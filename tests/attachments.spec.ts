import { afterEach, describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import {
  ToolErrorCode,
  ToolRegistry,
  createLocalAttachmentStore,
  createReadImageTool,
  sniffImageMime,
} from '../src/index.js';
import { makeCtx, memoryFs } from './helpers/ctx.js';
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => removeTmpDir(dir)));
});

async function tmp(): Promise<string> {
  const dir = await makeTmpDir();
  dirs.push(dir);
  return dir;
}

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const GIF_HEADER = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]);
const WEBP_HEADER = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1,
]);

describe('sniffImageMime', () => {
  it('recognises the supported formats by magic bytes', () => {
    expect(sniffImageMime(PNG_HEADER)).toBe('image/png');
    expect(sniffImageMime(JPEG_HEADER)).toBe('image/jpeg');
    expect(sniffImageMime(GIF_HEADER)).toBe('image/gif');
    expect(sniffImageMime(WEBP_HEADER)).toBe('image/webp');
  });

  it('rejects anything else, including a text file named .png', () => {
    expect(sniffImageMime(new TextEncoder().encode('not an image at all'))).toBeUndefined();
    expect(sniffImageMime(new Uint8Array([]))).toBeUndefined();
  });
});

describe('local attachment store', () => {
  it('stores bytes content-addressed and deduplicates', async () => {
    const dir = await tmp();
    const store = createLocalAttachmentStore({ dir });

    const first = await store.put(PNG_HEADER, { mimeType: 'image/png', name: 'a.png' });
    const second = await store.put(PNG_HEADER, { mimeType: 'image/png', name: 'b.png' });

    expect(first.id).toBe(second.id);
    expect(first.id.endsWith('.png')).toBe(true);
    expect(first.bytes).toBe(PNG_HEADER.byteLength);
    expect(await readdir(dir)).toHaveLength(1);
    expect(await store.has(first.id)).toBe(true);
  });

  it('reads the bytes back', async () => {
    const dir = await tmp();
    const store = createLocalAttachmentStore({ dir });

    const attachment = await store.put(JPEG_HEADER, { mimeType: 'image/jpeg' });
    const bytes = await store.get(attachment.id);

    expect(bytes).toEqual(JPEG_HEADER);
    expect(await store.get('missing.png')).toBeUndefined();
  });

  it('falls back to a bin extension for an unknown mime type', async () => {
    const dir = await tmp();
    const store = createLocalAttachmentStore({ dir });

    const attachment = await store.put(GIF_HEADER, { mimeType: 'application/octet-stream' });

    expect(attachment.id.endsWith('.bin')).toBe(true);
  });
});

describe('fs_read_image', () => {
  async function setup(files: Record<string, Uint8Array>) {
    const dir = await tmp();
    const store = createLocalAttachmentStore({ dir });
    const registry = new ToolRegistry();
    registry.register(createReadImageTool({ store, maxBytes: 64 }));
    const fs = memoryFs({ root: '/ws', binary: files });
    return { store, registry, ctx: makeCtx({ workdir: '/ws', fs }) };
  }

  it('stores an image and reports its attachment id', async () => {
    const { registry, ctx, store } = await setup({ 'shot.png': PNG_HEADER });

    const result = await registry.dispatch('fs_read_image', { path: 'shot.png' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('image/png');
    const attachment = (result.meta?.attachment ?? {}) as { id?: string };
    expect(attachment.id).toBeDefined();
    expect(await store.has(attachment.id ?? '')).toBe(true);
  });

  it('refuses a file that is not really an image', async () => {
    const { registry, ctx } = await setup({
      'fake.png': new TextEncoder().encode('definitely not a png'),
    });

    const result = await registry.dispatch('fs_read_image', { path: 'fake.png' }, ctx);

    expect(result.code).toBe(ToolErrorCode.BadArgs);
    expect(result.output).toContain('magic bytes');
  });

  it('refuses a missing file', async () => {
    const { registry, ctx } = await setup({});

    const result = await registry.dispatch('fs_read_image', { path: 'nope.png' }, ctx);

    expect(result.code).toBe(ToolErrorCode.NotFound);
  });

  it('refuses an image over the configured size limit', async () => {
    const big = new Uint8Array(200);
    big.set(PNG_HEADER);
    const { registry, ctx } = await setup({ 'big.png': big });

    const result = await registry.dispatch('fs_read_image', { path: 'big.png' }, ctx);

    expect(result.code).toBe(ToolErrorCode.TooLarge);
    expect(result.output).toContain('64 byte image limit');
  });

  it('is a read-only, parallel-safe tool', () => {
    const dir = '/tmp/dsh-attachments-probe';
    const tool = createReadImageTool({ store: createLocalAttachmentStore({ dir }) });

    expect(tool.parallelSafe).toBe(true);
    expect(tool.requiresApproval).toBe('never');
    expect(tool.name).toBe('fs_read_image');
  });
});
