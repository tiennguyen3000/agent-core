/**
 * Process-backed job registry.
 *
 * Two properties matter beyond "it runs a command":
 *  - memory is bounded: output lives in a ring buffer, so a runaway command
 *    cannot grow the agent's heap, and the caller is told what was dropped;
 *  - nothing is left behind: `kill` signals the child's own process group
 *    (SIGTERM, then SIGKILL after a grace period) and only settles once the
 *    process is really gone.
 *
 * The child receives an allowlisted environment, so a deployment's secrets do
 * not leak into every command it runs (invariant 9).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type {
  JobNotice,
  JobRegistry,
  JobSnapshot,
  JobStatus,
  JobWaitOptions,
  JobWaitResult,
} from './types.js';

export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'SHELL',
  'USER',
  'LOGNAME',
  'PWD',
];

const DEFAULT_MAX_OUTPUT_CHARS = 262_144;
const DEFAULT_KILL_GRACE_MS = 3_000;

export interface ProcessJobRegistryOptions {
  readonly env?: Record<string, string | undefined>;
  readonly envAllowlist?: readonly string[];
  /** Extra variable names to pass through on top of the allowlist. */
  readonly envPassthrough?: readonly string[];
  readonly maxOutputChars?: number;
  readonly killGraceMs?: number;
  /** Injectable timer so a deadline can be fired deterministically in tests. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  readonly now?: () => number;
  readonly spawnImpl?: typeof nodeSpawn;
  /** Injectable so the Windows branches are exercised on any platform. */
  readonly platform?: NodeJS.Platform;
}

interface JobRecord {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly child: ChildProcess;
  readonly startedAt: number;
  readonly exitPromise: Promise<void>;
  resolveExit: () => void;
  status: JobStatus;
  endedAt: number | undefined;
  exitCode: number | null;
  signal: string | null;
  error: string | undefined;
  text: string;
  droppedChars: number;
  outputChars: number;
  killRequested: boolean;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

export function createProcessJobRegistry(
  options: ProcessJobRegistryOptions = {},
): JobRegistry {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const schedule = options.schedule ?? defaultSchedule;
  const now = options.now ?? (() => Date.now());
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const sourceEnv = options.env ?? process.env;
  const envNames = new Set([
    ...(options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST),
    ...(options.envPassthrough ?? []),
  ]);

  const childEnv: Record<string, string> = {};
  for (const name of envNames) {
    const value = sourceEnv[name];
    if (value !== undefined) {
      childEnv[name] = value;
    }
  }

  const jobs = new Map<string, JobRecord>();
  const notices: JobNotice[] = [];
  let counter = 0;

  const snapshotOf = (record: JobRecord): JobSnapshot => ({
    id: record.id,
    command: record.command,
    cwd: record.cwd,
    pid: record.child.pid,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    outputChars: record.outputChars,
    droppedChars: record.droppedChars,
    error: record.error,
  });

  const requireRecord = (jobId: string): JobRecord => {
    const record = jobs.get(jobId);
    if (record === undefined) {
      throw new Error(`Unknown job: ${jobId}`);
    }
    return record;
  };

  /**
   * Windows has no process groups and `child.kill` only reaches the immediate
   * child, so `cmd /c a | b` would leave grandchildren running. `taskkill /T`
   * walks the tree; its own failure falls back to the direct signal.
   */
  const platform = options.platform ?? process.platform;

  const killTreeOnWindows = (pid: number): boolean => {
    try {
      const killer = (options.spawnImpl ?? nodeSpawn)('taskkill', [
        '/PID',
        String(pid),
        '/T',
        '/F',
      ], { stdio: 'ignore' });
      killer.on('error', () => undefined);
      killer.unref();
      return true;
    } catch {
      return false;
    }
  };

  const signalProcess = (record: JobRecord, signal: NodeJS.Signals): void => {
    const pid = record.child.pid;
    if (pid !== undefined && platform === 'win32') {
      if (killTreeOnWindows(pid)) {
        return;
      }
    }
    try {
      if (pid !== undefined && platform !== 'win32') {
        // Negative pid targets the group, so `bash -c "a | b"` dies whole.
        process.kill(-pid, signal);
        return;
      }
    } catch {
      // Fall through to the direct child signal below.
    }
    try {
      record.child.kill(signal);
    } catch {
      // The process is already gone.
    }
  };

  const append = (record: JobRecord, chunk: string): void => {
    record.text += chunk;
    record.outputChars += chunk.length;
    if (record.text.length > maxOutputChars) {
      const excess = record.text.length - maxOutputChars;
      record.text = record.text.slice(excess);
      record.droppedChars += excess;
    }
  };

  const finish = (record: JobRecord): void => {
    if (record.status === 'running') {
      record.status = record.killRequested
        ? 'killed'
        : record.exitCode === 0 || (record.exitCode === null && record.signal === null)
          ? 'exited'
          : 'failed';
    }
    record.endedAt = now();
    notices.push({
      jobId: record.id,
      command: record.command,
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
    });
    record.resolveExit();
  };

  return {
    async spawn(command, spawnOptions) {
      counter += 1;
      const id = `job-${String(counter)}`;
      const child = spawnImpl(command, {
        cwd: spawnOptions.cwd,
        env: childEnv,
        shell: true,
        // Own process group on POSIX so the whole command tree can be killed.
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let resolveExit: () => void = () => undefined;
      const exitPromise = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });

      const record: JobRecord = {
        id,
        command,
        cwd: spawnOptions.cwd,
        child,
        startedAt: now(),
        exitPromise,
        resolveExit,
        status: 'running',
        endedAt: undefined,
        exitCode: null,
        signal: null,
        error: undefined,
        text: '',
        droppedChars: 0,
        outputChars: 0,
        killRequested: false,
      };
      jobs.set(id, record);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        append(record, chunk);
      });
      child.stderr?.on('data', (chunk: string) => {
        append(record, chunk);
      });
      child.on('error', (error) => {
        record.error = error.message;
        record.exitCode = null;
        finish(record);
      });
      child.on('exit', (code, signal) => {
        record.exitCode = code;
        record.signal = signal;
        append(
          record,
          `\n[exit code: ${code === null ? 'null' : String(code)}${signal === null ? '' : `, signal: ${signal}`}]\n`,
        );
        finish(record);
      });

      return { jobId: id };
    },

    async kill(jobId) {
      const record = requireRecord(jobId);
      if (record.status !== 'running') {
        return;
      }
      record.killRequested = true;
      signalProcess(record, 'SIGTERM');
      const escalate = schedule(() => {
        if (record.status === 'running') {
          signalProcess(record, 'SIGKILL');
        }
      }, killGraceMs);
      try {
        await record.exitPromise;
      } finally {
        escalate();
      }
    },

    list() {
      return [...jobs.keys()];
    },

    snapshot(jobId) {
      const record = jobs.get(jobId);
      return record === undefined ? undefined : snapshotOf(record);
    },

    read(jobId, readOptions) {
      const record = jobs.get(jobId);
      if (record === undefined) {
        return undefined;
      }
      const since = readOptions?.since ?? 0;
      const base = record.outputChars - record.text.length;
      const start = Math.max(since - base, 0);
      return {
        snapshot: snapshotOf(record),
        text: record.text.slice(start),
        nextCursor: record.outputChars,
        lossy: since < base,
      };
    },

    async wait(jobId, waitOptions: JobWaitOptions = {}) {
      const record = requireRecord(jobId);
      if (record.status !== 'running') {
        return { outcome: 'settled', snapshot: snapshotOf(record) };
      }

      const timeoutMs = waitOptions.timeoutMs ?? 0;
      const signal = waitOptions.signal;
      if (signal?.aborted === true) {
        return { outcome: 'cancelled', snapshot: snapshotOf(record) };
      }

      let cancelTimer: (() => void) | undefined;
      let removeAbort: (() => void) | undefined;
      const racers: Promise<JobWaitResult>[] = [
        record.exitPromise.then(() => ({
          outcome: 'settled' as const,
          snapshot: snapshotOf(record),
        })),
      ];

      if (timeoutMs > 0) {
        racers.push(
          new Promise<JobWaitResult>((resolve) => {
            cancelTimer = schedule(() => {
              resolve({ outcome: 'running', snapshot: snapshotOf(record) });
            }, timeoutMs);
          }),
        );
      }
      if (signal !== undefined) {
        racers.push(
          new Promise<JobWaitResult>((resolve) => {
            const onAbort = (): void => {
              resolve({ outcome: 'cancelled', snapshot: snapshotOf(record) });
            };
            signal.addEventListener('abort', onAbort, { once: true });
            removeAbort = () => {
              signal.removeEventListener('abort', onAbort);
            };
          }),
        );
      }

      try {
        return await Promise.race(racers);
      } finally {
        cancelTimer?.();
        removeAbort?.();
      }
    },

    drainNotices() {
      return notices.splice(0, notices.length);
    },
  };
}
