import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTweetUrl, parseCampaign, buildQuote, validateQuote, weightedLength,
  checkSafety, intents, parseOembedHtml, cleanBrand, buildSearchQuery, extractQuoteRequirements, mentionedHandles,
} from "../web/logic.js";

const NOW = new Date(2026, 10, 16, 12, 0);

const INSTANT = `＼その場で当たる／
フォロー＆リポストで抽選で100名様に
Amazonギフト券1,000円分をプレゼント🎁

【応募方法】
①@brand_official をフォロー
②このポストをリポスト
結果はすぐにリプライで届きます！

〆切：11/30 23:59
当選者にはDMでご連絡いたします
#プレゼントキャンペーン`;

const QUOTE = `🎉新発売記念キャンペーン🎉
抽選で50名様に新商品セットをプレゼント！

▼応募方法
1. @juice_jp をフォロー
2. ＃白桃ジュースで当てよう をつけて引用リポスト

期間：2026年11月16日〜2026年12月5日`;

const THEME = `プレゼントキャンペーン実施中！
@snack_co をフォロー＆好きな味を教えて #スナック祭り をつけて引用リポストで応募完了
抽選で10名様 12/1まで`;

const MULTI_FOLLOW = `W当選チャンス！抽選で3名様にプレゼント
以下のアカウントをフォロー
@aaa_official
@bbb_store
このポストにいいね＆リポストで応募完了`;

test("tweet URL", () => {
  assert.deepEqual(parseTweetUrl("https://x.com/brand_official/status/1234567890?s=20"), { handle: "brand_official", tweetId: "1234567890" });
  assert.deepEqual(parseTweetUrl("見て https://twitter.com/a_b/status/99"), { handle: "a_b", tweetId: "99" });
  assert.equal(parseTweetUrl("https://example.com/"), null);
});

test("instant win campaign", () => {
  const r = parseCampaign(INSTANT, "brand_official", NOW);
  assert.ok(r.isCampaign && r.instantWin && r.supported);
  assert.deepEqual(r.follow, ["brand_official"]);
  assert.ok(r.repost && !r.like && !r.quote);
  assert.deepEqual(r.unsupported, []); // 当選連絡のDM・結果リプライは応募条件ではない
  assert.equal(r.deadline, "2026-11-30T23:59");
  assert.equal(r.winners, 100);
});

test("quote campaign with full-width hashtag", () => {
  const r = parseCampaign(QUOTE, "juice_jp", NOW);
  assert.ok(r.supported && r.quote && !r.repost);
  assert.deepEqual(r.quoteHashtags, ["白桃ジュースで当てよう"]);
  assert.deepEqual(r.follow, ["juice_jp"]);
  assert.equal(r.deadline, "2026-12-05T23:59");
});

test("theme and multiple follows", () => {
  const t = parseCampaign(THEME, "snack_co", NOW);
  assert.ok(t.quote && t.theme);
  assert.deepEqual(t.quoteHashtags, ["スナック祭り"]);
  assert.equal(t.deadline, "2026-12-01T23:59");
  const m = parseCampaign(MULTI_FOLLOW, "aaa_official", NOW);
  assert.deepEqual(m.follow, ["aaa_official", "bbb_store"]);
  assert.ok(m.like && m.repost && m.supported);
});

test("unsupported conditions", () => {
  assert.equal(parseCampaign("抽選で5名様にプレゼント！\n@ccc をフォローしてこのポストにリプライで応募完了", "ccc", NOW).supported, false);
  const line = parseCampaign("その場で当たる！\n@ddd をフォローしてLINE友だち追加で応募", "ddd", NOW);
  assert.ok(!line.supported && line.unsupported.includes("LINE登録"));
  assert.equal(parseCampaign("今日のランチはカレー", "x", NOW).supported, false);
  assert.equal(parseCampaign("抽選で1名様！フォロー&RTで応募。購入不要です", "x", NOW).supported, true);
});

test("year rollover for January deadline", () => {
  assert.equal(parseCampaign("抽選で10名様 フォロー&RT 1/10まで", "x", NOW).deadline, "2027-01-10T23:59");
});

test("quote generation includes keywords and rotates templates", () => {
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const used = [];
  for (let i = 0; i < 8; i++) {
    const { templateId, text } = buildQuote({ hashtags: ["白桃ジュースで当てよう"], keywords: ["白桃で乾杯"], brand: "白桃ジュース【公式】", recentIds: used.slice(-6), random });
    assert.ok(text.includes("#白桃ジュースで当てよう") && text.includes("白桃で乾杯"));
    assert.ok(!text.includes("【公式】"));
    assert.deepEqual(validateQuote(text, ["白桃ジュースで当てよう"], ["白桃で乾杯"]), []);
    assert.ok(!used.slice(-6).includes(templateId));
    used.push(templateId);
  }
  assert.equal(cleanBrand("Snack Official"), "Snack");
});

test("theme quote requires the user's answer", () => {
  const { text } = buildQuote({ hashtags: ["スナック祭り"], theme: "好きな味を教えて" });
  assert.deepEqual(validateQuote(text, ["スナック祭り"], []), ["お題の回答を入力してください"]);
});

test("weighted length", () => {
  assert.equal(weightedLength("abc"), 3);
  assert.equal(weightedLength("あいう"), 6);
  assert.equal(weightedLength("見て https://x.com/a/status/1"), 4 + 1 + 23);
  assert.ok(validateQuote("あ".repeat(130)).length > 0);
});

test("safety", () => {
  assert.equal(checkSafety("当選者は手数料500円をお振込みください", "fake").level, "danger");
  assert.equal(checkSafety(INSTANT, "Brand_Official", ["brand_official"]).level, "safe");
  assert.equal(checkSafety(INSTANT, "brand_official", [], ["brand_official"]).level, "danger");
  const u = checkSafety(INSTANT, "brand_cp2");
  assert.equal(u.level, "unknown");
  assert.equal(u.reasons.length, 2);
  assert.equal(checkSafety(INSTANT, "juice_jp").reasons.length, 1);
});

test("intents", () => {
  const u = new URL(intents.quote("こんにちは #タグ & more", "https://x.com/a/status/1"));
  assert.equal(u.searchParams.get("text"), "こんにちは #タグ & more");
  assert.equal(u.searchParams.get("url"), "https://x.com/a/status/1");
  assert.equal(intents.follow("abc"), "https://x.com/intent/follow?screen_name=abc");
});

test("oEmbed html", () => {
  const html = '<blockquote class="twitter-tweet"><p lang="ja" dir="ltr">抽選で&amp;当たる<br><a href="https://twitter.com/hashtag/x">#x</a> &#127873;</p>&mdash; Brand (@b) <a href="#">Nov</a></blockquote>';
  assert.equal(parseOembedHtml(html), "抽選で&当たる\n#x 🎁");
});

test("combined search query", () => {
  const q = buildSearchQuery({
    keywords: ["その場で当たる", "プレゼントキャンペーン", " "], required: ["フォロー", "RT"],
    exclude: "-filter:replies", sinceDays: 7, now: NOW,
  });
  assert.equal(q, '("その場で当たる" OR "プレゼントキャンペーン") ("フォロー" OR RT) -filter:replies since:2026-11-09');
  assert.equal(buildSearchQuery({ keywords: ["抽選で"] }), '"抽選で"');
});

// ---- 実際の懸賞ツイート（ユーザー提供のスクリーンショットより） ----
const FENNEL = `FENNEL HOTELAVA
THANK YOU GIVEAWAY

この1年間、FENNEL HOTELAVAを応援してくださった皆さまへ。

感謝の気持ちを込めて、以下の2点をセットで抽選で2名様にプレゼント

◼️ お好きなカラコン 左右各1箱
◼️ Nintendo Switch 2

【応募方法】
① 本ポストをリポスト
② @hotelloversjp、@FENNEL_official をフォロー

【応募期限】
11/20（金）23:59まで`;

const LAWSON = `盛りすぎ！チャレンジキャンペーン♪

① @akiko_lawson をフォロー✨
② この投稿に「ローソン盛りすぎチャレンジ」とコメントを付けて引用ポスト
③ 抽選で1名様にQUOカードPay1万円分が当たる🎁`;

const TOSHIBA = `📢ご応募は　東芝ライフスタイル公式 Instagramから！

新発売の単機能レンジ
「WarM(ウォーム)」
プレゼントキャンペーン開催!

キャンペーン詳細・応募はこちら↓`;

test("real: two accounts to follow", () => {
  const r = parseCampaign(FENNEL, "FENNEL_official", NOW);
  assert.ok(r.supported && r.repost && !r.quote);
  assert.deepEqual(r.follow, ["hotelloversjp", "FENNEL_official"]);
  assert.equal(r.deadline, "2026-11-20T23:59");
});

test("real: quote with required phrase「〇〇」とコメント", () => {
  const r = parseCampaign(LAWSON, "akiko_lawson", NOW);
  assert.ok(r.supported && r.quote && !r.repost);
  assert.deepEqual(r.follow, ["akiko_lawson"]);
  assert.deepEqual(r.quoteKeywords, ["ローソン盛りすぎチャレンジ"]);
  assert.equal(r.theme, null);
  const { text } = buildQuote({ hashtags: r.quoteHashtags, keywords: r.quoteKeywords, brand: "ローソン" });
  assert.ok(text.startsWith("ローソン盛りすぎチャレンジ！"));
  assert.deepEqual(validateQuote(text, r.quoteHashtags, r.quoteKeywords), []);
});

test("real: Instagram entry is unsupported", () => {
  const r = parseCampaign(TOSHIBA, "toshiba_life", NOW);
  assert.ok(!r.supported);
  assert.ok(r.unsupported[0].includes("Instagram"));
});

test("quote requirement variants", () => {
  assert.deepEqual(extractQuoteRequirements("「#推し活」を付けて引用してね").quoteHashtags, ["推し活"]);
  assert.deepEqual(extractQuoteRequirements("「当たれ！」と入れて引用リポスト").quoteKeywords, ["当たれ!"]);
  const t = extractQuoteRequirements("あなたの「推しフレーバー」をコメントして引用RT #祭り");
  assert.deepEqual(t.quoteKeywords, []); // 「〇〇」をコメント はお題
  assert.ok(t.theme);
  assert.deepEqual(t.quoteHashtags, ["祭り"]);
  assert.deepEqual(extractQuoteRequirements("「いいね」と「リポスト」をして、引用で「最高」とひとこと").quoteKeywords, ["最高"]);
  assert.deepEqual(mentionedHandles(FENNEL), ["hotelloversjp", "FENNEL_official"]);
});
