/**
 * One-shot shell port implementation.
 *
 * `ShellRunner` is the simple "run and collect" path used by tools that need
 * separated stdout/stderr; the model-facing `bash` tool goes through the job
 * registry instead. Cancellation here kills the command's process group, so an
 * aborted call never leaves a live child behind.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { splitHeadTail } from '../context/spill.js';
import { DEFAULT_ENV_ALLOWLIST } from '../jobs/registry.js';
import type { ShellResult, ShellRunner } from '../tools/registry.js';

const DEFAULT_MAX_OUTPUT_CHARS = 131_072;
const DEFAULT_KILL_GRACE_MS = 3_000;

export interface BashShellRunnerOptions {
  readonly shell?: string;
  readonly env?: Record<string, string | undefined>;
  readonly envAllowlist?: readonly string[];
  readonly envPassthrough?: readonly string[];
  /** Per-stream cap; beyond it the head and the tail are kept with a notice. */
  readonly maxOutputChars?: number;
  readonly killGraceMs?: number;
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  readonly spawnImpl?: typeof nodeSpawn;
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  try {
    if (pid !== undefined && process.platform !== 'win32') {
      process.kill(-pid, signal);
      return;
    }
  } catch {
    // Fall through to the direct child signal.
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

export function createBashShellRunner(options: BashShellRunnerOptions = {}): ShellRunner {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const shell = options.shell ?? process.env.SHELL ?? '/bin/bash';
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return () => clearTimeout(timer);
    });

  const sourceEnv = options.env ?? process.env;
  const names = new Set([
    ...(options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST),
    ...(options.envPassthrough ?? []),
  ]);
  const childEnv: Record<string, string> = {};
  for (const name of names) {
    const value = sourceEnv[name];
    if (value !== undefined) {
      childEnv[name] = value;
    }
  }

  const cap = (text: string): string => {
    if (text.length <= maxOutputChars) {
      return text;
    }
    const { head, tail } = splitHeadTail(text, maxOutputChars);
    const omitted = text.length - head.length - tail.length;
    return `${head}\n... (${String(omitted)} characters omitted) ...\n${tail}`;
  };

  return {
    async exec(command, execOptions): Promise<ShellResult> {
      const child = spawnImpl(shell, ['-lc', command], {
        cwd: execOptions.cwd,
        env: childEnv,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });

      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.on('error', () => {
          resolve({ code: null, signal: null });
        });
        child.on('exit', (code, signal) => {
          resolve({ code, signal });
        });
      });

      let aborted = false;
      let cancelEscalation: (() => void) | undefined;
      const onAbort = (): void => {
        aborted = true;
        signalProcess(child, 'SIGTERM');
        cancelEscalation = schedule(() => {
          signalProcess(child, 'SIGKILL');
        }, killGraceMs);
      };
      execOptions.signal.addEventListener('abort', onAbort, { once: true });

      try {
        const { code, signal } = await exited;
        const effectiveCode = aborted ? 130 : (code ?? (signal === null ? 0 : 1));
        return {
          code: effectiveCode,
          stdout: cap(stdout),
          stderr: cap(stderr),
          ...(signal === null && !aborted ? {} : { signal: signal ?? 'SIGTERM' }),
        };
      } finally {
        cancelEscalation?.();
        execOptions.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
