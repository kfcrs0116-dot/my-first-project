import random
from datetime import datetime
from urllib.parse import parse_qs, urlparse

import pytest

from kensho import intents, quote, safety
from kensho.app import create_app
from kensho.fetcher import FetchError, Tweet, parse_oembed_html
from kensho.parser import parse_campaign, parse_tweet_url

NOW = datetime(2026, 11, 16, 12, 0)

INSTANT = """＼その場で当たる／
フォロー＆リポストで抽選で100名様に
Amazonギフト券1,000円分をプレゼント🎁

【応募方法】
①@brand_official をフォロー
②このポストをリポスト
結果はすぐにリプライで届きます！

〆切：11/30 23:59
当選者にはDMでご連絡いたします
#プレゼントキャンペーン"""

QUOTE = """🎉新発売記念キャンペーン🎉
抽選で50名様に新商品セットをプレゼント！

▼応募方法
1. @juice_jp をフォロー
2. #白桃ジュースで当てよう をつけて引用リポスト

期間：2026年11月16日〜2026年12月5日"""

THEME = """プレゼントキャンペーン実施中！
@snack_co をフォロー＆好きな味を教えて #スナック祭り をつけて引用リポストで応募完了
抽選で10名様 12/1まで"""

MULTI_FOLLOW = """W当選チャンス！抽選で3名様にプレゼント
以下のアカウントをフォロー
@aaa_official
@bbb_store
このポストにいいね＆リポストで応募完了"""

REPLY_REQUIRED = """抽選で5名様にプレゼント！
@ccc をフォローしてこのポストにリプライで応募完了"""

LINE_REQUIRED = """その場で当たる！
@ddd をフォローしてLINE友だち追加で応募"""


def test_parse_tweet_url():
    assert parse_tweet_url("https://x.com/brand_official/status/1234567890?s=20") == ("brand_official", "1234567890")
    assert parse_tweet_url("https://twitter.com/a_b/status/99") == ("a_b", "99")
    assert parse_tweet_url("https://example.com/") is None


def test_instant_win():
    r = parse_campaign(INSTANT, organizer="brand_official", now=NOW)
    assert r.is_campaign and r.instant_win and r.supported
    assert r.follow == ["brand_official"]
    assert r.repost and not r.like and not r.quote
    assert r.unsupported == []  # 「DMでご連絡」「リプライで届きます」は応募条件ではない
    assert r.deadline == "2026-11-30T23:59"
    assert r.winners == 100


def test_quote_campaign():
    r = parse_campaign(QUOTE, organizer="juice_jp", now=NOW)
    assert r.supported and r.quote
    assert not r.repost  # 「引用リポスト」は通常のリポストとして数えない
    assert r.quote_hashtags == ["白桃ジュースで当てよう"]
    assert r.follow == ["juice_jp"]
    assert r.deadline == "2026-12-05T23:59"


def test_theme_and_multi_follow():
    r = parse_campaign(THEME, organizer="snack_co", now=NOW)
    assert r.quote and r.theme and r.quote_hashtags == ["スナック祭り"]
    m = parse_campaign(MULTI_FOLLOW, organizer="aaa_official", now=NOW)
    assert m.follow == ["aaa_official", "bbb_store"]
    assert m.like and m.repost and m.supported


def test_unsupported():
    assert not parse_campaign(REPLY_REQUIRED, "ccc", now=NOW).supported
    r = parse_campaign(LINE_REQUIRED, "ddd", now=NOW)
    assert not r.supported and "LINE登録" in r.unsupported
    assert not parse_campaign("今日のランチはカレー", "x", now=NOW).supported


def test_quote_generation_includes_keywords_and_rotates():
    rng = random.Random(0)
    used = []
    for _ in range(8):
        tid, text = quote.build_quote(["白桃ジュースで当てよう"], ["白桃で乾杯"], brand="白桃ジュース【公式】",
                                      recent_template_ids=used[-6:], rng=rng)
        assert "#白桃ジュースで当てよう" in text and "白桃で乾杯" in text
        assert quote.validate_quote(text, ["白桃ジュースで当てよう"], ["白桃で乾杯"]) == []
        assert "【公式】" not in text
        assert tid not in used[-6:]
        used.append(tid)


def test_theme_quote_requires_edit():
    _, text = quote.build_quote(["スナック祭り"], [], theme="好きな味を教えて")
    assert quote.validate_quote(text, ["スナック祭り"], []) == ["お題の回答を入力してください"]


def test_weighted_length():
    assert quote.x_weighted_length("abc") == 3
    assert quote.x_weighted_length("あいう") == 6
    assert quote.x_weighted_length("見て https://x.com/a/status/1") == 4 + 1 + 23
    assert quote.validate_quote("あ" * 130, [], [])  # 長すぎ


def test_safety():
    s = safety.check("当選者は手数料500円をお振込みください", "fake", set(), set())
    assert s.level == "danger"
    assert safety.check(INSTANT, "brand_official", {"brand_official"}, set()).level == "safe"
    assert safety.check(INSTANT, "brand_official", set(), {"brand_official"}).level == "danger"
    u = safety.check(INSTANT, "brand_cp2", set(), set())
    assert u.level == "unknown" and len(u.reasons) == 2


def test_intents():
    q = urlparse(intents.quote_url("こんにちは #タグ", "https://x.com/a/status/1"))
    params = parse_qs(q.query)
    assert params["text"] == ["こんにちは #タグ"] and params["url"] == ["https://x.com/a/status/1"]
    assert intents.follow_url("abc") == "https://x.com/intent/follow?screen_name=abc"


def test_oembed_html():
    html = ('<blockquote class="twitter-tweet"><p lang="ja" dir="ltr">抽選で&amp;当たる<br>'
            '<a href="https://twitter.com/hashtag/x">#x</a></p>&mdash; Brand (@b) <a href="#">Nov</a></blockquote>')
    assert parse_oembed_html(html) == "抽選で&当たる\n#x"


# ---------------- Web アプリ ----------------

@pytest.fixture
def client(tmp_path):
    tweets = {"111": Tweet("111", "juice_jp", "白桃ジュース公式", QUOTE, "https://x.com/juice_jp/status/111"),
              "222": Tweet("222", "ccc", "CCC", REPLY_REQUIRED, "https://x.com/ccc/status/222")}

    def fake_fetch(handle, tid):
        if tid not in tweets:
            raise FetchError("not found")
        return tweets[tid]

    app = create_app(str(tmp_path / "t.db"), fetch=fake_fetch)
    app.config["TESTING"] = True
    return app.test_client(), app.config["DB"]


def test_full_entry_flow(client):
    c, db = client
    assert c.get("/").status_code == 200
    r = c.post("/add", data={"url": "https://x.com/juice_jp/status/111"})
    assert r.status_code == 302
    page = c.get(r.headers["Location"]).get_data(as_text=True)
    assert "引用リポスト" in page and "intent/follow?screen_name=juice_jp" in page
    assert "#白桃ジュースで当てよう" in page

    cid = int(r.headers["Location"].rsplit("/", 1)[1])
    assert c.post(f"/c/{cid}/action", data={"action": "follow", "target": "juice_jp"}).json["complete"] is False
    assert c.post(f"/c/{cid}/action", data={"action": "quote", "target": ""}).json["complete"] is True
    assert db.get_campaign(cid)["status"] == "entered"
    assert db.today_counts() == {"entries": 1, "follows": 1, "total_follows": 1}

    # 重複登録は既存ページへ
    r2 = c.post("/add", data={"url": "https://x.com/juice_jp/status/111"})
    assert r2.headers["Location"].endswith(f"/c/{cid}")
    for path in ("/history", "/follows", "/settings"):
        assert c.get(path).status_code == 200


def test_unsupported_is_skipped_and_hidden(client):
    c, db = client
    r = c.post("/add", data={"url": "https://x.com/ccc/status/222"})
    cid = int(r.headers["Location"].rsplit("/", 1)[1])
    assert db.get_campaign(cid)["status"] == "skipped"
    page = c.get(f"/c/{cid}").get_data(as_text=True)
    assert "intent/follow" not in page and "対象外" in page


def test_fetch_failure_then_manual_text(client):
    c, db = client
    r = c.post("/add", data={"url": "https://x.com/zzz/status/333"})
    assert r.status_code == 200 and "本文を貼り付け" in r.get_data(as_text=True)
    r = c.post("/add", data={"url": "https://x.com/brand_official/status/333", "text": INSTANT})
    cid = int(r.headers["Location"].rsplit("/", 1)[1])
    assert db.get_campaign(cid)["status"] == "new"


def test_daily_limit_blocks(client):
    c, db = client
    db.set_setting("daily_entry_limit", "0")
    r = c.post("/add", data={"url": "https://x.com/juice_jp/status/111"})
    page = c.get(r.headers["Location"]).get_data(as_text=True)
    assert "応募上限" in page and "intent/follow" not in page
