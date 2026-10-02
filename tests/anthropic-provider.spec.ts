import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/index.js';
import type { AnthropicProviderOptions, LLMDelta, LLMRequest } from '../src/index.js';
import { sseChunk, sseHeaders, startTestServer } from './helpers/http-server.js';
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
  overrides: Partial<AnthropicProviderOptions> = {},
): AnthropicProvider {
  return new AnthropicProvider({
    baseUrl: server.url,
    apiKey: 'sk-ant-test',
    requestTimeoutMs: 0,
    sleep: async () => undefined,
    random: () => 0,
    ...overrides,
  });
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'claude-sonnet-4-5',
    system: 'You are a coding agent.',
    messages: [{ role: 'user', content: 'say hello' }],
    tools: [],
    maxOutputTokens: 512,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('AnthropicProvider', () => {
  it('streams text and reports cached/uncached usage split across two events', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(
        sseChunk({
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 120,
              cache_read_input_tokens: 900,
              cache_creation_input_tokens: 30,
            },
          },
        }),
      );
      response.write(
        sseChunk({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      );
      response.write(
        sseChunk({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hel' },
        }),
      );
      response.write(
        sseChunk({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'lo' },
        }),
      );
      response.write(sseChunk({ type: 'content_block_stop', index: 0 }));
      response.write(
        sseChunk({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 42 },
        }),
      );
      response.write(sseChunk({ type: 'message_stop' }));
      response.end();
    });
    const provider = makeProvider(server);

    const deltas = await collect(provider.stream(makeRequest()));

    expect(deltas.filter((delta) => delta.type === 'text')).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ]);
    expect(deltas.at(-2)).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 120,
        outputTokens: 42,
        cacheReadTokens: 900,
        cacheWriteTokens: 30,
        reasoningTokens: 0,
      },
    });
    expect(deltas.at(-1)).toEqual({ type: 'stop', reason: 'end' });
    expect(provider.id).toBe('anthropic');
  });

  it('sends the system prompt, tools and headers the Messages API expects', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(sseChunk({ type: 'message_start', message: { usage: { input_tokens: 5 } } }));
      response.write(sseChunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
      response.write(sseChunk({ type: 'message_stop' }));
      response.end();
    });

    await collect(
      makeProvider(server).stream(
        makeRequest({
          tools: [
            {
              name: 'fs_read',
              description: 'Read a file',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          ],
        }),
      ),
    );

    const request = server.requests[0];
    expect(request?.path).toBe('/v1/messages');
    expect(request?.headers['x-api-key']).toBe('sk-ant-test');
    expect(request?.headers['anthropic-version']).toBe('2023-06-01');
    // The key must never travel in an Authorization header for Anthropic.
    expect(request?.headers.authorization).toBeUndefined();
    const body = request?.body as Record<string, unknown>;
    expect(body.system).toBe('You are a coding agent.');
    expect(body.max_tokens).toBe(512);
    expect(body.stream).toBe(true);
    expect(body.tools).toEqual([
      {
        name: 'fs_read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
    // The system prompt is not a message.
    expect(body.messages).toEqual([{ role: 'user', content: 'say hello' }]);
  });

  it('translates tool_use blocks and merges tool results into one user turn', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(sseChunk({ type: 'message_start', message: { usage: { input_tokens: 9 } } }));
      response.write(
        sseChunk({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'fs_read' },
        }),
      );
      response.write(
        sseChunk({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":' },
        }),
      );
      response.write(
        sseChunk({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"a.txt"}' },
        }),
      );
      response.write(sseChunk({ type: 'content_block_stop', index: 0 }));
      response.write(
        sseChunk({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 20 },
        }),
      );
      response.write(sseChunk({ type: 'message_stop' }));
      response.end();
    });

    const deltas = await collect(makeProvider(server).stream(makeRequest()));

    expect(deltas).toContainEqual({
      type: 'tool_call',
      index: 0,
      id: 'toolu_1',
      name: 'fs_read',
    });
    expect(deltas).toContainEqual({
      type: 'tool_call',
      index: 0,
      argsJsonDelta: '{"path":',
    });
    expect(deltas.at(-1)).toEqual({ type: 'stop', reason: 'tool_calls' });
  });

  it('serialises an assistant tool call and two tool results the way the API requires', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(sseChunk({ type: 'message_start', message: { usage: { input_tokens: 5 } } }));
      response.write(sseChunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
      response.write(sseChunk({ type: 'message_stop' }));
      response.end();
    });

    await collect(
      makeProvider(server).stream(
        makeRequest({
          messages: [
            { role: 'user', content: 'read both files' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 'toolu_1', name: 'fs_read', args: { path: 'a.txt' } },
                { id: 'toolu_2', name: 'fs_read', args: { path: 'b.txt' } },
              ],
            },
            { role: 'tool', content: 'body a', toolCallId: 'toolu_1' },
            { role: 'tool', content: 'body b', toolCallId: 'toolu_2' },
          ],
        }),
      ),
    );

    const messages = (server.requests[0]?.body as { messages: Record<string, unknown>[] }).messages;
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'fs_read', input: { path: 'a.txt' } },
        { type: 'tool_use', id: 'toolu_2', name: 'fs_read', input: { path: 'b.txt' } },
      ],
    });
    // Both results belong to one user message, not two.
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'body a' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'body b' },
      ],
    });
  });

  it('sends an image as a base64 source block', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(sseChunk({ type: 'message_start', message: { usage: { input_tokens: 5 } } }));
      response.write(sseChunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
      response.write(sseChunk({ type: 'message_stop' }));
      response.end();
    });

    await collect(
      makeProvider(server).stream(
        makeRequest({
          messages: [
            {
              role: 'user',
              content: 'what is this?',
              parts: [
                { type: 'text', text: 'what is this?' },
                { type: 'image', mimeType: 'image/png', base64: 'aGk=' },
              ],
            },
          ],
        }),
      ),
    );

    const messages = (server.requests[0]?.body as { messages: { content: unknown }[] }).messages;
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
    ]);
  });

  it('maps an overloaded error and stops with a stable code', async () => {
    const server = await startTestServer((_request, response) => {
      response.writeHead(529, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'overloaded_error', message: 'busy' } }));
    });
    const provider = makeProvider(server, { maxAttempts: 1 });

    const deltas = await collect(provider.stream(makeRequest()));

    expect(deltas.at(-1)).toEqual({ type: 'stop', reason: 'error', errorCode: 'E_SERVER' });
    expect(provider.lastError?.retryable).toBe(true);
  });

  it('retries an overloaded response before the first delta', async () => {
    let calls = 0;
    const server = await startTestServer((_request, response) => {
      calls += 1;
      if (calls === 1) {
        response.writeHead(529, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { type: 'overloaded_error', message: 'busy' } }));
        return;
      }
      sseHeaders(response);
      response.write(sseChunk({ type: 'message_start', message: { usage: { input_tokens: 3 } } }));
      response.write(
        sseChunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      );
      response.write(
        sseChunk({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        }),
      );
      response.write(sseChunk({ type: 'message_stop' }));
      response.end();
    });
    const provider = makeProvider(server);

    const deltas = await collect(provider.stream(makeRequest()));

    expect(provider.retryDelays).toEqual([500]);
    expect(deltas).toContainEqual({ type: 'text', text: 'ok' });
    expect(deltas.at(-1)).toEqual({ type: 'stop', reason: 'end' });
  });

  it('maps an in-stream error event', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(sseChunk({ type: 'message_start', message: { usage: { input_tokens: 3 } } }));
      response.write(
        sseChunk({
          type: 'error',
          error: { type: 'overloaded_error', message: 'try later' },
        }),
      );
      response.end();
    });
    const provider = makeProvider(server, { maxAttempts: 1 });

    const deltas = await collect(provider.stream(makeRequest()));

    expect(deltas.at(-1)).toEqual({ type: 'stop', reason: 'error', errorCode: 'E_SERVER' });
    expect(provider.lastError?.message).toContain('try later');
  });

  it('streams extended thinking as reasoning when opted in', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(sseChunk({ type: 'message_start', message: { usage: { input_tokens: 3 } } }));
      response.write(
        sseChunk({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'weighing options' },
        }),
      );
      response.write(sseChunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
      response.write(sseChunk({ type: 'message_stop' }));
      response.end();
    });
    const provider = makeProvider(server, {
      thinkingBudgets: { low: 1_024, medium: 4_096, high: 16_384 },
    });

    const deltas = await collect(provider.stream(makeRequest({ reasoningEffort: 'medium' })));

    expect(deltas).toContainEqual({ type: 'reasoning', text: 'weighing options' });
    const body = server.requests[0]?.body as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4_096 });
  });

  it('does not enable thinking unless asked', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(sseChunk({ type: 'message_start', message: { usage: { input_tokens: 3 } } }));
      response.write(sseChunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
      response.write(sseChunk({ type: 'message_stop' }));
      response.end();
    });

    await collect(makeProvider(server).stream(makeRequest({ reasoningEffort: 'high' })));

    expect((server.requests[0]?.body as Record<string, unknown>).thinking).toBeUndefined();
  });

  it('fails with E_AUTH when no credential is available', async () => {
    const provider = new AnthropicProvider({
      baseUrl: 'http://127.0.0.1:1',
      env: {},
      requestTimeoutMs: 0,
    });

    const deltas = await collect(provider.stream(makeRequest()));

    expect(deltas).toEqual([
      { type: 'stop', reason: 'error', errorCode: 'E_AUTH' },
    ]);
    expect(provider.lastError?.message).toContain('ANTHROPIC_API_KEY');
  });

  it('reports cancellation as control flow, not an error', async () => {
    let sawClientClose = false;
    let releaseClose: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.on('close', () => {
        sawClientClose = true;
        releaseClose?.();
      });
      response.write(sseChunk({ type: 'message_start', message: { usage: { input_tokens: 3 } } }));
      // Exactly one delta, deliberately never ended: only the caller's abort can
      // finish this run.
      response.write(
        sseChunk({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'first' },
        }),
      );
    });
    servers.push(server);

    const controller = new AbortController();
    const provider = makeProvider(server);
    const deltas: LLMDelta[] = [];
    for await (const delta of provider.stream(makeRequest({ signal: controller.signal }))) {
      deltas.push(delta);
      if (delta.type === 'text') {
        controller.abort();
      }
    }
    await closed;

    expect(deltas.filter((delta) => delta.type === 'text')).toHaveLength(1);
    expect(deltas.at(-1)).toEqual({
      type: 'stop',
      reason: 'cancelled',
      errorCode: 'E_CANCELLED',
    });
    // Cancellation is control flow: it must not be reported as a provider error.
    expect(provider.lastError).toBeUndefined();
    expect(sawClientClose).toBe(true);
  });
});
