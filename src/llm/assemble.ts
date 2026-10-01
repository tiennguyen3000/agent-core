/**
 * Folds a delta stream into one completed response.
 *
 * Providers stream tool calls as fragments (`argsJsonDelta` pieces sharing an
 * `index`), so every consumer needs the same reassembly. Keeping it here means
 * the agent loop, tests, and any future front end agree on the result.
 *
 * Malformed argument JSON is not thrown away: it is reported in
 * `malformedToolArgs` so the loop can answer the model with a stable
 * `E_BAD_ARGS` tool result instead of crashing the turn.
 */

import type { LLMDelta, StopReason, ToolCall, Usage } from './types.js';

export interface MalformedToolArgs {
  readonly index: number;
  readonly raw: string;
}

export interface CompletedResponse {
  readonly text: string;
  readonly reasoning: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: Usage | undefined;
  readonly stop: StopReason;
  readonly errorCode: string | undefined;
  readonly malformedToolArgs: readonly MalformedToolArgs[];
}

interface PartialCall {
  id: string | undefined;
  name: string | undefined;
  args: string;
}

export function assembleResponse(deltas: readonly LLMDelta[]): CompletedResponse {
  let text = '';
  let reasoning = '';
  let usage: Usage | undefined;
  // First stop wins: a second one cannot silently clear an error the provider
  // already reported.
  let stop: StopReason | undefined;
  let errorCode: string | undefined;
  const calls = new Map<number, PartialCall>();

  for (const delta of deltas) {
    switch (delta.type) {
      case 'text':
        text += delta.text;
        break;
      case 'reasoning':
        reasoning += delta.text;
        break;
      case 'usage':
        usage = delta.usage;
        break;
      case 'tool_call': {
        const existing = calls.get(delta.index) ?? { id: undefined, name: undefined, args: '' };
        if (delta.id !== undefined && existing.id === undefined) {
          existing.id = delta.id;
        }
        if (delta.name !== undefined && existing.name === undefined) {
          existing.name = delta.name;
        }
        if (delta.argsJsonDelta !== undefined) {
          existing.args += delta.argsJsonDelta;
        }
        calls.set(delta.index, existing);
        break;
      }
      case 'stop':
        if (stop === undefined) {
          stop = delta.reason;
          errorCode = delta.errorCode;
        }
        break;
    }
  }

  const toolCalls: ToolCall[] = [];
  const malformedToolArgs: MalformedToolArgs[] = [];

  for (const index of [...calls.keys()].sort((a, b) => a - b)) {
    const partial = calls.get(index);
    if (partial === undefined) {
      continue;
    }
    let args: unknown = {};
    const raw = partial.args.trim();
    if (raw.length > 0) {
      try {
        args = JSON.parse(raw);
      } catch {
        args = {};
        malformedToolArgs.push({ index, raw: partial.args });
      }
    }
    toolCalls.push({
      id: partial.id ?? `call_${index}`,
      name: partial.name ?? '',
      args,
    });
  }

  return { text, reasoning, toolCalls, usage, stop: stop ?? 'end', errorCode, malformedToolArgs };
}
