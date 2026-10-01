/**
 * Live smoke test against the real DeepSeek API.
 *
 * Opt-in: the whole file is skipped unless `DEEPSEEK_API_KEY` is set, so
 * `pnpm test` stays offline and deterministic (invariant 10). Run it with:
 *
 *   DEEPSEEK_API_KEY=... DEEPSEEK_LIVE_MODEL=deepseek-chat pnpm test:live
 *
 * Purpose: lock the wire-format assumptions the offline suite cannot verify —
 * SSE framing, `stream_options.include_usage` usage field names, prompt-cache
 * hit reporting, and the streamed `tool_calls` delta shape.
 *
 * Budget: five small requests, capped output, no retries on success paths.
 */

import { describe, expect, it } from 'vitest';
import { DeepSeekProvider, assembleResponse } from '../../src/index.js';
import type {
  DeepSeekProviderOptions,
  LLMDelta,
  LLMRequest,
  ToolSchema,
} from '../../src/index.js';

const apiKey = process.env.DEEPSEEK_API_KEY;
const model = process.env.DEEPSEEK_LIVE_MODEL ?? 'deepseek-chat';
const baseUrl = process.env.DEEPSEEK_LIVE_BASE_URL ?? 'https://api.deepseek.com/v1';

const findings: string[] = [];
const record = (line: string): void => {
  findings.push(line);
  console.log(`[live] ${line}`);
};

function makeProvider(
  overrides: Partial<DeepSeekProviderOptions> = {},
): DeepSeekProvider {
  return new DeepSeekProvider({
    baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    maxAttempts: 2,
    requestTimeoutMs: 90_000,
    ...overrides,
  });
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model,
    system: 'You are a terse assistant. Answer in one short sentence.',
    messages: [{ role: 'user', content: 'Say the single word: pong.' }],
    tools: [],
    maxOutputTokens: 64,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<LLMDelta>): Promise<LLMDelta[]> {
  const deltas: LLMDelta[] = [];
  for await (const delta of iterable) {
    deltas.push(delta);
  }
  return deltas;
}

/** Repeats filler text so the prompt is comfortably above the cache block size. */
function longPrefix(repeat: number): string {
  const line =
    'The agent core keeps an append-only session log as the single source of truth, ' +
    'derives every model-facing transcript by replaying it, and hides - never deletes - ' +
    'compacted ranges so a resumed session reproduces the same conversation. ';
  return line.repeat(repeat);
}

describe.skipIf(apiKey === undefined)('live DeepSeek smoke test', () => {
  it(
    'streams a real completion and reports usage',
    { timeout: 120_000 },
    async () => {
      const provider = makeProvider();
      const deltas = await collect(provider.stream(makeRequest()));
      const response = assembleResponse(deltas);

      record(`model=${model} baseUrl=${baseUrl}`);
      record(`stop=${response.stop} errorCode=${response.errorCode ?? 'none'}`);
      record(`text=${JSON.stringify(response.text.slice(0, 60))}`);
      record(`usage=${JSON.stringify(response.usage)}`);

      expect(response.errorCode).toBeUndefined();
      expect(response.stop).toBe('end');
      expect(response.text.trim().length).toBeGreaterThan(0);
      expect(response.usage?.inputTokens ?? 0).toBeGreaterThan(0);
      expect(response.usage?.outputTokens ?? 0).toBeGreaterThan(0);
      expect(JSON.stringify(deltas)).not.toContain(apiKey ?? 'no-key');
    },
  );

  it(
    'reports prompt-cache hits on a repeated prefix',
    { timeout: 120_000 },
    async () => {
      const prefix = longPrefix(12);
      const provider = makeProvider();
      const call = async (): Promise<ReturnType<typeof assembleResponse>> =>
        assembleResponse(
          await collect(provider.stream(makeRequest({ system: prefix, maxOutputTokens: 128 }))),
        );

      const cold = await call();
      const warm = await call();
      const third = await call();

      const promptTotal = (response: ReturnType<typeof assembleResponse>): number =>
        (response.usage?.inputTokens ?? 0) + (response.usage?.cacheReadTokens ?? 0);
      const line = (label: string, response: ReturnType<typeof assembleResponse>): string =>
        `cache ${label}: stop=${response.stop} in=${String(response.usage?.inputTokens)} read=${String(response.usage?.cacheReadTokens)} total=${String(promptTotal(response))}`;
      record(line('call-1', cold));
      record(line('call-2', warm));
      record(line('call-3', third));

      // Only usage matters here: a reasoning model may stop on 'length' when the
      // output cap is tight, and usage is still reported in that case.
      expect(cold.errorCode).toBeUndefined();
      expect(warm.errorCode).toBeUndefined();

      // The DeepSeek prefix cache lives on the server and is shared across
      // processes, so a "cold" baseline cannot be assumed: an identical prefix
      // may already be cached from an earlier run. What must hold is the
      // accounting: miss + hit equals the whole prompt, and it is stable.
      expect(promptTotal(cold)).toBeGreaterThan(0);
      expect(promptTotal(warm)).toBe(promptTotal(cold));
      expect(promptTotal(third)).toBe(promptTotal(cold));

      // The mapping this suite depends on: cache hits are reported separately
      // from the uncached remainder instead of being folded into one number.
      expect(warm.usage?.cacheReadTokens ?? 0).toBeGreaterThan(0);
      expect(third.usage?.cacheReadTokens ?? 0).toBeGreaterThanOrEqual(
        warm.usage?.cacheReadTokens ?? 0,
      );

      const ratio = Math.round(
        (100 * (warm.usage?.cacheReadTokens ?? 0)) / promptTotal(warm),
      );
      record(`cache hit ratio on an identical prefix: ${String(ratio)}%`);
    },
  );

  it(
    'streams tool calls in OpenAI-compatible fragments',
    { timeout: 120_000 },
    async () => {
      const tools: ToolSchema[] = [
        {
          name: 'fs_read',
          description: 'Read a file from the workspace.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'File path' } },
            required: ['path'],
          },
        },
      ];
      const provider = makeProvider();
      const deltas = await collect(
        provider.stream(
          makeRequest({
            system: 'Use the provided tool when the user asks for a file.',
            messages: [{ role: 'user', content: 'Read the file notes.txt for me.' }],
            tools,
            maxOutputTokens: 128,
          }),
        ),
      );
      const response = assembleResponse(deltas);

      record(
        `tool stop=${response.stop} calls=${JSON.stringify(response.toolCalls)} malformed=${response.malformedToolArgs.length}`,
      );

      expect(response.errorCode).toBeUndefined();
      expect(response.toolCalls.length).toBeGreaterThan(0);
      expect(response.toolCalls[0]?.name).toBe('fs_read');
      expect(response.malformedToolArgs).toEqual([]);
      expect(response.toolCalls[0]?.args).toMatchObject({ path: expect.any(String) });
      expect(response.stop).toBe('tool_calls');
    },
  );

  it(
    'probes whether reasoning_effort is accepted',
    { timeout: 120_000 },
    async () => {
      const provider = makeProvider({ sendReasoningEffort: true });
      const response = assembleResponse(
        await collect(
          provider.stream(makeRequest({ reasoningEffort: 'low', maxOutputTokens: 32 })),
        ),
      );

      record(
        `reasoning_effort probe: stop=${response.stop} code=${response.errorCode ?? 'accepted'} lastError=${provider.lastError?.message ?? 'none'}`,
      );

      // Either answer is informative; what must not happen is a crash or an
      // unclassified failure. A rejection here means the field stays opt-in.
      if (response.errorCode !== undefined) {
        expect(response.errorCode).toBe('E_BAD_REQUEST');
        record('verdict: keep reasoning_effort omitted by default');
      } else {
        record('verdict: reasoning_effort is accepted by this route');
      }
    },
  );

  it('prints the collected findings', () => {
    console.log(`[live] ---- summary (${String(findings.length)} findings) ----`);
    for (const finding of findings) {
      console.log(`[live] ${finding}`);
    }
    expect(findings.length).toBeGreaterThan(0);
  });
});
