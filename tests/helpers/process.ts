/**
 * Process helpers for job tests.
 *
 * `untilAsync` waits with `setImmediate` (an event-loop turn) rather than a
 * clock, so tests assert "the child is gone" without sleeping.
 */
export async function untilAsync(
  predicate: () => boolean,
  label: string,
  attempts = 500,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(`condition never became true: ${label}`);
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
