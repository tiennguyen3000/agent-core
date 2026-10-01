/**
 * Session projection (invariants 1 and 2).
 *
 * `project()` derives the model-facing message list by replaying the event log.
 * Nothing here mutates the log, and compacted ranges are hidden — not deleted —
 * so replay stays deterministic and the full history remains inspectable.
 *
 * This module is deliberately pure: persistence (JSONL, fsync, locking) is M2.
 */

import type { Message } from '../llm/types.js';
import type { CompactionEvent, SessionEvent } from './events.js';

export interface ProjectionOptions {
  readonly summaryPrefix?: string;
  readonly summarySuffix?: string;
}

export interface ProjectionResult {
  readonly messages: readonly Message[];
  /** Events hidden by a compaction range: still in the log, invisible to the model. */
  readonly hiddenSeqs: readonly number[];
  /** Tool results dropped because the call they answered was compacted away. */
  readonly orphanedToolResults: readonly number[];
}

const DEFAULT_SUMMARY_PREFIX = '<compacted-history>';
const DEFAULT_SUMMARY_SUFFIX = '</compacted-history>';

function collectHiddenSeqs(events: readonly SessionEvent[]): Set<number> {
  const hidden = new Set<number>();
  for (const event of events) {
    if (event.t !== 'compaction') {
      continue;
    }
    for (let seq = event.coveredFrom; seq <= event.coveredTo; seq += 1) {
      hidden.add(seq);
    }
  }
  return hidden;
}

export function project(
  events: readonly SessionEvent[],
  options: ProjectionOptions = {},
): ProjectionResult {
  const summaryPrefix = options.summaryPrefix ?? DEFAULT_SUMMARY_PREFIX;
  const summarySuffix = options.summarySuffix ?? DEFAULT_SUMMARY_SUFFIX;

  const hidden = collectHiddenSeqs(events);
  const messages: Message[] = [];
  const pendingCallIds = new Set<string>();
  const orphanedToolResults: number[] = [];

  // A summary takes the place of the range it replaced, so it is emitted where
  // the covered range *starts*, not where the compaction event was recorded.
  const summariesByStart = new Map<number, CompactionEvent[]>();
  for (const event of events) {
    if (event.t === 'compaction') {
      const list = summariesByStart.get(event.coveredFrom) ?? [];
      list.push(event);
      summariesByStart.set(event.coveredFrom, list);
    }
  }

  const emittedSummaries = new Set<number>();
  const emitSummary = (event: CompactionEvent): void => {
    if (emittedSummaries.has(event.seq)) {
      return;
    }
    emittedSummaries.add(event.seq);
    messages.push({
      role: 'user',
      content: `${summaryPrefix}\n${event.summary}\n${summarySuffix}`,
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
        messages.push({ role: 'user', content: event.input });
        break;
      }
      case 'llm.response': {
        for (const call of event.toolCalls) {
          pendingCallIds.add(call.id);
        }
        if (event.text.length > 0 || event.toolCalls.length > 0) {
          messages.push(
            event.toolCalls.length > 0
              ? { role: 'assistant', content: event.text, toolCalls: event.toolCalls }
              : { role: 'assistant', content: event.text },
          );
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
        messages.push({ role: 'tool', content: event.output, toolCallId: event.callId });
        break;
      }
      case 'compaction': {
        // Fallback for a range whose `coveredFrom` is not present in the log.
        emitSummary(event);
        break;
      }
      default: {
        // session.created, step.start, llm.request, tool.call, approval.* and
        // turn.end are recorded facts that the model never sees.
        break;
      }
    }
  }

  return {
    messages,
    hiddenSeqs: [...hidden].sort((a, b) => a - b),
    orphanedToolResults,
  };
}

/** Convenience wrapper for callers that only need the transcript. */
export function replay(
  events: readonly SessionEvent[],
  options: ProjectionOptions = {},
): readonly Message[] {
  return project(events, options).messages;
}
