import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SessionLogError,
  SessionLogErrorCode,
  forkSessionLog,
  listSessionIds,
  openSessionLog,
  readSessionLog,
  sessionDir,
  sessionLogPath,
} from '../src/index.js';
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js';

const dirs: string[] = [];
const lockFile = (root: string): string => join(sessionDir(root, 's1'), 'session.lock');

async function tmp(): Promise<string> {
  const dir = await makeTmpDir();
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => removeTmpDir(dir)));
});

describe('session log', () => {
  it('appends and reads back exactly what was written', async () => {
    const root = await tmp();
    const log = await openSessionLog({ root, sessionId: 's1' });
    await log.append({
      t: 'session.created',
      sessionId: 's1',
      cwd: '/workspace',
      model: 'fake-model',
    });
    await log.append({ t: 'turn.start', turn: 1, input: 'hello' });
    await log.append({ t: 'turn.end', turn: 1, status: 'done' });

    const inMemory = log.readAll();
    await log.close();

    const reloaded = await readSessionLog({ root, sessionId: 's1' });
    expect(reloaded).toEqual(inMemory);
    expect(reloaded.map((event) => event.seq)).toEqual([1, 2, 3]);

    const lines = (await readFile(sessionLogPath(root, 's1'), 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ seq: 1, t: 'session.created' });
  });

  it('owns seq and timestamps so a caller cannot forge them', async () => {
    const root = await tmp();
    let tick = 100;
    const log = await openSessionLog({ root, sessionId: 's1', now: () => (tick += 10) });

    const first = await log.append({ t: 'turn.start', turn: 1, input: 'a' });
    const second = await log.append({ t: 'turn.start', turn: 2, input: 'b' });

    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect([first.at, second.at]).toEqual([110, 120]);
    expect(log.nextSeq()).toBe(3);
    expect(log.count).toBe(2);
    await log.close();
  });

  it('serializes concurrent appends into contiguous seqs', async () => {
    const root = await tmp();
    const log = await openSessionLog({ root, sessionId: 's1' });

    await Promise.all(
      [1, 2, 3, 4, 5].map((turn) =>
        log.append({ t: 'turn.start', turn, input: `task ${String(turn)}` }),
      ),
    );

    expect(log.readAll().map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    await log.close();

    const events = await readSessionLog({ root, sessionId: 's1' });
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    const lines = (await readFile(sessionLogPath(root, 's1'), 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(5);
  });

  it('survives an unclean exit: a new reader sees fsynced events', async () => {
    const root = await tmp();
    const log = await openSessionLog({ root, sessionId: 's1' });
    await log.append({ t: 'turn.start', turn: 1, input: 'before the crash' });

    // Nothing was closed and the lock file still exists, exactly like after
    // kill -9. A fresh reader must still see the durable event.
    const seen = await readSessionLog({ root, sessionId: 's1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.t).toBe('turn.start');

    const resumed = await openSessionLog({ root, sessionId: 's1', lock: false });
    expect(resumed.nextSeq()).toBe(2);
    await resumed.append({ t: 'turn.start', turn: 2, input: 'after the crash' });
    await resumed.close();
    await log.close();

    expect(await readSessionLog({ root, sessionId: 's1' })).toHaveLength(2);
  });

  it('drops a torn tail before appending so it cannot corrupt the log', async () => {
    const root = await tmp();
    const first = await openSessionLog({ root, sessionId: 's1' });
    await first.append({ t: 'turn.start', turn: 1, input: 'kept' });
    await first.close();

    const path = sessionLogPath(root, 's1');
    await appendFile(path, '{"seq":2,"t":"turn.start","turn":2,"inp');

    // A reader tolerates the fragment...
    expect(await readSessionLog({ root, sessionId: 's1' })).toHaveLength(1);

    // ...and a writer repairs the file before appending.
    const reopened = await openSessionLog({ root, sessionId: 's1' });
    expect(reopened.nextSeq()).toBe(2);
    await reopened.append({ t: 'turn.end', turn: 1, status: 'done' });
    await reopened.close();

    const events = await readSessionLog({ root, sessionId: 's1' });
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[1]?.t).toBe('turn.end');
    expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('tolerates a broken final line but refuses a broken middle line', async () => {
    const root = await tmp();
    const log = await openSessionLog({ root, sessionId: 's1' });
    await log.append({ t: 'turn.start', turn: 1, input: 'good' });
    await log.append({ t: 'turn.start', turn: 2, input: 'also good' });
    await log.close();

    const path = sessionLogPath(root, 's1');
    const good = await readFile(path, 'utf8');

    await writeFile(path, `${good}{oops}\n`);
    expect(await readSessionLog({ root, sessionId: 's1' })).toHaveLength(2);

    const validTail = JSON.stringify({
      seq: 3,
      t: 'turn.end',
      turn: 2,
      status: 'done',
      at: 1,
    });
    await writeFile(path, `${good}{oops}\n${validTail}\n`);

    await expect(readSessionLog({ root, sessionId: 's1' })).rejects.toMatchObject({
      code: SessionLogErrorCode.Corrupt,
    });
    await expect(openSessionLog({ root, sessionId: 's1' })).rejects.toBeInstanceOf(
      SessionLogError,
    );
    // A refused open must not leave the lock behind.
    await expect(readSessionLog({ root, sessionId: 's1' })).rejects.toBeInstanceOf(
      SessionLogError,
    );
  });

  it('refuses a log whose seq numbers are not contiguous', async () => {
    const root = await tmp();
    await mkdir(sessionDir(root, 's1'), { recursive: true });
    const lines = [
      { seq: 1, t: 'turn.start', turn: 1, input: 'one', at: 1 },
      { seq: 3, t: 'turn.end', turn: 1, status: 'done', at: 2 },
    ];
    await writeFile(
      sessionLogPath(root, 's1'),
      lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
    );

    await expect(readSessionLog({ root, sessionId: 's1' })).rejects.toMatchObject({
      code: SessionLogErrorCode.SeqGap,
    });
  });

  it('refuses a second writer and releases the lock on close', async () => {
    const root = await tmp();
    const first = await openSessionLog({ root, sessionId: 's1' });
    await first.append({ t: 'turn.start', turn: 1, input: 'held' });

    await expect(openSessionLog({ root, sessionId: 's1' })).rejects.toMatchObject({
      code: SessionLogErrorCode.Locked,
    });

    await first.close();
    const second = await openSessionLog({ root, sessionId: 's1' });
    expect(second.nextSeq()).toBe(2);
    await second.close();
  });

  it('takes over an unreadable lock but never a lock from another machine', async () => {
    const root = await tmp();
    await mkdir(sessionDir(root, 's1'), { recursive: true });

    await writeFile(lockFile(root), 'not json at all');
    const stolen = await openSessionLog({ root, sessionId: 's1' });
    await stolen.close();

    await writeFile(
      lockFile(root),
      JSON.stringify({ pid: process.pid, host: 'another-machine', at: 1 }),
    );
    await expect(openSessionLog({ root, sessionId: 's1' })).rejects.toMatchObject({
      code: SessionLogErrorCode.Locked,
    });
    await rm(lockFile(root), { force: true });
  });

  it('forks a prefix into a new session and leaves the source untouched', async () => {
    const root = await tmp();
    const parent = await openSessionLog({ root, sessionId: 'parent' });
    await parent.append({ t: 'turn.start', turn: 1, input: 'one' });
    await parent.append({ t: 'turn.end', turn: 1, status: 'done' });
    await parent.append({ t: 'turn.start', turn: 2, input: 'two' });
    await parent.close();

    const kept = await forkSessionLog({ root, from: 'parent', to: 'child', upToSeq: 2 });
    expect(kept.map((event) => event.seq)).toEqual([1, 2]);
    expect(await readSessionLog({ root, sessionId: 'parent' })).toHaveLength(3);

    const child = await openSessionLog({ root, sessionId: 'child' });
    expect(child.nextSeq()).toBe(3);
    await child.append({ t: 'turn.end', turn: 2, status: 'done' });
    await child.close();

    expect((await readSessionLog({ root, sessionId: 'child' })).map((e) => e.seq)).toEqual([
      1, 2, 3,
    ]);
    await expect(forkSessionLog({ root, from: 'parent', to: 'child' })).rejects.toThrow();
  });

  it('forks the whole log by default', async () => {
    const root = await tmp();
    const parent = await openSessionLog({ root, sessionId: 'parent' });
    await parent.append({ t: 'turn.start', turn: 1, input: 'one' });
    await parent.close();

    const kept = await forkSessionLog({ root, from: 'parent', to: 'copy' });

    expect(kept).toHaveLength(1);
    expect(await readSessionLog({ root, sessionId: 'copy' })).toEqual(kept);
  });

  it('rejects session ids that could escape the sessions root', async () => {
    const root = await tmp();

    await expect(openSessionLog({ root, sessionId: '../evil' })).rejects.toMatchObject({
      code: SessionLogErrorCode.InvalidId,
    });
    await expect(readSessionLog({ root, sessionId: 'a/b' })).rejects.toMatchObject({
      code: SessionLogErrorCode.InvalidId,
    });
    await expect(readSessionLog({ root, sessionId: '..' })).rejects.toMatchObject({
      code: SessionLogErrorCode.InvalidId,
    });
  });

  it('lists session ids and tolerates a missing root', async () => {
    const root = await tmp();
    expect(await listSessionIds(join(root, 'nope'))).toEqual([]);

    const second = await openSessionLog({ root, sessionId: 'b-session' });
    await second.close();
    const first = await openSessionLog({ root, sessionId: 'a-session' });
    await first.close();

    expect(await listSessionIds(root)).toEqual(['a-session', 'b-session']);
  });

  it('refuses to append after close', async () => {
    const root = await tmp();
    const log = await openSessionLog({ root, sessionId: 's1' });
    await log.close();

    await expect(log.append({ t: 'turn.start', turn: 1, input: 'late' })).rejects.toMatchObject({
      code: SessionLogErrorCode.Closed,
    });
  });
});
