/**
 * The model-facing `skill` tool: reads one skill's full instructions on demand.
 *
 * The catalog lives in the system prompt as one line per skill, so the body is
 * only paid for when it is actually used.
 */

import { z } from 'zod';
import type { SkillLoader } from '../skills/loader.js';
import { ToolErrorCode } from './registry.js';
import type { ToolDef, ToolResult } from './registry.js';

const skillSchema = z.object({
  name: z.string().min(1).describe('Skill name exactly as listed in the Skills section.'),
});

export interface SkillToolConfig {
  readonly loader: SkillLoader;
  readonly maxInlineTokens?: number;
}

export function createSkillTool(config: SkillToolConfig): ToolDef<z.infer<typeof skillSchema>> {
  return {
    name: 'skill',
    description:
      'Load the full instructions of a skill listed in the Skills section of your system prompt.',
    schema: skillSchema,
    parallelSafe: true,
    requiresApproval: 'never',
    timeoutMs: 15_000,
    maxInlineTokens: config.maxInlineTokens ?? 3_000,
    run: async (args): Promise<ToolResult> => {
      const result = await config.loader.load(args.name);
      if (!result.ok) {
        return {
          ok: false,
          code: result.code === 'E_NOT_FOUND' ? ToolErrorCode.NotFound : ToolErrorCode.ToolFailed,
          output: result.text,
        };
      }
      return {
        ok: true,
        output: result.text,
        meta: {
          skill: result.entry?.name,
          path: result.entry?.path,
          scope: result.entry?.scope,
        },
      };
    },
  };
}
