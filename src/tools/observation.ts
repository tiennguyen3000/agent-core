/**
 * Read-before-edit tracking (the observation policy).
 *
 * Optional on `ToolCtx`: a deployment that wants guarded writes mounts a
 * tracker, and the filesystem tools then refuse to overwrite a file the agent
 * never read, or one that changed since it was read. Reading a *missing* path
 * records the absence, which authorises creating exactly that path.
 */

import { createHash } from 'node:crypto';

export type ReadStatus = 'ok' | 'not-read' | 'stale';

/** `null` records "this path was read and did not exist". */
type Recorded = string | null;

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32);
}

export class ReadTracker {
  readonly #seen = new Map<string, Recorded>();

  /** Records a successful read, or the confirmed absence of a path. */
  record(path: string, content: string | undefined): void {
    this.#seen.set(path, content === undefined ? null : digest(content));
  }

  forget(path: string): void {
    this.#seen.delete(path);
  }

  clear(): void {
    this.#seen.clear();
  }

  get size(): number {
    return this.#seen.size;
  }

  /**
   * `ok` means the mutation is authorised by a previous read; `not-read` means
   * no read happened; `stale` means the content (or existence) moved on.
   */
  status(path: string, currentContent: string | undefined): ReadStatus {
    if (!this.#seen.has(path)) {
      return 'not-read';
    }
    const seen = this.#seen.get(path) ?? null;
    if (seen === null) {
      return currentContent === undefined ? 'ok' : 'stale';
    }
    if (currentContent === undefined) {
      return 'stale';
    }
    return digest(currentContent) === seen ? 'ok' : 'stale';
  }
}
