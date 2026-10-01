import type { Action, PolicyDecision, PolicyGate, SandboxMode } from '../../src/policy/gate.js';
import type {
  JobRegistry,
  SandboxedFs,
  ShellResult,
  ShellRunner,
  ToolCtx,
} from '../../src/tools/registry.js';

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

export function memoryFs(): SandboxedFs & { readonly files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: async (path) => {
      const value = files.get(path);
      if (value === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return value;
    },
    write: async (path, content) => {
      files.set(path, content);
    },
    exists: async (path) => files.has(path),
  };
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

export function recordingJobs(): JobRegistry & { readonly spawned: string[] } {
  const spawned: string[] = [];
  return {
    spawned,
    spawn: async (command) => {
      spawned.push(command);
      return { jobId: `job-${spawned.length}` };
    },
    kill: async (_jobId: string) => undefined,
    list: () => [...spawned],
  };
}

export interface CtxOptions {
  readonly signal?: AbortSignal;
  readonly approve?: boolean;
  /** Records every action the runtime asked the human about. */
  readonly approvals?: Action[];
}

export function makeCtx(options: CtxOptions = {}): ToolCtx {
  const approvals = options.approvals ?? [];
  return {
    signal: options.signal ?? new AbortController().signal,
    workdir: '/workspace',
    fs: memoryFs(),
    shell: recordingShell(),
    jobs: recordingJobs(),
    requestApproval: async (action) => {
      approvals.push(action);
      return options.approve ?? true;
    },
    log: () => undefined,
  };
}
