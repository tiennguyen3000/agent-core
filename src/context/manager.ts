/**
 * One entry point for context management.
 *
 * The loop uses three things: where pressure stands, which projection options to
 * apply right now, and whether to compact. Pruning is free (no model call), so
 * it engages earlier than compaction — the ordered strategy is "prune first,
 * then summarise".
 */

import type { LLMProvider, LLMRequest, Usage } from '../llm/types.js';
import type { ProjectionOptions } from '../session/projection.js';
import type { SessionEvent } from '../session/events.js';
import { createCompactor } from './compactor.js';
import type {
  CompactionEventInput,
  CompactionPlan,
  CompactionReason,
  Compactor,
} from './compactor.js';
import { createTokenMeter } from './meter.js';
import type { ContextPressure, TokenMeter } from './meter.js';
import { measureRequest } from './meter.js';

export type CompactOutcome =
  | {
      readonly status: 'compacted';
      readonly event: CompactionEventInput;
      readonly usage: Usage | undefined;
      readonly plan: CompactionPlan;
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'below-threshold' | 'nothing-to-cover';
    }
  | {
      readonly status: 'failed';
      readonly reason: 'model-error';
      readonly errorCode: string | undefined;
    };

export interface ContextManagerOptions {
  readonly provider: LLMProvider;
  readonly contextWindow: number;
  /** Model used for the single summarisation request. */
  readonly model: string;
  readonly thresholdRatio?: number;
  readonly retainRatio?: number;
  readonly retainTokens?: number;
  /** Prune tool results once pressure reaches this fraction (default 0.5). */
  readonly pruneRatio?: number;
  /** Per-tool-result cap once pruning is active (default 600 tokens). */
  readonly toolResultPruneTokens?: number;
  readonly maxSummaryTokens?: number;
}

export interface ContextManager {
  readonly meter: TokenMeter;
  readonly compactor: Compactor;
  /** Provider usage for a finished exchange; real numbers beat estimates. */
  recordUsage(usage: Usage): void;
  /** Heuristic size of a request, accepted only while no usage is known. */
  noteRequestEstimate(request: Pick<LLMRequest, 'system' | 'messages' | 'tools'>): void;
  pressure(): ContextPressure;
  /** Projection options the loop should use for this step. */
  projectionOptions(): ProjectionOptions;
  compact(
    events: readonly SessionEvent[],
    options: { readonly signal: AbortSignal; readonly reason?: CompactionReason },
  ): Promise<CompactOutcome>;
}

export function createContextManager(options: ContextManagerOptions): ContextManager {
  const thresholdRatio = options.thresholdRatio ?? 0.8;
  const pruneRatio = options.pruneRatio ?? 0.5;
  const toolResultPruneTokens = options.toolResultPruneTokens ?? 600;

  const meter = createTokenMeter({ contextWindow: options.contextWindow });
  const compactor = createCompactor({
    provider: options.provider,
    contextWindow: options.contextWindow,
    thresholdRatio,
    ...(options.retainRatio === undefined ? {} : { retainRatio: options.retainRatio }),
    ...(options.retainTokens === undefined ? {} : { retainTokens: options.retainTokens }),
    toolResultBudget: toolResultPruneTokens,
  });

  return {
    meter,
    compactor,

    recordUsage(usage) {
      meter.recordUsage(usage);
    },

    noteRequestEstimate(request) {
      meter.recordEstimate(measureRequest(request));
    },

    pressure() {
      return meter.pressure();
    },

    projectionOptions() {
      return meter.pressure().ratio >= pruneRatio
        ? { toolResultBudget: toolResultPruneTokens }
        : {};
    },

    async compact(events, compactOptions) {
      const pressure = meter.pressure();
      if (
        compactOptions.reason !== 'overflow' &&
        pressure.surfaceTokens > 0 &&
        pressure.ratio < thresholdRatio
      ) {
        return { status: 'skipped', reason: 'below-threshold' };
      }

      const plan = compactor.plan(events, pressure, {
        ...(compactOptions.reason === undefined ? {} : { reason: compactOptions.reason }),
      });
      if (plan === undefined) {
        return { status: 'skipped', reason: 'nothing-to-cover' };
      }

      const summarized = await compactor.summarize(events, plan, {
        model: options.model,
        signal: compactOptions.signal,
        ...(options.maxSummaryTokens === undefined
          ? {}
          : { maxSummaryTokens: options.maxSummaryTokens }),
        projectionOptions: this.projectionOptions(),
      });

      if (!summarized.ok) {
        return { status: 'failed', reason: 'model-error', errorCode: summarized.errorCode };
      }

      const usage: Usage = summarized.usage ?? { inputTokens: 0, outputTokens: 0 };
      // The summary request itself consumed context; the next real response
      // rewrites this with authoritative numbers.
      meter.recordUsage(usage);

      return {
        status: 'compacted',
        plan,
        usage: summarized.usage,
        event: compactor.toEventInput(plan, summarized.summary, usage),
      };
    },
  };
}
