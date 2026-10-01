# agent-core

Agent core cá nhân: event-sourced, tool-driven, policy-gated.
Trạng thái: **M4 — bash + job registry** (tiến trình con thật, ring buffer, kill theo process
group). Chưa có vòng lặp agent.

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

M5 sandbox + approval cho `ctx.fs`/`ctx.shell` · M6 token meter/compaction + attachment (để có
`fs_read_image`) · M7 subagent + skills + MCP · M8 CLI + vòng lặp agent.

Xem `docs/ARCHITECTURE.md` để hiểu luồng dữ liệu và `docs/blueprint.md` cho kế hoạch đầy đủ.
