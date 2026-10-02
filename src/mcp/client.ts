/**
 * Minimal MCP client over stdio.
 *
 * The transport is newline-delimited JSON-RPC 2.0: one message per line, no
 * Content-Length framing. Only what a tool consumer needs is implemented —
 * `initialize`, `tools/list`, `tools/call` — and anything the server sends that
 * is not a response to one of our requests is ignored rather than guessed at.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { z } from 'zod';
import { DEFAULT_ENV_ALLOWLIST } from '../jobs/registry.js';
import type { JsonSchemaObject } from '../llm/types.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
}

export interface McpCallResult {
  readonly ok: boolean;
  readonly text: string;
  readonly raw: unknown;
}

export class McpError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

export interface McpClient {
  readonly serverName: string;
  readonly stderr: string;
  initialize(): Promise<{ serverName: string; serverVersion: string; protocolVersion: string }>;
  listTools(): Promise<readonly McpToolInfo[]>;
  callTool(name: string, args: unknown): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpStdioClientOptions {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly envPassthrough?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly spawnImpl?: typeof nodeSpawn;
  /** Override how the server is launched; defaults to a shell on Windows only. */
  readonly shell?: boolean;
  /** Injectable so the Windows default is testable anywhere. */
  readonly platform?: NodeJS.Platform;
  /** Injectable timer so request timeouts can be driven in tests. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

const toolsListSchema = z.object({
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().nullish(),
        inputSchema: z.record(z.string(), z.unknown()).nullish(),
      }),
    )
    .nullish(),
});

const callResultSchema = z.object({
  content: z
    .array(z.object({ type: z.string(), text: z.string().nullish() }))
    .nullish(),
  isError: z.boolean().nullish(),
});

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cancelTimer(): void;
}

export function createMcpStdioClient(options: McpStdioClientOptions): McpClient {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return () => clearTimeout(timer);
    });

  const source = options.env ?? process.env;
  const names = new Set([...(options.envPassthrough ?? []), ...DEFAULT_ENV_ALLOWLIST]);
  const childEnv: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) {
      childEnv[name] = value;
    }
  }

  // On Windows an MCP server is usually a `.cmd` shim (`npx`, `uvx`), which
  // cannot be spawned directly since Node 18.20/20.12; routing through the
  // command interpreter is the documented workaround. Elsewhere spawning the
  // argv directly keeps quoting unambiguous.
  const useShell = options.shell ?? (options.platform ?? process.platform) === 'win32';
  const child = spawnImpl(options.command, [...(options.args ?? [])], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: childEnv,
    shell: useShell,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let stderr = '';
  let closed = false;
  let nextId = 0;
  const pending = new Map<number, Pending>();

  const exited = new Promise<void>((resolve) => {
    child.on('exit', () => {
      resolve();
    });
    child.on('error', () => {
      resolve();
    });
  });

  const failAll = (message: string, code: string): void => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.cancelTimer();
      entry.reject(new McpError(message, code));
    }
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line.length === 0) {
        continue;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        // A malformed line is the server's problem, not ours: ignore it.
        continue;
      }
      if (typeof message !== 'object' || message === null) {
        continue;
      }
      const record = message as { id?: unknown; error?: unknown; result?: unknown };
      if (typeof record.id !== 'number') {
        // Notifications and server-initiated requests are not supported.
        continue;
      }
      const entry = pending.get(record.id);
      if (entry === undefined) {
        continue;
      }
      pending.delete(record.id);
      entry.cancelTimer();
      if (record.error !== undefined) {
        const detail =
          typeof record.error === 'object' && record.error !== null
            ? ((record.error as { message?: unknown }).message ?? JSON.stringify(record.error))
            : String(record.error);
        entry.reject(new McpError(`MCP error: ${String(detail)}`, 'E_MCP_FAILED'));
      } else {
        entry.resolve(record.result);
      }
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });

  child.on('exit', (code) => {
    const detail = stderr.trim().length > 0 ? `: ${stderr.trim().split('\n').slice(-1)[0]}` : '';
    failAll(`MCP server ${options.name} exited (code ${String(code)})${detail}`, 'E_MCP_CLOSED');
  });
  child.on('error', (error) => {
    failAll(`MCP server ${options.name} failed to start: ${error.message}`, 'E_MCP_CLOSED');
  });

  const send = (method: string, params: unknown): Promise<unknown> => {
    if (closed) {
      return Promise.reject(new McpError('the MCP client is closed', 'E_MCP_CLOSED'));
    }
    nextId += 1;
    const id = nextId;
    return new Promise<unknown>((resolve, reject) => {
      const cancelTimer = schedule(() => {
        pending.delete(id);
        reject(new McpError(`${method} timed out after ${String(timeoutMs)}ms`, 'E_MCP_TIMEOUT'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, cancelTimer });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error !== null && error !== undefined) {
          pending.delete(id);
          cancelTimer();
          reject(new McpError(`could not write to the MCP server: ${error.message}`, 'E_MCP_CLOSED'));
        }
      });
    });
  };

  const notify = (method: string, params: unknown): void => {
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  return {
    serverName: options.name,

    get stderr() {
      return stderr;
    },

    async initialize() {
      const result = (await send('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'agent-core', version: '0.1.0' },
      })) as { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown } };

      notify('notifications/initialized', {});

      return {
        protocolVersion:
          typeof result?.protocolVersion === 'string' ? result.protocolVersion : MCP_PROTOCOL_VERSION,
        serverName:
          typeof result?.serverInfo?.name === 'string' ? result.serverInfo.name : options.name,
        serverVersion:
          typeof result?.serverInfo?.version === 'string' ? result.serverInfo.version : 'unknown',
      };
    },

    async listTools() {
      const parsed = toolsListSchema.safeParse(await send('tools/list', {}));
      if (!parsed.success) {
        throw new McpError('tools/list returned an unexpected shape', 'E_MCP_FAILED');
      }
      return (parsed.data.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as JsonSchemaObject,
      }));
    },

    async callTool(name, args) {
      const parsed = callResultSchema.safeParse(
        await send('tools/call', { name, arguments: args ?? {} }),
      );
      if (!parsed.success) {
        throw new McpError('tools/call returned an unexpected shape', 'E_MCP_FAILED');
      }
      const text = (parsed.data.content ?? [])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text ?? '')
        .join('\n');
      return {
        ok: parsed.data.isError !== true,
        text: text.length > 0 ? text : '(the tool returned no text content)',
        raw: parsed.data,
      };
    },

    async close() {
      if (closed) {
        return;
      }
      closed = true;
      failAll('the MCP client was closed', 'E_MCP_CLOSED');
      child.stdin?.end();
      child.kill('SIGTERM');
      await exited;
    },
  };
}
