import { describe, expect, it } from 'vitest';
import {
  ToolErrorCode,
  ToolRegistry,
  createGlobTool,
  createGrepTool,
  globToRegExp,
} from '../src/index.js';
import { makeCtx, memoryFs } from './helpers/ctx.js';

const tree = {
  'README.md': '# title\nTODO: fix this\n',
  'src/app.ts': 'const x = 1;\n// TODO: refactor\nconst y = 2;\n',
  'src/lib/util.ts': 'export const todo = 1;\n',
  'docs/guide.md': 'guide TODO text\n',
  'node_modules/pkg/index.js': '// TODO: vendored\n',
  '.git/config': 'TODO\n',
  'assets/blob.bin': 'binary\0data TODO\n',
};

function setup(files: Record<string, string> = tree) {
  const fs = memoryFs({ root: '/ws', files, dirs: ['empty'] });
  const registry = new ToolRegistry();
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  return { fs, registry, ctx: makeCtx({ workdir: '/ws', fs }) };
}

describe('globToRegExp', () => {
  it('lets ** span directories and keeps * inside one segment', () => {
    expect(globToRegExp('**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/lib/a.ts')).toBe(false);
    expect(globToRegExp('*.md').test('a.md')).toBe(true);
    expect(globToRegExp('*.md').test('a.txt')).toBe(false);
  });

  it('expands alternations and escapes regex characters', () => {
    expect(globToRegExp('{a,b}.md').test('a.md')).toBe(true);
    expect(globToRegExp('{a,b}.md').test('b.md')).toBe(true);
    expect(globToRegExp('{a,b}.md').test('c.md')).toBe(false);
    expect(globToRegExp('file.min.js').test('fileXminYjs')).toBe(false);
  });
});

describe('fs_glob', () => {
  it('finds files recursively and skips ignored directories', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('fs_glob', { pattern: '**/*.ts' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output.split('\n').slice(0, 2)).toEqual(['src/app.ts', 'src/lib/util.ts']);
    expect(result.output).not.toContain('node_modules');
  });

  it('matches a bare pattern against basenames at any depth', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('fs_glob', { pattern: '*.md' }, ctx);

    expect(result.output).toContain('README.md');
    expect(result.output).toContain('docs/guide.md');
  });

  it('respects a directory-scoped pattern', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('fs_glob', { pattern: 'src/*.ts' }, ctx);

    expect(result.output).toContain('src/app.ts');
    expect(result.output).not.toContain('src/lib/util.ts');
  });

  it('honours max_results and says it stopped early', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('fs_glob', { pattern: '**/*', max_results: 1 }, ctx);

    expect(result.output).toContain('stopped early');
    expect(result.meta?.truncated).toBeDefined();
  });

  it('reports honestly when nothing matches', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('fs_glob', { pattern: '**/*.rs' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('No files match');
  });

  it('returns E_CANCELLED when the signal aborts during the walk', async () => {
    const controller = new AbortController();
    const base = memoryFs({ root: '/ws', files: tree });
    const fs = {
      ...base,
      list: async (dir: string) => {
        const entries = await base.list(dir);
        controller.abort();
        return entries;
      },
    };
    const registry = new ToolRegistry();
    registry.register(createGlobTool());
    const ctx = makeCtx({ workdir: '/ws', fs, signal: controller.signal });

    const result = await registry.dispatch('fs_glob', { pattern: '**/*' }, ctx);

    expect(result.code).toBe(ToolErrorCode.Cancelled);
  });
});

describe('fs_grep', () => {
  it('finds matches case-insensitively and skips ignored directories', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('fs_grep', { pattern: 'TODO' }, ctx);

    expect(result.output).toContain('README.md:2:');
    expect(result.output).toContain('src/app.ts:2:');
    expect(result.output).toContain('docs/guide.md:1:');
    expect(result.output).not.toContain('node_modules');
    expect(result.output).not.toContain('.git/config');
  });

  it('honours case_sensitive', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('fs_grep', { pattern: 'todo', case_sensitive: true }, ctx);

    expect(result.output).toContain('src/lib/util.ts:1:');
    expect(result.output).not.toContain('README.md');
  });

  it('restricts the search with a glob filter', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('fs_grep', { pattern: 'TODO', glob: '*.md' }, ctx);

    expect(result.output).toContain('README.md');
    expect(result.output).toContain('docs/guide.md');
    expect(result.output).not.toContain('src/app.ts');
  });

  it('skips binary files and reports how many', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('fs_grep', { pattern: 'binary' }, ctx);

    expect(result.output).toContain('No matches');
    expect(result.output).toContain('1 binary file(s) skipped');
  });

  it('stops at max_matches and says so', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('fs_grep', { pattern: 'TODO', max_matches: 1 }, ctx);

    expect(result.output).toContain('stopped early');
  });

  it('rejects an invalid regular expression with E_BAD_ARGS', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('fs_grep', { pattern: '([' }, ctx);

    expect(result.code).toBe(ToolErrorCode.BadArgs);
    expect(result.output).toContain('Invalid regular expression');
  });

  it('truncates a very long matching line', async () => {
    const long = 'z'.repeat(500);
    const { registry, ctx } = setup({ 'big.txt': `${long} NEEDLE\n` });

    const result = await registry.dispatch('fs_grep', { pattern: 'NEEDLE' }, ctx);

    expect(result.output).toContain('…');
    expect(result.output).toContain('big.txt:1:');
  });
});
