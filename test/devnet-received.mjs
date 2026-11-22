// DEVNET ONLY: incoming payments show in Activity as Received, once; 0.0001 SOL dust (address poisoning) stays hidden.
// Needs dev/serve.mjs on :3399.   node test/devnet-received.mjs
import { execFileSync } from "node:child_process";
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

let failures = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};
const pay = (to, lamports) => execFileSync(process.execPath, ["--import", "tsx", ".devdata/fund.ts", to, String(lamports)], { cwd: root, encoding: "utf8" }).trim().split("\n").pop();

const profile = mkdtempSync(join(tmpdir(), "rings-received-"));
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: profile, args: ["--no-first-run"] });
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:3399/onboarding.html", { waitUntil: "load" });
  const bg = (msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const made = await bg({ type: "create", phrase, password: "received-test-1" });
  const first = made.data.accounts[0].address;
  const added = await bg({ type: "addAccount" });
  const second = added.data.accounts[1].address;
  check(added.ok && added.data.activeId === added.data.accounts[1].id, "account 2 added and active", second.slice(0, 8));

  // Match by signature: account 2 can hold older Received rows.
  const sigOf = (line) => new RegExp("tx/([1-9A-HJ-NP-Za-km-z]{64,90})").exec(line ?? "")?.[1] ?? "";
  const big = pay(second, 2_000_000);
  console.log("paid 0.002 SOL:", big);
  const small = pay(second, 100_000);
  console.log("paid 0.0001 SOL:", small);
  await new Promise((r) => setTimeout(r, 4000));

  // Activity's payment scan is rate-limited, so poll for a while.
  let received = [];
  for (let i = 0; i < 25; i++) {
    received = ((await bg({ type: "history" })).data ?? []).filter((h) => h.kind === "received");
    if (received.some((h) => h.signature === sigOf(big))) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const row = received.find((h) => h.signature === sigOf(big));
  check(!!row && row.amount === "+0.002" && row.sym === "SOL" && row.who === first && received.filter((h) => h.signature === sigOf(big)).length === 1, "the 0.002 SOL payment shows as Received from account 1, once", row ? `${row.amount} ${row.sym} from ${row.who?.slice(0, 8)}` : "not shown");
  check(!received.some((h) => h.signature === sigOf(small)), "the 0.0001 SOL payment is too small to show");

  const again = ((await bg({ type: "history" })).data ?? []).filter((h) => h.kind === "received");
  check(again.length === received.length, "looking again adds nothing twice");
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
