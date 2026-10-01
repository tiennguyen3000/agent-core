import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { McpError, createMcpStdioClient } from '../src/index.js';
import type { McpClient } from '../src/index.js';

const serverPath = fileURLToPath(new URL('./helpers/mcp-server.mjs', import.meta.url));

const clients: McpClient[] = [];

function make(options: Record<string, unknown> = {}): McpClient {
  const client = createMcpStdioClient({
    name: 'fixture',
    command: process.execPath,
    args: [serverPath],
    requestTimeoutMs: 10_000,
    ...options,
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined);
  }
});

describe('MCP stdio client', () => {
  it('completes the initialize handshake', async () => {
    const client = make();

    const result = await client.initialize();

    expect(result).toEqual({
      protocolVersion: '2024-11-05',
      serverName: 'fixture',
      serverVersion: '1.2.3',
    });
  });

  it('lists tools with their schemas', async () => {
    const client = make();
    await client.initialize();

    const tools = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'fail', 'hang', 'crash', 'junk']);
    expect(tools[0]?.description).toBe('Echo text back.');
    expect(tools[0]?.inputSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
    });
  });

  it('calls a tool and joins its text content', async () => {
    const client = make();
    await client.initialize();

    const result = await client.callTool('echo', { text: 'hello mcp' });

    expect(result.ok).toBe(true);
    expect(result.text).toBe('hello mcp');
  });

  it('surfaces a tool-reported failure as isError', async () => {
    const client = make();
    await client.initialize();

    const result = await client.callTool('fail', {});

    expect(result.ok).toBe(false);
    expect(result.text).toBe('boom');
  });

  it('turns a JSON-RPC error into a stable code', async () => {
    const client = make();
    await client.initialize();

    await expect(client.callTool('missing', {})).rejects.toMatchObject({
      name: 'McpError',
      code: 'E_MCP_FAILED',
    });
  });

  it('times out a server that never answers', async () => {
    const deadlines: (() => void)[] = [];
    const client = make({
      schedule: (fn: () => void) => {
        deadlines.push(fn);
        return () => undefined;
      },
    });
    await client.initialize();

    const pending = client.callTool('hang', {});
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(deadlines.length).toBeGreaterThan(0);
    for (const fire of deadlines.splice(0)) {
      fire();
    }

    await expect(pending).rejects.toMatchObject({ code: 'E_MCP_TIMEOUT' });
  });

  it('rejects pending work when the server dies', async () => {
    const client = make();
    await client.initialize();

    await expect(client.callTool('crash', {})).rejects.toMatchObject({
      code: 'E_MCP_CLOSED',
    });
  });

  it('ignores a malformed line and still answers the real request', async () => {
    const client = make();
    await client.initialize();

    const result = await client.callTool('junk', {});

    expect(result.ok).toBe(true);
    expect(result.text).toBe('ok');
  });

  it('refuses new work after close', async () => {
    const client = make();
    await client.initialize();
    await client.close();

    await expect(client.callTool('echo', { text: 'x' })).rejects.toMatchObject({
      code: 'E_MCP_CLOSED',
    });
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('reports a start failure instead of hanging', async () => {
    const client = make({ command: '/nonexistent/mcp-server-binary' });

    await expect(client.initialize()).rejects.toBeInstanceOf(McpError);
  });
});
