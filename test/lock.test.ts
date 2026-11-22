// A lock drops the private balance: a request that outlives it keeps no synced copy or decimals, in memory or sealed.
// No network: a stubbed fetch replays recorded devnet answers for an empty new account and the TEST1 mint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { WalletError } from "@heliuslabs/spr";

// Port 9 has no listener, so a request the stub misses fails fast; the SDK accepts plain http only on localhost.
const ORIGIN = "http://127.0.0.1:9";
(globalThis as { __RINGS_DEVNET_ORIGIN?: string }).__RINGS_DEVNET_ORIGIN = ORIGIN;

const MINT = "FF4iWENV2AA58SPN9yf77SZ9wuJkhHxDowM9hb3pjZzr"; // devnet TEST1
const MINT_DATA = "AQAAADynEIyGAFWDRXR5dtt0tnkq+WSE3+Z7m62iLW0dX98yACiLlBhfigEJAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const calls: { method: string; params: { filters?: unknown } }[] = [];
let slot = 524_846_289;
/** While set, indexer answers wait on it; `arrived` is called as each indexer request comes in. */
let held: Promise<void> | null = null;
let arrived: (() => void) | null = null;

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const body = JSON.parse(String(init.body)) as { id: unknown; method: string; params: { filters?: unknown } };
  calls.push({ method: body.method, params: body.params });
  const answer = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  if (url.startsWith(`${ORIGIN}/api/helius/spr/`)) {
    arrived?.();
    if (held) await held;
    return answer({ context: { blockTime: 1795296336, slot: ++slot }, outputTreeId: 0, data: [], paginationToken: null });
  }
  if (url === `${ORIGIN}/api/helius/rpc` && body.method === "getAccountInfo") {
    return answer({ context: { slot }, value: { lamports: 1066800, data: [MINT_DATA, "base64"], owner: TOKEN_PROGRAM, executable: false, rentEpoch: 0, space: 82 } });
  }
  throw new Error(`no network in this test: ${url}`);
}) as typeof fetch;

const { kept, SNAP } = await import("../src/lib/kept");
const rings = await import("../src/lib/rings");

const newKey = () => crypto.getRandomValues(new Uint8Array(32));
const historyReads = (from: number) => calls.slice(from).filter((c) => c.method === "getShieldedTransactionsByTags");
const mintReads = () => calls.filter((c) => c.method === "getAccountInfo").length;
const settle = () => new Promise((r) => setTimeout(r, 0)); // session writes are not awaited by their callers

test("a sync queued before a lock and run after it keeps nothing: no copy in memory, none sealed in the session", async () => {
  await rings.clearSynced();
  const key = newKey();
  const ctx = rings.ctxFor("devnet", key);
  const id = `devnet:${rings.accountAddress(ctx)}`;
  let release!: () => void;
  held = new Promise((r) => (release = r));
  const waiting = new Promise<void>((r) => (arrived = r));
  const from = calls.length;
  const first = rings.syncedBalance(ctx, []);
  const queued = rings.syncedBalance(ctx, []);
  await waiting;
  arrived = null;
  await rings.clearSynced(); // what lock() runs
  held = null;
  release();
  await first;
  await queued;
  await settle();
  assert.equal(await kept.get(SNAP + id), undefined, "nothing sealed in the session after the lock");
  const reads = historyReads(from);
  assert.equal(reads.length, 2);
  assert.equal(reads[0].params.filters, undefined, "the first read built the copy");
  assert.ok(reads[1].params.filters, "the queued one only asked what's new");
  const after = rings.ctxFor("devnet", key);
  const next = calls.length;
  await rings.syncedBalance(after, []);
  assert.equal(historyReads(next)[0].params.filters, undefined, "built from nothing after the lock");
  await settle();
  assert.ok(await kept.get(SNAP + id), "and that copy, of the new session, is kept");
  // Also kept in memory: the next read is incremental.
  const again = calls.length;
  await rings.syncedBalance(after, []);
  assert.ok(historyReads(again)[0].params.filters);
  await rings.clearSynced();
});

test("a request whose keys were taken before a lock neither uses nor changes the copy of the session after it", async () => {
  await rings.clearSynced();
  const key = newKey();
  const before = rings.ctxFor("devnet", key);
  await rings.clearSynced(); // lock; the next ctxFor starts a new session
  const now = rings.ctxFor("devnet", key);
  const id = `devnet:${rings.accountAddress(now)}`;
  await rings.syncedBalance(now, []);
  await settle();
  const sealed = await kept.get<{ sealed: string }>(SNAP + id);
  assert.ok(sealed);
  const from = calls.length;
  await rings.syncedBalance(before, []);
  assert.equal(historyReads(from)[0].params.filters, undefined, "its own copy, built");
  await settle();
  assert.deepEqual(await kept.get(SNAP + id), sealed, "the new session's sealed copy is untouched");
  const next = calls.length;
  await rings.syncedBalance(now, []);
  assert.ok(historyReads(next)[0].params.filters, "and the new session's copy in memory too");
  await rings.clearSynced();
});

test("decimals asked for a request a lock overtook are kept nowhere; for the current session, until the next lock", async () => {
  await rings.clearSynced();
  const at = kept.epoch();
  await rings.clearSynced(); // lock while that read is in flight
  const r0 = mintReads();
  assert.equal(await rings.decimalsOf("devnet", MINT, at), 9);
  await settle();
  assert.equal(await kept.get(`dec:devnet:${MINT}`), undefined, "not written back into the session after the lock");
  assert.equal(await rings.decimalsOf("devnet", MINT, kept.epoch()), 9);
  assert.equal(mintReads(), r0 + 2, "nor kept in memory: read again");
  await settle();
  assert.equal(await kept.get(`dec:devnet:${MINT}`), 9, "asked in the current session: kept in the session");
  assert.equal(await rings.decimalsOf("devnet", MINT, kept.epoch()), 9);
  assert.equal(mintReads(), r0 + 2, "and in memory");
  await rings.clearSynced();
  assert.equal(await kept.get(`dec:devnet:${MINT}`), undefined);
  assert.equal(await rings.decimalsOf("devnet", MINT), 9);
  assert.equal(mintReads(), r0 + 3, "a lock forgets them in memory too");
  await rings.clearSynced();
});

test("after a lock, nothing in the background still holds the last synced copy (its keypair and coins)", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  await rings.clearSynced();
  let ctx: ReturnType<typeof rings.ctxFor> | null = rings.ctxFor("devnet", newKey());
  const copy = new WeakRef(await rings.syncedBalance(ctx, []));
  ctx = null;
  await rings.clearSynced();
  for (let i = 0; i < 3 && copy.deref(); i++) {
    await settle();
    gc();
  }
  assert.equal(copy.deref(), undefined, "the queue of syncs kept it (it held each account's last answer)");
});

test("after a sync's request runs out of time, the next syncs ask for smaller pages of history, down to 125", () => {
  const timedOut = new WalletError("WALLET_SYNC", { causeCode: "CLIENT_TIMEOUT", causeCodes: ["CLIENT_TIMEOUT"] });
  assert.equal(rings.pageLimitAfter(1000, timedOut), 500);
  assert.equal(rings.pageLimitAfter(250, timedOut), 125);
  assert.equal(rings.pageLimitAfter(125, timedOut), 125);
  const unknownCoin = new WalletError("WALLET_SYNC", { causeCode: "WALLET_UNRESOLVED_ASSET", causeCodes: ["WALLET_UNRESOLVED_ASSET"] });
  assert.equal(rings.pageLimitAfter(1000, unknownCoin), 1000);
  assert.equal(rings.pageLimitAfter(1000, new Error("CLIENT_TIMEOUT")), 1000);
});

test("a sync asks for pages of 1,000 transactions until one runs out of time", async () => {
  await rings.clearSynced();
  const from = calls.length;
  await rings.syncedBalance(rings.ctxFor("devnet", newKey()), []);
  assert.deepEqual(historyReads(from).map((c) => (c.params as { limit?: number }).limit), [1000]);
  await rings.clearSynced();
});
