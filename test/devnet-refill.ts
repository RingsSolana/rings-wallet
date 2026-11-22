// DEVNET ONLY: moves the test wallet's public SOL into its private balance, without the Rings fee.
//   npx tsx test/devnet-refill.ts [lamports, default 300000000]
import { readFileSync } from "node:fs";
import { accountSecret, phraseSeed } from "../src/lib/keys";
import { SOL_MINT } from "../src/lib/net";
import { ctxFor, privateUnits, shield } from "../src/lib/rings";

const phrase = readFileSync(new URL("../.devdata/devnet-phrase.txt", import.meta.url), "utf8").trim();
const ctx = ctxFor("devnet", accountSecret(phraseSeed(phrase), 0));
const lamports = BigInt(process.argv[2] ?? "300000000");
const before = (await privateUnits(ctx, [])).get(SOL_MINT) ?? 0n;
const r = await shield(ctx, SOL_MINT, lamports, undefined, { topUp: false });
console.log(`private SOL was ${before} lamports; moved ${lamports} in: https://solscan.io/tx/${r.signature}?cluster=devnet`);
process.exit(0);
