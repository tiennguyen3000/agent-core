import { afterEach, describe, expect, it } from 'vitest';
import {
  ToolErrorCode,
  ToolRegistry,
  createBashTool,
  createJobKillTool,
  createJobListTool,
  createJobOutputTool,
  createProcessJobRegistry,
} from '../src/index.js';
import type { JobRegistry, ProcessJobRegistryOptions } from '../src/index.js';
import { RecordingGate, makeCtx } from './helpers/ctx.js';
import { untilAsync } from './helpers/process.js';

const registries: JobRegistry[] = [];

function setup(options: ProcessJobRegistryOptions = {}) {
  const jobs = createProcessJobRegistry(options);
  registries.push(jobs);
  const gate = new RecordingGate();
  const registry = new ToolRegistry({ gate });
  registry.register(createBashTool());
  registry.register(createJobOutputTool());
  registry.register(createJobListTool());
  registry.register(createJobKillTool());
  const ctx = makeCtx({ workdir: process.cwd(), jobs });
  return { jobs, gate, registry, ctx };
}

afterEach(async () => {
  for (const jobs of registries) {
    for (const id of jobs.list()) {
      await jobs.kill(id).catch(() => undefined);
    }
  }
  registries.length = 0;
});

describe('bash tool', () => {
  it('runs a foreground command and returns its output with a job id', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('bash', { command: 'echo hello' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello');
    expect(result.output).toContain('[exit code: 0]');
    expect(result.meta?.jobId).toBe('job-1');
    expect(result.meta?.exitCode).toBe(0);
  });

  it('reports a non-zero exit code without failing the tool call', async () => {
    const { registry, ctx } = setup();

    const result = await registry.dispatch('bash', { command: 'exit 4' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('[exit code: 4]');
    expect(result.meta?.status).toBe('failed');
  });

  it('starts a background command and returns immediately', async () => {
    const { registry, ctx, jobs } = setup();

    const result = await registry.dispatch(
      'bash',
      { command: 'exec sleep 30', run_in_background: true },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain('Started job-1 in the background');
    expect(jobs.snapshot('job-1')?.status).toBe('running');
  });

  it('hands back the job id when a foreground command outlives its deadline', async () => {
    const deadlines: (() => void)[] = [];
    const { registry, ctx, jobs } = setup({
      schedule: (fn) => {
        deadlines.push(fn);
        return () => undefined;
      },
    });

    const pending = registry.dispatch(
      'bash',
      { command: 'echo started; exec sleep 30', timeout_ms: 5_000 },
      ctx,
    );
    await untilAsync(() => deadlines.length === 1, 'the deadline was scheduled');
    deadlines[0]?.();

    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.output).toContain('still running after 5000ms');
    expect(result.output).toContain('job-1');
    expect(result.meta?.running).toBe(true);
    expect(jobs.snapshot('job-1')?.status).toBe('running');
    await jobs.kill('job-1');
  });

  it('kills the command when the turn is cancelled', async () => {
    const { registry, jobs } = setup();
    const controller = new AbortController();
    const ctx = makeCtx({ workdir: process.cwd(), jobs, signal: controller.signal });

    const pending = registry.dispatch('bash', { command: 'exec sleep 30' }, ctx);
    await untilAsync(() => jobs.list().length === 1, 'the command started');
    controller.abort();

    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.code).toBe(ToolErrorCode.Cancelled);
    expect(jobs.snapshot('job-1')?.status).toBe('killed');
  });

  it('derives a policy action with the command and the workspace', async () => {
    const { gate, registry, ctx } = setup();

    await registry.dispatch('bash', { command: 'echo hi' }, ctx);

    expect(gate.calls).toEqual([
      { kind: 'shell.exec', command: 'echo hi', cwd: process.cwd() },
    ]);
  });
});

describe('job tools', () => {
  it('follows a background job with job_output and stops it with job_kill', async () => {
    const { registry, ctx, jobs } = setup();

    await registry.dispatch('bash', { command: 'echo first; exec sleep 30', run_in_background: true }, ctx);
    await untilAsync(
      () => (jobs.read('job-1')?.text ?? '').includes('first'),
      'the background job produced output',
    );

    const output = await registry.dispatch('job_output', { job_id: 'job-1' }, ctx);
    expect(output.ok).toBe(true);
    expect(output.output).toContain('first');
    expect(output.meta?.status).toBe('running');

    const killed = await registry.dispatch('job_kill', { job_id: 'job-1' }, ctx);
    expect(killed.ok).toBe(true);
    expect(killed.output).toContain('Killed job-1');
    expect(jobs.snapshot('job-1')?.status).toBe('killed');
  });

  it('waits for a job to finish when wait_ms is given', async () => {
    const { registry, ctx } = setup();

    await registry.dispatch(
      'bash',
      { command: 'node -e "setTimeout(() => console.log(\'late\'), 50)"', run_in_background: true },
      ctx,
    );

    const output = await registry.dispatch(
      'job_output',
      { job_id: 'job-1', wait_ms: 10_000 },
      ctx,
    );

    expect(output.output).toContain('late');
    expect(output.meta?.status).toBe('exited');
  });

  it('lists jobs with status, exit code and command', async () => {
    const { registry, ctx } = setup();
    await registry.dispatch('bash', { command: 'echo one' }, ctx);
    await registry.dispatch('bash', { command: 'exit 2' }, ctx);

    const list = await registry.dispatch('job_list', {}, ctx);

    expect(list.output).toContain('job-1');
    expect(list.output).toContain('job-2');
    expect(list.output).toContain('exit=0');
    expect(list.output).toContain('exit=2');
    expect(list.output).toContain('echo one');
  });

  it('says so when there are no jobs', async () => {
    const { registry, ctx } = setup();

    const list = await registry.dispatch('job_list', {}, ctx);

    expect(list.output).toContain('No jobs');
  });

  it('rejects unknown job ids with E_NOT_FOUND', async () => {
    const { registry, ctx } = setup();

    const output = await registry.dispatch('job_output', { job_id: 'nope' }, ctx);
    const killed = await registry.dispatch('job_kill', { job_id: 'nope' }, ctx);

    expect(output.code).toBe(ToolErrorCode.NotFound);
    expect(output.output).toContain('Unknown job');
    expect(killed.code).toBe(ToolErrorCode.NotFound);
  });

  it('reports a job that had already finished instead of killing it', async () => {
    const { registry, ctx } = setup();
    await registry.dispatch('bash', { command: 'echo done' }, ctx);

    const killed = await registry.dispatch('job_kill', { job_id: 'job-1' }, ctx);

    expect(killed.ok).toBe(true);
    expect(killed.output).toContain('already finished');
  });

  it('marks job reads as parallel-safe and job_kill as exclusive', () => {
    expect(createJobOutputTool().parallelSafe).toBe(true);
    expect(createJobListTool().parallelSafe).toBe(true);
    expect(createJobKillTool().parallelSafe).toBe(false);
    expect(createBashTool().parallelSafe).toBe(false);
  });
});
