// DEVNET ONLY: times private-balance syncs (full and cached), private sends and a deposit with the test wallet.
//   npx tsx test/devnet-timing.ts
import { readFileSync } from "node:fs";
import { syncBalance } from "../../web/src/core/chain";
import { accountSecret, phraseSeed } from "../src/lib/keys";
import { client, ctxFor, parsePrivateAddress, privateAddressOf, privateUnits, sendPrivately, shield } from "../src/lib/rings";
import { payPrivately } from "../src/lib/pay";
import { ensureSession } from "../src/lib/session";

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
const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t = performance.now();
  const r = await fn();
  console.log(`${label}: ${((performance.now() - t) / 1000).toFixed(1)} s`);
  return r;
};
const cl = await time("client (prover attestation, first use)", () => client("devnet"));
await time("full private-balance sync (each send did this)", () => syncBalance(cl, a0.keys.accountSeed, []));
await time("full sync again", () => syncBalance(cl, a0.keys.accountSeed, []));
await time("cached sync, first (builds the cache)", () => privateUnits(a0, []));
await time("cached sync, next (only what's new)", () => privateUnits(a0, []));
await time("sign-in check", () => ensureSession(a0));
const to = (await parsePrivateAddress("devnet", await privateAddressOf(a1)))!;
await time("private send 0.0001 SOL, network fee paid by the account key", () => payPrivately(a0, "11111111111111111111111111111111", 100_000n, to));
await time("private send 0.0001 SOL, fee paid by the Rings account (all of it)", () => sendPrivately(a0, "11111111111111111111111111111111", 100_000n, to));
await time("make private 0.001 SOL (a deposit, all of it)", () => shield(a0, "11111111111111111111111111111111", 1_000_000n));
process.exit(0);
