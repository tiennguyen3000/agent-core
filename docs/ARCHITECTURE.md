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

**Side effect qua gate (invariant 3).** `ToolRegistry.dispatch` phân loại hành động thành
`Action`, hỏi `PolicyGate`, rồi mới chạy handler. Không mount gate + tool khai báo `policy`
⇒ **fail-closed** (`E_POLICY_DENIED`), không có đường tắt. Từ M4, `action(args, ctx)` nhận thêm
context vì có quyết định cần workspace root — lệnh shell mang `cwd` của nó.

*Ranh giới hiện tại (nói rõ để không hiểu nhầm):* tool khai báo `requiresApproval: 'never'` **không**
gọi gate — đó là các tool không cần hỏi duyệt (đọc file trong workspace, todo). Việc thi hành
sandbox cho read/write sẽ nằm ở cổng `ctx.fs` / `ctx.shell` khi M5 dựng `SandboxedFs`, tức mọi
truy cập file đều đi qua một cổng duy nhất, còn gate ở `dispatch` lo phần *duyệt*. Khi làm M5, nếu
`ctx.fs` chưa bọc hết thì invariant 3 mới chỉ đúng một nửa.

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

## Session log bền vững (M2)

`<root>/<sessionId>/session.jsonl` + `session.lock`. Ba quy tắc:

**Ghi là bền.** Mỗi `append` ghi một dòng JSON rồi `fsync` **trước khi** trả về, nên `kill -9`
không làm mất event đã được xác nhận: reader mới mở sau đó vẫn thấy đủ.

**Torn tail được sửa, không bị lan.** Một lần ghi đứt (JSON cụt, thiếu `\n`) bị bỏ khi đọc; khi
**mở để ghi**, file được cắt về cuối dòng hợp lệ cuối cùng trước khi append — nếu không, dòng mới
sẽ nối thẳng vào mảnh cụt và phá log vĩnh viễn. Dòng hỏng ở **giữa** file thì từ chối tải
(`E_LOG_CORRUPT`) vì mất dữ liệu im lặng còn tệ hơn; `seq` nhảy cũng từ chối (`E_LOG_SEQ_GAP`).

**Một writer.** Lock file chứa `{pid, host}`. Mở lần hai bị `E_LOG_LOCKED`; lock chết (pid không
còn, cùng máy) hoặc lock không đọc được thì được tha; lock của máy khác thì không bao giờ tha.
`close()` nhả lock.

`forkSessionLog` copy tiền tố `seq <= upToSeq` sang session mới, giữ nguyên số `seq`, không sửa
session nguồn, và từ chối ghi đè target đã tồn tại.

## Tầng tool (M3)

**Path.** Cổng `ctx.fs` luôn nhận **absolute** path (để M5 sandbox kiểm soát một chỗ), còn mọi thứ
model nhìn thấy là path **relative** kiểu POSIX. `fs_write`/`fs_edit` tự kiểm tra `isInsideWorkdir`
trước khi gọi cổng, nên kể cả khi port chưa bị sandbox thì `../` và path tuyệt đối vẫn bị chặn
(`E_PATH_ESCAPE`). Đọc thì được phép ra ngoài workspace — chỉ ghi mới bị giới hạn.

**Read-before-edit (tuỳ chọn).** Nếu `ctx.reads` có `ReadTracker`, mutation chỉ được phép khi path
đó đã được đọc và nội dung chưa đổi kể từ lúc đọc (`E_NO_READ` / `E_STALE_READ`). Đọc một file
**không tồn tại** ghi lại "vắng mặt", và đó chính là điều kiện cho phép tạo đúng path ấy — nên
`fs_read` trên file thiếu trả về gợi ý dùng `fs_write` chứ không phải một lỗi cụt.

**Cap ở mọi nơi.** `fs_read` cap số dòng và số token inline; `fs_glob` cap số entry/kết quả;
`fs_grep` cap match, kích thước mỗi file, tổng byte quét, và bỏ qua file nhị phân. Khi chạm cap,
output **nói rõ đã dừng sớm** thay vì im lặng cắt.

**Song song có kỷ luật.** `dispatchMany` giữ đúng thứ tự model yêu cầu, chỉ chồng lấn các tool khai
báo `parallelSafe: true`, và các tool còn lại chạy đơn độc (tuỳ chọn `maxParallel` để chặn trên).
Kết quả trả về theo thứ tự gọi, không theo thứ tự hoàn thành.

**Retention (invariant 8).** Sau khi handler chạy, output vượt `maxInlineTokens` được thay bằng
head + tail + thông báo; nếu có `SpillStore` thì toàn văn nằm trong file để model đọc lại
(`spillPath`). Store lỗi thì **giữ nguyên output gốc** — mất file chấp nhận được, mất dữ liệu thì
không.

## Tầng job (M4)

**Mọi lệnh là job.** `bash` spawn qua job registry rồi *chờ*. Nếu lệnh còn chạy khi hết
`timeout_ms`, tool trả về **job id** và để tiến trình sống tiếp (`job_output` để theo dõi,
`job_kill` để dừng) — không giết việc mà model còn cần. Ngược lại, khi **turn bị cancel** thì
lệnh đó thuộc về turn đang chết, nên tool giết nó và trả `E_CANCELLED`: cancel không để lại
tiến trình mồ côi.

**Bộ nhớ có chặn.** Output nằm trong ring buffer (`maxOutputChars`, mặc định 256 KiB). Vượt ngưỡng
thì cắt từ đầu và **đếm** phần đã mất (`droppedChars`), lần đọc sau báo `lossy` để caller biết dữ
liệu không còn đầy đủ. Một lệnh in 10 GB không làm phình heap của agent.

**Kill là thật.** Tiến trình con được spawn `detached` (process group riêng trên POSIX) và
`kill` gửi tín hiệu vào **cả nhóm** — nên `bash -c "a | b"` chết trọn, không sót tiến trình cháu.
SIGTERM trước, SIGKILL sau `killGraceMs`, và `kill` chỉ resolve khi tiến trình đã chết thật.

**Env allowlist.** Con chỉ nhận các biến trong allowlist (PATH, HOME, LANG, TERM, TMPDIR, SHELL,
USER…) cộng `envPassthrough` của deployment. Secret của agent không tự động chảy vào mọi lệnh
(invariant 9).

**`ShellRunner` là đường đơn giản.** Tool `bash` đi qua job registry; `createBashShellRunner`
phục vụ các tool cần stdout/stderr tách riêng, cũng kill theo process group khi bị huỷ.

## Sandbox và approval (M5)

**Một luật, hai lần thi hành.** `checkWrite()` trong `src/policy/sandbox.ts` là nguồn luật duy nhất;
`createSandboxPolicy` dùng nó để *quyết định*, `createSandboxedFs` dùng nó để *thi hành*. Vì vậy
một quyết định và việc thực thi không thể lệch nhau, và một tool lách qua gate vẫn không ghi được
ra ngoài. Ghi ngoài workspace ⇒ gate trả `deny` (`E_POLICY_DENIED`); nếu deployment đặt
`outsideWorkspace: 'ask'` thì gate trả `ask` và quyền quyết định thuộc về con người — nhưng tool
`fs_write` vẫn giữ kiểm tra workspace riêng của nó, nên **cả hai lớp** phải đồng ý.

**Đọc không bị giới hạn.** Sandbox nhốt *hiệu ứng*, không nhốt việc đọc: `fs.read` luôn được phép,
đúng như hành vi đọc cục bộ. Chỉ mutation mới bị kiểm.

**Approval fail-closed.** `createApprovalBroker` chỉ cho phép khi có câu trả lời rõ ràng: không có
answerer ⇒ deny ngay; answerer ném lỗi ⇒ deny; hết hạn trước khi trả lời ⇒ deny. Mỗi yêu cầu và
mỗi quyết định đều phát ra audit (`approval.request` / `approval.decision` với `by: 'user' | 'policy'`).

**Audit là một phần của log.** `policy.decision` (kể cả các quyết định *allow*) được thêm vào union
`SessionEvent`; `createLogAuditSink` chuyển audit event thành `SessionEventInput` (bỏ `at` để log tự
đóng dấu). Nhờ vậy câu hỏi "vì sao lần ghi này được phép?" trả lời được sau khi sự việc xảy ra.

**Shell: phải nói thật về mức độ nhốt.** Trong process không thể nhốt một lệnh shell — chỉ OS mới
làm được. `createSandboxedShellRunner` từ chối chạy trong `read-only`, bọc lệnh bằng
`OsSandboxBackend` khi có, và **công bố** `confinement: 'os-sandbox' | 'unconfined'` để deployment
không phải đoán. Backend seatbelt (`buildSeatbeltProfile`) deny mặc định rồi chỉ cho ghi vào
workspace + temp grant. Trên máy phát triển này `sandbox-exec` tồn tại nhưng apply bị từ chối
(`sandbox_apply: Operation not permitted`), nên `probe()` trả `available: false` — và đó chính là
lý do seam này tồn tại thay vì một giả định.

## Quản lý context (M6)

**Số thật thắng ước lượng.** `TokenMeter` chỉ chấp nhận ước lượng khi chưa có usage nào; sau lần
response đầu tiên, `source` chuyển thành `'usage'` và mọi `recordEstimate` sau đó bị bỏ qua. Kích
thước prompt là `inputTokens + cacheReadTokens (+ cacheWriteTokens)` — đúng như đo được ở live test,
và `surfaceTokens` cộng thêm `outputTokens` vì câu trả lời cũng nằm trong request kế tiếp.

**Prune trước, tóm tắt sau.** Cắt tool result là việc *miễn phí* (chỉ đổi projection, văn bản gốc
vẫn trong log), nên nó bật sớm hơn (`pruneRatio` mặc định 0.5) so với compaction (`thresholdRatio`
mặc định 0.8). Nhờ vậy nhiều phiên được giải phóng áp lực mà không tốn model call nào.

**Compaction tốn đúng một request.** `plan()` thuần và miễn phí: nó chọn `coveredTo` bằng cách đi
ngược từ cuối, cộng dồn token của phần đuôi muốn giữ, rồi **lùi biên lại** nếu phần đuôi bắt đầu
bằng một tool result mồ côi — nếu không, projection sẽ bỏ nó và model mất kết quả. `summarize()`
sau đó chạy một request không tool, và kết quả được trả về dưới dạng `CompactionEventInput` để
caller ghi vào log: **log vẫn là nơi ghi duy nhất**.

**Chuỗi compaction không chồng summary.** Compaction mới luôn phủ từ seq 1; projection coi một
compaction là "bị phủ" khi có compaction khác phủ **nhiều hơn** nó (`other.coveredTo >
candidate.coveredTo`) rồi ẩn summary cũ. Luật này phải bất đối xứng: nếu đối xứng thì hai range
lồng nhau sẽ triệt tiêu lẫn nhau và **không** summary nào tồn tại (đúng lỗi đã bị test bắt).

**Ảnh.** `fs_read_image` không nhét bytes vào transcript: nó kiểm magic bytes, lưu
content-addressed (sha256, dedupe) và trả attachment id. `Message.parts` + mapping `image_url`
data-URI trong provider là đường đưa ảnh tới model; phần mapping có test offline, còn đầu cuối thì
chưa xác nhận vì tài khoản đang dùng không có model thị giác.

## Quy ước

- Mọi import nội bộ dùng đuôi `.js` (NodeNext ESM).
- Không `any`: dùng `unknown` + validate.
- Không `TODO`/`FIXME`/stub: eslint chặn ở mức error.
- Test chỉ dùng `FakeProvider` và các test double trong `tests/helpers` — không mạng, không timer.
