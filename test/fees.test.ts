// floatFor / canPayFees: the fee float is as big as the public balance allows, never leaves the wallet below rent,
// and is never too small to open the Rings account.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_FEE_FLOAT, RENT_KEEP, TINY_FEE_FLOAT, canPayFees, floatFor } from "../src/lib/rings";

const SOL = 1_000_000_000n;

test("plenty of public SOL: the full float (0.015 SOL)", () => {
  assert.equal(floatFor(SOL, 100_000_000n), 15_000_000n);
});

test("the owner's case: 0.02 SOL in Public, 0.0175 SOL going private: the least float, and it fits", () => {
  const have = 20_000_000n;
  const spend = 17_500_000n;
  const float = floatFor(have, spend);
  assert.equal(float, TINY_FEE_FLOAT);
  // What stays in Public after the deposit, its fee and the float: still above the rent Solana asks for.
  assert.ok(have - spend - float - 20_000n >= RENT_KEEP);
});

test("a little more room: the small float (0.0025 SOL)", () => {
  assert.equal(floatFor(20_000_000n, 10_000_000n), MIN_FEE_FLOAT);
});

test("no room for even the least float: none (the deposit goes without it)", () => {
  assert.equal(floatFor(20_000_000n, 19_000_000n), 0n);
});

test("the least float opens the account key and pays about 20 fees before it must be topped up again", () => {
  assert.ok(TINY_FEE_FLOAT > RENT_KEEP);
  assert.ok(canPayFees(TINY_FEE_FLOAT));
  assert.equal(canPayFees(RENT_KEEP), false);
  assert.ok((TINY_FEE_FLOAT - RENT_KEEP) / 5_000n >= 20n);
});
