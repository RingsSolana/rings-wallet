// ownTxEffect: how transactions the account signed outside the wallet show in Activity (mainnet-shaped fixtures).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHIELDED_POOL_PROGRAM_ID } from "@heliuslabs/spr";
import { ownTxEffect, type ParsedTx } from "../src/lib/chainActivity";

const ME = "9vifFijkJ8EPxepwLA2P7373qhWFXrM3JMMw5mXMpsgt";
const OTHER = "7v3bLw8sQ2kM9xT4yN6pR1cZ5aE8uH2jK4mP9wQ3Lxyz";
const RINGS_ACCOUNT = "26usLFq9hT3mK8xP2vR5cN7wY4aB6eJ1sD9gQ3zL5kM";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const COMPUTE = "ComputeBudget111111111111111111111111111111";

const usdc = (accountIndex: number, owner: string, amount: string) => ({ accountIndex, mint: USDC, owner, uiTokenAmount: { amount, decimals: 6 } });
const tx = (o: { keys: string[]; programs: string[]; pre: number[]; post: number[]; fee?: number; preT?: ReturnType<typeof usdc>[]; postT?: ReturnType<typeof usdc>[]; err?: unknown; parsed?: { programId: string; parsed: { type: string; info: { source: string; destination: string } } }[] }): ParsedTx => ({
  blockTime: 1795181611,
  meta: { err: o.err ?? null, fee: o.fee ?? 5000, preBalances: o.pre, postBalances: o.post, preTokenBalances: o.preT ?? [], postTokenBalances: o.postT ?? [] },
  transaction: { message: { accountKeys: o.keys.map((pubkey) => ({ pubkey })), instructions: [...o.programs.map((programId) => ({ programId })), ...(o.parsed ?? [])] } },
});

test("a jup.ag buy shows as Swapped, the coin received, with Jupiter", () => {
  const e = ownTxEffect(tx({ keys: [ME, "ata1", JUP], programs: [COMPUTE, JUP], pre: [1_000_000_000, 2_039_280, 1], post: [989_976_000, 2_039_280, 1], fee: 24_000, preT: [usdc(1, ME, "0")], postT: [usdc(1, ME, "707466")] }), ME);
  assert.deepEqual(e, { kind: "swapped", mint: USDC, units: 707_466n, decimals: 6, who: "Jupiter" });
});

test("a jup.ag sell shows the SOL received", () => {
  const e = ownTxEffect(tx({ keys: [ME, "ata1", JUP], programs: [COMPUTE, JUP], pre: [990_000_000, 2_039_280, 1], post: [999_895_000, 2_039_280, 1], fee: 32_052, preT: [usdc(1, ME, "707466")], postT: [usdc(1, ME, "0")] }), ME);
  assert.equal(e?.kind, "swapped");
  assert.equal(e?.mint, SYSTEM);
  assert.equal(e?.units, 9_927_052n);
  assert.equal(e?.who, "Jupiter");
});

test("a Rings deposit is left to the wallet's own records", () => {
  assert.equal(ownTxEffect(tx({ keys: [ME, "vault"], programs: [SHIELDED_POOL_PROGRAM_ID], pre: [100_000_000, 0], post: [84_595_000, 15_400_000] }), ME), null);
});

test("a fee top-up to the account's own Rings account is left out", () => {
  const t = tx({ keys: [ME, RINGS_ACCOUNT, SYSTEM], programs: [], pre: [100_000_000, 0, 1], post: [84_995_000, 15_000_000, 1], parsed: [{ programId: SYSTEM, parsed: { type: "transfer", info: { source: ME, destination: RINGS_ACCOUNT } } }] });
  assert.equal(ownTxEffect(t, ME, RINGS_ACCOUNT), null);
});

test("SOL paid to someone through a plain transfer names who got it", () => {
  const t = tx({ keys: [ME, OTHER, SYSTEM], programs: [], pre: [100_000_000, 0, 1], post: [97_995_000, 2_000_000, 1], parsed: [{ programId: SYSTEM, parsed: { type: "transfer", info: { source: ME, destination: OTHER } } }] });
  assert.deepEqual(ownTxEffect(t, ME), { kind: "sent", mint: SYSTEM, units: 2_000_000n, decimals: 9, who: OTHER });
});

test("a token sent to someone names the new owner", () => {
  const t = tx({ keys: [ME, "mine", "theirs", TOKEN], programs: [TOKEN], pre: [100_000_000, 2_039_280, 2_039_280, 1], post: [99_995_000, 2_039_280, 2_039_280, 1], preT: [usdc(1, ME, "5000000"), usdc(2, OTHER, "0")], postT: [usdc(1, ME, "3000000"), usdc(2, OTHER, "2000000")] });
  assert.deepEqual(ownTxEffect(t, ME), { kind: "sent", mint: USDC, units: 2_000_000n, decimals: 6, who: OTHER });
});

test("nothing moved (an approval, an account opened, a failed or someone else's transaction): nothing shown", () => {
  assert.equal(ownTxEffect(tx({ keys: [ME, JUP], programs: [JUP], pre: [100_000_000, 1], post: [99_995_000, 1] }), ME), null);
  assert.equal(ownTxEffect(tx({ keys: [ME, "ata1", JUP], programs: [JUP], pre: [1_000_000_000, 0, 1], post: [989_976_000, 0, 1], preT: [usdc(1, ME, "0")], postT: [usdc(1, ME, "707466")], err: { InstructionError: [0, "Custom"] } }), ME), null);
  assert.equal(ownTxEffect(tx({ keys: [OTHER, ME], programs: [], pre: [100_000_000, 0], post: [97_995_000, 2_000_000] }), ME), null);
});
