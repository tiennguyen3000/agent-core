import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolErrorCode, ToolRegistry } from '../src/index.js';
import type { ToolDef } from '../src/index.js';
import { makeCtx } from './helpers/ctx.js';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Waits for a condition using microtasks only — no timers, no sleeping. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`condition never became true: ${label}`);
}

function setup(maxParallel?: number) {
  const events: string[] = [];
  const releases = new Map<string, () => void>();

  const makeTool = (name: string, parallelSafe: boolean): ToolDef<{ id: string }> => ({
    name,
    description: name,
    schema: z.object({ id: z.string() }),
    parallelSafe,
    requiresApproval: 'never',
    timeoutMs: 0,
    run: async (args) => {
      events.push(`start:${args.id}`);
      const gate = deferred();
      releases.set(args.id, gate.resolve);
      await gate.promise;
      events.push(`end:${args.id}`);
      return { ok: true, output: args.id };
    },
  });

  const registry = new ToolRegistry(
    maxParallel === undefined ? {} : { maxParallel },
  );
  registry.register(makeTool('fs_read', true));
  registry.register(makeTool('fs_write', false));

  return { registry, events, releases };
}

describe('dispatchMany', () => {
  it('overlaps parallel-safe calls and serializes the exclusive ones', async () => {
    const { registry, events, releases } = setup();
    const pending = registry.dispatchMany(
      [
        { name: 'fs_read', args: { id: 'a' } },
        { name: 'fs_read', args: { id: 'b' } },
        { name: 'fs_write', args: { id: 'c' } },
        { name: 'fs_write', args: { id: 'd' } },
      ],
      makeCtx(),
    );

    await until(() => events.length === 2, 'the parallel batch started');
    expect(events).toEqual(['start:a', 'start:b']);

    releases.get('a')?.();
    releases.get('b')?.();
    await until(() => events.length === 5, 'the exclusive call started');
    expect(events).toEqual(['start:a', 'start:b', 'end:a', 'end:b', 'start:c']);
    expect(events).not.toContain('start:d');

    releases.get('c')?.();
    await until(() => events.includes('start:d'), 'the second exclusive call started');
    releases.get('d')?.();

    const results = await pending;
    expect(results.map((result) => result.output)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps call order in the results even when completion order differs', async () => {
    const { registry, releases } = setup();
    const pending = registry.dispatchMany(
      [
        { name: 'fs_read', args: { id: 'first' } },
        { name: 'fs_read', args: { id: 'second' } },
      ],
      makeCtx(),
    );

    await until(() => releases.size === 2, 'both calls started');
    releases.get('second')?.();
    releases.get('first')?.();

    const results = await pending;
    expect(results.map((result) => result.output)).toEqual(['first', 'second']);
  });

  it('serializes even parallel-safe calls when maxParallel is 1', async () => {
    const { registry, events, releases } = setup(1);
    const pending = registry.dispatchMany(
      [
        { name: 'fs_read', args: { id: 'a' } },
        { name: 'fs_read', args: { id: 'b' } },
      ],
      makeCtx(),
    );

    await until(() => events.length === 1, 'the first call started');
    expect(events).toEqual(['start:a']);

    releases.get('a')?.();
    await until(() => events.includes('start:b'), 'the second call started');
    releases.get('b')?.();
    await pending;

    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('reports an unknown tool in its own slot without disturbing the others', async () => {
    const { registry, releases } = setup();
    const pending = registry.dispatchMany(
      [
        { name: 'fs_read', args: { id: 'a' } },
        { name: 'nope', args: {} },
      ],
      makeCtx(),
    );

    await until(() => releases.has('a'), 'the known tool started');
    releases.get('a')?.();
    const results = await pending;

    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.code).toBe(ToolErrorCode.UnknownTool);
  });
});
