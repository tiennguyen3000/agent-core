/**
 * Session event log contract (invariant 1).
 *
 * The log is the single source of truth: `seq` is a contiguous, monotonically
 * increasing integer starting at 1, and model history is always derived from
 * these events by `project()` — never stored alongside them.
 *
 * Requests are recorded as `LLMRequestSnapshot` (no `AbortSignal`) so every
 * event stays JSON-serializable.
 */

import type { LLMRequest, StopReason, ToolCall, Usage } from '../llm/types.js';
import type { Action } from '../policy/gate.js';

/** An `LLMRequest` with the non-serializable abort signal removed. */
export type LLMRequestSnapshot = Omit<LLMRequest, 'signal'>;

export interface SessionCreatedEvent {
  readonly seq: number;
  readonly t: 'session.created';
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly at: number;
}

export interface TurnStartEvent {
  readonly seq: number;
  readonly t: 'turn.start';
  readonly turn: number;
  readonly input: string;
  readonly at: number;
}

export interface StepStartEvent {
  readonly seq: number;
  readonly t: 'step.start';
  readonly turn: number;
  readonly step: number;
  readonly at: number;
}

export interface LLMRequestEvent {
  readonly seq: number;
  readonly t: 'llm.request';
  readonly requestId: string;
  readonly request: LLMRequestSnapshot;
  readonly at: number;
}

export interface LLMResponseEvent {
  readonly seq: number;
  readonly t: 'llm.response';
  readonly requestId: string;
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: Usage;
  readonly stop: StopReason;
  readonly at: number;
}

export interface ToolCallEvent {
  readonly seq: number;
  readonly t: 'tool.call';
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  readonly at: number;
}

export interface ToolResultEvent {
  readonly seq: number;
  readonly t: 'tool.result';
  readonly callId: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly output: string;
  readonly spillPath?: string;
  readonly durationMs: number;
  readonly at: number;
}

export interface ApprovalRequestEvent {
  readonly seq: number;
  readonly t: 'approval.request';
  readonly requestId: string;
  readonly action: Action;
  readonly at: number;
}

export interface ApprovalDecisionEvent {
  readonly seq: number;
  readonly t: 'approval.decision';
  readonly requestId: string;
  readonly decision: 'allow' | 'deny';
  readonly by: 'user' | 'policy';
  readonly at: number;
}

/**
 * Compaction hides a range of earlier events from the model (invariant 2).
 * The covered events stay in the log untouched; only `project()` omits them.
 */
export interface CompactionEvent {
  readonly seq: number;
  readonly t: 'compaction';
  readonly coveredFrom: number;
  readonly coveredTo: number;
  readonly summary: string;
  readonly usage: Usage;
  readonly at: number;
}

export interface TurnEndEvent {
  readonly seq: number;
  readonly t: 'turn.end';
  readonly turn: number;
  readonly status: 'done' | 'cancelled' | 'error' | 'budget_exceeded';
  readonly at: number;
}

export type SessionEvent =
  | SessionCreatedEvent
  | TurnStartEvent
  | StepStartEvent
  | LLMRequestEvent
  | LLMResponseEvent
  | ToolCallEvent
  | ToolResultEvent
  | ApprovalRequestEvent
  | ApprovalDecisionEvent
  | CompactionEvent
  | TurnEndEvent;

export type SessionEventType = SessionEvent['t'];

/** The `seq` the next appended event must carry. */
export function nextSeq(events: readonly SessionEvent[]): number {
  const last = events.at(-1);
  return last === undefined ? 1 : last.seq + 1;
}

/**
 * Throws when the log violates the contiguous-seq rule. Used by the log writer
 * (M2) and by tests that assert replay determinism.
 */
export function assertContiguousSeqs(events: readonly SessionEvent[]): void {
  events.forEach((event, index) => {
    const expected = index + 1;
    if (event.seq !== expected) {
      throw new Error(`Session log is corrupt: event at index ${index} has seq ${event.seq}, expected ${expected}.`);
    }
  });
}
