import { afterEach, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import {
  ReadTracker,
  ToolErrorCode,
  ToolRegistry,
  createBashTool,
  createFsReadTool,
  createFsWriteTool,
  createLogAuditSink,
  createProcessJobRegistry,
  createSandboxRuntime,
  openSessionLog,
  readSessionLog,
} from '../src/index.js';
import type {
  ApprovalAnswerer,
  JobRegistry,
  OsSandboxBackend,
  SandboxMode,
  SandboxRuntime,
  SessionEvent,
  SessionLog,
} from '../src/index.js';
import { makeCtx } from './helpers/ctx.js';
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js';

const dirs: string[] = [];
const logs: SessionLog[] = [];
const jobRegistries: JobRegistry[] = [];

afterEach(async () => {
  for (const jobs of jobRegistries) {
    for (const id of jobs.list()) {
      await jobs.kill(id).catch(() => undefined);
    }
  }
  jobRegistries.length = 0;
  for (const log of logs) {
    await log.close().catch(() => undefined);
  }
  logs.length = 0;
  await Promise.all(dirs.splice(0).map((dir) => removeTmpDir(dir)));
});

async function tmp(): Promise<string> {
  const dir = await makeTmpDir();
  dirs.push(dir);
  return dir;
}

interface StackOptions {
  readonly mode: SandboxMode;
  readonly outsideWorkspace?: 'deny' | 'ask';
  readonly answerer?: ApprovalAnswerer;
  readonly osSandbox?: OsSandboxBackend;
}

async function stack(options: StackOptions) {
  const workspace = await tmp();
  const sessionRoot = await tmp();
  const log = await openSessionLog({ root: sessionRoot, sessionId: 's1' });
  logs.push(log);

  const appends: Promise<unknown>[] = [];
  const audit = createLogAuditSink((input) => {
    appends.push(log.append(input));
  });

  const runtime: SandboxRuntime = createSandboxRuntime({
    mode: options.mode,
    workspaceRoot: workspace,
    audit,
    ...(options.outsideWorkspace === undefined
      ? {}
      : { outsideWorkspace: options.outsideWorkspace }),
    ...(options.answerer === undefined ? {} : { answerer: options.answerer }),
    ...(options.osSandbox === undefined ? {} : { osSandbox: options.osSandbox }),
  });

  const jobs = createProcessJobRegistry();
  jobRegistries.push(jobs);

  const registry = new ToolRegistry({ gate: runtime.gate });
  registry.register(createFsReadTool());
  registry.register(createFsWriteTool());
  registry.register(createBashTool({ defaultTimeoutMs: 20_000 }));

  const ctx = makeCtx({
    workdir: workspace,
    fs: runtime.fs,
    jobs,
    reads: new ReadTracker(),
    requestApproval: runtime.requestApproval,
  });

  const flushed = async (): Promise<readonly SessionEvent[]> => {
    await Promise.all(appends);
    return await readSessionLog({ root: sessionRoot, sessionId: 's1' });
  };

  return { workspace, runtime, registry, ctx, flushed };
}

describe('sandbox runtime end to end', () => {
  it('lets the agent write inside the workspace', async () => {
    const { workspace, registry, ctx, flushed } = await stack({ mode: 'workspace-write' });

    await registry.dispatch('fs_read', { path: 'notes.md' }, ctx);
    const written = await registry.dispatch(
      'fs_write',
      { path: 'notes.md', content: 'hello' },
      ctx,
    );

    expect(written.ok).toBe(true);
    expect(written.output).toContain('Created notes.md');

    const events = await flushed();
    const decisions = events.filter(
      (event): event is Extract<SessionEvent, { t: 'policy.decision' }> =>
        event.t === 'policy.decision',
    );
    expect(decisions.some((event) => event.outcome === 'allow')).toBe(true);
    expect(decisions.every((event) => typeof event.seq === 'number')).toBe(true);
    expect(workspace.length).toBeGreaterThan(0);
  });

  it('refuses a write outside the workspace at the gate', async () => {
    const { workspace, registry, ctx, flushed } = await stack({ mode: 'workspace-write' });
    const outside = resolve(workspace, '..', 'escaped.txt');

    const result = await registry.dispatch(
      'fs_write',
      { path: outside, content: 'nope' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe(ToolErrorCode.PolicyDenied);

    const events = await flushed();
    const denied = events.find(
      (event) => event.t === 'policy.decision' && event.outcome === 'deny',
    );
    expect(denied).toBeDefined();
  });

  it('fails closed when an escalated write has nobody to ask', async () => {
    const { workspace, registry, ctx } = await stack({
      mode: 'workspace-write',
      outsideWorkspace: 'ask',
    });

    const result = await registry.dispatch(
      'fs_write',
      { path: join(workspace, '..', 'escalated.txt'), content: 'x' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe(ToolErrorCode.ApprovalDenied);
  });

  it('still refuses the write when the human approves an outside path', async () => {
    const { workspace, registry, ctx, flushed } = await stack({
      mode: 'workspace-write',
      outsideWorkspace: 'ask',
      answerer: () => true,
    });

    const result = await registry.dispatch(
      'fs_write',
      { path: join(workspace, '..', 'escalated.txt'), content: 'x' },
      ctx,
    );

    // The gate escalated and the human said yes, but the filesystem tool keeps
    // its own workspace check: two independent layers, both must pass.
    expect(result.code).toBe(ToolErrorCode.PathEscape);

    const events = await flushed();
    expect(events.some((event) => event.t === 'approval.request')).toBe(true);
    expect(
      events.some((event) => event.t === 'approval.decision' && event.decision === 'allow'),
    ).toBe(true);
  });

  it('denies shell execution and mutation in read-only mode', async () => {
    const { registry, ctx, flushed } = await stack({ mode: 'read-only' });

    const shell = await registry.dispatch('bash', { command: 'echo hi' }, ctx);
    const write = await registry.dispatch('fs_write', { path: 'a.txt', content: 'x' }, ctx);

    expect(shell.code).toBe(ToolErrorCode.PolicyDenied);
    expect(write.code).toBe(ToolErrorCode.PolicyDenied);

    const events = await flushed();
    const outcomes = events
      .filter((event) => event.t === 'policy.decision')
      .map((event) => event.outcome);
    expect(outcomes).toEqual(['deny', 'deny']);
  });

  it('runs a real command through the sandboxed shell port', async () => {
    const { registry, ctx } = await stack({ mode: 'workspace-write' });

    const result = await registry.dispatch('bash', { command: 'echo sandboxed' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('sandboxed');
    expect(result.output).toContain('[exit code: 0]');
  });

  it('reports whether the shell is really confined', async () => {
    const unconfined = await stack({ mode: 'workspace-write' });
    expect(unconfined.runtime.shell.confinement).toBe('unconfined');

    const fakeSandbox: OsSandboxBackend = {
      id: 'fake',
      wrap: (command) => ({ file: '/usr/bin/true', args: ['-lc', command] }),
      probe: async () => ({ available: true, detail: 'fake' }),
    };
    const confined = await stack({ mode: 'workspace-write', osSandbox: fakeSandbox });

    expect(confined.runtime.shell.confinement).toBe('os-sandbox');
  });

  it('enforces the sandbox at the port even without a gate decision', async () => {
    const { workspace, runtime } = await stack({ mode: 'workspace-write' });

    await expect(runtime.fs.write(resolve(workspace, '..', 'direct.txt'), 'x')).rejects.toMatchObject(
      { code: 'E_POLICY_DENIED' },
    );
  });
});
