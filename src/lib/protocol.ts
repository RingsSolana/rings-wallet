// Messages between the wallet's own pages and the background; web pages never reach this channel.
import type { Network } from "./net";

export interface AccountView {
  id: string;
  name: string;
  kind: "hd" | "imported";
  address: string;
}

export interface WalletState {
  hasVault: boolean;
  unlocked: boolean;
  network: Network;
  autoLockMin: number;
  accounts: AccountView[];
  activeId: string | null;
  hasPhrase: boolean;
  version: string;
}

export type Request =
  | { type: "state" }
  | { type: "newPhrase" }
  /** `replace`: the forgot-password restore, which overwrites the saved wallet. */
  | { type: "create"; phrase: string; password: string; replace?: boolean }
  | { type: "importKey"; key: string; password: string; replace?: boolean }
  | { type: "unlock"; password: string }
  | { type: "lock" }
  | { type: "revealPhrase"; password: string }
  | { type: "setAutoLock"; minutes: number }
  | { type: "setNetwork"; network: Network }
  | { type: "addAccount" }
  | { type: "renameAccount"; id: string; name: string }
  | { type: "setActive"; id: string }
  | { type: "balances" }
  | { type: "privateBalances" }
  | { type: "cachedBalances" }
  /** Answers "public", "private" or "invalid". */
  | { type: "classify"; to: string }
  | { type: "send"; from: "public" | "private"; mint: string; amount: string; to: string }
  | { type: "move"; direction: "toPrivate" | "toPublic"; mint: string; amount: string; to?: string | null }
  | { type: "history" }
  | { type: "swapQuote"; inMint: string; outMint: string; amount: string; slippageBps: number; from?: "public" | "private"; receiveInto?: "private" | "wallet" | "other"; to?: string | null }
  /** What the private balance lacks to send this amount, or null. */
  | { type: "shortfall"; mint: string; amount: string }
  /** The fees a send or move will take, as FeesView. */
  | { type: "reviewCosts"; flow: "send" | "move"; from: "public" | "private"; direction: "toPrivate" | "toPublic"; mint: string; amount: string; to?: string | null }
  /** Moves a Shortfall's needs from Public to Private; returns the targets to poll with privateHas. */
  | { type: "topUp"; needs: { mint: string; units: string }[] }
  | { type: "privateHas"; target: { mint: string; units: string }[] }
  | {
      type: "swap";
      from: "public" | "private";
      inMint: string;
      outMint: string;
      amount: string;
      slippageBps: number;
      receiveInto: "private" | "wallet" | "other";
      to?: string | null;
      /** The quote's raw figures as shown: the swap is refused with "requote" if they got worse. */
      reviewed?: { minOutUnits: string; costsUnits: string; impactPct: number };
    }
  | { type: "swapStatus"; id: string }
  /** An empty query lists the usual coins to buy; otherwise a symbol, name or mint. */
  | { type: "searchTokens"; query: string }
  | { type: "approval"; id: string }
  | { type: "approvalDecision"; id: string; approve: boolean; addressChoice?: "main" | "fresh"; riskAccepted?: boolean }
  | { type: "sites" }
  | { type: "disconnectSite"; domain: string }
  | { type: "openProduct"; product: import("./net").Product }
  /** User activity in the popup: pushes the auto-lock back. Never sent by polling. */
  | { type: "touch" }
  /** The private address alone, derived locally without a sync. */
  | { type: "privateAddress" };

export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export interface SwapQuoteView {
  out: string;
  minOut: string;
  impactPct: number;
  route: string[];
  /** Rings' network costs in SOL; "" when unknown. */
  costs: string;
  shortfall?: Shortfall | null;
  /** The same figures in base units, echoed back with the swap. */
  minOutUnits?: string;
  costsUnits?: string;
  /** As in FeesView. */
  ringsFee?: string;
  networkFee?: string;
  networkFeeNote?: string;
}

export interface FeesView {
  /** e.g. "0.0125 USDC"; "" when no fee is taken. */
  ringsFee: string;
  networkFee: string;
  /** Who pays the network fee and any extras (rent, fee top-ups); may be "". */
  networkFeeNote: string;
}

export interface Shortfall {
  /** Display text, e.g. 120 USDC + 0.0044 SOL. */
  label: string;
  needs: { mint: string; units: string }[];
  /** Whether the public balance can pay it, network fees included. */
  publicOk: boolean;
}

export interface SwapView {
  state: string;
  /** 1 paying Rings privately, 2 swapping, 3 delivering. */
  step: 1 | 2 | 3;
  finished: "done" | "failed" | null;
  error: string | null;
  out?: string;
  url?: string;
}

export interface TokenOption {
  mint: string;
  sym: string;
  name: string;
  icon: string | null;
  price: number;
}

export interface PrivateView {
  rows: import("./net").TokenRow[];
  address: string;
}

/** The last balances answered for the active account; null when none is cached for this unlock. */
export interface CachedBalances {
  balances: import("./net").TokenRow[] | null;
  privateBalances: PrivateView | null;
}

export interface Done {
  signature: string;
  url: string;
}

/** A row of the Activity tab. */
export interface HistoryItem {
  id: string;
  network: import("./net").Network;
  account: string;
  kind: "sent" | "madePrivate" | "madePublic" | "swapped" | "received";
  balance: "public" | "private";
  who: string | null;
  amount: string;
  sym: string;
  at: number;
  /** "pending": sent, not confirmed yet. */
  status: "done" | "failed" | "pending";
  signature?: string;
  /** Other transactions of the same action, never shown again as "Received". */
  linked?: string[];
  error?: string;
}
