import { afterEach, describe, expect, it } from 'vitest';
import { DeepSeekProvider } from '../src/index.js';
import type { DeepSeekProviderOptions, LLMDelta, LLMRequest } from '../src/index.js';
import { SSE_DONE, sseChunk, sseHeaders, startTestServer } from './helpers/http-server.js';
import type { TestServer } from './helpers/http-server.js';

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function collect(iterable: AsyncIterable<LLMDelta>): Promise<LLMDelta[]> {
  const deltas: LLMDelta[] = [];
  for await (const delta of iterable) {
    deltas.push(delta);
  }
  return deltas;
}

function makeProvider(
  server: TestServer,
  overrides: Partial<DeepSeekProviderOptions> = {},
): DeepSeekProvider {
  return new DeepSeekProvider({
    baseUrl: server.url,
    apiKey: 'sk-test-key',
    requestTimeoutMs: 0,
    sleep: async () => undefined,
    random: () => 0,
    ...overrides,
  });
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'deepseek-flash',
    system: 'You are a coding agent.',
    messages: [{ role: 'user', content: 'say hello' }],
    tools: [],
    maxOutputTokens: 256,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('DeepSeekProvider streaming', () => {
  it('streams text and reasoning, then maps usage including cache hits', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(
        sseChunk({ choices: [{ delta: { reasoning_content: 'thinking' }, finish_reason: null }] }),
      );
      response.write(sseChunk({ choices: [{ delta: { content: 'Hel' }, finish_reason: null }] }));
      response.write(sseChunk({ choices: [{ delta: { content: 'lo' }, finish_reason: null }] }));
      response.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      response.write(
        sseChunk({
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 7,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 20,
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        }),
      );
      response.end(SSE_DONE);
    });
    servers.push(server);

    const deltas = await collect(makeProvider(server).stream(makeRequest()));

    expect(deltas).toEqual([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      {
        type: 'usage',
        usage: {
          inputTokens: 20,
          outputTokens: 7,
          cacheReadTokens: 80,
          cacheWriteTokens: 0,
          reasoningTokens: 3,
        },
      },
      { type: 'stop', reason: 'end' },
    ]);
  });

  it('sends an OpenAI-compatible streaming request with the credential', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.end(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + SSE_DONE);
    });
    servers.push(server);

    await collect(makeProvider(server).stream(makeRequest()));

    const sent = server.requests[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.path).toBe('/chat/completions');
    expect(sent?.headers.authorization).toBe('Bearer sk-test-key');
    expect(sent?.headers.accept).toBe('text/event-stream');
    expect(sent?.body).toMatchObject({
      model: 'deepseek-flash',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 256,
      messages: [
        { role: 'system', content: 'You are a coding agent.' },
        { role: 'user', content: 'say hello' },
      ],
    });
  });

  it('reassembles tool-call argument fragments by index', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(
        sseChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_a', function: { name: 'fs.read', arguments: '{"pa' } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      );
      response.write(
        sseChunk({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 1, id: 'call_b', function: { name: 'glob', arguments: '{"pat' } }],
              },
              finish_reason: null,
            },
          ],
        }),
      );
      response.write(
        sseChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: 'th":"a.txt"}' } },
                  { index: 1, function: { arguments: 'tern":"*.ts"}' } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      );
      response.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
      response.end(SSE_DONE);
    });
    servers.push(server);

    const deltas = await collect(makeProvider(server).stream(makeRequest()));

    const calls = deltas.filter((delta) => delta.type === 'tool_call');
    expect(calls.map((call) => (call.type === 'tool_call' ? call.index : -1))).toEqual([0, 1, 0, 1]);
    expect(calls[0]).toEqual({
      type: 'tool_call',
      index: 0,
      id: 'call_a',
      name: 'fs.read',
      argsJsonDelta: '{"pa',
    });

    const assembled = new Map<number, string>();
    for (const call of calls) {
      if (call.type !== 'tool_call') continue;
      assembled.set(call.index, (assembled.get(call.index) ?? '') + (call.argsJsonDelta ?? ''));
    }
    expect(JSON.parse(assembled.get(0) ?? '')).toEqual({ path: 'a.txt' });
    expect(JSON.parse(assembled.get(1) ?? '')).toEqual({ pattern: '*.ts' });
    expect(deltas.at(-1)).toEqual({ type: 'stop', reason: 'tool_calls' });
  });

  it('serializes assistant tool calls and tool results onto the wire', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.end(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + SSE_DONE);
    });
    servers.push(server);

    await collect(
      makeProvider(server).stream(
        makeRequest({
          messages: [
            { role: 'user', content: 'read a.txt' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'c1', name: 'fs.read', args: { path: 'a.txt' } }],
            },
            { role: 'tool', content: 'file body', toolCallId: 'c1' },
          ],
        }),
      ),
    );

    const messages = (server.requests[0]?.body as { messages: Record<string, unknown>[] }).messages;
    // Index 0 is the system prompt, so the transcript starts at index 1.
    expect(messages[1]).toEqual({ role: 'user', content: 'read a.txt' });
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'fs.read', arguments: '{"path":"a.txt"}' } },
      ],
    });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'file body' });
  });

  it('advertises tools only when the request has them', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.end(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + SSE_DONE);
    });
    servers.push(server);

    await collect(makeProvider(server).stream(makeRequest()));
    await collect(
      makeProvider(server).stream(
        makeRequest({
          tools: [
            {
              name: 'fs.read',
              description: 'Read a file.',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          ],
        }),
      ),
    );

    const withoutTools = server.requests[0]?.body as Record<string, unknown>;
    const withTools = server.requests[1]?.body as Record<string, unknown>;
    expect(withoutTools.tools).toBeUndefined();
    expect(withTools.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'fs.read',
          description: 'Read a file.',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ]);
    expect(withTools.tool_choice).toBe('auto');
  });

  it('omits reasoning_effort unless the deployment opts in', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.end(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + SSE_DONE);
    });
    servers.push(server);

    const request = makeRequest({ reasoningEffort: 'high' });
    await collect(makeProvider(server).stream(request));
    await collect(makeProvider(server, { sendReasoningEffort: true }).stream(request));

    expect((server.requests[0]?.body as Record<string, unknown>).reasoning_effort).toBeUndefined();
    expect((server.requests[1]?.body as Record<string, unknown>).reasoning_effort).toBe('high');
  });

  it('maps a length finish reason to a length stop', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.end(sseChunk({ choices: [{ delta: {}, finish_reason: 'length' }] }) + SSE_DONE);
    });
    servers.push(server);

    const deltas = await collect(makeProvider(server).stream(makeRequest()));

    expect(deltas.at(-1)).toEqual({ type: 'stop', reason: 'length' });
  });
});
