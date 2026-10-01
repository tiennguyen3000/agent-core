/**
 * Conversation compaction (invariant 2).
 *
 * Planning is pure and free: it only decides which range to cover and which
 * tail to keep, using the same projection the model sees. Summarising costs
 * exactly one model request, and the result is returned as a `CompactionEvent`
 * input — the caller appends it, so the log stays the only writer.
 *
 * Boundary rules:
 *  - the retained tail never starts with a tool result whose call was covered,
 *    because that would orphan it;
 *  - a plan is only produced when enough material is actually covered, so a
 *    pressure spike near the end of a small conversation cannot loop;
 *  - a newer compaction covers from seq 1, which lets the projection subsume
 *    older summaries instead of showing them side by side.
 */

import { assembleResponse } from '../llm/assemble.js';
import type { LLMDelta, LLMProvider, LLMRequest, Usage } from '../llm/types.js';
import type { CompactionEvent, SessionEvent } from '../session/events.js';
import { project, projectWithSeqs } from '../session/projection.js';
import type { ProjectionOptions } from '../session/projection.js';
import { estimateTokens } from './tokens.js';

export type CompactionReason = 'threshold' | 'overflow';

export interface CompactionPlan {
  /** Always 1: a newer compaction subsumes every earlier one. */
  readonly coveredFrom: number;
  readonly coveredTo: number;
  /** First seq the model keeps verbatim. */
  readonly retainedFrom: number;
  readonly reason: CompactionReason;
  /** How many projected messages the summary replaces. */
  readonly coveredMessages: number;
}

export interface ContextPressureLike {
  readonly surfaceTokens: number;
  readonly contextWindow: number;
  readonly ratio: number;
}

export interface CompactorOptions {
  readonly provider: LLMProvider;
  readonly contextWindow: number;
  /** Compact once pressure reaches this fraction of the window. */
  readonly thresholdRatio?: number;
  /** Retained tail size as a fraction of the window. */
  readonly retainRatio?: number;
  /** Absolute retained-tail size, overriding `retainRatio`. */
  readonly retainTokens?: number;
  /** Below this many projected messages there is nothing worth covering. */
  readonly minCoveredMessages?: number;
  /** Per-tool-result cap applied while planning and rendering. */
  readonly toolResultBudget?: number;
}

export interface SummarizeOptions {
  readonly model: string;
  readonly signal: AbortSignal;
  readonly system?: string;
  readonly maxSummaryTokens?: number;
  readonly projectionOptions?: ProjectionOptions;
}

export interface SummarizeResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly usage: Usage | undefined;
  readonly errorCode: string | undefined;
  readonly request: LLMRequest;
}

/** The part of a compaction event the log does not own. */
export type CompactionEventInput = Omit<CompactionEvent, 'seq' | 'at'>;

export interface Compactor {
  plan(
    events: readonly SessionEvent[],
    pressure: ContextPressureLike,
    options?: { readonly reason?: CompactionReason },
  ): CompactionPlan | undefined;
  summarize(
    events: readonly SessionEvent[],
    plan: CompactionPlan,
    options: SummarizeOptions,
  ): Promise<SummarizeResult>;
  toEventInput(plan: CompactionPlan, summary: string, usage: Usage): CompactionEventInput;
}

export const DEFAULT_SUMMARY_SYSTEM =
  'You compress an agent conversation so work can continue. Write a dense factual summary of ' +
  'what was asked, what was decided, which files were touched, what failed and what is still ' +
  'open. Preserve exact identifiers, paths and error codes. Do not add advice or new plans.';

const MESSAGE_RENDER_CAP = 4_000;

function renderMessages(messages: LLMRequest['messages']): string {
  return messages
    .map((message) => {
      const body =
        message.content.length > MESSAGE_RENDER_CAP
          ? `${message.content.slice(0, MESSAGE_RENDER_CAP)}\n...(truncated)`
          : message.content;
      const calls =
        (message.toolCalls?.length ?? 0) === 0
          ? ''
          : ` [tools: ${(message.toolCalls ?? [])
              .map((call) => `${call.name}(${JSON.stringify(call.args ?? {})})`)
              .join(', ')}]`;
      return `${message.role}: ${body}${calls}`;
    })
    .join('\n\n');
}

export function createCompactor(options: CompactorOptions): Compactor {
  const thresholdRatio = options.thresholdRatio ?? 0.8;
  const retainRatio = options.retainRatio ?? 0.16;
  const minCoveredMessages = options.minCoveredMessages ?? 3;
  const defaultProjection: ProjectionOptions =
    options.toolResultBudget === undefined
      ? {}
      : { toolResultBudget: options.toolResultBudget };

  const retainBudget = (): number =>
    options.retainTokens ?? Math.floor(options.contextWindow * retainRatio);

  return {
    plan(events, pressure, planOptions = {}) {
      const reason: CompactionReason = planOptions.reason ?? 'threshold';
      if (pressure.surfaceTokens <= 0) {
        return undefined;
      }
      if (reason !== 'overflow' && pressure.ratio < thresholdRatio) {
        return undefined;
      }

      const projected = projectWithSeqs(events, defaultProjection);
      if (projected.length === 0) {
        return undefined;
      }

      const budget = retainBudget();
      let accumulated = 0;
      let firstKept = projected.length;
      for (let index = projected.length - 1; index >= 0; index -= 1) {
        const entry = projected[index];
        if (entry === undefined) {
          continue;
        }
        accumulated += estimateTokens(entry.message.content);
        if (accumulated > budget && index < projected.length - 1) {
          firstKept = index + 1;
          break;
        }
        firstKept = index;
      }
      if (firstKept >= projected.length) {
        return undefined;
      }

      // Never start the retained tail with an orphaned tool result.
      const boundary = projected[firstKept];
      if (boundary !== undefined && boundary.message.role === 'tool') {
        const callId = boundary.message.toolCallId;
        const ownerIndex = projected.findIndex(
          (entry) =>
            entry.message.role === 'assistant' &&
            (entry.message.toolCalls ?? []).some((call) => call.id === callId),
        );
        if (ownerIndex !== -1 && ownerIndex < firstKept) {
          firstKept = ownerIndex;
        }
      }

      const kept = projected[firstKept];
      if (kept === undefined) {
        return undefined;
      }
      const coveredTo = kept.seq - 1;
      if (coveredTo < 1 || firstKept < minCoveredMessages) {
        return undefined;
      }

      return {
        coveredFrom: 1,
        coveredTo,
        retainedFrom: kept.seq,
        reason,
        coveredMessages: firstKept,
      };
    },

    async summarize(events, plan, summarizeOptions) {
      const covered = events.filter((event) => event.seq <= plan.coveredTo);
      const rendered = renderMessages(
        project(covered, summarizeOptions.projectionOptions ?? defaultProjection).messages,
      );

      const request: LLMRequest = {
        model: summarizeOptions.model,
        system: summarizeOptions.system ?? DEFAULT_SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: rendered }],
        tools: [],
        maxOutputTokens: summarizeOptions.maxSummaryTokens ?? 2_048,
        signal: summarizeOptions.signal,
      };

      const deltas: LLMDelta[] = [];
      for await (const delta of options.provider.stream(request)) {
        deltas.push(delta);
      }
      const response = assembleResponse(deltas);

      if (response.errorCode !== undefined) {
        return {
          ok: false,
          summary: '',
          usage: response.usage,
          errorCode: response.errorCode,
          request,
        };
      }
      const summary = response.text.trim();
      if (summary.length === 0) {
        return {
          ok: false,
          summary: '',
          usage: response.usage,
          errorCode: 'E_EMPTY_SUMMARY',
          request,
        };
      }
      return { ok: true, summary, usage: response.usage, errorCode: undefined, request };
    },

    toEventInput(plan, summary, usage) {
      return {
        t: 'compaction',
        coveredFrom: plan.coveredFrom,
        coveredTo: plan.coveredTo,
        summary,
        usage,
      };
    },
  };
}
