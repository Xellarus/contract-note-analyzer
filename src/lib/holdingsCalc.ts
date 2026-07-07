import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import {
  normName, loadScripMaster, resolveScrip, lookupScrip, ScripMaster, ScripEntry,
  SCRIP_MASTER_SPREADSHEET_ID,
} from "./scripMaster";
import { loadScripPrices, makePriceResolver } from "./scripPrices";
import { loadScripIndustries, makeIndustryResolver } from "./scripIndustries";
import { loadCorporateActions, CorpAction } from "./corporateActions";

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
  out.sort((a, b) => (a.ts - b.ts) || (a.idx - b.idx));
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
 * Read-only: compute the holdings of a portfolio **as of a past date** by
 * FIFO-replaying every Buy/Sell row in True Entry dated on or before `asOfTs`.
 * Computed purely from entry data (no opening seed). Does not write anything.
 * Mirrors rebuildHoldingTab's replay so figures stay consistent.
 */
export async function computeHoldingsAsOf(spreadsheetId: string, asOfTs: number): Promise<HistoricalHoldingResult> {
  let teRes: any;
  try {
    teRes = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId, range: "True Entry!A:T",
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
  if (teRows.length < 2) throw new Error("True Entry sheet is empty — nothing to report on.");

  const hdrs = teRows[0].map((h: any) => (h || "").toString().trim());
  const col = (name: string, fallback: number) => { const i = hdrs.indexOf(name); return i >= 0 ? i : fallback; };
  const dateIdx = col("Trade Date", 0), isinIdx = col("ISIN", -1), nameIdx = col("Stock Name", 2);
  const typeIdx = col("Transaction Type", 3), qtyIdx = col("Number of Shares", 4), priceIdx = col("Avg Price", 5);
  const turnoverIdx = col("Total Amount (Turnover)", 6);
  const inclIdx = col("Total Amount with Expense (Incl STT)", 15);

  interface TradeRow { ts: number; idx: number; isin: string; name: string; type: string; qty: number; price: number; }
  const trades: TradeRow[] = [];
  for (let i = 1; i < teRows.length; i++) {
    const r = teRows[i];
    if (!r || r.length === 0) continue;
    const type = (r[typeIdx] || "").toString().trim().toUpperCase();
    if (type !== "BUY" && type !== "SELL") continue;
    const name = (r[nameIdx] || "").toString().trim();
    const qty = toNum(r[qtyIdx]);
    if (!name || isNaN(qty) || qty <= 0) continue;
    const avgPrice = toNum(r[priceIdx]);
    const turnover = toNum(r[turnoverIdx]);
    const inclSTT = toNum(r[inclIdx]);
    // Invested = all-in cost incl. expenses: value BUYs by "Total Amount with
    // Expense (Incl STT)" (fallback turnover, then Avg Price). Sells carry no cost.
    const price = type === "BUY"
      ? (inclSTT > 0 ? inclSTT / qty : (turnover > 0 ? turnover / qty : avgPrice))
      : avgPrice;
    if (type === "BUY" && isNaN(price)) continue;
    trades.push({ ts: parseDateTs(r[dateIdx]), idx: i, isin: (r[isinIdx] || "").toString().trim(), name, type, qty, price: isNaN(price) ? 0 : price });
  }
  if (trades.length === 0) throw new Error("True Entry has no parseable Buy/Sell rows.");
  trades.sort((a, b) => (a.ts - b.ts) || (a.idx - b.idx));

  const master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID);
  const byKey = new Map<string, HoldingAcc>();
  const resolve = (isin: string, name: string): HoldingAcc => {
    const r = resolveScrip(master, isin, name);
    const key = r.status === "resolved" ? r.key : ((isin || "").trim() || normName(name));
    let h = byKey.get(key);
    if (!h) { h = { isin, securityName: r.status === "resolved" ? r.entry.canonicalName : name, quantity: 0, avgBuyPrice: 0 }; byKey.set(key, h); }
    else if (isin && !h.isin) h.isin = isin;
    return h;
  };

  // Only trades on/before the as-of date, with intraday round-trips squared off
  // (same-day buy+sell on a scrip is excluded so it can't lift the cost basis).
  const keyOf = (t: ReplayTrade) => {
    const r = resolveScrip(master, t.isin, t.name);
    return r.status === "resolved" ? r.key : ((t.isin || "").trim() || normName(t.name));
  };
  const window = trades.filter(t => t.ts <= asOfTs);
  const playable = squareOffIntraday(window, keyOf);

  const replayed = window.length;
  for (const t of playable) {
    const h = resolve(t.isin, t.name);
    if (t.type === "BUY") {
      const newQty = h.quantity + t.qty;
      h.avgBuyPrice = newQty > 0 ? (h.quantity < 0 ? t.price : ((h.quantity * h.avgBuyPrice) + (t.qty * t.price)) / newQty) : 0;
      h.quantity = newQty;
    } else {
      h.quantity -= t.qty;
      if (h.quantity <= 0) h.avgBuyPrice = 0;
    }
  }

  const active = [...byKey.values()].filter(h => h.quantity > 0).sort((a, b) => (b.quantity * b.avgBuyPrice) - (a.quantity * a.avgBuyPrice));
  let totalInvested = 0;
  const positions: HistoricalHolding[] = active.map(h => {
    const invested = h.quantity * h.avgBuyPrice;
    totalInvested += invested;
    return { securityName: h.securityName, isin: h.isin, quantity: h.quantity, avgBuyPrice: parseFloat(h.avgBuyPrice.toFixed(4)), invested: parseFloat(invested.toFixed(2)) };
  });
  return { positions, totalInvested: parseFloat(totalInvested.toFixed(2)), tradeRows: replayed };
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
    const type = (r[typeIdx] || "").toString().trim().toUpperCase();
    if (type !== "BUY" && type !== "SELL") continue;
    const name = (r[nameIdx] || "").toString().trim();
    const qty = toNum(r[qtyIdx]);
    if (!name || isNaN(qty) || qty <= 0) continue;
    const avgPrice = toNum(r[priceIdx]);
    const turnover = toNum(r[turnoverIdx]);
    const inclSTT = toNum(r[inclIdx]);
    // Invested = all-in cost incl. expenses: value BUYs by "Total Amount with
    // Expense (Incl STT)" (fallback turnover, then Avg Price). Sells carry no cost.
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
    if (r.status === "resolved") {
      key = r.key;
    } else {
      key = (isin || "").trim() || normName(name);
      if (!unresolvedMap.has(key)) {
        unresolvedMap.set(key, { name, isin, candidates: r.status === "ambiguous" ? r.candidates : [] });
      }
    }
    let h = byKey.get(key);
    if (!h) {
      h = { isin, securityName: name, quantity: 0, avgBuyPrice: 0 };
      byKey.set(key, h);
    } else if (isin && !h.isin) {
      h.isin = isin;
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

  // Corporate actions (merger / demerger) are applied in date order, interleaved
  // with the trade replay, so a position's cost is right at the moment each acts.
  const corpActions = await loadCorporateActions(spreadsheetId);
  const applyMergerHolding = (ca: CorpAction) => {
    const tgt = resolve("", ca.from);            // Target → removed
    tgt.quantity = 0; tgt.avgBuyPrice = 0;
    const acq = resolve("", ca.to);              // Acquirer → += sharesIn at carried cost
    const newQty = acq.quantity + ca.sharesIn;
    acq.avgBuyPrice = newQty > 0 ? ((acq.quantity * acq.avgBuyPrice) + ca.cost) / newQty : 0;
    acq.quantity = newQty;
  };
  const applyDemergerHolding = (ca: CorpAction) => {
    const parent = resolve("", ca.from);         // Parent → cost reduced, qty unchanged
    const parentCost = parent.quantity * parent.avgBuyPrice;
    const newParentCost = Math.max(0, parentCost - ca.cost);
    parent.avgBuyPrice = parent.quantity > 0 ? newParentCost / parent.quantity : 0;
    const nc = resolve("", ca.to);               // NewCo → += sharesIn at moved cost
    const newQty = nc.quantity + ca.sharesIn;
    nc.avgBuyPrice = newQty > 0 ? ((nc.quantity * nc.avgBuyPrice) + ca.cost) / newQty : 0;
    nc.quantity = newQty;
  };

  type HEv = { ts: number; ord: number; trade?: ReplayTrade; ca?: CorpAction };
  const hevents: HEv[] = [];
  for (const t of playable) hevents.push({ ts: t.ts, ord: 0, trade: t });
  for (const ca of corpActions) hevents.push({ ts: parseDateTs(ca.dateStr) || 0, ord: 1, ca });
  hevents.sort((a, b) => (a.ts - b.ts) || (a.ord - b.ord));

  for (const ev of hevents) {
    if (ev.ca) { ev.ca.type === "Merger" ? applyMergerHolding(ev.ca) : applyDemergerHolding(ev.ca); continue; }
    const t = ev.trade!;
    const h = resolve(t.isin, t.name);
    if (t.type === "BUY") {
      const newQty = h.quantity + t.qty;
      if (newQty > 0) {
        h.avgBuyPrice = h.quantity < 0
          ? t.price
          : ((h.quantity * h.avgBuyPrice) + (t.qty * t.price)) / newQty;
      } else {
        h.avgBuyPrice = 0;
      }
      h.quantity = newQty;
    } else {
      h.quantity -= t.qty;
      if (h.quantity <= 0) h.avgBuyPrice = 0;
    }
  }

  // ── 4. Write Holding tab ──
  const active = [...byKey.values()]
    .filter(h => h.quantity > 0)
    .sort((a, b) => (b.quantity * b.avgBuyPrice) - (a.quantity * a.avgBuyPrice));

  const rows: any[][] = [["Company Name", "ISIN", "Quantity", "Avg Buy Price", "Invested Value"]];
  let totalInvested = 0;
  for (const h of active) {
    const invested = h.quantity * h.avgBuyPrice;
    totalInvested += invested;
    rows.push([
      h.securityName,
      h.isin,
      h.quantity,
      parseFloat(h.avgBuyPrice.toFixed(4)),
      parseFloat(invested.toFixed(2)),
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

  return {
    positions: active.length,
    totalInvested: parseFloat(totalInvested.toFixed(2)),
    tradeRows: trades.length,
    unresolved: [...unresolvedMap.values()],
    master,
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
  const fmtDate = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  const isDelivery = (tc: string) => !tc.toLowerCase().includes("intraday");

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
    const txType = (r[typeIdx >= 0 ? typeIdx : 3] || "").toString().trim().toUpperCase();
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

  const deliveryBuys = teData.filter(t => t.txType === "BUY" && isDelivery(t.tradeClass)).sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
  const deliverySells = teData.filter(t => t.txType === "SELL" && isDelivery(t.tradeClass)).sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
  const intradayBuys = teData.filter(t => t.txType === "BUY" && !isDelivery(t.tradeClass));
  const intradaySells = teData.filter(t => t.txType === "SELL" && !isDelivery(t.tradeClass)).sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());

  interface IntradayLot { qty: number; remaining: number; purPrice: number; tradeDate: string; dateObj: Date; }
  const intradayQueues: Record<string, IntradayLot[]> = {};
  for (const buy of intradayBuys) {
    const key = `${fmtDate(buy.dateObj)}|${secKey(buy.isin, buy.stockName)}`; if (!intradayQueues[key]) intradayQueues[key] = [];
    intradayQueues[key].push({ qty: buy.qty, remaining: buy.qty, purPrice: buy.avgPrice, tradeDate: buy.tradeDate, dateObj: buy.dateObj });
  }

  // ── Step 4: FIFO-match delivery sells → STCG / LTCG rows ──
  interface CGRecord { saleDate: string; saleDateObj: Date; assetName: string; isin: string; qtySold: number; salePrice: number; saleAmt: number; purDate: string; purPrice: number; acqCost: number; intradayCg: number; stcg: number; ltcg: number; }
  const allRecords: CGRecord[] = [];

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

  // One date-ordered pass: BUY adds a lot, corporate action transforms queues,
  // SELL consumes lots FIFO. Same-date order: buys, then actions, then sells.
  type DEv = { ts: number; ord: number; buy?: TERow; sell?: TERow; ca?: CorpAction };
  const devents: DEv[] = [];
  for (const b of deliveryBuys) devents.push({ ts: b.dateObj.getTime(), ord: 0, buy: b });
  for (const ca of corpActions) { const d = parseDate(ca.dateStr); devents.push({ ts: d ? d.getTime() : 0, ord: 1, ca }); }
  for (const s of deliverySells) devents.push({ ts: s.dateObj.getTime(), ord: 2, sell: s });
  devents.sort((a, b) => (a.ts - b.ts) || (a.ord - b.ord));

  for (const ev of devents) {
    if (ev.buy) {
      const buy = ev.buy;
      const key = secKey(buy.isin, buy.stockName); if (!fifo[key]) fifo[key] = [];
      fifo[key].push({ stockName: buy.stockName, isin: buy.isin, buyDate: buy.dateObj, buyDateStr: buy.tradeDate, qty: buy.qty, remaining: buy.qty, purPrice: buy.avgPrice, isOpening: false });
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

  // ── Intraday sells: match same-day buys ──
  for (const sell of intradaySells) {
    const key = `${fmtDate(sell.dateObj)}|${secKey(sell.isin, sell.stockName)}`;
    const dayLots = intradayQueues[key] || [];
    let sellLeft = sell.qty; let matched = false;
    for (const lot of dayLots) {
      if (sellLeft <= 0) break; if (lot.remaining <= 0) continue;
      const matchQty = Math.min(lot.remaining, sellLeft);
      const saleAmt = r2(matchQty * sell.avgPrice);
      const acqCost = r2(matchQty * lot.purPrice);
      allRecords.push({ saleDate: fmtDate(sell.dateObj), saleDateObj: sell.dateObj, assetName: sell.stockName, isin: sell.isin, qtySold: matchQty, salePrice: sell.avgPrice, saleAmt, purDate: fmtDate(lot.dateObj), purPrice: lot.purPrice, acqCost, intradayCg: r2(saleAmt - acqCost), stcg: 0, ltcg: 0 });
      lot.remaining -= matchQty; sellLeft -= matchQty; matched = true;
    }
    if (!matched && sellLeft > 0) {
      const saleAmt = r2(sellLeft * sell.avgPrice);
      allRecords.push({ saleDate: fmtDate(sell.dateObj), saleDateObj: sell.dateObj, assetName: sell.stockName, isin: sell.isin, qtySold: sellLeft, salePrice: sell.avgPrice, saleAmt, purDate: fmtDate(sell.dateObj), purPrice: sell.avgPrice, acqCost: saleAmt, intradayCg: 0, stcg: 0, ltcg: 0 });
    }
  }

  allRecords.sort((a, b) => a.saleDateObj.getTime() - b.saleDateObj.getTime());

  // Historical (pre-FY24-25) sells participated in FIFO matching above so lot
  // consumption stays correct — but only FY24-25+ sales get exported.
  const reportRecords = allRecords.filter(r => r.saleDateObj.getTime() >= EXPORT_FROM.getTime());

  // ── Step 5: Build LTST tab data ──
  const ltstRows: any[][] = [];
  ltstRows.push(["Sale Date", "Asset Name", "Qty. Sold", "Sale Price", "Sale Amt.", "Pur. Date", "Pur. Price", "Acquisition Cost", "Intra day Cg", "Short Term Cg", "Long Term CG"]);
  for (const rec of reportRecords) {
    ltstRows.push([
      rec.saleDate, rec.assetName, rec.qtySold,
      r2(rec.salePrice), r2(rec.saleAmt),
      rec.purDate, r2(rec.purPrice), r2(rec.acqCost),
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
