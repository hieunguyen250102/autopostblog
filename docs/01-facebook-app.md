# 01 — App Facebook & Page Access Token

Mục tiêu: có một **Page Access Token dài hạn** để n8n đăng bài lên Page của bạn.

## 1. Tạo app

1. Vào <https://developers.facebook.com/apps> → **Create App**.
2. Use case: chọn **Other** → App type: **Business** → đặt tên app → Create.
3. Trong app, vào **App settings → Basic**, ghi lại **App ID** và **App Secret**
   (dùng cho `npm run check:fb`, không bắt buộc cho n8n).
4. Vào **Add products** → thêm **Facebook Login for Business** (chỉ cần để lấy
   token trong Graph API Explorer) và **Webhooks** thì không cần.

## 2. Lấy Page ID

Mở Page → **Settings → Page transparency**, hoặc dễ nhất: dùng Graph API Explorer
gọi `me/accounts` ở bước dưới, ID hiện ngay trong kết quả.

## 3. Lấy token bằng Graph API Explorer

1. Mở <https://developers.facebook.com/tools/explorer/>.
2. Góc phải: chọn đúng **app** của bạn.
3. **User or Page**: chọn *User Token* trước.
4. **Permissions** — thêm các quyền:
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_posts`  ← bắt buộc để đăng bài
5. **Generate Access Token** → đăng nhập, chọn Page cần dùng, cấp đủ quyền.
6. Gọi `GET /me/accounts` → copy `access_token` của đúng Page trong danh sách.
   Đây là **Page Access Token** (nhưng đang short-lived, ~1-2 giờ).

## 4. Đổi sang token dài hạn (không hết hạn)

Page token sinh từ một **long-lived user token** sẽ không có ngày hết hạn.

```bash
# B1: đổi short-lived user token -> long-lived user token (~60 ngày)
curl -s "https://graph.facebook.com/v21.0/oauth/access_token\
?grant_type=fb_exchange_token\
&client_id=APP_ID\
&client_secret=APP_SECRET\
&fb_exchange_token=SHORT_LIVED_USER_TOKEN"

# B2: dùng long-lived user token vừa nhận để lấy page token (không hết hạn)
curl -s "https://graph.facebook.com/v21.0/me/accounts?access_token=LONG_LIVED_USER_TOKEN"
```

Token của Page trong kết quả B2 là token bạn dán vào n8n.

## 5. Kiểm tra trước khi dùng

```bash
cp .env.example .env     # rồi điền FB_PAGE_TOKEN, FB_PAGE_ID, FB_APP_ID, FB_APP_SECRET
npm run check:fb
```

Script sẽ báo: token thuộc về ai, có đúng là Page token không, có đủ
`pages_manage_posts` không, có hết hạn không, đọc được feed page không.

Muốn thử đăng thật (bài chế độ **SELF** — chỉ admin Page thấy, nhớ xoá sau):

```bash
npm run check:fb -- --post
```

## 6. App Review — có cần không?

**Không.** Đăng bài lên **Page bạn quản trị** dùng được `pages_manage_posts` ngay ở
chế độ Development của app. Bài của page nguồn do crawler đọc (docs/03), không
dùng Graph API nên không cần quyền *Page Public Content Access*.

## 7. Giới hạn kỹ thuật cần nhớ

- Một bài tối đa **10 ảnh** (`attached_media`).
- Nội dung tối đa ~63.206 ký tự (workflow chặn ở 60.000 để chắc).
- Rate limit Page: đăng dồn dập dễ bị chặn tạm thời → workflow chỉ đăng **1 bài mỗi
  2 phút**, tick nhiều bài thì chúng lần lượt lên.

Có token rồi: trong n8n tạo credential **Facebook Graph API**, dán token vào
(xem [docs/03](03-n8n-va-crawler.md)).
