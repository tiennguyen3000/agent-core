# agent-core

Stack: TypeScript strict, Node 24 ESM, pnpm, vitest, zod. Không dùng framework agent nào.

## Lệnh bắt buộc trước khi báo hoàn thành

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Test phải chạy **offline**, không dùng timer, không gọi mạng. Chạy 10 lần phải ra cùng kết quả.

## Quy tắc

- Không stub, không `TODO`/`FIXME`, không mock trong `src/`. eslint chặn ở mức error.
- Interface trong `src/llm/types.ts`, `src/session/events.ts`, `src/tools/registry.ts`,
  `src/policy/gate.ts` là **hợp đồng cứng**: chỉ được thêm field, không đổi tên, không xoá.
- Mọi **mutation** fs và mọi lệnh shell/network phải đi qua `PolicyGate`. Tool khai báo
  `requiresApproval: 'never'` là tool không cần hỏi duyệt (ví dụ đọc file, todo) nên không gọi
  gate. Từ M5 việc thi hành đã có thật: `createSandboxedFs` chặn ghi ngoài workspace ở tầng port
  (kể cả khi không có quyết định nào), và `createSandboxedShellRunner` từ chối chạy trong
  read-only. **Nhưng**: shell chỉ thật sự bị nhốt khi có `OsSandboxBackend` — kiểm tra
  `shell.confinement`, đừng giả định. Đừng gán `'never'` cho tool có side effect.
- Mọi quyết định policy/approval phải đi vào audit sink (`policy.decision`, `approval.*`).
- Mọi hành vi ghi vào log dưới dạng `SessionEvent`; không giữ state song song.
- Không in secret ra log/stdout.
- Import nội bộ dùng đuôi `.js`. Không dùng `any`.
- Muốn lệch hợp đồng thì nói rõ và đề xuất, không tự sửa âm thầm.

## 10 invariant (mỗi cái phải có test)

1. Log là nguồn sự thật; transcript luôn được replay.
2. Compaction che, không xoá.
3. Mọi mutation fs + mọi lệnh shell/network đi qua `PolicyGate`; mutation còn bị chặn lần hai ở
   `ctx.fs`. Shell chỉ được nhốt thật khi có OS sandbox backend (kiểm tra `shell.confinement`).
4. Schema tool sinh từ zod, không viết tay bản thứ hai.
5. Cancel lan truyền tới provider, tool, tiến trình con; không rò tiến trình.
6. Budget được thực thi: `maxSteps`, `tokenBudget`, `wallClockMs`, `toolTimeout`.
7. Tool lỗi trả mã ổn định + gợi ý khắc phục.
8. Output vượt `maxInlineTokens` bị spill ra file; model thấy head + tail + path.
9. Secret chỉ từ env, không vào log/error.
10. Test offline, tất định, không phụ thuộc thời gian.

## Báo cáo cuối mỗi milestone

`Files | Deps added | Tests passed/failed | Invariants covered | Not done`
