import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test scratch space lives inside the repository (gitignored) so the suite
 * never writes outside the workspace and never touches the network.
 */
const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));

export async function makeTmpDir(): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true });
  return await mkdtemp(join(TMP_ROOT, 'case-'));
}

export async function removeTmpDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
