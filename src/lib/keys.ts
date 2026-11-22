// Wallet keys. The Rings key root must match rings.run's derivation exactly: shared code is imported, never copied.
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { ed25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { base58, fromBase58, utf8 } from "../../../web/src/core/codec";
import { ed25519Address, keyMessage, keyRoot, keysFromRoot } from "../../../web/src/core/keys";

export const WORDLIST = wordlist;

export const normalizePhrase = (p: string) => p.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");

export const newPhrase = (words: 12 | 24 = 12) => generateMnemonic(wordlist, words === 24 ? 256 : 128);

export function isPhrase(p: string): boolean {
  const n = normalizePhrase(p);
  const count = n.split(" ").length;
  return (count === 12 || count === 24) && validateMnemonic(n, wordlist);
}

/** The BIP39 seed, with no passphrase (as Phantom). */
export const phraseSeed = (p: string) => mnemonicToSeedSync(normalizePhrase(p));

const HARDENED = 0x80000000;

/** SLIP-0010 for Ed25519, which allows hardened indices only. */
export function slip10(seed: Uint8Array, path: readonly number[]): Uint8Array {
  let I = hmac(sha512, utf8("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const index of path) {
    const data = new Uint8Array(37);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, (index | HARDENED) >>> 0);
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

/** The secret (32-byte Ed25519 seed) of Solana account `index`: m/44'/501'/index'/0'. */
export const accountSecret = (seed: Uint8Array, index: number) => slip10(seed, [44, 501, index, 0]);

export const addressOf = (secret: Uint8Array) => base58(ed25519.getPublicKey(secret));

/** Returns the 32-byte secret. A 32-byte base58 input is refused: it is likely an address, i.e. public bytes. */
export function parseSecretKey(text: string): Uint8Array {
  const t = text.trim();
  let bytes: Uint8Array;
  try {
    if (t.startsWith("[")) {
      const list = JSON.parse(t) as unknown;
      if (!Array.isArray(list) || !list.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error("not bytes");
      bytes = Uint8Array.from(list as number[]);
    } else bytes = fromBase58(t);
  } catch {
    throw new Error("That private key isn't valid.");
  }
  if (bytes.length === 64) {
    const secret = bytes.slice(0, 32);
    const pub = ed25519.getPublicKey(secret);
    if (!pub.every((b, i) => b === bytes[32 + i])) throw new Error("That private key doesn't match its own address.");
    return secret;
  }
  if (bytes.length === 32 && t.startsWith("[") && bytes.some((b) => b !== 0)) return bytes;
  if (bytes.length === 32) throw new Error("That looks like an address, not a private key. Export the private key from your other wallet and paste it here.");
  throw new Error("That private key isn't valid.");
}

/** A per-site key from the account secret and the origin: restorable from the phrase, unlinkable across sites. */
export const siteSecret = (accountSecret: Uint8Array, origin: string) => hkdf(sha256, accountSecret, utf8("rings-wallet/site/v1"), utf8(origin), 32);

/** The account's Rings key root for `keyHost` ("rings.run" on mainnet). */
export function ringsRoot(secret: Uint8Array, keyHost: string): Uint8Array {
  const wallet = addressOf(secret);
  const signature = ed25519.sign(utf8(keyMessage(keyHost, wallet)), secret);
  const root = keyRoot(wallet, signature);
  signature.fill(0);
  return root;
}

/** Address of the Rings account key, which owns the private balance. */
export const ringsAccountAddress = (wallet: string, root: Uint8Array) => ed25519Address(keysFromRoot(wallet, root).accountSeed);
