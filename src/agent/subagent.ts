/**
 * In-process child agents.
 *
 * The whole point is context isolation: the child starts from its own history,
 * works with the same tools and workspace, and hands back one answer. Its
 * transcript is returned for the caller to log (or discard) but is never
 * appended to the parent's message list, so a long investigation costs the
 * parent a summary rather than every intermediate step.
 */

import type { LLMProvider, Usage } from '../llm/types.js';
import type { ToolCtx, ToolRegistry } from '../tools/registry.js';
import { runAgentLoop } from './loop.js';
import type { AgentLoopEventRecord, AgentLoopListener, AgentRunStatus } from './loop.js';

export interface SubagentRunnerOptions {
  readonly provider: LLMProvider;
  /** Tools the child may use; usually the same registry as the parent. */
  readonly registry: ToolRegistry;
  readonly model: string;
  readonly system: string;
  readonly maxSteps?: number;
  readonly maxOutputTokens?: number;
  readonly tokenBudget?: number;
  readonly wallClockMs?: number;
  readonly onEvent?: AgentLoopListener;
  readonly now?: () => number;
}

export interface SubagentRunResult {
  readonly ok: boolean;
  readonly status: AgentRunStatus;
  readonly summary: string;
  readonly usage: Usage;
  readonly steps: number;
  readonly errorCode: string | undefined;
  /** The child transcript, for the caller's log. Never merged into the parent. */
  readonly transcript: readonly { readonly role: string; readonly content: string }[];
}

export interface SubagentRunner {
  readonly maxSteps: number;
  run(task: string, ctx: ToolCtx, signal: AbortSignal): Promise<SubagentRunResult>;
}

export function createSubagentRunner(options: SubagentRunnerOptions): SubagentRunner {
  const maxSteps = options.maxSteps ?? 16;

  return {
    maxSteps,

    async run(task, ctx, signal) {
      const result = await runAgentLoop({
        provider: options.provider,
        registry: options.registry,
        ctx,
        signal,
        model: options.model,
        system: options.system,
        messages: [{ role: 'user', content: task }],
        maxSteps,
        ...(options.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: options.maxOutputTokens }),
        ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
        ...(options.wallClockMs === undefined ? {} : { wallClockMs: options.wallClockMs }),
        ...(options.onEvent === undefined
          ? {}
          : {
              onEvent: (event: AgentLoopEventRecord) => options.onEvent?.(event),
            }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });

      return {
        ok: result.ok && result.text.trim().length > 0,
        status: result.status,
        summary: result.text.trim(),
        usage: result.usage,
        steps: result.steps,
        errorCode: result.errorCode,
        transcript: result.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      };
    },
  };
}
