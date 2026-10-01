/**
 * Cost estimation from real provider usage.
 *
 * Prices are public list prices per million tokens, kept in one table so a
 * deployment can override them (`prices`) or by model. The estimate is honest
 * about being an estimate: `priced: false` means the model has no entry and the
 * numbers below it are tokens only.
 */

import type { Usage } from '../llm/types.js';

export interface ModelPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cacheReadPerMillion: number;
  readonly cacheWritePerMillion?: number;
}

/**
 * From the models.dev catalog for the DeepSeek alias this project targets.
 * Live pricing changes; treat these as defaults, not as truth.
 */
export const DEFAULT_PRICES: Readonly<Record<string, ModelPrice>> = {
  'deepseek-flash': {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    cacheReadPerMillion: 0.003,
  },
  'deepseek-v4-pro': {
    inputPerMillion: 0.435,
    outputPerMillion: 0.87,
    cacheReadPerMillion: 0.003625,
  },
};

export interface CostEstimate {
  readonly usd: number;
  readonly priced: boolean;
}

export function estimateCost(usage: Usage, price: ModelPrice | undefined): CostEstimate {
  if (price === undefined) {
    return { usd: 0, priced: false };
  }
  const perMillion = (tokens: number, rate: number): number => (tokens * rate) / 1_000_000;
  const usd =
    perMillion(usage.inputTokens, price.inputPerMillion) +
    perMillion(usage.cacheReadTokens ?? 0, price.cacheReadPerMillion) +
    perMillion(usage.cacheWriteTokens ?? 0, price.cacheWritePerMillion ?? price.inputPerMillion) +
    perMillion(usage.outputTokens, price.outputPerMillion);
  return { usd, priced: true };
}

function group(value: number): string {
  return value.toLocaleString('en-US');
}

/** Four decimals would round a small session to `$0.0000`; keep it meaningful. */
function formatUsd(usd: number): string {
  if (usd === 0) {
    return '$0';
  }
  return usd < 0.01 ? `$${usd.toFixed(6)}` : `$${usd.toFixed(4)}`;
}

/** The end-of-session report: what was spent and on what. */
export function formatUsageReport(
  usage: Usage,
  model: string,
  price: ModelPrice | undefined,
): string {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  const total =
    usage.inputTokens + cacheRead + (usage.cacheWriteTokens ?? 0) + usage.outputTokens;
  const cost = estimateCost(usage, price);
  // The template lives in a const because TypeScript 5.9 reports a parameter
  // used only inside a template literal within a ternary as unused.
  const priced = `${formatUsd(cost.usd)} (${model}, list price estimate)`;
  const costLine = cost.priced ? priced : 'unknown (no price entry for this model)';
  return [
    `Tokens  input ${group(usage.inputTokens)} (cache read ${group(cacheRead)}) | output ${group(usage.outputTokens)} (reasoning ${group(reasoning)}) | total ${group(total)}`,
    `Cost    ${costLine}`,
  ].join('\n');
}
