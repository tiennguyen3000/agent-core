import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolErrorCode, ToolRegistry } from '../src/index.js';
import type { Action, ToolDef } from '../src/index.js';
import { RecordingGate, makeCtx } from './helpers/ctx.js';

function countingTool(): { def: ToolDef<{ path: string }>; calls: () => number } {
  let calls = 0;
  const def: ToolDef<{ path: string }> = {
    name: 'fs.write',
    description: 'Write a file inside the workspace.',
    schema: z.object({ path: z.string() }),
    parallelSafe: false,
    requiresApproval: 'policy',
    timeoutMs: 1_000,
    action: (args) => ({ kind: 'fs.write', path: args.path }),
    run: async (args) => {
      calls += 1;
      return { ok: true, output: `wrote ${args.path}` };
    },
  };
  return { def, calls: () => calls };
}

describe('invariant-3: every side effect passes the PolicyGate', () => {
  it('invariant-3: gate denial blocks the handler entirely', async () => {
    const { def, calls } = countingTool();
    const gate = new RecordingGate('workspace-write', {
      outcome: 'deny',
      reason: 'outside workspace',
    });
    const registry = new ToolRegistry({ gate });
    registry.register(def);

    const result = await registry.dispatch('fs.write', { path: '../escape.txt' }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.code).toBe(ToolErrorCode.PolicyDenied);
    expect(result.output).toContain('outside workspace');
    expect(calls()).toBe(0);
    expect(gate.calls).toEqual([{ kind: 'fs.write', path: '../escape.txt' }]);
  });

  it('invariant-3: gate allowance runs the handler exactly once', async () => {
    const { def, calls } = countingTool();
    const gate = new RecordingGate();
    const registry = new ToolRegistry({ gate });
    registry.register(def);

    const result = await registry.dispatch('fs.write', { path: 'notes.md' }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.output).toBe('wrote notes.md');
    expect(calls()).toBe(1);
    expect(gate.calls).toHaveLength(1);
  });

  it('invariant-3: Ask delegates to the human and denial fails closed', async () => {
    const { def, calls } = countingTool();
    const gate = new RecordingGate('workspace-write', { outcome: 'ask' });
    const registry = new ToolRegistry({ gate });
    registry.register(def);
    const approvals: Action[] = [];

    const result = await registry.dispatch(
      'fs.write',
      { path: 'a.txt' },
      makeCtx({ approve: false, approvals }),
    );
    const approved = await registry.dispatch(
      'fs.write',
      { path: 'b.txt' },
      makeCtx({ approve: true, approvals }),
    );

    expect(result.code).toBe(ToolErrorCode.ApprovalDenied);
    expect(approved.ok).toBe(true);
    expect(calls()).toBe(1);
    expect(approvals).toEqual([
      { kind: 'fs.write', path: 'a.txt' },
      { kind: 'fs.write', path: 'b.txt' },
    ]);
  });

  it('invariant-3: a policy tool without a mounted gate fails closed', async () => {
    const { def, calls } = countingTool();
    const registry = new ToolRegistry();
    registry.register(def);

    const result = await registry.dispatch('fs.write', { path: 'a.txt' }, makeCtx());

    expect(result.code).toBe(ToolErrorCode.PolicyDenied);
    expect(result.output).toMatch(/fails closed/i);
    expect(calls()).toBe(0);
    expect(def.name).toBe('fs.write');
  });

  it('invariant-3: an approval-free tool never touches the gate', async () => {
    const gate = new RecordingGate();
    const registry = new ToolRegistry({ gate });
    registry.register<{ value: number }>({
      name: 'todo',
      description: 'Record a note.',
      schema: z.object({ value: z.number() }),
      parallelSafe: true,
      requiresApproval: 'never',
      timeoutMs: 1_000,
      run: async (args) => ({ ok: true, output: `note ${args.value}` }),
    });

    const result = await registry.dispatch('todo', { value: 3 }, makeCtx());

    expect(result.ok).toBe(true);
    expect(gate.calls).toEqual([]);
  });
});
