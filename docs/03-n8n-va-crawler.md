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

Bật toggle **Active** của workflow. Ba lịch chạy cùng lúc:

| Lịch | Việc |
| --- | --- |
| Mỗi 4 giờ: thu bài | Đọc tab `Sources` → crawler lấy bài mới → thêm vào `Posts` (`NEED_TRANSLATE`) |
| Mỗi 5 phút: dịch | Tối đa 3 bài `NEED_TRANSLATE` → Gemini → `en_text`, `REVIEW` |
| Mỗi 2 phút: đăng | Đăng **1** bài đã tick `publish_now` hoặc đến giờ `scheduled_at`; gỡ bài kẹt `POSTING` |

Chạy thử ngay không chờ lịch: mở workflow → bấm **Execute workflow** → chọn trigger
(ví dụ *Mỗi 4 giờ: thu bài*).

## 6. Node `Config` — chỗ duy nhất để chỉnh

| Khoá | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `sheet_id`, `page_id`, `crawler_token` | từ `.env` | |
| `crawler_url` | `http://fb-crawler:8000/crawl` | Giữ nguyên khi chạy bằng docker compose |
| `default_max_posts` | `5` | Số bài/page khi cột `max_posts` trống |
| `skip_video_posts` | `true` | Bỏ bài reel/video không có ảnh |
| `post_id_prefix` | `AP` | Tiền tố mã bài |
| `gemini_model` | `gemini-3.5-flash-lite` | Model dịch |
| `translate_per_run` | `3` | Số bài dịch mỗi 5 phút (gói free có giới hạn/phút, /ngày) |
| `min_images` / `max_images` | `1` / `10` | Đặt `min_images = 0` để cho phép bài chỉ có chữ |
| `min_content_chars` | `50` | Bản dịch ngắn hơn thì không đăng |
| `stuck_posting_minutes` | `15` | Bài ở `POSTING` quá lâu → `ERROR` để bạn kiểm tra |

## 7. Chỉnh lịch thu bài / dịch / đăng

Mỗi việc có một node lịch riêng (*Mỗi 4 giờ: thu bài*, *Mỗi 5 phút: dịch*, *Mỗi 2
phút: đăng*). Mở node → **Trigger Interval** chọn:

- **Hours / Minutes** — chạy đều, ví dụ mỗi 6 giờ, mỗi 10 phút.
- **Custom (Cron)** — chạy vào giờ cố định. Giờ tính theo `Asia/Ho_Chi_Minh` (biến
  `GENERIC_TIMEZONE` trong `docker-compose.yml`).

| Muốn | Node | Cron |
| --- | --- | --- |
| Thu bài lúc 7h, 12h, 19h | thu bài | `0 7,12,19 * * *` |
| Thu bài mỗi 3 giờ từ 6h đến 21h | thu bài | `0 6-21/3 * * *` |
| Dịch mỗi 10 phút, chỉ 7h–23h | dịch | `*/10 7-23 * * *` |
| Chỉ đăng trong 8h–22h | đăng | `*/2 8-21 * * *` |

Lưu (Ctrl+S) — workflow đang Active thì lịch mới có hiệu lực ngay.

Lưu ý:

- **Đăng vào giờ cụ thể cho từng bài**: không cần sửa lịch — điền cột `scheduled_at`
  (`2026-01-31 08:30`), bài lên trong ≤ 2 phút sau giờ đó. Giữ lịch đăng ngắn (2–5
  phút) vì nó cũng là độ trễ khi bạn tick `publish_now`. Giới hạn giờ cho node đăng
  (ví dụ 8h–22h) thì bài tick lúc 23h sẽ chờ tới 8h sáng.
- **Mỗi lượt đăng chỉ 1 bài** → lịch đăng cũng là khoảng cách tối thiểu giữa 2 bài.
  Muốn giãn ra (ví dụ ≥ 30 phút/bài khi tick nhiều bài) thì đổi thành mỗi 30 phút.
- **Số lượng mỗi lượt** chỉnh ở node `Config`: `translate_per_run` (bài dịch/lượt),
  `default_max_posts` hoặc cột `max_posts` ở tab `Sources` (bài/page/lượt thu).
- Đừng crawl dày hơn 2–3 giờ/lần — Facebook dễ chặn tạm thời. Không đăng nhập thì
  mỗi lượt chỉ thấy ~3 bài mới nhất/page, nên page đăng nhiều thì cần thu dày hơn
  hoặc dùng cookie.
- Sửa trong giao diện n8n sẽ **mất khi import lại** workflow. Muốn giữ lâu dài thì
  sửa mảng `SECTIONS` trong `tools/build-workflows.mjs`, ví dụ
  `rule: { field: 'cronExpression', expression: '0 7,12,19 * * *' }`, rồi build và
  import lại.

## 8. Sửa workflow lâu dài

Workflow được sinh từ [`tools/build-workflows.mjs`](../tools/build-workflows.mjs).
Sửa ở đó rồi:

```bash
npm test           # build + kiểm tra cấu trúc + chạy thử code các node + test crawler
```

và import lại. Không ghi sheet id / token thật vào file builder — để trong `.env`.
