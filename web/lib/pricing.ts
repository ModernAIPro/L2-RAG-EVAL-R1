/**
 * Token counts are exact — they come from the API's own usage field. Cost is an
 * estimate, and it is worth knowing why.
 *
 * The class proxy does not serve the model you ask for: request `gpt-4o-mini`
 * and the response comes back stamped `gpt-5.6-terra-2026-07-09`. So there is no
 * published price to look up, and no way from here to know what the proxy is
 * actually charged. The rates below are list prices for the model this repo
 * nominally targets, applied to real token counts.
 *
 * Treat cost as an order of magnitude. Treat tokens as fact.
 */

export type Usage = { prompt: number; completion: number };

/** USD per 1M tokens. Edit these if you point MODEL somewhere else. */
const RATES: Record<string, { in: number; out: number }> = {
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "text-embedding-3-small": { in: 0.02, out: 0 },
};

const FALLBACK = RATES["gpt-4o-mini"];

export function costOf(model: string, usage: Usage): number {
  // Match on prefix so a dated variant (gpt-4o-mini-2024-07-18) still resolves.
  const key = Object.keys(RATES).find((k) => model.startsWith(k));
  const rate = key ? RATES[key] : FALLBACK;
  return (usage.prompt * rate.in + usage.completion * rate.out) / 1_000_000;
}

/** Sub-cent numbers are the norm here, so plain toFixed(2) would show $0.00. */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}
