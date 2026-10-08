"""Test bộ bóc bài với dữ liệu giả mô phỏng cấu trúc JSON của Facebook.

    python3 -m unittest crawler/test_fbparse.py
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fbparse  # noqa: E402


def photo(uri, big=None):
    m = {"__typename": "Photo", "image": {"uri": uri}}
    if big:
        m["viewer_image"] = {"uri": big}
    return m


def story(post_id, text="", ts=1791443058, attachments=None, url=None, **extra):
    url = url or f"https://www.facebook.com/page/posts/pfbid{post_id}"
    return {
        "__typename": "Story",
        "post_id": post_id,
        "creation_time": ts,
        "attachments": attachments or [],
        "comet_sections": {
            "content": {"story": {"post_id": post_id, "message": {"text": text}, "wwwURL": url,
                                  "actors": [{"profile_picture": {"uri": "https://x/avatar.jpg"}}]}},
            "context_layout": {"story": {"comet_sections": {"metadata": [{"story": {"url": url}}]}}},
        },
        **extra,
    }


def album(*uris, count=None):
    subs = {"nodes": [{"media": photo(u)} for u in uris]}
    if count is not None:
        subs["count"] = count
    return {"styles": {"__typename": "StoryAttachmentAlbumStyleRenderer",
                       "attachment": {"all_subattachments": subs}}}


def html_with(*docs):
    scripts = "".join(f'<script type="application/json" data-sjs>{json.dumps(d)}</script>' for d in docs)
    return f"<html><body>{scripts}</body></html>"


def feed(*stories):
    return {"data": {"user": {"timeline_list_feed_units": {"edges": [{"node": s} for s in stories]}}}}


class ParseTest(unittest.TestCase):
    def test_album_keeps_order_full_text_and_newlines(self):
        s = story("1", "Dòng 1\n\nDòng 2 #tag", attachments=[album("https://x/a.jpg", "https://x/b.jpg")])
        [p] = fbparse.extract_posts([html_with(feed(s))])
        self.assertEqual(p["source_post_id"], "1")
        self.assertEqual(p["text"], "Dòng 1\n\nDòng 2 #tag")
        self.assertEqual(p["images"], ["https://x/a.jpg", "https://x/b.jpg"])
        self.assertEqual(p["source_post_url"], "https://www.facebook.com/page/posts/pfbid1")
        self.assertTrue(p["created_time"].startswith("2026-"))
        self.assertFalse(p["has_video"])

    def test_single_photo_prefers_biggest_image(self):
        att = {"styles": {"attachment": {"media": photo("https://x/small.jpg", big="https://x/big.jpg")}}}
        [p] = fbparse.extract_posts([html_with(feed(story("2", "x", attachments=[att])))])
        self.assertEqual(p["images"], ["https://x/big.jpg"])

    def test_avatar_and_text_background_are_not_post_images(self):
        s = story("3", "chữ trên nền màu")
        s["comet_sections"]["content"]["story"]["text_format_metadata"] = {"background_image": {"uri": "https://x/bg.jpg"}}
        [p] = fbparse.extract_posts([html_with(feed(s))])
        self.assertEqual(p["images"], [])

    def test_album_larger_than_loaded_gives_warning(self):
        s = story("4", "x", attachments=[album("https://x/1.jpg", count=12)])
        [p] = fbparse.extract_posts([html_with(feed(s))])
        self.assertIn("album có 12 ảnh, chỉ lấy được 1", p["warnings"])

    def test_video_and_reel_flagged(self):
        reel = story("5", "reel", url="https://www.facebook.com/reel/99/")
        vid = story("6", "video", attachments=[{"media": {"__typename": "Video", "image": {"uri": "https://x/thumb.jpg"}}}])
        posts = {p["source_post_id"]: p for p in fbparse.extract_posts([html_with(feed(reel, vid))])}
        self.assertTrue(posts["5"]["has_video"])
        self.assertTrue(posts["6"]["has_video"])
        self.assertEqual(posts["6"]["images"], [], "ảnh thumbnail video không được tính")

    def test_graphql_lines_and_for_loop_prefix(self):
        a = json.dumps({"data": {"node": story("7", "từ graphql", ts=100)}})
        b = json.dumps({"label": "x", "data": {"node": story("8", "dòng 2", ts=200)}})
        posts = fbparse.extract_posts(["for (;;);" + a + "\r\n" + b + "\nkhông phải json"])
        self.assertEqual([p["source_post_id"] for p in posts], ["8", "7"], "mới nhất trước")

    def test_same_post_twice_keeps_fuller_version(self):
        short = story("9", "ngắn")
        full = story("9", "đầy đủ hơn nhiều", attachments=[album("https://x/z.jpg")])
        [p] = fbparse.extract_posts([html_with(feed(short)), json.dumps({"data": full})])
        self.assertEqual(p["text"], "đầy đủ hơn nhiều")
        self.assertEqual(p["images"], ["https://x/z.jpg"])

    def test_shared_post_flagged_and_nested_story_not_duplicated(self):
        s = story("10", "chia sẻ", attached_story={"__typename": "Story", "post_id": "999",
                                                   "message": {"text": "bài gốc"}})
        posts = fbparse.extract_posts([html_with(feed(s))])
        self.assertEqual([p["source_post_id"] for p in posts], ["10"])
        self.assertTrue(posts[0]["is_shared"])

    def test_max_ten_images(self):
        s = story("11", "x", attachments=[album(*[f"https://x/{i}.jpg" for i in range(14)])])
        [p] = fbparse.extract_posts([html_with(feed(s))])
        self.assertEqual(len(p["images"]), 10)

    def test_empty_story_dropped(self):
        self.assertEqual(fbparse.extract_posts([html_with(feed(story("12", "")))]), [])


if __name__ == "__main__":
    unittest.main()
