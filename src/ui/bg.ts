// The wallet's pages talk to the background through this.
import type { Reply, Request } from "../lib/protocol";

export class BgError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export async function bg<T>(msg: Request): Promise<T> {
  const r = (await chrome.runtime.sendMessage(msg)) as Reply<T> | undefined;
  if (!r) throw new BgError("The wallet didn't answer. Try again.");
  if (!r.ok) throw new BgError(r.error, r.code);
  return r.data;
}
