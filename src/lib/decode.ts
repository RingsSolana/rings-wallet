// Plain-words steps of a transaction or message, for the approval window. Never throws. Background only.
import { decompileTransactionMessage, getAddressDecoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, type Address } from "@solana/kit";
import { SHIELDED_POOL_PROGRAM_ID } from "@heliuslabs/spr";
import { fromB64 } from "../../../web/src/core/codec";
import { SOL_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, describe, formatUnits, row, rpc, shortMint, type Network } from "./net";
import { oneLine } from "./text";

export interface Detail {
  label: string;
  value: string;
}

const SYSTEM = "11111111111111111111111111111111";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const MEMO = ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"];
const POOL: string = SHIELDED_POOL_PROGRAM_ID;
const STAKE = "Stake11111111111111111111111111111111111111";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const LOADER_V4 = "LoaderV411111111111111111111111111111111111";
// Core and compressed NFTs move no token account: only these steps can show them leaving.
const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const BUBBLEGUM = "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";
const TOKEN_METADATA = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
/** Bubblegum's instructions (Anchor: the first 8 bytes of sha256("global:<name>")). */
const BGUM: Record<string, number[]> = {
  transfer: [163, 52, 200, 231, 140, 3, 69, 186],
  delegate: [90, 147, 75, 178, 85, 88, 4, 137],
  burn: [116, 110, 29, 56, 107, 219, 42, 93],
  transfer_v2: [119, 40, 6, 235, 234, 221, 248, 49],
  delegate_v2: [95, 87, 125, 140, 181, 131, 128, 227],
  burn_v2: [115, 210, 34, 240, 232, 143, 183, 16],
};

const NAMES: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora DAMM v2",
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "Meteora DAMM",
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "Meteora bonding curve",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium CPMM",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex metadata",
  CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d: "Metaplex Core (NFTs)",
  BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY: "Metaplex Bubblegum (compressed NFTs)",
  Stake11111111111111111111111111111111111111: "Stake",
  // Named without "safety": its assertions are the site's, not checked by the wallet.
  L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95: "Lighthouse",
};

export const programName = (address: string): string | null => NAMES[address] ?? null;

const bgum = (d: Uint8Array) => Object.keys(BGUM).find((k) => BGUM[k].every((b, i) => d[i] === b)) ?? null;

/** Non-moving steps listed per transaction; the rest are only counted. */
const MAX_PLAIN_ROWS = 12;
const short = shortMint;
const sol = (lamports: bigint) => `${formatUnits(lamports, 9, 6)} SOL`;
const u32 = (d: Uint8Array, at: number) => (d.length >= at + 4 ? new DataView(d.buffer, d.byteOffset + at, 4).getUint32(0, true) : -1);
const u64 = (d: Uint8Array, at: number) => (d.length >= at + 8 ? new DataView(d.buffer, d.byteOffset + at, 8).getBigUint64(0, true) : null);
const keyAt = (d: Uint8Array, at: number) => (d.length >= at + 32 ? (getAddressDecoder().decode(d.subarray(at, at + 32)) as string) : "?");

type Ix = { programAddress: string; accounts?: { address: string; role: number }[]; data?: Uint8Array };

/** A top-level Privacy Rings deposit (tag 15). */
export interface Deposit {
  mint: string;
  units: bigint;
  ownerHash: Uint8Array;
}

/** Parses the SDK's writeDepositData layout; null when the data doesn't fit it. */
export function depositsOf(ix: Ix): Deposit[] | null {
  const d = ix.data;
  if (!d || d[0] !== 15) return null;
  try {
    let o = 1;
    const assets: ("sol" | "spl")[] = [];
    const nAssets = d[o++];
    for (let i = 0; i < nAssets; i++) {
      const kind = d[o++];
      if (kind === 0) assets.push("sol");
      else if (kind === 1) {
        o++; // the SPL interface bump
        assets.push("spl");
      } else return null;
    }
    // Account order: tree, depositor, pool program, then System and the SOL interface if SOL goes in, then per coin
    // its token program, mint, source token account and vault.
    const acc = (ix.accounts ?? []).map((a) => a.address);
    let k = 3 + (assets.includes("sol") ? 2 : 0);
    const mints = assets.map((a) => {
      if (a === "sol") return SOL_MINT;
      const mint = acc[k + 1];
      k += 4;
      return mint;
    });
    const out: Deposit[] = [];
    const n = d[o++];
    for (let i = 0; i < n; i++) {
      const assetIndex = d[o++];
      o += 32; // view tag
      const ownerHash = d.slice(o, o + 32);
      o += 32;
      if (o + 8 > d.length) return null;
      const units = new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true);
      o += 8;
      if (d[o++] === 1) o += 4 + new DataView(d.buffer, d.byteOffset + o, 4).getUint32(0, true); // optional memo: u32 length, then bytes
      const mint = mints[assetIndex];
      if (!mint || o > d.length) return null;
      out.push({ mint, units, ownerHash });
    }
    return out;
  } catch {
    return null;
  }
}

const sameBytes = (a: Uint8Array, b?: Uint8Array) => !!b && a.length === b.length && a.every((x, i) => x === b[i]);

async function instructionsOfMessage(network: Network, bytes: Uint8Array): Promise<Ix[] | null> {
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(bytes) as { addressTableLookups?: { lookupTableAddress: Address }[] };
    const all = compiled.addressTableLookups ?? [];
    if (all.length > 16) return null;
    const tables = await Promise.all(
      [...new Set(all.map((l) => l.lookupTableAddress))].map(async (t) => {
        const { value } = await rpc<{ value: { data: [string, string] } | null }>(network, "getAccountInfo", [t, { encoding: "base64", commitment: "confirmed" }]);
        if (!value) throw new Error("No such lookup table.");
        const data = fromB64(value.data[0]);
        const out: Address[] = [];
        for (let i = 56; i + 32 <= data.length; i += 32) out.push(getAddressDecoder().decode(data.subarray(i, i + 32)));
        return [t, out] as const;
      }),
    );
    return (decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: Object.fromEntries(tables) } as never) as unknown as { instructions: Ix[] }).instructions;
  } catch {
    return null;
  }
}

async function tokenFacts(network: Network, accounts: string[], mints: string[]) {
  const accountInfo = new Map<string, { mint: string; owner: string }>();
  const mintInfo = new Map<string, { decimals: number; sym: string }>();
  const parsed = async (list: string[]) =>
    list.length
      ? (await rpc<{ value: ({ data: { parsed?: { info?: { mint?: string; owner?: string; decimals?: number } } } } | null)[] }>(network, "getMultipleAccounts", [list, { encoding: "jsonParsed", commitment: "confirmed" }])).value
      : [];
  const accs = [...new Set(accounts)].slice(0, 60);
  (await parsed(accs).catch(() => [])).forEach((v, i) => {
    const info = v?.data?.parsed?.info;
    if (info?.mint && info.owner) accountInfo.set(accs[i], { mint: info.mint, owner: info.owner });
  });
  const allMints = [...new Set([...mints, ...[...accountInfo.values()].map((a) => a.mint)])].filter((m) => m !== SOL_MINT).slice(0, 60);
  const decimals = await parsed(allMints).catch(() => []);
  const rows = allMints.map((m, i) => row(m, 0n, decimals[i]?.data?.parsed?.info?.decimals ?? 0));
  await describe(network, rows).catch(() => undefined);
  // A look-alike's symbol carries its address, so a fake USDC can't pass as USDC.
  rows.forEach((r) => mintInfo.set(r.mint, { decimals: r.decimals, sym: r.lookAlike ? `${r.sym} (unverified, ${short(r.mint)})` : r.sym }));
  mintInfo.set(SOL_MINT, { decimals: 9, sym: "SOL" });
  return { accountInfo, mintInfo };
}

export interface StepContext {
  /** The signing key's Rings account key. */
  ringsAccount?: string;
  /** Hash identifying the signing key's own private balance. */
  ownerHash?: Uint8Array;
}

/** `moves`: it moves coins, NFTs or rights; such rows are never cut. */
type Step = Detail & { moves: boolean };

async function stepsOf(network: Network, ixs: Ix[], owner: string, ctx: StepContext = {}): Promise<{ rows: Detail[]; hidden: number }> {
  const { ringsAccount, ownerHash } = ctx;
  const tokenIxs = ixs.filter((ix) => ix.programAddress === TOKEN_PROGRAM || ix.programAddress === TOKEN_2022_PROGRAM);
  const accountsToRead = tokenIxs.flatMap((ix) => {
    const tag = ix.data?.[0];
    const a = (ix.accounts ?? []).map((x) => x.address);
    return tag === 3 || tag === 4 || tag === 8 ? [a[0], a[1]] : tag === 12 || tag === 13 || tag === 15 ? [a[0], a[2]] : [];
  }).filter(Boolean) as string[];
  const deposits = ixs.flatMap((ix) => (ix.programAddress === POOL ? (depositsOf(ix) ?? []) : []));
  const mintsToRead = [
    ...tokenIxs.filter((ix) => [12, 13, 14, 15].includes(ix.data?.[0] ?? -1)).map((ix) => ix.accounts?.[1]?.address),
    ...ixs.filter((ix) => ix.programAddress === ATA).map((ix) => ix.accounts?.[3]?.address),
    ...deposits.map((d) => d.mint),
  ].filter(Boolean) as string[];
  const { accountInfo, mintInfo } = await tokenFacts(network, accountsToRead, mintsToRead);
  const tokenAmount = (units: bigint, mint?: string, decimals?: number) => {
    const m = mint ? mintInfo.get(mint) : undefined;
    const d = decimals ?? m?.decimals ?? 0;
    return `${formatUnits(units, d, 6)} ${m?.sym ?? (mint ? short(mint) : "tokens")}`;
  };
  const who = (address: string) => {
    const o = accountInfo.get(address)?.owner ?? address;
    return o === owner ? "you" : o === ringsAccount ? "your Rings account" : short(o);
  };

  const out: Step[] = [];
  const push = (label: string, value: string, moves = true) => out.push({ label, value, moves });
  const named = new Set<string>();
  const memos: string[] = [];
  let computeLimit = 200_000n;
  let microLamports = 0n;
  for (const ix of ixs) {
    const d = ix.data ?? new Uint8Array();
    const a = (ix.accounts ?? []).map((x) => x.address);
    const p = ix.programAddress;
    if (p === SYSTEM) {
      const n = u32(d, 0);
      if (n === 2) {
        const lamports = u64(d, 4) ?? 0n;
        if (a[0] === owner) push("Send SOL", `${sol(lamports)} to ${a[1] === ringsAccount ? "your Rings account (network fees)" : short(a[1] ?? "?")}`);
        else push("Move SOL", `${sol(lamports)} from ${short(a[0] ?? "?")} to ${a[1] === owner ? "you" : short(a[1] ?? "?")}`);
      } else if (n === 0) push("Create an account", `${sol(u64(d, 4) ?? 0n)} for ${short(a[1] ?? "?")}, owned by ${NAMES[keyAt(d, 20)] ?? short(keyAt(d, 20))}`);
      else if (n === 1 || n === 10) push("Hand over an account", `${a[0] === owner ? "Your account" : short(a[0] ?? "?")} to another program`);
      else if (n === 4) push("Durable nonce", "This transaction can be kept and sent much later");
      else if (n === 5) push("Take SOL out of a nonce account", `${sol(u64(d, 4) ?? 0n)} to ${a[1] === owner ? "you" : short(a[1] ?? "?")}`);
      else if (n === 6) push("Make a nonce account", `${a[0] === owner ? "Your account" : short(a[0] ?? "?")}, controlled by ${keyAt(d, 4) === owner ? "you" : short(keyAt(d, 4))}`);
      else if (n === 7) push("Hand over a nonce account", `${short(a[0] ?? "?")} to ${keyAt(d, 4) === owner ? "you" : short(keyAt(d, 4))}`);
      else if (n === 8 || n === 9) push("Give an account data", `${a[0] === owner ? "Your account (it could no longer send SOL)" : short(a[0] ?? "?")}`);
      else push("System", `Instruction ${n}`);
    } else if (p === TOKEN_PROGRAM || p === TOKEN_2022_PROGRAM) {
      const tag = d[0];
      const amount = u64(d, 1) ?? 0n;
      if (tag === 3) push(a[2] === owner ? "Send tokens" : "Move tokens", `${tokenAmount(amount, accountInfo.get(a[0])?.mint)} to ${who(a[1])}`);
      else if (tag === 12) push(a[3] === owner ? "Send tokens" : "Move tokens", `${tokenAmount(amount, a[1], d[9])} to ${who(a[2])}`);
      else if (tag === 4 || tag === 13) push("Allow spending", `${tokenAmount(amount, tag === 13 ? a[1] : accountInfo.get(a[0])?.mint)} by ${short(tag === 13 ? a[2] : a[1])}`);
      else if (tag === 5) push("Remove a spending permission", short(a[0] ?? "?"), false);
      else if (tag === 6) push("Change who controls a token account or coin", short(a[0] ?? "?"));
      else if (tag === 7 || tag === 14) push("Create new tokens", tokenAmount(amount, a[0], tag === 14 ? d[9] : undefined));
      else if (tag === 8 || tag === 15) push("Burn tokens", tokenAmount(amount, tag === 15 ? a[1] : accountInfo.get(a[0])?.mint, tag === 15 ? d[9] : undefined));
      else if (tag === 9) push("Close a token account", `Its SOL goes to ${a[1] === owner ? "you" : short(a[1] ?? "?")}`);
      else if (tag === 17) push("Wrap SOL", "Into a token account", false);
      else if (tag === 1 || tag === 16 || tag === 18) push("Open a token account", short(a[0] ?? "?"), false);
      else push(p === TOKEN_PROGRAM ? "Token program" : "Token-2022 program", `Instruction ${tag}`);
    } else if (p === ATA) {
      const mint = a[3];
      push("Open a token account", `${mint ? (mintInfo.get(mint)?.sym ?? short(mint)) : "A coin"} for ${a[2] === owner ? "you" : short(a[2] ?? "?")}`, false);
    } else if (p === COMPUTE) {
      if (d[0] === 2) computeLimit = BigInt(u32(d, 1));
      if (d[0] === 3) microLamports = u64(d, 1) ?? 0n;
    } else if (MEMO.includes(p)) {
      memos.push(oneLine(new TextDecoder("utf-8", { fatal: false }).decode(d), 140));
    } else if (p === POOL) {
      const deps = depositsOf(ix);
      if (deps && a[1] === owner) {
        for (const dep of deps) push("Rings deposit", `${tokenAmount(dep.units, dep.mint, dep.mint === SOL_MINT ? 9 : undefined)} into ${sameBytes(dep.ownerHash, ownerHash) ? "your private balance" : "someone else's private balance"}`);
      } else if (!named.has(p)) {
        push("Rings private balance", "Moves coins into, inside or out of a private balance");
        named.add(p);
      }
    } else if (p === STAKE) {
      const n = u32(d, 0);
      if (n === 4) push("Take SOL out of a stake account", `${sol(u64(d, 4) ?? 0n)} to ${a[1] === owner ? "you" : short(a[1] ?? "?")}`);
      else if ([1, 8, 10, 11].includes(n)) push("Change who controls a stake account", short(a[0] ?? "?"));
      else if (n === 6 || n === 12) push("Change a stake account's lockup", short(a[0] ?? "?"));
      else if (n === 5) push("Stop staking", short(a[0] ?? "?"));
      else if (n === 2) push("Stake", short(a[0] ?? "?"));
      else push("Stake", `Instruction ${n}`);
    } else if ((p === UPGRADEABLE_LOADER && [3, 4, 5, 7].includes(u32(d, 0))) || (p === LOADER_V4 && [2, 3, 4, 5, 6].includes(u32(d, 0)))) {
      push("Change a program", `${short(a[p === UPGRADEABLE_LOADER ? 1 : 0] ?? "?")}: change, close or hand it over`);
    } else if (p === CORE && [12, 14].includes(d[0] ?? -1)) {
      // TransferV1 (14): asset, collection, payer, authority, new owner. BurnV1 (12): asset first.
      if (d[0] === 14) push(a[3] === owner || a[2] === owner ? "Send an NFT" : "Move an NFT", `${short(a[0] ?? "?")} to ${a[4] === owner ? "you" : short(a[4] ?? "?")}`);
      else push("Burn an NFT", short(a[0] ?? "?"));
    } else if (p === CORE && [2, 8].includes(d[0] ?? -1)) {
      // AddPluginV1 (2) and ApprovePluginAuthorityV1 (8): how a transfer, freeze or burn right is handed to someone.
      push("Change who has rights over an NFT", `${short(a[0] ?? "?")}: someone may be able to move, freeze or burn it`);
    } else if (p === BUBBLEGUM && bgum(d)) {
      const k = bgum(d)!;
      // v1 transfer and delegate: tree config, leaf owner, leaf delegate, then the new owner (or new delegate).
      if (k === "transfer") push(a[1] === owner ? "Send a compressed NFT" : "Move a compressed NFT", `to ${a[3] === owner ? "you" : short(a[3] ?? "?")}`);
      else if (k === "delegate") push("Let someone move a compressed NFT", short(a[3] ?? "?"));
      else if (k === "transfer_v2") push("Move a compressed NFT", "to a new owner");
      else if (k === "delegate_v2") push("Let someone move a compressed NFT", "a new delegate");
      else push("Burn a compressed NFT", "");
    } else if (p === TOKEN_METADATA && d[0] === 49) {
      // TransferV1: token, token owner, destination token, destination owner, mint, …
      push(a[1] === owner ? "Send an NFT" : "Move an NFT", `${a[4] ? (mintInfo.get(a[4])?.sym ?? short(a[4])) : "An NFT"} to ${a[3] === owner ? "you" : short(a[3] ?? "?")}`);
    } else if (p === TOKEN_METADATA && d[0] === 44) {
      push("Let someone move or use an NFT", a[0] ? short(a[0]) : "An NFT");
    } else if (!named.has(p)) {
      named.add(p);
      push(NAMES[p] ? "Uses" : "Program", NAMES[p] ?? `${short(p)} (Rings Wallet can't tell what it does)`, false);
    }
  }
  // Memos are the site's text: one row, labeled as the site's, hidden characters shown.
  if (memos.length) push(memos.length > 1 ? `Notes from the site (${memos.length})` : "Note from the site", oneLine(memos.join(" · "), 280), false);
  const priority = (computeLimit * microLamports) / 1_000_000n;
  if (priority > 0n) push("Priority fee", sol(priority), false);
  // Moving steps first, never cut; the rest up to MAX_PLAIN_ROWS, the remainder counted.
  const moving = out.filter((s) => s.moves);
  const plain = out.filter((s) => !s.moves);
  const kept = plain.slice(0, MAX_PLAIN_ROWS);
  const hidden = plain.length - kept.length;
  const rows: Detail[] = [...moving, ...kept].map(({ label, value }) => ({ label, value }));
  if (hidden > 0) rows.push({ label: "Not listed", value: `${hidden} more steps` });
  return { rows, hidden };
}

export async function transactionSteps(network: Network, wires: string[], owner: string, ctx: StepContext = {}): Promise<{ rows: Detail[]; hidden: number }> {
  const out: Detail[] = [];
  let hidden = 0;
  if (wires.length > 1) out.push({ label: "Transactions", value: `${wires.length}: the site gets each one signed and can send them one by one` });
  for (const [i, w] of wires.entries()) {
    const tag = (label: string) => (wires.length > 1 ? `${i + 1}. ${label}` : label);
    try {
      const tx = getTransactionDecoder().decode(fromB64(w));
      const ixs = await instructionsOfMessage(network, tx.messageBytes as unknown as Uint8Array);
      if (!ixs) {
        out.push({ label: tag("Unreadable"), value: "Rings Wallet couldn't read this transaction's steps" });
        hidden++;
        continue;
      }
      const steps = await stepsOf(network, ixs, owner, ctx);
      hidden += steps.hidden;
      out.push(...steps.rows.map((s) => ({ ...s, label: tag(s.label) })));
    } catch {
      out.push({ label: tag("Unreadable"), value: "Rings Wallet couldn't read this transaction" });
      hidden++;
    }
  }
  return { rows: out, hidden };
}

export async function transactionDetails(network: Network, wires: string[], owner: string, ringsAccount?: string, ownerHash?: Uint8Array): Promise<Detail[]> {
  return (await transactionSteps(network, wires, owner, { ringsAccount, ownerHash })).rows;
}

/** The last "Name: value" line wins: a statement can't shadow the real fields after it. */
const field = (text: string, name: string) => [...text.matchAll(new RegExp(`\\n${name}: ([^\\n]+)`, "g"))].pop()?.[1];

export async function messageDetails(network: Network, bytes: Uint8Array, text: string, owner: string, addressLabel = "This address"): Promise<Detail[]> {
  if (text.startsWith("Rings key v1")) {
    const domain = field(text, "Domain") ?? "?";
    return [{ label: "What it is", value: `Your Rings key for ${oneLine(domain, 80)}: with it, the Rings sites can see and spend your private balance. It moves nothing by itself.` }];
  }
  if (/ wants you to sign in to Rings with your Solana account:/.test(text.split("\n")[0] ?? "") || /\nSign in to Rings\. This moves no funds/.test(text)) {
    const domain = text.split("\n")[0]?.replace(/ wants you to sign in.*$/, "") ?? "?";
    return [{ label: "What it is", value: `A Rings sign-in for ${oneLine(domain, 80)}, with this address. It moves no funds.` }];
  }
  const siws = /^(\S+) wants you to sign in with your Solana account:\n(\S+)/.exec(text);
  if (siws) {
    const rows: Detail[] = [
      { label: "Sign in to", value: oneLine(siws[1], 120) },
      { label: "Address", value: siws[2] === owner ? addressLabel : `${short(siws[2])} (not this address)` },
    ];
    for (const [name, label] of [["URI", "Site"], ["Chain ID", "Network"], ["Issued At", "Asked at"], ["Expiration Time", "Expires"]] as const) {
      const v = field(text, name);
      if (v) rows.push({ label, value: oneLine(v, 160) });
    }
    return rows;
  }
  // A transaction message passed off as a message: show what it would do.
  const ixs = await instructionsOfMessage(network, bytes);
  if (ixs?.length) return [{ label: "Careful", value: "This is a transaction, not a message" }, ...(await stepsOf(network, ixs, owner)).rows];
  return [];
}
