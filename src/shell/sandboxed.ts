/**
 * Shell runner wrapped by the sandbox policy.
 *
 * `confinement` states the truth about a given composition: `os-sandbox` only
 * when a backend is mounted and the mode actually needs it, `unconfined`
 * otherwise. A deployment should surface that value instead of assuming the
 * shell is contained.
 *
 * Read-only mode refuses to run anything: a shell can always mutate, so there
 * is no safe subset to allow there.
 */

import type { SandboxMode } from '../policy/gate.js';
import type { ShellResult, ShellRunner } from '../tools/registry.js';
import type { OsSandboxBackend } from './os-sandbox.js';

export type Confinement = 'os-sandbox' | 'unconfined';

export type SandboxedShellRunner = ShellRunner & { readonly confinement: Confinement };

export interface SandboxedShellRunnerOptions {
  readonly mode: SandboxMode;
  readonly inner: ShellRunner;
  readonly workspaceRoot: string;
  readonly tempGrants?: readonly string[];
  readonly osSandbox?: OsSandboxBackend;
}

export function createSandboxedShellRunner(
  options: SandboxedShellRunnerOptions,
): SandboxedShellRunner {
  const tempGrants = options.tempGrants ?? [];
  const needsConfinement = options.mode !== 'full-access';
  const confinement: Confinement =
    needsConfinement && options.osSandbox !== undefined ? 'os-sandbox' : 'unconfined';

  return {
    confinement,

    async exec(command, execOptions): Promise<ShellResult> {
      if (options.mode === 'read-only') {
        return {
          code: 126,
          stdout: '',
          stderr: `shell execution is denied in read-only mode (command: ${command})\n`,
        };
      }

      if (confinement === 'unconfined' || options.osSandbox === undefined) {
        return await options.inner.exec(command, execOptions);
      }

      const wrapped = options.osSandbox.wrap(command, {
        workspaceRoot: options.workspaceRoot,
        tempGrants,
        cwd: execOptions.cwd,
      });

      if (options.inner.execArgv === undefined) {
        return {
          code: 126,
          stdout: '',
          stderr:
            'the inner shell runner cannot execute an argv, so the OS sandbox cannot be applied\n',
        };
      }
      return await options.inner.execArgv(wrapped.file, wrapped.args, execOptions);
    },
  };
}
