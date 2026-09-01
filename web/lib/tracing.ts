import { LangfuseClient } from "@langfuse/client";
import { observeOpenAI } from "@langfuse/openai";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
  startObservation,
} from "@langfuse/tracing";
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
 * SDK v5 (@langfuse/*) is built on OpenTelemetry. Nesting normally comes from
 * ambient context, and we cannot rely on that here — the answer is produced
 * inside a ReadableStream callback that runs after the handler returns, outside
 * any active context — so the root span's SpanContext is passed to children
 * explicitly. That is why this file uses `startObservation` rather than
 * `startActiveObservation`.
 *
 * Two v5 rules this file follows deliberately:
 *
 *   Input and output go on the root observation, never on the trace. v5
 *   deprecates trace-level IO: `updateTrace` is gone and `setTraceIO` exists
 *   only for legacy platform features. Langfuse derives what the trace shows
 *   from the root observation, which is why nothing here sets it directly.
 *
 *   The session is written as an explicit span attribute, not through
 *   `propagateAttributes`. That helper carries attributes in OpenTelemetry
 *   context, and context is exactly what this route lacks — see the note at the
 *   call site for what that produced when tried.
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

  // `input` is an observation attribute, not a trace one — see above.
  const root = startObservation("rag-turn", { input: question }, { asType: "chain" });

  // Session set as an explicit span attribute rather than via propagateAttributes.
  // That helper is a callback wrapper that carries attributes in OpenTelemetry
  // context, and context does not survive this route: the answer is produced in a
  // ReadableStream callback outside it. Measured, not assumed — wrapping span
  // creation in propagateAttributes produced traces with session=None. These are
  // documented public attributes, and deliberately not TRACE_INPUT/TRACE_OUTPUT,
  // which are the deprecated trace-level IO this file avoids.
  // Set on the OTel span rather than via updateOtelSpanAttributes, which despite
  // its name is typed for observation attributes and rejects these keys.
  root.otelSpan.setAttributes({
    [LangfuseOtelSpanAttributes.TRACE_NAME]: "rag-turn",
    ...(session ? { [LangfuseOtelSpanAttributes.TRACE_SESSION_ID]: session } : {}),
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

      // Root observation only. Langfuse derives the trace's output from here, so
      // a second trace-level write would be the deprecated path for no gain.
      root.update({ output: answer, metadata: detail });

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
