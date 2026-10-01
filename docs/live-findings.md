# Live wire-format findings

Ngày chạy: lần đầu sau M2. Model: `deepseek-flash` · baseUrl: `https://api.deepseek.com/v1`.
Tài khoản liệt kê 2 model: `deepseek-flash`, `deepseek-v4-pro`.

Chạy lại:

```bash
DEEPSEEK_API_KEY=sk-... DEEPSEEK_LIVE_MODEL=deepseek-flash pnpm test:live
```

`pnpm test` không bao giờ gọi mạng; file live tự skip khi thiếu key.

## Số đo thật

| Phép đo | Kết quả |
|---|---|
| `GET /models` | 2 model, có đúng `deepseek-flash` |
| Stream 1 câu ngắn | `stop=end`, text `"pong"` |
| usage lần 1 | `in=51 out=24 cache_read=0 reasoning=21` |
| usage lần 2 | `in=51 out=39 cache_read=0 reasoning=36` |
| Prompt 591 token, gọi 3 lần liên tiếp | `in=207 read=384 total=591` (cả 3 lần) |
| Tỉ lệ cache hit trên prefix lặp lại | **65%** (384/591) |
| Gọi tool | `stop=tool_calls`, 1 call `fs_read {"path":"notes.txt"}`, `malformed=0` |
| `reasoning_effort: 'low'` | được chấp nhận, `stop=end`, không có lỗi |

## Đã xác nhận (khoá được giả định)

1. **Khung SSE + `stream_options.include_usage`** hoạt động: usage đến ở cuối stream dưới dạng một
   chunk riêng có `choices: []`.
2. **Mapping cache đúng.** DeepSeek trả `prompt_cache_hit_tokens` riêng khỏi phần chưa cache, và
   `inputTokens + cacheReadTokens` = tổng prompt (591) **ổn định qua cả 3 lần gọi** — tức cách map
   `inputTokens = prompt_cache_miss_tokens`, `cacheReadTokens = prompt_cache_hit_tokens` không bị
   tính trùng và không mất token.
3. **`reasoning_tokens` nằm trong `completion_tokens`.** Ví dụ `out=24` mà `reasoning=21`, phần chữ
   hiển thị chỉ ~3 token. Suy ra: chi phí output bao gồm cả reasoning ẩn, nên hạ `reasoningEffort`
   là đòn giảm tiền thật (khớp với khuyến nghị ở phần so sánh Hermes).
4. **Shape của `tool_calls` stream đúng như adapter giả định**: fragment theo `index`, `id` và
   `function.name` đến ở fragment đầu, `function.arguments` là chuỗi JSON nối dần;
   `finish_reason: "tool_calls"` map sang `stop: tool_calls`; `assembleResponse` parse ra
   `{"path":"notes.txt"}` với `malformedToolArgs = []`.
5. **Usage vẫn được báo khi stop là `length`** (quan sát được ở lần chạy đầu với `max_tokens: 16`):
   kể cả response bị cắt, `usage` vẫn có.
6. **`reasoning_effort` được route này chấp nhận** (không 400). Vì vậy mặc định "omit" trong
   `DeepSeekProvider` là thận trọng chứ không bắt buộc; bật `sendReasoningEffort: true` là an toàn
   với `deepseek-flash`.

## Phát hiện đáng chú ý về cache (ảnh hưởng trực tiếp tới chi phí)

- **Cache nằm ở server và dùng chung giữa các process.** Ở lần chạy thứ hai, ngay lần gọi "đầu
  tiên" đã hit 384/591 token vì lần chạy trước vừa làm nóng đúng prefix đó. Hệ quả: không thể giả
  định một baseline "cold" — và trong vận hành thật, prefix cố định (system prompt + schema tool)
  gần như luôn được hit.
- **Tỉ lệ hit phụ thuộc độ lớn prefix, không phải một hằng số.** Với prompt 591 token, hit bão hoà ở
  384 (≈ 6 block × 64 token) và **207 token đuôi luôn phải trả giá đầy**. Đó là lý do cùng một cơ
  chế cache cho ra ~99% ở Hermes (prompt trung bình ~168k token, đuôi không đáng kể) nhưng chỉ 65% ở
  prompt nhỏ. Kết luận thực dụng: **giữ prefix lớn và ổn định** thì tỉ lệ hit mới cao.
- Cache không tăng thêm sau lần gọi thứ hai trong phép đo này (384 → 384 → 384), tức phần đuôi
  không được cache lại; đừng kỳ vọng lần gọi thứ N rẻ dần nếu prompt không đổi.

## Còn để ngỏ

- `reasoning_effort` **được chấp nhận** nhưng phép đo này không phân biệt được "có tác dụng" với
  "bị bỏ qua im lặng". Muốn biết phải so số `reasoning_tokens` giữa `low` và `high` trên cùng một
  prompt.
- Kích thước block cache (quan sát 384 = 6×64 gợi ý 64 token) chưa được kiểm chứng trực tiếp bằng
  nhiều độ dài prefix khác nhau.
- Chưa đo hành vi khi prompt vượt context window hay khi bị rate limit thật (429 thật).

## Ảnh hưởng tới các milestone sau

- **M6 (token meter / compaction)**: có thể tin `usage` từ provider làm số chuẩn thay vì ước lượng;
  nhưng khi tính áp lực context phải cộng `inputTokens + cacheReadTokens`, không chỉ `inputTokens`.
- **Mô hình chi phí**: phải định giá 3 nhóm riêng — miss input (đắt), cache-read input (rẻ ~1/10),
  output bao gồm reasoning — nếu không sẽ ước tính sai nhiều lần.
- **Prompt design**: system prompt + schema tool nên đứng trước và không đổi giữa các turn để tối
  đa phần được cache.
