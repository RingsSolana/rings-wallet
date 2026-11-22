// Password-encrypted vault: PBKDF2-SHA256 then AES-256-GCM. KDF settings live in the blob so they can be raised.
import { b64, fromB64, utf8 } from "../../../web/src/core/codec";
import type { Sites } from "../provider/server";

export interface Account {
  id: string;
  name: string;
  kind: "hd" | "imported";
  /** hd: the account number in m/44'/501'/index'/0'. imported: the position in Secrets.imported. */
  index: number;
  address: string;
}

export interface Secrets {
  phrase: string | null;
  /** Base58 of 32-byte secrets. */
  imported: string[];
  accounts: Account[];
  nextIndex: number;
  sites?: Sites;
}

export interface VaultBlob {
  v: 1;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  iv: string;
  data: string;
}

export const ITERATIONS = 600_000;
const AAD = utf8("rings-wallet/vault/v1");

export class WrongPassword extends Error {
  constructor() {
    super("Wrong password.");
  }
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", utf8(password) as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    true, // extractable: while unlocked, this key is kept instead of the password
    ["encrypt", "decrypt"],
  );
}

async function encrypt(key: CryptoKey, secrets: Secrets): Promise<{ iv: string; data: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD as BufferSource }, key, utf8(JSON.stringify(secrets)) as BufferSource);
  return { iv: b64(iv), data: b64(new Uint8Array(data)) };
}

export async function seal(secrets: Secrets, password: string): Promise<{ blob: VaultBlob; key: CryptoKey }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(password, salt, ITERATIONS);
  const blob: VaultBlob = { v: 1, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: b64(salt) }, ...(await encrypt(key, secrets)) };
  return { blob, key };
}

/** Re-encrypts under the same key and KDF settings with a fresh IV. */
export async function reseal(blob: VaultBlob, key: CryptoKey, secrets: Secrets): Promise<VaultBlob> {
  return { ...blob, ...(await encrypt(key, secrets)) };
}

export async function openWithKey(blob: VaultBlob, key: CryptoKey): Promise<Secrets> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(blob.iv) as BufferSource, additionalData: AAD as BufferSource }, key, fromB64(blob.data) as BufferSource);
  return JSON.parse(new TextDecoder().decode(plain)) as Secrets;
}

export async function open(blob: VaultBlob, password: string): Promise<{ secrets: Secrets; key: CryptoKey }> {
  if (blob.v !== 1 || blob.kdf.name !== "PBKDF2" || blob.kdf.hash !== "SHA-256") throw new Error("This wallet was saved by a newer version.");
  const key = await derive(password, fromB64(blob.kdf.salt), blob.kdf.iterations);
  try {
    return { secrets: await openWithKey(blob, key), key };
  } catch {
    throw new WrongPassword();
  }
}

export const exportKey = async (key: CryptoKey) => b64(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
export const importKey = (raw: string) => crypto.subtle.importKey("raw", fromB64(raw) as BufferSource, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
