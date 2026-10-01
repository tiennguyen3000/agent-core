import type { SessionEvent } from '../../src/session/events.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event literal without its `seq`; `withSeq` assigns contiguous seqs. */
export type SeqlessEvent = DistributiveOmit<SessionEvent, 'seq'>;

/**
 * Assigns `seq = index + 1` so tests describe facts, not bookkeeping. The log
 * writer in M2 does the same thing for real.
 */
export function withSeq(events: readonly SeqlessEvent[]): SessionEvent[] {
  return events.map((event, index) => ({ ...event, seq: index + 1 }) as SessionEvent);
}
