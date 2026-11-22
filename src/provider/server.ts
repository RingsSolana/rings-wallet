// Website requests (Wallet Standard). The site's origin comes from Chrome's port sender, never from the page.
import { ed25519 } from "@noble/curves/ed25519";
import { getTransactionDecoder } from "@solana/kit";
import { wire, withSignatures } from "../../../web/src/core/chain";
import { keyMessage, keysFromRoot, loginMessage, parseLoginMessage } from "../../../web/src/core/keys";
import { b64, fromB64, utf8 } from "../../../web/src/core/codec";
import { addressOf, ringsRoot, siteSecret } from "../lib/keys";
import { NETWORKS, formatUnits, rpc, type Network } from "../lib/net";
import { ownerHashOf } from "../lib/rings";
import { looksLikeTransaction, preview, readable, type Change, type Preview, type PreviewContext } from "../lib/simulate";
import { messageDetails, transactionSteps, type Detail } from "../lib/decode";
import { hasHiddenCharacters, isHostname, oneLine, shownHost } from "../lib/text";
import {
  INTERNAL,
  PORT_NAME,
  REJECTED,
  UNAUTHORIZED,
  type ConnectParams,
  type ProviderMethod,
  type SignAndSendParams,
  type SignInParams,
  type SignMessageParams,
  type SignTransactionsParams,
} from "./common";

declare const __RELEASE__: boolean | undefined;
const RELEASE = typeof __RELEASE__ !== "undefined" && __RELEASE__;

export interface SiteConn {
  accountId: string;
  fresh: boolean;
  address: string;
  at: number;
  /** Disconnected by the page: hidden from the site, but kept to offer the same address again. */
  off?: boolean;
}
/** Keyed by network, then `accountId|origin`; stored in the encrypted vault. */
export type Sites = Partial<Record<Network, Record<string, SiteConn>>>;

export interface ProviderDeps {
  network(): Promise<Network>;
  /** Must not extend the auto-lock: website requests may not keep the wallet open. */
  unlocked(): Promise<boolean>;
  /** Unlocked only; must not extend the auto-lock. */
  active(): Promise<{ id: string; name: string; secret: Uint8Array; address: string }>;
  secretOf(accountId: string): Promise<Uint8Array>;
  /** Empty while locked. */
  getSites(): Promise<Sites>;
  updateSites(change: (sites: Sites) => void): Promise<void>;
}

class ProviderError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}
const rejected = () => new ProviderError(REJECTED, "The request was rejected.");
const BUSY = -32002;

interface Req {
  origin: string;
  host: string;
  tab: chrome.tabs.Tab;
  gesture: boolean;
  entry: PortEntry;
  /** Chrome's document id: tab trust holds for the first document only. */
  documentId?: string;
}

const ringsSitesOf = (network: Network) => ["", "otc", "launch", "dex", "terminal"].map((sub) => NETWORKS[network].site(sub));
const RINGS_SITES: Record<Network, string[]> = {
  mainnet: ringsSitesOf("mainnet"),
  devnet: RELEASE ? [] : ringsSitesOf("devnet"),
};
const isRingsOrigin = (network: Network, origin: string) => RINGS_SITES[network].includes(origin);

/** Tabs the wallet opened: that Rings site skips the window once per kind, within 2 minutes, on its first document. */
const openedByWallet = new Map<number, { at: number; origin: string; documentId?: string; used: Set<string> }>();
export function trustTab(tabId: number, url: string) {
  openedByWallet.set(tabId, { at: Date.now(), origin: new URL(url).origin, used: new Set() });
}
function oneTap(network: Network, req: Req, kind: "connect" | "key" | "signin"): boolean {
  const t = req.tab.id !== undefined ? openedByWallet.get(req.tab.id) : undefined;
  if (!t || !isRingsOrigin(network, req.origin) || t.origin !== req.origin || Date.now() - t.at > 120_000 || t.used.has(kind)) return false;
  if (t.documentId && req.documentId && t.documentId !== req.documentId) return false;
  t.documentId ??= req.documentId;
  t.used.add(kind);
  return true;
}

const keyOf = (accountId: string, origin: string) => `${accountId}|${origin}`;

async function connection(d: ProviderDeps, network: Network, accountId: string, origin: string): Promise<SiteConn | null> {
  const c = (await d.getSites())[network]?.[keyOf(accountId, origin)] ?? null;
  return c && !c.off ? c : null;
}

/** Also returns a connection the page disconnected, to offer the same address again. */
async function remembered(d: ProviderDeps, network: Network, accountId: string, origin: string): Promise<SiteConn | null> {
  return (await d.getSites())[network]?.[keyOf(accountId, origin)] ?? null;
}

async function saveConnection(d: ProviderDeps, network: Network, origin: string, conn: Omit<SiteConn, "at" | "off">) {
  await d.updateSites((sites) => {
    sites[network] = { ...(sites[network] ?? {}), [keyOf(conn.accountId, origin)]: { ...conn, at: Date.now() } };
  });
}

async function pageDisconnect(d: ProviderDeps, network: Network, accountId: string, origin: string) {
  const c = await connection(d, network, accountId, origin);
  if (!c) return; // no write, so a page that never connected can't time the vault
  await d.updateSites((sites) => {
    const k = keyOf(accountId, origin);
    if (sites[network]?.[k]) sites[network]![k] = { ...sites[network]![k], off: true };
  });
}

export async function sitesOf(d: ProviderDeps, network: Network, accountId: string): Promise<{ domain: string; fresh: boolean; address: string }[]> {
  const all = (await d.getSites())[network] ?? {};
  return Object.entries(all)
    .filter(([k, c]) => k.startsWith(`${accountId}|`) && !c.off)
    .map(([k, c]) => ({ domain: new URL(k.slice(accountId.length + 1)).host, fresh: c.fresh, address: c.address }));
}

export async function disconnectDomain(d: ProviderDeps, network: Network, accountId: string, domain: string) {
  await d.updateSites((sites) => {
    for (const k of Object.keys(sites[network] ?? {})) {
      if (k.startsWith(`${accountId}|`) && new URL(k.slice(accountId.length + 1)).host === domain) delete sites[network]![k];
    }
  });
  await notifyAccounts();
}

/** Disconnects asked for while locked, applied at unlock; silent connects honor them until then. */
const QUEUE = "queuedDisconnects";
async function queueDisconnect(network: Network, origin: string) {
  const list = (((await chrome.storage.session.get(QUEUE))[QUEUE] as string[] | undefined) ?? []).filter((x) => x !== `${network}|${origin}`);
  await chrome.storage.session.set({ [QUEUE]: [...list, `${network}|${origin}`].slice(-100) });
}
async function queuedDisconnect(network: Network, origin: string): Promise<boolean> {
  return (((await chrome.storage.session.get(QUEUE))[QUEUE] as string[] | undefined) ?? []).includes(`${network}|${origin}`);
}
export async function applyQueuedDisconnects() {
  if (!deps) return;
  const list = ((await chrome.storage.session.get(QUEUE))[QUEUE] as string[] | undefined) ?? [];
  if (!list.length) return;
  const acc = await deps.active();
  for (const item of list) {
    const [network, ...rest] = item.split("|");
    await pageDisconnect(deps, network as Network, acc.id, rest.join("|")).catch(() => undefined);
  }
  await chrome.storage.session.remove(QUEUE);
}

export interface ApprovalView {
  request: "connect" | "transaction" | "message" | "signin";
  state: "normal" | "previewFailed" | "blocked";
  network: Network;
  siteDomain: string;
  siteIcon: string | null;
  otherDomain?: string;
  accountName: string;
  mainAddress: string;
  mainBalance: string;
  freshAddress: string;
  freshBalance: string;
  addressChoice: "main" | "fresh";
  networkFee?: string;
  changes?: Change[];
  message?: string;
  statement?: string;
  /** Risk or refusal text, always in the wallet's own words, never a site's. */
  riskReason?: string;
  details?: Detail[];
}

export interface Decision {
  approve: boolean;
  addressChoice?: "main" | "fresh";
  riskAccepted?: boolean;
}

interface Pending {
  view: ApprovalView;
  origin: string;
  entry?: PortEntry;
  windowId?: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (d: Decision) => void;
}
const pending = new Map<string, Pending>();
const WINDOW = { type: "popup" as const, width: 376, height: 640, focused: true };
const APPROVAL_TIMEOUT = 5 * 60_000;

// Chrome stops a worker idle for 30 seconds, dropping waiting requests; an API call every 20 seconds resets the timer.
let keptAwake: ReturnType<typeof setInterval> | null = null;
function stayAwakeWhileWaiting() {
  const busyNow = pending.size > 0 || claimed.size > 0;
  if (busyNow && !keptAwake) keptAwake = setInterval(() => void chrome.runtime.getPlatformInfo?.().catch(() => undefined), 20_000);
  else if (!busyNow && keptAwake) {
    clearInterval(keptAwake);
    keptAwake = null;
  }
}

const refusals = new Map<string, { count: number; until: number }>();
/** Origins with a request that may open a window: one at a time, claimed before any await. */
const claimed = new Set<string>();

function claim(req: Req): () => void {
  if (claimed.has(req.origin)) throw new ProviderError(BUSY, "Another request from this site is waiting in Rings Wallet.");
  const r = refusals.get(req.origin);
  if (r && !req.gesture) {
    if (r.count >= 3) throw new ProviderError(REJECTED, "You refused this site three times: Rings Wallet waits for a click on the site before it asks again.");
    if (Date.now() < r.until) throw new ProviderError(BUSY, "Rings Wallet waits a moment, or a click on the site, before asking again.");
  }
  claimed.add(req.origin);
  stayAwakeWhileWaiting();
  return () => {
    claimed.delete(req.origin);
    stayAwakeWhileWaiting();
  };
}

/** Only a refusal `byPerson` (Reject, window closed, timeout) counts toward the site's refusals. */
function settle(id: string, d: Decision, byPerson = false) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  stayAwakeWhileWaiting();
  if (p.timer) clearTimeout(p.timer);
  if (p.windowId !== undefined) void chrome.windows.remove(p.windowId).catch(() => undefined);
  if (d.approve) refusals.delete(p.origin);
  else if (byPerson) refusals.set(p.origin, { count: (refusals.get(p.origin)?.count ?? 0) + 1, until: Date.now() + 10_000 });
  p.resolve(d);
}

/** Near the browser's top right, slightly random so a page can't aim a click at the window. */
async function placement(): Promise<{ left?: number; top?: number }> {
  try {
    const w = await chrome.windows.getLastFocused();
    if (w.left === undefined || w.top === undefined || w.width === undefined) return {};
    const r = crypto.getRandomValues(new Uint8Array(2));
    return { left: Math.max(0, w.left + w.width - WINDOW.width - 16 - (r[0] % 64)), top: Math.max(0, w.top + 56 + (r[1] % 64)) };
  } catch {
    return {};
  }
}

async function ask(req: Pick<Req, "origin" | "entry">, view: ApprovalView): Promise<Decision> {
  if (req.entry && !ports.has(req.entry)) throw rejected();
  const id = crypto.randomUUID();
  const decided = new Promise<Decision>((resolve) => pending.set(id, { view, origin: req.origin, entry: req.entry, resolve }));
  stayAwakeWhileWaiting();
  try {
    const win = await chrome.windows.create({ ...WINDOW, ...(await placement()), url: chrome.runtime.getURL(`approve.html#${id}`) });
    const p = pending.get(id);
    if (p) {
      p.windowId = win.id;
      p.timer = setTimeout(() => settle(id, { approve: false }, true), APPROVAL_TIMEOUT);
    }
  } catch {
    settle(id, { approve: false });
  }
  return decided;
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, p] of pending) if (p.windowId === windowId) settle(id, { approve: false }, true);
});

export const approvalView = (id: string) => pending.get(id)?.view ?? null;
export function decide(id: string, d: Decision): boolean {
  if (!pending.has(id)) return false;
  settle(id, d, true);
  return true;
}
export function cancelAll() {
  for (const id of [...pending.keys()]) settle(id, { approve: false });
}

let unlockWindow: Promise<void> | null = null;

/** Same error for locked and not connected, so a page can't watch the wallet lock. */
const notConnected = () => new ProviderError(UNAUTHORIZED, "Not connected.");

/** One shared unlock window, opened only right after a user gesture on the site; requests wait up to 2 minutes. */
async function ensureUnlocked(deps: ProviderDeps, req: Req) {
  if (await deps.unlocked()) return;
  if (!req.gesture) throw notConnected();
  unlockWindow ??= (async () => {
    const win = await chrome.windows.create({ ...WINDOW, ...(await placement()), url: chrome.runtime.getURL(`popup.html?from=${encodeURIComponent(shownHost(req.host))}#unlock`) });
    try {
      for (let i = 0; i < 240; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await deps.unlocked()) return;
        if (win.id === undefined || !(await chrome.windows.get(win.id).catch(() => null))) return;
      }
    } finally {
      if (win.id !== undefined) await chrome.windows.remove(win.id).catch(() => undefined);
      unlockWindow = null;
    }
  })();
  await unlockWindow;
  if (!(await deps.unlocked())) throw new ProviderError(REJECTED, "Rings Wallet is locked.");
}

interface PortEntry {
  port: chrome.runtime.Port;
  origin: string;
}
const ports = new Set<PortEntry>();
let deps: ProviderDeps | null = null;

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const allowedOrigin = (origin: string) => /^https:\/\/[^/]+$/.test(origin) || LOOPBACK.test(origin) || (!RELEASE && /^http:\/\/[^/]+$/.test(origin));

export function startProvider(d: ProviderDeps) {
  deps = d;
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    const sender = port.sender;
    const origin = sender?.origin ?? (sender?.url ? new URL(sender.url).origin : "");
    if (!sender?.tab || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !allowedOrigin(origin)) return port.disconnect();
    const entry: PortEntry = { port, origin };
    ports.add(entry);
    port.onDisconnect.addListener(() => {
      ports.delete(entry);
      for (const [id, p] of pending) if (p.entry === entry) settle(id, { approve: false });
    });
    // Sent on every (re)connect, so changes made while the worker slept still arrive.
    void accountsFor(origin).then((accounts) => {
      try {
        port.postMessage({ event: "accounts", accounts });
      } catch {
        /* the page went away */
      }
    });
    const documentId = (sender as { documentId?: string }).documentId;
    port.onMessage.addListener(async (msg: { id: string; method: ProviderMethod; params: unknown; gesture?: boolean }) => {
      if (!msg || typeof msg.id !== "string") return;
      try {
        const req: Req = { origin, host: new URL(origin).host, tab: sender.tab!, gesture: msg.gesture !== false, entry, documentId };
        const result = await handle(d, req, msg.method, msg.params);
        port.postMessage({ id: msg.id, result });
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError(INTERNAL, e instanceof Error ? oneLine(e.message) : "Something went wrong.");
        try {
          port.postMessage({ id: msg.id, error: { message: err.message, code: err.code } });
        } catch {
          /* the page went away */
        }
      }
    });
  });
}

async function accountsFor(origin: string): Promise<string[]> {
  if (!deps) return [];
  let accountId: string | null = null;
  try {
    if (await deps.unlocked()) accountId = (await deps.active()).id;
  } catch {
    accountId = null;
  }
  const conn = accountId ? await connection(deps, await deps.network(), accountId, origin).catch(() => null) : null;
  return conn ? [conn.address] : [];
}

export async function notifyAccounts() {
  if (!deps) return;
  for (const { port, origin } of [...ports]) {
    const accounts = await accountsFor(origin);
    try {
      port.postMessage({ event: "accounts", accounts });
    } catch {
      /* gone */
    }
  }
  // Tabs whose port closed while the worker slept get a nudge to reconnect.
  try {
    const live = new Set([...ports].map((e) => e.port.sender?.tab?.id));
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) if (t.id !== undefined && !live.has(t.id)) void chrome.tabs.sendMessage(t.id, { event: "accountsChanged" }).catch(() => undefined);
  } catch {
    /* no tabs to tell */
  }
}

async function solText(network: Network, address: string): Promise<string> {
  try {
    const { value } = await rpc<{ value: number }>(network, "getBalance", [address, { commitment: "confirmed" }]);
    return `${formatUnits(BigInt(value), 9, 4)} SOL`;
  } catch {
    return "—";
  }
}

const siteName = (req: Req) => `${req.origin.startsWith("https:") ? "" : "http://"}${shownHost(req.host)}`;

async function baseView(d: ProviderDeps, network: Network, req: Req, opts: { balance?: boolean } = {}): Promise<ApprovalView> {
  const acc = await d.active();
  return {
    request: "connect",
    state: "normal",
    network,
    siteDomain: siteName(req),
    siteIcon: req.tab.favIconUrl && /^https:/.test(req.tab.favIconUrl) ? req.tab.favIconUrl : null,
    accountName: acc.name,
    mainAddress: acc.address,
    // Connect window only: fetched along with a fresh address's preview, it would link the two at the RPC.
    mainBalance: opts.balance ? await solText(network, acc.address) : "",
    freshAddress: addressOf(siteSecret(acc.secret, req.origin)),
    // Never fetched: querying both balances would link the fresh address to the main one.
    freshBalance: "New address",
    addressChoice: "main",
    networkFee: "—",
    message: "—",
    statement: "This site didn't add a statement.",
    // Always set: without it the design shows its sample rows.
    details: [],
    riskReason: "",
  };
}

async function chooseAddress(d: ProviderDeps, network: Network, req: Req): Promise<SiteConn> {
  const acc = await d.active();
  const view = await baseView(d, network, req, { balance: true });
  const last = await remembered(d, network, acc.id, req.origin);
  const choice = await ask(req, { ...view, addressChoice: last?.fresh ? "fresh" : "main" });
  if (!choice.approve) throw rejected();
  const fresh = choice.addressChoice === "fresh";
  const conn = { accountId: acc.id, fresh, address: fresh ? view.freshAddress : acc.address };
  await saveConnection(d, network, req.origin, conn);
  return { ...conn, at: Date.now() };
}

async function requireConnection(d: ProviderDeps, network: Network, req: Req): Promise<SiteConn> {
  await ensureUnlocked(d, req);
  const acc = await d.active();
  const conn = await connection(d, network, acc.id, req.origin);
  if (!conn) throw notConnected();
  return conn;
}

async function secretFor(d: ProviderDeps, conn: SiteConn, origin: string) {
  if (!(await d.unlocked())) throw new ProviderError(REJECTED, "Rings Wallet locked before signing.");
  const base = await d.secretOf(conn.accountId);
  return conn.fresh ? siteSecret(base, origin) : base;
}

function signWire(base64: string, secret: Uint8Array, address: string): string {
  const tx = getTransactionDecoder().decode(fromB64(base64));
  if (!(address in (tx.signatures as Record<string, unknown>))) throw new ProviderError(INTERNAL, "This transaction doesn't ask for this wallet's signature.");
  return wire(withSignatures(tx as never, [secret]));
}

/** A page's string field, cut to `max` and kept on one line (SIWS fields are single-line). */
const str = (v: unknown, max = 512) => (typeof v === "string" ? v.slice(0, max).replace(/[\r\n]+/g, " ") : undefined);

/** Sign In With Solana message text, in the standard's field order. */
function signInMessage(f: { domain: string; address: string; statement?: string; uri?: string; version?: string; chainId?: string; nonce?: string; issuedAt?: string; expirationTime?: string; notBefore?: string; requestId?: string; resources?: string[] }): string {
  let m = `${f.domain} wants you to sign in with your Solana account:\n${f.address}`;
  if (f.statement) m += `\n\n${f.statement}`;
  const fields: string[] = [];
  if (f.uri) fields.push(`URI: ${f.uri}`);
  if (f.version) fields.push(`Version: ${f.version}`);
  if (f.chainId) fields.push(`Chain ID: ${f.chainId}`);
  if (f.nonce) fields.push(`Nonce: ${f.nonce}`);
  if (f.issuedAt) fields.push(`Issued At: ${f.issuedAt}`);
  if (f.expirationTime) fields.push(`Expiration Time: ${f.expirationTime}`);
  if (f.notBefore) fields.push(`Not Before: ${f.notBefore}`);
  if (f.requestId) fields.push(`Request ID: ${f.requestId}`);
  if (f.resources?.length) fields.push(`Resources:\n${f.resources.map((r) => `- ${r}`).join("\n")}`);
  if (fields.length) m += `\n\n${fields.join("\n")}`;
  return m;
}

/** Any form of a Rings sign-in: its first line, its key lines or its sentence. */
function isRingsLogin(text: string): boolean {
  const lines = text.split("\n");
  return / wants you to sign in to Rings with your Solana account:$/.test(lines[0] ?? "") || /\nSign in to Rings\. This moves no funds/.test(text) || lines.some((l) => /^(Messaging key|Message signing key|Account key): /.test(l));
}

/** Exactly Rings' own sign-in text for this host and address, naming this address's own Rings keys. */
function isOwnRingsLogin(network: Network, text: string, secret: Uint8Array, wallet: string, host: string): boolean {
  const f = parseLoginMessage(text);
  if (f.domain !== host || f.wallet !== wallet || text !== loginMessage(f)) return false;
  const root = ringsRoot(secret, NETWORKS[network].keyHost);
  const keys = keysFromRoot(wallet, root);
  root.fill(0);
  return f.x25519 === b64(keys.msg.x25519Public) && f.ed25519 === b64(keys.msg.edPublic) && f.account === addressOf(keys.accountSeed);
}

function ringsAccountOf(network: Network, secret: Uint8Array): string {
  const root = ringsRoot(secret, NETWORKS[network].keyHost);
  const keys = keysFromRoot(addressOf(secret), root);
  root.fill(0);
  return addressOf(keys.accountSeed);
}

const amountText = (n: number) => Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 1 ? 9 : 6 });

/** True when the re-check fails, adds a risk, or takes more than the approved preview. */
function worse(first: Preview, again: Preview | null): boolean {
  if (!again) return true;
  if (first.ok && !again.ok) return true;
  const had = new Set((first.danger ?? "").split(/(?<=\.) /));
  if ((again.danger ?? "").split(/(?<=\.) /).some((t) => t && !had.has(t))) return true;
  for (const [mint, units] of Object.entries(again.losses ?? {})) {
    const was = BigInt(first.losses?.[mint] ?? "0");
    // Slack for fee or rent drift: 1% plus 0.001 SOL, or one base unit for a token.
    const room = was / 100n + (mint === "11111111111111111111111111111111" ? 1_000_000n : 1n);
    if (BigInt(units) > was + room) return true;
  }
  return false;
}

async function transactionView(d: ProviderDeps, network: Network, req: Req, conn: SiteConn, transactions: string[]) {
  // Only public values are derived from the key here; nothing is signed until approval.
  const secret = await secretFor(d, conn, req.origin);
  const context: PreviewContext = {
    ringsAccount: ringsAccountOf(network, secret),
    ringsSite: isRingsOrigin(network, req.origin),
    ownerHash: await ownerHashOf(network, secret).catch(() => undefined),
  };
  const [pv, steps] = await Promise.all([
    preview(network, transactions, conn.address, context).catch(
      (e: Error): Preview => ({ ok: false, changes: [], fee: "", error: e.message, danger: null, reason: "Rings Wallet couldn't preview this transaction." }),
    ),
    transactionSteps(network, transactions, conn.address, { ringsAccount: context.ringsAccount, ownerHash: context.ownerHash }).catch(() => ({ rows: [] as Detail[], hidden: 1 })),
  ]);
  const risks: string[] = [];
  if (pv.danger) risks.push(pv.danger);
  else if (!pv.ok) risks.push(pv.reason ?? "Rings Wallet couldn't preview this transaction.");
  if (steps.hidden > 0) risks.push("Some steps aren't listed here.");
  if (req.host.length > 60) risks.push("This site's address is unusually long: make sure it's the site you meant.");
  const safe = pv.ok && risks.length === 0;
  // The risk layout hides balance changes, so they lead the steps list instead.
  const changeRows: Detail[] = !safe && pv.ok ? pv.changes.map((c) => ({ label: "Balance change", value: `${c.amount < 0 ? "−" : "+"}${amountText(c.amount)} ${c.sym} · ${c.name}` })) : [];
  return {
    view: {
      ...(await baseView(d, network, req)),
      request: "transaction" as const,
      details: [...changeRows, ...steps.rows],
      state: safe ? ("normal" as const) : ("previewFailed" as const),
      changes: pv.changes,
      networkFee: pv.fee || "—",
      addressChoice: conn.fresh ? ("fresh" as const) : ("main" as const),
      riskReason: risks.join(" "),
    } satisfies ApprovalView,
    safe,
    pv,
    context,
  };
}

async function handle(d: ProviderDeps, req: Req, method: ProviderMethod, params: unknown): Promise<unknown> {
  const network = await d.network();
  const { origin, host } = req;
  const rings = isRingsOrigin(network, origin);
  switch (method) {
    case "connect": {
      const { silent } = (params ?? {}) as ConnectParams;
      if (silent) {
        if (!(await d.unlocked()) || (await queuedDisconnect(network, origin))) throw notConnected();
        const conn = await connection(d, network, (await d.active()).id, origin);
        if (!conn) throw notConnected();
        return { accounts: [conn.address] };
      }
      const release = claim(req);
      try {
        await ensureUnlocked(d, req);
        const acc = await d.active();
        const conn = await connection(d, network, acc.id, origin);
        if (conn) return { accounts: [conn.address] };
        if (oneTap(network, req, "connect")) {
          // Opened by the wallet: connect with the main address, which owns the private balance.
          await saveConnection(d, network, origin, { accountId: acc.id, fresh: false, address: acc.address });
          return { accounts: [acc.address] };
        }
        if (!req.gesture) throw notConnected();
        return { accounts: [(await chooseAddress(d, network, req)).address] };
      } finally {
        release();
      }
    }
    case "disconnect": {
      if (await d.unlocked()) await pageDisconnect(d, network, (await d.active()).id, origin);
      else await queueDisconnect(network, origin);
      return null;
    }
    case "signTransactions": {
      const { transactions } = (params ?? {}) as SignTransactionsParams;
      if (!Array.isArray(transactions) || !transactions.length || transactions.length > 20 || !transactions.every((t) => typeof t === "string" && t.length < 8000)) {
        throw new ProviderError(INTERNAL, "Send 1 to 20 transactions.");
      }
      const release = claim(req);
      try {
        const conn = await requireConnection(d, network, req);
        const { view, safe } = await transactionView(d, network, req, conn, transactions);
        const decision = await ask(req, view);
        if (!decision.approve || (!safe && !decision.riskAccepted)) throw rejected();
        const secret = await secretFor(d, conn, origin);
        return { signed: transactions.map((t) => signWire(t, secret, conn.address)) };
      } finally {
        release();
      }
    }
    case "signAndSendTransaction": {
      const { transaction, options } = (params ?? {}) as SignAndSendParams;
      if (typeof transaction !== "string" || transaction.length > 8000) throw new ProviderError(INTERNAL, "Send one transaction.");
      const release = claim(req);
      try {
        const conn = await requireConnection(d, network, req);
        const { view, safe, pv, context } = await transactionView(d, network, req, conn, [transaction]);
        const decision = await ask(req, view);
        if (!decision.approve || (!safe && !decision.riskAccepted)) throw rejected();
        // Simulated again just ahead of sending: a program can act differently than in the preview.
        const again = await preview(network, [transaction], conn.address, context).catch(() => null);
        if (worse(pv, again)) throw new ProviderError(REJECTED, "This transaction changed after you approved it (it would now take more, or do something new). Rings Wallet didn't send it.");
        if (!ports.has(req.entry)) throw new ProviderError(REJECTED, "The site closed before the transaction was sent. Nothing was sent.");
        const signed = signWire(transaction, await secretFor(d, conn, origin), conn.address);
        const signature = await rpc<string>(network, "sendTransaction", [
          signed,
          { encoding: "base64", skipPreflight: !!options?.skipPreflight, preflightCommitment: "confirmed", ...(typeof options?.maxRetries === "number" ? { maxRetries: options.maxRetries } : {}) },
        ]);
        return { signature };
      } finally {
        release();
      }
    }
    case "signMessage": {
      const { message } = (params ?? {}) as SignMessageParams;
      if (typeof message !== "string" || message.length > 16_000) throw new ProviderError(INTERNAL, "That message is too long.");
      const release = claim(req);
      try {
        const conn = await requireConnection(d, network, req);
        const bytes = fromB64(message);
        const text = readable(bytes);
        const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        const addressLabel = conn.fresh ? `Fresh address for ${shownHost(host)}` : "Main address";
        const details = await messageDetails(network, bytes, text, conn.address, addressLabel).catch(() => [] as Detail[]);
        if (hasHiddenCharacters(raw)) details.unshift({ label: "Careful", value: "This message has hidden or direction-changing characters, shown here as <U+…>." });
        const view = { ...(await baseView(d, network, req)), request: "message" as const, message: text || "(an empty message)", details };
        const blocked = async (reason: string) => {
          await ask(req, { ...view, state: "blocked", riskReason: reason }).catch(() => undefined);
          throw rejected();
        };
        const sign = async () => ({ signature: b64(ed25519.sign(bytes, await secretFor(d, conn, origin))) });
        if (raw.startsWith("Rings key v1")) {
          // Unlocks a private balance: exact Rings sites only, and only for the connected address.
          if (!rings) return await blocked("This asks for your Rings key, which only the Rings sites may ask for. Rings won't sign it.");
          if (raw !== keyMessage(NETWORKS[network].keyHost, conn.address)) return await blocked("This asks for the Rings key of another address or site. Rings won't sign it.");
          // No window: the exact key message, from a connected Rings site.
          return await sign();
        }
        if (isRingsLogin(raw)) {
          if (!rings) return await blocked("This is a Rings sign-in, which only the Rings sites may ask for. Rings won't sign it.");
          if (!isOwnRingsLogin(network, raw, await secretFor(d, conn, origin), conn.address, host)) return await blocked("This Rings sign-in is for another site or address, or names keys that aren't this wallet's. Rings won't sign it.");
          if (oneTap(network, req, "signin")) return await sign();
          if (!(await ask(req, view)).approve) throw rejected();
          return await sign();
        }
        const siws = /^(\S+) wants you to sign in with your Solana account:\n(\S+)/.exec(raw);
        if (siws && (siws[1] !== host || siws[2] !== conn.address)) return await blocked("This sign-in is for another site or address. Rings won't sign it.");
        if (looksLikeTransaction(bytes)) return await blocked("This looks like a transaction, not a message. Rings won't sign it.");
        if (!(await ask(req, view)).approve) throw rejected();
        return await sign();
      } finally {
        release();
      }
    }
    case "signIn": {
      const input = ((params ?? {}) as SignInParams).input ?? {};
      const release = claim(req);
      try {
        if (!origin.startsWith("https:") && !LOOPBACK.test(origin)) throw new ProviderError(REJECTED, "Rings Wallet signs in only on secure (https) sites.");
        await ensureUnlocked(d, req);
        const acc = await d.active();
        const view = await baseView(d, network, req);
        const askedDomain = typeof input.domain === "string" ? input.domain : undefined;
        const uri = str(input.uri);
        // Same scheme, and the same host or a subdomain either way (an app's API host, say).
        let uriOk = true;
        try {
          if (uri) {
            const u = new URL(uri);
            const a = u.hostname;
            const b = new URL(origin).hostname;
            uriOk = u.protocol === new URL(origin).protocol && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
          }
        } catch {
          uriOk = false;
        }
        if ((askedDomain !== undefined && askedDomain !== host) || !uriOk) {
          // Named only when it's a plain hostname: page text never enters the wallet's sentences.
          const other = askedDomain && askedDomain !== host && isHostname(askedDomain) ? shownHost(askedDomain) : "a different site";
          await ask(req, { ...view, request: "signin", state: "blocked", otherDomain: other, riskReason: "This sign-in is for a different site. Rings won't sign it." }).catch(() => undefined);
          throw rejected();
        }
        let conn = await connection(d, network, acc.id, origin);
        if (!conn) {
          if (!req.gesture) throw notConnected();
          conn = await chooseAddress(d, network, req);
        }
        const statement = str(input.statement, 1000);
        const text = signInMessage({
          domain: host,
          address: conn.address,
          statement,
          uri,
          version: str(input.version, 8),
          chainId: str(input.chainId, 64),
          nonce: str(input.nonce, 128),
          issuedAt: str(input.issuedAt, 64),
          expirationTime: str(input.expirationTime, 64),
          notBefore: str(input.notBefore, 64),
          requestId: str(input.requestId, 128),
          resources: Array.isArray(input.resources) ? input.resources.filter((r) => typeof r === "string").slice(0, 20).map((r) => r.slice(0, 512).replace(/[\r\n]+/g, " ")) : undefined,
        });
        const addressLabel = conn.fresh ? `Fresh address for ${shownHost(host)}` : "Main address";
        const details = await messageDetails(network, utf8(text), text, conn.address, addressLabel).catch(() => [] as Detail[]);
        const decision = await ask(req, { ...view, request: "signin", state: "normal", statement: statement ? readable(utf8(statement)) : "This site didn't add a statement.", message: readable(utf8(text)), details, addressChoice: conn.fresh ? "fresh" : "main" });
        if (!decision.approve) throw rejected();
        const secret = await secretFor(d, conn, origin);
        return { account: conn.address, signedMessage: b64(utf8(text)), signature: b64(ed25519.sign(utf8(text), secret)) };
      } finally {
        release();
      }
    }
    default:
      throw new ProviderError(INTERNAL, "Unknown request.");
  }
}
