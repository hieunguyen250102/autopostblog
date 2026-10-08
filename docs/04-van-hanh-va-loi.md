# 04 — Vận hành hàng ngày & xử lý lỗi

## Một vòng làm việc

1. **Máy tự làm:** thu bài mới từ các page trong `Sources` theo lịch ở tab `Settings`
   (mặc định 4 giờ/lần), rồi Gemini dịch
   trong ≤ 5 phút. Bài hiện ở `Posts` với `status = REVIEW`.
2. **Bạn duyệt:** đọc `en_text` (bấm vào ô để xem đủ), sửa nếu cần. Xem ảnh: bấm link
   trong `source_images`; xoá dòng link nào là bỏ ảnh đó.
3. **Bật đăng:** tick `publish_now` — hoặc điền `scheduled_at` = `2026-01-31 08:30`.
   n8n đăng mỗi 2 phút một bài; tick nhiều bài thì chúng lần lượt lên.
4. Xong: `status = POSTED`, có `fb_permalink`.

Không muốn đăng bài nào: đặt `status = SKIP`.

> ⏰ Link ảnh Facebook **hết hạn sau vài ngày** — duyệt và đăng trong 1–2 ngày sau
> khi thu.

## Cơ chế an toàn

- Trước khi đăng, n8n luôn kiểm tra: có `en_text` đủ dài, có 1–10 link ảnh. Thiếu →
  `ERROR`, lý do ở `check_note`, bài không lên.
- Ảnh tải hoặc upload lỗi dù chỉ 1 tấm → **huỷ** cả bài (không đăng bài thiếu ảnh).
- Bài `POSTED` không bao giờ bị đăng lại. Muốn đăng lại thật: đổi `status` về `REVIEW`
  rồi tick.
- Bài kẹt `POSTING` quá 15 phút (n8n khởi động lại, mất mạng…) → `ERROR`, **không** tự
  đăng lại vì có thể đã lên Page. Mở Page kiểm tra rồi mới quyết định.
- Bài hẹn giờ bị `ERROR` không bị thử lại liên tục — sửa xong thì tick tay.

## Bảng lỗi theo `check_note`

| `check_note` | Nguyên nhân & cách sửa |
| --- | --- |
| `⏳ Gemini tạm lỗi, sẽ tự thử lại: … 429 / quota` | Hết hạn mức free trong phút/ngày — tự dịch lại sau. Nhiều bài chờ thì giảm `translate_per_run`. |
| `⏳ Gemini tạm lỗi … API key not valid` | Sai API key trong credential Header Auth (Name phải là `x-goog-api-key`). |
| `❌ Gemini không dịch được / không trả bản dịch` | Bị chặn nội dung hoặc sai `gemini_model`. Dịch tay: menu 🌐 Dịch bằng AI (web). |
| `❌ Chưa có bản dịch ở en_text` | Tick đăng khi chưa dịch xong — chờ `REVIEW` rồi tick lại. |
| `❌ Nội dung quá ngắn` | `en_text` < `min_content_chars` ký tự. |
| `❌ Thiếu ảnh` | Bài gốc không có ảnh. Thêm link ảnh vào `source_images`, hoặc `min_images = 0` ở tab `Settings`. |
| `❌ Facebook từ chối: … tải ảnh 1 lỗi: 403` | Link ảnh gốc hết hạn. Mở bài gốc → chuột phải ảnh → *Sao chép địa chỉ hình ảnh* → dán lại vào `source_images`. |
| `❌ Facebook từ chối: … upload ảnh 2 lỗi: …` | Facebook không nhận ảnh đó — xoá link ảnh đó rồi tick lại. |
| `❌ Facebook từ chối: … (code 190) … expired` | Page token hết hạn/bị thu hồi — lấy token mới (docs/01), cập nhật credential Facebook. |
| `❌ Facebook từ chối: (#200) … pages_manage_posts` | Token thiếu quyền hoặc là User Token. `npm run check:fb` để xác nhận. |
| `❌ Facebook từ chối: (#368) / (#4)` | Bị chặn tạm vì đăng nhiều — chờ vài giờ. |
| `⚠️ Kẹt ở POSTING quá 15 phút` | Mở Page xem bài đã lên chưa: chưa → tick lại; rồi → đặt `status = POSTED`. |

## Lỗi trong n8n → Executions (execution màu đỏ)

| Lỗi | Xử lý |
| --- | --- |
| `Crawler lỗi với tất cả page — … ECONNREFUSED` | fb-crawler không chạy: `docker compose up -d fb-crawler` |
| `… Sai X-Crawler-Token` | `crawler_token` trong `Config` khác `CRAWLER_TOKEN` trong `.env` → `npm run build`, import lại |
| `… không lấy được bài nào` | Link page sai, page bị ẩn/giới hạn tuổi, hoặc Facebook chặn tạm. Mở link trong trình duyệt ẩn danh để kiểm tra. |
| `… Facebook yêu cầu đăng nhập/xác minh` | Chỉ khi dùng cookie: tài khoản bị checkpoint — xử lý trên trình duyệt thường rồi xuất lại cookie, hoặc xoá file cookie để chạy không đăng nhập. |
| `Tab "Sources" chưa có page nào bật active` | Tick `active` ít nhất một page. |
| Lâu không thấy bài mới / bài tick không lên, execution xanh dừng ở node *Cài đặt* | Chưa đến lịch theo tab `Settings` — xem `crawl_times`, `publish_hours`, `publish_gap_minutes` (có chữ `tắt`?). Output node *Cài đặt* có `schedule_note` và `settings_warnings` |
| Node `Sheets: …` lỗi quyền / không tìm thấy | Credential Google Sheets không phải tài khoản sở hữu Sheet, hoặc sai `sheet_id`. |

Xem log crawler: `docker compose logs -f fb-crawler`.

Crawler không còn bóc được bài dù page vẫn có bài: Facebook đổi cấu trúc dữ liệu —
sửa [`crawler/fbparse.py`](../crawler/fbparse.py), chạy `npm run test:crawler`, rồi
`docker compose up -d --build fb-crawler`.

## Bảo trì

| Việc | Tần suất |
| --- | --- |
| `npm run check:fb` — token Facebook còn sống | hàng tháng, hoặc khi gặp lỗi 190 |
| Chuyển bài `POSTED` cũ sang tab lưu trữ | khi `Posts` > ~2.000 dòng (n8n đọc cả tab mỗi 2 phút) |
| Xem lại `Sources`, page nào không còn bài | hàng tháng |
