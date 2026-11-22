// DEVNET ONLY: a swap paid from Public is delivered to Public and shows as one Public row in Activity (~0.05 SOL).
// Needs dev/serve.mjs on :3399; UI_ONLY=1 skips the swap.   node test/devnet-public-swap-into.mjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};

const profile = mkdtempSync(join(tmpdir(), "rings-public-into-"));
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: profile, args: ["--no-first-run"] });
try {
  const p = await browser.newPage();
  await p.setViewport({ width: 360, height: 600 });
  await p.goto("http://localhost:3399/onboarding.html", { waitUntil: "load" });
  const bg = (m) => p.evaluate((x) => chrome.runtime.sendMessage(x), m);
  check((await bg({ type: "create", phrase, password: "public-into-1" }))?.ok, "wallet created in the harness");

  await p.goto("http://localhost:3399/popup.html", { waitUntil: "load" });
  await p.waitForFunction(() => /Receive/.test(document.body.innerText), { timeout: 30000 });
  await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^Swap$/.test(b.innerText.trim()))?.click());
  await sleep(1500);
  const into = () =>
    p.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find((t) => ["Private balance", "This wallet", "Another wallet"].includes(t.innerText.trim()) && t.getAttribute("aria-selected") === "true")?.innerText.trim() ?? "none");
  const payFrom = (label) => p.evaluate((l) => [...document.querySelectorAll('[role="tab"]')].find((b) => b.innerText.trim() === l)?.click(), label);
  await payFrom("Private");
  await sleep(800);
  const start = await into();
  await payFrom("Public");
  await sleep(800);
  const afterPublic = await into();
  await payFrom("Private");
  await sleep(800);
  const afterPrivate = await into();
  check(start === "Private balance" && afterPublic === "This wallet" && afterPrivate === "Private balance", "choosing Public to pay sends the coins to this wallet (Public); Private sends them to Private", `${start} → ${afterPublic} → ${afterPrivate}`);

  const accountId = (await bg({ type: "state" })).data?.accounts?.[0]?.id;
  const row = (id, balance) => ({ id, network: "devnet", account: accountId, kind: "swapped", balance, who: null, amount: "+1", sym: "TEST1", at: Date.now(), status: "done" });
  await p.evaluate((rows) => chrome.storage.local.get("history").then((r) => chrome.storage.local.set({ history: [...rows, ...(r.history ?? [])] })), [row("ui-pub", "public"), row("ui-priv", "private")]);
  await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^Activity$/.test(b.innerText.trim()))?.click());
  await sleep(1500);
  const lines = await p.evaluate(() => document.body.innerText.split("\n").map((l) => l.trim()).filter(Boolean));
  const firstTwo = lines.filter((l, i) => /^Swapped$/.test(lines[i - 1] ?? "") || /^(Public|Private)$/.test(l)).slice(0, 4).join(" | ");
  const text = lines.join(" ");
  check(/Swapped Public/.test(text) && /Swapped Private/.test(text), "Activity: a swap into Public reads Public, one into Private reads Private", firstTwo);

  if (process.env.UI_ONLY) throw Object.assign(new Error("ui only"), { skip: true });
  // Above the private balance, so paying needs a deposit from Public first.
  const priv = Number((((await bg({ type: "privateBalances" })).data?.rows ?? []).find((r) => r.mint === SOL)?.units) ?? 0);
  const amount = (Math.max(0.05, priv / 1e9 + 0.01)).toFixed(3);
  const t0 = Date.now();
  const r = await bg({ type: "swap", from: "public", inMint: SOL, outMint: TEST1, amount, slippageBps: 300, receiveInto: "wallet" });
  check(r?.ok, "swap from Public started", r?.ok ? `${amount} SOL, ${r.data.id.slice(0, 8)}` : r?.error);
  let view = null;
  for (let i = 0; i < 90 && r?.ok; i++) {
    view = (await bg({ type: "swapStatus", id: r.data.id })).data;
    if (view?.finished) break;
    await sleep(4000);
  }
  await bg({ type: "swapStatus", id: r?.data?.id });
  // Leave out the hand-made ui-… rows: they can fall inside the time window.
  const rows = ((await bg({ type: "history" })).data ?? []).filter((h) => h.at >= t0 - 5000 && !String(h.id).startsWith("ui-"));
  const made = rows.filter((h) => h.kind === "madePrivate");
  const swapped = rows.filter((h) => h.kind === "swapped");
  check(view?.finished === "done" && swapped.length === 1 && swapped[0].balance === "public" && made.length === 0, "Activity: one Swapped row under Public, and not the deposit that paid it", rows.map((h) => `${h.kind} ${h.amount} ${h.sym} ${h.balance}`).join("; "));
} catch (e) {
  if (e?.skip) console.log("(UI_ONLY: the swap part skipped)");
  else {
    failures++;
    console.log("FAIL", e.message);
  }
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
