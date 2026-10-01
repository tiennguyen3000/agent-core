# agent-core

Agent core cá nhân: event-sourced, tool-driven, policy-gated.
Trạng thái: **M2 — session log bền vững** (JSONL + fsync + lock + repair, resume, fork). Chưa có
vòng lặp agent.

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
| `src/tools/registry.ts` | `ToolDef`, `ToolRegistry`, dispatch + gate + timeout + mã lỗi | M0 |
| `src/policy/gate.ts` | `PolicyGate`, `SandboxMode`, `Action` | M0 |
| `tests/invariant-*.spec.ts` | mỗi invariant một test | M0 |
| `tests/e2e-session-round.spec.ts` | E2E 1 vòng: provider → policy → log → replay → restart | M2 |

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

M3 tool fs/glob/grep · M4 bash + jobs ·
M5 sandbox + approval · M6 token meter/compaction/spill · M7 subagent + skills + MCP · M8 CLI.

Xem `docs/ARCHITECTURE.md` để hiểu luồng dữ liệu và `docs/blueprint.md` cho kế hoạch đầy đủ.
