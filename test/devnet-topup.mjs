// DEVNET ONLY: a swap from an empty Private offers a top-up from Public; once it lands, the swap can go ahead.
// Needs dev/serve.mjs on :3399; funds a new wallet with 0.05 devnet SOL.   node test/devnet-topup.mjs
import { execFileSync } from "node:child_process";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const puppeteer = createRequire(join(root, "../brand/video/package.json"))("puppeteer-core");
const cft = join(root, ".devdata/chrome/chrome");
const chromePath = join(cft, readdirSync(cft).find((d) => d.startsWith("win64-")), "chrome-win64", "chrome.exe");
const SOL = "11111111111111111111111111111111", TEST1 = "FF4iWENV2AA58SPN9yf77SZ9wuJkhHxDowM9hb3pjZzr";
const profile = mkdtempSync(join(tmpdir(), "rings-topup-"));
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: profile, args: ["--no-first-run"] });
let failures = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};
try {
  const p = await browser.newPage();
  await p.setViewport({ width: 360, height: 600 });
  await p.goto("http://localhost:3399/onboarding.html", { waitUntil: "load" });
  const bg = (m) => p.evaluate((x) => chrome.runtime.sendMessage(x), m);
  const words = (await bg({ type: "newPhrase" })).data;
  const made = await bg({ type: "create", phrase: Array.isArray(words) ? words.join(" ") : words, password: "topup-test-1" });
  const address = made.data.accounts[0].address;
  console.log("funded:", execFileSync(process.execPath, ["--import", "tsx", ".devdata/fund.ts", address, "50000000"], { cwd: root, encoding: "utf8" }).trim().split("\n").pop().slice(0, 50) + "…");
  await new Promise((r) => setTimeout(r, 3000));
  const ask = { type: "swapQuote", inMint: SOL, outMint: TEST1, amount: "0.01", slippageBps: 300, from: "private", receiveInto: "private" };
  const q1 = await bg(ask);
  const s = q1.data?.shortfall;
  check(q1.ok && s && s.publicOk && /SOL$/.test(s.label), "swap from an empty Private: shortfall worked out, Public can cover it", s ? s.label : q1.error);
  await p.goto("http://localhost:3399/popup.html", { waitUntil: "load" });
  await p.waitForFunction(() => /Receive/.test(document.body.innerText), { timeout: 30000 });
  await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^Swap$/.test(b.innerText.trim()))?.click());
  await new Promise((r) => setTimeout(r, 1500));
  await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^Private$/.test(b.innerText.trim()))?.click());
  await new Promise((r) => setTimeout(r, 500));
  const input = await p.$("input[inputmode=decimal], input[type=text], input");
  await input.click();
  await input.type("0.01");
  let btn = null;
  for (let i = 0; i < 20 && !btn; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    btn = await p.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.innerText.trim()).find((t) => /^Top up .* from Public$/.test(t)) ?? null);
  }
  check(!!btn, "the Swap screen offers the top-up", btn ?? (await p.evaluate(() => document.body.innerText.slice(0, 300))));
  await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^Top up .* from Public$/.test(b.innerText.trim()))?.click());
  const seen = new Set();
  let reviewOn = false;
  for (let i = 0; i < 90 && !reviewOn; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const t = await p.evaluate(() => document.body.innerText);
    if (/Moving to Private/.test(t)) seen.add("working");
    if (/Waiting for your private balance/.test(t)) seen.add("waiting");
    reviewOn = await p.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /^Review swap$/.test(x.innerText.trim())); return !!b && !b.disabled; });
  }
  check(reviewOn && !/short by/.test(await p.evaluate(() => document.body.innerText)), "after the top-up, nothing is short and Review swap is on", [...seen].join(" → "));
  const q2 = await bg(ask);
  check(q2.ok && !q2.data.shortfall, "a new quote finds nothing short");
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
