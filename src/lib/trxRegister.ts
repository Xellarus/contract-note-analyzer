import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import {
  normName, loadScripMaster, resolveScrip, ScripMaster,
  SCRIP_MASTER_SPREADSHEET_ID,
} from "./scripMaster";
import { loadCorporateActions } from "./corporateActions";
import { UnresolvedScrip } from "./holdingsCalc";

/**
 * Financial-year, scrip-wise TRANSACTION REGISTER — a replica of the accountant's
 * annual ledger format (opening stock → purchases → sales → closing stock, per
 * security, with LTCG/STCG split and a per-transaction charge breakdown).
 *
 * Computed purely from `True Entry` (entry-only, like the other engines). A single
 * chronological FIFO replay does double duty:
 *   • splits every FY SALE into LTCG / STCG parcels  → **turnover** cost basis
 *     (same convention as syncCapitalGains / the LTST tab), and
 *   • snapshots the remaining dated lots at the FY boundaries for the OPENING and
 *     CLOSING blocks → **all-in Incl-STT** valuation (same as the Holding tab).
 * Corporate actions (Merger / Demerger from the Corporate Actions tab) are
 * interleaved by date so lot cost + acquisition dates are right at each event.
 *
 * v1 scope = DELIVERY equity only. Intraday-tagged rows are excluded (F&O and
 * intraday P&L are separate sections in the source, deferred). Dmat and
 * Exchange-Clearing charge columns aren't captured in the ledger (nil in the
 * source too) and are left blank.
 */

// ── small local helpers (mirror holdingsCalc's date/number handling) ──
const toNum = (s: any): number => {
  const v = parseFloat((s ?? "").toString().replace(/,/g, "").trim());
  return isNaN(v) ? NaN : v;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

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
  lt: 14, st: 15,
  brok: 16, stt: 17, gst: 18, et: 19, dmat: 20, stamp: 21, sebi: 22, exchClg: 23, ipf: 24,
};
const WIDTH = 25;
const blankRow = (): any[] => new Array(WIDTH).fill("");

// ── charge bundle per trade (register order; exchClg not captured) ──
interface Charges { brok: number; stt: number; gst: number; et: number; stamp: number; sebi: number; ipf: number; dmat: number; }
const ZERO_CHARGES: Charges = { brok: 0, stt: 0, gst: 0, et: 0, stamp: 0, sebi: 0, ipf: 0, dmat: 0 };

interface Trade {
  ts: number; idx: number; key: string; name: string; isin: string;
  type: "BUY" | "SELL";
  qty: number; avgPrice: number; turnover: number; inclSTT: number;
  charges: Charges;
}

// A dated cost lot. purPrice = turnover/qty (capital-gains basis); inclPrice =
// Incl-STT/qty (holding-valuation basis for opening/closing).
interface Lot { buyTs: number; qty: number; remaining: number; purPrice: number; inclPrice: number; }
interface LotSnap { ts: number; dateStr: string; qty: number; inclPrice: number; }
// One consolidated opening/closing line per calendar date (weighted-avg rate,
// exact summed amount — the source shows opening/closing date-wise, not lot-wise).
interface DateAgg { ts: number; dateStr: string; qty: number; amount: number; rate: number; }

interface CorpNote { ts: number; text: string; }

// Per-scrip accumulated block.
interface Block {
  key: string; name: string;
  purchases: { ts: number; qty: number; avgPrice: number; turnover: number; charges: Charges }[];
  sales: { ts: number; qty: number; avgPrice: number; turnover: number; charges: Charges; lt: number; st: number }[];
  corpNotes: CorpNote[];
  opening: LotSnap[];
  closing: LotSnap[];
  firstTs: number;
}

export interface TrxRegisterResult {
  tabName: string;
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
  for (let i = 1; i < teRows.length; i++) {
    const r = teRows[i];
    if (!r || r.length === 0) continue;
    const type = (r[typeIdx] || "").toString().trim().toUpperCase();
    if (type !== "BUY" && type !== "SELL") continue;
    const name = (r[nameIdx] || "").toString().trim();
    const qty = toNum(r[qtyIdx]);
    if (!name || isNaN(qty) || qty <= 0) continue;
    const tradeClass = (classIdx >= 0 ? (r[classIdx] || "").toString() : "").toLowerCase();
    if (tradeClass.includes("intraday")) continue;   // delivery-only (v1)
    const isin = isinIdx >= 0 ? (r[isinIdx] || "").toString().trim() : "";
    const avgPrice = toNum(r[priceIdx]) || 0;
    const turnover = toNum(r[turnoverIdx]) || 0;
    const inclSTT = inclIdx >= 0 ? (toNum(r[inclIdx]) || 0) : 0;
    trades.push({
      ts: parseDateTs(r[dateIdx]), idx: i, key: keyOf(isin, name), name, isin,
      type: type as "BUY" | "SELL", qty, avgPrice, turnover, inclSTT,
      charges: {
        brok: num(r, brokIdx), stt: num(r, sttIdx), gst: num(r, gstIdx), et: num(r, etIdx),
        stamp: num(r, stampIdx), sebi: num(r, sebiIdx), ipf: num(r, ipfIdx), dmat: num(r, dmatIdx),
      },
    });
  }
  if (trades.length === 0) throw new Error("True Entry has no parseable delivery Buy/Sell rows.");

  // Longest name seen per key (usually the full official name over a short code).
  const nameByKey = new Map<string, string>();
  for (const t of trades) {
    const cur = nameByKey.get(t.key);
    if (!cur || t.name.length > cur.length) nameByKey.set(t.key, t.name);
  }

  // ── 3. Corporate actions (Merger / Demerger) as dated events ──
  const corpActions = await loadCorporateActions(spreadsheetId);

  // ── 4. Single chronological replay: buys add lots, CAs transform, sells consume ──
  type Ev =
    | { ts: number; ord: number; idx: number; kind: "trade"; trade: Trade }
    | { ts: number; ord: number; idx: number; kind: "ca"; fromKey: string; toKey: string; caType: "Merger" | "Demerger"; sharesIn: number; cost: number; from: string; to: string };
  const events: Ev[] = [];
  for (const t of trades) events.push({ ts: t.ts, ord: t.type === "BUY" ? 0 : 2, idx: t.idx, kind: "trade", trade: t });
  for (const ca of corpActions) {
    const caTs = parseDateTs(ca.dateStr);
    if (!caTs) {   // undateable action can't be placed in the timeline — skip rather than stamp an epoch-0 lot (which would force LTCG)
      console.warn(`Trx register: skipping corporate action with unparseable date "${ca.dateStr}" (${ca.type} ${ca.from} → ${ca.to}).`);
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
      b = { key, name: nameByKey.get(key) || key, purchases: [], sales: [], corpNotes: [], opening: [], closing: [], firstTs: Infinity };
      blocks.set(key, b);
    }
    return b;
  };
  const touch = (key: string, ts: number) => { const b = block(key); if (ts && ts < b.firstTs) b.firstTs = ts; };

  const snapshot = (key: string): LotSnap[] =>
    (fifo.get(key) || []).filter(l => l.remaining > 1e-9)
      .map(l => ({ ts: l.buyTs, dateStr: fmtDate(l.buyTs), qty: l.remaining, inclPrice: l.inclPrice }));
  const snapshotAll = (): Map<string, LotSnap[]> => {
    const m = new Map<string, LotSnap[]>();
    for (const key of fifo.keys()) { const s = snapshot(key); if (s.length) m.set(key, s); }
    return m;
  };

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
        arr.push({ buyTs: ev.ts, qty: ev.sharesIn, remaining: ev.sharesIn, purPrice: per, inclPrice: per });
        fifo.set(ev.toKey, arr);
      }
      if (inFY) {
        touch(ev.fromKey, ev.ts); touch(ev.toKey, ev.ts);
        block(ev.toKey).corpNotes.push({ ts: ev.ts, text: `${ev.caType.toUpperCase()} from ${ev.from} (${fmtDate(ev.ts)})` });
        block(ev.fromKey).corpNotes.push({ ts: ev.ts, text: `${ev.caType.toUpperCase()} → ${ev.to} (${fmtDate(ev.ts)})` });
      }
      continue;
    }

    const t = ev.trade;
    if (t.type === "BUY") {
      const purPrice = t.qty > 0 && t.turnover > 0 ? t.turnover / t.qty : t.avgPrice;
      const inclPrice = t.qty > 0 && t.inclSTT > 0 ? t.inclSTT / t.qty : purPrice;
      const arr = fifo.get(t.key) || [];
      arr.push({ buyTs: t.ts, qty: t.qty, remaining: t.qty, purPrice, inclPrice });
      fifo.set(t.key, arr);
      if (inFY) {
        touch(t.key, t.ts);
        block(t.key).purchases.push({ ts: t.ts, qty: t.qty, avgPrice: t.avgPrice, turnover: t.turnover, charges: t.charges });
      }
    } else {
      // SELL — FIFO-consume; classify each parcel LT/ST by holding days ≥ 365 (turnover basis)
      const lots = fifo.get(t.key) || [];
      const salePrice = t.qty > 0 && t.turnover > 0 ? t.turnover / t.qty : t.avgPrice;
      let left = t.qty, lt = 0, st = 0;
      for (const l of lots) {
        if (left <= 1e-9) break;
        if (l.remaining <= 1e-9) continue;
        const m = Math.min(l.remaining, left);
        const gain = r2(m * salePrice) - r2(m * l.purPrice);
        if (daysBetween(l.buyTs, t.ts) >= 365) lt += gain; else st += gain;
        l.remaining -= m; left -= m;
      }
      if (inFY) {
        touch(t.key, t.ts);
        block(t.key).sales.push({ ts: t.ts, qty: t.qty, avgPrice: t.avgPrice, turnover: t.turnover, charges: t.charges, lt: r2(lt), st: r2(st) });
      }
    }
  }
  if (opening === null) opening = snapshotAll();   // no FY events (all pre-FY) → opening = current lots
  const closing = snapshotAll();

  // Attach opening/closing snapshots to their blocks (create a block if a scrip is
  // held across the FY with no in-FY activity so it still shows up).
  for (const [key, snaps] of opening) { block(key).opening = snaps; touch(key, fyStartTs); }
  for (const [key, snaps] of closing) { block(key).closing = snaps; touch(key, fyStartTs); }

  // ── 5. Emit rows ──
  const active = [...blocks.values()]
    .filter(b => b.opening.length || b.closing.length || b.purchases.length || b.sales.length)
    .sort((a, b) => (a.firstTs - b.firstTs) || a.name.localeCompare(b.name));

  const out: any[][] = [];
  // title + group header + column header
  const titleRow = blankRow(); titleRow[COL.name] = `${title ? title + " — " : ""}Transaction Register ${fyLabel}`; out.push(titleRow);
  const grp = blankRow();
  grp[COL.oDate] = "OPENING STOCK"; grp[COL.pDate] = "PURCHASE"; grp[COL.sDate] = "SALES";
  grp[COL.lt] = "Long term"; grp[COL.st] = "Short term"; out.push(grp);
  out.push([
    "S.No", "SCRIPT NAME", "DATE", "NO OF SHARE", "RATE", "AMOUNT",
    "DATE", "NO OF SHARE", "RATE", "AMOUNT", "DATE", "NO OF SHARE", "RATE", "AMOUNT",
    "P/L", "P/L", "Brok.Total", "STT", "GST", "ET Charges", "Dmat", "Stamp duty", "SEBI Chg.", "EXCH.Clg.", "IPF",
  ]);

  const grand: Charges = { ...ZERO_CHARGES };
  const chargeCells = (row: any[], c: Charges) => {
    row[COL.brok] = c.brok || ""; row[COL.stt] = c.stt || ""; row[COL.gst] = c.gst || "";
    row[COL.et] = c.et || ""; row[COL.stamp] = c.stamp || ""; row[COL.sebi] = c.sebi || "";
    row[COL.ipf] = c.ipf || ""; row[COL.dmat] = c.dmat || "";
    grand.brok += c.brok; grand.stt += c.stt; grand.gst += c.gst; grand.et += c.et;
    grand.stamp += c.stamp; grand.sebi += c.sebi; grand.ipf += c.ipf; grand.dmat += c.dmat;
  };

  // Consolidate opening/closing lots into ONE line per calendar date: summed qty,
  // exact summed amount (Incl-STT basis), weighted-avg rate. Sorted by date. The
  // amount is the true sum of lot amounts (accurate to the decimal), not qty ×
  // rounded-rate, so it can't drift when several fills share a date.
  const consolidateByDate = (lots: LotSnap[]): DateAgg[] => {
    const map = new Map<number, DateAgg>();
    for (const l of lots) {
      const amt = l.qty * l.inclPrice;
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
    row[COL.oRate] = r4(a.rate); row[COL.oAmt] = r2(a.amount);
    return row;
  };
  // subtotal row across the consolidated dates: qty (D), weighted-avg rate (E), total (F)
  const aggSubtotal = (aggs: DateAgg[]): any[] => {
    const q = aggs.reduce((s, a) => s + a.qty, 0);
    const amt = aggs.reduce((s, a) => s + a.amount, 0);
    const row = blankRow();
    row[COL.oQty] = q; row[COL.oRate] = q > 0 ? r4(amt / q) : ""; row[COL.oAmt] = r2(amt);
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
    // Remaining opening dates + a subtotal (only when the position spans >1 date)
    if (openAgg.length > 1) {
      for (const a of openAgg.slice(1)) out.push(aggRow(a));
      out.push(aggSubtotal(openAgg));
    }

    // PURCHASES (chronological)
    for (const p of [...b.purchases].sort((x, y) => x.ts - y.ts)) {
      buyRows++;
      const row = blankRow();
      row[COL.pDate] = fmtDate(p.ts); row[COL.pQty] = p.qty;
      row[COL.pRate] = r4(p.avgPrice); row[COL.pAmt] = r2(p.turnover);
      chargeCells(row, p.charges);
      out.push(row);
    }

    // SALES (chronological) + LT/ST P/L
    for (const s of [...b.sales].sort((x, y) => x.ts - y.ts)) {
      sellRows++;
      const row = blankRow();
      row[COL.sDate] = fmtDate(s.ts); row[COL.sQty] = s.qty;
      row[COL.sRate] = r4(s.avgPrice); row[COL.sAmt] = r2(s.turnover);
      if (s.lt) row[COL.lt] = s.lt;
      if (s.st) row[COL.st] = s.st;
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

  // GRAND TOTAL of charges
  const gt = blankRow(); gt[COL.name] = "GRAND TOTAL";
  gt[COL.brok] = r2(grand.brok); gt[COL.stt] = r2(grand.stt); gt[COL.gst] = r2(grand.gst);
  gt[COL.et] = r2(grand.et); gt[COL.stamp] = r2(grand.stamp); gt[COL.sebi] = r2(grand.sebi);
  gt[COL.ipf] = r2(grand.ipf); gt[COL.dmat] = r2(grand.dmat);
  out.push(gt);

  // ── 6. Write the tab ──
  const tabName = `${fyLabel} Trx`;
  await ensureSheetTabs(spreadsheetId, [tabName]);
  await (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tabName}!A:Z` });
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId, range: `${tabName}!A1`, valueInputOption: "USER_ENTERED", resource: { values: out },
  });

  // ── 7. Indian comma formatting + header styling (matches the source's look) ──
  // Cosmetic only — never let a formatting hiccup fail the whole generate.
  try {
    const meta = await (gapi.client as any).sheets.spreadsheets.get({
      spreadsheetId, fields: "sheets.properties(sheetId,title)",
    });
    const sheet = (meta?.result?.sheets || []).find((s: any) => (s.properties?.title || "").toString().trim().toLowerCase() === tabName.trim().toLowerCase());
    const sheetId = sheet?.properties?.sheetId;
    if (sheetId !== undefined && sheetId !== null) {
      const INR = "#,##,##0.00", INT = "#,##,##0";   // Indian lakh/crore grouping
      const numFmt = (startCol: number, endColExcl: number, pattern: string) => ({
        repeatCell: {
          range: { sheetId, startRowIndex: 3, startColumnIndex: startCol, endColumnIndex: endColExcl },
          cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern } } },
          fields: "userEnteredFormat.numberFormat",
        },
      });
      const WHITE = { red: 1, green: 1, blue: 1 };
      const requests: any[] = [
        // Reset the ENTIRE sheet's fill + bold FIRST — values.clear() wipes cell
        // values but NOT formatting, so a prior generation's green bands would
        // otherwise bleed onto rows this run doesn't repaint. Bands below repaint
        // on top; bold is re-applied to the header rows afterwards.
        {
          repeatCell: {
            range: { sheetId },
            cell: { userEnteredFormat: { backgroundColor: WHITE, textFormat: { bold: false } } },
            fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold",
          },
        },
        numFmt(COL.oQty, COL.oQty + 1, INT),           // opening qty
        numFmt(COL.oRate, COL.oAmt + 1, INR),          // opening rate + amount
        numFmt(COL.pQty, COL.pQty + 1, INT),           // purchase qty
        numFmt(COL.pRate, COL.pAmt + 1, INR),          // purchase rate + amount
        numFmt(COL.sQty, COL.sQty + 1, INT),           // sales qty
        numFmt(COL.sRate, COL.ipf + 1, INR),           // sales rate/amount + P/L + all charges
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
        fill(1, 3, COL.sDate, COL.lt, SALMON),     // SALES band
        fill(1, 3, COL.lt, COL.brok, GREEN),       // Long/Short-term P/L header band
        fill(1, 3, COL.brok, WIDTH, GREEN),        // charge-column header band (Brok…IPF)
        fill(3, dataEnd, COL.lt, COL.brok, LIME),  // P/L columns shaded down the data
      );
      for (const cr of closingRanges) requests.push(fill(cr.start, cr.end, COL.name, COL.pDate, LIME));   // CLOSING rows (B–F)

      await (gapi.client as any).sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } });
    }
  } catch (e) {
    console.warn("Trx register formatting skipped (values written OK):", e);
  }

  return {
    tabName, fyLabel,
    scrips: active.length, buyRows, sellRows,
    unresolved: [...unresolvedMap.values()], master,
  };
}
