import { afterEach, describe, expect, it } from 'vitest';
import { DeepSeekProvider, ProviderErrorCode } from '../src/index.js';
import type { DeepSeekProviderOptions, LLMDelta, LLMRequest } from '../src/index.js';
import { sseChunk, sseHeaders, startTestServer } from './helpers/http-server.js';
import type { TestServer } from './helpers/http-server.js';

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function makeRequest(signal: AbortSignal): LLMRequest {
  return {
    model: 'deepseek-flash',
    system: 'You are a coding agent.',
    messages: [{ role: 'user', content: 'go' }],
    tools: [],
    maxOutputTokens: 256,
    signal,
  };
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

describe('DeepSeekProvider cancellation', () => {
  it('stops with cancelled when the caller aborts mid-stream', async () => {
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
      // Exactly one chunk, deliberately never ended: a second chunk could be
      // coalesced into the same TCP read, which would make the assertion on the
      // number of text deltas non-deterministic.
      response.write(
        sseChunk({ choices: [{ delta: { content: 'first' }, finish_reason: null }] }),
      );
      // Deliberately never ends: only the caller's abort can finish this run.
    });
    servers.push(server);

    const controller = new AbortController();
    const deltas: LLMDelta[] = [];
    for await (const delta of makeProvider(server).stream(makeRequest(controller.signal))) {
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
      errorCode: ProviderErrorCode.Cancelled,
    });
    expect(sawClientClose).toBe(true);
  });

  it('never opens a request when the signal is already aborted', async () => {
    const server = await startTestServer((_request, response) => {
      sseHeaders(response);
      response.end(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    });
    servers.push(server);

    const controller = new AbortController();
    controller.abort();
    const deltas: LLMDelta[] = [];
    for await (const delta of makeProvider(server).stream(makeRequest(controller.signal))) {
      deltas.push(delta);
    }

    expect(deltas).toEqual([
      { type: 'stop', reason: 'cancelled', errorCode: ProviderErrorCode.Cancelled },
    ]);
    expect(server.requests).toHaveLength(0);
  });

  it('does not retry after a cancellation', async () => {
    let attempts = 0;
    const controller = new AbortController();

    const provider = makeProvider(
      { url: 'http://127.0.0.1:1', requests: [], close: async () => undefined },
      {
        maxAttempts: 4,
        fetchImpl: async () => {
          attempts += 1;
          controller.abort();
          throw new TypeError('aborted');
        },
      },
    );

    const deltas: LLMDelta[] = [];
    for await (const delta of provider.stream(makeRequest(controller.signal))) {
      deltas.push(delta);
    }

    expect(attempts).toBe(1);
    expect(provider.retryDelays).toEqual([]);
    expect(deltas.at(-1)).toMatchObject({ type: 'stop', reason: 'cancelled' });
  });
});
