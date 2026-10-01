/**
 * Sandbox runtime: one call that wires policy, enforcement and approval.
 *
 * The gate decides, the ports enforce, the broker answers, and every decision
 * goes to one audit sink. M8's CLI composes this and hands the pieces to the
 * tool context.
 */

import { createLocalFs } from '../fs/local.js';
import { createBashShellRunner } from '../shell/bash.js';
import type { OsSandboxBackend } from '../shell/os-sandbox.js';
import { createSandboxedShellRunner } from '../shell/sandboxed.js';
import type { SandboxedShellRunner } from '../shell/sandboxed.js';
import type { SessionEventInput } from '../session/log.js';
import type { SandboxedFs, ShellRunner } from '../tools/registry.js';
import { createApprovalBroker } from './approval.js';
import type { ApprovalAnswerer, ApprovalAuditEvent, ApprovalRequest } from './approval.js';
import type { Action, PolicyGate, SandboxMode } from './gate.js';
import { createSandboxPolicy } from './sandbox.js';
import type { PolicyAuditEvent } from './sandbox.js';
import { createSandboxedFs } from './sandboxed-fs.js';

export type AuditEvent = PolicyAuditEvent | ApprovalAuditEvent;

/**
 * Adapts audit events to a session log. The log owns `seq` and `at`, so they
 * are stripped here — a decision is recorded once, by the log.
 */
export function createLogAuditSink(
  append: (input: SessionEventInput) => unknown,
): (event: AuditEvent) => void {
  return (event) => {
    const { at: _at, ...input } = event;
    void _at;
    void append(input as SessionEventInput);
  };
}

export interface SandboxRuntimeOptions {
  readonly mode: SandboxMode;
  readonly workspaceRoot: string;
  readonly tempGrants?: readonly string[];
  readonly outsideWorkspace?: 'deny' | 'ask';
  readonly audit?: (event: AuditEvent) => void;
  readonly answerer?: ApprovalAnswerer;
  readonly approvalTimeoutMs?: number;
  readonly innerFs?: SandboxedFs;
  readonly innerShell?: ShellRunner;
  readonly osSandbox?: OsSandboxBackend;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

export interface SandboxRuntime {
  readonly mode: SandboxMode;
  readonly gate: PolicyGate;
  readonly fs: SandboxedFs;
  readonly shell: SandboxedShellRunner;
  requestApproval(action: Action): Promise<boolean>;
  answer(requestId: string, approved: boolean): boolean;
  readonly pendingApprovals: readonly ApprovalRequest[];
}

export function createSandboxRuntime(options: SandboxRuntimeOptions): SandboxRuntime {
  const scope = {
    mode: options.mode,
    workspaceRoot: options.workspaceRoot,
    ...(options.tempGrants === undefined ? {} : { tempGrants: options.tempGrants }),
  };

  const gate = createSandboxPolicy({
    ...scope,
    ...(options.outsideWorkspace === undefined
      ? {}
      : { outsideWorkspace: options.outsideWorkspace }),
    ...(options.audit === undefined ? {} : { onDecision: options.audit }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const approval = createApprovalBroker({
    ...(options.audit === undefined ? {} : { onEvent: options.audit }),
    ...(options.approvalTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.approvalTimeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
  });
  approval.registerAnswerer(options.answerer);

  const fs = createSandboxedFs({ ...scope, inner: options.innerFs ?? createLocalFs() });

  const shell = createSandboxedShellRunner({
    mode: options.mode,
    workspaceRoot: options.workspaceRoot,
    tempGrants: options.tempGrants ?? [],
    inner: options.innerShell ?? createBashShellRunner(),
    ...(options.osSandbox === undefined ? {} : { osSandbox: options.osSandbox }),
  });

  return {
    mode: options.mode,
    gate,
    fs,
    shell,
    requestApproval: (action) => approval.requestApproval(action),
    answer: (requestId, approved) => approval.answer(requestId, approved),
    get pendingApprovals() {
      return approval.pending;
    },
  };
}
