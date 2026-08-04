import { accumulateOpeningLots, classifyTxn, obKey, OpeningLot, TxnStatementRow } from "./openingBasis";
import { loadOpeningHoldings, saveOpeningHoldings, OpeningSeedLot } from "./openingHoldings";
import { loadOpeningTxns, saveOpeningTxns } from "./openingTxns";
import { rebuildHoldingTab, syncCapitalGains } from "./holdingsCalc";

/**
 * Per-stock opening-basis import (temporary tool, user 2026-08-04).
 *
 * On a stock's detail page you upload that stock's broker transaction statement (a single-
 * security CSV: Type, Date, Quantity, Price, …). It REPLACES that stock's pre-FY26 opening
 * basis for the current account:
 *   • only rows dated ≤ 31-Mar-2025 are used (FY26 True Entry is left untouched),
 *   • brokerage / amount columns are ignored — cost basis is the raw Price,
 *   • same-day buys/sells are squared off (the app's intraday convention) before a FIFO
 *     replay reconstructs the surviving dated lots (via the shared openingBasis engine),
 *   • the reconstructed lots overwrite this stock's rows in "Opening Holdings" (the FY26 FIFO
 *     seed) and the raw rows overwrite its rows in "Opening Txns" (the historical report),
 *   • Holding + Capital Gains are rebuilt.
 *
 * The CSV has NO security-name column — the stock is the page context, so its canonical name
 * (and ISIN) are injected by the caller. Other stocks in the account are never touched.
 */

export const OPENING_CUTOFF_ISO = "2025-03-31";
// 31-Mar-2025 local midnight — a trade must be ON/BEFORE this to feed the opening basis.
const CUTOFF_TS = new Date(2025, 2, 31).getTime();

// Quote-aware CSV splitter for a given delimiter (comma / semicolon / tab / pipe — some
// broker/Excel exports aren't comma-separated).
function splitCsv(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const DELIMITERS = [",", ";", "\t", "|"];

const hkey = (s: string) => (s || "").toUpperCase().replace(/[^A-Z]/g, "");
const num = (s: any): number => { const v = parseFloat((s ?? "").toString().replace(/,/g, "").trim()); return isNaN(v) ? 0 : v; };

// "2026-07-01 09:00:00" | "2026-07-01" | "01-07-2026" | "01/07/2026" → { iso, ts } (time dropped).
function parseCsvDate(s: string): { iso: string; ts: number } {
  const c = (s || "").trim().split(/[ T]/)[0];
  let m = c.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { const y = +m[1], mo = +m[2], d = +m[3]; return { iso: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, ts: new Date(y, mo - 1, d).getTime() }; }
  m = c.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) { const d = +m[1], mo = +m[2], y = +m[3]; return { iso: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, ts: new Date(y, mo - 1, d).getTime() }; }
  return { iso: c, ts: 0 };
}

export interface ParsedStockCsv {
  txns: TxnStatementRow[];   // raw rows, ≤ cutoff, name injected (for Opening Txns)
  kept: number;
  dropped: number;           // rows after the cutoff (or undated) — excluded
  total: number;
  error?: string;
}

/**
 * Parse a single-stock transaction CSV. Header-driven (needs Type + Date + Quantity + Price;
 * Total-quantity is captured as the running balance if present). Injects `stockName` (the CSV
 * has no name column). Keeps only rows dated ≤ 31-Mar-2025; brokerage/amount are ignored.
 */
export function parseSingleStockTxnCsv(text: string, stockName: string): ParsedStockCsv {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);
  if (!lines.length) return { txns: [], kept: 0, dropped: 0, total: 0, error: "The file is empty." };

  // Try each delimiter until the header row resolves (some exports are ; or tab separated).
  let hi = -1, delim = ",";
  let ci: { type: number; date: number; qty: number; price: number; bal: number } | null = null;
  outer:
  for (const d of DELIMITERS) {
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      const cells = splitCsv(lines[i], d).map(hkey);
      const find = (...k: string[]) => cells.findIndex(c => k.includes(c));
      const type = find("TYPE", "TRANSTYPE", "TRANSACTIONTYPE", "TXNTYPE");
      const date = find("DATE", "TRADEDATE", "TRANSDATE");
      const qty = find("QUANTITY", "QTY", "SHARES");
      const price = find("PRICE", "RATE");
      if (type >= 0 && date >= 0 && qty >= 0 && price >= 0) {
        hi = i; delim = d;
        ci = { type, date, qty, price, bal: find("TOTALQUANTITY", "BALQTY", "BALANCE", "CLOSINGQTY") };
        break outer;
      }
    }
  }
  if (!ci) return { txns: [], kept: 0, dropped: 0, total: 0, error: `Couldn't find Type / Date / Quantity / Price columns. First line read as: "${(lines[0] || "").slice(0, 120)}"` };

  const txns: TxnStatementRow[] = [];
  let total = 0, dropped = 0;
  for (let i = hi + 1; i < lines.length; i++) {
    const f = splitCsv(lines[i], delim);
    const type = (f[ci.type] || "").trim();
    if (!type) continue;
    total++;
    const { iso, ts } = parseCsvDate(f[ci.date] || "");
    if (ts <= 0 || ts > CUTOFF_TS) { dropped++; continue; }   // after 31-Mar-2025 (or unparseable) → excluded
    txns.push({
      dateStr: (f[ci.date] || "").trim(), iso, ts,
      type: type.toUpperCase(), name: stockName,
      qty: num(f[ci.qty]), price: num(f[ci.price]),
      amount: 0,                                        // brokerage ignored → cost basis is Price
      balQty: ci.bal >= 0 ? num(f[ci.bal]) : 0,
    });
  }
  return { txns, kept: txns.length, dropped, total };
}

// Net each day's buys against its sells (the app's intraday square-off) → one BUY or SELL per
// day, so the FIFO replay leaves the correct surviving lots (a same-day round-trip must not
// bury an old cheap lot). Net-buy price is that day's quantity-weighted average buy price.
function squareOffDaily(txns: TxnStatementRow[], stockName: string): TxnStatementRow[] {
  const byDay = new Map<string, { ts: number; buyQty: number; buyVal: number; sellQty: number }>();
  for (const t of txns) {
    const kind = classifyTxn(t.type);
    if (kind !== "BUY" && kind !== "SELL") continue;   // this statement is buys/sells only
    const d = byDay.get(t.iso) || { ts: t.ts, buyQty: 0, buyVal: 0, sellQty: 0 };
    if (kind === "BUY") { d.buyQty += t.qty; d.buyVal += t.qty * t.price; }
    else d.sellQty += Math.abs(t.qty);
    byDay.set(t.iso, d);
  }
  const out: TxnStatementRow[] = [];
  for (const [iso, d] of byDay) {
    const net = d.buyQty - d.sellQty;
    if (Math.abs(net) < 1e-9) continue;   // fully squared off intraday
    if (net > 0) out.push({ dateStr: iso, iso, ts: d.ts, type: "BUY", name: stockName, qty: net, price: d.buyQty > 0 ? d.buyVal / d.buyQty : 0, amount: 0, balQty: 0 });
    else out.push({ dateStr: iso, iso, ts: d.ts, type: "SELL", name: stockName, qty: -net, price: 0, amount: 0, balQty: 0 });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export interface OpeningReconstruction {
  lots: OpeningLot[];
  qty: number;
  invested: number;
  longLots: number;
  shortLots: number;
}

/** Reconstruct the surviving dated opening lots as of 31-Mar-2025 from the (raw) statement
 *  rows — intraday square-off, then the shared FIFO engine. Pure. */
export function reconstructStockOpening(txns: TxnStatementRow[], isin: string): OpeningReconstruction {
  const netted = squareOffDaily(txns, txns[0]?.name || "");
  const res = accumulateOpeningLots([], netted, {}, []);
  const lots = res.lots.map(l => ({ ...l, isin: isin || l.isin }));
  const qty = lots.reduce((s, l) => s + l.qty, 0);
  const invested = lots.reduce((s, l) => s + l.invested, 0);
  return { lots, qty, invested, longLots: res.summary.longLots, shortLots: res.summary.shortLots };
}

const seedToOpeningLot = (s: OpeningSeedLot): OpeningLot => ({
  name: s.name, isin: s.isin || "", acqDate: s.acqDate, qty: s.qty, costPerShare: s.costPerShare,
  invested: Math.round(s.qty * s.costPerShare * 100) / 100, longTerm: s.longTerm, note: s.note || "",
});

const stockMatches = (name: string, rowIsin: string | undefined, wantKey: string, wantIsin: string): boolean =>
  obKey(name) === wantKey || (!!wantIsin && !!rowIsin && rowIsin.toUpperCase() === wantIsin);

export interface RemovalPreview { lots: number; txns: number; }

/** How many existing Opening Holdings lots + Opening Txns rows this stock currently has
 *  (i.e. what the import will replace). For the confirm preview. */
export async function previewStockOpeningRemoval(spreadsheetId: string, stockName: string, isin: string): Promise<RemovalPreview> {
  const wantKey = obKey(stockName), wantIsin = (isin || "").toUpperCase();
  const [lots, txns] = await Promise.all([loadOpeningHoldings(spreadsheetId), loadOpeningTxns(spreadsheetId)]);
  return {
    lots: lots.filter(l => stockMatches(l.name, l.isin, wantKey, wantIsin)).length,
    txns: txns.filter(t => obKey(t.name) === wantKey).length,
  };
}

export interface ApplyResult { lotsWritten: number; txnsWritten: number; lotsRemoved: number; txnsRemoved: number; }

/**
 * Replace this stock's opening basis for the account: drop its existing Opening Holdings lots
 * + Opening Txns rows, write the reconstructed lots + the raw statement rows, then rebuild the
 * Holding tab and Capital Gains. Other stocks are preserved (both tabs are full-tab overwrites,
 * so we re-emit everyone else unchanged). Re-reads at write time so it's safe to re-run.
 */
// Run a step, and if it throws, prefix the message with which step failed so the modal's
// error banner pinpoints it (e.g. "save Opening Holdings: The caller does not have permission").
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) { throw new Error(`${label}: ${e?.result?.error?.message || e?.message || String(e)}`); }
}

export async function applyStockOpeningImport(
  spreadsheetId: string, stockName: string, isin: string,
  lots: OpeningLot[], rawTxns: TxnStatementRow[],
): Promise<ApplyResult> {
  if (!spreadsheetId) throw new Error("No spreadsheet for this account (is it a Google-backed portfolio?).");
  const wantKey = obKey(stockName), wantIsin = (isin || "").toUpperCase();

  // Opening Holdings — keep every OTHER stock, replace this one's lots.
  const existingLots = await step("read Opening Holdings", () => loadOpeningHoldings(spreadsheetId));
  const keptLots = existingLots.filter(l => !stockMatches(l.name, l.isin, wantKey, wantIsin));
  await step("save Opening Holdings", () => saveOpeningHoldings(spreadsheetId, [...keptLots.map(seedToOpeningLot), ...lots]));

  // Opening Txns — keep every OTHER stock, replace this one's rows.
  const existingTxns = await step("read Opening Txns", () => loadOpeningTxns(spreadsheetId));
  const keptTxns = existingTxns.filter(t => obKey(t.name) !== wantKey);
  await step("save Opening Txns", () => saveOpeningTxns(spreadsheetId, [...keptTxns, ...rawTxns]));

  await step("rebuild Holding tab", () => rebuildHoldingTab(spreadsheetId));
  await step("sync Capital Gains", () => syncCapitalGains(spreadsheetId));

  return {
    lotsWritten: lots.length, txnsWritten: rawTxns.length,
    lotsRemoved: existingLots.length - keptLots.length,
    txnsRemoved: existingTxns.length - keptTxns.length,
  };
}
