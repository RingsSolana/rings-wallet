// Batched registry reads (src/lib/rings.ts) against the website's one-by-one read, on recorded devnet accounts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddressDecoder, type Address } from "@solana/kit";
import { getSplAssetRegistryAddress } from "@heliuslabs/spr/addresses";
import type { AssetRegistry } from "@heliuslabs/spr/transaction";
import { assetRegistry, type SprClient } from "../../web/src/core/chain";
import { batchedRegistry, registryEntries } from "../src/lib/rings";

const POOL = "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW";
const SOL = "11111111111111111111111111111111";
/** Each coin's registry address and recorded devnet account data (null: no registry entry). */
const RECORDED: { mint: string; pda: string; data: string | null }[] = [
  { mint: "6v74aDeQhs4o9rRq5ZsafivvjYhPdAoP39NmFTDB7Y55", pda: "3AcYDqV7PsD4cNsg9mp7Kr4ZfMVdKrAt5J7L8azS6TqR", data: "BQAAAAAAAABX5RJGPMBZdNyyekvvaEl9hxJApY9StGQyux6bqeVu2IMAAAAAAAAA" }, // devnet USDC
  { mint: "FF4iWENV2AA58SPN9yf77SZ9wuJkhHxDowM9hb3pjZzr", pda: "5r529bxnMehSsxNj8s3dvTx33d3zCLJQVDfahewBdshR", data: "BQAAAAAAAADTnfMT4yQBg+mFR63qLmQRCTGbDqefiF4jCIY31jwd2zEBAAAAAAAA" }, // TEST1
  { mint: "8g281QnLeJLhyoc8sLV6mwqUWeWhzt7MfBVUZG9CaYeB", pda: "66NLdBySwyu384EUhi28WstqnSf6thYem2cpMLfwE4Hj", data: null }, // TEST2
  { mint: "2TNM2RdoE9WdFLexFdiLQPGi8WwnMXENvLDen474qstW", pda: "7AJc9DeUBVsma5wftBmQ6v2SWerENvYirsdkCDNmCVTk", data: "BQAAAAAAAAAVnOxRPlNfdkxNlluqDXCZCracLyU4DCZtmVyiQa6ZY60BAAAAAAAA" },
  { mint: "5hKfqv2wJdDLxy1i6GsQYXDBNhCJPf8Nh8WY8cCW1Got", pda: "DwHgkn4yGMUfHAPEMiN4q8j7zbjzCvZRBR5ZrjD6Jo5z", data: "BQAAAAAAAABFwxcI8FNsn9JUthtDptLSfn15IuFXI77RbZptN7HZq7YBAAAAAAAA" },
  { mint: "6eunQMkSLPU5aavMxitc3m58WAseBfErZiDQnGK9zdZQ", pda: "9JDNiez4isrt31T2yGqNTyQ6tyZqKP17W4kSz54jREGH", data: "BQAAAAAAAABUAJs052FQmqUTqIX5edNU7oNnNlQ+y1PcM68O0cgaT6wBAAAAAAAA" },
  { mint: "Amh9Hfbd4gZ5CfwPksTmz4wmM6GAMJkKjDikwN4Gy2Pg", pda: "HNW38BDxPdmLSQZb7GUXKLx3vDWuxKnxvzM7FNUmHz5W", data: "BQAAAAAAAACRLCCtGpt1YsC+UY1RopcppCDLuj4TxY/nugzufZi/F64BAAAAAAAA" },
  { mint: "E3mVKhxzmtrzM5U2MCeizKb46dbcMzMTP7UrJP8PmJ96", pda: "U8UPaedirWqgUcY4F1w4Rk9UWeNmwhupwrMrcw9ScVd", data: "BQAAAAAAAADB3WUPPWXg7DHvEhLNT7NGdUqglKjYxq2KLA/wK+Yp2bABAAAAAAAA" },
  { mint: "FZ91zor35PuoEfKtD2gWAPHbPBL6yJKt1BnFS4tAL77C", pda: "2WQV4v3ma7SuUrkpF6Q193FBCW37Rt8e2hhCKoDhjQFy", data: "BQAAAAAAAADYP0SWTTOBZZUEW2PNVnuq8vdqfjB2G25rmP56yZsW57UBAAAAAAAA" },
  { mint: "So11111111111111111111111111111111111111112", pda: "2ttNQuBckNpiNXxvSe3Spvob9mtptXGowjzhNzWzidSE", data: "BQAAAAAAAAAGm4hX/quBhPtof2NGGMA12sQ53BrrO1WYoPAAAAAAATwAAAAAAAAA" }, // wrapped SOL
  { mint: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", pda: "AnEJkTJgigVoUa2GXbiKipMdH1HTzprPBm6PiPoCGuBz", data: null }, // not a coin
];

type Account = { owner: string; data: Uint8Array; lamports: bigint };
const asAccount = (b64: string): Account => ({ owner: POOL, data: new Uint8Array(Buffer.from(b64, "base64")), lamports: 1_000_000n });

/** Stub client over recorded accounts; counts getAccount calls (chain.ts) and getMultipleAccounts calls (wallet). */
function recorded(accounts = new Map(RECORDED.map((r) => [r.pda, r.data ? asAccount(r.data) : undefined]))) {
  const calls: { size: number; timeoutMs?: number }[] = [];
  let singles = 0;
  const client = {
    getAccount: async (a: string) => {
      singles++;
      return accounts.get(a);
    },
    getMultipleAccounts: async (list: readonly string[], context?: { timeoutMs?: number }) => {
      calls.push({ size: list.length, timeoutMs: context?.timeoutMs });
      return list.map((a) => accounts.get(a));
    },
  };
  return { client: client as unknown as SprClient, calls, singles: () => singles };
}

const entriesOf = (r: AssetRegistry) => r.entries().map(([id, mint]) => `${id}:${mint}`).sort();

test("the recorded addresses are the coins' registry addresses", async () => {
  for (const r of RECORDED) assert.equal(await getSplAssetRegistryAddress(r.mint as Address), r.pda);
});

test("the registry read in one batch equals the one read coin by coin (the website's assetRegistry)", async () => {
  const mints = [SOL, ...RECORDED.map((r) => r.mint)];
  const one = recorded();
  const sequential = await assetRegistry(one.client, mints as Address[]);
  assert.equal(one.singles(), RECORDED.length, "one call per coin");
  const many = recorded();
  const batched = await batchedRegistry(many.client, mints);
  assert.deepEqual(entriesOf(batched), entriesOf(sequential));
  assert.equal(many.singles(), 0);
  assert.deepEqual(many.calls, [{ size: RECORDED.length, timeoutMs: 15_000 }], "one call, with a time limit");
  // 9 registered coins plus built-in SOL; TEST2 and the token program have no entry.
  assert.equal(entriesOf(batched).length, 10);
  assert.ok(entriesOf(batched).includes("1:11111111111111111111111111111111"));
  assert.ok(entriesOf(batched).includes("305:FF4iWENV2AA58SPN9yf77SZ9wuJkhHxDowM9hb3pjZzr"));
  assert.ok(!entriesOf(batched).some((e) => e.endsWith(":8g281QnLeJLhyoc8sLV6mwqUWeWhzt7MfBVUZG9CaYeB")));
});

test("the entries for some coins only (a coin joining a synced copy): asked once each, SOL never", async () => {
  const one = recorded();
  const list = await registryEntries(one.client, [SOL, RECORDED[1].mint, RECORDED[1].mint, RECORDED[2].mint]);
  assert.deepEqual(list.map(([id, mint]) => `${id}:${mint}`), [`305:${RECORDED[1].mint}`]);
  assert.deepEqual(one.calls.map((c) => c.size), [2]);
  assert.deepEqual(await registryEntries(one.client, [SOL]), []);
});

test("more than 100 coins: calls of 100 at most, the answers kept in order", async () => {
  const decoder = getAddressDecoder();
  const random = Array.from({ length: 230 }, () => decoder.decode(crypto.getRandomValues(new Uint8Array(32))));
  const mints = [...random.slice(0, 150), RECORDED[0].mint, ...random.slice(150), RECORDED[1].mint];
  const r = recorded();
  const list = await registryEntries(r.client, mints);
  assert.deepEqual(r.calls.map((c) => c.size), [100, 100, 32]);
  assert.deepEqual(list.map(([id, mint]) => `${id}:${mint}`), [`131:${RECORDED[0].mint}`, `305:${RECORDED[1].mint}`]);
});

test("an account the pool doesn't own at a coin's registry address, or one that isn't a registry entry, is no entry", async () => {
  // Anyone can fund any address: a system-owned empty account at a registry address must read as no entry.
  const SYSTEM = "11111111111111111111111111111111";
  const accounts = new Map(RECORDED.map((r) => [r.pda, r.data ? asAccount(r.data) : undefined]));
  accounts.set(RECORDED[2].pda, { owner: SYSTEM, data: new Uint8Array(0), lamports: 890_880n }); // TEST2's, funded
  accounts.set(RECORDED[3].pda, { owner: POOL, data: new Uint8Array(7), lamports: 1_000_000n }); // not an entry
  const mints = [RECORDED[1].mint, RECORDED[2].mint, RECORDED[3].mint];
  await assert.rejects(assetRegistry(recorded(accounts).client, mints as Address[]), "the website's read fails on it");
  const list = await registryEntries(recorded(accounts).client, mints);
  assert.deepEqual(list.map(([id, mint]) => `${id}:${mint}`), [`305:${RECORDED[1].mint}`], "the others still read");
  // A valid entry owned by another program (only a lying server could answer this) is no entry either.
  accounts.set(RECORDED[1].pda, { ...asAccount(RECORDED[1].data!), owner: SYSTEM });
  assert.deepEqual(await registryEntries(recorded(accounts).client, mints), []);
});

test("an account at a coin's registry address naming another coin is left out", async () => {
  // TEST2's registry address answering with USDC's entry, as only a lying server could.
  const accounts = new Map(RECORDED.map((r) => [r.pda, r.data ? asAccount(r.data) : undefined]));
  accounts.set(RECORDED[2].pda, asAccount(RECORDED[0].data!));
  const r = recorded(accounts);
  const list = await registryEntries(r.client, [RECORDED[2].mint]);
  assert.deepEqual(list, []);
});
