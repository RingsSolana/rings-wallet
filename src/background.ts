// Background service worker, the only place keys live. Only the extension's own pages reach its account functions.
import { accountSecret, addressOf, isPhrase, newPhrase, normalizePhrase, parseSecretKey, phraseSeed } from "./lib/keys";
import { exportKey, importKey, open, openWithKey, reseal, seal, WrongPassword, type Account, type Secrets, type VaultBlob } from "./lib/vault";
import { DEVNET_ALIASES, NETWORKS, PRODUCTS, SOL_MINT, describe, formatUnits, networkOf, parseUnits, productUrl, publicBalances, publicMints, row, rpc, sortRows, type Network, type TokenRow } from "./lib/net";
import { ownTxEffect, type ParsedTx } from "./lib/chainActivity";
import { MaybeSent, PRIVATE_TX_FEE, PUBLIC_TX_FEE, RENT_KEEP, TINY_FEE_FLOAT, accountAddress, accountLamports, assertCanGoPrivate, canPayFees, clearSynced, costsOf, ctxFor, decimalsOf, ensureFeesFor, feeTopUpFor, isPublicAddress, parsePrivateAddress, privateAddressOf, privateUnits, sendPublic, shield, type ActionCosts, type Ctx, type OnSent, type Route } from "./lib/rings";
import { failureReason } from "./lib/simulate";
import { buyList, checkPayments, costsCeilingOf, createSwap, deliverToOf, paySwap, quote, swapCosts, swapStatus, tellPaid, type Payment, type SwapState } from "./lib/swap";
import { withSession } from "./lib/session";
import { payPrivately, ringsPaysFees, withdrawTo } from "./lib/pay";
import { feeOf } from "./lib/fee";
import { kept } from "./lib/kept";
import { applyQueuedDisconnects, approvalView, cancelAll, decide, disconnectDomain, notifyAccounts, sitesOf, startProvider, trustTab, type ProviderDeps } from "./provider/server";
import type { AccountView, CachedBalances, Done, FeesView, HistoryItem, PrivateView, Reply, Request, Shortfall, SwapQuoteView, SwapView, TokenOption, WalletState } from "./lib/protocol";
import { base58, fromBase58 } from "../../web/src/core/codec";

const LOCK_ALARM = "autolock";
const MIN_PASSWORD = 8;
const LOCK_CHOICES = [5, 15, 30, 60];

interface Prefs {
  network: Network;
  autoLockMin: number;
  activeId: string | null;
  accounts: AccountView[];
  hasPhrase: boolean;
  mints: Partial<Record<Network, string[]>>;
}
declare const __RELEASE__: boolean | undefined;
const RELEASE = typeof __RELEASE__ !== "undefined" && __RELEASE__;
const DEFAULT_PREFS: Prefs = { network: RELEASE ? "mainnet" : "devnet", autoLockMin: 15, activeId: null, accounts: [], hasPhrase: false, mints: {} };
const HISTORY_MAX = 200;

interface Unlock {
  key: string;
  until: number;
}

class Coded extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

let secrets: Secrets | null = null;
let seed: Uint8Array | null = null;
let vaultKey: CryptoKey | null = null;

const local = chrome.storage.local;
const session = chrome.storage.session;
void session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
// Content scripts can read and write storage.local by default; restrict it. Older Chrome versions reject the call.
try {
  void (local as unknown as { setAccessLevel?: (o: { accessLevel: string }) => Promise<void> }).setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch(() => undefined);
} catch {
  /* unsupported in this Chrome version */
}

const getVault = async () => ((await local.get("vault")).vault as VaultBlob | undefined) ?? null;
/** Storage can be edited outside the wallet: every setting is checked on read. */
const getPrefs = async (): Promise<Prefs> => {
  const p = { ...DEFAULT_PREFS, ...((await local.get("prefs")).prefs as Partial<Prefs> | undefined) };
  return {
    ...p,
    network: p.network === "mainnet" || (p.network === "devnet" && !RELEASE) ? p.network : DEFAULT_PREFS.network,
    autoLockMin: LOCK_CHOICES.includes(p.autoLockMin) ? p.autoLockMin : 15,
    accounts: Array.isArray(p.accounts) ? p.accounts : [],
    mints: p.mints && typeof p.mints === "object" ? p.mints : {},
  };
};
const setPrefs = async (p: Partial<Prefs>) => local.set({ prefs: { ...(await getPrefs()), ...p } });
const getUnlock = async () => ((await session.get("unlock")).unlock as Unlock | undefined) ?? null;
const viewOf = (a: Account): AccountView => ({ id: a.id, name: a.name, kind: a.kind, address: a.address });

/** Bumped by every lock, so a remember() in flight can't write the vault key back after it. */
let lockEpoch = 0;

/** Stores the vault key (never the password) and pushes the auto-lock back. */
async function remember(key: CryptoKey) {
  const epoch = lockEpoch;
  const until = Date.now() + (await getPrefs()).autoLockMin * 60_000;
  const raw = await exportKey(key);
  if (epoch !== lockEpoch) return;
  await session.set({ unlock: { key: raw, until } satisfies Unlock });
  if (epoch !== lockEpoch) return void session.remove("unlock");
  await chrome.alarms.create(LOCK_ALARM, { when: until });
}

async function lock() {
  lockEpoch++;
  seed?.fill(0);
  seed = null;
  secrets = null;
  vaultKey = null;
  const forgotten = clearSynced();
  cancelAll();
  await session.remove("unlock");
  await chrome.alarms.clear(LOCK_ALARM);
  await forgotten.catch(() => undefined);
  void notifyAccounts();
}

async function begin(key: CryptoKey, s: Secrets) {
  secrets = s;
  vaultKey = key;
  seed = s.phrase ? phraseSeed(s.phrase) : null;
  await remember(key);
}

/** True while an unexpired vault key is stored; reopens the keys after a worker restart. */
async function unlocked(): Promise<boolean> {
  // Read first: a lock while getUnlock() runs must not reopen the keys from stale data.
  const epoch = lockEpoch;
  const u = await getUnlock();
  if (!u || u.until <= Date.now()) {
    if (u || secrets) await lock();
    return false;
  }
  if (!secrets) {
    const blob = await getVault();
    if (!blob) return false;
    try {
      const key = await importKey(u.key);
      const s = await openWithKey(blob, key);
      if (epoch !== lockEpoch) return false;
      if (secrets) return true; // reopened by a concurrent call
      secrets = s;
      vaultKey = key;
      seed = s.phrase ? phraseSeed(s.phrase) : null;
    } catch {
      await lock();
      return false;
    }
  }
  return true;
}

/** Throws "locked" unless unlocked. `touch` pushes the auto-lock back; polling reads pass false. */
async function need(touch = true) {
  if (!(await unlocked()) || !vaultKey) throw new Coded("locked", "Rings Wallet is locked.");
  if (touch) await remember(vaultKey);
}

/** Saves are serialized; each writes the secrets current when it starts, so the last one holds the latest. */
let saving: Promise<unknown> = Promise.resolve();
function save(): Promise<void> {
  const run = async () => {
    const blob = await getVault();
    if (!blob || !vaultKey || !secrets) throw new Coded("locked", "Rings Wallet is locked.");
    const now = secrets;
    await local.set({ vault: await reseal(blob, vaultKey, now) });
    await setPrefs({ accounts: now.accounts.map(viewOf), hasPhrase: !!now.phrase });
  };
  const next = saving.then(run, run);
  saving = next.catch(() => undefined);
  return next;
}

async function state(): Promise<WalletState> {
  const [blob, prefs] = await Promise.all([getVault(), getPrefs()]);
  const isOpen = !!blob && (await unlocked());
  if (isOpen && vaultKey) await remember(vaultKey);
  return {
    hasVault: !!blob,
    unlocked: isOpen,
    network: prefs.network,
    autoLockMin: prefs.autoLockMin,
    // From the decrypted vault while unlocked: a Receive address must never come from editable storage.
    accounts: isOpen && secrets ? secrets.accounts.map(viewOf) : prefs.accounts,
    activeId: prefs.activeId ?? prefs.accounts[0]?.id ?? null,
    hasPhrase: prefs.hasPhrase,
    version: chrome.runtime.getManifest().version,
  };
}

async function create(s: Secrets, password: string, replace?: boolean) {
  if ((await getVault()) && !replace) throw new Coded("exists", "A wallet is already saved in this browser.");
  if (password.length < MIN_PASSWORD) throw new Coded("weakPassword", `Use at least ${MIN_PASSWORD} characters.`);
  await lock();
  const { blob, key } = await seal(s, password);
  await local.remove(["history", "swaps", "sites", "scanned", "scannedV2"]);
  await local.set({ vault: blob });
  await setPrefs({ accounts: s.accounts.map(viewOf), activeId: s.accounts[0]?.id ?? null, hasPhrase: !!s.phrase, mints: {} });
  await begin(key, s);
}

function secretOf(account: Account): Uint8Array {
  if (!secrets) throw new Coded("locked", "Rings Wallet is locked.");
  if (account.kind === "hd") {
    if (!seed) throw new Coded("locked", "Rings Wallet is locked.");
    return accountSecret(seed, account.index);
  }
  return fromBase58(secrets.imported[account.index]);
}

async function activeAccount(touch = true): Promise<{ prefs: Prefs; account: Account }> {
  await need(touch);
  const prefs = await getPrefs();
  const id = prefs.activeId ?? secrets!.accounts[0]?.id;
  const account = secrets!.accounts.find((a) => a.id === id) ?? secrets!.accounts[0];
  if (!account) throw new Coded("noAccount", "No account yet.");
  return { prefs, account };
}

async function active(touch = true): Promise<{ ctx: Ctx; prefs: Prefs; account: Account }> {
  const { prefs, account } = await activeAccount(touch);
  return { ctx: ctxFor(prefs.network, secretOf(account)), prefs, account };
}

const isRows = (x: unknown): x is TokenRow[] =>
  Array.isArray(x) &&
  x.every((r: Partial<TokenRow> | null) => !!r && typeof r.mint === "string" && typeof r.units === "string" && /^\d+$/.test(r.units) && isDecimals(r.decimals) && typeof r.sym === "string" && typeof r.name === "string" && typeof r.amount === "number" && typeof r.price === "number");
const isDecimals = (d: unknown) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 255;
const isMints = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 500 && x.every((m) => typeof m === "string" && isPublicAddress(m));
const keptFor = (network: Network, account: Account) => `${network}:${account.address}`;

async function trackMint(network: Network, mint: string) {
  if (mint === SOL_MINT || mint === NETWORKS[network].usdc) return;
  const prefs = await getPrefs();
  const list = prefs.mints[network] ?? [];
  if (!list.includes(mint)) await setPrefs({ mints: { ...prefs.mints, [network]: [...list, mint].slice(-50) } });
}

/** One writer at a time for Activity and the swap list: concurrent read-modify-writes would lose entries. */
let writes: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = writes.then(fn, fn);
  writes = next.catch(() => undefined);
  return next;
}

const record = (item: Omit<HistoryItem, "id" | "at">): Promise<string> =>
  serial(async () => {
    const list = ((await local.get("history")).history as HistoryItem[] | undefined) ?? [];
    const entry: HistoryItem = { ...item, id: crypto.randomUUID(), at: Date.now() };
    await local.set({ history: [entry, ...list].slice(0, HISTORY_MAX) });
    return entry.id;
  });
const updateRecord = (id: string, change: Partial<HistoryItem>) =>
  serial(async () => {
    const list = ((await local.get("history")).history as HistoryItem[] | undefined) ?? [];
    await local.set({ history: list.map((h) => (h.id === id ? { ...h, ...change } : h)) });
  });

const symOf = (network: Network, mint: string) => (mint === SOL_MINT ? "SOL" : mint === NETWORKS[network].usdc ? "USDC" : `${mint.slice(0, 4)}…`);

/** Runs a send or move and records it in Activity; the row is saved "pending" once sent, in case the worker stops. */
async function act(ctx: Ctx, accountId: string, item: Pick<HistoryItem, "kind" | "balance" | "who">, mint: string, amount: string, run: (onSent: OnSent) => Promise<{ signature: string }>): Promise<Done> {
  const base = { network: ctx.network, account: accountId, ...item, amount, sym: symOf(ctx.network, mint) };
  let rowId: string | null = null;
  const onSent: OnSent = async (signature) => {
    if (rowId) await updateRecord(rowId, { signature });
    else rowId = await record({ ...base, status: "pending", signature });
  };
  try {
    const { signature } = await run(onSent);
    if (rowId) await updateRecord(rowId, { status: "done", signature, error: undefined });
    else await record({ ...base, status: "done", signature });
    return { signature, url: NETWORKS[ctx.network].explorerTx(signature) };
  } catch (e) {
    // Anything that fails after sending may still land: "pending", never "failed", or a retry would pay twice.
    if (e instanceof MaybeSent) {
      if (rowId) await updateRecord(rowId, { status: "pending", signature: e.signature, error: describeError(e) });
      else await record({ ...base, status: "pending", signature: e.signature, error: describeError(e) });
    } else if (rowId) await updateRecord(rowId, { status: "pending", error: describeError(e) });
    else await record({ ...base, status: "failed", error: describeError(e) });
    throw e;
  }
}

async function amountIn(ctx: Ctx, mint: string, text: string | number): Promise<bigint> {
  let units: bigint;
  try {
    units = parseUnits(String(text), await decimalsOf(ctx.network, mint, ctx.epoch));
  } catch (e) {
    throw new Coded("badAmount", (e as Error).message);
  }
  if (units <= 0n) throw new Coded("badAmount", "Enter an amount.");
  return units;
}

async function withPassword<T>(password: string, fn: (s: Secrets, key: CryptoKey) => Promise<T>): Promise<T> {
  const blob = await getVault();
  if (!blob) throw new Coded("noWallet", "No wallet is saved in this browser yet.");
  let opened: { secrets: Secrets; key: CryptoKey };
  try {
    opened = await open(blob, password);
  } catch (e) {
    if (e instanceof WrongPassword) throw new Coded("wrongPassword", "Wrong password.");
    throw e;
  }
  return fn(opened.secrets, opened.key);
}

async function handle(msg: Request): Promise<unknown> {
  switch (msg.type) {
    case "state":
      return state();
    case "newPhrase":
      return newPhrase(12);
    case "create": {
      if (!isPhrase(msg.phrase)) throw new Coded("badPhrase", "That recovery phrase isn't valid.");
      const phrase = normalizePhrase(msg.phrase);
      const address = addressOf(accountSecret(phraseSeed(phrase), 0));
      await create({ phrase, imported: [], accounts: [{ id: "a0", name: "Account 1", kind: "hd", index: 0, address }], nextIndex: 1 }, msg.password, msg.replace);
      return state();
    }
    case "importKey": {
      let secret: Uint8Array;
      try {
        secret = parseSecretKey(msg.key);
      } catch (e) {
        throw new Coded("badKey", (e as Error).message);
      }
      const account: Account = { id: "i0", name: "Account 1", kind: "imported", index: 0, address: addressOf(secret) };
      await create({ phrase: null, imported: [base58(secret)], accounts: [account], nextIndex: 0 }, msg.password, msg.replace);
      secret.fill(0);
      return state();
    }
    case "unlock":
      await withPassword(msg.password, (s, key) => begin(key, s));
      await applyQueuedDisconnects().catch(() => undefined);
      void notifyAccounts();
      return state();
    case "lock":
      await lock();
      return state();
    case "revealPhrase":
      return withPassword(msg.password, async (s) => {
        if (!s.phrase) throw new Coded("noPhrase", "This wallet came from a private key, so it has no recovery phrase.");
        return s.phrase.split(" ");
      });
    case "setAutoLock":
      await setPrefs({ autoLockMin: LOCK_CHOICES.includes(msg.minutes) ? msg.minutes : 15 });
      if ((await unlocked()) && vaultKey) await remember(vaultKey);
      return state();
    case "setNetwork":
      await setPrefs({ network: networkOf(msg.network) });
      void notifyAccounts();
      return state();
    case "addAccount": {
      await need();
      if (!secrets!.phrase || !seed) throw new Coded("noPhrase", "New accounts come from a recovery phrase; this wallet came from a private key.");
      const index = secrets!.nextIndex;
      const account: Account = { id: `a${index}`, name: `Account ${secrets!.accounts.length + 1}`, kind: "hd", index, address: addressOf(accountSecret(seed, index)) };
      secrets = { ...secrets!, accounts: [...secrets!.accounts, account], nextIndex: index + 1 };
      await save();
      await setPrefs({ activeId: account.id });
      return state();
    }
    case "renameAccount": {
      await need();
      const name = msg.name.trim().slice(0, 32);
      if (!name) throw new Coded("badName", "Give the account a name.");
      secrets = { ...secrets!, accounts: secrets!.accounts.map((a) => (a.id === msg.id ? { ...a, name } : a)) };
      await save();
      return state();
    }
    case "setActive": {
      const prefs = await getPrefs();
      if (prefs.accounts.some((a) => a.id === msg.id)) await setPrefs({ activeId: msg.id });
      void notifyAccounts();
      return state();
    }
    case "approval":
      return approvalView(msg.id);
    case "approvalDecision":
      return decide(msg.id, { approve: !!msg.approve, addressChoice: msg.addressChoice === "fresh" ? "fresh" : "main", riskAccepted: !!msg.riskAccepted });
    case "openProduct": {
      // The wallet opened this tab itself, so the Rings site in it may connect in one tap.
      if (!PRODUCTS.includes(msg.product)) throw new Coded("badProduct", "No such Rings product.");
      const prefs = await getPrefs();
      const url = productUrl(prefs.network, msg.product);
      const tab = await chrome.tabs.create({ url });
      if (tab.id !== undefined) trustTab(tab.id, url);
      return null;
    }
    case "sites": {
      await need();
      const prefs = await getPrefs();
      const id = prefs.activeId ?? secrets!.accounts[0]?.id;
      if (!id) return [];
      // One balance at a time, with random gaps for fresh addresses, so the RPC can't link them to the main one.
      const list = await sitesOf(providerDeps, prefs.network, id);
      const out: (Awaited<ReturnType<typeof sitesOf>>[number] & { balance: string })[] = [];
      for (const [i, s] of list.entries()) {
        if (s.fresh && i > 0) await new Promise((r) => setTimeout(r, 1500 + (crypto.getRandomValues(new Uint8Array(1))[0] % 20) * 100));
        out.push({ ...s, balance: await rpc<{ value: number }>(prefs.network, "getBalance", [s.address, { commitment: "confirmed" }]).then((r) => formatUnits(BigInt(r.value), 9, 4), () => "") });
      }
      return out;
    }
    case "disconnectSite": {
      await need();
      const prefs = await getPrefs();
      const id = prefs.activeId ?? secrets!.accounts[0]?.id;
      if (id) await disconnectDomain(providerDeps, prefs.network, id, msg.domain);
      return id ? sitesOf(providerDeps, prefs.network, id) : [];
    }
    case "touch":
      await need(true);
      return null;
    case "privateAddress": {
      const { ctx } = await active(false);
      return privateAddressOf(ctx);
    }
    case "balances": {
      const at = kept.epoch(); // a lock during the reads voids these cache writes
      const { prefs, account } = await activeAccount(false);
      const rows = await publicBalances(prefs.network, account.address);
      const key = keptFor(prefs.network, account);
      void kept.put(`pub:${key}`, rows, at);
      void kept.put(`held:${key}`, rows.filter((r) => r.mint !== SOL_MINT).map((r) => r.mint), at);
      return rows;
    }
    case "privateBalances": {
      const at = kept.epoch();
      const { ctx, prefs, account } = await active(false);
      const net = NETWORKS[ctx.network];
      const key = keptFor(ctx.network, account);
      // Public mints only: asking their metadata here would show both lists together. The cached list is used when
      // present; only the first read after unlock waits for a fresh one.
      const lastHeld = await kept.get(`held:${key}`);
      const heldNow = publicMints(ctx.network, ctx.wallet).then(
        (list) => {
          void kept.put(`held:${key}`, list, at);
          return list;
        },
        () => [] as string[],
      );
      const held = isMints(lastHeld) ? lastHeld : await heldNow;
      const mints = [...new Set([net.usdc, ...(prefs.mints[ctx.network] ?? []), ...held])].filter((m) => m !== SOL_MINT).slice(0, 40);
      const units = await privateUnits(ctx, mints);
      const rows = await Promise.all([...units].filter(([mint, u]) => mint === SOL_MINT || u > 0n).map(async ([mint, u]) => row(mint, u, await decimalsOf(ctx.network, mint, at))));
      for (const [mint, u] of units) if (u > 0n) await trackMint(ctx.network, mint);
      await describe(ctx.network, rows, { privately: true });
      const view = { rows: sortRows(rows), address: await privateAddressOf(ctx) } satisfies PrivateView;
      void kept.put(`priv:${key}`, view, at);
      return view;
    }
    case "cachedBalances": {
      // Display only: every action re-reads live balances, so a Max based on these is refused at worst.
      const { prefs, account } = await activeAccount(false);
      const key = keptFor(prefs.network, account);
      const [pub, priv] = await Promise.all([kept.get(`pub:${key}`), kept.get<Partial<PrivateView>>(`priv:${key}`)]);
      return {
        balances: isRows(pub) ? pub : null,
        privateBalances: priv && isRows(priv.rows) && typeof priv.address === "string" ? { rows: priv.rows, address: priv.address } : null,
      } satisfies CachedBalances;
    }
    case "classify": {
      const { ctx } = await active();
      if (await parsePrivateAddress(ctx.network, msg.to)) return "private";
      return isPublicAddress(msg.to) ? "public" : "invalid";
    }
    case "send": {
      const { ctx, account } = await active();
      const units = await amountIn(ctx, msg.mint, msg.amount);
      // Computed here from the amount, never taken from the page.
      const fee = feeOf(units);
      const priv = await parsePrivateAddress(ctx.network, msg.to);
      if (!priv && !isPublicAddress(msg.to)) throw new Coded("badAddress", "That isn't a Solana address or a Rings private address.");
      const to = msg.to.trim();
      const item = { kind: "sent" as const, balance: msg.from, who: to };
      if (msg.from === "private") {
        return act(ctx, account.id, item, msg.mint, `-${msg.amount}`, (onSent) => (priv ? payPrivately(ctx, msg.mint, units, priv, onSent, fee) : withdrawTo(ctx, msg.mint, units, to, onSent, fee)));
      }
      return act(ctx, account.id, item, msg.mint, `-${msg.amount}`, (onSent) => (priv ? shield(ctx, msg.mint, units, priv, { onSent, fee }) : sendPublic(ctx, msg.mint, units, to, onSent, fee)));
    }
    case "move": {
      const { ctx, account } = await active();
      const units = await amountIn(ctx, msg.mint, msg.amount);
      const fee = feeOf(units);
      if (msg.direction === "toPrivate") {
        await trackMint(ctx.network, msg.mint);
        const topUp = !(await ringsPaysFees(ctx.network));
        return act(ctx, account.id, { kind: "madePrivate", balance: "private", who: null }, msg.mint, `+${msg.amount}`, (onSent) => shield(ctx, msg.mint, units, undefined, { topUp, onSent, fee }));
      }
      const to = (msg.to ?? "").trim() || ctx.wallet;
      if (!isPublicAddress(to)) throw new Coded("badAddress", "That isn't a Solana address.");
      return act(ctx, account.id, { kind: "madePublic", balance: "public", who: to }, msg.mint, `+${msg.amount}`, (onSent) => withdrawTo(ctx, msg.mint, units, to, onSent, fee));
    }
    case "history": {
      // Not awaited: the saved list returns at once and the popup's next poll sees the chain lookups.
      const { ctx, account } = await active(false);
      void refreshActivity(ctx.network, account, accountAddress(ctx));
      const list = ((await local.get("history")).history as HistoryItem[] | undefined) ?? [];
      return list.filter((h) => h.network === ctx.network && h.account === account.id);
    }
    case "swapQuote": {
      const { ctx } = await active();
      await privateCoinsCheck(ctx.network, msg.from ?? "private", msg.inMint, msg.outMint, msg.receiveInto !== "wallet" && msg.receiveInto !== "other");
      const units = await amountIn(ctx, msg.inMint, msg.amount);
      const slippageBps = clampSlippage(msg.slippageBps);
      const q = await quote(ctx.network, msg.inMint, msg.outMint, units, slippageBps);
      const outDecimals = await decimalsOf(ctx.network, msg.outMint, ctx.epoch);
      const deliver = msg.receiveInto === "wallet" || msg.receiveInto === "other" ? ("wallet" as const) : ("private" as const);
      const to = msg.receiveInto === "other" && isPublicAddress((msg.to ?? "").trim()) ? (msg.to ?? "").trim() : msg.receiveInto === "wallet" ? ctx.wallet : null;
      // Rings' cost figure, capped at the route's own formula ceiling. No figure, no quote.
      const asked = await swapCosts(ctx, { inMint: msg.inMint, outMint: msg.outMint, amount: units, slippageBps, deliver, to, accounts: q.accounts }).catch(() => null);
      if (asked === null) throw new Coded("noCosts", "Rings couldn't work out this swap's network costs right now. Try again in a moment.");
      const ceiling = costsCeilingOf({ inMint: msg.inMint, outMint: msg.outMint, deliver }, q.accounts);
      const costs: bigint | null = asked < ceiling ? asked : ceiling;
      let shortfall: Shortfall | null = null;
      const fee = feeOf(units);
      const txs = msg.inMint === SOL_MINT ? 1 : 2;
      if (msg.from === "private" && costs !== null) {
        const want = new Map<string, bigint>(msg.inMint === SOL_MINT ? [[SOL_MINT, units + fee + costs]] : [[msg.inMint, units + fee], [SOL_MINT, costs]]);
        shortfall = await shortfallFor(ctx, want, txs).catch(() => null);
      }
      const fromPublic = msg.from === "public";
      const swapFees = await feesView(ctx, msg.inMint, {
        fee,
        network: BigInt(txs) * PRIVATE_TX_FEE + (fromPublic ? BigInt(txs) * PUBLIC_TX_FEE : 0n),
        payer: fromPublic ? "both" : "account",
        openRent: 0n,
        float: 0n,
        topUp: fromPublic ? 0n : await feeTopUpFor(ctx, txs).catch(() => 0n),
      });
      return {
        ...swapFees,
        out: formatUnits(BigInt(q.outAmount), outDecimals),
        minOut: formatUnits(BigInt(q.minOut), outDecimals),
        impactPct: Number(q.impact.toFixed(2)),
        route: q.route,
        costs: costs === null ? "" : `${formatUnits(costs, 9, 4)} SOL`,
        shortfall,
        minOutUnits: q.minOut,
        costsUnits: costs === null ? undefined : costs.toString(),
      } satisfies SwapQuoteView;
    }
    case "shortfall": {
      const { ctx } = await active();
      const units = await amountIn(ctx, msg.mint, msg.amount);
      return shortfallFor(ctx, new Map([[msg.mint, units + feeOf(units)]]));
    }
    case "reviewCosts": {
      // Must pick the same route as "send" and "move" do.
      const { ctx } = await active();
      const units = await amountIn(ctx, msg.mint, msg.amount);
      const to = (msg.to ?? "").trim();
      let route: Route;
      if (msg.flow === "send") {
        const priv = await parsePrivateAddress(ctx.network, to);
        if (!priv && !isPublicAddress(to)) throw new Coded("badAddress", "That isn't a Solana address or a Rings private address.");
        route = msg.from === "private" ? (priv ? "privateToPrivate" : "privateToPublic") : priv ? "publicToPrivate" : "publicToPublic";
      } else route = msg.direction === "toPrivate" ? "ownDeposit" : "privateToPublic";
      const dest = msg.flow === "move" ? to || ctx.wallet : to;
      return feesView(ctx, msg.mint, await costsOf(ctx, route, msg.mint, units, route === "publicToPublic" || route === "privateToPublic" ? dest : null));
    }
    case "topUp": {
      const { ctx, account } = await active();
      const needs = parseNeeds(msg.needs);
      const before = await privateUnits(ctx, needs.filter((n) => n.mint !== SOL_MINT).map((n) => n.mint));
      await moveToPrivate(ctx, account.id, needs);
      return { target: needs.map((n) => ({ mint: n.mint, units: ((before.get(n.mint) ?? 0n) + n.units).toString() })) };
    }
    case "privateHas": {
      const { ctx } = await active(false);
      const target = parseNeeds(msg.target);
      const now = await privateUnits(ctx, target.filter((t) => t.mint !== SOL_MINT).map((t) => t.mint));
      return target.every((t) => (now.get(t.mint) ?? 0n) >= t.units);
    }
    case "swap": {
      const { ctx, account } = await active();
      const slippageBps = clampSlippage(msg.slippageBps);
      const units = await amountIn(ctx, msg.inMint, msg.amount);
      const deliver = msg.receiveInto === "private" ? "private" : "wallet";
      const to = msg.receiveInto === "other" ? (msg.to ?? "").trim() : msg.receiveInto === "wallet" ? ctx.wallet : null;
      if (msg.receiveInto === "other" && !isPublicAddress(to ?? "")) throw new Coded("badAddress", "That isn't a Solana address.");
      await privateCoinsCheck(ctx.network, msg.from, msg.inMint, msg.outMint, deliver === "private");
      const q = await quote(ctx.network, msg.inMint, msg.outMint, units, slippageBps);
      // The fresh quote must be no worse than the one shown: minimum out, price impact tier and costs.
      const reviewed = msg.reviewed;
      if (reviewed) {
        if (!/^\d{1,30}$/.test(reviewed.minOutUnits) || !/^\d{1,20}$/.test(reviewed.costsUnits)) throw new Coded("requote", "Review the swap again.");
        if (BigInt(q.minOut) < BigInt(reviewed.minOutUnits)) throw new Coded("requote", "The price moved since you reviewed this swap: check the new quote.");
        const tier = (pct: number) => (pct >= 15 ? 3 : pct >= 5 ? 2 : pct >= 1 ? 1 : 0);
        if (tier(q.impact) > tier(Number(reviewed.impactPct) || 0)) throw new Coded("requote", "The price impact grew since you reviewed this swap: check the new quote.");
      }
      const minOut = reviewed && BigInt(reviewed.minOutUnits) > BigInt(q.minOut) ? reviewed.minOutUnits : q.minOut;
      const ask = { inMint: msg.inMint, outMint: msg.outMint, amount: units, quote: { ...q, minOut }, slippageBps, deliver, to } as const;
      const asked = await swapCosts(ctx, { ...ask, accounts: q.accounts });
      const ceiling = costsCeilingOf({ inMint: msg.inMint, outMint: msg.outMint, deliver }, q.accounts);
      const costs = asked < ceiling ? asked : ceiling;
      if (reviewed && costs > BigInt(reviewed.costsUnits) + BigInt(reviewed.costsUnits) / 10n + 100_000n) throw new Coded("requote", "The network costs went up since you reviewed this swap: check the new quote.");
      const fee = feeOf(units);
      // A token swap pays the coin and the SOL costs in separate transactions.
      const txs = msg.inMint === SOL_MINT ? 1 : 2;
      // From Public: deposit the amount plus fee first; the deposits take no fee of their own.
      const funded = msg.from === "public" ? await fundPrivately(ctx, account.id, msg.inMint, units + fee, costs, txs) : [];
      await trackMint(ctx.network, msg.inMint);
      await trackMint(ctx.network, msg.outMint);
      const outSym = await symOfAny(ctx.network, msg.outMint);
      const outDecimals = await decimalsOf(ctx.network, msg.outMint, ctx.epoch);
      const balance = deliver === "private" ? ("private" as const) : ("public" as const);
      // Pay only if still signed in as this account: another account or a rings.run tab may sign in meanwhile.
      const { result: made, same } = await withSession(ctx, () => createSwap(ctx, ask));
      if (!same) throw new Coded("requote", "Review the swap again.");
      checkPayments(made.payments, msg.inMint, units, costs);
      // Check every coin first: a shortfall after the first payment would strand it with Rings.
      const have = await privateUnits(ctx, msg.inMint === SOL_MINT ? [] : [msg.inMint]);
      const wants = new Map<string, bigint>([[msg.inMint, fee]]);
      for (const p of made.payments) wants.set(p.mint, (wants.get(p.mint) ?? 0n) + BigInt(p.amount));
      for (const [mint, want] of wants) {
        if ((have.get(mint) ?? 0n) < want) {
          const need = formatUnits(want, await decimalsOf(ctx.network, mint, ctx.epoch));
          throw new Coded("short", `The swap needs ${need} ${mint === SOL_MINT ? "SOL" : await symOfAny(ctx.network, mint)} in your private balance, network costs included.`);
        }
      }
      // Fee SOL for every payment up front, or the first could be stranded. After the balance check, so an unpayable
      // swap never tops the account key up from Public (a public link).
      await ensureFeesFor(ctx, Math.max(txs, made.payments.length));
      // Saved first, so the follower can finish the swap whatever happens next.
      const pending: PendingSwap = {
        id: made.id,
        network: ctx.network,
        account: account.id,
        outMint: msg.outMint,
        outSym,
        outDecimals,
        balance,
        at: Date.now(),
        payments: made.payments.length,
        paid: [],
        deliverTo: deliverToOf(ctx),
        to: deliver === "wallet" ? (to ?? ctx.wallet) : null,
        funded,
      };
      await serial(async () => local.set({ swaps: [pending, ...(await getSwaps())].slice(0, 50) }));
      await chrome.alarms.create(SWAPS_ALARM, { periodInMinutes: 0.5 });
      let paid: Payment[];
      try {
        paid = await paySwap(ctx, made, { inMint: msg.inMint, units, maxCosts: costs, fee }, (p) => updateSwap(made.id, { paid: p }));
      } catch (e) {
        const sent = (await getSwaps()).find((x) => x.id === made.id)?.paid ?? [];
        if (sent.length) {
          // Every payment went out (or may have): the follower finishes it; a retry would pay twice.
          if (sent.length >= made.payments.length || e instanceof MaybeSent) return { id: made.id };
          // A later payment surely never went out and Rings needs full payment: report the stranded one at once.
          await serial(async () => local.set({ swaps: (await getSwaps()).filter((x) => x.id !== made.id) }));
          const error = `${describeError(e)} Your payment reached Rings: contact Rings with this transaction to get it back.`;
          await record({ network: ctx.network, account: account.id, kind: "swapped", balance, who: null, amount: "", sym: outSym, status: "failed", signature: sent[0].signature, linked: sent.slice(1).map((x) => x.signature), error });
          throw new Error(error);
        }
        await serial(async () => local.set({ swaps: (await getSwaps()).filter((x) => x.id !== made.id) }));
        await record({ network: ctx.network, account: account.id, kind: "swapped", balance, who: null, amount: "", sym: outSym, status: "failed", error: describeError(e) });
        throw e;
      }
      // The follower retries if Rings doesn't see the payments yet.
      await tellPaid(ctx.network, made.id, paid).catch(() => undefined);
      return { id: made.id };
    }
    case "swapStatus":
      return follow(msg.id);
    case "searchTokens": {
      const prefs = await getPrefs();
      return searchTokens(prefs.network, msg.query);
    }
  }
}

const SWAPS_ALARM = "swaps";

interface PendingSwap {
  id: string;
  network: Network;
  account: string;
  outMint: string;
  outSym: string;
  outDecimals: number;
  balance: "public" | "private";
  at: number;
  /** Payments Rings asked for, and those made so far (slot "0": sent, landing unknown). */
  payments?: number;
  paid?: Payment[];
  deliverTo?: string;
  to?: string | null;
  /** Rings' single-use key for this swap; its public delivery comes from this key. */
  swapKey?: string | null;
  funded?: string[];
}

/** Saved swaps, validated on read: storage is editable outside the wallet, and a record decides where coins go. */
const getSwaps = async (): Promise<PendingSwap[]> => {
  const list = (await local.get("swaps")).swaps;
  if (!Array.isArray(list)) return [];
  const sig = (x: unknown) => typeof x === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(x);
  return (list as PendingSwap[]).filter(
    (p) =>
      p &&
      typeof p.id === "string" &&
      /^[A-Za-z0-9_-]{6,80}$/.test(p.id) &&
      p.network === networkOf(p.network) &&
      typeof p.account === "string" &&
      (p.paid === undefined || (Array.isArray(p.paid) && p.paid.length <= 2 && p.paid.every((x) => sig(x?.signature) && /^\d{1,20}$/.test(String(x?.slot))))) &&
      (p.deliverTo === undefined || (typeof p.deliverTo === "string" && p.deliverTo.length < 400)) &&
      (p.to === undefined || p.to === null || isPublicAddress(p.to)) &&
      (p.funded === undefined || (Array.isArray(p.funded) && p.funded.every(sig))),
  );
};
const updateSwap = (id: string, change: Partial<PendingSwap>) =>
  serial(async () => local.set({ swaps: (await getSwaps()).map((s) => (s.id === id ? { ...s, ...change } : s)) }));

/** Re-reports a fully paid swap Rings still has as unpaid, once every payment has landed. */
async function resumePaid(p: PendingSwap): Promise<{ ok?: boolean; state?: string } | undefined> {
  const paid = p.paid ?? [];
  if (!p.payments || paid.length !== p.payments) return;
  const unknown = paid.filter((x) => x.slot === "0");
  if (unknown.length) {
    const { value } = await rpc<{ value: ({ slot: number; err: unknown; confirmationStatus?: string } | null)[] }>(p.network, "getSignatureStatuses", [unknown.map((x) => x.signature), { searchTransactionHistory: true }]);
    if (value.some((v) => !v || v.err || v.confirmationStatus === "processed")) return;
    const slots = new Map(unknown.map((x, i) => [x.signature, String(value[i]!.slot)]));
    const filled = paid.map((x) => ({ ...x, slot: slots.get(x.signature) ?? x.slot }));
    await updateSwap(p.id, { paid: filled });
    return tellPaid(p.network, p.id, filled, 1);
  }
  return tellPaid(p.network, p.id, paid, 1);
}
const clampSlippage = (bps: number) => Math.min(5000, Math.max(1, Math.round(Number(bps) || 50)));

/** Refuses coins a private balance can't hold: swaps are paid privately, and a private delivery would never arrive. */
async function privateCoinsCheck(network: Network, from: string, inMint: string, outMint: string, intoPrivate: boolean) {
  if (from === "public") await assertCanGoPrivate(network, inMint).catch((e: Error) => {
    throw new Coded("cantBePrivate", `${e.message} Swaps are paid from the private balance, so it can't be swapped here.`);
  });
  if (intoPrivate) await assertCanGoPrivate(network, outMint).catch((e: Error) => {
    throw new Coded("cantBePrivate", `${e.message} Choose Public as where it goes.`);
  });
}

async function feesView(ctx: Ctx, mint: string, c: ActionCosts): Promise<FeesView> {
  const sol = (lamports: bigint, frac = 9) => `${formatUnits(lamports, 9, frac)} SOL`;
  const decimals = await decimalsOf(ctx.network, mint, ctx.epoch);
  const notes: string[] = [];
  if (c.payer === "account") notes.push(c.topUp > 0n ? `From your Rings account, topped up with ${sol(c.topUp, 4)} from Public` : "From your Rings account");
  if (c.payer === "both") notes.push("From your Public balance and your Rings account");
  if (c.openRent > 0n) notes.push(`+ about ${sol(c.openRent, 5)} to open the receiving account for this coin`);
  if (c.float > 0n) notes.push(`+ ${sol(c.float, 4)} into your Rings account, for private fees`);
  return {
    ringsFee: c.fee > 0n ? `${formatUnits(c.fee, decimals, decimals)} ${mint === SOL_MINT ? "SOL" : await symOfAny(ctx.network, mint)}` : "",
    networkFee: sol(c.network),
    networkFeeNote: notes.join(" · "),
  };
}

async function symOfAny(network: Network, mint: string): Promise<string> {
  const r = [row(mint, 0n, 0)];
  await describe(network, r).catch(() => undefined);
  return r[0].sym;
}

/** Moves only the shortfall from Public to Private, all or nothing, then waits until the private balance shows it. */
async function fundPrivately(ctx: Ctx, accountId: string, mint: string, units: bigint, costs: bigint, txs = 1): Promise<string[]> {
  const want = new Map<string, bigint>(mint === SOL_MINT ? [[SOL_MINT, units + costs]] : [[mint, units], [SOL_MINT, costs]]);
  const short = await shortfallFor(ctx, want, txs);
  if (!short) return [];
  if (!short.publicOk) throw new Coded("publicShort", `Your Public balance can't pay for this swap: it needs ${short.label} moved to Private, network costs included. Nothing was moved.`);
  const needs = short.needs.map((n) => ({ mint: n.mint, units: BigInt(n.units) }));
  const mints = mint === SOL_MINT ? [] : [mint];
  const before = await privateUnits(ctx, mints);
  const sigs = await moveToPrivate(ctx, accountId, needs);
  // Each check syncs the private balance through the rate-limited proxy: keep polling slow.
  for (let i = 0; i < 24; i++) {
    const now = await privateUnits(ctx, mints);
    if (needs.every((n) => (now.get(n.mint) ?? 0n) >= (before.get(n.mint) ?? 0n) + n.units)) return sigs;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Your private balance is taking long to show the deposit. It's there: try the swap again from Private.");
}

/** Extra lamports on a SOL top-up, so one top-up survives small cost changes. */
const TOP_UP_BUFFER = 1_000_000n;

async function shortfallFor(ctx: Ctx, want: Map<string, bigint>, txs = 1): Promise<Shortfall | null> {
  const have = await privateUnits(ctx, [...want.keys()].filter((m) => m !== SOL_MINT));
  const needs: { mint: string; units: bigint }[] = [];
  for (const [mint, units] of want) {
    const h = have.get(mint) ?? 0n;
    if (units > h) needs.push({ mint, units: units - h });
  }
  if (!needs.length) return null;
  const pub = new Map((await publicBalances(ctx.network, ctx.wallet)).map((r) => [r.mint, BigInt(r.units)]));
  // Public also covers each deposit's fee, its own rent-exempt minimum and, when the account key can't pay `txs`
  // fees, a fee float. What's left pays the SOL buffer, up to its full size.
  const accountEmpty = !(await ringsPaysFees(ctx.network)) && !canPayFees(await accountLamports(ctx), txs);
  const sol = needs.find((n) => n.mint === SOL_MINT);
  const spare = (pub.get(SOL_MINT) ?? 0n) - (sol?.units ?? 0n) - 50_000n * BigInt(needs.length) - RENT_KEEP - (accountEmpty ? TINY_FEE_FLOAT : 0n);
  if (sol && spare > 0n) sol.units += spare >= TOP_UP_BUFFER ? TOP_UP_BUFFER : spare;
  const publicOk = spare >= 0n && needs.every((n) => n.mint === SOL_MINT || (pub.get(n.mint) ?? 0n) >= n.units);
  const parts: string[] = [];
  for (const n of needs) parts.push(`${formatUnits(n.units, await decimalsOf(ctx.network, n.mint, ctx.epoch), 4)} ${n.mint === SOL_MINT ? "SOL" : await symOfAny(ctx.network, n.mint)}`);
  return { label: parts.join(" + "), needs: needs.map((n) => ({ mint: n.mint, units: n.units.toString() })), publicOk };
}

/** Deposits each coin from Public to Private, one Activity row each; the first also tops up the fee float. */
async function moveToPrivate(ctx: Ctx, accountId: string, needs: { mint: string; units: bigint }[]): Promise<string[]> {
  const topUp = !(await ringsPaysFees(ctx.network));
  const sigs: string[] = [];
  for (const [i, n] of needs.entries()) {
    await trackMint(ctx.network, n.mint);
    const shown = formatUnits(n.units, await decimalsOf(ctx.network, n.mint, ctx.epoch));
    // Leave the SOL the later deposits need, so the first one's fee float can't spend it.
    const reserve = needs.slice(i + 1).reduce((sum, later) => sum + (later.mint === SOL_MINT ? later.units : 0n) + 20_000n, 0n);
    const done = await act(ctx, accountId, { kind: "madePrivate", balance: "private", who: null }, n.mint, `+${shown}`, (onSent) => shield(ctx, n.mint, n.units, undefined, { topUp: topUp && i === 0, reserve, onSent }));
    sigs.push(done.signature);
  }
  return sigs;
}

/** Validates amounts from a page: 1 to 3 coins, real mints, positive whole units. */
function parseNeeds(list: unknown): { mint: string; units: bigint }[] {
  if (!Array.isArray(list) || list.length === 0 || list.length > 3) throw new Coded("badTopUp", "Nothing to top up.");
  return list.map((x: { mint?: unknown; units?: unknown }) => {
    const mint = String(x?.mint ?? "");
    const units = String(x?.units ?? "");
    if ((mint !== SOL_MINT && !isPublicAddress(mint)) || !/^\d{1,20}$/.test(units) || BigInt(units) <= 0n) throw new Coded("badTopUp", "Nothing to top up.");
    return { mint, units: BigInt(units) };
  });
}

async function landedPayments(network: Network, paid: Payment[]): Promise<string[]> {
  const { value } = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>(network, "getSignatureStatuses", [paid.map((x) => x.signature), { searchTransactionHistory: true }]);
  return paid.filter((_, i) => value[i] && !value[i]!.err && value[i]!.confirmationStatus !== "processed").map((x) => x.signature);
}

/** A swap's progress from Rings; records a finished swap in Activity once. Needs no keys, so works while locked. */
async function follow(id: string): Promise<SwapView> {
  const pending = (await getSwaps()).find((s) => s.id === id);
  const network = pending?.network ?? (await getPrefs()).network;
  let s: SwapState = await swapStatus(network, id);
  // Rings' 10-minute cleanup marks an unpaid swap failed with exactly this error.
  const expired = s.state === "failed" && s.error === "Not paid in time." && !s.swapSig;
  let refused = false;
  // For a closed swap, the payments that actually landed; null when the chain couldn't be asked.
  let landed: string[] | null = null;
  if ((s.state === "quoted" || expired) && pending?.paid?.length) {
    if (expired) landed = await landedPayments(network, pending.paid).catch(() => null);
    // Rings takes only full payment, within 10 minutes: a closed swap with a payment missing on chain is final.
    if (expired && landed && landed.length < (pending.payments ?? pending.paid.length)) refused = true;
    else
      await resumePaid(pending).then(
        async (answer) => {
          // For a swap its cleanup closed, Rings answers "paid" with the final state: treat it as refused.
          if (expired && answer?.state === "failed") refused = true;
          s = await swapStatus(network, id);
        },
        // 400/404/410/422 are final; no answer, 409 (payment not seen yet), 429 or 5xx are retried next time.
        (e: unknown) => {
          const status = (e as { status?: number }).status;
          refused = expired && status !== undefined && [400, 404, 410, 422].includes(status);
        },
      );
  }
  // Paid but marked unpaid: keep following and re-reporting it for up to a day.
  const stillLate = s.state === "failed" && s.error === "Not paid in time." && !s.swapSig && !refused && !!pending?.paid?.length && Date.now() - pending.at < 86_400_000;
  const step: 1 | 2 | 3 = s.state === "quoted" || stillLate ? 1 : s.state === "paid" || s.state === "funded" ? 2 : 3;
  const finished = s.state === "done" || s.state === "delivered" ? "done" : s.state === "refunded" || (s.state === "failed" && !stillLate) ? "failed" : null;
  const out = s.outAmount && pending ? formatUnits(BigInt(s.outAmount), pending.outDecimals) : undefined;
  const url = s.swapSig ? NETWORKS[network].explorerTx(s.swapSig) : undefined;
  // Paid but abandoned by Rings: the landed payments' signatures are what gets the money back.
  const stranded = finished === "failed" && !s.swapSig && pending?.paid?.length ? (landed ?? pending.paid.map((x) => x.signature)) : [];
  const strandedPayment = stranded[0];
  const error =
    s.state === "refunded"
      ? "Rings couldn't make the swap and refunded your private balance."
      : strandedPayment
        ? `${s.error ?? "Rings didn't take the swap."} Your payment reached Rings: contact Rings with this transaction to get it back.`
        : (s.error ?? null);
  if (finished && pending) {
    // Recorded once: the popup and the alarm may both see it finish.
    const first = await serial(async () => {
      const list = await getSwaps();
      if (!list.some((x) => x.id === id)) return false;
      await local.set({ swaps: list.filter((x) => x.id !== id) });
      return true;
    });
    if (first) {
      await record({
        network,
        account: pending.account,
        kind: "swapped",
        balance: pending.balance,
        who: null,
        amount: out ? `+${out}` : "",
        sym: pending.outSym,
        status: finished,
        signature: s.swapSig ?? strandedPayment,
        // Folded into this row: the public delivery, the funding deposits of a completed swap (a failed one keeps them
        // as rows) and the stranded payments after the first.
        linked: [
          ...(s.deliverSig ? [s.deliverSig] : []),
          ...(finished === "done" ? (pending.funded ?? []) : []),
          ...stranded.slice(1),
        ],
        error: error ?? undefined,
      });
      const folded = new Set<string>([...(finished === "done" ? (pending.funded ?? []) : [])]);
      if (s.deliverSig || folded.size) {
        await serial(async () => {
          const now = ((await local.get("history")).history as HistoryItem[] | undefined) ?? [];
          const drop = (h: HistoryItem) => (h.kind === "received" && h.signature === s.deliverSig) || (h.kind === "madePrivate" && !!h.signature && folded.has(h.signature));
          if (now.some(drop)) await local.set({ history: now.filter((h) => !drop(h)) });
        });
      }
    }
  } else if (pending && s.swapKey && pending.swapKey !== s.swapKey) {
    await updateSwap(id, { swapKey: s.swapKey });
  }
  return { state: s.state, step, finished, error, out, url };
}

/** Incoming SOL below this many lamports is hidden: dust from look-alike addresses is a phishing trick. */
const RECEIVED_SOL_MIN = 1_000_000n;

/** Adds chain activity of the public address to Activity: incoming payments and txs signed on websites. */
async function scanReceived(network: Network, account: Account, ringsAccount?: string) {
  const owner = account.address;
  const key = `${network}:${account.id}`;
  const scanned = ((await local.get("scannedV2")).scannedV2 as Record<string, string[]> | undefined) ?? {};
  const seen = new Set(scanned[key] ?? []);
  const sigs = await rpc<{ signature: string; err: unknown }[]>(network, "getSignaturesForAddress", [owner, { limit: 20, commitment: "confirmed" }]);
  const history = ((await local.get("history")).history as HistoryItem[] | undefined) ?? [];
  const known = new Set(history.flatMap((h) => [h.signature, ...(h.linked ?? [])]).filter(Boolean));
  const swapKeys = new Set((await getSwaps()).map((s) => s.swapKey).filter(Boolean));
  const fresh = sigs.filter((s) => !s.err && !seen.has(s.signature) && !known.has(s.signature)).slice(0, 10);
  if (!fresh.length) return;
  const found: HistoryItem[] = [];
  const txs = await Promise.all(
    fresh.map((s) => rpc<ParsedTx | null>(network, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]).catch(() => undefined)),
  );
  for (const [n, s] of fresh.entries()) {
    const tx = txs[n];
    if (tx === undefined) continue; // lookup failed: retried next scan
    seen.add(s.signature);
    if (!tx?.meta || tx.meta.err) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
    const from = keys[0];
    const at = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
    if (from === owner) {
      // Signed by this account outside the wallet's own screens: a swap or payment made on a website.
      const e = ownTxEffect(tx, owner, ringsAccount);
      if (e) {
        found.push({
          id: crypto.randomUUID(),
          network,
          account: account.id,
          kind: e.kind,
          balance: "public",
          who: e.who,
          amount: `${e.kind === "sent" ? "-" : "+"}${formatUnits(e.units, e.decimals)}`,
          sym: e.mint === SOL_MINT ? "SOL" : await symOfAny(network, e.mint),
          status: "done",
          signature: s.signature,
          at,
        });
      }
      continue;
    }
    if (swapKeys.has(from)) continue;
    const base = { network, account: account.id, kind: "received" as const, balance: "public" as const, who: from, status: "done" as const, signature: s.signature, at };
    const i = keys.indexOf(owner);
    const sol = i >= 0 ? BigInt(tx.meta.postBalances[i] ?? 0) - BigInt(tx.meta.preBalances[i] ?? 0) : 0n;
    if (sol >= RECEIVED_SOL_MIN) found.push({ ...base, id: crypto.randomUUID(), amount: `+${formatUnits(sol, 9)}`, sym: "SOL" });
    for (const post of tx.meta.postTokenBalances ?? []) {
      if (post.owner !== owner) continue;
      const pre = (tx.meta.preTokenBalances ?? []).find((p) => p.accountIndex === post.accountIndex);
      const units = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? "0");
      if (units <= 0n) continue;
      found.push({ ...base, id: crypto.randomUUID(), amount: `+${formatUnits(units, post.uiTokenAmount.decimals)}`, sym: await symOfAny(network, post.mint) });
    }
  }
  await serial(async () => {
    const now = ((await local.get("history")).history as HistoryItem[] | undefined) ?? [];
    const have = new Set(now.map((h) => `${h.signature}|${h.sym}`));
    const add = found.filter((f) => !have.has(`${f.signature}|${f.sym}`));
    const all = ((await local.get("scannedV2")).scannedV2 as Record<string, string[]> | undefined) ?? {};
    await local.set({
      history: [...add, ...now].sort((a, b) => b.at - a.at).slice(0, HISTORY_MAX),
      scannedV2: { ...all, [key]: [...seen].slice(-200) },
    });
  });
}

/** Activity's chain lookups for one account: one at a time and throttled, as the RPC proxy is rate-limited. */
const activityLooks = new Map<string, { at: number; running: Promise<void> | null }>();
function refreshActivity(network: Network, account: Account, ringsAccount?: string): Promise<void> {
  const key = `${network}:${account.id}`;
  const look = activityLooks.get(key) ?? { at: 0, running: null };
  if (look.running) return look.running;
  if (Date.now() - look.at < 30_000) return Promise.resolve();
  look.at = Date.now();
  look.running = Promise.all([settlePending(network).catch(() => undefined), scanReceived(network, account, ringsAccount).catch(() => undefined)])
    .then(() => undefined)
    .finally(() => (look.running = null));
  activityLooks.set(key, look);
  return look.running;
}

async function settlePending(network: Network) {
  const list = ((await local.get("history")).history as HistoryItem[] | undefined) ?? [];
  const open = list.filter((h) => h.status === "pending" && h.signature && h.network === network).slice(0, 50);
  if (!open.length) return;
  const { value } = await rpc<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>(network, "getSignatureStatuses", [open.map((h) => h.signature), { searchTransactionHistory: true }]);
  const outcome = new Map<string, "done" | "failed">();
  open.forEach((h, i) => {
    const st = value[i];
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) outcome.set(h.id, st.err ? "failed" : "done");
    else if (!st && Date.now() - h.at > 10 * 60_000) outcome.set(h.id, "failed"); // unknown long after its blockhash expired
  });
  if (!outcome.size) return;
  await serial(async () => {
    const now = ((await local.get("history")).history as HistoryItem[] | undefined) ?? [];
    await local.set({ history: now.map((h) => (outcome.has(h.id) ? { ...h, status: outcome.get(h.id)! } : h)) });
  });
}

async function followAll() {
  const list = await getSwaps();
  if (!list.length) return void chrome.alarms.clear(SWAPS_ALARM);
  for (const s of list) {
    // Dropped after a day; if it paid anything, a failed row keeps the payment so it can be claimed.
    if (Date.now() - s.at > 86_400_000) {
      await serial(async () => local.set({ swaps: (await getSwaps()).filter((x) => x.id !== s.id) }));
      if (s.paid?.length) {
        const landed = await landedPayments(s.network, s.paid).catch(() => s.paid!.map((x) => x.signature));
        await record({
          network: s.network,
          account: s.account,
          kind: "swapped",
          balance: s.balance,
          who: null,
          amount: "",
          sym: s.outSym,
          status: "failed",
          signature: landed[0] ?? s.paid[0].signature,
          linked: landed.slice(1),
          error: landed.length ? "Rings never took this swap. Your payment reached Rings: contact Rings with this transaction to get it back." : "Rings never took this swap.",
        });
      }
      continue;
    }
    await follow(s.id).catch(() => undefined);
  }
}

async function searchTokens(network: Network, query: string): Promise<TokenOption[]> {
  const q = query.trim();
  let mints: string[];
  if (!q) mints = buyList(network);
  else if (isPublicAddress(q)) mints = [q];
  else if (network === "devnet") {
    const t = q.toLowerCase();
    mints = buyList(network).filter((m) => m === SOL_MINT ? "sol solana".includes(t) : `${DEVNET_ALIASES[m]?.sym} ${DEVNET_ALIASES[m]?.name}`.toLowerCase().includes(t));
  } else {
    const found = (await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .catch(() => [])) as { id: string }[];
    mints = (Array.isArray(found) ? found : []).slice(0, 20).map((t) => (t.id === "So11111111111111111111111111111111111111112" ? SOL_MINT : t.id));
  }
  const rows = mints.map((m) => row(m, 0n, 0));
  await describe(network, rows).catch(() => undefined);
  return rows.map((r) => ({ mint: r.mint, sym: r.sym, name: r.name, icon: r.icon ?? null, price: r.price }));
}

// Website connections (Wallet Standard). None of these push the auto-lock back; only the wallet's own pages do.
async function mustBeUnlocked() {
  if (!(await unlocked()) || !secrets) throw new Coded("locked", "Rings Wallet is locked.");
}
const providerDeps: ProviderDeps = {
  network: async () => (await getPrefs()).network,
  unlocked: () => unlocked(),
  active: async () => {
    await mustBeUnlocked();
    const prefs = await getPrefs();
    const id = prefs.activeId ?? secrets!.accounts[0]?.id;
    const account = secrets!.accounts.find((a) => a.id === id) ?? secrets!.accounts[0];
    if (!account) throw new Coded("noAccount", "No account yet.");
    return { id: account.id, name: account.name, secret: secretOf(account), address: account.address };
  },
  secretOf: async (accountId: string) => {
    await mustBeUnlocked();
    const account = secrets!.accounts.find((a) => a.id === accountId);
    if (!account) throw new Coded("noAccount", "That account is gone.");
    return secretOf(account);
  },
  // Kept in the encrypted vault: which address each site sees is private.
  getSites: async () => ((await unlocked()) && secrets ? structuredClone(secrets.sites ?? {}) : {}),
  updateSites: async (change) => {
    await mustBeUnlocked();
    // No await between read and write, so two sites connecting at once can't undo each other.
    const sites = structuredClone(secrets!.sites ?? {});
    change(sites);
    secrets = { ...secrets!, sites };
    await save();
  },
};
startProvider(providerDeps);

/** The extension's own pages only: content scripts send the same id but the web page's URL. */
const fromOwnPage = (sender: chrome.runtime.MessageSender) =>
  sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));

/** Requests that move money keep the worker awake until done, even if the popup closes. */
const MONEY = new Set<Request["type"]>(["send", "move", "topUp", "swap"]);
async function keptAwake<T>(run: () => Promise<T>): Promise<T> {
  const t = setInterval(() => void chrome.runtime.getPlatformInfo?.().catch(() => undefined), 20_000);
  try {
    return await run();
  } finally {
    clearInterval(t);
  }
}

chrome.runtime.onMessage.addListener((msg: Request, sender, sendResponse: (r: Reply) => void) => {
  if (!fromOwnPage(sender)) return false;
  (MONEY.has(msg?.type) ? keptAwake(() => handle(msg)) : handle(msg)).then(
    (data) => sendResponse({ ok: true, data }),
    (e: unknown) => sendResponse({ ok: false, error: describeError(e), code: e instanceof Coded ? e.code : undefined }),
  );
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SWAPS_ALARM) return void followAll();
  if (alarm.name !== LOCK_ALARM) return;
  const u = await getUnlock();
  if (!u || u.until <= Date.now() + 1_000) await lock();
});

void getSwaps().then((list) => {
  if (list.length) void chrome.alarms.create(SWAPS_ALARM, { periodInMinutes: 0.5 });
});
// Alarms may not survive a browser restart and Rings drops swaps not reported paid within 10 minutes: follow at once.
chrome.runtime.onStartup?.addListener(() => void followAll());

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL && !(await getVault())) {
    await chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});

function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  // -32002: the RPC's preflight simulation failed; explain it from the simulation's logs.
  const context = (e as { context?: { __code?: number; logs?: string[] } }).context;
  if (context?.__code === -32002) return failureReason((e as { cause?: unknown }).cause ?? null, context.logs ?? []);
  const coded = /^Solana error #(-?\d+)/.exec(e.message);
  if (coded) return `Solana refused this (error ${coded[1]}). Nothing was sent.`;
  const details = (e as { details?: { check?: string } }).details;
  const cause = (e as { cause?: unknown }).cause;
  const extra = details?.check ?? (cause instanceof Error ? cause.message : undefined);
  return extra ? `${e.message} (${extra})` : e.message;
}
