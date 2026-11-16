"""X の Web Intent（確認画面）URL を作る。API不要・無料。"""
from urllib.parse import quote, urlencode


def follow_url(handle: str) -> str:
    return "https://x.com/intent/follow?" + urlencode({"screen_name": handle})


def repost_url(tweet_id: str) -> str:
    return "https://x.com/intent/retweet?" + urlencode({"tweet_id": tweet_id})


def like_url(tweet_id: str) -> str:
    return "https://x.com/intent/like?" + urlencode({"tweet_id": tweet_id})


def quote_url(text: str, tweet_url: str) -> str:
    # 投稿の末尾にツイートURLを付けると、X上では引用ポストとして表示される
    return "https://x.com/intent/post?" + urlencode({"text": text, "url": tweet_url}, quote_via=quote)


def profile_url(handle: str) -> str:
    return f"https://x.com/{handle}"


def search_url(query: str) -> str:
    return "https://x.com/search?" + urlencode({"q": query, "f": "live"}, quote_via=quote)
