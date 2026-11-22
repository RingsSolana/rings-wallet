// The 0.1% treasury fee (src/lib/fee.ts): amounts, Max, the pinned treasury, and Activity never naming the treasury.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initializePoseidon, ShieldedAddress } from "@heliuslabs/spr";
import { FEE_BPS, TREASURY_PUBLIC, TREASURY_RING_B64, feeOf, maxWithFee } from "../src/lib/fee";
import { ownTxEffect, type ParsedTx } from "../src/lib/chainActivity";
import { fromB64, fromBase58 } from "../../web/src/core/codec";

test("the fee is 0.1%, rounded down, and nothing below 1,000 base units", () => {
  assert.equal(FEE_BPS, 10n);
  assert.equal(feeOf(0n), 0n);
  assert.equal(feeOf(999n), 0n);
  assert.equal(feeOf(1_000n), 1n);
  assert.equal(feeOf(1_999n), 1n);
  assert.equal(feeOf(1_000_000_000n), 1_000_000n); // 1 SOL: 0.001 SOL
  assert.equal(feeOf(250_000_000n), 250_000n); // 250 USDC: 0.25 USDC
  assert.equal(feeOf(-5n), 0n);
});

test("Max with the fee on top: the most whose amount and fee still fit, for every balance up to 20,000 units", () => {
  for (let have = 0n; have <= 20_000n; have++) {
    const u = maxWithFee(have);
    assert.ok(u + feeOf(u) <= have, `fits at ${have}`);
    assert.ok(u + 1n + feeOf(u + 1n) > have, `largest at ${have}`);
  }
});

test("Max with the fee on top, for large balances (SOL and big token amounts)", () => {
  for (const have of [1_000_000_000n, 123_456_789_012n, 999_999_999_999_999n, 18_446_744_073_709_551_615n, 1_001n * 7_777n + 1_000n]) {
    const u = maxWithFee(have);
    assert.ok(u + feeOf(u) <= have);
    assert.ok(u + 1n + feeOf(u + 1n) > have);
    // Max leaves 0 or 1 base unit; src/lib/rings.ts adds a leftover unit to the fee.
    assert.ok(have - u - feeOf(u) <= 1n, `left ${have - u - feeOf(u)} of ${have}`);
  }
});

test("the treasury is pinned: a 32-byte public address and a private-ring address the SDK reads back the same", async () => {
  assert.equal(fromBase58(TREASURY_PUBLIC).length, 32);
  const bytes = fromB64(TREASURY_RING_B64);
  await initializePoseidon();
  const ring = ShieldedAddress.fromBytes(bytes);
  assert.deepEqual([...ring.toBytes()], [...bytes]);
  assert.equal(ring.ownerHash().length, 32);
});

const ME = "9vifFijkJ8EPxepwLA2P7373qhWFXrM3JMMw5mXMpsgt";
const OTHER = "7v3bLw8sQ2kM9xT4yN6pR1cZ5aE8uH2jK4mP9wQ3Lxyz";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const usdc = (accountIndex: number, owner: string, amount: string) => ({ accountIndex, mint: USDC, owner, uiTokenAmount: { amount, decimals: 6 } });
const transfer = (destination: string) => ({ programId: SYSTEM, parsed: { type: "transfer", info: { source: ME, destination } } });

test("Activity: a SOL send with its fee names the person paid, and counts what left the wallet", () => {
  // 0.002 SOL to OTHER plus a 0.000002 SOL fee, transferred second as the wallet does.
  const t: ParsedTx = {
    blockTime: 1795181611,
    meta: { err: null, fee: 5000, preBalances: [100_000_000, 0, 5_000_000_000, 1], postBalances: [97_993_000, 2_000_000, 5_000_002_000, 1], preTokenBalances: [], postTokenBalances: [] },
    transaction: { message: { accountKeys: [ME, OTHER, TREASURY_PUBLIC, SYSTEM].map((pubkey) => ({ pubkey })), instructions: [transfer(OTHER), transfer(TREASURY_PUBLIC)] } },
  };
  assert.deepEqual(ownTxEffect(t, ME), { kind: "sent", mint: SYSTEM, units: 2_002_000n, decimals: 9, who: OTHER });
});

test("Activity: the treasury is never named as the one paid, whatever the order", () => {
  const t: ParsedTx = {
    blockTime: 1795181611,
    meta: { err: null, fee: 5000, preBalances: [100_000_000, 5_000_000_000, 0, 1], postBalances: [97_993_000, 5_000_002_000, 2_000_000, 1], preTokenBalances: [], postTokenBalances: [] },
    transaction: { message: { accountKeys: [ME, TREASURY_PUBLIC, OTHER, SYSTEM].map((pubkey) => ({ pubkey })), instructions: [transfer(TREASURY_PUBLIC), transfer(OTHER)] } },
  };
  assert.equal(ownTxEffect(t, ME)?.who, OTHER);
});

test("Activity: a token send with its fee to the treasury's token account names the person paid", () => {
  // 2 USDC to OTHER, 0.002 USDC to the treasury; the treasury's account listed first.
  const t: ParsedTx = {
    blockTime: 1795181611,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [100_000_000, 2_039_280, 2_039_280, 2_039_280, 1],
      postBalances: [99_995_000, 2_039_280, 2_039_280, 2_039_280, 1],
      preTokenBalances: [usdc(1, ME, "5000000"), usdc(2, TREASURY_PUBLIC, "10000000"), usdc(3, OTHER, "0")],
      postTokenBalances: [usdc(1, ME, "2998000"), usdc(2, TREASURY_PUBLIC, "10002000"), usdc(3, OTHER, "2000000")],
    },
    transaction: { message: { accountKeys: [ME, "mine", "treasury", "theirs", TOKEN].map((pubkey) => ({ pubkey })), instructions: [{ programId: TOKEN }] } },
  };
  assert.deepEqual(ownTxEffect(t, ME), { kind: "sent", mint: USDC, units: 2_002_000n, decimals: 6, who: OTHER });
});

test("a token fee goes only into a treasury account that can take it (not SOL parked at its address, not frozen, not another coin)", async () => {
  const { takesToken } = await import("../src/lib/rings");
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const account = (o: { mint?: string; owner?: string; state?: number; size?: number }) => {
    const data = new Uint8Array(o.size ?? 165);
    data.set(fromBase58(o.mint ?? USDC), 0);
    data.set(fromBase58(o.owner ?? TREASURY_PUBLIC), 32);
    data[108] = o.state ?? 1;
    return data;
  };
  assert.equal(takesToken({ owner: TOKEN, data: account({}) }, USDC, TREASURY_PUBLIC, TOKEN), true);
  assert.equal(takesToken(undefined, USDC, TREASURY_PUBLIC, TOKEN), false, "no account");
  assert.equal(takesToken({ owner: SYSTEM, data: new Uint8Array(0) }, USDC, TREASURY_PUBLIC, TOKEN), false, "SOL put at the address");
  assert.equal(takesToken({ owner: TOKEN, data: account({ state: 2 }) }, USDC, TREASURY_PUBLIC, TOKEN), false, "frozen");
  assert.equal(takesToken({ owner: TOKEN, data: account({ state: 0 }) }, USDC, TREASURY_PUBLIC, TOKEN), false, "not initialized");
  assert.equal(takesToken({ owner: TOKEN, data: account({ mint: SYSTEM }) }, USDC, TREASURY_PUBLIC, TOKEN), false, "another coin");
  assert.equal(takesToken({ owner: TOKEN, data: account({ owner: ME }) }, USDC, TREASURY_PUBLIC, TOKEN), false, "someone else's");
  assert.equal(takesToken({ owner: TOKEN, data: account({ size: 100 }) }, USDC, TREASURY_PUBLIC, TOKEN), false, "too short");
  assert.equal(takesToken({ owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data: account({}) }, USDC, TREASURY_PUBLIC, TOKEN), false, "another token program");
});
