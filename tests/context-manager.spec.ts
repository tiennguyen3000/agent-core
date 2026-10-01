import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider, createContextManager, openSessionLog, readSessionLog, replay } from '../src/index.js';
import type { ContextManager, SessionEvent, SessionLog } from '../src/index.js';
import { withSeq } from './helpers/events.js';
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js';

const dirs: string[] = [];
const logs: SessionLog[] = [];

afterEach(async () => {
  for (const log of logs) {
    await log.close().catch(() => undefined);
  }
  logs.length = 0;
  await Promise.all(dirs.splice(0).map((dir) => removeTmpDir(dir)));
});

const usage = { inputTokens: 5, outputTokens: 5 } as const;

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

function manager(provider: FakeProvider): ContextManager {
  return createContextManager({
    provider,
    contextWindow: 1_000,
    model: 'deepseek-flash',
    thresholdRatio: 0.8,
    retainTokens: 200,
    pruneRatio: 0.5,
    toolResultPruneTokens: 100,
  });
}

describe('context manager', () => {
  it('turns usage into pressure and prunes before it compacts', () => {
    const subject = manager(new FakeProvider({ deltas: [{ type: 'text', text: 'S' }] }));

    subject.recordUsage({ inputTokens: 100, outputTokens: 50 });
    expect(subject.projectionOptions()).toEqual({});

    subject.recordUsage({ inputTokens: 600, outputTokens: 100 });
    expect(subject.pressure().ratio).toBeCloseTo(0.7, 5);
    expect(subject.projectionOptions()).toEqual({ toolResultBudget: 100 });

    subject.recordUsage({ inputTokens: 850, outputTokens: 100 });
    expect(subject.pressure().ratio).toBeCloseTo(0.95, 5);
  });

  it('skips compaction below the threshold', async () => {
    const subject = manager(new FakeProvider({ deltas: [{ type: 'text', text: 'S' }] }));
    subject.recordUsage({ inputTokens: 100, outputTokens: 100 });

    const outcome = await subject.compact(conversation(6, 400), {
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'below-threshold' });
  });

  it('skips compaction when there is nothing worth covering', async () => {
    const subject = manager(new FakeProvider({ deltas: [{ type: 'text', text: 'S' }] }));
    subject.recordUsage({ inputTokens: 900, outputTokens: 100 });

    const outcome = await subject.compact(conversation(1, 10), {
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'nothing-to-cover' });
  });

  it('compacts once, and the log then replays as a summary plus the tail', async () => {
    const provider = new FakeProvider({
      deltas: [
        { type: 'text', text: 'DENSE SUMMARY' },
        { type: 'usage', usage: { inputTokens: 300, outputTokens: 20 } },
        { type: 'stop', reason: 'end' },
      ],
    });
    const subject = manager(provider);
    const events = conversation(8, 400);

    subject.recordUsage({ inputTokens: 900, outputTokens: 100 });
    const outcome = await subject.compact(events, { signal: new AbortController().signal });

    expect(outcome.status).toBe('compacted');
    if (outcome.status !== 'compacted') {
      throw new Error('unreachable');
    }
    expect(outcome.plan.coveredFrom).toBe(1);
    expect(outcome.usage).toEqual({ inputTokens: 300, outputTokens: 20 });
    expect(provider.requests).toHaveLength(1);

    const root = await makeTmpDir();
    dirs.push(root);
    const log = await openSessionLog({ root, sessionId: 's1' });
    logs.push(log);
    for (const event of events) {
      const { seq: _seq, at: _at, ...input } = event;
      await log.append(input);
    }
    await log.append(outcome.event);
    const stored = await readSessionLog({ root, sessionId: 's1' });

    const messages = replay(stored);
    expect(messages).toHaveLength(1 + (events.length - outcome.plan.coveredMessages));
    expect(messages[0]?.content).toContain('DENSE SUMMARY');
    expect(messages.every((message) => !message.content.includes('q1'))).toBe(true);
  });

  it('reports a failed summary and leaves the caller in control', async () => {
    const provider = new FakeProvider({
      deltas: [
        { type: 'text', text: 'partial' },
        { type: 'text', text: 'never sent' },
      ],
      failAfterDeltas: 1,
      errorCode: 'E_RATE_LIMITED',
    });
    const subject = manager(provider);
    subject.recordUsage({ inputTokens: 900, outputTokens: 100 });

    const outcome = await subject.compact(conversation(6, 400), {
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({ status: 'failed', reason: 'model-error', errorCode: 'E_RATE_LIMITED' });
  });

  it('records the summary request usage so pressure reflects it', async () => {
    const provider = new FakeProvider({
      deltas: [
        { type: 'text', text: 'S' },
        { type: 'usage', usage: { inputTokens: 700, outputTokens: 30 } },
        { type: 'stop', reason: 'end' },
      ],
    });
    const subject = manager(provider);
    subject.recordUsage({ inputTokens: 900, outputTokens: 100 });

    await subject.compact(conversation(6, 400), { signal: new AbortController().signal });

    expect(subject.pressure().surfaceTokens).toBe(730);
    expect(subject.pressure().source).toBe('usage');
  });
});
