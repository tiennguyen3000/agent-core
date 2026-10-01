/**
 * Durable session log (invariant 1).
 *
 * The log is an append-only JSONL file. Every append is written and `fsync`ed
 * before it is acknowledged, so a crash can lose at most a torn tail — and a
 * torn tail is repaired on the next open instead of corrupting the file.
 *
 * Layout: `<root>/<sessionId>/session.jsonl` plus `session.lock`.
 *
 * Failure policy:
 *  - a broken *last* line is treated as a torn write and dropped;
 *  - a broken line anywhere else refuses to load (silent data loss is worse);
 *  - a non-contiguous `seq` refuses to load.
 */

import { mkdir, open, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent } from './events.js';

export const SessionLogErrorCode = {
  Corrupt: 'E_LOG_CORRUPT',
  SeqGap: 'E_LOG_SEQ_GAP',
  Locked: 'E_LOG_LOCKED',
  InvalidId: 'E_LOG_INVALID_ID',
  Io: 'E_LOG_IO',
  Closed: 'E_LOG_CLOSED',
} as const;

export type SessionLogErrorCodeValue =
  (typeof SessionLogErrorCode)[keyof typeof SessionLogErrorCode];

export class SessionLogError extends Error {
  readonly code: SessionLogErrorCodeValue;
  readonly line: number | undefined;

  constructor(code: SessionLogErrorCodeValue, message: string, line?: number) {
    super(message);
    this.name = 'SessionLogError';
    this.code = code;
    this.line = line;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as a caller supplies it: the log owns `seq` and `at`. */
export type SessionEventInput = DistributiveOmit<SessionEvent, 'seq' | 'at'>;

const LOG_FILE = 'session.jsonl';
const LOCK_FILE = 'session.lock';

export interface SessionLog {
  readonly sessionId: string;
  readonly dir: string;
  readonly path: string;
  readonly lockPath: string;
  readonly count: number;
  nextSeq(): number;
  append(input: SessionEventInput): Promise<SessionEvent>;
  readAll(): readonly SessionEvent[];
  close(): Promise<void>;
}

export interface OpenSessionLogOptions {
  readonly root: string;
  readonly sessionId: string;
  /** Default true: every append is durable before it resolves. */
  readonly fsync?: boolean;
  readonly now?: () => number;
  /** Default true. Pass false for read-mostly reopen after an unclean exit. */
  readonly lock?: boolean;
  /** Default true: take over a lock whose owner is gone. */
  readonly stealStaleLock?: boolean;
}

export interface ForkSessionLogOptions {
  readonly root: string;
  readonly from: string;
  readonly to: string;
  /** Inclusive upper bound; defaults to the whole log. */
  readonly upToSeq?: number;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

function isSessionEvent(value: unknown): value is SessionEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { seq?: unknown; t?: unknown; at?: unknown };
  return (
    typeof candidate.seq === 'number' &&
    Number.isInteger(candidate.seq) &&
    typeof candidate.t === 'string' &&
    typeof candidate.at === 'number'
  );
}

function sanitizeSessionId(sessionId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new SessionLogError(
      SessionLogErrorCode.InvalidId,
      `Invalid session id ${JSON.stringify(sessionId)}: use letters, digits, dot, dash or underscore.`,
    );
  }
  return sessionId;
}

export function sessionDir(root: string, sessionId: string): string {
  return join(root, sanitizeSessionId(sessionId));
}

export function sessionLogPath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), LOG_FILE);
}

interface ParsedLog {
  readonly events: SessionEvent[];
  /** Byte length of the prefix that is safe to keep. */
  readonly validBytes: number;
  readonly repairedTail: boolean;
}

/**
 * Parses a JSONL log. A line that does not parse is tolerated only when it is
 * the final piece of content in the file (a torn write); anything else throws.
 */
function parseJsonl(raw: string, path: string): ParsedLog {
  const events: SessionEvent[] = [];
  let index = 0;
  let validBytes = 0;
  let repairedTail = false;
  let lineNumber = 0;

  while (index < raw.length) {
    const newlineAt = raw.indexOf('\n', index);
    const atEnd = newlineAt === -1;
    const line = atEnd ? raw.slice(index) : raw.slice(index, newlineAt);
    const lineEnd = atEnd ? raw.length : newlineAt + 1;
    lineNumber += 1;

    if (line.trim() === '') {
      index = lineEnd;
      validBytes = lineEnd;
      continue;
    }

    const parsed = tryParse(line);
    if (!isSessionEvent(parsed)) {
      const isTail = raw.slice(lineEnd).trim() === '';
      if (isTail) {
        repairedTail = true;
        break;
      }
      throw new SessionLogError(
        SessionLogErrorCode.Corrupt,
        `Corrupt session log at ${path}:${lineNumber}. Refusing to continue so no event is lost silently.`,
        lineNumber,
      );
    }

    events.push(parsed);
    index = lineEnd;
    validBytes = lineEnd;
  }

  events.forEach((event, position) => {
    const expected = position + 1;
    if (event.seq !== expected) {
      throw new SessionLogError(
        SessionLogErrorCode.SeqGap,
        `Session log ${path} has seq ${event.seq} at position ${position}, expected ${expected}.`,
        position + 1,
      );
    }
  });

  return { events, validBytes, repairedTail };
}

/** Reads a log without mutating it. Missing sessions read as an empty list. */
export async function readSessionLog(options: {
  readonly root: string;
  readonly sessionId: string;
}): Promise<readonly SessionEvent[]> {
  const path = sessionLogPath(options.root, options.sessionId);
  const raw = await readTextIfExists(path);
  if (raw === undefined || raw.length === 0) {
    return [];
  }
  return parseJsonl(raw, path).events;
}

export async function listSessionIds(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
}

interface LockPayload {
  readonly pid: number;
  readonly host: string;
  readonly at: number;
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return isErrno(error, 'EPERM');
  }
}

async function isLockStale(lockPath: string): Promise<boolean> {
  const raw = await readTextIfExists(lockPath);
  if (raw === undefined) {
    return true;
  }
  const payload = tryParse(raw) as LockPayload | undefined;
  if (payload === undefined || typeof payload.pid !== 'number') {
    return true;
  }
  if (payload.host !== hostname()) {
    // A lock from another machine is never stolen.
    return false;
  }
  return !isProcessAlive(payload.pid);
}

async function acquireLock(lockPath: string, stealStale: boolean): Promise<void> {
  const payload: LockPayload = { pid: process.pid, host: hostname(), at: Date.now() };
  const body = JSON.stringify(payload);

  try {
    await writeFile(lockPath, body, { flag: 'wx' });
    return;
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) {
      throw new SessionLogError(
        SessionLogErrorCode.Io,
        `Cannot create lock ${lockPath}: ${String(error)}`,
      );
    }
  }

  if (!stealStale || !(await isLockStale(lockPath))) {
    throw new SessionLogError(
      SessionLogErrorCode.Locked,
      `Session log is locked by another process (${lockPath}).`,
    );
  }

  await rm(lockPath, { force: true });
  try {
    await writeFile(lockPath, body, { flag: 'wx' });
  } catch {
    throw new SessionLogError(
      SessionLogErrorCode.Locked,
      `Session log is locked by another process (${lockPath}).`,
    );
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  const raw = await readTextIfExists(lockPath);
  if (raw !== undefined) {
    const payload = tryParse(raw) as LockPayload | undefined;
    if (payload !== undefined && typeof payload.pid === 'number' && payload.pid !== process.pid) {
      return;
    }
  }
  await rm(lockPath, { force: true });
}

class JsonlSessionLog implements SessionLog {
  readonly sessionId: string;
  readonly dir: string;
  readonly path: string;
  readonly lockPath: string;

  readonly #events: SessionEvent[];
  readonly #handle: FileHandle;
  readonly #fsync: boolean;
  readonly #now: () => number;
  readonly #lockHeld: boolean;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(init: {
    sessionId: string;
    dir: string;
    path: string;
    lockPath: string;
    events: SessionEvent[];
    handle: FileHandle;
    fsync: boolean;
    now: () => number;
    lockHeld: boolean;
  }) {
    this.sessionId = init.sessionId;
    this.dir = init.dir;
    this.path = init.path;
    this.lockPath = init.lockPath;
    this.#events = init.events;
    this.#handle = init.handle;
    this.#fsync = init.fsync;
    this.#now = init.now;
    this.#lockHeld = init.lockHeld;
  }

  get count(): number {
    return this.#events.length;
  }

  nextSeq(): number {
    return this.#events.length + 1;
  }

  readAll(): readonly SessionEvent[] {
    return [...this.#events];
  }

  append(input: SessionEventInput): Promise<SessionEvent> {
    const run = this.#queue.then(() => this.#appendNow(input));
    // Keep the chain usable after a failed append instead of poisoning it.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(): Promise<void> {
    await this.#queue;
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#handle.close();
    if (this.#lockHeld) {
      await releaseLock(this.lockPath);
    }
  }

  async #appendNow(input: SessionEventInput): Promise<SessionEvent> {
    if (this.#closed) {
      throw new SessionLogError(
        SessionLogErrorCode.Closed,
        `Session log ${this.sessionId} is closed.`,
      );
    }
    const event = {
      ...input,
      seq: this.#events.length + 1,
      at: this.#now(),
    } as SessionEvent;

    await this.#handle.write(`${JSON.stringify(event)}\n`);
    if (this.#fsync) {
      await this.#handle.sync();
    }
    this.#events.push(event);
    return event;
  }
}

export async function openSessionLog(options: OpenSessionLogOptions): Promise<SessionLog> {
  const sessionId = sanitizeSessionId(options.sessionId);
  const dir = join(options.root, sessionId);
  const path = join(dir, LOG_FILE);
  const lockPath = join(dir, LOCK_FILE);
  const wantLock = options.lock ?? true;

  await mkdir(dir, { recursive: true });

  if (wantLock) {
    await acquireLock(lockPath, options.stealStaleLock ?? true);
  }

  try {
    const raw = await readTextIfExists(path);
    let events: SessionEvent[] = [];
    if (raw !== undefined && raw.length > 0) {
      const parsed = parseJsonl(raw, path);
      events = parsed.events;
      if (parsed.validBytes !== raw.length) {
        // Drop a torn tail before appending, otherwise the next line would be
        // concatenated onto the fragment and corrupt the log for good.
        await truncate(path, parsed.validBytes);
      }
    }

    const handle = await open(path, 'a');
    return new JsonlSessionLog({
      sessionId,
      dir,
      path,
      lockPath,
      events,
      handle,
      fsync: options.fsync ?? true,
      now: options.now ?? (() => Date.now()),
      lockHeld: wantLock,
    });
  } catch (error) {
    if (wantLock) {
      await releaseLock(lockPath).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Copies the prefix of a session into a new session id, preserving seq numbers.
 * The source log is never modified and an existing target is refused.
 */
export async function forkSessionLog(
  options: ForkSessionLogOptions,
): Promise<readonly SessionEvent[]> {
  const source = await readSessionLog({ root: options.root, sessionId: options.from });
  const upTo = options.upToSeq ?? Number.POSITIVE_INFINITY;
  const kept = source.filter((event) => event.seq <= upTo);

  const targetDir = sessionDir(options.root, options.to);
  await mkdir(targetDir, { recursive: false });

  const targetPath = join(targetDir, LOG_FILE);
  const body = kept.map((event) => `${JSON.stringify(event)}\n`).join('');
  const handle = await open(targetPath, 'w');
  try {
    await handle.write(body);
    await handle.sync();
  } finally {
    await handle.close();
  }

  return kept;
}
