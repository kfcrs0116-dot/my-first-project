"""引用リポスト用の一文をテンプレートから作る（AI不使用・完全無料）。"""
from __future__ import annotations

import random
import re

# {brand} は主催アカウント名。名前が取れない場合は brand なしのテンプレートだけを使う。
TEMPLATES: list[str] = [
    "素敵な企画ありがとうございます、当たったら本当に嬉しいです！",
    "前から気になっていたので、ぜひ参加させてください！",
    "毎回楽しみにしているキャンペーン、今回も応募します！",
    "こんな嬉しいプレゼント、ぜひ当たりますように！",
    "いつも愛用しているので、思わず参加しちゃいました！",
    "見つけた瞬間に応募を決めました、楽しみに待ってます！",
    "家族みんなで楽しめそうなので、ぜひ当てたいです！",
    "ちょうど欲しいと思っていたところなので嬉しい企画です！",
    "ワクワクする企画をありがとうございます、応募しました！",
    "当たったら友達にも自慢したいので、全力で応募します！",
    "{brand}さんのキャンペーン、今回も楽しく参加させていただきます！",
    "{brand}さんの商品が大好きなので、ぜひ当てたいです！",
    "{brand}さん、いつも素敵な企画をありがとうございます！",
    "{brand}さんのファンとして、これは参加するしかないです！",
]

# お題（「好きな〇〇を教えて」など）がある場合は、回答部分を本人が入力する
THEME_PLACEHOLDER = "【ここにお題の回答を入れてください】"
THEME_TEMPLATES: list[str] = [
    THEME_PLACEHOLDER + "です、素敵な企画ありがとうございます！",
    "私は" + THEME_PLACEHOLDER + "が好きです、ぜひ当たりますように！",
    THEME_PLACEHOLDER + "！いつも楽しみにしています！",
]

URL_WEIGHT = 23
MAX_WEIGHT = 280


def x_weighted_length(text: str) -> int:
    """Xの文字数カウント（日本語などは2、英数字は1、URLは23）。上限は280。"""
    total = 0
    for part in re.split(r"(https?://\S+)", text):
        if part.startswith("http"):
            total += URL_WEIGHT
            continue
        for ch in part:
            cp = ord(ch)
            if (cp <= 4351 or 8192 <= cp <= 8205 or 8208 <= cp <= 8223
                    or 8242 <= cp <= 8247):
                total += 1
            else:
                total += 2
    return total


def clean_brand(name: str | None) -> str | None:
    if not name:
        return None
    # 「〇〇【公式】」「〇〇 公式」などの装飾を外す
    name = re.sub(r"[【\[（(].*?[】\]）)]", "", name)
    name = re.sub(r"(公式|official|Official|OFFICIAL)", "", name).strip(" _-・|｜")
    return name[:20] or None


def build_quote(
    hashtags: list[str],
    keywords: list[str],
    brand: str | None = None,
    theme: str | None = None,
    recent_template_ids: list[int] | None = None,
    rng: random.Random | None = None,
) -> tuple[int, str]:
    """(テンプレートID, 引用文) を返す。テーマ用テンプレートのIDは 1000 番台。"""
    rng = rng or random.Random()
    recent = set(recent_template_ids or [])
    brand = clean_brand(brand)

    if theme:
        pool = [(1000 + i, t) for i, t in enumerate(THEME_TEMPLATES)]
    else:
        pool = [(i, t) for i, t in enumerate(TEMPLATES) if brand or "{brand}" not in t]
    fresh = [p for p in pool if p[0] not in recent] or pool
    tid, tmpl = rng.choice(fresh)
    sentence = tmpl.format(brand=brand or "")

    parts = []
    if keywords:
        parts.append("".join(f"{k}！" for k in keywords))
    parts.append(sentence)
    body = "".join(parts)
    tags = " ".join(f"#{t}" for t in hashtags)
    text = f"{body} {tags}".strip() if tags else body
    return tid, text


def validate_quote(text: str, hashtags: list[str], keywords: list[str]) -> list[str]:
    """投稿前チェック。問題があればエラーメッセージのリストを返す。"""
    errors = []
    for t in hashtags:
        if f"#{t}" not in text:
            errors.append(f"指定ハッシュタグ #{t} が入っていません")
    for k in keywords:
        if k not in text:
            errors.append(f"指定キーワード「{k}」が入っていません")
    if THEME_PLACEHOLDER in text:
        errors.append("お題の回答を入力してください")
    # 引用URL（23）＋スペース分を見込む
    if x_weighted_length(text) + URL_WEIGHT + 1 > MAX_WEIGHT:
        errors.append("文字数が多すぎます（全角でおよそ125文字以内にしてください）")
    return errors
