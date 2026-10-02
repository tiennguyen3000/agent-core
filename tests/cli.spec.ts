import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

    const code = await runCli({ argv: ['--help'], io: io.io, env: { AGENT_CORE_HOME: await tmp() } });

    expect(code).toBe(0);
    expect(io.all()).toContain('Usage');
    expect(io.all()).toContain('--resume');
  });

  it('refuses to start without a provider or a key', async () => {
    const io = harness();

    const code = await runCli({ argv: ['do something'], io: io.io, env: { AGENT_CORE_HOME: await tmp() } });

    expect(code).toBe(2);
    expect(io.err.join('\n')).toContain('DEEPSEEK_API_KEY');
  });

  it('rejects a workspace that does not exist', async () => {
    const io = harness();

    const code = await runCli({
      argv: ['--workspace', '/definitely/not/here', 'task'],
      io: io.io,
      env: { AGENT_CORE_HOME: await tmp() },
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
      env: { AGENT_CORE_HOME: await tmp() },
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
      env: { AGENT_CORE_HOME: await tmp() },
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
      env: { AGENT_CORE_HOME: await tmp() },
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
      env: { AGENT_CORE_HOME: await tmp() },
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
      env: { AGENT_CORE_HOME: await tmp() },
      provider: new FakeProvider([textScript('ok')]),
    });

    const io = harness();
    const code = await runCli({ argv: ['--list', '--session-root', sessionRoot], io: io.io, env: { AGENT_CORE_HOME: await tmp() } });

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
      env: { AGENT_CORE_HOME: await tmp() },
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
      env: { AGENT_CORE_HOME: await tmp() },
      provider: new FakeProvider([textScript('first')]),
    });

    const io = harness();
    const provider = new FakeProvider([textScript('second')]);
    const code = await runCli({
      argv: ['--workspace', workspace, '--session-root', sessionRoot, '--resume', 'shared', 'second task'],
      io: io.io,
      env: { AGENT_CORE_HOME: await tmp() },
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
      env: { AGENT_CORE_HOME: await tmp() },
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
      env: { AGENT_CORE_HOME: await tmp() },
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
      env: { AGENT_CORE_HOME: await tmp() },
      provider,
    });

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('E_RATE_LIMITED');
    expect(io.text()).toBe('partial');
  });
});

describe('provider and credential commands', () => {
  it('stores a credential from the hidden prompt and reports the file', async () => {
    const home = await tmp();
    const io = harness();

    const code = await runCli({
      argv: ['key', 'anthropic'],
      io: { ...io.io, promptSecret: async () => '  sk-ant-secret  ' },
      env: { AGENT_CORE_HOME: home },
    });

    expect(code).toBe(0);
    expect(io.all()).toContain('stored ANTHROPIC_API_KEY');
    expect(await readFile(join(home, '.env'), 'utf8')).toBe('ANTHROPIC_API_KEY=sk-ant-secret\n');
  });

  it('accepts a credential as an argument and keeps the others', async () => {
    const home = await tmp();
    await runCli({
      argv: ['key', 'anthropic', 'sk-ant-one'],
      io: harness().io,
      env: { AGENT_CORE_HOME: home },
    });
    await runCli({
      argv: ['key', 'openai', 'sk-openai-two'],
      io: harness().io,
      env: { AGENT_CORE_HOME: home },
    });

    const stored = await readFile(join(home, '.env'), 'utf8');
    expect(stored).toContain('ANTHROPIC_API_KEY=sk-ant-one');
    expect(stored).toContain('OPENAI_API_KEY=sk-openai-two');
  });

  it('lists which providers have a credential without printing any value', async () => {
    const home = await tmp();
    await runCli({
      argv: ['key', 'deepseek', 'sk-secret-value'],
      io: harness().io,
      env: { AGENT_CORE_HOME: home },
    });

    const io = harness();
    const code = await runCli({ argv: ['key'], io: io.io, env: { AGENT_CORE_HOME: home } });

    expect(code).toBe(0);
    expect(io.all()).toContain('deepseek');
    expect(io.all()).toContain('stored');
    expect(io.all()).not.toContain('sk-secret-value');
  });

  it('sets the provider and model directly', async () => {
    const home = await tmp();
    const io = harness();

    const code = await runCli({
      argv: ['model', 'anthropic', 'claude-opus-4-1'],
      io: io.io,
      env: { AGENT_CORE_HOME: home },
    });

    expect(code).toBe(0);
    expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-1',
    });
  });

  it('runs the menu and saves the chosen provider and model', async () => {
    const home = await tmp();
    // Answer 2 picks Anthropic; with no key the built-in list is shown, and the
    // next answer 1 picks its first model.
    const io = harness(['2', '1']);

    const code = await runCli({ argv: ['model'], io: io.io, env: { AGENT_CORE_HOME: home } });

    expect(code).toBe(0);
    expect(io.all()).toContain('Anthropic (Claude)');
    expect(io.all()).toContain('built-in list');
    expect(io.all()).toContain('no ANTHROPIC_API_KEY yet');
    expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
  });

  it('passes a non-numeric menu answer through as a custom provider and model', async () => {
    const home = await tmp();
    const io = harness(['deepseek', 'my-custom-model']);

    await runCli({ argv: ['model'], io: io.io, env: { AGENT_CORE_HOME: home } });

    expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))).toEqual({
      provider: 'deepseek',
      model: 'my-custom-model',
    });
  });

  it('starts on the configured provider', async () => {
    const home = await tmp();
    const workspace = await tmp();
    await runCli({
      argv: ['model', 'anthropic', 'claude-sonnet-4-5'],
      io: harness().io,
      env: { AGENT_CORE_HOME: home },
    });

    const io = harness();
    const code = await runCli({
      argv: ['--workspace', workspace, '--session-root', await tmp(), 'task'],
      io: io.io,
      env: { AGENT_CORE_HOME: home },
      provider: new FakeProvider([textScript('claude answered', { inputTokens: 7, outputTokens: 3 })]),
    });

    expect(code).toBe(0);
    expect(io.text()).toBe('claude answered');
  });

  it('explains exactly how to fix a missing credential', async () => {
    const io = harness();

    const code = await runCli({
      argv: ['hello'],
      io: io.io,
      env: { AGENT_CORE_HOME: await tmp() },
    });

    expect(code).toBe(2);
    expect(io.err.join('\n')).toContain('no DEEPSEEK_API_KEY found for provider "deepseek"');
    expect(io.err.join('\n')).toContain('tiennk key deepseek');
    expect(io.err.join('\n')).toContain('tiennk model');
  });

  it('rejects an unknown provider id', async () => {
    const io = harness();

    const code = await runCli({
      argv: ['model', 'nope'],
      io: io.io,
      env: { AGENT_CORE_HOME: await tmp() },
    });

    expect(code).toBe(2);
    expect(io.err.join('\n')).toContain('unknown provider nope');
  });
});

describe('skills inheritance commands', () => {
  async function withSkillDir(): Promise<{ home: string; dir: string }> {
    const home = await tmp();
    const dir = await tmp();
    await mkdir(join(dir, 'apple-reminders'), { recursive: true });
    await writeFile(
      join(dir, 'apple-reminders', 'SKILL.md'),
      [
        '---',
        'name: apple-reminders',
        'description: Apple Reminders via remindctl.',
        'version: 1.0.0',
        'platforms: [macos]',
        '---',
        '',
        '# Reminders',
        'Use remindctl to list reminders.',
      ].join('\n'),
    );
    await writeFile(join(dir, 'plain.md'), '# Plain skill\n\nA flat skill file.');
    return { home, dir };
  }

  it('inherits another agent\'s skill directory through config', async () => {
    const { home, dir } = await withSkillDir();
    const io = harness();

    const code = await runCli({
      argv: ['skills', 'add', dir],
      io: io.io,
      env: { AGENT_CORE_HOME: home },
    });

    expect(code).toBe(0);
    expect(io.all()).toContain('now inheriting 2 skills');
    expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))).toMatchObject({
      skillSources: [dir],
    });

    const listed = harness();
    await runCli({
      argv: ['skills'],
      io: listed.io,
      env: { AGENT_CORE_HOME: home },
    });
    // The machine may already have skills in ~/.agents/skills, so assert on the
    // source line for the directory this test added.
    const sourceLine = listed
      .all()
      .split('\n')
      .find((line) => line.includes(dir));
    expect(sourceLine).toContain('2 skills');
    expect(sourceLine).toContain('[added]');
  });

  it('refuses a directory with no skills instead of storing junk', async () => {
    const home = await tmp();
    const empty = await tmp();
    const io = harness();

    const code = await runCli({
      argv: ['skills', 'add', empty],
      io: io.io,
      env: { AGENT_CORE_HOME: home },
    });

    expect(code).toBe(2);
    expect(io.err.join('\n')).toContain('no skills found');
    await expect(readFile(join(home, 'config.json'), 'utf8')).rejects.toThrow();
  });

  it('removes an inherited directory again', async () => {
    const { home, dir } = await withSkillDir();
    await runCli({ argv: ['skills', 'add', dir], io: harness().io, env: { AGENT_CORE_HOME: home } });

    const io = harness();
    const code = await runCli({
      argv: ['skills', 'remove', dir],
      io: io.io,
      env: { AGENT_CORE_HOME: home },
    });

    expect(code).toBe(0);
    expect(io.all()).toContain('stopped inheriting');
    expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))).not.toHaveProperty(
      'skillSources',
    );
  });

  it('imports copies into the agent-core skill directory', async () => {
    const { home, dir } = await withSkillDir();
    const io = harness();

    const code = await runCli({
      argv: ['skills', 'import', dir],
      io: io.io,
      env: { AGENT_CORE_HOME: home },
    });

    expect(code).toBe(0);
    expect(io.all()).toContain('copied 2 skills');
    const bundle = await readFile(join(home, 'skills', 'apple-reminders', 'SKILL.md'), 'utf8');
    expect(bundle).toContain('remindctl');
    const flat = await readFile(join(home, 'skills', 'plain.md'), 'utf8');
    expect(flat).toContain('A flat skill file.');

    // A second import is a no-op unless --force.
    const again = harness();
    await runCli({ argv: ['skills', 'import', dir], io: again.io, env: { AGENT_CORE_HOME: home } });
    expect(again.all()).toContain('copied 0 skills');
    expect(again.all()).toContain('skipped 2');

    const forced = harness();
    await runCli({
      argv: ['skills', 'import', dir, '--force'],
      io: forced.io,
      env: { AGENT_CORE_HOME: home },
    });
    expect(forced.all()).toContain('copied 2 skills');
  });

  it('searches inherited skills by keyword', async () => {
    const { home, dir } = await withSkillDir();
    await runCli({ argv: ['skills', 'add', dir], io: harness().io, env: { AGENT_CORE_HOME: home } });

    const io = harness();
    const code = await runCli({
      argv: ['skills', 'search', 'remindctl'],
      io: io.io,
      env: { AGENT_CORE_HOME: home },
    });

    expect(code).toBe(0);
    expect(io.all()).toContain('apple-reminders [apple-reminders]');
    expect(io.all()).toContain('Apple Reminders via remindctl.');
  });

  it('detects skill directories other agents installed', async () => {
    const io = harness();

    const code = await runCli({
      argv: ['skills', 'detect'],
      io: io.io,
      env: { AGENT_CORE_HOME: await tmp() },
      cwd: await tmp(),
    });

    expect(code).toBe(0);
    expect(io.all()).toContain('looking for skills installed by other agents');
    // Machine dependent: either something was found, or it says so plainly.
    expect(/skills\s+\/|none found/.test(io.all())).toBe(true);
  });

  it('rejects an unknown skills subcommand with usage', async () => {
    const io = harness();

    const code = await runCli({
      argv: ['skills', 'frobnicate'],
      io: io.io,
      env: { AGENT_CORE_HOME: await tmp() },
    });

    expect(code).toBe(2);
    expect(io.err.join('\n')).toContain('unknown skills command');
    expect(io.err.join('\n')).toContain('tiennk skills list');
  });
});
