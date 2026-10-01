/**
 * MCP tools as ordinary `ToolDef`s.
 *
 * An MCP tool's schema comes from its server, so it is advertised verbatim
 * (`jsonSchema`) while runtime validation stays permissive: the server owns the
 * argument contract, and this layer must not reject what the server would
 * accept. Names are namespaced (`mcp__<server>__<tool>`) so two servers cannot
 * collide.
 */

import { z } from 'zod';
import type { McpClient, McpToolInfo } from '../mcp/client.js';
import { ToolErrorCode } from './registry.js';
import type { ToolDef, ToolResult } from './registry.js';

export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

export interface McpToolsetConfig {
  readonly client: McpClient;
  readonly parallelSafe?: boolean;
  /** `policy` models an MCP call as network egress so the gate can decide. */
  readonly approval?: 'never' | 'policy';
  readonly maxInlineTokens?: number;
  readonly timeoutMs?: number;
}

function toToolDef(
  client: McpClient,
  info: McpToolInfo,
  config: McpToolsetConfig,
): ToolDef<Record<string, unknown>> {
  const approval = config.approval ?? 'never';
  const name = mcpToolName(client.serverName, info.name);
  const run = async (args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const result = await client.callTool(info.name, args);
      return result.ok
        ? { ok: true, output: result.text }
        : { ok: false, code: ToolErrorCode.McpFailed, output: result.text };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return {
        ok: false,
        code: typeof code === 'string' ? code : ToolErrorCode.McpFailed,
        output: `MCP call ${info.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  const shared = {
    name,
    description: `${info.description || 'MCP tool'} (MCP server: ${client.serverName})`,
    schema: z.record(z.string(), z.unknown()),
    jsonSchema: info.inputSchema,
    parallelSafe: config.parallelSafe ?? false,
    timeoutMs: config.timeoutMs ?? 60_000,
    maxInlineTokens: config.maxInlineTokens ?? 2_000,
    run,
  };

  if (approval === 'policy') {
    return {
      ...shared,
      requiresApproval: 'policy',
      action: () => ({
        kind: 'net.fetch' as const,
        url: `mcp://${client.serverName}/${info.name}`,
      }),
    };
  }
  return { ...shared, requiresApproval: 'never' };
}

export async function createMcpToolset(
  config: McpToolsetConfig,
): Promise<readonly ToolDef<Record<string, unknown>>[]> {
  const tools = await config.client.listTools();
  return tools.map((info) => toToolDef(config.client, info, config));
}
