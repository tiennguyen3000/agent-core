/**
 * Discovery tools: `fs_glob` and `fs_grep`.
 *
 * Both walk the workspace through the filesystem port, so the sandbox owns
 * confinement, and both are capped: a search never scans without a bound on
 * entries, files or bytes, and reports when it stopped early. Reads stay
 * absolute; everything returned to the model is workdir-relative.
 */

import { join } from 'node:path';
import { z } from 'zod';
import { joinRelative, resolveToolPath } from './paths.js';
import { ToolErrorCode } from './registry.js';
import type { ToolCtx, ToolDef, ToolResult } from './registry.js';

export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.pnpm-store',
  '.tooling',
  '.tmp',
];

function fail(code: string, output: string): ToolResult {
  return { ok: false, code, output };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * A small glob matcher: `**` spans directories, `*` and `?` stay inside one
 * segment, and `{a,b}` is an alternation.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          out += '(?:.*/)?';
          index += 2;
        } else {
          out += '.*';
          index += 1;
        }
        continue;
      }
      out += '[^/]*';
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    if (char === '{') {
      const close = pattern.indexOf('}', index);
      if (close > index) {
        const alternatives = pattern
          .slice(index + 1, close)
          .split(',')
          .map((part) => part.split('').map(escapeRegExpChar).join(''));
        out += `(?:${alternatives.join('|')})`;
        index = close;
        continue;
      }
    }
    out += escapeRegExpChar(char);
  }
  return new RegExp(`^${out}$`);
}

interface WalkStats {
  entries: number;
  truncated: boolean;
}

interface WalkEntry {
  readonly absolute: string;
  readonly relative: string;
  readonly isDirectory: boolean;
}

interface WalkOptions {
  readonly ignore: ReadonlySet<string>;
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly signal: AbortSignal;
}

async function* walk(
  ctx: ToolCtx,
  absoluteDir: string,
  relativeDir: string,
  depth: number,
  options: WalkOptions,
  stats: WalkStats,
): AsyncIterable<WalkEntry> {
  if (depth > options.maxDepth) {
    stats.truncated = true;
    return;
  }

  let entries: Awaited<ReturnType<ToolCtx['fs']['list']>>;
  try {
    entries = await ctx.fs.list(absoluteDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (options.signal.aborted) {
      return;
    }
    if (stats.entries >= options.maxEntries) {
      stats.truncated = true;
      return;
    }
    stats.entries += 1;

    const childAbsolute = join(absoluteDir, entry.name);
    const childRelative = joinRelative(relativeDir, entry.name);

    if (entry.isDirectory) {
      if (options.ignore.has(entry.name)) {
        continue;
      }
      yield { absolute: childAbsolute, relative: childRelative, isDirectory: true };
      yield* walk(ctx, childAbsolute, childRelative, depth + 1, options, stats);
    } else {
      yield { absolute: childAbsolute, relative: childRelative, isDirectory: false };
    }
  }
}

function basename(relative: string): string {
  const parts = relative.split('/');
  return parts[parts.length - 1] ?? relative;
}

export interface SearchToolConfig {
  readonly ignore?: readonly string[];
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly maxFileBytes?: number;
  readonly maxScanBytes?: number;
  readonly maxInlineTokens?: number;
}

interface ResolvedSearchConfig {
  readonly ignore: ReadonlySet<string>;
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxScanBytes: number;
  readonly maxInlineTokens: number;
}

function resolveConfig(config: SearchToolConfig): ResolvedSearchConfig {
  return {
    ignore: new Set(config.ignore ?? DEFAULT_IGNORED_DIRS),
    maxDepth: config.maxDepth ?? 12,
    maxEntries: config.maxEntries ?? 5_000,
    maxFileBytes: config.maxFileBytes ?? 1_048_576,
    maxScanBytes: config.maxScanBytes ?? 8_388_608,
    maxInlineTokens: config.maxInlineTokens ?? 1_600,
  };
}

const globSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Glob pattern, e.g. "**/*.ts" or "*.md" (a pattern without "/" matches at any depth).'),
  path: z.string().optional().describe('Directory to search, relative to the workspace.'),
  max_results: z.number().int().min(1).max(2_000).optional().describe('Result cap (default 200).'),
});

export function createGlobTool(config: SearchToolConfig = {}): ToolDef<z.infer<typeof globSchema>> {
  const settings = resolveConfig(config);

  return {
    name: 'fs_glob',
    description: 'Find files by glob pattern inside the workspace.',
    schema: globSchema,
    parallelSafe: true,
    requiresApproval: 'never',
    timeoutMs: 30_000,
    maxInlineTokens: settings.maxInlineTokens,
    run: async (args, ctx) => {
      const root = resolveToolPath(ctx.workdir, args.path ?? '.');
      const maxResults = args.max_results ?? 200;
      const matchFullPath = args.pattern.includes('/');
      const matcher = globToRegExp(args.pattern);
      const results: string[] = [];
      const stats: WalkStats = { entries: 0, truncated: false };

      for await (const entry of walk(ctx, root.absolute, root.relative, 0, {
        ignore: settings.ignore,
        maxDepth: settings.maxDepth,
        maxEntries: settings.maxEntries,
        signal: ctx.signal,
      }, stats)) {
        if (entry.isDirectory) {
          continue;
        }
        const candidate = matchFullPath ? entry.relative : basename(entry.relative);
        if (matcher.test(candidate)) {
          results.push(entry.relative);
          if (results.length >= maxResults) {
            break;
          }
        }
      }

      if (ctx.signal.aborted) {
        return fail(ToolErrorCode.Cancelled, 'The search was cancelled.');
      }
      if (results.length === 0) {
        return {
          ok: true,
          output: `No files match ${JSON.stringify(args.pattern)} under ${root.relative}.`,
          meta: { scanned: stats.entries, truncated: stats.truncated },
        };
      }

      const stopped = results.length >= maxResults || stats.truncated;
      return {
        ok: true,
        output: `${results.join('\n')}\n\n(${String(results.length)} file(s)${stopped ? '; listing stopped early — narrow the pattern' : ''})`,
        meta: { scanned: stats.entries, truncated: stats.truncated },
      };
    },
  };
}

const grepSchema = z.object({
  pattern: z.string().min(1).describe('Regular expression to search for.'),
  path: z.string().optional().describe('Directory to search, relative to the workspace.'),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts".'),
  case_sensitive: z.boolean().optional().describe('Case-sensitive match (default false).'),
  max_matches: z.number().int().min(1).max(1_000).optional().describe('Match cap (default 100).'),
});

export function createGrepTool(config: SearchToolConfig = {}): ToolDef<z.infer<typeof grepSchema>> {
  const settings = resolveConfig(config);

  return {
    name: 'fs_grep',
    description: 'Search file contents with a regular expression and return path:line:text.',
    schema: grepSchema,
    parallelSafe: true,
    requiresApproval: 'never',
    timeoutMs: 30_000,
    maxInlineTokens: settings.maxInlineTokens,
    run: async (args, ctx) => {
      let matcher: RegExp;
      try {
        matcher = new RegExp(args.pattern, args.case_sensitive === true ? '' : 'i');
      } catch (error) {
        return fail(ToolErrorCode.BadArgs, `Invalid regular expression: ${message(error)}`);
      }

      const root = resolveToolPath(ctx.workdir, args.path ?? '.');
      const maxMatches = args.max_matches ?? 100;
      const includeFullPath = args.glob?.includes('/') ?? false;
      const includeMatcher = args.glob === undefined ? undefined : globToRegExp(args.glob);

      const matches: string[] = [];
      const stats: WalkStats = { entries: 0, truncated: false };
      let scannedFiles = 0;
      let scannedBytes = 0;
      let skippedLarge = 0;
      let skippedBinary = 0;
      let stop = false;

      for await (const entry of walk(ctx, root.absolute, root.relative, 0, {
        ignore: settings.ignore,
        maxDepth: settings.maxDepth,
        maxEntries: settings.maxEntries,
        signal: ctx.signal,
      }, stats)) {
        if (entry.isDirectory) {
          continue;
        }
        if (
          includeMatcher !== undefined &&
          !includeMatcher.test(includeFullPath ? entry.relative : basename(entry.relative))
        ) {
          continue;
        }

        let content: string;
        try {
          content = await ctx.fs.read(entry.absolute);
        } catch {
          continue;
        }
        if (content.length > settings.maxFileBytes) {
          skippedLarge += 1;
          continue;
        }
        if (content.includes('\0')) {
          skippedBinary += 1;
          continue;
        }

        scannedFiles += 1;
        scannedBytes += content.length;

        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? '';
          if (!matcher.test(line)) {
            continue;
          }
          const shown = line.length > 400 ? `${line.slice(0, 400)}…` : line;
          matches.push(`${entry.relative}:${String(index + 1)}: ${shown}`);
          if (matches.length >= maxMatches) {
            stop = true;
            break;
          }
        }

        if (stop || scannedBytes >= settings.maxScanBytes) {
          stats.truncated = true;
          break;
        }
      }

      if (ctx.signal.aborted) {
        return fail(ToolErrorCode.Cancelled, 'The search was cancelled.');
      }

      const notes: string[] = [`${String(matches.length)} match(es) in ${String(scannedFiles)} file(s)`];
      if (skippedLarge > 0) {
        notes.push(`${String(skippedLarge)} file(s) skipped as too large`);
      }
      if (skippedBinary > 0) {
        notes.push(`${String(skippedBinary)} binary file(s) skipped`);
      }
      if (stop || stats.truncated) {
        notes.push('stopped early — narrow path/glob or raise max_matches');
      }

      if (matches.length === 0) {
        return {
          ok: true,
          output: `No matches for ${JSON.stringify(args.pattern)} under ${root.relative}. (${notes.join('; ')})`,
          meta: { scannedFiles, scannedBytes },
        };
      }

      return {
        ok: true,
        output: `${matches.join('\n')}\n\n(${notes.join('; ')})`,
        meta: { scannedFiles, scannedBytes },
      };
    },
  };
}
