// DEVNET ONLY: a Public-paid swap short of SOL for its costs is refused, nothing moved; once funded it goes through.
// Needs dev/serve.mjs on :3399.   node test/devnet-public-swap.mjs
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

let failures = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (args) => execFileSync(process.execPath, ["--import", "tsx", ...args], { cwd: root, encoding: "utf8" }).trim().split("\n").pop();

const profile = mkdtempSync(join(tmpdir(), "rings-public-swap-"));
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: profile, args: ["--no-first-run"] });
try {
  const p = await browser.newPage();
  await p.goto("http://localhost:3399/onboarding.html", { waitUntil: "load" });
  const bg = (m) => p.evaluate((x) => chrome.runtime.sendMessage(x), m);
  const words = (await bg({ type: "newPhrase" })).data;
  const made = await bg({ type: "create", phrase: Array.isArray(words) ? words.join(" ") : words, password: "public-swap-1" });
  const address = made.data.accounts[0].address;
  console.log("SOL:", run([".devdata/fund.ts", address, "3000000"]).slice(0, 40) + "…");
  // 0.5 TEST1 plus the 0.1% fee, in base units (9 decimals)
  console.log("TEST1:", run(["test/devnet-send-test-coin.ts", address, "500500000"]).slice(0, 40) + "…");
  await sleep(4000);
  const pub = async () => Object.fromEntries(((await bg({ type: "balances" })).data ?? []).map((r) => [r.mint, Number(r.units)]));
  const priv = async () => Object.fromEntries(((await bg({ type: "privateBalances" })).data?.rows ?? []).map((r) => [r.mint, Number(r.units)]));
  const before = await pub();
  console.log(`public: ${before[SOL] / 1e9} SOL, ${(before[TEST1] ?? 0) / 1e9} TEST1`);

  const ask = { type: "swap", from: "public", inMint: TEST1, outMint: SOL, amount: "0.5", slippageBps: 300, receiveInto: "private" };
  const refused = await bg(ask);
  await sleep(2000);
  const after = await pub();
  const privAfter = await priv();
  check(!refused.ok && refused.code === "publicShort" && (after[TEST1] ?? 0) === (before[TEST1] ?? 0) && !(privAfter[TEST1] > 0), "too little SOL in Public: refused before anything moves", refused.error);

  console.log("more SOL:", run([".devdata/fund.ts", address, "20000000"]).slice(0, 40) + "…");
  await sleep(4000);
  const swap = await bg(ask);
  let view = null;
  for (let i = 0; i < 90 && swap.ok; i++) {
    view = (await bg({ type: "swapStatus", id: swap.data.id })).data;
    if (view?.finished) break;
    await sleep(4000);
  }
  check(swap.ok && view?.finished === "done", "with SOL added, the same swap goes through", swap.ok ? `${view?.state} ${view?.out ?? ""}` : swap.error);
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
