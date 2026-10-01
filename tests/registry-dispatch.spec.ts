import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolErrorCode, ToolRegistry } from '../src/index.js';
import type { ToolDef } from '../src/index.js';
import { makeCtx } from './helpers/ctx.js';

const echoSchema = z.object({ text: z.string() });

function echoTool(name: string): ToolDef<z.infer<typeof echoSchema>> {
  return {
    name,
    description: `Echo via ${name}.`,
    schema: echoSchema,
    parallelSafe: true,
    requiresApproval: 'never',
    timeoutMs: 1_000,
    run: async (args) => ({ ok: true, output: args.text }),
  };
}

describe('tool registry', () => {
  it('reports an unknown tool with the available roster', async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool('zeta'));
    registry.register(echoTool('alpha'));

    const result = await registry.dispatch('missing', {}, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.code).toBe(ToolErrorCode.UnknownTool);
    expect(result.output).toContain('alpha, zeta');
  });

  it('rejects invalid arguments with a field path and never runs the handler', async () => {
    let calls = 0;
    const registry = new ToolRegistry();
    registry.register({ ...echoTool('echo'), run: async (args) => { calls += 1; return { ok: true, output: args.text }; } });

    const result = await registry.dispatch('echo', { text: 42 }, makeCtx());

    expect(result.code).toBe(ToolErrorCode.BadArgs);
    expect(result.output).toContain('text');
    expect(calls).toBe(0);
  });

  it('refuses to register the same name twice', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool('echo'));

    expect(() => registry.register(echoTool('echo'))).toThrow(/duplicate/i);
  });

  it('lists tools deterministically and exposes their names', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool('zeta'));
    registry.register(echoTool('alpha'));

    expect(registry.names()).toEqual(['alpha', 'zeta']);
    expect(registry.size).toBe(2);
    expect(registry.has('alpha')).toBe(true);
    expect(registry.get('alpha')?.description).toBe('Echo via alpha.');
  });

  it('records a deterministic duration using the injected clock', async () => {
    const ticks = [100, 175];
    const registry = new ToolRegistry({ now: () => ticks.shift() ?? 0 });
    registry.register(echoTool('echo'));

    const result = await registry.dispatch('echo', { text: 'hi' }, makeCtx());

    expect(result.meta?.durationMs).toBe(75);
  });

  it('turns a handler crash into a stable E_TOOL_FAILED result', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...echoTool('boom'),
      run: async () => {
        throw new Error('disk on fire');
      },
    });

    const result = await registry.dispatch('boom', { text: 'x' }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.code).toBe(ToolErrorCode.ToolFailed);
    expect(result.output).toContain('disk on fire');
  });
});
