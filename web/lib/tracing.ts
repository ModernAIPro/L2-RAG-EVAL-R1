import { LangfuseClient } from "@langfuse/client";
import { observeOpenAI } from "@langfuse/openai";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider, startObservation } from "@langfuse/tracing";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type OpenAI from "openai";
import { verify } from "@/lib/grounding";
import type { Hit } from "@/lib/retrieval";

/**
 * Optional Langfuse tracing, the browser-side counterpart of rag/tracing.py.
 *
 * Set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL and every
 * turn becomes a trace. Leave either key out and this degrades to no-ops: the
 * route behaves exactly as before and never calls Langfuse.
 *
 * SDK v4 is built on OpenTelemetry. The old `langfuse` v3 package had its own
 * transport and took an explicit `parent`; v4 emits OTel spans through a span
 * processor, and nesting normally comes from ambient context. We cannot rely on
 * that here — the answer is produced inside a ReadableStream callback that runs
 * after the handler returns, outside any active context — so the root span's
 * SpanContext is passed to children explicitly. That is why this file uses
 * `startObservation` rather than `startActiveObservation`.
 */

function enabled(): boolean {
  // Read at call time, never at module scope: route.ts loads the repo-root .env
  // in its module body, and ES imports are evaluated before that body runs.
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}

export type Turn = {
  /** Wrap the OpenAI client so its calls land inside this trace. */
  wrap(client: OpenAI): OpenAI;
  rewrote(original: string, standalone: string): void;
  retrieved(query: string, hits: Hit[]): void;
  graded(answer: string, contexts: string[]): void;
  /** Must be awaited: a frozen serverless instance sends nothing. */
  end(): Promise<void>;
};

const noop: Turn = {
  wrap: (client) => client,
  rewrote: () => {},
  retrieved: () => {},
  graded: () => {},
  end: async () => {},
};

// One provider and client per warm instance; each request still gets its trace.
let processor: LangfuseSpanProcessor | null = null;
let client: LangfuseClient | null = null;

function init(): { processor: LangfuseSpanProcessor; client: LangfuseClient } {
  if (!processor || !client) {
    // Both read LANGFUSE_PUBLIC_KEY / SECRET_KEY / BASE_URL from the environment.
    processor = new LangfuseSpanProcessor();
    // A provider of our own rather than the global OTel one: nothing else in
    // this app emits spans, and registering globally would fight Next's own
    // instrumentation. setLangfuseTracerProvider points the SDK at it.
    setLangfuseTracerProvider(new BasicTracerProvider({ spanProcessors: [processor] }));
    client = new LangfuseClient();
  }
  return { processor, client };
}

export function turn(question: string, session?: string): Turn {
  if (!enabled()) return noop;

  const { processor: proc, client: lf } = init();

  const root = startObservation("rag-turn", { input: question }, { asType: "chain" });
  root.updateTrace({
    name: "rag-turn",
    input: question,
    sessionId: session,
    metadata: { surface: "web" },
  });

  // Captured once: children and the wrapped OpenAI client are parented to this.
  const parentSpanContext = root.otelSpan.spanContext();

  return {
    wrap(openai) {
      return observeOpenAI(openai, { parentSpanContext });
    },

    rewrote(original, standalone) {
      if (original === standalone) return;
      root.startObservation("condense", { input: original, output: standalone }).end();
    },

    retrieved(query, hits) {
      // Distances are the whole story when an answer looks wrong.
      root
        .startObservation(
          "retrieve",
          {
            input: query,
            output: hits.map((h) => ({
              source: h.source,
              page: h.page,
              distance: Number(h.distance.toFixed(4)),
            })),
          },
          { asType: "retriever" },
        )
        .end();
    },

    graded(answer, contexts) {
      const g = verify(answer, contexts);
      const passed =
        g.refused || (g.cited.length > 0 && !g.unsupported.length && !g.badCites.length);

      const detail = {
        surface: "web",
        cited: g.cited,
        unsupported: g.unsupported,
        bad_citations: g.badCites,
        refused: g.refused,
      };

      // On the span and the trace both: the trace-level copy is what the list
      // view shows, the span-level copy survives if trace attributes are pruned.
      root.update({ output: answer, metadata: detail });
      root.updateTrace({ output: answer, metadata: detail });

      lf.score.trace(
        { otelSpan: root.otelSpan },
        { name: "grounded", value: passed ? 1 : 0, dataType: "BOOLEAN" },
      );
    },

    async end() {
      root.end();
      // A serverless function can be frozen the moment the response ends, so
      // both pipelines have to be on the wire before we close the stream:
      // spans go through the OTel processor, scores through the client.
      await Promise.all([proc.forceFlush(), lf.score.flush()]);
    },
  };
}

export function banner(): string {
  return enabled()
    ? `tracing -> ${process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com"}`
    : "tracing off";
}
