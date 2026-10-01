import { afterEach, describe, expect, it } from 'vitest';
import { DeepSeekProvider } from '../src/index.js';
import type { Message } from '../src/index.js';
import { SSE_DONE, sseChunk, sseHeaders, startTestServer } from './helpers/http-server.js';
import type { TestServer } from './helpers/http-server.js';

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function send(messages: Message[]): Promise<Record<string, unknown>[]> {
  const server = await startTestServer((_request, response) => {
    sseHeaders(response);
    response.end(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + SSE_DONE);
  });
  servers.push(server);

  const provider = new DeepSeekProvider({
    baseUrl: server.url,
    apiKey: 'sk-test',
    requestTimeoutMs: 0,
    sleep: async () => undefined,
  });
  for await (const _delta of provider.stream({
    model: 'deepseek-flash',
    system: 'sys',
    messages,
    tools: [],
    maxOutputTokens: 32,
    signal: new AbortController().signal,
  })) {
    void _delta;
  }

  const body = server.requests[0]?.body as { messages: Record<string, unknown>[] };
  return body.messages;
}

describe('message parts on the wire', () => {
  it('keeps a plain message as a string', async () => {
    const messages = await send([{ role: 'user', content: 'hello' }]);

    expect(messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('sends an image part as an OpenAI-style content array', async () => {
    const messages = await send([
      {
        role: 'user',
        content: 'look at this',
        parts: [
          { type: 'text', text: 'look at this' },
          { type: 'image', mimeType: 'image/png', base64: 'QUJD', attachmentId: 'x.png' },
        ],
      },
    ]);

    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      ],
    });
  });

  it('omits an empty text part but still sends the image', async () => {
    const messages = await send([
      {
        role: 'user',
        content: '',
        parts: [{ type: 'image', mimeType: 'image/jpeg', base64: 'QUJD' }],
      },
    ]);

    expect(messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }],
    });
  });

  it('keeps tool results as text even when parts exist', async () => {
    const messages = await send([
      {
        role: 'tool',
        content: 'tool output',
        toolCallId: 'c1',
        parts: [{ type: 'image', mimeType: 'image/png', base64: 'QUJD' }],
      },
    ]);

    expect(messages[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'tool output' });
  });

  it('carries an image alongside assistant tool calls', async () => {
    const messages = await send([
      {
        role: 'assistant',
        content: 'here',
        toolCalls: [{ id: 'c1', name: 'fs_read', args: { path: 'a.txt' } }],
        parts: [{ type: 'image', mimeType: 'image/webp', base64: 'QUJD' }],
      },
    ]);

    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: 'here' },
        { type: 'image_url', image_url: { url: 'data:image/webp;base64,QUJD' } },
      ],
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a.txt"}' } },
      ],
    });
  });
});
