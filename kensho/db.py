"""SQLite によるデータ保存。"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, date

SCHEMA = """
CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id TEXT UNIQUE NOT NULL,
    tweet_url TEXT NOT NULL,
    handle TEXT NOT NULL,
    author_name TEXT,
    text TEXT NOT NULL,
    parsed TEXT NOT NULL,
    quote_text TEXT,
    quote_template_id INTEGER,
    status TEXT NOT NULL DEFAULT 'new',  -- new / entered / skipped / won / lost
    deadline TEXT,
    created_at TEXT NOT NULL,
    entered_at TEXT
);
CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    action TEXT NOT NULL,      -- follow / repost / like / quote
    target TEXT NOT NULL DEFAULT '',
    done_at TEXT NOT NULL,
    UNIQUE(campaign_id, action, target)
);
CREATE TABLE IF NOT EXISTS follows (
    handle TEXT PRIMARY KEY,
    followed_at TEXT NOT NULL,
    last_campaign_id INTEGER,
    unfollowed_at TEXT
);
CREATE TABLE IF NOT EXISTS accounts (
    handle TEXT PRIMARY KEY,   -- 小文字で保存
    list TEXT NOT NULL         -- white / black
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

DEFAULT_SETTINGS = {
    "daily_entry_limit": "20",
    "daily_follow_limit": "30",
    "total_follow_warning": "4000",
    "search_queries": "\n".join([
        '"その場で当たる" (フォロー OR リポスト) -filter:replies',
        '"プレゼントキャンペーン" フォロー リポスト -filter:replies',
        '"抽選で" 名様 フォロー (リポスト OR いいね) -filter:replies',
        '"引用リポスト" キャンペーン 名様 -filter:replies',
    ]),
}


def now_str() -> str:
    return datetime.now().isoformat(timespec="seconds")


class DB:
    def __init__(self, path: str):
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        for k, v in DEFAULT_SETTINGS.items():
            self.conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, v))
        self.conn.commit()

    # ---- settings ----
    def get_setting(self, key: str) -> str:
        row = self.conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else DEFAULT_SETTINGS.get(key, "")

    def get_int(self, key: str) -> int:
        try:
            return int(self.get_setting(key))
        except ValueError:
            return int(DEFAULT_SETTINGS[key])

    def set_setting(self, key: str, value: str) -> None:
        self.conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", (key, value))
        self.conn.commit()

    # ---- accounts (white/black list) ----
    def account_lists(self) -> tuple[set[str], set[str]]:
        white, black = set(), set()
        for r in self.conn.execute("SELECT handle, list FROM accounts"):
            (white if r["list"] == "white" else black).add(r["handle"])
        return white, black

    def set_account(self, handle: str, lst: str | None) -> None:
        h = handle.lstrip("@").lower()
        if lst is None:
            self.conn.execute("DELETE FROM accounts WHERE handle=?", (h,))
        else:
            self.conn.execute("INSERT OR REPLACE INTO accounts(handle, list) VALUES (?, ?)", (h, lst))
        self.conn.commit()

    def replace_accounts(self, lst: str, handles: list[str]) -> None:
        self.conn.execute("DELETE FROM accounts WHERE list=?", (lst,))
        for h in handles:
            h = h.strip().lstrip("@").lower()
            if h:
                self.conn.execute("INSERT OR REPLACE INTO accounts(handle, list) VALUES (?, ?)", (h, lst))
        self.conn.commit()

    # ---- campaigns ----
    def find_campaign_by_tweet(self, tweet_id: str):
        return self.conn.execute("SELECT * FROM campaigns WHERE tweet_id=?", (tweet_id,)).fetchone()

    def add_campaign(self, *, tweet_id, tweet_url, handle, author_name, text, parsed: dict,
                     quote_text, quote_template_id) -> int:
        cur = self.conn.execute(
            """INSERT INTO campaigns(tweet_id, tweet_url, handle, author_name, text, parsed,
               quote_text, quote_template_id, deadline, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (tweet_id, tweet_url, handle, author_name, text, json.dumps(parsed, ensure_ascii=False),
             quote_text, quote_template_id, parsed.get("deadline"), now_str()),
        )
        self.conn.commit()
        return cur.lastrowid

    def get_campaign(self, cid: int):
        return self.conn.execute("SELECT * FROM campaigns WHERE id=?", (cid,)).fetchone()

    def list_campaigns(self, statuses: tuple[str, ...] | None = None, limit: int = 200):
        if statuses:
            q = ",".join("?" * len(statuses))
            return self.conn.execute(
                f"SELECT * FROM campaigns WHERE status IN ({q}) ORDER BY id DESC LIMIT ?",
                (*statuses, limit)).fetchall()
        return self.conn.execute("SELECT * FROM campaigns ORDER BY id DESC LIMIT ?", (limit,)).fetchall()

    def update_quote(self, cid: int, text: str, template_id: int | None) -> None:
        self.conn.execute("UPDATE campaigns SET quote_text=?, quote_template_id=? WHERE id=?",
                          (text, template_id, cid))
        self.conn.commit()

    def set_status(self, cid: int, status: str) -> None:
        if status == "entered":
            self.conn.execute(
                "UPDATE campaigns SET status=?, entered_at=COALESCE(entered_at, ?) WHERE id=?",
                (status, now_str(), cid))
        else:
            self.conn.execute("UPDATE campaigns SET status=? WHERE id=?", (status, cid))
        self.conn.commit()

    def recent_template_ids(self, n: int = 6) -> list[int]:
        rows = self.conn.execute(
            "SELECT quote_template_id FROM campaigns WHERE quote_template_id IS NOT NULL "
            "ORDER BY id DESC LIMIT ?", (n,)).fetchall()
        return [r[0] for r in rows]

    # ---- actions ----
    def record_action(self, cid: int, action: str, target: str = "") -> None:
        self.conn.execute(
            "INSERT OR IGNORE INTO actions(campaign_id, action, target, done_at) VALUES (?,?,?,?)",
            (cid, action, target, now_str()))
        if action == "follow" and target:
            self.conn.execute(
                """INSERT INTO follows(handle, followed_at, last_campaign_id) VALUES (?,?,?)
                   ON CONFLICT(handle) DO UPDATE SET last_campaign_id=excluded.last_campaign_id,
                   unfollowed_at=NULL""",
                (target.lower(), now_str(), cid))
        self.conn.commit()

    def done_actions(self, cid: int) -> set[str]:
        rows = self.conn.execute("SELECT action, target FROM actions WHERE campaign_id=?", (cid,))
        return {f"{r['action']}:{r['target']}" for r in rows}

    # ---- counters ----
    def today_counts(self) -> dict:
        today = date.today().isoformat()
        entries = self.conn.execute(
            "SELECT COUNT(*) FROM campaigns WHERE entered_at LIKE ?", (today + "%",)).fetchone()[0]
        follows = self.conn.execute(
            "SELECT COUNT(*) FROM actions WHERE action='follow' AND done_at LIKE ?",
            (today + "%",)).fetchone()[0]
        total_follows = self.conn.execute(
            "SELECT COUNT(*) FROM follows WHERE unfollowed_at IS NULL").fetchone()[0]
        return {"entries": entries, "follows": follows, "total_follows": total_follows}

    # ---- follow cleanup ----
    def cleanup_candidates(self, grace_days: int = 14):
        """締切から grace_days 日以上たち、落選（または結果不明）のキャンペーンだけで
        フォローしているアカウント。ホワイトリストのアカウントは除く。"""
        return self.conn.execute(
            """SELECT f.handle, f.followed_at, c.id AS campaign_id, c.deadline, c.status
               FROM follows f JOIN campaigns c ON c.id = f.last_campaign_id
               WHERE f.unfollowed_at IS NULL
                 AND c.status IN ('entered', 'lost')
                 AND c.deadline IS NOT NULL
                 AND julianday('now', 'localtime') - julianday(c.deadline) >= ?
                 AND f.handle NOT IN (SELECT handle FROM accounts WHERE list='white')
               ORDER BY c.deadline""", (grace_days,)).fetchall()

    def mark_unfollowed(self, handle: str) -> None:
        self.conn.execute("UPDATE follows SET unfollowed_at=? WHERE handle=?", (now_str(), handle.lower()))
        self.conn.commit()
