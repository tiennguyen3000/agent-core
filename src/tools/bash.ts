/**
 * The model-facing `bash` tool.
 *
 * Every command becomes a job. A foreground command waits for its deadline; if
 * it is still running when the deadline passes, the tool returns the job id and
 * leaves the process alive instead of killing work the model may still want.
 * A cancelled turn is different: the command was started for that turn, so the
 * tool kills it rather than leaking an orphan.
 */

import { z } from 'zod';
import { ToolErrorCode } from './registry.js';
import type { ToolDef, ToolResult } from './registry.js';

const DEFAULT_TIMEOUT_MS = 120_000;

const bashSchema = z.object({
  command: z.string().min(1).describe('Shell command to run in the workspace.'),
  description: z.string().optional().describe('Short human-readable summary of what it does.'),
  run_in_background: z
    .boolean()
    .optional()
    .describe('Start the command and return its job id immediately (default false).'),
  timeout_ms: z
    .number()
    .int()
    .min(0)
    .max(600_000)
    .optional()
    .describe(`How long a foreground command may take (default ${String(DEFAULT_TIMEOUT_MS)}).`),
});

export interface BashToolConfig {
  readonly defaultTimeoutMs?: number;
  readonly maxInlineTokens?: number;
}

function describeJob(result: {
  snapshot: { status: string; exitCode: number | null; signal: string | null };
}): string {
  const { snapshot } = result;
  const signal = snapshot.signal === null ? '' : `, signal ${snapshot.signal}`;
  return `status ${snapshot.status} (exit ${snapshot.exitCode === null ? 'null' : String(snapshot.exitCode)}${signal})`;
}

export function createBashTool(config: BashToolConfig = {}): ToolDef<z.infer<typeof bashSchema>> {
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: 'bash',
    description:
      'Run a shell command in the workspace. Every command is a background job: a foreground command that outlives timeout_ms returns its job id instead of being killed. The output ends with an [exit code: N] marker — check it, a non-zero code is a command failure, not a tool failure.',
    schema: bashSchema,
    parallelSafe: false,
    requiresApproval: 'policy',
    timeoutMs: 0,
    maxInlineTokens: config.maxInlineTokens ?? 2_000,
    action: (args, ctx) => ({ kind: 'shell.exec', command: args.command, cwd: ctx.workdir }),
    run: async (args, ctx): Promise<ToolResult> => {
      const { jobId } = await ctx.jobs.spawn(args.command, { cwd: ctx.workdir });

      if (args.run_in_background === true) {
        return {
          ok: true,
          output: `Started ${jobId} in the background: ${args.command}\nUse job_output to follow it, job_kill to stop it.`,
          meta: { jobId, background: true },
        };
      }

      const timeoutMs = args.timeout_ms ?? defaultTimeoutMs;
      const waited = await ctx.jobs.wait(jobId, {
        ...(timeoutMs > 0 ? { timeoutMs } : {}),
        signal: ctx.signal,
      });

      if (waited.outcome === 'cancelled') {
        await ctx.jobs.kill(jobId);
        const partial = ctx.jobs.read(jobId)?.text ?? '';
        return {
          ok: false,
          code: ToolErrorCode.Cancelled,
          output: `Command cancelled; the process was stopped.\n${partial}`,
          meta: { jobId },
        };
      }

      const output = ctx.jobs.read(jobId);
      const text = output?.text ?? '';
      const lossy = output?.lossy === true ? '\n[earlier output was dropped from the buffer]\n' : '';

      if (waited.outcome === 'running') {
        return {
          ok: true,
          output: `${text}${lossy}\n[still running after ${String(timeoutMs)}ms — job ${jobId}; use job_output to follow it or job_kill to stop it]`,
          meta: { jobId, running: true },
        };
      }

      return {
        ok: true,
        output: `${text}${lossy}`,
        meta: {
          jobId,
          status: waited.snapshot.status,
          exitCode: waited.snapshot.exitCode,
          durationMs: (waited.snapshot.endedAt ?? 0) - waited.snapshot.startedAt,
        },
      };
    },
  };
}

const jobOutputSchema = z.object({
  job_id: z.string().min(1).describe('Job id returned by bash or job_list.'),
  since: z.number().int().min(0).optional().describe('Only return output after this cursor.'),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .max(600_000)
    .optional()
    .describe('Wait up to this long for the job to finish before reading.'),
});

export function createJobOutputTool(): ToolDef<z.infer<typeof jobOutputSchema>> {
  return {
    name: 'job_output',
    description:
      'Read a job\'s output. Pass since (the previous cursor) to get only new output, or wait_ms to block until the job finishes.',
    schema: jobOutputSchema,
    parallelSafe: true,
    requiresApproval: 'never',
    timeoutMs: 0,
    maxInlineTokens: 2_000,
    run: async (args, ctx) => {
      if (ctx.jobs.snapshot(args.job_id) === undefined) {
        return {
          ok: false,
          code: ToolErrorCode.NotFound,
          output: `Unknown job ${args.job_id}. Known jobs: ${ctx.jobs.list().join(', ') || '(none)'}`,
        };
      }

      if (args.wait_ms !== undefined && args.wait_ms > 0) {
        await ctx.jobs.wait(args.job_id, { timeoutMs: args.wait_ms, signal: ctx.signal });
      }

      const output = ctx.jobs.read(args.job_id, args.since === undefined ? {} : { since: args.since });
      if (output === undefined) {
        return {
          ok: false,
          code: ToolErrorCode.NotFound,
          output: `Job ${args.job_id} disappeared.`,
        };
      }

      const lossy = output.lossy ? '[earlier output was dropped from the buffer]\n' : '';
      return {
        ok: true,
        output: `${output.text}\n(${describeJob(output)}; cursor ${String(output.nextCursor)})\n${lossy}`.trimEnd(),
        meta: {
          jobId: output.snapshot.id,
          status: output.snapshot.status,
          cursor: output.nextCursor,
        },
      };
    },
  };
}

const jobListSchema = z.object({});

export function createJobListTool(): ToolDef<z.infer<typeof jobListSchema>> {
  return {
    name: 'job_list',
    description: 'List this session\'s jobs with their status, exit code and duration.',
    schema: jobListSchema,
    parallelSafe: true,
    requiresApproval: 'never',
    timeoutMs: 0,
    maxInlineTokens: 800,
    run: async (_args, ctx) => {
      const ids = ctx.jobs.list();
      if (ids.length === 0) {
        return { ok: true, output: 'No jobs have been started in this session.' };
      }
      const lines = ids.map((id) => {
        const snapshot = ctx.jobs.snapshot(id);
        if (snapshot === undefined) {
          return `${id}  (gone)`;
        }
        const ended = snapshot.endedAt ?? Date.now();
        const seconds = ((ended - snapshot.startedAt) / 1_000).toFixed(1);
        return `${id}  ${snapshot.status.padEnd(7)}  exit=${snapshot.exitCode === null ? 'null' : String(snapshot.exitCode)}  ${seconds}s  ${snapshot.command}`;
      });
      return { ok: true, output: lines.join('\n'), meta: { jobs: ids.length } };
    },
  };
}

const jobKillSchema = z.object({
  job_id: z.string().min(1).describe('Job id to terminate.'),
});

export function createJobKillTool(): ToolDef<z.infer<typeof jobKillSchema>> {
  return {
    name: 'job_kill',
    description:
      'Terminate a running job (SIGTERM, then SIGKILL). Settles only after the process has stopped.',
    schema: jobKillSchema,
    parallelSafe: false,
    requiresApproval: 'never',
    timeoutMs: 0,
    maxInlineTokens: 400,
    run: async (args, ctx) => {
      const before = ctx.jobs.snapshot(args.job_id);
      if (before === undefined) {
        return {
          ok: false,
          code: ToolErrorCode.NotFound,
          output: `Unknown job ${args.job_id}. Known jobs: ${ctx.jobs.list().join(', ') || '(none)'}`,
        };
      }
      if (before.status !== 'running') {
        return {
          ok: true,
          output: `Job ${args.job_id} had already finished (${describeJob({ snapshot: before })}).`,
          meta: { jobId: args.job_id, status: before.status },
        };
      }

      await ctx.jobs.kill(args.job_id);
      const after = ctx.jobs.snapshot(args.job_id);
      return {
        ok: true,
        output: `Killed ${args.job_id} (${describeJob({ snapshot: after ?? before })}).`,
        meta: { jobId: args.job_id, status: after?.status ?? 'unknown' },
      };
    },
  };
}
