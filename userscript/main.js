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
function findArticle(tweetId) {
  return [...document.querySelectorAll('article[data-testid="tweet"]')].find((a) => readTweet(a)?.tweetId === tweetId) || null;
}

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

/** 投稿者のフォロー：ツイートの「…」メニューから */
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

/** 投稿者以外のフォロー：本文の @リンクからプロフィールを開いてフォローし、元の画面に戻る */
async function doFollowViaProfile(tweetId, handle) {
  const a = findArticle(tweetId);
  const want = "/" + handle.toLowerCase();
  const link = a && [...a.querySelectorAll('[data-testid="tweetText"] a[href]')].find((x) => (x.getAttribute("href") || "").toLowerCase() === want);
  if (!link) return "fail";
  const backTo = location.pathname + location.search;
  link.click();
  if (!(await waitFor(() => location.pathname.toLowerCase() === want, 6000))) return "fail";
  const col = () => document.querySelector('[data-testid="primaryColumn"]') || document.body;
  const findBtn = (suffix) => [...col().querySelectorAll(`[data-testid$="-${suffix}"]`)].find((b) => !b.closest('[data-testid="UserCell"]'));
  const btn = await waitFor(() => findBtn("unfollow") || findBtn("follow"), 8000);
  let r = "fail";
  if (btn) {
    if (/-unfollow$/.test(btn.dataset.testid)) r = "already";
    else {
      await humanPause();
      btn.click();
      r = (await waitFor(() => findBtn("unfollow"), 4000)) ? "ok" : "fail";
    }
  }
  await humanPause();
  history.back();
  await waitFor(() => location.pathname + location.search === backTo, 6000);
  await waitFor(() => findArticle(tweetId), 8000);
  await sleep(400);
  return r;
}

const normSpace = (s) => (s || "").replace(/\s+/g, "");
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
  // 入力して、全文が正しく入ったかを確認。だめならやり直し、それでもだめならコピー用に表示
  for (let attempt = 0; attempt < 2; attempt++) {
    box.focus();
    await sleep(300);
    if (attempt > 0) document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
    await sleep(300);
    if (normSpace(box.innerText) === normSpace(text)) return "ok";
  }
  return "manual";
}

// ---- 応募の状態（画面の作り直しに左右されないようにメモリに持つ） ----
const plans = {};     // tweetId -> {follow:[...], like, repost, quote}（手動で選び直した内容）
const progress = {};  // tweetId -> {steps, extra, btn, disabled, quoteText, v}
const busy = new Set();
const keyFollow = (h) => `follow:${h.toLowerCase()}`;
function isDone(entry, key, author) {
  if (!entry) return false;
  if (entry.actions[key]) return true;
  return !!author && key === keyFollow(author) && !!entry.actions.follow; // 旧バージョンの記録
}
function requiredKeys(plan) {
  return [...plan.follow.map(keyFollow), ...(plan.like ? ["like"] : []), ...(plan.repost ? ["repost"] : []), ...(plan.quote ? ["quote"] : [])];
}
function refresh(tweetId) {
  if (progress[tweetId]) progress[tweetId].v = (progress[tweetId].v || 0) + 1;
  const a = findArticle(tweetId);
  if (a) decorate(a);
}
function quoteReq(p, text) {
  return p.quote ? { quoteHashtags: p.quoteHashtags, quoteKeywords: p.quoteKeywords, theme: p.theme } : extractQuoteRequirements(text);
}

let pendingQuote = null; // tweetId
document.addEventListener("click", (e) => {
  if (!pendingQuote) return;
  if (e.target.closest('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')) {
    const id = pendingQuote;
    pendingQuote = null;
    const entry = state.entries[id];
    if (entry) { entry.actions.quote = localIso(); save(); }
    const pr = progress[id];
    if (pr) {
      const s = pr.steps.find((x) => x.key === "quote");
      if (s) s.r = "ok";
      if (!pr.steps.some((x) => x.r === "fail")) { pr.btn = "✓ 応募しました"; pr.disabled = true; }
    }
    toast("引用リポストを記録しました 🎉");
    setTimeout(() => refresh(id), 1500);
  }
}, true);

async function enter(tw, p) {
  const id = tw.tweetId;
  if (busy.has(id)) return;
  busy.add(id);
  try { await enterInner(tw, p); } finally { busy.delete(id); refresh(id); }
}

async function enterInner(tw, p) {
  const id = tw.tweetId;
  const plan = plans[id];
  const k = counts();
  if (k.entries >= state.settings.dailyEntryLimit && !state.entries[id]) {
    toast("今日の応募上限に達しました。凍結防止のため明日にしましょう"); return;
  }
  const entry = state.entries[id] || { at: localIso(), handle: tw.handle, actions: {} };
  const newFollows = plan.follow.filter((h) => !isDone(entry, keyFollow(h), tw.handle));
  if (k.follows + newFollows.length > state.settings.dailyFollowLimit) {
    toast(`今日のフォロー上限（${state.settings.dailyFollowLimit}件）を超えます。明日応募しましょう`); return;
  }

  let quoteText = null;
  if (plan.quote && !isDone(entry, "quote")) {
    const req = quoteReq(p, tw.text);
    const q = buildQuote({ hashtags: req.quoteHashtags, keywords: req.quoteKeywords, brand: tw.authorName, theme: req.theme, recentIds: state.recentTemplateIds });
    quoteText = q.text;
    if (req.theme) {
      const ans = prompt(`お題：${req.theme}\n\n回答を短く入力してください（引用文に入ります）`);
      if (!ans) { toast("キャンセルしました"); return; }
      quoteText = quoteText.replace(THEME_PLACEHOLDER, ans.trim());
    }
    const errs = validateQuote(quoteText, req.quoteHashtags, req.quoteKeywords);
    if (errs.length) { toast(errs.join(" / ")); return; }
    state.recentTemplateIds = [...state.recentTemplateIds, q.templateId].slice(-6);
  }
  entry.plan = { ...plan, follow: [...plan.follow] }; // 選んだ操作も保存（再読み込み後の判定用）
  state.entries[id] = entry;
  save();

  const pr = progress[id] = { steps: [], extra: "", btn: "応募中…", disabled: true, quoteText, v: 0 };
  refresh(id);
  const run = async (key, label, fn) => {
    if (isDone(entry, key, tw.handle)) { pr.steps.push({ key, label, r: "already" }); refresh(id); return; }
    const s = { key, label, r: "run" };
    pr.steps.push(s); refresh(id);
    const art = findArticle(id);
    s.r = art ? await fn(art) : "fail";
    if (s.r === "ok" || s.r === "already") {
      entry.actions[key] = localIso();
      if (key.startsWith("follow:") && s.r === "ok") state.followLog.push(localIso());
      save();
    }
    refresh(id);
    await humanPause();
  };

  const author = tw.handle.toLowerCase();
  if (plan.follow.some((h) => h.toLowerCase() === author)) {
    await run(keyFollow(tw.handle), `@${tw.handle} をフォロー`, (art) => doFollowAuthor(art, tw.handle));
  }
  if (plan.like) await run("like", "いいね", (art) => doLike(art));
  if (plan.repost) await run("repost", "リポスト", (art) => doRepost(art));
  for (const h of plan.follow.filter((x) => x.toLowerCase() !== author)) {
    await run(keyFollow(h), `@${h} をフォロー`, () => doFollowViaProfile(id, h));
  }
  if (quoteText) {
    const s = { key: "quote", label: "引用（内容を確認して「ポスト」を押す）", r: "run" };
    pr.steps.push(s); refresh(id);
    const art = findArticle(id);
    const r = art ? await openQuoteComposer(art, quoteText) : "fail";
    if (r === "fail") s.r = "fail";
    else {
      pendingQuote = id;
      if (r === "manual") {
        pr.extra += `<div class="kensho-note warn">引用文を自動で入力できませんでした。下の「コピー」を押して入力欄に貼り付けてください。</div>`;
      }
    }
  } else if (plan.quote) {
    pr.steps.push({ key: "quote", label: "引用", r: "already" });
  }

  const failed = pr.steps.filter((s) => s.r === "fail");
  if (failed.length) pr.extra += `<div class="kensho-note warn">✗ の操作は自動でできませんでした。もう一度試すか、手動で行ってください。</div>`;
  const quoteWaiting = pr.steps.some((s) => s.key === "quote" && s.r === "run");
  pr.btn = failed.length ? "もう一度試す" : quoteWaiting ? "引用を投稿すると完了します" : "✓ 応募しました";
  pr.disabled = !failed.length;
}

// ---------------- ツイートにボタンを付ける ----------------
function photoAltText(article) {
  return [...article.querySelectorAll('[data-testid="tweetPhoto"] img[alt]')]
    .map((img) => img.alt).filter((t) => t && !/^(画像|Image)$/i.test(t)).join("\n");
}

function decorate(article) {
  const tw = readTweet(article);
  const old = $q(article, ".kensho-bar");
  if (!tw) { old?.remove(); return; }
  const id = tw.tweetId;
  const fullText = [tw.text, photoAltText(article)].filter(Boolean).join("\n");
  const sigNow = () => [id, tw.truncated, Object.keys(state.entries[id]?.actions || {}).length,
    progress[id]?.v || 0, plans[id] ? JSON.stringify(plans[id]) : ""].join(":");
  const sig = sigNow();
  if (old && old.dataset.sig === sig) return;
  old?.remove();

  const p = parseCampaign(fullText, tw.handle);
  if (!p.isCampaign) return;
  const safe = checkSafety(fullText, tw.handle);
  const entry = state.entries[id];
  const pr = progress[id];

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
  } else if (p.unsupported.length) {
    html += `<div class="kensho-note">対象外：${escHtml(p.unsupported.join("、"))}</div>`;
  } else if (p.deadline && p.deadline < localIso()) {
    html += `<div class="kensho-note">締切を過ぎています</div>`;
  } else {
    const saved = entry?.plan;
    const plan = plans[id] || (plans[id] = saved ? { ...saved, follow: [...saved.follow] } : { follow: [...p.follow], like: p.like, repost: p.repost, quote: p.quote });
    const keys = requiredKeys(plan);
    const done = keys.length > 0 && keys.every((key) => isDone(entry, key, tw.handle));
    if (!p.supported) {
      html += `<div class="kensho-note warn">本文から応募方法を読み取れませんでした。画像などに条件が書かれている場合は、下から必要な操作を選んでください。</div>`;
    }
    // 必要な操作（タップで選び直せる）
    const handles = [...new Set([tw.handle, ...mentionedHandles(tw.text), ...plan.follow].map((h) => h))]
      .filter((h, i, arr) => arr.findIndex((x) => x.toLowerCase() === h.toLowerCase()) === i);
    const chip = (key, label, on) => `<button class="kensho-chip ${on ? "on" : ""}" data-chip="${escHtml(key)}">${on ? "✓ " : ""}${escHtml(label)}</button>`;
    html += `<div class="kensho-note">必要な操作（タップで変更）</div><div class="kensho-chips">`;
    html += handles.map((h) => chip(`follow:${h}`, `@${h} フォロー`, plan.follow.some((x) => x.toLowerCase() === h.toLowerCase()))).join("");
    html += chip("like", "いいね", plan.like) + chip("repost", "リポスト", plan.repost) + chip("quote", "引用", plan.quote);
    html += `</div>`;
    if (plan.quote) {
      const req = quoteReq(p, fullText);
      const must = [...req.quoteKeywords.map((x) => `「${x}」`), ...req.quoteHashtags.map((x) => `#${x}`)];
      html += `<div class="kensho-note">引用文に入れる言葉：${must.length ? escHtml(must.join(" ")) : "指定なし"}${req.theme ? `<br>お題：${escHtml(req.theme)}` : ""}</div>`;
    }
    if (!tw.verified && safe.reasons.length > 1) html += `<div class="kensho-note warn">${escHtml(safe.reasons[1])}</div>`;
    if (pr) {
      html += `<button class="kensho-btn kensho-go" ${pr.disabled ? "disabled" : ""}>${escHtml(pr.btn)}</button>`;
      html += `<div class="kensho-steps">${pr.steps.map((s) => `<span class="kensho-step ${s.r}">${s.r === "ok" || s.r === "already" ? "✓" : s.r === "fail" ? "✗" : "…"} ${escHtml(s.label)}</span>`).join("")}</div>`;
      html += pr.extra;
      if (pr.quoteText && !isDone(entry, "quote")) {
        html += `<div class="kensho-quote"><div>${escHtml(pr.quoteText)}</div><button class="kensho-copy">コピー</button></div>`;
      }
    } else if (done) {
      html += `<button class="kensho-btn kensho-go" disabled>✓ 応募済み</button>`;
    } else {
      html += `<button class="kensho-btn kensho-go" ${keys.length ? "" : "disabled"}>${keys.length ? "応募する" : "必要な操作を選んでください"}</button>`;
    }
  }
  bar.innerHTML = html;
  bar.dataset.sig = sigNow(); // 初回に plans[id] を作った分を反映
  bar.addEventListener("click", (e) => {
    e.stopPropagation(); // ツイート詳細へ移動しないように
    const chipEl = e.target.closest(".kensho-chip");
    if (chipEl && !busy.has(id)) {
      e.preventDefault();
      const plan = plans[id];
      const key = chipEl.dataset.chip;
      if (key.startsWith("follow:")) {
        const h = key.slice(7);
        const has = plan.follow.some((x) => x.toLowerCase() === h.toLowerCase());
        plan.follow = has ? plan.follow.filter((x) => x.toLowerCase() !== h.toLowerCase()) : [...plan.follow, h];
      } else plan[key] = !plan[key];
      if (progress[id] && !busy.has(id)) delete progress[id];
      decorate(article);
      return;
    }
    const go = e.target.closest(".kensho-go");
    if (go && !go.disabled) { e.preventDefault(); enter(tw, p); }
    if (e.target.closest(".kensho-more")) { e.preventDefault(); $q(article, '[data-testid="tweet-text-show-more-link"]')?.click(); }
    if (e.target.closest(".kensho-copy")) {
      e.preventDefault();
      navigator.clipboard?.writeText(progress[id]?.quoteText || "").then(() => toast("コピーしました"), () => toast("コピーできませんでした。文を長押ししてコピーしてください"));
    }
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
.kensho-chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0}
.kensho-chip{border:1px solid #bbb;background:#fff;color:#555;border-radius:999px;padding:4px 10px;font-size:13px}
.kensho-chip.on{background:#1d9bf0;border-color:#1d9bf0;color:#fff}
.kensho-quote{margin-top:6px;padding:8px;background:#fff;border:1px dashed #ffb74d;border-radius:8px;font-size:13px;user-select:text;-webkit-user-select:text}
.kensho-copy{margin-top:4px;border:none;background:#ff9800;color:#fff;border-radius:999px;padding:4px 12px;font-size:13px}
.kensho-fab{position:fixed;left:8px;bottom:120px;z-index:9999;width:40px;height:40px;border-radius:50%;border:none;background:#ff9800;font-size:20px;opacity:.85;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.kensho-panel{position:fixed;left:8px;right:8px;bottom:150px;z-index:10000;max-height:70vh;overflow:auto;background:#fff;color:#1f2328;border-radius:16px;padding:14px;box-shadow:0 4px 20px rgba(0,0,0,.35);font-size:14px}
.kensho-panel label{display:block;margin-top:8px}
.kensho-panel input,.kensho-panel textarea{width:100%;box-sizing:border-box;font-size:16px;padding:6px;border:1px solid #ccc;border-radius:8px}
.kensho-row{display:flex;justify-content:space-between;align-items:center}
.kensho-x{border:none;background:none;font-size:22px}
.kensho-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:160px;z-index:10001;background:#1f2328;color:#fff;padding:10px 14px;border-radius:10px;font-size:14px;max-width:90vw}
`;
document.head.appendChild(style);
scan();
