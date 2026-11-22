// DEVNET ONLY helper: sends TEST1 from the test wallet's private balance to a public address.
//   npx tsx test/devnet-send-test-coin.ts <to> <units>
import { readFileSync } from "node:fs";
import { accountSecret, phraseSeed } from "../src/lib/keys";
import { ctxFor } from "../src/lib/rings";
import { withdrawTo } from "../src/lib/pay";
import { ensureSession } from "../src/lib/session";

const TEST1 = "FF4iWENV2AA58SPN9yf77SZ9wuJkhHxDowM9hb3pjZzr";
const [to, units] = process.argv.slice(2);
if (!to || !units) throw new Error("usage: devnet-send-test-coin.ts <to> <units>");
const phrase = readFileSync(new URL("../.devdata/devnet-phrase.txt", import.meta.url), "utf8").trim();
const ctx = ctxFor("devnet", accountSecret(phraseSeed(phrase), 0));
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
await ensureSession(ctx);
const r = await withdrawTo(ctx, TEST1, BigInt(units), to);
console.log(`sent: https://solscan.io/tx/${r.signature}?cluster=devnet (fee paid by ${r.paidBy})`);
process.exit(0);
