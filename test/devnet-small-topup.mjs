// DEVNET ONLY: with 0.02 SOL in Public and an empty Private, a small swap offers the top-up, then goes through.
//   node test/devnet-small-topup.mjs [SOL amount, default 0.01]   (needs dev/serve.mjs and web's dev-devnet.mjs)
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
const SOL = "11111111111111111111111111111111";
const TEST1 = "FF4iWENV2AA58SPN9yf77SZ9wuJkhHxDowM9hb3pjZzr";
const AMOUNT = process.argv[2] ?? "0.01";

let failures = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = (p, re) =>
  p.evaluate((s) => {
    const b = [...document.querySelectorAll("button")].find((x) => new RegExp(s).test(x.innerText.trim()) && !x.disabled);
    b?.click();
    return b ? b.innerText.trim() : null;
  }, re);

const profile = mkdtempSync(join(tmpdir(), "rings-small-topup-"));
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: profile, args: ["--no-first-run"] });
try {
  const p = await browser.newPage();
  await p.setViewport({ width: 360, height: 600 });
  await p.goto("http://localhost:3399/onboarding.html", { waitUntil: "load" });
  const bg = (m) => p.evaluate((x) => chrome.runtime.sendMessage(x), m);
  const words = (await bg({ type: "newPhrase" })).data;
  const made = await bg({ type: "create", phrase: Array.isArray(words) ? words.join(" ") : words, password: "small-topup-1" });
  execFileSync(process.execPath, ["--import", "tsx", ".devdata/fund.ts", made.data.accounts[0].address, "20000000"], { cwd: root, encoding: "utf8" });
  await sleep(3000);

  await p.goto("http://localhost:3399/popup.html", { waitUntil: "load" });
  await p.waitForFunction(() => /Receive/.test(document.body.innerText), { timeout: 30000 });
  await clickText(p, "^Swap$");
  await sleep(1500);
  await clickText(p, "^Private$");
  await sleep(500);
  const input = (await p.$$("input"))[0];
  await input.click();
  await input.type(AMOUNT);
  let key = null;
  for (let i = 0; i < 20 && !key; i++) {
    await sleep(1000);
    key = await p.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /^Top up .* from Public$/.test(x.innerText.trim()));
      return b ? { text: b.innerText.trim(), disabled: b.disabled } : null;
    });
  }
  const shortToo = await p.evaluate(() => /public balance is short too/i.test(document.body.innerText));
  check(!!key && !key.disabled && !shortToo, `0.02 SOL in Public is enough to top up a ${AMOUNT} SOL swap`, key ? key.text : "no top-up key");
  if (key && !key.disabled) {
    await clickText(p, "^Top up .* from Public$");
    let ready = false;
    for (let i = 0; i < 90 && !ready; i++) {
      await sleep(1500);
      ready = await p.evaluate(() => !!([...document.querySelectorAll("button")].find((x) => /^Review swap$/.test(x.innerText.trim()) && !x.disabled)));
    }
    const pub = (await bg({ type: "balances" })).data.find((r) => r.mint === SOL)?.units ?? "0";
    check(ready, "after the top-up, Review swap is on", `public left ${Number(pub) / 1e9} SOL: the fee float was the small one`);
    const s = await bg({ type: "swap", from: "private", inMint: SOL, outMint: TEST1, amount: AMOUNT, slippageBps: 300, receiveInto: "private" });
    let view = null;
    for (let i = 0; i < 90 && s.ok; i++) {
      view = (await bg({ type: "swapStatus", id: s.data.id })).data;
      if (view?.finished) break;
      await sleep(4000);
    }
    check(s.ok && view?.finished === "done", "the swap went through", s.ok ? `${view?.state} ${view?.out ?? ""}` : s.error);
  }
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
