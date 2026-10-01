import { afterEach, describe, expect, it } from 'vitest';
import { DeepSeekProvider, ProviderErrorCode } from '../src/index.js';
import type { DeepSeekProviderOptions, FetchLike, LLMDelta, LLMRequest } from '../src/index.js';
import { SSE_DONE, sseChunk, sseHeaders, startTestServer } from './helpers/http-server.js';
import type { TestServer } from './helpers/http-server.js';

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const encoder = new TextEncoder();

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'deepseek-flash',
    system: 'You are a coding agent.',
    messages: [{ role: 'user', content: 'go' }],
    tools: [],
    maxOutputTokens: 256,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function collect(iterable: AsyncIterable<LLMDelta>): Promise<LLMDelta[]> {
  return (async () => {
    const deltas: LLMDelta[] = [];
    for await (const delta of iterable) {
      deltas.push(delta);
    }
    return deltas;
  })();
}

function makeProvider(
  overrides: Partial<DeepSeekProviderOptions> = {},
): DeepSeekProvider {
  return new DeepSeekProvider({
    apiKey: 'sk-test-key',
    requestTimeoutMs: 0,
    sleep: async () => undefined,
    random: () => 0,
    ...overrides,
  });
}

/** A response body that delivers one chunk and then fails, deterministically. */
function streamThenFail(): ReadableStream<Uint8Array> {
  let step = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      step += 1;
      if (step === 1) {
        controller.enqueue(
          encoder.encode(
            sseChunk({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }),
          ),
        );
        return;
      }
      controller.error(new Error('connection reset'));
    },
  });
}

function completeStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          sseChunk({ choices: [{ delta: { content: 'recovered' }, finish_reason: 'stop' }] }) +
            SSE_DONE,
        ),
      );
      controller.close();
    },
  });
}

describe('DeepSeekProvider failures and retries', () => {
  it('retries HTTP 429 and then succeeds', async () => {
    const server = await startTestServer((_request, response, index) => {
      if (index === 0) {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
        response.end(JSON.stringify({ error: { message: 'slow down' } }));
        return;
      }
      sseHeaders(response);
      response.end(
        sseChunk({ choices: [{ delta: { content: 'recovered' }, finish_reason: 'stop' }] }) +
          SSE_DONE,
      );
    });
    servers.push(server);

    const provider = makeProvider({ baseUrl: server.url });
    const deltas = await collect(provider.stream(makeRequest()));

    expect(server.requests).toHaveLength(2);
    expect(provider.retryDelays).toEqual([0]);
    expect(deltas).toEqual([
      { type: 'text', text: 'recovered' },
      { type: 'stop', reason: 'end' },
    ]);
  });

  it('backs off exponentially and gives up with E_SERVER', async () => {
    const server = await startTestServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
    });
    servers.push(server);

    const provider = makeProvider({
      baseUrl: server.url,
      maxAttempts: 3,
      baseRetryDelayMs: 500,
    });
    const deltas = await collect(provider.stream(makeRequest()));

    expect(server.requests).toHaveLength(3);
    expect(provider.retryDelays).toEqual([500, 1_000]);
    expect(deltas).toEqual([
      { type: 'stop', reason: 'error', errorCode: ProviderErrorCode.Server },
    ]);
    expect(provider.lastError?.code).toBe(ProviderErrorCode.Server);
    expect(provider.lastError?.status).toBe(500);
    expect(provider.lastError?.retryable).toBe(true);
  });

  it('reports E_AUTH and never leaks the credential', async () => {
    const server = await startTestServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'invalid key sk-test-key supplied' } }),
      );
    });
    servers.push(server);

    const provider = makeProvider({ baseUrl: server.url });
    const deltas = await collect(provider.stream(makeRequest()));

    expect(deltas).toEqual([
      { type: 'stop', reason: 'error', errorCode: ProviderErrorCode.Auth },
    ]);
    expect(server.requests).toHaveLength(1);
    expect(JSON.stringify(deltas)).not.toContain('sk-test-key');
    expect(provider.lastError?.message).not.toContain('sk-test-key');
    expect(provider.lastError?.message).toContain('***');
  });

  it('fails closed when no credential is configured', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.end(SSE_DONE);
    });
    servers.push(server);

    const provider = new DeepSeekProvider({
      baseUrl: server.url,
      env: {},
      requestTimeoutMs: 0,
    });
    const deltas = await collect(provider.stream(makeRequest()));

    expect(deltas).toEqual([
      { type: 'stop', reason: 'error', errorCode: ProviderErrorCode.Auth },
    ]);
    expect(provider.lastError?.message).toContain('DEEPSEEK_API_KEY');
    expect(server.requests).toHaveLength(0);
  });

  it('reports E_BAD_STREAM when the stream is truncated', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.write(sseChunk({ choices: [{ delta: { content: 'cut off' }, finish_reason: null }] }));
      response.end();
    });
    servers.push(server);

    const provider = makeProvider({ baseUrl: server.url });
    const deltas = await collect(provider.stream(makeRequest()));

    expect(deltas).toEqual([
      { type: 'text', text: 'cut off' },
      { type: 'stop', reason: 'error', errorCode: ProviderErrorCode.BadStream },
    ]);
    expect(server.requests).toHaveLength(1);
  });

  it('reports E_BAD_STREAM for a malformed chunk', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.end('data: {not json}\n\n' + SSE_DONE);
    });
    servers.push(server);

    const deltas = await collect(makeProvider({ baseUrl: server.url }).stream(makeRequest()));

    expect(deltas).toEqual([
      { type: 'stop', reason: 'error', errorCode: ProviderErrorCode.BadStream },
    ]);
  });

  it('retries a network failure that happened before any delta', async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      if (attempts <= 2) {
        throw new TypeError('fetch failed');
      }
      return new Response(completeStream(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const provider = makeProvider({ fetchImpl, maxAttempts: 3 });
    const deltas = await collect(provider.stream(makeRequest()));

    expect(attempts).toBe(3);
    // Two failures before the success, so the backoff doubles once.
    expect(provider.retryDelays).toEqual([500, 1_000]);
    expect(deltas).toEqual([
      { type: 'text', text: 'recovered' },
      { type: 'stop', reason: 'end' },
    ]);
  });

  it('never replays a stream that already emitted a delta', async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      return new Response(streamThenFail(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const provider = makeProvider({ fetchImpl, maxAttempts: 5 });
    const deltas = await collect(provider.stream(makeRequest()));

    expect(attempts).toBe(1);
    expect(provider.retryDelays).toEqual([]);
    expect(deltas).toEqual([
      { type: 'text', text: 'partial' },
      { type: 'stop', reason: 'error', errorCode: ProviderErrorCode.Network },
    ]);
    expect(provider.lastError?.retryable).toBe(false);
  });

  it('does not report a cancel as an error to onError', async () => {
    const reported: string[] = [];
    const provider = makeProvider({
      fetchImpl: async () => {
        throw new TypeError('aborted');
      },
      onError: (error) => reported.push(error.code),
    });

    const controller = new AbortController();
    controller.abort();
    const deltas = await collect(provider.stream(makeRequest({ signal: controller.signal })));

    expect(deltas).toEqual([
      { type: 'stop', reason: 'cancelled', errorCode: ProviderErrorCode.Cancelled },
    ]);
    expect(reported).toEqual([]);
  });
});
