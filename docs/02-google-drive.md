# 02 — Google Drive: quy ước folder bài viết

Mỗi bài viết = **một folder** trên Drive. Bạn dán link folder đó vào cột
`drive_folder_url` của sheet `Posts`.

## 1. Bên trong folder cần có gì

```
AP-0007 - Tieu de bai/
├── content.md          ← bài đã dịch sang tiếng Anh (bắt buộc, 1 file)
├── 01-cover.jpg        ← ảnh, đăng theo thứ tự tên file
├── 02-detail.jpg
└── 03-detail.png
```

**File nội dung** — n8n nhận 3 dạng:

| Dạng | Ghi chú |
| --- | --- |
| `.md` / `.txt` | Đơn giản nhất, khuyến nghị. Encoding UTF-8. |
| Google Docs | n8n tự export sang text. Tiện nếu bạn dịch trực tiếp trên Docs. |
| file `text/*` khác | Vẫn nhận, nhưng nên dùng 2 dạng trên. |

Nếu folder có **nhiều** file nội dung, n8n lấy file đầu tiên theo thứ tự tên và
ghi cảnh báo vào `check_note`. Nên giữ đúng 1 file.

**Ảnh** — `jpg`, `jpeg`, `png`, `gif`, `webp`; mỗi ảnh ≤ 8MB (đổi được ở node
`Config`, khoá `max_image_mb`); tối đa 10 ảnh/bài.

## 2. Thứ tự ảnh

Ảnh được sắp theo **tên file**, so sánh có hiểu số (`2.jpg` trước `10.jpg`).
Muốn chắc chắn thứ tự, đánh số tiền tố: `01-`, `02-`, `03-`…
Ảnh đầu tiên là ảnh hiển thị lớn nhất trong bài Facebook.

## 3. Nội dung file sẽ thành caption như thế nào

Toàn bộ text trong file = nội dung bài đăng. n8n chỉ xử lý nhẹ:

- bỏ BOM, chuẩn hoá xuống dòng, gộp ≥3 dòng trống thành 1 dòng trống;
- nếu dòng đầu là tiêu đề Markdown (`# Tiêu đề`) thì bỏ dấu `#`, giữ lại chữ;
- **không** bỏ emoji, hashtag, link — cứ viết như bạn muốn nó hiện trên Facebook.

Cột `title` trong sheet chỉ để bạn nhận biết bài, **không** được đăng lên Facebook.

## 4. Chia sẻ quyền cho n8n

n8n đọc Drive bằng credential Google của bạn:

- **Google OAuth2 (khuyến nghị cho cá nhân)**: đăng nhập bằng đúng tài khoản sở hữu
  folder → không cần chia sẻ gì thêm.
- **Service Account**: phải **Share** folder gốc (hoặc từng folder bài) cho email
  service account (`...@....iam.gserviceaccount.com`) với quyền **Viewer**.

Nếu quên bước này, `check_note` sẽ hiện:
`Không đọc được folder Drive: File not found` hoặc `Folder Drive rỗng (hoặc n8n
chưa được chia sẻ quyền xem folder này)`.

## 5. Lấy link folder

Mở folder trên Drive → copy URL trên thanh địa chỉ:

```
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz123456
```

Dán cả URL vào ô `drive_folder_url` — n8n tự bóc lấy ID. Dán riêng ID cũng được.

## 6. Mẹo tổ chức

- Tạo 1 folder mẹ `AutoPost/` chứa toàn bộ folder bài → chỉ cần share 1 lần.
- Đặt tên folder con bắt đầu bằng `post_id` (`AP-0007 - ...`) để đối chiếu nhanh
  với sheet.
- File nội dung đặt tên cố định `content.md` cho mọi bài → không bao giờ nhầm.
