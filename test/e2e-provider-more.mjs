// Devnet e2e: sign-and-send, several transactions per request, and account switches, locks and approvals across
// background sleep. Run: node test/e2e-provider-more.mjs. Spends a few thousand devnet lamports.
import { lookAt } from "./e2e-person.mjs";
import { createServer } from "node:http";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const PASSWORD = "e2e-more-password-1";
const RPC = "http://localhost:3101/api/helius/rpc";
const ONLY = process.env.ONLY ?? ""; // e.g. ONLY=sleep runs the setup and the sleep checks only

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`... ${m}`);
process.on("unhandledRejection", (e) => console.log("UNHANDLED", e?.message ?? e));
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};
const want = (part) => !ONLY || ONLY.split(",").includes(part);

const rpc = async (method, params) => {
  const j = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const { compileTransaction, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, pipe, address: addr, getBase64EncodedWireTransaction } = kit;
const transfer = (from, to, lamports) => ({
  programAddress: addr("11111111111111111111111111111111"),
  accounts: [{ address: addr(from), role: 3 }, { address: addr(to), role: 1 }],
  data: (() => {
    const d = new Uint8Array(12);
    d[0] = 2;
    new DataView(d.buffer).setBigUint64(4, BigInt(lamports), true);
    return d;
  })(),
});
const txOf = async (payer, ixs) => {
  const bh = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (x) => setTransactionMessageFeePayer(addr(payer), x),
      (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.value.blockhash, lastValidBlockHeight: BigInt(bh.value.lastValidBlockHeight) }, x),
      (x) => appendTransactionMessageInstructions(ixs, x),
    ),
  );
};
const landed = async (signature, ms = 40000) => {
  for (let t = 0; t < ms; t += 1500) {
    const st = (await rpc("getSignatureStatuses", [[signature]])).value[0];
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return st.err ? `failed ${JSON.stringify(st.err)}` : "confirmed";
    await sleep(1500);
  }
  return "not seen";
};
const b58 = (bytes) => kit.getBase58Decoder().decode(Uint8Array.from(bytes));

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

const isWorker = (t) => {
  const type = typeof t.type === "function" ? t.type() : t.type;
  const url = typeof t.url === "function" ? t.url() : t.url;
  return type === "service_worker" && String(url).startsWith(`chrome-extension://${EXT}/`);
};
const profile = mkdtempSync(join(tmpdir(), "rings-wallet-e2e-more-"));
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  userDataDir: profile,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-first-run", "--no-default-browser-check"],
  targetFilter: (t) => !isWorker(t), // an attached debugger would keep the worker awake
});

try {
  const bcdp = await browser.target().createCDPSession();
  const awake = async () => (await bcdp.send("Target.getTargets")).targetInfos.some(isWorker);
  /** Waits for Chrome to stop the idle worker; returns the ms it took, or null after `max` ms. */
  const waitAsleep = async (max = 150000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < max) {
      if (!(await awake())) return Date.now() - t0;
      await sleep(1000);
    }
    return null;
  };
  for (let i = 0; i < 40 && !(await awake()); i++) await sleep(500);
  check(await awake(), "extension loaded, its background running");

  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${EXT}/onboarding.html`);
  const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const made = await send({ type: "create", phrase, password: PASSWORD });
  check(made?.ok && made.data.unlocked, "wallet created from the devnet test phrase and unlocked", made?.error ?? "");
  const acc1 = made.data.accounts[0];
  const added = await send({ type: "addAccount" });
  const acc2 = added?.data?.accounts?.find((a) => a.id !== acc1.id);
  check(!!acc2?.address && !!acc1.id, "a second account added", acc2 ? acc2.name : JSON.stringify(added).slice(0, 120));
  await send({ type: "setActive", id: acc1.id });
  // Leave the extension page so an open page can't keep the worker awake.
  await ext.goto("about:blank");
  const sendFresh = async (msg) => {
    const p = await browser.newPage();
    try {
      await p.goto(`chrome-extension://${EXT}/onboarding.html`);
      return await p.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    } finally {
      await p.close();
    }
  };

  const seen = new Set();
  const nextWindow = async (timeout = 30000) => {
    const t = await browser.waitForTarget((x) => x.url().includes(`chrome-extension://${EXT}/approve.html`) && !seen.has(x), { timeout });
    seen.add(t);
    const p = await t.page();
    await p.waitForFunction(() => document.querySelectorAll("button").length > 0, { timeout: 30000 });
    // Its buttons ignore clicks until the window has been seen (src/ui/approve.tsx).
    await lookAt(p);
    return p;
  };
  const press = (p, label) =>
    p.evaluate((re) => {
      const b = [...document.querySelectorAll("button")].find((x) => new RegExp(re, "i").test(x.innerText.trim()) && !x.disabled);
      if (b) setTimeout(() => b.click(), 50);
      return b ? b.innerText.trim() : null;
    }, label);
  const approval = async (label) => {
    const p = await nextWindow();
    const text = await p.evaluate(() => document.body.innerText);
    await sleep(300);
    return { text, clicked: await press(p, label) };
  };

  step("connect the test site");
  const dapp = await browser.newPage();
  await dapp.goto("http://127.0.0.1:3398/");
  await dapp.waitForFunction(() => !!window.rings(), { timeout: 10000 });
  const connecting = dapp.evaluate(() => window.rings().features["standard:connect"].connect().then((r) => r.accounts.map((a) => a.address)));
  await approval("^connect$");
  check((await connecting)[0] === acc1.address, "connected with account 1");
  await dapp.evaluate(() => {
    window.__events = [];
    window.rings().features["standard:events"].on("change", (e) => window.__events.push((e.accounts ?? []).map((a) => a.address)));
  });
  const events = () => dapp.evaluate(() => window.__events.slice());

  if (want("send")) {
    step("signAndSendTransaction: one transaction");
    const one = await txOf(acc1.address, [transfer(acc1.address, acc2.address, 5000)]);
    const sending = dapp.evaluate(
      (b) => window.rings().features["solana:signAndSendTransaction"].signAndSendTransaction({ transaction: window.fromB64(b), chain: "solana:devnet", account: window.rings().accounts[0] }).then(([r]) => Array.from(r.signature), (e) => `refused ${e.code}: ${e.message}`),
      getBase64EncodedWireTransaction(one),
    );
    const w1 = await approval("^approve$");
    const r1 = await sending;
    const sig1 = Array.isArray(r1) ? b58(r1) : null;
    check(!!sig1 && w1.clicked === "Approve" && (await landed(sig1)) === "confirmed", "sign and send: approved, sent by the wallet, confirmed on devnet", sig1 ? sig1.slice(0, 10) : String(r1));

    step("signTransaction: three in one request");
    const three = await Promise.all([1, 2, 3].map((n) => txOf(acc1.address, [transfer(acc1.address, acc2.address, 1000 + n)])));
    const signingThree = dapp.evaluate(
      (list) => window.rings().features["solana:signTransaction"].signTransaction(...list.map((b) => ({ transaction: window.fromB64(b) }))).then((rs) => rs.map((r) => window.b64(r.signedTransaction)), (e) => `refused ${e.code}: ${e.message}`),
      three.map((t) => getBase64EncodedWireTransaction(t)),
    );
    const w3 = await approval("^approve$");
    await sleep(1500);
    const extra = (await browser.targets()).filter((x) => x.url().includes("approve.html")).length;
    const r3 = await signingThree;
    const pub1 = kit.getAddressEncoder().encode(addr(acc1.address));
    const allSigned = Array.isArray(r3) && r3.length === 3 && r3.every((b, i) => ed25519.verify(Buffer.from(b, "base64").subarray(1, 65), three[i].messageBytes, pub1));
    check(allSigned && extra === 0, "three transactions in one request: one window, all three signed", `the window says: ${w3.text.split("\n").filter((l) => /transaction|sol\b/i.test(l)).slice(0, 4).join(" | ")}`);

    step("signAndSendTransaction: two in one call");
    const two = await Promise.all([1, 2].map((n) => txOf(acc1.address, [transfer(acc1.address, acc2.address, 2000 + n)])));
    const sendingTwo = dapp.evaluate(
      (list) => window.rings().features["solana:signAndSendTransaction"].signAndSendTransaction(...list.map((b) => ({ transaction: window.fromB64(b) }))).then((rs) => rs.map((r) => Array.from(r.signature)), (e) => `refused ${e.code}: ${e.message}`),
      two.map((t) => getBase64EncodedWireTransaction(t)),
    );
    let windows = 0;
    for (let i = 0; i < 2; i++) {
      const w = await approval("^approve$").catch(() => null);
      if (w?.clicked) windows++;
    }
    const r2 = await sendingTwo;
    const sigs2 = Array.isArray(r2) ? r2.map(b58) : [];
    const states2 = await Promise.all(sigs2.map((s) => landed(s)));
    check(sigs2.length === 2 && states2.every((s) => s === "confirmed"), "sign and send two in one call: both sent and confirmed", `${windows} approval window(s), ${states2.join(", ") || String(r2)}`);
  }

  if (want("switch")) {
    step("switching account while connected, background awake");
    let n = (await events()).length;
    await sendFresh({ type: "setActive", id: acc2.id });
    await sleep(2500);
    let ev = (await events()).slice(n);
    check(ev.length > 0 && ev.at(-1).length === 0, "switching to an account the site isn't connected to tells the site (no account)", JSON.stringify(ev));
    n = (await events()).length;
    await sendFresh({ type: "setActive", id: acc1.id });
    await sleep(2500);
    ev = (await events()).slice(n);
    check(ev.length > 0 && ev.at(-1)[0] === acc1.address, "switching back tells the site account 1 again", JSON.stringify(ev));
  }

  if (want("sleep")) {
    step("waiting for Chrome to put the background to sleep (nothing to do)");
    const slept = await waitAsleep();
    check(slept !== null, "Chrome stops the wallet's background when idle, as it does for everyone", slept === null ? "still running after 150 s" : `${Math.round(slept / 1000)} s`);

    step("switching account after the background slept");
    let n = (await events()).length;
    await sendFresh({ type: "setActive", id: acc2.id });
    await sleep(3000);
    let ev = (await events()).slice(n);
    check(ev.length > 0 && ev.at(-1).length === 0, "after the background slept, the site is still told about an account switch", JSON.stringify(ev));
    n = (await events()).length;
    await sendFresh({ type: "setActive", id: acc1.id });
    await sleep(3000);
    ev = (await events()).slice(n);
    check(ev.length > 0 && ev.at(-1)[0] === acc1.address, "and about the switch back", JSON.stringify(ev));

    step("a lock after the background slept, then unlocking");
    const slept2 = await waitAsleep();
    n = (await events()).length;
    await sendFresh({ type: "lock" });
    await sleep(3000);
    ev = (await events()).slice(n);
    check(slept2 !== null && ev.length > 0 && ev.at(-1).length === 0, "a lock after the background slept tells the site (no account)", JSON.stringify(ev));
    n = (await events()).length;
    const un = await sendFresh({ type: "unlock", password: PASSWORD });
    await sleep(3000);
    ev = (await events()).slice(n);
    check(un?.ok && ev.length > 0 && ev.at(-1)[0] === acc1.address, "unlocking gives the connected site its account back", JSON.stringify(ev));

    step("an approval left open for a minute");
    const reading = dapp.evaluate(() => window.rings().features["solana:signMessage"].signMessage({ message: new TextEncoder().encode("Read me slowly") }).then(() => "signed", (e) => `refused ${e.code}: ${e.message}`));
    const w = await nextWindow();
    const t0 = Date.now();
    const asleep = await waitAsleep(60000);
    const readFor = Math.round((Date.now() - t0) / 1000);
    const clicked = await press(w, "^(sign|approve)$");
    const answer = await Promise.race([reading, sleep(15000).then(() => "no answer 15 s after the click")]);
    check(
      answer === "signed",
      "an approval read slowly still answers the site",
      `${asleep === null ? `background stayed awake for ${readFor} s with the window open` : `background slept after ${Math.round(asleep / 1000)} s with the window open`}; clicked ${clicked}; site got: ${answer}`,
    );

    step("the background stopped by force while an approval is open (a crash, an update)");
    const cut = dapp.evaluate(() => window.rings().features["solana:signMessage"].signMessage({ message: new TextEncoder().encode("Cut off") }).then(() => "signed", (e) => `refused ${e.code}: ${e.message}`));
    const cw = await nextWindow();
    const sw = await cw.createCDPSession();
    await sw.send("ServiceWorker.enable");
    await sw.send("ServiceWorker.stopAllWorkers");
    const stopped = (await waitAsleep(10000)) !== null;
    const cutAnswer = await Promise.race([cut, sleep(8000).then(() => "no answer")]);
    check(!stopped || /stopped before answering/.test(cutAnswer), "if the background stops anyway, the site gets an error at once instead of waiting forever", stopped ? cutAnswer : "couldn't stop it by force: not checked");
    await cw.close().catch(() => undefined);

    step("the site asks again after all that");
    const again = dapp.evaluate(() => window.rings().features["solana:signMessage"].signMessage({ message: new TextEncoder().encode("Still working?") }).then(() => "signed", (e) => `refused ${e.code}: ${e.message}`));
    const a = await approval("^(sign|approve)$").catch((e) => ({ clicked: null, text: e.message }));
    const againAnswer = await Promise.race([again, sleep(15000).then(() => "no answer")]);
    check(againAnswer === "signed", "a new request after the background slept works", `${a.clicked}; ${againAnswer}`);
  }
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
