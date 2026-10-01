/**
 * Deterministic scripted provider for tests and for local development without
 * network access.
 *
 * Invariant 10: no timers, no randomness, no I/O — a script always replays the
 * same deltas in the same order. Cancellation is honoured between deltas
 * (invariant 5).
 */

import type { LLMDelta, LLMProvider, LLMRequest } from './types.js';

export interface FakeScript {
  readonly deltas: readonly LLMDelta[];
  /** When set, the stream emits this many deltas then stops with `errorCode`. */
  readonly failAfterDeltas?: number;
  readonly errorCode?: string;
}

export class FakeProvider implements LLMProvider {
  readonly id = 'fake';
  /** Every request the provider received, in order, for assertions. */
  readonly requests: LLMRequest[] = [];

  readonly #scripts: FakeScript[];
  #cursor = 0;

  constructor(scripts: FakeScript | readonly FakeScript[]) {
    const list: readonly FakeScript[] = Array.isArray(scripts)
      ? (scripts as readonly FakeScript[])
      : [scripts as FakeScript];
    this.#scripts = [...list];
  }

  /** Scripts not yet consumed. */
  get remaining(): number {
    return this.#scripts.length - this.#cursor;
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMDelta> {
    this.requests.push(request);

    const script = this.#scripts[this.#cursor];
    this.#cursor += 1;

    if (script === undefined) {
      yield { type: 'stop', reason: 'error', errorCode: 'E_FAKE_SCRIPT_EXHAUSTED' };
      return;
    }

    let emitted = 0;
    for (const delta of script.deltas) {
      if (request.signal.aborted) {
        yield { type: 'stop', reason: 'cancelled' };
        return;
      }
      if (script.failAfterDeltas !== undefined && emitted >= script.failAfterDeltas) {
        yield script.errorCode === undefined
          ? { type: 'stop', reason: 'error' }
          : { type: 'stop', reason: 'error', errorCode: script.errorCode };
        return;
      }
      emitted += 1;
      yield delta;
    }

    // A script that ends with its own stop is authoritative; only add the
    // implicit one when the script did not say how the stream ends.
    const scriptDeclaresStop = script.deltas.some((delta) => delta.type === 'stop');
    if (!scriptDeclaresStop) {
      yield { type: 'stop', reason: 'end' };
    }
  }
}

/** Builds the common "text then finish" script. */
export function textScript(text: string): FakeScript {
  return { deltas: [{ type: 'text', text }] };
}
