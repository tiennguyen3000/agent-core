import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  FakeProvider,
  ToolErrorCode,
  ToolRegistry,
  assembleResponse,
  openSessionLog,
  readSessionLog,
  replay,
  sessionLogPath,
} from '../src/index.js';
import type {
  LLMDelta,
  LLMRequest,
  PolicyGate,
  SessionEvent,
  ToolDef,
  ToolResult,
} from '../src/index.js';
import { makeCtx } from './helpers/ctx.js';
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => removeTmpDir(dir)));
});

const readSchema = z.object({ path: z.string() });
const writeSchema = z.object({ path: z.string(), content: z.string() });

const readTool: ToolDef<z.infer<typeof readSchema>> = {
  name: 'fs.read',
  description: 'Read a UTF-8 file.',
  schema: readSchema,
  parallelSafe: true,
  requiresApproval: 'never',
  timeoutMs: 1_000,
  run: async (args) => ({ ok: true, output: `hello from ${args.path}` }),
};

/** A read that opts into policy so the gate can refuse sensitive paths. */
const guardedReadTool: ToolDef<z.infer<typeof readSchema>> = {
  name: 'fs.read_guarded',
  description: 'Read a file after a policy decision.',
  schema: readSchema,
  parallelSafe: true,
  requiresApproval: 'policy',
  timeoutMs: 1_000,
  action: (args) => ({ kind: 'fs.read', path: args.path }),
  run: async (args) => ({ ok: true, output: `hello from ${args.path}` }),
};

const writeTool: ToolDef<z.infer<typeof writeSchema>> = {
  name: 'fs.write',
  description: 'Write a file.',
  schema: writeSchema,
  parallelSafe: false,
  requiresApproval: 'policy',
  timeoutMs: 1_000,
  action: (args) => ({ kind: 'fs.write', path: args.path }),
  run: async (args) => ({ ok: true, output: `wrote ${args.path} (${args.content})` }),
};

const gateCalls: string[] = [];
const gate: PolicyGate = {
  mode: 'workspace-write',
  decide: async (action) => {
    gateCalls.push(action.kind);
    if (action.kind === 'fs.write') {
      return { outcome: 'deny', reason: 'outside workspace' };
    }
    if (action.kind === 'fs.read' && action.path.startsWith('/')) {
      return { outcome: 'deny', reason: `${action.path} is outside the workspace` };
    }
    return { outcome: 'allow' };
  },
};

type ToolResultEvent = Extract<SessionEvent, { t: 'tool.result' }>;

describe('end-to-end: one full round through provider, policy, log and replay', () => {
  it('runs a turn, records it durably, and replays it identically after a restart', async () => {
    const root = await makeTmpDir();
    dirs.push(root);
    gateCalls.length = 0;

    const registry = new ToolRegistry({ gate });
    registry.register(readTool);
    registry.register(guardedReadTool);
    registry.register(writeTool);

    const log = await openSessionLog({ root, sessionId: 's1' });

    // 1. session opens, the human asks for work
    await log.append({
      t: 'session.created',
      sessionId: 's1',
      cwd: '/workspace',
      model: 'fake-model',
    });
    await log.append({ t: 'turn.start', turn: 1, input: 'read a.txt then write notes.md' });
    await log.append({ t: 'step.start', turn: 1, step: 1 });

    // 2. the model request is recorded, then streamed by the provider
    const request: LLMRequest = {
      model: 'fake-model',
      system: 'You are a coding agent.',
      messages: [{ role: 'user', content: 'read a.txt then write notes.md' }],
      tools: registry.schemas(),
      maxOutputTokens: 256,
      signal: new AbortController().signal,
    };
    await log.append({ t: 'llm.request', requestId: 'r1', request });

    const provider = new FakeProvider({
      deltas: [
        { type: 'text', text: 'Reading and writing.' },
        { type: 'tool_call', index: 0, id: 'c1', name: 'fs.read', argsJsonDelta: '{"path":"a.txt"}' },
        { type: 'tool_call', index: 1, id: 'c2', name: 'fs.read_guarded', argsJsonDelta: '{"path":"/etc/passwd"}' },
        { type: 'tool_call', index: 2, id: 'c3', name: 'fs.write', argsJsonDelta: '{"path":"notes.md",' },
        { type: 'tool_call', index: 2, argsJsonDelta: '"content":"hi"}' },
        { type: 'usage', usage: { inputTokens: 120, outputTokens: 18, cacheReadTokens: 90 } },
        { type: 'stop', reason: 'tool_calls' },
      ],
    });

    const deltas: LLMDelta[] = [];
    for await (const delta of provider.stream(request)) {
      deltas.push(delta);
    }
    const response = assembleResponse(deltas);

    expect(response.toolCalls.map((call) => call.name)).toEqual([
      'fs.read',
      'fs.read_guarded',
      'fs.write',
    ]);
    expect(response.usage).toEqual({
      inputTokens: 120,
      outputTokens: 18,
      cacheReadTokens: 90,
    });

    await log.append({
      t: 'llm.response',
      requestId: 'r1',
      text: response.text,
      toolCalls: response.toolCalls,
      usage: response.usage ?? { inputTokens: 0, outputTokens: 0 },
      stop: response.stop,
    });

    // 3. every tool call goes through the policy gate before it runs
    const results: ToolResult[] = [];
    for (const call of response.toolCalls) {
      await log.append({ t: 'tool.call', callId: call.id, name: call.name, args: call.args });
      const result = await registry.dispatch(call.name, call.args, makeCtx());
      results.push(result);
      await log.append({
        t: 'tool.result',
        callId: call.id,
        ok: result.ok,
        output: result.output,
        durationMs: 1,
        ...(result.code === undefined ? {} : { code: result.code }),
      });
    }

    expect(results.map((result) => result.code)).toEqual([
      undefined,
      ToolErrorCode.PolicyDenied,
      ToolErrorCode.PolicyDenied,
    ]);
    // `fs.read` declares itself approval-free, so it never consults the gate.
    // The two tools that opt into policy do — reads included.
    expect(gateCalls).toEqual(['fs.read', 'fs.write']);

    // 4. the model closes the turn
    await log.append({
      t: 'llm.response',
      requestId: 'r2',
      text: 'a.txt says hello; /etc/passwd and notes.md were refused.',
      toolCalls: [],
      usage: { inputTokens: 40, outputTokens: 12 },
      stop: 'end',
    });
    await log.append({ t: 'turn.end', turn: 1, status: 'done' });

    const transcriptBefore = replay(log.readAll());
    const eventCount = log.count;
    await log.close();

    // 5. restart: a brand new reader must produce the same transcript
    const reloaded = await readSessionLog({ root, sessionId: 's1' });
    expect(reloaded).toHaveLength(eventCount);
    expect(replay(reloaded)).toEqual(transcriptBefore);

    expect(transcriptBefore).toEqual([
      { role: 'user', content: 'read a.txt then write notes.md' },
      {
        role: 'assistant',
        content: 'Reading and writing.',
        toolCalls: [
          { id: 'c1', name: 'fs.read', args: { path: 'a.txt' } },
          { id: 'c2', name: 'fs.read_guarded', args: { path: '/etc/passwd' } },
          { id: 'c3', name: 'fs.write', args: { path: 'notes.md', content: 'hi' } },
        ],
      },
      { role: 'tool', content: 'hello from a.txt', toolCallId: 'c1' },
      { role: 'tool', content: '/etc/passwd is outside the workspace', toolCallId: 'c2' },
      { role: 'tool', content: 'outside workspace', toolCallId: 'c3' },
      {
        role: 'assistant',
        content: 'a.txt says hello; /etc/passwd and notes.md were refused.',
      },
    ]);

    const toolResults = reloaded.filter(
      (event): event is ToolResultEvent => event.t === 'tool.result',
    );
    expect(toolResults).toHaveLength(3);
    expect(toolResults[0]).toMatchObject({ callId: 'c1', ok: true });
    expect(toolResults[1]).toMatchObject({
      callId: 'c2',
      ok: false,
      code: ToolErrorCode.PolicyDenied,
    });
    expect(toolResults[2]).toMatchObject({
      callId: 'c3',
      ok: false,
      code: ToolErrorCode.PolicyDenied,
    });

    // 6. the log really is a file on disk, one JSON object per line
    const lines = (await readFile(sessionLogPath(root, 's1'), 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(eventCount);
    for (const line of lines) {
      expect(typeof (JSON.parse(line) as { seq: number }).seq).toBe('number');
    }

    // 7. the session resumes and continues the seq
    const resumed = await openSessionLog({ root, sessionId: 's1' });
    expect(resumed.nextSeq()).toBe(eventCount + 1);
    await resumed.append({ t: 'turn.start', turn: 2, input: 'thanks' });
    await resumed.close();

    expect(await readSessionLog({ root, sessionId: 's1' })).toHaveLength(eventCount + 1);
  });
});
