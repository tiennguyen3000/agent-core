/**
 * The model-facing `subagent` tool.
 *
 * Only the child's final answer travels back into the parent's context; the
 * child's steps are reported through `meta` for the session log. That is the
 * token saving: the parent pays for one summary instead of a full
 * investigation.
 */

import { z } from 'zod';
import type { SubagentRunner } from '../agent/subagent.js';
import { ToolErrorCode } from './registry.js';
import type { ToolDef, ToolResult } from './registry.js';

const subagentSchema = z.object({
  task: z
    .string()
    .min(1)
    .describe(
      'What the child agent should accomplish. Include every fact it needs: it cannot see this conversation.',
    ),
  description: z.string().optional().describe('Short label for the work, shown in the UI.'),
});

export interface SubagentToolConfig {
  readonly runner: SubagentRunner;
  readonly maxInlineTokens?: number;
}

function failureCode(status: string): string {
  switch (status) {
    case 'cancelled':
      return ToolErrorCode.Cancelled;
    case 'budget-exceeded':
      return ToolErrorCode.BudgetExceeded;
    case 'max-steps':
      return ToolErrorCode.MaxSteps;
    default:
      return ToolErrorCode.ToolFailed;
  }
}

export function createSubagentTool(
  config: SubagentToolConfig,
): ToolDef<z.infer<typeof subagentSchema>> {
  return {
    name: 'subagent',
    description:
      'Delegate a self-contained task to a child agent that has its own context and the same tools. Only its final answer comes back, so use it for work that would otherwise flood this conversation with intermediate steps.',
    schema: subagentSchema,
    parallelSafe: false,
    requiresApproval: 'never',
    timeoutMs: 0,
    maxInlineTokens: config.maxInlineTokens ?? 1_600,
    run: async (args, ctx): Promise<ToolResult> => {
      const run = await config.runner.run(args.task, ctx, ctx.signal);

      if (!run.ok) {
        const reason =
          run.errorCode ??
          (run.summary.length > 0 ? 'the child produced no final answer' : run.status);
        return {
          ok: false,
          code: failureCode(run.status),
          output: `Subagent ${run.status} (${reason}). Steps: ${String(run.steps)}.`,
          meta: { usage: run.usage, steps: run.steps, status: run.status },
        };
      }

      return {
        ok: true,
        output: run.summary,
        meta: {
          usage: run.usage,
          steps: run.steps,
          status: run.status,
          ...(args.description === undefined ? {} : { description: args.description }),
        },
      };
    },
  };
}
