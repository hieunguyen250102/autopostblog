# 05 — Deploy lên VPS

Chạy n8n + fb-crawler 24/7 trên một VPS Linux. Máy cá nhân chỉ dùng để mở giao diện
n8n và build workflow.

```
Máy bạn ──SSH tunnel──▶ VPS: n8n (127.0.0.1:5678) ──▶ fb-crawler (mạng Docker nội bộ)
                              │
                              └─▶ Google Sheets, Gemini, Facebook Graph API (đi ra Internet)
```

Workflow chỉ chạy theo lịch, **không có webhook** → VPS không cần mở cổng nào ngoài
SSH. Đây là cách mặc định (mục 6A). Muốn mở n8n bằng tên miền HTTPS thì xem mục 6B.

## 1. Chọn VPS

| | Tối thiểu | Nên dùng |
| --- | --- | --- |
| CPU / RAM | 1 vCPU / 2 GB | 2 vCPU / 4 GB |
| Ổ đĩa | 20 GB | 40 GB |
| Hệ điều hành | Ubuntu 22.04 / 24.04 LTS | |

Chrome headless của crawler ăn ~0,5–1 GB RAM mỗi lần chạy. VPS 2 GB thì **bắt buộc
tạo swap** (mục 2).

> IP datacenter hay bị Facebook bắt đăng nhập hơn IP nhà. Nếu crawler trên VPS báo
> `không lấy được bài nào` / `yêu cầu đăng nhập` thường xuyên trong khi chạy ở máy
> nhà vẫn được, xem cách dùng cookie ở docs/03 hoặc chọn VPS ở Việt Nam.

## 2. Chuẩn bị VPS (làm 1 lần)

SSH vào VPS bằng root (hoặc user có sudo):

```bash
ssh root@IP_VPS
```

**Cập nhật, tạo user riêng, đặt múi giờ:**

```bash
apt update && apt upgrade -y
timedatectl set-timezone Asia/Ho_Chi_Minh

adduser deploy                       # đặt mật khẩu
usermod -aG sudo deploy
# Copy SSH key của root sang user mới để đăng nhập bằng key
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

Từ máy bạn thử `ssh deploy@IP_VPS` được rồi mới làm tiếp.

**Firewall — chỉ mở SSH:**

```bash
sudo ufw allow OpenSSH
sudo ufw enable
sudo ufw status
```

**Tắt đăng nhập bằng mật khẩu** (sau khi chắc chắn SSH key chạy được): sửa
`/etc/ssh/sshd_config` thành `PasswordAuthentication no` và `PermitRootLogin no`, rồi
`sudo systemctl restart ssh`.

**Swap 2 GB** (bỏ qua nếu VPS ≥ 4 GB RAM):

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h                              # thấy dòng Swap: 2.0Gi là được
```

**Cài Docker:**

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy
exit                                 # đăng xuất rồi SSH lại để nhận quyền nhóm docker
```

```bash
ssh deploy@IP_VPS
docker version && docker compose version
```

## 3. Lấy code về VPS

Repo private → dùng **deploy key** (key chỉ đọc, chỉ cho repo này):

```bash
ssh-keygen -t ed25519 -C "vps-autopostblog" -f ~/.ssh/autopostblog -N ""
cat ~/.ssh/autopostblog.pub
```

GitHub → repo → **Settings → Deploy keys → Add deploy key** → dán nội dung trên, **không**
tick *Allow write access*.

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-autopostblog
  HostName github.com
  User git
  IdentityFile ~/.ssh/autopostblog
  IdentitiesOnly yes
EOF

git clone git@github-autopostblog:hieunguyen250102/autopostblog.git ~/autopostblog
cd ~/autopostblog
```

## 4. File bí mật

Các file này **không có trong git**, phải tự đưa lên VPS.

**`.env`** — copy nguyên file `.env` từ máy bạn (để `CRAWLER_TOKEN` trên VPS khớp với
token đã build vào workflow). Chạy trên **máy bạn**:

```bash
scp .env deploy@IP_VPS:~/autopostblog/.env
```

Trên VPS:

```bash
chmod 600 ~/autopostblog/.env
```

Chưa có `.env` thì `cp .env.example .env` rồi điền như docs/03 mục 1 (tạo token mới:
`openssl rand -hex 16`).

**Cookie Facebook** (chỉ khi dùng, xem docs/03):

```bash
scp crawler/secrets/fb_cookies.json deploy@IP_VPS:~/autopostblog/crawler/secrets/
ssh deploy@IP_VPS chmod 600 ~/autopostblog/crawler/secrets/fb_cookies.json
```

## 5. Chạy n8n + crawler

```bash
cd ~/autopostblog
docker volume create n8n_data
docker compose up -d --build         # lần đầu build crawler mất vài phút
docker compose ps                    # cả 2 container phải ở trạng thái Up
```

Kiểm tra crawler:

```bash
curl -s localhost:8765/health
curl -s -X POST localhost:8765/crawl \
  -H "X-Crawler-Token: $(grep ^CRAWLER_TOKEN .env | cut -d= -f2)" \
  -d '{"page": "https://www.facebook.com/tenpage", "max_posts": 3}'
```

Container có `restart: unless-stopped` → VPS khởi động lại thì tự chạy lại, không cần
làm gì.

## 6. Mở giao diện n8n

### 6A. SSH tunnel (mặc định — không cần tên miền)

n8n chỉ nghe ở `127.0.0.1:5678` trên VPS. Từ **máy bạn**:

```bash
ssh -N -L 5678:localhost:5678 deploy@IP_VPS
```

Giữ cửa sổ đó mở, vào <http://localhost:5678> trên trình duyệt máy bạn. Lần đầu n8n
bắt tạo tài khoản owner — đặt mật khẩu mạnh.

Ưu điểm: không phơi n8n ra Internet, và OAuth Google chạy luôn vì redirect URL vẫn là
`http://localhost:5678/rest/oauth2-credential/callback` — trùng với lúc chạy ở máy
nhà.

> Máy bạn đang chạy n8n local ở cổng 5678 thì tắt nó đi trước (`docker compose down`
> ở máy bạn), nếu không tunnel sẽ báo cổng đã dùng.

### 6B. Tên miền + HTTPS (tuỳ chọn)

Dùng khi muốn mở n8n ở bất kỳ đâu không cần SSH. Cần một tên miền, ví dụ
`n8n.example.com`, trỏ bản ghi **A** về IP VPS.

**1. Báo cho n8n biết địa chỉ public** — tạo `docker-compose.override.yml` (đã
gitignore, docker compose tự gộp với file chính):

```bash
cat > ~/autopostblog/docker-compose.override.yml <<'EOF'
services:
  n8n:
    environment:
      - N8N_HOST=n8n.example.com
      - N8N_PROTOCOL=https
      - N8N_EDITOR_BASE_URL=https://n8n.example.com/
      - WEBHOOK_URL=https://n8n.example.com/
      - N8N_PROXY_HOPS=1
EOF
docker compose up -d
```

**2. Caddy làm reverse proxy, tự lấy chứng chỉ Let's Encrypt:**

```bash
sudo apt install -y caddy
echo 'n8n.example.com {
    reverse_proxy 127.0.0.1:5678
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo ufw allow 80,443/tcp
```

Vào `https://n8n.example.com`.

**3. Google OAuth:** Google Cloud Console → **APIs & Services → Credentials** → OAuth
client của n8n → thêm *Authorized redirect URI*
`https://n8n.example.com/rest/oauth2-credential/callback` (giữ cả URI localhost cũ cũng
được). Google không nhận IP trần, phải là tên miền.

## 7. Đưa workflow lên n8n trên VPS

Có 2 cách — chọn **một**.

### Cách 1: Import mới (sạch, khuyên dùng)

Trên **máy bạn** (nơi có `.env` + Node ≥ 18):

```bash
npm run build                        # sinh n8n/local/autopost.json
```

Trong n8n trên VPS (qua tunnel/tên miền): **Workflows → ⋯ → Import from File** → chọn
`n8n/local/autopost.json` trên máy bạn. Rồi tạo lại 3 credential như docs/03 mục 4
(Google Sheets OAuth2, Facebook Graph API, Header Auth cho Gemini) → bật **Active**.

> **Tắt workflow ở n8n máy nhà** (toggle Active → off, hoặc `docker compose down`).
> Hai nơi cùng chạy sẽ cùng thu bài và cùng đăng → bài trùng trên Page.

### Cách 2: Chuyển nguyên dữ liệu n8n từ máy nhà

Mang theo cả workflow, credential, lịch sử chạy, tài khoản đăng nhập. Trên **máy bạn**:

```bash
docker compose stop n8n              # dừng để dữ liệu không bị ghi dở
docker run --rm -v n8n_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/n8n_data.tgz -C /data .
scp n8n_data.tgz deploy@IP_VPS:~/
rm n8n_data.tgz
```

Trên **VPS** (làm trước khi n8n trên VPS được dùng, vì sẽ ghi đè):

```bash
cd ~/autopostblog
docker compose stop n8n
docker run --rm -v n8n_data:/data -v ~:/backup alpine \
  sh -c 'rm -rf /data/* /data/.[!.]* ; tar xzf /backup/n8n_data.tgz -C /data && chown -R 1000:1000 /data'
docker compose start n8n
rm ~/n8n_data.tgz
```

File `.tgz` chứa khoá giải mã credential — xoá ngay sau khi chuyển xong. Máy nhà đừng
`docker compose start n8n` lại (hoặc tắt Active workflow) để không chạy hai nơi.

## 8. Kiểm tra sau khi deploy

1. n8n → workflow → **Execute workflow** → chọn *Thu bài: kiểm tra mỗi 5 phút* → execution xanh,
   tab `Posts` có dòng mới `NEED_TRANSLATE`.
2. Chờ ≤ 5 phút → dòng đó thành `REVIEW`, có `en_text`.
3. Tick `publish_now` một bài → ≤ 2 phút sau `POSTED` + có `fb_permalink`.
4. `docker compose logs --tail 50 fb-crawler` không có lỗi lặp lại.

## 9. Vận hành trên VPS

**Xem log / trạng thái:**

```bash
cd ~/autopostblog
docker compose ps
docker compose logs -f fb-crawler
docker compose logs -f n8n
docker stats --no-stream             # RAM/CPU từng container
```

**Cập nhật code** (sau khi push từ máy bạn):

```bash
cd ~/autopostblog
git pull
docker compose up -d --build         # build lại crawler nếu code crawler đổi
```

Code workflow đổi (`tools/build-workflows.mjs`) thì còn phải build ở máy bạn và import
lại (xoá workflow cũ trước, chọn lại credential, bật Active).

**Cập nhật n8n:**

```bash
docker compose pull n8n && docker compose up -d n8n
```

Image n8n đang dùng tag mới nhất; nên backup (dưới đây) trước khi cập nhật. Muốn cố
định phiên bản thì sửa `image:` trong `docker-compose.yml` thành
`docker.n8n.io/n8nio/n8n:<phiên bản>` (xem số phiên bản ở trang Releases của n8n trên
GitHub).

**Backup tự động hằng ngày** (giữ 14 bản gần nhất):

```bash
mkdir -p ~/autopostblog/backups
crontab -e
```

Thêm dòng:

```
30 3 * * * docker run --rm -v n8n_data:/data:ro -v $HOME/autopostblog/backups:/backup alpine tar czf /backup/n8n_$(date +\%F).tgz -C /data . && ls -1t $HOME/autopostblog/backups/n8n_*.tgz | tail -n +15 | xargs -r rm
```

Nên chép backup ra ngoài VPS định kỳ (máy bạn, Google Drive…):
`scp deploy@IP_VPS:~/autopostblog/backups/n8n_*.tgz ./`. Khôi phục: như bước VPS ở
mục 7 cách 2.

**Dọn ổ đĩa** (image cũ sau nhiều lần build):

```bash
docker image prune -f
df -h
```

## 10. Lỗi thường gặp khi deploy

| Triệu chứng | Xử lý |
| --- | --- |
| `docker compose up` báo `external volume "n8n_data" not found` | `docker volume create n8n_data` |
| `Thiếu CRAWLER_TOKEN trong .env` | Chưa copy `.env` lên VPS hoặc đang đứng sai thư mục |
| Tunnel báo `bind: Address already in use` | Máy bạn đang có gì chạy ở 5678 (n8n local). Tắt nó, hoặc dùng `-L 15678:localhost:5678` rồi vào `localhost:15678` (OAuth Google khi đó cần thêm redirect URI cổng 15678) |
| n8n báo *secure cookie* / không đăng nhập được | Đang vào bằng `http://IP_VPS:...`. Dùng tunnel (`localhost`) hoặc tên miền HTTPS |
| Google OAuth báo `redirect_uri_mismatch` | Thêm đúng redirect URI n8n hiển thị trong credential vào OAuth client (mục 6B.3) |
| Crawler bị kill, log có `Killed` / `exit code 137` | Hết RAM → thêm swap (mục 2) hoặc nâng VPS |
| Crawler chạy ở máy nhà được nhưng VPS thì `không lấy được bài nào` | Facebook chặn IP datacenter — dùng cookie (docs/03) hoặc đổi nhà cung cấp/vùng VPS |
| Giờ trong `scheduled_at` lệch 7 tiếng | Container phải có `TZ=Asia/Ho_Chi_Minh` (đã có trong compose) và `timezone` trong node `Config` đúng; kiểm tra `docker compose exec n8n date` |
| Bài bị đăng 2 lần | n8n ở máy nhà vẫn Active — tắt đi |
