# 04 — Cài đặt n8n

Dùng n8n Cloud hay self-host đều được. Self-host bằng Docker:

```bash
docker run -d --name n8n -p 5678:5678 \
  -e GENERIC_TIMEZONE=Asia/Ho_Chi_Minh \
  -e TZ=Asia/Ho_Chi_Minh \
  -e WEBHOOK_URL=https://n8n.tenmiencuaban.com/ \
  -e N8N_HOST=n8n.tenmiencuaban.com \
  -v n8n_data:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n
```

`WEBHOOK_URL` phải là URL công khai (Apps Script gọi từ máy chủ Google, nên
`localhost` không dùng được). Đang thử nghiệm ở máy cá nhân thì dùng
`cloudflared tunnel` / `ngrok` để có URL https tạm.

## 1. Import 3 workflow

Trong n8n: **Workflows → ⋯ → Import from File**, lần lượt:

1. `n8n/workflows/01-collect-source-posts.json`
2. `n8n/workflows/02-check-and-publish.json`
3. `n8n/workflows/03-publish-queue.json`

## 2. Tạo credential

| Credential | Dùng ở | Cách tạo |
| --- | --- | --- |
| **Google Sheets OAuth2 API** | các node `Sheets: …` | Credentials → New → Google Sheets OAuth2 → làm theo hướng dẫn OAuth của n8n |
| **Google Drive OAuth2 API** | các node `Drive: …` | Tương tự, bật Drive API trong Google Cloud project |
| **Facebook Graph API** | các node `FB: …`, `Graph: …` | Dán **Page Access Token** lấy ở [docs/01](01-facebook-app.md) |

Các node Drive/Facebook dùng HTTP Request với *Predefined Credential Type*, nên khi
mở node bạn chỉ cần chọn credential ở dropdown **Credential for Google Drive OAuth2 API** /
**Credential for Facebook Graph API**. Node nào cần credential đều có ghi chú trên
canvas.

> Cả 3 credential Google (Sheets + Drive) nên dùng **cùng một tài khoản Google** sở
> hữu Sheet và folder Drive, để không phải chia sẻ quyền qua lại.

## 3. Điền node `Config`

Mỗi workflow có một node `Config` màu vàng ở đầu — **đây là chỗ duy nhất cần sửa**.

**Workflow 01 — thu bài**

| Khoá | Điền gì |
| --- | --- |
| `sheet_id` | Sheet ID (lấy từ URL Google Sheet) |
| `graph_version` | `v21.0` (giữ nguyên nếu không có lý do đổi) |
| `timezone` | `Asia/Ho_Chi_Minh` |
| `default_max_posts` | Số bài mỗi nguồn mỗi lần chạy, mặc định `5` |
| `post_id_prefix` | Tiền tố mã bài, mặc định `AP` |

**Workflow 02 — kiểm tra & đăng**

| Khoá | Điền gì |
| --- | --- |
| `sheet_id` | Sheet ID |
| `page_id` | ID Facebook Page sẽ đăng |
| `webhook_secret` | Chuỗi bí mật bạn tự đặt — **phải trùng** với menu ② trong Sheet |
| `graph_version` | `v21.0` |
| `timezone` | `Asia/Ho_Chi_Minh` |
| `min_images` / `max_images` | Mặc định `1` / `10`. Đặt `min_images = 0` nếu muốn cho phép bài không ảnh |
| `max_image_mb` | Giới hạn dung lượng mỗi ảnh, mặc định `8` |
| `min_content_chars` | Số ký tự tối thiểu, mặc định `50` |

**Workflow 03 — hàng đợi**

| Khoá | Điền gì |
| --- | --- |
| `sheet_id` | Sheet ID |
| `publish_url` | URL production webhook của workflow 02, dạng `https://.../webhook/autopost-publish` |
| `webhook_secret` | Giống workflow 02 |
| `timezone` | `Asia/Ho_Chi_Minh` |
| `max_per_run` | Số bài tối đa mỗi lần quét, mặc định `3` |

## 4. Lấy URL webhook

Mở workflow 02 → node `Webhook: Đăng bài` → tab **Production URL**. Dạng:

```
https://abc.app.n8n.cloud/webhook/autopost-publish
```

Phần trước `/webhook` chính là Base URL bạn nhập ở menu ② trong Sheet.
Workflow 01 có webhook tương tự: `/webhook/autopost-collect`.

> **Test URL vs Production URL**: Test URL (`/webhook-test/...`) chỉ sống khi bạn
> bấm *Execute workflow* trong UI. Muốn Sheet gọi được mọi lúc thì phải **Activate**
> workflow và dùng Production URL.

## 5. Activate

Bật toggle **Active** cho cả 3 workflow:

- 01: chạy theo lịch mỗi 2 giờ + nhận webhook thu bài;
- 02: nhận webhook kiểm tra/đăng — **bắt buộc active**;
- 03: quét sheet mỗi 5 phút.

Không muốn thu bài tự động: tắt Active workflow 01 và chỉ bấm menu
*⬇️ Thu bài mới từ các page nguồn* khi cần (webhook chỉ hoạt động khi workflow
active, nên trường hợp này hãy dùng nút **Execute workflow** trong n8n).

## 6. Chạy thử theo thứ tự

1. **Sheet → ① Khởi tạo cấu trúc sheet** (nếu chưa làm).
2. Thêm 1 dòng tay vào `Posts`: `post_id = AP-0001`, `status = NEED_CONTENT`,
   `drive_folder_url` = link folder thật của bạn.
3. **Sheet → 🔍 Kiểm tra bài đang chọn** → mong đợi `status = READY` và
   `check_note = ✅ Đủ thành phần: … ký tự nội dung + … ảnh.`
4. **Sheet → 📤 Đăng bài đang chọn** → mong đợi `status = POSTED` và có
   `fb_permalink`.
5. Điền `Sources`, bấm **⬇️ Thu bài mới từ các page nguồn** (hoặc Execute workflow
   01) → xem bài mới xuất hiện ở `Posts`.

## 7. Nếu node Sheets báo lỗi Document ID

Các node Sheets lấy `sheet_id` bằng biểu thức `{{ $('Config').first().json.sheet_id }}`
để bạn chỉ phải điền một chỗ. Nếu bản n8n của bạn không chịu biểu thức trong ô
**Document**, hãy đổi ô đó sang **By ID** và dán trực tiếp Sheet ID vào từng node
`Sheets: …` (workflow 02 có 6 node như vậy).

## 8. Sửa workflow lâu dài

Sửa nhanh thì cứ sửa trong UI n8n. Nếu muốn giữ thay đổi trong repo:

```bash
# sửa tools/build-workflows.mjs
npm test        # build lại JSON + kiểm tra cấu trúc
```

rồi import lại file JSON vào n8n. Không sửa tay `n8n/workflows/*.json` vì lần build
sau sẽ ghi đè.
