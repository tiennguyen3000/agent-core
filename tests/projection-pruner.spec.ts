import { describe, expect, it } from 'vitest';
import { project, replay } from '../src/index.js';
import type { SessionEvent } from '../src/index.js';
import { withSeq } from './helpers/events.js';

const usage = { inputTokens: 5, outputTokens: 5 } as const;

/** A log with a large tool result in the middle. */
function logWithBigResult(): SessionEvent[] {
  return withSeq([
    { t: 'turn.start', turn: 1, input: 'read the log', at: 1 },
    {
      t: 'llm.response',
      requestId: 'r1',
      text: 'reading',
      toolCalls: [{ id: 'c1', name: 'fs_read', args: { path: 'big.txt' } }],
      usage,
      stop: 'tool_calls',
      at: 2,
    },
    { t: 'tool.result', callId: 'c1', ok: true, output: 'A'.repeat(4_000), durationMs: 1, at: 3 },
    {
      t: 'llm.response',
      requestId: 'r2',
      text: 'done',
      toolCalls: [],
      usage,
      stop: 'end',
      at: 4,
    },
  ]);
}

describe('tool result pruner', () => {
  it('prunes the middle of an oversized result for the model only', () => {
    const events = logWithBigResult();

    const result = project(events, { toolResultBudget: 100 });
    const toolMessage = result.messages.find((message) => message.role === 'tool');

    expect(result.prunedToolResults).toEqual([3]);
    expect(toolMessage?.content).toContain('characters pruned');
    expect(toolMessage?.content).toContain('the full result is in the session log');
    expect(toolMessage?.content.startsWith('A')).toBe(true);
    expect(toolMessage?.content.endsWith('A')).toBe(true);
    expect(toolMessage?.content.length).toBeLessThan(1_000);
  });

  it('leaves results under the budget alone', () => {
    const events = logWithBigResult();

    const result = project(events, { toolResultBudget: 10_000 });

    expect(result.prunedToolResults).toEqual([]);
    expect(result.messages.find((message) => message.role === 'tool')?.content).toBe(
      'A'.repeat(4_000),
    );
  });

  it('keeps the log itself untouched', () => {
    const events = logWithBigResult();
    const snapshot = JSON.parse(JSON.stringify(events)) as SessionEvent[];

    project(events, { toolResultBudget: 50 });

    expect(events).toEqual(snapshot);
  });

  it('does not prune when no budget is configured', () => {
    expect(project(logWithBigResult()).prunedToolResults).toEqual([]);
  });
});

describe('nested compactions', () => {
  function nested(): SessionEvent[] {
    return withSeq([
      { t: 'turn.start', turn: 1, input: 'first question', at: 1 },
      {
        t: 'llm.response',
        requestId: 'r1',
        text: 'first answer',
        toolCalls: [],
        usage,
        stop: 'end',
        at: 2,
      },
      { t: 'turn.start', turn: 2, input: 'second question', at: 3 },
      {
        t: 'llm.response',
        requestId: 'r2',
        text: 'second answer',
        toolCalls: [],
        usage,
        stop: 'end',
        at: 4,
      },
      { t: 'compaction', coveredFrom: 1, coveredTo: 2, summary: 'OLD SUMMARY', usage, at: 5 },
      { t: 'turn.start', turn: 3, input: 'third question', at: 6 },
      {
        t: 'llm.response',
        requestId: 'r3',
        text: 'third answer',
        toolCalls: [],
        usage,
        stop: 'end',
        at: 7,
      },
      { t: 'compaction', coveredFrom: 1, coveredTo: 6, summary: 'NEW SUMMARY', usage, at: 8 },
    ]);
  }

  it('replaces an earlier summary instead of showing both', () => {
    const messages = replay(nested());
    const summaries = messages.filter((message) => message.content.includes('SUMMARY'));

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.content).toContain('NEW SUMMARY');
    expect(summaries[0]?.content).not.toContain('OLD SUMMARY');
  });

  it('still hides the covered events', () => {
    const result = project(nested());

    expect(result.hiddenSeqs).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.messages.map((message) => message.content)).toEqual([
      '<compacted-history>\nNEW SUMMARY\n</compacted-history>',
      'third answer',
    ]);
  });
});
