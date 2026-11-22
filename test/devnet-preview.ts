// DEVNET ONLY: the transaction preview (src/lib/simulate.ts) with address lookup tables; makes one table (~0.002 SOL).
//   npx tsx test/devnet-preview.ts
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from "@solana/kit";
import { accountSecret, phraseSeed } from "../src/lib/keys";
import { rpc } from "../src/lib/net";
import { preview } from "../src/lib/simulate";

const web3 = createRequire(new URL("../../web/package.json", import.meta.url))("@solana/web3.js") as typeof import("@solana/web3.js");
const phrase = readFileSync(new URL("../.devdata/devnet-phrase.txt", import.meta.url), "utf8").trim();
const payer = web3.Keypair.fromSeed(accountSecret(phraseSeed(phrase), 0));
const owner = payer.publicKey.toBase58();
const conn = new web3.Connection("https://api.devnet.solana.com", "confirmed");

let failures = 0;
const check = (ok: boolean, label: string, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};

const dest = web3.Keypair.generate().publicKey;
// The table address derives from a recent slot the program checks; a skipped slot fails, so retry a few times.
let table: import("@solana/web3.js").PublicKey | null = null;
let made = "";
for (let i = 0; i < 4 && !table; i++) {
  const slot = await conn.getSlot("confirmed");
  const [create, t] = web3.AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot - 2 });
  const extend = web3.AddressLookupTableProgram.extendLookupTable({ lookupTable: t, authority: payer.publicKey, payer: payer.publicKey, addresses: [dest] });
  try {
    made = await web3.sendAndConfirmTransaction(conn, new web3.Transaction().add(create, extend), [payer], { commitment: "confirmed" });
    table = t;
  } catch (e) {
    console.log("lookup table not made, trying again:", (e as Error).message.split("\n")[0]);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
if (!table) throw new Error("Couldn't make the lookup table.");
console.log("lookup table", table.toBase58(), "made:", made.slice(0, 12) + "…");
await new Promise((r) => setTimeout(r, 4000)); // addresses added to a table are usable only from the next slot

const SYSTEM = address("11111111111111111111111111111111");
const transfer = (lamports: bigint) => {
  const d = new Uint8Array(12);
  d[0] = 2;
  new DataView(d.buffer).setBigUint64(4, lamports, true);
  return { programAddress: SYSTEM, accounts: [{ address: address(owner), role: 3 }, { address: address(dest.toBase58()), role: 1 }], data: d };
};
const assign = () => {
  const d = new Uint8Array(36);
  d[0] = 1;
  d.set(getAddressEncoder().encode(address("Stake11111111111111111111111111111111111111")), 4);
  return { programAddress: SYSTEM, accounts: [{ address: address(owner), role: 3 }], data: d };
};
const { value: bh } = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("devnet", "getLatestBlockhash", [{ commitment: "confirmed" }]);
const wireOf = (ixs: ReturnType<typeof transfer>[], tables: Record<string, string[]>) =>
  getBase64EncodedWireTransaction(
    compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(address(owner), m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.blockhash as never, lastValidBlockHeight: BigInt(bh.lastValidBlockHeight) }, m),
        (m) => appendTransactionMessageInstructions(ixs as never, m),
        (m) => compressTransactionMessageUsingAddressLookupTables(m, Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((a) => address(a))])) as Record<Address, Address[]>),
      ),
    ),
  );
const tables = { [table.toBase58()]: [dest.toBase58()] };

const plain = await preview("devnet", [wireOf([transfer(1_000_000n)], tables)], owner);
const sent = plain.changes.find((c) => c.sym === "SOL")?.amount ?? 0;
check(plain.ok && plain.danger === null && sent < 0, "a transfer through a lookup table: read, simulated, no risk", `SOL ${sent}`);

const hidden = await preview("devnet", [wireOf([transfer(1_000_000n), assign()], tables)], owner);
check(/hand your account/.test(hidden.danger ?? ""), "handing the account over still seen with a lookup table in the transaction", hidden.danger ?? "none");

const fake = web3.Keypair.generate().publicKey.toBase58();
const unread = await preview("devnet", [wireOf([transfer(1_000_000n)], { [fake]: [dest.toBase58()] })], owner);
check(/couldn't read/.test(unread.danger ?? ""), "a lookup table that can't be read counts as a risk", unread.danger ?? "none");

console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
