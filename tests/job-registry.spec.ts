import { afterEach, describe, expect, it } from 'vitest';
import { createProcessJobRegistry } from '../src/index.js';
import type { JobRegistry, ProcessJobRegistryOptions } from '../src/index.js';
import { processAlive, untilAsync } from './helpers/process.js';

const registrys: JobRegistry[] = [];
const cwd = process.cwd();

function make(options: ProcessJobRegistryOptions = {}): JobRegistry {
  const registry = createProcessJobRegistry(options);
  registrys.push(registry);
  return registry;
}

afterEach(async () => {
  for (const registry of registrys) {
    for (const id of registry.list()) {
      await registry.kill(id).catch(() => undefined);
    }
  }
  registrys.length = 0;
});

async function run(registry: JobRegistry, command: string): Promise<string> {
  const { jobId } = await registry.spawn(command, { cwd });
  await registry.wait(jobId, { timeoutMs: 15_000 });
  const output = registry.read(jobId);
  expect(output).toBeDefined();
  return output?.text ?? '';
}

describe('process job registry', () => {
  it('runs a command, merges output and appends an exit marker', async () => {
    const registry = make();

    const { jobId } = await registry.spawn('echo hello', { cwd });
    const waited = await registry.wait(jobId, { timeoutMs: 15_000 });
    const output = registry.read(jobId);

    expect(waited.outcome).toBe('settled');
    expect(output?.snapshot.status).toBe('exited');
    expect(output?.snapshot.exitCode).toBe(0);
    expect(output?.text).toContain('hello');
    expect(output?.text).toContain('[exit code: 0]');
    expect(output?.snapshot.pid).toBeGreaterThan(0);
  });

  it('reports a failing command as failed with its exit code', async () => {
    const registry = make();

    const text = await run(registry, 'exit 3');
    const [jobId] = registry.list();
    const snapshot = jobId === undefined ? undefined : registry.snapshot(jobId);

    expect(snapshot?.status).toBe('failed');
    expect(snapshot?.exitCode).toBe(3);
    expect(text).toContain('[exit code: 3]');
  });

  it('merges stderr into the same buffer', async () => {
    const registry = make();

    const text = await run(registry, 'echo to-stderr >&2');

    expect(text).toContain('to-stderr');
  });

  it('runs in the requested working directory', async () => {
    const registry = make();

    const text = await run(registry, 'pwd');

    expect(text).toContain(cwd);
  });

  it('keeps the buffer bounded and reports what it dropped', async () => {
    const registry = make({ maxOutputChars: 200 });

    const { jobId } = await registry.spawn(
      `node -e "process.stdout.write('a'.repeat(2000))"`,
      { cwd },
    );
    await registry.wait(jobId, { timeoutMs: 15_000 });
    const output = registry.read(jobId);

    expect(output?.snapshot.outputChars).toBeGreaterThan(2_000);
    expect(output?.snapshot.droppedChars).toBeGreaterThan(0);
    expect(output?.text.length).toBeLessThanOrEqual(200);
    expect(output?.lossy).toBe(true);
    expect(output?.text).toContain('[exit code: 0]');
  });

  it('reads a delta from a cursor', async () => {
    const registry = make();

    const { jobId } = await registry.spawn('printf abcdef', { cwd });
    await registry.wait(jobId, { timeoutMs: 15_000 });
    const output = registry.read(jobId);
    const cursor = output?.nextCursor ?? 0;

    const delta = registry.read(jobId, { since: cursor });
    const partial = registry.read(jobId, { since: 3 });

    expect(delta?.text).toBe('');
    expect(delta?.lossy).toBe(false);
    expect(partial?.text).toBe((output?.text ?? '').slice(3));
  });

  it('kill terminates the child process for real', async () => {
    const registry = make();

    // `exec` replaces the shell, so the reported pid is the sleeping process.
    const { jobId } = await registry.spawn('echo started; exec sleep 30', { cwd });
    await untilAsync(() => (registry.read(jobId)?.text ?? '').includes('started'), 'the job started');

    const pid = registry.snapshot(jobId)?.pid;
    expect(pid).toBeGreaterThan(0);
    expect(processAlive(pid ?? 0)).toBe(true);

    await registry.kill(jobId);

    expect(registry.snapshot(jobId)?.status).toBe('killed');
    await untilAsync(() => !processAlive(pid ?? 0), 'the child process is gone');
  });

  it('kill on a finished job changes nothing', async () => {
    const registry = make();
    const { jobId } = await registry.spawn('true', { cwd });
    await registry.wait(jobId, { timeoutMs: 15_000 });

    const before = registry.snapshot(jobId)?.status;
    await registry.kill(jobId);

    expect(before).toBe('exited');
    expect(registry.snapshot(jobId)?.status).toBe('exited');
  });

  it('queues a completion notice exactly once', async () => {
    const registry = make();
    const { jobId } = await registry.spawn('echo done', { cwd });
    await registry.wait(jobId, { timeoutMs: 15_000 });

    const notices = registry.drainNotices();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ jobId, status: 'exited', exitCode: 0, command: 'echo done' });
    expect(registry.drainNotices()).toEqual([]);
  });

  it('does not leak secrets into the child environment', async () => {
    const registry = make({
      env: { PATH: process.env.PATH, DSH_TEST_SECRET: 'leak-me' },
      envAllowlist: ['PATH'],
    });

    const text = await run(registry, 'env');

    expect(text).toContain('PATH=');
    expect(text).not.toContain('leak-me');
  });

  it('returns running when the deadline fires, leaving the job alive', async () => {
    const deadlines: (() => void)[] = [];
    const registry = make({
      schedule: (fn) => {
        deadlines.push(fn);
        return () => undefined;
      },
    });

    const { jobId } = await registry.spawn('exec sleep 30', { cwd });
    const pending = registry.wait(jobId, { timeoutMs: 5_000 });
    await untilAsync(() => deadlines.length === 1, 'the deadline was scheduled');
    deadlines[0]?.();

    const waited = await pending;

    expect(waited.outcome).toBe('running');
    expect(registry.snapshot(jobId)?.status).toBe('running');
    await registry.kill(jobId);
  });

  it('settles immediately for a job that already finished', async () => {
    const registry = make();
    const { jobId } = await registry.spawn('true', { cwd });
    await registry.wait(jobId, { timeoutMs: 15_000 });

    const waited = await registry.wait(jobId);

    expect(waited.outcome).toBe('settled');
  });

  it('reports cancellation when the signal is already aborted', async () => {
    const registry = make();
    const { jobId } = await registry.spawn('exec sleep 30', { cwd });
    const controller = new AbortController();
    controller.abort();

    const waited = await registry.wait(jobId, { signal: controller.signal });

    expect(waited.outcome).toBe('cancelled');
    await registry.kill(jobId);
  });

  it('exposes snapshots and output only for known jobs', async () => {
    const registry = make();

    expect(registry.snapshot('nope')).toBeUndefined();
    expect(registry.read('nope')).toBeUndefined();
    await expect(registry.wait('nope')).rejects.toThrow(/Unknown job/);
    await expect(registry.kill('nope')).rejects.toThrow(/Unknown job/);
  });
});
