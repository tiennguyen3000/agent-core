/**
 * Sandboxed filesystem port.
 *
 * The policy gate already refuses disallowed mutations before a handler runs;
 * this layer is the enforcement half, so a tool that reaches the port without a
 * decision still cannot write outside the sandbox. Violations carry the stable
 * `E_POLICY_DENIED` code, which `dispatch` surfaces to the model.
 */

import type { SandboxedFs } from '../tools/registry.js';
import { checkWrite } from './sandbox.js';
import type { SandboxScope } from './sandbox.js';

export class SandboxViolationError extends Error {
  readonly code = 'E_POLICY_DENIED';

  constructor(message: string) {
    super(message);
    this.name = 'SandboxViolationError';
  }
}

export interface SandboxedFsOptions extends SandboxScope {
  readonly inner: SandboxedFs;
}

export function createSandboxedFs(options: SandboxedFsOptions): SandboxedFs {
  return {
    async read(path) {
      return await options.inner.read(path);
    },

    async readBytes(path) {
      return await options.inner.readBytes(path);
    },

    async write(path, content) {
      const verdict = checkWrite(options, path);
      if (!verdict.allowed) {
        throw new SandboxViolationError(
          `Refusing to write ${path}: ${verdict.reason ?? 'blocked by the sandbox'}.`,
        );
      }
      await options.inner.write(path, content);
    },

    async exists(path) {
      return await options.inner.exists(path);
    },

    async list(dir) {
      return await options.inner.list(dir);
    },
  };
}
