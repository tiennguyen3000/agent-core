/**
 * The agent loop (invariants 5, 6 and 7).
 *
 * One turn = repeated steps of "ask the model, run what it asked for, feed the
 * results back" until it stops asking for tools. The loop owns the budgets
 * (`maxSteps`, `tokenBudget`, `wallClockMs`), forwards cancellation into every
 * tool, and reports every fact through `onEvent` so the caller can append them
 * to the session log without the loop knowing about persistence.
 *
 * M7 uses it for child agents; M8 wires the same loop for the top-level agent.
 */

import { assembleResponse } from '../llm/assemble.js';
import type {
  LLMDelta,
  LLMProvider,
  LLMRequest,
  Message,
  ReasoningEffort,
  ToolCall,
  Usage,
} from '../llm/types.js';
import type { ToolCtx, ToolRegistry, ToolResult } from '../tools/registry.js';

export type AgentRunStatus = 'done' | 'max-steps' | 'budget-exceeded' | 'cancelled' | 'error';

export interface AgentLoopEvent {
  readonly t: 'step.start';
  readonly step: number;
}

export interface AgentLoopLlmEvent {
  readonly t: 'llm.response';
  readonly step: number;
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: Usage | undefined;
}

export interface AgentLoopToolEvent {
  readonly t: 'tool.result';
  readonly step: number;
  readonly name: string;
  readonly callId: string;
  readonly result: ToolResult;
}

export interface AgentLoopEndEvent {
  readonly t: 'run.end';
  readonly status: AgentRunStatus;
  readonly usage: Usage;
  readonly steps: number;
}

export type AgentLoopEventRecord =
  | AgentLoopEvent
  | AgentLoopLlmEvent
  | AgentLoopToolEvent
  | AgentLoopEndEvent;

export type AgentLoopListener = (event: AgentLoopEventRecord) => void | Promise<void>;

export interface AgentLoopOptions {
  readonly provider: LLMProvider;
  readonly registry: ToolRegistry;
  readonly ctx: ToolCtx;
  readonly signal: AbortSignal;
  readonly model: string;
  readonly system: string;
  readonly messages: readonly Message[];
  readonly maxSteps?: number;
  readonly maxOutputTokens?: number;
  /** Total prompt + output tokens the whole run may spend; 0 disables. */
  readonly tokenBudget?: number;
  /** Wall-clock ceiling for the run; 0 disables. */
  readonly wallClockMs?: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly onEvent?: AgentLoopListener;
  readonly now?: () => number;
}

export interface AgentRunResult {
  readonly ok: boolean;
  readonly status: AgentRunStatus;
  /** The last non-empty assistant text: the answer a caller usually wants. */
  readonly text: string;
  readonly messages: readonly Message[];
  readonly usage: Usage;
  readonly steps: number;
  readonly errorCode: string | undefined;
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

function addUsage(total: Usage, next: Usage | undefined): Usage {
  if (next === undefined) {
    return total;
  }
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: (total.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
    reasoningTokens: (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
  };
}

function spentTokens(usage: Usage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

function toolMessageContent(result: ToolResult, name: string): string {
  if (result.ok) {
    return result.output;
  }
  return `[${result.code ?? 'E_TOOL_FAILED'}] ${name} failed: ${result.output}`;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentRunResult> {
  const maxSteps = options.maxSteps ?? 24;
  const maxOutputTokens = options.maxOutputTokens ?? 4_096;
  const tokenBudget = options.tokenBudget ?? 0;
  const wallClockMs = options.wallClockMs ?? 0;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  let messages: Message[] = [...options.messages];
  let usage = ZERO_USAGE;
  let steps = 0;
  let text = '';
  let status: AgentRunStatus = 'max-steps';
  let errorCode: string | undefined;

  const emit = async (event: AgentLoopEventRecord): Promise<void> => {
    await options.onEvent?.(event);
  };

  while (steps < maxSteps) {
    if (options.signal.aborted) {
      status = 'cancelled';
      break;
    }
    if (wallClockMs > 0 && now() - startedAt >= wallClockMs) {
      status = 'budget-exceeded';
      break;
    }
    if (tokenBudget > 0 && spentTokens(usage) >= tokenBudget) {
      status = 'budget-exceeded';
      break;
    }

    steps += 1;
    await emit({ t: 'step.start', step: steps });

    const request: LLMRequest = {
      model: options.model,
      system: options.system,
      messages,
      tools: options.registry.schemas(),
      maxOutputTokens,
      signal: options.signal,
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: options.reasoningEffort }),
    };

    const deltas: LLMDelta[] = [];
    for await (const delta of options.provider.stream(request)) {
      deltas.push(delta);
    }
    const response = assembleResponse(deltas);
    usage = addUsage(usage, response.usage);
    await emit({
      t: 'llm.response',
      step: steps,
      text: response.text,
      toolCalls: response.toolCalls,
      usage: response.usage,
    });

    // Keep whatever the model produced before an error: the caller shows it and
    // the transcript stays faithful to what happened.
    if (response.text.trim().length > 0) {
      text = response.text;
    }
    if (response.text.length > 0 || response.toolCalls.length > 0) {
      messages = [
        ...messages,
        response.toolCalls.length > 0
          ? { role: 'assistant', content: response.text, toolCalls: response.toolCalls }
          : { role: 'assistant', content: response.text },
      ];
    }

    if (response.errorCode !== undefined) {
      status = 'error';
      errorCode = response.errorCode;
      break;
    }

    if (response.toolCalls.length === 0) {
      status = 'done';
      break;
    }

    const results = await options.registry.dispatchMany(
      response.toolCalls.map((call) => ({ name: call.name, args: call.args })),
      options.ctx,
    );

    for (const [index, call] of response.toolCalls.entries()) {
      const result = results[index] ?? {
        ok: false,
        code: 'E_TOOL_FAILED',
        output: 'the tool produced no result',
      };
      await emit({
        t: 'tool.result',
        step: steps,
        name: call.name,
        callId: call.id,
        result,
      });
      messages = [
        ...messages,
        { role: 'tool', content: toolMessageContent(result, call.name), toolCallId: call.id },
      ];
    }

    if (options.signal.aborted) {
      status = 'cancelled';
      break;
    }
  }

  await emit({ t: 'run.end', status, usage, steps });

  return {
    ok: status === 'done',
    status,
    text,
    messages,
    usage,
    steps,
    errorCode,
  };
}
