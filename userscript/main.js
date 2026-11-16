// ===== 懸賞応募アシスタント（X上で動くユーザースクリプト本体） =====
// logic.js の関数（parseCampaign, buildQuote など）はビルド時に同じスコープへ結合される。
// 画面に表示されたツイートを読み取り、懸賞ならボタンを付ける。
// ボタンを押したときだけ、そのツイート1件に必要な操作を順番に行う（勝手には動かない）。

const KEY = "kensho-us-v1";
const DEFAULTS = {
  dailyEntryLimit: 20,
  dailyFollowLimit: 30,
  searchKeywords: ["その場で当たる", "プレゼントキャンペーン", "抽選で", "名様にプレゼント", "キャンペーン実施中"],
  searchRequired: ["フォロー", "リポスト", "RT", "いいね", "引用"],
  searchExclude: "-filter:replies -filter:retweets -レシート",
  searchSinceDays: 7,
};

// ---------------- 保存 ----------------
function load() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { /* 壊れていたら初期化 */ }
  return {
    settings: { ...DEFAULTS, ...(s.settings || {}) },
    entries: s.entries || {},          // tweetId -> {at, handle, actions:{follow:..., like:...}}
    followLog: s.followLog || [],      // フォローした日時（1日の上限用）
    recentTemplateIds: s.recentTemplateIds || [],
  };
}
let state = load();
function save() {
  // 60日より古い記録は削除
  const limit = localIso(new Date(Date.now() - 60 * 864e5));
  for (const [id, e] of Object.entries(state.entries)) if (e.at < limit) delete state.entries[id];
  state.followLog = state.followLog.filter((t) => t >= limit);
  localStorage.setItem(KEY, JSON.stringify(state));
}
const todayStr = () => localIso().slice(0, 10);
const counts = () => ({
  entries: Object.values(state.entries).filter((e) => e.at.startsWith(todayStr())).length,
  follows: state.followLog.filter((t) => t.startsWith(todayStr())).length,
});

// ---------------- DOM ユーティリティ ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanPause = () => sleep(700 + Math.random() * 900); // 操作の間隔をあける
async function waitFor(fn, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}
const $q = (root, sel) => root.querySelector(sel);
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function closeMenu() {
  (document.activeElement || document.body).dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
}
function menuItems() {
  const menu = document.querySelector('[role="menu"]') || document.querySelector('[data-testid="Dropdown"]');
  return menu ? [...menu.querySelectorAll('[role="menuitem"], a[href]')] : [];
}

function toast(msg, ms = 4000) {
  const t = document.createElement("div");
  t.className = "kensho-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ---------------- ツイートの読み取り ----------------
function readTweet(article) {
  const textEl = $q(article, '[data-testid="tweetText"]');
  if (!textEl) return null;
  // 引用されている別ツイートの本文ではなく、このツイート自身の本文
  if (textEl.closest('article[data-testid="tweet"]') !== article) return null;
  const nameBox = $q(article, '[data-testid="User-Name"]');
  const handleLink = nameBox && [...nameBox.querySelectorAll("a[href]")].find((a) => /^\/[A-Za-z0-9_]{1,15}$/.test(a.getAttribute("href")));
  const timeLink = [...article.querySelectorAll('a[href*="/status/"]')].find((a) => a.querySelector("time"));
  // 時刻リンク（/handle/status/123）からツイートID。詳細ページの本文ツイートなどリンクがない場合はURLから
  const m = /\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/.exec(timeLink?.getAttribute("href") || location.pathname);
  const ids = m ? { handle: m[1], tweetId: m[2] } : null;
  if (!handleLink || !ids) return null;
  return {
    handle: handleLink.getAttribute("href").slice(1),
    authorName: nameBox.querySelector("span")?.textContent || null,
    tweetId: ids.tweetId,
    text: textEl.innerText,
    verified: !!$q(nameBox, '[data-testid="icon-verified"]'),
    truncated: !!$q(article, '[data-testid="tweet-text-show-more-link"]'),
  };
}

// ---------------- 応募操作 ----------------
async function doLike(article) {
  if ($q(article, '[data-testid="unlike"]')) return "already";
  const btn = $q(article, '[data-testid="like"]');
  if (!btn) return "fail";
  btn.click();
  return (await waitFor(() => $q(article, '[data-testid="unlike"]'), 3000)) ? "ok" : "fail";
}

async function doRepost(article) {
  if ($q(article, '[data-testid="unretweet"]')) return "already";
  const btn = $q(article, '[data-testid="retweet"]');
  if (!btn) return "fail";
  btn.click();
  const confirm = await waitFor(() => document.querySelector('[data-testid="retweetConfirm"]'));
  if (!confirm) { closeMenu(); return "fail"; }
  confirm.click();
  return (await waitFor(() => $q(article, '[data-testid="unretweet"]'), 3000)) ? "ok" : "fail";
}

async function doFollowAuthor(article, handle) {
  const caret = $q(article, '[data-testid="caret"]');
  if (!caret) return "fail";
  caret.click();
  const items = await waitFor(() => { const m = menuItems(); return m.length ? m : null; });
  if (!items) return "fail";
  // 「@xxxをフォロー」「@xxxのフォローを解除」の項目だけを対象にする（ミュート・リスト追加などは除外）
  const cands = items.filter((el) => /フォロー|Follow/i.test(el.textContent) && !/リスト|List/i.test(el.textContent));
  const target = cands.find((el) => el.textContent.toLowerCase().includes(`@${handle.toLowerCase()}`)) || cands[0];
  if (!target) { closeMenu(); return "fail"; }
  if (/解除|Unfollow/i.test(target.textContent)) { closeMenu(); return "already"; }
  target.click();
  await sleep(500);
  return "ok";
}

async function openQuoteComposer(article, text) {
  const btn = $q(article, '[data-testid="retweet"]') || $q(article, '[data-testid="unretweet"]');
  if (!btn) return "fail";
  btn.click();
  const quoteItem = await waitFor(() => menuItems().find((el) =>
    /compose\/(post|tweet)/.test(el.getAttribute?.("href") || "") || /引用|Quote/.test(el.textContent)));
  if (!quoteItem) { closeMenu(); return "fail"; }
  quoteItem.click();
  const box = await waitFor(() => document.querySelector('[data-testid="tweetTextarea_0"]'), 6000);
  if (!box) return "fail";
  box.focus();
  await sleep(300);
  const inserted = document.execCommand && document.execCommand("insertText", false, text);
  await sleep(200);
  if (!inserted || !box.textContent.includes(text.slice(0, 5))) {
    try { await navigator.clipboard.writeText(text); } catch { /* 無視 */ }
    toast("引用文をコピーしました。入力欄に貼り付けてから「ポスト」を押してください", 6000);
    return "copied";
  }
  return "ok";
}

let pendingQuote = null; // {tweetId}
document.addEventListener("click", (e) => {
  if (!pendingQuote) return;
  if (e.target.closest('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')) {
    const entry = state.entries[pendingQuote.tweetId];
    if (entry) { entry.actions.quote = localIso(); save(); }
    pendingQuote = null;
    toast("引用リポストを記録しました 🎉");
    setTimeout(scan, 1500);
  }
}, true);

const busy = new Set(); // 応募処理中のツイートID（処理中は表示を作り直さない）
const sigOf = (tw) => `${tw.tweetId}:${tw.truncated}:${Object.keys(state.entries[tw.tweetId]?.actions || {}).length}`;

async function enter(article, tw, p, bar) {
  if (busy.has(tw.tweetId)) return;
  busy.add(tw.tweetId);
  try { await enterInner(article, tw, p, bar); } finally {
    bar.dataset.sig = sigOf(tw);
    busy.delete(tw.tweetId);
  }
}

async function enterInner(article, tw, p, bar) {
  const k = counts();
  if (k.entries >= state.settings.dailyEntryLimit && !state.entries[tw.tweetId]) {
    toast("今日の応募上限に達しました。凍結防止のため明日にしましょう"); return;
  }
  const entry = state.entries[tw.tweetId] || (state.entries[tw.tweetId] = { at: localIso(), handle: tw.handle, actions: {} });
  const authorFollow = p.follow.some((h) => h.toLowerCase() === tw.handle.toLowerCase());
  const otherFollows = p.follow.filter((h) => h.toLowerCase() !== tw.handle.toLowerCase());
  if (authorFollow && !entry.actions.follow && k.follows >= state.settings.dailyFollowLimit) {
    toast("今日のフォロー上限に達しました。明日応募しましょう"); return;
  }

  let quoteText = null;
  if (p.quote && !entry.actions.quote) {
    const q = buildQuote({ hashtags: p.quoteHashtags, keywords: p.quoteKeywords, brand: tw.authorName, theme: p.theme, recentIds: state.recentTemplateIds });
    quoteText = q.text;
    if (p.theme) {
      const ans = prompt(`お題：${p.theme}\n\n回答を短く入力してください（引用文に入ります）`);
      if (!ans) { toast("キャンセルしました"); return; }
      quoteText = quoteText.replace(THEME_PLACEHOLDER, ans.trim());
    }
    const errs = validateQuote(quoteText, p.quoteHashtags, p.quoteKeywords);
    if (errs.length) { toast(errs.join(" / ")); return; }
    state.recentTemplateIds = [...state.recentTemplateIds, q.templateId].slice(-6);
  }
  save();

  const status = bar.querySelector(".kensho-steps");
  const btn = bar.querySelector(".kensho-go");
  btn.disabled = true;
  btn.textContent = "応募中…";
  const steps = [];
  const show = () => { status.innerHTML = steps.map((s) => `<span class="kensho-step ${s.r}">${s.r === "ok" || s.r === "already" ? "✓" : s.r === "fail" ? "✗" : "…"} ${escHtml(s.label)}</span>`).join(""); };
  const run = async (key, label, fn) => {
    if (entry.actions[key]) { steps.push({ label, r: "already" }); show(); return; }
    const s = { label, r: "run" }; steps.push(s); show();
    s.r = await fn();
    if (s.r === "ok" || s.r === "already") {
      entry.actions[key] = localIso();
      if (key === "follow" && s.r === "ok") state.followLog.push(localIso());
      save();
    }
    show();
    await humanPause();
  };

  if (authorFollow) await run("follow", `@${tw.handle} をフォロー`, () => doFollowAuthor(article, tw.handle));
  if (p.like) await run("like", "いいね", () => doLike(article));
  if (p.repost) await run("repost", "リポスト", () => doRepost(article));
  if (quoteText) {
    steps.push({ label: "引用（内容を確認して「ポスト」を押してください）", r: "run" }); show();
    const r = await openQuoteComposer(article, quoteText);
    steps[steps.length - 1].r = r === "fail" ? "fail" : "run";
    if (r !== "fail") pendingQuote = { tweetId: tw.tweetId };
    show();
  }

  const failed = steps.filter((s) => s.r === "fail");
  let extra = "";
  if (otherFollows.length) {
    extra += `<div class="kensho-note">ほかのフォロー先（タップして手動でフォロー）：${otherFollows.map((h) =>
      `<a href="${escHtml(intents.follow(h))}" target="_blank" rel="noopener" data-kensho-follow="${escHtml(h)}">@${escHtml(h)}</a>`).join(" ")}</div>`;
  }
  if (failed.length) extra += `<div class="kensho-note warn">✗ の操作は自動でできませんでした。ツイートのボタンから手動で行ってください。</div>`;
  status.insertAdjacentHTML("beforeend", extra);
  btn.textContent = failed.length ? "もう一度試す" : "✓ 応募しました";
  btn.disabled = !failed.length;
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-kensho-follow]");
  if (a) { state.followLog.push(localIso()); save(); }
});

// ---------------- ツイートにボタンを付ける ----------------
function decorate(article) {
  const tw = readTweet(article);
  const old = $q(article, ".kensho-bar");
  if (!tw) { old?.remove(); return; }
  if (busy.has(tw.tweetId) && old) return;
  const sig = sigOf(tw);
  if (old && old.dataset.sig === sig) return;
  old?.remove();

  const p = parseCampaign(tw.text, tw.handle);
  if (!p.isCampaign) return;
  const safe = checkSafety(tw.text, tw.handle);
  const entry = state.entries[tw.tweetId];
  const need = [
    ...p.follow.map((h) => `@${h}フォロー`),
    p.repost && "リポスト", p.like && "いいね", p.quote && "引用",
  ].filter(Boolean);
  const required = [
    ...(p.follow.some((h) => h.toLowerCase() === tw.handle.toLowerCase()) ? ["follow"] : []),
    ...(p.like ? ["like"] : []), ...(p.repost ? ["repost"] : []), ...(p.quote ? ["quote"] : []),
  ];
  const done = entry && required.every((k) => entry.actions[k]);

  const bar = document.createElement("div");
  bar.className = "kensho-bar";
  bar.dataset.sig = sig;
  let html = `<div class="kensho-head">🎁 ${p.instantWin ? "<b>その場で当たる</b> " : ""}懸賞`;
  html += p.deadline ? ` ・ 締切 ${escHtml(p.deadline.replace("T", " "))}` : "";
  html += tw.verified ? ` ・ <span class="kensho-ok">認証マークあり</span>` : ` ・ <span class="kensho-warn">認証マークなし</span>`;
  html += `</div>`;

  if (safe.level === "danger") {
    html += `<div class="kensho-note warn">⛔ 危険の可能性：${escHtml(safe.reasons.join("、"))}</div>`;
  } else if (tw.truncated) {
    html += `<div class="kensho-note">本文が省略されています。全文で条件を確認します。</div><button class="kensho-btn kensho-more">全文を開く</button>`;
  } else if (!p.supported) {
    html += `<div class="kensho-note">対象外：${escHtml(p.unsupported.join("、") || "応募方法を読み取れませんでした")}</div>`;
  } else if (p.deadline && p.deadline < localIso()) {
    html += `<div class="kensho-note">締切を過ぎています</div>`;
  } else {
    html += `<div class="kensho-note">必要：${escHtml(need.join(" ・ "))}${p.quoteHashtags.length ? ` ／ 指定：${escHtml("#" + p.quoteHashtags.join(" #"))}` : ""}</div>`;
    if (!tw.verified && safe.reasons.length > 1) html += `<div class="kensho-note warn">${escHtml(safe.reasons[1])}</div>`;
    html += done
      ? `<button class="kensho-btn kensho-go" disabled>✓ 応募済み</button>`
      : `<button class="kensho-btn kensho-go">応募する</button>`;
    html += `<div class="kensho-steps"></div>`;
  }
  bar.innerHTML = html;
  bar.addEventListener("click", (e) => {
    e.stopPropagation(); // ツイート詳細へ移動しないように
    if (e.target.closest(".kensho-go") && !e.target.disabled) { e.preventDefault(); enter(article, tw, p, bar); }
    if (e.target.closest(".kensho-more")) { e.preventDefault(); $q(article, '[data-testid="tweet-text-show-more-link"]')?.click(); }
  });
  const textEl = $q(article, '[data-testid="tweetText"]');
  textEl.insertAdjacentElement("afterend", bar);
}

let scanTimer = null;
function scan() {
  document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => {
    try { decorate(a); } catch (err) { console.warn("[kensho]", err); }
  });
}
new MutationObserver(() => { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 300); })
  .observe(document.body, { childList: true, subtree: true });

// ---------------- 画面左下の 🎁 メニュー ----------------
function searchQuery() {
  const s = state.settings;
  return buildSearchQuery({ keywords: s.searchKeywords, required: s.searchRequired, exclude: s.searchExclude, sinceDays: s.searchSinceDays });
}
function openPanel() {
  document.querySelector(".kensho-panel")?.remove();
  const k = counts(), s = state.settings;
  const panel = document.createElement("div");
  panel.className = "kensho-panel";
  panel.innerHTML = `
    <div class="kensho-row"><b>🎁 懸賞アシスタント</b><button class="kensho-x" data-k="close">×</button></div>
    <div>今日の応募 <b>${k.entries}</b>/${s.dailyEntryLimit} ・ フォロー <b>${k.follows}</b>/${s.dailyFollowLimit}</div>
    <button class="kensho-btn" data-k="search">🔍 懸賞ツイートをまとめて検索</button>
    <details><summary>設定</summary>
      <label>1日の応募上限 <input type="number" data-s="dailyEntryLimit" value="${s.dailyEntryLimit}" min="1"></label>
      <label>1日のフォロー上限 <input type="number" data-s="dailyFollowLimit" value="${s.dailyFollowLimit}" min="1"></label>
      <label>検索キーワード（1行に1つ）<textarea data-s="searchKeywords" rows="4">${escHtml(s.searchKeywords.join("\n"))}</textarea></label>
      <label>応募方法ワード（1行に1つ）<textarea data-s="searchRequired" rows="3">${escHtml(s.searchRequired.join("\n"))}</textarea></label>
      <label>除外・追加条件 <input type="text" data-s="searchExclude" value="${escHtml(s.searchExclude)}"></label>
      <label>何日前まで探すか <input type="number" data-s="searchSinceDays" value="${s.searchSinceDays}" min="0"></label>
      <button class="kensho-btn" data-k="save">保存</button>
    </details>`;
  panel.addEventListener("click", (e) => {
    const k2 = e.target.dataset.k;
    if (k2 === "close") panel.remove();
    if (k2 === "search") location.href = intents.search(searchQuery());
    if (k2 === "save") {
      panel.querySelectorAll("[data-s]").forEach((el) => {
        const key = el.dataset.s;
        if (el.tagName === "TEXTAREA") s[key] = el.value.split("\n").map((x) => x.trim()).filter(Boolean);
        else if (el.type === "number") s[key] = Math.max(key === "searchSinceDays" ? 0 : 1, parseInt(el.value, 10) || 0);
        else s[key] = el.value.trim();
      });
      save(); toast("保存しました"); panel.remove();
    }
  });
  document.body.appendChild(panel);
}
const fab = document.createElement("button");
fab.className = "kensho-fab";
fab.textContent = "🎁";
fab.title = "懸賞アシスタント";
fab.addEventListener("click", openPanel);
document.body.appendChild(fab);

// ---------------- スタイル ----------------
const style = document.createElement("style");
style.textContent = `
.kensho-bar{margin:8px 0;padding:10px;border-radius:12px;background:#fff7e6;border:1px solid #ffd591;color:#1f2328;font-size:14px;line-height:1.5}
.kensho-head{font-weight:600;margin-bottom:4px}
.kensho-note{font-size:13px;color:#555;margin:2px 0}
.kensho-note.warn,.kensho-warn{color:#c62828}
.kensho-ok{color:#2e7d32}
.kensho-note a{color:#1d9bf0;margin-right:6px}
.kensho-btn{display:block;width:100%;margin-top:6px;padding:10px;border:none;border-radius:999px;background:#1d9bf0;color:#fff;font-size:15px;font-weight:700;cursor:pointer}
.kensho-btn:disabled{background:#2e7d32;opacity:.9}
.kensho-steps{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.kensho-step{font-size:12px;padding:2px 8px;border-radius:999px;background:#eee}
.kensho-step.ok,.kensho-step.already{background:#e8f5e9;color:#1b5e20}
.kensho-step.fail{background:#fdecea;color:#b71c1c}
.kensho-fab{position:fixed;left:12px;bottom:90px;z-index:9999;width:48px;height:48px;border-radius:50%;border:none;background:#ff9800;font-size:24px;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.kensho-panel{position:fixed;left:8px;right:8px;bottom:150px;z-index:10000;max-height:70vh;overflow:auto;background:#fff;color:#1f2328;border-radius:16px;padding:14px;box-shadow:0 4px 20px rgba(0,0,0,.35);font-size:14px}
.kensho-panel label{display:block;margin-top:8px}
.kensho-panel input,.kensho-panel textarea{width:100%;box-sizing:border-box;font-size:16px;padding:6px;border:1px solid #ccc;border-radius:8px}
.kensho-row{display:flex;justify-content:space-between;align-items:center}
.kensho-x{border:none;background:none;font-size:22px}
.kensho-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:160px;z-index:10001;background:#1f2328;color:#fff;padding:10px 14px;border-radius:10px;font-size:14px;max-width:90vw}
`;
document.head.appendChild(style);
scan();
