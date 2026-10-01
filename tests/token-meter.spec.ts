import { describe, expect, it } from 'vitest';
import { createTokenMeter, measureRequest, totalPromptTokens } from '../src/index.js';
import type { LLMRequest } from '../src/index.js';

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'm',
    system: 'You are a coding agent.',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxOutputTokens: 64,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('token meter', () => {
  it('estimates until real usage exists, then refuses to go back', () => {
    const meter = createTokenMeter({ contextWindow: 2_000 });

    meter.recordEstimate(1_000);
    expect(meter.source).toBe('estimate');
    expect(meter.surfaceTokens).toBe(1_000);

    meter.recordUsage({ inputTokens: 500, cacheReadTokens: 300, outputTokens: 200 });
    expect(meter.source).toBe('usage');
    // The next request carries the prompt it sent plus the reply it produced.
    expect(meter.surfaceTokens).toBe(1_000);

    meter.recordEstimate(9_999);
    expect(meter.surfaceTokens).toBe(1_000);
    expect(meter.lastUsage?.cacheReadTokens).toBe(300);
  });

  it('sums cached and uncached prompt tokens', () => {
    expect(totalPromptTokens({ inputTokens: 10, cacheReadTokens: 90, outputTokens: 5 })).toBe(100);
    expect(totalPromptTokens({ inputTokens: 10, outputTokens: 5 })).toBe(10);
  });

  it('reports pressure against the window', () => {
    const meter = createTokenMeter({ contextWindow: 1_000 });
    meter.recordUsage({ inputTokens: 400, outputTokens: 100 });

    expect(meter.pressure()).toEqual({
      surfaceTokens: 500,
      contextWindow: 1_000,
      ratio: 0.5,
      source: 'usage',
    });
  });

  it('never divides by a zero window', () => {
    const meter = createTokenMeter({ contextWindow: 0 });
    meter.recordUsage({ inputTokens: 10, outputTokens: 10 });

    expect(meter.pressure().ratio).toBe(0);
  });

  it('starts empty and can be reset', () => {
    const meter = createTokenMeter({ contextWindow: 1_000 });
    expect(meter.pressure()).toMatchObject({ surfaceTokens: 0, source: 'empty', ratio: 0 });

    meter.recordUsage({ inputTokens: 10, outputTokens: 10 });
    meter.reset();

    expect(meter.source).toBe('empty');
    expect(meter.surfaceTokens).toBe(0);
    expect(meter.lastUsage).toBeUndefined();
  });
});

describe('measureRequest', () => {
  it('grows with the transcript and counts tool schemas', () => {
    const small = measureRequest(request());
    const bigger = measureRequest(
      request({
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'x'.repeat(1_000) },
        ],
      }),
    );
    const withTools = measureRequest(
      request({
        tools: [
          {
            name: 'fs_read',
            description: 'Read a file.',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      }),
    );

    expect(small).toBeGreaterThan(0);
    expect(bigger).toBeGreaterThan(small);
    expect(withTools).toBeGreaterThan(small);
  });

  it('counts tool call arguments', () => {
    const withoutCalls = measureRequest(request());
    const withCalls = measureRequest(
      request({
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'fs_write', args: { content: 'y'.repeat(500) } }],
          },
        ],
      }),
    );

    expect(withCalls).toBeGreaterThan(withoutCalls);
  });

  it('charges a flat allowance for an image part', () => {
    const text = measureRequest(request({ messages: [{ role: 'user', content: '' }] }));
    const image = measureRequest(
      request({
        messages: [
          {
            role: 'user',
            content: '',
            parts: [{ type: 'image', mimeType: 'image/png', base64: 'AAAA' }],
          },
        ],
      }),
    );

    expect(image).toBeGreaterThanOrEqual(text + 1_024);
  });
});
