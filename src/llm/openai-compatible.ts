/**
 * Generic provider for APIs that speak the OpenAI chat-completions wire format.
 *
 * DeepSeek, OpenAI, Groq, Together, OpenRouter, vLLM, Ollama and LM Studio all
 * use this shape, so one implementation serves them all with a few knobs
 * (`baseUrl`, `apiKeyEnv`, which field carries `max_tokens`, whether
 * `reasoning_effort` / `stream_options` are accepted).
 *
 * Invariants this module owns:
 *  - 5: `request.signal` reaches `fetch` and a cancelled run ends with
 *       `stop: cancelled` instead of an error.
 *  - 7: every failure ends with one stable `errorCode`.
 *  - 9: the API key never appears in a message, a delta, or `lastError`.
 *  - 10: retry timing is injectable (`sleep`, `random`), so tests stay offline
 *        and free of wall-clock dependence.
 *
 * Retry policy: only before the first delta of an attempt is emitted. Once the
 * caller has seen content, replaying silently would duplicate it, so the run
 * ends with `E_BAD_STREAM`/`E_NETWORK` and the caller decides.
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

const toolCallDeltaSchema = z.object({
  index: z.number().int(),
  id: z.string().nullish(),
  function: z
    .object({
      name: z.string().nullish(),
      arguments: z.string().nullish(),
    })
    .nullish(),
});

const chatChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            // DeepSeek spells it `reasoning_content`; some OpenAI-compatible
            // servers use `reasoning`.
            reasoning_content: z.string().nullish(),
            reasoning: z.string().nullish(),
            tool_calls: z.array(toolCallDeltaSchema).nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      // DeepSeek reports the split explicitly.
      prompt_cache_hit_tokens: z.number().nullish(),
      prompt_cache_miss_tokens: z.number().nullish(),
      // OpenAI reports the cached part as a detail.
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().nullish() })
        .nullish(),
      completion_tokens_details: z
        .object({ reasoning_tokens: z.number().nullish() })
        .nullish(),
    })
    .nullish(),
});

type ChatChunk = z.infer<typeof chatChunkSchema>;
type ChatUsage = NonNullable<ChatChunk['usage']>;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAiCompatibleOptions {
  /** Stable provider id, e.g. `deepseek`, `openai`. */
  readonly id?: string;
  /** Human label used in error messages, e.g. `DeepSeek`. */
  readonly label?: string;
  /** Used when `baseUrl` is not given. */
  readonly defaultBaseUrl?: string;
  /** Used when `apiKeyEnv` is not given. */
  readonly defaultApiKeyEnv?: string;
  readonly baseUrl?: string;
  /** Explicit credential; when omitted the env var named by `apiKeyEnv` is read. */
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: FetchLike;
  /** Injectable delay so tests never wait on a real clock. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0, 1). */
  readonly random?: () => number;
  readonly maxAttempts?: number;
  readonly baseRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly jitterRatio?: number;
  /** 0 disables the per-request timeout (used by tests). */
  readonly requestTimeoutMs?: number;
  /**
   * Not every route accepts `reasoning_effort`, so the field is omitted unless
   * a deployment opts in.
   */
  readonly sendReasoningEffort?: boolean;
  /** Some OpenAI-compatible servers reject `stream_options`. */
  readonly sendStreamOptions?: boolean;
  /** Newer OpenAI models want `max_completion_tokens` instead. */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Extra headers, e.g. `HTTP-Referer` for OpenRouter. */
  readonly extraHeaders?: Record<string, string>;
  readonly onError?: (error: ProviderError) => void;
  readonly maxErrorBodyChars?: number;
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

/**
 * Content for the wire. A message with image parts is sent as an OpenAI-style
 * content array (`image_url` with a data URI); everything else stays a plain
 * string so the common path is unchanged (M6).
 */
function toWireContent(message: Message): unknown {
  const parts = message.parts ?? [];
  if (!parts.some((part) => part.type === 'image')) {
    return message.content;
  }
  const wire: unknown[] = [];
  const hasTextPart = parts.some((part) => part.type === 'text');
  // `content` is the plain-text rendering; when explicit text parts exist they
  // are authoritative, otherwise the text would be sent twice.
  if (!hasTextPart && message.content.length > 0) {
    wire.push({ type: 'text', text: message.content });
  }
  for (const part of parts) {
    if (part.type === 'text') {
      wire.push({ type: 'text', text: part.text });
      continue;
    }
    wire.push({
      type: 'image_url',
      image_url: { url: `data:${part.mimeType};base64,${part.base64}` },
    });
  }
  return wire;
}

function toWireMessages(system: string, messages: readonly Message[]): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'tool') {
      // Tool results stay text: the chat-completions tool role has no image
      // form, so an image is attached on the next user/assistant turn instead.
      wire.push({
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content,
      });
      continue;
    }
    if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      wire.push({
        role: 'assistant',
        content: toWireContent(message),
        tool_calls: (message.toolCalls ?? []).map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        })),
      });
      continue;
    }
    wire.push({ role: message.role, content: toWireContent(message) });
  }
  return wire;
}

function buildBody(
  request: LLMRequest,
  settings: { sendReasoningEffort: boolean; sendStreamOptions: boolean; maxTokensField: string },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toWireMessages(request.system, request.messages),
    stream: true,
    [settings.maxTokensField]: request.maxOutputTokens,
  };
  if (settings.sendStreamOptions) {
    body.stream_options = { include_usage: true };
  }
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    body.tool_choice = 'auto';
  }
  if (settings.sendReasoningEffort && request.reasoningEffort !== undefined) {
    body.reasoning_effort = request.reasoningEffort;
  }
  return body;
}

/** Reads whichever spelling the server used; both shapes are common. */
function mapUsage(usage: ChatUsage): Usage {
  const promptTokens = usage.prompt_tokens ?? 0;
  const cacheReadTokens =
    usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const uncached =
    usage.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheReadTokens);
  return {
    inputTokens: Math.max(0, uncached),
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens: 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
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
    const direct = (parsed as { message?: unknown }).message;
    if (typeof direct === 'string') {
      return direct;
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

export class OpenAiCompatibleProvider implements LLMProvider {
  readonly id: string;
  /** Backoff delays actually used, in order. Useful in tests and diagnostics. */
  readonly retryDelays: number[] = [];

  readonly #label: string;
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
  readonly #sendReasoningEffort: boolean;
  readonly #sendStreamOptions: boolean;
  readonly #maxTokensField: string;
  readonly #extraHeaders: Record<string, string>;
  readonly #onError: ((error: ProviderError) => void) | undefined;
  readonly #maxErrorBodyChars: number;
  #lastError: ProviderError | undefined;

  constructor(options: OpenAiCompatibleOptions = {}) {
    const baseUrl = options.baseUrl ?? options.defaultBaseUrl ?? 'https://api.openai.com/v1';
    this.#label = options.label ?? options.id ?? 'provider';
    this.id = options.id ?? 'openai-compatible';
    this.#url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.#apiKey = options.apiKey;
    this.#apiKeyEnv = options.apiKeyEnv ?? options.defaultApiKeyEnv ?? 'OPENAI_API_KEY';
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.#baseRetryDelayMs = options.baseRetryDelayMs ?? 500;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 8_000;
    this.#jitterRatio = options.jitterRatio ?? 0.2;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 600_000;
    this.#sendReasoningEffort = options.sendReasoningEffort ?? false;
    this.#sendStreamOptions = options.sendStreamOptions ?? true;
    this.#maxTokensField = options.maxTokensField ?? 'max_tokens';
    this.#extraHeaders = options.extraHeaders ?? {};
    this.#onError = options.onError;
    this.#maxErrorBodyChars = options.maxErrorBodyChars ?? 500;
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
          // Cancellation is control flow, not a failure: keep it out of onError.
          yield {
            type: 'stop',
            reason: 'cancelled',
            errorCode: ProviderErrorCode.Cancelled,
          };
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
          yield {
            type: 'stop',
            reason: 'cancelled',
            errorCode: ProviderErrorCode.Cancelled,
          };
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
      authorization: `Bearer ${apiKey}`,
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
        body: JSON.stringify(
          buildBody(request, {
            sendReasoningEffort: this.#sendReasoningEffort,
            sendStreamOptions: this.#sendStreamOptions,
            maxTokensField: this.#maxTokensField,
          }),
        ),
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
        `${this.#label} rejected the credential (HTTP ${status}): ${detail}`,
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
    if (status >= 500) {
      return new ProviderError(
        ProviderErrorCode.Server,
        `${this.#label} server error (HTTP ${status}): ${detail}`,
        { status, retryable: true },
      );
    }
    if (status === 400 && /context length|too long|maximum context|reduce the length/i.test(detail)) {
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
    let finishReason: string | undefined;
    let usage: Usage | undefined;
    let sawDone = false;

    // A ReadableStream satisfies the parser's async-iterable contract at
    // runtime; the cast keeps the parser free of DOM-only typings.
    const source = body as unknown as AsyncIterable<Uint8Array>;
    for await (const event of parseSseStream(source)) {
      if (event.data === '[DONE]') {
        sawDone = true;
        break;
      }

      const json = tryParseJson(event.data);
      if (json === undefined) {
        yield {
          type: 'stop',
          reason: 'error',
          errorCode: ProviderErrorCode.BadStream,
        };
        this.#fail(
          new ProviderError(
            ProviderErrorCode.BadStream,
            `Malformed SSE payload: ${redactSecret(event.data.slice(0, 200), apiKey)}`,
          ),
        );
        return;
      }

      const parsed = chatChunkSchema.safeParse(json);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ');
        yield {
          type: 'stop',
          reason: 'error',
          errorCode: ProviderErrorCode.BadStream,
        };
        this.#fail(
          new ProviderError(
            ProviderErrorCode.BadStream,
            `Unexpected stream chunk: ${redactSecret(detail, apiKey)}`,
          ),
        );
        return;
      }

      const chunk = parsed.data;
      if (chunk.usage !== null && chunk.usage !== undefined) {
        usage = mapUsage(chunk.usage);
      }

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta;
        if (delta !== null && delta !== undefined) {
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            yield { type: 'text', text: delta.content };
          }
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            yield { type: 'reasoning', text: reasoning };
          }
          for (const call of delta.tool_calls ?? []) {
            const toolCallDelta: {
              type: 'tool_call';
              index: number;
              id?: string;
              name?: string;
              argsJsonDelta?: string;
            } = { type: 'tool_call', index: call.index };
            if (typeof call.id === 'string' && call.id.length > 0) {
              toolCallDelta.id = call.id;
            }
            if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
              toolCallDelta.name = call.function.name;
            }
            if (
              typeof call.function?.arguments === 'string' &&
              call.function.arguments.length > 0
            ) {
              toolCallDelta.argsJsonDelta = call.function.arguments;
            }
            yield toolCallDelta;
          }
        }
        if (typeof choice.finish_reason === 'string') {
          finishReason = choice.finish_reason;
        }
      }
    }

    if (usage !== undefined) {
      yield { type: 'usage', usage };
    }

    if (finishReason === undefined && !sawDone) {
      this.#fail(
        new ProviderError(
          ProviderErrorCode.BadStream,
          'The stream ended before a finish reason or [DONE] marker arrived.',
        ),
      );
      yield { type: 'stop', reason: 'error', errorCode: ProviderErrorCode.BadStream };
      return;
    }

    yield { type: 'stop', reason: mapFinishReason(finishReason) };
  }
}

export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleOptions = {},
): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider(options);
}
