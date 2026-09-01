import { readFileSync } from "node:fs";
import path from "node:path";

/** The shape rag/evaluate.py --web writes to web/data/eval.json. */
export type EvalSummary = {
  generated: string;
  model: string;
  questions: number;
  correct: number;
  scored: number;
  recall_at_5: number | null;
  answered_when_should_refuse: number;
  should_refuse_total: number;
  false_refusals: number;
  answerable_total: number;
  by_kind: { kind: string; n: number; correct: number; recall_at_5: number | null }[];
};

/**
 * Read at build time by the page, which is prerendered — so the site shows the
 * eval as of the last build. That is the right cadence: the golden set is a
 * batch artifact, not a live number, and pretending otherwise would invite
 * reading it as though it described the current conversation.
 *
 * Missing file is not an error. The repo should clone and run without anyone
 * having to produce an eval first.
 */
export function readEvalSummary(): EvalSummary | null {
  try {
    const file = path.join(process.cwd(), "data", "eval.json");
    return JSON.parse(readFileSync(file, "utf-8")) as EvalSummary;
  } catch {
    return null;
  }
}
