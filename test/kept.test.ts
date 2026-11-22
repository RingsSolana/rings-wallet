// Balance data kept in chrome.storage.session (src/lib/kept.ts): clearing on lock, quota handling, sealed snapshots.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initializePoseidon, serializeWallet, Wallet, WalletError, walletSnapshotCipher, type Address } from "@heliuslabs/spr";
import { AssetRegistry } from "@heliuslabs/spr/transaction";
import { kept, keeper, memoryArea, SNAP, type Area } from "../src/lib/kept";
import { openSnapshot, snapshotStore, unresolvedAsset } from "../src/lib/rings";
import { keypairFromSeed } from "../../web/src/core/chain";

const SOL = "11111111111111111111111111111111";
const TEST1 = "FF4iWENV2AA58SPN9yf77SZ9wuJkhHxDowM9hb3pjZzr";
const USDC = "6v74aDeQhs4o9rRq5ZsafivvjYhPdAoP39NmFTDB7Y55";
const VAULT_KEY = { unlock: { key: "the vault key", until: 1 } };

/** In-memory chrome.storage.session stand-in: `hold()` delays writes, and a write past `quota` bytes throws. */
function session(quota = Infinity) {
  const inner = memoryArea();
  let gate: Promise<void> | null = null;
  const area: Area & { hold(): () => void } = {
    get: (key) => inner.get(key),
    remove: (key) => inner.remove(key),
    async set(items) {
      if (gate) await gate;
      const all = { ...(await inner.get(null)), ...items };
      const bytes = Object.entries(all).reduce((n, [k, v]) => n + k.length + JSON.stringify(v).length, 0);
      if (bytes > quota) throw new Error("Session storage quota bytes exceeded. Values were not stored.");
      await inner.set(items);
    },
    hold() {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
  return area;
}

test("a lock removes everything kept for the balances, and nothing else (the vault key stays until lock() removes it)", async () => {
  const area = session();
  const k = keeper(area);
  await area.set(VAULT_KEY);
  assert.equal(await k.put(`${SNAP}devnet:A`, { sealed: "x", mints: [] }, k.epoch()), true);
  assert.equal(await k.put("dec:devnet:M", 6, k.epoch()), true);
  assert.equal(await k.put("pub:devnet:A", [], k.epoch()), true);
  assert.equal(await k.get("dec:devnet:M"), 6);
  await k.forget();
  assert.deepEqual(Object.keys(await area.get(null)), ["unlock"]);
  assert.equal(await k.get("dec:devnet:M"), undefined);
});

test("a write begun before a lock is never kept, even when it lands after it", async () => {
  const area = session();
  const k = keeper(area);
  const at = k.epoch();
  const release = area.hold();
  const writing = k.put(`${SNAP}devnet:A`, { sealed: "x", mints: [] }, at);
  await k.forget(); // lock while the write is held
  release();
  assert.equal(await writing, false);
  assert.deepEqual(await area.get(null), {});
});

test("a write asked for the session before a lock is refused, and one for the new session is kept", async () => {
  const area = session();
  const k = keeper(area);
  const before = k.epoch();
  await k.forget();
  assert.equal(await k.put("pub:devnet:A", [1], before), false);
  assert.deepEqual(await area.get(null), {});
  assert.equal(await k.put("pub:devnet:A", [1], k.epoch()), true);
});

test("a full session: the other accounts' private copies go and the copy is written once more; still too big: skipped", async () => {
  const area = session(2_500);
  const k = keeper(area);
  await area.set(VAULT_KEY);
  const copy = (c: string) => ({ sealed: c.repeat(900), mints: [] });
  assert.equal(await k.put(`${SNAP}devnet:A`, copy("a"), k.epoch(), { dropOtherSnapshots: true }), true);
  assert.equal(await k.put(`${SNAP}mainnet:A`, copy("b"), k.epoch(), { dropOtherSnapshots: true }), true);
  assert.equal(await k.put("dec:devnet:M", 6, k.epoch()), true);
  // Over quota: the other snapshots are dropped (not the decimals or the vault key), then the write fits.
  assert.equal(await k.put(`${SNAP}devnet:B`, copy("c"), k.epoch(), { dropOtherSnapshots: true }), true);
  assert.deepEqual(Object.keys(await area.get(null)).sort(), ["kept:dec:devnet:M", `kept:${SNAP}devnet:B`, "unlock"]);
  assert.equal(await k.put("pub:devnet:B", "p".repeat(2_500), k.epoch()), false);
  assert.ok(await k.get(`${SNAP}devnet:B`));
  assert.equal(await k.put(`${SNAP}devnet:C`, copy("d".repeat(5)), k.epoch(), { dropOtherSnapshots: true }), false);
  assert.deepEqual((await area.get("unlock")).unlock, VAULT_KEY.unlock);
});

test("outside Chrome (the devnet scripts), what is kept lives in memory, as copies", async () => {
  const at = kept.epoch();
  const rows = [{ mint: SOL, units: "5" }];
  assert.equal(await kept.put("pub:devnet:test", rows, at), true);
  rows[0].units = "6"; // must not change the kept copy
  assert.deepEqual(await kept.get("pub:devnet:test"), [{ mint: SOL, units: "5" }]);
  await kept.forget();
  assert.equal(await kept.get("pub:devnet:test"), undefined);
});

test("a sealed private copy opens for its own account only, with the coins it looked up; anything else is rebuilt", async () => {
  await initializePoseidon();
  const mine = keypairFromSeed(new Uint8Array(32).fill(7));
  const other = keypairFromSeed(new Uint8Array(32).fill(8));
  const wallet = new Wallet({ identity: mine.shieldedAddress(), registry: new AssetRegistry([[300n, TEST1 as Address]]) });
  const k = keeper(memoryArea());
  const store = snapshotStore("devnet:A", () => new Set([SOL, TEST1, USDC]), k.epoch(), k);
  await store.save(await walletSnapshotCipher(mine).seal(serializeWallet(wallet)));
  const record = await k.get<{ sealed: string; mints: string[] }>(`${SNAP}devnet:A`);
  assert.ok(record && typeof record.sealed === "string");
  // Sealed with AES-256-GCM keyed from the viewing secret: no coin address readable in session storage.
  assert.ok(!record.sealed.includes(TEST1));
  assert.equal(await store.load(), record.sealed);

  const opened = await openSnapshot(mine, record);
  assert.ok(opened);
  assert.deepEqual([...opened.wallet.identity.toBytes()], [...mine.shieldedAddress().toBytes()]);
  assert.deepEqual(opened.wallet.registry.entries().map(([id, m]) => `${id}:${m}`), ["1:11111111111111111111111111111111", `300:${TEST1}`]);
  assert.deepEqual([...opened.mints].sort(), [SOL, USDC, TEST1].sort());

  assert.equal(await openSnapshot(other, record), null, "another account's copy");
  const data = JSON.parse(record.sealed) as { data: string };
  const flipped = JSON.stringify({ ...JSON.parse(record.sealed), data: (data.data[0] === "A" ? "B" : "A") + data.data.slice(1) });
  assert.equal(await openSnapshot(mine, { ...record, sealed: flipped }), null, "a changed copy");
  assert.equal(await openSnapshot(mine, { ...record, mints: ["not a coin"] }), null, "a changed coin list");
  assert.equal(await openSnapshot(mine, undefined), null, "no copy");
});

test("a copy saved after a lock writes nothing; one saved in its own session is replaced whole", async () => {
  const k = keeper(memoryArea());
  const store = snapshotStore("devnet:A", () => new Set([SOL]), k.epoch(), k);
  await store.save("first");
  assert.deepEqual(await k.get(`${SNAP}devnet:A`), { sealed: "first", mints: [SOL] });
  await store.save("second");
  assert.deepEqual(await k.get(`${SNAP}devnet:A`), { sealed: "second", mints: [SOL] });
  await k.forget();
  await store.save("after the lock");
  assert.equal(await k.get(`${SNAP}devnet:A`), undefined);
  assert.equal(await store.load(), undefined);
});

test("the sync is tried once more only for a coin the registry scan didn't list (the SDK's own error)", () => {
  assert.equal(unresolvedAsset(new WalletError("WALLET_SYNC", { causeCode: "WALLET_UNRESOLVED_ASSET", causeCodes: ["WALLET_UNRESOLVED_ASSET"] })), true);
  assert.equal(unresolvedAsset(new WalletError("WALLET_SYNC", { causeCode: "CLIENT_TIMEOUT", causeCodes: ["CLIENT_TIMEOUT"] })), false);
  assert.equal(unresolvedAsset(new WalletError("WALLET_UNRESOLVED_ASSET")), false);
  assert.equal(unresolvedAsset(new Error("WALLET_SYNC")), false);
  assert.equal(unresolvedAsset(null), false);
});
