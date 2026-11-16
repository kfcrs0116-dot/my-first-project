// 懸賞ツイートの解析・引用文生成・安全チェック・X Intent URL（DOMに依存しない純粋関数）
// ブラウザでもNode.js（テスト）でも動く。

// ---------------- URL ----------------
export const TWEET_URL_RE = /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/;

export function parseTweetUrl(s) {
  const m = TWEET_URL_RE.exec(s || "");
  return m ? { handle: m[1], tweetId: m[2] } : null;
}

// ---------------- 条件解析 ----------------
const HANDLE_RE = /@([A-Za-z0-9_]{1,15})/g;
const HASHTAG_RE = /#([^\s#@、。!?「」()]+)/g;

const CAMPAIGN_WORDS = ["その場で当", "プレゼントキャンペーン", "キャンペーン", "抽選で", "名様", "プレゼント", "当選"];
const INSTANT_WIN_WORDS = ["その場で", "即時", "すぐに結果", "インスタントウィン", "インスタントウイン"];
const NOTICE_LINE_RE = /当選.*(連絡|お知らせ|通知|送付|発表)|(連絡|お知らせ|通知)いたします/;

const UNSUPPORTED = [
  ["リプライ（返信）での応募", /(リプライ|リプ|返信)(して|で応募|で参加|を送|をし|をつけ|を付け|をお願い)|(この|本)(ポスト|ツイート|投稿)に(リプ|返信|コメント)/],
  ["DMでの応募", /DM(を送|で応募|して|で参加)/],
  ["LINE登録", /LINE.{0,6}(登録|友だち|友達|追加)/],
  ["アプリのダウンロード", /アプリ.{0,6}(ダウンロード|DL|インストール)/],
  ["外部フォーム・アンケート", /応募フォーム|フォームから|フォームより|アンケート.{0,4}回答/],
  ["購入・レシート応募", /レシート|購入(して|者|いただ|された|の上)|対象商品を購入/],
  ["会員登録", /会員登録/],
];

const QUOTE_RE = /引用(RT|リツイート|リポスト|ポスト|して|で)?/gi;
const REPOST_RE = /RT|リツイート|リポスト|repost/i;
const PLAIN_KEYWORD_RE = /[「『]([^」』]{1,30})[」』](と|を)(入れ|書い|つけ|付け|含め|添え|記載)/g;
const THEME_RE = /(教えて|お答え|回答して|コメントして|聞かせて)/;
const DATE_FULL_RE = /(20\d{2})[/年.\-](\d{1,2})[/月.\-](\d{1,2})日?/g;
const DATE_MD_RE = /(\d{1,2})[/月](\d{1,2})日?/g;
const TIME_RE = /(\d{1,2}):(\d{2})/;
const WINNERS_RE = /(\d[\d,]*)\s*名(様)?/;

const pad = (n) => String(n).padStart(2, "0");
export const localIso = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function unique(arr) {
  const seen = new Set();
  return arr.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function dateWithTime(text, pos, y, mo, d) {
  let h = 23, mi = 59;
  const tm = TIME_RE.exec(text.slice(pos, pos + 15));
  if (tm) {
    h = +tm[1]; mi = +tm[2];
    if (h >= 24) { h = 23; mi = 59; }
  }
  const dt = new Date(y, mo - 1, d, h, mi);
  if (dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return localIso(dt);
}

function parseDeadline(text, now) {
  const found = [];
  for (const m of text.matchAll(DATE_FULL_RE)) {
    found.push(dateWithTime(text, m.index + m[0].length, +m[1], +m[2], +m[3]));
  }
  const stripped = text.replace(DATE_FULL_RE, (s) => " ".repeat(s.length));
  for (const m of stripped.matchAll(DATE_MD_RE)) {
    const before = stripped[m.index - 1] || "";
    const after = stripped[m.index + m[0].length] || "";
    if (/[\d/]/.test(before) || /[\d/]/.test(after)) continue;
    const mo = +m[1], d = +m[2];
    let y = now.getFullYear();
    if (mo < now.getMonth() + 1 - 1) y += 1; // 2か月以上前の月なら翌年
    found.push(dateWithTime(stripped, m.index + m[0].length, y, mo, d));
  }
  const valid = found.filter(Boolean).sort();
  return valid.length ? valid[valid.length - 1] : null;
}

export function parseCampaign(rawText, organizer = null, now = new Date()) {
  const text = (rawText || "").normalize("NFKC");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const entryLines = lines.filter((l) => !NOTICE_LINE_RE.test(l));
  const entryText = entryLines.join("\n");

  const r = {
    isCampaign: CAMPAIGN_WORDS.some((w) => text.includes(w)),
    instantWin: INSTANT_WIN_WORDS.some((w) => text.includes(w)),
    follow: [], repost: false, like: false, quote: false,
    quoteHashtags: [], quoteKeywords: [], theme: null,
    unsupported: [], deadline: null, prize: null, winners: null,
  };

  const cleaned = entryText.replaceAll("購入不要", "");
  for (const [label, re] of UNSUPPORTED) if (re.test(cleaned)) r.unsupported.push(label);

  r.quote = new RegExp(QUOTE_RE.source, "i").test(entryText);
  r.repost = REPOST_RE.test(entryText.replace(QUOTE_RE, ""));
  r.like = entryText.includes("いいね");

  if (entryText.includes("フォロー")) {
    let handles = [];
    entryLines.forEach((ln, i) => {
      if (!ln.includes("フォロー")) return;
      handles.push(...[...ln.matchAll(HANDLE_RE)].map((m) => m[1]));
      // 「以下のアカウントをフォロー」の次行以降に @だけの行が続くケース
      for (const nxt of entryLines.slice(i + 1)) {
        if (nxt.replace(HANDLE_RE, "").replace(/[\s・\-、,①②③④⑤]/g, "") === "") {
          handles.push(...[...nxt.matchAll(HANDLE_RE)].map((m) => m[1]));
        } else break;
      }
    });
    if (organizer && (!handles.length || /(当|この|公式|弊社)アカウント/.test(entryText))) {
      handles.unshift(organizer);
    }
    r.follow = unique(handles);
  }

  if (r.quote) {
    const tagLines = entryLines.filter((l) => /引用|つけて|付けて|を付け|をつけ|入れて|ハッシュタグ/.test(l));
    let tags = tagLines.flatMap((l) => [...l.matchAll(HASHTAG_RE)].map((m) => m[1]));
    if (!tags.length) tags = [...text.matchAll(HASHTAG_RE)].map((m) => m[1]);
    r.quoteHashtags = unique(tags);
    r.quoteKeywords = unique([...text.matchAll(PLAIN_KEYWORD_RE)].map((m) => m[1]));
    const themeLine = entryLines.find((l) => THEME_RE.test(l));
    if (themeLine) r.theme = themeLine.slice(0, 80);
  }

  r.deadline = parseDeadline(text, now);
  const w = WINNERS_RE.exec(text);
  if (w) r.winners = parseInt(w[1].replace(/,/g, ""), 10);
  const prizeLine = lines.find((l) => /名様|円分|ギフト|プレゼント/.test(l) && !l.startsWith("#"));
  if (prizeLine) r.prize = prizeLine.slice(0, 80);

  r.supported = r.isCampaign && (r.follow.length > 0 || r.repost || r.like || r.quote) && r.unsupported.length === 0;
  return r;
}

// ---------------- 引用文 ----------------
export const TEMPLATES = [
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
];
export const THEME_PLACEHOLDER = "【ここにお題の回答を入れてください】";
const THEME_TEMPLATES = [
  THEME_PLACEHOLDER + "です、素敵な企画ありがとうございます！",
  "私は" + THEME_PLACEHOLDER + "が好きです、ぜひ当たりますように！",
  THEME_PLACEHOLDER + "！いつも楽しみにしています！",
];
const URL_WEIGHT = 23;
const MAX_WEIGHT = 280;

/** Xの文字数カウント（日本語などは2、英数字は1、URLは23）。上限280。 */
export function weightedLength(text) {
  let total = 0;
  for (const part of (text || "").split(/(https?:\/\/\S+)/)) {
    if (/^https?:\/\//.test(part)) { total += URL_WEIGHT; continue; }
    for (const ch of part) {
      const cp = ch.codePointAt(0);
      total += (cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247)) ? 1 : 2;
    }
  }
  return total;
}

export function cleanBrand(name) {
  if (!name) return null;
  const s = name.replace(/[【\[（(].*?[】\]）)]/g, "").replace(/公式|official/gi, "").replace(/^[\s_\-・|｜]+|[\s_\-・|｜]+$/g, "");
  return s.slice(0, 20) || null;
}

/** {templateId, text} を返す。お題用テンプレートのIDは1000番台。 */
export function buildQuote({ hashtags = [], keywords = [], brand = null, theme = null, recentIds = [], random = Math.random }) {
  const b = cleanBrand(brand);
  const pool = theme
    ? THEME_TEMPLATES.map((t, i) => [1000 + i, t])
    : TEMPLATES.map((t, i) => [i, t]).filter(([, t]) => b || !t.includes("{brand}"));
  const fresh = pool.filter(([id]) => !recentIds.includes(id));
  const choices = fresh.length ? fresh : pool;
  const [templateId, tmpl] = choices[Math.floor(random() * choices.length)];
  const body = keywords.map((k) => `${k}！`).join("") + tmpl.replaceAll("{brand}", b || "");
  const tags = hashtags.map((t) => `#${t}`).join(" ");
  return { templateId, text: tags ? `${body} ${tags}` : body };
}

export function validateQuote(text, hashtags = [], keywords = []) {
  const errors = [];
  for (const t of hashtags) if (!text.includes(`#${t}`)) errors.push(`指定ハッシュタグ #${t} が入っていません`);
  for (const k of keywords) if (!text.includes(k)) errors.push(`指定キーワード「${k}」が入っていません`);
  if (text.includes(THEME_PLACEHOLDER)) errors.push("お題の回答を入力してください");
  if (!text.trim()) errors.push("引用文が空です");
  if (weightedLength(text) + URL_WEIGHT + 1 > MAX_WEIGHT) errors.push("文字数が多すぎます（全角でおよそ125文字以内にしてください）");
  return errors;
}

// ---------------- 安全チェック ----------------
const SCAM_PATTERNS = [
  ["手数料・送料の支払いを求めている", /手数料|送料.{0,6}(負担|お支払|支払)|振込|振り込/],
  ["口座・カード情報を求めている", /口座|カード番号|暗証番号|クレジットカード/],
  ["DMやLINEで受け取りを促している", /(DM|LINE).{0,8}(受け取|受取|受け付け|お受け)/],
  ["外部サイトでの受け取りを促している", /(サイト|リンク|URL).{0,8}(受け取|受取|登録して|入力)/],
  ["「全員当選」「必ず当たる」など過剰な表現", /全員当選|全員に|必ず当た|100%当/],
];
const LOOKALIKE_RE = /(campaign|present|kenshou|kensho|cp|gift)_?\d*$/i;

export function checkSafety(text, handle, whitelist = [], blacklist = []) {
  const h = (handle || "").toLowerCase();
  const t = (text || "").normalize("NFKC");
  if (blacklist.includes(h)) return { level: "danger", reasons: ["ブラックリストに登録されたアカウントです"] };
  const reasons = SCAM_PATTERNS.filter(([, re]) => re.test(t)).map(([label]) => label);
  if (reasons.length) return { level: "danger", reasons };
  if (whitelist.includes(h)) return { level: "safe", reasons: ["公式として登録済みのアカウントです"] };
  const r = { level: "unknown", reasons: ["未確認のアカウントです。プロフィールで認証マーク・フォロワー数・公式サイトを確認してください"] };
  if (LOOKALIKE_RE.test(h)) r.reasons.push("ID末尾が「キャンペーン専用」を装う偽アカウントによくあるパターンです（なりすましに注意）");
  return r;
}

// ---------------- X Web Intent ----------------
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
export const intents = {
  follow: (handle) => `https://x.com/intent/follow?${qs({ screen_name: handle })}`,
  repost: (id) => `https://x.com/intent/retweet?${qs({ tweet_id: id })}`,
  like: (id) => `https://x.com/intent/like?${qs({ tweet_id: id })}`,
  quote: (text, url) => `https://x.com/intent/post?${qs({ text, url })}`,
  profile: (handle) => `https://x.com/${handle}`,
  search: (q) => `https://x.com/search?${qs({ q, f: "live" })}`,
};

// ---------------- oEmbed ----------------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—" };
export function parseOembedHtml(html) {
  const m = /<p[^>]*>([\s\S]*?)<\/p>/.exec(html || "");
  return (m ? m[1] : html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (s, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? s;
    })
    .trim();
}
