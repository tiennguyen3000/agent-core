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
  /** The source root this skill was found under. */
  readonly root: string;
  /** First directory under the root, so a big catalog can be summarised. */
  readonly category: string;
}

/** Per-source tally, so a caller can report where skills came from. */
export interface SkillSourceSummary {
  readonly root: string;
  readonly scope: SkillScope;
  readonly count: number;
  /** True when the root could not be listed at all. */
  readonly missing: boolean;
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
  /** Where the skills came from and how many each root contributed. */
  sourceSummaries(): readonly SkillSourceSummary[];
  /** Keyword search over names, descriptions and categories. */
  search(query: string, limit?: number): readonly SkillEntry[];
  /** One bounded block for the system prompt (grouped when it would not fit). */
  promptSection(): string;
  /** Reads the full instructions on demand. */
  load(name: string): Promise<SkillLoadResult>;
}

export interface ParsedSkillFile {
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly body: string;
}

/**
 * Category-level documents that live next to skill directories. Treating them
 * as skills would put entries like `DESCRIPTION` in the catalog (Hermes keeps
 * `DESCRIPTION.md` per category), so they are skipped by name.
 */
const NON_SKILL_FILES = new Set([
  'readme.md',
  'description.md',
  'index.md',
  'changelog.md',
  'license.md',
  'contributing.md',
]);

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
  // A user who points this at an existing agent's skill directory may well have
  // hundreds of them, so the caps are generous and the prompt section adapts.
  const maxSkills = options.maxSkills ?? 256;
  const maxDescriptionChars = options.maxDescriptionChars ?? 200;
  const maxPromptChars = options.maxPromptChars ?? 4_000;
  const maxBodyChars = options.maxBodyChars ?? 20_000;
  const maxDepth = options.maxDepth ?? 4;
  const ignored = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED);

  let entries: SkillEntry[] = [];
  let scanned = false;

  const readSkill = async (
    path: string,
    source: SkillSource,
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
    const relative = path.startsWith(`${source.root}/`)
      ? path.slice(source.root.length + 1)
      : path;
    const [first] = relative.split('/');
    return {
      name,
      description,
      path,
      scope: source.scope,
      bundle,
      root: source.root,
      category: first === undefined || first.endsWith('.md') ? '.' : first,
    };
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
        const lowered = child.name.toLowerCase();
        if (
          !lowered.endsWith('.md') ||
          lowered === 'skill.md' ||
          NON_SKILL_FILES.has(lowered)
        ) {
          continue;
        }
        const entry = await readSkill(path, source, false, child.name.replace(/\.md$/, ''));
        if (entry !== undefined) {
          found.push(entry);
        }
        continue;
      }

      const bundlePath = `${path}/SKILL.md`;
      if (await options.fs.exists(bundlePath)) {
        const entry = await readSkill(bundlePath, source, true, child.name);
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
  let summaries: SkillSourceSummary[] = [];

  /** Groups the catalog by category, preserving discovery order. */
  const byCategory = (): Map<string, SkillEntry[]> => {
    const groups = new Map<string, SkillEntry[]>();
    for (const entry of entries) {
      const list = groups.get(entry.category);
      if (list === undefined) {
        groups.set(entry.category, [entry]);
      } else {
        list.push(entry);
      }
    }
    return groups;
  };

  return {
    async refresh() {
      const found: SkillEntry[] = [];
      const tally: SkillSourceSummary[] = [];
      for (const source of options.sources) {
        const before = found.length;
        await scanDirectory(source.root, source, 0, found);
        let missing = false;
        try {
          await options.fs.list(source.root);
        } catch {
          missing = true;
        }
        tally.push({
          root: source.root,
          scope: source.scope,
          count: found.length - before,
          missing,
        });
      }
      byName.clear();
      for (const entry of found) {
        // First source wins: project skills shadow user skills.
        if (!byName.has(entry.name)) {
          byName.set(entry.name, entry);
        }
      }
      entries = [...byName.values()];
      // Report the tally that survives shadowing, which is what the model sees.
      summaries = tally.map((summary) => ({
        ...summary,
        count: entries.filter((entry) => entry.root === summary.root).length,
      }));
      scanned = true;
      return entries;
    },

    catalog() {
      return entries;
    },

    sourceSummaries() {
      return summaries;
    },

    search(query, limit = 20) {
      const terms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 0);
      if (terms.length === 0) {
        return entries.slice(0, limit);
      }
      const matches: { entry: SkillEntry; nameHits: number }[] = [];
      for (const entry of entries) {
        const haystack = `${entry.name} ${entry.description} ${entry.category}`.toLowerCase();
        if (!terms.every((term) => haystack.includes(term))) {
          continue;
        }
        const lowered = entry.name.toLowerCase();
        matches.push({
          entry,
          nameHits: terms.filter((term) => lowered.includes(term)).length,
        });
      }
      matches.sort(
        (a, b) => b.nameHits - a.nameHits || a.entry.name.localeCompare(b.entry.name),
      );
      return matches.slice(0, limit).map((match) => match.entry);
    },

    promptSection() {
      if (entries.length === 0) {
        return '';
      }
      const header =
        '## Skills\nLoad one with the `skill` tool, using its exact name. Some may not be listed; use `skill_search` to find one.\n';
      const flat = entries.map((entry) => `- ${entry.name}: ${entry.description}`).join('\n');
      if (header.length + flat.length <= maxPromptChars) {
        return `${header}${flat}`;
      }

      // Too many to list: summarise by category so the model still knows the
      // shape of what exists, and can search for an exact name.
      const groups = byCategory();
      const note = `- ${String(entries.length)} skills in ${String(groups.size)} ${
        groups.size === 1 ? 'category' : 'categories'
      }; use \`skill_search\` for keywords.`;
      const parts: string[] = [];
      let used = header.length + note.length + 1;
      let shownCategories = 0;
      for (const [category, list] of groups) {
        const prefix = `- ${category} (${String(list.length)}): `;
        const names: string[] = [];
        let lineLength = prefix.length;
        for (const entry of list) {
          const piece = `${names.length === 0 ? '' : ', '}${entry.name}`;
          // Keep room for the trailing note when the budget finally runs out.
          if (used + lineLength + piece.length > maxPromptChars - 120) {
            break;
          }
          lineLength += piece.length;
          names.push(entry.name);
        }
        if (names.length === 0) {
          break;
        }
        const suffix = names.length < list.length ? ' …' : '';
        parts.push(`${prefix}${names.join(', ')}${suffix}`);
        used += lineLength + suffix.length + 1;
        shownCategories += 1;
      }
      if (shownCategories < groups.size) {
        parts.push(
          `- (${String(groups.size - shownCategories)} more categories not shown; use \`skill_search\`)`,
        );
      }
      return `${header}${[note, ...parts].join('\n')}`;
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
