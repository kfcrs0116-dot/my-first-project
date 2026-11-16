"""懸賞ツイートの応募条件をルールベースで解析する（AI不使用・完全無料）。"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field, asdict
from datetime import datetime

TWEET_URL_RE = re.compile(
    r"https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/([A-Za-z0-9_]{1,15})/status(?:es)?/(\d+)"
)
HANDLE_RE = re.compile(r"@([A-Za-z0-9_]{1,15})")
HASHTAG_RE = re.compile(r"#([^\s#@、。！!？?「」()（）]+)")

CAMPAIGN_WORDS = [
    "その場で当たる", "その場で当", "プレゼントキャンペーン", "キャンペーン",
    "抽選で", "名様", "プレゼント", "当選",
]
INSTANT_WIN_WORDS = ["その場で", "即時", "すぐに結果", "インスタントウィン", "インスタントウイン"]

# 当選連絡など「応募方法ではない」行を判定する
NOTICE_LINE_RE = re.compile(r"当選.*(連絡|お知らせ|通知|送付|発表)|(連絡|お知らせ|通知)いたします")

# フォロー・RT・いいね・引用以外の応募条件（＝このツールの対象外）
UNSUPPORTED_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("リプライ（返信）での応募", re.compile(
        r"(リプライ|リプ|返信)(して|で応募|で参加|を送|をし|をつけ|を付け|をお願い)"
        r"|(この|本)(ポスト|ツイート|投稿)に(リプ|返信|コメント)")),
    ("DMでの応募", re.compile(r"DM(を送|で応募|して|で参加)")),
    ("LINE登録", re.compile(r"LINE.{0,6}(登録|友だち|友達|追加)")),
    ("アプリのダウンロード", re.compile(r"アプリ.{0,6}(ダウンロード|DL|インストール)")),
    ("外部フォーム・アンケート", re.compile(r"応募フォーム|フォームから|フォームより|アンケート.{0,4}回答")),
    ("購入・レシート応募", re.compile(r"レシート|購入(して|者|いただ|された|の上)|対象商品を購入")),
    ("会員登録", re.compile(r"会員登録")),
]

QUOTE_RE = re.compile(r"引用(RT|リツイート|リポスト|ポスト|して|で)?", re.IGNORECASE)
REPOST_RE = re.compile(r"RT|リツイート|リポスト|repost", re.IGNORECASE)
PLAIN_KEYWORD_RE = re.compile(r"[「『]([^」』]{1,30})[」』](と|を)(入れ|書い|つけ|付け|含め|添え|記載)")
THEME_RE = re.compile(r"(教えて|お答え|回答して|コメントして|聞かせて)")

DATE_FULL_RE = re.compile(r"(20\d{2})[/年.\-](\d{1,2})[/月.\-](\d{1,2})日?")
DATE_MD_RE = re.compile(r"(?<![\d/])(\d{1,2})[/月](\d{1,2})日?(?![\d/])")
TIME_RE = re.compile(r"(\d{1,2})[:：](\d{2})")
WINNERS_RE = re.compile(r"(\d[\d,]*)\s*名(様)?")


@dataclass
class ParseResult:
    is_campaign: bool = False
    instant_win: bool = False
    follow: list[str] = field(default_factory=list)
    repost: bool = False
    like: bool = False
    quote: bool = False
    quote_hashtags: list[str] = field(default_factory=list)
    quote_keywords: list[str] = field(default_factory=list)
    theme: str | None = None
    unsupported: list[str] = field(default_factory=list)
    deadline: str | None = None  # ISO形式
    prize: str | None = None
    winners: int | None = None

    @property
    def supported(self) -> bool:
        has_action = bool(self.follow) or self.repost or self.like or self.quote
        return self.is_campaign and has_action and not self.unsupported

    def to_dict(self) -> dict:
        d = asdict(self)
        d["supported"] = self.supported
        return d


def normalize(text: str) -> str:
    """全角英数・記号（＃＠：など）を半角に揃える。"""
    return unicodedata.normalize("NFKC", text)


def parse_tweet_url(url: str) -> tuple[str, str] | None:
    m = TWEET_URL_RE.search(url.strip())
    return (m.group(1), m.group(2)) if m else None


def _unique(items):
    seen, out = set(), []
    for x in items:
        key = x.lower()
        if key not in seen:
            seen.add(key)
            out.append(x)
    return out


def _parse_deadline(text: str, now: datetime) -> str | None:
    candidates: list[datetime] = []
    for m in DATE_FULL_RE.finditer(text):
        y, mo, d = map(int, m.groups())
        candidates.append(_with_time(text, m.end(), y, mo, d))
    stripped = DATE_FULL_RE.sub(" ", text)
    for m in DATE_MD_RE.finditer(stripped):
        mo, d = map(int, m.groups())
        y = now.year
        # 2か月以上前の月なら翌年とみなす（年末年始のキャンペーン対策）
        if mo < now.month - 1:
            y += 1
        candidates.append(_with_time(stripped, m.end(), y, mo, d))
    candidates = [c for c in candidates if c is not None]
    return max(candidates).isoformat(timespec="minutes") if candidates else None


def _with_time(text: str, pos: int, y: int, mo: int, d: int) -> datetime | None:
    h, mi = 23, 59
    tm = TIME_RE.search(text[pos:pos + 15])
    if tm:
        h, mi = int(tm.group(1)), int(tm.group(2))
        if h == 24:
            h, mi = 23, 59
    try:
        return datetime(y, mo, d, h, mi)
    except ValueError:
        return None


def parse_campaign(text: str, organizer: str | None = None, now: datetime | None = None) -> ParseResult:
    now = now or datetime.now()
    text = normalize(text)
    r = ParseResult()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    entry_lines = [ln for ln in lines if not NOTICE_LINE_RE.search(ln)]
    entry_text = "\n".join(entry_lines)

    r.is_campaign = any(w in text for w in CAMPAIGN_WORDS)
    r.instant_win = any(w in text for w in INSTANT_WIN_WORDS)

    # --- 対象外の条件 ---
    cleaned = entry_text.replace("購入不要", "")
    for label, pat in UNSUPPORTED_PATTERNS:
        if pat.search(cleaned):
            r.unsupported.append(label)

    # --- 引用 / リポスト / いいね ---
    r.quote = bool(QUOTE_RE.search(entry_text))
    without_quote = QUOTE_RE.sub("", entry_text)
    r.repost = bool(REPOST_RE.search(without_quote))
    r.like = "いいね" in entry_text

    # --- フォロー ---
    if "フォロー" in entry_text:
        handles: list[str] = []
        for i, ln in enumerate(entry_lines):
            if "フォロー" in ln:
                handles += HANDLE_RE.findall(ln)
                # 「以下のアカウントをフォロー」の次行以降に @だけの行が続くケース
                for nxt in entry_lines[i + 1:]:
                    if HANDLE_RE.sub("", nxt).strip(" ・-、,①②③④⑤") == "":
                        handles += HANDLE_RE.findall(nxt)
                    else:
                        break
        if organizer and (not handles or re.search(r"(当|この|公式|弊社)アカウント", entry_text)):
            handles.insert(0, organizer)
        r.follow = _unique(handles)

    # --- 引用時に必要なキーワード ---
    if r.quote:
        tag_lines = [ln for ln in entry_lines
                     if re.search(r"引用|つけて|付けて|を付け|をつけ|入れて|ハッシュタグ", ln)]
        tags = [t for ln in tag_lines for t in HASHTAG_RE.findall(ln)]
        if not tags:
            tags = HASHTAG_RE.findall(text)
        r.quote_hashtags = _unique(tags)
        r.quote_keywords = _unique([m[0] for m in PLAIN_KEYWORD_RE.findall(text)])
        for ln in entry_lines:
            if THEME_RE.search(ln):
                r.theme = ln[:80]
                break

    # --- 締切・賞品・当選者数 ---
    r.deadline = _parse_deadline(text, now)
    m = WINNERS_RE.search(text)
    if m:
        r.winners = int(m.group(1).replace(",", ""))
    for ln in lines:
        if re.search(r"名様|円分|ギフト|プレゼント", ln) and not ln.startswith("#"):
            r.prize = ln[:80]
            break
    return r
