# 03 — n8n, crawler và Gemini

Tất cả chạy bằng một lệnh Docker Compose: **n8n** + **fb-crawler** (Python +
SeleniumBase, Chrome headless đọc page nguồn).

## 1. Điền `.env`

```bash
cp .env.example .env
```

| Biến | Điền gì |
| --- | --- |
| `N8N_SHEET_ID` | Sheet ID (docs/02) |
| `FB_PAGE_ID` | ID Page sẽ đăng bài (docs/01) |
| `CRAWLER_TOKEN` | Chuỗi ngẫu nhiên tự đặt, ví dụ `openssl rand -hex 16` |

## 2. Chạy n8n + crawler

```bash
docker rm -f n8n                 # chỉ khi đang có container n8n cũ chạy bằng `docker run`
docker compose up -d --build
```

Dữ liệu n8n nằm trong volume `n8n_data` nên xoá container cũ không mất gì. Lần đầu
chưa có volume thì tạo trước: `docker volume create n8n_data`.

Kiểm tra crawler (cổng 8765 chỉ mở cho máy này):

```bash
curl -s localhost:8765/health
curl -s -X POST localhost:8765/crawl \
  -H "X-Crawler-Token: $(grep ^CRAWLER_TOKEN .env | cut -d= -f2)" \
  -d '{"page": "https://www.facebook.com/tenpage", "max_posts": 3}'
```

### Có cần đăng nhập Facebook không?

**Không bắt buộc.** Mặc định crawler chạy **không đăng nhập** → không có tài khoản nào
bị rủi ro, nhưng Facebook chỉ cho xem **~3 bài mới nhất** mỗi page mỗi lần. Thu 4
giờ/lần thì đủ cho page đăng ≤ 3 bài trong 4 giờ.

Cần nhiều hơn thì cho crawler dùng cookie đăng nhập: cài extension **Cookie-Editor**,
mở facebook.com → Export → JSON → lưu vào `crawler/secrets/fb_cookies.json`
(`chmod 600`). Cookie là chìa khoá tài khoản — không gửi ai, không commit. Tài khoản
đó có thể bị checkpoint/khoá vì crawl vi phạm điều khoản Facebook.

## 3. Import workflow

```bash
npm run build      # sinh n8n/local/autopost.json, đã điền sheet_id / page_id / CRAWLER_TOKEN
```

n8n (<http://localhost:5678>) → **Workflows → ⋯ → Import from File** →
`n8n/local/autopost.json`. Chỉ **một** workflow.

> Import lại sau khi cập nhật: xoá workflow cũ trước rồi import, chọn lại credential.

## 4. Tạo 3 credential

Mở từng node có ghi chú *Cần chọn credential* và chọn:

| Credential | Node | Cách tạo |
| --- | --- | --- |
| **Google Sheets OAuth2 API** | các node `Sheets: …` | Credentials → New → Google Sheets OAuth2 → làm theo hướng dẫn OAuth của n8n. Dùng đúng tài khoản Google sở hữu Sheet |
| **Facebook Graph API** | các node `FB: …` | Dán **Page Access Token** dài hạn (docs/01) |
| **Header Auth** | `Gemini: Dịch` | Name `x-goog-api-key`, Value = API key tạo miễn phí ở <https://aistudio.google.com/apikey> |

## 5. Bật

Bật toggle **Active** của workflow. Ba việc chạy song song:

| Trigger | Việc |
| --- | --- |
| Thu bài: kiểm tra mỗi 5 phút | Đến lịch thu (mặc định mỗi 4 giờ) → đọc `Sources` → crawler lấy bài mới → thêm vào `Posts` (`NEED_TRANSLATE`) |
| Dịch: mỗi 5 phút | Tối đa 3 bài `NEED_TRANSLATE` → Gemini → `en_text`, `REVIEW` |
| Đăng: mỗi 2 phút | Đăng **1** bài đã tick `publish_now` hoặc đến giờ `scheduled_at`; gỡ bài kẹt `POSTING` |

**Giờ chạy thật chỉnh ở tab `Settings` của Sheet** (docs/02 mục 5): thu bài lúc mấy
giờ, khung giờ dịch / đăng, cách bao lâu giữa 2 bài… Không cần sửa trigger trong n8n.

Chạy thử ngay không chờ lịch: mở workflow → bấm **Execute workflow** → chọn trigger
(ví dụ *Thu bài: kiểm tra mỗi 5 phút*). Chạy tay luôn bỏ qua lịch trong `Settings`.

## 6. Node `Config` — giá trị mặc định

Chỉ cần điền 3 ô đầu (build từ `.env` thì đã điền sẵn). Các khoá có trong tab
`Settings` của Sheet thì Sheet được ưu tiên; ngoài ra **mọi khoá dưới đây (trừ 4 khoá
đầu) cũng có thể ghi đè** bằng cách thêm 1 dòng `key | value` vào tab `Settings`.

| Khoá | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `sheet_id`, `page_id`, `crawler_token` | từ `.env` | Chỉ sửa ở đây, Sheet không đè được |
| `crawler_url` | `http://fb-crawler:8000/crawl` | Giữ nguyên khi chạy bằng docker compose |
| `default_max_posts` | `5` | Số bài/page khi cột `max_posts` trống |
| `skip_video_posts` | `true` | Bỏ bài reel/video không có ảnh |
| `post_id_prefix` | `AP` | Tiền tố mã bài |
| `gemini_model` | `gemini-3.5-flash-lite` | Model dịch |
| `translate_per_run` | `3` | Số bài dịch mỗi 5 phút (gói free có giới hạn/phút, /ngày) |
| `min_images` / `max_images` | `1` / `10` | Đặt `min_images = 0` để cho phép bài chỉ có chữ |
| `min_content_chars` | `50` | Bản dịch ngắn hơn thì không đăng |
| `stuck_posting_minutes` | `15` | Bài ở `POSTING` quá lâu → `ERROR` để bạn kiểm tra |
| `crawl_every_hours`, `crawl_times`, `translate_hours`, `publish_hours`, `publish_gap_minutes` | `4`, trống, trống, trống, `0` | Lịch — xem docs/02 mục 5 |

## 7. Lịch hoạt động thế nào

Ba trigger chỉ là **nhịp kiểm tra** (5 / 5 / 2 phút). Mỗi lần chạy, n8n đọc tab
`Settings`, node **Cài đặt** quyết định lượt đó có làm hay không:

- **Thu bài**: n8n nhớ lần thu gần nhất (static data của workflow). Đủ
  `crawl_every_hours` hoặc vừa qua một mốc `crawl_times` thì thu, rồi ghi lại mốc. Thu
  lỗi cũng tính là đã thu — không bị gọi lại Facebook mỗi 5 phút. Import lại workflow
  thì mốc này mất → lần kiểm tra đầu tiên sẽ thu ngay.
- **Dịch**: ngoài `translate_hours` thì dừng.
- **Đăng**: nhánh đăng vẫn chạy để gỡ bài kẹt `POSTING`, nhưng chỉ chọn bài mới khi
  đang trong `publish_hours` và bài `POSTED` gần nhất đã cách ≥ `publish_gap_minutes`.

Các lượt "chưa đến giờ" vẫn hiện ở **Executions** (màu xanh, dừng ở node *Cài đặt*) —
đó là bình thường.

## 8. Sửa workflow lâu dài

Workflow được sinh từ [`tools/build-workflows.mjs`](../tools/build-workflows.mjs).
Sửa ở đó rồi:

```bash
npm test           # build + kiểm tra cấu trúc + chạy thử code các node + test crawler
```

và import lại. Không ghi sheet id / token thật vào file builder — để trong `.env`.
