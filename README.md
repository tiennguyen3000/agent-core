# agent-core

Agent core cá nhân: event-sourced, tool-driven, policy-gated.
Trạng thái: **M7 — subagent + skills + MCP** (vòng lặp agent thật, agent con context riêng, skill
nạp theo yêu cầu, MCP stdio). Chưa có CLI.

## Lệnh

```bash
pnpm install
pnpm typecheck     # tsc --noEmit, 0 error
pnpm lint          # eslint, 0 warning/error
pnpm test          # vitest, offline, không phụ thuộc thời gian
```

## Đã có

| Đường dẫn | Vai trò | Milestone |
|---|---|---|
| `src/llm/types.ts` | `LLMProvider`, `LLMRequest`, `LLMDelta`, `Usage` | M0 |
| `src/llm/fake.ts` | provider script hoá, tất định, không timer | M0 |
| `src/llm/sse.ts` | parser SSE không phụ thuộc thư viện (cắt chunk tuỳ ý, CRLF, UTF-8) | M1 |
| `src/llm/deepseek.ts` | provider DeepSeek: stream chat-completions, gom `tool_call` theo index, retry 429/5xx/network có backoff + jitter, map lỗi sang mã ổn định, redact API key | M1 |
| `src/llm/errors.ts` | `ProviderError`, bộ mã lỗi, `redactSecret` | M1 |
| `src/llm/assemble.ts` | gộp delta stream thành một response hoàn chỉnh (gom `tool_call` theo index, báo `malformedToolArgs`) | M2 |
| `src/session/events.ts` | union `SessionEvent` + luật `seq` liên tục | M0 |
| `src/session/projection.ts` | `project()` / `replay()`: dựng transcript từ log, xử lý compaction | M0 |
| `src/session/log.ts` | log append-only JSONL: fsync từng event, lock file (chống 2 writer, tha lock chết), **sửa torn tail** khi mở, từ chối log hỏng giữa dòng / nhảy seq, `forkSessionLog`, `listSessionIds` | M2 |
| `src/tools/registry.ts` | `ToolDef`, `ToolRegistry`: dispatch + gate + timeout + mã lỗi, `dispatchMany` (chạy song song chỉ tool `parallelSafe`), retention `maxInlineTokens` | M0, M3 |
| `src/tools/fs.ts` | `fs_read`, `fs_write`, `fs_edit`: read-before-edit, chặn ghi ngoài workspace, `fs_read` file thiếu thì ghi nhận "vắng mặt" để cho phép tạo | M3 |
| `src/tools/search.ts` | `fs_glob`, `fs_grep`: glob `**`/`*`/`?`/`{a,b}`, regex grep, bỏ qua `.git`/`node_modules`, cap entry/file/byte và báo khi dừng sớm | M3 |
| `src/tools/observation.ts` | `ReadTracker`: `ok` / `not-read` / `stale` cho từng path | M3 |
| `src/tools/paths.ts` | quy đổi path (port nhận absolute, model thấy relative) + kiểm tra thoát workspace | M3 |
| `src/context/tokens.ts` | ước lượng token theo ký tự (chỉ để cắt output; số thật lấy từ provider) | M3 |
| `src/context/spill.ts` | output quá lớn → head + tail + đường dẫn file đọc lại; store lỗi thì **không mất** output | M3 |
| `src/policy/gate.ts` | `PolicyGate`, `SandboxMode`, `Action` | M0 |
| `src/jobs/registry.ts` | job registry thật: ring buffer có chặn (báo `droppedChars`), `kill` theo **process group** (SIGTERM → SIGKILL sau grace), `wait` có deadline, `drainNotices`, env allowlist | M4 |
| `src/jobs/types.ts` | hợp đồng `JobRegistry`, `JobSnapshot`, `JobOutput`, `JobNotice` | M4 |
| `src/shell/bash.ts` | `ShellRunner` thật: stdout/stderr tách riêng, cwd, cancel giết process group, cap output có thông báo | M4 |
| `src/tools/bash.ts` | `bash` + `job_output` + `job_list` + `job_kill` | M4 |
| `src/fs/local.ts` | backend đĩa thật: ghi **atomic** (temp + fsync + rename), `list`, `exists` | M5 |
| `src/policy/sandbox.ts` | `checkWrite` (một nguồn luật duy nhất) + `createSandboxPolicy` (allow/deny/ask, audit từng quyết định) | M5 |
| `src/policy/sandboxed-fs.ts` | `ctx.fs` bị nhốt: chặn ghi ngoài workspace ở tầng port, ném `E_POLICY_DENIED` | M5 |
| `src/policy/approval.ts` | approval broker **fail-closed**: không có answerer / answerer lỗi / quá hạn ⇒ deny, có audit | M5 |
| `src/policy/runtime.ts` | `createSandboxRuntime` ghép gate + fs + shell + approval + audit; `createLogAuditSink` đẩy audit vào session log | M5 |
| `src/shell/sandboxed.ts` | `ShellRunner` có policy: read-only từ chối chạy, có OS backend thì bọc, công bố `confinement` | M5 |
| `src/shell/os-sandbox.ts` | seam OS sandbox + backend macOS seatbelt (`buildSeatbeltProfile`) + `probe()` | M5 |
| `src/context/meter.ts` | `TokenMeter`: usage thật của provider thắng ước lượng; `measureRequest` chỉ dùng khi chưa có usage | M6 |
| `src/context/compactor.ts` | `plan()` thuần (ngưỡng, giữ đuôi, không cắt rời tool call) + `summarize()` đúng **một** model call | M6 |
| `src/context/manager.ts` | `createContextManager`: prune trước (miễn phí), compact sau; trả `CompactionEventInput` để caller ghi log | M6 |
| `src/context/attachments.ts` | attachment store content-addressed (sha256), dedupe, `sniffImageMime` theo magic bytes | M6 |
| `src/tools/images.ts` | `fs_read_image`: validate bằng magic bytes, lưu attachment, trả id thay vì bytes | M6 |
| `src/agent/loop.ts` | `runAgentLoop`: vòng lặp thật (step, budget `maxSteps`/`tokenBudget`/`wallClockMs`, cancel, `onEvent` để caller ghi log) | M7 |
| `src/agent/subagent.ts` | `createSubagentRunner`: agent con **context riêng**, chỉ trả summary về cha | M7 |
| `src/tools/subagent.ts` | tool `subagent` — cha chỉ nhận câu trả lời cuối, không nhận từng bước | M7 |
| `src/skills/loader.ts` | quét `SKILL.md`/`<name>.md`, frontmatter, catalog chỉ gồm tên + mô tả; **nạp toàn văn theo yêu cầu** | M7 |
| `src/tools/skill.ts` | tool `skill` — trả về hướng dẫn đầy đủ của một skill | M7 |
| `src/mcp/client.ts` | MCP stdio client: JSON-RPC 2.0 phân cách bằng newline, `initialize`/`tools/list`/`tools/call`, timeout, đóng | M7 |
| `src/tools/mcp.ts` | biến tool của MCP thành `ToolDef` tên `mcp__<server>__<tool>`, quảng cáo schema của server | M7 |
| `tests/invariant-*.spec.ts` | mỗi invariant một test | M0 |
| `tests/e2e-session-round.spec.ts` | E2E 1 vòng: provider → policy → log → replay → restart | M2 |

### Tool đang có

| Tool | Song song | Duyệt | Ghi chú |
|---|---|---|---|
| `fs_read` | có | không | đọc theo dòng, `offset`/`limit`, cap 2.400 token |
| `fs_glob` | có | không | glob trong workspace, cap 200 kết quả |
| `fs_grep` | có | không | regex, `glob` lọc file, cap 100 match / 1 MiB mỗi file / 8 MiB mỗi lần quét |
| `fs_write` | không | `policy` | ghi đè cả file, bắt buộc đọc trước |
| `fs_edit` | không | `policy` | thay literal, từ chối khi mơ hồ (`E_AMBIGUOUS_MATCH`) |
| `bash` | không | `policy` | mọi lệnh là job; quá `timeout_ms` thì **trả job id** chứ không giết; cancel thì giết |
| `job_output` | có | không | đọc delta theo `since`, `wait_ms` để chờ job xong |
| `job_list` | có | không | trạng thái, exit code, thời lượng, lệnh |
| `job_kill` | không | không | SIGTERM → SIGKILL, chỉ trả về khi tiến trình đã chết |
| `fs_read_image` | có | không | png/jpeg/webp/gif, kiểm magic bytes, lưu attachment (sha256), cap 5 MiB |
| `subagent` | không | không | agent con context riêng; cha chỉ nhận summary (đòn tiết kiệm token) |
| `skill` | có | không | nạp toàn văn một skill trong catalog của system prompt |
| `mcp__<server>__<tool>` | không | tuỳ chọn | cầu nối tới MCP server qua stdio; schema do server quyết định |

`fs_read_image` **chưa có**: `Message.content` hiện là text-only, nên ảnh cần tầng attachment
(M6) trước khi có thể đưa vào hội thoại.

### Cắm provider thật

```ts
import { DeepSeekProvider } from './src/index.js';

const provider = new DeepSeekProvider({
  // baseUrl mặc định: https://api.deepseek.com/v1
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  maxAttempts: 3,
  requestTimeoutMs: 600_000,
});

for await (const delta of provider.stream(request)) {
  // text | reasoning | tool_call | usage | stop
}
```

Retry chỉ xảy ra **trước khi delta đầu tiên của một lần thử được phát ra**; sau đó lỗi kết thúc bằng
`stop: error` để caller tự quyết định, tránh nhân đôi nội dung. Huỷ giữa stream kết thúc bằng
`stop: cancelled` (không gọi `onError`).

### Live smoke test (tuỳ chọn, cần mạng)

`pnpm test` **không bao giờ** gọi mạng. Muốn xác nhận wire format thật:

```bash
DEEPSEEK_API_KEY=sk-... DEEPSEEK_LIVE_MODEL=deepseek-flash pnpm test:live
```

File `tests/live/deepseek-smoke.live.spec.ts` tự skip khi thiếu `DEEPSEEK_API_KEY`. Nó kiểm tra 4
giả định mà bộ test offline không thể xác nhận: khung SSE thật, tên field `usage` +
`stream_options.include_usage`, `prompt_cache_hit_tokens`, và shape của `tool_calls` stream.
Tổng ~6 request nhỏ, `max_tokens` bị chặn.

**Đã chạy thật và xanh 5/5** với `deepseek-flash` (xem số đo, phát hiện và phần còn để ngỏ ở
[`docs/live-findings.md`](docs/live-findings.md)). Ba kết luận đáng nhớ:

- `inputTokens + cacheReadTokens` = đúng tổng prompt, ổn định qua nhiều lần gọi → mapping cache
  không tính trùng.
- `reasoning_tokens` **nằm trong** `completion_tokens`, nên chi phí output bao gồm reasoning ẩn.
- Cache prefix của DeepSeek dùng chung giữa các process và **tỉ lệ hit phụ thuộc độ lớn prefix**
  (65% với prompt 591 token, nhưng ~99% với prefix hàng trăm nghìn token) — đây là lý do định
  lượng được cho lời khuyên "giữ prefix ổn định".

## Chưa có (theo milestone)

M8 CLI: ghép provider + tool + log + context + sandbox thành một app chạy được (`dsh`-like), kèm
`/compact`, `--resume`, `<command> <args>`.

### Điều gì đã kiểm chứng ở M7

- **Vòng lặp**: chạy nhiều step, nạp lỗi tool về cho model (`[E_UNKNOWN_TOOL] …`), dừng đúng ở
  `maxSteps`/`tokenBudget`/`wallClockMs`, cancel giữa run, giữ nguyên text một phần khi provider lỗi.
- **Cô lập context của subagent**: test khẳng định mảng message của cha **không đổi** sau khi agent
  con chạy xong, và request của con bắt đầu từ đúng `task` (không thấy hội thoại của cha).
- **Skill nạp theo yêu cầu**: `promptSection()` chỉ có tên + mô tả (test assert phần thân skill
  **không** xuất hiện), toàn văn chỉ đọc khi gọi tool.
- **MCP**: chạy thật với một server stdio viết riêng trong `tests/helpers/mcp-server.mjs` —
  handshake, `tools/list`, `tools/call`, lỗi JSON-RPC, tool báo lỗi, server treo (timeout), server
  chết giữa chừng, dòng rác, và đóng client. Tất cả offline, không mạng.

### Ảnh: đã có gì, chưa kiểm chứng gì

- `fs_read_image` **lưu** ảnh (content-addressed) và trả attachment id; `Message.parts` + mapping
  trong provider đã gửi ảnh dạng `image_url` data-URI — phần này **có test offline** (assert body
  gửi đi).
- **Chưa chạy thật với model vision**: tài khoản DeepSeek đang dùng chỉ có `deepseek-flash` và
  `deepseek-v4-pro`, không có model thị giác. Vì vậy đường "ảnh → model" được coi là *đã nối dây
  nhưng chưa xác nhận đầu cuối*.
- Pruner hoạt động ở tầng projection: model thấy head + tail, còn văn bản đầy đủ vẫn nằm trong log
  (không tốn model call, không mất dữ liệu).

### Sandbox: điều gì đã thật, điều gì chưa

- **Ghi file**: nhốt thật, trong process. `createSandboxedFs` chặn mọi mutation ngoài workspace +
  temp grant, kể cả khi tool bỏ qua gate. Có test trên đĩa thật.
- **Shell**: chỉ nhốt thật khi mount `OsSandboxBackend`. Trên máy này
  `/usr/bin/sandbox-exec` **tồn tại nhưng bị từ chối apply** (`sandbox_apply: Operation not
  permitted`), nên `probe()` trả `available: false` và `shell.confinement` là `unconfined` trừ khi
  bạn mount backend. Đừng giả định shell đã bị nhốt — hãy đọc `confinement`.

Xem `docs/ARCHITECTURE.md` để hiểu luồng dữ liệu và `docs/blueprint.md` cho kế hoạch đầy đủ.
