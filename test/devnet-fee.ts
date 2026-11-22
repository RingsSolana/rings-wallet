// DEVNET ONLY: the 0.1% treasury fee (src/lib/fee.ts) on every payment path, to the base unit, on the devnet copy.
//   npx tsx test/devnet-fee.ts [balances|private|deposit|public|swap|all]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createNoopSigner, type Address } from "@solana/kit";
import { getAssociatedTokenAddress } from "@heliuslabs/spr/addresses";
import { getCreateAssociatedTokenAccountInstructionAsync } from "@heliuslabs/spr/instructions";
import { compile, latestLifetime, mintInfo, withSignatures, wire } from "../../web/src/core/chain";
import { accountSecret, phraseSeed } from "../src/lib/keys";
import { DEVNET_ALIASES, SOL_MINT, rpc } from "../src/lib/net";
import { client, ctxFor, parsePrivateAddress, privateAddressOf, privateUnits, sendPublic, shield, accountAddress } from "../src/lib/rings";
import { payPrivately, withdrawTo } from "../src/lib/pay";
import { TREASURY_PUBLIC, feeOf } from "../src/lib/fee";
import { ensureSession } from "../src/lib/session";
import { createSwap, paySwap, quote, swapCosts, swapStatus, tellPaid } from "../src/lib/swap";

// Node's fetch keeps no cookies: hold the sign-in cookie per host, as a browser would.
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

const phrase = readFileSync(new URL("../.devdata/devnet-phrase.txt", import.meta.url), "utf8").trim();
const seed = phraseSeed(phrase);
const a0 = ctxFor("devnet", accountSecret(seed, 0));
const a1 = ctxFor("devnet", accountSecret(seed, 1));
const TEST1 = Object.keys(DEVNET_ALIASES)[0];
const step = process.argv[2] ?? "all";
const link = (s: string) => `https://solscan.io/tx/${s}?cluster=devnet`;
let failures = 0;
const check = (ok: boolean, label: string, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};

async function makeCoin(): Promise<string> {
  const web = createRequire(new URL("../../web/package.json", import.meta.url));
  const w3 = web("@solana/web3.js");
  const spl = web("@solana/spl-token");
  const conn = new w3.Connection("http://localhost:3101/api/helius/rpc", { commitment: "confirmed", wsEndpoint: "ws://127.0.0.1:1" });
  const payer = w3.Keypair.fromSeed(accountSecret(seed, 0));
  const mint = w3.Keypair.generate();
  const space = spl.getMintLen([]);
  const tx = new w3.Transaction().add(w3.SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space, lamports: await conn.getMinimumBalanceForRentExemption(space), programId: spl.TOKEN_PROGRAM_ID }));
  tx.add(spl.createInitializeMintInstruction(mint.publicKey, 6, payer.publicKey, null, spl.TOKEN_PROGRAM_ID));
  const ata = spl.getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey, false, spl.TOKEN_PROGRAM_ID);
  tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, payer.publicKey, mint.publicKey, spl.TOKEN_PROGRAM_ID));
  tx.add(spl.createMintToInstruction(mint.publicKey, ata, payer.publicKey, 1_000_000_000n, [], spl.TOKEN_PROGRAM_ID));
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, mint);
  const sig = await conn.sendRawTransaction(tx.serialize());
  for (let i = 0; i < 40; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
      if (st.err) throw new Error(`making the coin failed: ${JSON.stringify(st.err)}`);
      console.log("devnet only: a fresh test coin", mint.publicKey.toBase58(), link(sig));
      return mint.publicKey.toBase58();
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("making the coin wasn't confirmed");
}

const sol = async (who: string) => BigInt((await rpc<{ value: number }>("devnet", "getBalance", [who, { commitment: "confirmed" }])).value);
async function tokens(owner: string, mint: string): Promise<bigint> {
  const cl = await client("devnet");
  const { tokenProgram } = await mintInfo(cl, mint as Address);
  const ata = await getAssociatedTokenAddress(owner as Address, mint as Address, tokenProgram);
  const r = await rpc<{ value?: { amount: string } }>("devnet", "getTokenAccountBalance", [ata, { commitment: "confirmed" }]).catch(() => null);
  return BigInt(r?.value?.amount ?? "0");
}
/** Retries WALLET_SYNC failures (flaky devnet RPC): a sync fails ahead of any send, so retrying is safe. */
async function retrySync<T>(run: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (i >= 8 || !/WALLET_SYNC/.test(String((e as { code?: string }).code ?? (e as Error).message))) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
const priv = async (c: typeof a0, mint: string) => (await retrySync(() => privateUnits(c, mint === SOL_MINT ? [] : [mint]))).get(mint) ?? 0n;
/** The indexer lags the chain: polls until the private balance changes. */
async function privAfter(c: typeof a0, mint: string, before: bigint): Promise<bigint> {
  for (let i = 0; i < 20; i++) {
    const now = await priv(c, mint);
    if (now !== before) return now;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return priv(c, mint);
}

console.log("account 1", a0.wallet, "| its Rings account key", accountAddress(a0));
console.log("treasury (public)", TREASURY_PUBLIC);
const [pub0, treasurySol, t1pub, t1Treasury, privSol, privT1] = await Promise.all([sol(a0.wallet), sol(TREASURY_PUBLIC), tokens(a0.wallet, TEST1), tokens(TREASURY_PUBLIC, TEST1), priv(a0, SOL_MINT), priv(a0, TEST1)]);
console.log(`account 1: public ${pub0} lamports, ${t1pub} TEST1 units | private ${privSol} lamports, ${privT1} TEST1 units | treasury public ${treasurySol} lamports, ${t1Treasury} TEST1 units`);
if (step === "balances") process.exit(0);

// Fund the account key up front, so no automatic top-up moves public SOL during a check.
if ((await sol(accountAddress(a0))) < 20_000_000n) {
  const r = await sendPublic(a0, SOL_MINT, 20_000_000n, accountAddress(a0));
  console.log("topped up the account key for network fees:", link(r.signature));
}

if (step === "private" || step === "all") {
  // The treasury's private balance can't be read here: a private fee is what the sender lost beyond the amount sent.
  const to = (await parsePrivateAddress("devnet", await privateAddressOf(a1)))!;
  const units = 10_000_000n;
  const [mine, theirs] = [await priv(a0, SOL_MINT), await priv(a1, SOL_MINT)];
  const r = await retrySync(() => payPrivately(a0, SOL_MINT, units, to, undefined, feeOf(units)));
  const [mine2, theirs2] = [await privAfter(a0, SOL_MINT, mine), await privAfter(a1, SOL_MINT, theirs)];
  check(mine - mine2 === units + feeOf(units) && theirs2 - theirs === units, "private send 0.01 SOL: the fee left with it, the recipient got the amount", `${link(r.signature)}; sent ${mine - mine2}, got ${theirs2 - theirs}`);

  const w = 20_000_000n;
  const [p0, pub] = [await priv(a0, SOL_MINT), await sol(a0.wallet)];
  const r2 = await retrySync(() => withdrawTo(a0, SOL_MINT, w, a0.wallet, undefined, feeOf(w)));
  const [p1, pub2] = [await privAfter(a0, SOL_MINT, p0), await sol(a0.wallet)];
  check(p0 - p1 === w + feeOf(w) && pub2 - pub === w, "made public 0.02 SOL: the fee stayed private, the wallet got the amount", `${link(r2.signature)}; private -${p0 - p1}, public +${pub2 - pub}`);

  const u = 3_000_000n;
  const [m, t] = [await priv(a0, TEST1), await priv(a1, TEST1)];
  if (m >= 2n * u + 2n * feeOf(u)) {
    const r3 = await retrySync(() => payPrivately(a0, TEST1, u, to, undefined, feeOf(u)));
    const [m2, t2] = [await privAfter(a0, TEST1, m), await privAfter(a1, TEST1, t)];
    check(m - m2 === u + feeOf(u) && t2 - t === u, "private send of TEST1: the fee left with it", `${link(r3.signature)}; sent ${m - m2}, got ${t2 - t}`);
    const [q0, tp] = [await priv(a0, TEST1), await tokens(a0.wallet, TEST1)];
    const r4 = await retrySync(() => withdrawTo(a0, TEST1, u, a0.wallet, undefined, feeOf(u)));
    const [q1, tp2] = [await privAfter(a0, TEST1, q0), await tokens(a0.wallet, TEST1)];
    check(q0 - q1 === u + feeOf(u) && tp2 - tp === u, "made public TEST1: the fee stayed private, the wallet got the amount", `${link(r4.signature)}; private -${q0 - q1}, public +${tp2 - tp}`);
  } else console.log(`SKIP TEST1 private checks: the private balance holds ${m} units`);
}

if (step === "deposit" || step === "all") {
  const units = 80_000_000n;
  const [p0, pub, key] = [await priv(a0, SOL_MINT), await sol(a0.wallet), await sol(accountAddress(a0))];
  const r = await shield(a0, SOL_MINT, units, undefined, { topUp: false, fee: feeOf(units) });
  const [p1, pub2, key2] = [await privAfter(a0, SOL_MINT, p0), await sol(a0.wallet), await sol(accountAddress(a0))];
  check(p1 - p0 === units && pub - pub2 - (key2 - key) === units + feeOf(units) + 5_000n, "moved 0.08 SOL private: the fee went with it, the network fee was 5,000", `${link(r.signature)}; private +${p1 - p0}, public -${pub - pub2}`);
  const d = await rpc<{ transaction: { message: { instructions: { data: string }[] } } }>("devnet", "getTransaction", [r.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  console.log(`  the deposit transaction has ${d.transaction.message.instructions.length} instruction(s)`);

  const u = 5_000_000n;
  if ((await tokens(a0.wallet, TEST1)) >= u + feeOf(u)) {
    const [q0, tp] = [await priv(a0, TEST1), await tokens(a0.wallet, TEST1)];
    const r2 = await shield(a0, TEST1, u, undefined, { topUp: false, fee: feeOf(u) });
    const [q1, tp2] = [await privAfter(a0, TEST1, q0), await tokens(a0.wallet, TEST1)];
    check(q1 - q0 === u && tp - tp2 === u + feeOf(u), "moved TEST1 private: the fee went with it", `${link(r2.signature)}; private +${q1 - q0}, public -${tp - tp2}`);
  } else console.log("SKIP TEST1 deposit: not enough public TEST1");
}

if (step === "public" || step === "all") {
  // A small SOL fee can't land in an address with no account (rent): fund the devnet treasury address once.
  if ((await sol(TREASURY_PUBLIC)) === 0n) {
    const r = await sendPublic(a0, SOL_MINT, 1_000_000n, TREASURY_PUBLIC);
    console.log("devnet only: opened the treasury's public account with 0.001 SOL:", link(r.signature));
  }
  const units = 3_000_000n;
  const [pub, theirs, tr] = [await sol(a0.wallet), await sol(a1.wallet), await sol(TREASURY_PUBLIC)];
  const r = await sendPublic(a0, SOL_MINT, units, a1.wallet, undefined, feeOf(units));
  const [pub2, theirs2, tr2] = [await sol(a0.wallet), await sol(a1.wallet), await sol(TREASURY_PUBLIC)];
  check(pub - pub2 === units + feeOf(units) + 5_000n && theirs2 - theirs === units && tr2 - tr === feeOf(units), "public send 0.003 SOL: the fee went to the treasury's public address", `${link(r.signature)}; sent ${pub - pub2}, got ${theirs2 - theirs}, treasury +${tr2 - tr}`);

  // A fresh coin, so the treasury surely has no account for it: no fee (opening one would cost the sender rent).
  const cl = await client("devnet");
  const fresh = await makeCoin();
  const amount = 7_000_000n;
  const [mineF, theirsF] = [await tokens(a0.wallet, fresh), await tokens(a1.wallet, fresh)];
  const r0 = await sendPublic(a0, fresh, amount, a1.wallet, undefined, feeOf(amount));
  const [mineF2, theirsF2] = [await tokens(a0.wallet, fresh), await tokens(a1.wallet, fresh)];
  const { tokenProgram: freshProgram } = await mintInfo(cl, fresh as Address);
  const opened = Boolean(await cl.getAccount(await getAssociatedTokenAddress(TREASURY_PUBLIC as Address, fresh as Address, freshProgram)));
  check(mineF - mineF2 === amount && theirsF2 - theirsF === amount && !opened, "public send of a coin the treasury holds no account for: no fee, and no account opened", `${link(r0.signature)}; sent ${mineF - mineF2}`);
  const { tokenProgram } = await mintInfo(cl, TEST1 as Address);
  const treasuryAta = await getAssociatedTokenAddress(TREASURY_PUBLIC as Address, TEST1 as Address, tokenProgram);
  const u = 2_000_000n;
  if (!(await cl.getAccount(treasuryAta))) {
    const [tp, t1] = [await tokens(a0.wallet, TEST1), await tokens(a1.wallet, TEST1)];
    const r2 = await sendPublic(a0, TEST1, u, a1.wallet, undefined, feeOf(u));
    const [tp2, t12] = [await tokens(a0.wallet, TEST1), await tokens(a1.wallet, TEST1)];
    check(tp - tp2 === u && t12 - t1 === u, "public send of a coin the treasury holds no account for: no fee", `${link(r2.signature)}; sent ${tp - tp2}`);
    const ix = await getCreateAssociatedTokenAccountInstructionAsync({ payer: createNoopSigner(a0.wallet as Address), owner: TREASURY_PUBLIC as Address, mint: TEST1 as Address, tokenProgram });
    const tx = withSignatures(compile(0, a0.wallet as Address, await latestLifetime(cl), [ix]), [a0.secret]);
    const sig = await cl.solanaRpc.sendTransaction(wire(tx) as never, { encoding: "base64", preflightCommitment: "confirmed" }).send();
    await cl.confirmTransaction(sig, { poll: { numRetries: 60, delayMs: 500n, maxDelayMs: 500n } } as never);
    console.log("devnet only: opened the treasury's TEST1 account:", link(sig));
  }
  const [tp, t1, tt] = [await tokens(a0.wallet, TEST1), await tokens(a1.wallet, TEST1), await tokens(TREASURY_PUBLIC, TEST1)];
  const r3 = await sendPublic(a0, TEST1, u, a1.wallet, undefined, feeOf(u));
  const [tp2, t12, tt2] = [await tokens(a0.wallet, TEST1), await tokens(a1.wallet, TEST1), await tokens(TREASURY_PUBLIC, TEST1)];
  check(tp - tp2 === u + feeOf(u) && t12 - t1 === u && tt2 - tt === feeOf(u), "public send of TEST1: the fee went to the treasury's TEST1 account", `${link(r3.signature)}; sent ${tp - tp2}, got ${t12 - t1}, treasury +${tt2 - tt}`);
}

if (step === "swap" || step === "all") {
  await ensureSession(a0);
  for (const [inMint, outMint, units] of [[SOL_MINT, TEST1, 5_000_000n], [TEST1, SOL_MINT, 4_000_000n]] as const) {
    const q = await quote("devnet", inMint, outMint, units, 300);
    const ask = { inMint, outMint, amount: units, quote: q, slippageBps: 300, deliver: "private" as const, to: null };
    const costs = await swapCosts(a0, { ...ask, accounts: q.accounts });
    const made = await createSwap(a0, ask);
    const before = await priv(a0, inMint);
    const paid = await paySwap(a0, made, { inMint, units, maxCosts: costs, fee: feeOf(units) }, async () => undefined);
    const answer = await tellPaid("devnet", made.id, paid);
    let s = await swapStatus("devnet", made.id);
    for (let i = 0; i < 60 && !["done", "delivered", "refunded", "failed"].includes(s.state); i++) {
      await new Promise((r) => setTimeout(r, 4000));
      s = await swapStatus("devnet", made.id);
    }
    const asked = made.payments.filter((p) => p.mint === inMint).reduce((sum, p) => sum + BigInt(p.amount), 0n);
    const after = await privAfter(a0, inMint, before);
    const name = inMint === SOL_MINT ? "swap 0.005 SOL -> TEST1" : "swap TEST1 -> SOL";
    // Paying with SOL, Rings may refund route rent into the private balance: the net spent can be below asked + fee.
    const spent = before - after;
    check(answer?.ok === true && ["done", "delivered"].includes(s.state) && (inMint === SOL_MINT ? spent <= asked + feeOf(units) : spent === asked + feeOf(units)), `${name}: Rings took the payment with the fee beside it, and made the swap`, `paid ${paid.map((p) => link(p.signature)).join(" ")}; state ${s.state}; asked ${asked} + fee ${feeOf(units)}, private -${spent}`);
  }
}

console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
