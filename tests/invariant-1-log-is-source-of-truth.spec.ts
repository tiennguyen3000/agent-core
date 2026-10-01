import { describe, expect, it } from 'vitest';
import { assertContiguousSeqs, nextSeq, replay } from '../src/index.js';
import type { SessionEvent } from '../src/index.js';
import { withSeq } from './helpers/events.js';

function sampleEvents(): SessionEvent[] {
  return withSeq([
    { t: 'session.created', sessionId: 's1', cwd: '/workspace', model: 'fake-model', at: 1 },
    { t: 'turn.start', turn: 1, input: 'read a.txt', at: 2 },
    { t: 'step.start', turn: 1, step: 1, at: 3 },
    {
      t: 'llm.response',
      requestId: 'r1',
      text: 'Reading it now.',
      toolCalls: [{ id: 'c1', name: 'fs.read', args: { path: 'a.txt' } }],
      usage: { inputTokens: 10, outputTokens: 5 },
      stop: 'tool_calls',
      at: 4,
    },
    { t: 'tool.call', callId: 'c1', name: 'fs.read', args: { path: 'a.txt' }, at: 5 },
    { t: 'tool.result', callId: 'c1', ok: true, output: 'hello', durationMs: 3, at: 6 },
    { t: 'turn.end', turn: 1, status: 'done', at: 7 },
  ]);
}

describe('invariant-1: the session log is the source of truth', () => {
  it('invariant-1: derives the transcript from events alone', () => {
    const events = sampleEvents();
    assertContiguousSeqs(events);

    expect(replay(events)).toEqual([
      { role: 'user', content: 'read a.txt' },
      {
        role: 'assistant',
        content: 'Reading it now.',
        toolCalls: [{ id: 'c1', name: 'fs.read', args: { path: 'a.txt' } }],
      },
      { role: 'tool', content: 'hello', toolCallId: 'c1' },
    ]);
  });

  it('invariant-1: changing an event changes the projection (no cached history)', () => {
    const events = sampleEvents();
    const before = replay(events);
    const mutated = events.map((event) =>
      event.t === 'turn.start' ? { ...event, input: 'read b.txt' } : event,
    );
    const after = replay(mutated);

    expect(after).not.toEqual(before);
    expect(after[0]).toEqual({ role: 'user', content: 'read b.txt' });
  });

  it('invariant-1: replay is deterministic across repeated runs', () => {
    const events = sampleEvents();
    const first = replay(events);
    for (let run = 0; run < 10; run += 1) {
      expect(replay(events)).toEqual(first);
    }
  });

  it('invariant-1: rejects a log whose seqs are not contiguous', () => {
    const broken = sampleEvents();
    const withGap = broken.map((event) =>
      event.seq === 7 ? { ...event, seq: 9 } : event,
    ) as SessionEvent[];

    expect(() => assertContiguousSeqs(withGap)).toThrow(/corrupt/i);
    expect(nextSeq(sampleEvents())).toBe(8);
  });
});
