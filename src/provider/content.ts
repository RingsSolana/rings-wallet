// Content script: relays the page's wallet requests to the background port and the answers back; decides nothing.
import { PORT_NAME, TO_CONTENT, TO_PAGE, type PageRequest, type PageResponse, type ProviderMethod } from "./common";

let port: chrome.runtime.Port | null = null;
/** Unanswered requests by id; all fail at once if the port closes. */
const waiting = new Map<string, ProviderMethod>();
/** Only a page that used the wallet reconnects for account changes. */
let used = false;
/** Accounts last sent to the page, as JSON (null: none). Only changes pass, so a page can't watch locks. */
let given: string | null = null;

const answer = (id: string, message: string) =>
  window.postMessage({ target: TO_PAGE, id, error: { message, code: -32603 } } satisfies PageResponse, window.location.origin);

function accountsOf(method: ProviderMethod | undefined, result: unknown): string[] | null {
  if (method === "connect") return ((result as { accounts?: string[] } | null)?.accounts ?? []).filter((a) => typeof a === "string");
  if (method === "signIn") return typeof (result as { account?: unknown } | null)?.account === "string" ? [(result as { account: string }).account] : null;
  if (method === "disconnect") return [];
  return null;
}

function connect(): chrome.runtime.Port {
  if (port) return port;
  const p = chrome.runtime.connect({ name: PORT_NAME });
  p.onMessage.addListener((msg: PageResponse) => {
    if (msg.event === "accounts") {
      const accounts = Array.isArray(msg.accounts) ? msg.accounts : [];
      const key = JSON.stringify(accounts);
      if (key === given || (given === null && accounts.length === 0)) return;
      given = key;
      window.postMessage({ ...msg, target: TO_PAGE }, window.location.origin);
      return;
    }
    if (msg.id) {
      const method = waiting.get(msg.id);
      waiting.delete(msg.id);
      const accounts = msg.error ? null : accountsOf(method, msg.result);
      if (accounts) given = JSON.stringify(accounts);
    }
    window.postMessage({ ...msg, target: TO_PAGE }, window.location.origin);
  });
  p.onDisconnect.addListener(() => {
    // The worker stopped (the next request reconnects) or the extension reloaded.
    void chrome.runtime.lastError;
    if (port === p) port = null;
    for (const id of waiting.keys()) answer(id, "Rings Wallet stopped before answering. Try again.");
    waiting.clear();
  });
  port = p;
  return p;
}

window.addEventListener("message", (event: MessageEvent<PageRequest>) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const msg = event.data;
  if (!msg || msg.target !== TO_CONTENT || typeof msg.id !== "string" || typeof msg.method !== "string") return;
  // Transient user activation, read in the isolated world where the page can't fake it.
  const gesture = navigator.userActivation ? navigator.userActivation.isActive : true;
  used = true;
  waiting.set(msg.id, msg.method);
  try {
    connect().postMessage({ id: msg.id, method: msg.method, params: msg.params, gesture });
  } catch {
    waiting.delete(msg.id);
    answer(msg.id, "Rings Wallet was updated. Reload this page.");
  }
});

// Nudge from the background after the port closed: a page that used the wallet reconnects to hear its accounts.
chrome.runtime.onMessage.addListener((m: unknown, sender) => {
  if (sender.id !== chrome.runtime.id || (m as { event?: unknown } | null)?.event !== "accountsChanged") return;
  if (!used || port) return;
  try {
    connect();
  } catch {
    /* extension reloaded */
  }
});
