# Figma UI MCP Bridge

Kiettt8 Custom Edition

Figma UI MCP Bridge giúp Codex, Claude Code, Cursor, VS Code và các MCP client
khác đọc hoặc chỉnh sửa thiết kế trực tiếp trong Figma Desktop.

Bản này có giao diện plugin tùy chỉnh và bridge chạy ngầm. Sau khi cài đặt một
lần, người dùng chỉ cần mở plugin trong Figma, không phải mở Terminal hoặc chạy
`npx figma-ui-mcp`.

![Figma UI MCP Bridge](assets/plugin-ui-light.png)

## Yêu cầu

- Node.js 18 trở lên
- Git
- Figma Desktop
- Một MCP client như Codex, Claude Code, Cursor, VS Code hoặc Windsurf

Figma bản web không dùng được với bridge local này.

## Cách đơn giản nhất: nhờ AI cài

Gửi link repository này cho Codex, Claude Code hoặc Cursor Agent:

```text
Cài repository này giúp tôi:
https://github.com/kiettt8-product/figma-ui-mcp

Hãy clone vào một thư mục cố định, chạy npm install, cấu hình MCP cho client
hiện tại, cài background bridge và kiểm tra port 38451. Không dùng package npm
của repository upstream.
```

AI có thể thực hiện phần cài đặt bằng Terminal. Người dùng chỉ cần import
development plugin vào Figma một lần theo hướng dẫn bên dưới.

Claude Desktop dạng chat thông thường không có quyền Terminal nên không tự cài
được. Hãy dùng Claude Code hoặc một agent có quyền chạy lệnh.

## Tự cài đặt

### 1. Clone và setup

```bash
git clone https://github.com/kiettt8-product/figma-ui-mcp.git
cd figma-ui-mcp
npm install
npm run setup
```

Setup wizard sẽ:

- Tìm MCP client đang có trên máy.
- Thêm cấu hình `figma-ui-mcp` vào client được chọn.
- Giữ nguyên các MCP server khác.
- Tạo backup trước khi sửa file cấu hình.
- Cài bridge chạy ngầm khi đăng nhập máy.
- Khởi động bridge ngay sau khi setup.

Khi wizard hỏi cài background bridge, chọn `Y` hoặc nhấn Enter.

Nếu muốn chạy setup không cần trả lời:

```bash
npm run setup -- --client codex --yes
```

Thay `codex` bằng một trong các giá trị:

```text
claude-code
claude-desktop
cursor
vscode
windsurf
```

Có thể cấu hình nhiều client cùng lúc:

```bash
npm run setup -- --client codex,claude-code,cursor --yes
```

### 2. Import plugin vào Figma

Mở Figma Desktop:

```text
Plugins
→ Development
→ Manage plugins in development
→ Import plugin from manifest
```

Chọn file:

```text
figma-ui-mcp/plugin/manifest.json
```

Chỉ cần import một lần. Không di chuyển hoặc xóa thư mục repository sau khi
import vì Figma lưu đường dẫn đến file manifest.

### 3. Chạy plugin

Mở một Figma design file, sau đó chọn:

```text
Plugins
→ Development
→ Figma UI MCP Bridge · Kiettt8
```

Plugin cần hiển thị trạng thái `Connected`.

## Cách sử dụng hằng ngày

Sau khi đã setup:

1. Mở Figma Desktop.
2. Mở design file cần làm việc.
3. Chạy `Figma UI MCP Bridge · Kiettt8`.
4. Prompt cho Codex, Claude Code, Cursor hoặc MCP client đang dùng.

Không cần mở Terminal. Không cần chạy `npm start` hoặc `npx figma-ui-mcp`.

Bridge đã được hệ điều hành chạy ngầm từ trước:

```text
Đăng nhập máy
→ background bridge chạy tại 127.0.0.1:38451
→ mở Figma plugin
→ plugin tự kết nối
→ MCP client gửi lệnh đến Figma
```

Figma vẫn yêu cầu người dùng tự mở development plugin. Plugin không thể tự
khởi chạy process hệ điều hành do giới hạn sandbox của Figma.

## Kiểm tra kết nối

Kiểm tra bridge:

```bash
curl http://127.0.0.1:38451/health
```

Nếu plugin đang mở, kết quả cần có:

```json
{
  "pluginConnected": true
}
```

Trong MCP client, có thể yêu cầu:

```text
Kiểm tra kết nối Figma bằng figma_status.
```

## Cập nhật phiên bản mới

Trong thư mục repository:

```bash
git pull origin main
npm install
npm run setup:background
```

Lệnh cuối sẽ cập nhật và restart background bridge. Không cần import lại
manifest nếu repository vẫn nằm ở đường dẫn cũ.

## Xử lý lỗi nhanh

### Plugin báo chạy `npx figma-ui-mcp`

Cài lại background bridge:

```bash
npm run setup:background
curl http://127.0.0.1:38451/health
```

### Plugin vẫn hiện giao diện cũ

1. Mở `Manage plugins in development`.
2. Xóa đăng ký Figma UI MCP Bridge cũ.
3. Import lại đúng file `plugin/manifest.json` trong repository này.
4. Đóng và chạy lại plugin.

### MCP client đang dùng nhầm bản npm

Không dùng cấu hình:

```json
{
  "command": "npx",
  "args": ["figma-ui-mcp"]
}
```

Chạy lại:

```bash
npm run setup
```

Wizard sẽ cấu hình client dùng trực tiếp `server/index.js` trong repository
này.

### Port 38451 không hoạt động

Trên macOS:

```bash
launchctl print gui/$(id -u)/io.github.kiettt8-product.figma-ui-mcp-bridge
tail -50 ~/Library/Logs/FigmaUIMCP/bridge.error.log
```

Trên Linux:

```bash
systemctl --user status figma-ui-mcp-bridge.service
```

Sau đó chạy lại:

```bash
npm run setup:background
```

## Phát triển source

- Giao diện plugin: `plugin/ui.html`
- Logic plugin: `src/plugin/`
- MCP adapter: `server/index.js`
- Background bridge: `server/bridge-daemon.js`
- Setup wizard: `scripts/setup-mcp.js`

Build lại plugin sau khi sửa logic:

```bash
npm run build:plugin
```

Chạy test:

```bash
npm run test:setup
```

## Bảo mật

- Bridge mặc định chỉ chạy tại `127.0.0.1`.
- Không expose port `38451` lên Internet.
- Không đổi bridge sang public host nếu chưa có authentication và firewall.
- Kiểm tra thao tác do AI tạo trước khi áp dụng lên design file quan trọng.

## Nguồn và giấy phép

Repository này là bản phát triển độc lập dựa trên
[TranHoaiHung/figma-ui-mcp](https://github.com/TranHoaiHung/figma-ui-mcp).

- Nền tảng MCP và Figma plugin: dự án gốc
- Custom UI, background setup và tài liệu: Kiettt8
- License: MIT

Xem thêm hướng dẫn kỹ thuật tại [KIETTT8_SETUP.md](KIETTT8_SETUP.md).
