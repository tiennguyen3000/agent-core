/**
 * Anthropic (Claude) provider over the Messages API.
 *
 * Same contract as every other provider — `LLMProvider` — but a different wire
 * format from the OpenAI family, so it does not share their implementation:
 *
 *  - the system prompt is a top-level field, not a message;
 *  - tool results ride in a *user* message as `tool_result` blocks, and an
 *    assistant turn that called tools sends `tool_use` blocks;
 *  - `max_tokens` is required;
 *  - the stream is typed (`message_start`, `content_block_delta`, …) and usage
 *    arrives in two places: input tokens in `message_start`, output tokens in
 *    `message_delta`;
 *  - prompt caching is explicit: `cache_read_input_tokens` /
 *    `cache_creation_input_tokens`.
 *
 * Invariants: same as the OpenAI-compatible provider (5, 7, 9, 10).
 */

import { z } from 'zod';
import {
  ProviderError,
  ProviderErrorCode,
  describeError,
  isRetryableStatus,
  redactSecret,
} from './errors.js';
import { parseSseStream } from './sse.js';
import type { LLMDelta, LLMProvider, LLMRequest, Message, StopReason, Usage } from './types.js';
import type { FetchLike } from './openai-compatible.js';

export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';

const usageSchema = z
  .object({
    input_tokens: z.number().nullish(),
    output_tokens: z.number().nullish(),
    cache_read_input_tokens: z.number().nullish(),
    cache_creation_input_tokens: z.number().nullish(),
  })
  .nullish();

const streamEventSchema = z.object({
  type: z.string(),
  index: z.number().int().nullish(),
  message: z.object({ usage: usageSchema }).nullish(),
  content_block: z
    .object({
      type: z.string().nullish(),
      id: z.string().nullish(),
      name: z.string().nullish(),
    })
    .nullish(),
  delta: z
    .object({
      type: z.string().nullish(),
      text: z.string().nullish(),
      thinking: z.string().nullish(),
      partial_json: z.string().nullish(),
      stop_reason: z.string().nullish(),
    })
    .nullish(),
  usage: usageSchema,
  error: z.object({ type: z.string().nullish(), message: z.string().nullish() }).nullish(),
});

export interface AnthropicProviderOptions {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly maxAttempts?: number;
  readonly baseRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly jitterRatio?: number;
  readonly requestTimeoutMs?: number;
  /**
   * Extended thinking is opt-in: enabling it makes `max_tokens` have to exceed
   * the budget, so a deployment chooses explicitly.
   */
  readonly thinkingBudgets?: { readonly low: number; readonly medium: number; readonly high: number };
  readonly onError?: (error: ProviderError) => void;
  readonly maxErrorBodyChars?: number;
  readonly extraHeaders?: Record<string, string>;
}

interface OpenSuccess {
  readonly ok: true;
  readonly body: ReadableStream<Uint8Array>;
}

interface OpenFailure {
  readonly ok: false;
  readonly error: ProviderError;
  readonly retryAfterMs: number | undefined;
}

type OpenResult = OpenSuccess | OpenFailure;

function textBlock(text: string): Record<string, unknown> {
  return { type: 'text', text };
}

function imageBlocks(message: Message): Record<string, unknown>[] {
  const parts = message.parts ?? [];
  if (!parts.some((part) => part.type === 'image')) {
    return [];
  }
  const blocks: Record<string, unknown>[] = [];
  const hasTextPart = parts.some((part) => part.type === 'text');
  if (!hasTextPart && message.content.length > 0) {
    blocks.push(textBlock(message.content));
  }
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push(textBlock(part.text));
      continue;
    }
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: part.mimeType, data: part.base64 },
    });
  }
  return blocks;
}

/**
 * Anthropic requires tool results inside a user message, so consecutive tool
 * messages are merged into one.
 */
function toWireMessages(messages: readonly Message[]): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      };
      const last = wire.at(-1);
      if (last !== undefined && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        wire.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      const blocks: Record<string, unknown>[] = [...imageBlocks(message)];
      if (blocks.length === 0 && message.content.length > 0) {
        blocks.push(textBlock(message.content));
      }
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.args ?? {},
        });
      }
      wire.push({ role: 'assistant', content: blocks });
      continue;
    }

    const images = imageBlocks(message);
    wire.push({
      role: message.role,
      content: images.length > 0 ? images : message.content,
    });
  }

  return wire;
}

function buildBody(
  request: LLMRequest,
  thinkingBudgets: AnthropicProviderOptions['thinkingBudgets'],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    system: request.system,
    messages: toWireMessages(request.messages),
    max_tokens: request.maxOutputTokens,
    stream: true,
  };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  if (thinkingBudgets !== undefined && request.reasoningEffort !== undefined) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: thinkingBudgets[request.reasoningEffort],
    };
  }
  return body;
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return 'end';
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractErrorMessage(bodyText: string): string {
  const parsed = tryParseJson(bodyText);
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
    const error = (parsed as { error?: unknown }).error;
    if (typeof error === 'object' && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') {
        return message;
      }
    }
  }
  return bodyText;
}

function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const timestamp = Date.parse(header);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - now);
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly retryDelays: number[] = [];

  readonly #url: string;
  readonly #apiKey: string | undefined;
  readonly #apiKeyEnv: string;
  readonly #env: Record<string, string | undefined>;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #maxAttempts: number;
  readonly #baseRetryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #jitterRatio: number;
  readonly #requestTimeoutMs: number;
  readonly #thinkingBudgets: AnthropicProviderOptions['thinkingBudgets'];
  readonly #onError: ((error: ProviderError) => void) | undefined;
  readonly #maxErrorBodyChars: number;
  readonly #extraHeaders: Record<string, string>;
  #lastError: ProviderError | undefined;

  constructor(options: AnthropicProviderOptions = {}) {
    const baseUrl = options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL;
    this.#url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
    this.#apiKey = options.apiKey;
    this.#apiKeyEnv = options.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#sleep =
      options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.#baseRetryDelayMs = options.baseRetryDelayMs ?? 500;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 8_000;
    this.#jitterRatio = options.jitterRatio ?? 0.2;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 600_000;
    this.#thinkingBudgets = options.thinkingBudgets;
    this.#onError = options.onError;
    this.#maxErrorBodyChars = options.maxErrorBodyChars ?? 500;
    this.#extraHeaders = options.extraHeaders ?? {};
  }

  get lastError(): ProviderError | undefined {
    return this.#lastError;
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMDelta> {
    const apiKey = this.#resolveApiKey();
    if (apiKey === undefined) {
      const error = new ProviderError(
        ProviderErrorCode.Auth,
        `Missing credential: pass apiKey or set ${this.#apiKeyEnv}.`,
      );
      this.#fail(error);
      yield { type: 'stop', reason: 'error', errorCode: error.code };
      return;
    }

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const opened = await this.#open(request, apiKey);

      if (!opened.ok) {
        if (opened.error.retryable && attempt < this.#maxAttempts && !request.signal.aborted) {
          await this.#wait(attempt, opened.retryAfterMs);
          continue;
        }
        if (request.signal.aborted) {
          yield { type: 'stop', reason: 'cancelled', errorCode: ProviderErrorCode.Cancelled };
          return;
        }
        this.#fail(opened.error);
        yield { type: 'stop', reason: 'error', errorCode: opened.error.code };
        return;
      }

      let emitted = 0;
      try {
        for await (const delta of this.#translate(opened.body, apiKey)) {
          emitted += 1;
          yield delta;
        }
        return;
      } catch (error) {
        const providerError = this.#streamFailure(error, request, apiKey, emitted);
        if (providerError.retryable && attempt < this.#maxAttempts && !request.signal.aborted) {
          await this.#wait(attempt, undefined);
          continue;
        }
        if (request.signal.aborted) {
          yield { type: 'stop', reason: 'cancelled', errorCode: ProviderErrorCode.Cancelled };
          return;
        }
        this.#fail(providerError);
        yield { type: 'stop', reason: 'error', errorCode: providerError.code };
        return;
      }
    }
  }

  #resolveApiKey(): string | undefined {
    const key = this.#apiKey ?? this.#env[this.#apiKeyEnv];
    return key === undefined || key.trim() === '' ? undefined : key;
  }

  #streamFailure(
    error: unknown,
    request: LLMRequest,
    apiKey: string,
    emitted: number,
  ): ProviderError {
    if (request.signal.aborted) {
      return new ProviderError(ProviderErrorCode.Cancelled, 'The request was cancelled.');
    }
    if (error instanceof ProviderError) {
      return error;
    }
    return new ProviderError(
      ProviderErrorCode.Network,
      redactSecret(`Stream failed: ${describeError(error)}`, apiKey),
      { retryable: emitted === 0 },
    );
  }

  async #wait(attempt: number, retryAfterMs: number | undefined): Promise<void> {
    const delay = this.#backoffDelay(attempt, retryAfterMs);
    this.retryDelays.push(delay);
    await this.#sleep(delay);
  }

  #backoffDelay(attempt: number, retryAfterMs: number | undefined): number {
    if (retryAfterMs !== undefined) {
      return Math.min(this.#maxRetryDelayMs, Math.max(0, retryAfterMs));
    }
    const exponential = Math.min(
      this.#maxRetryDelayMs,
      this.#baseRetryDelayMs * 2 ** (attempt - 1),
    );
    return Math.round(exponential + exponential * this.#jitterRatio * this.#random());
  }

  #fail(error: ProviderError): void {
    this.#lastError = error;
    this.#onError?.(error);
  }

  async #open(request: LLMRequest, apiKey: string): Promise<OpenResult> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      ...this.#extraHeaders,
    };
    const signals: AbortSignal[] = [request.signal];
    if (this.#requestTimeoutMs > 0) {
      signals.push(AbortSignal.timeout(this.#requestTimeoutMs));
    }

    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildBody(request, this.#thinkingBudgets)),
        signal: signals.length === 1 ? request.signal : AbortSignal.any(signals),
      });
    } catch (error) {
      if (request.signal.aborted) {
        return {
          ok: false,
          error: new ProviderError(ProviderErrorCode.Cancelled, 'The request was cancelled.'),
          retryAfterMs: undefined,
        };
      }
      return {
        ok: false,
        error: new ProviderError(
          ProviderErrorCode.Network,
          redactSecret(`Request failed: ${describeError(error)}`, apiKey),
          { retryable: true },
        ),
        retryAfterMs: undefined,
      };
    }

    if (!response.ok) {
      const rawBody = await this.#readErrorBody(response);
      return {
        ok: false,
        error: this.#mapStatus(response.status, rawBody, apiKey),
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), Date.now()),
      };
    }

    if (response.body === null) {
      return {
        ok: false,
        error: new ProviderError(
          ProviderErrorCode.BadStream,
          `Streaming response had no body (HTTP ${response.status}).`,
          { status: response.status },
        ),
        retryAfterMs: undefined,
      };
    }

    return { ok: true, body: response.body };
  }

  async #readErrorBody(response: Response): Promise<string> {
    try {
      return (await response.text()).slice(0, this.#maxErrorBodyChars);
    } catch {
      return '';
    }
  }

  #mapStatus(status: number, rawBody: string, apiKey: string): ProviderError {
    const detail = redactSecret(extractErrorMessage(rawBody), apiKey);
    if (status === 401 || status === 403) {
      return new ProviderError(
        ProviderErrorCode.Auth,
        `Anthropic rejected the credential (HTTP ${status}): ${detail}`,
        { status },
      );
    }
    if (status === 404) {
      return new ProviderError(
        ProviderErrorCode.ModelNotFound,
        `Model or endpoint not found (HTTP 404): ${detail}`,
        { status },
      );
    }
    if (status === 429) {
      return new ProviderError(
        ProviderErrorCode.RateLimited,
        `Rate limited (HTTP 429): ${detail}`,
        { status, retryable: true },
      );
    }
    // 529 is Anthropic's `overloaded_error`.
    if (status >= 500) {
      return new ProviderError(
        ProviderErrorCode.Server,
        `Anthropic server error (HTTP ${status}): ${detail}`,
        { status, retryable: true },
      );
    }
    if (status === 400 && /prompt is too long|too many tokens|context/i.test(detail)) {
      return new ProviderError(
        ProviderErrorCode.ContextOverflow,
        `The request exceeds the model context window: ${detail}`,
        { status },
      );
    }
    return new ProviderError(
      ProviderErrorCode.BadRequest,
      `Request rejected (HTTP ${status}): ${detail}`,
      { status, retryable: isRetryableStatus(status) },
    );
  }

  async *#translate(
    body: ReadableStream<Uint8Array>,
    apiKey: string,
  ): AsyncIterable<LLMDelta> {
    let stopReason: string | undefined;
    let inputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    let sawStop = false;
    let toolIndex = -1;
    const openToolIndexes = new Map<number, number>();

    const source = body as unknown as AsyncIterable<Uint8Array>;
    for await (const event of parseSseStream(source)) {
      const json = tryParseJson(event.data);
      if (json === undefined) {
        this.#fail(
          new ProviderError(
            ProviderErrorCode.BadStream,
            `Malformed SSE payload: ${redactSecret(event.data.slice(0, 200), apiKey)}`,
          ),
        );
        yield { type: 'stop', reason: 'error', errorCode: ProviderErrorCode.BadStream };
        return;
      }

      const parsed = streamEventSchema.safeParse(json);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ');
        this.#fail(
          new ProviderError(
            ProviderErrorCode.BadStream,
            `Unexpected stream chunk: ${redactSecret(detail, apiKey)}`,
          ),
        );
        yield { type: 'stop', reason: 'error', errorCode: ProviderErrorCode.BadStream };
        return;
      }

      const chunk = parsed.data;
      switch (chunk.type) {
        case 'message_start': {
          const usage = chunk.message?.usage;
          inputTokens = usage?.input_tokens ?? 0;
          cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
          cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
          sawUsage = usage !== null && usage !== undefined;
          break;
        }
        case 'content_block_start': {
          const block = chunk.content_block;
          const index = chunk.index ?? 0;
          if (block?.type === 'tool_use') {
            toolIndex += 1;
            openToolIndexes.set(index, toolIndex);
            const delta: {
              type: 'tool_call';
              index: number;
              id?: string;
              name?: string;
            } = { type: 'tool_call', index: toolIndex };
            if (typeof block.id === 'string') {
              delta.id = block.id;
            }
            if (typeof block.name === 'string') {
              delta.name = block.name;
            }
            yield delta;
          } else {
            openToolIndexes.delete(index);
          }
          break;
        }
        case 'content_block_delta': {
          const delta = chunk.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            if (delta.text.length > 0) {
              yield { type: 'text', text: delta.text };
            }
            break;
          }
          if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            if (delta.thinking.length > 0) {
              yield { type: 'reasoning', text: delta.thinking };
            }
            break;
          }
          if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const index = openToolIndexes.get(chunk.index ?? 0);
            if (index !== undefined && delta.partial_json.length > 0) {
              yield { type: 'tool_call', index, argsJsonDelta: delta.partial_json };
            }
          }
          break;
        }
        case 'message_delta': {
          if (typeof chunk.delta?.stop_reason === 'string') {
            stopReason = chunk.delta.stop_reason;
          }
          if (chunk.usage !== null && chunk.usage !== undefined) {
            outputTokens = chunk.usage.output_tokens ?? outputTokens;
            sawUsage = true;
          }
          break;
        }
        case 'message_stop':
          sawStop = true;
          break;
        case 'error': {
          const code = chunk.error?.type === 'overloaded_error'
            ? ProviderErrorCode.Server
            : ProviderErrorCode.BadRequest;
          this.#fail(
            new ProviderError(
              code,
              `Anthropic stream error: ${redactSecret(chunk.error?.message ?? 'unknown', apiKey)}`,
              { retryable: code === ProviderErrorCode.Server },
            ),
          );
          yield { type: 'stop', reason: 'error', errorCode: code };
          return;
        }
        default:
          // `ping`, `content_block_stop` and future events need no translation.
          break;
      }
    }

    if (sawUsage) {
      const usage: Usage = {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens: 0,
      };
      yield { type: 'usage', usage };
    }

    if (stopReason === undefined && !sawStop) {
      this.#fail(
        new ProviderError(
          ProviderErrorCode.BadStream,
          'The stream ended before a stop reason or message_stop arrived.',
        ),
      );
      yield { type: 'stop', reason: 'error', errorCode: ProviderErrorCode.BadStream };
      return;
    }

    yield { type: 'stop', reason: mapStopReason(stopReason) };
  }
}

export function createAnthropicProvider(
  options: AnthropicProviderOptions = {},
): AnthropicProvider {
  return new AnthropicProvider(options);
}
