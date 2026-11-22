// Approval steps for NFTs: Core and compressed NFTs move no token account, so the balance preview can't show
// them leaving; the steps must say where each goes and who gets rights over it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { transactionDetails } from "../src/lib/decode";

const OWNER = "Vote111111111111111111111111111111111111111";
const OTHER = "SysvarRent111111111111111111111111111111111";
const ASSET = "SysvarC1ock11111111111111111111111111111111";
const FILL = "SysvarS1otHashes111111111111111111111111111";
const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const BUBBLEGUM = "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";
const TOKEN_METADATA = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

type Acc = [string, number];
const ix = (program: string, accounts: Acc[], data: number[]) => ({
  programAddress: address(program),
  accounts: accounts.map(([a, role]) => ({ address: address(a), role })),
  data: Uint8Array.from(data),
});
const wire = (i: ReturnType<typeof ix>) =>
  getBase64EncodedWireTransaction(
    compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(address(OWNER), m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as never, lastValidBlockHeight: 0n }, m),
        (m) => appendTransactionMessageInstructions([i as never], m),
      ),
    ),
  );
const rows = async (i: ReturnType<typeof ix>) => (await transactionDetails("devnet", [wire(i)], OWNER)).map((r) => `${r.label}: ${r.value}`);

test("a Core NFT sent to someone says where it goes", async () => {
  const r = await rows(ix(CORE, [[ASSET, 1], [CORE, 0], [OWNER, 3], [OWNER, 2], [OTHER, 0], [FILL, 0], [CORE, 0]], [14, 0]));
  assert.ok(r.some((x) => x === `Send an NFT: ${short(ASSET)} to ${short(OTHER)}`), r.join(" | "));
});

test("a Core plugin handing rights over an NFT is spelled out", async () => {
  const r = await rows(ix(CORE, [[ASSET, 1], [CORE, 0], [OWNER, 3], [OWNER, 2], [FILL, 0], [CORE, 0]], [2, 0]));
  assert.ok(r.some((x) => x.startsWith("Change who has rights over an NFT")), r.join(" | "));
});

test("a compressed NFT sent to someone says where it goes", async () => {
  const data = [163, 52, 200, 231, 140, 3, 69, 186, ...new Array(108).fill(0)];
  const r = await rows(ix(BUBBLEGUM, [[FILL, 0], [OWNER, 2], [OWNER, 0], [OTHER, 0], [ASSET, 1]], data));
  assert.ok(r.some((x) => x === `Send a compressed NFT: to ${short(OTHER)}`), r.join(" | "));
});

test("a compressed NFT delegation names who may move it", async () => {
  const data = [90, 147, 75, 178, 85, 88, 4, 137, ...new Array(108).fill(0)];
  const r = await rows(ix(BUBBLEGUM, [[FILL, 0], [OWNER, 2], [OWNER, 0], [OTHER, 0], [ASSET, 1]], data));
  assert.ok(r.some((x) => x === `Let someone move a compressed NFT: ${short(OTHER)}`), r.join(" | "));
});

test("a programmable NFT sent through Token Metadata says where it goes", async () => {
  const accounts: Acc[] = [[FILL, 1], [OWNER, 0], [FILL, 1], [OTHER, 0], [ASSET, 0], [FILL, 1], [FILL, 0], [FILL, 1], [FILL, 1], [OWNER, 2], [OWNER, 3]];
  const r = await rows(ix(TOKEN_METADATA, accounts, [49, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert.ok(r.some((x) => x === `Send an NFT: ${short(ASSET)} to ${short(OTHER)}`), r.join(" | "));
});
