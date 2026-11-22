// A sync that meets a coin it can't name (WALLET_UNRESOLVED_ASSET) is retried once (src/lib/rings.ts syncKept).
// No network: a stub replays recorded devnet answers for a fixed test key holding 1 base unit of TEST1.
import { test } from "node:test";
import assert from "node:assert/strict";

// Port 9 has no listener, so a request the stub misses fails fast; the SDK accepts plain http only on localhost.
const ORIGIN = "http://127.0.0.1:9";
(globalThis as { __RINGS_DEVNET_ORIGIN?: string }).__RINGS_DEVNET_ORIGIN = ORIGIN;

const POOL = "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW";
const TEST1 = "FF4iWENV2AA58SPN9yf77SZ9wuJkhHxDowM9hb3pjZzr";
const TEST1_REGISTRY = "5r529bxnMehSsxNj8s3dvTx33d3zCLJQVDfahewBdshR";
const TEST1_ENTRY = "BQAAAAAAAADTnfMT4yQBg+mFR63qLmQRCTGbDqefiF4jCIY31jwd2zEBAAAAAAAA"; // asset id 305
const DEPOSIT = {
  slot: 524847452,
  signature: "5idzK23bKLJneBtLvUzmJUF1F6XC4hqJHAXWLCyvb36tZaj68uNZwtnF2hVKGFbmrWsTkSEJgrRzVpMmKBqN6qWe",
  outputSlot: {
    viewTag: "9Qedt5Y2SQZzBVaRFMib15D1oyCoeaBzpv2eKGq536tK",
    outputContext: { hash: "3kDvnpfBkRiKHNpqJZZ4zyQfSAyN4Ut6F1MWdUzw2q3q", tree: "777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor", treeId: 0, leafIndex: 608187 },
    payload: "AG8AAAAAGA4JOq1Hq6AcbReY5z2dYJqVlVIn59OGvgZYoycQAikAAPmGerLYMWFIIVdHAVgs0xUswghqJbYMPt6YLMPd/dOd8xPjJAGD6YVHreouZBEJMZsOp5+IXiMIhjfWPB3bAQAAAAAAAAAAAAAAAAA=",
  },
};

/** Queued stub answers: registry scans ("short" lists nothing), TEST1 registry reads, and indexer delays in ms. */
const plan = { scans: [] as ("short" | "full")[], reads: [] as ("none" | "entry")[], indexerMs: [] as number[] };
const calls: { method: string; at: number }[] = [];
let slot = 524_847_461;

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const body = JSON.parse(String(init.body)) as { id: unknown; method: string; params: unknown };
  calls.push({ method: body.method, at: performance.now() });
  const answer = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  if (url.startsWith(`${ORIGIN}/api/helius/spr/`)) {
    const ms = plan.indexerMs.shift() ?? 0;
    if (ms) await new Promise((r) => setTimeout(r, ms));
    const since = (body.params as { filters?: { slot?: { gt?: number } } }).filters?.slot?.gt ?? 0;
    const page = (data: unknown[]) => answer({ context: { blockTime: 1795296618, slot: ++slot }, outputTreeId: 0, data: since >= DEPOSIT.slot ? [] : data, paginationToken: null });
    if (body.method === "getEncryptedUtxosByTags") {
      return page([{ slot: DEPOSIT.slot, signature: DEPOSIT.signature, outputs: [{ slot: DEPOSIT.slot, txSignature: DEPOSIT.signature, outputSlot: DEPOSIT.outputSlot, txViewingPk: null, salt: null }] }]);
    }
    return page([]); // no transfers, and the deposit unspent
  }
  if (url === `${ORIGIN}/api/helius/rpc` && body.method === "getMultipleAccounts") {
    const list = (body.params as [string[]])[0];
    const entry = plan.reads.shift() ?? "entry";
    const account = { lamports: 894080, data: [TEST1_ENTRY, "base64"], owner: POOL, executable: false, rentEpoch: 0, space: 48 };
    return answer({ context: { slot }, value: list.map((a) => (a === TEST1_REGISTRY && entry === "entry" ? account : null)) });
  }
  if (url === `${ORIGIN}/api/helius/rpc` && body.method === "getProgramAccounts") {
    const full = (plan.scans.shift() ?? "full") === "full";
    return answer(full ? [{ pubkey: TEST1_REGISTRY, account: { lamports: 894080, data: [TEST1_ENTRY, "base64"], owner: POOL, executable: false, rentEpoch: 0, space: 48 } }] : []);
  }
  throw new Error(`no network in this test: ${url} ${body.method}`);
}) as typeof fetch;

const rings = await import("../src/lib/rings");
/** A new ctx for the fixed key on each call, as the background makes one per request (Ctx.epoch). */
const key = () => rings.ctxFor("devnet", new Uint8Array(32).fill(9));
const callsOf = (from: number, method: string) => calls.slice(from).filter((c) => c.method === method);

test("the recorded deposit reads as 1 base unit of TEST1 when the copy knows the coin (no scan)", async () => {
  await rings.clearSynced();
  const from = calls.length;
  assert.equal((await rings.privateUnits(key(), [TEST1])).get(TEST1), 1n);
  assert.equal(callsOf(from, "getProgramAccounts").length, 0);
});

test("a coin the copy looked up before anyone registered it: read again after the failed sync, which is tried again at once", async () => {
  await rings.clearSynced();
  plan.reads = ["none", "entry"]; // unregistered at the first read, registered by the retry
  plan.scans = ["short"];
  const from = calls.length;
  const t0 = performance.now();
  assert.equal((await rings.privateUnits(key(), [TEST1])).get(TEST1), 1n);
  assert.equal(callsOf(from, "getProgramAccounts").length, 1, "the short scan only: the retry needed none");
  assert.equal(callsOf(from, "getMultipleAccounts").length, 2, "the registry read, then the coin read again");
  assert.ok(performance.now() - t0 < 4_000, "no wait before the retry");
  // The coin is in the copy: the next sync needs no scan and no registry read.
  const next = calls.length;
  await rings.privateUnits(key(), [TEST1]);
  assert.equal(callsOf(next, "getProgramAccounts").length + callsOf(next, "getMultipleAccounts").length, 0);
  await rings.clearSynced();
});

test("a coin only the scan can name: the retry's scan comes 5 s after the first one, so rings.run's proxy doesn't hand back the same answer", async () => {
  // rings.run's RPC proxy reuses a scan's answer for 5 s from its start.
  await rings.clearSynced();
  plan.reads = [];
  plan.scans = ["short", "full"];
  plan.indexerMs = [400, 400, 50, 50]; // a slower first try: the gap must count from its scan, not its start
  const from = calls.length;
  assert.equal((await rings.privateUnits(key(), [])).get(TEST1), 1n, "a coin the wallet wasn't told about still shows");
  const scans = callsOf(from, "getProgramAccounts");
  assert.equal(scans.length, 2, "tried once more");
  assert.ok(scans[1].at - scans[0].at >= 5_000, `the second scan ${Math.round(scans[1].at - scans[0].at)} ms after the first`);
  assert.equal(callsOf(from, "getMultipleAccounts").length, 0, "no coin of its own to read again");
  plan.indexerMs = [];
  await rings.clearSynced();
});

test("still short at the retry: the sync fails with the SDK's error, tried once more only", async () => {
  await rings.clearSynced();
  plan.scans = ["short", "short", "full"];
  const from = calls.length;
  await assert.rejects(rings.privateUnits(key(), []), (e) => rings.unresolvedAsset(e));
  assert.equal(callsOf(from, "getProgramAccounts").length, 2);
  plan.scans = [];
  await rings.clearSynced();
});
