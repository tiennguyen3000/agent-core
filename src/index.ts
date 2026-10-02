/**
 * Public surface of the agent core.
 *
 * M0 ships contracts plus the two pure pieces that make them verifiable:
 * `project()` (session projection) and `FakeProvider`. M1 adds the real
 * DeepSeek provider (streaming SSE, retry, stable error codes) and its SSE
 * parser. Implementations of the ports — durable log (M2), filesystem and
 * search tools (M3), bash and jobs (M4), sandbox and approval (M5), context
 * management (M6), subagents, skills and MCP (M7), CLI (M8) — plug in behind
 * these types.
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

export { DeepSeekProvider, createDeepSeekProvider } from './llm/deepseek.js';
export type { DeepSeekProviderOptions } from './llm/deepseek.js';

export {
  OpenAiCompatibleProvider,
  createOpenAiCompatibleProvider,
} from './llm/openai-compatible.js';
export type { OpenAiCompatibleOptions, FetchLike } from './llm/openai-compatible.js';

export { AnthropicProvider, createAnthropicProvider } from './llm/anthropic.js';
export type { AnthropicProviderOptions } from './llm/anthropic.js';

export { parseSseStream } from './llm/sse.js';
export type { SseEvent } from './llm/sse.js';

export {
  ProviderError,
  ProviderErrorCode,
  describeError,
  isRetryableStatus,
  redactSecret,
} from './llm/errors.js';
export type { ProviderErrorCodeValue, ProviderErrorOptions } from './llm/errors.js';

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

export { assembleResponse } from './llm/assemble.js';
export type { CompletedResponse, MalformedToolArgs } from './llm/assemble.js';

export {
  SessionLogError,
  SessionLogErrorCode,
  forkSessionLog,
  listSessionIds,
  openSessionLog,
  readSessionLog,
  sessionDir,
  sessionLogPath,
} from './session/log.js';
export type {
  ForkSessionLogOptions,
  OpenSessionLogOptions,
  SessionEventInput,
  SessionLog,
  SessionLogErrorCodeValue,
} from './session/log.js';

export type {
  DirEntry,
  JobRegistry,
  SandboxedFs,
  ShellResult,
  ShellRunner,
  ToolCallRequest,
  ToolCtx,
  ToolDef,
  ToolResult,
} from './tools/registry.js';
export { ToolErrorCode, ToolRegistry, ToolTimeoutError } from './tools/registry.js';
export type { ToolErrorCodeValue, ToolRegistryOptions } from './tools/registry.js';
export { toolErrorCodeFrom } from './tools/registry.js';

export {
  DEFAULT_ENV_ALLOWLIST,
  createProcessJobRegistry,
} from './jobs/registry.js';
export type { ProcessJobRegistryOptions } from './jobs/registry.js';
export type {
  JobNotice,
  JobOutput,
  JobSnapshot,
  JobSpawnOptions,
  JobStatus,
  JobWaitOptions,
  JobWaitResult,
} from './jobs/types.js';

export { createBashShellRunner } from './shell/bash.js';
export type { BashShellRunnerOptions } from './shell/bash.js';

export {
  createBashTool,
  createJobKillTool,
  createJobListTool,
  createJobOutputTool,
} from './tools/bash.js';
export type { BashToolConfig } from './tools/bash.js';

export { createLocalFs } from './fs/local.js';
export type { LocalFsOptions } from './fs/local.js';

export { createSandboxPolicy, checkWrite, toAbsolute } from './policy/sandbox.js';
export type {
  PolicyAuditEvent,
  SandboxPolicyOptions,
  SandboxScope,
  WriteVerdict,
} from './policy/sandbox.js';
export { SandboxViolationError, createSandboxedFs } from './policy/sandboxed-fs.js';
export type { SandboxedFsOptions } from './policy/sandboxed-fs.js';
export { createApprovalBroker } from './policy/approval.js';
export type {
  ApprovalAnswerer,
  ApprovalAuditEvent,
  ApprovalBroker,
  ApprovalBrokerOptions,
  ApprovalRequest,
} from './policy/approval.js';
export { createLogAuditSink, createSandboxRuntime } from './policy/runtime.js';
export type {
  AuditEvent,
  SandboxRuntime,
  SandboxRuntimeOptions,
} from './policy/runtime.js';

export { buildSeatbeltProfile, createSeatbeltBackend } from './shell/os-sandbox.js';
export type {
  OsSandboxBackend,
  OsSandboxContext,
  OsSandboxProbe,
  SeatbeltBackendOptions,
  WrappedCommand,
} from './shell/os-sandbox.js';
export { createSandboxedShellRunner } from './shell/sandboxed.js';
export type {
  Confinement,
  SandboxedShellRunner,
  SandboxedShellRunnerOptions,
} from './shell/sandboxed.js';

export { ReadTracker } from './tools/observation.js';
export type { ReadStatus } from './tools/observation.js';

export {
  isInsideWorkdir,
  joinRelative,
  resolveToolPath,
  toPosixPath,
  toRelativePath,
} from './tools/paths.js';
export type { ResolvedToolPath } from './tools/paths.js';

export { createFsEditTool, createFsReadTool, createFsWriteTool } from './tools/fs.js';
export type { FsReadConfig } from './tools/fs.js';

export {
  DEFAULT_IGNORED_DIRS,
  createGlobTool,
  createGrepTool,
  globToRegExp,
} from './tools/search.js';
export type { SearchToolConfig } from './tools/search.js';

export { CHARS_PER_TOKEN, estimateTokens, tokensToChars } from './context/tokens.js';

export { createFileSpillStore, retainOutput, splitHeadTail } from './context/spill.js';
export type {
  FileSpillStoreOptions,
  RetainOptions,
  SpillResult,
  SpillStore,
} from './context/spill.js';

export {
  createTokenMeter,
  measureRequest,
  totalPromptTokens,
} from './context/meter.js';
export type {
  ContextPressure,
  PressureSource,
  TokenMeter,
  TokenMeterOptions,
} from './context/meter.js';

export { DEFAULT_SUMMARY_SYSTEM, createCompactor } from './context/compactor.js';
export type {
  CompactionEventInput,
  CompactionPlan,
  CompactionReason,
  Compactor,
  CompactorOptions,
  ContextPressureLike,
  SummarizeOptions,
  SummarizeResult,
} from './context/compactor.js';

export { createContextManager } from './context/manager.js';
export type {
  CompactOutcome,
  ContextManager,
  ContextManagerOptions,
} from './context/manager.js';

export {
  createLocalAttachmentStore,
  sniffImageMime,
} from './context/attachments.js';
export type {
  Attachment,
  AttachmentStore,
  LocalAttachmentStoreOptions,
} from './context/attachments.js';

export { createReadImageTool } from './tools/images.js';
export type { ReadImageConfig } from './tools/images.js';

export { runAgentLoop } from './agent/loop.js';
export type {
  AgentLoopEvent,
  AgentLoopEventRecord,
  AgentLoopLlmEvent,
  AgentLoopListener,
  AgentLoopOptions,
  AgentLoopToolEvent,
  AgentRunResult,
  AgentRunStatus,
} from './agent/loop.js';

export { createSubagentRunner } from './agent/subagent.js';
export type {
  SubagentRunResult,
  SubagentRunner,
  SubagentRunnerOptions,
} from './agent/subagent.js';
export { createSubagentTool } from './tools/subagent.js';
export type { SubagentToolConfig } from './tools/subagent.js';

export { createSkillLoader, parseSkillMarkdown } from './skills/loader.js';
export type {
  ParsedSkillFile,
  SkillEntry,
  SkillLoadResult,
  SkillLoader,
  SkillLoaderOptions,
  SkillScope,
  SkillSource,
} from './skills/loader.js';
export { createSkillSearchTool, createSkillTool } from './tools/skill.js';
export type { SkillToolConfig } from './tools/skill.js';

export { MCP_PROTOCOL_VERSION, McpError, createMcpStdioClient } from './mcp/client.js';
export type {
  McpCallResult,
  McpClient,
  McpStdioClientOptions,
  McpToolInfo,
} from './mcp/client.js';
export { createMcpToolset, mcpToolName } from './tools/mcp.js';
export type { McpToolsetConfig } from './tools/mcp.js';

export {
  DEFAULT_PRICES,
  estimateCost,
  formatUsageReport,
} from './context/cost.js';
export type { CostEstimate, ModelPrice } from './context/cost.js';

export { createAgentRuntime, mapLoopEvent } from './app/runtime.js';
export type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentTurnResult,
} from './app/runtime.js';

export { describeAction, parseArgs, runCli } from './cli/main.js';
export type { CliCommand, CliIo, CliOptions } from './cli/main.js';

export type {
  Action,
  PolicyDecision,
  PolicyGate,
  PolicyOutcome,
  SandboxMode,
} from './policy/gate.js';

export {
  PROVIDER_PRESETS,
  configPaths,
  fetchModels,
  findPreset,
  loadConfig,
  presetFor,
  readEnvFile,
  resolveEnv,
  saveConfig,
  writeEnvValue,
} from './config/store.js';
export type {
  AgentCoreConfig,
  ConfigPaths,
  ModelListResult,
  ProviderKind,
  ProviderPreset,
} from './config/store.js';

export { apiKeyEnvFor, createProviderFor } from './llm/factory.js';
export type { ProviderOverrides } from './llm/factory.js';
