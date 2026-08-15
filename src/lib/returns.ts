/**
 * Headline return figures — CAGR (time-weighted) and XIRR (money-weighted), for the whole book
 * and per portfolio.
 *
 * The two answer different questions and are SUPPOSED to disagree:
 *
 *   CAGR  annualises the time-weighted index, which strips capital flows out before chaining.
 *         It judges stock selection and is the number comparable to the benchmark.
 *   XIRR  discounts the actual dated cash flows. It judges what the capital earned, timing
 *         included — higher than CAGR when money went in before a run, lower when after.
 *
 * Deliberately PURE (no gapi): the caller hands in the already-computed NAV series and cash
 * flows. That keeps the arithmetic testable, which matters more here than usual because these
 * are single numbers someone will quote rather than a chart shape that hides small errors.
 *
 * Two guards exist because a headline number has no room to be approximately right:
 *
 *  • ENDPOINTS MUST BE FULLY PRICED. An unpriced holding contributes nothing to NAV
 *    (navTimeline drops it rather than valuing it at zero), so a session missing a price is a
 *    session with an understated NAV. The chain self-heals across a gap in the MIDDLE — the
 *    dip and the recovery multiply back to 1 — but a CAGR rests on exactly two points, and a
 *    gap on either one corrupts it with nothing to cancel it out. So endpoints step inward to
 *    the nearest session meeting the coverage bar, and say so when they moved.
 *
 *  • NOTHING UNDER A YEAR IS ANNUALISED. Raising a three-month return to the fourth power
 *    produces a confident-looking number with no basis. Below a year `cagrPct` is null and the
 *    caller shows the cumulative return instead.
 */
import type { NavPoint } from "./navMath";
import { COVERAGE_OK } from "./priceGrid";
import { xirr, DAYS_PER_YEAR, type CashFlow } from "./xirr";

const DAY = 86400000;

/** Below this the return is shown cumulatively; annualising a stub is a fabricated number. */
export const MIN_YEARS_TO_ANNUALISE = 1;

export function yearsBetween(fromTs: number, toTs: number): number {
  return (toTs - fromTs) / (DAY * DAYS_PER_YEAR);
}

/**
 * Compound annual growth rate as a PERCENTAGE, from two index levels and an elapsed span.
 * Null unless both levels are positive and real time passed — a zero or negative index has no
 * growth rate, and neither does a zero-length window.
 */
export function cagrPct(startIndex: number, endIndex: number, years: number): number | null {
  if (!(startIndex > 0) || !(endIndex > 0) || !(years > 0)) return null;
  const r = Math.pow(endIndex / startIndex, 1 / years) - 1;
  return isFinite(r) ? r * 100 : null;
}

export interface Endpoints {
  start: NavPoint;
  end: NavPoint;
  /** True when the endpoint stepped inward off a session priced worse than the book's norm. */
  trimmedStart: boolean;
  trimmedEnd: boolean;
  /** The book's typical coverage — how much of it is priced on an ordinary session. */
  medianCoverage: number;
  /** Coverage difference between the two endpoints. This is what actually skews a CAGR. */
  coverageSkew: number;
}

/** Below this the book is too sparsely priced for any return figure to mean anything. */
export const COVERAGE_FLOOR = 0.80;
/** How far below the book's own norm an endpoint may sit, in coverage fraction. */
export const COVERAGE_TOL = 0.01;

/** A session that could serve as an endpoint at all, before the coverage test. */
const priced = (p: NavPoint) => p.index !== null && p.index > 0 && p.nav > 0;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * First and last sessions usable as endpoints — judged RELATIVE to the book's own normal
 * coverage, not against an absolute bar.
 *
 * The absolute test this replaces looked right and was wrong. A CAGR is a RATIO of two index
 * levels, so a holding with no price on ANY session understates both ends by roughly the same
 * proportion and largely cancels; it lowers coverage permanently without distorting the growth
 * rate. Testing every session against a flat 98% therefore rejected entire books — the combined
 * series especially, whose coverage is cost-weighted across every portfolio, so one permanently
 * unpriced scrip anywhere sank every session at once and the whole book reported "no measurable
 * window".
 *
 * What genuinely corrupts a CAGR is a coverage CHANGE between the two endpoints: a holding
 * priced on most days but missing on the first or last. So endpoints must sit within `tol` of
 * the book's median coverage, and the residual gap between them is returned as `coverageSkew`
 * for the caller to disclose. `COVERAGE_FLOOR` still refuses a book too sparse to measure at all.
 */
export function pickEndpoints(points: NavPoint[], minCoverage = COVERAGE_OK): Endpoints | null {
  if (!points || points.length < 2) return null;
  const cands = points.filter(priced);
  if (cands.length < 2) return null;

  const med = median(cands.map((p) => p.coverage));
  if (med < COVERAGE_FLOOR) return null;                    // too little of the book is priced
  // Never demand more than the book actually achieves; never accept below the floor.
  const bar = Math.max(COVERAGE_FLOOR, Math.min(minCoverage, med - COVERAGE_TOL));
  const usable = (p: NavPoint) => priced(p) && p.coverage >= bar;

  let i = 0;
  while (i < points.length && !usable(points[i])) i++;
  let j = points.length - 1;
  while (j >= 0 && !usable(points[j])) j--;
  if (i >= j) return null;

  return {
    start: points[i],
    end: points[j],
    trimmedStart: i > 0,
    trimmedEnd: j < points.length - 1,
    medianCoverage: med,
    coverageSkew: Math.abs(points[j].coverage - points[i].coverage),
  };
}

export interface ReturnRow {
  id: string;
  label: string;

  // ── time-weighted ──
  fromTs: number | null;
  toTs: number | null;
  years: number;
  /** Total growth of the index across the window, %. Shown when CAGR is suppressed. */
  cumulativePct: number | null;
  /** Annualised, or null under MIN_YEARS_TO_ANNUALISE / with no usable window. */
  cagrPct: number | null;

  // ── money-weighted ──
  xirrPct: number | null;
  /** Date of the first cash flow — can predate the NAV series by years. */
  xirrFromTs: number | null;
  xirrFlowCount: number;
  /** Capital came back out and went in again, so the rate solved isn't provably unique. */
  xirrAmbiguous: boolean;

  /** Closing market value used as XIRR's terminal inflow (= the NAV at `toTs`). */
  terminalValue: number | null;

  /** How much of the book is priced on a typical session, 0..1. Diagnostic. */
  medianCoverage: number | null;
  /** Coverage gap between the two endpoints — what would skew the CAGR. Diagnostic. */
  coverageSkew: number | null;
  /** Sessions that had an index at all, whether or not they qualified as endpoints. */
  sessionCount: number;

  /** Plain-language caveats to show with the numbers. */
  notes: string[];
}

export interface ReturnsInput {
  total: NavPoint[];
  byPortfolio: { id: string; label: string; points: NavPoint[] }[];
  /** Rebased benchmark index, for the excess figure. */
  benchmark?: { ts: number; index: number }[];
  benchmarkLabel?: string;
  /**
   * Dated cash flows per portfolio id, WITHOUT a terminal value — this module appends that
   * itself, so it always matches the NAV endpoint the CAGR used.
   */
  flowsById: Map<string, CashFlow[]>;
  minCoverage?: number;
}

export interface ReturnsResult {
  total: ReturnRow;
  byPortfolio: ReturnRow[];
  /** Benchmark CAGR over the TOTAL row's window, and the portfolio's excess over it. */
  benchmarkCagrPct: number | null;
  excessCagrPct: number | null;
  benchmarkLabel: string;
}

const EMPTY_ROW = (id: string, label: string, note: string, diag?: Partial<ReturnRow>): ReturnRow => ({
  id, label,
  fromTs: null, toTs: null, years: 0, cumulativePct: null, cagrPct: null,
  xirrPct: null, xirrFromTs: null, xirrFlowCount: 0, xirrAmbiguous: false,
  terminalValue: null, medianCoverage: null, coverageSkew: null, sessionCount: 0,
  notes: [note], ...diag,
});

/** Value of `series` at the latest point on or before `ts` (null if it starts later). */
function levelAsOf(series: { ts: number; index: number }[], ts: number): number | null {
  let out: number | null = null;
  for (const p of series) { if (p.ts > ts) break; out = p.index; }
  return out;
}

function buildRow(id: string, label: string, points: NavPoint[], flows: CashFlow[], minCoverage: number): ReturnRow {
  const ep = pickEndpoints(points, minCoverage);
  if (!ep) {
    // Say WHY, with the numbers. "No measurable window" on its own sends the reader hunting in
    // the wrong place — the cause is almost always upstream, in what the price grid covers.
    const live = points.filter((p) => p.index !== null && p.index > 0 && p.nav > 0);
    const med = live.length ? median(live.map((p) => p.coverage)) : 0;
    const why = !points.length ? "no NAV history"
      : !live.length ? "no session has both a value and a started index"
      : live.length < 2 ? "only one usable session so far"
      : med < COVERAGE_FLOOR ? `only ${(med * 100).toFixed(0)}% of the book is priced on a typical session — too little to measure a return from`
      : "no two sessions priced consistently enough to measure between";
    return EMPTY_ROW(id, label, why, {
      medianCoverage: live.length ? med : null,
      sessionCount: live.length,
    });
  }

  const notes: string[] = [];
  const years = yearsBetween(ep.start.ts, ep.end.ts);
  const cumulative = ep.start.index! > 0 ? (ep.end.index! / ep.start.index! - 1) * 100 : null;
  const annualised = years >= MIN_YEARS_TO_ANNUALISE ? cagrPct(ep.start.index!, ep.end.index!, years) : null;

  if (annualised === null && cumulative !== null) {
    notes.push(`under a year of history (${Math.round(years * DAYS_PER_YEAR)} days) — cumulative, not annualised`);
  }
  if (ep.trimmedStart || ep.trimmedEnd) {
    notes.push("window trimmed to the nearest consistently-priced sessions");
  }
  if (ep.medianCoverage < COVERAGE_OK) {
    notes.push(`only ${(ep.medianCoverage * 100).toFixed(1)}% of the book is priced on a typical session — the level is understated throughout, though a constant shortfall largely cancels in a growth rate`);
  }
  if (ep.coverageSkew > COVERAGE_TOL) {
    notes.push(`the two endpoints differ by ${(ep.coverageSkew * 100).toFixed(1)}pp of pricing coverage, which skews the rate by roughly that much over the window`);
  }

  // XIRR: the real dated flows, closed off with the SAME endpoint value the CAGR used, so a
  // partly-priced last session can't quietly understate what the book is worth.
  const upto = flows.filter((f) => isFinite(f.ts) && f.ts <= ep.end.ts && f.amount !== 0);
  const withTerminal: CashFlow[] = ep.end.nav > 0
    ? [...upto, { ts: ep.end.ts, amount: ep.end.nav }]
    : [...upto];
  const solved = xirr(withTerminal);
  if (solved.rate === null && upto.length > 0) notes.push(`XIRR: ${solved.note ?? "unsolvable"}`);
  if (!upto.length) notes.push("no cash-flow history for XIRR");
  if (solved.ambiguous) notes.push("capital left and re-entered — XIRR is one of several valid rates");

  const firstFlow = upto.length ? Math.min(...upto.map((f) => f.ts)) : null;
  if (firstFlow !== null && firstFlow < ep.start.ts) {
    notes.push("XIRR reaches back further than the NAV series, so it covers a longer period than the CAGR");
  }

  return {
    id, label,
    fromTs: ep.start.ts, toTs: ep.end.ts, years,
    cumulativePct: cumulative,
    cagrPct: annualised,
    xirrPct: solved.rate === null ? null : solved.rate * 100,
    xirrFromTs: firstFlow,
    xirrFlowCount: upto.length,
    xirrAmbiguous: !!solved.ambiguous,
    terminalValue: ep.end.nav,
    medianCoverage: ep.medianCoverage,
    coverageSkew: ep.coverageSkew,
    sessionCount: points.filter((p) => p.index !== null).length,
    notes,
  };
}

export function computeReturns(inp: ReturnsInput): ReturnsResult {
  const minCoverage = inp.minCoverage ?? COVERAGE_OK;
  const benchmarkLabel = inp.benchmarkLabel ?? "NIFTY Smallcap 250";

  // The whole book's flows are every portfolio's flows on one timeline.
  const allFlows: CashFlow[] = [];
  for (const list of inp.flowsById.values()) allFlows.push(...list);
  allFlows.sort((a, b) => a.ts - b.ts);

  const total = buildRow("total", "All portfolios", inp.total, allFlows, minCoverage);
  const byPortfolio = inp.byPortfolio.map((p) =>
    buildRow(p.id, p.label, p.points, inp.flowsById.get(p.id) ?? [], minCoverage),
  );

  // Benchmark measured over exactly the total row's window, so the excess is like-for-like.
  let benchmarkCagrPct: number | null = null;
  if (inp.benchmark?.length && total.fromTs !== null && total.toTs !== null && total.cagrPct !== null) {
    const b0 = levelAsOf(inp.benchmark, total.fromTs);
    const b1 = levelAsOf(inp.benchmark, total.toTs);
    if (b0 !== null && b1 !== null) benchmarkCagrPct = cagrPct(b0, b1, total.years);
  }

  return {
    total,
    byPortfolio,
    benchmarkCagrPct,
    excessCagrPct: total.cagrPct !== null && benchmarkCagrPct !== null ? total.cagrPct - benchmarkCagrPct : null,
    benchmarkLabel,
  };
}
