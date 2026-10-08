"""
fb-crawler: service HTTP nhỏ dùng SeleniumBase (Chrome headless) đọc bài mới của
một Facebook Page. Workflow n8n (lịch "Mỗi 4 giờ: thu bài") gọi:

    POST /crawl   {"page": "https://www.facebook.com/tenpage", "max_posts": 5}
    header        X-Crawler-Token: <CRAWLER_TOKEN>

Trả về {"ok": true, "logged_in": true, "posts": [...]} — mỗi bài gồm
source_post_id, source_post_url, text, images (link ảnh gốc), created_time.

Mặc định chạy KHÔNG đăng nhập (Facebook chỉ cho thấy ~3 bài mới nhất mỗi page).
Tuỳ chọn đăng nhập bằng cookie: /secrets/fb_cookies.json (xuất từ trình duyệt, xem
docs/03-n8n-va-crawler.md); cookie mới sau mỗi lần chạy được ghi ngược lại file để
phiên đăng nhập không hết hạn.

Chủ ý chạy CHẬM và ÍT: một trình duyệt tại một thời điểm, cuộn có nghỉ — để
giảm nguy cơ tài khoản bị checkpoint.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from seleniumbase import SB

from fbparse import extract_posts

TOKEN = os.environ.get("CRAWLER_TOKEN", "")
COOKIES_FILE = os.environ.get("FB_COOKIES_FILE", "/secrets/fb_cookies.json")
CHROME_BIN = os.environ.get("CHROME_BIN") or None
PORT = int(os.environ.get("PORT", "8000"))
MAX_SCROLLS = int(os.environ.get("MAX_SCROLLS", "8"))
MAX_POSTS_LIMIT = 10

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fb-crawler")
browser_lock = threading.Lock()


class CrawlError(Exception):
    pass


def page_url(ref: str) -> str:
    ref = (ref or "").strip()
    if not ref:
        raise CrawlError("Thiếu page (link hoặc id/username của page nguồn)")
    if re.match(r"^https?://", ref, re.I):
        return re.sub(r"^https?://(m|mbasic|web)\.facebook\.com", "https://www.facebook.com", ref, flags=re.I)
    return "https://www.facebook.com/" + ref.lstrip("@/")


def load_cookies() -> list[dict]:
    if not os.path.exists(COOKIES_FILE):
        return []
    with open(COOKIES_FILE, encoding="utf-8") as fh:
        raw = json.load(fh)
    # Chấp nhận định dạng của extension Cookie-Editor / EditThisCookie và của Selenium.
    if isinstance(raw, dict):
        raw = raw.get("cookies", [])
    cookies = []
    for c in raw:
        if not c.get("name") or "facebook.com" not in str(c.get("domain", ".facebook.com")):
            continue
        cookie = {
            "name": c["name"],
            "value": c.get("value", ""),
            "domain": c.get("domain") or ".facebook.com",
            "path": c.get("path") or "/",
            "secure": bool(c.get("secure", True)),
            "httpOnly": bool(c.get("httpOnly", False)),
        }
        expiry = c.get("expiry") or c.get("expirationDate")
        if expiry:
            cookie["expiry"] = int(float(expiry))
        cookies.append(cookie)
    return cookies


def save_cookies(cookies: list[dict]) -> None:
    keep = [c for c in cookies if "facebook.com" in str(c.get("domain", ""))]
    if not any(c.get("name") == "c_user" for c in keep):
        return  # không ghi đè cookie tốt bằng phiên đã bị đăng xuất
    tmp = COOKIES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(keep, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, COOKIES_FILE)


def is_logged_in(sb) -> bool:
    return any(c.get("name") == "c_user" for c in sb.driver.get_cookies())


def graphql_bodies(sb) -> list[str]:
    """Đọc lại các response /api/graphql/ (bài tải thêm khi cuộn) từ performance log."""
    bodies = []
    try:
        entries = sb.driver.get_log("performance")
    except Exception as exc:  # noqa: BLE001 — log CDP không bật thì chỉ dùng HTML
        log.warning("không đọc được performance log: %s", exc)
        return bodies
    for entry in entries:
        try:
            msg = json.loads(entry["message"])["message"]
        except (KeyError, ValueError):
            continue
        if msg.get("method") != "Network.responseReceived":
            continue
        params = msg.get("params", {})
        if "/api/graphql" not in str((params.get("response") or {}).get("url", "")):
            continue
        try:
            body = sb.driver.execute_cdp_cmd("Network.getResponseBody", {"requestId": params["requestId"]})
            bodies.append(body.get("body", ""))
        except Exception:  # noqa: BLE001 — response đã bị trình duyệt giải phóng
            continue
    return bodies


def pause(lo=2.0, hi=4.5):
    time.sleep(random.uniform(lo, hi))


def crawl(ref: str, max_posts: int) -> dict:
    url = page_url(ref)
    max_posts = max(1, min(int(max_posts or 5), MAX_POSTS_LIMIT))
    warnings: list[str] = []

    with browser_lock, SB(
        headless2=True,
        locale_code="vi",
        log_cdp=True,
        binary_location=CHROME_BIN,
        chromium_arg="--no-sandbox,--disable-dev-shm-usage",
    ) as sb:
        sb.open("https://www.facebook.com/robots.txt")  # mở đúng domain để nạp cookie
        cookies = load_cookies()
        for cookie in cookies:
            try:
                sb.driver.add_cookie(cookie)
            except Exception as exc:  # noqa: BLE001
                log.warning("bỏ qua cookie %s: %s", cookie.get("name"), exc)

        sb.open(url)
        pause(4, 6)
        current = sb.get_current_url()
        if re.search(r"/checkpoint|/login", current):
            raise CrawlError(
                "Facebook yêu cầu đăng nhập/xác minh (" + current + "). "
                "Mở Facebook trên trình duyệt thường, xử lý checkpoint nếu có, rồi xuất lại cookie."
            )
        logged_in = is_logged_in(sb)
        if not logged_in:
            warnings.append(
                "Chưa đăng nhập (thiếu/hết hạn cookie) — Facebook chỉ cho xem 1–3 bài đầu."
                if cookies else "Chưa có file cookie — Facebook chỉ cho xem 1–3 bài đầu."
            )

        sources = [sb.get_page_source()]
        posts = extract_posts(sources)
        scrolls = 0
        while len(posts) < max_posts and scrolls < MAX_SCROLLS:
            sb.execute_script("window.scrollBy(0, Math.round(window.innerHeight * (1.5 + Math.random())))")
            pause()
            scrolls += 1
            sources.extend(graphql_bodies(sb))
            posts = extract_posts(sources)
            if not logged_in and scrolls >= 2:
                break  # chưa đăng nhập thì cuộn thêm cũng không ra bài

        if logged_in:
            save_cookies(sb.driver.get_cookies())

    for p in posts:
        warnings.extend(f"{p['source_post_id']}: {w}" for w in p.pop("warnings", []))
    log.info("%s: %d bài (logged_in=%s, cuộn %d lần)", url, len(posts), logged_in, scrolls)
    return {"ok": True, "page": url, "logged_in": logged_in, "posts": posts[:max_posts], "warnings": warnings}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._send(200, {"ok": True, "cookies": os.path.exists(COOKIES_FILE)})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/crawl":
            self._send(404, {"ok": False, "error": "not found"})
            return
        if TOKEN and self.headers.get("X-Crawler-Token") != TOKEN:
            self._send(401, {"ok": False, "error": "Sai X-Crawler-Token"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            self._send(200, crawl(body.get("page", ""), body.get("max_posts", 5)))
        except CrawlError as exc:
            self._send(422, {"ok": False, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001 — luôn trả JSON cho n8n
            log.exception("crawl lỗi")
            self._send(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})

    def log_message(self, fmt, *args):
        log.info("%s %s", self.address_string(), fmt % args)


if __name__ == "__main__":
    if not TOKEN:
        log.warning("CRAWLER_TOKEN trống — ai gọi được cổng này cũng dùng được crawler")
    log.info("fb-crawler nghe ở :%d, cookie: %s", PORT, COOKIES_FILE)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
