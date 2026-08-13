/**
 * The Price History grid's shape and the pure computation over it. Deliberately free of any
 * `gapi` import so the maths can be exercised outside a browser — the fill bounds and the session
 * lookups here are what stop the charts from lying, and untestable correctness code is not
 * correctness code. The Sheets read lives in priceHistory.ts.
 */

/** Below this fraction of the book (by cost) priced, a NAV point is not trustworthy. */
export const COVERAGE_OK = 0.98;

/** Default cap on how many sessions a stale close may be carried forward. */
export const MAX_CARRY_SESSIONS = 7;

export interface PriceGrid {
  /** IST session dates, ascending, `yyyy-mm-dd`. */
  dates: string[];
  /** UTC-midnight epoch ms for each entry of `dates`, so callers never re-parse. */
  ts: number[];
  /** Column key → column ordinal in `rows`. */
  colIndex: Map<string, number>;
  /** rows[dateIdx][colOrdinal] — the close, or null when the cell was blank. */
  rows: (number | null)[][];
  /** dateIdx by date string, for O(1) lookup. */
  indexOf: Map<string, number>;
}

export const EMPTY_GRID: PriceGrid = {
  dates: [], ts: [], colIndex: new Map(), rows: [], indexOf: new Map(),
};

const SHEET_EPOCH_MS = Date.UTC(1899, 11, 30);

/**
 * A date cell → `yyyy-mm-dd`. The .gs pins column A to TEXT so it should already be an ISO string,
 * but Sheets has coerced this column before (the trap that broke the Prices tab and the Corp
 * Action Alerts tab), so serials and Date objects are tolerated on read.
 */
export function ymdCell(v: any): string {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) return isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "number" && isFinite(v)) {
    return new Date(SHEET_EPOCH_MS + Math.round(v) * 86400000).toISOString().slice(0, 10);
  }
  const s = v.toString().trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);        // dd-mm-yyyy
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const t = Date.parse(s);
  return isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10);
}

/** `yyyy-mm-dd` → UTC midnight ms. ONE date convention for every series in the charts. */
export const tsOfYmd = (ymd: string): number => Date.parse(`${ymd}T00:00:00Z`);

export const gridNum = (v: any): number | null => {
  if (typeof v === "number") return isFinite(v) && v > 0 ? v : null;
  const s = (v ?? "").toString().replace(/,/g, "").trim();
  if (!s) return null;
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? n : null;
};

/**
 * The LAST session at or before `ts`, or -1 when `ts` precedes the grid; clamps to the final
 * session when `ts` is past the end.
 *
 * Never match a trade or corporate-action date to a session by equality: a Saturday trade date, a
 * settlement holiday, or an ex-date on a non-trading day would silently find nothing.
 */
export function sessionIndexAsOf(grid: PriceGrid, ts: number): number {
  let lo = 0, hi = grid.ts.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (grid.ts[mid] <= ts) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** The FIRST session at or after `ts`, or -1 when `ts` is past the grid. */
export function sessionIndexOnOrAfter(grid: PriceGrid, ts: number): number {
  let lo = 0, hi = grid.ts.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (grid.ts[mid] >= ts) { best = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return best;
}

export interface FilledColumn {
  /** One entry per session; null means genuinely unpriced — never 0, never a cost fallback. */
  values: (number | null)[];
  /** True where the value was carried forward rather than actually observed. */
  carried: boolean[];
  /** Sessions that had a real close. */
  observed: number;
}

/**
 * Forward-fill one scrip's column under two hard bounds. A blank cell is a session the scrip did
 * not trade (or Yahoo had no bar); carrying the last close forward is the obvious fix and is
 * dangerous in two specific ways:
 *
 *   • Across a split/bonus ex-date it multiplies that stretch of NAV by the split factor — for a
 *     10:1 that is a 10× overstatement until the next real bar. `boundaries` holds the session
 *     indices where a corporate action takes effect for this scrip, and a carry never crosses one.
 *   • For a suspended or delisted scrip it prints a value the position no longer has, forever.
 *     So a carry also expires after `maxCarry` sessions.
 *
 * Past either bound the value is null: unpriced, to be reported as such.
 */
export function fillColumn(
  grid: PriceGrid,
  key: string,
  boundaries: Set<number> = new Set(),
  maxCarry: number = MAX_CARRY_SESSIONS,
): FilledColumn {
  const n = grid.dates.length;
  const values: (number | null)[] = new Array(n).fill(null);
  const carried: boolean[] = new Array(n).fill(false);
  const ord = grid.colIndex.get(key);
  if (ord === undefined) return { values, carried, observed: 0 };

  let last: number | null = null;
  let age = 0;
  let observed = 0;
  for (let i = 0; i < n; i++) {
    if (boundaries.has(i)) { last = null; age = 0; }   // a corporate action invalidates the carry
    const v = grid.rows[i][ord];
    if (v !== null) { values[i] = v; last = v; age = 0; observed++; continue; }
    if (last !== null && age < maxCarry) { values[i] = last; carried[i] = true; age++; }
    // else: stays null — unpriced
  }
  return { values, carried, observed };
}

/** The grid's own extent, for gating the range presets off real data rather than a guess. */
export function gridExtent(grid: PriceGrid): { from: number; to: number } | null {
  if (!grid.dates.length) return null;
  return { from: grid.ts[0], to: grid.ts[grid.ts.length - 1] };
}
