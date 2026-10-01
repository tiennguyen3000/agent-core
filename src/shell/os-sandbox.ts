/**
 * OS-level sandbox seam.
 *
 * In-process policy cannot stop a shell command from writing anywhere the user
 * can; only the operating system can. This module defines the seam and ships a
 * macOS seatbelt backend. `probe()` reports whether the platform actually lets
 * the sandbox be applied — a deployment must not assume it does.
 */

import { spawn as nodeSpawn } from 'node:child_process';

export interface OsSandboxContext {
  readonly workspaceRoot: string;
  readonly tempGrants: readonly string[];
  readonly cwd: string;
}

export interface WrappedCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export interface OsSandboxProbe {
  readonly available: boolean;
  readonly detail: string;
}

export interface OsSandboxBackend {
  readonly id: string;
  wrap(command: string, context: OsSandboxContext): WrappedCommand;
  probe(): Promise<OsSandboxProbe>;
}

function escapeProfileString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Seatbelt profile: deny everything, then allow process execution, reads and
 * writes confined to the workspace plus the session's temp grants.
 */
export function buildSeatbeltProfile(context: {
  readonly workspaceRoot: string;
  readonly tempGrants: readonly string[];
}): string {
  const writable = [context.workspaceRoot, ...context.tempGrants]
    .map((path) => `  (subpath "${escapeProfileString(path)}")`)
    .join('\n');
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec*)',
    '(allow process-fork)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow file-read*)',
    '(allow file-write*',
    writable,
    ')',
    '',
  ].join('\n');
}

export interface SeatbeltBackendOptions {
  readonly executable?: string;
  readonly shell?: string;
  readonly spawnImpl?: typeof nodeSpawn;
}

export function createSeatbeltBackend(options: SeatbeltBackendOptions = {}): OsSandboxBackend {
  const executable = options.executable ?? '/usr/bin/sandbox-exec';
  const shell = options.shell ?? '/bin/bash';
  const spawnImpl = options.spawnImpl ?? nodeSpawn;

  return {
    id: 'seatbelt',

    wrap(command, context) {
      const profile = buildSeatbeltProfile({
        workspaceRoot: context.workspaceRoot,
        tempGrants: context.tempGrants,
      });
      return { file: executable, args: ['-p', profile, shell, '-lc', command] };
    },

    async probe() {
      return await new Promise<OsSandboxProbe>((resolve) => {
        const child = spawnImpl(executable, ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', (error) => {
          resolve({ available: false, detail: `cannot start ${executable}: ${error.message}` });
        });
        child.on('exit', (code) => {
          resolve(
            code === 0
              ? { available: true, detail: 'seatbelt applied successfully' }
              : { available: false, detail: stderr.trim() || `exit code ${String(code)}` },
          );
        });
      });
    },
  };
}
