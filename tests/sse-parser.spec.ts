import { describe, expect, it } from 'vitest';
import { parseSseStream } from '../src/index.js';
import type { SseEvent } from '../src/index.js';

async function* chunksOf(
  chunks: readonly (string | Uint8Array)[],
): AsyncIterable<string | Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function collect(chunks: readonly (string | Uint8Array)[]): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(chunksOf(chunks))) {
    events.push(event);
  }
  return events;
}

describe('SSE parser', () => {
  it('reassembles a payload split across chunk boundaries', async () => {
    const events = await collect(['data: {"a"', ':1}\n\n']);

    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('{"a":1}');
  });

  it('accepts LF, CRLF and lone CR line endings', async () => {
    expect((await collect(['data: lf\n\n'])).map((event) => event.data)).toEqual(['lf']);
    expect((await collect(['data: crlf\r\n\r\n'])).map((event) => event.data)).toEqual(['crlf']);
    expect((await collect(['data: cr\r\r'])).map((event) => event.data)).toEqual(['cr']);
  });

  it('waits for the second half of a CRLF split across chunks', async () => {
    const events = await collect(['data: z\r', '\n\r\n']);

    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('z');
  });

  it('joins multiple data lines with a newline', async () => {
    const events = await collect(['data: first\ndata: second\n\n']);

    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('first\nsecond');
  });

  it('ignores comments and blocks without data', async () => {
    expect(await collect([': keep-alive\n\n'])).toEqual([]);
    expect(await collect(['event: ping\n\n'])).toEqual([]);
    expect(await collect(['\n\n\n'])).toEqual([]);
  });

  it('captures event and id fields', async () => {
    const events = await collect(['event: message\nid: 42\ndata: payload\n\n']);

    expect(events).toEqual([{ data: 'payload', event: 'message', id: '42' }]);
  });

  it('emits a trailing event that never got its blank line', async () => {
    const events = await collect(['data: tail']);

    expect(events).toEqual([{ data: 'tail', event: undefined, id: undefined }]);
  });

  it('passes the [DONE] sentinel through as data', async () => {
    const events = await collect(['data: [DONE]\n\n']);

    expect(events[0]?.data).toBe('[DONE]');
  });

  it('decodes UTF-8 split in the middle of a multi-byte character', async () => {
    const bytes = new TextEncoder().encode('data: tiếng Việt\n\n');
    const events = await collect([bytes.slice(0, 8), bytes.slice(8)]);

    expect(events[0]?.data).toBe('tiếng Việt');
  });
});
