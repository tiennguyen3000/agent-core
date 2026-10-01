import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  ToolErrorCode,
  ToolRegistry,
  createMcpStdioClient,
  createMcpToolset,
  mcpToolName,
} from '../src/index.js';
import type { McpClient, McpToolInfo, ToolDef } from '../src/index.js';
import { makeCtx } from './helpers/ctx.js';

const serverPath = fileURLToPath(new URL('./helpers/mcp-server.mjs', import.meta.url));
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
});

/** A client double so the toolset can be tested without a process. */
function fakeClient(overrides: Partial<McpClient> = {}): McpClient & { readonly calls: unknown[] } {
  const calls: unknown[] = [];
  const tools: McpToolInfo[] = [
    {
      name: 'echo',
      description: 'Echo text back.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  ];
  const base: McpClient = {
    serverName: 'fake',
    stderr: '',
    initialize: async () => ({
      serverName: 'fake',
      serverVersion: '0.0.1',
      protocolVersion: '2024-11-05',
    }),
    listTools: async () => tools,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, text: `called ${name}`, raw: {} };
    },
    close: async () => undefined,
  };
  return Object.assign({ calls }, base, overrides);
}

describe('createMcpToolset', () => {
  it('namespaces tool names per server', async () => {
    const client = fakeClient();
    const tools = await createMcpToolset({ client });

    expect(tools.map((tool) => tool.name)).toEqual([mcpToolName('fake', 'echo')]);
    expect(tools[0]?.name).toBe('mcp__fake__echo');
    expect(tools[0]?.description).toContain('MCP server: fake');
  });

  it('advertises the server schema, not the permissive local one', async () => {
    const client = fakeClient();
    const registry = new ToolRegistry();
    for (const tool of await createMcpToolset({ client })) {
      registry.register(tool);
    }

    const [schema] = registry.schemas();

    expect(schema?.parameters).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
  });

  it('passes arguments through and returns the text', async () => {
    const client = fakeClient();
    const registry = new ToolRegistry();
    for (const tool of await createMcpToolset({ client })) {
      registry.register(tool);
    }

    const result = await registry.dispatch('mcp__fake__echo', { text: 'hi' }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.output).toBe('called echo');
    expect(client.calls).toEqual([{ name: 'echo', args: { text: 'hi' } }]);
  });

  it('maps a failing call to E_MCP_FAILED', async () => {
    const client = fakeClient({
      callTool: async () => ({ ok: false, text: 'server said no', raw: {} }),
    });
    const registry = new ToolRegistry();
    for (const tool of await createMcpToolset({ client })) {
      registry.register(tool);
    }

    const result = await registry.dispatch('mcp__fake__echo', {}, makeCtx());

    expect(result.code).toBe(ToolErrorCode.McpFailed);
    expect(result.output).toBe('server said no');
  });

  it('maps a thrown client error with its own code', async () => {
    const client = fakeClient({
      callTool: async () => {
        const error = new Error('server is gone') as Error & { code: string };
        error.code = ToolErrorCode.McpClosed;
        throw error;
      },
    });
    const registry = new ToolRegistry();
    for (const tool of await createMcpToolset({ client })) {
      registry.register(tool);
    }

    const result = await registry.dispatch('mcp__fake__echo', {}, makeCtx());

    expect(result.code).toBe(ToolErrorCode.McpClosed);
  });

  it('models a policy-gated MCP call as network egress', async () => {
    const client = fakeClient();
    const tools = await createMcpToolset({ client, approval: 'policy' });
    const tool: ToolDef<Record<string, unknown>> | undefined = tools[0];

    expect(tool?.requiresApproval).toBe('policy');
    if (tool === undefined || tool.requiresApproval === 'never') {
      throw new Error('expected the policy branch');
    }
    expect(tool.action({}, makeCtx())).toEqual({
      kind: 'net.fetch',
      url: 'mcp://fake/echo',
    });
  });

  it('is exclusive by default and not approval-free for mutations', async () => {
    const client = fakeClient();
    const tools = await createMcpToolset({ client });

    expect(tools[0]?.parallelSafe).toBe(false);
    expect(tools[0]?.requiresApproval).toBe('never');
  });
});

describe('MCP tools against a real server', () => {
  it('round-trips a tool call through the toolset', async () => {
    const client = createMcpStdioClient({
      name: 'fixture',
      command: process.execPath,
      args: [serverPath],
      requestTimeoutMs: 10_000,
    });
    closers.push(() => client.close());
    await client.initialize();

    const registry = new ToolRegistry();
    for (const tool of await createMcpToolset({ client })) {
      registry.register(tool);
    }

    const names = registry.names();
    expect(names).toContain('mcp__fixture__echo');

    const result = await registry.dispatch(
      'mcp__fixture__echo',
      { text: 'through the wire' },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBe('through the wire');
  });

  it('reports a tool-level failure from the real server', async () => {
    const client = createMcpStdioClient({
      name: 'fixture',
      command: process.execPath,
      args: [serverPath],
      requestTimeoutMs: 10_000,
    });
    closers.push(() => client.close());
    await client.initialize();

    const registry = new ToolRegistry();
    for (const tool of await createMcpToolset({ client })) {
      registry.register(tool);
    }

    const result = await registry.dispatch('mcp__fixture__fail', {}, makeCtx());

    expect(result.code).toBe(ToolErrorCode.McpFailed);
    expect(result.output).toBe('boom');
  });
});
