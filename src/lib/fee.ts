// The 0.1% fee on the wallet's own sends, swaps and moves, never on site requests. No imports: the popup bundles it.

/** 0.1%, in basis points. */
export const FEE_BPS = 10n;

/** Rounded down: zero below 1,000 base units. */
export const feeOf = (units: bigint): bigint => (units > 0n ? (units * FEE_BPS) / 10_000n : 0n);

/** The most that can go out of `have` with the fee on top: the largest u with u + feeOf(u) <= have. */
export function maxWithFee(have: bigint): bigint {
  if (have <= 0n) return 0n;
  let u = (have * 10_000n) / (10_000n + FEE_BPS);
  while (u > 0n && u + feeOf(u) > have) u--;
  while (u + 1n + feeOf(u + 1n) <= have) u++;
  return u;
}

/** The treasury's public address (same on mainnet and devnet), for public sends' fees. Pinned: never taken from a server. */
export const TREASURY_PUBLIC = "6zq4WxBjrUA3DwRo7PYY5GWdkbwsUbaf97BMDxFZmJae";
/** Its private-ring address, base64. Private actions pay here: a public fee would reveal the private amount. */
export const TREASURY_RING_B64 = "AVka4hEjBx75uGZ5vinbID06T5b6D5ViU5zTnZJPTRxjAC8sZu/G1BkAEX2Tc7LmtSne7p8UxeuBHa825zGojVJfBJhw0xQvJZXNnFKD4YL+pt2zxgGYgMRo0dxNg0b50IE4";
