# 07 — Chạy n8n trên máy Ubuntu (và vì sao `npm install -g n8n` hay lỗi)

## Cách 1 — Docker Compose (khuyến nghị)

Không phụ thuộc Node.js trên máy, không lo version.

```bash
# 1. Cài Docker (Ubuntu) nếu chưa có
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER      # để không phải sudo mỗi lần
newgrp docker                      # hoặc logout/login lại

# 2. Chạy n8n từ trong repo
cd ~/workspace/autopostblog
docker compose up -d
docker compose logs -f n8n         # Ctrl+C để thoát log
```

Mở <http://localhost:5678> → tạo tài khoản owner (chỉ lần đầu, lưu trong volume).

**Import 3 workflow bằng 1 lệnh** (nhanh hơn click 3 lần trong UI):

```bash
docker compose exec n8n n8n import:workflow --separate --input=/workflows
docker compose restart n8n
```

Workflow import bằng CLI sẽ ở trạng thái **inactive** và **chưa có credential** —
vẫn phải vào UI chọn credential + điền node `Config` + bật Active như
[docs/04](04-n8n-setup.md).

Các lệnh hay dùng:

```bash
docker compose ps                  # đang chạy chưa
docker compose logs -f n8n         # xem log
docker compose restart n8n         # khởi động lại (sau khi đổi .env)
docker compose down                # tắt (dữ liệu vẫn giữ trong volume n8n_data)
docker compose down -v             # tắt + XOÁ SẠCH dữ liệu n8n
docker compose pull && docker compose up -d   # cập nhật n8n lên bản mới
```

### Mở URL công khai cho Apps Script gọi vào

Apps Script gọi webhook **từ server của Google**, nên `localhost:5678` không tới được.
Cần một URL public trỏ vào máy bạn:

```bash
# Terminal 1 — mở tunnel, đọc URL nó in ra
cloudflared tunnel --url http://localhost:5678
# ví dụ: https://random-words-1234.trycloudflare.com
```

```bash
# Terminal 2 — ghi URL đó vào .env rồi khởi động lại n8n
echo 'WEBHOOK_URL=https://random-words-1234.trycloudflare.com/' >> .env
docker compose up -d
```

Cài cloudflared nếu chưa có:

```bash
curl -L -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i /tmp/cloudflared.deb
```

> ⚠️ Quick tunnel **đổi URL mỗi lần chạy lại** → mỗi lần đổi phải sửa `WEBHOOK_URL`
> trong `.env`, sửa menu ② trong Sheet, và sửa `publish_url` ở node Config của
> workflow 03. Dùng lâu dài thì làm **named tunnel** (URL cố định theo domain của
> bạn) hoặc dùng **n8n Cloud**.

Kiểm tra webhook đã ra ngoài được chưa (sau khi đã Active workflow 02):

```bash
curl -i -X POST https://URL_TUNNEL_CUA_BAN/webhook/autopost-publish \
  -H 'content-type: application/json' -d '{"secret":"sai-secret"}'
# Kỳ vọng: HTTP 401 + {"ok":false,"error":"Sai webhook secret"}
# => đường đi thông, workflow đang chạy, chỉ sai secret như chủ đích
```

Nhận `404` → workflow 02 chưa Active. Không nhận gì → tunnel chưa lên.

---

## Cách 2 — Cài bằng npm (nếu vẫn muốn)

### Vì sao `sudo npm install n8n -g --legacy-peer-deps` thất bại

| Nguyên nhân | Dấu hiệu |
| --- | --- |
| **n8n bản mới cần Node.js ≥ 24** (n8n 2.40+). Ubuntu `apt` thường cho Node 18 | `npm WARN EBADENGINE required: { node: '>=24.0.0' }` |
| **Dùng `sudo` khi Node do nvm quản lý**: `sudo` chạy node hệ thống, cài vào prefix khác, binary không nằm trong PATH của bạn | cài "xong" nhưng `n8n: command not found` |
| `--legacy-peer-deps` không liên quan gì ở đây | không sửa được lỗi nào |

### Chẩn đoán trên máy bạn

```bash
node -v                      # cần >= 24 cho n8n mới nhất
which node npm
npm config get prefix         # prefix global npm đang dùng
ls "$(npm config get prefix)/bin" | grep -i n8n
echo $PATH
```

Nếu `ls` thấy `n8n` nhưng `n8n --version` báo not found → chỉ là **thiếu PATH**:

```bash
echo "export PATH=\"$(npm config get prefix)/bin:\$PATH\"" >> ~/.bashrc
source ~/.bashrc
```

### Cài đúng cách

```bash
# 1. Node 24 bằng nvm (KHÔNG dùng apt, KHÔNG dùng sudo)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL -l
nvm install 24
nvm use 24
nvm alias default 24
node -v                      # v24.x

# 2. Cài n8n — KHÔNG sudo (nvm đã cho bạn quyền ghi vào prefix riêng)
npm install -g n8n

# 3. Chạy
n8n start
```

Nếu buộc phải dùng Node 20 hoặc 22, ghim bản n8n cũ hơn:

```bash
npm install -g n8n@2.0.0     # hỗ trợ node >=20.19 <=24.x
```

### Không cài, chạy thẳng

```bash
npx n8n            # tải về cache rồi chạy luôn, vẫn cần Node đúng version
```

### Chạy n8n npm với URL public

```bash
export WEBHOOK_URL=https://url-tunnel-cua-ban/
export GENERIC_TIMEZONE=Asia/Ho_Chi_Minh
export TZ=Asia/Ho_Chi_Minh
n8n start
```

Dữ liệu nằm ở `~/.n8n/` (database SQLite + credential đã mã hoá). Muốn xoá sạch để
làm lại: `rm -rf ~/.n8n` (mất hết credential, phải tạo lại).

---

## Cách 3 — n8n Cloud

<https://n8n.io> → đăng ký. Có domain cố định dạng `https://abc.app.n8n.cloud`,
không cần Docker, không cần tunnel. Đây là cách ít việc nhất để hệ thống chạy
24/7 (máy local tắt là workflow 01/03 theo lịch cũng ngừng).

---

## So sánh nhanh

| | Docker Compose | npm / npx | n8n Cloud |
| --- | --- | --- | --- |
| Phụ thuộc Node trên máy | không | có (≥24) | không |
| URL public | cần tunnel | cần tunnel | có sẵn |
| Chạy 24/7 | máy phải bật | máy phải bật | có |
| Dễ vỡ khi update | thấp | cao | không |
