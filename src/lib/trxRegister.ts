import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import {
  normName, loadScripMaster, resolveScrip, ScripMaster,
  SCRIP_MASTER_SPREADSHEET_ID,
} from "./scripMaster";
import { loadCorporateActions } from "./corporateActions";
import { loadOpeningHoldings } from "./openingHoldings";
import { UnresolvedScrip } from "./holdingsCalc";
import { ledgerSide, isSplitType } from "./tradeRowSchema";

/**
 * Financial-year, scrip-wise TRANSACTION LEDGER — a replica of the accountant's
 * annual ledger format (opening stock → purchases → sales → closing stock, per
 * security, with LTCG/STCG split and a per-transaction charge breakdown).
 *
 * Computed purely from `True Entry` (entry-only, like the other engines). A single
 * chronological FIFO replay does double duty:
 *   • splits every FY SALE into LTCG / STCG parcels  → **turnover** cost basis
 *     (same convention as syncCapitalGains / the LTST tab), and
 *   • snapshots the remaining dated lots at the FY boundaries for the OPENING and
 *     CLOSING blocks → **turnover** (charge-free) valuation (same as the Holding tab).
 * Corporate actions (Merger / Demerger from the Corporate Actions tab) are
 * interleaved by date so lot cost + acquisition dates are right at each event.
 *
 * Three P&L buckets, matching the PnL Summary tab: Intra-Day / Short term / Long
 * term. Delivery buy/sell feed the FIFO replay (opening → purchase → sale →
 * closing, with STCG/LTCG). Intraday-tagged trades are matched same-day per scrip
 * (speculative P&L → the Intra-Day column) and never carry a lot, so they don't
 * touch the opening/closing position. Dmat and Exchange-Clearing charge columns
 * aren't captured in the ledger (nil in the source too) and are left blank.
 */

// ── small local helpers (mirror holdingsCalc's date/number handling) ──
const toNum = (s: any): number => {
  const v = parseFloat((s ?? "").toString().replace(/,/g, "").trim());
  return isNaN(v) ? NaN : v;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
// Rate / cost-per-share: keep full precision (only trim float noise at 6 dp) — never
// round the basis to paise. Money amounts (turnover, P/L, charges) stay at r2.
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

const SHEET_EPOCH_MS = Date.UTC(1899, 11, 30);
const serialToTs = (serial: number): number => {
  const d = new Date(SHEET_EPOCH_MS + Math.round(serial * 86400000));
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
};
// Sheets date serial (preferred, unambiguous) or a DD/MM/YYYY-ish string → epoch ms.
const parseDateTs = (s: any): number => {
  if (s === null || s === undefined || s === "") return 0;
  if (typeof s === "number") return isFinite(s) ? serialToTs(s) : 0;
  const c = s.toString().trim();
  if (!c) return 0;
  let m = c.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
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
const fmtDate = (ts: number): string => {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
};
const daysBetween = (a: number, b: number) => Math.floor((b - a) / 86400000);

// ── 25-column layout (mirrors the source CSV exactly) ──
const COL = {
  sno: 0, name: 1,
  oDate: 2, oQty: 3, oRate: 4, oAmt: 5,
  pDate: 6, pQty: 7, pRate: 8, pAmt: 9,
  sDate: 10, sQty: 11, sRate: 12, sAmt: 13,
  intra: 14, st: 15, lt: 16,
  brok: 17, stt: 18, gst: 19, et: 20, dmat: 21, stamp: 22, sebi: 23, exchClg: 24, ipf: 25,
};
const WIDTH = 26;
const blankRow = (): any[] => new Array(WIDTH).fill("");

// ── charge bundle per trade (register order; exchClg not captured) ──
interface Charges { brok: number; stt: number; gst: number; et: number; stamp: number; sebi: number; ipf: number; dmat: number; }
const ZERO_CHARGES: Charges = { brok: 0, stt: 0, gst: 0, et: 0, stamp: 0, sebi: 0, ipf: 0, dmat: 0 };
const addCharges = (a: Charges, b: Charges): Charges => ({
  brok: a.brok + b.brok, stt: a.stt + b.stt, gst: a.gst + b.gst, et: a.et + b.et,
  stamp: a.stamp + b.stamp, sebi: a.sebi + b.sebi, ipf: a.ipf + b.ipf, dmat: a.dmat + b.dmat,
});
// Pro-rate a charge bundle by a quantity fraction (used when one trade is split into
// intraday / short-term / long-term rows — the split rows' charges sum to the original).
const scaleCharges = (c: Charges, f: number): Charges => ({
  brok: c.brok * f, stt: c.stt * f, gst: c.gst * f, et: c.et * f,
  stamp: c.stamp * f, sebi: c.sebi * f, ipf: c.ipf * f, dmat: c.dmat * f,
});

interface Trade {
  ts: number; idx: number; key: string; name: string; isin: string;
  type: "BUY" | "SELL";
  qty: number; avgPrice: number; turnover: number; inclSTT: number;
  charges: Charges;
  isIntraday: boolean;
}

// A dated cost lot. purPrice = turnover/qty; inclPrice = Incl-STT/qty. Both bases
// are kept so we can always recover the charge-free TURNOVER (see turnoverPrice).
interface Lot { buyTs: number; qty: number; remaining: number; purPrice: number; inclPrice: number; charges: Charges; }
interface LotSnap { ts: number; dateStr: string; qty: number; inclPrice: number; purPrice: number; charges: Charges; }

// Charge-free TURNOVER per share for a HELD lot — the basis the OPENING / CLOSING
// blocks (and the Holding tab) value at. A held lot is always a buy / opening-seed /
// corporate-action lot, so its all-in (Incl-STT) price = turnover + non-negative
// charges ≥ its turnover price. Turnover is therefore ALWAYS the smaller of the two,
// regardless of which physical column a given import happened to drop it in (some
// brokers land turnover in the Incl-STT column and the all-in in the turnover column
// — the values are reversed, but min() still recovers turnover). Seed / CA lots set
// the two equal, so min() is a no-op there.
const turnoverPrice = (l: { purPrice: number; inclPrice: number }): number =>
  Math.min(l.purPrice, l.inclPrice);
// One consolidated opening/closing line per calendar date (weighted-avg rate,
// exact summed amount — the source shows opening/closing date-wise, not lot-wise).
interface DateAgg { ts: number; dateStr: string; qty: number; amount: number; rate: number; }

interface CorpNote { ts: number; text: string; }

// Per-scrip accumulated block.
interface Block {
  key: string; name: string;
  purchases: { ts: number; qty: number; avgPrice: number; turnover: number; charges: Charges }[];
  sales: { ts: number; qty: number; avgPrice: number; turnover: number; charges: Charges; category: "INTRA" | "ST" | "LT"; pnl: number }[];
  splits: { ts: number; qty: number; rate: number; amount: number }[];   // restated holding after a split (post-split qty/rate/total cost)
  corpNotes: CorpNote[];
  opening: LotSnap[];
  closing: LotSnap[];
  firstTs: number;
}

export interface TrxRegisterResult {
  tabName: string;
  holdingTabName: string;
  fyLabel: string;
  scrips: number;
  buyRows: number;
  sellRows: number;
  unresolved: UnresolvedScrip[];
  master: ScripMaster;
}

const findCol = (hdrs: string[], ...names: string[]): number => {
  for (const n of names) { const i = hdrs.indexOf(n); if (i >= 0) return i; }
  return -1;
};

// Sheets API calls can transiently 429/5xx — especially right after a Holding rebuild
// + capital-gains sync has burned through the per-minute write quota. The formatting
// batch is atomic: losing it leaves the PREVIOUS run's colour bands misaligned under
// the fresh values (green stripes mid-data), so retry briefly instead of giving up.
const withBackoff = async <T>(fn: () => Promise<T>, tries = 4): Promise<T> => {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e: any) {
      last = e;
      const code = Number(e?.result?.error?.code ?? e?.status ?? 0);
      if (code !== 429 && code !== 500 && code !== 503) throw e;
      await new Promise(res => setTimeout(res, 1500 * (i + 1)));
    }
  }
  throw last;
};
const fyLabelOf = (startYear: number) =>
  `FY${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`;

/**
 * Build the FY register tab. `fyStartYear` = 2023 means FY2023-24 (1-Apr-2023 to
 * 31-Mar-2024). Reads True Entry + Corporate Actions, writes a new tab.
 */
export async function generateTrxRegister(
  spreadsheetId: string,
  fyStartYear: number,
  title?: string,
): Promise<TrxRegisterResult> {
  const fyStartTs = new Date(fyStartYear, 3, 1).getTime();          // 1-Apr, inclusive
  const fyEndExclTs = new Date(fyStartYear + 1, 3, 1).getTime();    // next 1-Apr, exclusive
  const fyLabel = fyLabelOf(fyStartYear);

  // ── 1. Read True Entry (dates as serials — unambiguous) ──
  let teRes: any;
  try {
    teRes = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId, range: "True Entry!A:Z",
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
  if (teRows.length < 2) throw new Error("True Entry sheet is empty — nothing to generate from.");

  const hdrs = teRows[0].map((h: any) => (h || "").toString().trim());
  const dateIdx = findCol(hdrs, "Trade Date", "Date");
  const nameIdx = findCol(hdrs, "Stock Name", "Security Name");
  const typeIdx = findCol(hdrs, "Transaction Type");
  const qtyIdx = findCol(hdrs, "Number of Shares", "Quantity");
  const priceIdx = findCol(hdrs, "Avg Price");
  const turnoverIdx = findCol(hdrs, "Total Amount (Turnover)");
  const inclIdx = findCol(hdrs, "Total Amount with Expense (Incl STT)");
  const classIdx = findCol(hdrs, "Trade Class", "Trade Type");
  const isinIdx = findCol(hdrs, "ISIN");
  // charge columns (Dmat + Exchange-Clearing intentionally absent from the ledger)
  const brokIdx = findCol(hdrs, "Total Brokerage", "Brokerage");
  const sttIdx = findCol(hdrs, "STT");
  const gstIdx = findCol(hdrs, "IGST", "Total GST");
  const etIdx = findCol(hdrs, "Exchange Turnover Charges");
  const stampIdx = findCol(hdrs, "Stamp Duty");
  const sebiIdx = findCol(hdrs, "SEBI Turnover Fees");
  const ipfIdx = findCol(hdrs, "IPF Charges");
  const dmatIdx = findCol(hdrs, "Demat Charges", "Demat Chrg", "Demat Chrg.", "Dmat");

  const num = (r: any[], i: number) => (i >= 0 ? (toNum(r[i]) || 0) : 0);

  // ── 2. Resolve scrips via the shared master (short code + full name → one key) ──
  const master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID);
  const unresolvedMap = new Map<string, UnresolvedScrip>();
  const keyOf = (isin: string, name: string): string => {
    const r = resolveScrip(master, isin, name);
    if (r.status === "resolved") return r.key;
    const k = (isin || "").trim() || normName(name);
    if (!unresolvedMap.has(k)) {
      unresolvedMap.set(k, { name, isin, candidates: r.status === "ambiguous" ? r.candidates : [] });
    }
    return k;
  };

  const trades: Trade[] = [];
  const splitRows: { ts: number; key: string; qty: number }[] = [];   // rescale events (kept out of trades)
  for (let i = 1; i < teRows.length; i++) {
    const r = teRows[i];
    if (!r || r.length === 0) continue;
    const rawType = (r[typeIdx] || "").toString().trim();
    const name = (r[nameIdx] || "").toString().trim();
    const qty = toNum(r[qtyIdx]);
    if (!name || isNaN(qty) || qty <= 0) continue;
    const isin = isinIdx >= 0 ? (r[isinIdx] || "").toString().trim() : "";
    // A Split rescales the held lots (keeps their acquisition dates) — collect it
    // separately and apply as a dated event; it's NOT a buy.
    if (isSplitType(rawType)) { splitRows.push({ ts: parseDateTs(r[dateIdx]), key: keyOf(isin, name), qty }); continue; }
    // Everything else → a buy/sell SIDE (Bonus/IPO/Rights are buy-side, ₹0/priced add).
    const type = ledgerSide(rawType);
    if (!type) continue;
    const tradeClass = (classIdx >= 0 ? (r[classIdx] || "").toString() : "").toLowerCase();
    const isIntraday = tradeClass.includes("intraday");
    const avgPrice = toNum(r[priceIdx]) || 0;
    const turnover = toNum(r[turnoverIdx]) || 0;
    const inclSTT = inclIdx >= 0 ? (toNum(r[inclIdx]) || 0) : 0;
    trades.push({
      ts: parseDateTs(r[dateIdx]), idx: i, key: keyOf(isin, name), name, isin,
      type: type as "BUY" | "SELL", qty, avgPrice, turnover, inclSTT, isIntraday,
      charges: {
        brok: num(r, brokIdx), stt: num(r, sttIdx), gst: num(r, gstIdx), et: num(r, etIdx),
        stamp: num(r, stampIdx), sebi: num(r, sebiIdx), ipf: num(r, ipfIdx), dmat: num(r, dmatIdx),
      },
    });
  }
  if (trades.length === 0 && splitRows.length === 0) throw new Error("True Entry has no parseable delivery Buy/Sell rows.");

  // Longest name seen per key (usually the full official name over a short code).
  const nameByKey = new Map<string, string>();
  for (const t of trades) {
    const cur = nameByKey.get(t.key);
    if (!cur || t.name.length > cur.length) nameByKey.set(t.key, t.name);
  }

  // ── 3. Corporate actions (Merger / Demerger) as dated events ──
  const corpActions = await loadCorporateActions(spreadsheetId);

  // Opening basis carried into the FY (lots as of 1-Apr of fyStartYear+1). True
  // Entry is FY26-only, so a scrip bought before FY26 has no buy row here; without
  // this seed its FY26 sells would find no lot → P/L 0 (blank) and OPENING STOCK
  // empty. Seed exactly like syncCapitalGains. No-op if the tab doesn't exist.
  const openingSeed = await loadOpeningHoldings(spreadsheetId).catch(() => []);
  for (const ol of openingSeed) {
    const key = keyOf(ol.isin, ol.name);
    if (ol.name && (nameByKey.get(key)?.length ?? 0) < ol.name.length) nameByKey.set(key, ol.name);
  }

  // ── 3b. Automatic intraday reconciliation per (scrip, day) — ALWAYS ON, tag-independent.
  // A same-day buy+sell of the same scrip is an intraday round-trip by definition, so we
  // match the min(buyQty, sellQty) as speculative regardless of the broker's Trade Class
  // (Zerodha's tag is only a buy==sell heuristic and misses partial round-trips — e.g.
  // Park Medi World 12-Feb: bought 1,500, sold 3,000 → 1,500 intraday + 1,500 delivery).
  // The matched qty → an intraday round-trip; the residual buy/sell is real DELIVERY and
  // flows through the FIFO (→ STCG/LTCG, reduces closing). Days with only buys OR only
  // sells for a scrip aren't round-trips and pass through unchanged as delivery trades.
  // Same-day netting convention (matches the accountant): a pre-existing holding does NOT
  // suppress this — held 500, then same-day buy 100 + sell 200 ⇒ 100 intraday, and the
  // residual 100 sale draws from the carried holding via FIFO (its own LTCG/STCG).
  interface IntradayRT { key: string; ts: number; qty: number; buyPrice: number; sellPrice: number; buyCharges: Charges; sellCharges: Charges; }
  const intradayRTs: IntradayRT[] = [];
  const residualTrades: Trade[] = [];
  const pairedIdx = new Set<number>();   // idx of trades consumed by a same-day round-trip
  {
    const groups = new Map<string, Trade[]>();
    for (const t of trades) {
      const gk = `${t.key}|${t.ts}`;
      (groups.get(gk) || groups.set(gk, []).get(gk)!).push(t);
    }
    for (const [, g] of groups) {
      const buys = g.filter(t => t.type === "BUY"), sells = g.filter(t => t.type === "SELL");
      const buyQty = buys.reduce((s, t) => s + t.qty, 0), sellQty = sells.reduce((s, t) => s + t.qty, 0);
      const matched = Math.min(buyQty, sellQty);
      if (matched <= 1e-9) continue;   // only buys OR only sells that day → not a round-trip; leave as delivery events
      for (const t of g) pairedIdx.add(t.idx);   // the whole day's rows for this scrip are re-expressed as intraday + residual
      const avgBuy = buyQty > 0 ? buys.reduce((s, t) => s + t.turnover, 0) / buyQty : 0;
      const avgSell = sellQty > 0 ? sells.reduce((s, t) => s + t.turnover, 0) / sellQty : 0;
      const buyCharges = buys.reduce((c, t) => addCharges(c, t.charges), { ...ZERO_CHARGES });
      const sellCharges = sells.reduce((c, t) => addCharges(c, t.charges), { ...ZERO_CHARGES });
      const proto = g[0];
      intradayRTs.push({
        key: proto.key, ts: proto.ts, qty: matched, buyPrice: avgBuy, sellPrice: avgSell,
        buyCharges: scaleCharges(buyCharges, buyQty > 0 ? matched / buyQty : 0),
        sellCharges: scaleCharges(sellCharges, sellQty > 0 ? matched / sellQty : 0),
      });
      const resBuy = buyQty - matched, resSell = sellQty - matched;
      const residual = (type: "BUY" | "SELL", qty: number, price: number, dayCharges: Charges, dayQty: number) => residualTrades.push({
        ts: proto.ts, idx: proto.idx, key: proto.key, name: proto.name, isin: proto.isin, type,
        qty, avgPrice: price, turnover: price * qty, inclSTT: price * qty, isIntraday: false,
        charges: scaleCharges(dayCharges, dayQty > 0 ? qty / dayQty : 0),
      });
      if (resBuy > 1e-9) residual("BUY", resBuy, avgBuy, buyCharges, buyQty);
      if (resSell > 1e-9) residual("SELL", resSell, avgSell, sellCharges, sellQty);
    }
  }

  // ── 4. Single chronological replay: buys add lots, CAs transform, sells consume ──
  type Ev =
    | { ts: number; ord: number; idx: number; kind: "trade"; trade: Trade }
    | { ts: number; ord: number; idx: number; kind: "split"; key: string; qty: number }
    | { ts: number; ord: number; idx: number; kind: "ca"; fromKey: string; toKey: string; caType: "Merger" | "Demerger"; sharesIn: number; cost: number; from: string; to: string };
  const events: Ev[] = [];
  for (const t of trades) if (!pairedIdx.has(t.idx)) events.push({ ts: t.ts, ord: t.type === "BUY" ? 0 : 2, idx: t.idx, kind: "trade", trade: t });
  for (const t of residualTrades) events.push({ ts: t.ts, ord: t.type === "BUY" ? 0 : 2, idx: t.idx, kind: "trade", trade: t });
  for (const sp of splitRows) events.push({ ts: sp.ts, ord: 1, idx: 1e9, kind: "split", key: sp.key, qty: sp.qty });
  for (const ca of corpActions) {
    const caTs = parseDateTs(ca.dateStr);
    if (!caTs) {   // undateable action can't be placed in the timeline — skip rather than stamp an epoch-0 lot (which would force LTCG)
      console.warn(`Transaction Ledger: skipping corporate action with unparseable date "${ca.dateStr}" (${ca.type} ${ca.from} → ${ca.to}).`);
      continue;
    }
    events.push({
      ts: caTs, ord: 1, idx: 1e9, kind: "ca",
      fromKey: keyOf("", ca.from), toKey: keyOf("", ca.to),
      caType: ca.type, sharesIn: ca.sharesIn, cost: ca.cost, from: ca.from, to: ca.to,
    });
  }
  // buys (0) → corp actions (1) → sells (2) on the same day; then by sheet order
  events.sort((a, b) => (a.ts - b.ts) || (a.ord - b.ord) || (a.idx - b.idx));

  const fifo = new Map<string, Lot[]>();
  const blocks = new Map<string, Block>();
  const block = (key: string): Block => {
    let b = blocks.get(key);
    if (!b) {
      b = { key, name: nameByKey.get(key) || key, purchases: [], sales: [], splits: [], corpNotes: [], opening: [], closing: [], firstTs: Infinity };
      blocks.set(key, b);
    }
    return b;
  };
  const touch = (key: string, ts: number) => { const b = block(key); if (ts && ts < b.firstTs) b.firstTs = ts; };

  const snapshot = (key: string): LotSnap[] =>
    (fifo.get(key) || []).filter(l => l.remaining > 1e-9)
      // charges are pro-rated to the still-held fraction (remaining / original qty),
      // which is invariant under a split (both scale by the same factor).
      .map(l => ({ ts: l.buyTs, dateStr: fmtDate(l.buyTs), qty: l.remaining, inclPrice: l.inclPrice, purPrice: l.purPrice, charges: scaleCharges(l.charges, l.qty > 0 ? l.remaining / l.qty : 0) }));
  const snapshotAll = (): Map<string, LotSnap[]> => {
    const m = new Map<string, LotSnap[]>();
    for (const key of fifo.keys()) { const s = snapshot(key); if (s.length) m.set(key, s); }
    return m;
  };

  // Seed the carried-in opening lots BEFORE the replay so they're the oldest lots
  // in each queue (FIFO consumes them first). cost basis = reconstructed cost/share
  // for both the CG (purPrice) and the closing-valuation (inclPrice) bases.
  for (const ol of openingSeed) {
    const key = keyOf(ol.isin, ol.name);
    const buyTs = parseDateTs(ol.acqDate) || fyStartTs;
    (fifo.get(key) || fifo.set(key, []).get(key)!).push({ buyTs, qty: ol.qty, remaining: ol.qty, purPrice: ol.costPerShare, inclPrice: ol.costPerShare, charges: { ...ZERO_CHARGES } });
  }
  for (const [, arr] of fifo) arr.sort((a, b) => a.buyTs - b.buyTs);

  let opening: Map<string, LotSnap[]> | null = null;
  for (const ev of events) {
    if (ev.ts >= fyEndExclTs) break;                       // future FY — excluded from this year's closing
    if (opening === null && ev.ts >= fyStartTs) opening = snapshotAll();  // freeze opening at the FY boundary
    const inFY = ev.ts >= fyStartTs && ev.ts < fyEndExclTs;

    if (ev.kind === "ca") {
      const lots = fifo.get(ev.fromKey) || [];
      if (ev.caType === "Merger") {
        for (const l of lots) l.remaining = 0;             // target absorbed
      } else {                                             // Demerger: shrink parent cost pro-rata
        const remCost = lots.reduce((s, l) => s + l.remaining * l.purPrice, 0);
        const factor = remCost > 0 ? Math.max(0, remCost - ev.cost) / remCost : 1;
        // r2 on purPrice to match syncCapitalGains exactly (keeps register CG == LTST tab)
        for (const l of lots) { l.purPrice = r2(l.purPrice * factor); l.inclPrice = r4(l.inclPrice * factor); }
      }
      if (ev.sharesIn > 0) {                               // acquirer / new-co lot at the action date
        const per = ev.cost / ev.sharesIn;
        const arr = fifo.get(ev.toKey) || [];
        arr.push({ buyTs: ev.ts, qty: ev.sharesIn, remaining: ev.sharesIn, purPrice: per, inclPrice: per, charges: { ...ZERO_CHARGES } });
        fifo.set(ev.toKey, arr);
      }
      if (inFY) {
        touch(ev.fromKey, ev.ts); touch(ev.toKey, ev.ts);
        block(ev.toKey).corpNotes.push({ ts: ev.ts, text: `${ev.caType.toUpperCase()} from ${ev.from} (${fmtDate(ev.ts)})` });
        block(ev.fromKey).corpNotes.push({ ts: ev.ts, text: `${ev.caType.toUpperCase()} → ${ev.to} (${fmtDate(ev.ts)})` });
      }
      continue;
    }

    if (ev.kind === "split") {
      // Subdivide every lot held on the split date: qty ×factor, cost/share ÷factor,
      // acquisition date UNCHANGED (holding period stays continuous). factor derived
      // from the split's added qty over the qty actually held → exact.
      const lots = fifo.get(ev.key) || [];
      const held = lots.reduce((s, l) => s + l.remaining, 0);
      if (held > 1e-9 && ev.qty > 0) {
        const factor = (held + ev.qty) / held;
        for (const l of lots) { l.qty *= factor; l.remaining *= factor; l.purPrice = l.purPrice / factor; l.inclPrice = l.inclPrice / factor; }
        if (inFY) {
          touch(ev.key, ev.ts);
          // Restate the holding after the split: post-split qty, weighted-avg rescaled
          // rate, and the (unchanged) total cost — shown as a "SPLIT" line in the ledger.
          const newQty = lots.reduce((s, l) => s + l.remaining, 0);
          const amt = lots.reduce((s, l) => s + l.remaining * turnoverPrice(l), 0);
          block(ev.key).splits.push({ ts: ev.ts, qty: newQty, rate: newQty > 0 ? amt / newQty : 0, amount: amt });
        }
      }
      continue;
    }

    const t = ev.trade;
    if (t.type === "BUY") {
      const purPrice = t.qty > 0 && t.turnover > 0 ? t.turnover / t.qty : t.avgPrice;
      const inclPrice = t.qty > 0 && t.inclSTT > 0 ? t.inclSTT / t.qty : purPrice;
      const arr = fifo.get(t.key) || [];
      arr.push({ buyTs: t.ts, qty: t.qty, remaining: t.qty, purPrice, inclPrice, charges: t.charges });
      fifo.set(t.key, arr);
      if (inFY) {
        touch(t.key, t.ts);
        block(t.key).purchases.push({ ts: t.ts, qty: t.qty, avgPrice: t.avgPrice, turnover: t.turnover, charges: t.charges });
      }
    } else {
      // SELL — FIFO-consume; split matched parcels into ST and LT buckets (qty + P/L)
      // by holding days ≥ 365 (turnover basis), so each bucket becomes its own row.
      const lots = fifo.get(t.key) || [];
      const salePrice = t.qty > 0 && t.turnover > 0 ? t.turnover / t.qty : t.avgPrice;
      let left = t.qty, ltQty = 0, ltGain = 0, stQty = 0, stGain = 0;
      for (const l of lots) {
        if (left <= 1e-9) break;
        if (l.remaining <= 1e-9) continue;
        const m = Math.min(l.remaining, left);
        const gain = r2(m * salePrice) - r2(m * l.purPrice);
        if (daysBetween(l.buyTs, t.ts) >= 365) { ltQty += m; ltGain += gain; } else { stQty += m; stGain += gain; }
        l.remaining -= m; left -= m;
      }
      if (inFY) {
        touch(t.key, t.ts);
        const b = block(t.key);
        const pushSale = (category: "ST" | "LT", qty: number, pnl: number) => {
          if (qty <= 1e-9) return;
          b.sales.push({ ts: t.ts, qty, avgPrice: salePrice, turnover: r2(salePrice * qty), charges: scaleCharges(t.charges, t.qty > 0 ? qty / t.qty : 0), category, pnl: r2(pnl) });
        };
        pushSale("ST", stQty, stGain);
        pushSale("LT", ltQty, ltGain);
        // Sold more than held (no matching lot, e.g. missing opening basis) → show the
        // uncovered qty as ST with 0 P/L so the quantity still reconciles, not a phantom gain.
        if (left > 1e-9) pushSale("ST", left, 0);
      }
    }
  }
  if (opening === null) opening = snapshotAll();   // no FY events (all pre-FY) → opening = current lots
  const closing = snapshotAll();

  // Attach opening/closing snapshots to their blocks (create a block if a scrip is
  // held across the FY with no in-FY activity so it still shows up).
  for (const [key, snaps] of opening) { block(key).opening = snaps; touch(key, fyStartTs); }
  for (const [key, snaps] of closing) { block(key).closing = snaps; touch(key, fyStartTs); }

  // ── 4b. Intraday round-trips (matched same-day qty): the buy shows as a PURCHASE
  // row and the sell as an intraday SALES row. The residual (unmatched) quantity was
  // already routed into the delivery FIFO above → it emits its own ST/LT sale rows. ──
  for (const rt of intradayRTs) {
    if (rt.ts < fyStartTs || rt.ts >= fyEndExclTs) continue;
    touch(rt.key, rt.ts);
    const b = block(rt.key);
    b.purchases.push({ ts: rt.ts, qty: rt.qty, avgPrice: rt.buyPrice, turnover: rt.buyPrice * rt.qty, charges: rt.buyCharges });
    b.sales.push({ ts: rt.ts, qty: rt.qty, avgPrice: rt.sellPrice, turnover: rt.sellPrice * rt.qty, charges: rt.sellCharges, category: "INTRA", pnl: r2((rt.sellPrice - rt.buyPrice) * rt.qty) });
  }

  // ── 5. Emit rows ──
  // Only scrips with in-FY activity (purchase / sale / corporate action) — mirrors
  // the accountant's report. Opening-only holdings (seeded but untraded all year)
  // are intentionally omitted so the seed doesn't balloon the tab to every holding.
  const active = [...blocks.values()]
    .filter(b => b.purchases.length || b.sales.length || b.corpNotes.length || b.splits.length)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));   // scrip-wise, alphabetical

  const out: any[][] = [];
  // title + group header + column header
  const titleRow = blankRow(); titleRow[COL.name] = `${title ? title + " — " : ""}Capital Gains for ${fyLabel}`; out.push(titleRow);
  const grp = blankRow();
  grp[COL.oDate] = "OPENING STOCK"; grp[COL.pDate] = "PURCHASE"; grp[COL.sDate] = "SALES";
  grp[COL.intra] = "Intra-Day"; grp[COL.st] = "Short term"; grp[COL.lt] = "Long term"; out.push(grp);
  out.push([
    "S.No", "SCRIPT NAME", "DATE", "NO OF SHARE", "RATE", "AMOUNT",
    "DATE", "NO OF SHARE", "RATE", "AMOUNT", "DATE", "NO OF SHARE", "RATE", "AMOUNT",
    "P/L", "P/L", "P/L", "Brok.Total", "STT", "GST", "ET Charges", "Dmat", "Stamp duty", "SEBI Chg.", "EXCH.Clg.", "IPF",
  ]);

  const grand: Charges = { ...ZERO_CHARGES };
  const grandPnl = { intra: 0, st: 0, lt: 0 };   // running P&L totals per tax bucket
  const chargeCells = (row: any[], c: Charges) => {
    row[COL.brok] = c.brok || ""; row[COL.stt] = c.stt || ""; row[COL.gst] = c.gst || "";
    row[COL.et] = c.et || ""; row[COL.stamp] = c.stamp || ""; row[COL.sebi] = c.sebi || "";
    row[COL.ipf] = c.ipf || ""; row[COL.dmat] = c.dmat || "";
    grand.brok += c.brok; grand.stt += c.stt; grand.gst += c.gst; grand.et += c.et;
    grand.stamp += c.stamp; grand.sebi += c.sebi; grand.ipf += c.ipf; grand.dmat += c.dmat;
  };

  // Consolidate opening/closing lots into ONE line per calendar date: summed qty,
  // exact summed amount (TURNOVER basis — charge-free, matching the PURCHASE rows and
  // the Holding tab), weighted-avg rate. Sorted by date. The amount is the true sum of
  // lot amounts (accurate to the decimal), not qty × rounded-rate, so it can't drift
  // when several fills share a date.
  const consolidateByDate = (lots: LotSnap[]): DateAgg[] => {
    const map = new Map<number, DateAgg>();
    for (const l of lots) {
      const amt = l.qty * turnoverPrice(l);
      const e = map.get(l.ts);
      if (e) { e.qty += l.qty; e.amount += amt; }
      else map.set(l.ts, { ts: l.ts, dateStr: l.dateStr, qty: l.qty, amount: amt, rate: 0 });
    }
    const arr = [...map.values()].sort((a, b) => a.ts - b.ts);
    for (const e of arr) e.rate = e.qty > 0 ? e.amount / e.qty : 0;
    return arr;
  };
  // one consolidated opening/closing row (cols C–F)
  const aggRow = (a: DateAgg, label?: string): any[] => {
    const row = blankRow();
    if (label) row[COL.name] = label;
    row[COL.oDate] = a.dateStr; row[COL.oQty] = a.qty;
    row[COL.oRate] = r6(a.rate); row[COL.oAmt] = r2(a.amount);
    return row;
  };
  // subtotal row across the consolidated dates: qty (D), weighted-avg rate (E), total (F)
  const aggSubtotal = (aggs: DateAgg[]): any[] => {
    const q = aggs.reduce((s, a) => s + a.qty, 0);
    const amt = aggs.reduce((s, a) => s + a.amount, 0);
    const row = blankRow();
    row[COL.oQty] = q; row[COL.oRate] = q > 0 ? r6(amt / q) : ""; row[COL.oAmt] = r2(amt);
    return row;
  };

  const closingRanges: { start: number; end: number }[] = [];   // row spans to shade green
  let sno = 0, buyRows = 0, sellRows = 0;
  for (const b of active) {
    sno++;
    // Opening consolidated date-wise (one row per date, not per lot).
    const openAgg = consolidateByDate(b.opening);
    // Header row carries S.No + name — and the FIRST opening date-line, as in the source.
    const head = blankRow(); head[COL.sno] = sno; head[COL.name] = b.name;
    if (openAgg.length) {
      const l0 = aggRow(openAgg[0]);
      for (let c = COL.oDate; c <= COL.oAmt; c++) head[c] = l0[c];
    }
    out.push(head);
    // Remaining opening date-lines. No subtotal row — the date-wise lines already
    // show the full opening position, so a summed total would be redundant.
    if (openAgg.length > 1) {
      for (const a of openAgg.slice(1)) out.push(aggRow(a));
    }

    // SPLIT lines — restated holding after each split (post-split qty, rescaled rate,
    // unchanged total cost), shown in the opening/holding columns with a "SPLIT" label.
    for (const sp of [...b.splits].sort((x, y) => x.ts - y.ts)) {
      const row = blankRow();
      row[COL.name] = "SPLIT";
      row[COL.oDate] = fmtDate(sp.ts); row[COL.oQty] = sp.qty;
      row[COL.oRate] = r6(sp.rate); row[COL.oAmt] = r2(sp.amount);
      out.push(row);
    }

    // PURCHASES (chronological)
    for (const p of [...b.purchases].sort((x, y) => x.ts - y.ts)) {
      buyRows++;
      const row = blankRow();
      row[COL.pDate] = fmtDate(p.ts); row[COL.pQty] = p.qty;
      row[COL.pRate] = r6(p.avgPrice); row[COL.pAmt] = r2(p.turnover);
      chargeCells(row, p.charges);
      out.push(row);
    }

    // SALES — one row per tax bucket per date; intra-day first, then short, then long.
    const catOrder = (c: "INTRA" | "ST" | "LT") => (c === "INTRA" ? 0 : c === "ST" ? 1 : 2);
    for (const s of [...b.sales].sort((x, y) => (x.ts - y.ts) || (catOrder(x.category) - catOrder(y.category)))) {
      sellRows++;
      const row = blankRow();
      row[COL.sDate] = fmtDate(s.ts); row[COL.sQty] = s.qty;
      row[COL.sRate] = r6(s.avgPrice); row[COL.sAmt] = r2(s.turnover);
      if (s.pnl) row[s.category === "INTRA" ? COL.intra : s.category === "ST" ? COL.st : COL.lt] = s.pnl;
      if (s.category === "INTRA") grandPnl.intra += s.pnl; else if (s.category === "ST") grandPnl.st += s.pnl; else grandPnl.lt += s.pnl;
      chargeCells(row, s.charges);
      out.push(row);
    }

    // Corporate-action notes
    for (const n of [...b.corpNotes].sort((x, y) => x.ts - y.ts)) {
      const row = blankRow(); row[COL.name] = n.text; out.push(row);
    }

    // CLOSING consolidated date-wise + subtotal (record the span so it shades green)
    const closeAgg = consolidateByDate(b.closing);
    const closeStart = out.length;
    if (closeAgg.length) {
      closeAgg.forEach((a, i) => out.push(aggRow(a, i === 0 ? "CLOSING" : undefined)));
      if (closeAgg.length > 1) out.push(aggSubtotal(closeAgg));
    } else {
      const row = blankRow(); row[COL.name] = "CLOSING"; row[COL.oAmt] = "NIL"; out.push(row);
    }
    closingRanges.push({ start: closeStart, end: out.length });

    out.push(blankRow());   // spacer between scrips
  }

  // GRAND TOTAL of P&L (per bucket) + charges
  const gt = blankRow(); gt[COL.name] = "GRAND TOTAL";
  gt[COL.intra] = r2(grandPnl.intra) || ""; gt[COL.st] = r2(grandPnl.st) || ""; gt[COL.lt] = r2(grandPnl.lt) || "";
  gt[COL.brok] = r2(grand.brok); gt[COL.stt] = r2(grand.stt); gt[COL.gst] = r2(grand.gst);
  gt[COL.et] = r2(grand.et); gt[COL.stamp] = r2(grand.stamp); gt[COL.sebi] = r2(grand.sebi);
  gt[COL.ipf] = r2(grand.ipf); gt[COL.dmat] = r2(grand.dmat);
  out.push(gt);

  // ── 6. Write the tab ──
  const tabName = `Capital Gains for ${fyLabel}`;
  // Older names for this same tab, migrated in place (same sheet, new title — stale
  // formatting is fully reset below) so users don't end up with duplicate tabs after
  // each rename: "FY.. Transaction Ledger" (previous) and "FY.. Trx" (original).
  const legacyTabs = [`${fyLabel} Transaction Ledger`, `${fyLabel} Trx`];
  let sheetId: number | undefined;
  {
    const meta: any = await withBackoff(() => (gapi.client as any).sheets.spreadsheets.get({
      spreadsheetId, fields: "sheets.properties(sheetId,title)",
    }));
    const props = (meta?.result?.sheets || []).map((s: any) => s.properties || {});
    const byTitle = (t: string) => props.find((p: any) => (p.title || "").toString().trim().toLowerCase() === t.trim().toLowerCase());
    const existing = byTitle(tabName), legacy = legacyTabs.map(byTitle).find(Boolean);
    if (existing) {
      sheetId = existing.sheetId;
    } else if (legacy) {
      await withBackoff(() => (gapi.client as any).sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: { requests: [{ updateSheetProperties: { properties: { sheetId: legacy.sheetId, title: tabName }, fields: "title" } }] },
      }));
      sheetId = legacy.sheetId;
    } else {
      await ensureSheetTabs(spreadsheetId, [tabName]);
      const meta2: any = await withBackoff(() => (gapi.client as any).sheets.spreadsheets.get({
        spreadsheetId, fields: "sheets.properties(sheetId,title)",
      }));
      sheetId = ((meta2?.result?.sheets || []).find((s: any) =>
        (s.properties?.title || "").toString().trim().toLowerCase() === tabName.trim().toLowerCase()) || {}).properties?.sheetId;
    }
  }
  await withBackoff(() => (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tabName}!A:Z` }));
  await withBackoff(() => (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId, range: `${tabName}!A1`, valueInputOption: "USER_ENTERED", resource: { values: out },
  }));

  // ── 7. Indian comma formatting + header styling (matches the source's look) ──
  // Cosmetic only — never let a formatting hiccup fail the whole generate. But a
  // SKIPPED repaint is worse than no paint: the previous run's bands sit misaligned
  // under the fresh values. So retry with backoff, and if it still fails, at least
  // strip the old paint so the sheet is plain rather than wrong.
  const WHITE = { red: 1, green: 1, blue: 1 };
  // values.clear() wipes cell values but NOT formatting — this reset is what stops a
  // prior generation's colour bands bleeding onto rows this run doesn't repaint.
  const resetRequest = {
    repeatCell: {
      range: { sheetId },
      cell: { userEnteredFormat: { backgroundColor: WHITE, textFormat: { bold: false } } },
      fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold",
    },
  };
  try {
    if (sheetId !== undefined && sheetId !== null) {
      const INR = "#,##,##0.00", INT = "#,##,##0";   // Indian lakh/crore grouping
      const RATE = "#,##,##0.00####";                // rate/cost-per-share: 2–6 dp (don't truncate the basis to paise)
      const numFmt = (startCol: number, endColExcl: number, pattern: string) => ({
        repeatCell: {
          range: { sheetId, startRowIndex: 3, startColumnIndex: startCol, endColumnIndex: endColExcl },
          cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern } } },
          fields: "userEnteredFormat.numberFormat",
        },
      });
      const requests: any[] = [
        // Reset FIRST; bands repaint on top, bold is re-applied to the header rows.
        resetRequest,
        numFmt(COL.oQty, COL.oQty + 1, INT),           // opening qty
        numFmt(COL.oRate, COL.oRate + 1, RATE),        // opening rate (full precision)
        numFmt(COL.oAmt, COL.oAmt + 1, INR),           // opening amount
        numFmt(COL.pQty, COL.pQty + 1, INT),           // purchase qty
        numFmt(COL.pRate, COL.pRate + 1, RATE),        // purchase rate (full precision)
        numFmt(COL.pAmt, COL.pAmt + 1, INR),           // purchase amount
        numFmt(COL.sQty, COL.sQty + 1, INT),           // sales qty
        numFmt(COL.sRate, COL.sRate + 1, RATE),        // sales rate (full precision)
        numFmt(COL.sAmt, COL.ipf + 1, INR),            // sales amount + P/L + all charges
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 3 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold",
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 3 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
      ];

      // Background colour bands matching the accountant's sheet.
      const rgb = (r: number, g: number, b: number) => ({ red: r, green: g, blue: b });
      const fill = (r0: number, r1: number, c0: number, c1: number, color: any) => ({
        repeatCell: {
          range: { sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 },
          cell: { userEnteredFormat: { backgroundColor: color } },
          fields: "userEnteredFormat.backgroundColor",
        },
      });
      const GREEN = rgb(0.298, 0.686, 0.314), ORANGE = rgb(0.93, 0.60, 0.25),
        SALMON = rgb(0.96, 0.60, 0.51), LIME = rgb(0.61, 0.80, 0.40);
      const dataEnd = out.length;
      requests.push(
        fill(1, 3, COL.sno, COL.oDate, GREEN),     // S.No + Script Name band (rows 2–3)
        fill(1, 3, COL.oDate, COL.pDate, ORANGE),  // OPENING STOCK band
        fill(1, 3, COL.pDate, COL.sDate, GREEN),   // PURCHASE band
        fill(1, 3, COL.sDate, COL.intra, SALMON),  // SALES band
        fill(1, 3, COL.intra, COL.brok, GREEN),    // Intra-Day/Short/Long-term P/L header band
        fill(1, 3, COL.brok, WIDTH, GREEN),        // charge-column header band (Brok…IPF)
        fill(3, dataEnd, COL.intra, COL.brok, LIME),  // P/L columns shaded down the data
      );
      for (const cr of closingRanges) requests.push(fill(cr.start, cr.end, COL.name, COL.pDate, LIME));   // CLOSING rows (B–F)

      await withBackoff(() => (gapi.client as any).sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } }));
    }
  } catch (e) {
    console.warn("Transaction Ledger formatting failed — stripping old paint so stale bands don't mislead:", e);
    try {
      await (gapi.client as any).sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests: [resetRequest] } });
    } catch { /* values are correct; formatting can be regenerated on the next run */ }
  }

  // ── 8. FY-end holding snapshot tab: "Holding as on 31st March <fyEnd>" ──
  // A standalone closing-stock statement — every scrip's lots still held at FY-end (the
  // FIFO state frozen above), with pro-rated buy charges and an all-in "final amount",
  // in the accountant's CSV layout. Built from block.closing. The live "Holding" tab
  // (current holding, refreshed on every import) is separate and untouched.
  const fyEndYear = fyStartYear + 1;
  const holdingTabName = `Holding as on 31st March ${fyEndYear}`;
  try {
    const HW = 15;
    const hRow = (): any[] => new Array(HW).fill("");
    const HC = { sno: 0, name: 1, date: 2, qty: 3, rate: 4, amt: 5, brok: 6, stt: 7, et: 8, sebi: 9, ecc: 10, stamp: 11, ipf: 12, gst: 13, final: 14 };
    interface HAgg { ts: number; dateStr: string; qty: number; amt: number; ch: Charges; }
    const consolidate = (snaps: LotSnap[]): HAgg[] => {   // one line per calendar date
      const m = new Map<number, HAgg>();
      for (const l of snaps) {
        // Closing amount uses the SAME basis as the Capital Gains tab's CLOSING
        // (consolidateByDate → turnoverPrice), so the two tabs reconcile to the rupee.
        const amt = l.qty * turnoverPrice(l);
        const e = m.get(l.ts);
        if (e) { e.qty += l.qty; e.amt += amt; e.ch = addCharges(e.ch, l.charges); }
        else m.set(l.ts, { ts: l.ts, dateStr: l.dateStr, qty: l.qty, amt, ch: { ...l.charges } });
      }
      return [...m.values()].sort((a, b) => a.ts - b.ts);
    };
    // "final amount" = closing amount + ALL expenses EXCEPT STT (STT is not part of the
    // cost basis for capital gains). STT still shows in its own column, just not in final.
    const exclSTT = (c: Charges) => c.brok + c.gst + c.et + c.stamp + c.sebi + c.ipf + c.dmat;
    const chCells = (row: any[], c: Charges) => {   // blank a zero charge (matches the source)
      row[HC.brok] = c.brok ? r2(c.brok) : ""; row[HC.stt] = c.stt ? r2(c.stt) : "";
      row[HC.et] = c.et ? r2(c.et) : ""; row[HC.sebi] = c.sebi ? r2(c.sebi) : "";
      row[HC.ecc] = ""; row[HC.stamp] = c.stamp ? r2(c.stamp) : "";
      row[HC.ipf] = c.ipf ? r2(c.ipf) : ""; row[HC.gst] = c.gst ? r2(c.gst) : "";
    };

    const hout: any[][] = [];
    const t0 = hRow(); t0[HC.name] = `${title ? title + " — " : ""}Holding as on 31st March ${fyEndYear}`; hout.push(t0);
    const t1 = hRow(); t1[HC.date] = `CLOSING STOCK-31.03.${fyEndYear}`; hout.push(t1);
    hout.push(["S.No", "SCRIPT NAME", "DATE", "NO OF SHARE", "RATE", "AMOUNT", "Total Brokerage", "STT", "ETC", "SEBI Turnover Fees", "ECC", "Stamp Duty", "IPF", "GST", "final amount"]);

    // ALL held scrips (incl. opening-only, untraded-in-FY) — a holding statement, not the
    // in-FY-activity filter the Capital Gains tab uses.
    const held = [...blocks.values()].filter(b => b.closing.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    let hsno = 0;
    const gTot = { amt: 0, ch: { ...ZERO_CHARGES } };
    const blockRanges: { start: number; end: number }[] = [];   // green A:F band per scrip (excl. spacer)
    for (const b of held) {
      hsno++;
      const aggs = consolidate(b.closing);
      const bStart = hout.length;
      const head = hRow(); head[HC.sno] = hsno; head[HC.name] = b.name; hout.push(head);   // scrip name on its own row
      aggs.forEach((a, i) => {
        const row = hRow();
        if (i === 0) row[HC.name] = "CLOSING";   // first held-lot row carries the CLOSING label
        row[HC.date] = a.dateStr; row[HC.qty] = a.qty;
        row[HC.rate] = a.qty > 0 ? r6(a.amt / a.qty) : ""; row[HC.amt] = r2(a.amt);
        chCells(row, a.ch); row[HC.final] = r2(a.amt + exclSTT(a.ch));
        gTot.amt += a.amt; gTot.ch = addCharges(gTot.ch, a.ch);
        hout.push(row);
      });
      if (aggs.length > 1) {   // per-scrip subtotal (qty · amount · final)
        const sub = hRow();
        sub[HC.qty] = aggs.reduce((s, a) => s + a.qty, 0);
        sub[HC.amt] = r2(aggs.reduce((s, a) => s + a.amt, 0));
        sub[HC.final] = r2(aggs.reduce((s, a) => s + a.amt + exclSTT(a.ch), 0));
        hout.push(sub);
      }
      blockRanges.push({ start: bStart, end: hout.length });   // name row → subtotal (before the spacer)
      hout.push(hRow());   // spacer between scrips
    }
    const gtRow = hout.length;
    const gt = hRow();
    gt[HC.name] = "TOTAL HOLDINGS WITHOUT EXPENSES";
    gt[HC.amt] = r2(gTot.amt); chCells(gt, gTot.ch); gt[HC.final] = r2(gTot.amt + exclSTT(gTot.ch));
    hout.push(gt);

    // Write values (resolve the tab's sheetId first, for the formatting pass below).
    await ensureSheetTabs(spreadsheetId, [holdingTabName]);
    let hSheetId: number | undefined;
    {
      const meta: any = await withBackoff(() => (gapi.client as any).sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" }));
      hSheetId = ((meta?.result?.sheets || []).find((s: any) => (s.properties?.title || "").toString().trim().toLowerCase() === holdingTabName.trim().toLowerCase()) || {}).properties?.sheetId;
    }
    await withBackoff(() => (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${holdingTabName}!A:Z` }));
    await withBackoff(() => (gapi.client as any).sheets.spreadsheets.values.update({
      spreadsheetId, range: `${holdingTabName}!A1`, valueInputOption: "USER_ENTERED", resource: { values: hout },
    }));

    // ── formatting: yellow title/total, green name+holding blocks, orange CLOSING-STOCK band,
    // cream charge-header band, Indian comma number formats. Reset first so stale bands don't
    // bleed (same guard as the Capital Gains tab). Cosmetic — never fails the write.
    if (hSheetId !== undefined && hSheetId !== null) {
      try {
        const rgb = (r: number, g: number, b: number) => ({ red: r, green: g, blue: b });
        const YELLOW = rgb(1, 0.92, 0.15), GREEN = rgb(0.298, 0.686, 0.314), ORANGE = rgb(0.93, 0.60, 0.25), CREAM = rgb(1, 0.949, 0.8), WHT = rgb(1, 1, 1);
        const INR = "#,##,##0.00", INT = "#,##,##0", RATEP = "#,##,##0.00####";
        const fill = (r0: number, r1: number, c0: number, c1: number, color: any) => ({
          repeatCell: { range: { sheetId: hSheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 }, cell: { userEnteredFormat: { backgroundColor: color } }, fields: "userEnteredFormat.backgroundColor" },
        });
        const numFmt = (c0: number, c1: number, pattern: string) => ({
          repeatCell: { range: { sheetId: hSheetId, startRowIndex: 3, startColumnIndex: c0, endColumnIndex: c1 }, cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern } } }, fields: "userEnteredFormat.numberFormat" },
        });
        const bold = (r0: number, r1: number) => ({
          repeatCell: { range: { sheetId: hSheetId, startRowIndex: r0, endRowIndex: r1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" },
        });
        const requests: any[] = [
          { repeatCell: { range: { sheetId: hSheetId }, cell: { userEnteredFormat: { backgroundColor: WHT, textFormat: { bold: false } } }, fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold" } },
          numFmt(HC.qty, HC.qty + 1, INT),
          numFmt(HC.rate, HC.rate + 1, RATEP),
          numFmt(HC.amt, HW, INR),   // amount + charges + final amount
          bold(0, 3), bold(gtRow, gtRow + 1),
          { updateSheetProperties: { properties: { sheetId: hSheetId, gridProperties: { frozenRowCount: 3 } }, fields: "gridProperties.frozenRowCount" } },
          fill(0, 1, 0, HW, YELLOW),                 // title row (SAGUN CAPITAL / Holding as on…)
          fill(1, 3, HC.sno, HC.date, GREEN),        // S.No + SCRIPT NAME band
          fill(1, 2, HC.date, HC.brok, ORANGE),      // CLOSING STOCK-31.03.YYYY band (row 1: DATE→AMOUNT)
          fill(2, 3, HC.date, HC.brok, GREEN),       // column headers DATE→AMOUNT (row 2)
          fill(1, 3, HC.brok, HW, CREAM),            // charge-column header band
          fill(gtRow, gtRow + 1, 0, HC.brok, YELLOW),// TOTAL HOLDINGS row (label + amount)
        ];
        for (const r of blockRanges) requests.push(fill(r.start, r.end, HC.sno, HC.brok, GREEN));   // each scrip's holding block, A→F
        await withBackoff(() => (gapi.client as any).sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } }));
      } catch (fmtErr) {
        console.warn(`"${holdingTabName}" values written; formatting skipped:`, fmtErr);
      }
    }
  } catch (e) {
    console.warn(`Failed to write the "${holdingTabName}" tab (the Capital Gains tab is unaffected):`, e);
  }

  return {
    tabName, holdingTabName, fyLabel,
    scrips: active.length, buyRows, sellRows,
    unresolved: [...unresolvedMap.values()], master,
  };
}
