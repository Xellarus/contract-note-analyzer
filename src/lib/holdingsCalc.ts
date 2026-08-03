import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import {
  normName, loadScripMaster, resolveScrip, lookupScrip, findNameCollisions, ScripMaster, ScripEntry, NameCollision,
  SCRIP_MASTER_SPREADSHEET_ID,
} from "./scripMaster";
import { loadScripPrices, makePriceResolver } from "./scripPrices";
import { loadScripIndustries, makeIndustryResolver } from "./scripIndustries";
import { loadCorporateActions, CorpAction } from "./corporateActions";
import { loadOpeningHoldings } from "./openingHoldings";
import { loadOpeningTxns } from "./openingTxns";
import { loadOpeningCorpActions } from "./openingCorpActions";
import { replayOpeningTxnsAsOf, classifyTxn, TxnStatementRow, ActionResolution } from "./openingBasis";
import { ledgerSide, isSplitType } from "./tradeRowSchema";

export interface UnresolvedScrip {
  name: string;
  isin: string;
  candidates: ScripEntry[];
}

export interface RebuildHoldingResult {
  positions: number;
  totalInvested: number;
  tradeRows: number;
  unresolved: UnresolvedScrip[];
  master: ScripMaster;
  // Names this portfolio uses that map to 2+ scrip-master entries (e.g. a rename left an
  // old entry behind) → those trades won't merge into one holding. Surfaced as a warning.
  nameCollisions: NameCollision[];
}

interface HoldingAcc {
  isin: string;
  securityName: string;
  quantity: number;
  avgBuyPrice: number;
}

const toNum = (s: any): number => {
  const v = parseFloat((s ?? "").toString().replace(/,/g, "").trim());
  return isNaN(v) ? NaN : v;
};

// A Google Sheets date **serial** (days since 1899-12-30) → epoch ms at local
// midnight. Reading dates as serials is unambiguous; reading the *displayed*
// string is not (a `mm-dd-yyyy`-formatted cell looks like `07-23-2025`, which a
// day-first parser misreads as month 23 → a wrong/future date).
const SHEET_EPOCH_MS = Date.UTC(1899, 11, 30);
const serialToTs = (serial: number): number => {
  const d = new Date(SHEET_EPOCH_MS + Math.round(serial * 86400000));
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
};

// Accepts a Sheets date **serial number** (preferred — unambiguous) or a string
// (DD/MM/YYYY, DD-MM-YYYY, DD-MMM-YYYY, YYYY-MM-DD). → epoch ms (0 if unparseable).
const parseDateTs = (s: any): number => {
  if (s === null || s === undefined || s === "") return 0;
  if (typeof s === "number") return isFinite(s) ? serialToTs(s) : 0;
  const c = s.toString().trim();
  if (!c) return 0;
  let m = c.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1])).getTime();
  m = c.match(/^(\d{1,2})[\/\-]([A-Za-z]+)[\/\-](\d{4})$/);
  if (m) {
    const mo = new Date(Date.parse(`${m[2]} 1, 2000`)).getMonth();
    return new Date(parseInt(m[3]), mo, parseInt(m[1])).getTime();
  }
  m = c.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])).getTime();
  const ts = Date.parse(c);
  return isNaN(ts) ? 0 : ts;
};

interface ReplayTrade { ts: number; idx: number; isin: string; name: string; type: string; qty: number; price: number; }

/**
 * Collapse same-scrip, same-day trades into a single net trade so that intraday
 * round-trips don't pollute the holding's weighted-average cost. For each
 * (scrip, day) the matched quantity — min(that day's buys, that day's sells) —
 * is an intraday square-off and is dropped; only the surplus remains:
 *   • net BUY  → one buy of the surplus at the day's weighted-average buy price
 *   • net SELL → one sell of the surplus (a sell carries no cost into the holding)
 *   • net zero → nothing (fully squared off).
 * Same-day pure buys / pure sells also collapse to one trade, which is identical
 * for weighted-average purposes and removes any intra-day ordering ambiguity.
 * Rows with an unparseable date (ts <= 0) pass through untouched.
 */
function squareOffIntraday(trades: ReplayTrade[], keyOf: (t: ReplayTrade) => string): ReplayTrade[] {
  const groups = new Map<string, ReplayTrade[]>();
  const out: ReplayTrade[] = [];
  for (const t of trades) {
    if (t.type === "SPLIT") { out.push(t); continue; }  // a split rescales lots — never a round-trip leg, never netted
    if (t.ts <= 0) { out.push(t); continue; }       // undated row — leave as-is
    const gk = keyOf(t) + "@" + t.ts;
    const g = groups.get(gk);
    if (g) g.push(t); else groups.set(gk, [t]);
  }
  for (const g of groups.values()) {
    if (g.length === 1) { out.push(g[0]); continue; }
    let buyQty = 0, sellQty = 0, buyVal = 0, minIdx = Infinity, proto = g[0];
    for (const t of g) {
      if (t.idx < minIdx) minIdx = t.idx;
      if (!proto.isin && t.isin) proto = t;          // prefer a row carrying an ISIN
      if (t.type === "BUY") { buyQty += t.qty; buyVal += t.qty * t.price; }
      else sellQty += t.qty;
    }
    const net = buyQty - sellQty;
    if (net > 0) out.push({ ts: g[0].ts, idx: minIdx, isin: proto.isin, name: proto.name, type: "BUY", qty: net, price: buyVal / buyQty });
    else if (net < 0) out.push({ ts: g[0].ts, idx: minIdx, isin: proto.isin, name: proto.name, type: "SELL", qty: -net, price: 0 });
    // net === 0 → fully intraday, contributes nothing to the holding
  }
  // Same-day order: buy (0) → split (1) → sell (2), so a split rescales lots before a
  // same-day sell consumes them and after a same-day buy is added.
  const ordType = (t: ReplayTrade) => (t.type === "BUY" ? 0 : t.type === "SPLIT" ? 1 : 2);
  out.sort((a, b) => (a.ts - b.ts) || (ordType(a) - ordType(b)) || (a.idx - b.idx));
  return out;
}

// ── FIFO holding replay ─────────────────────────────────────────────────────
// Shared by the live Holding tab (`rebuildHoldingTab`) and the Historical Holding
// Report (`computeHoldingsAsOf`) so a portfolio's holding is computed the SAME way the
// FIFO capital-gains engine consumes lots — a SELL removes the OLDEST lots first, and
// the survivors ARE the holding. This replaces the previous weighted-average cost basis.
//
// Only the LOT MATCHING changed. The per-lot cost basis is whatever the caller seeds /
// buys at: the callers pass the all-in incl-STT buy cost, so "Invested Value" keeps its
// established all-in meaning — a FIFO sell just decides WHICH lots' cost survives.
//
// `netQty` is tracked independently of the surviving lots so an oversold position (more
// sold than ever held — a data error) surfaces as a NEGATIVE quantity, exactly like the
// old weighted-average path, instead of being silently clamped.
export interface FifoSeedLot { qty: number; price: number; ts: number; }
export type FifoHoldingEvent =
  | { kind: "BUY"; key: string; ts: number; qty: number; price: number }
  | { kind: "SELL"; key: string; ts: number; qty: number }
  | { kind: "SPLIT"; key: string; ts: number; qty: number }
  | { kind: "MERGER"; ts: number; fromKey: string; toKey: string; sharesIn: number; cost: number }
  | { kind: "DEMERGER"; ts: number; fromKey: string; toKey: string; sharesIn: number; cost: number };
export interface FifoHoldingOut { netQty: number; invested: number; }

export function replayFifoHoldings(
  seed: Map<string, FifoSeedLot[]>,
  events: FifoHoldingEvent[],
): Map<string, FifoHoldingOut> {
  interface L { remaining: number; price: number; ts: number; }
  const lots = new Map<string, L[]>();
  const netQty = new Map<string, number>();
  const bump = (k: string, dq: number) => netQty.set(k, (netQty.get(k) || 0) + dq);
  const getLots = (k: string) => { let a = lots.get(k); if (!a) { a = []; lots.set(k, a); } return a; };

  // Seed carried-in lots (oldest first within each scrip).
  for (const [k, arr] of seed) {
    const a = getLots(k);
    for (const l of arr) { a.push({ remaining: l.qty, price: l.price, ts: l.ts }); bump(k, l.qty); }
    a.sort((x, y) => x.ts - y.ts);
  }

  // Date order: BUY (0) → SPLIT / MERGER / DEMERGER (1) → SELL (2), mirroring the FIFO
  // capital-gains engine so the surviving lots line up with it.
  const ordOf = (e: FifoHoldingEvent) => (e.kind === "BUY" ? 0 : e.kind === "SELL" ? 2 : 1);
  const evs = [...events].sort((a, b) => (a.ts - b.ts) || (ordOf(a) - ordOf(b)));

  for (const e of evs) {
    if (e.kind === "BUY") {
      // If the scrip is currently oversold (netQty < 0 from a prior data-error sell), the
      // buy first COVERS that deficit — only the surplus becomes a held lot — so Σremaining
      // stays equal to netQty and invested isn't inflated by phantom shares. (Matches the old
      // weighted-avg path, which reset cost to the buy price when a buy crossed back above 0.)
      const cur = netQty.get(e.key) || 0;
      const rem = cur < 0 ? Math.max(0, e.qty + cur) : e.qty;
      getLots(e.key).push({ remaining: rem, price: e.price, ts: e.ts });
      bump(e.key, e.qty);
    } else if (e.kind === "SELL") {
      let left = e.qty;
      for (const l of getLots(e.key)) {
        if (left <= 1e-9) break;
        if (l.remaining <= 0) continue;
        const m = Math.min(l.remaining, left);
        l.remaining -= m; left -= m;
      }
      bump(e.key, -e.qty);   // may drive netQty negative → surfaced as a discrepancy
    } else if (e.kind === "SPLIT") {
      const a = getLots(e.key);
      const held = a.reduce((s, l) => s + l.remaining, 0);
      if (held > 1e-9 && e.qty > 0) {
        const f = (held + e.qty) / held;   // total cost preserved: qty ×f, cost/share ÷f
        for (const l of a) { l.remaining *= f; l.price = l.price / f; }
        bump(e.key, e.qty);
      }
    } else if (e.kind === "MERGER") {
      for (const l of getLots(e.fromKey)) l.remaining = 0;   // target absorbed
      netQty.set(e.fromKey, 0);
      const px = e.sharesIn > 0 ? e.cost / e.sharesIn : 0;
      getLots(e.toKey).push({ remaining: e.sharesIn, price: px, ts: e.ts });
      bump(e.toKey, e.sharesIn);
    } else {   // DEMERGER — reduce parent lots' cost, spin off a fresh NewCo lot
      const a = getLots(e.fromKey);
      const remCost = a.reduce((s, l) => s + l.remaining * l.price, 0);
      const f = remCost > 0 ? Math.max(0, (remCost - e.cost) / remCost) : 1;
      for (const l of a) l.price = l.price * f;
      const px = e.sharesIn > 0 ? e.cost / e.sharesIn : 0;
      getLots(e.toKey).push({ remaining: e.sharesIn, price: px, ts: e.ts });
      bump(e.toKey, e.sharesIn);
    }
  }

  const out = new Map<string, FifoHoldingOut>();
  const keys = new Set<string>([...netQty.keys(), ...lots.keys()]);
  for (const k of keys) {
    const nq = netQty.get(k) || 0;
    const inv = nq > 1e-9 ? (lots.get(k) || []).reduce((s, l) => s + Math.max(0, l.remaining) * l.price, 0) : 0;
    out.set(k, { netQty: nq, invested: inv });
  }
  return out;
}

export interface HistoricalHolding {
  securityName: string;
  isin: string;
  quantity: number;
  avgBuyPrice: number;
  invested: number;
}
export interface HistoricalHoldingResult {
  positions: HistoricalHolding[];
  totalInvested: number;
  tradeRows: number;     // Buy/Sell rows replayed (on or before the as-of date)
}

/**
 * Read-only: compute the holdings of a portfolio **as of a past date** by replaying trades
 * dated on or before `asOfTs`. Two sources are combined (in date order):
 *   1. the **opening-basis batch transactions** ("Opening Txns"), replayed to the as-of date
 *      — the ONLY source of pre-FY26 positions (True Entry is FY26-only), and it also carries
 *      the opening position into an FY26-date report, and
 *   2. **True Entry** (FY26) Buy/Sell rows, replayed on top.
 * Does not write anything. Mirrors rebuildHoldingTab's replay so figures stay consistent.
 */
export async function computeHoldingsAsOf(spreadsheetId: string, asOfTs: number): Promise<HistoricalHoldingResult> {
  const master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID);
  const byKey = new Map<string, HoldingAcc>();
  const resolve = (isin: string, name: string): HoldingAcc => {
    const r = resolveScrip(master, isin, name);
    const key = r.status === "resolved" ? r.key : ((isin || "").trim() || normName(name));
    let h = byKey.get(key);
    if (!h) { h = { isin: r.status === "resolved" ? (r.entry.isin || isin || "") : isin, securityName: r.status === "resolved" ? r.entry.canonicalName : name, quantity: 0, avgBuyPrice: 0 }; byKey.set(key, h); }
    else if (isin && !h.isin) h.isin = isin;
    return h;
  };
  // Same key resolve() groups under — used to bucket FIFO seed lots / events by scrip.
  const keyFor = (isin: string, name: string): string => {
    const r = resolveScrip(master, isin, name);
    return r.status === "resolved" ? r.key : ((isin || "").trim() || normName(name));
  };

  // 1. Seed the pre-FY26 opening position. HOW depends on whether the report date is on/after the
  //    opening-basis cutoff (FY25 close, 31-Mar-2025) or a genuinely earlier date:
  const openingAsOfTs = Date.parse("2025-03-31T23:59:59");   // FY25 close = the opening-basis date
  let openingCount = 0;
  // Post-cutoff dates use the FIFO engine (mirrors the live Holding tab + capital-gains). The
  // pre-cutoff legacy branch (fragile Opening-Txns replay + HPR reconciliation) stays weighted-avg.
  const useFifo = asOfTs >= openingAsOfTs;
  const asOfSeed = new Map<string, FifoSeedLot[]>();

  if (asOfTs >= openingAsOfTs) {
    // ── FY-END (31-Mar-2025) AND LATER — the AUTHORITATIVE opening position is the reconciled
    // "Opening Holdings" tab (broker-checked, and exactly what the live Holdings view seeds from
    // via rebuildHoldingTab). We deliberately do NOT use the raw "Opening Txns" replay here: that
    // history is fragile/corrupt for messy scrips (mis-keyed prices, bad split balances, phantom
    // sold-out lots) and diverges from the broker's Historical Valuation Report. Seeding straight
    // from Opening Holdings makes the report mirror the broker AND the live Holdings view; FY26
    // True Entry trades then replay on top (step 2 below). See [[opening-basis]].
    const openingLots = await loadOpeningHoldings(spreadsheetId).catch(() => []);
    for (const ol of openingLots) {
      resolve(ol.isin, ol.name);   // register display name/ISIN (ISIN→name via scrip master, merges with FY26)
      const key = keyFor(ol.isin, ol.name);
      (asOfSeed.get(key) || asOfSeed.set(key, []).get(key)!).push({ qty: ol.qty, price: ol.costPerShare, ts: parseDateTs(ol.acqDate) || 0 });
    }
    openingCount = openingLots.length;
  } else {
    // ── A GENUINELY PAST DATE (before the cutoff) — Opening Holdings is only the 31-Mar-2025
    // SURVIVOR set, so it can't represent an earlier position (misses shares sold before then,
    // over-counts survivors). Reconstruct by replaying the batch transaction history ("Opening
    // Txns") to the as-of date, then adopt the reconciled Opening-Holdings COST where it ties out.
    const openingTxns = await loadOpeningTxns(spreadsheetId).catch(() => [] as TxnStatementRow[]);
    if (openingTxns.length) {
      const resolutions = await loadOpeningCorpActions(spreadsheetId).catch(() => ({} as Record<string, ActionResolution>));
      const openPos = replayOpeningTxnsAsOf(openingTxns, resolutions, asOfTs);
      openingCount = openingTxns.filter(t => t.ts <= 0 || t.ts <= asOfTs).length;
      for (const okey in openPos) {
        const p = openPos[okey];
        const h = resolve("", p.name);
        const cost = h.quantity * h.avgBuyPrice + p.qty * p.avgCost;   // weighted-avg merge (aliases → same key)
        h.quantity += p.qty;
        h.avgBuyPrice = h.quantity > 0 ? cost / h.quantity : 0;
      }

      // Adopt the reconciled Opening-Holdings figure over the raw replay, per scrip:
      //   • SETTLED (no Opening-Txns activity after the as-of date AND no HPR lot dated later) →
      //     position unchanged since then → use the HPR entry VERBATIM (qty + cost).
      //   • Otherwise → keep the replay's quantity, but adopt the exact HPR cost when the split-
      //     invariant invested total reconciles within 2% (per-lot charge drift), else keep replay.
      const openingLots = await loadOpeningHoldings(spreadsheetId).catch(() => []);
      if (openingLots.length) {
        const hprInvestedByKey = new Map<string, number>();   // resolved key → Σ HPR cost basis
        const hprQtyByKey = new Map<string, number>();         // resolved key → Σ HPR qty
        const hprFutureLot = new Set<string>();               // keys with an HPR lot acquired AFTER the as-of date
        for (const ol of openingLots) {
          const r = resolveScrip(master, ol.isin, ol.name);
          const key = r.status === "resolved" ? r.key : ((ol.isin || "").trim() || normName(ol.name));
          hprInvestedByKey.set(key, (hprInvestedByKey.get(key) || 0) + ol.qty * ol.costPerShare);
          hprQtyByKey.set(key, (hprQtyByKey.get(key) || 0) + ol.qty);
          if (parseDateTs(ol.acqDate) > asOfTs) hprFutureLot.add(key);
        }
        const activityAfterAsOf = new Set<string>();
        for (const t of openingTxns) {
          const kind = classifyTxn(t.type);
          if (t.ts > asOfTs && (kind === "BUY" || kind === "SELL" || kind === "BONUS" || kind === "SPLIT" || kind === "RIGHT")) {
            const r = resolveScrip(master, "", t.name);
            activityAfterAsOf.add(r.status === "resolved" ? r.key : normName(t.name));
          }
        }
        for (const [key, h] of byKey) {
          const hprInvested = hprInvestedByKey.get(key);
          const hprQty = hprQtyByKey.get(key) || 0;
          // Skip ONLY when the scrip is genuinely ABSENT from Opening Holdings (no HPR row). A ₹0
          // hprInvested is a legitimate zero-cost lot, NOT "missing" — don't let a replay-invented
          // cost survive for it.
          if (hprInvested === undefined || hprQty <= 0 || h.quantity <= 1e-9) continue;
          const settled = !activityAfterAsOf.has(key) && !hprFutureLot.has(key);
          if (settled) {
            h.quantity = hprQty;
            h.avgBuyPrice = hprInvested / hprQty;
          } else {
            const replayBasis = h.quantity * h.avgBuyPrice;
            if (Math.abs(replayBasis - hprInvested) <= hprInvested * 0.02) h.avgBuyPrice = hprInvested / h.quantity;
          }
        }
      }
    }
  }

  // 2. FY26 trades from True Entry, replayed on top. Tolerant: a missing/empty tab just means
  //    "opening basis only" (a fresh portfolio still building its history).
  let teRows: any[][] = [];
  try {
    const teRes: any = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId, range: "True Entry!A:T",
      // Dates as serials, not display strings — see parseDateTs for why.
      valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER",
    });
    teRows = teRes?.result?.values || [];
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || "";
    if (!/unable to parse range/i.test(msg)) throw e;   // missing tab is fine (opening-only)
  }

  let replayed = 0;
  const fifoEvents: FifoHoldingEvent[] = [];
  if (teRows.length >= 2) {
    const hdrs = teRows[0].map((h: any) => (h || "").toString().trim());
    const col = (name: string, fallback: number) => { const i = hdrs.indexOf(name); return i >= 0 ? i : fallback; };
    const dateIdx = col("Trade Date", 0), isinIdx = col("ISIN", -1), nameIdx = col("Stock Name", 2);
    const typeIdx = col("Transaction Type", 3), qtyIdx = col("Number of Shares", 4), priceIdx = col("Avg Price", 5);
    const turnoverIdx = col("Total Amount (Turnover)", 6);
    const inclIdx = col("Total Amount with Expense (Incl STT)", 15);

    const trades: ReplayTrade[] = [];
    for (let i = 1; i < teRows.length; i++) {
      const r = teRows[i];
      if (!r || r.length === 0) continue;
      // Ledger stores the real action ("Bonus"/"Split"/"IPO"/"Rights"); classify it. A SPLIT
      // rescales the held lots (kept a distinct type so it's excluded from the intraday
      // square-off and isn't a ₹0 add); Bonus/IPO/Rights are buy-side.
      const type = isSplitType(r[typeIdx]) ? "SPLIT" : ledgerSide(r[typeIdx]);
      if (!type) continue;
      const name = (r[nameIdx] || "").toString().trim();
      const qty = toNum(r[qtyIdx]);
      if (!name || isNaN(qty) || qty <= 0) continue;
      const avgPrice = toNum(r[priceIdx]);
      const turnover = toNum(r[turnoverIdx]);
      const inclSTT = toNum(r[inclIdx]);
      // Invested = all-in cost incl. expenses: value BUYs by "Total Amount with
      // Expense (Incl STT)" (fallback turnover, then Avg Price). Sells carry no cost.
      // Bonus/Split rows carry 0 turnover/cost, so this yields ₹0 as intended.
      const price = type === "BUY"
        ? (inclSTT > 0 ? inclSTT / qty : (turnover > 0 ? turnover / qty : avgPrice))
        : avgPrice;
      if (type === "BUY" && isNaN(price)) continue;
      trades.push({ ts: parseDateTs(r[dateIdx]), idx: i, isin: (r[isinIdx] || "").toString().trim(), name, type, qty, price: isNaN(price) ? 0 : price });
    }
    trades.sort((a, b) => (a.ts - b.ts) || (a.idx - b.idx));

    // Only trades on/before the as-of date, with intraday round-trips squared off
    // (same-day buy+sell on a scrip is excluded so it can't lift the cost basis).
    const window = trades.filter(t => t.ts <= asOfTs);
    const playable = squareOffIntraday(window, (t) => keyFor(t.isin, t.name));
    replayed = window.length;
    for (const t of playable) {
      if (useFifo) {
        // FIFO: collect events; the replay + survivors are computed in the aggregation below.
        resolve(t.isin, t.name);   // register display name/ISIN
        const key = keyFor(t.isin, t.name);
        if (t.type === "BUY") fifoEvents.push({ kind: "BUY", key, ts: t.ts, qty: t.qty, price: t.price });
        else if (t.type === "SPLIT") fifoEvents.push({ kind: "SPLIT", key, ts: t.ts, qty: t.qty });
        else fifoEvents.push({ kind: "SELL", key, ts: t.ts, qty: t.qty });
        continue;
      }
      // ── Legacy weighted-average path (genuinely pre-cutoff historical dates) ──
      const h = resolve(t.isin, t.name);
      if (t.type === "SPLIT") {
        // Subdivide: qty grows by the added shares, total cost unchanged → avg ÷factor.
        if (h.quantity > 1e-9 && t.qty > 0) { const cost = h.quantity * h.avgBuyPrice; h.quantity += t.qty; h.avgBuyPrice = h.quantity > 0 ? cost / h.quantity : 0; }
        continue;
      }
      if (t.type === "BUY") {
        const newQty = h.quantity + t.qty;
        h.avgBuyPrice = newQty > 0 ? (h.quantity < 0 ? t.price : ((h.quantity * h.avgBuyPrice) + (t.qty * t.price)) / newQty) : 0;
        h.quantity = newQty;
      } else {
        h.quantity -= t.qty;
        if (h.quantity <= 0) h.avgBuyPrice = 0;
      }
    }
  }

  if (byKey.size === 0 && openingCount === 0 && teRows.length < 2) {
    throw new Error("Nothing to report — this portfolio has no opening basis and no True Entry trades yet.");
  }

  let totalInvested = 0;
  let positions: HistoricalHolding[];
  if (useFifo) {
    // FIFO: SELLs consumed the oldest lots; the survivors are the as-of holding. Only
    // positive positions are reported (as the historical report always has).
    const fifoOut = replayFifoHoldings(asOfSeed, fifoEvents);
    const rows: HistoricalHolding[] = [];
    for (const [key, o] of fifoOut) {
      if (o.netQty <= 1e-9) continue;
      const h = byKey.get(key); if (!h) continue;
      totalInvested += o.invested;
      rows.push({ securityName: h.securityName, isin: h.isin, quantity: o.netQty, avgBuyPrice: parseFloat((o.invested / o.netQty).toFixed(4)), invested: parseFloat(o.invested.toFixed(2)) });
    }
    rows.sort((a, b) => b.invested - a.invested);
    positions = rows;
  } else {
    const active = [...byKey.values()].filter(h => h.quantity > 0).sort((a, b) => (b.quantity * b.avgBuyPrice) - (a.quantity * a.avgBuyPrice));
    positions = active.map(h => {
      const invested = h.quantity * h.avgBuyPrice;
      totalInvested += invested;
      return { securityName: h.securityName, isin: h.isin, quantity: h.quantity, avgBuyPrice: parseFloat(h.avgBuyPrice.toFixed(4)), invested: parseFloat(invested.toFixed(2)) };
    });
  }
  return { positions, totalInvested: parseFloat(totalInvested.toFixed(2)), tradeRows: replayed + openingCount };
}

/**
 * Rebuilds the "Holding" tab of a portfolio spreadsheet from every Buy/Sell row
 * in "True Entry" — computed purely from entry data (no opening seed).
 * Throws with a descriptive message on failure — callers should surface it.
 */
export async function rebuildHoldingTab(spreadsheetId: string): Promise<RebuildHoldingResult> {
  // ── 1. Read True Entry (columns resolved by header name, not position) ──
  let teRes: any;
  try {
    teRes = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "True Entry!A:T",
      // Dates as serials, not display strings — see parseDateTs for why.
      valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER",
    });
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || "";
    if (/unable to parse range/i.test(msg)) {
      throw new Error("'True Entry' tab not found in this spreadsheet — import a contract note or transaction report first.");
    }
    throw e;
  }
  const teRows: any[][] = teRes?.result?.values || [];
  if (teRows.length < 2) throw new Error("True Entry sheet is empty — nothing to rebuild from.");

  const hdrs = teRows[0].map((h: any) => (h || "").toString().trim());
  const col = (name: string, fallback: number) => {
    const i = hdrs.indexOf(name);
    return i >= 0 ? i : fallback;
  };
  const dateIdx = col("Trade Date", 0);
  const isinIdx = col("ISIN", -1);
  const nameIdx = col("Stock Name", 2);
  const typeIdx = col("Transaction Type", 3);
  const qtyIdx = col("Number of Shares", 4);
  const priceIdx = col("Avg Price", 5);
  const turnoverIdx = col("Total Amount (Turnover)", 6);
  const inclIdx = col("Total Amount with Expense (Incl STT)", 15);

  interface TradeRow { ts: number; idx: number; isin: string; name: string; type: string; qty: number; price: number; }
  const trades: TradeRow[] = [];
  for (let i = 1; i < teRows.length; i++) {
    const r = teRows[i];
    if (!r || r.length === 0) continue;
    // Classify the stored action. A SPLIT rescales held lots (distinct type → excluded from
    // the intraday square-off, not a ₹0 add); Bonus/IPO/Rights are buy-side.
    const type = isSplitType(r[typeIdx]) ? "SPLIT" : ledgerSide(r[typeIdx]);
    if (!type) continue;
    const name = (r[nameIdx] || "").toString().trim();
    const qty = toNum(r[qtyIdx]);
    if (!name || isNaN(qty) || qty <= 0) continue;
    const avgPrice = toNum(r[priceIdx]);
    const turnover = toNum(r[turnoverIdx]);
    const inclSTT = toNum(r[inclIdx]);
    // Invested = all-in cost incl. expenses: value BUYs by "Total Amount with
    // Expense (Incl STT)" (fallback turnover, then Avg Price). Sells carry no cost.
    // Bonus/Split rows carry 0 turnover/cost → ₹0, as intended.
    const price = type === "BUY"
      ? (inclSTT > 0 ? inclSTT / qty : (turnover > 0 ? turnover / qty : avgPrice))
      : avgPrice;
    if (type === "BUY" && isNaN(price)) continue; // a buy without price can't contribute to avg cost
    trades.push({
      ts: parseDateTs(r[dateIdx]),
      idx: i,
      isin: (r[isinIdx] || "").toString().trim(),
      name,
      type,
      qty,
      price: isNaN(price) ? 0 : price,
    });
  }
  if (trades.length === 0) throw new Error("True Entry has no parseable Buy/Sell rows.");

  // Replay chronologically (stable: sheet order breaks ties) so weighted
  // average cost is computed in the order trades actually happened.
  trades.sort((a, b) => (a.ts - b.ts) || (a.idx - b.idx));

  // ── 2. Resolve every (isin, name) to one canonical key via the shared Scrip
  // Master, so short codes ("GOODLUCK") and full names ("Goodluck India Ltd") merge. ──
  const master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID);
  const byKey = new Map<string, HoldingAcc>();
  const unresolvedMap = new Map<string, UnresolvedScrip>();

  const resolve = (isin: string, name: string): HoldingAcc => {
    const r = resolveScrip(master, isin, name);
    let key: string;
    // When the scrip resolves, group AND display under the master's CANONICAL name +
    // ISIN — not whatever raw name the trades happen to carry. So renaming a scrip in the
    // master (new name, old name kept as an alias) makes the Holding tab show the NEW name
    // after a rebuild instead of the old one; all its trades still merge under one key
    // (mirrors computeHoldingsAsOf, which already does this).
    let displayName = name, displayIsin = (isin || "").trim();
    if (r.status === "resolved") {
      key = r.key;
      displayName = r.entry.canonicalName;
      if (!displayIsin) displayIsin = r.entry.isin || "";
    } else {
      key = displayIsin || normName(name);
      if (!unresolvedMap.has(key)) {
        unresolvedMap.set(key, { name, isin, candidates: r.status === "ambiguous" ? r.candidates : [] });
      }
    }
    let h = byKey.get(key);
    if (!h) {
      h = { isin: displayIsin, securityName: displayName, quantity: 0, avgBuyPrice: 0 };
      byKey.set(key, h);
    } else if (displayIsin && !h.isin) {
      h.isin = displayIsin;
    }
    return h;
  };

  // ── 3. Replay trades (intraday round-trips squared off first) ──
  // Same-day buy+sell on a scrip is treated as intraday and excluded, so the
  // churn doesn't pollute the holding's weighted-average cost.
  const keyOf = (t: ReplayTrade) => {
    const r = resolveScrip(master, t.isin, t.name);
    return r.status === "resolved" ? r.key : ((t.isin || "").trim() || normName(t.name));
  };
  const playable = squareOffIntraday(trades, keyOf);

  // Corporate actions (merger / demerger) transform the FIFO lot queues in date order,
  // interleaved with the trade replay, so a position's lots are right when each acts.
  const corpActions = await loadCorporateActions(spreadsheetId);

  // Seed the carried-in opening lots (pre-FY26 basis) as the oldest FIFO lots, so FY26
  // sells consume them first — exactly as the capital-gains engine does. No-op if the
  // Opening Holdings tab is absent. resolve() registers each scrip's display name/ISIN.
  const openingLots = await loadOpeningHoldings(spreadsheetId).catch(() => []);
  const seed = new Map<string, FifoSeedLot[]>();
  for (const ol of openingLots) {
    resolve(ol.isin, ol.name);   // ISIN → canonical name via the scrip master (merges with FY26 rows)
    const key = keyOf({ isin: ol.isin, name: ol.name } as ReplayTrade);
    (seed.get(key) || seed.set(key, []).get(key)!).push({ qty: ol.qty, price: ol.costPerShare, ts: parseDateTs(ol.acqDate) || 0 });
  }

  // Build the dated FIFO event stream: trades (same-day round-trips already squared off)
  // valued at their all-in incl-STT cost + corporate actions. resolve() registers display.
  const fifoEvents: FifoHoldingEvent[] = [];
  for (const t of playable) {
    resolve(t.isin, t.name);
    const key = keyOf(t);
    if (t.type === "BUY") fifoEvents.push({ kind: "BUY", key, ts: t.ts, qty: t.qty, price: t.price });
    else if (t.type === "SPLIT") fifoEvents.push({ kind: "SPLIT", key, ts: t.ts, qty: t.qty });
    else fifoEvents.push({ kind: "SELL", key, ts: t.ts, qty: t.qty });
  }
  for (const ca of corpActions) {
    resolve("", ca.from); resolve("", ca.to);
    fifoEvents.push({
      kind: ca.type === "Merger" ? "MERGER" : "DEMERGER",
      ts: parseDateTs(ca.dateStr) || 0,
      fromKey: keyOf({ isin: "", name: ca.from } as ReplayTrade),
      toKey: keyOf({ isin: "", name: ca.to } as ReplayTrade),
      sharesIn: ca.sharesIn, cost: ca.cost,
    });
  }

  // Every name this portfolio actually references (trades + opening lots), normalized —
  // used below to flag ONLY the scrip-master name collisions that affect THIS portfolio.
  const seenNames = new Set<string>();
  for (const t of trades) seenNames.add(normName(t.name));
  for (const ol of openingLots) seenNames.add(normName(ol.name));

  // FIFO replay: a SELL consumes the oldest lots first; the survivors are the holding.
  const fifoOut = replayFifoHoldings(seed, fifoEvents);

  // ── 4. Write Holding tab ──
  // Keep NEGATIVE net positions too (|qty| > 0), not just positives: a negative holding
  // is impossible in reality and flags a data discrepancy (a missing buy, a dropped/
  // duplicated sell, a bad opening lot). Surfacing it — rather than silently dropping it —
  // lets the Holdings view show it as a discrepancy so it can be traced and fixed.
  // Negatives carry invested 0 so they don't distort the total, and computeAum already
  // skips qty<=0 so the dashboard AUM is unaffected.
  interface HoldingOut { securityName: string; isin: string; quantity: number; avgBuyPrice: number; invested: number; }
  const active: HoldingOut[] = [];
  for (const [key, o] of fifoOut) {
    if (Math.abs(o.netQty) <= 1e-9) continue;
    const h = byKey.get(key);
    if (!h) continue;
    const invested = o.netQty > 0 ? o.invested : 0;   // negatives → invested 0
    const avg = o.netQty > 0 ? invested / o.netQty : 0;
    active.push({ securityName: h.securityName, isin: h.isin, quantity: o.netQty, avgBuyPrice: avg, invested });
  }
  active.sort((a, b) => b.invested - a.invested);

  const rows: any[][] = [["Company Name", "ISIN", "Quantity", "Avg Buy Price", "Invested Value"]];
  let totalInvested = 0;
  for (const h of active) {
    totalInvested += h.invested;
    rows.push([
      h.securityName,
      h.isin,
      h.quantity,
      parseFloat(h.avgBuyPrice.toFixed(4)),
      parseFloat(h.invested.toFixed(2)),
    ]);
  }
  rows.push(["Total", "", "", "", parseFloat(totalInvested.toFixed(2))]);

  // The Holding tab may not exist yet (e.g. first run on a fresh spreadsheet)
  await ensureSheetTabs(spreadsheetId, ["Holding"]);

  await (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: "Holding!A:Z" });
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Holding!A1",
    valueInputOption: "USER_ENTERED",
    resource: { values: rows },
  });

  // Name collisions that affect THIS portfolio: a name it uses is claimed by 2+ master
  // entries (only one wins the lookup) → those trades split instead of merging. Common
  // after a rename where the old entry wasn't removed. Scoped to seenNames so unrelated
  // collisions elsewhere in the shared master don't create noise here.
  const nameCollisions = findNameCollisions(master).filter(c => seenNames.has(c.key));

  return {
    positions: active.length,
    totalInvested: parseFloat(totalInvested.toFixed(2)),
    tradeRows: trades.length,
    unresolved: [...unresolvedMap.values()],
    master,
    nameCollisions,
  };
}

export interface AumPortfolio {
  id: string;
  label: string;
  currentValue: number;   // Σ qty × CMP (imported price, else cost)
  investedValue: number;  // Σ invested (cost)
  positions: number;
  priced: number;         // how many positions had a real imported price
}
export interface AumResult {
  totalCurrent: number;   // the AUM
  totalInvested: number;
  perPortfolio: AumPortfolio[];
  fullyPriced: boolean;   // false → some positions valued at cost (no imported price)
}

/**
 * Current AUM across the given portfolios: reads each one's "Holding" tab and
 * sums quantity × current price, where the current price is the imported
 * screener snapshot (matched via the scrip master) and falls back to average
 * cost when no price is on file. Read-only.
 */
export async function computeAum(portfolios: { id: string; label: string; sheetId: string }[]): Promise<AumResult> {
  const master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID).catch(() => null);
  const prices = await loadScripPrices(SCRIP_MASTER_SPREADSHEET_ID).catch(() => []);
  const cmpOf = makePriceResolver(master, prices);

  const toN = (v: any) => { const n = parseFloat((v ?? "").toString().replace(/,/g, "").trim()); return isNaN(n) ? NaN : n; };
  const per: AumPortfolio[] = [];
  let totalCurrent = 0, totalInvested = 0, anyUnpriced = false;

  for (const p of portfolios) {
    let cur = 0, inv = 0, positions = 0, priced = 0;
    try {
      const res = await (gapi.client as any).sheets.spreadsheets.values.get({ spreadsheetId: p.sheetId, range: "Holding!A:E" });
      const rows: any[][] = res?.result?.values || [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i]; if (!r) continue;
        const name = (r[0] || "").toString().trim();
        if (!name || /^total/i.test(name)) continue;
        const isin = (r[1] || "").toString().trim();
        const qty = toN(r[2]);
        const avg = toN(r[3]);
        const investedVal = toN(r[4]);
        if (isNaN(qty) || qty <= 0 || isNaN(avg)) continue;
        positions++;
        const cmp = cmpOf(isin, name);
        if (cmp !== undefined) priced++;
        cur += qty * (cmp !== undefined ? cmp : avg);
        inv += isNaN(investedVal) ? qty * avg : investedVal;
      }
    } catch { /* Holding tab missing/unreadable → contributes 0 */ }
    if (priced < positions) anyUnpriced = true;
    per.push({ id: p.id, label: p.label, currentValue: cur, investedValue: inv, positions, priced });
    totalCurrent += cur; totalInvested += inv;
  }

  return {
    totalCurrent: parseFloat(totalCurrent.toFixed(2)),
    totalInvested: parseFloat(totalInvested.toFixed(2)),
    perPortfolio: per,
    fullyPriced: !anyUnpriced,
  };
}

export interface IndustrySlice {
  industry: string;
  companies: number;   // distinct held companies in this industry (across all portfolios)
  invested: number;    // Σ cost of those holdings
  current: number;     // Σ current value (CMP where priced, else cost)
}
export interface IndustryAllocationResult {
  slices: IndustrySlice[];  // sorted: most companies first
  totalCompanies: number;   // distinct companies across all portfolios
  classified: number;       // companies with a known (non-"Unclassified") industry
}

/**
 * Sector/industry allocation across the given portfolios: reads each "Holding"
 * tab, maps every distinct held company (deduped by canonical scrip key across
 * portfolios, so a stock in two portfolios is ONE company) to its industry (from
 * the screener-imported Industries tab, else "Unclassified"), and counts
 * companies per industry. Read-only. Slice size is by company COUNT — the more
 * companies in an industry, the bigger the slice.
 */
export async function computeIndustryAllocation(portfolios: { id: string; label: string; sheetId: string }[]): Promise<IndustryAllocationResult> {
  const master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID).catch(() => null);
  const prices = await loadScripPrices(SCRIP_MASTER_SPREADSHEET_ID).catch(() => []);
  const industries = await loadScripIndustries(SCRIP_MASTER_SPREADSHEET_ID).catch(() => []);
  const cmpOf = makePriceResolver(master, prices);
  const industryOf = makeIndustryResolver(master, industries);

  const toN = (v: any) => { const n = parseFloat((v ?? "").toString().replace(/,/g, "").trim()); return isNaN(n) ? NaN : n; };

  const companies = new Map<string, { industry: string; invested: number; current: number }>();
  for (const p of portfolios) {
    try {
      const res = await (gapi.client as any).sheets.spreadsheets.values.get({ spreadsheetId: p.sheetId, range: "Holding!A:E" });
      const rows: any[][] = res?.result?.values || [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i]; if (!r) continue;
        const name = (r[0] || "").toString().trim();
        if (!name || /^total/i.test(name)) continue;
        const isin = (r[1] || "").toString().trim();
        const qty = toN(r[2]); const avg = toN(r[3]); const investedVal = toN(r[4]);
        if (isNaN(qty) || qty <= 0) continue;
        let key = (isin || "").trim().toUpperCase() || normName(name);
        if (master) { const e = lookupScrip(master, isin, name).entry; if (e) key = e.key; }
        const industry = industryOf(isin, name) || "Unclassified";
        const cmp = cmpOf(isin, name);
        const cur = qty * (cmp !== undefined ? cmp : (isNaN(avg) ? 0 : avg));
        const inv = isNaN(investedVal) ? qty * (isNaN(avg) ? 0 : avg) : investedVal;
        const prev = companies.get(key);
        if (prev) { prev.invested += inv; prev.current += cur; }  // same company in another portfolio
        else companies.set(key, { industry, invested: inv, current: cur });
      }
    } catch { /* Holding tab missing/unreadable → contributes nothing */ }
  }

  const byInd = new Map<string, IndustrySlice>();
  let classified = 0;
  for (const c of companies.values()) {
    if (c.industry !== "Unclassified") classified++;
    let s = byInd.get(c.industry);
    if (!s) { s = { industry: c.industry, companies: 0, invested: 0, current: 0 }; byInd.set(c.industry, s); }
    s.companies++; s.invested += c.invested; s.current += c.current;
  }
  const slices = [...byInd.values()].sort((a, b) => (b.companies - a.companies) || (b.current - a.current));
  return { slices, totalCompanies: companies.size, classified };
}

export interface CapitalGainsResult {
  stcg: number;
  ltcg: number;
  intradayCg: number;
  exported: number;        // FY25-26+ sale rows written to LTST
  unresolved: UnresolvedScrip[];
  master: ScripMaster;
}

/**
 * Compute FIFO capital gains (intraday / STCG / LTCG) purely from "True Entry"
 * (no opening seed) and write the "LTST" + "PnL Summary" tabs. Pre-FY25-26 sells
 * participate in FIFO lot matching for cost-basis correctness but are not
 * exported; only FY25-26 onwards sales are written. Returns totals + any
 * unresolved scrips. Used by the Holdings button AND auto-run by the import flow.
 */
export async function syncCapitalGains(spreadsheetId: string): Promise<CapitalGainsResult> {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const OPEN_DATE = new Date(2024, 2, 31);
  // Older history in True Entry exists only to supply FIFO cost-basis
  // lots — sales before this date are matched but never exported.
  const EXPORT_FROM = new Date(2025, 3, 1); // 01/04/2025 → FY25-26 onwards

  const parseDate = (s: any): Date | null => {
    if (s === null || s === undefined || s === "") return null;
    if (typeof s === "number") {
      if (!isFinite(s)) return null;
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(s * 86400000));
      return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
    const c = s.toString().trim();
    if (!c) return null;
    const dmy = c.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) return new Date(parseInt(dmy[3]), parseInt(dmy[2]) - 1, parseInt(dmy[1]));
    const dmY = c.match(/^(\d{1,2})[\/\-]([A-Za-z]+)[\/\-](\d{4})$/);
    if (dmY) { const m = new Date(Date.parse(`${dmY[2]} 1, 2000`)).getMonth(); return new Date(parseInt(dmY[3]), m, parseInt(dmY[1])); }
    const ymd = c.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (ymd) return new Date(parseInt(ymd[1]), parseInt(ymd[2]) - 1, parseInt(ymd[3]));
    const ts = Date.parse(c); return isNaN(ts) ? null : new Date(ts);
  };
  const daysBetween = (d1: Date, d2: Date) => Math.floor((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
  const num = (s: string) => { const v = parseFloat((s || "").replace(/,/g, '').trim()); return isNaN(v) ? 0 : v; };
  const r2 = (n: number) => Math.round(n * 100) / 100;
  // Prices (purchase / sale) keep full precision — cost basis carries many decimals
  // (e.g. ₹1075.574895); r6 only trims float noise, never rounds the basis to paise.
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const fmtDate = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

  // Resolve every (isin, name) to one canonical key via the shared Scrip Master
  // so short codes ("GOODLUCK") and full names ("Goodluck India Ltd") map to the
  // same FIFO bucket. Unresolved/ambiguous names are collected for review.
  const master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID);
  const unresolvedMap = new Map<string, UnresolvedScrip>();
  const secKey = (isin: string, name: string) => {
    const r = resolveScrip(master, isin, name);
    if (r.status === "resolved") return r.key;
    const key = (isin || "").trim() || normName(name);
    if (!unresolvedMap.has(key)) {
      unresolvedMap.set(key, { name, isin, candidates: r.status === "ambiguous" ? r.candidates : [] });
    }
    return key;
  };

  // ── Step 1: Read True Entry ──
  const teRes = await (gapi.client as any).sheets.spreadsheets.values.get({ spreadsheetId, range: 'True Entry!A:T', valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' });
  const teRows: any[][] = teRes?.result?.values || [];
  if (teRows.length < 2) throw new Error("True Entry sheet is empty or missing.");

  const hdrs = teRows[0].map((h: any) => h.toString().trim());
  const ci = (n: string) => hdrs.indexOf(n);
  const dateIdx = ci("Trade Date"), isinIdx = ci("ISIN"), nameIdx = ci("Stock Name");
  const typeIdx = ci("Transaction Type"), qtyIdx = ci("Number of Shares");
  const avgPriceIdx = ci("Avg Price"), turnoverIdx = ci("Total Amount (Turnover)");
  const tradeClassIdx = ci("Trade Class");

  interface TERow { tradeDate: string; dateObj: Date; isin: string; stockName: string; txType: string; qty: number; avgPrice: number; turnover: number; tradeClass: string; }
  const teData: TERow[] = [];
  for (let i = 1; i < teRows.length; i++) {
    const r = teRows[i]; if (!r || r.length === 0) continue;
    const dateObj = parseDate(r[dateIdx >= 0 ? dateIdx : 0]); if (!dateObj) continue;
    const tradeDate = fmtDate(dateObj);   // clean DD/MM/YYYY for the LTST output
    const isin = (isinIdx >= 0 ? (r[isinIdx] || "") : "").toString().trim();
    const stockName = (r[nameIdx >= 0 ? nameIdx : 2] || "").toString().trim();
    // Normalize the stored action to a buy/sell SIDE (Bonus/Split/IPO/Rights → BUY at
    // their sheet cost, ₹0 for Bonus/Split); non-trade rows (Dividend) keep their raw
    // type and are dropped by the BUY/SELL-only steps below.
    const rawType = (r[typeIdx >= 0 ? typeIdx : 3] || "").toString().trim().toUpperCase();
    // A Split RESCALES the held lots (keeps their acquisition dates), so it's kept
    // distinct from BUY; Bonus/IPO/Rights stay BUY (₹0 or priced add). Dividend etc.
    // keep their raw type and are dropped by the BUY/SELL/SPLIT steps below.
    const txType = isSplitType(rawType) ? "SPLIT" : (ledgerSide(rawType) || rawType);
    const qty = num((r[qtyIdx >= 0 ? qtyIdx : 4] || "0").toString());
    const rawAvg = num((r[avgPriceIdx >= 0 ? avgPriceIdx : 5] || "0").toString());
    const turnover = num((r[turnoverIdx >= 0 ? turnoverIdx : 6] || "0").toString());
    // Cost/proceeds from the actual traded amount (turnover) for sub-paisa accuracy;
    // the Avg Price column is rounded to 2 dp. Falls back to Avg Price when blank.
    const avgPrice = (turnover > 0 && qty > 0) ? turnover / qty : rawAvg;
    const tradeClass = (tradeClassIdx >= 0 ? (r[tradeClassIdx] || "Delivery") : "Delivery").toString().trim();
    if (!stockName || qty <= 0) continue;
    teData.push({ tradeDate, dateObj, isin, stockName, txType, qty, avgPrice, turnover, tradeClass });
  }

  // ── Step 2: Build FIFO queues (delivery) + intraday day-queues, purely from
  // True Entry (no opening seed from Closing Fy24-25). ──
  interface FifoLot { stockName: string; isin: string; buyDate: Date; buyDateStr: string; qty: number; remaining: number; purPrice: number; isOpening: boolean; }
  const fifo: Record<string, FifoLot[]> = {};

  // Seed the FIFO queues with the opening lots (pre-FY26 basis, with acquisition
  // dates + cost) so FY26 sells match against carried-in holdings first and their
  // LTCG/STCG is classified from the real acquisition date. No-op if the Opening
  // Holdings tab is absent. These are the oldest lots, so they sit at the front
  // of each queue and FIFO consumes them before any FY26 buy.
  const openingSeed = await loadOpeningHoldings(spreadsheetId).catch(() => []);
  for (const ol of openingSeed) {
    const key = secKey(ol.isin, ol.name);   // resolve via scrip master (ISIN → name) so it merges with FY26 rows
    if (!fifo[key]) fifo[key] = [];
    const d = parseDate(ol.acqDate) || OPEN_DATE;
    fifo[key].push({ stockName: ol.name, isin: ol.isin, buyDate: d, buyDateStr: fmtDate(d), qty: ol.qty, remaining: ol.qty, purPrice: ol.costPerShare, isOpening: true });
  }
  for (const k in fifo) fifo[k].sort((a, b) => a.buyDate.getTime() - b.buyDate.getTime());

  const deliveryBuys: TERow[] = [];
  const deliverySells: TERow[] = [];

  // ── Step 4: FIFO-match delivery sells → STCG / LTCG rows ──
  interface CGRecord { saleDate: string; saleDateObj: Date; assetName: string; isin: string; qtySold: number; salePrice: number; saleAmt: number; purDate: string; purPrice: number; acqCost: number; intradayCg: number; stcg: number; ltcg: number; }
  const allRecords: CGRecord[] = [];

  // Automatic intraday reconciliation per (scrip, day) — ALWAYS ON, tag-independent.
  // A same-day buy+sell of the same scrip is an intraday round-trip by definition, so the
  // matched min(buyQty, sellQty) is speculative (→ allRecords.intradayCg) regardless of the
  // broker Trade Class tag (Zerodha only marks buy==sell, missing partial round-trips like
  // Park Medi World 12-Feb: bought 1,500, sold 3,000 → 1,500 intraday + 1,500 delivery). The
  // residual buy/sell is real DELIVERY and joins the FIFO below; a day with only buys OR only
  // sells for a scrip isn't a round-trip and passes through unchanged. This mirrors the Trx
  // ledger's §3b so LTST / PnL-Summary match the register. Same-day netting convention: a
  // pre-existing holding does NOT suppress this — held 500, then same-day buy 100 + sell 200
  // ⇒ 100 intraday, residual 100 sale drawn from the carried holding via FIFO (its LTCG/STCG).
  {
    const groups: Record<string, { buys: TERow[]; sells: TERow[] }> = {};
    for (const t of teData) {
      if (t.txType !== "BUY" && t.txType !== "SELL") continue;
      const gk = `${fmtDate(t.dateObj)}|${secKey(t.isin, t.stockName)}`;
      (groups[gk] || (groups[gk] = { buys: [], sells: [] }))[t.txType === "BUY" ? "buys" : "sells"].push(t);
    }
    for (const gk in groups) {
      const g = groups[gk];
      const buyQty = g.buys.reduce((s, t) => s + t.qty, 0), sellQty = g.sells.reduce((s, t) => s + t.qty, 0);
      const matched = Math.min(buyQty, sellQty);
      if (matched <= 0) {   // no same-day round-trip → pure delivery, keep the individual rows
        for (const b of g.buys) deliveryBuys.push(b);
        for (const s of g.sells) deliverySells.push(s);
        continue;
      }
      const avgBuy = g.buys.reduce((s, t) => s + t.qty * t.avgPrice, 0) / buyQty;
      const avgSell = g.sells.reduce((s, t) => s + t.qty * t.avgPrice, 0) / sellQty;
      const proto = g.buys[0] || g.sells[0];
      const saleAmt = r2(matched * avgSell), acqCost = r2(matched * avgBuy);
      allRecords.push({ saleDate: fmtDate(proto.dateObj), saleDateObj: proto.dateObj, assetName: proto.stockName, isin: proto.isin, qtySold: matched, salePrice: avgSell, saleAmt, purDate: fmtDate(proto.dateObj), purPrice: avgBuy, acqCost, intradayCg: r2(saleAmt - acqCost), stcg: 0, ltcg: 0 });
      const resBuy = buyQty - matched, resSell = sellQty - matched;
      if (resBuy > 0) deliveryBuys.push({ ...proto, txType: "BUY", tradeClass: "Delivery", qty: resBuy, avgPrice: avgBuy, turnover: r2(avgBuy * resBuy) });
      if (resSell > 0) deliverySells.push({ ...proto, txType: "SELL", tradeClass: "Delivery", qty: resSell, avgPrice: avgSell, turnover: r2(avgSell * resSell) });
    }
  }
  deliveryBuys.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
  deliverySells.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());

  // Corporate actions transform the delivery lot queues at their date — a merger
  // removes Target's lots (no gain) and adds a fresh Acquirer lot at the carried
  // cost; a demerger reduces Parent's remaining-lot cost and spins off a fresh
  // NewCo lot. New shares take the action date as acquisition date (holding-period
  // clock restarts there, per the manual-cost design).
  const corpActions = await loadCorporateActions(spreadsheetId);
  const applyMergerFifo = (ca: CorpAction, when: Date) => {
    for (const lot of (fifo[secKey("", ca.from)] || [])) lot.remaining = 0;
    const ak = secKey("", ca.to); if (!fifo[ak]) fifo[ak] = [];
    const px = ca.sharesIn > 0 ? ca.cost / ca.sharesIn : 0;
    fifo[ak].push({ stockName: ca.to, isin: "", buyDate: when, buyDateStr: ca.dateStr, qty: ca.sharesIn, remaining: ca.sharesIn, purPrice: px, isOpening: false });
  };
  const applyDemergerFifo = (ca: CorpAction, when: Date) => {
    const lots = fifo[secKey("", ca.from)] || [];
    const remCost = lots.reduce((s, l) => s + l.remaining * l.purPrice, 0);
    const factor = remCost > 0 ? Math.max(0, (remCost - ca.cost) / remCost) : 1;
    for (const l of lots) l.purPrice = r2(l.purPrice * factor);
    const nk = secKey("", ca.to); if (!fifo[nk]) fifo[nk] = [];
    const px = ca.sharesIn > 0 ? ca.cost / ca.sharesIn : 0;
    fifo[nk].push({ stockName: ca.to, isin: "", buyDate: when, buyDateStr: ca.dateStr, qty: ca.sharesIn, remaining: ca.sharesIn, purPrice: px, isOpening: false });
  };

  // A Split subdivides every lot held on its date: qty ×factor, cost/share ÷factor,
  // acquisition date UNCHANGED (holding period is continuous — the whole point of a
  // split vs a bonus). factor is derived from the split row's added qty over the qty
  // actually held at that point, so it stays exact regardless of intervening trades.
  const splits = teData.filter(t => t.txType === "SPLIT");
  const applySplitFifo = (sp: TERow) => {
    const lots = fifo[secKey(sp.isin, sp.stockName)] || [];
    const held = lots.reduce((s, l) => s + l.remaining, 0);
    if (held <= 1e-9 || sp.qty <= 0) return;   // a split on nothing → no-op
    const factor = (held + sp.qty) / held;
    for (const l of lots) { l.qty *= factor; l.remaining *= factor; l.purPrice = l.purPrice / factor; }
  };

  // One date-ordered pass: BUY adds a lot, split/corporate action transforms queues,
  // SELL consumes lots FIFO. Same-date order: buys, then splits/actions, then sells.
  type DEv = { ts: number; ord: number; buy?: TERow; sell?: TERow; ca?: CorpAction; split?: TERow };
  const devents: DEv[] = [];
  for (const b of deliveryBuys) devents.push({ ts: b.dateObj.getTime(), ord: 0, buy: b });
  for (const sp of splits) devents.push({ ts: sp.dateObj.getTime(), ord: 1, split: sp });
  for (const ca of corpActions) { const d = parseDate(ca.dateStr); devents.push({ ts: d ? d.getTime() : 0, ord: 1, ca }); }
  for (const s of deliverySells) devents.push({ ts: s.dateObj.getTime(), ord: 2, sell: s });
  devents.sort((a, b) => (a.ts - b.ts) || (a.ord - b.ord));

  for (const ev of devents) {
    if (ev.buy) {
      const buy = ev.buy;
      const key = secKey(buy.isin, buy.stockName); if (!fifo[key]) fifo[key] = [];
      fifo[key].push({ stockName: buy.stockName, isin: buy.isin, buyDate: buy.dateObj, buyDateStr: buy.tradeDate, qty: buy.qty, remaining: buy.qty, purPrice: buy.avgPrice, isOpening: false });
    } else if (ev.split) {
      applySplitFifo(ev.split);
    } else if (ev.ca) {
      const when = parseDate(ev.ca.dateStr) || OPEN_DATE;
      ev.ca.type === "Merger" ? applyMergerFifo(ev.ca, when) : applyDemergerFifo(ev.ca, when);
    } else {
      const sell = ev.sell!;
      const key = secKey(sell.isin, sell.stockName);
      const lots = fifo[key]; if (!lots || lots.length === 0) continue;
      let sellLeft = sell.qty;
      for (const lot of lots) {
        if (sellLeft <= 0) break; if (lot.remaining <= 0) continue;
        const matchQty = Math.min(lot.remaining, sellLeft);
        const saleAmt = r2(matchQty * sell.avgPrice);
        const acqCost = r2(matchQty * lot.purPrice);
        const gain = r2(saleAmt - acqCost);
        const holdingDays = daysBetween(lot.buyDate, sell.dateObj);
        const isLT = holdingDays >= 365;
        allRecords.push({ saleDate: fmtDate(sell.dateObj), saleDateObj: sell.dateObj, assetName: sell.stockName, isin: sell.isin, qtySold: matchQty, salePrice: sell.avgPrice, saleAmt, purDate: fmtDate(lot.buyDate), purPrice: lot.purPrice, acqCost, intradayCg: 0, stcg: isLT ? 0 : gain, ltcg: isLT ? gain : 0 });
        lot.remaining -= matchQty; sellLeft -= matchQty;
      }
    }
  }

  // (Intraday round-trips were emitted above; their delivery residuals flowed through
  // the FIFO with the delivery sells, so there is no separate intraday-sells pass.)

  allRecords.sort((a, b) => a.saleDateObj.getTime() - b.saleDateObj.getTime());

  // Historical (pre-FY24-25) sells participated in FIFO matching above so lot
  // consumption stays correct — but only FY24-25+ sales get exported.
  const reportRecords = allRecords
    .filter(r => r.saleDateObj.getTime() >= EXPORT_FROM.getTime())
    .sort((a, b) => a.saleDateObj.getTime() - b.saleDateObj.getTime());   // stable: intraday rows (pushed first) stay ahead of the day's delivery rows

  // ── Step 5: Build LTST tab data ──
  const ltstRows: any[][] = [];
  ltstRows.push(["Sale Date", "Asset Name", "Qty. Sold", "Sale Price", "Sale Amt.", "Pur. Date", "Pur. Price", "Acquisition Cost", "Intra day Cg", "Short Term Cg", "Long Term CG"]);
  for (const rec of reportRecords) {
    ltstRows.push([
      rec.saleDate, rec.assetName, rec.qtySold,
      r6(rec.salePrice), r2(rec.saleAmt),
      rec.purDate, r6(rec.purPrice), r2(rec.acqCost),
      rec.intradayCg !== 0 ? rec.intradayCg : "",
      rec.stcg !== 0 ? rec.stcg : "",
      rec.ltcg !== 0 ? rec.ltcg : "",
    ]);
  }
  if (reportRecords.length === 0) ltstRows.push(["No sell trades found in True Entry sheet for FY25-26 onwards.", "", "", "", "", "", "", "", "", "", ""]);

  // ── Build monthly pivot for LTST ──
  const monthMap: Record<string, { year: number; month: number; intradayCg: number; stcg: number; ltcg: number; acqCost: number }> = {};
  for (const rec of reportRecords) {
    const y = rec.saleDateObj.getFullYear(), m = rec.saleDateObj.getMonth(), k = `${y}-${m}`;
    if (!monthMap[k]) monthMap[k] = { year: y, month: m, intradayCg: 0, stcg: 0, ltcg: 0, acqCost: 0 };
    monthMap[k].intradayCg = r2(monthMap[k].intradayCg + rec.intradayCg);
    monthMap[k].stcg = r2(monthMap[k].stcg + rec.stcg);
    monthMap[k].ltcg = r2(monthMap[k].ltcg + rec.ltcg);
    monthMap[k].acqCost = r2(monthMap[k].acqCost + rec.acqCost);
  }
  const sortedMonths = Object.values(monthMap).sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
  const yearMap: Record<number, typeof sortedMonths> = {};
  for (const mData of sortedMonths) { const y = mData.year; if (!yearMap[y]) yearMap[y] = []; yearMap[y].push(mData); }

  let grandIntCg = 0, grandStcg = 0, grandLtcg = 0, grandAcqCost = 0;

  // ── Step 6: Build PnL Summary tab (year → month pivot) ──
  const pnlRows: any[][] = [];
  pnlRows.push(["Row Labels", "Sum of Intra day Cg", "Sum of Short Term Cg", "Sum of Long Term CG", "Sum of Acquisition Cost"]);
  for (const [yearStr, months] of Object.entries(yearMap).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
    const y = parseInt(yearStr);
    const yInt = r2(months.reduce((s, m) => s + m.intradayCg, 0));
    const yStcg = r2(months.reduce((s, m) => s + m.stcg, 0));
    const yLtcg = r2(months.reduce((s, m) => s + m.ltcg, 0));
    const yAcq = r2(months.reduce((s, m) => s + m.acqCost, 0));
    pnlRows.push([`⊟ ${y}`, yInt !== 0 ? yInt : "", yStcg !== 0 ? yStcg : "", yLtcg !== 0 ? yLtcg : "", yAcq !== 0 ? yAcq : ""]);
    for (const mData of months) {
      pnlRows.push([`  ${MONTHS[mData.month]}`, mData.intradayCg !== 0 ? mData.intradayCg : "", mData.stcg !== 0 ? mData.stcg : "", mData.ltcg !== 0 ? mData.ltcg : "", mData.acqCost !== 0 ? mData.acqCost : ""]);
    }
    grandIntCg = r2(grandIntCg + yInt); grandStcg = r2(grandStcg + yStcg); grandLtcg = r2(grandLtcg + yLtcg); grandAcqCost = r2(grandAcqCost + yAcq);
  }
  pnlRows.push(["Grand Total", grandIntCg !== 0 ? grandIntCg : "", grandStcg !== 0 ? grandStcg : "", grandLtcg !== 0 ? grandLtcg : "", grandAcqCost !== 0 ? grandAcqCost : ""]);

  // ── Step 7: Create tabs if missing, clear, write ──
  await ensureSheetTabs(spreadsheetId, ["LTST", "PnL Summary"]);
  for (const [tabName, tabRows] of [["LTST", ltstRows], ["PnL Summary", pnlRows]] as [string, any[][]][]) {
    await (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tabName}!A:Z` });
    await (gapi.client as any).sheets.spreadsheets.values.update({ spreadsheetId, range: `${tabName}!A1`, valueInputOption: "USER_ENTERED", resource: { values: tabRows } });
  }

  return {
    stcg: grandStcg, ltcg: grandLtcg, intradayCg: grandIntCg,
    exported: reportRecords.length,
    unresolved: [...unresolvedMap.values()],
    master,
  };
}
