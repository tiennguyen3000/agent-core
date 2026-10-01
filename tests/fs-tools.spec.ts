import { describe, expect, it } from 'vitest';
import {
  ReadTracker,
  ToolErrorCode,
  ToolRegistry,
  createFsEditTool,
  createFsReadTool,
  createFsWriteTool,
} from '../src/index.js';
import { RecordingGate, makeCtx, memoryFs } from './helpers/ctx.js';

const initialFiles = {
  'a.txt': 'hello\nworld\n',
  'src/app.ts': 'const x = 1;\n',
};

function setup(options: { reads?: ReadTracker; files?: Record<string, string> } = {}) {
  const fs = memoryFs({ root: '/ws', files: options.files ?? initialFiles, dirs: ['empty'] });
  const gate = new RecordingGate();
  const registry = new ToolRegistry({ gate });
  registry.register(createFsReadTool());
  registry.register(createFsWriteTool());
  registry.register(createFsEditTool());
  const ctx = makeCtx({
    workdir: '/ws',
    fs,
    ...(options.reads === undefined ? {} : { reads: options.reads }),
  });
  return { fs, gate, registry, ctx };
}

describe('fs_read', () => {
  it('returns numbered lines and the total line count', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('fs_read', { path: 'a.txt' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toBe('1\thello\n2\tworld\n3\t');
    expect(result.meta?.totalLines).toBe(3);
  });

  it('honours offset and limit and says what it showed', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('fs_read', { path: 'a.txt', offset: 2, limit: 1 }, ctx);

    expect(result.output).toContain('2\tworld');
    expect(result.output).toContain('(lines 2-2 of 3)');
  });

  it('records a missing path so the agent may then create it', async () => {
    const reads = new ReadTracker();
    const { registry, ctx } = setup({ reads });

    const missing = await registry.dispatch('fs_read', { path: 'notes.md' }, ctx);
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe(ToolErrorCode.NotFound);
    expect(missing.output).toContain('fs_write');

    const created = await registry.dispatch('fs_write', { path: 'notes.md', content: 'hi' }, ctx);
    expect(created.ok).toBe(true);
    expect(created.output).toContain('Created notes.md');
  });

  it('tells the model to use fs_glob when the path is a directory', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('fs_read', { path: 'src' }, ctx);

    expect(result.code).toBe(ToolErrorCode.IsDirectory);
    expect(result.output).toContain('fs_glob');
  });
});

describe('observation policy (read before write)', () => {
  it('refuses a write to a file that was never read', async () => {
    const reads = new ReadTracker();
    const { registry, ctx, fs } = setup({ reads });

    const result = await registry.dispatch('fs_write', { path: 'a.txt', content: 'nope' }, ctx);

    expect(result.code).toBe(ToolErrorCode.NoRead);
    expect(result.output).toContain('fs_read');
    expect(fs.files.get('/ws/a.txt')).toBe('hello\nworld\n');
  });

  it('allows the write after a read', async () => {
    const reads = new ReadTracker();
    const { registry, ctx, fs } = setup({ reads });

    await registry.dispatch('fs_read', { path: 'a.txt' }, ctx);
    const result = await registry.dispatch('fs_write', { path: 'a.txt', content: 'replaced' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('Replaced a.txt');
    expect(fs.files.get('/ws/a.txt')).toBe('replaced');
  });

  it('refuses a write when the file changed since it was read', async () => {
    const reads = new ReadTracker();
    const { registry, ctx, fs } = setup({ reads });

    await registry.dispatch('fs_read', { path: 'a.txt' }, ctx);
    // The external change keeps the needle so the retry can succeed; the point
    // of the first attempt is the stale-read refusal, not the missing needle.
    fs.files.set('/ws/a.txt', 'hello\nworld again\n');

    const stale = await registry.dispatch('fs_edit', {
      path: 'a.txt',
      old_string: 'world',
      new_string: 'there',
    }, ctx);
    expect(stale.code).toBe(ToolErrorCode.StaleRead);

    await registry.dispatch('fs_read', { path: 'a.txt' }, ctx);
    const retried = await registry.dispatch('fs_edit', {
      path: 'a.txt',
      old_string: 'world',
      new_string: 'there',
    }, ctx);
    expect(retried.ok).toBe(true);
    expect(fs.files.get('/ws/a.txt')).toBe('hello\nthere again\n');
  });

  it('writes unconditionally when no tracker is mounted', async () => {
    const { registry, ctx, fs } = setup();

    const result = await registry.dispatch('fs_write', { path: 'a.txt', content: 'free' }, ctx);

    expect(result.ok).toBe(true);
    expect(fs.files.get('/ws/a.txt')).toBe('free');
  });
});

describe('fs_write and fs_edit guards', () => {
  it('refuses to write outside the workspace', async () => {
    const { registry, ctx, fs } = setup();

    const relative = await registry.dispatch('fs_write', { path: '../evil.txt', content: 'x' }, ctx);
    const absolute = await registry.dispatch('fs_write', { path: '/etc/passwd', content: 'x' }, ctx);

    expect(relative.code).toBe(ToolErrorCode.PathEscape);
    expect(absolute.code).toBe(ToolErrorCode.PathEscape);
    expect(fs.files.has('/evil.txt')).toBe(false);
  });

  it('edits a unique substring and reports the replacement', async () => {
    const reads = new ReadTracker();
    const { registry, ctx, fs } = setup({ reads });

    await registry.dispatch('fs_read', { path: 'a.txt' }, ctx);
    const result = await registry.dispatch('fs_edit', {
      path: 'a.txt',
      old_string: 'world',
      new_string: 'there',
    }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('1 replacement');
    expect(fs.files.get('/ws/a.txt')).toBe('hello\nthere\n');
  });

  it('refuses an ambiguous edit unless replace_all is set', async () => {
    const reads = new ReadTracker();
    const { registry, ctx, fs } = setup({
      reads,
      files: { 'dup.txt': 'x\nx\nx\n' },
    });

    await registry.dispatch('fs_read', { path: 'dup.txt' }, ctx);
    const ambiguous = await registry.dispatch('fs_edit', {
      path: 'dup.txt',
      old_string: 'x',
      new_string: 'y',
    }, ctx);
    expect(ambiguous.code).toBe(ToolErrorCode.AmbiguousMatch);
    expect(ambiguous.output).toContain('3 times');

    const all = await registry.dispatch('fs_edit', {
      path: 'dup.txt',
      old_string: 'x',
      new_string: 'y',
      replace_all: true,
    }, ctx);
    expect(all.ok).toBe(true);
    expect(all.output).toContain('3 replacements');
    expect(fs.files.get('/ws/dup.txt')).toBe('y\ny\ny\n');
  });

  it('reports a missing needle without touching the file', async () => {
    const reads = new ReadTracker();
    const { registry, ctx, fs } = setup({ reads });

    await registry.dispatch('fs_read', { path: 'a.txt' }, ctx);
    const result = await registry.dispatch('fs_edit', {
      path: 'a.txt',
      old_string: 'absent',
      new_string: 'x',
    }, ctx);

    expect(result.code).toBe(ToolErrorCode.NoMatch);
    expect(fs.files.get('/ws/a.txt')).toBe('hello\nworld\n');
  });

  it('lets a second edit follow the first without re-reading', async () => {
    const reads = new ReadTracker();
    const { registry, ctx, fs } = setup({ reads });

    await registry.dispatch('fs_read', { path: 'a.txt' }, ctx);
    await registry.dispatch('fs_edit', { path: 'a.txt', old_string: 'hello', new_string: 'hi' }, ctx);
    const second = await registry.dispatch('fs_edit', {
      path: 'a.txt',
      old_string: 'world',
      new_string: 'there',
    }, ctx);

    expect(second.ok).toBe(true);
    expect(fs.files.get('/ws/a.txt')).toBe('hi\nthere\n');
  });
});

describe('fs tool metadata', () => {
  it('marks reads parallel-safe and mutations policy-gated', () => {
    const read = createFsReadTool();
    const write = createFsWriteTool();
    const edit = createFsEditTool();

    expect([read.parallelSafe, write.parallelSafe, edit.parallelSafe]).toEqual([true, false, false]);
    expect(read.requiresApproval).toBe('never');
    expect(write.requiresApproval).toBe('policy');
    expect(edit.requiresApproval).toBe('policy');

    // `action` only exists on the approval-carrying half of the union.
    const writeAction = write.requiresApproval === 'never' ? undefined : write.action;
    const editAction = edit.requiresApproval === 'never' ? undefined : edit.action;
    expect(writeAction?.({ path: 'a.txt', content: '' })).toEqual({
      kind: 'fs.write',
      path: 'a.txt',
    });
    expect(editAction?.({ path: 'src/app.ts', old_string: 'a', new_string: 'b' })).toEqual({
      kind: 'fs.write',
      path: 'src/app.ts',
    });
  });
});
