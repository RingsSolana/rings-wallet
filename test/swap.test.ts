// What Rings may ask to be paid for a swap (src/lib/swap.ts checkPayments): checked before anything is paid.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOL_MINT } from "../src/lib/net";
import { checkPayments } from "../src/lib/swap";

const COIN = "FF4iWENV2AA58SPN9yf77SZ9wuJkhHxDowM9hb3pjZzr";
const costs = 3_000_000n; // Rings' costs figure, in lamports
const units = 10_000_000n;

test("selling SOL: one SOL payment of the amount plus costs passes", () => {
  checkPayments([{ mint: SOL_MINT, amount: String(units + costs) }], SOL_MINT, units, costs);
});

test("selling SOL: a small rise in costs passes, a big one is refused", () => {
  checkPayments([{ mint: SOL_MINT, amount: String(units + costs + 500_000n) }], SOL_MINT, units, costs);
  assert.throws(() => checkPayments([{ mint: SOL_MINT, amount: String(units + 3n * costs) }], SOL_MINT, units, costs), /more than this swap should cost/);
});

test("selling a coin: the exact amount plus SOL costs passes", () => {
  checkPayments(
    [
      { mint: COIN, amount: String(units) },
      { mint: SOL_MINT, amount: String(costs) },
    ],
    COIN,
    units,
    costs,
  );
});

test("selling a coin: more of the coin than typed is refused", () => {
  assert.throws(
    () =>
      checkPayments(
        [
          { mint: COIN, amount: String(units + 1n) },
          { mint: SOL_MINT, amount: String(costs) },
        ],
        COIN,
        units,
        costs,
      ),
    /more than this swap should cost/,
  );
});

test("a payment in another coin, or extra payments, are refused", () => {
  const other = "8g281QnLeJLhyoc8sLV6mwqUWeWhzt7MfBVUZG9CaYeB";
  assert.throws(() => checkPayments([{ mint: other, amount: "1" }], SOL_MINT, units, costs));
  assert.throws(() =>
    checkPayments(
      [
        { mint: COIN, amount: String(units) },
        { mint: SOL_MINT, amount: String(costs) },
        { mint: other, amount: "1" },
      ],
      COIN,
      units,
      costs,
    ),
  );
  assert.throws(() => checkPayments([], SOL_MINT, units, costs));
});

test("amounts that aren't whole numbers are refused", () => {
  assert.throws(() => checkPayments([{ mint: SOL_MINT, amount: "-5" }], SOL_MINT, units, costs), /unexpected payment/);
  assert.throws(() => checkPayments([{ mint: SOL_MINT, amount: "1e9" }], SOL_MINT, units, costs), /unexpected payment/);
});
