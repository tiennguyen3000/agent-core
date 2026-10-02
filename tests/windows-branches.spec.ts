import { describe, expect, it } from 'vitest';
import { createBashShellRunner, createMcpStdioClient, createProcessJobRegistry } from '../src/index.js';
import type { SandboxedFs } from '../src/index.js';
import { memoryFs } from './helpers/ctx.js';

/**
 * Windows behaviour, exercised from any platform by injecting the platform.
 *
 * These are the paths that would otherwise only be discovered on a Windows
 * machine: a process tree that survives `kill`, an `.cmd` shim that cannot be
 * spawned directly, and `bash` flags sent to `cmd.exe`.
 */
describe('windows branches', () => {
  it('kills the whole process tree with taskkill instead of the direct child', async () => {
    const spawned: { command: string; args: readonly string[] }[] = [];
    const jobListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const emitExit = (): void => {
      for (const listener of jobListeners.exit ?? []) {
        listener(null, 'SIGTERM');
      }
    };

    const spawnImpl = ((command: string, args: readonly string[]) => {
      spawned.push({ command, args });
      if (command === 'taskkill') {
        // The real taskkill walks the tree, so the job child dies right after.
        emitExit();
        return { pid: 1, on: () => undefined, unref: () => undefined, kill: () => true };
      }
      const child = {
        pid: 4321,
        on(event: string, listener: (...args: unknown[]) => void) {
          (jobListeners[event] ??= []).push(listener);
          return child;
        },
        kill: () => {
          emitExit();
          return true;
        },
        unref: () => undefined,
        stdout: null,
        stderr: null,
      };
      return child;
    }) as never;

    const registry = createProcessJobRegistry({ platform: 'win32', now: () => 0, spawnImpl });
    const { jobId } = await registry.spawn('echo hello', { cwd: 'C:\\work' });

    await registry.kill(jobId);

    const taskkill = spawned.find((entry) => entry.command === 'taskkill');
    expect(taskkill?.args).toEqual(['/PID', '4321', '/T', '/F']);
    // Only the taskkill spawn carries an argv; the job spawn takes the
    // platform shell, and no POSIX group signal is attempted on Windows.
    const withArgv = spawned.filter((entry) => Array.isArray(entry.args));
    expect(withArgv).toHaveLength(1);
    expect(registry.snapshot(jobId)?.status).toBe('killed');
  });

  it('spawns MCP servers through a shell on Windows and directly elsewhere', () => {
    const seen: { command: string; shell: boolean | undefined }[] = [];
    const spawnImpl = ((command: string, _args: readonly string[], options: { shell?: boolean }) => {
      seen.push({ command, shell: options.shell });
      return {
        pid: 1,
        on: () => undefined,
        kill: () => true,
        unref: () => undefined,
        stdin: { write: () => true, end: () => undefined, on: () => undefined },
        stdout: { setEncoding: () => undefined, on: () => undefined },
        stderr: { setEncoding: () => undefined, on: () => undefined },
      };
    }) as never;

    createMcpStdioClient({ name: 'w', command: 'npx', args: ['-y', 'pkg'], spawnImpl, platform: 'win32' });
    createMcpStdioClient({ name: 'p', command: 'npx', args: ['-y', 'pkg'], spawnImpl, platform: 'darwin' });

    expect(seen[0]).toEqual({ command: 'npx', shell: true });
    expect(seen[1]).toEqual({ command: 'npx', shell: false });
  });

  it('uses cmd.exe with /d /s /c on Windows and bash -lc elsewhere', async () => {
    const calls: { file: string; args: readonly string[]; detached: boolean }[] = [];
    const fs = memoryFs({ root: 'C:\\work', files: {} }) as unknown as SandboxedFs;

    const spawnImpl = ((file: string, args: readonly string[], options: { detached: boolean }) => {
      calls.push({ file, args, detached: options.detached });
      return {
        pid: 99,
        stdout: { setEncoding: () => undefined, on: () => undefined },
        stderr: { setEncoding: () => undefined, on: () => undefined },
        on: (event: string, listener: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            listener(0, null);
          }
        },
        kill: () => true,
      };
    }) as never;

    const windows = createBashShellRunner({
      platform: 'win32',
      spawnImpl,
      shell: 'cmd.exe',
      env: {},
    });
    await windows.exec('dir', { cwd: 'C:\\work', signal: new AbortController().signal });
    expect(calls[0]).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', 'dir'],
      detached: false,
    });

    const posix = createBashShellRunner({
      platform: 'darwin',
      spawnImpl,
      shell: '/bin/bash',
      env: {},
    });
    await posix.exec('ls', { cwd: '/work', signal: new AbortController().signal });
    expect(calls[1]).toEqual({
      file: '/bin/bash',
      args: ['-lc', 'ls'],
      detached: true,
    });
    void fs;
  });
});
