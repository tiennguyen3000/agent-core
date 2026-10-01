/**
 * Public surface of the agent core.
 *
 * M0 ships contracts plus the two pure pieces that make them verifiable:
 * `project()` (session projection) and `FakeProvider`. Implementations of the
 * ports — DeepSeek provider (M1), durable log (M2), filesystem and search tools
 * (M3), bash and jobs (M4), sandbox and approval (M5), context management (M6),
 * subagents, skills and MCP (M7), CLI (M8) — plug in behind these types.
 */

export type {
  JsonSchemaObject,
  LLMDelta,
  LLMProvider,
  LLMRequest,
  Message,
  ReasoningEffort,
  Role,
  StopReason,
  ToolCall,
  ToolSchema,
  Usage,
} from './llm/types.js';

export { FakeProvider, textScript } from './llm/fake.js';
export type { FakeScript } from './llm/fake.js';

export type {
  ApprovalDecisionEvent,
  ApprovalRequestEvent,
  CompactionEvent,
  LLMRequestEvent,
  LLMRequestSnapshot,
  LLMResponseEvent,
  SessionCreatedEvent,
  SessionEvent,
  SessionEventType,
  StepStartEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent,
} from './session/events.js';
export { assertContiguousSeqs, nextSeq } from './session/events.js';

export { project, replay } from './session/projection.js';
export type { ProjectionOptions, ProjectionResult } from './session/projection.js';

export type {
  JobRegistry,
  SandboxedFs,
  ShellResult,
  ShellRunner,
  ToolCtx,
  ToolDef,
  ToolResult,
} from './tools/registry.js';
export { ToolErrorCode, ToolRegistry, ToolTimeoutError } from './tools/registry.js';
export type { ToolErrorCodeValue, ToolRegistryOptions } from './tools/registry.js';

export type {
  Action,
  PolicyDecision,
  PolicyGate,
  PolicyOutcome,
  SandboxMode,
} from './policy/gate.js';
