/**
 * The model-facing skill tools: `skill` reads one skill's full instructions on
 * demand, `skill_search` finds one when the catalog in the system prompt was
 * summarised because there are too many to list.
 *
 * The catalog costs one line per skill, so the body is only paid for when it is
 * actually used.
 */

import { z } from 'zod';
import type { SkillLoader } from '../skills/loader.js';
import { ToolErrorCode } from './registry.js';
import type { ToolDef, ToolResult } from './registry.js';

const skillSchema = z.object({
  name: z.string().min(1).describe('Skill name exactly as listed in the Skills section.'),
});

const searchSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Words to match against skill names, descriptions and categories.'),
  limit: z.number().int().min(1).max(50).optional().describe('Maximum matches (default 20).'),
});

export interface SkillToolConfig {
  readonly loader: SkillLoader;
  readonly maxInlineTokens?: number;
}

export function createSkillSearchTool(
  config: SkillToolConfig,
): ToolDef<z.infer<typeof searchSchema>> {
  return {
    name: 'skill_search',
    description:
      'Search the available skills by keyword when the Skills section lists categories instead of every name.',
    schema: searchSchema,
    parallelSafe: true,
    requiresApproval: 'never',
    timeoutMs: 15_000,
    maxInlineTokens: config.maxInlineTokens ?? 2_000,
    run: async (args): Promise<ToolResult> => {
      const matches = config.loader.search(args.query, args.limit ?? 20);
      if (matches.length === 0) {
        return {
          ok: false,
          code: ToolErrorCode.NotFound,
          output: `No skill matches ${JSON.stringify(args.query)}. There are ${String(
            config.loader.catalog().length,
          )} skills in total; try a broader keyword.`,
        };
      }
      const lines = matches.map(
        (entry) => `- ${entry.name} [${entry.category}]: ${entry.description}`,
      );
      return {
        ok: true,
        output: `${String(matches.length)} match(es):\n${lines.join('\n')}\nLoad one with the \`skill\` tool.`,
        meta: { matches: matches.length },
      };
    },
  };
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
