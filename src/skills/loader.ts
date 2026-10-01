/**
 * Skill discovery with progressive disclosure.
 *
 * Scanning is cheap and produces a catalog of names and descriptions; the full
 * instructions are read only when the agent asks for one skill by name. That is
 * the point: a repository can hold dozens of skills and the prompt only carries
 * one line each.
 *
 * A skill is either a directory bundle (`<dir>/SKILL.md`) or a flat `<name>.md`
 * file at a scanned root, with optional `name`/`description` frontmatter.
 * Earlier sources win, so a project skill overrides a user skill of the same
 * name.
 */

import type { SandboxedFs } from '../tools/registry.js';

export type SkillScope = 'project' | 'user' | 'custom';

export interface SkillSource {
  readonly root: string;
  readonly scope: SkillScope;
}

export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly scope: SkillScope;
  /** True for `<dir>/SKILL.md`, false for a flat `<name>.md`. */
  readonly bundle: boolean;
}

export interface SkillLoadResult {
  readonly ok: boolean;
  readonly entry: SkillEntry | undefined;
  readonly text: string;
  readonly code: string | undefined;
}

export interface SkillLoaderOptions {
  readonly sources: readonly SkillSource[];
  readonly fs: SandboxedFs;
  readonly maxSkills?: number;
  readonly maxDescriptionChars?: number;
  readonly maxPromptChars?: number;
  readonly maxBodyChars?: number;
  readonly maxDepth?: number;
  readonly ignoredDirectories?: readonly string[];
}

export interface SkillLoader {
  /** Rescans every source and replaces the catalog. */
  refresh(): Promise<readonly SkillEntry[]>;
  /** The catalog from the last scan. */
  catalog(): readonly SkillEntry[];
  /** One bounded line per skill, for the system prompt. */
  promptSection(): string;
  /** Reads the full instructions on demand. */
  load(name: string): Promise<SkillLoadResult>;
}

export interface ParsedSkillFile {
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly body: string;
}

const DEFAULT_IGNORED = [
  '.git',
  '.cache',
  'node_modules',
  'dist',
  'coverage',
  '.tmp',
  '.pnpm-store',
];

/** Minimal frontmatter parser: `---` fenced `key: value` scalars. */
export function parseSkillMarkdown(text: string): ParsedSkillFile {
  const normalised = text.replace(/\r\n/g, '\n');
  if (!normalised.startsWith('---\n')) {
    return { name: undefined, description: undefined, body: normalised.trim() };
  }
  const end = normalised.indexOf('\n---', 3);
  if (end === -1) {
    return { name: undefined, description: undefined, body: normalised.trim() };
  }
  const header = normalised.slice(4, end);
  const body = normalised.slice(end + 4).replace(/^\n/, '');

  let name: string | undefined;
  let description: string | undefined;
  for (const line of header.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const raw = line.slice(separator + 1).trim();
    const value = raw.replace(/^["']|["']$/g, '');
    if (value.length === 0) {
      continue;
    }
    if (key === 'name') {
      name = value;
    } else if (key === 'description') {
      description = value;
    }
  }
  return { name, description, body: body.trim() };
}

function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((candidate) => candidate.replace(/^#+\s*/, '').trim())
    .find((candidate) => candidate.length > 0);
  return line ?? '';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function createSkillLoader(options: SkillLoaderOptions): SkillLoader {
  const maxSkills = options.maxSkills ?? 64;
  const maxDescriptionChars = options.maxDescriptionChars ?? 200;
  const maxPromptChars = options.maxPromptChars ?? 4_000;
  const maxBodyChars = options.maxBodyChars ?? 20_000;
  const maxDepth = options.maxDepth ?? 2;
  const ignored = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED);

  let entries: SkillEntry[] = [];
  let scanned = false;

  const readSkill = async (
    path: string,
    scope: SkillScope,
    bundle: boolean,
    fallbackName: string,
  ): Promise<SkillEntry | undefined> => {
    let text: string;
    try {
      text = await options.fs.read(path);
    } catch {
      return undefined;
    }
    const parsed = parseSkillMarkdown(text);
    const name = parsed.name ?? fallbackName;
    const description = truncate(parsed.description ?? firstLine(parsed.body), maxDescriptionChars);
    return { name, description, path, scope, bundle };
  };

  const scanDirectory = async (
    root: string,
    source: SkillSource,
    depth: number,
    found: SkillEntry[],
  ): Promise<void> => {
    let children: Awaited<ReturnType<SandboxedFs['list']>>;
    try {
      children = await options.fs.list(root);
    } catch {
      return;
    }

    for (const child of children) {
      if (found.length >= maxSkills) {
        return;
      }
      if (ignored.has(child.name)) {
        continue;
      }
      const path = `${root}/${child.name}`;

      if (!child.isDirectory) {
        if (!child.name.endsWith('.md') || child.name === 'SKILL.md') {
          continue;
        }
        const entry = await readSkill(path, source.scope, false, child.name.replace(/\.md$/, ''));
        if (entry !== undefined) {
          found.push(entry);
        }
        continue;
      }

      const bundlePath = `${path}/SKILL.md`;
      if (await options.fs.exists(bundlePath)) {
        const entry = await readSkill(bundlePath, source.scope, true, child.name);
        if (entry !== undefined) {
          found.push(entry);
        }
        continue;
      }
      if (depth + 1 < maxDepth) {
        await scanDirectory(path, source, depth + 1, found);
      }
    }
  };

  const byName = new Map<string, SkillEntry>();

  return {
    async refresh() {
      const found: SkillEntry[] = [];
      for (const source of options.sources) {
        await scanDirectory(source.root, source, 0, found);
      }
      byName.clear();
      for (const entry of found) {
        // First source wins: project skills shadow user skills.
        if (!byName.has(entry.name)) {
          byName.set(entry.name, entry);
        }
      }
      entries = [...byName.values()];
      scanned = true;
      return entries;
    },

    catalog() {
      return entries;
    },

    promptSection() {
      if (entries.length === 0) {
        return '';
      }
      const header = '## Skills\nLoad one with the `skill` tool when its description matches the task.\n';
      const lines: string[] = [];
      let used = header.length;
      for (const entry of entries) {
        const line = `- ${entry.name}: ${entry.description}`;
        if (used + line.length + 1 > maxPromptChars) {
          lines.push(`- (${String(entries.length - lines.length)} more skills not shown)`);
          break;
        }
        lines.push(line);
        used += line.length + 1;
      }
      return `${header}${lines.join('\n')}`;
    },

    async load(name) {
      if (!scanned) {
        await this.refresh();
      }
      const entry =
        byName.get(name) ??
        [...byName.values()].find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());

      if (entry === undefined) {
        const available = [...byName.keys()].join(', ') || '(none)';
        return {
          ok: false,
          entry: undefined,
          text: `Unknown skill ${JSON.stringify(name)}. Available: ${available}`,
          code: 'E_NOT_FOUND',
        };
      }

      let raw: string;
      try {
        raw = await options.fs.read(entry.path);
      } catch (error) {
        return {
          ok: false,
          entry,
          text: `Could not read ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
          code: 'E_TOOL_FAILED',
        };
      }

      const body = parseSkillMarkdown(raw).body;
      const text =
        body.length <= maxBodyChars
          ? body
          : `${body.slice(0, maxBodyChars)}\n...(truncated; full skill at ${entry.path})`;
      return { ok: true, entry, text, code: undefined };
    },
  };
}
