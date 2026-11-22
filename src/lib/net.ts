// Networks, Rings endpoints, public balances, token names and prices.

export type Network = "mainnet" | "devnet";

interface NetConfig {
  /** Rings server: Helius proxies (RPC, indexer, prover) and APIs. */
  rings: string;
  /** Host the Rings keys are derived for: another host means another private balance. */
  keyHost: string;
  usdc: string;
  site: (sub: string) => string;
  explorerTx: (signature: string) => string;
}

declare const __RELEASE__: boolean | undefined;

// Release builds get a devnet address that never resolves, so no local address ships in them.
const devnetRings =
  typeof __RELEASE__ !== "undefined" && __RELEASE__ ? "https://devnet.invalid" : ((globalThis as { __RINGS_DEVNET_ORIGIN?: string }).__RINGS_DEVNET_ORIGIN ?? "http://localhost:3101");
const devnetHost = typeof __RELEASE__ !== "undefined" && __RELEASE__ ? "devnet.invalid" : "localhost:3101";
// Development builds use a local mainnet server: its keys, and so its private balance, differ from rings.run's.
const mainnetRings = typeof __RELEASE__ !== "undefined" && __RELEASE__ ? "https://rings.run" : "http://localhost:3100";

/** Anything unknown is mainnet; release builds know only mainnet. */
export const networkOf = (n: unknown): Network => (n === "devnet" && !(typeof __RELEASE__ !== "undefined" && __RELEASE__) ? "devnet" : "mainnet");
const mainnetUrl = new URL(mainnetRings);

export const NETWORKS: Record<Network, NetConfig> = {
  mainnet: {
    rings: mainnetRings,
    keyHost: mainnetUrl.host,
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    site: (sub) => `${mainnetUrl.protocol}//${sub ? `${sub}.` : ""}${mainnetUrl.host}`,
    explorerTx: (signature) => `https://solscan.io/tx/${signature}`,
  },
  devnet: {
    rings: devnetRings,
    keyHost: devnetHost,
    usdc: "6v74aDeQhs4o9rRq5ZsafivvjYhPdAoP39NmFTDB7Y55",
    site: (sub) => `${devnetHost === "devnet.invalid" ? "https" : "http"}://${sub ? `${sub}.` : ""}${devnetHost}`,
    explorerTx: (signature) => `https://solscan.io/tx/${signature}?cluster=devnet`,
  },
};

export const rpcUrl = (network: Network) => `${NETWORKS[network].rings}/api/helius/rpc`;

export const PRODUCTS = ["otc", "launch", "dex", "terminal", "requests"] as const;
export type Product = (typeof PRODUCTS)[number];

/** `?wallet=Rings`: the site picks Rings Wallet and unlocks without a prompt. */
export function productUrl(network: Network, product: Product): string {
  const site = NETWORKS[network].site;
  return `${product === "requests" ? `${site("otc")}/requests` : site(product)}?wallet=Rings`;
}

/** One token in one balance; SOL's `mint` is SOL_MINT. */
export interface TokenRow {
  mint: string;
  sym: string;
  name: string;
  amount: number;
  /** Exact base units, as a decimal string. */
  units: string;
  decimals: number;
  price: number;
  change: number;
  icon?: string;
  /** Another mint copying a known coin's ticker or name, or a wallet label: shown as unverified. */
  lookAlike?: boolean;
}

/** Privacy Rings names SOL by the System Program address. */
export const SOL_MINT = "11111111111111111111111111111111";
/** Wrapped SOL: what price feeds call SOL. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** For balance reads: Chrome stops a background whose fetch gets no response for 30 seconds. */
export const READ_TIMEOUT_MS = 15_000;

/** No timeout unless given: a send cut short here could still land. */
export async function rpc<T>(network: Network, method: string, params: unknown[], timeoutMs?: number): Promise<T> {
  const res = await fetch(rpcUrl(network), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  if (!res.ok) throw new Error(`The network didn't answer (${res.status}).`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

interface ParsedTokenAccount {
  account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } };
}

/** Largest value first. */
export async function publicBalances(network: Network, owner: string): Promise<TokenRow[]> {
  const opts = { encoding: "jsonParsed", commitment: "confirmed" };
  const [sol, classic, t22] = await Promise.all([
    rpc<{ value: number }>(network, "getBalance", [owner, { commitment: "confirmed" }], READ_TIMEOUT_MS),
    rpc<{ value: ParsedTokenAccount[] }>(network, "getTokenAccountsByOwner", [owner, { programId: TOKEN_PROGRAM }, opts], READ_TIMEOUT_MS),
    rpc<{ value: ParsedTokenAccount[] }>(network, "getTokenAccountsByOwner", [owner, { programId: TOKEN_2022_PROGRAM }, opts], READ_TIMEOUT_MS),
  ]);
  const byMint = new Map<string, { units: bigint; decimals: number }>();
  for (const acc of [...classic.value, ...t22.value]) {
    const info = acc.account.data.parsed.info;
    const units = BigInt(info.tokenAmount.amount);
    if (units === 0n) continue;
    const prev = byMint.get(info.mint);
    byMint.set(info.mint, { units: (prev?.units ?? 0n) + units, decimals: info.tokenAmount.decimals });
  }
  const rows = [row(SOL_MINT, BigInt(sol.value), 9), ...[...byMint].map(([mint, v]) => row(mint, v.units, v.decimals))];
  await describe(network, rows);
  return sortRows(rows);
}

/** Mints only: nobody is asked for names or prices. */
export async function publicMints(network: Network, owner: string): Promise<string[]> {
  const opts = { encoding: "jsonParsed", commitment: "confirmed" };
  const [classic, t22] = await Promise.all([
    rpc<{ value: ParsedTokenAccount[] }>(network, "getTokenAccountsByOwner", [owner, { programId: TOKEN_PROGRAM }, opts], READ_TIMEOUT_MS),
    rpc<{ value: ParsedTokenAccount[] }>(network, "getTokenAccountsByOwner", [owner, { programId: TOKEN_2022_PROGRAM }, opts], READ_TIMEOUT_MS),
  ]);
  return [...new Set([...classic.value, ...t22.value].filter((a) => BigInt(a.account.data.parsed.info.tokenAmount.amount) > 0n).map((a) => a.account.data.parsed.info.mint))];
}

export function row(mint: string, units: bigint, decimals: number): TokenRow {
  const sol = mint === SOL_MINT;
  return { mint, sym: sol ? "SOL" : `${mint.slice(0, 4)}…`, name: sol ? "Solana" : "Token", amount: Number(units) / 10 ** decimals, units: units.toString(), decimals, price: 0, change: 0 };
}

export const sortRows = (rows: TokenRow[]) => rows.sort((x, y) => y.amount * y.price - x.amount * x.price || (x.mint === SOL_MINT ? -1 : y.mint === SOL_MINT ? 1 : 0));

/** Devnet stand-ins and the mainnet coins they are priced as; matches the server's DEVNET_PRICE_ALIASES. */
export const DEVNET_ALIASES: Record<string, { mainnet: string; sym: string; name: string }> = {
  FF4iWENV2AA58SPN9yf77SZ9wuJkhHxDowM9hb3pjZzr: { mainnet: "BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy", sym: "TEST1", name: "Devnet test coin 1" },
  "8g281QnLeJLhyoc8sLV6mwqUWeWhzt7MfBVUZG9CaYeB": { mainnet: "4CxjZyMNoF1p6eXHXHv1TWpS2X47CuUmLwtGe18spump", sym: "TEST2", name: "Devnet test coin 2" },
};

type Meta = { symbol: string | null; name: string | null; image: string | null };

/** Well-known mainnet coins: another mint with one of these tickers or names is a look-alike. */
const PINNED_MAINNET: Record<string, { sym: string; name: string }> = {
  [SOL_MINT]: { sym: "SOL", name: "Solana" },
  [WSOL_MINT]: { sym: "SOL", name: "Wrapped SOL" },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { sym: "USDC", name: "USD Coin" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { sym: "USDT", name: "Tether USD" },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { sym: "JUP", name: "Jupiter" },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { sym: "Bonk", name: "Bonk" },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { sym: "WIF", name: "dogwifhat" },
  "65iH8k736QNhuUHm1tt8X7yJXpJ517HPPq8BrVdwring": { sym: "RINGS", name: "Rings" },
};

/** A known coin on this network, whose name can be trusted. */
export function isPinned(network: Network, mint: string): boolean {
  if (mint === SOL_MINT || mint === NETWORKS[network].usdc) return true;
  return network === "mainnet" ? mint in PINNED_MAINNET : mint in DEVNET_ALIASES;
}

// Cyrillic and Greek look-alikes of Latin letters, and 0 for o.
const CONFUSABLE: Record<string, string> = { а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", ѕ: "s", і: "i", ј: "j", ԁ: "d", ɡ: "g", ο: "o", ν: "v", μ: "u", ϲ: "c", κ: "k", τ: "t", ι: "i", α: "a", ρ: "p", "0": "o" };
const plain = (s: string) =>
  [...s.normalize("NFKC").toLowerCase()].map((c) => CONFUSABLE[c] ?? c).join("").replace(/[^a-z0-9]/g, "");
const KNOWN_SYMS = new Set(Object.values(PINNED_MAINNET).map((p) => plain(p.sym)).concat(["sol", "wsol", "usdc", "usdt", "rings"]));
const KNOWN_NAMES = new Set(Object.values(PINNED_MAINNET).map((p) => plain(p.name)).concat(["usdcoin", "tether", "solana", "wrappedsol", "ringsrun"]));
// The wallet's own labels: a coin named so could pass for the wallet speaking.
const WALLET_WORDS = ["privatebalance", "publicbalance", "ringsaccount", "ringswallet", "networkfee", "yourwallet"];

export function looksLikeKnown(network: Network, mint: string, sym: string, name: string): boolean {
  if (isPinned(network, mint)) return false;
  const s = plain(sym.replace(/^\$/, ""));
  const n = plain(name);
  return KNOWN_SYMS.has(s) || KNOWN_NAMES.has(n) || KNOWN_SYMS.has(n) || WALLET_WORDS.some((w) => n.includes(w) || s.includes(w));
}

export const shortMint = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

type Price = { usdPrice?: number; priceChange24h?: number };

const ringsPrices = new Map<string, { at: number; usd?: number }>();
async function pricesViaRings(network: Network, mints: string[]): Promise<Record<string, Price>> {
  const out: Record<string, Price> = {};
  await Promise.all(
    mints.map(async (m) => {
      const feed = m === SOL_MINT ? WSOL_MINT : m;
      let hit = ringsPrices.get(feed);
      if (!hit || Date.now() - hit.at > 60_000) {
        const usd = await fetch(`${NETWORKS[network].rings}/api/market/${feed}`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
          .then((r) => (r.ok ? (r.json() as Promise<{ price?: { usdPrice?: number | null } }>) : null))
          .then((j) => j?.price?.usdPrice ?? undefined)
          .catch(() => undefined);
        ringsPrices.set(feed, (hit = { at: Date.now(), usd }));
      }
      if (hit.usd) out[feed] = { usdPrice: hit.usd };
    }),
  );
  return out;
}

/** Names, pictures and prices. `privately`: prices from Rings, so Jupiter never sees which coins are held privately. */
export async function describe(network: Network, rows: TokenRow[], opts: { privately?: boolean } = {}) {
  const { usdc, rings } = NETWORKS[network];
  const mints = [...new Set(rows.map((r) => r.mint))].slice(0, 60);
  const [meta, prices] = await Promise.all([
    mints.length
      ? fetch(`${rings}/api/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mints }), signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
          .then((r) => (r.ok ? (r.json() as Promise<{ tokens?: Record<string, Meta> }>) : {}))
          .then((j) => (j as { tokens?: Record<string, Meta> }).tokens ?? {})
          .catch(() => ({}) as Record<string, Meta>)
      : Promise.resolve({} as Record<string, Meta>),
    network !== "mainnet" || !mints.length
      ? Promise.resolve({} as Record<string, Price>)
      : opts.privately
        ? pricesViaRings(network, mints.filter((m) => m !== usdc))
        : fetch(`https://lite-api.jup.ag/price/v3?ids=${[...new Set(mints.map((m) => (m === SOL_MINT ? WSOL_MINT : m)))].join(",")}`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
            .then((r) => r.json() as Promise<Record<string, Price>>)
            .catch(() => ({}) as Record<string, Price>),
  ]);
  for (const r of rows) {
    const t = meta[r.mint];
    if (t?.symbol) r.sym = t.symbol;
    if (t?.name) r.name = t.name;
    // Only Rings' own copy: a host the creator chose would learn who holds the token.
    if (typeof t?.image === "string" && /^\/api\/tokens\/[1-9A-HJ-NP-Za-km-z]{32,44}\/image(\?[\w=.-]*)?$/.test(t.image)) r.icon = `${rings}${t.image}`;
    if (r.mint === usdc) {
      r.sym = "USDC";
      r.name = "USD Coin";
      if (network === "mainnet") r.price = 1;
    }
    const alias = network === "devnet" ? DEVNET_ALIASES[r.mint] : undefined;
    if (alias) {
      r.sym = alias.sym;
      r.name = alias.name;
    }
    const p = prices?.[r.mint === SOL_MINT ? WSOL_MINT : r.mint];
    if (p?.usdPrice && r.mint !== usdc) {
      r.price = p.usdPrice;
      r.change = p.priceChange24h ?? 0;
    }
    // A look-alike keeps its ticker but never a known coin's name.
    if (looksLikeKnown(network, r.mint, r.sym, r.name)) {
      r.lookAlike = true;
      r.name = `Unverified · ${shortMint(r.mint)}`;
    }
  }
}

/** 1500000000n, 9 -> "1.5": at most `maxFrac` decimals, trailing zeros dropped, a nonzero amount never shown as 0. */
export function formatUnits(units: bigint, decimals: number, maxFrac = 6): string {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = u / base;
  let frac = (u % base).toString().padStart(decimals, "0").slice(0, Math.min(decimals, maxFrac)).replace(/0+$/, "");
  if (whole === 0n && frac === "" && u > 0n) frac = "0".repeat(Math.min(decimals, maxFrac) - 1) + "1";
  return `${neg ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}

/** "1.5", 9 -> 1500000000n; refuses more decimals than the token has. */
export function parseUnits(text: string, decimals: number): bigint {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") throw new Error("Enter an amount.");
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) throw new Error(`This token has ${decimals} decimals at most.`);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}
