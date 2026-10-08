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

Bước ① tạo 4 tab `Posts`, `Sources`, `Prompt`, `Settings`. Tab cũ khác cấu trúc (từ phiên bản
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

## 5. Tab `Settings` — lịch chạy và thông số

**Chỉnh lịch thu bài / dịch / đăng ở đây** — sửa ô `value` là có hiệu lực ở lượt chạy
kế tiếp của n8n (≤ 5 phút), không cần mở n8n, không cần import lại, không cần SSH vào
VPS. Ô `value` để trống = dùng mặc định.

| `key` | Mặc định | Ý nghĩa | Ví dụ |
| --- | --- | --- | --- |
| `crawl_every_hours` | `4` | Thu bài mỗi N giờ. `0` = tắt thu bài | `3` |
| `crawl_times` | trống | Giờ thu bài cố định trong ngày. Có giá trị thì bỏ qua `crawl_every_hours` | `07:00, 12:00, 19:00` |
| `translate_hours` | trống = cả ngày | Khung giờ được dịch | `07:00-23:00` |
| `publish_hours` | trống = cả ngày | Khung giờ được đăng, nhiều khung cách nhau dấu phẩy, qua đêm được | `08:00-11:00, 19:00-22:00` |
| `publish_gap_minutes` | `0` | Cách tối thiểu giữa 2 bài đăng (phút) | `60` |
| `translate_per_run` | `3` | Số bài dịch mỗi 5 phút | `5` |
| `default_max_posts` | `5` | Số bài/page/lần thu khi cột `max_posts` ở `Sources` trống (tối đa 10) | `3` |
| `min_images` | `1` | Số ảnh tối thiểu để được đăng. `0` = cho đăng bài chỉ có chữ | `0` |
| `gemini_model` | trống = mặc định | Model Gemini dùng để dịch | |

- **Viết giờ** kiểu nào cũng được: `7`, `7h`, `7h30`, `07:30`, `7:30 PM`. Khoảng giờ:
  `8h-22h`, `08:00–22:00`, `8h đến 22h`.
- **Tạm dừng** một việc: gõ `tắt` vào `crawl_times`, `translate_hours` hoặc
  `publish_hours`. Ví dụ đi vắng mấy hôm: `publish_hours = tắt` — bài đã tick vẫn nằm
  chờ, xoá chữ `tắt` là chúng lần lượt lên.
- **Ngoài `publish_hours`**, bài tick `publish_now` hoặc đến `scheduled_at` sẽ **chờ**
  tới đầu khung giờ kế tiếp rồi mới lên. `publish_gap_minutes` cũng áp dụng cho bài hẹn
  giờ: hẹn 2 bài 8:00 và 8:10 với gap 30 thì bài thứ 2 lên lúc ~8:30.
- **Thu bài theo giờ cố định**: mỗi mốc chạy 1 lần, trễ tối đa 5 phút. n8n tắt đúng
  lúc đến mốc thì khi bật lại sẽ thu bù 1 lần (trong cùng ngày).
- Đừng thu dày hơn 2–3 giờ/lần — Facebook dễ chặn tạm thời. Không đăng nhập thì mỗi
  lần chỉ thấy ~3 bài mới nhất/page, nên page đăng nhiều thì thu dày hơn một chút hoặc
  dùng cookie (docs/03).
- Viết sai giá trị: n8n dùng mặc định cho ô đó và ghi cảnh báo `settings_warnings` ở
  output node **Cài đặt** (n8n → Executions).
- Muốn đăng **một bài** vào giờ cụ thể thì không cần đụng tab này — điền `scheduled_at`
  của bài đó.

## 6. Menu 🚀 Auto Post

| Menu | Khi nào dùng |
| --- | --- |
| ① Khởi tạo / sửa lại cấu trúc sheet | Lần đầu, và sau mỗi lần cập nhật `Code.gs` |
| 🌐 Dịch bằng AI (web) bài đang chọn | Dự phòng khi Gemini báo lỗi: copy prompt sang ChatGPT / Claude / Gemini web, dán kết quả về |
| ➕ Thêm bài thủ công | Muốn reup một bài cụ thể: dán link, nội dung gốc, link ảnh → n8n tự dịch |
