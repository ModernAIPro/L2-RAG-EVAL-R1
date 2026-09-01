/**
 * The after-the-fact check that an answer came from the excerpts, not memory.
 * A port of rag/grounding.py — keep the two in step, since a divergence would
 * mean the deployed chatbot and the local scripts disagree about what counts as
 * grounded.
 */

/** Numbers the answer asserts, minus the [n] citation markers. */
function figures(text: string): string[] {
  const withoutCites = text.replace(/\[\d+\]/g, " ");
  return [...new Set(withoutCites.match(/\d[\d,]*(?:\.\d+)?/g) ?? [])];
}

/** Filings report millions ("31,370"); answers restate them as billions
 * ("31.370 billion"). Comparing digits alone sees through both separators. */
function digits(text: string): string {
  return text.replace(/[,.]/g, "");
}

export type Grounding = {
  refused: boolean;
  cited: number[];
  unsupported: string[];
  badCites: number[];
};

export function verify(answer: string, contexts: string[]): Grounding {
  if (answer.trim().startsWith("NOT IN CORPUS")) {
    return { refused: true, cited: [], unsupported: [], badCites: [] };
  }

  const haystack = digits(contexts.join(" "));
  const unsupported = figures(answer).filter((n) => !haystack.includes(digits(n)));

  const cited = [
    ...new Set((answer.match(/\[(\d+)\]/g) ?? []).map((m) => parseInt(m.slice(1, -1), 10))),
  ].sort((a, b) => a - b);
  const badCites = cited.filter((c) => c < 1 || c > contexts.length);

  return { refused: false, cited, unsupported: unsupported.sort(), badCites };
}
