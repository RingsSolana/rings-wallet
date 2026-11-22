// DEVNET ONLY: Activity lists swaps and payments signed on websites, and shows a wallet swap into Public only once.
// Needs dev/serve.mjs on :3399 and the devnet copy on :3101.   npx tsx test/devnet-site-activity.ts
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountSecret, phraseSeed } from "../src/lib/keys";

const rootPath = decodeURIComponent(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const puppeteer = createRequire(new URL("../../brand/video/package.json", import.meta.url))("puppeteer-core");
const web = createRequire(new URL("../../web/package.json", import.meta.url));
const w3 = web("@solana/web3.js");
const spl = web("@solana/spl-token");
const cft = join(rootPath, ".devdata/chrome/chrome");
const chromePath = join(cft, readdirSync(cft).find((d) => d.startsWith("win64-"))!, "chrome-win64", "chrome.exe");
const phrase = readFileSync(join(rootPath, ".devdata/devnet-phrase.txt"), "utf8").trim();
const conn = new w3.Connection("http://localhost:3101/api/helius/rpc", { commitment: "confirmed", wsEndpoint: "ws://127.0.0.1:1" });
const COIN = new w3.PublicKey("2TNM2RdoE9WdFLexFdiLQPGi8WwnMXENvLDen474qstW"); // plain Token-2022, 6 decimals
const SOL = "11111111111111111111111111111111";
const TEST1 = "FF4iWENV2AA58SPN9yf77SZ9wuJkhHxDowM9hb3pjZzr";

let failures = 0;
const check = (ok: boolean, label: string, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seed = phraseSeed(phrase);
const a1 = w3.Keypair.fromSeed(accountSecret(seed, 0));
const a2 = w3.Keypair.fromSeed(accountSecret(seed, 1));
async function send(tx: InstanceType<typeof w3.Transaction>, signers: unknown[]) {
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = a1.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize());
  for (let i = 0; i < 40; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig as string;
    await sleep(1500);
  }
  throw new Error("not confirmed");
}

const profile = mkdtempSync(join(tmpdir(), "rings-site-activity-"));
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: profile, args: ["--no-first-run"] });
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:3399/onboarding.html", { waitUntil: "load" });
  const bg = (msg: unknown) => page.evaluate(((m: unknown) => chrome.runtime.sendMessage(m)) as never, msg) as Promise<{ ok: boolean; data?: any; error?: string }>;
  check(!!(await bg({ type: "create", phrase, password: "site-activity-1" }))?.ok, "wallet created in the harness");
  await bg({ type: "history" }); // the first scan takes in what's already on chain

  // Mimics a site swap: SOL out and the coin back in one transaction.
  const ata = (owner: InstanceType<typeof w3.PublicKey>) => spl.getAssociatedTokenAddressSync(COIN, owner, false, spl.TOKEN_2022_PROGRAM_ID);
  const swap = new w3.Transaction()
    .add(w3.SystemProgram.transfer({ fromPubkey: a1.publicKey, toPubkey: a2.publicKey, lamports: 1_000_000 }))
    .add(spl.createTransferCheckedInstruction(ata(a2.publicKey), COIN, ata(a1.publicKey), a2.publicKey, 1_000_000, 6, [], spl.TOKEN_2022_PROGRAM_ID));
  const swapSig = await send(swap, [a1, a2]);
  const paySig = await send(new w3.Transaction().add(w3.SystemProgram.transfer({ fromPubkey: a1.publicKey, toPubkey: a2.publicKey, lamports: 2_000_000 })), [a1]);

  let rows: { kind: string; balance: string; who: string | null; amount: string; sym: string; signature?: string }[] = [];
  for (let i = 0; i < 8; i++) {
    await sleep(6000);
    await bg({ type: "history" });
    await sleep(4000);
    rows = (await bg({ type: "history" })).data ?? [];
    if (rows.some((h) => h.signature === swapSig) && rows.some((h) => h.signature === paySig)) break;
  }
  const s = rows.find((h) => h.signature === swapSig);
  check(s?.kind === "swapped" && s.balance === "public" && s.amount === "+1", "a website's swap shows as Swapped, in Public, with the coin received", s ? `${s.kind} ${s.amount} ${s.sym} ${s.balance}` : "not shown");
  const p = rows.find((h) => h.signature === paySig);
  check(p?.kind === "sent" && p.amount === "-0.002" && p.who === a2.publicKey.toBase58(), "a website's SOL payment shows as Sent, to whom", p ? `${p.kind} ${p.amount} ${p.sym} to ${p.who?.slice(0, 6)}` : "not shown");
  check(rows.filter((h) => h.signature === swapSig || h.signature === paySig).length === 2, "each once");

  const t0 = Date.now();
  const r = await bg({ type: "swap", from: "private", inMint: SOL, outMint: TEST1, amount: "0.002", slippageBps: 300, receiveInto: "wallet" });
  let view: any = null;
  for (let i = 0; i < 90 && r.ok; i++) {
    view = (await bg({ type: "swapStatus", id: r.data.id })).data;
    if (view?.finished) break;
    await sleep(4000);
  }
  for (let i = 0; i < 3; i++) {
    await sleep(11000);
    await bg({ type: "history" });
  }
  await sleep(4000);
  const after = (((await bg({ type: "history" })).data ?? []) as { kind: string; sym: string; at: number }[]).filter((h) => h.at >= t0 - 5000 && h.sym === "TEST1");
  check(view?.finished === "done" && after.filter((h) => h.kind === "swapped").length === 1 && !after.some((h) => h.kind === "received"), "a wallet swap into Public shows once, its delivery not again as Received", after.map((h) => h.kind).join(", "));
} catch (e) {
  failures++;
  console.log("FAIL", (e as Error).message);
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
