import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FakeProvider,
  createAgentRuntime,
  mapLoopEvent,
  replay,
} from '../src/index.js';
import type { AgentRuntime, AgentRuntimeOptions, SessionEvent } from '../src/index.js';
import { makeTmpDir, removeTmpDir } from './helpers/tmp-dir.js';

const dirs: string[] = [];
const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.close().catch(() => undefined);
  }
  await Promise.all(dirs.splice(0).map((dir) => removeTmpDir(dir)));
});

async function tmp(): Promise<string> {
  const dir = await makeTmpDir();
  dirs.push(dir);
  return dir;
}

async function makeRuntime(
  provider: FakeProvider,
  overrides: Partial<AgentRuntimeOptions> = {},
): Promise<{ workspace: string; sessionRoot: string; runtime: AgentRuntime }> {
  const workspace = await tmp();
  const sessionRoot = await tmp();
  await writeFile(join(workspace, 'a.txt'), 'file body\n');
  const runtime = await createAgentRuntime({
    workspaceRoot: workspace,
    sessionRoot,
    sessionId: 's1',
    provider,
    model: 'deepseek-flash',
    mode: 'workspace-write',
    contextWindow: 1_000_000,
    ...overrides,
  });
  runtimes.push(runtime);
  return { workspace, sessionRoot, runtime };
}

function textScript(text: string, usage?: { inputTokens: number; outputTokens: number }) {
  return {
    deltas: [
      { type: 'text' as const, text },
      ...(usage === undefined ? [] : [{ type: 'usage' as const, usage }]),
      { type: 'stop' as const, reason: 'end' as const },
    ],
  };
}

function readScript(path: string) {
  return {
    deltas: [
      {
        type: 'tool_call' as const,
        index: 0,
        id: 'c1',
        name: 'fs_read',
        argsJsonDelta: JSON.stringify({ path }),
      },
      { type: 'stop' as const, reason: 'tool_calls' as const },
    ],
  };
}

describe('agent runtime', () => {
  it('registers the whole tool roster', async () => {
    const { runtime } = await makeRuntime(new FakeProvider([textScript('hi')]));

    expect(runtime.registry.names()).toEqual([
      'bash',
      'fs_edit',
      'fs_glob',
      'fs_grep',
      'fs_read',
      'fs_read_image',
      'fs_write',
      'job_kill',
      'job_list',
      'job_output',
      'skill',
      'skill_search',
      'subagent',
    ]);
  });

  it('records a full turn in the session log', async () => {
    const provider = new FakeProvider([readScript('a.txt'), textScript('done')]);
    const { runtime } = await makeRuntime(provider);

    const result = await runtime.runTask('read a.txt');

    expect(result.ok).toBe(true);
    expect(result.text).toBe('done');
    const types = runtime.log.readAll().map((event) => event.t);
    expect(types).toEqual([
      'session.created',
      'turn.start',
      'step.start',
      'llm.request',
      'llm.response',
      'tool.call',
      'tool.result',
      'step.start',
      'llm.request',
      'llm.response',
      'turn.end',
    ]);
    const toolResult = runtime.log
      .readAll()
      .find((event): event is Extract<SessionEvent, { t: 'tool.result' }> => event.t === 'tool.result');
    expect(toolResult?.ok).toBe(true);
    expect(toolResult?.output).toContain('file body');
  });

  it('continues the recorded history on the next turn (resume)', async () => {
    const provider = new FakeProvider([
      textScript('first answer'),
      textScript('second answer'),
    ]);
    const { runtime } = await makeRuntime(provider);

    await runtime.runTask('first task');
    const second = await runtime.runTask('second task');

    expect(second.text).toBe('second answer');
    const messages = provider.requests[1]?.messages ?? [];
    expect(messages[0]).toEqual({ role: 'user', content: 'first task' });
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'second task' });
  });

  it('resumes a session that a previous runtime closed', async () => {
    const workspace = await tmp();
    const sessionRoot = await tmp();
    await writeFile(join(workspace, 'a.txt'), 'body\n');
    const first = await createAgentRuntime({
      workspaceRoot: workspace,
      sessionRoot,
      sessionId: 'shared',
      provider: new FakeProvider([textScript('first')]),
      model: 'deepseek-flash',
      mode: 'workspace-write',
      contextWindow: 1_000_000,
    });
    await first.runTask('remember this');
    const eventsAfterFirst = first.log.count;
    await first.close();

    const provider = new FakeProvider([textScript('second')]);
    const second = await createAgentRuntime({
      workspaceRoot: workspace,
      sessionRoot,
      sessionId: 'shared',
      provider,
      model: 'deepseek-flash',
      mode: 'workspace-write',
      contextWindow: 1_000_000,
    });
    runtimes.push(second);

    await second.runTask('and this');

    expect(second.log.count).toBeGreaterThan(eventsAfterFirst);
    expect(provider.requests[0]?.messages[0]).toEqual({ role: 'user', content: 'remember this' });
    // Reopening a session must not create it twice, and turn numbers continue.
    const events = second.log.readAll();
    expect(events.filter((event) => event.t === 'session.created')).toHaveLength(1);
    const turns = events
      .filter((event): event is Extract<SessionEvent, { t: 'turn.start' }> => event.t === 'turn.start')
      .map((event) => event.turn);
    expect(turns).toEqual([1, 2]);
    expect(second.nextTurn()).toBe(3);
  });

  it('compacts once the context window is under pressure', async () => {
    // Enough material to cover: several turns of filler, then the summary call.
    const filler = 'x'.repeat(600);
    const provider = new FakeProvider([
      textScript(`answer one ${filler}`, { inputTokens: 200, outputTokens: 20 }),
      textScript(`answer two ${filler}`),
      textScript(`answer three ${filler}`),
      textScript(`answer four ${filler}`),
      textScript('a dense summary'),
    ]);
    const { runtime } = await makeRuntime(provider, { contextWindow: 100 });

    await runtime.runTask(`question one ${filler}`);
    await runtime.runTask(`question two ${filler}`);
    await runtime.runTask(`question three ${filler}`);
    await runtime.runTask(`question four ${filler}`);
    const outcome = await runtime.compact(new AbortController().signal);

    expect(outcome.status).toBe('compacted');
    const types = runtime.log.readAll().map((event) => event.t);
    expect(types).toContain('compaction');
    const messages = replay(runtime.log.readAll());
    expect(messages[0]?.content).toContain('a dense summary');
  });

  it('reports tokens and an estimated cost', async () => {
    const provider = new FakeProvider([
      textScript('done', { inputTokens: 1_000, outputTokens: 100 }),
    ]);
    const { runtime } = await makeRuntime(provider);

    await runtime.runTask('do something');
    const report = runtime.formatReport();

    expect(runtime.usageTotals()).toMatchObject({ inputTokens: 1_000, outputTokens: 100 });
    expect(report).toContain('Tokens  input 1,000 (cache read 0) | output 100 (reasoning 0)');
    expect(report).toContain('Cost    $0.00021');
    expect(report).toContain('deepseek-flash');
  });
});

describe('mapLoopEvent', () => {
  it('maps every loop event onto a session event', () => {
    const usage = { inputTokens: 1, outputTokens: 2 };

    expect(mapLoopEvent({ t: 'step.start', step: 3 }, 7)).toEqual({
      t: 'step.start',
      turn: 7,
      step: 3,
    });
    expect(
      mapLoopEvent(
        {
          t: 'llm.request',
          step: 1,
          requestId: 'request-1',
          request: {
            model: 'm',
            system: 's',
            messages: [],
            tools: [],
            maxOutputTokens: 8,
          },
        },
        7,
      ),
    ).toMatchObject({ t: 'llm.request', requestId: 'request-1' });
    expect(
      mapLoopEvent(
        {
          t: 'llm.response',
          step: 1,
          requestId: 'request-1',
          text: 'hi',
          toolCalls: [],
          usage,
          stop: 'end',
        },
        7,
      ),
    ).toMatchObject({ t: 'llm.response', text: 'hi', stop: 'end' });
    expect(
      mapLoopEvent({ t: 'tool.call', step: 1, name: 'fs_read', callId: 'c1', args: { path: 'a' } }, 7),
    ).toEqual({ t: 'tool.call', name: 'fs_read', callId: 'c1', args: { path: 'a' } });
    expect(
      mapLoopEvent(
        {
          t: 'tool.result',
          step: 1,
          name: 'fs_read',
          callId: 'c1',
          result: { ok: false, code: 'E_NO_READ', output: 'nope', meta: { durationMs: 5 } },
        },
        7,
      ),
    ).toEqual({
      t: 'tool.result',
      callId: 'c1',
      ok: false,
      code: 'E_NO_READ',
      output: 'nope',
      durationMs: 5,
    });
    expect(mapLoopEvent({ t: 'run.end', status: 'done', usage, steps: 1 }, 7)).toBeUndefined();
  });
});
