// DEVNET ONLY, read-only: the Rings fee and network fee rows on send, move and swap reviews; nothing is confirmed.
// Needs dev/serve.mjs on :3399 and the devnet copy of rings.run on :3101.   node test/devnet-review-fees.mjs
import { readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const puppeteer = createRequire(join(root, "../brand/video/package.json"))("puppeteer-core");
const { ed25519 } = await import("@noble/curves/ed25519");
const kit = await import("@solana/kit");
const cft = join(root, ".devdata/chrome/chrome");
const chromePath = join(cft, readdirSync(cft).find((d) => d.startsWith("win64-")), "chrome-win64", "chrome.exe");
const phrase = readFileSync(join(root, ".devdata/devnet-phrase.txt"), "utf8").trim();
const SOL = "11111111111111111111111111111111";
const TEST1 = "FF4iWENV2AA58SPN9yf77SZ9wuJkhHxDowM9hb3pjZzr";
const SHOTS = process.env.SHOTS ?? join(tmpdir(), "rings-review-fees");
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freshAddress = () => kit.getAddressDecoder().decode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
const show = (f) => (f ? `fee "${f.ringsFee}", network "${f.networkFee}", note "${f.networkFeeNote}"` : "none");

const profile = mkdtempSync(join(tmpdir(), "rings-review-fees-"));
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: profile, args: ["--no-first-run"] });
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:3399/onboarding.html", { waitUntil: "load" });
  const bg = (msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const made = await bg({ type: "create", phrase, password: "review-fees-test-1" });
  check(made?.ok, "wallet created in the harness");
  const state = (await bg({ type: "state" })).data;
  check(state?.network === "devnet", "on devnet", state?.network);
  const me = state.accounts.find((a) => a.id === state.activeId).address;
  const privAddr = (await bg({ type: "privateAddress" })).data;

  const costs = async (m) => {
    const r = await bg({ type: "reviewCosts", ...m });
    if (!r.ok) throw new Error(`${JSON.stringify(m)}: ${r.error}`);
    return r.data;
  };
  const stranger = freshAddress();
  let f = await costs({ flow: "send", from: "public", direction: "toPrivate", mint: SOL, amount: "0.25", to: stranger });
  check(f.ringsFee === "0.00025 SOL" && f.networkFee === "0.000005 SOL" && f.networkFeeNote === "", "public SOL send: 0.1% fee, one signature", show(f));

  f = await costs({ flow: "send", from: "public", direction: "toPrivate", mint: TEST1, amount: "10", to: stranger });
  const treasuryTakesTest1 = f.ringsFee !== "";
  check(
    (f.ringsFee === "" || /^0\.01 /.test(f.ringsFee)) && f.networkFee === "0.000005 SOL" && /^\+ about 0\.00\d+ SOL to open the receiving account for this coin$/.test(f.networkFeeNote),
    "public token send to an address with no account for it: rent named, fee only if the treasury can take the coin",
    show(f),
  );

  f = await costs({ flow: "send", from: "public", direction: "toPrivate", mint: TEST1, amount: "10", to: me });
  check(f.networkFeeNote === "", "public token send to an address that has the account: no rent", show(f));

  f = await costs({ flow: "send", from: "private", direction: "toPublic", mint: SOL, amount: "0.25", to: stranger });
  check(f.ringsFee === "0.00025 SOL" && f.networkFee === "0.00001 SOL" && /^From your Rings account/.test(f.networkFeeNote), "private SOL send to a public address: paid by the Rings account", show(f));

  f = await costs({ flow: "send", from: "private", direction: "toPublic", mint: TEST1, amount: "10", to: stranger });
  check(f.ringsFee === "0.01 TEST1" || /^0\.01 /.test(f.ringsFee), "a private token send always takes its fee (a private payment)", show(f));
  check(/From your Rings account.* · \+ about 0\.00\d+ SOL to open the receiving account for this coin$/.test(f.networkFeeNote), "… and names the rent for the receiving account", show(f));

  f = await costs({ flow: "send", from: "private", direction: "toPublic", mint: SOL, amount: "0.25", to: privAddr });
  check(f.ringsFee === "0.00025 SOL" && f.networkFee === "0.00001 SOL", "private send to a Rings address", show(f));

  f = await costs({ flow: "send", from: "public", direction: "toPrivate", mint: SOL, amount: "0.25", to: privAddr });
  check(f.ringsFee === "0.00025 SOL" && f.networkFee === "0.000005 SOL" && f.networkFeeNote === "", "public SOL into someone's private balance: one signature, no float", show(f));

  f = await costs({ flow: "move", from: "public", direction: "toPrivate", mint: SOL, amount: "0.25" });
  check(f.ringsFee === "0.00025 SOL" && f.networkFee === "0.000005 SOL" && (f.networkFeeNote === "" || /^\+ [\d.]+ SOL into your Rings account, for private fees$/.test(f.networkFeeNote)), "move to Private", show(f));

  f = await costs({ flow: "move", from: "private", direction: "toPublic", mint: SOL, amount: "0.25" });
  check(f.ringsFee === "0.00025 SOL" && f.networkFee === "0.00001 SOL" && /^From your Rings account/.test(f.networkFeeNote), "move to Public (this wallet)", show(f));

  f = await costs({ flow: "move", from: "private", direction: "toPublic", mint: SOL, amount: "0.0000001" });
  check(f.ringsFee === "", "an amount too small for a 0.1% fee shows no Rings fee row", show(f));

  const bad = await bg({ type: "reviewCosts", flow: "send", from: "public", direction: "toPrivate", mint: SOL, amount: "0.1", to: "nonsense" });
  check(!bad.ok && bad.code === "badAddress", "a bad address is refused in plain words", bad.error);

  for (const from of ["private", "public"]) {
    const q = await bg({ type: "swapQuote", inMint: SOL, outMint: TEST1, amount: "0.003", slippageBps: 300, from, receiveInto: from === "private" ? "private" : "wallet" });
    const d = q.data;
    const wantNet = from === "private" ? "0.00001 SOL" : "0.000015 SOL";
    const wantNote = from === "private" ? /^From your Rings account/ : /^From your Public balance and your Rings account$/;
    check(q.ok && d.ringsFee === "0.000003 SOL" && d.networkFee === wantNet && wantNote.test(d.networkFeeNote) && /SOL$/.test(d.costs), `swap quote paid from ${from}: Rings fee, network cost and network fee`, q.ok ? `${show(d)}, cost "${d.costs}"` : q.error);
  }

  const popup = await browser.newPage();
  await popup.setViewport({ width: 360, height: 600, deviceScaleFactor: 2 });
  await popup.goto("http://localhost:3399/popup.html", { waitUntil: "networkidle0" });
  // Each dev-server page runs its own background: unlock this one too.
  const unlocked = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "unlock", password: "review-fees-test-1" }));
  check(unlocked?.ok, "popup unlocked", unlocked?.error);
  await popup.goto("http://localhost:3399/popup.html", { waitUntil: "networkidle0" });
  const clickText = async (text, within = "button") => {
    const ok = await popup.evaluate((t, sel) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === t && !e.disabled);
      if (!el) return false;
      el.click();
      return true;
    }, text, within);
    if (!ok) throw new Error(`no "${text}" to click; buttons: ${await popup.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).join(" | "))}`);
    await sleep(500);
  };
  const type = async (selector, text) => {
    await popup.click(selector, { clickCount: 3 });
    await popup.type(selector, text);
    await sleep(300);
  };
  const waitFor = async (fn, label, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await popup.evaluate(fn)) return true;
      await sleep(500);
    }
    throw new Error(`timed out: ${label}`);
  };
  const reviewText = () => popup.evaluate(() => document.body.innerText);
  const backHome = async () => {
    await popup.goto("http://localhost:3399/popup.html", { waitUntil: "networkidle0" });
    await sleep(800);
  };

  await sleep(1500);
  await clickText("Send");
  await type('input[placeholder="Solana address"]', stranger);
  await type('input[placeholder="0"]', "0.01");
  await clickText("Review");
  await waitFor(() => /Rings fee/.test(document.body.innerText) || /Something went wrong|failed/i.test(document.body.innerText), "send review");
  let text = await reviewText();
  await popup.screenshot({ path: join(SHOTS, "send-public-review.png") });
  check(/Rings fee \(0\.1%\)\s*0\.00001 SOL/.test(text) && /Network fee\s*0\.000005 SOL/.test(text) && !/Paid by Rings/.test(text), "popup Send review (from Public) shows both fees", text.replace(/\s+/g, " ").match(/To.*?(Back|Confirm|Send)/)?.[0] ?? text.slice(0, 200));

  await backHome();
  await clickText("Send");
  await clickText("Private balance");
  await type('input[placeholder="Solana address"]', stranger);
  await type('input[placeholder="0"]', "0.01");
  await clickText("Review");
  await waitFor(() => /Rings fee/.test(document.body.innerText) || /Something went wrong|failed/i.test(document.body.innerText), "private send review");
  text = await reviewText();
  await popup.screenshot({ path: join(SHOTS, "send-private-review.png") });
  check(/Rings fee \(0\.1%\)\s*0\.00001 SOL/.test(text) && /Network fee\s*0\.00001 SOL\s*From your Rings account/.test(text) && !/Paid by Rings/.test(text), "popup Send review (from Private) shows both fees, paid by the Rings account", text.replace(/\s+/g, " ").match(/From .*?(Back|Confirm|Send)/)?.[0] ?? text.slice(0, 200));

  await backHome();
  await clickText("Move");
  await type('input[placeholder="0"]', "0.01");
  await clickText("Review");
  await waitFor(() => /Rings fee/.test(document.body.innerText) || /Something went wrong|failed/i.test(document.body.innerText), "move review");
  text = await reviewText();
  await popup.screenshot({ path: join(SHOTS, "move-review.png") });
  check(/Rings fee \(0\.1%\)\s*0\.00001 SOL/.test(text) && /Network fee\s*0\.000005 SOL/.test(text) && !/Paid by Rings/.test(text), "popup Move review shows both fees", text.replace(/\s+/g, " ").match(/From .*?(Back|Confirm|Move)/)?.[0] ?? text.slice(0, 200));
  console.log(`screenshots in ${SHOTS}${treasuryTakesTest1 ? "" : " (the devnet treasury has no TEST1 account: public TEST1 sends carry no fee)"}`);
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
