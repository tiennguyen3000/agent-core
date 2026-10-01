/**
 * Tool contract and registry.
 *
 * Invariant 4: a tool's JSON Schema is generated from its zod schema at
 * registration time — there is exactly one source of truth for the shape the
 * model sees and the shape the runtime validates.
 *
 * Invariant 3: dispatch consults the `PolicyGate` before any handler runs.
 * When a tool declares `requiresApproval: 'policy'` and no gate is mounted the
 * call fails closed.
 */

import { z } from 'zod';
import type { JsonSchemaObject, ToolSchema } from '../llm/types.js';
import type { Action, PolicyGate } from '../policy/gate.js';

/** Filesystem port. The sandboxed implementation lands in M5. */
export interface SandboxedFs {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface ShellResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Shell port. One-shot bash lands in M4. */
export interface ShellRunner {
  exec(
    command: string,
    options: { readonly cwd: string; readonly signal: AbortSignal },
  ): Promise<ShellResult>;
}

/** Background job port. The process registry lands in M4. */
export interface JobRegistry {
  spawn(command: string, options: { readonly cwd: string }): Promise<{ readonly jobId: string }>;
  kill(jobId: string): Promise<void>;
  list(): readonly string[];
}

export interface ToolCtx {
  /**
   * Cancellation signal (invariant 5). Handlers MUST check `signal.aborted`
   * before awaiting anything and must pass the signal into every I/O call:
   * listening for the 'abort' event alone misses a cancellation that already
   * happened before the handler started.
   */
  readonly signal: AbortSignal;
  readonly workdir: string;
  readonly fs: SandboxedFs;
  readonly shell: ShellRunner;
  readonly jobs: JobRegistry;
  requestApproval(action: Action): Promise<boolean>;
  log(line: string): void;
}

export interface ToolResult {
  readonly ok: boolean;
  /** Stable machine code on failure so the model can self-correct. */
  readonly code?: string;
  readonly output: string;
  /** Set when oversized output was written to a file the model can re-read. */
  readonly spillPath?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export const ToolErrorCode = {
  UnknownTool: 'E_UNKNOWN_TOOL',
  BadArgs: 'E_BAD_ARGS',
  PolicyDenied: 'E_POLICY_DENIED',
  ApprovalDenied: 'E_APPROVAL_DENIED',
  Cancelled: 'E_CANCELLED',
  Timeout: 'E_TIMEOUT',
  ToolFailed: 'E_TOOL_FAILED',
} as const;

export type ToolErrorCodeValue = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

interface ToolDefBase<A> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<A>;
  /** Safe to run concurrently with other tools in the same step. */
  readonly parallelSafe: boolean;
  readonly timeoutMs: number;
  /** Above this estimate the result is spilled instead of inlined (M6). */
  readonly maxInlineTokens?: number;
  run(args: A, ctx: ToolCtx): Promise<ToolResult>;
}

/**
 * A tool is either approval-free, or it declares how to derive the `Action`
 * that the gate and the approval prompt evaluate.
 */
export type ToolDef<A = unknown> = ToolDefBase<A> &
  (
    | { readonly requiresApproval: 'never' }
    | {
        readonly requiresApproval: 'policy' | 'always';
        readonly action: (args: A) => Action;
      }
  );

/**
 * The runtime shape of the approval-carrying half of `ToolDef`. `#authorize`
 * casts to it instead of using a type predicate: narrowing an intersection of a
 * union with a predicate collapses the negative branch to `never`.
 */
type ApprovalTool = {
  readonly action: (args: unknown) => Action;
};

export class ToolTimeoutError extends Error {
  constructor(
    readonly toolName: string,
    readonly timeoutMs: number,
  ) {
    super(`Tool "${toolName}" exceeded its ${timeoutMs}ms timeout.`);
    this.name = 'ToolTimeoutError';
  }
}

function failure(code: ToolErrorCodeValue, output: string): ToolResult {
  return { ok: false, code, output };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultToJsonSchema(schema: z.ZodType<unknown>): JsonSchemaObject {
  return z.toJSONSchema(schema as unknown as z.ZodType) as unknown as JsonSchemaObject;
}

export interface ToolRegistryOptions {
  /** Omitted in tests that assert fail-closed behaviour. */
  readonly gate?: PolicyGate;
  /** Override the schema converter (defaults to zod's `toJSONSchema`). */
  readonly toJsonSchema?: (schema: z.ZodType<unknown>) => JsonSchemaObject;
  /** Injectable clock so dispatch metadata stays testable. */
  readonly now?: () => number;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDef<unknown>>();
  readonly #gate: PolicyGate | undefined;
  readonly #toJsonSchema: (schema: z.ZodType<unknown>) => JsonSchemaObject;
  readonly #now: () => number;

  constructor(options: ToolRegistryOptions = {}) {
    this.#gate = options.gate;
    this.#toJsonSchema = options.toJsonSchema ?? defaultToJsonSchema;
    this.#now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.#tools.size;
  }

  register<A>(def: ToolDef<A>): void {
    if (this.#tools.has(def.name)) {
      throw new Error(`Duplicate tool name: ${def.name}`);
    }
    // The stored type erases the argument type on purpose: dispatch validates
    // arguments with the same zod schema before calling `run`.
    this.#tools.set(def.name, def as unknown as ToolDef<unknown>);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): ToolDef<unknown> | undefined {
    return this.#tools.get(name);
  }

  list(): readonly ToolDef<unknown>[] {
    return [...this.#tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  names(): readonly string[] {
    return this.list().map((tool) => tool.name);
  }

  /** The model-facing tool roster, derived from the zod schemas (invariant 4). */
  schemas(): readonly ToolSchema[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: this.#toJsonSchema(tool.schema),
    }));
  }

  async dispatch(name: string, args: unknown, ctx: ToolCtx): Promise<ToolResult> {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      return failure(
        ToolErrorCode.UnknownTool,
        `Unknown tool "${name}". Available: ${this.names().join(', ') || '(none)'}`,
      );
    }

    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      return failure(ToolErrorCode.BadArgs, `Invalid arguments for "${name}": ${issues}`);
    }

    if (ctx.signal.aborted) {
      return failure(ToolErrorCode.Cancelled, `"${name}" was cancelled before it started.`);
    }

    const denied = await this.#authorize(tool, parsed.data, ctx);
    if (denied !== undefined) {
      return denied;
    }

    const startedAt = this.#now();
    try {
      const result = await this.#runWithTimeout(tool, parsed.data, ctx);
      return {
        ...result,
        meta: { ...(result.meta ?? {}), durationMs: this.#now() - startedAt },
      };
    } catch (error) {
      if (error instanceof ToolTimeoutError) {
        return failure(
          ToolErrorCode.Timeout,
          `"${name}" exceeded its ${tool.timeoutMs}ms timeout. Narrow the request or raise timeoutMs.`,
        );
      }
      if (ctx.signal.aborted) {
        return failure(ToolErrorCode.Cancelled, `"${name}" was cancelled.`);
      }
      return failure(ToolErrorCode.ToolFailed, `"${name}" failed: ${errorMessage(error)}`);
    }
  }

  async #authorize(
    tool: ToolDef<unknown>,
    args: unknown,
    ctx: ToolCtx,
  ): Promise<ToolResult | undefined> {
    if (tool.requiresApproval === 'never') {
      return undefined;
    }

    // The `ToolDef` union guarantees `action` exists whenever `requiresApproval`
    // is not 'never'; this cast keeps the runtime check for untyped callers.
    const { action: actionFor } = tool as unknown as ApprovalTool;
    if (typeof actionFor !== 'function') {
      return failure(
        ToolErrorCode.PolicyDenied,
        `"${tool.name}" requires approval but declares no action().`,
      );
    }

    const action = actionFor(args);

    if (tool.requiresApproval === 'always') {
      const approved = await ctx.requestApproval(action);
      return approved
        ? undefined
        : failure(ToolErrorCode.ApprovalDenied, `Approval for "${tool.name}" was denied.`);
    }

    if (this.#gate === undefined) {
      return failure(
        ToolErrorCode.PolicyDenied,
        `No PolicyGate is mounted, so "${tool.name}" fails closed.`,
      );
    }

    const decision = await this.#gate.decide(action);
    if (decision.outcome === 'allow') {
      return undefined;
    }
    if (decision.outcome === 'deny') {
      return failure(
        ToolErrorCode.PolicyDenied,
        decision.reason ?? `Policy denied "${tool.name}".`,
      );
    }

    const approved = await ctx.requestApproval(action);
    return approved
      ? undefined
      : failure(ToolErrorCode.ApprovalDenied, `Approval for "${tool.name}" was denied.`);
  }

  async #runWithTimeout(
    tool: ToolDef<unknown>,
    args: unknown,
    ctx: ToolCtx,
  ): Promise<ToolResult> {
    if (!(tool.timeoutMs > 0)) {
      return await tool.run(args, ctx);
    }

    const controller = new AbortController();
    const forward = (): void => controller.abort(ctx.signal.reason);
    if (ctx.signal.aborted) {
      // The outer signal was already aborted, so the 'abort' event will never
      // fire again: abort the child directly or the tool would run forever.
      controller.abort(ctx.signal.reason);
    } else {
      ctx.signal.addEventListener('abort', forward, { once: true });
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new ToolTimeoutError(tool.name, tool.timeoutMs));
    }, tool.timeoutMs);
    timer.unref();

    try {
      return await tool.run(args, { ...ctx, signal: controller.signal });
    } catch (error) {
      if (timedOut) {
        throw new ToolTimeoutError(tool.name, tool.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', forward);
    }
  }
}
