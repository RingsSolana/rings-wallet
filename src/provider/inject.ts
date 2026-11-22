// Page world: registers Rings with the Wallet Standard; holds no key and decides nothing.
import { b64, base58, fromB64, fromBase58 } from "../../../web/src/core/codec";
import { TO_CONTENT, TO_PAGE, type PageResponse, type ProviderMethod } from "./common";

declare const __RINGS_ICON__: string;
declare const __RELEASE__: boolean | undefined;

const CHAINS: readonly string[] = typeof __RELEASE__ !== "undefined" && __RELEASE__ ? ["solana:mainnet"] : ["solana:mainnet", "solana:devnet"];

function checkChain(chain: unknown) {
  if (chain !== undefined && !CHAINS.includes(String(chain))) throw new Error(`Rings Wallet doesn't sign for ${String(chain).slice(0, 40)}.`);
}
const ACCOUNT_FEATURES = ["solana:signAndSendTransaction", "solana:signTransaction", "solana:signMessage", "solana:signIn"] as const;

type Listener = (props: { accounts?: readonly RingsAccount[] }) => void;

class RingsAccount {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains = CHAINS;
  readonly features = ACCOUNT_FEATURES;
  constructor(address: string) {
    this.address = address;
    this.publicKey = fromBase58(address);
    Object.freeze(this);
  }
}

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Set<Listener>();
let accounts: RingsAccount[] = [];

function setAccounts(addresses: string[]) {
  if (addresses.length === accounts.length && addresses.every((a, i) => a === accounts[i]?.address)) return;
  accounts = addresses.map((a) => new RingsAccount(a));
  for (const l of listeners) l({ accounts: accounts.slice() });
}

function call<T>(method: ProviderMethod, params: unknown): Promise<T> {
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.postMessage({ target: TO_CONTENT, id, method, params }, window.location.origin);
  });
}

window.addEventListener("message", (event: MessageEvent<PageResponse>) => {
  if (event.source !== window) return;
  const m = event.data;
  if (!m || m.target !== TO_PAGE) return;
  if (m.event === "accounts") return setAccounts(m.accounts ?? []);
  const p = m.id ? pending.get(m.id) : undefined;
  if (!p || !m.id) return;
  pending.delete(m.id);
  if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
  else p.resolve(m.result);
});

const wallet = {
  version: "1.0.0" as const,
  name: "Rings",
  icon: __RINGS_ICON__ as `data:image/svg+xml;base64,${string}`,
  get chains() {
    return CHAINS.slice();
  },
  get accounts() {
    return accounts.slice();
  },
  features: {
    "standard:connect": {
      version: "1.0.0",
      connect: async (input?: { silent?: boolean }) => {
        const r = await call<{ accounts: string[] }>("connect", { silent: !!input?.silent });
        setAccounts(r.accounts);
        return { accounts: accounts.slice() };
      },
    },
    "standard:disconnect": {
      version: "1.0.0",
      disconnect: async () => {
        await call("disconnect", {}).catch(() => undefined);
        setAccounts([]);
      },
    },
    "standard:events": {
      version: "1.0.0",
      on: (event: "change", listener: Listener) => {
        if (event !== "change") return () => undefined;
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    "solana:signTransaction": {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signTransaction: async (...inputs: { transaction: Uint8Array; chain?: string }[]) => {
        for (const i of inputs) checkChain(i.chain);
        const r = await call<{ signed: string[] }>("signTransactions", { transactions: inputs.map((i) => b64(i.transaction)) });
        return r.signed.map((s) => ({ signedTransaction: fromB64(s) }));
      },
    },
    "solana:signAndSendTransaction": {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signAndSendTransaction: async (...inputs: { transaction: Uint8Array; chain?: string; options?: { skipPreflight?: boolean; maxRetries?: number } }[]) => {
        for (const i of inputs) checkChain(i.chain);
        const out: { signature: Uint8Array }[] = [];
        for (const i of inputs) {
          const r = await call<{ signature: string }>("signAndSendTransaction", { transaction: b64(i.transaction), options: i.options });
          out.push({ signature: fromBase58(r.signature) });
        }
        return out;
      },
    },
    "solana:signMessage": {
      version: "1.0.0",
      signMessage: async (...inputs: { message: Uint8Array }[]) => {
        const out: { signedMessage: Uint8Array; signature: Uint8Array }[] = [];
        for (const i of inputs) {
          const r = await call<{ signature: string }>("signMessage", { message: b64(i.message) });
          out.push({ signedMessage: i.message, signature: fromB64(r.signature) });
        }
        return out;
      },
    },
    "solana:signIn": {
      version: "1.0.0",
      signIn: async (...inputs: Record<string, unknown>[]) => {
        const out: { account: RingsAccount; signedMessage: Uint8Array; signature: Uint8Array; signatureType: "ed25519" }[] = [];
        for (const input of inputs) {
          const r = await call<{ account: string; signedMessage: string; signature: string }>("signIn", { input: input ?? {} });
          setAccounts([r.account]);
          out.push({ account: accounts[0], signedMessage: fromB64(r.signedMessage), signature: fromB64(r.signature), signatureType: "ed25519" });
        }
        return out;
      },
    },
  },
};

// Wallet Standard handshake: register at once, and again for any app that signals ready later.
type RegisterApi = { register: (w: typeof wallet) => unknown };
const announce = (api: RegisterApi) => {
  try {
    api.register(wallet);
  } catch {
    /* an app that can't take it */
  }
};
try {
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: announce }));
} catch {
  /* ignore */
}
window.addEventListener("wallet-standard:app-ready", ((e: CustomEvent<RegisterApi>) => announce(e.detail)) as EventListener);

// References the otherwise unused base58 import.
void base58;
