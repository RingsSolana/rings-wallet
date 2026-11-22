// Keys match other wallets (same addresses per phrase) and rings.run (same Rings root, so the same private balance).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { derivePath } from "ed25519-hd-key";
import nacl from "tweetnacl";
import { accountSecret, addressOf, isPhrase, newPhrase, parseSecretKey, phraseSeed, ringsAccountAddress, ringsRoot } from "../src/lib/keys";
import { keyMessage, keyRoot } from "../../web/src/core/keys";
import { base58, hex, utf8 } from "../../web/src/core/codec";

const TEST_PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const bytes = (n: number) => new Uint8Array(randomBytes(n));

test("Solana accounts match the reference derivation (ed25519-hd-key, as Solflare and Backpack use)", () => {
  for (let i = 0; i < 20; i++) {
    const seed = bytes(64);
    for (const index of [0, 1, 2, 7, 31]) {
      const ref = derivePath(`m/44'/501'/${index}'/0'`, Buffer.from(seed).toString("hex")).key;
      assert.equal(hex(accountSecret(seed, index)), ref.toString("hex"));
    }
  }
});

test("the standard test phrase gives the same first address as the reference wallets", () => {
  assert.ok(isPhrase(TEST_PHRASE));
  const seed = phraseSeed(TEST_PHRASE);
  const ref = derivePath("m/44'/501'/0'/0'", Buffer.from(seed).toString("hex")).key;
  const refAddress = base58(nacl.sign.keyPair.fromSeed(new Uint8Array(ref)).publicKey);
  assert.equal(addressOf(accountSecret(seed, 0)), refAddress);
});

test("the Rings key root is the one rings.run derives from the wallet's own signature", () => {
  for (let i = 0; i < 25; i++) {
    const secret = bytes(32);
    const kp = nacl.sign.keyPair.fromSeed(secret);
    const wallet = base58(kp.publicKey);
    for (const host of ["rings.run", "localhost:3101"]) {
      // What a wallet like Phantom returns when rings.run asks it to sign the key message (plain Ed25519):
      const walletSignature = nacl.sign.detached(utf8(keyMessage(host, wallet)), kp.secretKey);
      assert.equal(hex(ringsRoot(secret, host)), hex(keyRoot(wallet, walletSignature)));
    }
  }
});

test("pinned values for the test phrase (a change here would move users' keys)", () => {
  const secret = accountSecret(phraseSeed(TEST_PHRASE), 0);
  const wallet = addressOf(secret);
  const root = ringsRoot(secret, "rings.run");
  const pinned = { wallet, root: hex(root), ringsAccount: ringsAccountAddress(wallet, root) };
  assert.deepEqual(pinned, PINNED);
});

test("private keys: Phantom's base58 export, the CLI's JSON array, and bad input", () => {
  const secret = bytes(32);
  const kp = nacl.sign.keyPair.fromSeed(secret);
  assert.deepEqual(parseSecretKey(base58(kp.secretKey)), secret);
  assert.deepEqual(parseSecretKey(JSON.stringify(Array.from(kp.secretKey))), secret);
  assert.throws(() => parseSecretKey("not a key"));
  const tampered = new Uint8Array(kp.secretKey);
  tampered[40] ^= 1;
  assert.throws(() => parseSecretKey(base58(tampered)), /doesn't match/);
});

test("new phrases are valid 12-word phrases, and a changed word is caught", () => {
  for (let i = 0; i < 10; i++) {
    const p = newPhrase();
    assert.equal(p.split(" ").length, 12);
    assert.ok(isPhrase(p));
  }
  assert.ok(!isPhrase(TEST_PHRASE.replace(/about$/, "abandon")));
  assert.ok(isPhrase(`  ${TEST_PHRASE.toUpperCase()}  `));
});

// The wallet address is the well-known one for this phrase (Solana CLI, Phantom, Solflare: m/44'/501'/0'/0').
const PINNED = {
  wallet: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
  root: "02e05f27b929eeca5b857ec7ce9acdc916391c0974534a1a77db67cc4031a1e8",
  ringsAccount: "FpLzCG21P7pamwiKAJQ6J2yrLW3EExo2uiWWSGs5339w",
};
