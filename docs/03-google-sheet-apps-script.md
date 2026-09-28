# 03 — Google Sheet & Apps Script

Sheet là bảng điều khiển: xem trạng thái, dán link folder, bấm đăng.

## 1. Tạo Sheet và nạp script

1. Tạo một Google Sheet mới, đặt tên ví dụ `AutoPost Control`.
2. Copy **Sheet ID** từ URL (dùng cho node `Config` trong n8n):
   `https://docs.google.com/spreadsheets/d/`**`1AbC...XyZ`**`/edit`
3. Trong Sheet: **Extensions → Apps Script**.
4. Xoá nội dung `Code.gs` mặc định, dán toàn bộ [`apps-script/Code.gs`](../apps-script/Code.gs).
5. (Tuỳ chọn, gọn hơn) Bấm ⚙️ **Project Settings** → tick *Show "appsscript.json"* →
   dán [`apps-script/appsscript.json`](../apps-script/appsscript.json).
6. **Save**, rồi chạy thử hàm `onOpen` một lần để Google xin quyền:
   Run → chọn `onOpen` → Review permissions → Allow.
   (Cảnh báo "Google hasn't verified this app" là bình thường với script của chính
   bạn: *Advanced → Go to ... (unsafe)*.)
7. Quay lại tab Sheet, **tải lại trang** → xuất hiện menu **🚀 Auto Post**.

## 2. Ba bước trong menu

| Menu | Làm gì |
| --- | --- |
| ① Khởi tạo / sửa lại cấu trúc sheet | Tạo 3 tab `Posts`, `Sources`, `Log` đúng schema, thêm dropdown trạng thái, checkbox, tô màu theo status, ghi chú giải thích trên từng tiêu đề cột |
| ② Nhập cấu hình n8n | Lưu Base URL của n8n + `webhook_secret` vào Document Properties (không nằm trong code, không lên git) |
| ③ Bật tự động khi tick ô publish_now | Cài **installable trigger** `onEditHandler` |

> Bước ③ là bắt buộc nếu muốn tick ô là đăng **ngay**. Trigger `onEdit` đơn giản
> không được phép gọi ra internet, nên phải dùng installable trigger — đó chính là
> việc menu ③ làm. Nếu bỏ qua bước này, tick ô vẫn hoạt động nhưng phải chờ
> workflow 03 quét (≤ 5 phút).

Base URL điền ở bước ② là phần trước `/webhook`, ví dụ `https://abc.app.n8n.cloud`.
Script tự ghép thành `…/webhook/autopost-publish` và `…/webhook/autopost-collect`.

## 3. Schema tab `Posts`

Tên cột ở dòng 1 **phải giữ nguyên** — n8n đọc/ghi theo đúng tên này.

| Cột | Ai điền | Ý nghĩa |
| --- | --- | --- |
| `post_id` | n8n | Mã bài `AP-0001`, tự tăng |
| `source_page` | n8n | Tên page nguồn |
| `source_post_url` | n8n | Link bài gốc — bạn mở link này để dịch |
| `source_post_id` | n8n | Dùng để chống thu trùng |
| `collected_at` | n8n | Thời điểm thu được |
| `title` | n8n / bạn | Nhãn để bạn nhận biết (KHÔNG đăng lên FB) |
| `summary` | n8n | Tóm tắt nội dung gốc |
| **`drive_folder_url`** | **bạn** | **Link folder Drive (nội dung + ảnh)** |
| `status` | n8n / bạn | `NEED_CONTENT` → `READY` → `POSTED`, hoặc `ERROR` / `SKIP` |
| `images_count` | n8n | Số ảnh tìm thấy |
| `content_chars` | n8n | Số ký tự nội dung |
| `check_note` | n8n | Kết quả kiểm tra / lý do lỗi |
| `scheduled_at` | bạn | Hẹn giờ: `2026-01-31 08:30` (giờ VN) |
| `posted_at` | n8n | Thời điểm đăng |
| `fb_post_id` | n8n | ID bài trên Facebook |
| `fb_permalink` | n8n | Link bài đã đăng |
| **`publish_now`** | **bạn** | **Tick = đăng ngay.** n8n tự bỏ tick sau khi xử lý |
| `last_action_at` | n8n | Lần cuối n8n tác động |

Bạn có thể tự thêm cột **sau** cột cuối (ví dụ `nguoi_dich`, `ghi_chu`) — n8n chỉ
đọc/ghi các cột nó biết tên, cột lạ được giữ nguyên. **Đừng đổi tên hay đảo thứ tự**
các cột trên.

## 4. Schema tab `Sources`

| Cột | Ý nghĩa |
| --- | --- |
| `source_name` | Tên gợi nhớ |
| `page_id_or_url` | Page ID (khuyến nghị) hoặc link page — dùng khi `mode = graph` |
| `mode` | `graph` = gọi Graph API; `rss` = đọc `feed_url` |
| `feed_url` | URL RSS/Atom, chỉ dùng khi `mode = rss` |
| `active` | Tick để bật nguồn này |
| `max_posts` | Số bài mới nhất lấy mỗi lần (mặc định 5, tối đa 25) |
| `note` | Ghi chú |

Nhớ đọc mục "App Review" ở [docs/01](01-facebook-app.md#6-app-review--khi-nào-cần):
đọc feed page **của người khác** bằng Graph API cần Facebook phê duyệt, nên với
nguồn ngoài hãy dùng `mode = rss` hoặc dán link bài tay vào `Posts`.

## 5. Tab `Log`

Mỗi lần bấm nút, Apps Script ghi 1 dòng: thời gian, `post_id`, hành động,
HTTP code, thông báo từ n8n. Đây là nơi xem nhanh "tôi vừa bấm gì, n8n trả lời gì".

## 6. Bảo mật & phân quyền

- Secret lưu ở **Document Properties**, chỉ người có quyền mở Script của file này
  đọc được. Không commit secret vào repo.
- Muốn cho người khác dán link folder mà không cho đăng bài: share Sheet quyền
  **Editor** nhưng không share Apps Script project, và **không** bật workflow 03
  (vì workflow 03 coi mọi ô `publish_now` được tick là lệnh đăng).
