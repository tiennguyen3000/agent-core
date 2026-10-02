/**
 * Sandbox policy (invariant 3).
 *
 * One rule decides where a mutation may land, and both the gate and the
 * sandboxed filesystem port use it — so a decision and its enforcement can
 * never drift apart.
 *
 * Reads are deliberately not restricted: like the reference implementation, the
 * sandbox preserves local read behaviour and confines *effects*.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type { Action, PolicyDecision, PolicyGate, PolicyOutcome, SandboxMode } from './gate.js';

export interface SandboxScope {
  readonly mode: SandboxMode;
  readonly workspaceRoot: string;
  /** Directories writable in `workspace-write` even outside the workspace. */
  readonly tempGrants?: readonly string[];
}

export function toAbsolute(scope: SandboxScope, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(scope.workspaceRoot, path);
}

/**
 * Is `absolute` the root itself or below it?
 *
 * A string prefix check with `/` is wrong on Windows twice over: children are
 * joined with `\`, and paths there are case-insensitive. `relative` handles
 * both, so a write to `<root>\notes.md` counts as inside `<root>`.
 */
function isWithin(root: string, absolute: string): boolean {
  const rel = relative(resolve(root), resolve(absolute));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export interface WriteVerdict {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** The single source of truth for "may this path be written?". */
export function checkWrite(scope: SandboxScope, path: string): WriteVerdict {
  if (scope.mode === 'full-access') {
    return { allowed: true };
  }
  if (scope.mode === 'read-only') {
    return { allowed: false, reason: 'read-only mode forbids file mutations' };
  }

  const absolute = toAbsolute(scope, path);
  if (isWithin(scope.workspaceRoot, absolute)) {
    return { allowed: true };
  }
  for (const grant of scope.tempGrants ?? []) {
    if (isWithin(grant, absolute)) {
      return { allowed: true };
    }
  }
  return {
    allowed: false,
    reason: `${absolute} is outside the workspace (${scope.workspaceRoot}) and outside every temp grant`,
  };
}

export interface PolicyAuditEvent {
  readonly t: 'policy.decision';
  readonly requestId: string;
  readonly action: Action;
  readonly outcome: PolicyOutcome;
  readonly reason?: string;
  readonly at: number;
}

export interface SandboxPolicyOptions extends SandboxScope {
  /** What to do when a write leaves the workspace: refuse, or ask the human. */
  readonly outsideWorkspace?: 'deny' | 'ask';
  readonly onDecision?: (event: PolicyAuditEvent) => void;
  readonly now?: () => number;
}

export function createSandboxPolicy(options: SandboxPolicyOptions): PolicyGate {
  const outsideWorkspace = options.outsideWorkspace ?? 'deny';
  const now = options.now ?? (() => Date.now());
  let counter = 0;

  const record = (
    action: Action,
    outcome: PolicyOutcome,
    reason: string | undefined,
  ): PolicyDecision => {
    counter += 1;
    options.onDecision?.({
      t: 'policy.decision',
      requestId: `policy-${String(counter)}`,
      action,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      at: now(),
    });
    return reason === undefined ? { outcome } : { outcome, reason };
  };

  return {
    mode: options.mode,
    async decide(action: Action): Promise<PolicyDecision> {
      switch (action.kind) {
        case 'fs.read':
        case 'net.fetch':
          return record(action, 'allow', undefined);
        case 'shell.exec':
          return options.mode === 'read-only'
            ? record(action, 'deny', 'read-only mode forbids shell execution')
            : record(action, 'allow', undefined);
        case 'fs.write': {
          const verdict = checkWrite(options, action.path);
          if (verdict.allowed) {
            return record(action, 'allow', undefined);
          }
          if (outsideWorkspace === 'ask') {
            return record(action, 'ask', verdict.reason);
          }
          return record(action, 'deny', verdict.reason);
        }
      }
    },
  };
}
