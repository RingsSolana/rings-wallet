// Rings server sign-in, as rings.run does it: the wallet key and the Rings account key both sign the login message.
import { ed25519 } from "@noble/curves/ed25519";
import { loginMessage } from "../../../web/src/core/keys";
import { b64, base58, utf8 } from "../../../web/src/core/codec";
import { accountAddress, type Ctx } from "./rings";
import { NETWORKS, type Network } from "./net";

export class RingsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(network: Network, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${NETWORKS[network].rings}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "include",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new RingsApiError(res.status, data.error ?? `Rings didn't answer (${res.status}).`);
  return data;
}

export async function ensureSession(ctx: Ctx): Promise<void> {
  const now = await api<{ wallet: string | null }>(ctx.network, "/api/auth/session").catch(() => ({ wallet: null }));
  if (now.wallet === ctx.wallet) return;
  const { nonce, issuedAt } = await api<{ nonce: string; issuedAt: string }>(ctx.network, "/api/auth/nonce", { method: "POST" });
  const message = loginMessage({
    // The server checks this against its own Host.
    domain: NETWORKS[ctx.network].keyHost,
    wallet: ctx.wallet,
    nonce,
    issuedAt,
    x25519: b64(ctx.keys.msg.x25519Public),
    ed25519: b64(ctx.keys.msg.edPublic),
    account: accountAddress(ctx),
  });
  const signature = base58(ed25519.sign(utf8(message), ctx.secret));
  const accountSignature = base58(ed25519.sign(utf8(message), ctx.keys.accountSeed));
  await api(ctx.network, "/api/auth/verify", { body: { message, signature, accountSignature } });
}

let sessionTurn: Promise<unknown> = Promise.resolve();

/** Runs `fn` signed in as this wallet, one at a time: Rings binds a swap to whoever is signed in when it is made. */
export function withSession<T>(ctx: Ctx, fn: () => Promise<T>): Promise<{ result: T; same: boolean }> {
  const run = async () => {
    await ensureSession(ctx);
    const result = await fn();
    const now = await api<{ wallet: string | null }>(ctx.network, "/api/auth/session").catch(() => ({ wallet: null }));
    return { result, same: now.wallet === ctx.wallet };
  };
  const next = sessionTurn.then(run, run);
  sessionTurn = next.catch(() => undefined);
  return next;
}
