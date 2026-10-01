import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { buildSeatbeltProfile, createSeatbeltBackend } from '../src/index.js';
import type { ShellResult, ShellRunner } from '../src/index.js';
import { createSandboxedShellRunner } from '../src/index.js';
import type { OsSandboxBackend } from '../src/index.js';

const signal = (): AbortSignal => new AbortController().signal;

function fakeInner(): ShellRunner & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    exec: async (command): Promise<ShellResult> => {
      calls.push(`exec:${command}`);
      return { code: 0, stdout: 'inner', stderr: '' };
    },
    execArgv: async (file, args): Promise<ShellResult> => {
      calls.push(`argv:${file} ${args.join(' ')}`);
      return { code: 0, stdout: 'wrapped', stderr: '' };
    },
  };
}

function fakeInnerWithoutArgv(): ShellRunner {
  return {
    exec: async (): Promise<ShellResult> => ({ code: 0, stdout: 'inner', stderr: '' }),
  };
}

const fakeSandbox: OsSandboxBackend = {
  id: 'fake',
  wrap: (command) => ({
    file: '/fake/sandbox-exec',
    args: ['-p', 'profile', '/bin/bash', '-lc', command],
  }),
  probe: async () => ({ available: true, detail: 'fake backend' }),
};

describe('seatbelt profile', () => {
  it('denies by default and grants writes only to the workspace and grants', () => {
    const profile = buildSeatbeltProfile({ workspaceRoot: '/ws', tempGrants: ['/tmp/grant'] });

    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow file-read*)');
    expect(profile).toContain('(subpath "/ws")');
    expect(profile).toContain('(subpath "/tmp/grant")');
    expect(profile.indexOf('(deny default)')).toBeLessThan(
      profile.indexOf('(allow file-write*'),
    );
  });

  it('escapes quotes and backslashes in paths', () => {
    const profile = buildSeatbeltProfile({
      workspaceRoot: '/ws/we"ird\\path',
      tempGrants: [],
    });

    expect(profile).toContain('/ws/we\\"ird\\\\path');
  });

  it('wraps a command as sandbox-exec with the profile', () => {
    const wrapped = createSeatbeltBackend().wrap('echo hi', {
      workspaceRoot: '/ws',
      tempGrants: [],
      cwd: '/ws',
    });

    expect(wrapped.file).toBe('/usr/bin/sandbox-exec');
    expect(wrapped.args[0]).toBe('-p');
    expect(wrapped.args[2]).toBe('/bin/bash');
    expect(wrapped.args.slice(3)).toEqual(['-lc', 'echo hi']);
  });
});

describe('seatbelt probe', () => {
  function fakeSpawn(exitCode: number, stderr = ''): (() => EventEmitter) & object {
    return Object.assign(
      (): EventEmitter => {
        const emitter = new EventEmitter();
        const stream = Object.assign(new EventEmitter(), {
          setEncoding: (): void => undefined,
        });
        Object.assign(emitter, { stdout: stream, stderr: stream, pid: 1 });
        setImmediate(() => {
          if (stderr.length > 0) {
            stream.emit('data', stderr);
          }
          emitter.emit('exit', exitCode);
        });
        return emitter;
      },
      {},
    );
  }

  it('reports available when the profile applies', async () => {
    const backend = createSeatbeltBackend({
      spawnImpl: fakeSpawn(0) as unknown as typeof import('node:child_process').spawn,
    });

    await expect(backend.probe()).resolves.toEqual({
      available: true,
      detail: 'seatbelt applied successfully',
    });
  });

  it('reports the platform error when the profile cannot be applied', async () => {
    const backend = createSeatbeltBackend({
      spawnImpl: fakeSpawn(1, 'sandbox_apply: Operation not permitted\n') as unknown as typeof import('node:child_process').spawn,
    });

    const probe = await backend.probe();

    expect(probe.available).toBe(false);
    expect(probe.detail).toContain('Operation not permitted');
  });

  it('answers with a structured result on this machine', async () => {
    const probe = await createSeatbeltBackend().probe();

    expect(typeof probe.available).toBe('boolean');
    expect(probe.detail.length).toBeGreaterThan(0);
  });
});

describe('sandboxed shell runner', () => {
  it('refuses to run anything in read-only mode without touching the inner runner', async () => {
    const inner = fakeInner();
    const shell = createSandboxedShellRunner({
      mode: 'read-only',
      inner,
      workspaceRoot: '/ws',
      osSandbox: fakeSandbox,
    });

    const result = await shell.exec('rm -rf /', { cwd: '/ws', signal: signal() });

    expect(result.code).toBe(126);
    expect(result.stderr).toContain('read-only');
    expect(inner.calls).toEqual([]);
  });

  it('reports unconfined when no OS backend is mounted', async () => {
    const inner = fakeInner();
    const shell = createSandboxedShellRunner({
      mode: 'workspace-write',
      inner,
      workspaceRoot: '/ws',
    });

    const result = await shell.exec('echo hi', { cwd: '/ws', signal: signal() });

    expect(shell.confinement).toBe('unconfined');
    expect(result.stdout).toBe('inner');
    expect(inner.calls).toEqual(['exec:echo hi']);
  });

  it('wraps the command when an OS backend is mounted', async () => {
    const inner = fakeInner();
    const shell = createSandboxedShellRunner({
      mode: 'workspace-write',
      inner,
      workspaceRoot: '/ws',
      osSandbox: fakeSandbox,
    });

    const result = await shell.exec('echo hi', { cwd: '/ws', signal: signal() });

    expect(shell.confinement).toBe('os-sandbox');
    expect(result.stdout).toBe('wrapped');
    expect(inner.calls[0]).toContain('argv:/fake/sandbox-exec');
    expect(inner.calls[0]).toContain('-lc echo hi');
  });

  it('fails clearly when the inner runner cannot execute an argv', async () => {
    const shell = createSandboxedShellRunner({
      mode: 'workspace-write',
      inner: fakeInnerWithoutArgv(),
      workspaceRoot: '/ws',
      osSandbox: fakeSandbox,
    });

    const result = await shell.exec('echo hi', { cwd: '/ws', signal: signal() });

    expect(result.code).toBe(126);
    expect(result.stderr).toContain('cannot execute an argv');
  });

  it('does not wrap anything in full-access mode', async () => {
    const inner = fakeInner();
    const shell = createSandboxedShellRunner({
      mode: 'full-access',
      inner,
      workspaceRoot: '/ws',
      osSandbox: fakeSandbox,
    });

    await shell.exec('echo hi', { cwd: '/ws', signal: signal() });

    expect(shell.confinement).toBe('unconfined');
    expect(inner.calls).toEqual(['exec:echo hi']);
  });
});
