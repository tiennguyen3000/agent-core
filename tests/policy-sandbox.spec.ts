import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkWrite, createSandboxPolicy } from '../src/index.js';
import type { PolicyAuditEvent, SandboxMode } from '../src/index.js';

const workspaceRoot = '/ws';

function policy(
  mode: SandboxMode,
  extra: {
    tempGrants?: readonly string[];
    outsideWorkspace?: 'deny' | 'ask';
    events?: PolicyAuditEvent[];
  } = {},
) {
  return createSandboxPolicy({
    mode,
    workspaceRoot,
    ...(extra.tempGrants === undefined ? {} : { tempGrants: extra.tempGrants }),
    ...(extra.outsideWorkspace === undefined
      ? {}
      : { outsideWorkspace: extra.outsideWorkspace }),
    ...(extra.events === undefined
      ? {}
      : { onDecision: (event) => extra.events?.push(event) }),
    now: () => 42,
  });
}

describe('checkWrite', () => {
  it('confines workspace-write to the workspace and its temp grants', () => {
    const scope = { mode: 'workspace-write' as const, workspaceRoot, tempGrants: ['/tmp/grant'] };

    expect(checkWrite(scope, 'src/app.ts').allowed).toBe(true);
    expect(checkWrite(scope, '/ws/deep/nested.txt').allowed).toBe(true);
    expect(checkWrite(scope, '/ws').allowed).toBe(true);
    expect(checkWrite(scope, '/tmp/grant/session.tmp').allowed).toBe(true);
    expect(checkWrite(scope, '../escape.txt').allowed).toBe(false);
    expect(checkWrite(scope, '/etc/passwd').allowed).toBe(false);
    expect(checkWrite(scope, '/tmp/outside.txt').allowed).toBe(false);
    expect(checkWrite(scope, '/ws/../sibling.txt').allowed).toBe(false);
  });

  it('refuses every mutation in read-only mode', () => {
    const scope = { mode: 'read-only' as const, workspaceRoot };

    expect(checkWrite(scope, 'src/app.ts').allowed).toBe(false);
    expect(checkWrite(scope, '/ws/file.txt').reason).toContain('read-only');
  });

  it('allows anything in full-access mode', () => {
    const scope = { mode: 'full-access' as const, workspaceRoot };

    expect(checkWrite(scope, '/etc/hosts').allowed).toBe(true);
  });
});

describe('sandbox policy gate', () => {
  // The policy resolves paths, so on Windows this becomes D:\\etc\\hosts.
  const hostsPath = resolve('/etc/hosts');

  it('denies mutations and shell execution in read-only mode', async () => {
    const gate = policy('read-only');

    await expect(gate.decide({ kind: 'fs.write', path: '/ws/a.txt' })).resolves.toMatchObject({
      outcome: 'deny',
    });
    await expect(
      gate.decide({ kind: 'shell.exec', command: 'ls', cwd: workspaceRoot }),
    ).resolves.toMatchObject({ outcome: 'deny' });
    await expect(gate.decide({ kind: 'fs.read', path: '/etc/hosts' })).resolves.toMatchObject({
      outcome: 'allow',
    });
  });

  it('allows writes inside the workspace and denies escapes', async () => {
    const gate = policy('workspace-write');

    await expect(gate.decide({ kind: 'fs.write', path: 'src/a.ts' })).resolves.toMatchObject({
      outcome: 'allow',
    });
    const denied = await gate.decide({ kind: 'fs.write', path: '../escape.txt' });
    expect(denied.outcome).toBe('deny');
    expect(denied.reason).toContain('outside the workspace');
  });

  it('honours temp grants', async () => {
    const gate = policy('workspace-write', { tempGrants: ['/tmp/grant'] });

    await expect(
      gate.decide({ kind: 'fs.write', path: '/tmp/grant/x.tmp' }),
    ).resolves.toMatchObject({ outcome: 'allow' });
    await expect(
      gate.decide({ kind: 'fs.write', path: '/tmp/other.tmp' }),
    ).resolves.toMatchObject({ outcome: 'deny' });
  });

  it('can escalate an outside write to a human instead of refusing', async () => {
    const gate = policy('workspace-write', { outsideWorkspace: 'ask' });

    const decision = await gate.decide({ kind: 'fs.write', path: '/etc/hosts' });

    expect(decision.outcome).toBe('ask');
    expect(decision.reason).toContain(hostsPath);
  });

  it('allows shell and network in workspace-write and full-access', async () => {
    for (const mode of ['workspace-write', 'full-access'] as const) {
      const gate = policy(mode);
      await expect(
        gate.decide({ kind: 'shell.exec', command: 'ls', cwd: workspaceRoot }),
      ).resolves.toMatchObject({ outcome: 'allow' });
      await expect(
        gate.decide({ kind: 'net.fetch', url: 'https://example.com' }),
      ).resolves.toMatchObject({ outcome: 'allow' });
    }
  });

  it('records every decision, allowed ones included', async () => {
    const events: PolicyAuditEvent[] = [];
    const gate = policy('workspace-write', { events });

    await gate.decide({ kind: 'fs.read', path: 'a.txt' });
    await gate.decide({ kind: 'fs.write', path: 'b.txt' });
    await gate.decide({ kind: 'fs.write', path: '/etc/hosts' });

    expect(events.map((event) => [event.t, event.action.kind, event.outcome])).toEqual([
      ['policy.decision', 'fs.read', 'allow'],
      ['policy.decision', 'fs.write', 'allow'],
      ['policy.decision', 'fs.write', 'deny'],
    ]);
    expect(events.map((event) => event.requestId)).toEqual([
      'policy-1',
      'policy-2',
      'policy-3',
    ]);
    expect(events[0]?.at).toBe(42);
    expect(events[2]?.reason).toBeDefined();
  });

  it('reports its mode on the gate', () => {
    expect(policy('read-only').mode).toBe('read-only');
  });
});
