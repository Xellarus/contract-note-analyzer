import {
  accumulateOpeningLots, classifyTxn, obKey,
  OpeningLot, ReconIssue, SeedLot, TxnStatementRow,
} from "./openingBasis";
import { loadOpeningHoldings, saveOpeningHoldings, OpeningSeedLot } from "./openingHoldings";
import { loadOpeningTxns, saveOpeningTxns } from "./openingTxns";
import { rebuildHoldingTab, syncCapitalGains } from "./holdingsCalc";

/**
 * Per-stock opening-basis import. On a stock's detail page you upload that stock's trades
 * (the downloadable .xlsx template, or any broker CSV/workbook with Date / Type / Quantity /
 * Price columns) and they are ADDED to its pre-FY26 opening basis for the current account.
 *
 * It used to REPLACE the stock's opening basis. It no longer does (user directive
 * 2026-09-14) — the whole point is to file trades that were missing, without re-uploading a
 * complete history to do it.
 *
 * "Add" is NOT an append of lots. Opening Holdings is not a row list, it is the surviving
 * FIFO reconstruction, so appending a separately-reconstructed lot set is wrong the moment
 * the new file contains a SELL: that sell would replay against an empty queue and vanish.
 * Adding means SEEDING the FIFO from the lots already on the sheet and replaying only the
 * new rows on top — a BUY adds a lot, a SELL consumes the oldest lot already there. That is
 * exactly the carried-in-position contract of `accumulateOpeningLots(prevLots, txns)`, which
 * the date-sliced batch importer has always used.
 *
 *   - only rows dated on/before 31-Mar-2025 are used (FY26 True Entry is untouched),
 *   - the cost basis is the raw Price, or "Total Amount (Turnover)" / Qty when that column is
 *     filled; the charge columns (STT, brokerage, fees...) are READ AND IGNORED, because every
 *     gain in this app is computed on turnover and s.48 does not allow STT anyway,
 *   - same-day buys/sells are squared off (the app's intraday convention) before the FIFO
 *     replay, via the shared openingBasis engine,
 *   - rows already present in "Opening Txns" (same date, type, qty and price) are SKIPPED, so
 *     re-uploading the same file does not double the position,
 *   - rows naming a DIFFERENT security are rejected and counted, never relabelled,
 *   - Holding + Capital Gains are rebuilt afterwards.
 *
 * The identity of the stock is the page context. A file may carry Company Name / ISIN columns
 * (the template does) but they are used to VERIFY, never to route: other stocks are never
 * touched by this importer.
 */

export const OPENING_CUTOFF_ISO = "2025-03-31";
// 31-Mar-2025 local midnight — a trade must be ON/BEFORE this to feed the opening basis.
const CUTOFF_TS = new Date(2025, 2, 31).getTime();

/** The template's data tab — named here so the reader's error message and the writer agree. */
export const TEMPLATE_SHEET = "Equity Trades template";

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

const hkey = (s: any) => (s ?? "").toString().toUpperCase().replace(/[^A-Z]/g, "");
const num = (s: any): number => { const v = parseFloat((s ?? "").toString().replace(/,/g, "").trim()); return isNaN(v) ? 0 : v; };
const txt = (s: any): string => (s ?? "").toString().trim();

// The one ISIN shape, check digit included — same rule as extractIsin: without the trailing
// digit an NSE symbol or a BSE code would read as an ISIN and the identity check would fire
// on a row that is perfectly fine.
const ISIN_RE = /^IN[A-Z0-9]{9}[0-9]$/;

const SHEET_EPOCH_MS = Date.UTC(1899, 11, 30);
// A serial outside this window is not a trade date — it is a stray number in the date column
// (a year, a quantity, a header artefact). Treating one as a date would mint a 1905 lot that
// nothing downstream could question, so it is dropped and counted instead.
const SERIAL_MIN = 20000;   // 1954-10-03
const SERIAL_MAX = 60000;   // 2064-04-23

/**
 * Date cell → { iso, ts }. Handles the four shapes that reach here: an Excel serial (what a
 * real .xlsx date cell IS), a Date (some readers hydrate them), "2026-07-01[ 09:00:00]", and
 * "01-07-2026" / "01/07/2026" (the template's dd/mm/yyyy). ts of 0 means unparseable.
 */
export function parseCellDate(v: any): { iso: string; ts: number } {
  const mk = (y: number, mo: number, d: number) => ({
    iso: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    ts: new Date(y, mo - 1, d).getTime(),
  });
  if (v instanceof Date && !isNaN(v.getTime())) return mk(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === "number" && isFinite(v)) {
    if (v < SERIAL_MIN || v > SERIAL_MAX) return { iso: String(v), ts: 0 };
    const d = new Date(SHEET_EPOCH_MS + Math.round(v * 86400000));
    return mk(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const c = txt(v).split(/[ T]/)[0];
  let m = c.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return mk(+m[1], +m[2], +m[3]);
  m = c.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return mk(+m[3], +m[2], +m[1]);
  return { iso: c, ts: 0 };
}

export interface ParsedStockCsv {
  txns: TxnStatementRow[];   // rows on/before the cutoff, for THIS stock, name injected
  kept: number;
  dropped: number;           // rows after the cutoff (or undated) — excluded
  foreign: number;           // rows naming a DIFFERENT security — excluded
  foreignNames: string[];    // up to a handful, for the message
  amountRows: number;        // rows whose turnover column drove the cost basis
  amountDiverged: number;    // ...and differed from Qty × Price by more than a paisa
  total: number;
  sheetName?: string;        // which worksheet the rows came from (.xlsx only)
  error?: string;
}

interface ColIdx {
  type: number; date: number; qty: number; price: number;
  bal: number; name: number; isin: number; amount: number;
}

const emptyParse = (error?: string): ParsedStockCsv =>
  ({ txns: [], kept: 0, dropped: 0, foreign: 0, foreignNames: [], amountRows: 0, amountDiverged: 0, total: 0, error });

/**
 * Locate the header row in a grid. Needs Type + Date + Quantity + Price together IN ONE ROW —
 * which is also what keeps the template's own Instructions sheet from matching: it lists those
 * words down a Field Name column, never across a row.
 *
 * Only the TURNOVER-named amount headers are accepted. A bare "Amount" on a broker statement is
 * usually all-in (brokerage folded in) and `replayScrip` prefers amount over price, so adopting
 * one would quietly move charges into the cost basis of every lot.
 */
export function findHeader(grid: any[][]): { hi: number; ci: ColIdx } | null {
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const cells = (grid[i] || []).map(hkey);
    const find = (...k: string[]) => cells.findIndex(c => !!c && k.includes(c));
    const type = find("TYPE", "TRANSTYPE", "TRANSACTIONTYPE", "TXNTYPE", "TRADETYPE");
    const date = find("DATE", "TRADEDATE", "TRANSDATE", "TRANSACTIONDATE");
    const qty = find("QUANTITY", "QTY", "SHARES", "UNITS");
    const price = find("PRICE", "RATE", "PRICEPERSHARE");
    if (type < 0 || date < 0 || qty < 0 || price < 0) continue;
    return {
      hi: i,
      ci: {
        type, date, qty, price,
        bal: find("TOTALQUANTITY", "BALQTY", "BALANCE", "CLOSINGQTY"),
        name: find("COMPANYNAME", "COMPANY", "SCRIPNAME", "SCRIP", "SECURITY", "SECURITYNAME", "STOCK", "NAME"),
        isin: find("ISIN", "ISINCODE", "BSENSECODEISIN", "BSENSECODE", "CODE"),
        amount: find("TOTALAMOUNTTURNOVER", "TURNOVER", "TOTALTURNOVER"),
      },
    };
  }
  return null;
}

/**
 * Does this row name a DIFFERENT security? A valid ISIN decides on its own; otherwise the
 * company name does (obKey normalises Ltd/Limited/punctuation). A blank identity, or a
 * BSE code / NSE symbol in the ISIN column, cannot decide — the page context supplies the
 * identity, so those rows are accepted.
 */
export function rowIsForeign(rowName: string, rowIsin: string, stockName: string, isin: string): boolean {
  const ri = (rowIsin || "").toUpperCase(), wi = (isin || "").toUpperCase();
  if (ISIN_RE.test(ri) && ISIN_RE.test(wi)) return ri !== wi;
  if (rowName && stockName) return obKey(rowName) !== obKey(stockName);
  return false;
}

/**
 * Parse a grid (CSV rows or a worksheet) of this stock's trades. Header-driven. Injects
 * `stockName`, keeps only rows dated on/before 31-Mar-2025, and drops rows belonging to
 * another security. Pure.
 */
export function parseStockTxnGrid(grid: any[][], stockName: string, isin: string = ""): ParsedStockCsv {
  const head = findHeader(grid);
  if (!head) {
    const first = (grid[0] || []).map(txt).join(" | ").slice(0, 120);
    return emptyParse(`Couldn't find Date / Trans Type / Quantity / Price columns. First line read as: "${first}"`);
  }
  const { hi, ci } = head;

  const txns: TxnStatementRow[] = [];
  const foreignNames: string[] = [];
  let total = 0, dropped = 0, foreign = 0, amountRows = 0, amountDiverged = 0;

  for (let i = hi + 1; i < grid.length; i++) {
    const f = grid[i] || [];
    const type = txt(f[ci.type]);
    if (!type) continue;
    total++;

    const rowName = ci.name >= 0 ? txt(f[ci.name]) : "";
    const rowIsin = ci.isin >= 0 ? txt(f[ci.isin]) : "";
    if (rowIsForeign(rowName, rowIsin, stockName, isin)) {
      foreign++;
      const label = rowName || rowIsin;
      if (label && foreignNames.length < 5 && !foreignNames.includes(label)) foreignNames.push(label);
      continue;
    }

    const { iso, ts } = parseCellDate(f[ci.date]);
    if (ts <= 0 || ts > CUTOFF_TS) { dropped++; continue; }   // after 31-Mar-2025 (or unparseable)

    const qty = num(f[ci.qty]), price = num(f[ci.price]);
    // The turnover column wins when it is filled: it is the figure the owner typed, and a
    // price rounded to paise divided back does not reproduce it. Divergence is COUNTED and
    // shown rather than silently absorbed — it is the tell that charges were folded in.
    let amount = 0;
    if (ci.amount >= 0) {
      const a = num(f[ci.amount]);
      if (a > 0 && qty > 0) {
        amount = a;
        amountRows++;
        if (Math.abs(a - qty * price) > 0.01) amountDiverged++;
      }
    }

    txns.push({
      dateStr: iso, iso, ts,
      type: type.toUpperCase(), name: stockName,
      qty, price, amount,
      balQty: ci.bal >= 0 ? num(f[ci.bal]) : 0,
    });
  }

  return { txns, kept: txns.length, dropped, foreign, foreignNames, amountRows, amountDiverged, total };
}

/** Parse a delimited text file — tries each delimiter until a header row resolves. */
export function parseSingleStockTxnCsv(text: string, stockName: string, isin: string = ""): ParsedStockCsv {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);
  if (!lines.length) return emptyParse("The file is empty.");
  for (const d of DELIMITERS) {
    const grid = lines.map(l => splitCsv(l, d));
    if (findHeader(grid)) return parseStockTxnGrid(grid, stockName, isin);
  }
  return emptyParse(`Couldn't find Date / Trans Type / Quantity / Price columns. First line read as: "${(lines[0] || "").slice(0, 120)}"`);
}

/**
 * Parse an uploaded .xlsx / .xls / .csv. The workbook is scanned sheet by sheet and the FIRST
 * one carrying a usable header is used — so the template's Instructions tab is skipped without
 * needing to know its name, and a renamed data tab still works.
 *
 * `xlsx` is loaded on demand: it is a read-only import path with no business in the first-load
 * bundle. Cells are read RAW so a date arrives as a serial, never as a display string in
 * whatever locale format the sheet happened to show.
 */
export async function parseTradeFile(file: File, stockName: string, isin: string = ""): Promise<ParsedStockCsv> {
  if (/\.csv$/i.test(file.name)) return parseSingleStockTxnCsv(await file.text(), stockName, isin);
  if (!/\.xlsx?$/i.test(file.name)) return emptyParse("Please choose a .xlsx or .csv file.");

  const XLSX: any = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const names: string[] = wb.SheetNames || [];
  for (const sn of names) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, blankrows: false }) as any[][];
    if (findHeader(grid)) return { ...parseStockTxnGrid(grid, stockName, isin), sheetName: sn };
  }
  return emptyParse(
    `No sheet in this workbook has Date / Trans Type / Quantity / Price columns (looked in: ${names.join(", ") || "none"}). ` +
    `Download the sample template and fill the "${TEMPLATE_SHEET}" tab.`,
  );
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
    // The turnover column, when present, is the buy's true value — the same preference
    // replayScrip applies, kept here so squaring off can't silently switch basis.
    if (kind === "BUY") { d.buyQty += t.qty; d.buyVal += t.amount > 0 ? t.amount : t.qty * t.price; }
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
  issues: ReconIssue[];
}

/**
 * Reconstruct this stock's surviving opening lots as of 31-Mar-2025 by replaying `txns` ON TOP
 * OF `seed` (its lots already on the sheet — empty for a first import). Intraday square-off,
 * then the shared FIFO engine, which consumes the seed oldest-first so a sell in the new batch
 * takes the lot that was already there. Pure.
 */
export function reconstructStockOpening(txns: TxnStatementRow[], isin: string, seed: SeedLot[] = []): OpeningReconstruction {
  const name = txns[0]?.name || seed[0]?.name || "";
  const netted = squareOffDaily(txns, name);
  const res = accumulateOpeningLots(seed, netted, {}, []);
  const lots = res.lots.map(l => ({ ...l, isin: isin || l.isin }));
  const qty = lots.reduce((s, l) => s + l.qty, 0);
  const invested = lots.reduce((s, l) => s + l.invested, 0);
  return { lots, qty, invested, longLots: res.summary.longLots, shortLots: res.summary.shortLots, issues: res.issues };
}

const seedToOpeningLot = (s: OpeningSeedLot): OpeningLot => ({
  name: s.name, isin: s.isin || "", acqDate: s.acqDate, qty: s.qty, costPerShare: s.costPerShare,
  invested: Math.round(s.qty * s.costPerShare * 100) / 100, longTerm: s.longTerm, note: s.note || "",
});

const seedLotOf = (s: OpeningSeedLot): SeedLot => ({
  name: s.name, isin: s.isin || "", acqDate: s.acqDate, qty: s.qty, costPerShare: s.costPerShare, note: s.note,
});

const stockMatches = (name: string, rowIsin: string | undefined, wantKey: string, wantIsin: string): boolean =>
  obKey(name) === wantKey || (!!wantIsin && !!rowIsin && rowIsin.toUpperCase() === wantIsin);

/**
 * A row's identity for the duplicate guard: date, type, quantity and price. Deliberately NOT
 * the running balance or the amount — a re-export of the same statement can differ there.
 * Quantities round to 6dp, prices to 4, so a float re-parse can't split one row into two.
 */
export const txnKey = (t: TxnStatementRow): string =>
  `${t.iso}|${classifyTxn(t.type)}|${Math.round(t.qty * 1e6)}|${Math.round(t.price * 1e4)}`;

/** Rows of `incoming` that are not already in `existing` (same date/type/qty/price). Pure.
 *  Duplicates WITHIN `incoming` are kept — two identical fills on one day are real. */
export function dedupeAgainstExisting(existing: TxnStatementRow[], incoming: TxnStatementRow[]): { fresh: TxnStatementRow[]; duplicates: number } {
  const seen = new Set(existing.map(txnKey));
  const fresh = incoming.filter(t => !seen.has(txnKey(t)));
  return { fresh, duplicates: incoming.length - fresh.length };
}

/**
 * Would this batch replay out of FIFO order? `replayScrip` seeds the queue with the existing
 * lots sorted oldest-first and then PUSHES new buys onto the end regardless of their dates. So
 * a batch that buys at dates older than lots already on the sheet AND sells in the same batch
 * consumes the wrong lots. Buy-only batches are safe: every downstream engine re-sorts opening
 * lots by acquisition date, so where they land in the queue does not survive the write.
 */
export function batchIsOutOfOrder(seed: SeedLot[], txns: TxnStatementRow[]): boolean {
  const sells = txns.some(t => classifyTxn(t.type) === "SELL");
  if (!sells) return false;
  const seedTs = seed.map(l => parseCellDate(l.acqDate).ts).filter(t => t > 0);
  if (!seedTs.length) return false;
  const newestSeed = Math.max(...seedTs);
  return txns.some(t => classifyTxn(t.type) === "BUY" && t.ts > 0 && t.ts < newestSeed);
}

export interface AddPreview {
  existingLots: number;
  existingQty: number;
  existingInvested: number;
  duplicates: number;          // incoming rows already on the sheet (will be skipped)
  freshRows: number;           // rows that will actually be written
  result: OpeningReconstruction;
  outOfOrder: boolean;
}

/**
 * What this import would leave behind, without writing anything: the stock's current opening
 * position, how many incoming rows are duplicates, and the resulting lots. Reads both tabs.
 */
export async function previewStockOpeningAdd(
  spreadsheetId: string, stockName: string, isin: string, incoming: TxnStatementRow[],
): Promise<AddPreview> {
  const wantKey = obKey(stockName), wantIsin = (isin || "").toUpperCase();
  const [allLots, allTxns] = await Promise.all([loadOpeningHoldings(spreadsheetId), loadOpeningTxns(spreadsheetId)]);
  const mine = allLots.filter(l => stockMatches(l.name, l.isin, wantKey, wantIsin));
  const mineTxns = allTxns.filter(t => obKey(t.name) === wantKey);
  const seed = mine.map(seedLotOf);
  const { fresh, duplicates } = dedupeAgainstExisting(mineTxns, incoming);
  return {
    existingLots: mine.length,
    existingQty: mine.reduce((s, l) => s + l.qty, 0),
    existingInvested: mine.reduce((s, l) => s + l.qty * l.costPerShare, 0),
    duplicates,
    freshRows: fresh.length,
    result: reconstructStockOpening(fresh, isin, seed),
    outOfOrder: batchIsOutOfOrder(seed, fresh),
  };
}

export interface AddResult {
  lotsBefore: number; lotsAfter: number;
  txnsWritten: number; duplicatesSkipped: number;
  qtyBefore: number; qtyAfter: number;
}

// Run a step, and if it throws, prefix the message with which step failed so the modal's
// error banner pinpoints it (e.g. "save Opening Holdings: The caller does not have permission").
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) { throw new Error(`${label}: ${e?.result?.error?.message || e?.message || String(e)}`); }
}

/**
 * ADD these trades to the stock's opening basis. Re-reads both tabs at write time and redoes
 * the merge, so the preview is display only and a sheet edited in between cannot be clobbered.
 * Other stocks are preserved (both tabs are full-tab overwrites, so everyone else is re-emitted
 * unchanged). Safe to re-run: identical rows are skipped rather than added twice.
 */
export async function addStockOpeningImport(
  spreadsheetId: string, stockName: string, isin: string, incoming: TxnStatementRow[],
): Promise<AddResult> {
  if (!spreadsheetId) throw new Error("No spreadsheet for this account (is it a Google-backed portfolio?).");
  const wantKey = obKey(stockName), wantIsin = (isin || "").toUpperCase();

  const existingLots = await step("read Opening Holdings", () => loadOpeningHoldings(spreadsheetId));
  const mine = existingLots.filter(l => stockMatches(l.name, l.isin, wantKey, wantIsin));
  const others = existingLots.filter(l => !stockMatches(l.name, l.isin, wantKey, wantIsin));

  const existingTxns = await step("read Opening Txns", () => loadOpeningTxns(spreadsheetId));
  const mineTxns = existingTxns.filter(t => obKey(t.name) === wantKey);
  const { fresh, duplicates } = dedupeAgainstExisting(mineTxns, incoming);

  const qtyBefore = mine.reduce((s, l) => s + l.qty, 0);
  if (fresh.length === 0) {
    // Nothing to do. Writing anyway would rewrite two tabs and run a rebuild + CG sync for no
    // change — a lot of Sheets requests to accomplish nothing.
    return { lotsBefore: mine.length, lotsAfter: mine.length, txnsWritten: 0, duplicatesSkipped: duplicates, qtyBefore, qtyAfter: qtyBefore };
  }

  const merged = reconstructStockOpening(fresh, isin, mine.map(seedLotOf));

  // Opening Holdings — every OTHER stock verbatim, this one replaced by the MERGED position
  // (its old lots are inside that merge, not discarded).
  await step("save Opening Holdings", () => saveOpeningHoldings(spreadsheetId, [...others.map(seedToOpeningLot), ...merged.lots]));
  // Opening Txns — append; the history is the record the as-of report replays.
  await step("save Opening Txns", () => saveOpeningTxns(spreadsheetId, [...existingTxns, ...fresh]));

  await step("rebuild Holding tab", () => rebuildHoldingTab(spreadsheetId));
  await step("sync Capital Gains", () => syncCapitalGains(spreadsheetId));

  return {
    lotsBefore: mine.length, lotsAfter: merged.lots.length,
    txnsWritten: fresh.length, duplicatesSkipped: duplicates,
    qtyBefore, qtyAfter: merged.qty,
  };
}
