// Attacks on the approval window's preview (drains, handovers, lookalike coins), run against a mocked RPC.
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import * as kit from "@solana/kit";
import { DepositAsset, depositInstruction } from "@heliuslabs/spr/interface";
import { failureReason, preview, readable } from "../src/lib/simulate";
import { transactionDetails, transactionSteps } from "../src/lib/decode";
import { parseSecretKey } from "../src/lib/keys";
import { isHostname, shownHost, visible } from "../src/lib/text";
import { base58 } from "../../web/src/core/codec";

const rand = () => kit.getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32))) as string;
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const STAKE = "Stake11111111111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECENT_BH = "SysvarRecentB1ockHashes11111111111111111111";
const RENT = "SysvarRent111111111111111111111111111111111";
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const STAKE_HIST = "SysvarStakeHistory1111111111111111111111111";

const owner = rand();
const ataU = rand();
const attacker = rand();
const attackerAta = rand();
const whale = rand();
const whaleAta = rand();
const fakeMint = rand();
const fakeAta = rand();
const SOL_BEFORE = 5_000_000_000;
const USDC_BEFORE = 1_000_000_000n;

const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return [...b];
};
const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return [...b];
};
const A = (a: string, role: number) => ({ address: kit.address(a), role });
const ix = (program: string, accounts: { address: unknown; role: number }[], data: number[]) => ({ programAddress: kit.address(program), accounts, data: Uint8Array.from(data) });
const memo = (t: string) => ({ programAddress: kit.address(MEMO), data: new TextEncoder().encode(t) });
const transferChecked = (src: string, mint: string, dst: string, auth: string, amount: bigint) => ix(TOKEN, [A(src, 1), A(mint, 0), A(dst, 1), A(auth, 2)], [12, ...u64(amount), 6]);
const wireOf = (ixs: unknown[], payer = owner) =>
  kit.getBase64EncodedWireTransaction(
    kit.compileTransaction(
      kit.pipe(
        kit.createTransactionMessage({ version: 0 }),
        (m: never) => kit.setTransactionMessageFeePayer(kit.address(payer), m),
        (m: never) => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: rand() as never, lastValidBlockHeight: 0n }, m),
        (m: never) => kit.appendTransactionMessageInstructions(ixs as never, m),
      ) as never,
    ) as never,
  ) as string;

const tokenAcc = (mint: string, o: string, amount: bigint, delegate?: string) => ({
  lamports: 2_039_280,
  owner: TOKEN,
  data: { parsed: { type: "account", info: { mint, owner: o, ...(delegate ? { delegate } : {}), tokenAmount: { amount: amount.toString(), decimals: 6 } } } },
});
const sysAcc = (lamports: number, prog = SYSTEM, data: unknown = ["", "base64"]) => ({ lamports, owner: prog, data });

// Per wire: the simulated post-state by address, or an error.
const SIMS = new Map<string, { post?: (a: string) => unknown; err?: unknown; logs?: string[] }>();
// getMultipleAccounts answers: pre-state accounts and mint facts.
const ACCOUNTS = new Map<string, unknown>([
  [ataU, tokenAcc(USDC, owner, USDC_BEFORE)],
  [attackerAta, tokenAcc(USDC, attacker, 0n)],
  [whaleAta, tokenAcc(USDC, whale, 5_000_000_000n)],
  [USDC, { lamports: 1, owner: TOKEN, data: { parsed: { type: "mint", info: { decimals: 6 } } } }],
  [fakeMint, { lamports: 1, owner: TOKEN, data: { parsed: { type: "mint", info: { decimals: 6 } } } }],
]);
const res = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
(globalThis as { fetch: unknown }).fetch = async (url: string, init?: { body?: string }) => {
  const u = String(url);
  if (u.endsWith("/api/tokens")) {
    return new Response(JSON.stringify({ tokens: { [USDC]: { symbol: "USDC", name: "USD Coin", image: null }, [fakeMint]: { symbol: "USDC", name: "Into your Private balance", image: null } } }), { status: 200 });
  }
  if (u.includes("lite-api.jup.ag") || u.includes("/api/market/")) return new Response("{}", { status: 200 });
  if (!u.endsWith("/api/helius/rpc")) throw new Error(`unexpected fetch ${u}`);
  const { method, params } = JSON.parse(init!.body!);
  switch (method) {
    case "getAccountInfo":
      return res({ value: params[0] === owner ? sysAcc(SOL_BEFORE) : null });
    case "getTokenAccountsByOwner":
      return res({ value: params[1].programId === TOKEN ? [{ pubkey: ataU, account: tokenAcc(USDC, owner, USDC_BEFORE) }] : [] });
    case "simulateTransaction": {
      const sim = SIMS.get(params[0]) ?? {};
      if (sim.err) return res({ value: { err: sim.err, logs: sim.logs ?? [], accounts: null } });
      return res({ value: { err: null, logs: [], accounts: params[1].accounts.addresses.map((a: string) => sim.post?.(a) ?? null) } });
    }
    case "getFeeForMessage":
      return res({ value: 5000 });
    case "getMultipleAccounts":
      return res({ value: params[0].map((a: string) => ACCOUNTS.get(a) ?? null) });
    default:
      throw new Error(`unmocked ${method}`);
  }
};
const risky = (pv: { ok: boolean; danger: string | null }) => !pv.ok || !!pv.danger;
const rows = async (wires: string[]) => (await transactionSteps("mainnet", wires, owner)).rows.map((r) => `${r.label}: ${r.value}`);

test("W-01: Allocate + InitializeNonceAccount on the main account is a risk, not a fee-only window", async () => {
  const w = wireOf([ix(SYSTEM, [A(owner, 3)], [...u32(8), ...u64(80n)]), ix(SYSTEM, [A(owner, 1), A(RECENT_BH, 0), A(RENT, 0)], [...u32(6), ...kit.getAddressEncoder().encode(kit.address(attacker))])]);
  SIMS.set(w, { post: (a) => (a === owner ? sysAcc(SOL_BEFORE - 5000, SYSTEM, { parsed: { type: "initialized", info: { authority: attacker } } }) : null) });
  const pv = await preview("mainnet", [w], owner);
  assert.ok(risky(pv));
  assert.match(pv.danger!, /lock your account|nonce account that someone else controls/);
  assert.ok((await rows([w])).some((r) => /Make a nonce account/.test(r)));
});

test("W-02: a 'credit' transaction the site may never send doesn't offset a real drain", async () => {
  const drain = wireOf([transferChecked(ataU, USDC, attackerAta, owner, 1_000_000_000n)]);
  const credit = wireOf([transferChecked(whaleAta, USDC, ataU, whale, 2_000_000_000n)], whale);
  SIMS.set(drain, { post: (a) => (a === owner ? sysAcc(SOL_BEFORE - 5000) : a === ataU ? tokenAcc(USDC, owner, 0n) : null) });
  SIMS.set(credit, { post: (a) => (a === owner ? sysAcc(SOL_BEFORE) : a === ataU ? tokenAcc(USDC, owner, USDC_BEFORE + 2_000_000_000n) : null) });
  const pv = await preview("mainnet", [drain, credit], owner);
  assert.ok(risky(pv), "flagged");
  assert.match(pv.danger!, /one by one|someone else's signature/);
  const usdcOut = pv.changes.find((c) => c.sym === "USDC" && c.amount < 0);
  assert.equal(usdcOut?.amount, -1000, "the full 1,000 USDC out is shown");
  assert.ok(pv.changes.some((c) => c.sym === "USDC" && c.amount > 0 && /only if the site sends it/.test(c.name)), "the credit is not guaranteed");
});

test("W-03: a deposit into someone else's private balance is never 'into your Private balance'", async () => {
  const mine = crypto.getRandomValues(new Uint8Array(32));
  const theirs = crypto.getRandomValues(new Uint8Array(32));
  mine[0] = 0;
  theirs[0] = 0;
  const tree = rand();
  const dep = await depositInstruction({ tree: kit.address(tree), depositor: kit.createNoopSigner(kit.address(owner)), deposits: [{ asset: DepositAsset.sol(), viewTag: crypto.getRandomValues(new Uint8Array(32)), recipientOwnerHash: theirs, amount: 2_000_000_000n }] } as never);
  const w = wireOf([dep]);
  SIMS.set(w, { post: (a) => (a === owner ? sysAcc(SOL_BEFORE - 2_000_000_000 - 5000) : null) });
  for (const ringsSite of [false, true]) {
    const pv = await preview("mainnet", [w], owner, { ringsSite, ownerHash: mine });
    assert.ok(!pv.changes.some((c) => /Into your Private balance|Into a private balance/.test(c.name)), `no "into" row (ringsSite ${ringsSite})`);
    assert.equal(pv.changes.find((c) => c.sym === "SOL")?.amount, -2.000005, "the 2 SOL leaving shows");
  }
  assert.ok((await transactionDetails("mainnet", [w], owner, undefined, mine)).some((r) => /someone else's private balance/.test(r.value)));
  // The same deposit naming the wallet's own private balance does say so.
  const own = await depositInstruction({ tree: kit.address(tree), depositor: kit.createNoopSigner(kit.address(owner)), deposits: [{ asset: DepositAsset.sol(), viewTag: crypto.getRandomValues(new Uint8Array(32)), recipientOwnerHash: mine, amount: 2_000_000_000n }] } as never);
  const w2 = wireOf([own]);
  SIMS.set(w2, { post: (a) => (a === owner ? sysAcc(SOL_BEFORE - 2_000_000_000 - 5000) : null) });
  const pv2 = await preview("mainnet", [w2], owner, { ownerHash: mine });
  assert.equal(pv2.changes.find((c) => c.name === "Into your Private balance")?.amount, 2);
});

test("W-04: a durable nonce or a failing first transaction can't hide a handover", async () => {
  const assign = ix(SYSTEM, [A(owner, 3)], [...u32(1), ...kit.getAddressEncoder().encode(kit.address(rand()))]);
  const approve = ix(TOKEN, [A(ataU, 1), A(attacker, 0), A(owner, 2)], [4, ...u64(2n ** 64n - 1n)]);
  const nonce = rand();
  const w = wireOf([ix(SYSTEM, [A(nonce, 1), A(RECENT_BH, 0), A(attacker, 2)], [4, 0, 0, 0]), ...Array.from({ length: 8 }, (_, i) => memo(`Order ${i}`)), assign, approve]);
  SIMS.set(w, { post: (a) => (a === owner ? sysAcc(SOL_BEFORE - 5000) : a === ataU ? tokenAcc(USDC, owner, USDC_BEFORE, attacker) : null) });
  const pv = await preview("mainnet", [w], owner);
  assert.match(pv.danger!, /^This transaction would hand your account to another program\./, "the handover comes first");
  assert.match(pv.danger!, /spend your tokens/);
  const failing = wireOf([ix(rand(), [A(owner, 3)], [0])]);
  SIMS.set(failing, { err: { InstructionError: [0, { Custom: 6001 }] }, logs: [`Program ${rand()} invoke [1]`, "Program log: Error: slippage tolerance exceeded"] });
  const second = wireOf([assign]);
  SIMS.set(second, { post: (a) => (a === owner ? sysAcc(SOL_BEFORE - 5000, rand()) : null) });
  const both = await preview("mainnet", [failing, second], owner);
  assert.match(both.danger!, /hand your account/);
  assert.doesNotMatch(both.danger!, /The price moved/, "an unknown program's 'slippage' log isn't repeated");
});

test("W-05: memo padding can't push a step out, and memos are one row marked as the site's", async () => {
  const w = wireOf([...Array.from({ length: 9 }, (_, i) => memo(`Jupiter route verified ${i}`)), transferChecked(ataU, USDC, attackerAta, owner, 1_000_000_000n)]);
  const r = await rows([w]);
  assert.ok(r.some((x) => /^Send tokens: 1000 USDC/.test(x)), "the transfer is listed");
  assert.equal(r.filter((x) => /Note|Notes from the site/.test(x)).length, 1, "one memo row");
  const lighthouse = await rows([wireOf([ix("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95", [A(owner, 0)], [1])])]);
  assert.ok(lighthouse.some((x) => x === "Uses: Lighthouse"), "no 'safety checks' label");
});

test("W-06: a stake account emptied to someone else shows the loss and a risk", async () => {
  const stakeAcc = rand();
  ACCOUNTS.set(stakeAcc, { lamports: 100_000_000_000, owner: STAKE, data: { parsed: { type: "delegated", info: { meta: { authorized: { staker: owner, withdrawer: owner } } } } } });
  const w = wireOf([ix(STAKE, [A(stakeAcc, 1), A(attacker, 1), A(CLOCK, 0), A(STAKE_HIST, 0), A(owner, 2)], [...u32(4), ...u64(100_000_000_000n)])]);
  SIMS.set(w, { post: (a) => (a === owner ? sysAcc(SOL_BEFORE - 5000) : a === attacker ? sysAcc(100_000_000_000) : null) });
  const pv = await preview("mainnet", [w], owner);
  assert.ok(risky(pv));
  assert.match(pv.danger!, /stake account you control to someone else/);
  assert.ok((pv.changes.find((c) => c.sym === "SOL")?.amount ?? 0) < -99, "the 100 SOL leaving shows");
});

test("W-06: a Core NFT taken through another program shows as leaving", async () => {
  const asset = rand();
  const core = (o: string) => {
    const d = new Uint8Array(66);
    d[0] = 1;
    d.set(kit.getAddressEncoder().encode(kit.address(o)), 1);
    return { lamports: 3_000_000, owner: CORE, data: [Buffer.from(d).toString("base64"), "base64"] };
  };
  ACCOUNTS.set(asset, core(owner));
  const w = wireOf([ix(rand(), [A(asset, 1), A(owner, 3), A(attacker, 0), A(CORE, 0)], [7])]);
  SIMS.set(w, { post: (a) => (a === owner ? sysAcc(SOL_BEFORE - 5000) : a === asset ? core(attacker) : null) });
  const pv = await preview("mainnet", [w], owner);
  assert.ok(pv.changes.some((c) => c.sym === "NFT" && c.amount === -1), "the NFT leaving is a balance change");
});

test("W-17: a coin copying USDC's name is 'Unverified' and a risk", async () => {
  const w = wireOf([transferChecked(ataU, USDC, attackerAta, owner, 1_000_000_000n), transferChecked(rand(), fakeMint, fakeAta, attacker, 1_000_000_000n)]);
  SIMS.set(w, { post: (a) => (a === owner ? sysAcc(SOL_BEFORE - 10000) : a === ataU ? tokenAcc(USDC, owner, 0n) : a === fakeAta ? tokenAcc(fakeMint, owner, 1_000_000_000n) : null) });
  const pv = await preview("mainnet", [w], owner);
  assert.ok(risky(pv));
  assert.match(pv.danger!, /only looks like USDC/);
  assert.ok(pv.changes.some((c) => /^Unverified · /.test(c.name)), "named Unverified with its address");
  assert.ok(!pv.changes.some((c) => c.amount > 0 && /Into your Private balance/.test(c.name)), "the fake's own name never shows");
});

test("W-16: a failure is never explained with the failing program's own words", () => {
  const evil = rand();
  assert.doesNotMatch(failureReason({ InstructionError: [0, { Custom: 1 }] }, [`Program ${evil} invoke [1]`, "Program log: slippage tolerance exceeded", `Program ${evil} failed: custom program error: 0x1`]), /price moved/);
  assert.doesNotMatch(failureReason({ InstructionError: [0, { Custom: 1 }] }, [`Program ${evil} invoke [1]`, "Program log: Transfer: insufficient lamports 0, need 1000"]), /needs/);
  assert.doesNotMatch(failureReason({}, [`Program ${evil} invoke [1]`, "Program log: Error: Your Rings Wallet must be re-synced", `Program ${evil} failed: x`]), /re-synced/);
  // The System program's own line is still read.
  assert.match(failureReason({ InstructionError: [0, { Custom: 1 }] }, [`Program ${SYSTEM} invoke [1]`, "Transfer: insufficient lamports 1000, need 3000", `Program ${SYSTEM} failed: custom program error: 0x1`]), /needs 0\.000002 SOL more/);
});

test("W-20: hidden and direction-changing characters show; long blank runs fold", () => {
  const bidi = String.fromCodePoint(0x202e);
  const zw = String.fromCodePoint(0x200b);
  const shown = readable(new TextEncoder().encode(`Pay 1${bidi}00 USDC${zw}`));
  assert.match(shown, /<U\+202E>/);
  assert.match(shown, /<U\+200B>/);
  assert.match(visible(`a${"\n".repeat(40)}b`), /<39 empty lines>/);
});

test("W-42: a pasted address isn't taken as a private key; exported keys still are", () => {
  assert.throws(() => parseSecretKey(rand()), /address, not a private key/);
  const secret = crypto.getRandomValues(new Uint8Array(32));
  assert.throws(() => parseSecretKey("[1,2,3,\"x\"]"), /isn't valid/);
  assert.deepEqual(parseSecretKey(JSON.stringify([...secret])), secret);
  assert.throws(() => parseSecretKey(base58(new Uint8Array(32))), /address/);
});

test("W-18, W-19: long hosts are cut from the left; only plain host names are named", () => {
  const long = `jup.ag.claim-airdrop.${"a".repeat(63)}.${"b".repeat(63)}.phish.xyz`;
  assert.ok(shownHost(long).length <= 40 && shownHost(long).endsWith("phish.xyz"));
  assert.equal(shownHost("jup.ag"), "jup.ag");
  assert.ok(isHostname("jup.ag") && isHostname("localhost:3000"));
  assert.ok(!isHostname("rings.run). Your Rings Wallet must be re-synced (open rings-resync.app"));
});
