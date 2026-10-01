import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolErrorCode, ToolRegistry } from '../src/index.js';
import type { ToolDef } from '../src/index.js';
import { makeCtx } from './helpers/ctx.js';

/** Waits for a condition using microtasks only, so no test sleeps. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`condition never became true: ${label}`);
}

describe('tool timeout (invariant 6)', () => {
  it('ends a hung tool with E_TIMEOUT and aborts its signal', async () => {
    const deadlines: (() => void)[] = [];
    const cancels: number[] = [];
    let sawAbort = false;

    const registry = new ToolRegistry({
      schedule: (fn) => {
        deadlines.push(fn);
        return () => {
          cancels.push(1);
        };
      },
    });

    const hung: ToolDef<{ id: string }> = {
      name: 'hang',
      description: 'Never completes on its own.',
      schema: z.object({ id: z.string() }),
      parallelSafe: true,
      requiresApproval: 'never',
      timeoutMs: 5_000,
      run: async (_args, ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        throw new Error('aborted');
      },
    };
    registry.register(hung);

    const pending = registry.dispatch('hang', { id: 'a' }, makeCtx());
    await until(() => deadlines.length === 1, 'the deadline was scheduled');

    deadlines[0]?.();
    const result = await pending;

    expect(sawAbort).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ToolErrorCode.Timeout);
    expect(result.output).toContain('5000ms timeout');
    expect(cancels.length).toBeGreaterThan(0);
  });

  it('clears the deadline when the tool finishes in time', async () => {
    let cancelled = 0;
    const registry = new ToolRegistry({
      schedule: () => () => {
        cancelled += 1;
      },
    });
    registry.register<{ id: string }>({
      name: 'fast',
      description: 'Completes immediately.',
      schema: z.object({ id: z.string() }),
      parallelSafe: true,
      requiresApproval: 'never',
      timeoutMs: 5_000,
      run: async (args) => ({ ok: true, output: args.id }),
    });

    const result = await registry.dispatch('fast', { id: 'a' }, makeCtx());

    expect(result.ok).toBe(true);
    expect(cancelled).toBe(1);
  });
});
