// X を模したページ（tests/mock-x.html）でユーザースクリプトの動作を確認する。
// 使い方: node scripts/build-userscript.mjs && node tests/userscript.e2e.cjs [スクリーンショット保存先]
const { chromium, devices } = require("playwright");
const path = require("path");
const assert = require("assert/strict");

(async () => {
  const shotDir = process.argv[2];
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices["iPhone 13"] });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto("file://" + path.resolve(__dirname, "mock-x.html"));
  await p.evaluate(() => localStorage.clear());
  await p.addScriptTag({ path: path.resolve(__dirname, "../web/kensho.user.js") });
  await p.waitForSelector(".kensho-bar");

  const bars = await p.$$eval("article", (as) => as.map((a) => a.querySelector(".kensho-bar")?.innerText || ""));
  assert.match(bars[0], /必要：@juice_jpフォロー ・ いいね ・ 引用/);
  assert.match(bars[0], /認証マークあり/);
  assert.match(bars[1], /その場で当たる/);
  assert.match(bars[2], /対象外：LINE登録/);
  assert.match(bars[3], /全文を開く/);
  assert.equal(bars[4], ""); // 懸賞ではないツイートには何も付けない
  if (shotDir) await p.screenshot({ path: shotDir + "/us-before.png" });

  // 1件目：フォロー＋いいね＋引用
  await p.click("article:nth-of-type(1) .kensho-go");
  await p.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 15000 });
  await p.waitForTimeout(800);
  const typed = await p.textContent('[data-testid="tweetTextarea_0"]');
  assert.match(typed, /#白桃ジュースで当てよう/);
  if (shotDir) await p.screenshot({ path: shotDir + "/us-composer.png" });
  await p.click('[data-testid="tweetButton"]');
  await p.waitForTimeout(2200);

  // 2件目：フォロー＋リポスト
  await p.click("article:nth-of-type(2) .kensho-go");
  await p.waitForFunction(() => /応募しました|応募済み|もう一度/.test(document.querySelector("article:nth-of-type(2) .kensho-go")?.textContent || ""), null, { timeout: 15000 });

  const log = await p.evaluate(() => window.__log);
  console.log("actions:", log);
  assert.ok(log.includes("follow:juice_jp") && log.includes("like:111"));
  assert.ok(log.some((l) => l.startsWith("quote:111:") && l.includes("#白桃ジュースで当てよう")));
  assert.ok(log.includes("follow:snack_co") && log.includes("repost:222"));
  assert.ok(!log.some((l) => l.startsWith("navigate:")), "ボタン操作でツイート詳細に移動してはいけない");
  assert.ok(!log.some((l) => /333|line_cp/.test(l)), "対象外のツイートは操作しない");

  await p.waitForTimeout(800);
  const after = await p.$$eval("article .kensho-go", (bs) => bs.map((x) => x.textContent));
  console.log("buttons after:", after);
  assert.ok(after.every((t) => /応募済み|応募しました/.test(t)));
  if (shotDir) await p.screenshot({ path: shotDir + "/us-after.png" });

  // 再読み込み後も「応募済み」を覚えている
  await p.reload();
  await p.addScriptTag({ path: path.resolve(__dirname, "../web/kensho.user.js") });
  await p.waitForSelector(".kensho-go");
  const reloaded = await p.$$eval("article .kensho-go", (bs) => bs.map((x) => x.textContent));
  assert.deepEqual(reloaded, ["✓ 応募済み", "✓ 応募済み"]);

  // 🎁 メニューの「まとめて検索」
  await p.click(".kensho-fab");
  const cnt = await p.textContent(".kensho-panel");
  assert.match(cnt, /今日の応募 2\/20/);
  assert.deepEqual(errors, []);
  console.log("USERSCRIPT E2E OK");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
