import { describe, expect, it } from 'vitest';
import { createBashShellRunner } from '../src/index.js';
import type { BashShellRunnerOptions, ShellRunner } from '../src/index.js';
import { LONG_RUNNING_COMMAND, PRINT_CWD_COMMAND } from './helpers/process.js';

const cwd = process.cwd();

function runner(options: BashShellRunnerOptions = {}): ShellRunner {
  return createBashShellRunner(options);
}

describe('bash shell runner', () => {
  it('collects stdout and reports the exit code', async () => {
    const result = await runner().exec('echo hi', {
      cwd,
      signal: new AbortController().signal,
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
    expect(result.stderr).toBe('');
  });

  it('keeps stderr separate from stdout', async () => {
    const result = await runner().exec('echo out; echo err >&2', {
      cwd,
      signal: new AbortController().signal,
    });

    expect(result.stdout).toContain('out');
    expect(result.stdout).not.toContain('err');
    expect(result.stderr).toContain('err');
  });

  it('propagates a non-zero exit code', async () => {
    const result = await runner().exec('exit 7', {
      cwd,
      signal: new AbortController().signal,
    });

    expect(result.code).toBe(7);
  });

  it('runs in the requested working directory', async () => {
    const result = await runner().exec(PRINT_CWD_COMMAND, {
      cwd,
      signal: new AbortController().signal,
    });

    expect(result.stdout.trim()).toBe(cwd);
  });

  it('kills the command when the signal aborts and only then resolves', async () => {
    const controller = new AbortController();
    const pending = runner().exec(`echo started && ${LONG_RUNNING_COMMAND}`, {
      cwd,
      signal: controller.signal,
    });

    controller.abort();
    const result = await pending;

    // Resolving at all proves the child exited; a leaked `sleep` would hang here.
    expect(result.code).toBe(130);
    expect(result.signal).toBeDefined();
  });

  it('does not leak secrets into the command environment', async () => {
    const result = await runner({
      env: { PATH: process.env.PATH, DSH_TEST_SECRET: 'leak-me' },
      envAllowlist: ['PATH'],
    }).exec('env', { cwd, signal: new AbortController().signal });

    expect(result.stdout).toContain('PATH=');
    expect(result.stdout).not.toContain('leak-me');
  });

  it('caps a flooding stream and says how much it dropped', async () => {
    const result = await runner({ maxOutputChars: 200 }).exec(
      `node -e "process.stdout.write('b'.repeat(2000))"`,
      { cwd, signal: new AbortController().signal },
    );

    expect(result.stdout).toContain('characters omitted');
    expect(result.stdout.length).toBeLessThan(400);
  });
});
