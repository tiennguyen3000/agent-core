import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLocalFs, createSandboxedFs } from '../src/index.js';
import type { SandboxMode } from '../src/index.js';
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => removeTmpDir(dir)));
});

async function tmp(): Promise<string> {
  const dir = await makeTmpDir();
  dirs.push(dir);
  return dir;
}

function sandbox(root: string, mode: SandboxMode, tempGrants: readonly string[] = []) {
  return createSandboxedFs({ mode, workspaceRoot: root, tempGrants, inner: createLocalFs() });
}

describe('local filesystem backend', () => {
  it('writes atomically and reads the content back', async () => {
    const root = await tmp();
    const fs = createLocalFs();
    const target = join(root, 'nested', 'file.txt');

    await fs.write(target, 'hello');
    await fs.write(target, 'replaced');

    expect(await fs.read(target)).toBe('replaced');
    expect(await fs.exists(target)).toBe(true);
    expect(await fs.list(join(root, 'nested'))).toEqual([
      { name: 'file.txt', isDirectory: false },
    ]);
  });

  it('reports a missing path as absent and lists directories', async () => {
    const root = await tmp();
    const fs = createLocalFs();
    await fs.write(join(root, 'a.txt'), 'a');
    await fs.write(join(root, 'sub', 'b.txt'), 'b');

    expect(await fs.exists(join(root, 'nope.txt'))).toBe(false);
    expect(await fs.list(root)).toEqual([
      { name: 'a.txt', isDirectory: false },
      { name: 'sub', isDirectory: true },
    ]);
  });
});

describe('sandboxed filesystem port', () => {
  it('allows a write inside the workspace', async () => {
    const root = await tmp();
    const fs = sandbox(root, 'workspace-write');

    await fs.write(join(root, 'notes.md'), 'inside');

    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('inside');
  });

  it('refuses a write outside the workspace with E_POLICY_DENIED', async () => {
    const root = await tmp();
    const outside = await tmp();
    const fs = sandbox(root, 'workspace-write');

    await expect(fs.write(join(outside, 'escape.txt'), 'x')).rejects.toMatchObject({
      code: 'E_POLICY_DENIED',
    });
    await expect(fs.write('/etc/dsh-should-not-exist', 'x')).rejects.toMatchObject({
      code: 'E_POLICY_DENIED',
    });
  });

  it('refuses every write in read-only mode but still reads', async () => {
    const root = await tmp();
    const fs = sandbox(root, 'read-only');
    await createLocalFs().write(join(root, 'existing.txt'), 'data');

    await expect(fs.write(join(root, 'new.txt'), 'x')).rejects.toThrow(/read-only/);
    expect(await fs.read(join(root, 'existing.txt'))).toBe('data');
  });

  it('allows a write inside a temp grant', async () => {
    const root = await tmp();
    const grant = await tmp();
    const fs = sandbox(root, 'workspace-write', [grant]);

    await fs.write(join(grant, 'session.tmp'), 'granted');

    expect(await readFile(join(grant, 'session.tmp'), 'utf8')).toBe('granted');
  });

  it('allows writes anywhere in full-access mode', async () => {
    const root = await tmp();
    const outside = await tmp();
    const fs = sandbox(root, 'full-access');

    await fs.write(join(outside, 'anywhere.txt'), 'free');

    expect(await readFile(join(outside, 'anywhere.txt'), 'utf8')).toBe('free');
  });

  it('surfaces a raw errno from the backend through the tool layer', async () => {
    const root = await tmp();
    const fs = sandbox(root, 'workspace-write');

    await expect(fs.read(join(root, 'missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
