/**
 * Cheap token estimation.
 *
 * This is a *heuristic* used to size tool output before it reaches a model.
 * Provider-reported `Usage` is authoritative and must win wherever it is
 * available (see docs/live-findings.md); never bill or compact on this number
 * when real usage exists.
 */

export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function tokensToChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
}
