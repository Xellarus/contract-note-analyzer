/**
 * The valuation maths for the market-value charts, with no I/O — so it can be tested directly.
 * The Sheets reads and the ledger replay live in navTimeline.ts.
 */

export interface NavPoint {
  ts: number;
  /** Market value of open positions, ₹. Negative quantities are excluded (see `discrepancy`). */
  nav: number;
  /** Cost of open positions on that session, ₹ — the same basis the invested line uses. */
  cost: number;
  /** Fraction of cost that was actually priced, 0..1. Below COVERAGE_OK, `nav` is partial. */
  coverage: number;
  /** |negative qty × close| — oversold positions, reported rather than folded into NAV. */
  discrepancy: number;
  /** Net external flow this session: cash in (buys) − cash out (sells), ₹. */
  flow: number;
  /** Time-weighted index, 1000 at the first trustworthy session. null until it can start. */
  index: number | null;
}

/**
 * The day after holdingsCalc's opening-basis cutoff (31-Mar-2025). Before it, `Opening Holdings`
 * is a SNAPSHOT of surviving lots rather than a transaction history — lots both bought and sold
 * before the cutoff are simply absent — so replayed share counts understate positions and any NAV
 * derived from them is wrong. See holdingsCalc.ts:263, where `useFifo` switches engines at exactly
 * this date. The invested-COST line has no such limit and keeps its full span.
 */
export const NAV_START_TS = Date.parse("2025-04-01T00:00:00Z");

/**
 * Chain each session's flow-adjusted return into an index based at 1000, in place.
 *
 * `r = (NAV − flow) / NAV_prev` removes money that entered or left the portfolio that session, so
 * only price movement compounds. This is the whole difference between a performance chart and a
 * cash-flow chart: without it, deploying ₹50L into a ₹2Cr book shows as a 25% gain having earned
 * nothing, and each range button reports a different total return for the same portfolio.
 *
 * `NAV_prev` is the last session that HELD something, not merely the previous session, so a
 * portfolio that goes fully to cash and is later redeployed doesn't book the redeployment as a
 * return.
 */
export function applyTwr(points: NavPoint[]): void {
  let index: number | null = null;
  let prevNav: number | null = null;
  for (const pt of points) {
    if (prevNav !== null && prevNav > 0 && index !== null) {
      const r = (pt.nav - pt.flow) / prevNav;
      // A non-finite or non-positive ratio means the series is degenerate here (fully exited, or a
      // flow larger than the book). Carry the index rather than invent a return.
      if (isFinite(r) && r > 0) index = index * r;
    } else if (pt.nav > 0) {
      index = 1000;                                    // first session holding anything
    }
    pt.index = index;
    if (pt.nav > 0) prevNav = pt.nav;
  }
}

/**
 * Rebase a raw price/level series to 1000 at `anchorIdx`. Used for the benchmark, which has no
 * flows and so needs no time-weighting — but MUST be anchored on the same session the portfolio
 * index starts, or the two lines don't leave 1000 together and the comparison is meaningless.
 */
export function rebaseToIndex(
  values: (number | null)[],
  ts: number[],
  anchorIdx: number,
): { ts: number; index: number }[] {
  const base = values[anchorIdx];
  if (!base || base <= 0) return [];
  const out: { ts: number; index: number }[] = [];
  for (let i = anchorIdx; i < values.length; i++) {
    const v = values[i];
    if (v !== null) out.push({ ts: ts[i], index: (v / base) * 1000 });
  }
  return out;
}
