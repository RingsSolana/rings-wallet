// Devnet e2e: Chrome restarts between paying a swap and telling Rings; the wallet must report it on its own.
// Run: npx tsx test/e2e-swap-restart.ts (AGED=1: restart past Rings' 10-minute window). Spends ~0.012 devnet SOL.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountSecret, phraseSeed } from "../src/lib/keys";
import { DEVNET_ALIASES, SOL_MINT } from "../src/lib/net";
import { ctxFor } from "../src/lib/rings";
import { ensureSession } from "../src/lib/session";
import { createSwap, deliverToOf, paySwap, quote, swapCosts, swapStatus } from "../src/lib/swap";

const jar = new Map<string, string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(init.headers);
  const c = jar.get(url.host);
  if (c) headers.set("cookie", c);
  const res = await realFetch(input, { ...init, headers });
  for (const sc of res.headers.getSetCookie()) jar.set(url.host, sc.split(";")[0]);
  return res;
}) as typeof fetch;

const root = new URL("..", import.meta.url);
const rootPath = decodeURIComponent(root.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const puppeteer = createRequire(new URL("../../brand/video/package.json", import.meta.url))("puppeteer-core");
const dist = join(rootPath, "dist");
const cft = join(rootPath, ".devdata/chrome/chrome");
const chromePath = join(cft, readdirSync(cft).find((d) => d.startsWith("win64-"))!, "chrome-win64", "chrome.exe");
const phrase = readFileSync(join(rootPath, ".devdata/devnet-phrase.txt"), "utf8").trim();
const EXT = "polncinkggpfflechknjkjokigacghgj";
const PASSWORD = "restart-test-password-1";
const TEST1 = Object.keys(DEVNET_ALIASES)[0];
const AGED = process.env.AGED === "1";

let failures = 0;
const check = (ok: boolean, label: string, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isWorker = (t: { type: () => string; url: () => string }) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${EXT}/`);
const profile = mkdtempSync(join(tmpdir(), "rings-swap-restart-"));
const launch = () =>
  puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    userDataDir: profile,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-first-run", "--no-default-browser-check"],
    targetFilter: (t: { type: () => string; url: () => string }) => !isWorker(t),
  });
type Page = { goto: (u: string) => Promise<unknown>; evaluate: <T>(f: (...a: never[]) => T, ...args: unknown[]) => Promise<T>; close: () => Promise<void> };
const extPage = async (browser: { newPage: () => Promise<Page> }) => {
  const p = await browser.newPage();
  await p.goto(`chrome-extension://${EXT}/onboarding.html`);
  return p;
};
const bgOn = (p: Page) => (msg: unknown) => p.evaluate(((m: unknown) => chrome.runtime.sendMessage(m)) as never, msg) as Promise<{ ok: boolean; data?: any; error?: string; code?: string }>;

let browser = await launch();
try {
  // 1. Create the wallet and sign in to devnet Rings through a too-big swap, refused with nothing paid.
  for (let i = 0; i < 40; i++) {
    const targets = (await (await browser.target().createCDPSession()).send("Target.getTargets")).targetInfos as { type: string; url: string }[];
    if (targets.some((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${EXT}/`))) break;
    await sleep(500);
  }
  let ext = await extPage(browser);
  let bg = bgOn(ext);
  const made0 = await bg({ type: "create", phrase, password: PASSWORD });
  check(!!made0?.ok, "wallet created");
  const account = made0.data.accounts[0].id as string;
  const signIn = await bg({ type: "swap", from: "private", inMint: SOL_MINT, outMint: TEST1, amount: "100000", slippageBps: 300, receiveInto: "private" });
  check(!signIn.ok && signIn.code === "short", "signed in to Rings (a too-big swap, refused before paying)", signIn.error);

  // 2. Pay a swap with the wallet's own code without telling Rings, as if Chrome closed right after paying.
  const ctx = ctxFor("devnet", accountSecret(phraseSeed(phrase), 0));
  await ensureSession(ctx);
  const units = 2_000_000n;
  const q = await quote("devnet", SOL_MINT, TEST1, units, 300);
  const ask = { inMint: SOL_MINT, outMint: TEST1, amount: units, quote: q, slippageBps: 300, deliver: "private" as const, to: null };
  const costs = await swapCosts(ctx, { ...ask, accounts: q.accounts });
  const made = await createSwap(ctx, ask);
  const paid = await paySwap(ctx, made, { inMint: SOL_MINT, units, maxCosts: costs }, async () => undefined);
  const pending = { id: made.id, network: "devnet", account, outMint: TEST1, outSym: "TEST1", outDecimals: 9, balance: "private", at: Date.now(), payments: made.payments.length, paid, deliverTo: deliverToOf(ctx), to: null };
  await ext.evaluate(((p: unknown) => chrome.storage.local.get("swaps").then((r) => chrome.storage.local.set({ swaps: [p, ...((r.swaps as unknown[]) ?? [])] }))) as never, pending);
  check((await swapStatus("devnet", made.id)).state === "quoted", "paid, and Rings hasn't heard", made.id.slice(0, 8));
  if (AGED) {
    // Age the swap past Rings' window; any next createSwap runs the tidy-up that marks it unpaid.
    const pg = createRequire(new URL("../../web/package.json", import.meta.url))("pg");
    const dbUrl = readFileSync(join(rootPath, "../web/.env.devnet.local"), "utf8").match(/^DATABASE_URL=(.*)$/m)![1].trim().replace(/^["']|["']$/g, "");
    const db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query("update dex_swaps set created_at = now() - interval '11 minutes' where id = $1", [made.id]);
    await db.end();
    await createSwap(ctx, ask);
    await sleep(3000);
    const st = await swapStatus("devnet", made.id);
    check(st.state === "failed" && st.error === "Not paid in time.", "closed past Rings' 10 minutes: Rings marked it unpaid", `${st.state}: ${st.error}`);
  }

  // 3. Restart Chrome and touch nothing.
  await browser.close();
  const t0 = Date.now();
  browser = await launch();
  if (AGED) {
    // Rings never takes a late "paid", so the wallet must close the swap at once and keep its payment signatures.
    ext = await extPage(browser);
    bg = bgOn(ext);
    await bg({ type: "unlock", password: PASSWORD });
    type Row = { kind: string; status: string; at: number; signature?: string; linked?: string[]; error?: string };
    let row: Row | undefined;
    for (let i = 0; i < 40 && !row; i++) {
      await sleep(3000);
      await bg({ type: "swapStatus", id: made.id });
      row = (((await bg({ type: "history" })).data ?? []) as Row[]).find((h) => h.kind === "swapped" && h.at >= pending.at - 60_000);
    }
    const took = Math.round((Date.now() - t0) / 1000);
    const sigs = [row?.signature, ...(row?.linked ?? [])];
    check(
      row?.status === "failed" && /contact Rings with this transaction/.test(row?.error ?? "") && paid.every((p) => sigs.includes(p.signature)),
      "past Rings' 10 minutes: the wallet closed the swap at once, keeping every payment's signature",
      `${row?.status ?? "no row"} after ${took} s: ${row?.error ?? ""}`,
    );
    const swaps = await ext.evaluate((() => chrome.storage.local.get("swaps").then((r) => ((r.swaps as { id: string }[]) ?? []).map((s) => s.id))) as never) as string[];
    check(!swaps.includes(made.id), "and stopped following it");
    throw Object.assign(new Error("aged case done"), { done: true });
  }
  let state = "quoted";
  let error: string | null | undefined = null;
  // Settled: done, delivered, refunded, or failed for a reason other than the 10-minute timeout.
  const settled = () => ["done", "delivered", "refunded"].includes(state) || (state === "failed" && error !== "Not paid in time.");
  for (let i = 0; i < 60 && !settled(); i++) {
    await sleep(3000);
    ({ state, error } = await swapStatus("devnet", made.id));
  }
  const took = Math.round((Date.now() - t0) / 1000);
  check(state === "done" || state === "delivered", "after the restart the wallet told Rings by itself, and the swap finished", `${state} after ${took} s`);

  // 4. Unlock (the restart locked the wallet) and check that Activity shows the swap once.
  ext = await extPage(browser);
  bg = bgOn(ext);
  await bg({ type: "unlock", password: PASSWORD });
  await bg({ type: "swapStatus", id: made.id });
  const history = ((await bg({ type: "history" })).data ?? []) as { kind: string; status: string; at: number }[];
  const entries = history.filter((h) => h.kind === "swapped" && h.at >= pending.at - 60_000);
  check(entries.length === 1 && entries[0].status === "done", "Activity shows the swap once", entries.map((h) => h.status).join(", ") || "none");
} catch (e) {
  if (!(e as { done?: boolean }).done) {
    failures++;
    console.log("FAIL", (e as Error).message);
  }
} finally {
  await browser.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
