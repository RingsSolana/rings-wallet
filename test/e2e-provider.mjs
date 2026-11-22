// Devnet e2e of site connections: a test site and the local devnet rings.run (:3101) use dist/ in Chrome for Testing.
// Run: node test/e2e-provider.mjs. Prints PASS/FAIL lines only, never the phrase.
import { createServer } from "node:http";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { lookAt } from "./e2e-person.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, "../brand/video/package.json"));
const puppeteer = require("puppeteer-core");
const { ed25519 } = await import("@noble/curves/ed25519");
const kit = await import("@solana/kit");
const dist = join(root, "dist");
const cft = join(root, ".devdata/chrome/chrome");
const chromePath = join(cft, readdirSync(cft).find((d) => d.startsWith("win64-")), "chrome-win64", "chrome.exe");
const phrase = readFileSync(join(root, ".devdata/devnet-phrase.txt"), "utf8").trim();
const EXT = "polncinkggpfflechknjkjokigacghgj";
const PASSWORD = "e2e-test-password-1";

let failures = 0;
const step = (m) => console.log(`... ${m}`);
process.on("unhandledRejection", (e) => console.log("UNHANDLED", e?.message ?? e));
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};

const DAPP = `<!doctype html><html><body><h1>Test site</h1><script>
window.__wallets = [];
const api = { register: (...ws) => { for (const w of ws) window.__wallets.push(w); return () => {}; } };
window.addEventListener("wallet-standard:register-wallet", (e) => e.detail(api));
window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
window.rings = () => window.__wallets.find((w) => w.name === "Rings");
window.b64 = (u8) => btoa(String.fromCharCode(...u8));
window.fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
</script></body></html>`;
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(DAPP);
}).listen(3398, "127.0.0.1");

const profile = mkdtempSync(join(tmpdir(), "rings-wallet-e2e-"));
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  userDataDir: profile,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-first-run", "--no-default-browser-check"],
});

try {
  // The background answers only the extension's own pages, so the wallet is set up from one.
  const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${EXT}/`), { timeout: 20000 });
  check(!!worker, "extension loaded with its fixed id");
  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${EXT}/onboarding.html`);
  const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  step("creating the wallet");
  const made = await send({ type: "create", phrase, password: PASSWORD });
  step("created: " + JSON.stringify({ ok: made?.ok, error: made?.error }));
  check(made?.ok && made.data.unlocked, "wallet created from the devnet test phrase and unlocked");
  const address = made.data.accounts[0].address;
  const pub = kit.getAddressEncoder().encode(kit.address(address));

  // Approval windows: wait for the next one, read it, run `first` in it if given, then press a button.
  const seen = new Set();
  const nextWindow = async () => {
    const t = await browser.waitForTarget((x) => x.url().includes(`chrome-extension://${EXT}/approve.html`) && !seen.has(x), { timeout: 30000 });
    seen.add(t);
    const p = await t.page();
    await p.waitForFunction(() => document.querySelectorAll("button").length > 0, { timeout: 30000 });
    // Its buttons ignore clicks until the window has been seen (src/ui/approve.tsx).
    await lookAt(p);
    return p;
  };
  const approval = async (label, first) => {
    const p = await nextWindow();
    const text = await p.evaluate(() => document.body.innerText);
    if (first) await p.evaluate(first);
    await new Promise((r) => setTimeout(r, 300));
    const clicked = await p.evaluate((re) => {
      const b = [...document.querySelectorAll("button")].find((x) => new RegExp(re, "i").test(x.innerText.trim()) && !x.disabled);
      // Click on a timer: the click closes the window, which would cut this evaluate() short.
      if (b) setTimeout(() => b.click(), 50);
      return b ? b.innerText.trim() : null;
    }, label);
    return { text, clicked };
  };
  const windowsOpen = async () => (await browser.targets()).filter((x) => x.url().includes("approve.html")).length;

  step("opening the test site");
  const dapp = await browser.newPage();
  await dapp.goto("http://127.0.0.1:3398/");
  await dapp.waitForFunction(() => !!window.rings(), { timeout: 10000 });
  check(true, "the test site sees a wallet named Rings (Wallet Standard)");

  step("connect");
  const connecting = dapp.evaluate(() => window.rings().features["standard:connect"].connect().then((r) => r.accounts.map((a) => a.address)));
  const c = await approval("^connect$");
  check(/127\.0\.0\.1:3398/.test(c.text) && /wants to connect/i.test(c.text), "connect window names the real site", c.clicked ?? "no button");
  const accounts = await connecting;
  check(accounts[0] === address, "connected with the main address");

  const sites = await send({ type: "sites" });
  const plain = await ext.evaluate(() => chrome.storage.local.get(null).then((all) => JSON.stringify(all)));
  check(sites?.ok && sites.data.some((s) => s.domain === "127.0.0.1:3398") && !plain.includes("127.0.0.1:3398"), "the connected site is listed, and kept only inside the encrypted vault");

  step("reject");
  const rejecting = dapp.evaluate(() => window.rings().features["solana:signMessage"].signMessage({ message: new TextEncoder().encode("Please reject me") }).then(() => "signed", (e) => `refused ${e.code}`));
  const rj = await approval("^reject$");
  check((await rejecting) === "refused 4001" && rj.clicked === "Reject", "Reject answers no and closes the window");

  step("lock while a request waits");
  const waiting = dapp.evaluate(() => window.rings().features["solana:signMessage"].signMessage({ message: new TextEncoder().encode("Still there?") }).then(() => "signed", (e) => `refused ${e.code}`));
  await nextWindow();
  await send({ type: "lock" });
  const lockedAnswer = await waiting;
  await new Promise((r) => setTimeout(r, 800));
  check(lockedAnswer === "refused 4001" && (await windowsOpen()) === 0, "locking the wallet answers no to a waiting request and closes its window");

  step("locked: only a click opens the unlock window");
  const unlockWindows = async () => (await browser.targets()).filter((x) => x.url().includes("popup.html") && x.url().includes("#unlock"));
  // evaluate() counts as a user gesture, so call from a 6 s timer, after Chrome's 5 s transient activation expires.
  const t0 = Date.now();
  const quiet = await dapp.evaluate(
    () =>
      new Promise((done) =>
        setTimeout(() => window.rings().features["solana:signMessage"].signMessage({ message: new TextEncoder().encode("on a timer") }).then(() => done("signed"), (e) => done(`refused ${e.code}`)), 6000),
      ),
  );
  const quietMs = Date.now() - t0 - 6000;
  await new Promise((r) => setTimeout(r, 800));
  // 4100: not connected; -32002: a short wait after the person refused this site.
  check(/^refused (4100|-32002)$/.test(quiet) && quietMs < 2000 && (await unlockWindows()).length === 0, "a site's own call while locked is refused at once, and no window opens", `${quiet}, ${quietMs} ms`);
  await dapp.evaluate(() => {
    const b = document.createElement("button");
    b.id = "ask";
    b.textContent = "Ask";
    b.onclick = () => {
      window.__asked = window.rings().features["solana:signMessage"].signMessage({ message: new TextEncoder().encode("after a click") }).then(() => "signed", (e) => `refused ${e.code}`);
    };
    document.body.append(b);
  });
  await dapp.click("#ask");
  const unlockTarget = await browser.waitForTarget((x) => x.url().includes("popup.html") && x.url().includes("#unlock"), { timeout: 10000 }).catch(() => null);
  const unlockPage = unlockTarget ? await unlockTarget.page() : null;
  if (unlockPage) await unlockPage.waitForFunction(() => /unlock for/.test(document.title), { timeout: 5000 }).catch(() => undefined);
  const unlockTitle = unlockPage ? await unlockPage.title() : "";
  check(!!unlockTarget && /unlock for 127\.0\.0\.1:3398/.test(unlockTitle), "a call right after a click opens the unlock window, titled with the site", unlockTitle || "no window");
  const reopened = await send({ type: "unlock", password: PASSWORD });
  check(reopened?.ok && reopened.data.unlocked, "unlocked again");
  const after = await approval("^reject$");
  check((await dapp.evaluate(() => window.__asked)) === "refused 4001" && after.clicked === "Reject", "once unlocked, the clicked request goes on to its approval window");

  step("message");
  const msgSigning = dapp.evaluate(() => window.rings().features["solana:signMessage"].signMessage({ message: new TextEncoder().encode("Hello from the test site") }).then(([r]) => window.b64(r.signature)));
  const m = await approval("^(sign|approve)");
  const sig = Buffer.from(await msgSigning, "base64");
  check(/Hello from the test site/.test(m.text) && ed25519.verify(sig, new TextEncoder().encode("Hello from the test site"), pub), "message shown and signed", m.clicked ?? "");

  const keyMsg = `Rings key v1\n\nDomain: localhost:3101\nWallet: ${address}\n\nSign to unlock your Rings keys on this device.\nThis signature stays in your browser and moves no funds.\nNever sign this message on any other site.`;
  const phish = dapp.evaluate((t) => window.rings().features["solana:signMessage"].signMessage({ message: new TextEncoder().encode(t) }).then(() => "signed", (e) => `refused ${e.code}`), keyMsg);
  const ph = await approval("^close$");
  check((await phish) === "refused 4001" && ph.clicked === "Close", "Rings key message refused for another site");

  const { compileTransaction, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, pipe, address: addr, getBase64EncodedWireTransaction } = kit;
  const bh = await (await fetch("http://localhost:3101/api/helius/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }) })).json();
  const transfer = { programAddress: addr("11111111111111111111111111111111"), accounts: [{ address: addr(address), role: 3 }, { address: addr(address), role: 1 }], data: (() => { const d = new Uint8Array(12); d[0] = 2; new DataView(d.buffer).setBigUint64(4, 1n, true); return d; })() };
  const tx = compileTransaction(pipe(createTransactionMessage({ version: 0 }), (x) => setTransactionMessageFeePayer(addr(address), x), (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.result.value.blockhash, lastValidBlockHeight: BigInt(bh.result.value.lastValidBlockHeight) }, x), (x) => appendTransactionMessageInstructions([transfer], x)));
  const wireB64 = getBase64EncodedWireTransaction(tx);
  const messageB64 = Buffer.from(tx.messageBytes).toString("base64");
  const disguised = dapp.evaluate((b) => window.rings().features["solana:signMessage"].signMessage({ message: window.fromB64(b) }).then(() => "signed", (e) => `refused ${e.code}`), messageB64);
  const dz = await approval("^close$");
  check((await disguised) === "refused 4001" && /looks like a transaction/i.test(dz.text), "transaction passed off as a message refused");

  const signing = dapp.evaluate((b) => window.rings().features["solana:signTransaction"].signTransaction({ transaction: window.fromB64(b) }).then(([r]) => window.b64(r.signedTransaction)), wireB64);
  const t = await approval("^approve$");
  const signedB64 = await Promise.race([signing, new Promise((r) => setTimeout(() => r(null), 30000))]);
  if (signedB64 === null) throw new Error(`no answer 30 s after the approval (clicked: ${t.clicked}; the window said: ${t.text.replace(/\s+/g, " ").slice(0, 400)})`);
  const signedTx = Buffer.from(signedB64, "base64");
  const sigBytes = signedTx.subarray(1, 65);
  check(/approve transaction/i.test(t.text) && ed25519.verify(sigBytes, tx.messageBytes, pub), "transaction previewed, approved and signed", t.text.match(/-?[d.]+ SOL/)?.[0] ?? "");

  // Assign changes no balance, so only the danger check can catch it.
  const assignData = new Uint8Array(36);
  assignData[0] = 1; // System: Assign
  assignData.set(kit.getAddressEncoder().encode(addr("Stake11111111111111111111111111111111111111")), 4);
  const assign = { programAddress: addr("11111111111111111111111111111111"), accounts: [{ address: addr(address), role: 3 }], data: assignData };
  const assignTx = compileTransaction(pipe(createTransactionMessage({ version: 0 }), (x) => setTransactionMessageFeePayer(addr(address), x), (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.result.value.blockhash, lastValidBlockHeight: BigInt(bh.result.value.lastValidBlockHeight) }, x), (x) => appendTransactionMessageInstructions([assign], x)));
  const risky = dapp.evaluate((b) => window.rings().features["solana:signTransaction"].signTransaction({ transaction: window.fromB64(b) }).then(() => "signed", (e) => `refused ${e.code}`), getBase64EncodedWireTransaction(assignTx));
  const rp = await nextWindow();
  const riskText = await rp.evaluate(() => document.body.innerText);
  const approveLocked = await rp.evaluate(() => [...document.querySelectorAll("button")].find((x) => /^approve$/i.test(x.innerText.trim()))?.disabled ?? null);
  await rp.evaluate(() => void setTimeout(() => [...document.querySelectorAll("button")].find((x) => /^reject$/i.test(x.innerText.trim()))?.click(), 50));
  check(/understand the risk/i.test(riskText) && /hand your account to another program/i.test(riskText) && approveLocked === true && (await risky) === "refused 4001", "a transaction handing the account to another program shows why, and needs \"I understand the risk\"");

  const wrongDomain = dapp.evaluate(() => window.rings().features["solana:signIn"].signIn({ domain: "jup-claim.io", statement: "Sign in" }).then(() => "signed", (e) => `refused ${e.code}`));
  const wd = await approval("^close$");
  check((await wrongDomain) === "refused 4001" && /jup-claim\.io/.test(wd.text), "sign-in for another domain refused");

  const signingIn = dapp.evaluate(() => window.rings().features["solana:signIn"].signIn({ statement: "Welcome", nonce: "abc12345" }).then(([r]) => ({ text: new TextDecoder().decode(r.signedMessage), sig: window.b64(r.signature), account: r.account.address })));
  await approval("^sign in$");
  const si = await signingIn;
  check(si.text.startsWith("127.0.0.1:3398 wants you to sign in with your Solana account:") && si.account === address && ed25519.verify(Buffer.from(si.sig, "base64"), new TextEncoder().encode(si.text), pub), "sign-in uses the real domain and verifies");

  await dapp.evaluate(() => window.rings().features["standard:disconnect"].disconnect());
  const silent = await dapp.evaluate(() => window.rings().features["standard:connect"].connect({ silent: true }).then(() => "connected", (e) => `refused ${e.code}`));
  check(silent === "refused 4100", "after disconnect the site is no longer connected");

  step("devnet rings.run opened by hand");
  const site = await browser.newPage();
  await site.goto("http://localhost:3101/", { waitUntil: "domcontentloaded" });
  await site.evaluate(() => {
    window.__wallets = [];
    const api = { register: (...ws) => { for (const w of ws) window.__wallets.push(w); return () => {}; } };
    window.addEventListener("wallet-standard:register-wallet", (e) => e.detail(api));
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  });
  const ringsConnecting = site.evaluate(() => window.__wallets.find((w) => w.name === "Rings").features["standard:connect"].connect().then((r) => r.accounts.map((a) => a.address)));
  const rc = await approval("^connect$");
  const ringsAccounts = await ringsConnecting;
  await new Promise((r) => setTimeout(r, 1500)); // let the connect window close
  const keyWindowsBefore = await windowsOpen();
  const keySig = await site.evaluate((t) => window.__wallets.find((w) => w.name === "Rings").features["solana:signMessage"].signMessage({ message: new TextEncoder().encode(t) }).then(([r]) => btoa(String.fromCharCode(...r.signature))), keyMsg);
  const expected = ed25519.verify(Buffer.from(keySig, "base64"), new TextEncoder().encode(keyMsg), pub);
  check(ringsAccounts[0] === address && expected && rc.clicked === "Connect" && (await windowsOpen()) === keyWindowsBefore, "devnet rings.run opened by hand: connecting asks once, then the Rings key is given with no window", `account ${ringsAccounts[0] === address}, key ${expected}, clicked ${rc.clicked}, windows ${keyWindowsBefore}`);
  await send({ type: "lock" });
  const lockedKey = await site.evaluate((t) => new Promise((done) => setTimeout(() => window.__wallets.find((w) => w.name === "Rings").features["solana:signMessage"].signMessage({ message: new TextEncoder().encode(t) }).then(() => done("signed"), (e) => done(`refused ${e.code}`)), 6000)), keyMsg);
  check(lockedKey !== "signed", "while the wallet is locked, a Rings site gets no Rings key", lockedKey);
  check((await send({ type: "unlock", password: PASSWORD }))?.ok, "unlocked again");

  step("a Rings site with a fresh address");
  const launch = await browser.newPage();
  await launch.goto("http://launch.localhost:3101/", { waitUntil: "domcontentloaded", timeout: 180000 });
  await launch.evaluate(() => {
    window.__wallets = [];
    const api = { register: (...ws) => { for (const w of ws) window.__wallets.push(w); return () => {}; } };
    window.addEventListener("wallet-standard:register-wallet", (e) => e.detail(api));
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  });
  const freshConnecting = launch.evaluate(() => window.__wallets.find((w) => w.name === "Rings").features["standard:connect"].connect().then((r) => r.accounts.map((a) => a.address)));
  await approval("^connect$", () => [...document.querySelectorAll("button")].find((b) => /Fresh address for this site/.test(b.innerText))?.click());
  const [freshAddress] = await freshConnecting;
  const freshKeyMsg = keyMsg.replace(`Wallet: ${address}`, `Wallet: ${freshAddress}`);
  const freshSig = await launch.evaluate((t) => window.__wallets.find((w) => w.name === "Rings").features["solana:signMessage"].signMessage({ message: new TextEncoder().encode(t) }).then(([r]) => btoa(String.fromCharCode(...r.signature)), (e) => `refused ${e.code}`), freshKeyMsg);
  const freshPub = kit.getAddressEncoder().encode(kit.address(freshAddress));
  const freshOk = !freshSig.startsWith("refused") && ed25519.verify(Buffer.from(freshSig, "base64"), new TextEncoder().encode(freshKeyMsg), freshPub);
  const crossKey = launch.evaluate((t) => window.__wallets.find((w) => w.name === "Rings").features["solana:signMessage"].signMessage({ message: new TextEncoder().encode(t) }).then(() => "signed", (e) => `refused ${e.code}`), keyMsg);
  const ck = await approval("^close$");
  check(freshAddress !== address && freshOk && (await crossKey) === "refused 4001" && /Rings key of another address/.test(ck.text), "a Rings site with a fresh address gets its own Rings key, signed by the fresh key, and never the main address's");

  step("rings.run (devnet desk) opened from Products");
  const warm = await browser.newPage(); // warm-up: the dev server's first compile must not eat the 2-minute Products window
  await warm.goto("http://otc.localhost:3101/", { waitUntil: "load", timeout: 180000 }).catch(() => undefined);
  await warm.close();
  const windowsBefore = await windowsOpen();
  const opened = await send({ type: "openProduct", product: "otc" });
  const deskTarget = await browser.waitForTarget((x) => x.url().startsWith("http://otc.localhost:3101/") && x.url().includes("wallet=Rings"), { timeout: 30000 });
  const desk = await deskTarget.page();
  let signedIn = null;
  for (let i = 0; i < 60 && signedIn !== address; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    signedIn = await desk.evaluate(() => fetch("/api/auth/session").then((r) => r.json()).then((j) => j.wallet).catch(() => null)).catch(() => null);
  }
  const windowsAfter = await windowsOpen();
  check(opened?.ok && signedIn === address && windowsAfter === windowsBefore, "the desk opened from Products signed in as the wallet on arrival, no prompt", String(signedIn).slice(0, 8));
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
