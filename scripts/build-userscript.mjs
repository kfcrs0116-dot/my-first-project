// web/logic.js と userscript/main.js を1ファイルのユーザースクリプトにまとめる
import { readFileSync, writeFileSync } from "node:fs";

const BASE = "https://kfcrs0116-dot.github.io/my-first-project";
const d = new Date();
const version = `1.${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}.${d.getUTCHours() * 100 + d.getUTCMinutes()}`;

const logic = readFileSync("web/logic.js", "utf8").replace(/^export /gm, "");
const main = readFileSync("userscript/main.js", "utf8");

const header = `// ==UserScript==
// @name         懸賞応募アシスタント
// @namespace    kensho-assistant
// @version      ${version}
// @description  Xの懸賞ツイートを読み取り、ボタン1つで応募条件（フォロー・いいね・リポスト・引用）を実行します
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://mobile.x.com/*
// @match        https://mobile.twitter.com/*
// @run-at       document-idle
// @grant        none
// @updateURL    ${BASE}/kensho.user.js
// @downloadURL  ${BASE}/kensho.user.js
// ==/UserScript==
`;

const out = `${header}\n(function () {\n"use strict";\n${logic}\n${main}\n})();\n`;
writeFileSync("web/kensho.user.js", out);
console.log(`built web/kensho.user.js (version ${version}, ${out.length} bytes)`);
