/**
 * Context pressure measurement (invariant 6).
 *
 * Real provider usage always wins: once a response reports how many prompt
 * tokens it actually consumed, the meter stops estimating. The heuristic is
 * only a fallback for the very first request, and the `source` field says which
 * one produced the current number so no caller has to guess.
 *
 * Measured facts this relies on (see docs/live-findings.md): a provider reports
 * `inputTokens` for the uncached part of the prompt and `cacheReadTokens` for
 * the cached prefix, so the prompt size is their sum.
 */

import type { LLMRequest, Message, Usage } from '../llm/types.js';
import { estimateTokens } from './tokens.js';

export type PressureSource = 'usage' | 'estimate' | 'empty';

export interface ContextPressure {
  readonly surfaceTokens: number;
  readonly contextWindow: number;
  /** `surfaceTokens / contextWindow`; deliberately not clamped. */
  readonly ratio: number;
  readonly source: PressureSource;
}

/** Total prompt tokens of one request, cached and uncached alike. */
export function totalPromptTokens(usage: Usage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

function measureMessage(message: Message): number {
  let tokens = estimateTokens(message.content);
  for (const part of message.parts ?? []) {
    // An image is priced by the provider, not by characters; count a flat
    // allowance so a projected request is not wildly under-measured.
    tokens += part.type === 'image' ? 1_024 : estimateTokens(part.text);
  }
  for (const call of message.toolCalls ?? []) {
    tokens += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.args ?? {}));
  }
  return tokens;
}

/** Heuristic size of a request, used only before real usage exists. */
export function measureRequest(request: Pick<LLMRequest, 'system' | 'messages' | 'tools'>): number {
  let tokens = estimateTokens(request.system);
  for (const message of request.messages) {
    tokens += measureMessage(message);
  }
  for (const tool of request.tools) {
    tokens += estimateTokens(tool.name) + estimateTokens(tool.description);
    tokens += estimateTokens(JSON.stringify(tool.parameters));
  }
  return tokens;
}

export interface TokenMeter {
  /** Provider-reported usage for one completed exchange. */
  recordUsage(usage: Usage): void;
  /** Heuristic size of a request, accepted only while no usage exists. */
  recordEstimate(surfaceTokens: number): void;
  readonly surfaceTokens: number;
  readonly source: PressureSource;
  readonly lastUsage: Usage | undefined;
  pressure(): ContextPressure;
  reset(): void;
}

export interface TokenMeterOptions {
  readonly contextWindow: number;
}

export function createTokenMeter(options: TokenMeterOptions): TokenMeter {
  let surfaceTokens = 0;
  let source: PressureSource = 'empty';
  let lastUsage: Usage | undefined;

  const pressure = (): ContextPressure => ({
    surfaceTokens,
    contextWindow: options.contextWindow,
    ratio: options.contextWindow <= 0 ? 0 : surfaceTokens / options.contextWindow,
    source,
  });

  return {
    recordUsage(usage) {
      const nothingReported =
        usage.inputTokens === 0 &&
        usage.outputTokens === 0 &&
        (usage.cacheReadTokens ?? 0) === 0 &&
        (usage.cacheWriteTokens ?? 0) === 0;
      if (nothingReported) {
        // A response that reported no tokens must not wipe a known measurement:
        // keeping the previous (larger) pressure is the safer direction.
        return;
      }
      lastUsage = usage;
      // The next request carries this prompt plus the reply it produced.
      surfaceTokens = totalPromptTokens(usage) + usage.outputTokens;
      source = 'usage';
    },
    recordEstimate(next) {
      if (source === 'usage') {
        // Real numbers outrank the heuristic for the rest of the session.
        return;
      }
      surfaceTokens = next;
      source = 'estimate';
    },
    get surfaceTokens() {
      return surfaceTokens;
    },
    get source() {
      return source;
    },
    get lastUsage() {
      return lastUsage;
    },
    pressure,
    reset() {
      surfaceTokens = 0;
      source = 'empty';
      lastUsage = undefined;
    },
  };
}
