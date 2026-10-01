/**
 * Filesystem tools over the `ToolCtx.fs` port.
 *
 * Three rules the model is expected to learn from the tool results:
 *  - a mutation must be preceded by a read of the same path (observation
 *    policy, when a `ReadTracker` is mounted on the context);
 *  - writing outside the workspace is refused even if the port is unconfined;
 *  - a read of a missing file records the absence, which authorises creating
 *    exactly that path.
 *
 * `fs_read_image` is deliberately absent: `Message.content` is text-only in the
 * current contract, so images need attachment storage before they can be shown.
 */

import { z } from 'zod';
import { isInsideWorkdir, resolveToolPath } from './paths.js';
import { ToolErrorCode } from './registry.js';
import type { ToolCtx, ToolDef, ToolResult } from './registry.js';

const DEFAULT_READ_LINES = 400;
const MAX_READ_LINES = 2_000;

function fail(code: string, output: string): ToolResult {
  return { ok: false, code, output };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function tryList(ctx: ToolCtx, absolute: string): Promise<readonly unknown[] | undefined> {
  try {
    return await ctx.fs.list(absolute);
  } catch {
    return undefined;
  }
}

/**
 * Enforces read-before-write when the context carries a tracker. Returns a
 * failure result when the mutation must be refused, otherwise `undefined`.
 */
async function guardMutation(
  ctx: ToolCtx,
  absolute: string,
  display: string,
  verb: string,
): Promise<ToolResult | undefined> {
  const tracker = ctx.reads;
  if (tracker === undefined) {
    return undefined;
  }

  const exists = await ctx.fs.exists(absolute);
  let current: string | undefined;
  if (exists) {
    try {
      current = await ctx.fs.read(absolute);
    } catch {
      current = undefined;
    }
  }

  const status = tracker.status(absolute, current);
  if (status === 'ok') {
    return undefined;
  }
  if (status === 'not-read') {
    return fail(
      ToolErrorCode.NoRead,
      `Refusing to ${verb} ${display} before reading it. Call fs_read on that path first — reading a missing file records it as absent and authorises creating it.`,
    );
  }
  return fail(
    ToolErrorCode.StaleRead,
    `${display} changed since it was read. Read it again, then retry the ${verb}.`,
  );
}

const readSchema = z.object({
  path: z.string().min(1).describe('File path, relative to the workspace or absolute.'),
  offset: z.number().int().min(1).optional().describe('First line to return (1-based).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_READ_LINES)
    .optional()
    .describe(`How many lines to return (default ${String(DEFAULT_READ_LINES)}).`),
});

export interface FsReadConfig {
  readonly maxLines?: number;
  readonly maxInlineTokens?: number;
}

export function createFsReadTool(
  config: FsReadConfig = {},
): ToolDef<z.infer<typeof readSchema>> {
  const defaultLimit = Math.min(config.maxLines ?? DEFAULT_READ_LINES, MAX_READ_LINES);

  return {
    name: 'fs_read',
    description:
      'Read a UTF-8 text file and return its lines with line numbers. A successful read is required before fs_write or fs_edit can touch the same path.',
    schema: readSchema,
    parallelSafe: true,
    requiresApproval: 'never',
    timeoutMs: 15_000,
    maxInlineTokens: config.maxInlineTokens ?? 2_400,
    run: async (args, ctx) => {
      const { absolute, relative } = resolveToolPath(ctx.workdir, args.path);

      if (!(await ctx.fs.exists(absolute))) {
        // Recording the absence is what authorises creating this exact path.
        ctx.reads?.record(absolute, undefined);
        return fail(
          ToolErrorCode.NotFound,
          `${relative} does not exist. It is now recorded as absent, so fs_write may create it.`,
        );
      }

      let content: string;
      try {
        content = await ctx.fs.read(absolute);
      } catch (error) {
        const listing = await tryList(ctx, absolute);
        if (listing !== undefined) {
          return fail(
            ToolErrorCode.IsDirectory,
            `${relative} is a directory, not a file. Use fs_glob with path "${relative}" to list its files.`,
          );
        }
        return fail(
          ToolErrorCode.ToolFailed,
          `Could not read ${relative}: ${message(error)}`,
        );
      }

      ctx.reads?.record(absolute, content);

      const lines = content.split('\n');
      const start = Math.max(1, args.offset ?? 1);
      const limit = Math.min(args.limit ?? defaultLimit, MAX_READ_LINES);
      const slice = lines.slice(start - 1, start - 1 + limit);
      const end = start + Math.max(0, slice.length - 1);
      const width = String(Math.max(end, 1)).length;
      const body = slice
        .map((line, index) => `${String(start + index).padStart(width, ' ')}\t${line}`)
        .join('\n');
      const footer =
        lines.length > end ? `\n... (lines ${String(start)}-${String(end)} of ${String(lines.length)})` : '';

      return {
        ok: true,
        output: `${body}${footer}`,
        meta: { totalLines: lines.length, from: start, to: end },
      };
    },
  };
}

const writeSchema = z.object({
  path: z.string().min(1).describe('File path inside the workspace.'),
  content: z.string().describe('Full file content; this replaces the file.'),
});

export function createFsWriteTool(): ToolDef<z.infer<typeof writeSchema>> {
  return {
    name: 'fs_write',
    description:
      'Create or replace a whole file inside the workspace. Requires a successful fs_read of the same path first.',
    schema: writeSchema,
    parallelSafe: false,
    requiresApproval: 'policy',
    timeoutMs: 15_000,
    maxInlineTokens: 400,
    action: (args) => ({ kind: 'fs.write', path: args.path }),
    run: async (args, ctx) => {
      const { absolute, relative } = resolveToolPath(ctx.workdir, args.path);
      if (!isInsideWorkdir(ctx.workdir, absolute)) {
        return fail(
          ToolErrorCode.PathEscape,
          `Refusing to write ${args.path}: it resolves outside the workspace (${ctx.workdir}).`,
        );
      }

      const guard = await guardMutation(ctx, absolute, relative, 'write');
      if (guard !== undefined) {
        return guard;
      }

      const existed = await ctx.fs.exists(absolute);
      await ctx.fs.write(absolute, args.content);
      ctx.reads?.record(absolute, args.content);

      return {
        ok: true,
        output: `${existed ? 'Replaced' : 'Created'} ${relative} (${String(args.content.length)} chars).`,
      };
    },
  };
}

const editSchema = z.object({
  path: z.string().min(1).describe('File path inside the workspace.'),
  old_string: z.string().min(1).describe('Exact text to replace; must be unique unless replace_all.'),
  new_string: z.string().describe('Replacement text.'),
  replace_all: z.boolean().optional().describe('Replace every occurrence (default false).'),
});

/** Counts non-overlapping occurrences without touching a regex. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export function createFsEditTool(): ToolDef<z.infer<typeof editSchema>> {
  return {
    name: 'fs_edit',
    description:
      'Replace an exact substring inside a file. Requires a successful fs_read of the same path first.',
    schema: editSchema,
    parallelSafe: false,
    requiresApproval: 'policy',
    timeoutMs: 15_000,
    maxInlineTokens: 400,
    action: (args) => ({ kind: 'fs.write', path: args.path }),
    run: async (args, ctx) => {
      const { absolute, relative } = resolveToolPath(ctx.workdir, args.path);
      if (!isInsideWorkdir(ctx.workdir, absolute)) {
        return fail(
          ToolErrorCode.PathEscape,
          `Refusing to edit ${args.path}: it resolves outside the workspace (${ctx.workdir}).`,
        );
      }

      const guard = await guardMutation(ctx, absolute, relative, 'edit');
      if (guard !== undefined) {
        return guard;
      }

      const current = await ctx.fs.read(absolute);
      const occurrences = countOccurrences(current, args.old_string);
      if (occurrences === 0) {
        return fail(
          ToolErrorCode.NoMatch,
          `${JSON.stringify(args.old_string)} was not found in ${relative}. Read the file again and pass an exact substring.`,
        );
      }
      if (occurrences > 1 && args.replace_all !== true) {
        return fail(
          ToolErrorCode.AmbiguousMatch,
          `${JSON.stringify(args.old_string)} appears ${String(occurrences)} times in ${relative}. Pass a longer unique string or set replace_all: true.`,
        );
      }

      const next =
        args.replace_all === true
          ? current.split(args.old_string).join(args.new_string)
          : current.replace(args.old_string, args.new_string);

      await ctx.fs.write(absolute, next);
      ctx.reads?.record(absolute, next);

      return {
        ok: true,
        output: `Edited ${relative}: ${args.replace_all === true ? `${String(occurrences)} replacements` : '1 replacement'}.`,
      };
    },
  };
}
