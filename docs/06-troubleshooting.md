# 06 — Xử lý lỗi

Tra theo nội dung cột `check_note` hoặc thông báo hộp thoại trong Sheet.

## Lỗi kiểm tra thành phần (`status = ERROR`)

| `check_note` | Nguyên nhân & cách sửa |
| --- | --- |
| `Thiếu / sai link folder Drive ở cột drive_folder_url` | Ô trống hoặc link không chứa ID folder. Dán lại URL folder đầy đủ. |
| `Folder Drive rỗng (hoặc n8n chưa được chia sẻ quyền xem folder này)` | Folder thật sự rỗng, **hoặc** credential Google của n8n không thấy folder. Xem [docs/02 mục 4](02-google-drive.md#4-chia-sẻ-quyền-cho-n8n). |
| `Không đọc được folder Drive: File not found` | Sai ID folder, hoặc folder thuộc tài khoản khác. |
| `Thiếu file nội dung: cần 1 file .txt / .md hoặc Google Docs` | Trong folder chỉ có ảnh, hoặc file nội dung là `.docx`/PDF. Đổi sang `.md`, `.txt` hoặc Google Docs. |
| `Thiếu ảnh: cần tối thiểu 1 ảnh, hiện có 0` | Chưa up ảnh, hoặc ảnh sai định dạng (chỉ nhận jpg/png/gif/webp — `.heic` từ iPhone **không** được nhận). |
| `Quá nhiều ảnh: Facebook cho tối đa 10 ảnh/bài` | Bỏ ảnh bớt, hoặc tách thành 2 bài. |
| `Ảnh vượt 8MB: …` | Nén ảnh, hoặc tăng `max_image_mb` trong node `Config` của workflow 02. |
| `File nội dung rỗng` / `Nội dung quá ngắn` | File chưa có chữ, hoặc ngắn hơn `min_content_chars`. |
| `Nội dung quá dài` | Facebook giới hạn ~63.206 ký tự; cắt ngắn bài. |
| `Bài đã đăng lúc … — bỏ qua` | Bảo vệ chống đăng trùng. Muốn đăng lại: đổi `status` về `READY` rồi đăng, hoặc gửi `force: true`. |
| `Bài đang trong tiến trình đăng` | Có lần đăng trước chưa xong. Xem n8n → Executions; nếu execution đã lỗi/kết thúc, đổi `status` về `READY`. |

## Lỗi từ Facebook (`❌ Facebook từ chối: …`)

| Thông báo | Xử lý |
| --- | --- |
| `Error validating access token … has expired` (code 190) | Token hết hạn hoặc bị thu hồi (đổi mật khẩu, đổi quyền admin). Lấy token mới theo [docs/01](01-facebook-app.md) rồi cập nhật credential trong n8n. |
| `(#200) … requires pages_manage_posts permission` | Token thiếu quyền, hoặc là **User Token** thay vì **Page Token**. Chạy `npm run check:fb` để xác nhận. |
| `(#100) Missing or invalid image file` | Ảnh hỏng/sai định dạng, hoặc quá lớn. Mở thử ảnh trên Drive để kiểm tra. |
| `(#368) temporarily blocked` / `(#4) Application request limit reached` | Đăng quá nhiều/nhanh. Giảm `max_per_run` ở workflow 03, chờ vài giờ. |
| `(#1500) The url you supplied is invalid` | Link trong nội dung bị Facebook chặn — bỏ link đó ra. |
| `Chỉ upload được 2/5 ảnh lên Facebook, huỷ đăng` | Một ảnh bị Facebook từ chối. Xem chi tiết ở n8n → Executions, node `FB: Upload ảnh`, tìm ảnh lỗi rồi thay ảnh. |

## Lỗi phía Sheet / Apps Script

| Hiện tượng | Xử lý |
| --- | --- |
| Không thấy menu **🚀 Auto Post** | Chưa dán script, hoặc chưa tải lại trang Sheet. Chạy hàm `onOpen` một lần trong Apps Script rồi F5. |
| `Chưa cấu hình n8n. Vào menu ② …` | Chạy menu ② để nhập Base URL + secret. |
| Hộp thoại báo `HTTP 401` | Secret trong Sheet khác `webhook_secret` ở node `Config` workflow 02. Sửa cho trùng. |
| Hộp thoại báo `HTTP 404` | Sai Base URL, hoặc workflow 02 chưa **Activate** (đang dùng Test URL). |
| `n8n nhận việc nhưng phản hồi chậm` | Bình thường khi bài nhiều ảnh (UrlFetchApp cắt ở ~60s). n8n vẫn chạy tiếp — theo dõi cột `status`. |
| Tick ô `publish_now` mà không có gì xảy ra | Chưa cài trigger (menu ③). Không cài cũng được: workflow 03 sẽ xử lý trong ≤ 5 phút. |
| Tick ô rồi tự bỏ tick, không đăng | Bài đang `POSTED`/`POSTING` → bị bỏ qua có chủ ý. Xem toast thông báo. |
| `Exception: You do not have permission to call UrlFetchApp.fetch` | Trigger được tạo bởi tài khoản khác, hoặc chưa cấp quyền. Chạy lại menu ③ bằng tài khoản của bạn. |

## Lỗi phía n8n

| Hiện tượng | Xử lý |
| --- | --- |
| Node Sheets: `The resource you are requesting could not be found` | Sai `sheet_id`, sai tên tab (`Posts`/`Sources` phân biệt chữ hoa), hoặc credential không có quyền vào Sheet. |
| Node Sheets báo lỗi ở ô **Document** | Bản n8n không nhận biểu thức trong resource locator — xem [docs/04 mục 7](04-n8n-setup.md#7-nếu-node-sheets-báo-lỗi-document-id). |
| Update ghi sai dòng | Workflow ghi theo `row_number` đọc từ sheet. **Đừng chèn/xoá dòng giữa lúc n8n đang chạy**; tránh sort sheet khi có bài đang `POSTING`. |
| Workflow 01: `Graph API lỗi với nguồn …: (#10) … Page Public Content Access` | Đang cố đọc page của người khác. Đổi nguồn sang `mode = rss` hoặc dán link bài tay. Xem [docs/01 mục 6](01-facebook-app.md#6-app-review--khi-nào-cần). |
| Workflow 01: `Sheet "Sources" chưa có nguồn nào bật active = TRUE` | Tick ô `active` cho ít nhất một nguồn. |
| Không thu được bài mới dù nguồn có bài | Bài đã tồn tại trong `Posts` (chống trùng theo `source_post_id`/`source_post_url`). Kiểm tra lại sheet. |
| `post_id` bị trùng | Có người sửa tay `post_id`. Mã mới được sinh từ số lớn nhất đang có; giữ nguyên định dạng `AP-0001`. |

## Cách truy nguyên tận gốc

1. Sheet → tab `Log`: xem lần bấm gần nhất trả về gì.
2. n8n → **Executions** → mở execution tương ứng (lọc theo thời gian).
3. Bấm vào node bị đỏ, xem tab **Input**/**Output** để biết dữ liệu thực tế.
4. Node đáng xem nhất:
   - `Tìm dòng bài viết` — đọc đúng dòng chưa;
   - `Kiểm tra đủ thành phần` — Drive trả về những file nào;
   - `Chuẩn hoá nội dung` — nội dung sẽ đăng trông ra sao;
   - `FB: Upload ảnh` / `FB: Tạo bài trên Page` — Facebook trả lỗi gì.
5. Chạy lại: sửa dữ liệu rồi bấm lại từ Sheet (đừng "Retry" execution cũ vì dữ liệu
   Drive/Sheet đã thay đổi).
