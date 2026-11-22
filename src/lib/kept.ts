// Balance caches in chrome.storage.session: memory only, cleared at lock, never written to disk.

/** The subset of chrome.storage's StorageArea in use; stand-ins implement only these. */
export interface Area {
  /** One key, or every key with `null`. */
  get(key: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  /** A single key: stand-ins don't accept a list. */
  remove(key: string): Promise<void>;
}

/** Prefix of every entry: lock removes exactly these, never the vault key ("unlock"). */
const PREFIX = "kept:";
/** Sealed private-balance snapshot key: kept:snap:<network>:<Rings account address>. */
export const SNAP = "snap:";

export interface Kept {
  /** Bumped by every lock; a write begun under an older epoch is never kept. */
  epoch(): number;
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Writes unless a lock came after `at`; true if kept. On a full quota, `dropOtherSnapshots` evicts other snapshots and retries. */
  put(key: string, value: unknown, at: number, opts?: { dropOtherSnapshots?: boolean }): Promise<boolean>;
  /** At lock: removes every entry; writes already under way can't restore any. */
  forget(): Promise<void>;
}

const isFull = (e: unknown) => /quota/i.test(`${(e as { name?: string } | null)?.name ?? ""} ${(e as Error | null)?.message ?? String(e)}`);

export function keeper(area: Area): Kept {
  let epoch = 0;
  const keys = async (prefix: string) => Object.keys(await area.get(null)).filter((k) => k.startsWith(prefix));
  const removeAll = (list: string[]) => Promise.all(list.map((k) => area.remove(k).catch(() => undefined)));
  return {
    epoch: () => epoch,
    async get<T>(key: string) {
      try {
        return (await area.get(PREFIX + key))[PREFIX + key] as T | undefined;
      } catch {
        return undefined;
      }
    },
    async put(key, value, at, opts = {}) {
      if (at !== epoch) return false;
      const k = PREFIX + key;
      try {
        await area.set({ [k]: value });
      } catch (e) {
        if (!opts.dropOtherSnapshots || !isFull(e)) return false;
        await removeAll((await keys(PREFIX + SNAP).catch(() => [] as string[])).filter((x) => x !== k));
        if (at !== epoch) return false;
        try {
          await area.set({ [k]: value });
        } catch {
          return false;
        }
      }
      if (at !== epoch) {
        await area.remove(k).catch(() => undefined);
        return false;
      }
      return true;
    },
    async forget() {
      epoch++;
      await removeAll(await keys(PREFIX).catch(() => [] as string[]));
    },
  };
}

/** In-memory stand-in outside Chrome; stores JSON so each read returns a copy, as Chrome does. */
export function memoryArea(): Area {
  const m = new Map<string, string>();
  return {
    async get(key) {
      if (key === null) return Object.fromEntries([...m].map(([k, v]) => [k, JSON.parse(v) as unknown]));
      const v = m.get(key);
      return v === undefined ? {} : { [key]: JSON.parse(v) as unknown };
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        if (v === undefined) m.delete(k);
        else m.set(k, JSON.stringify(v));
      }
    },
    async remove(key) {
      m.delete(key);
    },
  };
}

function sessionArea(): Area {
  const s = (globalThis as { chrome?: { storage?: { session?: chrome.storage.StorageArea } } }).chrome?.storage?.session;
  if (!s) return memoryArea();
  return {
    get: (key) => s.get(key) as Promise<Record<string, unknown>>,
    set: (items) => s.set(items),
    remove: (key) => s.remove(key),
  };
}

/** One per worker lifetime: the epoch restarts at 0, which is safe as nothing older survives a restart. */
export const kept: Kept = keeper(sessionArea());
