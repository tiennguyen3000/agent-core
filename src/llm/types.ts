/**
 * Model-facing LLM contract.
 *
 * Everything above this layer talks to `LLMProvider` only; no other module may
 * import a concrete provider. Providers stream `LLMDelta` values so the agent
 * loop can render text, accumulate tool calls, and observe usage without
 * buffering a whole response.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A JSON Schema document as sent to the model (shape is provider-defined). */
export interface JsonSchemaObject {
  readonly [key: string]: unknown;
}

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export interface Message {
  readonly role: Role;
  readonly content: string;
  /** Set on `tool` messages: the `ToolCall.id` this result answers. */
  readonly toolCallId?: string;
  /** Set on `assistant` messages that requested tools. */
  readonly toolCalls?: readonly ToolCall[];
}

/**
 * Token accounting for one model request.
 *
 * `inputTokens` counts only the *uncached* prompt tokens; `cacheReadTokens`
 * counts the prefix the provider served from its prompt cache (DeepSeek reports
 * these as `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`), and
 * `cacheWriteTokens` counts tokens written into the cache. Reasoners report
 * their hidden tokens in `reasoningTokens`, which providers usually bill as
 * output.
 */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export type ReasoningEffort = 'low' | 'medium' | 'high';

export type StopReason = 'end' | 'tool_calls' | 'length' | 'cancelled' | 'error';

export interface LLMRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSchema[];
  readonly maxOutputTokens: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly signal: AbortSignal;
}

export type LLMDelta =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | {
      readonly type: 'tool_call';
      /** Position of the call inside the response; deltas for one call share an index. */
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argsJsonDelta?: string;
    }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'stop'; readonly reason: StopReason; readonly errorCode?: string };

export interface LLMProvider {
  readonly id: string;
  stream(request: LLMRequest): AsyncIterable<LLMDelta>;
}
