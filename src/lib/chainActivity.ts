// What a transaction did for an account, from jsonParsed chain data, for Activity. Pure: no RPC calls here.
import { SHIELDED_POOL_PROGRAM_ID } from "@heliuslabs/spr";
import { programName } from "./decode";
import { TREASURY_PUBLIC } from "./fee";
import { SOL_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./net";

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } };
export interface ParsedTx {
  blockTime: number | null;
  meta: {
    err: unknown;
    fee?: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction: {
    message: {
      accountKeys: { pubkey: string }[];
      instructions?: { programId: string; parsed?: { type?: string; info?: { source?: string; destination?: string } } }[];
    };
  };
}

export interface Effect {
  kind: "swapped" | "sent" | "received";
  /** What came in (swap, receipt) or went out (send); SOL_MINT for SOL. */
  mint: string;
  units: bigint;
  decimals: number;
  /** The program used (by name when known), or the address paid. */
  who: string | null;
}

const WSOL = "So11111111111111111111111111111111111111112";
const SYSTEM = "11111111111111111111111111111111";
const POOL: string = SHIELDED_POOL_PROGRAM_ID;
/** Programs that only move coins or set up a transaction: they don't identify the app used. */
const PLUMBING = new Set([
  SYSTEM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95",
]);
/** Lamports; smaller SOL changes (net of the fee) are rent and change, not a transfer. */
const SOL_MIN = 100_000n;

/** What a tx the account paid for did, or null. Skips pool moves and fee top-ups, which the wallet records itself. */
export function ownTxEffect(tx: ParsedTx | null, owner: string, ringsAccount?: string): Effect | null {
  if (!tx?.meta || tx.meta.err) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  if (keys[0] !== owner) return null;
  const programs = (tx.transaction.message.instructions ?? []).map((i) => i.programId);
  if (programs.includes(POOL)) return null;

  // Net change per coin (wSOL counts as SOL), with the network fee added back.
  const change = new Map<string, { units: bigint; decimals: number }>();
  const add = (mint: string, units: bigint, decimals: number) => {
    const c = change.get(mint) ?? { units: 0n, decimals };
    c.units += units;
    change.set(mint, c);
  };
  const i = keys.indexOf(owner);
  add(SOL_MINT, BigInt(tx.meta.postBalances[i] ?? 0) - BigInt(tx.meta.preBalances[i] ?? 0) + BigInt(tx.meta.fee ?? 0), 9);
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];
  for (const idx of new Set([...pre, ...post].filter((b) => b.owner === owner).map((b) => b.accountIndex))) {
    const a = pre.find((b) => b.accountIndex === idx);
    const z = post.find((b) => b.accountIndex === idx);
    const mint = (z ?? a)!.mint;
    const units = BigInt(z?.uiTokenAmount.amount ?? "0") - BigInt(a?.uiTokenAmount.amount ?? "0");
    add(mint === WSOL ? SOL_MINT : mint, units, (z ?? a)!.uiTokenAmount.decimals);
  }
  const moved = [...change].filter(([mint, c]) => (mint === SOL_MINT ? c.units >= SOL_MIN || c.units <= -SOL_MIN : c.units !== 0n));
  const ins = moved.filter(([, c]) => c.units > 0n);
  const outs = moved.filter(([, c]) => c.units < 0n);
  // Prefer a token over SOL: SOL in a token swap is mostly rent and change.
  const main = (list: typeof moved) => list.find(([mint]) => mint !== SOL_MINT) ?? list[0];

  // A fee top-up of the account's own Rings account key: the wallet's screens record it.
  if (ringsAccount && keys.includes(ringsAccount) && !ins.length && outs.every(([mint]) => mint === SOL_MINT) && programs.every((p) => PLUMBING.has(p))) return null;

  const app = programs.find((p) => !PLUMBING.has(p));
  const where = app ? (programName(app) ?? app) : null;
  if (ins.length && outs.length) {
    const [mint, c] = main(ins);
    return { kind: "swapped", mint, units: c.units, decimals: c.decimals, who: where };
  }
  if (outs.length) {
    const [mint, c] = main(outs);
    // The recipient: the holder whose token balance rose, or a plain SOL transfer's target. Never the treasury, which
    // takes the fee in the same transaction.
    const toOwner =
      mint === SOL_MINT
        ? (tx.transaction.message.instructions ?? []).find((x) => x.programId === SYSTEM && x.parsed?.type === "transfer" && x.parsed.info?.source === owner && x.parsed.info?.destination !== TREASURY_PUBLIC)?.parsed?.info?.destination
        : post.find((b) => b.mint === mint && b.owner && b.owner !== owner && b.owner !== TREASURY_PUBLIC && BigInt(b.uiTokenAmount.amount) > BigInt(pre.find((p) => p.accountIndex === b.accountIndex)?.uiTokenAmount.amount ?? "0"))?.owner;
    return { kind: "sent", mint, units: -c.units, decimals: c.decimals, who: where ?? toOwner ?? null };
  }
  if (ins.length) {
    const [mint, c] = main(ins);
    return { kind: "received", mint, units: c.units, decimals: c.decimals, who: where };
  }
  return null;
}
