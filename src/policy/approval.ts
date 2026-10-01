/**
 * Channel-neutral approval broker (invariant 3 and 7).
 *
 * A tool that asks for approval gets exactly one answer for exactly one action.
 * The broker fails **closed**: with no answerer attached, a failing answerer, or
 * a deadline that passes first, the action is denied. Every request and every
 * decision is emitted to the audit sink.
 */

import type { Action } from './gate.js';

export interface ApprovalRequest {
  readonly id: string;
  readonly action: Action;
  readonly reason?: string;
}

export type ApprovalAnswerer = (request: ApprovalRequest) => boolean | Promise<boolean>;

export type ApprovalAuditEvent =
  | {
      readonly t: 'approval.request';
      readonly requestId: string;
      readonly action: Action;
      readonly at: number;
    }
  | {
      readonly t: 'approval.decision';
      readonly requestId: string;
      readonly decision: 'allow' | 'deny';
      readonly by: 'user' | 'policy';
      readonly at: number;
    };

export interface ApprovalBrokerOptions {
  readonly onEvent?: (event: ApprovalAuditEvent) => void;
  /** 0 (default) waits forever; a deadline denies when it fires first. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

export interface ApprovalBroker {
  /** The `ToolCtx.requestApproval` seam. */
  requestApproval(action: Action): Promise<boolean>;
  /** Resolves a pending request; returns false when the id is unknown or stale. */
  answer(requestId: string, approved: boolean): boolean;
  registerAnswerer(answerer: ApprovalAnswerer | undefined): void;
  readonly pending: readonly ApprovalRequest[];
}

interface Pending {
  readonly request: ApprovalRequest;
  settle(approved: boolean): void;
  answered: boolean;
}

export function createApprovalBroker(options: ApprovalBrokerOptions = {}): ApprovalBroker {
  const now = options.now ?? (() => Date.now());
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return () => clearTimeout(timer);
    });
  const timeoutMs = options.timeoutMs ?? 0;

  const pending = new Map<string, Pending>();
  let answerer: ApprovalAnswerer | undefined;
  let counter = 0;

  const emit = (event: ApprovalAuditEvent): void => {
    options.onEvent?.(event);
  };

  const decide = (entry: Pending, approved: boolean, by: 'user' | 'policy'): void => {
    if (entry.answered) {
      return;
    }
    entry.answered = true;
    pending.delete(entry.request.id);
    emit({
      t: 'approval.decision',
      requestId: entry.request.id,
      decision: approved ? 'allow' : 'deny',
      by,
      at: now(),
    });
    entry.settle(approved);
  };

  return {
    async requestApproval(action) {
      counter += 1;
      const request: ApprovalRequest = { id: `approval-${String(counter)}`, action };
      emit({ t: 'approval.request', requestId: request.id, action, at: now() });

      const currentAnswerer = answerer;
      if (currentAnswerer === undefined) {
        // No channel can answer: fail closed without prompting anyone.
        const entry: Pending = {
          request,
          answered: false,
          settle: () => undefined,
        };
        decide(entry, false, 'policy');
        return false;
      }

      let settle: (approved: boolean) => void = () => undefined;
      const answerPromise = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      const entry: Pending = { request, settle, answered: false };
      pending.set(request.id, entry);

      let cancelTimer: (() => void) | undefined;

      void (async () => {
        try {
          const approved = await currentAnswerer(request);
          decide(entry, approved === true, 'user');
        } catch {
          // An answerer that throws cannot be trusted: deny.
          decide(entry, false, 'policy');
        }
      })();

      if (timeoutMs > 0) {
        cancelTimer = schedule(() => {
          decide(entry, false, 'policy');
        }, timeoutMs);
      }

      try {
        return await answerPromise;
      } finally {
        cancelTimer?.();
        pending.delete(request.id);
      }
    },

    answer(requestId, approved) {
      const entry = pending.get(requestId);
      if (entry === undefined) {
        return false;
      }
      decide(entry, approved, 'user');
      return true;
    },

    registerAnswerer(next) {
      answerer = next;
    },

    get pending() {
      return [...pending.values()].map((entry) => entry.request);
    },
  };
}
