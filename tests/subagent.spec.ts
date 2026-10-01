import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FakeProvider,
  ToolErrorCode,
  ToolRegistry,
  createSubagentRunner,
  createSubagentTool,
} from '../src/index.js';
import type { ToolDef } from '../src/index.js';
import { makeCtx } from './helpers/ctx.js';

function echoTool(): ToolDef<{ text: string }> {
  return {
    name: 'echo',
    description: 'Echo text back.',
    schema: z.object({ text: z.string() }),
    parallelSafe: true,
    requiresApproval: 'never',
    timeoutMs: 1_000,
    run: async (args) => ({ ok: true, output: `echo:${args.text}` }),
  };
}

function runner(provider: FakeProvider, overrides: Record<string, unknown> = {}) {
  return createSubagentRunner({
    provider,
    registry: (() => {
      const registry = new ToolRegistry();
      registry.register(echoTool());
      return registry;
    })(),
    model: 'm',
    system: 'child system prompt',
    ...overrides,
  });
}

describe('subagent context isolation', () => {
  it('starts the child from its own history and returns only a summary', async () => {
    const provider = new FakeProvider([
      { deltas: [{ type: 'text', text: 'child summary' }, { type: 'stop', reason: 'end' }] },
    ]);
    const parentMessages = [{ role: 'user' as const, content: 'parent task' }];

    const run = await runner(provider).run('investigate X', makeCtx(), new AbortController().signal);

    expect(run.ok).toBe(true);
    expect(run.summary).toBe('child summary');
    // The parent's history is untouched: that is the token saving.
    expect(parentMessages).toHaveLength(1);
    const sent = provider.requests[0];
    expect(sent?.system).toBe('child system prompt');
    expect(sent?.messages).toEqual([{ role: 'user', content: 'investigate X' }]);
  });

  it('can use tools and reports them in its transcript', async () => {
    const provider = new FakeProvider([
      {
        deltas: [
          { type: 'tool_call', index: 0, id: 'c1', name: 'echo', argsJsonDelta: '{"text":"inner"}' },
          { type: 'stop', reason: 'tool_calls' },
        ],
      },
      { deltas: [{ type: 'text', text: 'summary after tool' }, { type: 'stop', reason: 'end' }] },
    ]);

    const run = await runner(provider).run('use the tool', makeCtx(), new AbortController().signal);

    expect(run.summary).toBe('summary after tool');
    expect(run.transcript.map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(run.transcript[2]?.content).toBe('echo:inner');
  });

  it('reports its own token usage so the parent can account for it', async () => {
    const provider = new FakeProvider([
      {
        deltas: [
          { type: 'text', text: 'done' },
          { type: 'usage', usage: { inputTokens: 321, outputTokens: 45 } },
          { type: 'stop', reason: 'end' },
        ],
      },
    ]);

    const run = await runner(provider).run('task', makeCtx(), new AbortController().signal);

    expect(run.usage).toMatchObject({ inputTokens: 321, outputTokens: 45 });
    expect(run.steps).toBe(1);
  });

  it('fails with the provider error code', async () => {
    const provider = new FakeProvider([
      {
        deltas: [
          { type: 'text', text: 'partial' },
          { type: 'text', text: 'never sent' },
        ],
        failAfterDeltas: 1,
        errorCode: 'E_RATE_LIMITED',
      },
    ]);

    const run = await runner(provider).run('task', makeCtx(), new AbortController().signal);

    expect(run.ok).toBe(false);
    expect(run.status).toBe('error');
    expect(run.errorCode).toBe('E_RATE_LIMITED');
  });

  it('honours its own step budget', async () => {
    const step = {
      deltas: [
        { type: 'tool_call' as const, index: 0, id: 'c1', name: 'echo', argsJsonDelta: '{"text":"x"}' },
        { type: 'stop' as const, reason: 'tool_calls' as const },
      ],
    };
    const provider = new FakeProvider([step, step, step, step]);

    const run = await runner(provider, { maxSteps: 2 }).run(
      'loop',
      makeCtx(),
      new AbortController().signal,
    );

    expect(run.status).toBe('max-steps');
    expect(run.ok).toBe(false);
    expect(run.steps).toBe(2);
  });
});

describe('subagent tool', () => {
  it('returns the child summary as the tool output', async () => {
    const provider = new FakeProvider([
      { deltas: [{ type: 'text', text: 'the answer' }, { type: 'stop', reason: 'end' }] },
    ]);
    const registry = new ToolRegistry();
    registry.register(createSubagentTool({ runner: runner(provider) }));

    const result = await registry.dispatch('subagent', { task: 'do it' }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.output).toBe('the answer');
    expect(result.meta?.steps).toBe(1);
  });

  it('maps a failed child to a stable tool code', async () => {
    const provider = new FakeProvider([
      { deltas: [{ type: 'text', text: 'x' }, { type: 'stop', reason: 'error', errorCode: 'E_SERVER' }] },
    ]);
    const registry = new ToolRegistry();
    registry.register(createSubagentTool({ runner: runner(provider) }));

    const result = await registry.dispatch('subagent', { task: 'do it' }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.code).toBe(ToolErrorCode.ToolFailed);
    expect(result.output).toContain('E_SERVER');
  });

  it('is not parallel-safe, because a child touches the workspace', () => {
    const provider = new FakeProvider([{ deltas: [{ type: 'stop', reason: 'end' }] }]);
    const tool = createSubagentTool({ runner: runner(provider) });

    expect(tool.parallelSafe).toBe(false);
    expect(tool.requiresApproval).toBe('never');
  });
});
