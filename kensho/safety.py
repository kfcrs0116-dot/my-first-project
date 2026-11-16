"""偽アカウント・詐欺キャンペーンの簡易チェック（完全無料・APIなし）。"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

SCAM_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("手数料・送料の支払いを求めている", re.compile(r"手数料|送料.{0,6}(負担|お支払|支払)|振込|振り込")),
    ("口座・カード情報を求めている", re.compile(r"口座|カード番号|暗証番号|クレジットカード")),
    ("DMやLINEで受け取りを促している", re.compile(r"(DM|LINE).{0,8}(受け取|受取|受け付け|お受け)")),
    ("外部サイトでの受け取りを促している", re.compile(r"(サイト|リンク|URL).{0,8}(受け取|受取|登録して|入力)")),
    ("「全員当選」「必ず当たる」など過剰な表現", re.compile(r"全員当選|全員に|必ず当た|100%当")),
]

LOOKALIKE_RE = re.compile(r"(campaign|present|kenshou|kensho|cp|gift)_?\d*$", re.IGNORECASE)


@dataclass
class SafetyResult:
    level: str = "unknown"  # "safe" / "unknown" / "danger"
    reasons: list[str] = field(default_factory=list)


def check(text: str, handle: str, whitelist: set[str], blacklist: set[str]) -> SafetyResult:
    h = handle.lower()
    res = SafetyResult()
    if h in blacklist:
        res.level = "danger"
        res.reasons.append("ブラックリストに登録されたアカウントです")
        return res
    for label, pat in SCAM_PATTERNS:
        if pat.search(text):
            res.reasons.append(label)
    if res.reasons:
        res.level = "danger"
        return res
    if h in whitelist:
        res.level = "safe"
        res.reasons.append("ホワイトリストに登録された公式アカウントです")
        return res
    res.level = "unknown"
    res.reasons.append("未確認のアカウントです。プロフィールで認証マーク・フォロワー数・公式サイトを確認してください")
    if LOOKALIKE_RE.search(h):
        res.reasons.append("ID末尾が「キャンペーン専用」を装う偽アカウントによくあるパターンです（なりすましに注意）")
    return res
