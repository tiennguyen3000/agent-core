import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeProvider, parseArgs, runCli } from '../src/index.js';
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

interface Harness {
  readonly io: {
    out(chunk: string): void;
    write(chunk: string): void;
    err(chunk: string): void;
    prompt(question: string): Promise<string>;
  };
  readonly out: string[];
  readonly err: string[];
  readonly typed: string[];
  readonly questions: string[];
  text(): string;
  all(): string;
}

function harness(answers: readonly string[] = []): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const streamed: string[] = [];
  const questions: string[] = [];
  const pending = [...answers];
  return {
    io: {
      out: (chunk) => out.push(chunk),
      write: (chunk) => streamed.push(chunk),
      err: (chunk) => err.push(chunk),
      prompt: async (question) => {
        questions.push(question);
        return pending.shift() ?? '/quit';
      },
    },
    out,
    err,
    typed: streamed,
    questions,
    text: () => streamed.join(''),
    all: () => [...out, ...streamed, ...err].join('\n'),
  };
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

describe('parseArgs', () => {
  it('collects the task and the flags', () => {
    const command = parseArgs(
      ['--workspace', '/tmp/x', '--model', 'deepseek-v4-pro', '--mode', 'read-only', 'fix', 'the', 'bug'],
      {},
      '/cwd',
    );

    expect(command).toMatchObject({
      kind: 'run',
      task: 'fix the bug',
      workspace: '/tmp/x',
      model: 'deepseek-v4-pro',
      mode: 'read-only',
      yes: false,
      escalate: false,
      errors: [],
    });
  });

  it('reports unknown options and bad values instead of guessing', () => {
    const command = parseArgs(['--nope', '--mode', 'yolo', '--max-steps', 'zero'], {}, '/cwd');

    expect(command.errors).toEqual([
      'unknown option --nope',
      '--mode must be read-only, workspace-write or full-access (got yolo)',
      '--max-steps needs a positive integer',
    ]);
  });

  it('recognises help, version and list', () => {
    expect(parseArgs(['--help'], {}, '/cwd').kind).toBe('help');
    expect(parseArgs(['--version'], {}, '/cwd').kind).toBe('version');
    expect(parseArgs(['--list'], {}, '/cwd').kind).toBe('list');
  });
});

describe('cli', () => {
  it('prints help and exits 0', async () => {
    const io = harness();

    const code = await runCli({ argv: ['--help'], io: io.io, env: {} });

    expect(code).toBe(0);
    expect(io.all()).toContain('Usage');
    expect(io.all()).toContain('--resume');
  });

  it('refuses to start without a provider or a key', async () => {
    const io = harness();

    const code = await runCli({ argv: ['do something'], io: io.io, env: {} });

    expect(code).toBe(2);
    expect(io.err.join('\n')).toContain('DEEPSEEK_API_KEY');
  });

  it('rejects a workspace that does not exist', async () => {
    const io = harness();

    const code = await runCli({
      argv: ['--workspace', '/definitely/not/here', 'task'],
      io: io.io,
      env: {},
      provider: new FakeProvider([textScript('x')]),
    });

    expect(code).toBe(2);
    expect(io.err.join('\n')).toContain('does not exist');
  });

  it('runs one task end to end and prints the token and cost report', async () => {
    const workspace = await tmp();
    const sessionRoot = await tmp();
    const io = harness();
    const provider = new FakeProvider([
      textScript('all done', { inputTokens: 1_000, outputTokens: 100 }),
    ]);

    const code = await runCli({
      argv: ['--workspace', workspace, '--session-root', sessionRoot, '--session', 's1', 'fix the bug'],
      io: io.io,
      env: {},
      provider,
    });

    expect(code).toBe(0);
    expect(io.text()).toBe('all done');
    expect(io.all()).toContain('Tokens  input 1,000 (cache read 0) | output 100');
    expect(io.all()).toContain('Cost    $0.00021');
  });

  it('shows tool activity and streams the answer', async () => {
    const workspace = await tmp();
    await writeFile(join(workspace, 'notes.txt'), 'the body\n');
    const sessionRoot = await tmp();
    const io = harness();
    const provider = new FakeProvider([readScript('notes.txt'), textScript('read it')]);

    const code = await runCli({
      argv: ['--workspace', workspace, '--session-root', sessionRoot, '--session', 's1', 'read notes'],
      io: io.io,
      env: {},
      provider,
    });

    expect(code).toBe(0);
    expect(io.all()).toContain('· fs_read');
    expect(io.text()).toBe('read it');
  });

  it('asks before escalating an outside write and honours a refusal', async () => {
    const workspace = await tmp();
    const sessionRoot = await tmp();
    const io = harness(['n']);
    const provider = new FakeProvider([
      {
        deltas: [
          {
            type: 'tool_call',
            index: 0,
            id: 'c1',
            name: 'fs_write',
            argsJsonDelta: JSON.stringify({ path: '/tmp/outside-dsh.txt', content: 'x' }),
          },
          { type: 'stop', reason: 'tool_calls' },
        ],
      },
      textScript('could not write'),
    ]);

    const code = await runCli({
      argv: [
        '--workspace',
        workspace,
        '--session-root',
        sessionRoot,
        '--session',
        's1',
        '--escalate',
        'write outside',
      ],
      io: io.io,
      env: {},
      provider,
    });

    expect(code).toBe(0);
    expect(io.questions[0]).toContain('Approve write /tmp/outside-dsh.txt?');
    expect(io.all()).toContain('✗ fs_write: E_APPROVAL_DENIED');
  });

  it('skips every prompt with --yes', async () => {
    const workspace = await tmp();
    const sessionRoot = await tmp();
    const io = harness();
    const provider = new FakeProvider([textScript('fine')]);

    await runCli({
      argv: ['--workspace', workspace, '--session-root', sessionRoot, '--session', 's1', '--yes', 'go'],
      io: io.io,
      env: {},
      provider,
    });

    expect(io.all()).not.toContain('Approve');
  });

  it('lists sessions that exist', async () => {
    const workspace = await tmp();
    const sessionRoot = await tmp();
    await runCli({
      argv: ['--workspace', workspace, '--session-root', sessionRoot, '--session', 'listed', 'hi'],
      io: harness().io,
      env: {},
      provider: new FakeProvider([textScript('ok')]),
    });

    const io = harness();
    const code = await runCli({ argv: ['--list', '--session-root', sessionRoot], io: io.io, env: {} });

    expect(code).toBe(0);
    expect(io.all()).toContain('listed');
  });

  it('runs a REPL session with slash commands', async () => {
    const workspace = await tmp();
    const sessionRoot = await tmp();
    const io = harness(['/help', 'do the thing', '/cost', '/export', '/quit']);
    const provider = new FakeProvider([
      textScript('first answer', { inputTokens: 10, outputTokens: 5 }),
    ]);

    const code = await runCli({
      argv: ['--workspace', workspace, '--session-root', sessionRoot, '--session', 'repl'],
      io: io.io,
      env: {},
      provider,
    });

    expect(code).toBe(0);
    expect(io.all()).toContain('Type a task, or /help for commands.');
    expect(io.all()).toContain('Usage');
    expect(io.text()).toContain('first answer');
    expect(io.all()).toContain('Tokens  input 10 (cache read 0) | output 5');
    expect(io.all()).toContain(`exported`);
    const exported = await readFile(join(workspace, 'repl-export.jsonl'), 'utf8');
    expect(exported).toContain('"t":"turn.end"');
  });

  it('resumes an existing session from the CLI', async () => {
    const workspace = await tmp();
    const sessionRoot = await tmp();
    await runCli({
      argv: ['--workspace', workspace, '--session-root', sessionRoot, '--session', 'shared', 'first task'],
      io: harness().io,
      env: {},
      provider: new FakeProvider([textScript('first')]),
    });

    const io = harness();
    const provider = new FakeProvider([textScript('second')]);
    const code = await runCli({
      argv: ['--workspace', workspace, '--session-root', sessionRoot, '--resume', 'shared', 'second task'],
      io: io.io,
      env: {},
      provider,
    });

    expect(code).toBe(0);
    expect(provider.requests[0]?.messages[0]).toEqual({ role: 'user', content: 'first task' });
    expect(io.text()).toBe('second');
  });

  it('exits cleanly when stdin closes instead of crashing', async () => {
    const workspace = await tmp();
    const sessionRoot = await tmp();
    const io = harness();
    const closed = (): never => {
      const error = new Error('readline was closed') as Error & { code: string };
      error.code = 'ERR_USE_AFTER_CLOSE';
      throw error;
    };
    const provider = new FakeProvider([textScript('first', { inputTokens: 5, outputTokens: 5 })]);

    const code = await runCli({
      argv: ['--workspace', workspace, '--session-root', sessionRoot, '--session', 'eof'],
      io: { ...io.io, prompt: async () => closed() },
      env: {},
      provider,
    });

    expect(code).toBe(0);
    expect(io.all()).toContain('Tokens  input 0 (cache read 0)');
  });

  it('fails closed when stdin closes while waiting for approval', async () => {
    const workspace = await tmp();
    const sessionRoot = await tmp();
    const io = harness();
    const questions: string[] = [];
    const provider = new FakeProvider([
      {
        deltas: [
          {
            type: 'tool_call',
            index: 0,
            id: 'c1',
            name: 'fs_write',
            argsJsonDelta: JSON.stringify({ path: '/tmp/outside-eof.txt', content: 'x' }),
          },
          { type: 'stop', reason: 'tool_calls' },
        ],
      },
      textScript('gave up safely'),
    ]);

    const code = await runCli({
      argv: [
        '--workspace',
        workspace,
        '--session-root',
        sessionRoot,
        '--session',
        'eof-approval',
        '--escalate',
        'write outside',
      ],
      io: {
        ...io.io,
        prompt: async (question: string) => {
          questions.push(question);
          const error = new Error('readline was closed') as Error & { code: string };
          error.code = 'ERR_USE_AFTER_CLOSE';
          throw error;
        },
      },
      env: {},
      provider,
    });

    expect(code).toBe(0);
    expect(questions[0]).toContain('Approve write /tmp/outside-eof.txt?');
    expect(io.all()).toContain('✗ fs_write: E_APPROVAL_DENIED');
    expect(io.all()).toContain('gave up safely');
  });

  it('reports a failed turn with a non-zero exit code', async () => {
    const workspace = await tmp();
    const sessionRoot = await tmp();
    const io = harness();
    const provider = new FakeProvider([
      {
        deltas: [
          { type: 'text', text: 'partial' },
          { type: 'text', text: 'never sent' },
        ],
        failAfterDeltas: 1,
        errorCode: 'E_RATE_LIMITED',
      },
    ]);

    const code = await runCli({
      argv: ['--workspace', workspace, '--session-root', sessionRoot, '--session', 's1', 'go'],
      io: io.io,
      env: {},
      provider,
    });

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('E_RATE_LIMITED');
    expect(io.text()).toBe('partial');
  });
});
