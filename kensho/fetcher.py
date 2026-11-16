"""ツイート本文を X の公開埋め込み（oEmbed）から取得する。APIキー不要・無料。"""
from __future__ import annotations

import html
import json
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass

OEMBED_URL = "https://publish.twitter.com/oembed"


@dataclass
class Tweet:
    tweet_id: str
    handle: str
    author_name: str | None
    text: str
    url: str


class FetchError(Exception):
    pass


def parse_oembed_html(snippet: str) -> str:
    """oEmbedのHTML（<blockquote><p>本文</p>…）から本文テキストを取り出す。"""
    m = re.search(r"<p[^>]*>(.*?)</p>", snippet, re.DOTALL)
    body = m.group(1) if m else snippet
    body = re.sub(r"<br\s*/?>", "\n", body)
    body = re.sub(r"<[^>]+>", "", body)
    return html.unescape(body).strip()


def fetch_tweet(handle: str, tweet_id: str, timeout: float = 10) -> Tweet:
    url = f"https://twitter.com/{handle}/status/{tweet_id}"
    q = urllib.parse.urlencode({"url": url, "omit_script": "1", "lang": "ja", "dnt": "true"})
    req = urllib.request.Request(f"{OEMBED_URL}?{q}", headers={"User-Agent": "kensho-helper/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # ネットワークエラー、削除済み・非公開ツイートなど
        raise FetchError(f"ツイートを取得できませんでした（{e}）") from e
    author_url = data.get("author_url", "")
    m = re.search(r"(?:x|twitter)\.com/([A-Za-z0-9_]{1,15})", author_url)
    return Tweet(
        tweet_id=tweet_id,
        handle=m.group(1) if m else handle,
        author_name=data.get("author_name"),
        text=parse_oembed_html(data.get("html", "")),
        url=f"https://x.com/{m.group(1) if m else handle}/status/{tweet_id}",
    )
