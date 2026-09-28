# 05 — Vận hành hàng ngày

## Vòng làm việc chuẩn

**1. Máy thu bài** (tự động mỗi 2 giờ, hoặc bấm *⬇️ Thu bài mới từ các page nguồn*)

Bài mới xuất hiện ở `Posts` với `status = NEED_CONTENT`, có `source_post_url`.
Bài đã thu trước đó không bị thu lại (chống trùng theo `source_post_id`).

**2. Bạn chuẩn bị nội dung**

- Mở `source_post_url`, đọc bài gốc.
- Dịch sang tiếng Anh, lưu thành `content.md` (hoặc Google Docs).
- Tải ảnh, đổi tên `01-…`, `02-…` theo thứ tự muốn đăng.
- Tạo folder Drive cho bài, up file nội dung + ảnh vào.
- Dán link folder vào cột `drive_folder_url`.

**3. Kiểm tra**

Chọn dòng → menu **🚀 Auto Post → 🔍 Kiểm tra bài đang chọn**.

- Đủ: `status = READY`, `check_note` ghi số ký tự và số ảnh.
- Thiếu: `status = ERROR`, `check_note` ghi rõ thiếu gì → sửa folder → kiểm tra lại.

Bước này **không** đăng gì lên Facebook, bấm bao nhiêu lần cũng an toàn.

**4. Đăng**

Chọn một trong ba cách:

| Cách | Khi nào dùng |
| --- | --- |
| **📤 Đăng bài đang chọn** (menu) | Đăng 1 hoặc nhiều bài ngay, có hộp xác nhận |
| **Tick ô `publish_now`** | Nhanh nhất, không cần mở menu |
| **Điền `scheduled_at`** = `2026-01-31 08:30` | Hẹn giờ; workflow 03 đăng khi đến hạn (sai số ≤ 5 phút) |

Khi đăng, workflow **luôn kiểm tra lại** đủ thành phần trước — tick ô mà folder
thiếu ảnh thì bài không lên, `status` thành `ERROR`.

Xong: `status = POSTED`, có `fb_post_id`, `fb_permalink`, `posted_at`; ô
`publish_now` được tự bỏ tick.

## Chọn nhiều dòng một lúc

Menu *Kiểm tra* và *Đăng* chạy với **mọi dòng đang được chọn** — kéo chọn nhiều
dòng, hoặc Ctrl+click nhiều dòng rời rạc. Hộp thoại xác nhận liệt kê từng bài
trước khi đăng.

## Những cơ chế an toàn

- Bài `POSTED` **không** bị đăng lại (webhook trả 409, ghi lý do vào `check_note`).
  Muốn đăng lại thật: gọi webhook với `force: true`, hoặc đổi `status` về `READY`
  rồi đăng lại.
- Bài đang `POSTING` không bị đăng chồng.
- Đặt `status = SKIP` cho bài bạn không muốn đăng — cả menu và workflow 03 đều bỏ qua.
- Nếu chỉ upload được một phần ảnh lên Facebook, workflow **huỷ** việc tạo bài để
  không đăng bài thiếu ảnh, và ghi lỗi vào `check_note`.
- Workflow 03 giới hạn `max_per_run` (mặc định 3) bài mỗi lần quét, giãn 4 giây
  mỗi bài để tránh rate limit của Facebook.

## Sửa nội dung sau khi đã đăng

Hệ thống không sửa bài đã đăng. Nếu cần: sửa/xoá trực tiếp trên Facebook, rồi tự
cập nhật `check_note` trong sheet để biết đường lần sau.

## Xem lại lịch sử

- Tab `Log` trong Sheet: mọi lần bấm nút và phản hồi của n8n.
- n8n → **Executions**: chi tiết từng lần chạy, xem được dữ liệu từng node khi cần
  truy nguyên lỗi.

## Bảo trì định kỳ

| Việc | Tần suất |
| --- | --- |
| Kiểm tra token còn sống: `npm run check:fb` | mỗi tháng, hoặc khi gặp lỗi 190 |
| Xoá/đóng băng bài `POSTED` cũ sang tab lưu trữ | khi `Posts` > ~2.000 dòng (workflow đọc cả sheet mỗi lần chạy) |
| Xem lại `Sources` còn nguồn nào chết | hàng tháng |
