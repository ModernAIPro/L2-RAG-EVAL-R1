"use client";

import { useEffect, useRef, useState } from "react";
import { formatCost } from "@/lib/pricing";
import type { EvalSummary } from "@/lib/evalsummary";

type Source = {
  source: string;
  page: number;
  form: string;
  year: string;
  distance: number;
};

type Grounding = {
  refused: boolean;
  cited: number[];
  unsupported: string[];
  badCites: number[];
};

type Step = { step: string; model: string; prompt: number; completion: number; usd: number };

type Metrics = {
  steps: Step[];
  prompt: number;
  completion: number;
  usd: number;
  refused: boolean;
};

// Only role and content go back to the server; the rest is display state for the
// retrieval that produced this turn.
type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  rewritten?: string | null;
  grounding?: Grounding;
  metrics?: Metrics;
};

const STORAGE_KEY = "chat-password";

/** Mirrors rag/grounding.py's report(): what the check found, in one line. */
function groundingNote(grounding: Grounding, total: number): string {
  if (grounding.refused) return "refused — nothing to verify";

  const parts: string[] = [];
  parts.push(
    grounding.cited.length
      ? `cites ${grounding.cited.map((c) => `[${c}]`).join(" ")}`
      : "no citations — every claim should carry one",
  );
  if (grounding.badCites.length) {
    parts.push(`invalid citations ${grounding.badCites.join(", ")} (only 1-${total} exist)`);
  }
  if (grounding.unsupported.length) {
    parts.push(`not in retrieved text: ${grounding.unsupported.join(", ")} — check it`);
  } else if (!grounding.badCites.length && grounding.cited.length) {
    parts.push("every figure appears in the retrieved text");
  }
  return parts.join(" · ");
}

function pct(n: number, d: number) {
  return d ? `${Math.round((100 * n) / d)}%` : "—";
}

export default function Chat({ evalSummary }: { evalSummary: EvalSummary | null }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  // One id per page load, so a conversation reads as one session in tracing.
  // useRef rather than useState: it must never change, and never re-render.
  const session = useRef<string>(null);
  if (session.current === null) session.current = crypto.randomUUID();

  // localStorage is browser-only, so read it after mount to keep hydration happy.
  useEffect(() => {
    setPassword(localStorage.getItem(STORAGE_KEY));
    setReady(true);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function unlock(event: React.FormEvent) {
    event.preventDefault();
    const entered = input.trim();
    if (!entered) return;
    localStorage.setItem(STORAGE_KEY, entered);
    setPassword(entered);
    setInput("");
    setAuthError("");
  }

  // The password is wrong or has been rotated — send the visitor back to unlock.
  function lockOut() {
    localStorage.removeItem(STORAGE_KEY);
    setPassword(null);
    setMessages([]);
    setAuthError("That password was not accepted. Try again.");
    setBusy(false);
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    const history: Message[] = [...messages, { role: "user", content: text }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-chat-password": password ?? "",
        "x-chat-session": session.current ?? "",
      },
      // Only what the model needs: the display fields would just be noise.
      body: JSON.stringify({
        messages: history.map(({ role, content }) => ({ role, content })),
      }),
    });

    if (response.status === 401) {
      lockOut();
      return;
    }

    if (!response.ok || !response.body) {
      const detail = await response.text();
      setMessages([...history, { role: "assistant", content: `Error: ${detail}` }]);
      setBusy(false);
      return;
    }

    // Newline-delimited JSON: sources first, then tokens, then the verdict. A
    // chunk can split mid-line, so hold the tail back until its newline arrives.
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const turn: Message = { role: "assistant", content: "" };
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "sources") {
          turn.sources = event.sources;
          turn.rewritten = event.rewritten;
        } else if (event.type === "token") {
          turn.content += event.text;
        } else if (event.type === "grounding") {
          turn.grounding = event;
        } else if (event.type === "metrics") {
          turn.metrics = event;
        }
      }

      setMessages([...history, { ...turn }]);
    }

    setBusy(false);
  }

  if (!ready) return null;

  if (!password) {
    return (
      <main className="chat">
        <h1>Chatbot</h1>
        <div className="thread">
          <p className="hint">This chatbot is password protected.</p>
          {authError && <p className="error">{authError}</p>}
        </div>
        <form onSubmit={unlock}>
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Password"
            autoFocus
          />
          <button type="submit" disabled={!input.trim()}>
            Unlock
          </button>
        </form>
      </main>
    );
  }

  // Session totals, recomputed from the turns rather than accumulated, so they
  // cannot drift out of step with what is on screen.
  const answered = messages.filter((m) => m.role === "assistant" && m.grounding);
  const totals = answered.reduce(
    (acc, m) => ({
      prompt: acc.prompt + (m.metrics?.prompt ?? 0),
      completion: acc.completion + (m.metrics?.completion ?? 0),
      usd: acc.usd + (m.metrics?.usd ?? 0),
      refused: acc.refused + (m.grounding?.refused ? 1 : 0),
      flagged: acc.flagged + (m.grounding && m.grounding.unsupported.length > 0 ? 1 : 0),
    }),
    { prompt: 0, completion: 0, usd: 0, refused: 0, flagged: 0 },
  );

  return (
    <div className="layout">
      <main className="chat">
        <h1>Chatbot</h1>

        <div className="thread">
          {messages.length === 0 && (
            <p className="hint">Ask about Apple&rsquo;s SEC filings, FY2023&ndash;FY2026 Q2.</p>
          )}
          {messages.map((message, i) => (
            <div key={i} className={`turn ${message.role}`}>
              <div className={`bubble ${message.role}`}>{message.content || "…"}</div>
              {message.rewritten && <p className="meta">searched for: {message.rewritten}</p>}
              {message.sources && (
                <ol className="sources">
                  {message.sources.map((s, n) => (
                    <li key={n}>
                      {s.source} p{s.page}{" "}
                      <span className="distance">{s.distance.toFixed(3)}</span>
                    </li>
                  ))}
                </ol>
              )}
              {message.grounding && (
                <p className={message.grounding.unsupported.length ? "warn" : "meta"}>
                  {groundingNote(message.grounding, message.sources?.length ?? 0)}
                </p>
              )}
              {message.metrics && (
                <p className="meta">
                  {message.metrics.prompt.toLocaleString()} in ·{" "}
                  {message.metrics.completion.toLocaleString()} out ·{" "}
                  {formatCost(message.metrics.usd)}
                  {message.metrics.steps.length > 1 && (
                    <> · {message.metrics.steps.map((s) => s.step).join(" + ")}</>
                  )}
                </p>
              )}
            </div>
          ))}
          <div ref={bottom} />
        </div>

        <form onSubmit={send}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything"
            autoFocus
          />
          <button type="submit" disabled={busy || !input.trim()}>
            Send
          </button>
        </form>
      </main>

      <aside className="panel">
        <section>
          <h2>This conversation</h2>
          <dl className="stats">
            <div>
              <dt>Turns</dt>
              <dd>{answered.length}</dd>
            </div>
            <div>
              <dt>Refused</dt>
              <dd>{totals.refused}</dd>
            </div>
            <div>
              <dt>Flagged figures</dt>
              <dd className={totals.flagged ? "bad" : undefined}>{totals.flagged}</dd>
            </div>
            <div>
              <dt>Tokens in</dt>
              <dd>{totals.prompt.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Tokens out</dt>
              <dd>{totals.completion.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Cost (est.)</dt>
              <dd>{formatCost(totals.usd)}</dd>
            </div>
          </dl>
          <p className="footnote">
            Tokens are reported by the API. Cost is an estimate at list price — the
            proxy serves a different model than the one requested.
          </p>
        </section>

        <section>
          <h2>Eval baseline</h2>
          {evalSummary ? (
            <>
              <dl className="stats">
                <div>
                  <dt>Golden set</dt>
                  <dd>
                    {evalSummary.correct}/{evalSummary.scored} correct
                  </dd>
                </div>
                <div>
                  <dt>Retrieval recall@5</dt>
                  <dd
                    className={
                      (evalSummary.recall_at_5 ?? 1) < 0.8 ? "bad" : undefined
                    }
                  >
                    {evalSummary.recall_at_5 === null
                      ? "—"
                      : `${Math.round(evalSummary.recall_at_5 * 100)}%`}
                  </dd>
                </div>
                <div>
                  <dt>Answered when it should refuse</dt>
                  <dd className={evalSummary.answered_when_should_refuse ? "bad" : "good"}>
                    {evalSummary.answered_when_should_refuse}/{evalSummary.should_refuse_total}
                  </dd>
                </div>
                <div>
                  <dt>False refusals</dt>
                  <dd className={evalSummary.false_refusals ? "bad" : "good"}>
                    {evalSummary.false_refusals}/{evalSummary.answerable_total}
                  </dd>
                </div>
              </dl>

              <table className="kinds">
                <thead>
                  <tr>
                    <th>kind</th>
                    <th>n</th>
                    <th>ok</th>
                    <th>r@5</th>
                  </tr>
                </thead>
                <tbody>
                  {evalSummary.by_kind.map((k) => (
                    <tr key={k.kind}>
                      <td>{k.kind}</td>
                      <td>{k.n}</td>
                      <td>{pct(k.correct, k.n)}</td>
                      <td>
                        {k.recall_at_5 === null ? "—" : `${Math.round(k.recall_at_5 * 100)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <p className="footnote">
                From <code>rag/evaluate.py --web</code>, {evalSummary.generated.slice(0, 10)}.
                A fixed question set, not this conversation.
              </p>
            </>
          ) : (
            <p className="footnote">
              No eval yet. Run <code>python rag/evaluate.py --web</code> and rebuild.
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}
