// DEVNET ONLY: kept balances survive a background stop (private copy sealed, nothing on disk); a lock clears them.
//   node test/devnet-kept.mjs   (read-only; loads dist/ into the Chrome in .devdata/chrome; devnet copy on :3101)
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const puppeteer = createRequire(join(root, "../brand/video/package.json"))("puppeteer-core");
const cft = join(root, ".devdata/chrome/chrome");
const chromePath = join(cft, readdirSync(cft).find((d) => d.startsWith("win64-")), "chrome-win64", "chrome.exe");
const phrase = readFileSync(join(root, ".devdata/devnet-phrase.txt"), "utf8").trim();
const EXT = "polncinkggpfflechknjkjokigacghgj";
const ORIGIN = `chrome-extension://${EXT}/`;
const PASSWORD = "kept-test-local-1";

let failures = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const amounts = (rows) => (rows ?? []).map((r) => `${r.mint}:${r.units}`).sort().join(",");
const changes = (a, b) => {
  const A = new Map((a ?? []).map((r) => [r.mint, r.units]));
  const B = new Map((b ?? []).map((r) => [r.mint, r.units]));
  return [...new Set([...A.keys(), ...B.keys()])]
    .filter((m) => A.get(m) !== B.get(m))
    .map((m) => `${m.slice(0, 4)}… ${A.get(m) ?? "none"} -> ${B.get(m) ?? "none"}`)
    .join("; ");
};
const same = (a, b) => (amounts(a) === amounts(b) ? "" : `changed: ${changes(a, b)}`);

const profile = mkdtempSync(join(tmpdir(), "rings-kept-"));
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  userDataDir: profile,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-first-run", "--no-default-browser-check"],
});
const isWorker = (t) => t.type() === "service_worker" && t.url().startsWith(ORIGIN);
const closeExtensionPages = async () => {
  for (const p of await browser.pages()) if (p.url().startsWith(ORIGIN)) await p.close().catch(() => undefined);
};
const openPage = async () => {
  const page = await browser.newPage();
  await page.goto(`${ORIGIN}onboarding.html`, { waitUntil: "domcontentloaded" });
  const send = async (msg) => {
    const t = Date.now();
    const r = await page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    return { ...r, ms: Date.now() - t };
  };
  const sessionKeys = () => page.evaluate(() => chrome.storage.session.get(null).then((all) => Object.keys(all)));
  return { page, send, sessionKeys };
};

try {
  await browser.waitForTarget(isWorker, { timeout: 30_000 });
  // A fresh install opens onboarding.html by itself: close it.
  await browser.waitForTarget((t) => t.url().startsWith(`${ORIGIN}onboarding.html`), { timeout: 8_000 }).catch(() => null);
  await closeExtensionPages();

  let { page, send, sessionKeys } = await openPage();
  const made = await send({ type: "create", phrase, password: PASSWORD });
  check(made?.ok && made.data?.unlocked, "wallet created from the devnet test phrase");
  if (made.data?.network !== "devnet") throw new Error(`the wallet is on ${made.data?.network}, not devnet: stopped before any balance call`);

  // Read until stable: the devnet indexer may still be catching up on recent transactions.
  const built = await send({ type: "privateBalances" });
  check(built.ok && built.data.rows.length > 0, "private balance built", built.ok ? `${built.data.rows.length} rows, ${built.ms} ms` : built.error);
  const pub = await send({ type: "balances" });
  check(pub.ok && pub.data.length > 0, "public balance", pub.ok ? `${pub.data.length} rows, ${pub.ms} ms` : pub.error);
  let warm = await send({ type: "privateBalances" });
  for (let i = 0; i < 8; i++) {
    await sleep(3000);
    const next = await send({ type: "privateBalances" });
    if (next.ok && warm.ok && amounts(next.data.rows) === amounts(warm.data.rows)) break;
    console.log(`... the private balance is still moving: ${next.ok && warm.ok ? changes(warm.data.rows, next.data.rows) : next.error}`);
    warm = next;
  }
  check(warm.ok, "private balance again, background awake", `${warm.ms} ms${warm.ok ? ` ${same(built.data.rows, warm.data.rows)}` : ""}`);

  const keys = await sessionKeys();
  const has = (prefix) => keys.some((k) => k.startsWith(prefix));
  check(keys.includes("unlock") && has("kept:snap:devnet:") && has("kept:pub:devnet:") && has("kept:priv:devnet:") && has("kept:held:devnet:") && has("kept:dec:devnet:"), "the session holds the vault key, the sealed private copy, the last balances and the decimals", keys.map((k) => k.replace(/:[1-9A-HJ-NP-Za-km-z]{32,44}$/, ":…")).join(" "));
  const sealed = await page.evaluate(() =>
    chrome.storage.session.get(null).then((all) => {
      const v = Object.entries(all).find(([k]) => k.startsWith("kept:snap:"))?.[1];
      return typeof v?.sealed === "string" ? v.sealed : "";
    }),
  );
  let envelope = null;
  try {
    envelope = JSON.parse(sealed);
  } catch {}
  const privateMints = warm.data.rows.map((r) => r.mint).filter((m) => m !== "11111111111111111111111111111111");
  check(envelope?.v === 1 && typeof envelope.data === "string" && typeof envelope.nonce === "string" && !privateMints.some((m) => sealed.includes(m)) && !/"utxos"|"amount"/.test(sealed), "the synced private copy is sealed: an envelope whose string names no coin or amount (the last balances beside it are plain: README, Fast balances)", `${sealed.length} characters`);
  const local = await page.evaluate(() => chrome.storage.local.get(null).then((all) => JSON.stringify(all)));
  check(!local.includes("kept:") && !local.includes(envelope?.data?.slice(0, 40) ?? "kept:"), "nothing kept for the balances is in chrome.storage.local (disk)");

  // Chrome stops an idle extension worker after ~30 s with no extension page open; attaching to it would keep it alive.
  await closeExtensionPages();
  const waitFrom = Date.now();
  while (browser.targets().some(isWorker) && Date.now() - waitFrom < 150_000) await sleep(250);
  const stopped = !browser.targets().some(isWorker);
  check(stopped, "Chrome stopped the background", `${((Date.now() - waitFrom) / 1000).toFixed(1)} s after the last page closed`);
  await sleep(1500);

  ({ page, send, sessionKeys } = await openPage());
  const cached = await send({ type: "cachedBalances" });
  check(
    cached.ok && amounts(cached.data.balances) === amounts(pub.data) && amounts(cached.data.privateBalances?.rows) === amounts(warm.data.rows) && cached.data.privateBalances.address === warm.data.address,
    "after the stop, the last balances come back at once (cachedBalances)",
    `${cached.ms} ms, background started for it`,
  );
  const restored = await send({ type: "privateBalances" });
  check(restored.ok && amounts(restored.data.rows) === amounts(warm.data.rows), "after the stop, the private balance is the same as before it", restored.ok ? `${restored.ms} ms ${same(warm.data.rows, restored.data.rows)}` : restored.error);
  check(restored.ok && restored.ms < built.ms, "… restored from the sealed copy: faster than building it", `${restored.ms} ms against ${built.ms} ms built, ${warm.ms} ms awake`);
  const again = await send({ type: "privateBalances" });
  check(again.ok && restored.ok && amounts(again.data.rows) === amounts(restored.data.rows), "and once more, awake", `${again.ms} ms${again.ok && restored.ok ? ` ${same(restored.data.rows, again.data.rows)}` : ""}`);

  const locked = await send({ type: "lock" });
  const afterLock = await sessionKeys();
  check(locked.ok && !locked.data.unlocked && !afterLock.some((k) => k.startsWith("kept:")) && !afterLock.includes("unlock"), "a lock leaves nothing kept in the session", afterLock.join(" ") || "empty");
  const none = await send({ type: "cachedBalances" });
  check(!none.ok && none.code === "locked", "locked: no kept balances are given", none.error);
  const unlocked = await send({ type: "unlock", password: PASSWORD });
  check(unlocked.ok && unlocked.data.unlocked, "unlocked");
  const empty = await send({ type: "cachedBalances" });
  check(empty.ok && empty.data.balances === null && empty.data.privateBalances === null, "after unlocking, nothing kept from before the lock");
  const rebuilt = await send({ type: "privateBalances" });
  check(rebuilt.ok && again.ok && amounts(rebuilt.data.rows) === amounts(again.data.rows), "after unlocking, the private balance is built again: the same as the restored one", rebuilt.ok ? `${rebuilt.ms} ms ${again.ok ? same(again.data.rows, rebuilt.data.rows) : ""}` : rebuilt.error);
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  await browser.close().catch(() => undefined);
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(profile, { recursive: true, force: true });
      break;
    } catch {
      await sleep(1000);
    }
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}
