import { describe, expect, it } from 'vitest';
import { project, replay } from '../src/index.js';
import type { SessionEvent } from '../src/index.js';

const usage = { inputTokens: 12, outputTokens: 7 } as const;

/** A log where turn 1 is later compacted away while turn 2 stays visible. */
function compactedLog(): SessionEvent[] {
  return [
    { seq: 1, t: 'session.created', sessionId: 's1', cwd: '/workspace', model: 'fake-model', at: 1 },
    { seq: 2, t: 'turn.start', turn: 1, input: 'OLD CONTEXT', at: 2 },
    {
      seq: 3,
      t: 'llm.response',
      requestId: 'r1',
      text: 'OLD ANSWER',
      toolCalls: [],
      usage,
      stop: 'end',
      at: 3,
    },
    { seq: 4, t: 'turn.start', turn: 2, input: 'NEW QUESTION', at: 4 },
    {
      seq: 5,
      t: 'compaction',
      coveredFrom: 2,
      coveredTo: 3,
      summary: 'user asked about the old context',
      usage,
      at: 5,
    },
    {
      seq: 6,
      t: 'llm.response',
      requestId: 'r2',
      text: 'NEW ANSWER',
      toolCalls: [],
      usage,
      stop: 'end',
      at: 6,
    },
  ];
}

describe('invariant-2: compaction hides, never deletes', () => {
  it('invariant-2: hides the covered range from the model', () => {
    const events = compactedLog();
    const result = project(events);

    expect(result.hiddenSeqs).toEqual([2, 3]);
    const transcript = result.messages.map((message) => message.content).join('\n');
    expect(transcript).not.toContain('OLD CONTEXT');
    expect(transcript).not.toContain('OLD ANSWER');
    expect(transcript).toContain('NEW QUESTION');
    expect(transcript).toContain('NEW ANSWER');
  });

  it('invariant-2: keeps the covered events in the log, untouched', () => {
    const events = compactedLog();
    const snapshot = JSON.parse(JSON.stringify(events)) as SessionEvent[];

    project(events);

    expect(events).toEqual(snapshot);
    expect(events).toHaveLength(6);
    expect(events.find((event) => event.seq === 3)).toBeDefined();
  });

  it('invariant-2: replaces the hidden range with one marked summary message', () => {
    const events = compactedLog();
    const messages = replay(events);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({
      role: 'user',
      content: '<compacted-history>\nuser asked about the old context\n</compacted-history>',
    });
    expect(messages.map((message) => message.content)).toEqual([
      '<compacted-history>\nuser asked about the old context\n</compacted-history>',
      'NEW QUESTION',
      'NEW ANSWER',
    ]);
  });

  it('invariant-2: projection is idempotent and returns fresh objects', () => {
    const events = compactedLog();
    const first = replay(events);
    const second = replay(events);

    expect(second).toEqual(first);
    expect(second[0]).not.toBe(first[0]);
  });
});
