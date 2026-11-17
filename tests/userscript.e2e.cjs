// X を模したページ（tests/mock-x.html）でユーザースクリプトの動作を確認する。
// 使い方: npm run test:e2e  （スクリーンショットを保存する場合は引数に保存先フォルダ）
const { chromium, devices } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");

const SCRIPT = path.resolve(__dirname, "../web/kensho.user.js");
const MOCK = fs.readFileSync(path.resolve(__dirname, "mock-x.html"));

(async () => {
  const shotDir = process.argv[2];
  // どのパスでも模擬ページを返す（X と同じく /handle などに画面遷移するため）
  const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(MOCK); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const BASE = `http://127.0.0.1:${server.address().port}/mock-x.html`;

  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices["iPhone 13"] });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const load = async () => { await p.goto(BASE); await p.addScriptTag({ path: SCRIPT }); await p.waitForSelector(".kensho-bar"); };
  const bar = (n) => `article:nth-of-type(${n}) .kensho-bar`;
  await load();

  const texts = await p.$$eval("article", (as) => as.map((a) => a.querySelector(".kensho-bar")?.innerText || ""));
  assert.match(texts[0], /✓ @hotelloversjp フォロー/);
  assert.match(texts[0], /✓ @FENNEL_official フォロー/);
  assert.match(texts[0], /締切 2026-11-20 23:59/);
  assert.match(texts[1], /引用文に入れる言葉：「ローソン盛りすぎチャレンジ」/);
  assert.match(texts[2], /対象外：Instagram/);
  assert.match(texts[3], /画像などに条件/);          // 本文に応募方法がない → 手動で選ぶ
  assert.match(texts[3], /必要な操作を選んでください/);
  assert.equal(texts[4], "");                          // 懸賞ではない
  if (shotDir) await p.screenshot({ path: shotDir + "/us2-before.png" });

  // 1) FENNEL：リポスト＋2アカウントのフォロー（1つは投稿者、1つはプロフィールへ移動してフォロー）
  await p.click(`${bar(1)} .kensho-go`);
  await p.waitForFunction(() => /応募しました|もう一度/.test(document.querySelector("article:nth-of-type(1) .kensho-go")?.textContent || ""), null, { timeout: 30000 });
  const t1 = await p.innerText(bar(1));
  console.log("FENNEL steps:", t1.split("\n").filter((l) => /[✓✗]/.test(l)).join(" | "));
  assert.match(await p.innerText(`${bar(1)} .kensho-go`), /応募しました/);

  // 2) ローソン：フォロー＋引用（指定文が入っていること）
  await p.click(`${bar(2)} .kensho-go`);
  await p.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 20000 });
  await p.waitForTimeout(1000);
  const typed = await p.innerText('[data-testid="tweetTextarea_0"]');
  console.log("quote text:", typed);
  assert.ok(typed.startsWith("ローソン盛りすぎチャレンジ！"));
  if (shotDir) await p.screenshot({ path: shotDir + "/us2-composer.png" });
  await p.click('[data-testid="tweetButton"]');
  await p.waitForTimeout(2500);
  assert.match(await p.innerText(`${bar(2)} .kensho-go`), /応募しました/);

  // 3) 画像に条件があるツイート：手動で「フォロー＋いいね」を選んで応募
  await p.click(`${bar(4)} [data-chip="follow:img_brand"]`);
  await p.click(`${bar(4)} [data-chip="like"]`);
  await p.click(`${bar(4)} .kensho-go`);
  await p.waitForFunction(() => /応募しました|もう一度/.test(document.querySelector("article:nth-of-type(4) .kensho-go")?.textContent || ""), null, { timeout: 20000 });

  const log = await p.evaluate(() => window.__log);
  console.log("actions:", log);
  for (const a of ["repost:111", "follow:FENNEL_official", "follow:hotelloversjp", "follow:akiko_lawson", "follow:img_brand", "like:444"]) {
    assert.ok(log.includes(a), "missing " + a);
  }
  assert.ok(log.some((l) => l.startsWith("quote:222:ローソン盛りすぎチャレンジ！")));
  assert.ok(!log.includes("WRONG-follow"), "おすすめユーザーをフォローしてはいけない");
  assert.ok(!log.some((l) => l.startsWith("navigate:")), "ボタン操作でツイート詳細に移動してはいけない");
  assert.ok(!log.some((l) => /333|toshiba/.test(l)), "対象外のツイートは操作しない");
  if (shotDir) await p.screenshot({ path: shotDir + "/us2-after.png" });

  // 再読み込み後も応募済みを覚えている
  await load();
  const after = await p.$$eval("article .kensho-go", (bs) => bs.map((x) => x.textContent));
  assert.deepEqual(after, ["✓ 応募済み", "✓ 応募済み", "✓ 応募済み"]);
  await p.click(".kensho-fab");
  assert.match(await p.textContent(".kensho-panel"), /今日の応募 3\/20 ・ フォロー 4\/30/);
  assert.deepEqual(errors, []);
  console.log("USERSCRIPT E2E OK");
  await b.close();
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
