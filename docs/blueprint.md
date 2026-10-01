# Agent Core cá nhân — Blueprint + bộ Prompt sinh source

> Mục đích: đưa cho một AI coding agent (DSH, Claude Code, Codex…) để nó sinh ra **source agent core chạy được**, không phải demo đồ chơi.
> Cách dùng: dán **§2 Master Prompt** cho milestone M0, sau đó mỗi phiên dán **§3 prompt của milestone kế tiếp**. Giữ file này trong repo để mọi phiên sau tự đọc.

---

## 1. Vì sao prompt "hãy viết cho tôi một AI agent framework" luôn thất bại

| Lỗi AI luôn mắc | Hậu quả | Cách chặn trong prompt |
|---|---|---|
| 1. Toy loop `while: llm() → tool → llm()` | Không turn/step, không budget, không cancel, treo vô hạn | Bắt buộc state machine + `maxSteps` + `AbortSignal` xuyên suốt |
| 2. Chỉ giữ `messages[]` trong RAM | Không resume, không fork, không audit, không replay | Bắt buộc **event-sourced log**, history chỉ là projection |
| 3. Schema tool viết tay rời validator | Model gọi sai, lỗi khó truy, schema lệch code | Một nguồn sự thật duy nhất: type → JSON Schema tự sinh |
| 4. Side effect không qua policy | Không sandbox, không approval, xoá nhầm file | Mọi fs/shell/network phải qua `PolicyGate` |
| 5. Không quản context/token | Chết ở context limit hoặc cháy tiền | `TokenMeter` + `Compactor` + `SpillStore` là module hạng nhất |
| 6. Không test offline | AI báo "done" nhưng code không chạy | Fake provider + snapshot test + lệnh verify bắt buộc dán output |

**Nguyên tắc vàng:** đừng yêu cầu "viết framework". Yêu cầu **một lát cắt dọc (vertical slice) có hợp đồng interface cứng, chạy được, test offline xanh**. Độ "hoàn chỉnh" đến từ việc lặp 8 milestone, không đến từ một prompt khổng lồ.

---

## 2. Master Prompt (dán nguyên khối)

```text
You are a senior systems engineer implementing a production-grade personal AI agent core.
Work in the repository at <REPO_PATH>. Follow this contract EXACTLY.

## STACK (do not change without asking)
- Language: TypeScript (strict), Node 24, ESM.
- Package manager: pnpm. Test: vitest. Lint/format: eslint + prettier.
- Validation: zod (single source of truth for tool schemas).
- No framework: no LangChain/LlamaIndex/Vercel AI SDK. Raw fetch for HTTP.
- Dependencies must be listed and justified BEFORE writing code. Max 8 runtime deps.

## GOAL
A single-process agent core that: reads a user task, streams a model response,
executes tools under a policy gate, appends every model-visible fact to a durable
append-only session log, survives kill -9 and resumes, and can be driven by a CLI.

## NON-GOALS (do not implement now)
Web UI, multi-tenant auth, vector DB / RAG, fine-tuning, plugin marketplace, cloud deploy.

## MODULE LAYOUT (create exactly these)
src/
  llm/types.ts        LLMProvider interface + request/delta/usage types
  llm/deepseek.ts     OpenAI-compatible adapter (streaming SSE, tool_call deltas, usage)
  llm/fake.ts         deterministic in-memory provider for tests (scripted responses)
  session/events.ts   SessionEvent union + seq rules
  session/log.ts      append-only JSONL log: append() with fsync, read(fromSeq), lock file
  session/projection.ts  replay(events) -> model messages (compaction-aware)
  agent/loop.ts       turn/step state machine, budgets, cancel, steering
  tools/registry.ts   ToolDef registration, schema->JSON Schema, dispatch, timeout, retention
  tools/fs.ts         read, write, edit, glob, grep (all writes go through ctx.fs)
  tools/bash.ts       one-shot command, exit markers, cwd, env allowlist
  tools/jobs.ts       run_in_background, job_output, job_list, job_kill
  tools/todo.ts       whole-list replacement task list
  policy/gate.ts      PolicyGate: sandbox mode + approval, fail-closed
  policy/sandbox.ts   path resolution, workspace confinement, temp grants
  context/meter.ts    token estimate + provider usage reconciliation, pressure
  context/compactor.ts  threshold compaction via one model call, retains recent N
  context/spill.ts    oversized tool output -> head/tail + readable file path
  jobs/registry.ts    child process registry, ring-buffer output, kill, notices
  config/index.ts     layered config: defaults <- file <- env <- CLI flags
  cli/main.ts         REPL: stream render, tool lines, approval prompt, /resume /fork /compact
  index.ts            public exports
tests/                unit + integration (offline, no network)

## HARD INTERFACES (implement verbatim; you may add fields, never remove/rename)

// llm/types.ts
export type Role = 'system' | 'user' | 'assistant' | 'tool';
export interface ToolSchema { name: string; description: string; parameters: object }
export interface Message { role: Role; content: string; toolCallId?: string; toolCalls?: ToolCall[] }
export interface ToolCall { id: string; name: string; args: unknown }
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
export interface LLMRequest {
  model: string; system: string; messages: Message[]; tools: ToolSchema[];
  maxOutputTokens: number; reasoningEffort?: 'low' | 'medium' | 'high'; signal: AbortSignal;
}
export type LLMDelta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argsJsonDelta?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'stop'; reason: 'end' | 'tool_calls' | 'length' | 'cancelled' | 'error'; errorCode?: string };
export interface LLMProvider {
  readonly id: string;
  stream(req: LLMRequest): AsyncIterable<LLMDelta>;
}

// session/events.ts  — every event has a monotonically increasing seq, starting at 1
export type SessionEvent =
  | { seq: number; t: 'session.created'; sessionId: string; cwd: string; model: string; at: number }
  | { seq: number; t: 'turn.start'; turn: number; input: string; at: number }
  | { seq: number; t: 'step.start'; turn: number; step: number; at: number }
  | { seq: number; t: 'llm.request'; requestId: string; request: LLMRequest; at: number }
  | { seq: number; t: 'llm.response'; requestId: string; text: string; toolCalls: ToolCall[]; usage: Usage; stop: string; at: number }
  | { seq: number; t: 'tool.call'; callId: string; name: string; args: unknown; at: number }
  | { seq: number; t: 'tool.result'; callId: string; ok: boolean; code?: string; output: string; spillPath?: string; durationMs: number; at: number }
  | { seq: number; t: 'approval.request'; requestId: string; action: Action; at: number }
  | { seq: number; t: 'approval.decision'; requestId: string; decision: 'allow' | 'deny'; by: 'user' | 'policy'; at: number }
  | { seq: number; t: 'compaction'; coveredFrom: number; coveredTo: number; summary: string; usage: Usage; at: number }
  | { seq: number; t: 'turn.end'; turn: number; status: 'done' | 'cancelled' | 'error' | 'budget_exceeded'; at: number };

// tools/registry.ts
export interface ToolCtx {
  signal: AbortSignal; workdir: string; fs: SandboxedFs; shell: ShellRunner;
  jobs: JobRegistry; requestApproval(a: Action): Promise<boolean>; log(line: string): void;
}
export interface ToolResult { ok: boolean; code?: string; output: string; spillPath?: string; meta?: Record<string, unknown> }
export interface ToolDef<A = unknown> {
  name: string; description: string; schema: z.ZodType<A>;
  parallelSafe: boolean; requiresApproval: 'never' | 'always' | 'policy';
  timeoutMs: number; maxInlineTokens?: number;
  run(args: A, ctx: ToolCtx): Promise<ToolResult>;
}

// policy/gate.ts
export type SandboxMode = 'read-only' | 'workspace-write' | 'full-access';
export type Action =
  | { kind: 'fs.write'; path: string } | { kind: 'fs.read'; path: string }
  | { kind: 'shell.exec'; command: string; cwd: string } | { kind: 'net.fetch'; url: string };
export interface PolicyGate {
  readonly mode: SandboxMode;
  decide(action: Action): Promise<{ outcome: 'allow' | 'deny' | 'ask'; reason?: string }>;
}

## INVARIANTS (violating any of these is a bug, add a test for each)
1. The session log is the single source of truth. Model history is ALWAYS derived by replaying events.
2. Compaction never deletes events; it records a covered range that the projection hides.
3. Every filesystem mutation and every shell execution passes through PolicyGate. No exceptions.
4. Tool schemas are generated from the zod schema; never hand-write a second copy.
5. Cancellation propagates: AbortSignal reaches the provider, every tool, and every child process.
   Cancelling must leave no orphan process and must append a turn.end event.
6. Budgets are enforced, not advisory: maxSteps, tokenBudget, wallClockMs, toolTimeout.
7. Every tool returns a stable machine code on failure (e.g. E_NO_READ, E_PATH_ESCAPE, E_TIMEOUT)
   plus a human-readable recovery hint, so the model can self-correct.
8. Tool output above maxInlineTokens is spilled to a file; the model sees head + tail + path.
9. Secrets come from env only; they must never appear in the session log or in error output.
10. Tests never touch the network and never depend on wall-clock timing.

## WORKING PROTOCOL
- FIRST: print your plan (files to create, dependency list with justification, test list). Then wait.
- Implement ONE milestone at a time. Never write code for a later milestone.
- No stubs, no `// TODO`, no `throw new Error('not implemented')`, no mock logic in src/.
- After each milestone run: `pnpm typecheck && pnpm lint && pnpm test`
  and paste the REAL terminal output. If it fails, fix it before reporting.
- Never invent an API. If unsure about a library's shape, write the smallest probe test first.
- If the contract seems wrong, SAY SO and propose a change; do not silently deviate.
- Report at the end of each milestone in this exact shape:
  Files: <list> | Deps added: <list> | Tests: <n passed/n failed> | Invariants covered: <ids> | Not done: <list>

## DEFINITION OF DONE for M0 (the only milestone in this prompt)
- Repo builds, typechecks, lints, and `pnpm test` is green.
- `src/llm/types.ts`, `src/session/events.ts`, `src/tools/registry.ts`, `src/policy/gate.ts`
  exist with the EXACT interfaces above, fully typed, documented with JSDoc.
- `src/llm/fake.ts` implements a scripted provider: it yields a predetermined sequence of
  LLMDelta for tests, with no timers.
- One test per invariant 1-5 that is testable at this stage; each test named
  `invariant-N: <claim>`.
- `docs/ARCHITECTURE.md` explaining the data flow in ≤ 60 lines.
Start by printing the plan.
```

**Vì sao prompt này hiệu quả:** nó khoá interface trước (AI không thể "sáng tạo" lung tung), khoá stack (không tự ý kéo framework), cấm stub, bắt dán output lệnh thật, và chia nhỏ để mỗi phiên là một vertical slice kiểm chứng được.

---

## 3. Tám prompt theo milestone

Mỗi prompt giữ nguyên phần `STACK`, `HARD INTERFACES`, `INVARIANTS`, `WORKING PROTOCOL` ở §2 (dán lại hoặc để AI đọc file), chỉ thay phần GOAL/DONE.

**M1 — Provider thật**
> Implement `llm/deepseek.ts`: SSE streaming, accumulate `tool_call` deltas by index, parse usage (gồm cache hit/miss nếu có), map lỗi HTTP sang mã ổn định + retry có backoff cho 429/5xx, tôn trọng `signal`. DoD: test bằng HTTP server cục bộ giả lập SSE (không ra internet), case: stream cắt giữa chừng, 429 rồi thành công, abort giữa stream.

**M2 — Session log + replay/resume/fork**
> Implement `session/log.ts` (JSONL append + fsync + lock) và `session/projection.ts`. DoD: test `append → kill → reopen → replay` cho history y hệt; test fork tạo session mới từ seq N; test log hỏng dòng cuối thì bỏ qua dòng đó và vẫn đọc được phần còn lại.

**M3 — Tool registry + fs tools**
> Implement `tools/registry.ts` + `tools/fs.ts` (read/read_image/write/edit/glob/grep). DoD: schema JSON sinh từ zod có snapshot test; dispatch song song chỉ với `parallelSafe`; timeout trả `E_TIMEOUT`; output lớn bị spill; test read-before-edit (sửa file chưa đọc → `E_NO_READ`).

**M4 — Bash + jobs**
> Implement `tools/bash.ts` + `jobs/registry.ts` + `tools/jobs.ts`. DoD: mọi lệnh là job; timeout foreground trả job id; `job_kill` kết thúc tiến trình con thật (test bằng `sleep 30` rồi kiểm tra không còn process); output ring-buffer không phình RAM.

**M5 — Policy: sandbox + approval**
> Implement `policy/sandbox.ts` + `policy/gate.ts` + `tools/` wiring. DoD: `workspace-write` chặn ghi ra `..` và ra `/tmp` ngoài grant (test bằng path traversal, symlink, `~`); `read-only` chặn mọi mutation; approval fail-closed khi không có answerer; mọi quyết định ghi event audit.

**M6 — Context: meter + compactor + spill**
> Implement `context/meter.ts`, `context/compactor.ts`, `context/spill.ts`. DoD: pressure tính từ usage thật của provider, không ước lượng khi có số thật; compact dùng **một** model call và giữ `retainRatio` cuối; sau compact replay vẫn tái tạo đúng history; pruner cắt tool result trước khi compact.

**M7 — Subagent + skills + MCP**
> Implement subagent in-process (context con độc lập, chỉ trả summary về cha), skill loader (`SKILL.md`: catalog name+description trong prompt, full text nạp theo yêu cầu), MCP client tối thiểu (stdio: `initialize`, `tools/list`, `tools/call`). DoD: test subagent không làm phình token cha; test skill không nạp full text khi chưa gọi.

**M8 — CLI/TUI + báo cáo chi phí**
> Implement `cli/main.ts`: stream render, dòng tool, prompt approval, `/resume`, `/fork`, `/compact`, `/model`, `/export`. DoD: `agent "task"` chạy end-to-end với provider giả qua script fixture; in bảng token in/out/cache hit và chi phí ước tính cuối phiên.

---

## 4. Checklist "đủ hoàn chỉnh" — dùng để nghiệm thu

| Hạng mục | Tiêu chí đo được |
|---|---|
| Bền vững | `kill -9` giữa lúc chạy → mở lại resume đúng bước, không mất tool result |
| Bất biến log | Sửa 1 dòng JSONL bất kỳ → replay phát hiện sai lệch (checksum) |
| Cách ly | Test ghi file ra ngoài workspace ở mode `workspace-write` phải fail |
| Huỷ | Abort giữa stream → không còn child process, log có `turn.end: cancelled` |
| Ngân sách | Vượt `maxSteps`/`tokenBudget` → dừng và ghi `budget_exceeded`, không treo |
| Schema | Đổi zod schema → JSON Schema gửi model đổi theo, không cần sửa tay |
| Ngữ cảnh | Hội thoại 200k token vẫn chạy nhờ compact; replay tái tạo y hệt |
| Output lớn | Tool trả 5MB → model chỉ thấy head/tail + path, file đọc lại được |
| Offline test | `pnpm test` chạy không cần mạng, không flaky khi chạy 10 lần |
| Bảo mật | `grep -r "sk-" src/ tests/` không ra kết quả; log không chứa env secrets |
| Đo lường | Cuối phiên in được input/output/cache-hit tokens + chi phí |

---

## 5. Cách vận hành với DSH (hoặc Codex/Claude Code)

1. Tạo workspace trống, `git init`, rồi **đặt chính file này + `AGENTS.md`** vào repo. `AGENTS.md` chỉ cần 10 dòng: stack, lệnh verify (`pnpm typecheck && pnpm lint && pnpm test`), 10 invariant, "không stub, không TODO".
2. Phiên 1: bật `/plan`, dán Master Prompt (M0), **duyệt plan trước** khi cho code.
3. Mỗi milestone = **một phiên riêng**, commit trước khi sang phiên sau. Nhờ vậy context không phình và lỗi khoanh vùng được.
4. Không bao giờ nhận câu "should work". Bắt buộc: dán output thật của `pnpm test`, và nếu fail thì tự sửa.
5. Dùng permission preset `workspace-write` để agent không ghi ra ngoài repo; bật approval cho `shell.exec` lạ.
6. Khi cần chạy tự động: `dsh --profile headless "chạy pnpm test và sửa lỗi"` — dùng được cho CI.
7. Sau M8, muốn tiết kiệm token khi vận hành: `reasoningEffort: medium`, giữ prefix ổn định để DeepSeek cache hit, và đẩy việc đọc nhiều file cho subagent.

---

## 6. Mẫu `AGENTS.md` tối thiểu cho repo agent core

```markdown
# agent-core
Stack: TypeScript strict, Node 24 ESM, pnpm, vitest, zod. Không dùng framework agent.
Verify: pnpm typecheck && pnpm lint && pnpm test   (offline, không mạng)
Rules:
- Không stub, không TODO, không mock trong src/.
- Interface trong src/llm/types.ts, src/session/events.ts, src/tools/registry.ts,
  src/policy/gate.ts là hợp đồng cứng: chỉ thêm field, không đổi tên.
- Invariant 1-10 trong agent-core-blueprint.md §2 là điều kiện merge.
- Mọi fs/shell/network phải qua PolicyGate.
- Không in secret ra log/stdout.
```
