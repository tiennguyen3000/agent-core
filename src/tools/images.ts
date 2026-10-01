/**
 * `fs_read_image`: turn an image file into a stored attachment.
 *
 * The tool does not put bytes into the transcript by itself — that is the
 * message layer's job (`Message.parts`). It validates the file by magic bytes,
 * stores it content-addressed and reports the attachment id, so the loop can
 * attach it to the next request and a vision route can render it.
 */

import { z } from 'zod';
import { sniffImageMime } from '../context/attachments.js';
import type { AttachmentStore } from '../context/attachments.js';
import { resolveToolPath } from './paths.js';
import { ToolErrorCode } from './registry.js';
import type { ToolDef, ToolResult } from './registry.js';

const DEFAULT_MAX_BYTES = 5 * 1_024 * 1_024;

const readImageSchema = z.object({
  path: z.string().min(1).describe('Image path, relative to the workspace or absolute.'),
});

export interface ReadImageConfig {
  readonly store: AttachmentStore;
  readonly maxBytes?: number;
}

function fail(code: string, output: string): ToolResult {
  return { ok: false, code, output };
}

export function createReadImageTool(
  config: ReadImageConfig,
): ToolDef<z.infer<typeof readImageSchema>> {
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    name: 'fs_read_image',
    description:
      'Read a png/jpeg/webp/gif image and register it as an attachment that can be sent to a vision model. Returns the attachment id, not the bytes.',
    schema: readImageSchema,
    parallelSafe: true,
    requiresApproval: 'never',
    timeoutMs: 15_000,
    maxInlineTokens: 400,
    run: async (args, ctx) => {
      const { absolute, relative } = resolveToolPath(ctx.workdir, args.path);

      if (!(await ctx.fs.exists(absolute))) {
        return fail(ToolErrorCode.NotFound, `${relative} does not exist.`);
      }
      if (ctx.fs.readBytes === undefined) {
        return fail(
          ToolErrorCode.ToolFailed,
          'This filesystem port cannot read raw bytes, so images are unavailable.',
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = await ctx.fs.readBytes(absolute);
      } catch (error) {
        return fail(
          ToolErrorCode.ToolFailed,
          `Could not read ${relative}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (bytes.byteLength > maxBytes) {
        return fail(
          ToolErrorCode.TooLarge,
          `${relative} is ${String(bytes.byteLength)} bytes, over the ${String(maxBytes)} byte image limit.`,
        );
      }

      const mimeType = sniffImageMime(bytes);
      if (mimeType === undefined) {
        return fail(
          ToolErrorCode.BadArgs,
          `${relative} is not a png, jpeg, webp or gif image (checked the magic bytes, not the extension).`,
        );
      }

      const attachment = await config.store.put(bytes, { mimeType, name: relative });
      return {
        ok: true,
        output: `Read ${relative} as ${mimeType} (${String(attachment.bytes)} bytes). Attachment: ${attachment.id}`,
        meta: { attachment },
      };
    },
  };
}
