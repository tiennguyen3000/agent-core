import { describe, expect, it } from 'vitest';
import { FakeProvider, createCompactor } from '../src/index.js';
import type { CompactionPlan, ContextPressureLike, SessionEvent } from '../src/index.js';
import { withSeq } from './helpers/events.js';

const usage = { inputTokens: 5, outputTokens: 5 } as const;

function pressure(ratio: number, contextWindow = 1_000): ContextPressureLike {
  return { surfaceTokens: Math.floor(ratio * contextWindow), contextWindow, ratio };
}

/** Several turns of filler so a boundary has something to cover. */
function conversation(turns: number, filler: number): SessionEvent[] {
  const events = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ t: 'turn.start' as const, turn, input: `q${String(turn)} ${'x'.repeat(filler)}`, at: turn * 2 });
    events.push({
      t: 'llm.response' as const,
      requestId: `r${String(turn)}`,
      text: `a${String(turn)} ${'y'.repeat(filler)}`,
      toolCalls: [],
      usage,
      stop: 'end' as const,
      at: turn * 2 + 1,
    });
  }
  return withSeq(events);
}

function compactor(options: Partial<Parameters<typeof createCompactor>[0]> = {}) {
  const provider = new FakeProvider({ deltas: [{ type: 'text', text: 'SUMMARY' }] });
  return {
    provider,
    compactor: createCompactor({
      provider,
      contextWindow: 1_000,
      retainTokens: 100,
      minCoveredMessages: 3,
      ...options,
    }),
  };
}

describe('compaction planning', () => {
  it('does nothing below the threshold', () => {
    const { compactor: subject } = compactor({ thresholdRatio: 0.8 });

    expect(subject.plan(conversation(6, 400), pressure(0.5))).toBeUndefined();
  });

  it('does nothing when there is no measured pressure at all', () => {
    const { compactor: subject } = compactor();

    expect(subject.plan(conversation(6, 400), pressure(0))).toBeUndefined();
  });

  it('does nothing when the whole conversation fits in the retained tail', () => {
    const { compactor: subject } = compactor({ retainTokens: 1_000_000 });

    expect(subject.plan(conversation(3, 10), pressure(0.9))).toBeUndefined();
  });

  it('covers the oldest material and keeps a bounded tail', () => {
    const { compactor: subject } = compactor({ retainTokens: 200 });

    const plan = subject.plan(conversation(8, 400), pressure(0.9));

    expect(plan).toBeDefined();
    expect(plan?.coveredFrom).toBe(1);
    expect(plan?.reason).toBe('threshold');
    expect(plan?.coveredTo).toBeLessThan(plan?.retainedFrom ?? 0);
    expect(plan?.coveredMessages).toBeGreaterThanOrEqual(3);
  });

  it('compacts on overflow even below the threshold', () => {
    const { compactor: subject } = compactor({ thresholdRatio: 0.95 });

    const plan = subject.plan(conversation(8, 400), pressure(0.2), { reason: 'overflow' });

    expect(plan?.reason).toBe('overflow');
  });

  it('never starts the retained tail on an orphaned tool result', () => {
    const events = withSeq([
      { t: 'session.created', sessionId: 's1', cwd: '/w', model: 'm', at: 1 },
      { t: 'turn.start', turn: 1, input: 'first', at: 2 },
      {
        t: 'llm.response',
        requestId: 'r1',
        text: 'done with turn one',
        toolCalls: [],
        usage,
        stop: 'end',
        at: 3,
      },
      { t: 'turn.start', turn: 2, input: 'read it', at: 4 },
      {
        t: 'llm.response',
        requestId: 'r2',
        text: 'reading',
        toolCalls: [{ id: 'c1', name: 'fs_read', args: { path: 'a.txt' } }],
        usage,
        stop: 'tool_calls',
        at: 5,
      },
      { t: 'tool.result', callId: 'c1', ok: true, output: 'file body', durationMs: 1, at: 6 },
    ]);
    const { compactor: subject } = compactor({ retainTokens: 1, minCoveredMessages: 3 });

    const plan = subject.plan(events, pressure(0.95));

    expect(plan).toBeDefined();
    // The tail wants to start at the tool result (seq 6); the plan moves the
    // boundary back to the assistant message that requested it (seq 5).
    expect(plan?.retainedFrom).toBe(5);
    expect(plan?.coveredTo).toBe(4);
  });
});

describe('summarising', () => {
  const events = conversation(6, 400);
  const plan: CompactionPlan = {
    coveredFrom: 1,
    coveredTo: 4,
    retainedFrom: 5,
    reason: 'threshold',
    coveredMessages: 4,
  };

  it('uses exactly one model request and returns the summary', async () => {
    const { compactor: subject, provider } = compactor();

    const result = await subject.summarize(events, plan, {
      model: 'deepseek-flash',
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('SUMMARY');
    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0];
    expect(request?.tools).toEqual([]);
    expect(request?.model).toBe('deepseek-flash');
    expect(request?.system).toContain('compress an agent conversation');
    expect(request?.messages[0]?.content).toContain('q1');
    expect(request?.messages[0]?.content).not.toContain('q3');
  });

  it('reports a provider failure without inventing a summary', async () => {
    // `failAfterDeltas: 1` makes the script fail before the second delta, which
    // is how a mid-stream provider error looks.
    const provider = new FakeProvider({
      deltas: [
        { type: 'text', text: 'partial' },
        { type: 'text', text: 'never sent' },
      ],
      failAfterDeltas: 1,
      errorCode: 'E_SERVER',
    });
    const subject = createCompactor({ provider, contextWindow: 1_000 });

    const result = await subject.summarize(events, plan, {
      model: 'm',
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('E_SERVER');
    expect(result.summary).toBe('');
  });

  it('treats an empty summary as a failure', async () => {
    const provider = new FakeProvider({ deltas: [{ type: 'text', text: '   ' }] });
    const subject = createCompactor({ provider, contextWindow: 1_000 });

    const result = await subject.summarize(events, plan, {
      model: 'm',
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('E_EMPTY_SUMMARY');
  });

  it('renders tool calls so the summary can name them', async () => {
    const { compactor: subject, provider } = compactor();
    const withTools = withSeq([
      { t: 'turn.start', turn: 1, input: 'read a.txt', at: 1 },
      {
        t: 'llm.response',
        requestId: 'r1',
        text: '',
        toolCalls: [{ id: 'c1', name: 'fs_read', args: { path: 'a.txt' } }],
        usage,
        stop: 'tool_calls',
        at: 2,
      },
    ]);

    await subject.summarize(withTools, { ...plan, coveredTo: 2 }, {
      model: 'm',
      signal: new AbortController().signal,
    });

    expect(provider.requests[0]?.messages[0]?.content).toContain('fs_read');
    expect(provider.requests[0]?.messages[0]?.content).toContain('a.txt');
  });

  it('builds the compaction event input', () => {
    const { compactor: subject } = compactor();

    expect(subject.toEventInput(plan, 'SUMMARY', usage)).toEqual({
      t: 'compaction',
      coveredFrom: 1,
      coveredTo: 4,
      summary: 'SUMMARY',
      usage,
    });
  });
});
