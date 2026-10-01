import { describe, expect, it } from 'vitest';
import { project } from '../src/index.js';
import type { SessionEvent } from '../src/index.js';

const usage = { inputTokens: 3, outputTokens: 2 } as const;

/**
 * The assistant turn that requested `c1` is compacted away, but the tool result
 * survives. A projected transcript must stay valid, so the orphan is dropped.
 */
function orphanLog(): SessionEvent[] {
  return [
    { seq: 1, t: 'session.created', sessionId: 's1', cwd: '/workspace', model: 'fake-model', at: 1 },
    { seq: 2, t: 'turn.start', turn: 1, input: 'do the thing', at: 2 },
    {
      seq: 3,
      t: 'llm.response',
      requestId: 'r1',
      text: 'calling a tool',
      toolCalls: [{ id: 'c1', name: 'fs.read', args: { path: 'a.txt' } }],
      usage,
      stop: 'tool_calls',
      at: 3,
    },
    { seq: 4, t: 'tool.call', callId: 'c1', name: 'fs.read', args: { path: 'a.txt' }, at: 4 },
    { seq: 5, t: 'tool.result', callId: 'c1', ok: true, output: 'file body', durationMs: 2, at: 5 },
    {
      seq: 6,
      t: 'compaction',
      coveredFrom: 2,
      coveredTo: 4,
      summary: 'the user asked to read a file',
      usage,
      at: 6,
    },
    {
      seq: 7,
      t: 'llm.response',
      requestId: 'r2',
      text: 'here is the summary',
      toolCalls: [],
      usage,
      stop: 'end',
      at: 7,
    },
  ];
}

describe('projection tool pairing', () => {
  it('keeps assistant tool calls paired with their results', () => {
    const events: SessionEvent[] = [
      { seq: 1, t: 'turn.start', turn: 1, input: 'q', at: 1 },
      {
        seq: 2,
        t: 'llm.response',
        requestId: 'r1',
        text: '',
        toolCalls: [{ id: 'c1', name: 'fs.read', args: {} }],
        usage,
        stop: 'tool_calls',
        at: 2,
      },
      { seq: 3, t: 'tool.result', callId: 'c1', ok: true, output: 'body', durationMs: 1, at: 3 },
    ];

    const result = project(events);

    expect(result.orphanedToolResults).toEqual([]);
    expect(result.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'fs.read', args: {} }] },
      { role: 'tool', content: 'body', toolCallId: 'c1' },
    ]);
  });

  it('drops a tool result whose call was compacted away', () => {
    const result = project(orphanLog());

    expect(result.hiddenSeqs).toEqual([2, 3, 4]);
    expect(result.orphanedToolResults).toEqual([5]);
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(result.messages[1]).toEqual({ role: 'assistant', content: 'here is the summary' });
  });

  it('omits assistant messages that carry neither text nor tool calls', () => {
    const events: SessionEvent[] = [
      { seq: 1, t: 'turn.start', turn: 1, input: 'q', at: 1 },
      {
        seq: 2,
        t: 'llm.response',
        requestId: 'r1',
        text: '',
        toolCalls: [],
        usage,
        stop: 'end',
        at: 2,
      },
      { seq: 3, t: 'turn.end', turn: 1, status: 'done', at: 3 },
    ];

    expect(project(events).messages).toEqual([{ role: 'user', content: 'q' }]);
  });
});
