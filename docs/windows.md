# Cài agent-core trên Windows

Hướng dẫn này cho Windows 10/11 với **PowerShell** (không phải `cmd`). Toàn bộ lệnh chạy được bằng
copy-paste.

## Yêu cầu

| Thứ | Phiên bản | Ghi chú |
|---|---|---|
| Node.js | **≥ 24** | `package.json` khai báo `engines.node >= 24` |
| pnpm | **12.3.4** | đúng version trong `packageManager`, lệch version pnpm có thể từ chối chạy |
| Git | bất kỳ | hoặc tải ZIP từ GitHub |

## Cài đặt

### 1. Node, Git, pnpm

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

**Đóng PowerShell và mở cửa sổ mới** — PATH chỉ được nạp lại ở cửa sổ mới, đây chính là lý do hay
gặp lỗi `'node' is not recognized` / `'pnpm' is not recognized`.

```powershell
node -v                       # >= v24
npm i -g pnpm@12.3.4
pnpm -v                       # 12.3.4
```

Nếu `npm i -g` báo `EPERM`, mở PowerShell **Run as Administrator** rồi chạy lại. Không cần
`corepack`; nếu vẫn muốn dùng thì `corepack enable` cũng cần quyền admin vì nó ghi vào thư mục cài
Node.

### 2. Lấy code

```powershell
cd $HOME\Documents
git clone https://github.com/tiennguyen3000/agent-core.git
cd agent-core
```

Repo là private, Git sẽ hỏi đăng nhập GitHub. Có `gh` thì `gh repo clone tiennguyen3000/agent-core`.

### 3. Cài dependency và build

```powershell
pnpm install
pnpm build
```

`pnpm build` chạy `tsc -p tsconfig.build.json` và sinh ra `dist/`. Bước này **bắt buộc**: lệnh toàn
cục nạp `dist/`, không nạp `src/`.

### 4. Cài lệnh toàn cục

```powershell
npm i -g .
tiennk --version        # -> agent-core 0.1.0
```

`npm` sinh shim `tiennk.cmd` (và `tiennk.ps1`) trong thư mục global của npm, thường là
`%AppData%\npm` và đã có sẵn trong PATH. Nếu `tiennk` không tìm thấy: mở PowerShell mới, hoặc kiểm
tra `npm prefix -g` có nằm trong `$env:PATH`.

Hai tên cùng một entry point: `tiennk` và `agent-core`.

### 5. Nạp API key rồi chạy

```powershell
tiennk key deepseek                    # dán key, ký tự không hiện ra màn hình
tiennk model deepseek deepseek-flash
cd C:\du-an-cua-ban
tiennk                                 # vào REPL
```

Hoặc chạy một phát rồi thoát:

```powershell
tiennk "đọc repo này và tóm tắt kiến trúc"
tiennk --list
tiennk --resume session-1730000000000 "làm tiếp việc đang dở"
```

## File nằm ở đâu

| Thứ | Đường dẫn |
|---|---|
| Cấu hình (provider, model, skill sources) | `C:\Users\<tên>\.agent-core\config.json` |
| API key | `C:\Users\<tên>\.agent-core\.env` (chỉ chủ máy đọc) |
| Session log | `C:\Users\<tên>\.agent-core\sessions\<id>\session.jsonl` |
| Skill import | `C:\Users\<tên>\.agent-core\skills\` |
| Code + `dist/` | thư mục bạn clone về |

Đổi chỗ lưu bằng biến `AGENT_CORE_HOME`.

## Khác biệt so với macOS/Linux

| Điểm | Trên Windows |
|---|---|
| Shell của tool `bash` | `cmd.exe /d /s /c`, không phải `bash` |
| Nhắc model dùng lệnh | `dir`, `type`, `findstr`, `where` — **không** có `ls`, `cat`, `grep`, `which` |
| Kill job nền | `taskkill /PID <pid> /T /F`, giết cả cây tiến trình |
| MCP server là `.cmd` shim (`npx`, `uvx`) | spawn qua shell (từ Node 18.20/20.12 không spawn `.cmd` trực tiếp được) |
| Kiểm tra đường dẫn trong workspace | dùng `path.relative` — không phân biệt dấu `\` `/` và hoa/thường |
| Quyền file | không có bit POSIX; `.env` chỉ dựa vào ACL của thư mục người dùng |
| Sandbox shell (seatbelt) | macOS-only; trên Windows `shell.confinement` là `unconfined` |

Muốn có bash thật thì cài Git for Windows rồi đặt biến môi trường `SHELL` trỏ tới
`C:\Program Files\Git\bin\bash.exe`.

## Lỗi thường gặp

| Thông báo | Nguyên nhân | Cách sửa |
|---|---|---|
| `'pnpm' is not recognized as the name of a cmdlet…` | chưa cài pnpm, hoặc PATH của cửa sổ cũ | `npm i -g pnpm@12.3.4`, rồi mở PowerShell mới |
| `'node' is not recognized…` | chưa cài Node, hoặc chưa mở cửa sổ mới | `winget install OpenJS.NodeJS.LTS`, mở cửa sổ mới |
| `npm i -g` → `EPERM` | thư mục global của npm | chạy PowerShell as Administrator |
| `corepack enable` → `EPERM` | ghi vào thư mục cài Node | dùng `npm i -g pnpm@12.3.4` thay vì corepack |
| `tiennk` không tìm thấy sau khi cài | PATH của cửa sổ hiện tại | mở PowerShell mới |
| Agent từ chối ghi file | ghi ngoài workspace bị chặn theo thiết kế | thêm `--escalate` để được hỏi, hoặc `--yes` để tự đồng ý |
| `ERR_PNPM_BAD_PM_VERSION` | pnpm khác 12.3.4 | `npm i -g pnpm@12.3.4` |
| `pnpm build` xong nhưng `tiennk` vẫn chạy code cũ | `npm i -g .` tạo symlink tới repo | chạy lại `pnpm build` sau mỗi lần sửa source |

## Đã kiểm chứng tới đâu

**Có bằng chứng (CI, mỗi lần push):** `.github/workflows/ci.yml` chạy trên `ubuntu-latest`,
`macos-latest` và `windows-latest` các bước `pnpm install --frozen-lockfile` → `typecheck` → `lint`
→ `pnpm test` (offline) → `pnpm build`. Trên `windows-latest` cả 45 file test đều pass.

Các nhánh riêng của Windows còn được test **ngay trên macOS** bằng cách inject platform
(`tests/windows-branches.spec.ts`): `taskkill`, spawn qua shell, `cmd.exe /d /s /c`.

**Chưa kiểm chứng, nói thẳng:**

- `npm i -g .` trên Windows thật (CI không cài global). npm sinh shim theo trường `bin` nên nhiều
  khả năng chạy, nhưng đây là suy luận.
- Một lượt gọi API thật từ máy Windows (runner CI không có key).
- `sandbox-exec`/seatbelt: chỉ macOS, Windows luôn là `unconfined`.
