import type { JobSnapshot } from '../../src/jobs/types.js';
import type { Action, PolicyDecision, PolicyGate, SandboxMode } from '../../src/policy/gate.js';
import type {
  JobRegistry,
  SandboxedFs,
  ShellResult,
  ShellRunner,
  ToolCtx,
} from '../../src/tools/registry.js';
import { memoryFs } from './memory-fs.js';

export { memoryFs };

/** Test double for the policy layer: records every action it was asked about. */
export class RecordingGate implements PolicyGate {
  readonly calls: Action[] = [];

  constructor(
    readonly mode: SandboxMode = 'workspace-write',
    readonly outcome: PolicyDecision = { outcome: 'allow' },
  ) {}

  async decide(action: Action): Promise<PolicyDecision> {
    this.calls.push(action);
    return this.outcome;
  }
}

export function recordingShell(): ShellRunner & { readonly commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    exec: async (command): Promise<ShellResult> => {
      commands.push(command);
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

/**
 * In-memory job port for tools that never really spawn anything. Commands are
 * recorded and immediately reported as finished, so tests stay child-free.
 */
export function recordingJobs(): JobRegistry & { readonly spawned: string[] } {
  const spawned: string[] = [];
  const snapshots = new Map<string, JobSnapshot>();
  return {
    spawned,
    spawn: async (command, options) => {
      const id = `job-${String(spawned.length + 1)}`;
      spawned.push(command);
      snapshots.set(id, {
        id,
        command,
        cwd: options.cwd,
        pid: undefined,
        status: 'exited',
        startedAt: 0,
        endedAt: 1,
        exitCode: 0,
        signal: null,
        outputChars: 0,
        droppedChars: 0,
        error: undefined,
      });
      return { jobId: id };
    },
    kill: async (_jobId: string) => undefined,
    list: () => [...snapshots.keys()],
    snapshot: (jobId) => snapshots.get(jobId),
    read: (jobId) => {
      const snapshot = snapshots.get(jobId);
      return snapshot === undefined
        ? undefined
        : { snapshot, text: '', nextCursor: 0, lossy: false };
    },
    wait: async (jobId) => {
      const snapshot = snapshots.get(jobId);
      if (snapshot === undefined) {
        throw new Error(`Unknown job: ${jobId}`);
      }
      return { outcome: 'settled', snapshot };
    },
    drainNotices: () => [],
  };
}

export interface CtxOptions {
  readonly signal?: AbortSignal;
  readonly approve?: boolean;
  /** Records every action the runtime asked the human about. */
  readonly approvals?: Action[];
  readonly workdir?: string;
  readonly fs?: SandboxedFs;
  readonly reads?: ToolCtx['reads'];
  readonly jobs?: JobRegistry;
}

export function makeCtx(options: CtxOptions = {}): ToolCtx {
  const approvals = options.approvals ?? [];
  const workdir = options.workdir ?? '/ws';
  return {
    signal: options.signal ?? new AbortController().signal,
    workdir,
    fs: options.fs ?? memoryFs({ root: workdir }),
    shell: recordingShell(),
    jobs: options.jobs ?? recordingJobs(),
    ...(options.reads === undefined ? {} : { reads: options.reads }),
    requestApproval: async (action) => {
      approvals.push(action);
      return options.approve ?? true;
    },
    log: () => undefined,
  };
}
