// Private balance, private addresses and money movement for the Rings account key. Background only.
import { createNoopSigner, getAddressEncoder, getProgramDerivedAddress, getTransactionDecoder, type Address, type Instruction, type Transaction } from "@solana/kit";
import {
  LocalKeys,
  SHIELDED_POOL_PROGRAM_ID,
  ShieldedAddress,
  Wallet,
  loadPersistedWallet,
  syncPersistedWallet,
  walletSnapshotCipher,
  type Bytes32,
  type RequestContext,
  type ShieldedKeypair,
  type WalletStateCipher,
  type WalletStateStore,
} from "@heliuslabs/spr";
import { getAssociatedTokenAddress, getSplAssetRegistryAddress } from "@heliuslabs/spr/addresses";
import { getCreateAssociatedTokenAccountInstructionAsync, getCreateSplInterfaceInstructionAsync } from "@heliuslabs/spr/instructions";
import { DepositAsset, TransactWithdrawal, decodeSplAssetRegistry, depositInstruction, transactInstruction } from "@heliuslabs/spr/interface";
import { AssetRegistry, ConfidentialTransfer, ProofInputUtxo, WithdrawalTarget } from "@heliuslabs/spr/transaction";
import { sha256 } from "@noble/hashes/sha2";
import {
  CONFIRM_POLL,
  MIN_FEE_FLOAT,
  RENT_KEEP,
  TINY_FEE_FLOAT,
  feeFloatFor,
  buildTopUp,
  compile,
  interfaceExists,
  keypairFromSeed,
  latestLifetime,
  mintInfo,
  publicSol,
  ringsClient,
  wire,
  withSignatures,
  type SprClient,
  type Synced,
} from "../../../web/src/core/chain";
import { keysFromRoot, type RingsKeys } from "../../../web/src/core/keys";
import { base58, fromB64, fromBase58 } from "../../../web/src/core/codec";
import { mintRules, privateBlocker } from "../../../web/src/core/mintRules";
import { TREASURY_PUBLIC, TREASURY_RING_B64, feeOf } from "./fee";
import { addressOf, ringsRoot } from "./keys";
import { kept, SNAP, type Kept } from "./kept";
import { NETWORKS, READ_TIMEOUT_MS, SOL_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type Network } from "./net";

export type Sent = { signature: string };

const clients = new Map<Network, Promise<SprClient>>();

export function client(network: Network): Promise<SprClient> {
  let c = clients.get(network);
  if (!c) {
    c = ringsClient(NETWORKS[network].rings, network);
    clients.set(network, c);
    c.catch(() => clients.delete(network));
  }
  return c;
}

export interface Ctx {
  network: Network;
  secret: Uint8Array;
  wallet: string;
  /** The seeds derived on demand are left out: the root is wiped, so they would give predictable keys. */
  keys: Omit<RingsKeys, "dealSeed" | "launchSeed" | "requestSeed">;
  /** kept.epoch() as the keys are taken: a request that outlives a lock caches nothing. */
  epoch: number;
}

export function ctxFor(network: Network, secret: Uint8Array): Ctx {
  const wallet = addressOf(secret);
  const root = ringsRoot(secret, NETWORKS[network].keyHost);
  const { dealSeed: _deal, launchSeed: _launch, requestSeed: _request, ...keys } = keysFromRoot(wallet, root);
  root.fill(0);
  return { network, secret, wallet, keys, epoch: kept.epoch() };
}

/** The Rings account key, which controls the private balance and pays private actions' network fees. */
export const accountAddress = (c: Ctx) => addressOf(c.keys.accountSeed);

const check = (bytes: Uint8Array) => sha256(bytes).slice(0, 4);

/** Base58 of the shielded address bytes plus a 4-byte sha256 checksum. */
export async function privateAddressOf(c: Ctx): Promise<string> {
  await client(c.network); // loads the SDK's Poseidon hasher
  const bytes = keypairFromSeed(c.keys.accountSeed).shieldedAddress().toBytes();
  const out = new Uint8Array(bytes.length + 4);
  out.set(bytes);
  out.set(check(bytes), bytes.length);
  return base58(out);
}

export async function ownerHashOf(network: Network, secret: Uint8Array): Promise<Uint8Array> {
  await client(network); // loads the SDK's Poseidon hasher
  const root = ringsRoot(secret, NETWORKS[network].keyHost);
  const keys = keysFromRoot(addressOf(secret), root);
  root.fill(0);
  return keypairFromSeed(keys.accountSeed).shieldedAddress().ownerHash();
}

export async function parsePrivateAddress(network: Network, text: string): Promise<ShieldedAddress | null> {
  const t = text.trim();
  if (t.length < 60) return null; // public addresses are 32 to 44 characters
  await client(network);
  try {
    const all = fromBase58(t);
    const bytes = all.slice(0, all.length - 4);
    const sum = check(bytes);
    if (!sum.every((b, i) => b === all[bytes.length + i])) return null;
    return ShieldedAddress.fromBytes(bytes);
  } catch {
    return null;
  }
}

export function isPublicAddress(text: string): boolean {
  try {
    return fromBase58(text.trim()).length === 32;
  } catch {
    return false;
  }
}

interface Cached {
  synced: Synced;
  keys: LocalKeys;
  /** Every mint looked up in the registry, registered or not. */
  mints: Set<string>;
  store: WalletStateStore;
  cipher: WalletStateCipher;
}
const cache = new Map<string, Cached>();
/** Copies of requests a lock overtook: kept for that request only, never in `cache` or in storage. */
const overtaken = new WeakMap<Ctx, Cached>();
/** Syncs of one account run one at a time. */
const turns = new Map<string, Promise<unknown>>();

/** On lock: forget the synced copies and decimals, in memory and in storage. */
export const clearSynced = (): Promise<void> => {
  cache.clear();
  knownDecimals.clear();
  return kept.forget();
};

/** Per sync request, under Chrome's 30-second limit on a background fetch; a stuck read would hold every later sync. */
const SYNC_REQUEST_TIMEOUT_MS = 20_000;
/** In characters, which are bytes here; chrome.storage.session holds 10 MB in all. */
const SNAPSHOT_MAX = 4_000_000;

export async function syncedBalance(c: Ctx, mints: string[]): Promise<Synced> {
  const cl = await client(c.network);
  const id = `${c.network}:${accountAddress(c)}`;
  const run = async () => {
    const want = [...new Set([SOL_MINT, ...mints])];
    // Same epoch as this request's keys: the shared copy. Otherwise the request's own (`overtaken`).
    const current = () => c.epoch === kept.epoch();
    const keep = (x: Cached) => (current() ? cache.set(id, x) : overtaken.set(c, x));
    let found = current() ? cache.get(id) : overtaken.get(c);
    if (!found) found = (current() ? await restored(c, cl, id) : null) ?? (await built(c, cl, id, want));
    const s = found;
    keep(s);
    try {
      // No history rescan for new mints: a sync never keeps a coin of an unknown asset (SDK rule).
      const missing = want.filter((m) => !s.mints.has(m));
      if (missing.length) {
        await join(s, cl, missing);
        for (const m of missing) s.mints.add(m);
      }
      await syncKept(s, cl);
      s.synced.registry = s.synced.wallet.registry; // the SDK returns a copy: re-read after every change
      return s.synced;
    } finally {
      keep(s); // a lock may have emptied `cache` meanwhile; a send syncs twice
    }
  };
  const next = (turns.get(id) ?? Promise.resolve()).then(run, run);
  // Store only the ordering: holding `next` would keep the copy's keypair and coins alive after a lock.
  turns.set(id, next.then(() => undefined, () => undefined));
  return next;
}

async function restored(c: Ctx, cl: SprClient, id: string): Promise<Cached | null> {
  const keypair = keypairFromSeed(c.keys.accountSeed);
  const opened = await openSnapshot(keypair, await kept.get(SNAP + id));
  return opened ? cachedOf(cl, id, c.epoch, opened.wallet, keypair, opened.mints) : null;
}

async function built(c: Ctx, cl: SprClient, id: string, want: string[]): Promise<Cached> {
  const keypair = keypairFromSeed(c.keys.accountSeed);
  const wallet = new Wallet({ identity: keypair.shieldedAddress(), registry: await batchedRegistry(cl, want) });
  return cachedOf(cl, id, c.epoch, wallet, keypair, new Set(want));
}

/** Only between syncs: a registry change during one would void it. Returns how many joined. */
async function join(s: Cached, cl: SprClient, mints: readonly string[]): Promise<number> {
  let joined = 0;
  for (const [assetId, mint] of await registryEntries(cl, mints)) {
    try {
      if (s.synced.wallet.ensureAsset(assetId, mint)) joined++;
    } catch {
      // already bound to another mint: skipped
    }
  }
  return joined;
}

function cachedOf(cl: SprClient, id: string, epoch: number, wallet: Wallet, keypair: ShieldedKeypair, mints: Set<string>): Cached {
  const s: Cached = {
    synced: { wallet, registry: wallet.registry, keypair },
    keys: LocalKeys.fromKeypair(keypair, cl.proofService),
    mints,
    store: snapshotStore(id, () => s.mints, epoch),
    cipher: walletSnapshotCipher(keypair),
  };
  return s;
}

/** Null when missing, damaged, unreadable by this SDK, or sealed for another account. */
export async function openSnapshot(keypair: ShieldedKeypair, record: unknown): Promise<{ wallet: Wallet; mints: Set<string> } | null> {
  const r = record as { sealed?: unknown; mints?: unknown } | null | undefined;
  if (!r || typeof r.sealed !== "string" || !Array.isArray(r.mints) || !r.mints.every((m) => typeof m === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m))) return null;
  const sealed = r.sealed;
  try {
    const wallet = await loadPersistedWallet({ store: { load: async () => sealed }, cipher: walletSnapshotCipher(keypair) });
    return wallet ? { wallet, mints: new Set(r.mints as string[]) } : null;
  } catch {
    return null;
  }
}

/** `epoch`: the creating request's Ctx.epoch; nothing is written after a lock. Saving never fails a sync. */
export function snapshotStore(id: string, mints: () => Set<string>, epoch: number, store: Kept = kept): WalletStateStore {
  return {
    load: async () => {
      const r = await store.get<{ sealed?: unknown }>(SNAP + id);
      return typeof r?.sealed === "string" ? r.sealed : undefined;
    },
    save: async (sealed) => {
      if (sealed.length > SNAPSHOT_MAX) return;
      await store.put(SNAP + id, { sealed, mints: [...mints()] }, epoch, { dropOtherSnapshots: true });
    },
  };
}

const syncFailedWith = (e: unknown, cause: string) => {
  const x = e as { code?: string; causeCode?: string; causeCodes?: readonly string[] } | null;
  return x?.code === "WALLET_SYNC" && (x.causeCode === cause || !!x.causeCodes?.includes(cause));
};
export const unresolvedAsset = (e: unknown) => syncFailedWith(e, "WALLET_UNRESOLVED_ASSET");

/** Transactions per history page: the SDK's default and Photon's maximum. */
const PAGE_MAX = 1_000;
const PAGE_MIN = 125;
/** Halved after a sync request times out: the SDK shrinks a page only when the indexer refuses it as too big. */
let pageLimit = PAGE_MAX;
export const pageLimitAfter = (limit: number, e: unknown) => (syncFailedWith(e, "CLIENT_TIMEOUT") ? Math.max(PAGE_MIN, Math.floor(limit / 2)) : limit);

/** How long rings.run's proxy serves every browser the same registry-scan answer (its REGISTRY_FRESH_MS). */
const SCAN_SHARED_MS = 5_000;

async function syncKept(s: Cached, cl: SprClient) {
  const once = async () => {
    try {
      await syncPersistedWallet({ wallet: s.synced.wallet, keys: s.keys, client: cl as never, store: s.store, cipher: s.cipher, config: { pageLimit } }, { timeoutMs: SYNC_REQUEST_TIMEOUT_MS });
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code === "WALLET_SNAPSHOT" || code === "WALLET_PERSIST") return; // raised only after the sync committed
      pageLimit = pageLimitAfter(pageLimit, e);
      throw e;
    }
  };
  try {
    await once();
  } catch (e) {
    if (!unresolvedAsset(e)) throw e;
    const failed = Date.now();
    const listed = new Set<string>(s.synced.wallet.registry.entries().map(([, mint]) => mint));
    const unlisted = [...s.mints].filter((m) => m !== SOL_MINT && !listed.has(m));
    // Re-read the mints found unregistered; if none joined, wait until the proxy's shared scan answer expires.
    const joined = unlisted.length ? await join(s, cl, unlisted).catch(() => 0) : 0;
    if (!joined) await new Promise((r) => setTimeout(r, Math.max(0, SCAN_SHARED_MS + 500 - (Date.now() - failed))));
    await once();
  }
}

/** getMultipleAccounts' per-call limit. */
const ACCOUNTS_PER_CALL = 100;

export async function registryEntries(cl: Pick<SprClient, "getMultipleAccounts">, mints: readonly string[], context: RequestContext = { timeoutMs: READ_TIMEOUT_MS }): Promise<[bigint, Address][]> {
  const list = [...new Set(mints)].filter((m) => m !== SOL_MINT);
  const pdas = await Promise.all(list.map((m) => getSplAssetRegistryAddress(m as Address)));
  const calls = [];
  for (let i = 0; i < pdas.length; i += ACCOUNTS_PER_CALL) calls.push(cl.getMultipleAccounts(pdas.slice(i, i + ACCOUNTS_PER_CALL), context));
  const accounts = (await Promise.all(calls)).flat();
  const out: [bigint, Address][] = [];
  accounts.forEach((account, i) => {
    // Anyone can send lamports to a registry address, leaving a system-owned account there.
    if (!account || account.owner !== SHIELDED_POOL_PROGRAM_ID) return;
    let decoded;
    try {
      decoded = decodeSplAssetRegistry(account.data);
    } catch {
      return;
    }
    if (decoded.mint === list[i]) out.push([decoded.assetId, decoded.mint]);
  });
  return out;
}

export async function batchedRegistry(cl: Pick<SprClient, "getMultipleAccounts">, mints: readonly string[], context?: RequestContext): Promise<AssetRegistry> {
  const registry = new AssetRegistry();
  for (const [assetId, mint] of await registryEntries(cl, mints, context)) registry.insert(assetId, mint);
  return registry;
}

export async function privateUnits(c: Ctx, mints: string[]): Promise<Map<string, bigint>> {
  const all = [...new Set([SOL_MINT, ...mints])].sort();
  const s = { wallet: (await syncedBalance(c, mints)).wallet };
  const out = new Map<string, bigint>();
  for (const m of all) {
    try {
      out.set(m, s.wallet.balance(m as Address).amount);
    } catch {
      out.set(m, 0n); // no registry entry: never made private
    }
  }
  // Plus every other coin held: the SDK backfills the registry when a sync meets an unknown asset.
  for (const b of s.wallet.balances(true)) if (!out.has(b.mint) && b.amount > 0n) out.set(b.mint, b.amount);
  return out;
}

/** Mainnet decimals of well-known coins, never taken from a server. */
const PINNED_DECIMALS: Record<string, number> = {
  So11111111111111111111111111111111111111112: 9,
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6,
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 6,
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5,
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 6,
};
const checkedDecimals = new Map<string, number>();
const knownDecimals = new Map<string, number>();
// Checked decimals are also stored in `kept`. `at` is the asking request's Ctx.epoch: nothing is kept after a lock;
// without `at`, memory only.
const DECIMALS = "dec:";
const isDecimals = (d: unknown): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 255;
function keepDecimals(id: string, decimals: number, at: number | undefined) {
  if (at !== undefined && at !== kept.epoch()) return;
  knownDecimals.set(id, decimals);
  if (at !== undefined) void kept.put(DECIMALS + id, decimals, at);
}

/** Never from Rings' answer alone: pinned, or read from the mint and, on mainnet, checked against Jupiter. */
export async function decimalsOf(network: Network, mint: string, at?: number): Promise<number> {
  if (mint === SOL_MINT) return 9;
  if (network === "mainnet" && PINNED_DECIMALS[mint] !== undefined) return PINNED_DECIMALS[mint];
  const id = `${network}:${mint}`;
  const known0 = knownDecimals.get(id);
  if (known0 !== undefined) return known0;
  const saved = await kept.get(DECIMALS + id);
  if (isDecimals(saved)) {
    knownDecimals.set(id, saved);
    return saved;
  }
  const info = await mintInfo(await client(network), mint as Address);
  if (info.tokenProgram !== TOKEN_PROGRAM && info.tokenProgram !== TOKEN_2022_PROGRAM) throw new Error("That address isn't a coin.");
  if (network !== "mainnet") {
    keepDecimals(id, info.decimals, at);
    return info.decimals;
  }
  let known = checkedDecimals.get(mint);
  if (known === undefined) {
    const found = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`)
      .then((r) => r.json() as Promise<{ id?: string; decimals?: number }[]>)
      .then((list) => (Array.isArray(list) ? list.find((t) => t.id === mint)?.decimals : undefined))
      .catch(() => undefined);
    if (typeof found === "number") checkedDecimals.set(mint, (known = found));
  }
  if (known !== undefined && known !== info.decimals) throw new Error("Rings' answer about this coin doesn't match Jupiter's. Nothing was done.");
  // Cached only once Jupiter confirms them.
  if (known !== undefined) keepDecimals(id, info.decimals, at);
  return info.decimals;
}

export function signWire(base64: string, secrets: Uint8Array[]): string {
  const tx = getTransactionDecoder().decode(fromB64(base64));
  return wire(withSignatures(tx as never, secrets));
}

/** Sent, or maybe sent, but unconfirmed: it can still land, so it is never retried. */
export class MaybeSent extends Error {
  constructor(readonly signature: string, cause: unknown) {
    super(`Sent, but not confirmed yet (${cause instanceof Error ? cause.message : String(cause)}). Check Activity before trying again.`);
  }
}

/** Called with the signature just before the transaction goes out. */
export type OnSent = (signature: string) => Promise<void> | void;

/** The fee payer's signature, which is the first. */
export function signatureOfWire(base64Wire: string): string {
  const tx = getTransactionDecoder().decode(fromB64(base64Wire));
  const first = Object.values(tx.signatures as Record<string, Uint8Array | null>)[0];
  if (!first) throw new Error("This transaction isn't signed.");
  return base58(first);
}

/** Nothing went out: a node's JSON-RPC error (negative code) or a 4xx from Rings' proxy. Anything else may have. */
export function surelyRefused(e: unknown): boolean {
  const c = (e as { context?: { __code?: number; statusCode?: number } } | null)?.context;
  if (typeof c?.__code === "number" && c.__code < 0) return true;
  return typeof c?.statusCode === "number" && c.statusCode >= 400 && c.statusCode < 500;
}

async function sendAndConfirm(cl: SprClient, base64Wire: string, onSent?: OnSent): Promise<Sent> {
  const signature = signatureOfWire(base64Wire);
  await onSent?.(signature);
  try {
    await cl.solanaRpc.sendTransaction(base64Wire as never, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" }).send();
  } catch (e) {
    if (surelyRefused(e)) throw e;
    throw new MaybeSent(signature, e);
  }
  try {
    await cl.confirmTransaction(signature as never, CONFIRM_POLL);
  } catch (e) {
    throw new MaybeSent(signature, e);
  }
  return { signature };
}


export async function assertWalletAddress(network: Network, to: string) {
  const { value } = await (await client(network)).solanaRpc.getAccountInfo(to as Address, { encoding: "base64" }).send();
  const owner = value?.owner as string | undefined;
  if (owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) throw new Error("That address is a token account or a coin's mint, not a wallet. Coins sent there would be lost.");
}

const short = (lamports: bigint) => `${(Number(lamports) / 1e9).toFixed(4)} SOL`;

export { MIN_FEE_FLOAT, RENT_KEEP, TINY_FEE_FLOAT };
/** A private transaction's fee (10,000 lamports) with margin. */
const TX_FEE_ROOM = 20_000n;
export const canPayFees = (lamports: bigint, txs = 1) => lamports >= RENT_KEEP + BigInt(txs) * TX_FEE_ROOM;
const floatLow = (lamports: bigint) => lamports < MIN_FEE_FLOAT / 2n;
/** (have, spend): the float `have` public lamports can give once `spend` is paid. */
export const floatFor = feeFloatFor;

export async function accountLamports(c: Ctx): Promise<bigint> {
  return publicSol(await client(c.network), accountAddress(c) as Address);
}

/** Tops up the account key only when it can't pay `txs` more fees: each top-up publicly links it to the wallet. */
async function ensureFees(c: Ctx, cl: SprClient, allowTopUp = true, txs = 1) {
  const account = accountAddress(c) as Address;
  if (canPayFees(await publicSol(cl, account), txs)) return;
  if (!allowTopUp) throw new Error("Rings couldn't pay this network fee right now. Try again in a little while: paying it from your Public balance would link it to your private balance.");
  const lamports = floatFor(await publicSol(cl, c.wallet as Address), 0n);
  if (!lamports) throw new Error(`Private actions need about ${short(TINY_FEE_FLOAT + RENT_KEEP + TX_FEE_ROOM)} in your Public balance for network fees.`);
  try {
    await sendAndConfirm(cl, signWire(await buildTopUp(cl, c.wallet as Address, account, lamports), [c.secret]));
  } catch (e) {
    // The top-up's MaybeSent must not read as the payment's: the payment hasn't been sent.
    if (e instanceof MaybeSent) throw new Error("The network-fee top-up was sent but isn't confirmed yet. Your payment wasn't sent: try again in a minute.");
    throw e;
  }
}

/** For a multi-transaction action: every fee is covered up front, or nothing starts. */
export async function ensureFeesFor(c: Ctx, txs: number) {
  await ensureFees(c, await client(c.network), true, txs);
}

/** Up front, as the pool refuses deposits of some coins, e.g. Token-2022 with a transfer fee (error 7010). */
export async function assertCanGoPrivate(network: Network, mint: string) {
  if (mint === SOL_MINT) return;
  const key = `${network}:${mint}`;
  let hit = blockers.get(key);
  if (!hit || Date.now() - hit.at > 10 * 60_000) {
    hit = { at: Date.now(), why: privateBlockerOf(network, mint) };
    blockers.set(key, hit);
    hit.why.catch(() => blockers.delete(key));
  }
  const why = await hit.why;
  if (why) throw new Error(why);
}
const blockers = new Map<string, { at: number; why: Promise<string | null> }>();
async function privateBlockerOf(network: Network, mint: string): Promise<string | null> {
  const cl = await client(network);
  const { value } = await cl.solanaRpc.getAccountInfo(mint as Address, { encoding: "base64" }).send();
  if (!value) throw new Error("That coin wasn't found on this network."); // not cached: the mint may be seconds old
  const data = Uint8Array.from(atob((value.data as unknown as [string, string])[0]), (ch) => ch.charCodeAt(0));
  return privateBlocker(mintRules(value.owner, data));
}

/** One signature's network fee, in lamports. */
const PUBLIC_TX_FEE = 5_000n;

/** Needs the SDK's hasher, which client() loads. */
const treasuryRing = (): ShieldedAddress => ShieldedAddress.fromBytes(fromB64(TREASURY_RING_B64));

/** Public -> private, into this account's balance or `to`'s. `reserve`: public lamports later deposits still need. */
export async function shield(c: Ctx, mint: string, units: bigint, to?: ShieldedAddress, opts: { topUp?: boolean; reserve?: bigint; fee?: bigint; onSent?: OnSent } = {}): Promise<Sent> {
  await assertCanGoPrivate(c.network, mint);
  const cl = await client(c.network);
  const account = accountAddress(c) as Address;
  let fee = opts.fee ?? 0n;
  const held = !to && opts.topUp !== false ? await publicSol(cl, account) : null;
  const have = await publicSol(cl, c.wallet as Address);
  const float = held !== null && floatLow(held) ? floatFor(have, (mint === SOL_MINT ? units + fee : 0n) + (opts.reserve ?? 0n)) : 0n;
  // Refused up front: the coins would land in a private balance whose account key can't pay to spend them.
  if (held !== null && !canPayFees(held) && float === 0n) throw new Error(`Private actions need about ${short(TINY_FEE_FLOAT + RENT_KEEP + TX_FEE_ROOM)} in your Public balance for network fees.`);
  // A single leftover lamport would break Solana's rent rule: it goes with the fee.
  if (mint === SOL_MINT && fee > 0n && have - units - fee - float - PUBLIC_TX_FEE === 1n) fee += 1n;
  const depositor = createNoopSigner(c.wallet as Address);
  const ixs: Instruction[] = [];
  if (float > 0n) ixs.push(transferLamports(c.wallet as Address, account, float));
  let asset;
  if (mint === SOL_MINT) asset = DepositAsset.sol();
  else {
    const { tokenProgram } = await mintInfo(cl, mint as Address);
    // The first deposit of a coin, by anyone, opens its vault in the pool.
    if (!(await interfaceExists(cl, mint as Address))) ixs.push(await getCreateSplInterfaceInstructionAsync({ authority: depositor, mint: mint as Address, tokenProgram }));
    asset = DepositAsset.spl({ mint: mint as Address, sourceTokenAccount: await getAssociatedTokenAddress(c.wallet as Address, mint as Address, tokenProgram), tokenProgram });
  }
  const dest = to ?? keypairFromSeed(c.keys.accountSeed).shieldedAddress();
  const deposits = [{ asset, viewTag: dest.confidentialViewTag() as Bytes32, recipientOwnerHash: dest.ownerHash() as Bytes32, amount: units }];
  if (fee > 0n) {
    const t = treasuryRing();
    deposits.push({ asset, viewTag: t.confidentialViewTag() as Bytes32, recipientOwnerHash: t.ownerHash() as Bytes32, amount: fee });
  }
  ixs.push(await depositInstruction({ tree: cl.tree, depositor, deposits }));
  const tx = withSignatures(compile(0, c.wallet as Address, await latestLifetime(cl), ixs), [c.secret]);
  return sendAndConfirm(cl, wire(tx), opts.onSent);
}

export async function unshield(c: Ctx, mint: string, units: bigint, to: string, opts: { allowTopUp?: boolean; fee?: bigint; onSent?: OnSent } = {}): Promise<Sent> {
  const cl = await client(c.network);
  if (to !== c.wallet) await assertWalletAddress(c.network, to);
  await mustHold(c, mint, units + (opts.fee ?? 0n));
  await ensureFees(c, cl, opts.allowTopUp !== false);
  return transact(c, cl, mint, units, { public: to }, opts.fee ?? 0n, opts.onSent);
}

export async function sendPrivately(c: Ctx, mint: string, units: bigint, to: ShieldedAddress, opts: { allowTopUp?: boolean; fee?: bigint; onSent?: OnSent } = {}): Promise<Sent> {
  const cl = await client(c.network);
  await mustHold(c, mint, units + (opts.fee ?? 0n));
  await ensureFees(c, cl, opts.allowTopUp !== false);
  return transact(c, cl, mint, units, { private: to }, opts.fee ?? 0n, opts.onSent);
}

/** Run before ensureFees: a send the balance can't cover must not make the public top-up. */
async function mustHold(c: Ctx, mint: string, want: bigint) {
  const { wallet } = await syncedBalance(c, mint === SOL_MINT ? [] : [mint]);
  let held = 0n;
  try {
    held = wallet.balance(mint as Address).amount;
  } catch {
    /* never made private */
  }
  if (held < want) throw new Error("Your balance doesn't have enough of a coin for this.");
}

/** Input coins per proof: 24 with three outputs (SDK proof shapes), 40 with two. */
const maxInputs = (outputs: number) => (outputs > 2 ? 24 : 40);

/** Null when the recipient needs a token account and `openAccount` is off (Rings' fee payer pays no rent). */
export async function proveTransfer(c: Ctx, cl: SprClient, payer: Address, mint: string, units: bigint, to: { private: ShieldedAddress } | { public: string }, feeAsked: bigint, opts: { openAccount: boolean }): Promise<Transaction | null> {
  const owner = accountAddress(c) as Address;
  const { wallet, registry, keypair } = await syncedBalance(c, mint === SOL_MINT ? [] : [mint]);
  const coins = [...wallet.balance(mint as Address).utxos].filter((u) => u.amount > 0n).sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  if (!coins.length) throw new Error("No private balance in that token.");
  const pick = (need: bigint) => {
    const picked: typeof coins = [];
    let sum = 0n;
    for (const u of coins) {
      if (sum >= need) break;
      picked.push(u);
      sum += u.amount;
    }
    return { picked, sum };
  };
  let fee = feeAsked;
  let { picked, sum } = pick(units + fee);
  // A single unit of change would be dust: it goes with the fee.
  if (fee > 0n && sum - units - fee === 1n) fee += 1n;
  const outputs = (fee: bigint) => ("private" in to ? 1 : 0) + (fee > 0n ? 1 : 0) + (sum > units + fee ? 1 : 0);
  // Too many coins for the fee's output to fit in one proof: send without the fee rather than not at all.
  if (fee > 0n && picked.length > maxInputs(outputs(fee))) {
    fee = 0n;
    ({ picked, sum } = pick(units));
  }
  if (sum < units + fee) throw new Error("Your balance doesn't have enough of a coin for this.");
  const t = new ConfidentialTransfer(keypair.shieldedAddress(), picked.map((u) => ProofInputUtxo.fromKeypair(u, keypair)), payer);
  const pre: Instruction[] = [];
  let withdrawal;
  if ("private" in to) t.send(to.private, mint as Address, units);
  else if (mint === SOL_MINT) {
    t.withdraw(SOL_MINT as Address, units, WithdrawalTarget.sol({ recipient: to.public as Address }));
    withdrawal = TransactWithdrawal.sol({ recipient: to.public as Address });
  } else {
    const { tokenProgram } = await mintInfo(cl, mint as Address);
    const recipientTokenAccount = await getAssociatedTokenAddress(to.public as Address, mint as Address, tokenProgram);
    const [splTokenInterface, splInterfaceBump] = await getProgramDerivedAddress({
      programAddress: SHIELDED_POOL_PROGRAM_ID,
      seeds: [new TextEncoder().encode("spl_asset_vault"), getAddressEncoder().encode(mint as Address)],
    });
    t.withdraw(mint as Address, units, WithdrawalTarget.spl({ recipientTokenAccount, splTokenInterface, splInterfaceBump }));
    withdrawal = TransactWithdrawal.spl({ mint: mint as Address, splTokenInterface, recipientTokenAccount, tokenProgram });
    if (!(await cl.getAccount(recipientTokenAccount))) {
      if (!opts.openAccount) return null;
      pre.push(await getCreateAssociatedTokenAccountInstructionAsync({ payer: createNoopSigner(payer), owner: to.public as Address, mint: mint as Address, tokenProgram }));
    }
  }
  // After the payment: the fee as its own output to the treasury.
  if (fee > 0n) t.send(treasuryRing(), mint as Address, fee);
  const data = await cl.proveTransact(t.sign(keypair, registry), [keypair]);
  const ix = await transactInstruction({
    payer: createNoopSigner(payer),
    ownerSigners: [createNoopSigner(owner)],
    inputTree: cl.tree,
    outputTree: cl.tree,
    ...(withdrawal ? { withdrawal } : {}),
    data,
  });
  return withSignatures(compile(1, payer, await latestLifetime(cl), [...pre, ix]), [c.keys.accountSeed]);
}

async function transact(c: Ctx, cl: SprClient, mint: string, units: bigint, to: { private: ShieldedAddress } | { public: string }, fee: bigint, onSent?: OnSent): Promise<Sent> {
  const tx = await proveTransfer(c, cl, accountAddress(c) as Address, mint, units, to, fee, { openAccount: true });
  return sendAndConfirm(cl, wire(tx!), onSent);
}

export async function sendPublic(c: Ctx, mint: string, units: bigint, to: string, onSent?: OnSent, feeAsked = 0n): Promise<Sent> {
  const cl = await client(c.network);
  await assertWalletAddress(c.network, to);
  const wallet = c.wallet as Address;
  const ixs: Instruction[] = [];
  if (mint === SOL_MINT) {
    let fee = feeAsked;
    // A single leftover lamport would break Solana's rent rule: it goes with the fee.
    if (fee > 0n && (await publicSol(cl, wallet)) - units - fee - PUBLIC_TX_FEE === 1n) fee += 1n;
    ixs.push(transferLamports(wallet, to as Address, units));
    if (fee > 0n) ixs.push(transferLamports(wallet, TREASURY_PUBLIC as Address, fee));
  } else {
    const { tokenProgram, decimals } = await mintInfo(cl, mint as Address);
    const from = await getAssociatedTokenAddress(wallet, mint as Address, tokenProgram);
    const dest = await getAssociatedTokenAddress(to as Address, mint as Address, tokenProgram);
    if (!(await cl.getAccount(dest))) {
      ixs.push(await getCreateAssociatedTokenAccountInstructionAsync({ payer: createNoopSigner(wallet), owner: to as Address, mint: mint as Address, tokenProgram }));
    }
    ixs.push(transferChecked(from, mint as Address, dest, wallet, units, decimals, tokenProgram));
    if (feeAsked > 0n) {
      const treasury = await getAssociatedTokenAddress(TREASURY_PUBLIC as Address, mint as Address, tokenProgram);
      // Skipped unless the treasury's account can take it: a fee that can't land fails the whole send, and opening
      // the account would cost more rent than the fee.
      if (takesToken(await cl.getAccount(treasury), mint, TREASURY_PUBLIC, tokenProgram)) ixs.push(transferChecked(from, mint as Address, treasury, wallet, feeAsked, decimals, tokenProgram));
    }
  }
  const tx = compile(0, wallet, await latestLifetime(cl), ixs);
  return sendAndConfirm(cl, wire(withSignatures(tx, [c.secret])), onSent);
}

/** SPL token account layout (Token-2022 extends it): mint at 0, owner at 32, state at 108 (1: initialized, not frozen). */
export function takesToken(account: { owner: string; data: Uint8Array } | undefined, mint: string, owner: string, program: string): boolean {
  if (!account || account.owner !== program || account.data.length < 165) return false;
  return base58(account.data.subarray(0, 32)) === mint && base58(account.data.subarray(32, 64)) === owner && account.data[108] === 1;
}

/** Lamports: the signature fee plus the pool's own. */
export const PRIVATE_TX_FEE = 10_000n;
export { PUBLIC_TX_FEE };

/** `ownDeposit`: a move into this account's own private balance. */
export type Route = "publicToPublic" | "publicToPrivate" | "ownDeposit" | "privateToPrivate" | "privateToPublic";

export interface ActionCosts {
  /** The fee actually taken: 0 when sendPublic would skip it. */
  fee: bigint;
  network: bigint;
  /** "both": a swap paid from Public (deposits, then private payments). */
  payer: "public" | "account" | "both";
  openRent: bigint;
  /** An own deposit's float for the account key, in the same transaction. */
  float: bigint;
  /** A private action's top-up of the account key, in its own transaction first. */
  topUp: bigint;
}

/** Mirrors shield, sendPublic, transact and ensureFees, minus rare cases (a coin's first deposit, over 24 coins). */
export async function costsOf(c: Ctx, route: Route, mint: string, units: bigint, to: string | null): Promise<ActionCosts> {
  const cl = await client(c.network);
  const account = accountAddress(c) as Address;
  let fee = feeOf(units);
  let openRent = 0n;
  let float = 0n;
  let topUp = 0n;
  if ((route === "publicToPublic" || route === "privateToPublic") && mint !== SOL_MINT && to) {
    const { tokenProgram } = await mintInfo(cl, mint as Address);
    if (!(await cl.getAccount(await getAssociatedTokenAddress(to as Address, mint as Address, tokenProgram)))) openRent = await tokenAccountRent(cl);
    if (route === "publicToPublic") {
      const treasury = await getAssociatedTokenAddress(TREASURY_PUBLIC as Address, mint as Address, tokenProgram);
      if (!takesToken(await cl.getAccount(treasury), mint, TREASURY_PUBLIC, tokenProgram)) fee = 0n;
    }
  }
  if (route === "ownDeposit" && floatLow(await publicSol(cl, account))) {
    float = floatFor(await publicSol(cl, c.wallet as Address), mint === SOL_MINT ? units + fee : 0n);
  }
  const fromPrivate = route === "privateToPrivate" || route === "privateToPublic";
  if (fromPrivate && !canPayFees(await publicSol(cl, account))) topUp = floatFor(await publicSol(cl, c.wallet as Address), 0n);
  return { fee, network: fromPrivate ? PRIVATE_TX_FEE : PUBLIC_TX_FEE, payer: fromPrivate ? "account" : "public", openRent, float, topUp };
}

/** ensureFees' top-up for `txs` private transactions, or 0. */
export async function feeTopUpFor(c: Ctx, txs: number): Promise<bigint> {
  const cl = await client(c.network);
  if (canPayFees(await publicSol(cl, accountAddress(c) as Address), txs)) return 0n;
  return floatFor(await publicSol(cl, c.wallet as Address), 0n);
}

/** Rent for a 165-byte token account; Token-2022 accounts need a little more. */
let tokenRent: bigint | null = null;
async function tokenAccountRent(cl: SprClient): Promise<bigint> {
  // Cached once read; a failed read falls back to the standard figure, uncached.
  if (tokenRent === null) tokenRent = await cl.solanaRpc.getMinimumBalanceForRentExemption(165n).send().then(BigInt, () => null);
  return tokenRent ?? 2_039_280n;
}

/** System Program Transfer: u32 instruction 2, then u64 lamports, little-endian. */
function transferLamports(from: Address, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  data[0] = 2;
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  return {
    programAddress: "11111111111111111111111111111111" as Address,
    accounts: [
      { address: from, role: 3 },
      { address: to, role: 1 },
    ],
    data,
  } as Instruction;
}

/** SPL Token TransferChecked: tag 12, u64 amount, u8 decimals; the program checks the decimals against the mint. */
function transferChecked(source: Address, mint: Address, dest: Address, owner: Address, amount: bigint, decimals: number, program: Address): Instruction {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;
  return {
    programAddress: program,
    accounts: [
      { address: source, role: 1 },
      { address: mint, role: 0 },
      { address: dest, role: 1 },
      { address: owner, role: 2 },
    ],
    data,
  } as Instruction;
}
