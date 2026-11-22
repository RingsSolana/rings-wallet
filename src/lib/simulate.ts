// Transaction previews: simulated through Rings' own RPC (no third-party scanner), plus danger checks.
import { decompileTransactionMessage, getAddressDecoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, type Address } from "@solana/kit";
import { SHIELDED_POOL_PROGRAM_ID } from "@heliuslabs/spr";
import { b64, fromB64 } from "../../../web/src/core/codec";
import { SOL_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, describe, formatUnits, isPinned, row, rpc, shortMint, type Network } from "./net";
import { depositsOf, programName } from "./decode";
import { visible } from "./text";

export interface Change {
  sym: string;
  name: string;
  amount: number;
  price: number;
  icon?: string;
}

export interface Preview {
  ok: boolean;
  changes: Change[];
  fee: string;
  error?: string;
  danger: string | null;
  reason?: string;
  /** The most each mint or NFT can lose, in base units; the pre-send re-check compares against it. */
  losses?: Record<string, string>;
  count?: number;
}

export interface PreviewContext {
  ringsAccount?: string;
  ringsSite?: boolean;
  /** Owner hash of the signer's own private balance. */
  ownerHash?: Uint8Array;
}

const POOL: string = SHIELDED_POOL_PROGRAM_ID;
const SYSTEM = "11111111111111111111111111111111";
const STAKE = "Stake11111111111111111111111111111111111111";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const LOADER_V4 = "LoaderV411111111111111111111111111111111111";
const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const BUBBLEGUM = "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";
const TOKEN_METADATA = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
/** Account-compression programs (compressed-NFT trees). */
const COMPRESSION = ["cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK", "mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW"];
/** Swap programs whose slippage logs may be repeated to the user. */
const SWAP_PROGRAMS = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
]);
/** Bubblegum delegate discriminators (Anchor: first 8 bytes of sha256 of `global:<name>`). */
const BGUM_DELEGATE = [
  [90, 147, 75, 178, 85, 88, 4, 137],
  [95, 87, 125, 140, 181, 131, 128, 227],
];

const nameOf = (program: string) => programName(program) ?? shortMint(program);

/** Why a simulation failed, in the wallet's own words; only built-in and known swap programs' logs are read. */
export function failureReason(err: unknown, logs: string[]): string {
  // Track the running program: `Program X invoke [n]` pushes it, `Program X success|failed` pops it.
  const stack: string[] = [];
  let failed: string | null = null;
  let short: RegExpExecArray | null = null;
  let tokenShort = false;
  let slippage = false;
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    const end = /^Program (\w+) (success|failed)/.exec(line);
    if (end) {
      if (end[2] === "failed") failed ??= end[1];
      stack.pop();
      continue;
    }
    const top = stack[stack.length - 1];
    // Built-in programs log without the `Program log: ` prefix that other programs' lines carry.
    if (top === SYSTEM && /^Transfer: insufficient lamports \d+, need \d+$/.test(line)) short = /insufficient lamports (\d+), need (\d+)/.exec(line);
    if ((top === TOKEN_PROGRAM || top === TOKEN_2022_PROGRAM) && /^Program log: Error: insufficient funds$/i.test(line)) tokenShort = true;
    if (top && SWAP_PROGRAMS.has(top) && /^Program log: .*slippage/i.test(line)) slippage = true;
  }
  if (short) return `Your Public balance doesn't have enough SOL for this: it needs ${formatUnits(BigInt(short[2]) - BigInt(short[1]), 9, 9)} SOL more.`;
  const e = typeof err === "string" ? err : JSON.stringify(err ?? "");
  if (/InsufficientFundsForFee/.test(e)) return "Your Public balance can't pay this transaction's network fee.";
  if (/AccountNotFound/.test(e)) return "Your Public balance is empty, so it can't pay this transaction.";
  if (tokenShort) return "Your balance doesn't have enough of a coin for this.";
  if (slippage) return "The price moved: this swap would fail as it is.";
  return `This transaction would fail as it is${failed ? ` (${nameOf(failed)} refused it)` : ""}.`;
}

/** System Program Transfer: u32 tag 2, then u64 lamports, little-endian. */
function transferOf(ix: Ix): { from: string; to: string; lamports: bigint } | null {
  if (ix.programAddress !== SYSTEM || u32(ix.data) !== 2 || !ix.data || ix.data.length < 12) return null;
  const [from, to] = ix.accounts ?? [];
  if (!from || !to) return null;
  return { from: from.address, to: to.address, lamports: new DataView(ix.data.buffer, ix.data.byteOffset + 4, 8).getBigUint64(0, true) };
}

type ParsedInfo = {
  mint?: string;
  owner?: string;
  delegate?: string;
  closeAuthority?: string;
  authority?: string;
  tokenAmount?: { amount: string; decimals: number };
  meta?: { authorized?: { staker?: string; withdrawer?: string } };
};
interface ParsedAccount {
  lamports: number;
  owner: string;
  data: { parsed?: { type?: string; info?: ParsedInfo } } | [string, string];
}

type Ix = { programAddress: string; accounts?: { address: string; role: number }[]; data?: Uint8Array };

/** Lookup table account data: a 56-byte header, then 32-byte addresses. */
async function tableAddresses(network: Network, table: string): Promise<Address[]> {
  const { value } = await rpc<{ value: { data: [string, string] } | null }>(network, "getAccountInfo", [table, { encoding: "base64", commitment: "confirmed" }]);
  if (!value) throw new Error("No such lookup table.");
  const data = fromB64(value.data[0]);
  const out: Address[] = [];
  for (let i = 56; i + 32 <= data.length; i += 32) out.push(getAddressDecoder().decode(data.subarray(i, i + 32)));
  return out;
}

function missingSigners(wire: string): string[] {
  try {
    const tx = getTransactionDecoder().decode(fromB64(wire));
    return Object.entries(tx.signatures as Record<string, Uint8Array | null>)
      .filter(([, s]) => !s || s.every((b) => b === 0))
      .map(([k]) => k);
  } catch {
    return [];
  }
}

/** Instructions with lookup tables resolved; null when unreadable, which callers treat as a risk. */
async function instructionsOf(network: Network, wire: string): Promise<{ ixs: Ix[] | null; messageB64: string; feePayer: string | null }> {
  const tx = getTransactionDecoder().decode(fromB64(wire));
  const bytes = tx.messageBytes as unknown as Uint8Array;
  const messageB64 = b64(new Uint8Array(bytes));
  let feePayer: string | null = null;
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(bytes) as { staticAccounts?: Address[]; addressTableLookups?: { lookupTableAddress: Address }[] };
    feePayer = compiled.staticAccounts?.[0] ?? null;
    const all = compiled.addressTableLookups ?? [];
    if (all.length > 16) return { ixs: null, messageB64, feePayer };
    const tables = [...new Set(all.map((l) => l.lookupTableAddress))];
    const addressesByLookupTableAddress = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await tableAddresses(network, t)] as const)));
    const ixs = (decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress } as never) as unknown as { instructions: Ix[] }).instructions;
    return { ixs, messageB64, feePayer };
  } catch {
    return { ixs: null, messageB64, feePayer };
  }
}

const u32 = (d?: Uint8Array) => (d && d.length >= 4 ? new DataView(d.buffer, d.byteOffset, 4).getUint32(0, true) : -1);
const keyAt = (d: Uint8Array | undefined, at: number) => (d && d.length >= at + 32 ? (getAddressDecoder().decode(d.subarray(at, at + 32)) as string) : null);

/** Level 3 hands something over, 2 may lose value unseen, 1 is a note. */
interface Danger {
  level: 1 | 2 | 3;
  text: string;
}
const HANDS_ACCOUNT = "This transaction would hand your account to another program.";

export function dangersOf(ixs: Ix[], owner: string): Danger[] {
  const out: Danger[] = [];
  const add = (level: Danger["level"], text: string) => out.push({ level, text });
  for (const ix of ixs) {
    const accounts = ix.accounts ?? [];
    const at = (i: number) => accounts[i]?.address;
    const signedByOwner = accounts.some((a) => a.address === owner && (a.role === 2 || a.role === 3));
    const p = ix.programAddress;
    if (p === SYSTEM) {
      const n = u32(ix.data);
      if ((n === 1 || n === 10) && signedByOwner) add(3, HANDS_ACCOUNT);
      // Allocate (8, 9): a system account with data can never pay a fee or send SOL.
      if ((n === 8 || n === 9) && at(0) === owner) add(3, "This transaction would lock your account: it could never send SOL or pay a fee again.");
      // InitializeNonceAccount (6) needs no signature from the account itself: match by address.
      if (n === 6 && at(0) === owner) add(3, "This transaction would turn your account into a nonce account that someone else controls.");
      if (n === 5 && at(4) === owner && at(1) !== owner) add(3, "This transaction would send the SOL of a nonce account you control to someone else.");
      if (n === 7 && at(1) === owner && keyAt(ix.data, 4) !== owner) add(3, "This transaction would hand a nonce account you control to someone else.");
      if (n === 4) add(1, "This transaction uses a durable nonce: it could be held and sent much later.");
    }
    if ((p === TOKEN_PROGRAM || p === TOKEN_2022_PROGRAM) && signedByOwner) {
      const tag = ix.data?.[0];
      if (tag === 4 || tag === 13) add(3, "This transaction would let someone else spend your tokens.");
      if (tag === 6) add(3, "This transaction would change who controls one of your token accounts or coins.");
      if (tag === 9 && at(1) !== owner) add(3, "This transaction would close a token account and send its SOL to someone else.");
    }
    if (p === STAKE && signedByOwner) {
      const n = u32(ix.data);
      if ([1, 6, 8, 10, 11, 12].includes(n)) add(3, "This transaction would change who controls a stake account.");
      if (n === 4 && at(1) !== owner) add(3, "This transaction would send the SOL of a stake account you control to someone else.");
    }
    if (p === UPGRADEABLE_LOADER && signedByOwner && [3, 4, 5, 7].includes(u32(ix.data))) add(3, "This transaction would change, close or hand over a program you control.");
    if (p === LOADER_V4 && signedByOwner && [2, 3, 4, 5, 6].includes(u32(ix.data))) add(3, "This transaction would change, close or hand over a program you control.");
    if (p === CORE && signedByOwner && [2, 8].includes(ix.data?.[0] ?? -1)) add(3, "This transaction would give someone rights over one of your NFTs: to move, freeze or burn it.");
    if (p === BUBBLEGUM && signedByOwner && ix.data && BGUM_DELEGATE.some((d) => d.every((b, i) => ix.data![i] === b))) add(3, "This transaction would let someone else move one of your compressed NFTs.");
    if (p === TOKEN_METADATA && signedByOwner && ix.data?.[0] === 44) add(3, "This transaction would let someone else move or use one of your NFTs.");
  }
  return out;
}

function dangerText(list: Danger[]): string | null {
  const seen = new Set<string>();
  const ranked = [...list].sort((a, b) => b.level - a.level).filter((d) => !seen.has(d.text) && seen.add(d.text));
  if (!ranked.length) return null;
  const shown = ranked.slice(0, 3).map((d) => d.text);
  if (ranked.length > 3) shown.push(`And ${ranked.length - 3} more risks.`);
  return shown.join(" ");
}

const sameBytes = (a: Uint8Array, b?: Uint8Array) => !!b && a.length === b.length && a.every((x, i) => x === b[i]);

interface TokenAcc {
  pubkey: string;
  account: { data: { parsed: { info: { mint: string; owner: string; delegate?: string; closeAuthority?: string; tokenAmount: { amount: string; decimals: number } } } } };
}

interface TxEffect {
  /** Signed units per mint; SOL includes the stake and nonce accounts the address controls. */
  delta: Map<string, { units: bigint; decimals: number }>;
  fee: bigint;
  /** Deposits into the address's own private balance, per mint. */
  intoOwn: Map<string, bigint>;
  toRingsAccount: bigint;
  nfts: { asset: string; sign: -1 | 1 }[];
}

const isStake = (a: ParsedAccount | null) => a?.owner === STAKE;
const parsedInfo = (a: ParsedAccount | null) => (a && !Array.isArray(a.data) ? a.data.parsed?.info : undefined);
/** Metaplex Core AssetV1 data: key byte 1, then the 32-byte owner. */
function coreOwner(a: ParsedAccount | null): string | null {
  if (!a || a.owner !== CORE || !Array.isArray(a.data)) return null;
  const d = fromB64(a.data[0]);
  return d[0] === 1 ? keyAt(d, 1) : null;
}

/** Simulates each transaction alone; returns the balance changes and every risk found. */
export async function preview(network: Network, wires: string[], owner: string, context: PreviewContext = {}): Promise<Preview> {
  const opts = { encoding: "jsonParsed", commitment: "confirmed" };
  const [mainBefore, classic, t22] = await Promise.all([
    rpc<{ value: { lamports: number; owner: string; data?: [string, string] } | null }>(network, "getAccountInfo", [owner, { encoding: "base64", commitment: "confirmed" }]),
    rpc<{ value: TokenAcc[] }>(network, "getTokenAccountsByOwner", [owner, { programId: TOKEN_PROGRAM }, opts]),
    rpc<{ value: TokenAcc[] }>(network, "getTokenAccountsByOwner", [owner, { programId: TOKEN_2022_PROGRAM }, opts]),
  ]);
  const solBefore = BigInt(mainBefore.value?.lamports ?? 0);
  const ownerBefore = mainBefore.value?.owner ?? SYSTEM;
  const dataBefore = mainBefore.value?.data?.[0] ?? "";
  const tokensBefore = new Map([...classic.value, ...t22.value].map((t) => [t.pubkey, t.account.data.parsed.info]));
  const dangers: Danger[] = [];
  const effects: TxEffect[] = [];
  let failure: { error: string; reason: string } | null = null;
  let feeTotal = 0n;

  for (const wire of wires) {
    const { ixs, messageB64, feePayer } = await instructionsOf(network, wire);
    // Static checks run on every transaction, whatever the simulation says.
    if (!ixs) dangers.push({ level: 1, text: "Rings Wallet couldn't read every step of this transaction." });
    else dangers.push(...dangersOf(ixs, owner));
    const effect: TxEffect = { delta: new Map(), fee: 0n, intoOwn: new Map(), toRingsAccount: 0n, nfts: [] };
    effects.push(effect);
    const add = (mint: string, units: bigint, decimals: number) => {
      if (units === 0n) return;
      const d = effect.delta.get(mint) ?? { units: 0n, decimals };
      d.units += units;
      effect.delta.set(mint, d);
    };
    const ownerSigns = (ixs ?? []).some((ix) => (ix.accounts ?? []).some((a) => a.address === owner && (a.role === 2 || a.role === 3)));
    for (const ix of ixs ?? []) {
      const t = transferOf(ix);
      if (t && t.from === owner && context.ringsAccount && t.to === context.ringsAccount) effect.toRingsAccount += t.lamports;
      if (ix.programAddress === POOL && (ix.accounts ?? [])[1]?.address === owner) {
        // Only plain deposits can be attributed.
        for (const dep of depositsOf(ix) ?? []) {
          if (sameBytes(dep.ownerHash, context.ownerHash)) effect.intoOwn.set(dep.mint, (effect.intoOwn.get(dep.mint) ?? 0n) + dep.units);
        }
      }
    }
    // Watch only the owner and the written accounts: the RPC caps addresses at the transaction's account count.
    const writable = (ixs ?? []).flatMap((ix) => (ix.accounts ?? []).filter((a) => a.role === 1 || a.role === 3).map((a) => a.address));
    const addresses = [...new Set([owner, ...writable])].slice(0, 100);
    const others = addresses.filter((a) => a !== owner && !tokensBefore.has(a));
    type Sim = { value: { err: unknown; logs?: string[]; accounts?: (ParsedAccount | null)[] } };
    const [sim, feeAnswer, othersBefore] = await Promise.all([
      rpc<Sim>(network, "simulateTransaction", [
        wire,
        { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "jsonParsed", addresses } },
      ]).catch((e: Error): Sim => ({ value: { err: e.message, logs: [] } })),
      rpc<{ value: number | null }>(network, "getFeeForMessage", [messageB64, { commitment: "confirmed" }]).catch(() => ({ value: null })),
      others.length
        ? rpc<{ value: (ParsedAccount | null)[] }>(network, "getMultipleAccounts", [others, opts]).then(
            (r) => r.value,
            () => others.map((): ParsedAccount | null => null),
          )
        : Promise.resolve([] as (ParsedAccount | null)[]),
    ]);
    const fee = BigInt(feeAnswer.value ?? 5000);
    feeTotal += fee;
    if (feePayer === owner) effect.fee = fee;
    if (sim.value.err) {
      // Keep checking the rest: one failure must not hide another transaction's risk.
      failure ??= { error: JSON.stringify(sim.value.err).slice(0, 200), reason: failureReason(sim.value.err, sim.value.logs ?? []) };
      continue;
    }
    const post = sim.value.accounts ?? [];
    const before = new Map(others.map((a, i) => [a, othersBefore[i] ?? null]));
    let treeTouched = false;
    post.forEach((acc, i) => {
      const address = addresses[i];
      if (address === owner) {
        add(SOL_MINT, BigInt(acc?.lamports ?? 0) - solBefore, 9);
        if (acc && acc.owner !== ownerBefore) dangers.push({ level: 3, text: HANDS_ACCOUNT });
        // New data on the main account (Allocate, nonce, even via CPI) locks it.
        const dataNow = acc ? (Array.isArray(acc.data) ? acc.data[0] : "parsed") : "";
        if (acc && dataNow !== dataBefore && dataNow !== "") dangers.push({ level: 3, text: "This transaction would lock your account: it could never send SOL or pay a fee again." });
        return;
      }
      const info = parsedInfo(acc);
      const tokenBefore = tokensBefore.get(address);
      if (tokenBefore) {
        const after = info?.tokenAmount?.amount ?? "0";
        add(tokenBefore.mint, BigInt(after) - BigInt(tokenBefore.tokenAmount.amount), tokenBefore.tokenAmount.decimals);
        if (info && (info.owner !== tokenBefore.owner || (info.delegate ?? null) !== (tokenBefore.delegate ?? null) || (info.closeAuthority ?? null) !== (tokenBefore.closeAuthority ?? null))) {
          dangers.push({ level: 3, text: "This transaction would change who controls one of your token accounts." });
        }
        return;
      }
      if (info?.owner === owner && info.mint && info.tokenAmount) {
        add(info.mint, BigInt(info.tokenAmount.amount), info.tokenAmount.decimals);
        return;
      }
      const was = before.get(address) ?? null;
      const wasInfo = parsedInfo(was);
      // Stake or nonce accounts the address controls: their SOL counts as its own.
      const controlled =
        (isStake(was) && (wasInfo?.meta?.authorized?.withdrawer === owner || wasInfo?.meta?.authorized?.staker === owner)) ||
        (was?.owner === SYSTEM && wasInfo?.authority === owner);
      if (controlled && was) {
        add(SOL_MINT, BigInt(acc?.lamports ?? 0) - BigInt(was.lamports), 9);
        const nowInfo = parsedInfo(acc);
        const handed = isStake(was)
          ? acc && (nowInfo?.meta?.authorized?.withdrawer !== wasInfo?.meta?.authorized?.withdrawer || nowInfo?.meta?.authorized?.staker !== wasInfo?.meta?.authorized?.staker)
          : acc && nowInfo?.authority !== owner;
        if (handed) dangers.push({ level: 3, text: isStake(was) ? "This transaction would change who controls a stake account." : "This transaction would hand a nonce account you control to someone else." });
        return;
      }
      const ownerWas = coreOwner(was);
      const ownerNow = acc ? coreOwner(acc) : null;
      if (ownerWas === owner && ownerNow !== owner) effect.nfts.push({ asset: address, sign: -1 });
      else if (ownerWas !== owner && ownerNow === owner) effect.nfts.push({ asset: address, sign: 1 });
      if (was && COMPRESSION.includes(was.owner)) treeTouched = true;
    });
    // A tree changed without a top-level Bubblegum step: whose NFT moved can't be read.
    if (treeTouched && ownerSigns && !(ixs ?? []).some((ix) => ix.programAddress === BUBBLEGUM)) {
      dangers.push({ level: 2, text: "This transaction changes compressed NFTs through another program: Rings Wallet can't tell whose NFT moves." });
    }
  }

  // One transaction is atomic, so its changes net out. Several can each be sent alone: outflows add up in full
  // and inflows are listed apart as not guaranteed.
  const many = wires.length > 1;
  const decimalsOf = new Map<string, number>();
  const out = new Map<string, bigint>();
  const inn = new Map<string, bigint>();
  const intoOwn = new Map<string, bigint>();
  let toRingsAccount = 0n;
  const nftsOut: string[] = [];
  const nftsIn: string[] = [];
  const paying: number[] = [];
  const giving: number[] = [];
  effects.forEach((e, i) => {
    for (const [mint, d] of e.delta) {
      decimalsOf.set(mint, d.decimals);
      // The fee is shown as the network fee, not as a payment.
      const units = mint === SOL_MINT ? d.units + e.fee : d.units;
      if (units < 0n) {
        out.set(mint, (out.get(mint) ?? 0n) - units);
        paying.push(i);
      } else if (units > 0n) {
        inn.set(mint, (inn.get(mint) ?? 0n) + units);
        giving.push(i);
      }
    }
    for (const [mint, u] of e.intoOwn) intoOwn.set(mint, (intoOwn.get(mint) ?? 0n) + u);
    toRingsAccount += e.toRingsAccount;
    for (const n of e.nfts) (n.sign < 0 ? nftsOut : nftsIn).push(n.asset);
    if (e.nfts.some((n) => n.sign < 0)) paying.push(i);
    if (e.nfts.some((n) => n.sign > 0)) giving.push(i);
  });
  if (many && giving.some((g) => paying.some((p) => p !== g))) {
    dangers.push({ level: 2, text: `These ${wires.length} transactions can be sent one by one: what one gives you isn't guaranteed when another one pays.` });
  }
  if (many && wires.some((w, i) => giving.includes(i) && missingSigners(w).some((s) => s !== owner))) {
    dangers.push({ level: 2, text: "What one of these transactions gives you still needs someone else's signature, so it may never be sent." });
  }

  const lines: { mint: string; units: bigint; label?: "notGuaranteed" }[] = [];
  const mints = [...new Set([...out.keys(), ...inn.keys()])];
  for (const mint of mints) {
    const o = out.get(mint) ?? 0n;
    const n = inn.get(mint) ?? 0n;
    if (!many) {
      if (n - o !== 0n) lines.push({ mint, units: n - o });
    } else {
      if (o) lines.push({ mint, units: -o });
      if (n) lines.push({ mint, units: n, label: "notGuaranteed" });
    }
  }
  // A single transaction shows the fee inside its SOL row, as the network takes it.
  if (!many && effects[0]?.fee) {
    const sol = lines.find((l) => l.mint === SOL_MINT);
    if (sol) sol.units -= effects[0].fee;
    else lines.push({ mint: SOL_MINT, units: -effects[0].fee });
    if (sol && sol.units === 0n) lines.splice(lines.indexOf(sol), 1);
  }
  // SOL is always described: the Rings rows below need its price and icon.
  const rows = lines.map((l) => ({ l, r: row(l.mint, l.units < 0n ? -l.units : l.units, decimalsOf.get(l.mint) ?? 9) }));
  const sol = rows.find((x) => x.r.mint === SOL_MINT)?.r ?? row(SOL_MINT, 0n, 9);
  const extra = [...intoOwn.keys()].filter((m) => !rows.some((x) => x.r.mint === m)).map((m) => row(m, 0n, 9));
  await describe(network, [...rows.map((x) => x.r), ...(rows.some((x) => x.r === sol) ? [] : [sol]), ...extra]).catch(() => undefined);
  const known = new Map([...rows.map((x) => x.r), sol, ...extra].map((r) => [r.mint, r]));
  // A coin from an unknown mint shows its address; one copying a known coin's name is a risk.
  const label = (r: (typeof rows)[number]["r"]) => (r.lookAlike || isPinned(network, r.mint) ? r.name : `${r.name} · ${shortMint(r.mint)}`);
  for (const { r } of rows) if (r.lookAlike) dangers.push({ level: 2, text: `A coin here only looks like ${r.sym}: it comes from another address (${shortMint(r.mint)}).` });
  const changes: Change[] = rows.map(({ l, r }) => ({
    sym: r.sym,
    name: l.label === "notGuaranteed" ? `${label(r)} (only if the site sends it)` : label(r),
    amount: l.units < 0n ? -r.amount : r.amount,
    price: r.price,
    icon: r.icon,
  }));
  // Own private-balance deposits: the named amount, capped at what actually left.
  for (const [mint, units] of intoOwn) {
    const left = out.get(mint) ?? 0n;
    const shown = units < left ? units : left;
    if (shown <= 0n) continue;
    const r = known.get(mint);
    const decimals = decimalsOf.get(mint) ?? r?.decimals ?? 9;
    changes.push({ sym: r?.sym ?? shortMint(mint), name: "Into your Private balance", amount: Number(shown) / 10 ** decimals, price: r?.price ?? 0, icon: r?.icon });
  }
  if (toRingsAccount > 0n) changes.push({ sym: "SOL", name: "Your Rings account (network fees)", amount: Number(toRingsAccount) / 1e9, price: sol.price, icon: sol.icon });
  for (const asset of nftsOut) changes.push({ sym: "NFT", name: `NFT · ${shortMint(asset)}`, amount: -1, price: 0 });
  for (const asset of nftsIn) changes.push({ sym: "NFT", name: `NFT · ${shortMint(asset)}${many ? " (only if the site sends it)" : ""}`, amount: 1, price: 0 });

  const losses: Record<string, string> = {};
  for (const [mint, units] of out) losses[mint] = units.toString();
  for (const asset of nftsOut) losses[asset] = "1";
  const fee = `${formatUnits(feeTotal, 9, 9)} SOL`;
  if (failure) dangers.push({ level: 1, text: failure.reason });
  const danger = dangerText(dangers);
  if (failure) return { ok: false, changes, fee, error: failure.error, danger, reason: failure.reason, losses, count: wires.length };
  return { ok: true, changes, fee, danger, losses, count: wires.length };
}

export function looksLikeTransaction(bytes: Uint8Array): boolean {
  try {
    const [, end] = getCompiledTransactionMessageDecoder().read(bytes, 0);
    return end === bytes.length;
  } catch {
    return false;
  }
}

export function readable(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // U+FFFD replaces invalid UTF-8.
  const printable = [...text].every((c) => {
    const cp = c.codePointAt(0)!;
    return cp !== 0xfffd && (cp === 9 || cp === 10 || cp === 13 || cp >= 32);
  });
  return printable ? visible(text) : Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
