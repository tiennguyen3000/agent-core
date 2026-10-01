import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeProvider, ToolRegistry, runAgentLoop } from '../src/index.js';
import type { AgentLoopEventRecord, ToolDef } from '../src/index.js';
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

function registryWith(tool: ToolDef<never> | ToolDef<{ text: string }>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(tool as ToolDef<{ text: string }>);
  return registry;
}

const toolCallStep = {
  deltas: [
    {
      type: 'tool_call' as const,
      index: 0,
      id: 'c1',
      name: 'echo',
      argsJsonDelta: '{"text":"hi"}',
    },
    { type: 'usage' as const, usage: { inputTokens: 100, outputTokens: 10 } },
    { type: 'stop' as const, reason: 'tool_calls' as const },
  ],
};

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    model: 'm',
    system: 's',
    messages: [{ role: 'user' as const, content: 'go' }],
    signal: new AbortController().signal,
    ctx: makeCtx(),
    ...overrides,
  };
}

describe('agent loop', () => {
  it('runs a tool step and finishes with the final text', async () => {
    const provider = new FakeProvider([
      toolCallStep,
      {
        deltas: [
          { type: 'text', text: 'final answer' },
          { type: 'usage', usage: { inputTokens: 50, outputTokens: 20 } },
          { type: 'stop', reason: 'end' },
        ],
      },
    ]);
    const events: AgentLoopEventRecord[] = [];

    const result = await runAgentLoop({
      ...baseOptions({ onEvent: (event: AgentLoopEventRecord) => events.push(event) }),
      provider,
      registry: registryWith(echoTool()),
    });

    expect(result.status).toBe('done');
    expect(result.ok).toBe(true);
    expect(result.text).toBe('final answer');
    expect(result.steps).toBe(2);
    expect(result.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(result.messages[2]?.content).toBe('echo:hi');
    expect(events.map((event) => event.t)).toEqual([
      'step.start',
      'llm.request',
      'llm.response',
      'tool.call',
      'tool.result',
      'step.start',
      'llm.request',
      'llm.response',
      'run.end',
    ]);
    expect(result.usage).toMatchObject({ inputTokens: 150, outputTokens: 30 });
  });

  it('feeds a tool failure back to the model instead of aborting', async () => {
    const provider = new FakeProvider([
      {
        deltas: [
          { type: 'tool_call', index: 0, id: 'c1', name: 'nope', argsJsonDelta: '{}' },
          { type: 'stop', reason: 'tool_calls' },
        ],
      },
      { deltas: [{ type: 'text', text: 'recovered' }, { type: 'stop', reason: 'end' }] },
    ]);

    const result = await runAgentLoop({
      ...baseOptions(),
      provider,
      registry: registryWith(echoTool()),
    });

    expect(result.status).toBe('done');
    expect(result.text).toBe('recovered');
    const toolMessage = result.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('[E_UNKNOWN_TOOL]');
  });

  it('stops at maxSteps when the model keeps asking for tools', async () => {
    const provider = new FakeProvider([
      toolCallStep,
      toolCallStep,
      toolCallStep,
      toolCallStep,
    ]);

    const result = await runAgentLoop({
      ...baseOptions({ maxSteps: 3 }),
      provider,
      registry: registryWith(echoTool()),
    });

    expect(result.status).toBe('max-steps');
    expect(result.ok).toBe(false);
    expect(result.steps).toBe(3);
  });

  it('enforces a token budget across steps', async () => {
    const provider = new FakeProvider([
      toolCallStep,
      { deltas: [{ type: 'text', text: 'never reached' }, { type: 'stop', reason: 'end' }] },
    ]);

    const result = await runAgentLoop({
      ...baseOptions({ tokenBudget: 50 }),
      provider,
      registry: registryWith(echoTool()),
    });

    expect(result.status).toBe('budget-exceeded');
    expect(result.steps).toBe(1);
  });

  it('enforces a wall-clock budget', async () => {
    const ticks = [0, 10_000, 10_000];
    let index = 0;

    const result = await runAgentLoop({
      ...baseOptions({ wallClockMs: 1_000, now: () => ticks[index++] ?? 10_000 }),
      provider: new FakeProvider([toolCallStep]),
      registry: registryWith(echoTool()),
    });

    expect(result.status).toBe('budget-exceeded');
    expect(result.steps).toBe(0);
  });

  it('reports cancellation when the signal aborts mid-run', async () => {
    const controller = new AbortController();
    const abortingTool: ToolDef<{ text: string }> = {
      ...echoTool(),
      run: async () => {
        controller.abort();
        return { ok: true, output: 'aborted after this' };
      },
    };

    const result = await runAgentLoop({
      ...baseOptions({ signal: controller.signal }),
      provider: new FakeProvider([toolCallStep, toolCallStep]),
      registry: registryWith(abortingTool),
    });

    expect(result.status).toBe('cancelled');
    expect(result.steps).toBe(1);
  });

  it('reports a provider error with its code', async () => {
    const provider = new FakeProvider([
      {
        deltas: [
          { type: 'text', text: 'partial' },
          { type: 'text', text: 'never sent' },
        ],
        failAfterDeltas: 1,
        errorCode: 'E_SERVER',
      },
    ]);

    const result = await runAgentLoop({
      ...baseOptions(),
      provider,
      registry: registryWith(echoTool()),
    });

    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('E_SERVER');
    expect(result.text).toBe('partial');
  });
});
