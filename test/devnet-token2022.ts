// DEVNET ONLY: fresh Token-2022 coins (plain, 1% transfer fee) through shield, private send, withdraw and public send.
//   npx tsx test/devnet-token2022.ts   (~0.01 devnet SOL)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { accountSecret, phraseSeed } from "../src/lib/keys";
import { publicBalances } from "../src/lib/net";
import { payPrivately, withdrawTo } from "../src/lib/pay";
import { ctxFor, parsePrivateAddress, privateAddressOf, privateUnits, sendPublic, shield } from "../src/lib/rings";

// Node's fetch keeps no cookies: hold the sign-in cookie, as Rings pays private fees only for a signed-in wallet.
const jar = new Map<string, string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(init.headers);
  const c = jar.get(url.host);
  if (c) headers.set("cookie", c);
  const res = await realFetch(input, { ...init, headers });
  for (const sc of res.headers.getSetCookie()) jar.set(url.host, sc.split(";")[0]);
  return res;
}) as typeof fetch;

const web = createRequire(new URL("../../web/package.json", import.meta.url));
const w3 = web("@solana/web3.js");
const spl = web("@solana/spl-token");
const RPC = "http://localhost:3101/api/helius/rpc";
const conn = new w3.Connection(RPC, { commitment: "confirmed", wsEndpoint: "ws://127.0.0.1:1" });

let failures = 0;
const check = (ok: boolean, label: string, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function sendTx(tx: InstanceType<typeof w3.Transaction>, signers: unknown[]) {
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = (signers[0] as { publicKey: unknown }).publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize());
  for (let i = 0; i < 40; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
      if (st.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
      return sig;
    }
    await sleep(1500);
  }
  throw new Error("transaction not confirmed");
}

const phrase = readFileSync(new URL("../.devdata/devnet-phrase.txt", import.meta.url), "utf8").trim();
const seed = phraseSeed(phrase);
const a0 = ctxFor("devnet", accountSecret(seed, 0));
const a1 = ctxFor("devnet", accountSecret(seed, 1));
const payer = w3.Keypair.fromSeed(accountSecret(seed, 0));
const D = 6;
const U = (n: number) => BigInt(Math.round(n * 10 ** D));
const show = (u: bigint | undefined) => (Number(u ?? 0n) / 10 ** D).toFixed(D);

async function makeCoin(feeBps: number) {
  const mint = w3.Keypair.generate();
  const exts = feeBps ? [spl.ExtensionType.TransferFeeConfig] : [];
  const space = spl.getMintLen(exts);
  const lamports = await conn.getMinimumBalanceForRentExemption(space);
  const tx = new w3.Transaction().add(w3.SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space, lamports, programId: spl.TOKEN_2022_PROGRAM_ID }));
  if (feeBps) tx.add(spl.createInitializeTransferFeeConfigInstruction(mint.publicKey, payer.publicKey, payer.publicKey, feeBps, BigInt(10 ** 15), spl.TOKEN_2022_PROGRAM_ID));
  tx.add(spl.createInitializeMintInstruction(mint.publicKey, D, payer.publicKey, null, spl.TOKEN_2022_PROGRAM_ID));
  const ata = spl.getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey, false, spl.TOKEN_2022_PROGRAM_ID);
  tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, payer.publicKey, mint.publicKey, spl.TOKEN_2022_PROGRAM_ID));
  tx.add(spl.createMintToInstruction(mint.publicKey, ata, payer.publicKey, U(1000), [], spl.TOKEN_2022_PROGRAM_ID));
  await sendTx(tx, [payer, mint]);
  return mint.publicKey.toBase58() as string;
}
const pubOf = async (owner: string, mint: string) => BigInt((await publicBalances("devnet", owner)).find((r) => r.mint === mint)?.units ?? "0");
const privOf = async (ctx: typeof a0, mint: string) => (await privateUnits(ctx, [mint])).get(mint) ?? 0n;
/** Runs a step; a throw is reported as a FAIL and returns ok: false, so the coin's later steps are skipped. */
async function stepOk(label: string, run: () => Promise<string>) {
  try {
    const extra = await run();
    return { ok: true, extra };
  } catch (e) {
    check(false, label, (e as Error).message.slice(0, 200));
    return { ok: false, extra: "" };
  }
}

try {
  const p1 = (await parsePrivateAddress("devnet", await privateAddressOf(a1)))!;
  for (const [name, feeBps] of [["plain Token-2022", 0], ["Token-2022 with a 1% transfer fee", 100]] as const) {
    console.log(`... ${name}`);
    const mint = await makeCoin(feeBps);
    console.log(`    coin ${mint}`);
    const pub0 = await pubOf(a0.wallet, mint);
    check(pub0 === U(1000), `${name}: shown in Public`, show(pub0));

    // The pool rejects deposits of transfer-fee coins (error 7010): the wallet must refuse to shield them.
    if (feeBps) {
      let refused = "";
      try {
        await shield(a0, mint, U(100));
      } catch (e) {
        refused = (e as Error).message;
      }
      const pub = await pubOf(a0.wallet, mint);
      check(/fee on every transfer/.test(refused) && pub === U(1000), `${name}: refused before anything moves, in plain words`, refused || "it went through");
    }

    let r = feeBps ? { ok: false, extra: "" } : await stepOk(`${name}: made private`, async () => {
      const s = await shield(a0, mint, U(100));
      await sleep(2000);
      const priv = await privOf(a0, mint);
      const pub = await pubOf(a0.wallet, mint);
      check(pub === U(900) && priv === U(100), `${name}: made private (100 in)`, `private ${show(priv)}, public ${show(pub)}, ${s.signature.slice(0, 8)}`);
      return "";
    });

    const privBefore = r.ok ? await privOf(a0, mint) : 0n;
    if (r.ok) r = await stepOk(`${name}: sent privately`, async () => {
      const s = await payPrivately(a0, mint, U(10), p1);
      await sleep(2000);
      const mine = await privOf(a0, mint);
      const theirs = await privOf(a1, mint);
      check(mine === privBefore - U(10) && theirs === U(10), `${name}: sent privately to account 2`, `account 1 private ${show(mine)}, account 2 private ${show(theirs)}, fee paid by ${s.paidBy}`);
      return "";
    });

    const pubBefore = await pubOf(a0.wallet, mint);
    const privBefore2 = r.ok ? await privOf(a0, mint) : 0n;
    if (r.ok) r = await stepOk(`${name}: made public again`, async () => {
      const s = await withdrawTo(a0, mint, U(20), a0.wallet);
      await sleep(2000);
      const pub = await pubOf(a0.wallet, mint);
      const priv = await privOf(a0, mint);
      const arrived = pub - pubBefore;
      check(priv === privBefore2 - U(20) && arrived === U(20) - (feeBps ? U(0.2) : 0n), `${name}: made public again (20 out, ${feeBps ? "19.8 expected after the fee" : "20 expected"})`, `arrived ${show(arrived)}, private ${show(priv)}, fee paid by ${s.paidBy}`);
      return "";
    });

    const theirPub0 = await pubOf(a1.wallet, mint);
    await stepOk(`${name}: sent publicly`, async () => {
      const s = await sendPublic(a0, mint, U(5), a1.wallet);
      await sleep(2000);
      const got = (await pubOf(a1.wallet, mint)) - theirPub0;
      check(got === U(5) - (feeBps ? U(0.05) : 0n), `${name}: sent publicly to account 2 (5 sent, ${feeBps ? "4.95 expected after the fee" : "5 expected"})`, `arrived ${show(got)}, ${s.signature.slice(0, 8)}`);
      return "";
    });
  }
} catch (e) {
  failures++;
  console.log("FAIL", (e as Error).message, String((e as Error).stack).split(/\r?\n/).slice(1, 6).join(" <- "), (e as { cause?: unknown }).cause);
} finally {
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
