// Popup: drives the generated src/design screens. Keys never reach this page; the background signs everything.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import WalletHome from "../design/WalletHome";
import WalletSend, { WalletSendDesign } from "../design/WalletSend";
import WalletSwap from "../design/WalletSwap";
import WalletMore from "../design/WalletMore";
import WalletTokens from "../design/WalletTokens";
import { bg, BgError } from "./bg";
import { qrSvg } from "./qr";
import { SOL_MINT, type Network, type Product, type TokenRow } from "../lib/net";
import { maxWithFee } from "../lib/fee";
import type { CachedBalances, Done, FeesView, HistoryItem, PrivateView, Shortfall, SwapQuoteView, SwapView, TokenOption, WalletState } from "../lib/protocol";
import "./base.css";

declare const __RELEASE__: boolean | undefined;
const askedBy = new URLSearchParams(location.search).get("from");
if (location.hash === "#unlock" && askedBy) document.title = `Rings Wallet: unlock for ${askedBy}`;

const RELEASE = typeof __RELEASE__ !== "undefined" && __RELEASE__;

// Real, scannable QR codes on the Receive screen.
(WalletSendDesign as unknown as { qr: (text: string) => React.ReactElement }).qr = qrSvg;

type View = "public" | "private";
type MoreTab = "products" | "activity" | "settings";
type Step = "form" | "review" | "working" | "done" | "failed";
type Screen =
  | { kind: "home" }
  | { kind: "send" | "move" | "receive"; view: View }
  | { kind: "swap" }
  | { kind: "more"; tab: MoreTab };
type Picking = null | "flow" | "swapPay" | "swapReceive";

interface ReviewPayload {
  flow: "send" | "move";
  from: View;
  to: string | null;
  direction: "toPrivate" | "toPublic";
  destination: "wallet" | "other";
  token: string;
  amount: string;
}

interface FlowToken {
  mint: string;
  sym: string;
  name: string;
  price: number;
  public: number;
  private: number;
  icon: string | null;
}

const designToken = (t: TokenRow) => ({ sym: t.sym, name: t.name, amount: t.amount, price: t.price, change: t.change, icon: t.icon });
const usd = (n: number) => (n > 0 ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "");
const amt = (n: number) => (n ? n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 4 }) : "0");

const NETWORK_FEE_LAMPORTS = 5_000n;

/** Both balances by mint, SOL first, as sendable amounts: net of the Rings fee and, for public SOL, the network fee. */
function flowTokens(pub: TokenRow[] | null, priv: TokenRow[] | null): FlowToken[] {
  const by = new Map<string, FlowToken>();
  const add = (r: TokenRow, side: View) => {
    const t = by.get(r.mint) ?? { mint: r.mint, sym: r.sym, name: r.name, price: r.price, public: 0, private: 0, icon: r.icon ?? null };
    let units: bigint;
    try {
      units = BigInt(r.units);
    } catch {
      units = 0n;
    }
    const base = r.mint === SOL_MINT && side === "public" ? units - NETWORK_FEE_LAMPORTS : units;
    t[side] = Number(maxWithFee(base > 0n ? base : 0n)) / 10 ** r.decimals;
    by.set(r.mint, t);
  };
  (pub ?? []).forEach((r) => add(r, "public"));
  (priv ?? []).forEach((r) => add(r, "private"));
  if (!by.has(SOL_MINT)) by.set(SOL_MINT, { mint: SOL_MINT, sym: "SOL", name: "Solana", price: 0, public: 0, private: 0, icon: null });
  return [...by.values()].sort((a, b) => (a.mint === SOL_MINT ? -1 : b.mint === SOL_MINT ? 1 : b.price * (b.public + b.private) - a.price * (a.public + a.private)));
}

function ago(at: number): string {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return "Yesterday";
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function App() {
  const [st, setSt] = useState<WalletState | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "home" });
  const [view, setView] = useState<View>("public");
  const [wrongPassword, setWrongPassword] = useState(false);
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [priv, setPriv] = useState<PrivateView | null>(null);
  // True once a live private answer lands; until then Home shows the private balance as updating.
  const [privLive, setPrivLive] = useState(false);
  const [privError, setPrivError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [words, setWords] = useState<string[] | null>(null);
  const [phraseWrong, setPhraseWrong] = useState(false);
  const [step, setStep] = useState<Step>("form");
  const [workingStep, setWorkingStep] = useState(1);
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [fees, setFees] = useState<FeesView | null>(null);
  const [flowMint, setFlowMint] = useState(SOL_MINT);
  const [usesRings, setUsesRings] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [failReason, setFailReason] = useState("");
  const [picking, setPicking] = useState<Picking>(null);
  const [pickQuery, setPickQuery] = useState("");
  const [found, setFound] = useState<TokenOption[] | null>(null);
  const [payFrom, setPayFrom] = useState<View>("private");
  const [payMint, setPayMint] = useState(SOL_MINT);
  const [receive, setReceive] = useState<TokenOption | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [receiveInto, setReceiveInto] = useState<"private" | "wallet" | "other">("private");
  const choosePayFrom = (v: View) => {
    setPayFrom(v);
    setReceiveInto((r) => (r === "other" ? r : v === "public" ? "wallet" : "private"));
  };
  const [otherAddress, setOtherAddress] = useState("");
  const [slippage, setSlippage] = useState(0.5);
  const [quote, setQuote] = useState<SwapQuoteView | null>(null);
  const [quoteState, setQuoteState] = useState<"idle" | "loading" | "ready" | "none" | "error">("idle");
  const [topUpState, setTopUpState] = useState<"idle" | "working" | "waiting" | "failed">("idle");
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [sendAmount, setSendAmount] = useState("");
  const [sendFrom, setSendFrom] = useState<View>("public");
  const [sendShort, setSendShort] = useState<Shortfall | null>(null);
  const [swapOut, setSwapOut] = useState("");
  const [sites, setSites] = useState<{ domain: string; fresh: boolean; address: string; balance?: string }[]>([]);
  const [fundTo, setFundTo] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quoteSeq = useRef(0);
  // Derived locally: Receive never waits on a sync, and never falls back to the design's sample address.
  const [privAddr, setPrivAddr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await bg<WalletState>({ type: "state" });
    setSt(s);
    return s;
  }, []);

  // network:account the balances on screen belong to; stillShown drops late answers asked for another one.
  const shownFor = useRef("");
  const stillShown = useCallback(<T,>(apply: (v: T) => void) => {
    const asked = shownFor.current;
    return (v: T) => {
      if (shownFor.current === asked) apply(v);
    };
  }, []);

  const loadBalances = useCallback(() => {
    bg<TokenRow[]>({ type: "balances" }).then(stillShown(setTokens), stillShown(() => setTokens((t) => t ?? [])));
    setPrivError(null);
    bg<PrivateView>({ type: "privateBalances" }).then(
      stillShown((v: PrivateView) => {
        setPriv(v);
        setPrivLive(true);
      }),
      stillShown((e: Error) => setPrivError(e.message)),
    );
  }, [stillShown]);

  // Only user input defers the auto-lock (throttled); the timed reads must not, so an idle open popup still locks.
  useEffect(() => {
    let last = 0;
    const used = () => {
      if (Date.now() - last < 30_000) return;
      last = Date.now();
      void bg({ type: "touch" }).catch(() => undefined);
    };
    window.addEventListener("pointerdown", used, true);
    window.addEventListener("keydown", used, true);
    return () => {
      window.removeEventListener("pointerdown", used, true);
      window.removeEventListener("keydown", used, true);
    };
  }, []);
  const lockedNow = useCallback((e: unknown) => {
    if (e instanceof BgError && e.code === "locked") void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh().then((s) => {
      if (!s.hasVault) {
        void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
        window.close();
      }
    });
  }, [refresh]);

  useEffect(() => {
    if (!st?.unlocked) return;
    shownFor.current = `${st.network}:${st.activeId}`;
    setTokens(null);
    setPriv(null);
    setPrivLive(false);
    setReceive(null);
    setPrivAddr(null);
    bg<string>({ type: "privateAddress" }).then(stillShown(setPrivAddr), stillShown(() => setPrivAddr(null)));
    // Cached balances (in memory until lock) show at once; they only fill empty slots, never replacing live rows.
    bg<CachedBalances | undefined>({ type: "cachedBalances" }).then(
      stillShown((c: CachedBalances | undefined) => {
        if (c?.balances) setTokens((t) => t ?? c.balances);
        if (c?.privateBalances) setPriv((p) => p ?? c.privateBalances);
      }),
      () => undefined,
    );
    loadBalances();
  }, [st?.unlocked, st?.network, st?.activeId, loadBalances, stillShown]);

  // Public balances every tick, private every 6th: the private sync is heavy and the proxy rate-limits it.
  useEffect(() => {
    if (!st?.unlocked) return;
    let ticks = 0;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      ticks++;
      bg<TokenRow[]>({ type: "balances" }).then(stillShown(setTokens), lockedNow);
      if (ticks % 6 === 0) {
        bg<PrivateView>({ type: "privateBalances" }).then(
          stillShown((v: PrivateView) => {
            setPriv(v);
            setPrivLive(true);
            setPrivError(null);
          }),
          lockedNow,
        );
      }
    }, 10_000);
    return () => clearInterval(id);
  }, [st?.unlocked, st?.network, st?.activeId, stillShown]);

  const onActivity = screen.kind === "more" && screen.tab === "activity";
  useEffect(() => {
    if (!onActivity) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") bg<HistoryItem[]>({ type: "history" }).then(setHistory, lockedNow);
    }, 3_000);
    return () => clearInterval(id);
  }, [onActivity]);

  useEffect(() => {
    if (picking !== "swapReceive" && !(screen.kind === "swap" && !receive)) return;
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const ask = (attempt: number) => {
      bg<TokenOption[]>({ type: "searchTokens", query: picking === "swapReceive" ? pickQuery : "" }).then(
        (list) => {
          if (!live) return;
          setFound(list);
          if (!receive) setReceive(list.find((x) => x.mint !== SOL_MINT) ?? null);
          // The server fetches new coins' icons in the background: retry while any are missing.
          if (attempt < 3 && list.some((x) => !x.icon)) retry = setTimeout(() => ask(attempt + 1), [3000, 5000, 7000][attempt]);
        },
        () => live && attempt === 0 && setFound([]),
      );
    };
    const t = setTimeout(() => ask(0), 300);
    return () => {
      live = false;
      clearTimeout(t);
      clearTimeout(retry);
    };
  }, [picking, pickQuery, screen.kind, receive]);

  useEffect(() => {
    if (!receive || receive.icon || !found) return;
    const withIcon = found.find((x) => x.mint === receive.mint && x.icon);
    if (withIcon) setReceive({ ...receive, icon: withIcon.icon });
  }, [found]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (screen.kind !== "swap" || !receive || !Number(payAmount) || payMint === receive.mint) {
      setQuote(null);
      setQuoteState("idle");
      return;
    }
    const seq = ++quoteSeq.current;
    setQuoteState("loading");
    const t = setTimeout(() => {
      bg<SwapQuoteView>({
        type: "swapQuote",
        inMint: payMint,
        outMint: receive.mint,
        amount: payAmount,
        slippageBps: Math.round(slippage * 100),
        from: payFrom,
        receiveInto,
        to: otherAddress,
      }).then(
        (q) => {
          if (seq !== quoteSeq.current) return;
          setQuote(q);
          setQuoteState("ready");
        },
        (e: Error) => {
          if (seq !== quoteSeq.current) return;
          setQuote(null);
          setQuoteState(/no route|no price|only/i.test(e.message) ? "none" : "error");
        },
      );
    }, 450);
    return () => clearTimeout(t);
  }, [screen.kind, receive, payMint, payAmount, slippage, payFrom, receiveInto, otherAddress, quoteNonce]);

  // Requote periodically so the terms on screen stay close to what Confirm executes; the background refuses worse ones.
  useEffect(() => {
    if (screen.kind !== "swap") return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && step !== "working" && step !== "done") setQuoteNonce((n) => n + 1);
    }, 15_000);
    return () => clearInterval(id);
  }, [screen.kind, step]);

  useEffect(() => {
    if (screen.kind !== "send" || sendFrom !== "private" || !Number(sendAmount)) {
      setSendShort(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      bg<Shortfall | null>({ type: "shortfall", mint: flowMint, amount: sendAmount }).then(
        (s) => live && setSendShort(s),
        () => live && setSendShort(null),
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [screen.kind, sendFrom, sendAmount, flowMint, quoteNonce]);

  const topUp = async (s: Shortfall | null | undefined) => {
    if (!s || topUpState === "working" || topUpState === "waiting") return;
    setTopUpState("working");
    try {
      const { target } = await bg<{ target: { mint: string; units: string }[] }>({ type: "topUp", needs: s.needs });
      setTopUpState("waiting");
      // Each check syncs the private balance through the rate-limited proxy: poll slowly.
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        if (await bg<boolean>({ type: "privateHas", target }).catch(() => false)) break;
      }
      loadBalances();
      setQuoteNonce((n) => n + 1);
      setTopUpState("idle");
    } catch {
      setTopUpState("failed");
    }
  };

  if (!st || !st.hasVault) return null;

  const run = (p: Promise<unknown>) => p.then(refresh, refresh);
  const go = (s: Screen) => {
    setStep("form");
    setReview(null);
    setDone(null);
    setFailReason("");
    setFlowMint(SOL_MINT);
    setUsesRings(false);
    setPicking(null);
    setPickQuery("");
    setFundTo("");
    setSendAmount("");
    setSendShort(null);
    setTopUpState("idle");
    if (s.kind === "send" || s.kind === "move" || s.kind === "receive") setSendFrom(s.view);
    if (s.kind === "more" && s.tab === "activity") bg<HistoryItem[]>({ type: "history" }).then(setHistory, () => setHistory([]));
    if (s.kind === "more") bg<typeof sites>({ type: "sites" }).then(setSites, () => setSites([]));
    setScreen(s);
  };
  const home = () => go({ kind: "home" });
  const tab = (k: string) => {
    if (k === "wallet") home();
    else if (k === "swap") {
      choosePayFrom(view);
      go({ kind: "swap" });
    } else if (k === "products" || k === "activity" || k === "settings") go({ kind: "more", tab: k });
  };

  if (!st.unlocked) {
    return (
      <WalletHome
        locked
        network={st.network}
        wrongPassword={wrongPassword}
        onUnlock={async (password: string) => {
          try {
            await bg({ type: "unlock", password });
            setWrongPassword(false);
            // Unlock window opened for a site's request: the request continues in its own window.
            if (location.hash === "#unlock") return window.close();
            setScreen({ kind: "home" });
            await refresh();
          } catch (e) {
            if (e instanceof BgError && e.code === "wrongPassword") setWrongPassword(true);
          }
        }}
        onForgotPassword={() => void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html#restore") })}
      />
    );
  }

  const account = st.accounts.find((a) => a.id === st.activeId) ?? st.accounts[0];
  const list = flowTokens(tokens, priv?.rows ?? null);
  const tokenOf = (mint: string) => list.find((t) => t.mint === mint) ?? list[0];
  const designFlowToken = (t: FlowToken) => ({ sym: t.sym, name: t.name, price: t.price, public: t.public, private: t.private, icon: t.icon });
  const common = { network: st.network, accountName: account.name, publicAddress: account.address, privateAddress: privAddr ?? priv?.address ?? "Loading your private address…" };

  const fail = (e: unknown) => {
    if (timer.current) clearTimeout(timer.current);
    setFailReason(e instanceof Error ? e.message : String(e));
    setStep("failed");
  };

  if (picking) {
    const side: View = picking === "swapPay" ? payFrom : screen.kind === "send" || screen.kind === "move" ? screen.view : "public";
    const rows =
      picking === "swapReceive"
        ? (found ?? []).map((t) => ({ mint: t.mint, sym: t.sym, name: t.name, icon: t.icon, balance: amt(tokenOf(t.mint)?.mint === t.mint ? tokenOf(t.mint)[side] : 0), value: "" }))
        : list.map((t) => ({ mint: t.mint, sym: t.sym, name: t.name, icon: t.icon, balance: amt(t[side]), value: usd(t[side] * t.price) }));
    return (
      <WalletTokens
        title={picking === "swapReceive" ? "Choose a token to get" : "Choose a token"}
        query={pickQuery}
        loading={picking === "swapReceive" && found === null}
        tokens={rows}
        selected={picking === "swapReceive" ? (receive?.mint ?? "") : picking === "swapPay" ? payMint : flowMint}
        onQueryChange={(q: string) => setPickQuery(q)}
        onClose={() => setPicking(null)}
        onSelect={(mint: string) => {
          if (picking === "swapReceive") setReceive((found ?? []).find((t) => t.mint === mint) ?? receive);
          else if (picking === "swapPay") setPayMint(mint);
          else setFlowMint(mint);
          setPicking(null);
          setPickQuery("");
        }}
      />
    );
  }

  const onReview = async (p: ReviewPayload) => {
    setReview(p);
    setFees(null);
    if (p.flow === "send" && p.to) {
      try {
        const kind = await bg<"public" | "private" | "invalid">({ type: "classify", to: String(p.to) });
        if (kind === "invalid") return fail(new Error("That isn't a Solana address or a Rings private address."));
        setUsesRings(kind === "private");
      } catch (e) {
        return fail(e);
      }
    }
    // No Confirm without both fees on screen: the store listing and privacy policy promise it.
    try {
      const to = p.flow === "send" ? String(p.to ?? "") : p.direction === "toPublic" && p.destination === "other" ? p.to : null;
      setFees(await bg<FeesView>({ type: "reviewCosts", flow: p.flow, from: p.from, direction: p.direction, mint: flowMint, amount: String(p.amount), to }));
    } catch (e) {
      return fail(e);
    }
    setStep("review");
  };

  const onConfirm = async () => {
    if (!review) return;
    setStep("working");
    setWorkingStep(1);
    timer.current = setTimeout(() => setWorkingStep(2), 1500);
    try {
      const result =
        review.flow === "send"
          ? await bg<Done>({ type: "send", from: review.from, mint: flowMint, amount: String(review.amount), to: String(review.to ?? "") })
          : await bg<Done>({
              type: "move",
              direction: review.direction,
              mint: flowMint,
              amount: String(review.amount),
              to: review.direction === "toPublic" && review.destination === "other" ? review.to : null,
            });
      if (timer.current) clearTimeout(timer.current);
      setWorkingStep(3);
      setDone(result);
      setStep("done");
      loadBalances();
    } catch (e) {
      fail(e);
    }
  };

  const onSwapConfirm = async () => {
    if (!receive) return;
    setStep("working");
    setWorkingStep(1);
    try {
      const { id } = await bg<{ id: string }>({
        type: "swap",
        from: payFrom,
        inMint: payMint,
        outMint: receive.mint,
        amount: payAmount,
        slippageBps: Math.round(slippage * 100),
        receiveInto,
        to: receiveInto === "other" ? otherAddress : null,
        reviewed: quote?.minOutUnits && quote.costsUnits ? { minOutUnits: quote.minOutUnits, costsUnits: quote.costsUnits, impactPct: quote.impactPct } : undefined,
      });
      // Status reads only observe: a missed answer is retried, the swap carries on server-side.
      let misses = 0;
      for (;;) {
        let s: SwapView;
        try {
          s = await bg<SwapView>({ type: "swapStatus", id });
          misses = 0;
        } catch {
          if (++misses > 20) return fail(new Error("Lost touch with Rings for a while. The swap keeps going: check Activity."));
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        setWorkingStep(s.step);
        if (s.finished === "done") {
          setSwapOut(s.out ?? quote?.out ?? "");
          setDone({ signature: "", url: s.url ?? "" });
          setStep("done");
          loadBalances();
          return;
        }
        if (s.finished === "failed") return fail(new Error(s.error ?? "The swap didn't go through."));
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (e) {
      // Costs or price moved against the quote (short / requote): nothing is paid; back to the form for a fresh quote.
      if (e instanceof BgError && (e.code === "short" || e.code === "requote")) {
        setStep("form");
        setQuoteNonce((n) => n + 1);
        return;
      }
      fail(e);
    }
  };

  const payToken = tokenOf(payMint);

  switch (screen.kind) {
    case "home":
      return (
        <WalletHome
          locked={false}
          view={view}
          network={st.network}
          accountName={account.name}
          address={account.address}
          publicTokens={(tokens ?? []).map(designToken)}
          privateTokens={(priv?.rows ?? []).map(designToken)}
          syncing={view === "private" && !privLive && !privError}
          privateError={privError}
          onRetryPrivate={loadBalances}
          onViewChange={(k: View) => setView(k)}
          onSend={(v: View) => go({ kind: "send", view: v })}
          onReceive={(v: View) => go({ kind: "receive", view: v })}
          onSwap={(v: View) => {
            choosePayFrom(v);
            go({ kind: "swap" });
          }}
          onMove={(v: View) => go({ kind: "move", view: v })}
          onTab={tab}
          onSettings={() => go({ kind: "more", tab: "settings" })}
          onAccount={() => go({ kind: "more", tab: "settings" })}
        />
      );
    case "receive":
      return <WalletSend {...common} flow="receive" from={screen.view} onBack={home} onDone={home} />;
    case "send":
    case "move":
      return (
        <WalletSend
          {...common}
          flow={screen.kind}
          from={screen.view}
          direction={screen.view === "private" ? "toPublic" : "toPrivate"}
          step={step}
          workingStep={workingStep}
          to=""
          amount=""
          otherAddress={screen.kind === "move" ? fundTo : ""}
          destination={screen.kind === "move" && fundTo ? "other" : "wallet"}
          recents={[]}
          recipientUsesRings={usesRings}
          ringsFee={fees?.ringsFee ?? ""}
          networkFee={fees?.networkFee ?? ""}
          networkFeeNote={fees?.networkFeeNote ?? ""}
          token={designFlowToken(tokenOf(flowMint))}
          txUrl={done?.url ?? ""}
          failReason={failReason}
          onToChange={(text: string) => {
            const t = String(text ?? "").trim();
            if (t.length < 60) return setUsesRings(false);
            bg<"public" | "private" | "invalid">({ type: "classify", to: t }).then((k) => setUsesRings(k === "private"), () => setUsesRings(false));
          }}
          onAmountChange={(text: string) => setSendAmount(String(text ?? ""))}
          onFromChange={(v: View) => setSendFrom(v)}
          shortfall={screen.kind === "send" && sendFrom === "private" ? (sendShort?.label ?? "") : ""}
          topUpState={topUpState === "idle" && sendShort && !sendShort.publicOk ? "unavailable" : topUpState}
          onTopUp={() => void topUp(sendShort)}
          onPickToken={() => setPicking("flow")}
          onReview={(p: ReviewPayload) => void onReview(p)}
          onConfirm={() => void onConfirm()}
          onRetry={() => setStep("form")}
          onBack={() => (step === "review" ? setStep("form") : home())}
          onCancel={home}
          onDone={home}
        />
      );
    case "swap":
      return (
        <WalletSwap
          network={st.network}
          step={step}
          workingStep={workingStep}
          payFrom={payFrom}
          receiveInto={receiveInto}
          slippage={slippage}
          payAmount={payAmount}
          otherAddress={otherAddress}
          payToken={designFlowToken(payToken)}
          receiveToken={receive ? { sym: receive.sym, name: receive.name, price: receive.price, icon: receive.icon } : { sym: "…", name: "Choose a token", price: 0, icon: null }}
          quoteOut={step === "done" ? swapOut : (quote?.out ?? "")}
          quoteState={quoteState}
          minReceived={quote ? `${quote.minOut} ${receive?.sym ?? ""}` : ""}
          networkCost={quote?.costs ?? ""}
          ringsFee={quote?.ringsFee ?? ""}
          networkFee={quote?.networkFee ?? ""}
          networkFeeNote={quote?.networkFeeNote ?? ""}
          shortfall={payFrom === "private" ? (quote?.shortfall?.label ?? "") : ""}
          topUpState={topUpState === "idle" && quote?.shortfall && !quote.shortfall.publicOk ? "unavailable" : topUpState}
          onTopUp={() => void topUp(quote?.shortfall)}
          impactPct={quote?.impactPct ?? 0}
          route={quote?.route?.length ? [payToken.sym, ...quote.route, receive?.sym ?? ""] : [payToken.sym, receive?.sym ?? ""]}
          txUrl={done?.url ?? ""}
          failReason={failReason}
          onPayAmountChange={(text: string) => setPayAmount(String(text ?? ""))}
          onPayFromChange={(v: View) => choosePayFrom(v)}
          onReceiveIntoChange={(k: "private" | "wallet" | "other") => setReceiveInto(k)}
          onSlippageChange={(v: number | string) => {
            const n = Number(v);
            if (n > 0 && n <= 50) setSlippage(n);
          }}
          onPickPayToken={() => setPicking("swapPay")}
          onPickReceiveToken={() => {
            setFound(null);
            setPicking("swapReceive");
          }}
          onFlip={() => {
            if (!receive) return;
            const nextPay = receive.mint;
            const old = tokenOf(payMint);
            setReceive({ mint: old.mint, sym: old.sym, name: old.name, icon: old.icon, price: old.price });
            setPayMint(nextPay);
          }}
          onReview={(p: { otherAddress?: string | null }) => {
            if (p?.otherAddress) setOtherAddress(String(p.otherAddress));
            setStep("review");
          }}
          onConfirm={() => void onSwapConfirm()}
          onRetry={() => setStep("form")}
          onBack={() => (step === "review" ? setStep("form") : home())}
          onCancel={home}
          onDone={() => {
            setPayAmount("");
            home();
          }}
          onTab={tab}
        />
      );
    case "more":
      return (
        <WalletMore
          tab={screen.tab}
          network={st.network}
          networkChoice={!RELEASE}
          version={st.version}
          autoLock={st.autoLockMin}
          accounts={st.accounts.map((a) => ({ id: a.id, name: a.name, address: a.address }))}
          activeAccount={account.id}
          sites={sites.map((x) => ({ domain: x.domain, fresh: x.fresh, address: x.address, balance: x.balance ?? "" }))}
          onCopySiteAddress={(a: string) => void navigator.clipboard?.writeText(a).catch(() => undefined)}
          onFundSite={(domain: string) => {
            const site = sites.find((x) => x.domain === domain);
            if (!site) return;
            go({ kind: "move", view: "private" });
            setFundTo(site.address);
          }}
          onDisconnectSite={(domain: string) => bg<typeof sites>({ type: "disconnectSite", domain }).then(setSites, () => undefined)}
          // The design labels any row without a who as Private, so public rows get "Public".
          activity={history.map((h) => ({ id: h.id, kind: h.kind, balance: h.balance, who: h.who ?? (h.balance === "public" ? "Public" : null), amount: h.amount, sym: h.sym, time: ago(h.at), status: h.status }))}
          activityEmpty={history.length === 0}
          words={words ?? []}
          phraseRevealed={!!words}
          wrongPassword={phraseWrong}
          onTab={tab}
          onOpenProduct={(p: Product) => void bg({ type: "openProduct", product: p }).catch(() => undefined)}
          onActivity={(id: string) => {
            const h = history.find((x) => x.id === id);
            if (h?.signature) void chrome.tabs.create({ url: `https://solscan.io/tx/${h.signature}${h.network === "devnet" ? "?cluster=devnet" : ""}` });
          }}
          onAutoLockChange={(m: number) => run(bg({ type: "setAutoLock", minutes: m }))}
          onNetworkChange={(n: Network) => run(bg({ type: "setNetwork", network: n }))}
          onSelectAccount={(id: string) => run(bg({ type: "setActive", id }))}
          onAddAccount={() => run(bg({ type: "addAccount" }))}
          onRenameAccount={(id: string, name: string) => run(bg({ type: "renameAccount", id, name }))}
          onRevealPhrase={async (password: string) => {
            try {
              setWords(await bg<string[]>({ type: "revealPhrase", password }));
              setPhraseWrong(false);
            } catch {
              setPhraseWrong(true);
            }
          }}
          onSettingsPage={(p: string) => {
            if (p !== "phrase") setWords(null);
          }}
          onBack={() => {
            setWords(null);
            home();
          }}
          onLock={() => run(bg({ type: "lock" }))}
        />
      );
  }
}

createRoot(document.getElementById("root")!).render(<App />);
