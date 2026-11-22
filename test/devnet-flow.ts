// DEVNET ONLY: shield, private send and unshield of SOL on the devnet copy (:3101); private balances must move exactly.
//   npx tsx test/devnet-flow.ts [shield|send|unshield|all]
import { readFileSync } from "node:fs";
import { accountSecret, phraseSeed } from "../src/lib/keys";
import { SOL_MINT, publicBalances } from "../src/lib/net";
import { accountAddress, ctxFor, parsePrivateAddress, privateAddressOf, privateUnits, sendPrivately, shield, unshield } from "../src/lib/rings";

const phrase = readFileSync(new URL("../.devdata/devnet-phrase.txt", import.meta.url), "utf8").trim();
const seed = phraseSeed(phrase);
const a0 = ctxFor("devnet", accountSecret(seed, 0));
const a1 = ctxFor("devnet", accountSecret(seed, 1));
const step = process.argv[2] ?? "all";
const sol = (u: bigint) => `${(Number(u) / 1e9).toFixed(4)} SOL`;
const link = (s: string) => `https://solscan.io/tx/${s}?cluster=devnet`;

async function show(label: string) {
  const [pub, priv0, priv1] = await Promise.all([publicBalances("devnet", a0.wallet), privateUnits(a0, []), privateUnits(a1, [])]);
  const pubSol = pub.find((r) => r.mint === SOL_MINT)?.units ?? "0";
  console.log(`${label}: account 1 public ${sol(BigInt(pubSol))}, private ${sol(priv0.get(SOL_MINT) ?? 0n)} | account 2 private ${sol(priv1.get(SOL_MINT) ?? 0n)}`);
  return { pub: BigInt(pubSol), priv0: priv0.get(SOL_MINT) ?? 0n, priv1: priv1.get(SOL_MINT) ?? 0n };
}

console.log("account 1 wallet", a0.wallet, "| Rings account key", accountAddress(a0));
const p1 = await privateAddressOf(a1);
console.log("account 2 private address", `${p1.slice(0, 10)}…${p1.slice(-6)} (${p1.length} chars), parses: ${!!(await parsePrivateAddress("devnet", p1))}, typo refused: ${!(await parsePrivateAddress("devnet", p1.slice(0, -1) + (p1.endsWith("A") ? "B" : "A")))}`);

const before = await show("before");
if (step === "shield" || step === "all") {
  const r = await shield(a0, SOL_MINT, 50_000_000n);
  console.log("shield 0.05 SOL:", link(r.signature));
}
if (step === "send" || step === "all") {
  const r = await sendPrivately(a0, SOL_MINT, 10_000_000n, (await parsePrivateAddress("devnet", p1))!);
  console.log("private send 0.01 SOL to account 2:", link(r.signature));
}
if (step === "unshield" || step === "all") {
  const r = await unshield(a0, SOL_MINT, 20_000_000n, a0.wallet);
  console.log("unshield 0.02 SOL to account 1:", link(r.signature));
}
const after = await show("after");
if (step === "all") {
  const ok = after.priv0 === before.priv0 + 50_000_000n - 10_000_000n - 20_000_000n && after.priv1 === before.priv1 + 10_000_000n;
  console.log(ok ? "PASS: private balances moved exactly" : "CHECK: private balances did not move as expected");
}
process.exit(0);
