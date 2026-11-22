// DEVNET ONLY, nothing signed: the transaction preview (src/lib/simulate.ts) of a website-built Rings deposit.
//   npx tsx test/devnet-preview-deposit.ts
import { readFileSync } from "node:fs";
import type { Address } from "@solana/kit";
import { ACCOUNT_FEE_FLOAT, buildDeposit } from "../../web/src/core/chain";
import { accountSecret, phraseSeed } from "../src/lib/keys";
import { accountAddress, client, ctxFor } from "../src/lib/rings";
import { SOL_MINT } from "../src/lib/net";
import { preview } from "../src/lib/simulate";

const phrase = readFileSync(new URL("../.devdata/devnet-phrase.txt", import.meta.url), "utf8").trim();
const ctx = ctxFor("devnet", accountSecret(phraseSeed(phrase), 0));
const cl = await client("devnet");
for (const sol of [0.01, 50]) {
  const wire = await buildDeposit(cl, {
    wallet: ctx.wallet as Address,
    mint: SOL_MINT as Address,
    amount: BigInt(Math.round(sol * 1e9)),
    recipientSeed: ctx.keys.accountSeed,
    topUp: { to: accountAddress(ctx) as Address, lamports: ACCOUNT_FEE_FLOAT },
  });
  const pv = await preview("devnet", [wire], ctx.wallet, { ringsAccount: accountAddress(ctx), ringsSite: true });
  console.log(`deposit ${sol} SOL:`, pv.ok ? "" : "FAILS", JSON.stringify({ changes: pv.changes.map((c) => `${c.name}: ${c.amount} ${c.sym}`), fee: pv.fee, reason: pv.reason, danger: pv.danger }));
}
process.exit(0);
