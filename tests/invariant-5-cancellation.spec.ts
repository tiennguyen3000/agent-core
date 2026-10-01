import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeProvider, ToolErrorCode, ToolRegistry } from '../src/index.js';
import type { LLMDelta, PolicyGate, ToolDef } from '../src/index.js';
import { makeCtx } from './helpers/ctx.js';

function request(signal: AbortSignal) {
  return {
    model: 'fake-model',
    system: 'test',
    messages: [{ role: 'user' as const, content: 'go' }],
    tools: [],
    maxOutputTokens: 64,
    signal,
  };
}

describe('invariant-5: cancellation propagates', () => {
  it('invariant-5: aborting mid-stream stops the provider between deltas', async () => {
    const controller = new AbortController();
    const provider = new FakeProvider({
      deltas: [
        { type: 'text', text: 'one ' },
        { type: 'text', text: 'two ' },
        { type: 'text', text: 'three ' },
        { type: 'text', text: 'four ' },
      ],
    });

    const received: LLMDelta[] = [];
    for await (const delta of provider.stream(request(controller.signal))) {
      received.push(delta);
      if (received.length === 2) {
        controller.abort();
      }
    }

    expect(received).toHaveLength(3);
    expect(received.at(-1)).toEqual({ type: 'stop', reason: 'cancelled' });
    expect(provider.requests).toHaveLength(1);
  });

  it('invariant-5: an already-aborted signal never reaches the handler', async () => {
    let calls = 0;
    const registry = new ToolRegistry();
    const def: ToolDef<{ path: string }> = {
      name: 'fs.read',
      description: 'Read a file.',
      schema: z.object({ path: z.string() }),
      parallelSafe: true,
      requiresApproval: 'never',
      timeoutMs: 1_000,
      run: async () => {
        calls += 1;
        return { ok: true, output: 'never' };
      },
    };
    registry.register(def);

    const controller = new AbortController();
    controller.abort();
    const result = await registry.dispatch('fs.read', { path: 'a.txt' }, makeCtx({ signal: controller.signal }));

    expect(result.ok).toBe(false);
    expect(result.code).toBe(ToolErrorCode.Cancelled);
    expect(calls).toBe(0);
  });

  it('invariant-5: aborting during a tool run settles with E_CANCELLED', async () => {
    let observedAbort = false;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const registry = new ToolRegistry();
    const def: ToolDef<{ path: string }> = {
      name: 'fs.read',
      description: 'Read a file slowly.',
      schema: z.object({ path: z.string() }),
      parallelSafe: true,
      requiresApproval: 'never',
      timeoutMs: 60_000,
      run: async (_args, ctx) => {
        markStarted?.();
        if (ctx.signal.aborted) {
          observedAbort = true;
          throw new Error('aborted before the handler could start waiting');
        }
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        throw new Error('aborted by caller');
      },
    };
    registry.register(def);

    const controller = new AbortController();
    const pending = registry.dispatch(
      'fs.read',
      { path: 'big.txt' },
      makeCtx({ signal: controller.signal }),
    );

    // Deterministic ordering: the handler is provably waiting before we abort.
    await started;
    controller.abort();
    const result = await pending;

    expect(observedAbort).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ToolErrorCode.Cancelled);
  });

  it('invariant-5: an abort raised while authorizing still reaches the handler', async () => {
    let sawAbortedSignal = false;
    const controller = new AbortController();

    // The gate aborts the run while dispatch is awaiting it, so the tool starts
    // after `ctx.signal` is already aborted. The registry must forward that
    // state to the handler instead of handing it a live signal.
    const gate: PolicyGate = {
      mode: 'workspace-write',
      decide: async () => {
        controller.abort();
        return { outcome: 'allow' };
      },
    };

    const registry = new ToolRegistry({ gate });
    registry.register<{ path: string }>({
      name: 'fs.read',
      description: 'Read a file.',
      schema: z.object({ path: z.string() }),
      parallelSafe: true,
      requiresApproval: 'policy',
      timeoutMs: 60_000,
      action: (args) => ({ kind: 'fs.read', path: args.path }),
      run: async (_args, ctx) => {
        sawAbortedSignal = ctx.signal.aborted;
        throw new Error('cancelled');
      },
    });

    const result = await registry.dispatch(
      'fs.read',
      { path: 'a.txt' },
      makeCtx({ signal: controller.signal }),
    );

    expect(sawAbortedSignal).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ToolErrorCode.Cancelled);
  });
});
