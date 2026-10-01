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

## Chưa có (theo milestone)

M2 log bền vững (JSONL/fsync/lock, resume, fork) · M3 tool fs/glob/grep · M4 bash + jobs ·
M5 sandbox + approval · M6 token meter/compaction/spill · M7 subagent + skills + MCP · M8 CLI.

Xem `docs/ARCHITECTURE.md` để hiểu luồng dữ liệu và `docs/blueprint.md` cho kế hoạch đầy đủ.
