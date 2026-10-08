# 02 — Google Sheet

Sheet là nơi **lưu bài, duyệt bản dịch và bật đăng**. Mọi việc khác chạy trong n8n.

## 1. Tạo Sheet và nạp script

1. Tạo một Google Sheet mới (hoặc dùng Sheet cũ), ví dụ `AutoPost Control`.
2. Copy **Sheet ID** từ URL vào `.env` → `N8N_SHEET_ID`:
   `https://docs.google.com/spreadsheets/d/`**`1AbC...XyZ`**`/edit`
3. **Extensions → Apps Script** → xoá `Code.gs` mặc định, dán toàn bộ
   [`apps-script/Code.gs`](../apps-script/Code.gs) → **Save**.
4. Chạy thử hàm `onOpen` một lần để Google xin quyền (Run → `onOpen` → Allow;
   cảnh báo "Google hasn't verified this app" là bình thường: *Advanced → Go to …*).
5. Quay lại Sheet, **tải lại trang** → menu **🚀 Auto Post** → **① Khởi tạo / sửa lại
   cấu trúc sheet**.

Bước ① tạo 3 tab `Posts`, `Sources`, `Prompt`. Tab cũ khác cấu trúc (từ phiên bản
trước) **được đổi tên** thành `…_cu_<ngày>`, không bị xoá — copy dữ liệu cần giữ
sang tab mới rồi tự xoá tab cũ. Chạy lại ① bất cứ lúc nào cũng an toàn.

## 2. Tab `Sources` — page nguồn

| Cột | Ý nghĩa |
| --- | --- |
| `source_name` | Tên gợi nhớ |
| `page_url` | Link page, ví dụ `https://www.facebook.com/tenpage` |
| `active` | Tick để bật thu bài từ page này |
| `max_posts` | Số bài mới nhất lấy mỗi lần (mặc định 5, tối đa 10) |
| `note` | Ghi chú |

## 3. Tab `Posts` — duyệt và đăng

Tên cột ở dòng 1 **phải giữ nguyên** — n8n đọc/ghi theo đúng tên.

| Cột | Ai điền | Ý nghĩa |
| --- | --- | --- |
| `post_id` | n8n | Mã bài `AP-0001` |
| `status` | n8n / bạn | Xem bảng trạng thái bên dưới. Đặt `SKIP` để bỏ bài |
| **`publish_now`** | **bạn** | **Tick = đăng.** n8n tự bỏ tick sau khi xử lý |
| `scheduled_at` | bạn | Hẹn giờ: `2026-01-31 08:30` (giờ VN) — không cần tick |
| `title` | n8n | Nhãn nhận biết bài (không đăng) |
| **`en_text`** | **Gemini / bạn** | **Nội dung sẽ được đăng** — đọc lại, sửa trực tiếp |
| `source_images` | n8n / bạn | Link ảnh gốc, mỗi dòng 1 link, đăng đúng thứ tự. Xoá dòng nào là bỏ ảnh đó |
| `check_note` | n8n | Kết quả / lý do lỗi gần nhất |
| `source_text` | n8n | Nội dung gốc tiếng Việt |
| `source_page`, `source_post_url`, `source_post_id` | n8n | Nguồn bài, chống thu trùng |
| `collected_at`, `posted_at`, `last_action_at` | n8n | Mốc thời gian |
| `fb_post_id`, `fb_permalink` | n8n | Bài đã đăng trên Page của bạn |
| `images_count` | n8n | Số ảnh |

| `status` | Nghĩa | Bước tiếp theo |
| --- | --- | --- |
| `NEED_TRANSLATE` | Vừa thu về, chờ dịch | n8n tự dịch trong ≤ 5 phút |
| `REVIEW` | Đã có bản dịch | **Bạn** đọc `en_text`, tick `publish_now` |
| `POSTING` | Đang đăng | chờ |
| `POSTED` | Đã lên Page | xong |
| `ERROR` | Lỗi — lý do ở `check_note` | **Bạn** sửa rồi tick lại |
| `NEED_CONTENT` | Bài gốc không có chữ | **Bạn** tự viết `en_text` |
| `SKIP` | Không đăng | — |

## 4. Tab `Prompt`

Ô `A2` là prompt Gemini dùng để dịch. Mặc định: dịch giữ giọng văn, bỏ thông tin
liên hệ / tên page gốc, và **kết thúc bằng 1 dòng 3–5 hashtag tiếng Anh** hợp nội dung
(gộp cả hashtag có sẵn của bài gốc). Sửa thoải mái (số hashtag, giọng văn…), chỉ cần
giữ `{{NOI_DUNG}}` là chỗ chèn bài gốc.

Chạy lại menu ① sẽ cập nhật `A2` lên prompt mặc định mới **chỉ khi** bạn chưa sửa nó;
prompt bạn đã sửa được giữ nguyên. Bài đã dịch rồi không tự dịch lại — muốn dịch lại
một bài theo prompt mới: xoá ô `en_text` và đặt `status = NEED_TRANSLATE`.

## 5. Menu 🚀 Auto Post

| Menu | Khi nào dùng |
| --- | --- |
| ① Khởi tạo / sửa lại cấu trúc sheet | Lần đầu, và sau mỗi lần cập nhật `Code.gs` |
| 🌐 Dịch bằng AI (web) bài đang chọn | Dự phòng khi Gemini báo lỗi: copy prompt sang ChatGPT / Claude / Gemini web, dán kết quả về |
| ➕ Thêm bài thủ công | Muốn reup một bài cụ thể: dán link, nội dung gốc, link ảnh → n8n tự dịch |
