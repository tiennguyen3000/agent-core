import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  ToolRegistry,
  createFileSpillStore,
  createFsReadTool,
  estimateTokens,
  retainOutput,
  splitHeadTail,
} from '../src/index.js';
import type { SpillStore, ToolDef } from '../src/index.js';
import { makeCtx, memoryFs } from './helpers/ctx.js';
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => removeTmpDir(dir)));
});

async function tmp(): Promise<string> {
  const dir = await makeTmpDir();
  dirs.push(dir);
  return dir;
}

function recordingStore(): SpillStore & { readonly puts: { text: string; tool?: string }[] } {
  const puts: { text: string; tool?: string }[] = [];
  return {
    puts,
    put: async (text, meta) => {
      const entry: { text: string; tool?: string } = { text };
      if (meta?.tool !== undefined) {
        entry.tool = meta.tool;
      }
      puts.push(entry);
      return `/spill/${String(puts.length)}.txt`;
    },
  };
}

describe('retainOutput', () => {
  it('leaves text under the budget untouched', async () => {
    const result = await retainOutput('short', { maxInlineTokens: 100 });

    expect(result).toEqual({
      text: 'short',
      spillPath: undefined,
      truncated: false,
      omittedChars: 0,
    });
  });

  it('keeps a head and a tail and points at the spilled file', async () => {
    const store = recordingStore();
    const text = `${'a'.repeat(400)}${'b'.repeat(4000)}${'c'.repeat(400)}`;

    const result = await retainOutput(text, { maxInlineTokens: 40, store, toolName: 'fs_read' });

    expect(result.truncated).toBe(true);
    expect(result.spillPath).toBe('/spill/1.txt');
    expect(result.omittedChars).toBeGreaterThan(0);
    expect(result.text.startsWith('a')).toBe(true);
    expect(result.text.endsWith('c')).toBe(true);
    expect(result.text).toContain('/spill/1.txt');
    expect(store.puts[0]?.text).toBe(text);
    expect(store.puts[0]?.tool).toBe('fs_read');
    expect(result.text.length).toBeLessThan(text.length);
  });

  it('truncates with a notice when no store is mounted', async () => {
    const result = await retainOutput('x'.repeat(4000), { maxInlineTokens: 20 });

    expect(result.spillPath).toBeUndefined();
    expect(result.text).toContain('output exceeded the inline budget');
    expect(result.truncated).toBe(true);
  });

  it('never loses the output when the store fails', async () => {
    const failing: SpillStore = {
      put: async () => {
        throw new Error('disk full');
      },
    };

    const result = await retainOutput('y'.repeat(4000), { maxInlineTokens: 20, store: failing });

    expect(result.spillPath).toBeUndefined();
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('y')).toBe(true);
    expect(result.text.endsWith('y')).toBe(true);
  });

  it('splits roughly 60/40 without overlapping', () => {
    const { head, tail } = splitHeadTail('0123456789', 10);

    expect(head).toBe('012345');
    expect(tail).toBe('6789');
    expect(head.length + tail.length).toBe(10);
  });

  it('estimates tokens from characters', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(35))).toBe(10);
  });
});

describe('file spill store', () => {
  it('writes the full text to a readable file', async () => {
    const dir = await tmp();
    const store = createFileSpillStore({ dir });

    const path = await store.put('full output', { tool: 'fs_grep' });

    expect(path).toContain('fs_grep-');
    expect(await readFile(path, 'utf8')).toBe('full output');
  });
});

describe('registry retention', () => {
  function setup(options: { spill?: SpillStore } = {}) {
    const registry = new ToolRegistry(options.spill === undefined ? {} : { spill: options.spill });
    const bigTool: ToolDef<{ size: number }> = {
      name: 'big',
      description: 'Returns a large blob.',
      schema: z.object({ size: z.number() }),
      parallelSafe: true,
      requiresApproval: 'never',
      timeoutMs: 0,
      maxInlineTokens: 20,
      run: async (args) => ({ ok: true, output: 'z'.repeat(args.size) }),
    };
    registry.register(bigTool);
    return registry;
  }

  it('applies maxInlineTokens and records the omission', async () => {
    const registry = setup();

    const result = await registry.dispatch('big', { size: 4_000 }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.meta?.truncated).toBe(true);
    expect(result.spillPath).toBeUndefined();
    expect(result.output).toContain('characters omitted');
  });

  it('spills through the mounted store', async () => {
    const store = recordingStore();
    const registry = setup({ spill: store });

    const result = await registry.dispatch('big', { size: 4_000 }, makeCtx());

    expect(result.spillPath).toBe('/spill/1.txt');
    expect(store.puts).toHaveLength(1);
    expect(result.output).toContain('/spill/1.txt');
  });

  it('leaves small results alone', async () => {
    const registry = setup();

    const result = await registry.dispatch('big', { size: 10 }, makeCtx());

    expect(result.meta?.truncated).toBeUndefined();
    expect(result.output).toBe('z'.repeat(10));
  });

  it('retains an fs_read result end to end', async () => {
    const dir = await tmp();
    const registry = new ToolRegistry({ spill: createFileSpillStore({ dir }) });
    registry.register(createFsReadTool({ maxInlineTokens: 30 }));
    const fs = memoryFs({
      root: '/ws',
      files: { 'big.txt': Array.from({ length: 300 }, (_, i) => `line ${String(i)}`).join('\n') },
    });

    const result = await registry.dispatch('fs_read', { path: 'big.txt' }, makeCtx({ fs }));

    expect(result.meta?.truncated).toBe(true);
    expect(result.spillPath).toBeDefined();
    const spilled = await readFile(result.spillPath ?? '', 'utf8');
    expect(spilled).toContain('line 0');
    expect(spilled).toContain('line 299');
  });
});
