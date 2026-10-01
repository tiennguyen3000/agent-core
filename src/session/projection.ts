/**
 * Session projection (invariants 1, 2 and 8).
 *
 * `project()` derives the model-facing message list by replaying the event log.
 * Nothing here mutates the log, and compacted ranges are hidden — not deleted —
 * so replay stays deterministic and the full history remains inspectable.
 *
 * Two details matter for long sessions:
 *  - a compaction that covers an earlier compaction subsumes its summary, so a
 *    chain of compactions never shows stale summaries side by side;
 *  - `toolResultBudget` prunes oversized tool output *for the model* while the
 *    untouched text stays in the log, which is what makes pruning free of any
 *    model call.
 */

import { splitHeadTail } from '../context/spill.js';
import { estimateTokens, tokensToChars } from '../context/tokens.js';
import type { Message } from '../llm/types.js';
import type { CompactionEvent, SessionEvent } from './events.js';

export interface ProjectionOptions {
  readonly summaryPrefix?: string;
  readonly summarySuffix?: string;
  /** Per-tool-result cap in estimated tokens; over it the middle is dropped. */
  readonly toolResultBudget?: number;
}

export interface ProjectionResult {
  readonly messages: readonly Message[];
  /** Events hidden by a compaction range: still in the log, invisible to the model. */
  readonly hiddenSeqs: readonly number[];
  /** Tool results dropped because the call they answered was compacted away. */
  readonly orphanedToolResults: readonly number[];
  /** Tool results whose middle was pruned for the model (invariant 8). */
  readonly prunedToolResults: readonly number[];
}

/** A projected message together with the event seq it came from. */
export interface ProjectedMessage {
  readonly seq: number;
  readonly message: Message;
}

interface ReplayResult extends ProjectionResult {
  readonly projected: readonly ProjectedMessage[];
}

const DEFAULT_SUMMARY_PREFIX = '<compacted-history>';
const DEFAULT_SUMMARY_SUFFIX = '</compacted-history>';

function isCompaction(event: SessionEvent): event is CompactionEvent {
  return event.t === 'compaction';
}

function collectHiddenSeqs(events: readonly SessionEvent[]): Set<number> {
  const hidden = new Set<number>();
  for (const event of events) {
    if (!isCompaction(event)) {
      continue;
    }
    for (let seq = event.coveredFrom; seq <= event.coveredTo; seq += 1) {
      hidden.add(seq);
    }
  }
  return hidden;
}

/**
 * Compactions that another, *larger* compaction covers. The rule is
 * asymmetric on purpose: a range that covers strictly more material subsumes an
 * inner one, never the other way around (otherwise nested ranges would cancel
 * each other out and no summary would survive).
 */
function collectSubsumedCompactions(events: readonly SessionEvent[]): Set<number> {
  const compactions = events.filter(isCompaction);
  const subsumed = new Set<number>();
  for (const candidate of compactions) {
    for (const other of compactions) {
      if (other.seq === candidate.seq || other.coveredTo <= candidate.coveredTo) {
        continue;
      }
      if (other.coveredFrom <= candidate.coveredFrom && candidate.coveredFrom <= other.coveredTo) {
        subsumed.add(candidate.seq);
      }
    }
  }
  return subsumed;
}

function pruneOutput(text: string, budgetTokens: number): { text: string; pruned: boolean } {
  if (budgetTokens <= 0 || estimateTokens(text) <= budgetTokens) {
    return { text, pruned: false };
  }
  const { head, tail } = splitHeadTail(text, tokensToChars(budgetTokens));
  const omitted = Math.max(0, text.length - head.length - tail.length);
  return {
    text: `${head}\n... (${String(omitted)} characters pruned; the full result is in the session log) ...\n${tail}`,
    pruned: true,
  };
}

function replayInternal(
  events: readonly SessionEvent[],
  options: ProjectionOptions,
): ReplayResult {
  const summaryPrefix = options.summaryPrefix ?? DEFAULT_SUMMARY_PREFIX;
  const summarySuffix = options.summarySuffix ?? DEFAULT_SUMMARY_SUFFIX;

  const hidden = collectHiddenSeqs(events);
  const subsumed = collectSubsumedCompactions(events);
  const projected: ProjectedMessage[] = [];
  const pendingCallIds = new Set<string>();
  const orphanedToolResults: number[] = [];
  const prunedToolResults: number[] = [];

  // A summary takes the place of the range it replaced, so it is emitted where
  // the covered range *starts*, not where the compaction event was recorded.
  const summariesByStart = new Map<number, CompactionEvent[]>();
  for (const event of events) {
    if (!isCompaction(event) || subsumed.has(event.seq)) {
      continue;
    }
    const list = summariesByStart.get(event.coveredFrom) ?? [];
    list.push(event);
    summariesByStart.set(event.coveredFrom, list);
  }

  const emittedSummaries = new Set<number>();
  const emitSummary = (event: CompactionEvent): void => {
    if (emittedSummaries.has(event.seq)) {
      return;
    }
    emittedSummaries.add(event.seq);
    projected.push({
      seq: event.seq,
      message: {
        role: 'user',
        content: `${summaryPrefix}\n${event.summary}\n${summarySuffix}`,
      },
    });
  };

  for (const event of events) {
    for (const summary of summariesByStart.get(event.seq) ?? []) {
      emitSummary(summary);
    }

    if (hidden.has(event.seq)) {
      continue;
    }

    switch (event.t) {
      case 'turn.start': {
        projected.push({ seq: event.seq, message: { role: 'user', content: event.input } });
        break;
      }
      case 'llm.response': {
        for (const call of event.toolCalls) {
          pendingCallIds.add(call.id);
        }
        if (event.text.length > 0 || event.toolCalls.length > 0) {
          projected.push({
            seq: event.seq,
            message:
              event.toolCalls.length > 0
                ? { role: 'assistant', content: event.text, toolCalls: event.toolCalls }
                : { role: 'assistant', content: event.text },
          });
        }
        break;
      }
      case 'tool.result': {
        if (!pendingCallIds.delete(event.callId)) {
          // The assistant message that requested this call is hidden by a
          // compaction, so the result would be an orphan: drop it (invariant 1
          // requires the projected history to be a valid transcript).
          orphanedToolResults.push(event.seq);
          break;
        }
        const pruned =
          options.toolResultBudget === undefined
            ? { text: event.output, pruned: false }
            : pruneOutput(event.output, options.toolResultBudget);
        if (pruned.pruned) {
          prunedToolResults.push(event.seq);
        }
        projected.push({
          seq: event.seq,
          message: { role: 'tool', content: pruned.text, toolCallId: event.callId },
        });
        break;
      }
      case 'compaction': {
        // Fallback for a range whose `coveredFrom` is not present in the log.
        if (!subsumed.has(event.seq)) {
          emitSummary(event);
        }
        break;
      }
      default: {
        // session.created, step.start, llm.request, tool.call, approval.*,
        // policy.decision and turn.end are recorded facts the model never sees.
        break;
      }
    }
  }

  return {
    projected,
    messages: projected.map((entry) => entry.message),
    hiddenSeqs: [...hidden].sort((a, b) => a - b),
    orphanedToolResults,
    prunedToolResults,
  };
}

export function project(
  events: readonly SessionEvent[],
  options: ProjectionOptions = {},
): ProjectionResult {
  const { projected: _projected, ...result } = replayInternal(events, options);
  return result;
}

/**
 * Replays the log into messages, keeping the source seq of each one so callers
 * (the compactor) can choose a boundary without reimplementing the projection.
 */
export function projectWithSeqs(
  events: readonly SessionEvent[],
  options: ProjectionOptions = {},
): readonly ProjectedMessage[] {
  return replayInternal(events, options).projected;
}

/** Convenience wrapper for callers that only need the transcript. */
export function replay(
  events: readonly SessionEvent[],
  options: ProjectionOptions = {},
): readonly Message[] {
  return replayInternal(events, options).messages;
}
