/**
 * Attachment storage (the "durable files" side of images).
 *
 * Content-addressed: the id is the sha256 of the bytes plus the extension, so
 * the same image uploaded twice is stored once and an id is self-describing
 * (no index file to keep in sync). The store is deliberately separate from the
 * session workspace: images live below DSH_HOME-like storage, not in the repo
 * the agent is editing.
 */

import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Attachment {
  readonly id: string;
  readonly path: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly name: string | undefined;
}

export interface AttachmentStore {
  put(bytes: Uint8Array, options: { mimeType: string; name?: string }): Promise<Attachment>;
  get(id: string): Promise<Uint8Array | undefined>;
  has(id: string): Promise<boolean>;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Magic-byte detection: never trust the file extension alone. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

export interface LocalAttachmentStoreOptions {
  readonly dir: string;
}

export function createLocalAttachmentStore(
  options: LocalAttachmentStoreOptions,
): AttachmentStore {
  const extensionFor = (mimeType: string): string => EXTENSIONS[mimeType] ?? 'bin';
  const pathFor = (id: string): string => join(options.dir, id);

  const describe = (
    id: string,
    bytes: Uint8Array,
    mimeType: string,
    name: string | undefined,
  ): Attachment => ({
    id,
    path: pathFor(id),
    bytes: bytes.byteLength,
    mimeType,
    name,
  });

  return {
    async put(bytes, putOptions) {
      const digest = createHash('sha256').update(bytes).digest('hex');
      const id = `${digest}.${extensionFor(putOptions.mimeType)}`;
      const path = pathFor(id);

      await mkdir(options.dir, { recursive: true });
      try {
        // `wx` fails when the content is already stored: dedupe for free.
        const handle = await open(path, 'wx');
        try {
          await handle.write(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'EEXIST') {
          throw error;
        }
      }

      return describe(id, bytes, putOptions.mimeType, putOptions.name);
    },

    async get(id) {
      try {
        return new Uint8Array(await readFile(pathFor(id)));
      } catch {
        return undefined;
      }
    },

    async has(id) {
      try {
        await readFile(pathFor(id));
        return true;
      } catch {
        return false;
      }
    },
  };
}
