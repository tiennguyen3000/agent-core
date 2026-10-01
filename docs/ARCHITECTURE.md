# agent-core — luồng dữ liệu

```
        ┌────────────┐
        │  CLI/TUI   │  (M8)
        └─────┬──────┘
              │ task
        ┌─────▼──────┐   append    ┌──────────────────┐
        │ AgentLoop  ├────────────►│  Session log     │  nguồn sự thật duy nhất
        │  (M-later) │             │  seq 1..N        │  (M0: contract, M2: JSONL)
        └─────┬──────┘◄────────────┤                  │
              │      project(events)└──────────────────┘
              │                            ▲ compaction chỉ *che* dải seq
        ┌─────▼──────┐
        │ LLMProvider│  stream(LLMDelta): text | reasoning | tool_call | usage | stop
        └─────┬──────┘
              │ tool_call
        ┌─────▼─────────┐   authorize   ┌──────────────┐
        │ ToolRegistry  ├──────────────►│ PolicyGate   │  allow | deny | ask → fail-closed
        └─────┬─────────┘               └──────────────┘
              │ run(args, ctx)
        ┌─────▼───────────────────────────────────────┐
        │ fs · bash · jobs · web · subagent · skills  │  (M3–M7)
        └─────────────────────────────────────────────┘
```

## Vì sao thiết kế như vậy

**Log là nguồn sự thật (invariant 1).** Không ai giữ một mảng `messages[]` song song với log.
`project()` replay ra transcript mỗi lần cần, nên resume, fork, audit và telemetry đều dùng chung
một dữ liệu. Transcript không thể "trôi" khỏi lịch sử.

**Compaction che, không xoá (invariant 2).** `CompactionEvent` ghi `coveredFrom..coveredTo`;
`project()` bỏ qua dải đó và chèn một message tóm tắt. Sự kiện gốc vẫn nằm trong log nên replay
luôn tái tạo được đúng kết quả cũ, và người dùng vẫn đọc lại được toàn bộ lịch sử.

**Mọi side effect qua gate (invariant 3).** `ToolRegistry.dispatch` phân loại hành động thành
`Action`, hỏi `PolicyGate`, rồi mới chạy handler. Không mount gate + tool khai báo `policy`
⇒ **fail-closed** (`E_POLICY_DENIED`), không có đường tắt.

**Một nguồn schema (invariant 4).** Schema gửi model sinh từ chính zod schema dùng để validate
tham số; không có bản JSON viết tay thứ hai để lệch.

**Cancel lan truyền (invariant 5).** `AbortSignal` đi từ lời gọi xuống provider, xuống từng tool,
và `AbortController` con trong `dispatch` chuyển tiếp tín hiệu huỷ. Tool bị huỷ trả `E_CANCELLED`,
không để lại việc chạy nền.

**Mã lỗi ổn định (invariant 7).** `E_UNKNOWN_TOOL`, `E_BAD_ARGS`, `E_POLICY_DENIED`,
`E_APPROVAL_DENIED`, `E_CANCELLED`, `E_TIMEOUT`, `E_TOOL_FAILED` — model đọc mã lỗi và tự sửa,
thay vì nhận một chuỗi stack trace.

## Ranh giới module

`src/llm` không biết gì về tool. `src/tools` không biết gì về HTTP của provider. `src/session`
không import `src/tools`. `src/policy` không import gì ngoài type. Nhờ vậy M1–M8 chỉ việc cắm
implementation vào sau các port đã có.

## Tầng provider (M1)

`DeepSeekProvider` nói chuyện với endpoint chat-completions tương thích OpenAI. Ba quy tắc:

**Retry chỉ trước delta đầu tiên.** 429/5xx/lỗi mạng được thử lại với backoff luỹ thừa + jitter
(`baseRetryDelayMs`, `jitterRatio`, tôn trọng `Retry-After`). Khi một lần thử đã phát delta cho
caller thì replay sẽ nhân đôi nội dung, nên lỗi kết thúc bằng `stop: error` và caller quyết định.

**Huỷ không phải lỗi.** `request.signal` được truyền vào `fetch`; nhánh huỷ phát
`stop: cancelled` + `E_CANCELLED` và **không** gọi `onError`, để telemetry lỗi không bị nhiễu bởi
thao tác người dùng.

**Không rò credential.** Mọi chuỗi lấy từ response hoặc từ exception đều đi qua
`redactSecret(text, apiKey)` trước khi vào message hay `lastError` (invariant 9).

Bộ mã lỗi ổn định: `E_AUTH`, `E_BAD_REQUEST`, `E_MODEL_NOT_FOUND`, `E_CONTEXT_OVERFLOW`,
`E_RATE_LIMITED`, `E_SERVER`, `E_NETWORK`, `E_TIMEOUT`, `E_BAD_STREAM`, `E_CANCELLED`.

## Quy ước

- Mọi import nội bộ dùng đuôi `.js` (NodeNext ESM).
- Không `any`: dùng `unknown` + validate.
- Không `TODO`/`FIXME`/stub: eslint chặn ở mức error.
- Test chỉ dùng `FakeProvider` và các test double trong `tests/helpers` — không mạng, không timer.
