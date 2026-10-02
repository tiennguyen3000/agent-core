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

/**
 * A command that blocks for ~30 seconds, spelled for the platform's shell.
 * `&&` and these commands exist in both cmd.exe and sh, and neither needs
 * quoting that would survive `shell: true` differently on Windows.
 */
export const LONG_RUNNING_COMMAND =
  process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30';

/** Prints the current directory: `cd` on Windows, `pwd` elsewhere. */
export const PRINT_CWD_COMMAND = process.platform === 'win32' ? 'cd' : 'pwd';
