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
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentRuntime } from '../app/runtime.js';
import { createDeepSeekProvider } from '../llm/deepseek.js';
import type { LLMProvider } from '../llm/types.js';
import type { Action, SandboxMode } from '../policy/gate.js';
import { forkSessionLog, listSessionIds, readSessionLog } from '../session/log.js';

export interface CliIo {
  readonly out: (line: string) => void;
  /** Streaming output: text as it arrives, no trailing newline. */
  readonly write: (chunk: string) => void;
  readonly err: (line: string) => void;
  readonly prompt: (question: string) => Promise<string>;
}

export interface CliOptions {
  readonly argv: readonly string[];
  readonly io?: Partial<CliIo>;
  /** Injected by tests; otherwise built from the environment. */
  readonly provider?: LLMProvider;
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
}

export interface CliCommand {
  readonly kind: 'help' | 'version' | 'list' | 'run';
  readonly task: string;
  readonly session: string | undefined;
  readonly resume: string | undefined;
  readonly workspace: string;
  readonly model: string;
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

Options
  --workspace <dir>      Workspace root (default: current directory)
  --session <id>         Start a new session with this id
  --resume <id>          Continue an existing session
  --model <name>         Model to use (default: deepseek-flash)
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
  let model = env.DEEPSEEK_MODEL ?? 'deepseek-flash';
  let mode: SandboxMode = 'workspace-write';
  let sessionRoot = env.AGENT_CORE_SESSION_ROOT ?? join(env.HOME ?? cwd, '.agent-core', 'sessions');
  let session: string | undefined;
  let resume: string | undefined;
  let maxSteps = 24;
  let contextWindow = 1_000_000;
  let reasoning = false;
  let yes = false;
  let escalate = false;
  let kind: CliCommand['kind'] = 'run';
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
        } else {
          taskParts.push(arg);
        }
    }
  }

  return {
    kind,
    task: taskParts.join(' '),
    session,
    resume,
    workspace,
    model,
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

export async function runCli(options: CliOptions): Promise<number> {
  const env = options.env ?? process.env;
  const terminal =
    options.io?.prompt === undefined
      ? createInterface({ input: process.stdin, output: process.stdout })
      : undefined;
  // On a real terminal let readline draw the prompt; on a pipe or a file, read
  // queued lines so scripted sessions are not lost to the EOF race.
  const piped = terminal !== undefined && process.stdin.isTTY !== true
    ? createLineReader(terminal)
    : undefined;
  const io: CliIo = {
    out: options.io?.out ?? ((line) => process.stdout.write(`${line}\n`)),
    write: options.io?.write ?? ((chunk) => process.stdout.write(chunk)),
    err: options.io?.err ?? ((line) => process.stderr.write(`${line}\n`)),
    prompt:
      options.io?.prompt ??
      (async (question) => {
        if (piped !== undefined) {
          return await piped(question);
        }
        return await (terminal?.question(question) ?? '');
      }),
  };

  const command = parseArgs(options.argv, env, options.cwd ?? process.cwd());

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
      if ((env.DEEPSEEK_API_KEY ?? '').trim() === '') {
        return undefined;
      }
      return createDeepSeekProvider({ env });
    })();
  if (provider === undefined) {
    io.err('error: set DEEPSEEK_API_KEY, or run with a provider injected');
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
    model: command.model,
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
    `agent-core · session ${runtime.sessionId} · model ${runtime.model} · mode ${command.mode}` +
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
