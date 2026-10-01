import { describe, expect, it } from 'vitest';
import { createApprovalBroker } from '../src/index.js';
import type { Action, ApprovalAuditEvent, ApprovalRequest } from '../src/index.js';
import { untilAsync } from './helpers/process.js';

const action: Action = { kind: 'shell.exec', command: 'rm -rf build', cwd: '/ws' };

describe('approval broker', () => {
  it('fails closed when nothing can answer', async () => {
    const events: ApprovalAuditEvent[] = [];
    const broker = createApprovalBroker({ onEvent: (event) => events.push(event), now: () => 7 });

    const approved = await broker.requestApproval(action);

    expect(approved).toBe(false);
    expect(events.map((event) => event.t)).toEqual(['approval.request', 'approval.decision']);
    expect(events[1]).toMatchObject({ decision: 'deny', by: 'policy', requestId: 'approval-1' });
    expect(events[0]).toMatchObject({ action });
  });

  it('asks a registered answerer and accepts its verdict', async () => {
    const broker = createApprovalBroker();
    broker.registerAnswerer(async () => true);

    expect(await broker.requestApproval(action)).toBe(true);
  });

  it('lets a caller answer a pending request by id', async () => {
    const broker = createApprovalBroker();
    let seen: ApprovalRequest | undefined;
    broker.registerAnswerer(
      (request) =>
        new Promise<boolean>(() => {
          seen = request;
        }),
    );

    const pending = broker.requestApproval(action);
    await untilAsync(() => seen !== undefined, 'the answerer was asked');

    expect(broker.pending).toHaveLength(1);
    expect(broker.answer(seen?.id ?? 'missing', true)).toBe(true);
    expect(await pending).toBe(true);
    expect(broker.pending).toHaveLength(0);
    expect(broker.answer(seen?.id ?? 'missing', true)).toBe(false);
  });

  it('denies when the answerer says no', async () => {
    const broker = createApprovalBroker();
    let seen: ApprovalRequest | undefined;
    broker.registerAnswerer(
      (request) =>
        new Promise<boolean>(() => {
          seen = request;
        }),
    );

    const pending = broker.requestApproval(action);
    await untilAsync(() => seen !== undefined, 'the answerer was asked');
    broker.answer(seen?.id ?? 'missing', false);

    expect(await pending).toBe(false);
  });

  it('denies when the answerer throws', async () => {
    const broker = createApprovalBroker();
    broker.registerAnswerer(() => {
      throw new Error('channel broke');
    });

    expect(await broker.requestApproval(action)).toBe(false);
  });

  it('denies when the deadline fires first', async () => {
    const deadlines: (() => void)[] = [];
    const events: ApprovalAuditEvent[] = [];
    const broker = createApprovalBroker({
      timeoutMs: 1_000,
      onEvent: (event) => events.push(event),
      schedule: (fn) => {
        deadlines.push(fn);
        return () => undefined;
      },
    });
    broker.registerAnswerer(() => new Promise<boolean>(() => undefined));

    const pending = broker.requestApproval(action);
    await untilAsync(() => deadlines.length === 1, 'the deadline was scheduled');
    deadlines[0]?.();

    expect(await pending).toBe(false);
    expect(events.at(-1)).toMatchObject({ decision: 'deny', by: 'policy' });
  });

  it('handles several pending requests independently', async () => {
    const broker = createApprovalBroker();
    const seen: ApprovalRequest[] = [];
    broker.registerAnswerer(
      (request) =>
        new Promise<boolean>(() => {
          seen.push(request);
        }),
    );

    const first = broker.requestApproval(action);
    const second = broker.requestApproval({ kind: 'fs.write', path: '/etc/hosts' });
    await untilAsync(() => seen.length === 2, 'both requests were asked');

    broker.answer(seen[0]?.id ?? 'a', true);
    broker.answer(seen[1]?.id ?? 'b', false);

    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(seen[0]?.id).not.toBe(seen[1]?.id);
  });

  it('can be detached from its answerer again', async () => {
    const broker = createApprovalBroker();
    broker.registerAnswerer(() => true);
    expect(await broker.requestApproval(action)).toBe(true);

    broker.registerAnswerer(undefined);

    expect(await broker.requestApproval(action)).toBe(false);
  });
});
