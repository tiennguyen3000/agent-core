import { describe, expect, it } from 'vitest';
import { z, toJSONSchema } from 'zod';
import { ToolRegistry } from '../src/index.js';
import type { ToolDef } from '../src/index.js';
import { makeCtx } from './helpers/ctx.js';

const readSchema = z.object({
  path: z.string().describe('Workspace-relative file path'),
  lines: z.number().int().optional(),
});

function readTool(schema: typeof readSchema): ToolDef<z.infer<typeof readSchema>> {
  return {
    name: 'fs.read',
    description: 'Read a UTF-8 file.',
    schema,
    parallelSafe: true,
    requiresApproval: 'never',
    timeoutMs: 1_000,
    run: async (args) => ({ ok: true, output: `read ${args.path}` }),
  };
}

describe('invariant-4: one source of truth for tool schemas', () => {
  it('invariant-4: the model-facing schema is generated from the zod schema', () => {
    const registry = new ToolRegistry();
    registry.register(readTool(readSchema));

    const [schema] = registry.schemas();

    expect(schema).toBeDefined();
    expect(schema?.name).toBe('fs.read');
    expect(schema?.parameters).toEqual(toJSONSchema(readSchema));
  });

  it('invariant-4: the generated schema reflects the declared shape', () => {
    const registry = new ToolRegistry();
    registry.register(readTool(readSchema));

    const parameters = registry.schemas()[0]?.parameters as {
      type?: string;
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };

    expect(parameters.type).toBe('object');
    expect(parameters.properties?.path?.type).toBe('string');
    expect(parameters.properties?.lines?.type).toBe('integer');
    expect(parameters.required).toContain('path');
    expect(parameters.required ?? []).not.toContain('lines');
    expect(JSON.stringify(parameters)).toContain('Workspace-relative file path');
  });

  it('invariant-4: changing the zod schema changes what the model sees', () => {
    const extended = readSchema.extend({ encoding: z.string() });
    const before = new ToolRegistry();
    const after = new ToolRegistry();
    before.register(readTool(readSchema));
    after.register(readTool(extended));

    expect(after.schemas()[0]?.parameters).not.toEqual(before.schemas()[0]?.parameters);
  });

  it('invariant-4: validation and schema generation agree on the same object', async () => {
    const registry = new ToolRegistry();
    registry.register(readTool(readSchema));
    const ctx = makeCtx();

    const good = await registry.dispatch('fs.read', { path: 'a.txt', lines: 2 }, ctx);
    const bad = await registry.dispatch('fs.read', { path: 'a.txt', lines: 'two' }, ctx);

    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('E_BAD_ARGS');
    expect(bad.output).toContain('lines');
  });
});
