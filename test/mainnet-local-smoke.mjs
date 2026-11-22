// Read-only mainnet smoke test, sends nothing: dist/ and a new empty wallet on local rings.run (npm run dev, :3100).
// Run: node test/mainnet-local-smoke.mjs. Checks balances, the private balance, a swap quote and a Products sign-in.
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const puppeteer = createRequire(join(root, "../brand/video/package.json"))("puppeteer-core");
const cft = join(root, ".devdata/chrome/chrome");
const chromePath = join(cft, readdirSync(cft).find((d) => d.startsWith("win64-")), "chrome-win64", "chrome.exe");
const dist = join(root, "dist");
const EXT = "polncinkggpfflechknjkjokigacghgj";
const SOL = "11111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let failures = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};

const profile = mkdtempSync(join(tmpdir(), "rings-mainnet-smoke-"));
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  userDataDir: profile,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-first-run", "--no-default-browser-check"],
});
try {
  await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${EXT}/`), { timeout: 20000 });
  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${EXT}/onboarding.html`);
  const bg = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);

  const words = (await bg({ type: "newPhrase" })).data;
  const made = await bg({ type: "create", phrase: Array.isArray(words) ? words.join(" ") : words, password: "mainnet-smoke-1" });
  const net = await bg({ type: "setNetwork", network: "mainnet" });
  const address = made.data.accounts[0].address;
  check(made.ok && net.ok && net.data.network === "mainnet", "a new empty wallet, switched to mainnet", address.slice(0, 8));

  const pub = await bg({ type: "balances" });
  const sol = pub.ok ? pub.data.find((r) => r.mint === SOL) : null;
  check(pub.ok && sol && sol.units === "0", "public balance read from mainnet through the local copy", pub.ok ? `${sol?.amount} SOL` : pub.error);

  const priv = await bg({ type: "privateBalances" });
  check(priv.ok && priv.data.address.length > 100 && priv.data.rows.some((r) => r.mint === SOL), "private balance synced (empty) and a private address made", priv.ok ? `${priv.data.address.slice(0, 10)}…` : priv.error);

  const q = await bg({ type: "swapQuote", inMint: SOL, outMint: USDC, amount: "0.01", slippageBps: 50 });
  check(q.ok && Number(q.data.out) > 0, "a live swap quote, with Rings' network costs", q.ok ? `0.01 SOL -> ${q.data.out} USDC, costs ${q.data.costs || "?"}, ${q.data.route.join(" + ")}` : q.error);

  const kind = await bg({ type: "classify", to: priv.ok ? priv.data.address : "" });
  check(kind.ok && kind.data === "private", "its private address is recognised as one");

  const opened = await bg({ type: "openProduct", product: "otc" });
  const desk = await (await browser.waitForTarget((t) => t.url().startsWith("http://otc.localhost:3100/") && t.url().includes("wallet=Rings"), { timeout: 30000 })).page();
  let signedIn = null;
  for (let i = 0; i < 60 && signedIn !== address; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    signedIn = await desk.evaluate(() => fetch("/api/auth/session").then((r) => r.json()).then((j) => j.wallet).catch(() => null)).catch(() => null);
  }
  const windows = (await browser.targets()).filter((t) => t.url().includes("approve.html")).length;
  check(opened.ok && signedIn === address && windows === 0, "the local mainnet desk opened from Products signed in as the wallet, no window", String(signedIn).slice(0, 8));
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
