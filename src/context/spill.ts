/**
 * Oversized tool output, kept recoverable instead of flooding the context.
 *
 * The model receives a bounded head and tail plus the path of the full text,
 * which it can read again with the filesystem tools. Content is never silently
 * dropped: if the store cannot write, the original output is returned intact.
 */

import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tokensToChars } from './tokens.js';

export interface SpillStore {
  /** Persists the text and returns a readable path. */
  put(text: string, meta?: { readonly tool?: string }): Promise<string>;
}

export interface SpillResult {
  readonly text: string;
  readonly spillPath: string | undefined;
  readonly truncated: boolean;
  readonly omittedChars: number;
}

export interface RetainOptions {
  readonly maxInlineTokens: number;
  readonly store?: SpillStore;
  readonly toolName?: string;
}

/** Splits around an omission marker so both ends of the output survive. */
export function splitHeadTail(text: string, budgetChars: number): {
  head: string;
  tail: string;
} {
  const headChars = Math.max(0, Math.floor(budgetChars * 0.6));
  const tailChars = Math.max(0, budgetChars - headChars);
  return {
    head: text.slice(0, headChars),
    tail: tailChars === 0 ? '' : text.slice(Math.max(headChars, text.length - tailChars)),
  };
}

export async function retainOutput(text: string, options: RetainOptions): Promise<SpillResult> {
  const budget = tokensToChars(options.maxInlineTokens);
  if (text.length <= budget) {
    return { text, spillPath: undefined, truncated: false, omittedChars: 0 };
  }

  const { head, tail } = splitHeadTail(text, budget);
  const omittedChars = Math.max(0, text.length - head.length - tail.length);

  let spillPath: string | undefined;
  if (options.store !== undefined) {
    try {
      spillPath = await options.store.put(text, { tool: options.toolName ?? 'tool' });
    } catch {
      // Losing the file is acceptable; losing the output is not.
      spillPath = undefined;
    }
  }

  const notice =
    spillPath === undefined
      ? `\n\n... (${String(omittedChars)} characters omitted; output exceeded the inline budget) ...\n\n`
      : `\n\n... (${String(omittedChars)} characters omitted; full output at ${spillPath}) ...\n\n`;

  return { text: `${head}${notice}${tail}`, spillPath, truncated: true, omittedChars };
}

export interface FileSpillStoreOptions {
  readonly dir: string;
  /** Injectable for deterministic file names in tests. */
  readonly nextId?: () => string;
}

export function createFileSpillStore(options: FileSpillStoreOptions): SpillStore {
  let counter = 0;
  const nextId =
    options.nextId ??
    ((): string => {
      counter += 1;
      return `${String(counter).padStart(4, '0')}`;
    });

  return {
    async put(text, meta) {
      await mkdir(options.dir, { recursive: true });
      const name = `${meta?.tool ?? 'tool'}-${nextId()}.txt`;
      const path = join(options.dir, name);
      const handle = await open(path, 'w');
      try {
        await handle.write(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return path;
    },
  };
}
