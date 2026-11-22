// Payments out of the private balance; the Rings account key pays the network fee. Background only.
import type { ShieldedAddress } from "@heliuslabs/spr";
import { sendPrivately, unshield, type Ctx, type OnSent, type Sent } from "./rings";
import type { Network } from "./net";

export type Paid = Sent & { paidBy: "account" };

export async function payPrivately(ctx: Ctx, mint: string, units: bigint, to: ShieldedAddress, onSent?: OnSent, fee = 0n): Promise<Paid> {
  return { ...(await sendPrivately(ctx, mint, units, to, { onSent, fee })), paidBy: "account" };
}

export async function withdrawTo(ctx: Ctx, mint: string, units: bigint, to: string, onSent?: OnSent, fee = 0n): Promise<Paid> {
  return { ...(await unshield(ctx, mint, units, to, { onSent, fee })), paidBy: "account" };
}

/** Always false: the wallet never asks Rings to sponsor network fees. */
export const ringsPaysFees = async (_network: Network): Promise<boolean> => false;
