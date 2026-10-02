import { afterEach, describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider, createOpenAiCompatibleProvider } from '../src/index.js';
import type { LLMDelta, LLMRequest, OpenAiCompatibleOptions } from '../src/index.js';
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
  overrides: Partial<OpenAiCompatibleOptions> = {},
): OpenAiCompatibleProvider {
  return createOpenAiCompatibleProvider({
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
    model: 'gpt-5-mini',
    system: 'You are a coding agent.',
    messages: [{ role: 'user', content: 'say hello' }],
    tools: [],
    maxOutputTokens: 256,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('OpenAiCompatibleProvider', () => {
  it('reads usage from the OpenAI spelling of the cache and reasoning details', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(sseChunk({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] }));
      response.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      response.write(
        sseChunk({
          choices: [],
          usage: {
            prompt_tokens: 1_000,
            completion_tokens: 200,
            prompt_tokens_details: { cached_tokens: 768 },
            completion_tokens_details: { reasoning_tokens: 64 },
          },
        }),
      );
      response.write(SSE_DONE);
      response.end();
    });
    const provider = makeProvider(server);

    const deltas = await collect(provider.stream(makeRequest()));

    const usage = deltas.find((delta) => delta.type === 'usage');
    // OpenAI's prompt_tokens includes the cached part, so uncached = 1000 - 768.
    expect(usage).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 232,
        outputTokens: 200,
        cacheReadTokens: 768,
        cacheWriteTokens: 0,
        reasoningTokens: 64,
      },
    });
    expect(deltas.at(-1)).toEqual({ type: 'stop', reason: 'end' });
  });

  it('accepts the `reasoning` spelling of hidden text', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(sseChunk({ choices: [{ delta: { reasoning: 'pondering' } }] }));
      response.write(sseChunk({ choices: [{ delta: { content: 'answer' } }] }));
      response.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      response.write(SSE_DONE);
      response.end();
    });

    const deltas = await collect(makeProvider(server).stream(makeRequest()));

    expect(deltas).toContainEqual({ type: 'reasoning', text: 'pondering' });
    expect(deltas).toContainEqual({ type: 'text', text: 'answer' });
  });

  it('can use max_completion_tokens and skip stream_options for strict servers', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(sseChunk({ choices: [{ delta: { content: 'ok' } }] }));
      response.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      response.write(SSE_DONE);
      response.end();
    });
    const provider = makeProvider(server, {
      maxTokensField: 'max_completion_tokens',
      sendStreamOptions: false,
    });

    await collect(provider.stream(makeRequest()));

    const body = server.requests[0]?.body as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(256);
    expect(body.max_tokens).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
  });

  it('carries an id and label through to error messages', async () => {
    const server = await startTestServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'bad key' } }));
    });
    const provider = makeProvider(server, {
      id: 'groq',
      label: 'Groq',
      maxAttempts: 1,
    });

    const deltas = await collect(provider.stream(makeRequest()));

    expect(provider.id).toBe('groq');
    expect(deltas.at(-1)).toEqual({ type: 'stop', reason: 'error', errorCode: 'E_AUTH' });
    expect(provider.lastError?.message).toContain('Groq rejected the credential');
  });

  it('sends extra headers and an image part in the OpenAI shape', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(sseChunk({ choices: [{ delta: { content: 'seen' } }] }));
      response.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      response.write(SSE_DONE);
      response.end();
    });
    const provider = makeProvider(server, { extraHeaders: { 'http-referer': 'https://example.test' } });

    await collect(
      provider.stream(
        makeRequest({
          messages: [
            {
              role: 'user',
              content: 'what is this?',
              parts: [{ type: 'image', mimeType: 'image/png', base64: 'aGk=' }],
            },
          ],
        }),
      ),
    );

    const request = server.requests[0];
    expect(request?.headers['http-referer']).toBe('https://example.test');
    const messages = (request?.body as { messages: unknown[] }).messages;
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
      ],
    });
  });
});
