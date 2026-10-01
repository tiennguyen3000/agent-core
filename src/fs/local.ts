/**
 * Filesystem backend for real disk.
 *
 * Writes are atomic: content lands in a sibling temporary file that is fsynced
 * and then renamed over the target, so a crash never leaves a half-written
 * source file behind.
 */

import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DirEntry, SandboxedFs } from '../tools/registry.js';

export interface LocalFsOptions {
  /** Injectable for deterministic temporary names in tests. */
  readonly nextId?: () => string;
}

export function createLocalFs(options: LocalFsOptions = {}): SandboxedFs {
  let counter = 0;
  const nextId =
    options.nextId ??
    ((): string => {
      counter += 1;
      return `${String(process.pid)}-${String(counter)}`;
    });

  return {
    async read(path) {
      return await readFile(path, 'utf8');
    },

    async write(path, content) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = join(dirname(path), `.${String(process.pid)}-${nextId()}.tmp`);
      const handle = await open(temporary, 'w');
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },

    async exists(path) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },

    async list(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .map((entry): DirEntry => ({ name: entry.name, isDirectory: entry.isDirectory() }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
