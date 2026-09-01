import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { config } from "dotenv";
import OpenAI from "openai";
import { verify } from "@/lib/grounding";
import { MAX_DISTANCE, excerpts, retrieve } from "@/lib/retrieval";
import * as tracing from "@/lib/tracing";

// On Vercel these arrive from the project's Environment Variables, already in
// process.env. Only when they are missing do we fall back to the repo-root .env
// used by the labs locally. Either way they are read on the server and never sent
// to the browser: only NEXT_PUBLIC_* names are inlined into the client bundle.
// The LANGFUSE check matters on its own — the key may be present while the
// tracing keys are not, which would silently leave local runs untraced.
if (!process.env.OPENAI_API_KEY || !process.env.LANGFUSE_SECRET_KEY) {
  config({ path: path.join(process.cwd(), "..", ".env") });
}

const MODEL = process.env.MODEL ?? "gpt-4o-mini";

// Same wording as rag/chat.py. The refusal string is load-bearing: the grounding
// check keys off it, and the client renders it as a refusal rather than an answer.
const SYSTEM =
  "You answer strictly from the numbered excerpts of Apple SEC filings given " +
  "to you. Every factual claim must cite its excerpt like [1] or [2]. Figures " +
  "differ between fiscal years, so always say which year a number comes from. " +
  "You may not use anything you know about Apple from outside these excerpts, " +
  "even if you are confident it is correct. If the excerpts do not contain the " +
  "answer, reply exactly: NOT IN CORPUS — and nothing else. Earlier turns are " +
  "for context only; each answer must rest on the excerpts given with it.";

const CONDENSE =
  "Rewrite the user's last message as a standalone question, resolving pronouns " +
  "and anything left implicit from the conversation. Keep it short and keep any " +
  "fiscal year explicit. Output only the question.";

const HISTORY_TURNS = 6;

// Retrieval adds an embedding call and a rewrite call before the answer starts.
export const maxDuration = 60;

type Message = { role: "user" | "assistant"; content: string };

/**
 * The custom domain is a production domain, and Vercel's Standard Protection
 * covers everything *except* production domains — so this gate, not Vercel, is
 * what stands between the open internet and an LLM funded by our key.
 *
 * Fails closed: in production a missing CHAT_PASSWORD locks the route rather
 * than opening it. Locally it stays open so `npm run dev` needs no setup.
 */
function passwordOk(request: Request): boolean {
  const expected = process.env.CHAT_PASSWORD;
  if (!expected) return process.env.NODE_ENV !== "production";

  const given = Buffer.from(request.headers.get("x-chat-password") ?? "");
  const wanted = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so check that first.
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** "and the year before?" embeds to nothing useful; against the history it
 * becomes a question with a year in it, which retrieves the right page. */
async function standalone(client: OpenAI, question: string, history: Message[]) {
  if (history.length === 0) return question;

  const transcript = history
    .slice(-4)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const reply = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: CONDENSE },
      { role: "user", content: `${transcript}\nuser: ${question}` },
    ],
  });

  return reply.choices[0]?.message?.content?.trim() || question;
}

export async function POST(request: Request) {
  if (!passwordOk(request)) {
    return new Response("Wrong or missing password.", { status: 401 });
  }

  if (!process.env.OPENAI_API_KEY) {
    return new Response(
      "No OPENAI_API_KEY — set it in ../.env locally, or in Vercel's Environment Variables.",
      { status: 500 },
    );
  }

  const { messages } = (await request.json()) as { messages: Message[] };
  const question = messages[messages.length - 1]?.content ?? "";
  const history = messages.slice(0, -1);

  // One trace per turn, grouped by the browser conversation it belongs to.
  const trace = tracing.turn(question, request.headers.get("x-chat-session") ?? undefined);

  const client = trace.wrap(
    new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    }),
  );

  const query = await standalone(client, question, history);
  trace.rewrote(question, query);

  const hits = await retrieve(client, query);
  trace.retrieved(query, hits);

  const nearest = hits[0]?.distance ?? Infinity;
  const contexts = hits.map((h) => h.text);

  const encoder = new TextEncoder();
  // Newline-delimited JSON, so one stream can carry the sources (known up front),
  // the tokens, and the grounding verdict (only knowable once the answer ends).
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

      send({
        type: "sources",
        rewritten: query === question ? null : query,
        sources: hits.map((h) => ({
          source: h.source,
          page: h.page,
          form: h.form,
          year: h.year,
          distance: h.distance,
        })),
      });

      let answer = "";

      // Off-topic questions never reach the model, so it cannot answer from memory.
      if (nearest > MAX_DISTANCE) {
        answer = "NOT IN CORPUS";
        send({ type: "token", text: answer });
      } else {
        const turn = `${excerpts(hits)}\n\nQuestion: ${question}`;
        const completion = await client.chat.completions.create({
          model: MODEL,
          messages: [
            { role: "system", content: SYSTEM },
            ...history.slice(-HISTORY_TURNS),
            { role: "user", content: turn },
          ],
          stream: true,
        });

        for await (const chunk of completion) {
          // The proxy's final chunk carries usage only, with no choices.
          const piece = chunk.choices[0]?.delta?.content ?? "";
          if (piece) {
            answer += piece;
            send({ type: "token", text: piece });
          }
        }
      }

      send({ type: "grounding", ...verify(answer, contexts) });

      trace.graded(answer, contexts);
      // Awaited before close: the instance can freeze the moment the response
      // ends, and a queued batch that never left is a trace that never existed.
      await trace.end();

      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}
