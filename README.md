# agent-core

Agent core cá nhân: event-sourced, tool-driven, policy-gated.
Trạng thái: **M0 — contracts**. Chưa gọi LLM thật.

## Lệnh

```bash
pnpm install
pnpm typecheck     # tsc --noEmit, 0 error
pnpm lint          # eslint, 0 warning/error
pnpm test          # vitest, offline, không phụ thuộc thời gian
```

## Đã có trong M0

| Đường dẫn | Vai trò |
|---|---|
| `src/llm/types.ts` | `LLMProvider`, `LLMRequest`, `LLMDelta`, `Usage` |
| `src/session/events.ts` | union `SessionEvent` + luật `seq` liên tục |
| `src/session/projection.ts` | `project()` / `replay()`: dựng transcript từ log, xử lý compaction |
| `src/tools/registry.ts` | `ToolDef`, `ToolRegistry`, dispatch + gate + timeout + mã lỗi |
| `src/policy/gate.ts` | `PolicyGate`, `SandboxMode`, `Action` |
| `src/llm/fake.ts` | provider script hoá, tất định, không timer |
| `tests/invariant-*.spec.ts` | mỗi invariant một test |

## Chưa có (theo milestone)

M1 provider DeepSeek · M2 log bền vững (JSONL/fsync/lock, resume, fork) · M3 tool fs/glob/grep ·
M4 bash + jobs · M5 sandbox + approval · M6 token meter/compaction/spill · M7 subagent + skills + MCP ·
M8 CLI.

Xem `docs/ARCHITECTURE.md` để hiểu luồng dữ liệu và `docs/blueprint.md` cho kế hoạch đầy đủ.
