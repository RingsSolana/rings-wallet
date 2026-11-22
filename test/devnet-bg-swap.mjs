// DEVNET ONLY: a private swap through the background lands in Activity once; one over the private balance is refused.
// Needs dev/serve.mjs on :3399 and the devnet copy of rings.run on :3101.   node test/devnet-bg-swap.mjs
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const puppeteer = createRequire(join(root, "../brand/video/package.json"))("puppeteer-core");
const cft = join(root, ".devdata/chrome/chrome");
const chromePath = join(cft, readdirSync(cft).find((d) => d.startsWith("win64-")), "chrome-win64", "chrome.exe");
const phrase = readFileSync(join(root, ".devdata/devnet-phrase.txt"), "utf8").trim();
const SOL = "11111111111111111111111111111111";
const TEST1 = "FF4iWENV2AA58SPN9yf77SZ9wuJkhHxDowM9hb3pjZzr";

let failures = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};

const profile = mkdtempSync(join(tmpdir(), "rings-bg-swap-"));
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: profile, args: ["--no-first-run"] });
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:3399/onboarding.html", { waitUntil: "load" }); // popup.html redirects a visitor with no wallet
  const bg = (msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const made = await bg({ type: "create", phrase, password: "bg-swap-test-1" });
  check(made?.ok, "wallet created in the harness");

  const privSol = async () => {
    const r = await bg({ type: "privateBalances" });
    return Number(r.data.rows.find((x) => x.mint === SOL)?.units ?? 0);
  };
  const before = await privSol();
  console.log(`private SOL before: ${before / 1e9}`);

  const big = await bg({ type: "swap", from: "private", inMint: SOL, outMint: TEST1, amount: String(Math.ceil(before / 1e9) + 1), slippageBps: 300, receiveInto: "private" });
  const swapsAfterBig = await page.evaluate(() => chrome.storage.local.get("swaps").then((r) => (r.swaps ?? []).length));
  check(!big.ok && big.code === "short" && swapsAfterBig === 0 && (await privSol()) === before, "a swap bigger than the private balance is refused before anything is paid", big.error);

  const swap = await bg({ type: "swap", from: "private", inMint: SOL, outMint: TEST1, amount: "0.003", slippageBps: 300, receiveInto: "private" });
  check(swap?.ok && !!swap.data?.id, "swap started", swap.ok ? swap.data.id.slice(0, 8) : swap.error);
  let view = null;
  for (let i = 0; i < 90 && swap.ok; i++) {
    view = (await bg({ type: "swapStatus", id: swap.data.id })).data;
    if (view?.finished) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  check(view?.finished === "done", "the swap finished", `${view?.state} ${view?.out ?? ""} ${view?.error ?? ""}`);
  await bg({ type: "swapStatus", id: swap.data?.id }); // a repeat poll must not add a second Activity entry
  const history = (await bg({ type: "history" })).data ?? [];
  const entries = history.filter((h) => h.kind === "swapped" && h.status === "done");
  const left = await page.evaluate(() => chrome.storage.local.get("swaps").then((r) => (r.swaps ?? []).length));
  check(entries.length === 1 && left === 0, "Activity has the swap once and the follow list is empty", `${entries[0]?.amount ?? ""} ${entries[0]?.sym ?? ""}`);
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
