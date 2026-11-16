// 懸賞応募アシスタント（スマホ用・データは端末内のlocalStorageに保存）
import {
  parseTweetUrl, parseCampaign, buildQuote, validateQuote, weightedLength,
  checkSafety, intents, parseOembedHtml, localIso, buildSearchQuery,
} from "./logic.js";

// ================= 保存 =================
const KEY = "kensho-v1";
const DEFAULT_SETTINGS = {
  dailyEntryLimit: 20, dailyFollowLimit: 30, totalFollowWarning: 4000,
  // 検索：キーワードのどれか ＋ 応募方法ワードのどれか、を1回で検索する
  searchKeywords: ["その場で当たる", "プレゼントキャンペーン", "抽選で", "名様にプレゼント", "キャンペーン実施中"],
  searchRequired: ["フォロー", "リポスト", "RT", "いいね", "引用"],
  searchExclude: "-filter:replies -filter:retweets -レシート",
  searchSinceDays: 7,
};
const STATUS = { new: "未応募", entered: "応募済", skipped: "スキップ", won: "当選", lost: "落選" };

function freshStore() {
  return {
    version: 1, nextId: 1, campaigns: [], follows: {}, whitelist: [], blacklist: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}
let store;
function loadStore(data) {
  const s = { ...freshStore(), ...data };
  s.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) }; // 新しい設定項目を補う
  delete s.settings.searchQueries; // 旧バージョンの設定
  return s;
}
try { store = loadStore(JSON.parse(localStorage.getItem(KEY) || "{}")); } catch { store = freshStore(); }
const searchQuery = () => buildSearchQuery({
  keywords: store.settings.searchKeywords, required: store.settings.searchRequired,
  exclude: store.settings.searchExclude, sinceDays: store.settings.searchSinceDays,
});
const save = () => localStorage.setItem(KEY, JSON.stringify(store));
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

const getC = (id) => store.campaigns.find((c) => c.id === +id);
const today = () => localIso().slice(0, 10);

function counts() {
  const t = today();
  let follows = 0;
  for (const c of store.campaigns) for (const [k, v] of Object.entries(c.actions || {})) if (k.startsWith("follow:") && v.startsWith(t)) follows++;
  return {
    entries: store.campaigns.filter((c) => (c.enteredAt || "").startsWith(t)).length,
    follows,
    totalFollows: Object.values(store.follows).filter((f) => !f.unfollowedAt).length,
  };
}

function requiredKeys(p) {
  const keys = p.follow.map((h) => `follow:${h.toLowerCase()}`);
  if (p.repost) keys.push("repost:");
  if (p.like) keys.push("like:");
  if (p.quote) keys.push("quote:");
  return keys;
}

function setStatus(c, st) {
  c.status = st;
  if (st === "entered" && !c.enteredAt) c.enteredAt = localIso();
  save();
}

function recordAction(c, action, target) {
  const key = `${action}:${target}`;
  c.actions = c.actions || {};
  if (!c.actions[key]) c.actions[key] = localIso();
  if (action === "follow") {
    store.follows[target] = { followedAt: store.follows[target]?.followedAt || localIso(), lastCampaignId: c.id, unfollowedAt: null };
  }
  const complete = requiredKeys(c.parsed).every((k) => c.actions[k]);
  if (complete && c.status === "new") setStatus(c, "entered");
  save();
  return complete;
}

function recentTemplateIds(n = 6) {
  return store.campaigns.filter((c) => c.quoteTemplateId != null).slice(-n).map((c) => c.quoteTemplateId);
}

function makeQuote(p, authorName) {
  if (!p.quote) return { templateId: null, text: null };
  return buildQuote({ hashtags: p.quoteHashtags, keywords: p.quoteKeywords, brand: authorName, theme: p.theme, recentIds: recentTemplateIds() });
}

function addCampaign({ handle, tweetId, authorName, text }) {
  const parsed = parseCampaign(text, handle);
  const q = makeQuote(parsed, authorName);
  const c = {
    id: store.nextId++, tweetId, handle, authorName: authorName || null, text,
    tweetUrl: `https://x.com/${handle}/status/${tweetId}`, parsed,
    quoteText: q.text, quoteTemplateId: q.templateId,
    status: parsed.supported ? "new" : "skipped", deadline: parsed.deadline,
    createdAt: localIso(), enteredAt: null, actions: {},
  };
  store.campaigns.push(c);
  save();
  return c;
}

// ================= ツイート取得（X公開埋め込み・無料） =================
function fetchTweet(handle, tweetId, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const cb = `__oembed_${Date.now()}`;
    const s = document.createElement("script");
    const done = () => { clearTimeout(timer); delete window[cb]; s.remove(); };
    const timer = setTimeout(() => { done(); reject(new Error("timeout")); }, timeoutMs);
    window[cb] = (data) => {
      done();
      const m = /(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/.exec(data?.author_url || "");
      resolve({ handle: m ? m[1] : handle, tweetId, authorName: data?.author_name, text: parseOembedHtml(data?.html) });
    };
    s.onerror = () => { done(); reject(new Error("network")); };
    const url = `https://twitter.com/${handle}/status/${tweetId}`;
    s.src = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=1&lang=ja&dnt=true&callback=${cb}`;
    document.head.appendChild(s);
  });
}

// ================= 描画 =================
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const fmt = (iso) => (iso ? iso.replace("T", " ") : "");
const $app = document.getElementById("app");
let flash = null; // {type, msg}
let homeState = { url: "", showText: false, busy: false };

function header() {
  const k = counts(), s = store.settings;
  const warn = k.totalFollows >= s.totalFollowWarning;
  return `
  <header>
    <a class="brand" href="#/">🎁 懸賞アシスタント</a>
    <nav><a href="#/">ホーム</a><a href="#/history">履歴</a><a href="#/follows">整理</a><a href="#/settings">設定</a></nav>
  </header>
  <div class="counter">今日の応募 <b>${k.entries}</b>/${s.dailyEntryLimit} ・ フォロー <b>${k.follows}</b>/${s.dailyFollowLimit} ・ フォロー中 <b class="${warn ? "warn" : ""}">${k.totalFollows}</b></div>
  <main>
  ${flash ? `<div class="flash ${flash.type}">${esc(flash.msg)}</div>` : ""}
  ${warn ? `<div class="flash error">フォロー数が多くなっています。「整理」から終了したキャンペーンのアカウントを解除しましょう。</div>` : ""}`;
}

function viewHome() {
  const pending = store.campaigns.filter((c) => c.status === "new").reverse();
  return `
  <section class="card">
    <h2>① 懸賞ツイートを探す</h2>
    <a class="btn big" href="${esc(intents.search(searchQuery()))}" target="_blank" rel="noopener">🔍 懸賞ツイートをまとめて検索</a>
    <p class="note">登録したキーワード（${esc(store.settings.searchKeywords.join("・"))}）のどれかを含む、直近${store.settings.searchSinceDays}日の懸賞ツイートを新しい順に表示します。
      気になるツイートで「共有 → リンクをコピー」してください。キーワードは「設定」で変更できます。</p>
  </section>
  <section class="card">
    <h2>② URLを貼り付けて解析</h2>
    <form id="add-form">
      <div class="row nowrap">
        <input type="url" name="url" placeholder="https://x.com/xxxx/status/123..." value="${esc(homeState.url)}" required>
        <button type="button" class="btn secondary" data-act="paste">貼付</button>
      </div>
      <details ${homeState.showText ? "open" : ""}>
        <summary>本文を貼り付け（自動取得できなかったとき）</summary>
        <textarea name="text" rows="6" placeholder="ツイート本文をそのまま貼り付け"></textarea>
      </details>
      <button class="btn" type="submit" ${homeState.busy ? "disabled" : ""}>${homeState.busy ? "取得中…" : "解析する"}</button>
    </form>
  </section>
  <section class="card">
    <h2>③ 応募待ち</h2>
    ${pending.length ? "" : `<p class="note">応募待ちのキャンペーンはありません。</p>`}
    <ul class="list">${pending.map((c) => `
      <li><a href="#/c/${c.id}"><b>@${esc(c.handle)}</b>
        ${c.parsed.instantWin ? `<span class="tag hot">その場で当たる</span>` : ""}
        <span class="sub">${esc(c.parsed.prize || c.text.slice(0, 40))}</span>
        ${c.deadline ? `<span class="sub">締切 ${esc(fmt(c.deadline))}</span>` : ""}</a></li>`).join("")}
    </ul>
  </section>`;
}

function viewCampaign(c) {
  const p = c.parsed, s = store.settings, k = counts();
  const safe = checkSafety(c.text, c.handle, store.whitelist, store.blacklist);
  const expired = c.deadline && c.deadline < localIso();
  const blockers = [];
  if (!p.supported) blockers.push("このキャンペーンは対象外です（フォロー・リポスト・いいね・引用以外の条件があるか、懸賞ではありません）");
  if (safe.level === "danger") blockers.push("危険なキャンペーンの可能性があるため応募ボタンを表示しません");
  if (expired) blockers.push("締切を過ぎています");
  if (c.status === "new" && k.entries >= s.dailyEntryLimit) blockers.push("今日の応募上限に達しました。凍結防止のため明日にしましょう");

  const act = c.actions || {};
  const newFollows = p.follow.filter((h) => !act[`follow:${h.toLowerCase()}`]).length;
  const followOver = k.follows + newFollows > s.dailyFollowLimit;
  const quoteErrors = p.quote ? validateQuote(c.quoteText || "", p.quoteHashtags, p.quoteKeywords) : [];

  const buttons = [
    ...p.follow.map((h) => ({ action: "follow", target: h.toLowerCase(), label: `@${h} をフォロー`, url: intents.follow(h), disabled: followOver })),
    ...(p.repost ? [{ action: "repost", target: "", label: "リポスト", url: intents.repost(c.tweetId) }] : []),
    ...(p.like ? [{ action: "like", target: "", label: "いいね", url: intents.like(c.tweetId) }] : []),
    ...(p.quote ? [{ action: "quote", target: "", label: "引用リポスト", url: intents.quote(c.quoteText || "", c.tweetUrl), disabled: quoteErrors.length > 0, id: "quote-btn" }] : []),
  ];
  const yes = (b, a = "必要", n = "不要") => (b ? a : n);
  const levelLabel = { safe: "✅ 公式（登録済み）", danger: "⛔ 危険", unknown: "⚠️ 要確認" }[safe.level];

  return `
  <section class="card">
    <h2>@${esc(c.handle)} ${c.authorName ? `<span class="sub">${esc(c.authorName)}</span>` : ""}<span class="tag">${STATUS[c.status]}</span></h2>
    <pre class="tweet">${esc(c.text)}</pre>
    <a href="${esc(c.tweetUrl)}" target="_blank" rel="noopener">元のツイートを開く</a>
  </section>

  <section class="card safety ${safe.level}">
    <h3>アカウントの安全チェック：${levelLabel}</h3>
    <ul>${safe.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
    <div class="row">
      <a class="btn secondary" href="${esc(intents.profile(c.handle))}" target="_blank" rel="noopener">プロフィールを確認</a>
      <button class="btn secondary" data-act="white">公式として登録</button>
      <button class="btn danger" data-act="black">ブラックリストへ</button>
    </div>
  </section>

  <section class="card">
    <h3>応募条件（自動解析）</h3>
    <table class="kv">
      <tr><th>その場で当たる</th><td>${yes(p.instantWin, "はい", "いいえ")}</td></tr>
      <tr><th>フォロー</th><td>${p.follow.length ? esc("@" + p.follow.join(", @")) : "なし"}</td></tr>
      <tr><th>リポスト</th><td>${yes(p.repost)}</td></tr>
      <tr><th>いいね</th><td>${yes(p.like)}</td></tr>
      <tr><th>引用</th><td>${yes(p.quote)}</td></tr>
      ${p.quote ? `
      <tr><th>指定ハッシュタグ</th><td>${p.quoteHashtags.length ? esc("#" + p.quoteHashtags.join(" #")) : "なし"}</td></tr>
      <tr><th>指定キーワード</th><td>${esc(p.quoteKeywords.join("、")) || "なし"}</td></tr>
      ${p.theme ? `<tr><th>お題</th><td>${esc(p.theme)}</td></tr>` : ""}` : ""}
      <tr><th>締切</th><td>${c.deadline ? esc(fmt(c.deadline)) : "不明（本文で確認）"}</td></tr>
      <tr><th>賞品</th><td>${esc(p.prize || "不明")}${p.winners ? `（${p.winners}名）` : ""}</td></tr>
      ${p.unsupported.length ? `<tr><th>対象外の条件</th><td class="warn">${esc(p.unsupported.join("、"))}</td></tr>` : ""}
    </table>
    <p class="note">自動解析は完璧ではありません。応募前に元ツイートの条件と見比べてください。</p>
  </section>

  ${p.quote && !blockers.length ? `
  <section class="card">
    <h3>引用文</h3>
    <textarea id="quote-text" rows="3">${esc(c.quoteText || "")}</textarea>
    <div class="note" id="quote-len">文字数カウント：${weightedLength(c.quoteText || "")} / 約256</div>
    <div id="quote-errors">${quoteErrors.map((e) => `<div class="flash error">${esc(e)}</div>`).join("")}</div>
    <button class="btn secondary" data-act="regen">別の文を作る</button>
  </section>` : ""}

  <section class="card">
    <h3>応募する</h3>
    ${blockers.map((b) => `<div class="flash error">${esc(b)}</div>`).join("")}
    ${blockers.length ? "" : `
      <p class="note">上から順にタップ → Xの画面で確定してください。全部押すと自動で「応募済」になります。</p>
      ${followOver ? `<div class="flash error">今日のフォロー上限を超えるため、フォローボタンを止めています。</div>` : ""}
      <div class="actions">${buttons.map((b) => {
        const done = act[`${b.action}:${b.target}`];
        return `<a class="btn action ${done ? "done" : ""} ${b.disabled ? "disabled" : ""}" ${b.id ? `id="${b.id}"` : ""}
          href="${esc(b.url)}" target="_blank" rel="noopener" data-action="${b.action}" data-target="${esc(b.target)}">${done ? "✓ " : ""}${esc(b.label)}</a>`;
      }).join("")}</div>`}
    <div class="row">
      ${c.status === "new" ? `<button class="btn secondary" data-act="status" data-v="entered">応募済にする</button>
                              <button class="btn secondary" data-act="status" data-v="skipped">スキップ</button>` : ""}
      ${["entered", "won", "lost"].includes(c.status) ? `<button class="btn secondary" data-act="status" data-v="won">🎉 当選</button>
                              <button class="btn secondary" data-act="status" data-v="lost">落選</button>` : ""}
      ${c.status === "skipped" ? `<button class="btn secondary" data-act="status" data-v="new">応募待ちに戻す</button>` : ""}
      <button class="btn danger" data-act="delete">削除</button>
    </div>
  </section>`;
}

function viewHistory(filter) {
  const rows = store.campaigns.filter((c) => !filter || c.status === filter).reverse();
  return `
  <section class="card">
    <h2>応募履歴</h2>
    <div class="row">
      <a class="btn secondary ${!filter ? "active" : ""}" href="#/history">すべて</a>
      ${Object.entries(STATUS).map(([k, v]) => `<a class="btn secondary ${filter === k ? "active" : ""}" href="#/history/${k}">${v}</a>`).join("")}
    </div>
    <table class="grid">
      <tr><th>主催</th><th>賞品</th><th>締切</th><th>状態</th></tr>
      ${rows.map((c) => `<tr>
        <td><a href="#/c/${c.id}">@${esc(c.handle)}</a></td>
        <td>${esc((c.parsed.prize || c.text).slice(0, 24))}</td>
        <td>${esc(c.deadline ? fmt(c.deadline).slice(5, 10) : "-")}</td>
        <td><span class="tag ${c.status}">${STATUS[c.status]}</span></td></tr>`).join("")}
    </table>
  </section>`;
}

function cleanupCandidates(graceDays = 14) {
  const limit = new Date(Date.now() - graceDays * 864e5);
  const limitIso = localIso(limit);
  return Object.entries(store.follows)
    .filter(([h, f]) => !f.unfollowedAt && !store.whitelist.includes(h))
    .map(([h, f]) => ({ handle: h, c: getC(f.lastCampaignId) }))
    .filter(({ c }) => c && ["entered", "lost"].includes(c.status) && c.deadline && c.deadline <= limitIso)
    .sort((a, b) => a.c.deadline.localeCompare(b.c.deadline));
}

function viewFollows() {
  const rows = cleanupCandidates();
  return `
  <section class="card">
    <h2>フォロー整理</h2>
    <p class="note">締切から14日以上たち、当選していないキャンペーンでフォローしたアカウントです（公式として登録したアカウントは除外）。
      当選連絡はDMで届くことが多いので、発表前には解除しないでください。<br>
      一括の自動解除は規約違反のため、プロフィールを開いて1件ずつ解除し、「解除した」を押してください。</p>
    ${rows.length ? "" : `<p class="note">整理候補はありません。</p>`}
    <table class="grid">${rows.map(({ handle, c }) => `<tr>
      <td><a href="${esc(intents.profile(handle))}" target="_blank" rel="noopener">@${esc(handle)}</a></td>
      <td>締切 ${esc(c.deadline.slice(0, 10))}</td>
      <td><button class="btn secondary" data-act="unfollowed" data-h="${esc(handle)}">解除した</button></td></tr>`).join("")}
    </table>
  </section>`;
}

function viewSettings() {
  const s = store.settings;
  return `
  <section class="card">
    <h2>設定</h2>
    <form id="settings-form">
      <h3>凍結防止の上限</h3>
      <label>1日の応募数の上限 <input type="number" name="dailyEntryLimit" value="${s.dailyEntryLimit}" min="1"></label>
      <label>1日のフォロー数の上限 <input type="number" name="dailyFollowLimit" value="${s.dailyFollowLimit}" min="1"></label>
      <label>フォロー総数の警告ライン <input type="number" name="totalFollowWarning" value="${s.totalFollowWarning}" min="1"></label>
      <h3>まとめて検索の条件</h3>
      <label>キーワード（1行に1つ・どれかを含む）<textarea name="searchKeywords" rows="5">${esc(s.searchKeywords.join("\n"))}</textarea></label>
      <label>応募方法ワード（1行に1つ・どれかを含む。空なら条件なし）<textarea name="searchRequired" rows="3">${esc(s.searchRequired.join("\n"))}</textarea></label>
      <label>除外・追加条件 <input type="text" name="searchExclude" value="${esc(s.searchExclude)}"></label>
      <p class="note">例：<code>-filter:replies</code>（返信を除く）、<code>filter:verified</code>（認証済みのみ）、<code>-LINE</code>（LINEを含むものを除く）</p>
      <label>何日前までのツイートを探すか <input type="number" name="searchSinceDays" value="${s.searchSinceDays}" min="0"></label>
      <p class="note">検索内容：<code>${esc(searchQuery())}</code></p>
      <h3>公式アカウント（ホワイトリスト）</h3>
      <p class="note">@なしのIDを1行に1つ。</p>
      <textarea name="whitelist" rows="4">${esc(store.whitelist.join("\n"))}</textarea>
      <h3>ブラックリスト</h3>
      <textarea name="blacklist" rows="3">${esc(store.blacklist.join("\n"))}</textarea>
      <button class="btn" type="submit">保存</button>
    </form>
  </section>
  <section class="card">
    <h2>バックアップ</h2>
    <p class="note">データはこのスマホのブラウザ内だけに保存されています。機種変更やブラウザのデータ削除に備えて、ときどき書き出してください。</p>
    <button class="btn secondary" data-act="export">データを書き出す</button>
    <label class="btn secondary">データを読み込む<input type="file" accept="application/json" id="import-file" hidden></label>
  </section>`;
}

function render() {
  const [, page, arg] = (location.hash || "#/").split("/");
  let body;
  if (page === "c" && getC(arg)) body = viewCampaign(getC(arg));
  else if (page === "history") body = viewHistory(arg);
  else if (page === "follows") body = viewFollows();
  else if (page === "settings") body = viewSettings();
  else body = viewHome();
  $app.innerHTML = header() + body + "</main>";
  flash = null;
}

function go(hash, msg) {
  if (msg) flash = msg;
  if (location.hash === hash) render(); else location.hash = hash;
}

// ================= 操作 =================
async function handleAdd(url, text) {
  const ids = parseTweetUrl(url);
  if (!ids) return go("#/", { type: "error", msg: "ツイートのURLを貼り付けてください（例：https://x.com/xxx/status/123...）" });
  const exist = store.campaigns.find((c) => c.tweetId === ids.tweetId);
  if (exist) return go(`#/c/${exist.id}`, { type: "info", msg: "このツイートは登録済みです" });

  if (text && text.trim()) return go(`#/c/${addCampaign({ ...ids, text: text.trim() }).id}`);
  homeState = { url, showText: false, busy: true };
  render();
  try {
    const tw = await fetchTweet(ids.handle, ids.tweetId);
    homeState = { url: "", showText: false, busy: false };
    go(`#/c/${addCampaign(tw).id}`);
  } catch {
    homeState = { url, showText: true, busy: false };
    go("#/", { type: "error", msg: "ツイートを自動取得できませんでした。本文をコピーして「本文を貼り付け」欄に入れ、もう一度「解析する」を押してください。" });
  }
}

document.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (e.target.id === "add-form") handleAdd(f.get("url"), f.get("text"));
  if (e.target.id === "settings-form") {
    const num = (k) => Math.max(1, parseInt(f.get(k), 10) || store.settings[k]);
    const lines = (k) => String(f.get(k) || "").split("\n").map((q) => q.trim()).filter(Boolean);
    const list = (k) => [...new Set(String(f.get(k)).split(/\s+/).map((h) => h.replace(/^@/, "").toLowerCase()).filter(Boolean))];
    store.settings = {
      dailyEntryLimit: num("dailyEntryLimit"), dailyFollowLimit: num("dailyFollowLimit"), totalFollowWarning: num("totalFollowWarning"),
      searchKeywords: lines("searchKeywords"),
      searchRequired: lines("searchRequired"),
      searchExclude: String(f.get("searchExclude") || "").trim(),
      searchSinceDays: Math.max(0, parseInt(f.get("searchSinceDays"), 10) || 0),
    };
    store.whitelist = list("whitelist");
    store.blacklist = list("blacklist");
    save();
    go("#/settings", { type: "info", msg: "保存しました" });
  }
});

document.addEventListener("click", async (e) => {
  const a = e.target.closest("a.action");
  if (a) {
    if (a.classList.contains("disabled")) { e.preventDefault(); return; }
    const c = getC(location.hash.split("/")[2]);
    const complete = recordAction(c, a.dataset.action, a.dataset.target);
    a.classList.add("done");
    if (!a.textContent.trim().startsWith("✓")) a.textContent = "✓ " + a.textContent.trim();
    if (complete) setTimeout(render, 1500);
    return; // リンクはそのまま開く
  }
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const c = getC(location.hash.split("/")[2]);
  switch (b.dataset.act) {
    case "paste":
      try {
        const t = await navigator.clipboard.readText();
        const ids = parseTweetUrl(t);
        document.querySelector('input[name="url"]').value = ids ? `https://x.com/${ids.handle}/status/${ids.tweetId}` : t;
      } catch { alert("クリップボードを読み取れませんでした。入力欄を長押しして貼り付けてください。"); }
      break;
    case "status": setStatus(c, b.dataset.v); render(); break;
    case "regen": {
      const q = makeQuote(c.parsed, c.authorName);
      c.quoteText = q.text; c.quoteTemplateId = q.templateId; save(); render(); break;
    }
    case "white":
    case "black": {
      const h = c.handle.toLowerCase();
      store.whitelist = store.whitelist.filter((x) => x !== h);
      store.blacklist = store.blacklist.filter((x) => x !== h);
      (b.dataset.act === "white" ? store.whitelist : store.blacklist).push(h);
      if (b.dataset.act === "black" && c.status === "new") c.status = "skipped";
      save(); render(); break;
    }
    case "delete":
      if (confirm("このキャンペーンを削除しますか？")) {
        store.campaigns = store.campaigns.filter((x) => x.id !== c.id); save(); go("#/");
      }
      break;
    case "unfollowed":
      store.follows[b.dataset.h].unfollowedAt = localIso(); save(); render(); break;
    case "export": {
      const blob = new Blob([JSON.stringify(store, null, 1)], { type: "application/json" });
      const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `kensho-backup-${today()}.json` });
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      break;
    }
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id !== "quote-text") return;
  const c = getC(location.hash.split("/")[2]);
  c.quoteText = e.target.value;
  save();
  const errs = validateQuote(c.quoteText, c.parsed.quoteHashtags, c.parsed.quoteKeywords);
  document.getElementById("quote-len").textContent = `文字数カウント：${weightedLength(c.quoteText)} / 約256`;
  document.getElementById("quote-errors").innerHTML = errs.map((x) => `<div class="flash error">${esc(x)}</div>`).join("");
  const btn = document.getElementById("quote-btn");
  if (btn) {
    btn.href = intents.quote(c.quoteText, c.tweetUrl);
    btn.classList.toggle("disabled", errs.length > 0);
  }
});

document.addEventListener("change", async (e) => {
  if (e.target.id !== "import-file" || !e.target.files[0]) return;
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (!Array.isArray(data.campaigns)) throw new Error();
    if (!confirm(`${data.campaigns.length}件のデータで上書きします。よろしいですか？`)) return;
    store = loadStore(data); save();
    go("#/", { type: "info", msg: "読み込みました" });
  } catch { alert("バックアップファイルを読み込めませんでした"); }
});

window.addEventListener("hashchange", render);

// Androidの「共有」からURLを受け取る（ホーム画面に追加した場合）
const params = new URLSearchParams(location.search);
const shared = [params.get("url"), params.get("text"), params.get("title")].filter(Boolean).join(" ");
if (shared) {
  history.replaceState(null, "", location.pathname + location.hash);
  const ids = parseTweetUrl(shared);
  if (ids) handleAdd(`https://x.com/${ids.handle}/status/${ids.tweetId}`, "");
  else render();
} else {
  render();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
