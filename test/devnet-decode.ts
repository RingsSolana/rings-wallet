// DEVNET ONLY, nothing signed: the approval window's decoded rows (src/lib/decode.ts) for a SOL send, a Rings deposit,
// a transaction disguised as a message, the Rings key message and Sign in with Solana.   npx tsx test/devnet-decode.ts
import { readFileSync } from "node:fs";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from "@solana/kit";
import { ACCOUNT_FEE_FLOAT, buildDeposit } from "../../web/src/core/chain";
import { keyMessage } from "../../web/src/core/keys";
import { utf8 } from "../../web/src/core/codec";
import { accountSecret, phraseSeed } from "../src/lib/keys";
import { accountAddress, client, ctxFor } from "../src/lib/rings";
import { NETWORKS, SOL_MINT, rpc } from "../src/lib/net";
import { messageDetails, transactionDetails } from "../src/lib/decode";

let failures = 0;
const check = (ok: boolean, label: string, rows: { label: string; value: string }[]) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  for (const r of rows) console.log(`       ${r.label}: ${r.value}`);
};

const phrase = readFileSync(new URL("../.devdata/devnet-phrase.txt", import.meta.url), "utf8").trim();
const ctx = ctxFor("devnet", accountSecret(phraseSeed(phrase), 0));
const owner = ctx.wallet;
const rings = accountAddress(ctx);
const cl = await client("devnet");
const { value: bh } = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("devnet", "getLatestBlockhash", [{ commitment: "confirmed" }]);

// System transfer data: u32 instruction index 2, then u64 lamports at byte 4.
const to = "JAi9SNkk4SpHECA16h7r846XYHH4zEEjU7b663g4xA4J";
const data = new Uint8Array(12);
data[0] = 2;
new DataView(data.buffer).setBigUint64(4, 1_000_000n, true);
const transfer = { programAddress: address("11111111111111111111111111111111"), accounts: [{ address: address(owner), role: 3 }, { address: address(to), role: 1 }], data };
const tx = compileTransaction(
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(owner), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.blockhash as never, lastValidBlockHeight: BigInt(bh.lastValidBlockHeight) }, m),
    (m) => appendTransactionMessageInstructions([transfer] as never, m),
  ),
);
const send = await transactionDetails("devnet", [getBase64EncodedWireTransaction(tx)], owner, rings);
check(send.some((r) => r.label === "Send SOL" && /^0\.001 SOL to JAi9…xA4J$/.test(r.value)), "a SOL send reads as \"Send SOL: 0.001 SOL to JAi9…xA4J\"", send);

const deposit = await buildDeposit(cl, { wallet: owner as Address, mint: SOL_MINT as Address, amount: 10_000_000n, recipientSeed: ctx.keys.accountSeed, topUp: { to: rings as Address, lamports: ACCOUNT_FEE_FLOAT } });
const dep = await transactionDetails("devnet", [deposit], owner, rings);
check(dep.some((r) => /your Rings account/.test(r.value)) && dep.some((r) => r.label === "Rings private balance"), "a Rings top-up names the Rings account's fee float and the private balance", dep);

const disguised = await messageDetails("devnet", tx.messageBytes as unknown as Uint8Array, "", owner);
check(disguised[0]?.label === "Careful" && disguised.some((r) => r.label === "Send SOL"), "a transaction passed off as a message is decoded and flagged", disguised);

const km = keyMessage(NETWORKS.devnet.keyHost, owner);
const key = await messageDetails("devnet", utf8(km), km, owner);
check(/Your Rings key for localhost:3101/.test(key[0]?.value ?? ""), "the Rings key message says what it is", key);

const siwsText = `jup.ag wants you to sign in with your Solana account:\n${owner}\n\nWelcome\n\nURI: https://jup.ag\nVersion: 1\nChain ID: mainnet\nNonce: abc12345\nIssued At: 2026-11-20T10:00:00Z`;
const siws = await messageDetails("devnet", utf8(siwsText), siwsText, owner);
check(siws[0]?.value === "jup.ag" && siws.some((r) => r.label === "Address" && r.value === "This address"), "a Sign in with Solana message lists the site and the address", siws);

console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
