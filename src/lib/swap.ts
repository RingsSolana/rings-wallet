// Swaps through the Rings DEX relay, paid from the private balance. Background only.
import { ShieldedAddress } from "@heliuslabs/spr";
import type { Address } from "@solana/kit";
import { keypairFromSeed } from "../../../web/src/core/chain";
import { payPrivately } from "./pay";
import { TREASURY_RING_B64 } from "./fee";
import { routeAccountsOf, swapCosts as costsFormula } from "../../../web/src/dex/costs";
import { b64, fromB64 } from "../../../web/src/core/codec";
import { MaybeSent, client, decimalsOf, type Ctx } from "./rings";
import { api } from "./session";
import { DEVNET_ALIASES, NETWORKS, SOL_MINT, WSOL_MINT, type Network } from "./net";

const JUP = "https://lite-api.jup.ag";

/** Coins offered to buy besides the ones held. */
export function buyList(network: Network): string[] {
  if (network === "devnet") return [SOL_MINT, ...Object.keys(DEVNET_ALIASES)];
  return [
    SOL_MINT,
    NETWORKS.mainnet.usdc,
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP
    "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
    "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
    "65iH8k736QNhuUHm1tt8X7yJXpJ517HPPq8BrVdwring", // $RINGS
  ];
}

export interface Quote {
  inAmount: string;
  outAmount: string;
  minOut: string;
  impact: number;
  route: string[];
  accounts: number;
}

const feed = (m: string) => (m === SOL_MINT ? WSOL_MINT : m);

export async function quote(network: Network, inMint: string, outMint: string, amount: bigint, slippageBps: number): Promise<Quote> {
  if (network === "mainnet") {
    const res = await fetch(`${JUP}/swap/v1/quote?inputMint=${feed(inMint)}&outputMint=${feed(outMint)}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=false`);
    const q = (await res.json()) as { outAmount?: string; otherAmountThreshold?: string; priceImpactPct?: string; routePlan?: { swapInfo?: { label?: string; inputMint?: string; outputMint?: string } }[]; error?: string };
    if (!q.outAmount || !q.otherAmountThreshold) throw new Error(q.error ? `No route: ${q.error}` : "No route for this swap right now.");
    return {
      inAmount: amount.toString(),
      outAmount: q.outAmount,
      minOut: q.otherAmountThreshold,
      impact: Number(q.priceImpactPct ?? 0) * 100,
      route: [...new Set((q.routePlan ?? []).map((p) => p.swapInfo?.label).filter((l): l is string => Boolean(l)))],
      accounts: routeAccountsOf(
        (q.routePlan ?? []).map((p) => ({ inputMint: p.swapInfo?.inputMint ?? "", outputMint: p.swapInfo?.outputMint ?? "" })).filter((h) => h.inputMint && h.outputMint),
        feed(inMint),
      ),
    };
  }
  // Devnet: priced as the mainnet coins the stand-ins mirror, as the relayer fills them.
  const mainnetOf = (m: string) => (m === SOL_MINT ? WSOL_MINT : DEVNET_ALIASES[m]?.mainnet);
  const a = mainnetOf(inMint);
  const b = mainnetOf(outMint);
  if (!a || !b) throw new Error("On devnet, swap SOL and the devnet test coins only.");
  const prices = (await (await fetch(`${JUP}/price/v3?ids=${a},${b}`)).json()) as Record<string, { usdPrice?: number }>;
  const pin = prices[a]?.usdPrice;
  const pout = prices[b]?.usdPrice;
  if (!pin || !pout) throw new Error("No price for this pair right now.");
  const [din, dout] = await Promise.all([decimalsOf(network, inMint), decimalsOf(network, outMint)]);
  const out = BigInt(Math.floor((Number(amount) / 10 ** din) * (pin / pout) * 10 ** dout));
  const minOut = (out * BigInt(10_000 - slippageBps)) / 10_000n;
  return { inAmount: amount.toString(), outAmount: out.toString(), minOut: (minOut > 0n ? minOut : 1n).toString(), impact: 0, route: ["Rings devnet stock"], accounts: 2 };
}

export interface SwapAsk {
  inMint: string;
  outMint: string;
  amount: bigint;
  quote: Quote;
  slippageBps: number;
  deliver: "private" | "wallet";
  /** For "wallet": the address the coins go to. */
  to: string | null;
}

export interface SwapState {
  state: string;
  error?: string | null;
  outAmount?: string | null;
  swapSig?: string | null;
  deliverSig?: string | null;
  /** The swap's single-use key: it pays the delivery to a public address. */
  swapKey?: string | null;
}

export interface MadeSwap {
  id: string;
  payTo: string;
  payments: { mint: string; amount: string }[];
}

/** Base64 shielded address where private deliveries and refunds go. */
export const deliverToOf = (ctx: Ctx) => b64(keypairFromSeed(ctx.keys.accountSeed).shieldedAddress().toBytes());

/** Registers the swap with Rings; nothing is paid yet. */
export async function createSwap(ctx: Ctx, ask: SwapAsk): Promise<MadeSwap> {
  return api<MadeSwap>(ctx.network, "/api/dex/swaps", {
    body: {
      inputMint: feed(ask.inMint),
      outputMint: feed(ask.outMint),
      amount: ask.amount.toString(),
      minOut: ask.quote.minOut,
      slippageBps: ask.slippageBps,
      routeAccounts: ask.quote.accounts,
      deliver: ask.deliver,
      wallet: ask.deliver === "wallet" ? (ask.to ?? ctx.wallet) : undefined,
      deliverTo: deliverToOf(ctx),
    },
  });
}

/** Margin over Rings' costs figure, which is recomputed when the swap is made. */
const costsCeiling = (costs: bigint) => costs + costs / 4n + 1_000_000n;

/** Rings may ask only for the coin sold, exactly `units`, and SOL for costs within the ceiling; throws otherwise. */
export function checkPayments(payments: { mint: string; amount: string }[], inMint: string, units: bigint, maxCosts: bigint) {
  if (!Array.isArray(payments) || payments.length === 0 || payments.length > 2) throw new Error("Rings asked for an unexpected payment. Nothing was paid.");
  const total = new Map<string, bigint>();
  for (const p of payments) {
    if (typeof p?.mint !== "string" || typeof p?.amount !== "string" || !/^\d{1,20}$/.test(p.amount)) throw new Error("Rings asked for an unexpected payment. Nothing was paid.");
    total.set(p.mint, (total.get(p.mint) ?? 0n) + BigInt(p.amount));
  }
  const sol = total.get(SOL_MINT) ?? 0n;
  const ok =
    inMint === SOL_MINT
      ? total.size === 1 && sol > units && sol <= units + costsCeiling(maxCosts)
      : total.size === 2 && total.get(inMint) === units && sol > 0n && sol <= costsCeiling(maxCosts);
  if (!ok) throw new Error("Rings asked for more than this swap should cost. Nothing was paid.");
}

/** `slot` is "0" until the payment is known to have landed. */
export type Payment = { signature: string; slot: string };

/** Worst-case costs by the shared formula for the wallet's own quote: Rings' figure is never taken above it. */
export function costsCeilingOf(ask: { inMint: string; outMint: string; deliver: "private" | "wallet" }, routeAccounts: number): bigint {
  return costsFormula({
    inputSol: ask.inMint === SOL_MINT || ask.inMint === WSOL_MINT,
    outputSol: ask.outMint === SOL_MINT || ask.outMint === WSOL_MINT,
    deliver: ask.deliver,
    recipientNeedsAccount: true,
    newInterface: true,
    routeAccounts,
  }).price;
}

/** `onPaid` hears of each payment as it goes out, unconfirmed, so the swap can be finished whatever happens here. */
export async function paySwap(ctx: Ctx, made: MadeSwap, limits: { inMint: string; units: bigint; maxCosts: bigint; fee?: bigint }, onPaid: (paid: Payment[]) => Promise<void>): Promise<Payment[]> {
  checkPayments(made.payments, limits.inMint, limits.units, limits.maxCosts);
  // The fee must not go to Rings' pay-to address, where it would count as payment.
  if (made.payTo === TREASURY_RING_B64) throw new Error("Rings asked for an unexpected payment. Nothing was paid.");
  const to = ShieldedAddress.fromBytes(fromB64(made.payTo));
  const paid: Payment[] = [];
  // SOL for costs first: if the coin payment then fails, only that small part waits with Rings.
  const order = [...made.payments].sort((a, b) => (a.mint === SOL_MINT ? 0 : 1) - (b.mint === SOL_MINT ? 0 : 1));
  // The fee rides once, with the first payment of the coin sold: a split payment can't double it.
  let feeLeft = limits.fee ?? 0n;
  for (const p of order) {
    const fee = p.mint === limits.inMint ? feeLeft : 0n;
    feeLeft -= fee;
    let signature: string;
    try {
      signature = (await payPrivately(ctx, p.mint, BigInt(p.amount), to, (sig) => onPaid([...paid, { signature: sig, slot: "0" }]), fee)).signature;
    } catch (e) {
      // onPaid already heard of this payment: it stays listed only if it may have gone out.
      await onPaid(e instanceof MaybeSent ? [...paid, { signature: e.signature, slot: "0" }] : [...paid]);
      throw e;
    }
    paid.push({ signature, slot: "0" });
    await onPaid([...paid]);
    // The slot, for Rings' check; looked up again later if this fails.
    const status = await (await client(ctx.network)).solanaRpc.getSignatureStatuses([signature as never]).send().catch(() => null);
    const slot = status?.value[0]?.slot;
    if (slot) {
      paid[paid.length - 1] = { signature, slot: String(slot) };
      await onPaid([...paid]);
    }
  }
  return paid;
}

/** Retried on 409 (payments not yet seen on chain). Past its 10-minute window, Rings answers state "failed". */
export async function tellPaid(network: Network, id: string, paid: Payment[], tries = 26): Promise<{ ok?: boolean; state?: string }> {
  for (let i = 1; ; i++) {
    try {
      return await api<{ ok?: boolean; state?: string }>(network, `/api/dex/swaps/${encodeURIComponent(id)}`, { body: { action: "paid", payments: paid } });
    } catch (e) {
      if ((e as { status?: number }).status !== 409 || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

export const swapStatus = (network: Network, id: string) => api<SwapState>(network, `/api/dex/swaps/${encodeURIComponent(id)}`);

/** The swap's network costs in lamports, as Rings prices them. */
export async function swapCosts(ctx: Ctx, ask: Omit<SwapAsk, "quote"> & { accounts: number }): Promise<bigint> {
  const qs = new URLSearchParams({ in: feed(ask.inMint), out: feed(ask.outMint), deliver: ask.deliver, accounts: String(ask.accounts) });
  if (ask.deliver === "wallet") qs.set("wallet", ask.to ?? ctx.wallet);
  const j = await api<{ price?: string; error?: string }>(ctx.network, `/api/dex/costs?${qs}`);
  if (!j.price) throw new Error(j.error ?? "Rings couldn't price the swap.");
  return BigInt(j.price);
}

export { DEVNET_ALIASES };
