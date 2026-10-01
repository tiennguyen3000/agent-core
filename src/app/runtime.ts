/**
 * Composition root: everything the CLI needs, wired once.
 *
 * This module owns *assembly*, not behaviour: it builds the sandbox runtime,
 * the session log, the tool roster, the context manager, the skill catalog and
 * the loop, then records every loop event into the log as it happens.
 * Everything is injectable, so the same runtime runs against the real DeepSeek
 * provider or a scripted fake.
 */

import { runAgentLoop } from '../agent/loop.js';
import type { AgentLoopEventRecord, AgentRunStatus } from '../agent/loop.js';
import { createSubagentRunner } from '../agent/subagent.js';
import { createLocalAttachmentStore } from '../context/attachments.js';
import { DEFAULT_PRICES, formatUsageReport } from '../context/cost.js';
import type { ModelPrice } from '../context/cost.js';
import { createContextManager } from '../context/manager.js';
import type { CompactOutcome, ContextManager } from '../context/manager.js';
import { createProcessJobRegistry } from '../jobs/registry.js';
import type { JobRegistry } from '../jobs/types.js';
import type { LLMDelta, LLMProvider, Usage } from '../llm/types.js';
import type { ApprovalAnswerer } from '../policy/approval.js';
import type { SandboxMode } from '../policy/gate.js';
import { createLogAuditSink, createSandboxRuntime } from '../policy/runtime.js';
import type { SandboxRuntime } from '../policy/runtime.js';
import { openSessionLog } from '../session/log.js';
import type { SessionEventInput, SessionLog } from '../session/log.js';
import { project } from '../session/projection.js';
import type { OsSandboxBackend } from '../shell/os-sandbox.js';
import { createSkillLoader } from '../skills/loader.js';
import type { SkillLoader, SkillSource } from '../skills/loader.js';
import {
  createBashTool,
  createJobKillTool,
  createJobListTool,
  createJobOutputTool,
} from '../tools/bash.js';
import { createFsEditTool, createFsReadTool, createFsWriteTool } from '../tools/fs.js';
import { createReadImageTool } from '../tools/images.js';
import { ReadTracker } from '../tools/observation.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolCtx } from '../tools/registry.js';
import { createGlobTool, createGrepTool } from '../tools/search.js';
import { createSkillTool } from '../tools/skill.js';
import { createSubagentTool } from '../tools/subagent.js';

export interface AgentRuntimeOptions {
  readonly workspaceRoot: string;
  readonly sessionRoot: string;
  readonly sessionId: string;
  readonly provider: LLMProvider;
  readonly model: string;
  readonly mode: SandboxMode;
  readonly contextWindow: number;
  readonly tempGrants?: readonly string[];
  readonly attachmentDir?: string;
  readonly skillSources?: readonly SkillSource[];
  readonly systemPrompt?: string;
  readonly maxSteps?: number;
  readonly maxOutputTokens?: number;
  readonly tokenBudget?: number;
  readonly wallClockMs?: number;
  readonly answerer?: ApprovalAnswerer;
  readonly approvalTimeoutMs?: number;
  /** `ask` escalates outside-workspace writes to the human instead of denying. */
  readonly outsideWorkspace?: 'deny' | 'ask';
  readonly osSandbox?: OsSandboxBackend;
  readonly subagentMaxSteps?: number;
  readonly onDelta?: (delta: LLMDelta) => void;
  readonly onLoopEvent?: (event: AgentLoopEventRecord) => void;
  readonly prices?: Readonly<Record<string, ModelPrice>>;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

export interface AgentTurnResult {
  readonly status: AgentRunStatus;
  readonly ok: boolean;
  readonly text: string;
  readonly steps: number;
  readonly errorCode: string | undefined;
}

export interface AgentRuntime {
  readonly sessionId: string;
  readonly model: string;
  readonly workspaceRoot: string;
  /** `os-sandbox` only when an OS backend is mounted and the mode needs it. */
  readonly confinement: string;
  readonly registry: ToolRegistry;
  readonly context: ContextManager;
  readonly sandbox: SandboxRuntime;
  readonly log: SessionLog;
  readonly skills: SkillLoader;
  readonly jobs: JobRegistry;
  /** Runs one turn and records it: `turn.start` … `turn.end`. */
  runTask(task: string, options?: { readonly signal?: AbortSignal }): Promise<AgentTurnResult>;
  compact(signal: AbortSignal): Promise<CompactOutcome>;
  /** Cumulative usage of every turn this runtime ran. */
  usageTotals(): Usage;
  formatReport(): string;
  nextTurn(): number;
  close(): Promise<void>;
}

const DEFAULT_SYSTEM = [
  'You are a coding agent working inside a sandboxed workspace.',
  'Prefer the dedicated tools over shell commands for reading and editing files.',
  'Every shell command is a background job; check the [exit code: N] marker before trusting its output.',
  'Report what you changed and what you verified.',
].join(' ');

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function addUsage(total: Usage, next: Usage | undefined): Usage {
  if (next === undefined) {
    return total;
  }
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: (total.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
    reasoningTokens: (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
  };
}

function turnStatus(status: AgentRunStatus): 'done' | 'cancelled' | 'error' | 'budget_exceeded' {
  switch (status) {
    case 'done':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    case 'error':
      return 'error';
    default:
      return 'budget_exceeded';
  }
}

/** Maps a loop event onto the session event it records (or nothing). */
export function mapLoopEvent(
  event: AgentLoopEventRecord,
  turn: number,
): SessionEventInput | undefined {
  switch (event.t) {
    case 'step.start':
      return { t: 'step.start', turn, step: event.step };
    case 'llm.request':
      return { t: 'llm.request', requestId: event.requestId, request: event.request };
    case 'llm.response':
      return {
        t: 'llm.response',
        requestId: event.requestId,
        text: event.text,
        toolCalls: event.toolCalls,
        usage: event.usage ?? { inputTokens: 0, outputTokens: 0 },
        stop: event.stop,
      };
    case 'tool.call':
      return { t: 'tool.call', callId: event.callId, name: event.name, args: event.args };
    case 'tool.result': {
      const raw = Number(event.result.meta?.durationMs ?? 0);
      return {
        t: 'tool.result',
        callId: event.callId,
        ok: event.result.ok,
        output: event.result.output,
        durationMs: Number.isFinite(raw) ? raw : 0,
        ...(event.result.code === undefined ? {} : { code: event.result.code }),
        ...(event.result.spillPath === undefined ? {} : { spillPath: event.result.spillPath }),
      };
    }
    case 'run.end':
      return undefined;
  }
}

export async function createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime> {
  const now = options.now ?? (() => Date.now());
  const log = await openSessionLog({
    root: options.sessionRoot,
    sessionId: options.sessionId,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const sandbox = createSandboxRuntime({
    mode: options.mode,
    workspaceRoot: options.workspaceRoot,
    ...(options.tempGrants === undefined ? {} : { tempGrants: options.tempGrants }),
    audit: createLogAuditSink((input) => {
      void log.append(input);
    }),
    ...(options.answerer === undefined ? {} : { answerer: options.answerer }),
    ...(options.outsideWorkspace === undefined
      ? {}
      : { outsideWorkspace: options.outsideWorkspace }),
    ...(options.approvalTimeoutMs === undefined
      ? {}
      : { approvalTimeoutMs: options.approvalTimeoutMs }),
    ...(options.osSandbox === undefined ? {} : { osSandbox: options.osSandbox }),
    now,
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
  });

  const jobs = createProcessJobRegistry({
    now,
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
  });
  const attachments = createLocalAttachmentStore({
    dir: options.attachmentDir ?? `${options.sessionRoot}/attachments`,
  });

  const registry = new ToolRegistry({ gate: sandbox.gate, now });
  registry.register(createFsReadTool());
  registry.register(createFsWriteTool());
  registry.register(createFsEditTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  registry.register(createReadImageTool({ store: attachments }));
  registry.register(createBashTool());
  registry.register(createJobOutputTool());
  registry.register(createJobListTool());
  registry.register(createJobKillTool());

  const skills = createSkillLoader({
    fs: sandbox.fs,
    sources: options.skillSources ?? [
      { root: `${options.workspaceRoot}/.agents/skills`, scope: 'project' },
      { root: `${options.workspaceRoot}/.claude/skills`, scope: 'project' },
    ],
  });
  await skills.refresh();
  registry.register(createSkillTool({ loader: skills }));

  const baseSystem = options.systemPrompt ?? DEFAULT_SYSTEM;
  registry.register(
    createSubagentTool({
      runner: createSubagentRunner({
        provider: options.provider,
        registry,
        model: options.model,
        system: `${baseSystem}\nYou are a child agent: finish the single task you were given and answer with the result.`,
        ...(options.subagentMaxSteps === undefined
          ? {}
          : { maxSteps: options.subagentMaxSteps }),
        now,
      }),
    }),
  );

  const context = createContextManager({
    provider: options.provider,
    contextWindow: options.contextWindow,
    model: options.model,
  });

  const baseCtx: ToolCtx = {
    signal: new AbortController().signal,
    workdir: options.workspaceRoot,
    fs: sandbox.fs,
    shell: sandbox.shell,
    jobs,
    reads: new ReadTracker(),
    requestApproval: sandbox.requestApproval,
    log: () => undefined,
  };

  const system = [baseSystem, skills.promptSection()]
    .filter((part) => part.trim().length > 0)
    .join('\n\n');

  await log.append({
    t: 'session.created',
    sessionId: options.sessionId,
    cwd: options.workspaceRoot,
    model: options.model,
  });

  let totals: Usage = ZERO_USAGE;
  let turn = 0;

  return {
    sessionId: options.sessionId,
    model: options.model,
    workspaceRoot: options.workspaceRoot,
    confinement: sandbox.shell.confinement,
    registry,
    context,
    sandbox,
    log,
    skills,
    jobs,

    nextTurn() {
      return turn + 1;
    },

    async runTask(task, runOptions = {}) {
      turn += 1;
      const currentTurn = turn;
      const signal = runOptions.signal ?? new AbortController().signal;
      const runCtx: ToolCtx = { ...baseCtx, signal };

      await log.append({ t: 'turn.start', turn: currentTurn, input: task });

      const history = project(log.readAll(), context.projectionOptions()).messages;

      const result = await runAgentLoop({
        provider: options.provider,
        registry,
        ctx: runCtx,
        signal,
        model: options.model,
        system,
        messages: [...history, { role: 'user', content: task }],
        maxSteps: options.maxSteps ?? 24,
        ...(options.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: options.maxOutputTokens }),
        ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
        ...(options.wallClockMs === undefined ? {} : { wallClockMs: options.wallClockMs }),
        ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
        now,
        onEvent: async (event) => {
          options.onLoopEvent?.(event);
          if (event.t === 'llm.response' && event.usage !== undefined) {
            // Record only what the provider actually reported: a turn without
            // usage must not overwrite a real measurement with zero.
            context.recordUsage(event.usage);
            totals = addUsage(totals, event.usage);
          }
          const mapped = mapLoopEvent(event, currentTurn);
          if (mapped !== undefined) {
            await log.append(mapped);
          }
        },
      });

      await log.append({
        t: 'turn.end',
        turn: currentTurn,
        status: turnStatus(result.status),
      });

      return {
        status: result.status,
        ok: result.ok,
        text: result.text,
        steps: result.steps,
        errorCode: result.errorCode,
      };
    },

    async compact(signal) {
      const outcome = await context.compact(log.readAll(), { signal });
      if (outcome.status === 'compacted') {
        await log.append(outcome.event);
        totals = addUsage(totals, outcome.usage);
      }
      return outcome;
    },

    usageTotals() {
      return totals;
    },

    formatReport() {
      const prices = options.prices ?? DEFAULT_PRICES;
      return formatUsageReport(totals, options.model, prices[options.model]);
    },

    async close() {
      for (const id of jobs.list()) {
        await jobs.kill(id).catch(() => undefined);
      }
      await log.close();
    },
  };
}
