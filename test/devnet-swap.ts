// DEVNET ONLY: a private SOL swap through the devnet Rings relay with the wallet's own code, followed to the end.
//   npx tsx test/devnet-swap.ts [lamports]
import { readFileSync } from "node:fs";
import { accountSecret, phraseSeed } from "../src/lib/keys";
import { DEVNET_ALIASES, SOL_MINT } from "../src/lib/net";
import { ctxFor, privateUnits } from "../src/lib/rings";
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
const ctx = ctxFor("devnet", accountSecret(phraseSeed(phrase), 0));
const lamports = BigInt(process.argv[2] ?? "10000000");
const coin = Object.keys(DEVNET_ALIASES)[0];

await ensureSession(ctx);
console.log("signed in as", ctx.wallet);
const before = await privateUnits(ctx, [coin]);
const q = await quote("devnet", SOL_MINT, coin, lamports, 300);
console.log(`quote: ${Number(lamports) / 1e9} SOL -> ${q.outAmount} units of ${coin.slice(0, 4)}… (min ${q.minOut})`);
// As in the background: costs first, so paySwap can check Rings' payment asks against them.
const ask = { inMint: SOL_MINT, outMint: coin, amount: lamports, quote: q, slippageBps: 300, deliver: "private" as const, to: null };
const costs = await swapCosts(ctx, { ...ask, accounts: q.accounts });
const made = await createSwap(ctx, ask);
console.log(`Rings asks: ${made.payments.map((p) => `${p.amount} of ${p.mint.slice(0, 4)}…`).join(", ")} (costs figure ${costs})`);
const paid = await paySwap(ctx, made, { inMint: SOL_MINT, units: lamports, maxCosts: costs }, async (p) => console.log(`  swap ${made.id}: paid ${p.length}/${made.payments.length} (${p.map((x) => x.signature).join(", ")})`));
await tellPaid("devnet", made.id, paid);
const id = made.id;
console.log("swap", id, "paid privately; following…");
for (let i = 0; i < 120; i++) {
  const s = await swapStatus("devnet", id);
  if (i % 5 === 0 || ["done", "delivered", "refunded", "failed"].includes(s.state)) console.log(" ", s.state, s.error ?? "");
  if (["done", "delivered", "refunded", "failed"].includes(s.state)) break;
  await new Promise((r) => setTimeout(r, 4000));
}
const after = await privateUnits(ctx, [coin]);
console.log(`private ${coin.slice(0, 4)}…: ${before.get(coin) ?? 0n} -> ${after.get(coin) ?? 0n} | private SOL: ${before.get(SOL_MINT)} -> ${after.get(SOL_MINT)}`);
process.exit(0);
