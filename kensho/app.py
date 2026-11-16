"""懸賞応募アシスタントの Web アプリ（Flask）。"""
from __future__ import annotations

import json
import os
from datetime import datetime

from flask import Flask, abort, flash, jsonify, redirect, render_template, request, url_for

from . import intents, quote, safety
from .db import DB
from .fetcher import FetchError, Tweet, fetch_tweet
from .parser import parse_campaign, parse_tweet_url

STATUS_LABELS = {
    "new": "未応募", "entered": "応募済", "skipped": "スキップ", "won": "当選", "lost": "落選",
}


def required_actions(c, parsed: dict) -> list[tuple[str, str]]:
    acts = [("follow", h.lower()) for h in parsed.get("follow", [])]
    if parsed.get("repost"):
        acts.append(("repost", ""))
    if parsed.get("like"):
        acts.append(("like", ""))
    if parsed.get("quote"):
        acts.append(("quote", ""))
    return acts


def create_app(db_path: str | None = None, fetch=fetch_tweet) -> Flask:
    app = Flask(__name__)
    app.secret_key = os.environ.get("KENSHO_SECRET", "local-only")
    db = DB(db_path or os.environ.get("KENSHO_DB", "kensho.db"))
    app.config["DB"] = db

    @app.context_processor
    def inject():
        return {"counts": db.today_counts(), "STATUS_LABELS": STATUS_LABELS,
                "limits": {"entries": db.get_int("daily_entry_limit"),
                           "follows": db.get_int("daily_follow_limit"),
                           "total_follow_warning": db.get_int("total_follow_warning")}}

    def make_quote(parsed: dict, author_name: str | None) -> tuple[int | None, str | None]:
        if not parsed.get("quote"):
            return None, None
        return quote.build_quote(parsed["quote_hashtags"], parsed["quote_keywords"],
                                 brand=author_name, theme=parsed.get("theme"),
                                 recent_template_ids=db.recent_template_ids())

    # ---------- トップ ----------
    @app.get("/")
    def index(prefill_url: str = "", show_text: bool = False):
        queries = [q for q in db.get_setting("search_queries").splitlines() if q.strip()]
        searches = [(q, intents.search_url(q)) for q in queries]
        pending = db.list_campaigns(("new",), limit=50)
        return render_template("index.html", searches=searches, pending=pending,
                               prefill_url=prefill_url, show_text=show_text,
                               parsed_of=lambda c: json.loads(c["parsed"]))

    @app.post("/add")
    def add():
        url = request.form.get("url", "").strip()
        manual_text = request.form.get("text", "").strip()
        ids = parse_tweet_url(url)
        if not ids:
            flash("ツイートのURLを貼り付けてください（例：https://x.com/xxx/status/123...）", "error")
            return redirect(url_for("index"))
        handle, tweet_id = ids
        existing = db.find_campaign_by_tweet(tweet_id)
        if existing:
            flash("このツイートは登録済みです", "info")
            return redirect(url_for("campaign", cid=existing["id"]))

        if manual_text:
            tw = Tweet(tweet_id, handle, None, manual_text, f"https://x.com/{handle}/status/{tweet_id}")
        else:
            try:
                tw = fetch(handle, tweet_id)
            except FetchError as e:
                flash(f"{e}。ツイート本文をコピーして「本文を貼り付け」欄に入れてください。", "error")
                return index(prefill_url=url, show_text=True)

        parsed = parse_campaign(tw.text, organizer=tw.handle).to_dict()
        tid, qtext = make_quote(parsed, tw.author_name)
        cid = db.add_campaign(tweet_id=tw.tweet_id, tweet_url=tw.url, handle=tw.handle,
                              author_name=tw.author_name, text=tw.text, parsed=parsed,
                              quote_text=qtext, quote_template_id=tid)
        if not parsed["supported"]:
            db.set_status(cid, "skipped")
        return redirect(url_for("campaign", cid=cid))

    # ---------- キャンペーン詳細 ----------
    @app.get("/c/<int:cid>")
    def campaign(cid: int):
        c = db.get_campaign(cid) or abort(404)
        parsed = json.loads(c["parsed"])
        white, black = db.account_lists()
        safe = safety.check(c["text"], c["handle"], white, black)
        done = db.done_actions(cid)
        counts = db.today_counts()

        quote_errors = []
        if parsed.get("quote"):
            quote_errors = quote.validate_quote(c["quote_text"] or "", parsed["quote_hashtags"],
                                                parsed["quote_keywords"])
        expired = bool(c["deadline"] and c["deadline"] < datetime.now().isoformat(timespec="minutes"))

        blockers = []
        if not parsed.get("supported"):
            blockers.append("このキャンペーンは対象外です（フォロー・リポスト・いいね・引用以外の条件があるか、懸賞ではありません）")
        if safe.level == "danger":
            blockers.append("危険なキャンペーンの可能性があるため応募ボタンを表示しません")
        if expired:
            blockers.append("締切を過ぎています")
        if c["status"] == "new" and counts["entries"] >= db.get_int("daily_entry_limit"):
            blockers.append("今日の応募上限に達しました。凍結防止のため明日にしましょう")

        follow_over = (counts["follows"] + len([h for h in parsed.get("follow", [])
                                                if f"follow:{h.lower()}" not in done])
                       > db.get_int("daily_follow_limit"))

        buttons = []
        for h in parsed.get("follow", []):
            buttons.append({"action": "follow", "target": h.lower(), "label": f"@{h} をフォロー",
                            "url": intents.follow_url(h), "disabled": follow_over})
        if parsed.get("repost"):
            buttons.append({"action": "repost", "target": "", "label": "リポスト",
                            "url": intents.repost_url(c["tweet_id"]), "disabled": False})
        if parsed.get("like"):
            buttons.append({"action": "like", "target": "", "label": "いいね",
                            "url": intents.like_url(c["tweet_id"]), "disabled": False})
        if parsed.get("quote"):
            buttons.append({"action": "quote", "target": "", "label": "引用リポスト",
                            "url": intents.quote_url(c["quote_text"] or "", c["tweet_url"]),
                            "disabled": bool(quote_errors)})
        for b in buttons:
            b["done"] = f"{b['action']}:{b['target']}" in done

        return render_template("campaign.html", c=c, p=parsed, safe=safe, buttons=buttons,
                               blockers=blockers, quote_errors=quote_errors, follow_over=follow_over,
                               profile_url=intents.profile_url(c["handle"]),
                               quote_len=quote.x_weighted_length(c["quote_text"] or ""))

    @app.post("/c/<int:cid>/action")
    def action(cid: int):
        c = db.get_campaign(cid) or abort(404)
        act = request.form.get("action", "")
        target = request.form.get("target", "").lower()
        if act not in ("follow", "repost", "like", "quote"):
            abort(400)
        db.record_action(cid, act, target)
        parsed = json.loads(c["parsed"])
        done = db.done_actions(cid)
        complete = all(f"{a}:{t}" in done for a, t in required_actions(c, parsed))
        if complete and c["status"] == "new":
            db.set_status(cid, "entered")
        return jsonify({"ok": True, "complete": complete})

    @app.post("/c/<int:cid>/quote")
    def save_quote(cid: int):
        c = db.get_campaign(cid) or abort(404)
        if request.form.get("regen"):
            parsed = json.loads(c["parsed"])
            tid, text = make_quote(parsed, c["author_name"])
            db.update_quote(cid, text, tid)
        else:
            db.update_quote(cid, request.form.get("quote_text", "").strip(), c["quote_template_id"])
        return redirect(url_for("campaign", cid=cid) + "#quote")

    @app.post("/c/<int:cid>/status")
    def set_status(cid: int):
        db.get_campaign(cid) or abort(404)
        st = request.form.get("status")
        if st not in STATUS_LABELS:
            abort(400)
        db.set_status(cid, st)
        return redirect(request.form.get("next") or url_for("campaign", cid=cid))

    @app.post("/c/<int:cid>/account")
    def set_account(cid: int):
        c = db.get_campaign(cid) or abort(404)
        lst = request.form.get("list")
        db.set_account(c["handle"], lst if lst in ("white", "black") else None)
        if lst == "black":
            db.set_status(cid, "skipped")
        return redirect(url_for("campaign", cid=cid))

    # ---------- 履歴 ----------
    @app.get("/history")
    def history():
        st = request.args.get("status")
        rows = db.list_campaigns((st,) if st in STATUS_LABELS else None, limit=500)
        return render_template("history.html", rows=rows, current=st,
                               parsed_of=lambda c: json.loads(c["parsed"]))

    # ---------- フォロー整理 ----------
    @app.get("/follows")
    def follows():
        rows = db.cleanup_candidates()
        return render_template("follows.html", rows=rows, profile_url=intents.profile_url)

    @app.post("/follows/<handle>/unfollowed")
    def unfollowed(handle: str):
        db.mark_unfollowed(handle)
        return redirect(url_for("follows"))

    # ---------- 設定 ----------
    @app.route("/settings", methods=["GET", "POST"])
    def settings():
        if request.method == "POST":
            for key in ("daily_entry_limit", "daily_follow_limit", "total_follow_warning"):
                val = request.form.get(key, "").strip()
                if val.isdigit():
                    db.set_setting(key, val)
            db.set_setting("search_queries", request.form.get("search_queries", "").strip())
            db.replace_accounts("white", request.form.get("whitelist", "").split())
            db.replace_accounts("black", request.form.get("blacklist", "").split())
            flash("保存しました", "info")
            return redirect(url_for("settings"))
        white, black = db.account_lists()
        return render_template("settings.html", s={
            k: db.get_setting(k) for k in
            ("daily_entry_limit", "daily_follow_limit", "total_follow_warning", "search_queries")},
            whitelist="\n".join(sorted(white)), blacklist="\n".join(sorted(black)))

    return app
