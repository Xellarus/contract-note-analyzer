import { gapi } from "gapi-script";
import { SCRIP_MASTER_SPREADSHEET_ID } from "./scripMaster";
import { EMPTY_GRID, gridNum, tsOfYmd, ymdCell, type PriceGrid } from "./priceGrid";

/**
 * Sheets read for the "Price History" tab — a wide grid of TRUE (un-adjusted) daily closes written
 * by apps-script/YahooPriceUpdate.gs: row 1 is `Date` then one column per scrip key, one row per
 * IST trading session. Benchmarks live in the same grid under keys prefixed '^'.
 *
 * This is what lets the app value PAST positions at all. Before it existed the Prices tab was a
 * single snapshot, so the only market-value history was a per-day log written when someone
 * happened to open the Dashboard — which is why 6M and 1Y showed almost nothing.
 *
 * Everything computed OVER the grid lives in priceGrid.ts, which has no gapi dependency and is
 * re-exported here so callers need only one import.
 */

export const PRICE_HISTORY_TAB = "Price History";

/** Benchmark column keys, matching BENCHMARKS in the .gs. */
export const BENCH_SMALLCAP250 = "^NIFTYSMLCAP250";
export const BENCH_NIFTY50 = "^NIFTY50";

export {
  COVERAGE_OK, MAX_CARRY_SESSIONS, EMPTY_GRID,
  tsOfYmd, ymdCell, gridNum,
  sessionIndexAsOf, sessionIndexOnOrAfter, fillColumn, gridExtent,
} from "./priceGrid";
export type { PriceGrid, FilledColumn } from "./priceGrid";

/**
 * Read the whole grid in one call (500 × ~330 ≈ 165k cells; a single values.get handles it).
 * Returns EMPTY_GRID when the tab doesn't exist yet, so every caller degrades to "no market
 * history" rather than throwing.
 */
export async function loadPriceGrid(): Promise<PriceGrid> {
  let vals: any[][];
  try {
    const res = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId: SCRIP_MASTER_SPREADSHEET_ID,
      range: `${PRICE_HISTORY_TAB}!A1:ZZ100000`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
    vals = res?.result?.values || [];
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || "";
    if (/unable to parse range/i.test(msg)) return EMPTY_GRID;   // not backfilled yet
    throw e;
  }
  return parsePriceGrid(vals);
}

/** Grid parsing, split out from the fetch so it can be exercised with a fixture. */
export function parsePriceGrid(vals: any[][]): PriceGrid {
  if (!vals || vals.length < 2) return EMPTY_GRID;

  const header = vals[0] || [];
  const colIndex = new Map<string, number>();
  const ordOfHeaderCol: number[] = [];               // header column → ordinal (or -1)
  let keyCount = 0;
  for (let c = 0; c < header.length; c++) {
    if (c === 0) { ordOfHeaderCol.push(-1); continue; }   // the Date column
    const k = (header[c] ?? "").toString().trim();
    if (!k || colIndex.has(k)) { ordOfHeaderCol.push(-1); continue; }
    colIndex.set(k, keyCount);
    ordOfHeaderCol.push(keyCount);
    keyCount++;
  }

  // Collect by date first: the tab is written sorted, but a hand-edit could break that and every
  // consumer assumes ascending dates.
  const byDate = new Map<string, (number | null)[]>();
  for (let r = 1; r < vals.length; r++) {
    const row = vals[r];
    if (!row) continue;
    const ymd = ymdCell(row[0]);
    if (!ymd) continue;
    const out: (number | null)[] = new Array(keyCount).fill(null);
    const lim = Math.min(row.length, ordOfHeaderCol.length);
    for (let c = 1; c < lim; c++) {
      const ord = ordOfHeaderCol[c];
      if (ord < 0) continue;
      out[ord] = gridNum(row[c]);
    }
    byDate.set(ymd, out);
  }

  const dates = [...byDate.keys()].sort();
  const indexOf = new Map<string, number>();
  dates.forEach((d, i) => indexOf.set(d, i));
  return {
    dates,
    ts: dates.map(tsOfYmd),
    colIndex,
    rows: dates.map(d => byDate.get(d)!),
    indexOf,
  };
}
