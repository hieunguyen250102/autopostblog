"""
Bóc bài viết từ dữ liệu JSON mà Facebook nhúng trong trang / trả qua /api/graphql/.

Không dựa vào CSS class (Facebook mã hoá và đổi liên tục) mà tìm các node JSON có
"__typename": "Story" — cấu trúc này ổn định hơn nhiều. File này không phụ thuộc
Selenium để test được bằng dữ liệu giả (xem test_fbparse.py).
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

SCRIPT_JSON_RE = re.compile(r'<script type="application/json"[^>]*>(.*?)</script>', re.S)

# Thứ tự ưu tiên: ảnh to nhất trước.
IMAGE_KEYS = ("viewer_image", "photo_image", "large_share_image", "image")
VIDEO_TYPES = {"Video", "GenericAttachmentMedia"}


def dig(obj, *path):
    for key in path:
        if isinstance(obj, dict):
            obj = obj.get(key)
        elif isinstance(obj, list) and isinstance(key, int) and -len(obj) <= key < len(obj):
            obj = obj[key]
        else:
            return None
    return obj


def find_first(obj, key, skip=("attached_story",)):
    """Giá trị đầu tiên của `key` (duyệt theo chiều rộng), bỏ qua nhánh bài được chia sẻ."""
    queue = [obj]
    while queue:
        cur = queue.pop(0)
        if isinstance(cur, dict):
            if key in cur and not isinstance(cur[key], (dict, list)) and cur[key] not in (None, ""):
                return cur[key]
            queue.extend(v for k, v in cur.items() if k not in skip)
        elif isinstance(cur, list):
            queue.extend(cur)
    return None


def iter_json_docs(text: str):
    """Response graphql là nhiều JSON nối nhau bằng xuống dòng; HTML có nhiều thẻ script JSON."""
    if "<script" in text:
        chunks = SCRIPT_JSON_RE.findall(text)
    else:
        chunks = text.splitlines()
    for chunk in chunks:
        chunk = chunk.strip()
        if chunk.startswith("for (;;);"):
            chunk = chunk[len("for (;;);"):]
        if not chunk or chunk[0] not in "[{":
            continue
        try:
            yield json.loads(chunk)
        except ValueError:
            continue


def iter_stories(doc):
    stack = [doc]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            if cur.get("__typename") == "Story" and (cur.get("post_id") or cur.get("comet_sections")):
                yield cur
                continue  # Story lồng bên trong (bài chia sẻ) xử lý cùng story cha
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)


def media_image(media):
    if not isinstance(media, dict) or media.get("__typename") in VIDEO_TYPES:
        return None
    for key in IMAGE_KEYS:
        uri = dig(media, key, "uri")
        if uri:
            return uri
    return None


def has_video_media(obj) -> bool:
    stack = [obj]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            if cur.get("__typename") == "Video":
                return True
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)
    return False


def images_from_attachments(attachments):
    images, warnings = [], []
    for att in attachments or []:
        styled = dig(att, "styles", "attachment") or {}
        subs = dig(styled, "all_subattachments") or dig(att, "all_subattachments") or {}
        nodes = subs.get("nodes") or []
        if nodes:
            for node in nodes:
                uri = media_image(node.get("media"))
                if uri:
                    images.append(uri)
            total = subs.get("count")
            if isinstance(total, int) and total > len(nodes):
                warnings.append(f"album có {total} ảnh, chỉ lấy được {len(nodes)}")
        else:
            uri = media_image(styled.get("media") or att.get("media"))
            if uri:
                images.append(uri)
    return images, warnings


def parse_story(story) -> dict | None:
    content = dig(story, "comet_sections", "content", "story") or {}
    post_id = str(story.get("post_id") or content.get("post_id") or find_first(story, "post_id") or "")
    if not post_id:
        return None

    text = (
        dig(content, "message", "text")
        or dig(content, "comet_sections", "message", "story", "message", "text")
        or dig(story, "message", "text")
        or ""
    )
    url = (
        content.get("wwwURL")
        or dig(story, "comet_sections", "context_layout", "story", "comet_sections", "metadata", 0, "story", "url")
        or story.get("url")
        or find_first(story, "wwwURL")
        or ""
    )
    created = story.get("creation_time") or find_first(story, "creation_time")

    images, warnings = images_from_attachments(story.get("attachments"))
    more, more_warn = images_from_attachments(content.get("attachments"))
    for uri in more:
        if uri not in images:
            images.append(uri)
    warnings += [w for w in more_warn if w not in warnings]

    has_video = (
        bool(re.search(r"/(reel|videos|watch)/", url))
        or has_video_media(story.get("attachments"))
        or has_video_media(content.get("attachments"))
    )
    shared = bool(story.get("attached_story") or content.get("attached_story"))
    if shared:
        warnings.append("bài chia sẻ lại từ nơi khác")

    return {
        "source_post_id": post_id,
        "source_post_url": url,
        "text": text.strip(),
        "images": list(dict.fromkeys(images))[:10],
        "created_time": datetime.fromtimestamp(int(created), tz=timezone.utc).isoformat() if created else "",
        "is_shared": shared,
        "has_video": has_video,
        "warnings": warnings,
    }


def merge(a: dict, b: dict) -> dict:
    """Cùng một bài có thể xuất hiện nhiều lần với độ đầy đủ khác nhau => giữ phần đầy đủ hơn."""
    out = dict(a)
    for key in ("text", "source_post_url", "created_time"):
        if len(str(b.get(key) or "")) > len(str(out.get(key) or "")):
            out[key] = b[key]
    if len(b.get("images") or []) > len(out.get("images") or []):
        out["images"] = b["images"]
    out["warnings"] = list(dict.fromkeys((out.get("warnings") or []) + (b.get("warnings") or [])))
    return out


def extract_posts(texts) -> list[dict]:
    """texts: HTML trang + các response graphql. Trả về bài mới nhất trước."""
    found: dict[str, dict] = {}
    for text in texts:
        for doc in iter_json_docs(text):
            for story in iter_stories(doc):
                post = parse_story(story)
                if not post:
                    continue
                key = post["source_post_id"]
                found[key] = merge(found[key], post) if key in found else post
    posts = [p for p in found.values() if p["text"] or p["images"]]
    posts.sort(key=lambda p: p["created_time"], reverse=True)
    return posts
