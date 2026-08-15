import { gapi } from "gapi-script";
import { loadOpeningHoldings } from "./openingHoldings";
import { loadCorporateActions } from "./corporateActions";
import { loadOpeningTxns } from "./openingTxns";
import type { CashFlow } from "./xirr";
import { loadScripMaster, lookupScrip, normName, SCRIP_MASTER_SPREADSHEET_ID } from "./scripMaster";
import {
  loadPriceGrid, fillColumn, sessionIndexOnOrAfter, sessionIndexAsOf,
  COVERAGE_OK, BENCH_SMALLCAP250, type PriceGrid, type FilledColumn,
} from "./priceHistory";
import { applyTwr, rebaseToIndex, NAV_START_TS, type NavPoint } from "./navMath";

/**
 * Real market-value history: for every trading session, the value of the positions actually held
 * that day, priced at that day's true close.
 *
 * WHY THIS STARTS AT 01-APR-2025 AND NOT EARLIER. `Opening Holdings` is a SNAPSHOT of the lots
 * that survived to 31-Mar-2025, not a transaction history — see holdingsCalc.ts:263, where
 * `useFifo = asOfTs >= openingAsOfTs` switches engines at exactly that date. Lots that were both
 * bought and sold before the cutoff are absent, so replaying share counts backwards past it
 * understates positions. The price grid reaches back two years, but NAV honestly does not: it is
 * clamped to the day after the cutoff. The invested-COST line has no such limit — it is derived
 * from the ledger and is accurate for its whole span — which is why the charts draw cost over the
 * full history and NAV only from the clamp.
 *
 * WHY PERFORMANCE IS TIME-WEIGHTED AND NOT REBASED NAV. Rebasing raw portfolio value to 1000
 * reads capital flows as performance: deploy ₹50L into a ₹2Cr book and the line leaps 25% having
 * earned nothing, and every range button then reports a different total return. So each session's
 * return removes that session's external flow before chaining — `r = (NAV - flow) / NAV_prev - 1`
 * — which is what a unitised fund NAV actually is, and the only form comparable to an index.
 *
 * Conventions deliberately shared with the other engines: same-day ordering is BUY (0) →
 * CORPORATE ACTION (1) → SELL (2), and cost is released on a sell at the running weighted average.
 * This mirrors aumTimeline.ts rather than importing from it: that module collapses every portfolio
 * into one cost total, whereas NAV needs quantity per (portfolio, scrip) at every session, and its
 * position keys are joined with a literal NUL byte which makes the file hostile to editing.
 */

export type { NavPoint } from "./navMath";
export { applyTwr, NAV_START_TS } from "./navMath";

export interface NavPortfolio { id: string; points: NavPoint[] }

export interface NavResult {
  /** Combined across portfolios. */
  total: NavPoint[];
  byPortfolio: NavPortfolio[];
  /** Benchmark, rebased to 1000 at the SAME session the portfolio index starts. */
  benchmark: { ts: number; index: number }[];
  /** First and last session NAV is defined for. */
  fromTs: number | null;
  toTs: number | null;
  /** Ledger names with no usable price column — what a NAV is missing. */
  unpriced: string[];
  /** Sessions whose coverage fell below COVERAGE_OK. */
  lowCoverageCount: number;
  /** Dated cash flows per portfolio id, for the money-weighted return. Investor's signs: buys
   *  negative, sells positive. No terminal value — computeReturns appends that itself so it
   *  always matches the NAV endpoint the CAGR used. */
  flowsById: Map<string, CashFlow[]>;
  /** Portfolio ids whose `Opening Txns` history is absent OR doesn't reach back as far as their
   *  oldest surviving lot, so the pre-FY26 cash flows fall back to those lots alone: every
   *  position opened AND closed before 31-Mar-2025 is missing, which biases XIRR. */
  partialFlowIds: string[];
}

const EMPTY: NavResult = { total: [], byPortfolio: [], benchmark: [], fromTs: null, toTs: null, unpriced: [], lowCoverageCount: 0, flowsById: new Map(), partialFlowIds: [] };

const toNum = (s: any): number => {
  const v = parseFloat((s ?? "").toString().replace(/,/g, "").trim());
  return isNaN(v) ? NaN : v;
};

const SHEET_EPOCH_MS = Date.UTC(1899, 11, 30);
/** Sheet serial / ISO / dd-mm-yyyy → UTC-midnight ms, the one convention used throughout here. */
function dateTs(v: any): number {
  if (typeof v === "number" && isFinite(v)) return SHEET_EPOCH_MS + Math.round(v * 86400000);
  const s = (v ?? "").toString().trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  const t = Date.parse(s);
  return isNaN(t) ? NaN : t;
}

type Side = "BUY" | "SELL" | "CA";
interface Ev {
  ts: number; ord: number; pri: number;
  key: string;            // scrip key within this portfolio
  side: Side;
  qty: number;
  /** BUY: all-in cost. SELL: net proceeds. Both are the CASH leg, used for flow. */
  amount: number;
  /** True for a bonus/split row: adds quantity at zero cost and marks a price boundary. */
  corp?: boolean;
  ca?: { kind: "MERGER" | "DEMERGER"; toKey: string; sharesIn: number; cost: number };
}

/** True Entry → events. Reads sell proceeds too, which the invested-only timeline never needed. */
async function trueEntryEvents(spreadsheetId: string, keyOf: (isin: string, name: string) => string, ord: () => number, names: Map<string, string>): Promise<Ev[]> {
  let res: any;
  try {
    res = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId, range: "True Entry!A:T",
      valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER",
    });
  } catch (e: any) {
    if (/unable to parse range/i.test(e?.result?.error?.message || e?.message || "")) return [];
    throw e;
  }
  const rows: any[][] = res?.result?.values || [];
  if (rows.length < 2) return [];
  const hdrs = rows[0].map((h: any) => (h || "").toString().trim());
  const col = (name: string, fb: number) => { const i = hdrs.indexOf(name); return i >= 0 ? i : fb; };
  const dateIdx = col("Trade Date", 0), nameIdx = col("Stock Name", 2), typeIdx = col("Transaction Type", 3);
  const qtyIdx = col("Number of Shares", 4), priceIdx = col("Avg Price", 5);
  const turnoverIdx = col("Total Amount (Turnover)", 6), inclIdx = col("Total Amount with Expense (Incl STT)", 15);

  const out: Ev[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const rawType = (r[typeIdx] || "").toString();
    const isSell = /sell/i.test(rawType);
    // Bonus / Split / IPO / Rights are buy-side. Bonus and Split carry ₹0 cost, and additionally
    // mark a price boundary so a carried-forward close can't straddle them.
    const isCorp = /bonus|split/i.test(rawType);
    const side: Side | null = isSell ? "SELL" : /buy|bonus|split|ipo|right/i.test(rawType) ? "BUY" : null;
    if (!side) continue;
    const name = (r[nameIdx] || "").toString().trim();
    const qty = toNum(r[qtyIdx]);
    const ts = dateTs(r[dateIdx]);
    if (!name || isNaN(qty) || qty <= 0 || isNaN(ts)) continue;
    const incl = toNum(r[inclIdx]), turn = toNum(r[turnoverIdx]), avg = toNum(r[priceIdx]);
    const cash = incl > 0 ? incl : turn > 0 ? turn : (avg > 0 ? avg * qty : 0);
    const key = keyOf("", name);
    if (!names.has(key)) names.set(key, name);
    out.push({
      ts, ord: ord(), pri: side === "BUY" ? 0 : 2, key, side, qty,
      amount: isCorp ? 0 : cash,
      corp: isCorp,
    });
  }
  return out;
}

/**
 * Resolve a ledger position to its Price History column. The .gs keys columns as
 * `isin || masterEntry.isin || normName(rawName)`, and the app's own canonical key is
 * `isin || normName(canonicalName)` — those coincide most of the time but not always (a renamed
 * scrip), so several candidates are probed rather than committing to one. Returns '' when the
 * scrip has no column at all, which is reported as unpriced instead of valued at zero.
 */
function makeColumnResolver(grid: PriceGrid, master: any) {
  const cache = new Map<string, string>();
  return (isin: string, name: string): string => {
    const ck = `${isin}|${name}`;
    const hit = cache.get(ck);
    if (hit !== undefined) return hit;
    const entry = master ? lookupScrip(master, isin, name).entry : null;
    const cands = [
      (isin || "").trim().toUpperCase(),
      (entry?.isin || "").trim().toUpperCase(),
      entry?.key || "",
      normName(name),
    ];
    let found = "";
    for (const c of cands) {
      if (c && grid.colIndex.has(c)) { found = c; break; }
    }
    cache.set(ck, found);
    return found;
  };
}

export async function computeNavTimeline(
  portfolios: { id: string; sheetId: string }[],
): Promise<NavResult> {
  const grid = await loadPriceGrid();
  if (!grid.dates.length) return EMPTY;

  let master: any = null;
  try { master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID); } catch { /* name-only keys */ }
  const keyOf = (isin: string, name: string): string => {
    if (master) { const e = lookupScrip(master, isin, name).entry; if (e) return e.key; }
    return (isin || "").trim().toUpperCase() || normName(name);
  };
  const resolveCol = makeColumnResolver(grid, master);

  // First session NAV is defined for: the later of the grid's start and the opening-basis clamp.
  const startTs = Math.max(grid.ts[0], NAV_START_TS);
  const i0 = sessionIndexOnOrAfter(grid, startTs);
  if (i0 < 0) return EMPTY;

  const unpriced = new Set<string>();
  const perPortfolio: NavPortfolio[] = [];
  const flowsById = new Map<string, CashFlow[]>();
  const partialFlowIds: string[] = [];

  for (const p of portfolios) {
    let n = 0; const ord = () => n++;
    const names = new Map<string, string>();          // key → a human name, for `unpriced`
    const [lots, te, cas, otx] = await Promise.all([
      loadOpeningHoldings(p.sheetId).catch(() => []),
      trueEntryEvents(p.sheetId, keyOf, ord, names).catch(() => [] as Ev[]),
      loadCorporateActions(p.sheetId).catch(() => []),
      loadOpeningTxns(p.sheetId).catch(() => []),
    ]);

    const events: Ev[] = [...te];
    const isinOf = new Map<string, string>();         // key → ISIN, for column resolution
    for (const l of lots) {
      const ts = dateTs(l.acqDate);
      if (isNaN(ts) || !(l.qty > 0)) continue;
      const key = keyOf(l.isin, l.name);
      if (!names.has(key)) names.set(key, l.name);
      if (l.isin && !isinOf.has(key)) isinOf.set(key, l.isin);
      events.push({ ts, ord: ord(), pri: 0, key, side: "BUY", qty: l.qty, amount: l.qty * (l.costPerShare || 0) });
    }
    for (const ca of cas) {
      const caTs = dateTs(ca.dateStr);
      if (isNaN(caTs)) {
        console.warn(`NAV timeline: skipping corporate action with unparseable date "${ca.dateStr}" (${ca.type} ${ca.from} → ${ca.to}).`);
        continue;
      }
      const fromKey = keyOf("", ca.from), toKey = keyOf("", ca.to);
      if (!names.has(fromKey)) names.set(fromKey, ca.from);
      if (!names.has(toKey)) names.set(toKey, ca.to);
      events.push({
        ts: caTs, ord: ord(), pri: 1, key: fromKey, side: "CA", qty: 0, amount: 0,
        ca: { kind: ca.type === "Merger" ? "MERGER" : "DEMERGER", toKey, sharesIn: ca.sharesIn, cost: ca.cost },
      });
    }
    if (!events.length) { perPortfolio.push({ id: p.id, points: [] }); continue; }
    events.sort((a, b) => (a.ts - b.ts) || (a.pri - b.pri) || (a.ord - b.ord));

    // ── dated CASH flows, for the money-weighted return (XIRR) ────────────────
    // Investor's sign convention: a buy is money out (negative), a sell is money back
    // (positive). NOT clamped to NAV_START_TS — XIRR discounts cash flows rather than replaying
    // positions, so the opening-basis cutoff that binds the NAV series doesn't bind it.
    //
    // The pre-FY26 leg has two possible sources and they are NOT equivalent:
    //   Opening Txns   the full statement history — every buy AND every sell, including
    //                  positions opened and closed before the cutoff. Complete.
    //   opening lots   only the lots that SURVIVED to 31-Mar-2025. Every realised round-trip
    //                  before then is missing, both legs, which biases the rate. Used only as
    //                  a fallback, and the portfolio is reported in `partialFlowIds` so the
    //                  number can be labelled rather than quietly trusted.
    const cash: CashFlow[] = [];
    const preFy26 = otx.filter((t) => {
      const ts = dateTs(t.iso);
      return !isNaN(ts) && ts < NAV_START_TS;
    });
    // A history that exists is not necessarily a history that's COMPLETE: Add-batch mode is fed
    // in slices, so a half-finished seeding leaves a tab holding only the recent years. Every
    // surviving lot was bought at some point, so if the oldest lot predates the oldest recorded
    // transaction, the earlier slices are missing — and using that history alone would be worse
    // than the lots fallback, silently. `min` by loop, not Math.min(...arr): these arrays run to
    // thousands and spreading them overflows the argument stack.
    const minTs = (list: number[]) => list.reduce((m, t) => (isNaN(t) ? m : Math.min(m, t)), Infinity);
    const earliestLot = minTs(lots.filter((l) => l.qty > 0).map((l) => dateTs(l.acqDate)));
    const earliestTxn = minTs(preFy26.map((t) => dateTs(t.iso)));
    const coversAllLots = !isFinite(earliestLot) || earliestTxn <= earliestLot + 7 * 86400000;

    if (preFy26.length && coversAllLots) {
      for (const t of preFy26) {
        if (/bonus|split/i.test(t.type)) continue;             // shares, not cash
        const amt = t.amount > 0 ? t.amount : t.qty * t.price;
        if (!(amt > 0)) continue;
        cash.push({ ts: dateTs(t.iso), amount: /sell/i.test(t.type) ? amt : -amt });
      }
    } else {
      partialFlowIds.push(p.id);   // fall through to the surviving lots below
    }
    const useTxnHistory = preFy26.length > 0 && coversAllLots;
    for (const e of events) {
      // Corporate actions and bonus/split rows carry amount 0, so they drop out here on their
      // own — correct, since none of them move cash.
      if (e.side === "CA" || !e.amount) continue;
      // With a full statement history the surviving lots are already represented by their
      // original purchases; taking them again would double-count the same money.
      if (useTxnHistory && e.ts < NAV_START_TS) continue;
      cash.push({ ts: e.ts, amount: e.side === "BUY" ? -e.amount : e.amount });
    }
    cash.sort((a, b) => a.ts - b.ts);
    flowsById.set(p.id, cash);

    // Corporate-action boundaries per key, as SESSION INDICES — mapped with an as-of lookup so an
    // ex-date falling on a weekend or holiday still lands on a real session.
    const boundaries = new Map<string, Set<number>>();
    const markBoundary = (key: string, ts: number) => {
      const si = sessionIndexOnOrAfter(grid, ts);
      if (si < 0) return;
      let s = boundaries.get(key);
      if (!s) { s = new Set(); boundaries.set(key, s); }
      s.add(si);
    };
    for (const e of events) {
      if (e.corp) markBoundary(e.key, e.ts);
      if (e.side === "CA" && e.ca) { markBoundary(e.key, e.ts); markBoundary(e.ca.toKey, e.ts); }
    }

    // Lazily filled price column per key.
    const cols = new Map<string, FilledColumn | null>();
    const columnFor = (key: string): FilledColumn | null => {
      if (cols.has(key)) return cols.get(key)!;
      const col = resolveCol(isinOf.get(key) || "", names.get(key) || key);
      let filled: FilledColumn | null = null;
      if (col) filled = fillColumn(grid, col, boundaries.get(key) || new Set());
      else unpriced.add(names.get(key) || key);
      cols.set(key, filled);
      return filled;
    };

    // ── replay ────────────────────────────────────────────────────────────────
    const pos = new Map<string, { qty: number; cost: number }>();
    const posOf = (k: string) => { let s = pos.get(k); if (!s) { s = { qty: 0, cost: 0 }; pos.set(k, s); } return s; };
    const points: NavPoint[] = [];
    let ei = 0;
    let prevNav: number | null = null;
    let index: number | null = null;

    for (let i = 0; i < grid.dates.length; i++) {
      const sessionTs = grid.ts[i];
      let flow = 0;
      // Apply every event dated on or before this session. Ledger dates are UTC midnight and so
      // are session stamps, so a same-day trade is included by `<=`.
      while (ei < events.length && events[ei].ts <= sessionTs) {
        const e = events[ei++];
        if (e.side === "CA" && e.ca) {
          const from = posOf(e.key), to = posOf(e.ca.toKey);
          if (e.ca.kind === "MERGER") { from.cost = 0; from.qty = 0; }
          else {
            const rem = from.cost;
            const f = rem > 0 ? Math.max(0, (rem - e.ca.cost) / rem) : 1;
            from.cost = rem * f;                    // parent keeps its shares in a demerger
          }
          to.qty += e.ca.sharesIn; to.cost += e.ca.cost;
          continue;
        }
        const ps = posOf(e.key);
        if (e.side === "BUY") {
          ps.qty += e.qty; ps.cost += e.amount;
          if (i >= i0) flow += e.amount;             // cash in
        } else if (ps.qty > 0) {
          const sellQty = Math.min(e.qty, ps.qty);
          ps.cost -= ps.cost * (sellQty / ps.qty);
          ps.qty -= sellQty;
          if (ps.qty <= 1e-9) { ps.cost = 0; ps.qty = 0; }
          if (i >= i0) flow -= e.amount;             // cash out
        } else {
          // Oversell against a zero/negative position: keep the quantity negative so the
          // discrepancy surfaces, exactly as replayFifoHoldings does.
          ps.qty -= e.qty;
          if (i >= i0) flow -= e.amount;
        }
      }
      if (i < i0) continue;                          // pre-clamp: replay only, emit nothing

      let nav = 0, cost = 0, pricedCost = 0, discrepancy = 0;
      for (const [key, ps] of pos) {
        if (Math.abs(ps.qty) <= 1e-9) continue;
        cost += Math.max(ps.cost, 0);
        const col = columnFor(key);
        const px = col ? col.values[i] : null;
        if (px === null) continue;                   // unpriced → contributes NOTHING to nav
        pricedCost += Math.max(ps.cost, 0);
        if (ps.qty > 0) nav += ps.qty * px;
        else discrepancy += Math.abs(ps.qty) * px;
      }
      const coverage = cost > 0 ? Math.min(1, pricedCost / cost) : 1;
      points.push({ ts: sessionTs, nav, cost, coverage, discrepancy, flow, index: null });
    }
    applyTwr(points);
    perPortfolio.push({ id: p.id, points });
  }

  // ── combine ────────────────────────────────────────────────────────────────
  const sessions = grid.ts.slice(i0);
  const total: NavPoint[] = sessions.map((ts, k) => {
    let nav = 0, cost = 0, pricedCost = 0, discrepancy = 0, flow = 0;
    for (const pf of perPortfolio) {
      const pt = pf.points[k];
      if (!pt) continue;
      nav += pt.nav; cost += pt.cost; discrepancy += pt.discrepancy; flow += pt.flow;
      pricedCost += pt.cost * pt.coverage;
    }
    return { ts, nav, cost, coverage: cost > 0 ? Math.min(1, pricedCost / cost) : 1, discrepancy, flow, index: null };
  });

  // Index the COMBINED navs, not a sum of per-portfolio indices — averaging indices would weight
  // a ₹5L account the same as a ₹2Cr one.
  applyTwr(total);

  // Benchmark rebased at the first session the portfolio index actually starts, so both lines
  // leave 1000 together. Anchoring anywhere else makes the comparison meaningless.
  let anchor = total.findIndex(p => p.index !== null);
  let benchmark: { ts: number; index: number }[] = [];
  if (anchor >= 0 && grid.colIndex.has(BENCH_SMALLCAP250)) {
    const bcol = fillColumn(grid, BENCH_SMALLCAP250, new Set());
    const bench = bcol.values.slice(i0);
    // The anchor must be a session where BOTH series have a value, or the two lines don't both
    // leave 1000 and every reported out/under-performance is off by the gap.
    while (anchor < sessions.length && bench[anchor] === null) anchor++;
    if (anchor < sessions.length) benchmark = rebaseToIndex(bench, sessions, anchor);
  }

  return {
    total,
    byPortfolio: perPortfolio,
    flowsById,
    partialFlowIds,
    benchmark,
    fromTs: sessions.length ? sessions[0] : null,
    toTs: sessions.length ? sessions[sessions.length - 1] : null,
    unpriced: [...unpriced].sort(),
    lowCoverageCount: total.filter(p => p.coverage < COVERAGE_OK).length,
  };
}

/** Re-export so the Dashboard can gate its range presets without importing two modules. */
export { sessionIndexAsOf };
