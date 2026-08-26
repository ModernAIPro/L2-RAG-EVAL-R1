import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { config } from "dotenv";
import OpenAI from "openai";

// On Vercel the key arrives from the project's Environment Variables, already in
// process.env. Only when it is missing do we fall back to the repo-root .env used
// by the labs locally. Either way it is read on the server and never sent to the
// browser: only NEXT_PUBLIC_* names are inlined into the client bundle.
if (!process.env.OPENAI_API_KEY) {
  config({ path: path.join(process.cwd(), "..", ".env") });
}

const MODEL = process.env.MODEL ?? "gpt-4o-mini";
const SYSTEM = "You are a helpful, concise assistant.";

// LLM replies can outrun Vercel's short default function timeout.
export const maxDuration = 60;

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

  const { messages } = await request.json();
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  });

  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "system", content: SYSTEM }, ...messages],
    stream: true,
  });

  // Forward the model's tokens to the browser as plain text, as they arrive.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for await (const chunk of completion) {
        // The proxy's final chunk carries usage only, with no choices.
        const piece = chunk.choices[0]?.delta?.content ?? "";
        if (piece) controller.enqueue(encoder.encode(piece));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
