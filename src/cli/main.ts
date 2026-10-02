/**
 * The CLI: one command that wires the whole core together.
 *
 * `runCli` is the testable half — it takes argv, an IO seam and an optional
 * provider, and returns an exit code. `main`/the entrypoint guard is a thin
 * wrapper, so the suite can drive a full session against a scripted provider
 * without touching the network.
 */

import { createInterface } from 'node:readline/promises';
import { stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentRuntime } from '../app/runtime.js';
import {
  PROVIDER_PRESETS,
  fetchModels,
  findPreset,
  loadConfig,
  resolveEnv,
  saveConfig,
  writeEnvValue,
} from '../config/store.js';
import type { AgentCoreConfig } from '../config/store.js';
import { apiKeyEnvFor, createProviderFor } from '../llm/factory.js';
import type { LLMProvider } from '../llm/types.js';
import type { Action, SandboxMode } from '../policy/gate.js';
import { forkSessionLog, listSessionIds, readSessionLog } from '../session/log.js';

export interface CliIo {
  readonly out: (line: string) => void;
  /** Streaming output: text as it arrives, no trailing newline. */
  readonly write: (chunk: string) => void;
  readonly err: (line: string) => void;
  readonly prompt: (question: string) => Promise<string>;
  /** Reads a credential without echoing it; defaults to a hidden prompt. */
  readonly promptSecret?: (question: string) => Promise<string>;
}

export interface CliOptions {
  readonly argv: readonly string[];
  readonly io?: Partial<CliIo>;
  /** Injected by tests; otherwise built from the configuration. */
  readonly provider?: LLMProvider;
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
}

export interface CliCommand {
  readonly kind: 'help' | 'version' | 'list' | 'run' | 'model' | 'key';
  readonly task: string;
  readonly session: string | undefined;
  readonly resume: string | undefined;
  readonly workspace: string;
  readonly model: string;
  /** `--provider` override, or the provider named by `model`/`key`. */
  readonly provider: string | undefined;
  /** Positional arguments after the subcommand. */
  readonly args: readonly string[];
  readonly mode: SandboxMode;
  readonly sessionRoot: string;
  readonly maxSteps: number;
  readonly contextWindow: number;
  readonly reasoning: boolean;
  readonly yes: boolean;
  readonly escalate: boolean;
  readonly errors: readonly string[];
}

const HELP = `agent-core — a personal coding agent

Usage
  agent-core [options] [task]
  agent-core --resume <session> [task]
  agent-core model                       Choose the provider and model
  agent-core model <provider> <model>    Set them without a menu
  agent-core key <provider>              Store an API key (~/.agent-core/.env)
  agent-core key                         Show which providers have a key

Options
  --workspace <dir>      Workspace root (default: current directory)
  --session <id>         Start a new session with this id
  --resume <id>          Continue an existing session
  --provider <id>        ${PROVIDER_PRESETS.map((preset) => preset.id).join(' | ')}
  --model <name>         Model to use (default: the configured model)
  --mode <mode>          read-only | workspace-write | full-access (default: workspace-write)
  --session-root <dir>   Where sessions are stored (default: ~/.agent-core/sessions)
  --max-steps <n>        Step ceiling per turn (default: 24)
  --context-window <n>   Tokens the model accepts (default: 1000000)
  --show-reasoning       Print reasoning deltas too
  --escalate             Ask before writing outside the workspace (default: refuse)
  --yes, -y              Approve every gated action without asking
  --list                 List stored sessions
  --version              Print the version
  --help, -h             Print this help

Inside the REPL
  /help /quit /cost /compact /model <name> /resume <id> /fork [id] /export
`;

function takeValue(argv: readonly string[], index: number): string | undefined {
  return argv[index + 1];
}

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): CliCommand {
  const errors: string[] = [];
  let workspace = cwd;
  let model = env.DEEPSEEK_MODEL ?? '';
  let provider: string | undefined;
  let mode: SandboxMode = 'workspace-write';
  let sessionRoot =
    env.AGENT_CORE_SESSION_ROOT ?? join(env.AGENT_CORE_HOME ?? homedir(), '.agent-core', 'sessions');
  let session: string | undefined;
  let resume: string | undefined;
  let maxSteps = 24;
  let contextWindow = 1_000_000;
  let reasoning = false;
  let yes = false;
  let escalate = false;
  let kind: CliCommand['kind'] = 'run';
  const args: string[] = [];
  const taskParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    switch (arg) {
      case '--help':
      case '-h':
        kind = 'help';
        break;
      case '--version':
        kind = 'version';
        break;
      case '--list':
        kind = 'list';
        break;
      case '--workspace': {
        const value = takeValue(argv, index);
        if (value === undefined) {
          errors.push('--workspace needs a path');
        } else {
          workspace = resolve(cwd, value);
        }
        index += 1;
        break;
      }
      case '--session':
        session = takeValue(argv, index);
        index += 1;
        break;
      case '--resume':
        resume = takeValue(argv, index);
        index += 1;
        break;
      case '--model':
        model = takeValue(argv, index) ?? model;
        index += 1;
        break;
      case '--provider': {
        const value = takeValue(argv, index);
        if (value === undefined) {
          errors.push('--provider needs an id');
        } else if (findPreset(value) === undefined) {
          errors.push(
            `--provider must be one of ${PROVIDER_PRESETS.map((preset) => preset.id).join(', ')} (got ${value})`,
          );
        } else {
          provider = value;
        }
        index += 1;
        break;
      }
      case '--session-root':
        sessionRoot = resolve(cwd, takeValue(argv, index) ?? sessionRoot);
        index += 1;
        break;
      case '--mode': {
        const value = takeValue(argv, index);
        if (value === 'read-only' || value === 'workspace-write' || value === 'full-access') {
          mode = value;
        } else {
          errors.push(`--mode must be read-only, workspace-write or full-access (got ${String(value)})`);
        }
        index += 1;
        break;
      }
      case '--max-steps': {
        const value = Number(takeValue(argv, index));
        if (Number.isInteger(value) && value > 0) {
          maxSteps = value;
        } else {
          errors.push('--max-steps needs a positive integer');
        }
        index += 1;
        break;
      }
      case '--context-window': {
        const value = Number(takeValue(argv, index));
        if (Number.isInteger(value) && value > 0) {
          contextWindow = value;
        } else {
          errors.push('--context-window needs a positive integer');
        }
        index += 1;
        break;
      }
      case '--show-reasoning':
        reasoning = true;
        break;
      case '--escalate':
        escalate = true;
        break;
      case '--yes':
      case '-y':
        yes = true;
        break;
      default:
        if (arg.startsWith('-') && arg.length > 1) {
          errors.push(`unknown option ${arg}`);
          break;
        }
        // The first bare word may name a subcommand; everything after it is an
        // argument to that subcommand rather than part of the task.
        if (args.length === 0 && taskParts.length === 0 && (arg === 'model' || arg === 'key')) {
          kind = arg;
          break;
        }
        if (kind === 'model' || kind === 'key') {
          args.push(arg);
          break;
        }
        taskParts.push(arg);
    }
  }

  return {
    kind,
    task: taskParts.join(' '),
    session,
    resume,
    workspace,
    model,
    provider,
    args,
    mode,
    sessionRoot,
    maxSteps,
    contextWindow,
    reasoning,
    yes,
    escalate,
    errors,
  };
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'shell.exec':
      return `run shell: ${action.command}`;
    case 'fs.write':
      return `write ${action.path}`;
    case 'fs.read':
      return `read ${action.path}`;
    case 'net.fetch':
      return `fetch ${action.url}`;
  }
}

function defaultSessionId(now: number): string {
  return `session-${String(now)}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `readline.question` throws this once stdin has ended. A closed pipe, a
 * `< /dev/null` run or a scripted session without `/quit` must end the REPL
 * cleanly, and an approval waiting on that stdin must fail closed — never a
 * stack trace.
 */
function isInputClosed(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === 'ERR_USE_AFTER_CLOSE';
}

function inputClosedError(): Error & { code: string } {
  const error = new Error('readline was closed') as Error & { code: string };
  error.code = 'ERR_USE_AFTER_CLOSE';
  return error;
}

interface PendingLine {
  readonly resolve: (line: string) => void;
  readonly reject: (error: Error) => void;
}

/**
 * A piped stdin can be consumed and closed before the first `question()` call,
 * which would silently drop every scripted line. Queue the lines instead, and
 * let the caller ask for them one at a time.
 */
function createLineReader(
  terminal: ReturnType<typeof createInterface>,
): (question: string) => Promise<string> {
  const pending: string[] = [];
  const waiters: PendingLine[] = [];
  let closed = false;

  terminal.on('line', (line: string) => {
    const waiter = waiters.shift();
    if (waiter === undefined) {
      pending.push(line);
      return;
    }
    waiter.resolve(line);
  });
  terminal.on('close', () => {
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(inputClosedError());
    }
  });

  return async () => {
    const queued = pending.shift();
    if (queued !== undefined) {
      return queued;
    }
    if (closed) {
      throw inputClosedError();
    }
    return await new Promise<string>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  };
}

/**
 * Reads a credential without echoing it. On a pipe there is nothing to hide, so
 * the line is read normally; on a terminal the characters never reach the
 * screen (backspace and Ctrl-C are honoured).
 */
export async function readSecretFromStdin(question: string): Promise<string> {
  const input = process.stdin;
  if (input.isTTY !== true) {
    process.stdout.write(question);
    input.setEncoding('utf8');
    const chunks: string[] = [];
    for await (const chunk of input) {
      const text = String(chunk);
      chunks.push(text);
      if (text.includes('\n')) {
        break;
      }
    }
    return chunks.join('').trim();
  }

  process.stdout.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return await new Promise<string>((resolve) => {
    let value = '';
    const finish = (result: string): void => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      resolve(result);
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish(value);
          return;
        }
        if (char === '\u0003') {
          finish('');
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    input.on('data', onData);
  });
}

async function chooseModel(
  preset: (typeof PROVIDER_PRESETS)[number],
  io: CliIo,
  shellEnv: Record<string, string | undefined>,
  storedEnv: Record<string, string | undefined>,
): Promise<number> {
  const key = (storedEnv[preset.apiKeyEnv] ?? '').trim();
  const listing = await fetchModels(preset, key === '' ? undefined : key);
  if (listing.error !== undefined) {
    io.out(`(built-in list; live list unavailable: ${listing.error})`);
  } else {
    io.out(`${listing.models.length} models offered by this account:`);
  }
  const shown = listing.models.slice(0, 40);
  shown.forEach((name, index) => {
    io.out(`  ${String(index + 1)}. ${name}`);
  });
  if (listing.models.length > shown.length) {
    io.out(`  … ${String(listing.models.length - shown.length)} more (type a name directly)`);
  }

  const answer = (
    await io.prompt(`\nModel number or name (empty = ${preset.defaultModel}): `)
  ).trim();
  const asNumber = Number(answer);
  const chosen =
    answer === ''
      ? preset.defaultModel
      : Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= shown.length
        ? (shown[asNumber - 1] ?? preset.defaultModel)
        : answer;

  await saveConfig({ provider: preset.id, model: chosen }, shellEnv);
  io.out(`saved: ${preset.id} · ${chosen}`);
  if (key === '') {
    io.out(`no ${preset.apiKeyEnv} yet — store it with: tiennk key ${preset.id}`);
    if (preset.docs !== '') {
      io.out(`create one at ${preset.docs}`);
    }
  }
  return 0;
}

async function runModelCommand(
  command: CliCommand,
  io: CliIo,
  shellEnv: Record<string, string | undefined>,
  storedEnv: Record<string, string | undefined>,
  current: AgentCoreConfig,
): Promise<number> {
  const [providerArg, modelArg] = command.args;
  io.out(`current: ${current.provider} · ${current.model}`);

  if (providerArg === undefined) {
    io.out('');
    PROVIDER_PRESETS.forEach((preset, index) => {
      const has = (storedEnv[preset.apiKeyEnv] ?? '').trim() !== '';
      io.out(
        `  ${String(index + 1)}. ${preset.label} (${preset.id}) — ${has ? 'key ✓' : 'no key'}`,
      );
    });
    const answer = (
      await io.prompt('\nProvider number or id (empty = cancel): ')
    ).trim();
    if (answer === '') {
      io.out('unchanged');
      return 0;
    }
    const asNumber = Number(answer);
    const preset =
      Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= PROVIDER_PRESETS.length
        ? PROVIDER_PRESETS[asNumber - 1]
        : findPreset(answer);
    if (preset === undefined) {
      io.err(`unknown provider ${answer}`);
      return 2;
    }
    return await chooseModel(preset, io, shellEnv, storedEnv);
  }

  const preset = findPreset(providerArg);
  if (preset === undefined) {
    io.err(
      `unknown provider ${providerArg} (known: ${PROVIDER_PRESETS.map((entry) => entry.id).join(', ')})`,
    );
    return 2;
  }
  if (modelArg !== undefined && modelArg !== '') {
    await saveConfig({ provider: preset.id, model: modelArg }, shellEnv);
    io.out(`saved: ${preset.id} · ${modelArg}`);
    if ((storedEnv[preset.apiKeyEnv] ?? '').trim() === '') {
      io.out(`no ${preset.apiKeyEnv} yet — store it with: tiennk key ${preset.id}`);
    }
    return 0;
  }
  return await chooseModel(preset, io, shellEnv, storedEnv);
}

async function runKeyCommand(
  command: CliCommand,
  io: CliIo,
  shellEnv: Record<string, string | undefined>,
  storedEnv: Record<string, string | undefined>,
): Promise<number> {
  const [providerArg, valueArg] = command.args;

  if (providerArg === undefined) {
    io.out('credentials (~/.agent-core/.env, plus anything exported):');
    for (const preset of PROVIDER_PRESETS) {
      const fromEnv =
        (shellEnv[preset.apiKeyEnv] ?? '').trim() !== '' ? 'exported' : undefined;
      const stored = (storedEnv[preset.apiKeyEnv] ?? '').trim() !== '' ? 'stored' : undefined;
      const state = fromEnv ?? stored ?? 'missing';
      io.out(`  ${preset.id.padEnd(12)} ${preset.apiKeyEnv.padEnd(22)} ${state}`);
    }
    io.out('\nStore one: tiennk key <provider>');
    return 0;
  }

  const preset = findPreset(providerArg);
  if (preset === undefined) {
    io.err(
      `unknown provider ${providerArg} (known: ${PROVIDER_PRESETS.map((entry) => entry.id).join(', ')})`,
    );
    return 2;
  }

  let value = valueArg;
  if (value === undefined) {
    if (preset.docs !== '') {
      io.out(`Create a key at ${preset.docs}`);
    }
    value = (await (io.promptSecret ?? readSecretFromStdin)(`${preset.label} API key: `)).trim();
  }
  if (value === '') {
    io.err('no key entered; nothing stored');
    return 2;
  }

  const file = await writeEnvValue(preset.apiKeyEnv, value, shellEnv);
  io.out(`stored ${preset.apiKeyEnv} in ${file}`);
  io.out(`start the agent with: tiennk --provider ${preset.id}`);
  return 0;
}

export async function runCli(options: CliOptions): Promise<number> {
  // readline is created lazily: attaching it claims stdin, which would starve a
  // piped credential (`printf sk-... | tiennk key deepseek`) or a script.
  let terminal: ReturnType<typeof createInterface> | undefined;
  let piped: ((question: string) => Promise<string>) | undefined;
  const terminalFor = (): ReturnType<typeof createInterface> => {
    if (terminal === undefined) {
      terminal = createInterface({ input: process.stdin, output: process.stdout });
      // On a pipe or a file, read queued lines so scripted sessions are not
      // lost to the EOF race.
      piped = process.stdin.isTTY !== true ? createLineReader(terminal) : undefined;
    }
    return terminal;
  };
  const io: CliIo = {
    out: options.io?.out ?? ((line) => process.stdout.write(`${line}\n`)),
    write: options.io?.write ?? ((chunk) => process.stdout.write(chunk)),
    err: options.io?.err ?? ((line) => process.stderr.write(`${line}\n`)),
    prompt:
      options.io?.prompt ??
      (async (question) => {
        const active = terminalFor();
        if (piped !== undefined) {
          return await piped(question);
        }
        return await active.question(question);
      }),
    ...(options.io?.promptSecret === undefined
      ? {}
      : { promptSecret: options.io.promptSecret }),
  };
  // A stored credential is enough to start: no shell export required.
  const shellEnv = options.env ?? process.env;
  const storedEnv = await resolveEnv(shellEnv);
  const loaded = await loadConfig(shellEnv);
  const command = parseArgs(options.argv, shellEnv, options.cwd ?? process.cwd());
  const config: AgentCoreConfig = {
    provider: command.provider ?? loaded?.provider ?? 'deepseek',
    model: command.model !== '' ? command.model : (loaded?.model ?? 'deepseek-flash'),
    ...(loaded?.baseUrl === undefined ? {} : { baseUrl: loaded.baseUrl }),
    ...(loaded?.kind === undefined ? {} : { kind: loaded.kind }),
    ...(loaded?.apiKeyEnv === undefined ? {} : { apiKeyEnv: loaded.apiKeyEnv }),
  };

  if (command.kind === 'help') {
    io.out(HELP);
    return 0;
  }
  if (command.kind === 'version') {
    io.out('agent-core 0.1.0');
    return 0;
  }
  if (command.kind === 'list') {
    const ids = await listSessionIds(command.sessionRoot);
    io.out(ids.length === 0 ? `No sessions in ${command.sessionRoot}` : ids.join('\n'));
    return 0;
  }
  if (command.kind === 'model') {
    return await runModelCommand(command, io, shellEnv, storedEnv, config);
  }
  if (command.kind === 'key') {
    return await runKeyCommand(command, io, shellEnv, storedEnv);
  }
  if (command.errors.length > 0) {
    for (const error of command.errors) {
      io.err(`error: ${error}`);
    }
    io.err('run with --help for usage');
    return 2;
  }
  if (!(await pathExists(command.workspace))) {
    io.err(`error: workspace ${command.workspace} does not exist`);
    return 2;
  }

  const provider =
    options.provider ??
    (() => {
      const envName = apiKeyEnvFor(config);
      if ((storedEnv[envName] ?? '').trim() === '') {
        return undefined;
      }
      return createProviderFor(config, storedEnv);
    })();
  if (provider === undefined) {
    const envName = apiKeyEnvFor(config);
    io.err(`error: no ${envName} found for provider "${config.provider}".`);
    io.err(`  Store it once:   tiennk key ${config.provider}`);
    io.err(`  Or this run:     export ${envName}=...`);
    io.err('  Pick a provider: tiennk model');
    return 2;
  }

  const answerer = command.yes
    ? async (): Promise<boolean> => true
    : async (request: { action: Action }): Promise<boolean> => {
        try {
          const answer = await io.prompt(`Approve ${describeAction(request.action)}? [y/N] `);
          return /^y(es)?$/i.test(answer.trim());
        } catch (error) {
          // No human on the other end: deny rather than crash (fail closed).
          if (isInputClosed(error)) {
            return false;
          }
          throw error;
        }
      };

  let runtime = await createAgentRuntime({
    workspaceRoot: command.workspace,
    sessionRoot: command.sessionRoot,
    sessionId: command.resume ?? command.session ?? defaultSessionId(Date.now()),
    provider,
    model: config.model,
    mode: command.mode,
    contextWindow: command.contextWindow,
    maxSteps: command.maxSteps,
    answerer,
    ...(command.escalate ? { outsideWorkspace: 'ask' as const } : {}),
    onDelta: (delta) => {
      if (delta.type === 'text') {
        io.write(delta.text);
      } else if (delta.type === 'reasoning' && command.reasoning) {
        io.write(delta.text);
      }
    },
    onLoopEvent: (event) => {
      if (event.t === 'tool.call') {
        io.out(`\n· ${event.name} ${JSON.stringify(event.args).slice(0, 120)}`);
      }
      if (event.t === 'tool.result' && !event.result.ok) {
        io.out(`  ✗ ${event.name}: ${event.result.code ?? 'failed'}`);
      }
    },
  });

  const reconnect = async (changes: {
    sessionId?: string;
    model?: string;
  }): Promise<void> => {
    const previousId = runtime.sessionId;
    const previousModel = runtime.model;
    await runtime.close();
    runtime = await createAgentRuntime({
      workspaceRoot: command.workspace,
      sessionRoot: command.sessionRoot,
      sessionId: changes.sessionId ?? previousId,
      provider,
      model: changes.model ?? previousModel,
      mode: command.mode,
      contextWindow: command.contextWindow,
      maxSteps: command.maxSteps,
      answerer,
      ...(command.escalate ? { outsideWorkspace: 'ask' as const } : {}),
      onDelta: (delta) => {
        if (delta.type === 'text') {
          io.write(delta.text);
        }
      },
      onLoopEvent: (event) => {
        if (event.t === 'tool.call') {
          io.out(`\n· ${event.name} ${JSON.stringify(event.args).slice(0, 120)}`);
        }
      },
    });
  };

  const runTurn = async (task: string): Promise<number> => {
    const result = await runtime.runTask(task);
    io.out('');
    if (!result.ok) {
      io.err(
        `turn ended: ${result.status}${result.errorCode === undefined ? '' : ` (${result.errorCode})`}`,
      );
    }
    return result.ok ? 0 : 1;
  };

  if (command.task.length > 0) {
    const code = await runTurn(command.task);
    io.out(runtime.formatReport());
    await runtime.close();
    return code;
  }

  io.out(
    `agent-core · session ${runtime.sessionId} · ${config.provider}/${runtime.model} · mode ${command.mode}` +
      (runtime.confinement === 'unconfined' ? ' · shell unconfined' : ' · shell os-sandboxed'),
  );
  io.out('Type a task, or /help for commands.');

  for (;;) {
    let line: string;
    try {
      line = (await io.prompt('\n> ')).trim();
    } catch (error) {
      // End of stdin (piped script, `< /dev/null`): stop the REPL, keep the report.
      if (isInputClosed(error)) {
        io.out('');
        break;
      }
      throw error;
    }
    if (line.length === 0) {
      continue;
    }
    if (line === '/quit' || line === '/exit') {
      break;
    }
    if (line === '/help') {
      io.out(HELP);
      continue;
    }
    if (line === '/cost') {
      io.out(runtime.formatReport());
      continue;
    }
    if (line === '/compact') {
      const outcome = await runtime.compact(new AbortController().signal);
      if (outcome.status === 'compacted') {
        io.out(
          `compacted: covered seq 1..${String(outcome.plan.coveredTo)}, kept from ${String(outcome.plan.retainedFrom)}`,
        );
      } else if (outcome.status === 'skipped') {
        io.out(`not compacted (${outcome.reason})`);
      } else {
        io.out(`compaction failed (${outcome.reason}: ${outcome.errorCode ?? 'unknown'})`);
      }
      continue;
    }
    if (line === '/export') {
      const target = join(command.workspace, `${runtime.sessionId}-export.jsonl`);
      const events = await readSessionLog({
        root: command.sessionRoot,
        sessionId: runtime.sessionId,
      });
      await writeFile(target, events.map((event) => `${JSON.stringify(event)}\n`).join(''));
      io.out(`exported ${String(events.length)} events to ${target}`);
      continue;
    }
    if (line.startsWith('/model ')) {
      const model = line.slice('/model '.length).trim();
      if (model.length === 0) {
        io.out(`model is ${runtime.model}`);
        continue;
      }
      await reconnect({ model });
      io.out(`model switched to ${runtime.model}`);
      continue;
    }
    if (line.startsWith('/resume ')) {
      const sessionId = line.slice('/resume '.length).trim();
      if (sessionId.length === 0) {
        io.out(`current session is ${runtime.sessionId}`);
        continue;
      }
      await reconnect({ sessionId });
      io.out(`resumed ${runtime.sessionId} (${String(runtime.log.count)} events)`);
      continue;
    }
    if (line.startsWith('/fork')) {
      const requested = line.slice('/fork'.length).trim();
      const target = requested.length > 0 ? requested : `${runtime.sessionId}-fork-${String(Date.now())}`;
      const events = await readSessionLog({
        root: command.sessionRoot,
        sessionId: runtime.sessionId,
      });
      await forkSessionLog({
        root: command.sessionRoot,
        from: runtime.sessionId,
        to: target,
        upToSeq: events.length,
      });
      await reconnect({ sessionId: target });
      io.out(`forked into ${target} (${String(runtime.log.count)} events)`);
      continue;
    }
    if (line.startsWith('/')) {
      io.err(`unknown command ${line} — try /help`);
      continue;
    }

    await runTurn(line);
  }

  io.out(runtime.formatReport());
  await runtime.close();
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runCli({ argv: process.argv.slice(2) });
}
