// SQL report aggregates. src/lib/reports.ts is the in-memory oracle these are tested against.
// Days and months are Asia/Dhaka (BR-5): created_at is converted to Dhaka local time before it is
// bucketed, because the database and Vercel run in UTC. Voided sales never count (BR-4).

import { sql } from "drizzle-orm";
import { dhakaDayStart, shiftDays } from "../lib/time";
import type { Db } from "./db-types";

export interface PeriodTotalsRow {
  period: string; // "YYYY-MM-DD" or "YYYY-MM" (Dhaka)
  barberId: number;
  count: number; // sales (customers)
  services: number; // service units
  total: number;
  barberShare: number;
  ownerShare: number;
}

export interface PeriodTotalsQuery {
  from: string; // inclusive Dhaka date key
  to: string; // inclusive Dhaka date key
  mode: "day" | "month";
}

/** Per period and barber, newest period first (same shape as reports.ts `byPeriod`, minus names). */
export async function periodTotals(db: Db, q: PeriodTotalsQuery): Promise<PeriodTotalsRow[]> {
  const res = await db.execute(periodTotalsSql(q));
  // Sums come back as bigint strings from the driver; money is whole taka so Number is exact.
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    period: String(r.period),
    barberId: Number(r.barberId),
    count: Number(r.count),
    services: Number(r.services),
    total: Number(r.total),
    barberShare: Number(r.barberShare),
    ownerShare: Number(r.ownerShare),
  }));
}

/** The statement itself, exported so tests can EXPLAIN exactly what runs in production. */
export function periodTotalsSql(q: PeriodTotalsQuery) {
  const start = dhakaDayStart(q.from).toISOString();
  const end = dhakaDayStart(shiftDays(q.to, 1)).toISOString();
  const pattern = q.mode === "day" ? "YYYY-MM-DD" : "YYYY-MM";
  return sql`
    select
      to_char(s.created_at at time zone 'Asia/Dhaka', ${pattern}::text) as "period",
      s.barber_id as "barberId",
      count(*)::int as "count",
      coalesce(sum(i.units), 0)::bigint as "services",
      sum(s.total)::bigint as "total",
      sum(s.barber_share)::bigint as "barberShare",
      sum(s.owner_share)::bigint as "ownerShare"
    from sales s
    left join lateral (select sum(qty) as units from sale_items where sale_id = s.id) i on true
    where s.voided_at is null
      and s.created_at >= ${start}::timestamptz
      and s.created_at < ${end}::timestamptz
    group by 1, 2
    order by 1 desc, 2 asc
  `;
}
