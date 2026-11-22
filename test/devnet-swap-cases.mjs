// DEVNET ONLY (dev/serve.mjs on :3399): swaps into Public, sales from Public, refunds, and transfer-fee coins refused.
//   ONLY=public,sell,refund[,feecoin] FEE_COIN=<mint with a transfer fee> node test/devnet-swap-cases.mjs
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const puppeteer = createRequire(join(root, "../brand/video/package.json"))("puppeteer-core");
const pg = createRequire(join(root, "../web/package.json"))("pg");
const cft = join(root, ".devdata/chrome/chrome");
const chromePath = join(cft, readdirSync(cft).find((d) => d.startsWith("win64-")), "chrome-win64", "chrome.exe");
const phrase = readFileSync(join(root, ".devdata/devnet-phrase.txt"), "utf8").trim();
const dbUrl = readFileSync(join(root, "../web/.env.devnet.local"), "utf8").match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "");
const SOL = "11111111111111111111111111111111";
const TEST1 = "FF4iWENV2AA58SPN9yf77SZ9wuJkhHxDowM9hb3pjZzr";
const ONLY = (process.env.ONLY ?? "public,sell,refund").split(",");

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};

const profile = mkdtempSync(join(tmpdir(), "rings-swap-cases-"));
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: profile, args: ["--no-first-run"] });
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:3399/onboarding.html", { waitUntil: "load" });
  const bg = (msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const made = await bg({ type: "create", phrase, password: "swap-cases-test-1" });
  check(made?.ok, "wallet created in the harness");
  const pub = async () => Object.fromEntries(((await bg({ type: "balances" })).data ?? []).map((r) => [r.mint, BigInt(r.units)]));
  const priv = async () => Object.fromEntries(((await bg({ type: "privateBalances" })).data?.rows ?? []).map((r) => [r.mint, BigInt(r.units)]));
  const follow = async (id, rounds = 120) => {
    let view = null;
    for (let i = 0; i < rounds; i++) {
      view = (await bg({ type: "swapStatus", id })).data;
      if (view?.finished) break;
      await sleep(4000);
    }
    await bg({ type: "swapStatus", id }); // a repeat poll must not add a second Activity entry
    return view;
  };
  const activity = async (id0) => ((await bg({ type: "history" })).data ?? []).filter((h) => h.kind === "swapped" && h.at >= id0);
  const fmt = (u, d = 9) => (Number(u) / 10 ** d).toFixed(6);

  if (ONLY.includes("public")) {
    console.log("... a swap from Private delivered into Public");
    const t0 = Date.now();
    const [p0, v0] = [await pub(), await priv()];
    const r = await bg({ type: "swap", from: "private", inMint: SOL, outMint: TEST1, amount: "0.003", slippageBps: 300, receiveInto: "wallet" });
    check(r?.ok, "swap into Public started", r?.ok ? r.data.id.slice(0, 8) : r?.error);
    const view = r?.ok ? await follow(r.data.id) : null;
    await sleep(3000);
    const [p1, v1] = [await pub(), await priv()];
    const gotPublic = (p1[TEST1] ?? 0n) - (p0[TEST1] ?? 0n);
    const gotPrivate = (v1[TEST1] ?? 0n) - (v0[TEST1] ?? 0n);
    const spentSol = (v0[SOL] ?? 0n) - (v1[SOL] ?? 0n);
    check(view?.finished === "done" && gotPublic > 0n && gotPrivate === 0n, "the coin landed in the public address, not the private balance", `+${fmt(gotPublic, 9)} TEST1 public, private SOL -${fmt(spentSol)}`);
    const acts = await activity(t0);
    check(acts.length === 1 && acts[0].balance === "public" && acts[0].status === "done", "Activity shows it once, under Public", acts.map((a) => `${a.amount} ${a.sym} ${a.balance} ${a.status}`).join("; "));
  }

  if (ONLY.includes("sell")) {
    console.log("... selling a coin from Public back to SOL, into Private");
    const t0 = Date.now();
    const [p0, v0] = [await pub(), await priv()];
    const units = (p0[TEST1] ?? 0n) / 2n;
    if (units === 0n) check(false, "the public address holds TEST1 to sell", "none");
    else {
      const amount = (Number(units) / 1e9).toFixed(9);
      const r = await bg({ type: "swap", from: "public", inMint: TEST1, outMint: SOL, amount, slippageBps: 300, receiveInto: "private" });
      check(r?.ok, "sale started", r?.ok ? `${amount} TEST1, ${r.data.id.slice(0, 8)}` : r?.error);
      const view = r?.ok ? await follow(r.data.id) : null;
      await sleep(3000);
      const [p1, v1] = [await pub(), await priv()];
      // Only Private's shortfall moves in from Public, so the coin sold is counted across both balances.
      const soldPublic = (p0[TEST1] ?? 0n) - (p1[TEST1] ?? 0n);
      const soldAll = soldPublic + ((v0[TEST1] ?? 0n) - (v1[TEST1] ?? 0n));
      const solPrivate = (v1[SOL] ?? 0n) - (v0[SOL] ?? 0n);
      // units / 1000n: the 0.1% Rings fee leaves with the coin sold.
      check(view?.finished === "done" && soldAll === units + units / 1000n && Number(view?.out ?? 0) > 0, "the coin was sold with its 0.1% fee (what Private lacked moved in from Public) and SOL arrived in Private", `-${fmt(soldAll, 9)} TEST1 (-${fmt(soldPublic, 9)} from Public), got ${view?.out} SOL, private SOL ${solPrivate >= 0n ? "+" : ""}${fmt(solPrivate)} after costs, ${view?.state} ${view?.error ?? ""}`);
      const acts = await activity(t0);
      check(acts.filter((a) => a.status === "done").length === 1, "Activity shows the sale once", acts.map((a) => `${a.amount} ${a.sym} ${a.status}`).join("; "));
    }
  }

  if (ONLY.includes("feecoin")) {
    console.log("... a coin with a transfer fee");
    const fee = process.env.FEE_COIN;
    if (!fee) check(false, "FEE_COIN is set", "none");
    else {
      const [p0, v0] = [await pub(), await priv()];
      const buy = await bg({ type: "swapQuote", from: "private", inMint: SOL, outMint: fee, amount: "0.002", slippageBps: 300, receiveInto: "private" });
      check(!buy?.ok && buy.code === "cantBePrivate" && /fee on every transfer/.test(buy.error) && /Choose Public/.test(buy.error), "buying it into Private is refused at the quote, saying why and what to do", buy?.error ?? "it quoted");
      const sell = await bg({ type: "swap", from: "public", inMint: fee, outMint: SOL, amount: "1", slippageBps: 300, receiveInto: "private" });
      check(!sell?.ok && sell.code === "cantBePrivate" && /paid from the private balance/.test(sell.error), "selling it from Public is refused before anything moves", sell?.error ?? "it went ahead");
      const [p1, v1] = [await pub(), await priv()];
      check(p1[fee] === p0[fee] && p1[SOL] === p0[SOL] && v1[SOL] === v0[SOL], "nothing moved", `public ${p1[fee]} of the coin`);
    }
  }

  if (ONLY.includes("refund")) {
    console.log("... a swap that fails after it was paid");
    const t0 = Date.now();
    const v0 = await priv();
    // Force a failure: raise the new swap's min_out in the DB while Rings is still funding its key.
    let tampered = null;
    const watcher = (async () => {
      for (let i = 0; i < 240 && !tampered; i++) {
        const { rows } = await db.query("select id, state from dex_swaps where created_at > to_timestamp($1 / 1000.0) order by created_at desc limit 1", [t0]);
        if (rows[0] && ["quoted", "paid", "funded"].includes(rows[0].state)) {
          await db.query("update dex_swaps set min_out = '999999999999999999' where id = $1", [rows[0].id]);
          tampered = rows[0];
        }
        await sleep(250);
      }
    })();
    const r = await bg({ type: "swap", from: "private", inMint: SOL, outMint: TEST1, amount: "0.002", slippageBps: 300, receiveInto: "private" });
    await watcher;
    check(r?.ok && tampered?.id === r.data.id, "swap paid, and its minimum raised before Rings made it", tampered ? `raised while ${tampered.state}` : r?.error ?? "not found");
    const paidSol = (v0[SOL] ?? 0n) - ((await priv())[SOL] ?? 0n);
    const view = r?.ok ? await follow(r.data.id, 150) : null;
    const row = r?.ok ? (await db.query("select state, attempts, error, refund_sig from dex_swaps where id = $1", [r.data.id])).rows[0] : null;
    await sleep(4000);
    const v1 = await priv();
    const lost = (v0[SOL] ?? 0n) - (v1[SOL] ?? 0n);
    check(view?.finished === "failed" && row?.state === "refunded" && /refunded/.test(view?.error ?? ""), "Rings gave up and refunded; the wallet says so", `${row?.state}, ${row?.attempts} tries, "${view?.error}"`);
    check(lost > 0n && lost < 200_000n, "the private balance got the payment back, less Rings' network costs and the 0.1% fee", `paid ${fmt(paidSol)} SOL, net cost ${fmt(lost)} SOL`);
    const acts = await activity(t0);
    check(acts.length === 1 && acts[0].status === "failed", "Activity shows the failed swap once", acts.map((a) => `${a.status}: ${a.error ?? ""}`).join("; "));
  }
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  await db.end().catch(() => undefined);
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
