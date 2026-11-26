// Payout API actions: admin only (FR-4). The balance view also feeds the admin Barbers screen.

import { db } from "@/db";
import { requireAdmin } from "@/lib/auth";
import { payoutDeleteInput, payoutInput } from "@/lib/schemas";
import type { Payout } from "@/lib/types";
import { parseInput, runAction, type ActionResult } from "@/server/action";
import * as payouts from "@/server/payouts";
import type { BarberBalance } from "@/server/payouts";

export interface PayoutsView {
  payouts: Payout[];
  balances: BarberBalance[];
}

export async function getPayoutsView(): Promise<ActionResult<PayoutsView>> {
  return runAction(async () => {
    await requireAdmin();
    const [list, balances] = await Promise.all([payouts.listPayouts(db), payouts.barberBalances(db)]);
    return { payouts: list, balances };
  });
}

export async function addPayout(input: unknown): Promise<ActionResult<Payout>> {
  return runAction(async () => {
    await requireAdmin();
    const p = await payouts.addPayout(db, parseInput(payoutInput, input));
    return p;
  });
}

export async function deletePayout(input: unknown): Promise<ActionResult<null>> {
  return runAction(async () => {
    await requireAdmin();
    await payouts.deletePayout(db, parseInput(payoutDeleteInput, input).id);
    return null;
  });
}
