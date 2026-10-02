import { describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Packaging contract: the wiring a global install depends on. These checks do
 * not need a build, so `pnpm test` stays fast; `pnpm verify:pack` builds and
 * runs the compiled artifact for real.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
  bin?: Record<string, string>;
  files?: string[];
  main?: string;
  types?: string;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
};

describe('packaging wiring', () => {
  it('exposes a bin that exists, is executable and starts with a shebang', async () => {
    const binPath = pkg.bin?.['agent-core'];
    expect(binPath).toBe('bin/agent-core.mjs');

    const absolute = join(root, binPath ?? '');
    const info = await stat(absolute);
    expect(info.isFile()).toBe(true);
    if (process.platform !== 'win32') {
      // Windows has no exec bit; npm writes a `tiennk.cmd` shim from the bin
      // field instead, which is what makes the command runnable there.
      expect(info.mode & 0o111).toBeGreaterThan(0);
    }

    const contents = await readFile(absolute, 'utf8');
    expect(contents.startsWith('#!/usr/bin/env node')).toBe(true);
    // A global run must not depend on the TypeScript sources being present.
    expect(contents).toContain('../dist/cli/main.js');
  });

  it('ships exactly the runtime pieces', () => {
    expect(pkg.files).toEqual(['bin', 'dist', 'README.md']);
  });

  it('points the entry points into dist', () => {
    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.types).toBe('dist/index.d.ts');
    expect(pkg.exports?.['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
    });
  });

  it('has a build script and a build config that emits declarations', async () => {
    expect(pkg.scripts?.build).toBe('tsc -p tsconfig.build.json');

    const buildConfig = JSON.parse(
      await readFile(join(root, 'tsconfig.build.json'), 'utf8'),
    ) as { compilerOptions?: Record<string, unknown>; include?: string[] };

    expect(buildConfig.compilerOptions).toMatchObject({
      noEmit: false,
      rootDir: 'src',
      outDir: 'dist',
      declaration: true,
    });
    expect(buildConfig.include).toEqual(['src/**/*.ts']);
  });
});
