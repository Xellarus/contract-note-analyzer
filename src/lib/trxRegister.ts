import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import {
  normName, loadScripMaster, resolveScrip, lookupScrip, ScripMaster,
  SCRIP_MASTER_SPREADSHEET_ID, ltDaysFor, assetClassOf, isSttRemoved,
} from "./scripMaster";
import { ASSET_CLASSES, ASSET_CLASS_IDS, AssetClassId } from "./privateEquities";
import { loadCorporateActions, CORP_ACTIONS_TAB } from "./corporateActions";
import { loadOpeningHoldings } from "./openingHoldings";
import { UnresolvedScrip, insertLotByTs, carryLots, CarrySource } from "./holdingsCalc";
import { ledgerSide, isSplitType, isTransferType, parseRatio, freeSharesFor, FreeShareRatio } from "./tradeRowSchema";
import {
  buildItrUnlistedSchedule, ItrCompanyInput, ITR_COL, ITR_WIDTH, ITR_COL_WIDTHS,
  ITR_HEADER_ROW_INDEX, ITR_FIRST_DATA_ROW_INDEX, ITR_BANNER_ROWS,
} from "./itrUnlistedSchedule";

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
// Rupee amount for prose inside a cell (the numeric columns stay raw numbers so the
// sheet can sum them - this is only ever used inside an explanatory label).
const fmtAmt = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

// ── Column layout, per output tab ──
/**
 * The register is written as TWO tabs, and they are not the same width:
 *
 *   DELIVERY  → "Capital Gains for FY.."  — Short term + Long term P/L   (25 columns)
 *   INTRADAY  → "Intra-Day for FY.."      — Intra-Day P/L only          (24 columns)
 *
 * Everything to the left of the P/L block (S.No … SALES AMOUNT) and everything to the right
 * of it (the nine charge columns) is identical on both; only the P/L block differs, so every
 * charge column sits at a DIFFERENT absolute index on the two tabs.
 *
 * `COL` therefore deliberately does NOT carry `intra` / `st` / `lt` keys. The P/L columns are
 * reachable only through `plCols` / `plCol()` / `firstPl` / `lastPl`. That is the whole safety
 * net: this project has no `strictNullChecks`, so an OPTIONAL key would let `row[COL.intra]`
 * compile, evaluate to `row[undefined]`, and silently drop a tax figure with a green build.
 * A MISSING key is a type error regardless of strictness, so `tsc` genuinely proves that every
 * P/L reference has been re-pointed.
 */
type PlKey = "intra" | "st" | "lt";
type VariantId = "DELIVERY" | "INTRADAY";
const PL_LABEL: Record<PlKey, string> = { intra: "Intra-Day", st: "Short term", lt: "Long term" };
const PL_OF: Record<VariantId, PlKey[]> = { DELIVERY: ["st", "lt"], INTRADAY: ["intra"] };
const BUCKET_PL: Record<"INTRA" | "ST" | "LT", PlKey> = { INTRA: "intra", ST: "st", LT: "lt" };

const LEFT_KEYS = ["sno", "name", "oDate", "oQty", "oRate", "oAmt", "pDate", "pQty", "pRate", "pAmt", "sDate", "sQty", "sRate", "sAmt"] as const;
const CHARGE_KEYS = ["brok", "stt", "gst", "et", "dmat", "stamp", "sebi", "exchClg", "ipf"] as const;
const LEFT_HDR = ["S.No", "SCRIPT NAME", "DATE", "NO OF SHARE", "RATE", "AMOUNT", "DATE", "NO OF SHARE", "RATE", "AMOUNT", "DATE", "NO OF SHARE", "RATE", "AMOUNT"];
const CHARGE_HDR = ["Brok.Total", "STT", "GST", "ET Charges", "Dmat", "Stamp duty", "SEBI Chg.", "EXCH.Clg.", "IPF"];
type ColMap = Record<(typeof LEFT_KEYS)[number] | (typeof CHARGE_KEYS)[number], number>;

/**
 * The TRANSACTION STATEMENT layout - one row per transaction, for the non-listed classes.
 *
 * A different question from the capital-gains tabs, so a different shape: those are
 * scrip-wise matched SALES (opening → purchase → sale → P/L), this is a record of what was
 * transacted. It is what makes a mutual-fund or bond sale visible at all, since those have no
 * holding-period rule and are refused by the gains engines.
 *
 * The nine charge columns REUSE `CHARGE_HDR` verbatim so a statement sitting beside a gains tab
 * has the same charge block in the same order.
 */
const TXN_HDR = ["S.No", "DATE", "SCRIPT NAME", "TYPE", "NO OF SHARE", "RATE", "AMOUNT",
                 ...CHARGE_HDR, "NET AMOUNT"];
const TX = {
  sno: 0, date: 1, name: 2, type: 3, qty: 4, rate: 5, amt: 6,
  brok: 7, stt: 8, gst: 9, et: 10, dmat: 11, stamp: 12, sebi: 13, exchClg: 14, ipf: 15,
  net: 16,
};
const TXN_WIDTH = TXN_HDR.length;
// The charge block must line up with CHARGE_HDR or every charge lands one column out in a
// document someone files. Cheap structural check, at module load.
if (TXN_WIDTH !== 17) throw new Error(`Transaction statement layout: ${TXN_WIDTH} columns, expected 17.`);
if (TXN_HDR[TX.brok] !== CHARGE_HDR[0] || TXN_HDR[TX.ipf] !== CHARGE_HDR[CHARGE_HDR.length - 1]) {
  throw new Error("Transaction statement layout: the charge block is not aligned with CHARGE_HDR.");
}

interface Layout {
  id: VariantId;
  COL: ColMap;
  WIDTH: number;
  plKeys: PlKey[];
  plCols: { key: PlKey; col: number; label: string }[];
  /** First P/L column — where the SALES colour band ends and the P/L band begins. */
  firstPl: number;
  /** Last P/L column — the expense-footer label anchor, immediately left of Brok.Total. */
  lastPl: number;
  headers: string[];
  blankRow: () => any[];
  /** Column for a sale's tax bucket. Throws if that bucket cannot belong on this tab. */
  plCol: (bucket: "INTRA" | "ST" | "LT") => number;
}

const makeLayout = (id: VariantId): Layout => {
  const plKeys = PL_OF[id];
  const order: string[] = [...LEFT_KEYS, ...plKeys, ...CHARGE_KEYS];
  const COL = {} as ColMap;
  order.forEach((k, i) => { (COL as any)[k] = i; });
  const WIDTH = order.length;
  const plCols = plKeys.map((k) => ({ key: k, col: order.indexOf(k), label: PL_LABEL[k] }));
  const firstPl = plCols[0].col, lastPl = COL.brok - 1;
  const headers = [...LEFT_HDR, ...plKeys.map(() => "P/L"), ...CHARGE_HDR];
  // Cheap structural detectors. A one-column drift here silently misfiles every charge in a
  // tax document and neither tsc nor vite can see it; these throw at generate time instead.
  if (headers.length !== WIDTH) throw new Error(`Register layout ${id}: ${headers.length} headers for ${WIDTH} columns.`);
  if (COL.ipf !== WIDTH - 1) throw new Error(`Register layout ${id}: IPF is not the last column.`);
  if (firstPl !== COL.sAmt + 1) throw new Error(`Register layout ${id}: the P/L block is not adjacent to SALES AMOUNT.`);
  if (lastPl !== plCols[plCols.length - 1].col) throw new Error(`Register layout ${id}: lastPl is not the last P/L column.`);
  return {
    id, COL, WIDTH, plKeys, plCols, firstPl, lastPl, headers,
    blankRow: () => new Array(WIDTH).fill(""),
    plCol: (b) => {
      const c = plCols.find((x) => x.key === BUCKET_PL[b]);
      // Reaching here means a row was routed to the wrong tab — refuse rather than write it
      // into a column that does not exist and lose the figure.
      if (!c) throw new Error(`Register bug: a ${b} row reached the ${id} tab, which has no ${b} column.`);
      return c.col;
    },
  };
};

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
  /** A cross-portfolio transfer leg. It carries a normal BUY/SELL side so the lot queue
   *  moves, but realises NO gain: the replay consumes/adds the lots and records a note
   *  instead of a sale or purchase row - the same treatment as a merger. */
  xfer?: boolean;
  /** Free text from the row's Notes column, used to name the counterparty account. */
  note?: string;
  /** Bonus ONLY: the stored ratio. Its presence makes the share count DERIVED from the
   *  position held on the bonus's own date, so editing an earlier buy moves it. */
  freeRatio?: FreeShareRatio | null;
  /** The raw ledger action, so Bonus (N per M held) is told from Split (new:old). */
  rawAction?: string;
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

/**
 * A corporate action MOVES COST, so a bare label leaves the block unreconcilable: a
 * demerger's parent shows a purchase and a sale whose difference is NOT the printed P&L,
 * and the NewCo shows a sale with no purchase at all. `cols` says which column family
 * carries the numbers:
 *   "purchase" - the receiving side. The action IS the acquisition, so it prints where a
 *                purchase prints: qty in, cost/share, total cost.
 *   "holding"  - the giving side. Prints the RESTATED position the way a SPLIT line does,
 *                so the reduced basis the next sale will use is visible.
 * Omitted entirely for a note that moves no cost (transfer in/out), which stays a label.
 */
interface CorpNote {
  ts: number; text: string;
  cols?: "purchase" | "holding";
  qty?: number; rate?: number; amount?: number;
}

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
  /** The delivery (short/long-term) tab. Keeps the historic name and the legacy migration. */
  tabName: string;
  /** The speculative same-day tab. Always written, even with no round trips that year -
   *  skipping it would leave a previous run's figures standing under the same FY heading. */
  intradayTabName: string;
  /** The FY-end holding statement that carries EVERY class. Stays the headline name:
   *  a consumer that says "the holding tab" means the complete one. */
  holdingTabName: string;
  /** All three FY-end holding statements. Equity + PE does NOT foot to combined when
   *  the book holds AIF / Mutual Fund / Bonds — those are on combined alone, and the
   *  tab says so under its grand total. */
  holdingTabs: { equity: string; pe: string; combined: string };
  /**
   * The ITR schedule "Details of Unlisted Equity Shares held at any time during the previous
   * year", written per FY beside the holding tabs.
   *
   * The three counts are DIAGNOSTIC and exist for the same reason the STT pair does: every way
   * this schedule can be wrong is silent on the tab itself. `itrCompanies` 0 against a book
   * that holds unlisted companies means the Private Equities tab was not read or the companies
   * did not resolve — not that nothing was held. `itrMissingPan` names companies whose PAN cell
   * is empty, because a blank column D on a filed return is indistinguishable from a company
   * that legitimately has none. `itrUnfooted` names companies whose rows will not foot, which
   * happens when a split, a merger/demerger receipt or a cross-portfolio transfer moved shares
   * with no row of its own.
   */
  itrUnlistedTab: string;
  itrCompanies: number;
  itrMissingPan: string[];
  itrUnfooted: string[];
  fyLabel: string;
  /** One entry per non-listed asset class that produced output this run, in registry order. */
  classTabs: { id: AssetClassId; label: string; cgTab?: string; txnTab?: string }[];
  /** FY sales omitted from BOTH P/L columns because their asset class has no decided
   *  holding-period rule (currently: mutual funds). Reported so the gap is stated. */
  unclassified: { name: string; isin: string; qty: number; ts: number }[];
  /**
   * DIAGNOSTIC for the "STT Removed" flag, because its failure mode is SILENT: a tab that
   * still shows STT looks identical whether the master was never read, the scrip never
   * matched, or the owner is looking at a tab this run did not write.
   *
   * `sttFlaggedInMaster` counts entries carrying the flag in the master AS LOADED BY THIS RUN
   * - so 0 means the column was not seen at all (wrong tab, stale bundle, unread range) and
   * the lookup is not even in question. `sttSuppressed` names the scrips this run actually
   * blanked STT for. The two together separate three causes that otherwise look the same.
   */
  sttFlaggedInMaster: number;
  sttSuppressed: string[];
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
  const ratioIdx = findCol(hdrs, "Ratio");   // -1 on every sheet written before 14-Sep-2026
  const turnoverIdx = findCol(hdrs, "Total Amount (Turnover)");
  const inclIdx = findCol(hdrs, "Total Amount with Expense (Incl STT)");
  const classIdx = findCol(hdrs, "Trade Class", "Trade Type");
  // Notes carries the counterparty account for a transfer leg ("Transferred to X").
  const notesIdx = findCol(hdrs, "Notes", "Note", "Remarks");
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
  // FORCED, not cached. The master carries HAND-MAINTAINED classification the owner edits in the
  // sheet and then immediately clicks this button to apply: the asset-class tabs, "Price
  // Exception", "STT Removed", aliases. `loadScripMaster` caches for 90s and the read-only hot
  // paths keep the cache warm, so an unforced read here returns the master AS IT WAS BEFORE THE
  // EDIT and writes a register/tab that silently ignores it - the "I marked it and nothing
  // happened" bug, indistinguishable from a broken feature. Only the explicitly-clicked WRITE
  // actions force; forcing the read-only paths would re-open the read-quota problem.
  const master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID, { force: true });

  // Same refusal as `syncCapitalGains`, for the same reason: this register splits every sale
  // into short and long term at `ltDaysFor`, which is 730 days for an unlisted company. With
  // the Private Equities tab unreadable every security reads as listed, so an unlisted sale
  // held 12-24 months lands in the LONG-term column of a tax register that is then filed.
  // Blocking is recoverable in one step; a mis-split register that already looks finished is not.
  if (master.peFailed) {
    throw new Error(
      'Register not written: the "Private Equities" tab of the shared scrip master could not be read, '
      + 'so unlisted companies cannot be identified — and their long-term holding period is 24 months, not 12. '
      + 'Continuing would classify unlisted sales held 12–24 months as long-term. Fix that tab and run this again.',
    );
  }

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
  // `freeRatio` present -> the share count is DERIVED from the position on the action's own
  // date, so editing an earlier trade moves it. Absent on rows written before 14-Sep-2026.
  const splitRows: { ts: number; key: string; qty: number; freeRatio?: FreeShareRatio | null }[] = [];
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
    if (isSplitType(rawType)) { splitRows.push({ ts: parseDateTs(r[dateIdx]), key: keyOf(isin, name), qty, freeRatio: ratioIdx >= 0 ? parseRatio(r[ratioIdx]) : null }); continue; }
    // Everything else → a buy/sell SIDE (Bonus/IPO/Rights are buy-side, ₹0/priced add).
    const type = ledgerSide(rawType);
    if (!type) continue;
    const xfer = isTransferType(rawType);
    const note = notesIdx >= 0 ? (r[notesIdx] || "").toString().trim() : "";
    const tradeClass = (classIdx >= 0 ? (r[classIdx] || "").toString() : "").toLowerCase();
    const isIntraday = tradeClass.includes("intraday");
    const avgPrice = toNum(r[priceIdx]) || 0;
    const turnover = toNum(r[turnoverIdx]) || 0;
    const inclSTT = inclIdx >= 0 ? (toNum(r[inclIdx]) || 0) : 0;
    trades.push({
      ts: parseDateTs(r[dateIdx]), idx: i, key: keyOf(isin, name), name, isin,
      type: type as "BUY" | "SELL", qty, avgPrice, turnover, inclSTT, isIntraday, xfer, note,
      freeRatio: ratioIdx >= 0 ? parseRatio(r[ratioIdx]) : null, rawAction: rawType,
      charges: {
        brok: num(r, brokIdx), stt: num(r, sttIdx), gst: num(r, gstIdx), et: num(r, etIdx),
        stamp: num(r, stampIdx), sebi: num(r, sebiIdx), ipf: num(r, ipfIdx), dmat: num(r, dmatIdx),
      },
    });
  }
  if (trades.length === 0 && splitRows.length === 0) throw new Error("True Entry has no parseable delivery Buy/Sell rows.");

  // Longest name seen per key (usually the full official name over a short code).
  const nameByKey = new Map<string, string>();
  // First non-blank ISIN seen per key. Kept beside the name because a class lookup wants both,
  // and a key built from a blank ISIN carries only the name.
  const isinByKey = new Map<string, string>();
  for (const t of trades) {
    const cur = nameByKey.get(t.key);
    if (!cur || t.name.length > cur.length) nameByKey.set(t.key, t.name);
    if (t.isin && !isinByKey.get(t.key)) isinByKey.set(t.key, t.isin);
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
    if (ol.isin && !isinByKey.get(key)) isinByKey.set(key, ol.isin);
  }

  /**
   * Asset class per scrip key. `undefined` means LISTED - on none of the non-listed tabs.
   *
   * Resolved LAZILY and memoised, for two reasons. `assetClassOf` runs `lookupScrip`, whose
   * token-subset fallback rescans every master entry (~5,000) for a name it cannot match
   * exactly, so calling it per row would be a full scan per row on a multi-thousand row ledger.
   * And lazily rather than in the loop above because keys also arrive from the OPENING SEED and
   * from corporate actions - a mutual fund bought before this FY has no trade row here at all,
   * and eager population from `trades` would have read it as listed.
   */
  const classByKey = new Map<string, AssetClassId | undefined>();
  const classOfKey = (key: string): AssetClassId | undefined => {
    if (classByKey.has(key)) return classByKey.get(key);
    const c = assetClassOf(master, isinByKey.get(key) || "", nameByKey.get(key) || key);
    classByKey.set(key, c);
    return c;
  };
  /**
   * Does this scrip's class have a decided long-term threshold?
   *
   * Listed equity does (365), PE and AIF do (730), a mutual fund and a bond do NOT. This single
   * test decides BOTH whether a scrip may appear on a capital-gains tab at all and whether its
   * charges are expected there, so the emission and the charge-conservation guard cannot drift
   * apart: whatever is kept off the tabs is exactly what is not expected on them.
   */
  const keyHasLtRule = (key: string): boolean => {
    const c = classOfKey(key);
    return !c || ASSET_CLASSES[c].ltDays !== null;
  };

  /**
   * Is STT suppressed on the capital-gains tabs for this scrip? ("STT Removed" in the master.)
   *
   * Memoised like `classOfKey` for the same reason: the lookup can fall through to a
   * token-subset rescan of every master entry, and this is asked once per emitted row.
   */
  const sttOffByKey = new Map<string, boolean>();
  const sttOffForKey = (key: string): boolean => {
    const hit = sttOffByKey.get(key);
    if (hit !== undefined) return hit;
    const off = isSttRemoved(master, isinByKey.get(key) || "", nameByKey.get(key) || key);
    sttOffByKey.set(key, off);
    return off;
  };

  /**
   * The charges AS THEY APPEAR ON A CAPITAL-GAINS TAB.
   *
   * This does not change any gain: the P/L is `sale turnover - purchase turnover`, and turnover
   * is charge-free, so STT has never been part of it. What it changes is the nine-column charge
   * block, which a reader takes to be the expenses claimed against that gain - and under s.48
   * STT is not a deductible expense, so listing it there is a claim nobody is making.
   *
   * Everything on a gains tab goes through here, INCLUDING the charge-conservation guard's
   * `expect`. That is the whole discipline, and the same one `keyHasLtRule` follows: whatever is
   * dropped from the tabs must be dropped from what is expected on them, keyed on the identical
   * test, or the guard sees drift and refuses to write the register AT ALL.
   *
   * The transaction and holding statements deliberately do NOT go through here. They are a
   * record of what was transacted, they are not in the guard's sum, and they must still tie back
   * to the broker's contract note.
   */
  const cgCharges = (key: string, c: Charges): Charges =>
    (sttOffForKey(key) ? { ...c, stt: 0 } : c);

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
    | { ts: number; ord: number; idx: number; kind: "split"; key: string; qty: number; freeRatio?: FreeShareRatio | null }
    | { ts: number; ord: number; idx: number; kind: "ca"; fromKey: string; toKey: string; caType: "Merger" | "Demerger"; sharesIn: number; cost: number; from: string; to: string };
  const events: Ev[] = [];
  for (const t of trades) if (!pairedIdx.has(t.idx)) events.push({ ts: t.ts, ord: t.type === "BUY" ? 0 : 2, idx: t.idx, kind: "trade", trade: t });
  for (const t of residualTrades) events.push({ ts: t.ts, ord: t.type === "BUY" ? 0 : 2, idx: t.idx, kind: "trade", trade: t });
  for (const sp of splitRows) events.push({ ts: sp.ts, ord: 1, idx: 1e9, kind: "split", key: sp.key, qty: sp.qty, freeRatio: sp.freeRatio });
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
  // FY sales left out of both P/L columns because their class has no decided holding-period
  // rule. Surfaced on the result so the gap is stated rather than discovered.
  const unclassifiedSales: { name: string; isin: string; qty: number; ts: number }[] = [];
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
      // Weights for the parcels handed to the receiving security. SNAPSHOTTED here because both
      // branches below overwrite the very fields they are read from - the merger zeroes
      // `remaining` on the next line, and the demerger rewrites `purPrice`.
      let carrySrc: CarrySource[] = [];
      if (ev.caType === "Merger") {
        carrySrc = lots.map((l) => ({ ts: l.buyTs, qty: l.remaining, cost: l.remaining * l.purPrice }));
        for (const l of lots) l.remaining = 0;             // target absorbed
      } else {                                             // Demerger: shrink parent cost pro-rata
        const remCost = lots.reduce((s, l) => s + l.remaining * l.purPrice, 0);
        const factor = remCost > 0 ? Math.max(0, remCost - ev.cost) / remCost : 1;
        // r6, NOT r2. Rounding cost-per-share to paise here loses basis in proportion to the
        // quantity — ₹110.76 on 24,000 Tata Motors shares — and left the printed columns
        // unable to add up to the printed P/L. Cost per share is a RATE, and the project rule
        // is full precision on rates; only money amounts round to paise. Changed in lockstep
        // with syncCapitalGains so the register still equals the LTST tab.
        // Basis each lot SURRENDERS - read before the shrink consumes it. Quantity is
        // apportioned by quantity and cost by this; different weights on purpose (`carryLots`).
        carrySrc = lots.map((l) => ({ ts: l.buyTs, qty: l.remaining, cost: l.remaining * l.purPrice * (1 - factor) }));
        for (const l of lots) { l.purPrice = r6(l.purPrice * factor); l.inclPrice = r6(l.inclPrice * factor); }
      }
      if (ev.sharesIn > 0) {
        // The received shares CARRY THE PARENT LOTS' ACQUISITION DATES - s.2(42A) Expl 1(i)(g)
        // for a demerger, 1(i)(b) for a s.47(vii) amalgamation. Until 12-Sep-2026 this stamped
        // ev.ts, which filed a long-term parent's spin-off as short term.
        //
        // INSERTED, never pushed: this queue is consumed in array order (the sale loop below),
        // the only sort runs BEFORE the event loop, and these parcels now carry OLD dates. A
        // push would leave the queue unsorted, hand the next sale the wrong lot, and - because
        // `insertLotByTs`'s binary search assumes sorted input - mis-place every later buy too.
        //
        // Built field-by-field rather than spread from the parent: the parcels take ZERO_CHARGES.
        // Inheriting the parent's charges would count the same brokerage twice, and the
        // charge-conservation guard would throw rather than write ANY register.
        const arr = fifo.get(ev.toKey) || [];
        for (const c of carryLots(carrySrc, ev.sharesIn, ev.cost, ev.ts)) {
          const per = c.qty > 1e-9 ? r6(c.cost / c.qty) : 0;
          insertLotByTs(arr,
            { buyTs: c.ts, qty: c.qty, remaining: c.qty, purPrice: per, inclPrice: per, charges: { ...ZERO_CHARGES } },
            (l) => l.buyTs);
        }
        fifo.set(ev.toKey, arr);
      }
      if (inFY) {
        touch(ev.fromKey, ev.ts); touch(ev.toKey, ev.ts);
        const kind = ev.caType.toUpperCase();

        // RECEIVING side - the action is this security's acquisition. Its whole cost basis
        // arrives here and nowhere else, so it has to print like a purchase or the block
        // shows a sale against no cost at all.
        block(ev.toKey).corpNotes.push({
          ts: ev.ts, text: `${kind} from ${ev.from} (${fmtDate(ev.ts)})`,
          // Numbers only when shares actually arrived. With Shares In = 0 the row would read
          // "0 shares at 0.00 = <the whole cost>", which is incoherent on its face; the
          // warning row below carries the amount instead.
          ...(ev.sharesIn > 0
            ? { cols: "purchase" as const, qty: ev.sharesIn, rate: ev.cost / ev.sharesIn, amount: ev.cost }
            : {}),
        });

        // GIVING side - a CONTRA line carrying only the cost that LEFT, signed negative.
        //
        // It deliberately has NO quantity. A demerger moves cost, not shares: the parent still
        // holds every share it held before. Printing the restated POSITION here instead
        // (24,000 @ 454.85) put a second 24,000 into the very column that already held the
        // purchase it was restating, so the column read as two positions and twice the cost.
        // A signed adjustment sums correctly - 15,858,000 + (-4,941,710.76) is exactly the
        // basis the sale below is measured against.
        const remQty = lots.reduce((sum, l) => sum + Math.max(0, l.remaining), 0);
        block(ev.fromKey).corpNotes.push({
          ts: ev.ts,
          text: `${kind} → ${ev.to} (${fmtDate(ev.ts)})`,
          // A merger empties the target: its whole basis leaves with the shares, so there is
          // no surviving position for a contra line to adjust - label only.
          ...(remQty > 1e-9 ? { cols: "holding" as const, amount: -ev.cost } : {}),
        });

        // Cost out with no shares in is a DATA ERROR that destroys value: the parent's basis
        // is reduced and nothing is credited anywhere, so the amount simply leaves the
        // portfolio. The engine cannot repair it (only the sheet knows the real share count),
        // but it must never pass silently through a tax document.
        if (ev.cost > 0 && !(ev.sharesIn > 0)) {
          const warn = `⚠ ${kind} DATA ERROR: Shares In is 0 on the ${CORP_ACTIONS_TAB} row `
            + `(${fmtDate(ev.ts)} ${ev.from} → ${ev.to}). ${fmtAmt(ev.cost)} of cost was removed `
            + `from ${ev.from} and credited to NO security. Capital gains on both are wrong until fixed.`;
          block(ev.fromKey).corpNotes.push({ ts: ev.ts, text: warn });
          block(ev.toKey).corpNotes.push({ ts: ev.ts, text: warn });
          console.warn(`Capital Gains register: ${warn}`);
        }
      }
      continue;
    }

    if (ev.kind === "split") {
      // Subdivide every lot held on the split date: qty ×factor, cost/share ÷factor,
      // acquisition date UNCHANGED (holding period stays continuous). factor derived
      // from the split's added qty over the qty actually held → exact.
      const lots = fifo.get(ev.key) || [];
      const held = lots.reduce((s, l) => s + l.remaining, 0);
      // new:old off the ratio when the row carries one; otherwise the stored added-quantity.
      const addQty = ev.freeRatio ? freeSharesFor("Split", ev.freeRatio, held) : ev.qty;
      if (held > 1e-9 && addQty > 0) {
        const factor = (held + addQty) / held;
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
      // A BONUS carrying a ratio re-derives its share count from the position held on its OWN
      // date, so deleting or editing an earlier buy moves it instead of leaving the number it
      // was born with. Written back onto `t` deliberately and BEFORE anything reads `t.qty`:
      // the lot, the printed purchase row and the transaction statement are all built from it,
      // and each trade is visited exactly once, at the only moment the position is known.
      if (t.freeRatio) {
        const heldNow = (fifo.get(t.key) || []).reduce((s2, l) => s2 + Math.max(0, l.remaining), 0);
        const derived = freeSharesFor(t.rawAction || "Bonus", t.freeRatio, heldNow);
        if (!(derived > 0)) continue;   // a bonus on nothing is nothing
        t.qty = derived;
      }
      const purPrice = t.qty > 0 && t.turnover > 0 ? t.turnover / t.qty : t.avgPrice;
      const inclPrice = t.qty > 0 && t.inclSTT > 0 ? t.inclSTT / t.qty : purPrice;
      const arr = fifo.get(t.key) || [];
      insertLotByTs(arr, { buyTs: t.ts, qty: t.qty, remaining: t.qty, purPrice, inclPrice, charges: t.charges }, (l) => l.buyTs);
      fifo.set(t.key, arr);
      if (inFY) {
        touch(t.key, t.ts);
        if (t.xfer) {
          // A transfer IN is not a purchase - no money changed hands and no consideration
          // was paid. Record it the way a merger is recorded, so the register explains the
          // quantity appearing without inventing a purchase for the year.
          block(t.key).corpNotes.push({
            ts: t.ts,
            text: `TRANSFER IN ${t.qty} ${t.note ? `from ${t.note}` : "from another account"} (${fmtDate(t.ts)})`,
          });
        } else {
          block(t.key).purchases.push({ ts: t.ts, qty: t.qty, avgPrice: t.avgPrice, turnover: t.turnover, charges: t.charges });
        }
      }
    } else {
      // SELL — FIFO-consume; split matched parcels into ST and LT buckets (qty + P/L)
      // by holding days ≥ the long-term threshold (turnover basis), so each bucket becomes
      // its own row. That threshold is 365 days for listed equity but 730 for an UNLISTED
      // (private-equity) company — the concessional listed-share period doesn't apply to
      // unquoted shares. Resolved once per sale, not per lot.
      const lots = fifo.get(t.key) || [];
      if (t.xfer) {
        // TRANSFER OUT — consume the lots FIFO so the shares genuinely leave this book,
        // but emit NO sale row: a transfer realises no capital gain, so it must never
        // reach the register's sales section or the tax computation. Only a note.
        let leftX = t.qty;
        for (const l of lots) {
          if (leftX <= 1e-9) break;
          if (l.remaining <= 1e-9) continue;
          const m = Math.min(l.remaining, leftX);
          l.remaining -= m; leftX -= m;
        }
        if (inFY) {
          touch(t.key, t.ts);
          block(t.key).corpNotes.push({
            ts: t.ts,
            text: `TRANSFER OUT ${t.qty} ${t.note ? `\u2192 ${t.note}` : "to another account"} (${fmtDate(t.ts)})`,
          });
        }
        continue;
      }
      // Null = no decided holding-period rule (a mutual fund, or a bond). The lots must still be
      // consumed - the position moved - but the sale cannot be filed as short or long, so it is
      // recorded as unclassified and left out of both P/L columns. Without this the `>= null`
      // comparison coerces to `>= 0` and every such sale prints as LONG TERM in a tax document.
      const ltDaysOrNull = ltDaysFor(master, t.isin, t.name);
      if (ltDaysOrNull === null) {
        let rem = t.qty;
        for (const l of lots) {
          if (rem <= 1e-9) break;
          if (l.remaining <= 1e-9) continue;
          const m = Math.min(l.remaining, rem);
          l.remaining -= m; rem -= m;
        }
        if (inFY) unclassifiedSales.push({ name: t.name, isin: t.isin, qty: t.qty, ts: t.ts });
        continue;
      }
      const ltDays = ltDaysOrNull;
      const salePrice = t.qty > 0 && t.turnover > 0 ? t.turnover / t.qty : t.avgPrice;
      let left = t.qty, ltQty = 0, ltGain = 0, stQty = 0, stGain = 0;
      for (const l of lots) {
        if (left <= 1e-9) break;
        if (l.remaining <= 1e-9) continue;
        const m = Math.min(l.remaining, left);
        const gain = r2(m * salePrice) - r2(m * l.purPrice);
        if (daysBetween(l.buyTs, t.ts) >= ltDays) { ltQty += m; ltGain += gain; } else { stQty += m; stGain += gain; }
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

  // ── 4b. Intraday round-trips (matched same-day qty) go into their OWN blocks. ──
  // They used to be pushed into the same per-scrip block as the delivery activity, which is
  // why the single tab mixed the two. Building a SEPARATE map is what keeps them apart: it
  // is structural, not a filter, so an intraday row cannot reach the delivery tab even by
  // accident. That matters most for the round-trip's PURCHASE row, which carries no tax
  // bucket of its own — a filter written over `category` alone would leave it (and its
  // brokerage) on both tabs and double-count the charge.
  //
  // The residual (unmatched) quantity was already routed into the delivery FIFO above, with
  // the complementary fraction of the day's charges, so a partial round trip splits across
  // the two tabs and still sums to what the note charged.
  const intraBlocks = new Map<string, Block>();
  for (const rt of intradayRTs) {
    if (rt.ts < fyStartTs || rt.ts >= fyEndExclTs) continue;
    let ib = intraBlocks.get(rt.key);
    if (!ib) {
      ib = { key: rt.key, name: nameByKey.get(rt.key) || rt.key, purchases: [], sales: [], splits: [], corpNotes: [], opening: [], closing: [], firstTs: Infinity };
      intraBlocks.set(rt.key, ib);
    }
    if (rt.ts < ib.firstTs) ib.firstTs = rt.ts;
    ib.purchases.push({ ts: rt.ts, qty: rt.qty, avgPrice: rt.buyPrice, turnover: rt.buyPrice * rt.qty, charges: rt.buyCharges });
    ib.sales.push({ ts: rt.ts, qty: rt.qty, avgPrice: rt.sellPrice, turnover: rt.sellPrice * rt.qty, charges: rt.sellCharges, category: "INTRA", pnl: r2((rt.sellPrice - rt.buyPrice) * rt.qty) });
  }

  // ── 5. Emit rows ──
  /**
   * Build one tab's payload. Everything it accumulates — the rows, the charge and P/L
   * totals, the scrip serial, and every row-index the painter needs — is LOCAL to this
   * call. That is deliberate: these were function-scoped when there was one tab, and
   * running the emission twice over shared accumulators would double the GRAND TOTAL.
   */
  interface Emission {
    values: any[][]; plBandEnd: number; expStart: number; expEnd: number;
    closingRanges: { start: number; end: number }[];
    grand: Charges; grandPnl: Partial<Record<PlKey, number>>;
    scrips: number; buyRows: number; sellRows: number;
  }
  const emitTab = (L: Layout, activeBlocks: Block[], caption: string, expenseLabel: string): Emission => {
      const { COL, blankRow } = L;
      const active = activeBlocks
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));   // scrip-wise, alphabetical

      const out: any[][] = [];
      // title + group header + column header
      const titleRow = blankRow(); titleRow[COL.name] = caption; out.push(titleRow);
      const grp = blankRow();
      grp[COL.oDate] = "OPENING STOCK"; grp[COL.pDate] = "PURCHASE"; grp[COL.sDate] = "SALES";
      for (const pc of L.plCols) grp[pc.col] = pc.label;
      out.push(grp);
      out.push(L.headers);

      const grand: Charges = { ...ZERO_CHARGES };
      // Seeded from the VARIANT, not with all three buckets: a bucket that cannot appear on
      // this tab must stay absent, so a leak shows up as an undefined rather than a 0.
      const grandPnl: Partial<Record<PlKey, number>> = Object.fromEntries(L.plKeys.map((k) => [k, 0]));
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

      // Where a RESTATEMENT line belongs. A split or a corporate action creates no new cost -
    // it restates cost that is already on the page - so it prints in the same column family
    // where that cost was last stated:
    //   bought during this year  → the PURCHASE columns
    //   carried in from before   → the OPENING STOCK columns
    // Putting an in-year purchase's restated basis under OPENING STOCK reads as if the
    // shares had been held at FY start, and for a scrip bought and demerged in the same year
    // (Tata Motors Passenger Vehicles, Oct-2025) it looked like a second, phantom position.
    // A block with both keeps PURCHASE: that is the more recent statement of the cost.
    const restateCols = (blk: Block) => (blk.purchases.length
      ? { d: COL.pDate, q: COL.pQty, r: COL.pRate, a: COL.pAmt }
      : { d: COL.oDate, q: COL.oQty, r: COL.oRate, a: COL.oAmt });

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
      // unchanged total cost), labelled "SPLIT" and placed by the restatement rule above.
      for (const sp of [...b.splits].sort((x, y) => x.ts - y.ts)) {
        const row = blankRow();
        row[COL.name] = "SPLIT";
        const rc = restateCols(b);
        row[rc.d] = fmtDate(sp.ts); row[rc.q] = sp.qty;
        row[rc.r] = r6(sp.rate); row[rc.a] = r2(sp.amount);
        out.push(row);
      }

      // PURCHASES (chronological)
      for (const p of [...b.purchases].sort((x, y) => x.ts - y.ts)) {
        buyRows++;
        const row = blankRow();
        row[COL.pDate] = fmtDate(p.ts); row[COL.pQty] = p.qty;
        row[COL.pRate] = r6(p.avgPrice); row[COL.pAmt] = r2(p.turnover);
        chargeCells(row, cgCharges(b.key, p.charges));
        out.push(row);
      }

      // Corporate-action notes. Placed BETWEEN purchases and sales, not after them: a
      // demerger-in funds the sale below it, and a demerger-out reduces the basis that same
      // sale is measured against. Printed after the sales they explain, both read backwards.
      for (const cn of [...b.corpNotes].sort((x, y) => x.ts - y.ts)) {
        // The label gets a row of its OWN, with every other cell empty, so Sheets lets it
        // overflow and the whole sentence stays readable. Putting the label and the figures
        // on one row clips it at the SCRIPT NAME column - which hid the very number the
        // line exists to disclose ("cost out ...") behind a truncated "DEMERGER →".
        const label = blankRow();
        label[COL.name] = cn.text;
        out.push(label);
        if (!cn.cols) continue;
        const row = blankRow();
        // "purchase" is an ACQUISITION (the receiving side of a merger/demerger — the shares
        // arrive this year, so it is always a purchase). "holding" is a RESTATEMENT of the
        // giving side's surviving position, which follows restateCols.
        const rc = cn.cols === "purchase"
          ? { d: COL.pDate, q: COL.pQty, r: COL.pRate, a: COL.pAmt }
          : restateCols(b);
        row[rc.d] = fmtDate(cn.ts);
        // A contra line has no quantity and no rate, only a signed amount. Writing zeros
        // would read as "0 shares at 0.00" and, worse, would put a second quantity into a
        // column that is meant to sum to the position.
        if (cn.qty !== undefined) row[rc.q] = cn.qty;
        if (cn.rate !== undefined) row[rc.r] = r6(cn.rate);
        row[rc.a] = r2(cn.amount || 0);
        out.push(row);
      }

      // SALES — one row per tax bucket per date; intra-day first, then short, then long.
      const catOrder = (c: "INTRA" | "ST" | "LT") => (c === "INTRA" ? 0 : c === "ST" ? 1 : 2);
      for (const s of [...b.sales].sort((x, y) => (x.ts - y.ts) || (catOrder(x.category) - catOrder(y.category)))) {
        sellRows++;
        const row = blankRow();
        row[COL.sDate] = fmtDate(s.ts); row[COL.sQty] = s.qty;
        row[COL.sRate] = r6(s.avgPrice); row[COL.sAmt] = r2(s.turnover);
        // plCol throws if this bucket has no column on this tab, which means a row was routed
        // to the wrong one. Refusing is the point: writing to a column that does not exist
        // would drop the figure and still produce a finished-looking tax tab.
        if (s.pnl) row[L.plCol(s.category)] = s.pnl;
        const bk = BUCKET_PL[s.category];
        if (grandPnl[bk] === undefined) throw new Error(`Register bug: a ${s.category} sale reached the ${L.id} tab.`);
        grandPnl[bk]! += s.pnl;
        chargeCells(row, cgCharges(b.key, s.charges));
        out.push(row);
      }

      // CLOSING consolidated date-wise + subtotal (record the span so it shades green).
      // Skipped entirely on the intra-day tab: a same-day round trip holds nothing
      // overnight, so a "CLOSING NIL" line under every scrip is noise, not information.
      // The position itself is reported on the delivery tab, which keeps a scrip whose only
      // in-FY trade was intraday precisely so its opening and closing stay visible.
      if (L.id === "DELIVERY") {
        const closeAgg = consolidateByDate(b.closing);
        const closeStart = out.length;
        if (closeAgg.length) {
          closeAgg.forEach((a, i) => out.push(aggRow(a, i === 0 ? "CLOSING" : undefined)));
          if (closeAgg.length > 1) out.push(aggSubtotal(closeAgg));
        } else {
          const row = blankRow(); row[COL.name] = "CLOSING"; row[COL.oAmt] = "NIL"; out.push(row);
        }
        closingRanges.push({ start: closeStart, end: out.length });
      }

      out.push(blankRow());   // spacer between scrips
    }

    // GRAND TOTAL of P&L (per bucket) + charges
    const gt = blankRow(); gt[COL.name] = "GRAND TOTAL";
    for (const pc of L.plCols) gt[pc.col] = r2(grandPnl[pc.key] || 0) || "";
    gt[COL.brok] = r2(grand.brok); gt[COL.stt] = r2(grand.stt); gt[COL.gst] = r2(grand.gst);
    gt[COL.et] = r2(grand.et); gt[COL.stamp] = r2(grand.stamp); gt[COL.sebi] = r2(grand.sebi);
    gt[COL.ipf] = r2(grand.ipf); gt[COL.dmat] = r2(grand.dmat);
    out.push(gt);

    // Row after GRAND TOTAL — the lime P/L colour band stops here. The expense summary
    // below isn't part of the per-scrip P/L grid, so it shouldn't carry the P/L stripe.
    const plBandEnd = out.length;

    // ── 5b. Expense-summary footer — this tab's own charges, nothing else. ──
    // Before the split this footer carried BOTH lines and derived the delivery figure by
    // subtracting intraday from the grand total. Now each tab accumulates only its own rows,
    // so `grand` IS this tab's expense total and the subtraction is gone with it — one less
    // way for the two halves to disagree. The reconciliation moved to the caller, where it can
    // be checked against the SOURCE trades rather than against the rows we just emitted.
    const chargeSum = (c: Charges) => c.brok + c.stt + c.gst + c.et + c.dmat + c.stamp + c.sebi + c.ipf;
    // Zeros show as 0.00 (as in the source), not blank — the columns line up under GRAND TOTAL
    // exactly. The label sits in the LAST P/L column, immediately left of the charge
    // breakdown: that is COL.lt on the delivery tab and COL.intra on the intraday one, which
    // is why it is addressed as `L.lastPl` and never by name.
    const expenseRow = (label: string, c: Charges): any[] => {
      const row = blankRow();
      row[L.lastPl] = label;
      row[COL.brok] = r2(c.brok); row[COL.stt] = r2(c.stt); row[COL.gst] = r2(c.gst);
      row[COL.et] = r2(c.et); row[COL.dmat] = r2(c.dmat); row[COL.stamp] = r2(c.stamp);
      row[COL.sebi] = r2(c.sebi); row[COL.ipf] = r2(c.ipf);
      return row;
    };
    const totalRow = (c: Charges): any[] => {
      const row = blankRow();
      row[L.lastPl] = "Total";
      row[COL.brok] = r2(chargeSum(c));   // summed figure under the Brok column, beneath the breakdown
      return row;
    };
    out.push(blankRow());   // spacer under GRAND TOTAL
    const expStart = out.length;
    out.push(expenseRow(expenseLabel, grand));
    out.push(totalRow(grand));
    const expEnd = out.length;

    return {
      values: out, plBandEnd, expStart, expEnd, closingRanges,
      grand, grandPnl, scrips: active.length, buyRows, sellRows,
    };
  };

  // ── 6+7. Write one tab: locate/create it, replace its values, repaint it. ──
  // Extracted so it can run once per tab. Everything it needs is an argument: nothing here
  // may close over the caller's `sheetId`, `out` or column indices, because the two tabs
  // have different widths and different sheetIds and a leaked binding would paint one tab
  // with the other's geometry.
  const writeAndPaint = async (L: Layout, tabName: string, legacyTabs: string[], em: Emission) => {
    const { COL } = L;
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
    // A:Z is 26 columns — deliberately WIDER than either layout (25 / 24). A previous run
    // wrote 26, so a clear narrowed to the current width would strand last year's IPF
    // figures in the orphaned right-hand column of a tax document.
    await withBackoff(() => (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tabName}!A:Z` }));
    await withBackoff(() => (gapi.client as any).sheets.spreadsheets.values.update({
      spreadsheetId, range: `${tabName}!A1`, valueInputOption: "USER_ENTERED", resource: { values: em.values },
    }));

    // ── Indian comma formatting + header styling (matches the source's look) ──
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
    if (sheetId === undefined || sheetId === null) {
      // Previously this silently skipped the whole paint INCLUDING the reset, so a tab that
      // lost its id kept the last run's bands over new values with no warning anywhere.
      console.warn(`Capital Gains: no sheetId for "${tabName}" — values written, formatting skipped (old bands may be stale).`);
      return;
    }
    try {
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

      // Background colour bands matching the accountant's sheet. The P/L block is addressed
      // as firstPl..COL.brok rather than by bucket name — it is two columns wide on the
      // delivery tab and one on the intraday tab.
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
      requests.push(
        fill(1, 3, COL.sno, COL.oDate, GREEN),     // S.No + Script Name band (rows 2–3)
        fill(1, 3, COL.oDate, COL.pDate, ORANGE),  // OPENING STOCK band
        fill(1, 3, COL.pDate, COL.sDate, GREEN),   // PURCHASE band
        fill(1, 3, COL.sDate, L.firstPl, SALMON),  // SALES band
        fill(1, 3, L.firstPl, COL.brok, GREEN),    // P/L header band
        fill(1, 3, COL.brok, L.WIDTH, GREEN),      // charge-column header band (Brok…IPF)
        fill(3, em.plBandEnd, L.firstPl, COL.brok, LIME),  // P/L columns shaded down the DATA only (stops above the expense footer)
      );
      for (const cr of em.closingRanges) requests.push(fill(cr.start, cr.end, COL.name, COL.pDate, LIME));   // CLOSING rows (B–F)
      // Expense-summary footer (label + Total): green label cells + bold labels, sitting in
      // the LAST P/L column just left of the charge breakdown.
      requests.push(
        fill(em.expStart, em.expEnd, L.lastPl, L.lastPl + 1, LIME),
        {
          repeatCell: {
            range: { sheetId, startRowIndex: em.expStart, endRowIndex: em.expEnd, startColumnIndex: L.lastPl, endColumnIndex: L.lastPl + 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold",
          },
        },
      );

      await withBackoff(() => (gapi.client as any).sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } }));
    } catch (e) {
      console.warn(`Capital Gains formatting failed for "${tabName}" — stripping old paint so stale bands don't mislead:`, e);
      try {
        await (gapi.client as any).sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests: [resetRequest] } });
      } catch { /* values are correct; formatting can be regenerated on the next run */ }
    }
  };


  // ── 7b. Two tabs, one replay. ──
  // Delivery keeps every scrip with in-FY delivery activity. It ALSO keeps a scrip whose only
  // in-FY trade was an intraday round trip but which carries a position, because that
  // position's OPENING and CLOSING lines are real and belong on the tax tab - dropping the
  // scrip because its trades moved to the other tab would silently delete a holding from a
  // filed document.
  const deliveryActive = [...blocks.values()].filter(b =>
    (b.purchases.length || b.sales.length || b.corpNotes.length || b.splits.length
      || (intraBlocks.has(b.key) && (b.opening.length || b.closing.length)))
    // A class with NO holding-period rule appears on no capital-gains tab at all - its
    // PURCHASES included, not just its sales. Leaving the purchases on meant their charges
    // reached `delivery.grand` while the guard excluded the scrip from `expect`, and the
    // register refused to write; see fixture E and `hasRule` below. Its transactions are
    // still reported, on that class's own transaction statement.
    && keyHasLtRule(b.key));
  const intradayActive = [...intraBlocks.values()];

  /**
   * Capital gains, split by asset class - LISTED on the historic tab, each non-listed class on
   * its own. Splitting is not cosmetic: PE and AIF are off-market, long-term at 730 days and
   * bear no STT, so they are taxed on a different footing from listed equity and a preparer
   * cannot separate them out of a commingled table.
   *
   * A sale lands on exactly ONE of these, which is why PE MOVES OFF the main tab instead of
   * being copied to a second one - two tabs carrying the same gain is a double count that
   * nothing downstream could detect.
   */
  const listedActive = deliveryActive.filter(b => !classOfKey(b.key));
  const classActive = new Map<AssetClassId, Block[]>();
  for (const b of deliveryActive) {
    const c = classOfKey(b.key);
    if (!c) continue;
    const arr = classActive.get(c) || [];
    arr.push(b);
    classActive.set(c, arr);
  }

  const dL = makeLayout("DELIVERY"), iL = makeLayout("INTRADAY");
  const head = title ? title + " \u2014 " : "";
  const delivery = emitTab(dL, listedActive, `${head}Capital Gains for ${fyLabel}`, "Delivery Expenses");
  const intraday = emitTab(iL, intradayActive, `${head}Intra-Day for ${fyLabel}`, "Intra-day Expenses");
  /**
   * One emission per non-listed class that HAS a rule and HAS activity. Same DELIVERY layout,
   * so the geometry, the painting and the charge columns are identical - only the block set and
   * the caption differ. Reusing `emitTab` is safe because it accumulates into its own `grand`
   * per call; a shared accumulator would double the totals.
   */
  const classCg: { id: AssetClassId; tab: string; em: Emission }[] = [];
  for (const id of ASSET_CLASS_IDS) {
    if (ASSET_CLASSES[id].ltDays === null) continue;      // nothing to compute
    const bl = classActive.get(id);
    if (!bl || !bl.length) continue;
    const label = ASSET_CLASSES[id].label;
    classCg.push({
      id,
      tab: `${label} Capital Gains for ${fyLabel}`,
      em: emitTab(dL, bl, `${head}${label} \u2014 Capital Gains for ${fyLabel}`, "Delivery Expenses"),
    });
  }

  // CHARGE CONSERVATION. Anchored to the SOURCE rows, never to the rows just emitted:
  // `grand` is by definition the sum over emitted rows, so comparing the two tabs' grands to
  // a total derived the same way would be tautological and would pass even if a whole scrip
  // were dropped. This compares against what True Entry actually charged, in the FY window.
  {
    const expect: Charges = { ...ZERO_CHARGES };
    const add = (c: Charges) => {
      expect.brok += c.brok; expect.stt += c.stt; expect.gst += c.gst; expect.et += c.et;
      expect.stamp += c.stamp; expect.sebi += c.sebi; expect.ipf += c.ipf; expect.dmat += c.dmat;
    };
    const inFy = (ts: number) => ts >= fyStartTs && ts < fyEndExclTs;
    /**
     * A scrip whose asset class has no decided holding-period rule appears on NO capital-gains
     * tab - not its sales, and not its purchases either - so its charges must not be EXPECTED
     * on one.
     *
     * Keyed on the CLASS, not on whether the scrip happened to sell this year. It WAS keyed on
     * `unclassifiedSales`, and that was a bug with a narrow, nasty trigger: a fund or bond
     * BOUGHT inside the FY still emitted a PURCHASE row, `chargeCells` put its buy charges into
     * `delivery.grand`, and if it also SOLD that year it was excluded from `expect` - drift in
     * one direction only, so the guard threw and **no register was written at all**. Buying and
     * selling one mutual fund inside a single financial year was enough. A fixture that buys
     * pre-FY cannot reach it, which is exactly why fixture E buys inside the year.
     */
    const hasRule = (isin: string, name: string) => keyHasLtRule(keyOf(isin, name));
    // Same three sources the emission draws from: unpaired trades, the residual legs of a
    // partial round trip, and the round trips themselves. Transfers realise nothing and
    // never reach a purchase or sale row, so their charges are not expected on either tab.
    // Through cgCharges, exactly as the emission is. A charge suppressed on the tabs must not
    // be expected on them - the guard compares the two, and any gap means no register is written.
    for (const t of trades) if (!pairedIdx.has(t.idx) && inFy(t.ts) && !t.xfer && hasRule(t.isin, t.name)) add(cgCharges(t.key, t.charges));
    for (const t of residualTrades) if (inFy(t.ts) && hasRule(t.isin, t.name)) add(cgCharges(t.key, t.charges));
    for (const rt of intradayRTs) if (inFy(rt.ts)) { add(cgCharges(rt.key, rt.buyCharges)); add(cgCharges(rt.key, rt.sellCharges)); }

    const keys: (keyof Charges)[] = ["brok", "stt", "gst", "et", "stamp", "sebi", "ipf", "dmat"];
    // Sums EVERY capital-gains tab, not just the two original ones. Splitting the output by
    // asset class moved charges onto new tabs; a guard still adding only delivery + intraday
    // would see every PE charge as missing and refuse to write the whole register. The
    // transaction statements are deliberately NOT counted here - they restate the same
    // charges as a record of what was transacted, so adding them would double every figure.
    const cgGrand = (k: keyof Charges) =>
      delivery.grand[k] + intraday.grand[k] + classCg.reduce((s, c) => s + c.em.grand[k], 0);
    const drift = keys
      .map(k => ({ k, d: cgGrand(k) - expect[k] }))
      .filter(x => Math.abs(x.d) > 0.01);
    if (drift.length) {
      // Refuse rather than file. A charge that is on neither tab, or on both, is a wrong
      // expense claim - and nothing downstream can detect it once the tabs are written.
      throw new Error(
        "Register not written: delivery + intra-day charges do not reconcile to True Entry ("
        + drift.map(x => `${x.k} off by ${fmtAmt(x.d)}`).join(", ")
        + "). This is a bug in the delivery/intra-day split, not in your data.",
      );
    }
  }

  // Empty is a real answer and must still be written: a portfolio that had intraday last
  // run and none this one would otherwise keep the stale tab under the same FY heading.
  if (!intradayActive.length) {
    const r = iL.blankRow();
    r[iL.COL.name] = `No intra-day (same-day round-trip) transactions in ${fyLabel}.`;
    intraday.values.splice(3, 0, r);
  }
  // Same for the LISTED tab, which can now legitimately be empty: a book holding only private
  // equity has no listed transactions at all, and a tab carrying nothing but column headers
  // reads as a failed run rather than as an answer. It also has to say WHERE the figures went,
  // or an empty "Capital Gains" tab beside a populated "Private Equity Capital Gains" tab looks
  // like the split dropped them.
  if (!listedActive.length) {
    const r = dL.blankRow();
    r[dL.COL.name] = classCg.length
      ? `No LISTED transactions in ${fyLabel}. Non-listed holdings are on their own tabs: `
        + classCg.map(c => `"${c.tab}"`).join(", ") + "."
      : `No delivery transactions in ${fyLabel}.`;
    delivery.values.splice(3, 0, r);
  }

  const tabName = `Capital Gains for ${fyLabel}`;
  const intradayTabName = `Intra-Day for ${fyLabel}`;
  // ONLY the delivery tab inherits the legacy names - it is the continuation of the old
  // single tab. Letting both consult the list would have the second write claim the sheet
  // the first just renamed.
  await writeAndPaint(dL, tabName, [`${fyLabel} Transaction Ledger`, `${fyLabel} Trx`], delivery);
  await writeAndPaint(iL, intradayTabName, [], intraday);
  // Per-class capital gains. Sequential, like the two above: these are writes to a shared
  // spreadsheet inside the app's heaviest operation, and Sheets rate-limits per document.
  for (const c of classCg) await writeAndPaint(dL, c.tab, [], c.em);

  // ── 8. FY-end holding snapshot: THREE tabs per FY ──
  // Standalone closing-stock statements — every scrip's lots still held at FY-end (the FIFO
  // state frozen above), with pro-rated buy charges and an all-in "final amount", in the
  // accountant's CSV layout. Built from block.closing. The live "Holding" tab (current
  // holding, refreshed on every import) is separate and untouched.
  //
  // Split by asset class (owner directive 2026-09-14) exactly as the capital-gains tabs
  // already are, and for the same reason: PE is off-market, long-term at 730 days and bears
  // no STT, so it is taxed on a different footing from listed equity and a preparer cannot
  // separate the two out of a commingled table.
  //
  //   "Holding Equity+Intraday …"      listed equity. There is no such thing as an intraday
  //                                    HOLDING — a same-day round trip is squared off and
  //                                    leaves no closing stock — so this is the listed book,
  //                                    named for the book both its trade kinds live in.
  //   "Holding Private Equity Only …"  the PE class alone.
  //   "Holding Combined …"             every class, which is what the single tab always was.
  //
  // AIF / Mutual Fund / Bond holdings appear ONLY on Combined — the owner's decision, taken
  // with the consequence stated. So Equity + PE does NOT foot to Combined whenever the book
  // holds one of those. That shortfall is PRINTED under Combined's grand total rather than
  // left to be discovered: an unexplained difference between two filed statements is the
  // thing nobody can debug six months later.
  //
  // None of these tabs reach `cgGrand`. Like the transaction statements they record what is
  // HELD, not an expense claim, so splitting them cannot move the conservation guard.
  const fyEndYear = fyStartYear + 1;
  const asOn = `as on 31st March ${fyEndYear}`;
  const equityHoldingTab = `Holding Equity+Intraday ${asOn}`;
  const peHoldingTab = `Holding Private Equity Only ${asOn}`;
  const combinedHoldingTab = `Holding Combined ${asOn}`;
  // The headline name stays the COMPLETE statement: every existing consumer of
  // `holdingTabName` means "the holding tab", and pointing it at a partial one would quietly
  // narrow what they report.
  const holdingTabName = combinedHoldingTab;
  // Declared OUT here, like the tab names above, because the whole section-8 block is wrapped
  // in a try/catch that downgrades any failure to a console.warn — so the result must be able
  // to report what was (and was not) written from outside it.
  const itrUnlistedTab = `Unlisted Equity Shares for ${fyLabel}`;
  let itrCompanies = 0;
  let itrMissingPan: string[] = [];
  let itrUnfooted: string[] = [];
  try {
    /**
     * Column geometry. The PRIVATE EQUITY statement carries a PAN column that the other two do
     * not (owner directive 2026-09-14: a preparer needs each unlisted company's PAN beside its
     * holding), so this is a function of the tab rather than a constant — every index after
     * SCRIPT NAME shifts by one. Everything below, the painting included, is written in terms
     * of HC/HW, so there is no second set of numbers that can drift out of step with this one.
     */
    const HEAD_COLS = ["S.No", "SCRIPT NAME", "DATE", "NO OF SHARE", "RATE", "AMOUNT", "Total Brokerage", "STT", "ETC", "SEBI Turnover Fees", "ECC", "Stamp Duty", "IPF", "GST", "final amount"];
    const COMPANY_COLS = ["PAN", "FACE VALUE", "TYPE OF COMPANY"];
    const geom = (withCompanyCols: boolean) => {
      const HC: Record<string, number> = { sno: 0, name: 1 };
      let i = 2;
      if (withCompanyCols) { HC.pan = i++; HC.faceValue = i++; HC.companyType = i++; }
      for (const k of ["date", "qty", "rate", "amt", "brok", "stt", "et", "sebi", "ecc", "stamp", "ipf", "gst", "final"]) HC[k] = i++;
      const header = withCompanyCols ? [...HEAD_COLS.slice(0, 2), ...COMPANY_COLS, ...HEAD_COLS.slice(2)] : HEAD_COLS.slice();
      return { HC, HW: i, header };
    };

    /**
     * The company attributes the PE statement prints beside the name, from its asset-class tab
     * in the shared scrip master. ONE lookup for all three — asked once per HELD scrip on one
     * tab, unlike `classOfKey` / `sttOffForKey` which are asked once per emitted ROW and are
     * memoised for it, so a plain lookup is the right cost here.
     *
     * A missing value is "" rather than 0: a face value of zero is not a fact about the
     * company, it is the absence of one, and printing 0.00 on a statement asserts otherwise.
     */
    const companyColsOfKey = (key: string): (string | number)[] => {
      const e = lookupScrip(master, isinByKey.get(key) || "", nameByKey.get(key) || key).entry;
      return [e?.pan || "", e?.faceValue > 0 ? e.faceValue : "", e?.companyType || ""];
    };
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

    // ALL held scrips (incl. opening-only, untraded-in-FY) — a holding statement, not the
    // in-FY-activity filter the Capital Gains tab uses.
    const heldAll = [...blocks.values()].filter(b => b.closing.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    const heldListed = heldAll.filter(b => !classOfKey(b.key));
    const heldPe = heldAll.filter(b => classOfKey(b.key) === "PE");
    const heldOther = heldAll.filter(b => { const c = classOfKey(b.key); return !!c && c !== "PE"; });

    // ── The ITR unlisted-equity-shares schedule's inputs ──────────────────────────────────
    //
    // Built from `blocks` DIRECTLY, not from `heldAll` / `heldPe`: those filter on
    // `closing.length > 0`, and a company SOLD OUT during the year is exactly what this
    // schedule must still report ("held at any time during the previous year"). Such a block
    // survives in `blocks` with its opening and sales populated and an empty closing.
    //
    // And `intraBlocks` is folded in, which is not obvious and is the one way this tab could
    // have been silently short. The same-day matcher groups purely on `key|ts` with NO
    // asset-class and no intraday-flag test, then removes the WHOLE day's rows for that scrip
    // from the delivery replay. So an unlisted company bought and sold on one date — an
    // off-market secondary settled same-day — loses its acquisition row AND its transfer row,
    // while opening and closing stay untouched, so the schedule still foots perfectly with a
    // year's activity missing from it. Reading both maps is the fix; the matcher itself is left
    // alone because changing it would move capital-gains figures.
    const sumLotQty = (ls: LotSnap[]) => ls.reduce((s, l) => s + l.qty, 0);
    const sumLotCost = (ls: LotSnap[]) => ls.reduce((s, l) => s + l.qty * turnoverPrice(l), 0);
    const chargedLot = (c: Charges) =>
      c.brok + c.stt + c.gst + c.et + c.stamp + c.sebi + c.ipf + c.dmat > 0.005;

    const itrKeys = new Set<string>();
    for (const b of blocks.values()) {
      if (classOfKey(b.key) !== "PE") continue;
      if (b.opening.length || b.purchases.length || b.sales.length || b.closing.length) itrKeys.add(b.key);
    }
    for (const k of intraBlocks.keys()) if (classOfKey(k) === "PE") itrKeys.add(k);

    const itrCompanyInputs: ItrCompanyInput[] = [...itrKeys].map((key) => {
      const b = blocks.get(key);
      const ib = intraBlocks.get(key);
      const e = lookupScrip(master, isinByKey.get(key) || "", nameByKey.get(key) || key).entry;
      const purchases = [...(b?.purchases || []), ...(ib?.purchases || [])];
      const sales = [...(b?.sales || []), ...(ib?.sales || [])];
      return {
        // The scrip master's own spelling. `b.name` is the LONGEST ledger/broker spelling,
        // which on an unlisted company is whatever the counterparty's paperwork said — not a
        // name to file under.
        name: e?.canonicalName || nameByKey.get(key) || key,
        pan: e?.pan || "",
        companyType: e?.companyType || "",
        faceValue: e?.faceValue > 0 ? e.faceValue : 0,
        openingQty: sumLotQty(b?.opening || []),
        openingCost: sumLotCost(b?.opening || []),
        acquisitions: purchases.map(p => ({ ts: p.ts, qty: p.qty, turnover: p.turnover })),
        // One sale is pushed as up to THREE parcels (its ST bucket, its LT bucket and any
        // uncovered quantity), so the company's transfer has to be re-aggregated here; there
        // is no single per-company figure anywhere upstream.
        transferredQty: sales.reduce((s, x) => s + x.qty, 0),
        consideration: sales.reduce((s, x) => s + x.turnover, 0),
        closingQty: sumLotQty(b?.closing || []),
        closingCost: sumLotCost(b?.closing || []),
        hasCharges: purchases.some(p => chargedLot(p.charges)),
      };
    });

    // The line that stops Equity + PE ≠ Combined from being a silent discrepancy.
    const otherLabels = [...new Set(heldOther.map(b => ASSET_CLASSES[classOfKey(b.key)!].label))].sort();
    const combinedNote = heldOther.length
      ? `Includes ${heldOther.length} holding(s) in ${otherLabels.join(" / ")}, which appear on NO other holding tab — `
        + `"Holding Equity+Intraday" plus "Holding Private Equity Only" therefore does not add up to this total.`
      : "";

    interface HoldingSheet {
      rows: any[][]; blockRanges: { start: number; end: number }[]; gtRow: number;
      /** This tab's own geometry — the paint pass below must use it, not a shared constant. */
      HC: Record<string, number>; HW: number;
    }
    /**
     * One holding statement. `gTot` is LOCAL to the call on purpose — a shared accumulator
     * would add the Combined tab's total onto the Equity tab's, the same trap `emitTab`
     * carries its own `grand` per call to avoid.
     */
    const buildHolding = (held: Block[], caption: string, note: string, withCompanyCols = false): HoldingSheet => {
      const { HC, HW, header } = geom(withCompanyCols);
      const hRow = (): any[] => new Array(HW).fill("");
      const chCells = (row: any[], c: Charges) => {   // blank a zero charge (matches the source)
        row[HC.brok] = c.brok ? r2(c.brok) : ""; row[HC.stt] = c.stt ? r2(c.stt) : "";
        row[HC.et] = c.et ? r2(c.et) : ""; row[HC.sebi] = c.sebi ? r2(c.sebi) : "";
        row[HC.ecc] = ""; row[HC.stamp] = c.stamp ? r2(c.stamp) : "";
        row[HC.ipf] = c.ipf ? r2(c.ipf) : ""; row[HC.gst] = c.gst ? r2(c.gst) : "";
      };
      const out: any[][] = [];
      const t0 = hRow(); t0[HC.name] = caption; out.push(t0);
      const t1 = hRow(); t1[HC.date] = `CLOSING STOCK-31.03.${fyEndYear}`; out.push(t1);
      out.push(header);

      let hsno = 0;
      const gTot = { amt: 0, ch: { ...ZERO_CHARGES } };
      const blockRanges: { start: number; end: number }[] = [];   // green A:F band per scrip (excl. spacer)
      for (const b of held) {
        hsno++;
        const aggs = consolidate(b.closing);
        const bStart = out.length;
        // Identity row: S.No + name, and on the PE statement the company's PAN, face value and
        // type beside it. They belong HERE and not on the lot rows below — those are
        // per-acquisition-date lines, and a company attribute repeated down them would read as
        // a per-lot one.
        const head0 = hRow(); head0[HC.sno] = hsno; head0[HC.name] = b.name;
        if (withCompanyCols) {
          const [pan, fv, ctype] = companyColsOfKey(b.key);
          head0[HC.pan] = pan; head0[HC.faceValue] = fv; head0[HC.companyType] = ctype;
        }
        out.push(head0);
        aggs.forEach((a, i) => {
          const row = hRow();
          if (i === 0) row[HC.name] = "CLOSING";   // first held-lot row carries the CLOSING label
          row[HC.date] = a.dateStr; row[HC.qty] = a.qty;
          row[HC.rate] = a.qty > 0 ? r6(a.amt / a.qty) : ""; row[HC.amt] = r2(a.amt);
          chCells(row, a.ch); row[HC.final] = r2(a.amt + exclSTT(a.ch));
          gTot.amt += a.amt; gTot.ch = addCharges(gTot.ch, a.ch);
          out.push(row);
        });
        if (aggs.length > 1) {   // per-scrip subtotal (qty · amount · final)
          const sub = hRow();
          sub[HC.qty] = aggs.reduce((s, a) => s + a.qty, 0);
          sub[HC.amt] = r2(aggs.reduce((s, a) => s + a.amt, 0));
          sub[HC.final] = r2(aggs.reduce((s, a) => s + a.amt + exclSTT(a.ch), 0));
          out.push(sub);
        }
        blockRanges.push({ start: bStart, end: out.length });   // name row → subtotal (before the spacer)
        out.push(hRow());   // spacer between scrips
      }
      // Empty is a real answer and must still be SAID. A book that held PE last year and none
      // this year would otherwise get a tab carrying nothing but headers, which reads as a
      // failed run rather than as "no private equity held".
      if (!held.length) {
        const none = hRow(); none[HC.name] = `Nothing held under this heading as on 31st March ${fyEndYear}.`;
        out.push(none);
        out.push(hRow());
      }
      const gtRow = out.length;
      const gt = hRow();
      gt[HC.name] = "TOTAL HOLDINGS WITHOUT EXPENSES";
      gt[HC.amt] = r2(gTot.amt); chCells(gt, gTot.ch); gt[HC.final] = r2(gTot.amt + exclSTT(gTot.ch));
      out.push(gt);
      if (note) { const n = hRow(); n[HC.name] = note; out.push(n); }
      return { rows: out, blockRanges, gtRow, HC, HW };
    };

    const variants: { tab: string; sheet: HoldingSheet }[] = [
      { tab: equityHoldingTab, sheet: buildHolding(heldListed, `${head}Holding (Equity + Intra-Day) ${asOn}`, "") },
      { tab: peHoldingTab, sheet: buildHolding(heldPe, `${head}Holding (Private Equity only) ${asOn}`, "", true) },
      { tab: combinedHoldingTab, sheet: buildHolding(heldAll, `${head}Holding (Combined) ${asOn}`, combinedNote) },
    ];

    // The ITR schedule is a SIBLING of the three holding tabs, not a fourth entry in `variants`.
    // `geom()` parameterises COLUMNS, but every row index in the paint pass below is a shared
    // constant — bold(0,3), the three fill bands, numFmt(startRowIndex: 3) and frozenRowCount 3
    // — and this tab has banners on rows 1-2, its header on row 4 and data from row 5. Reusing
    // the variant machinery would paint the wrong bands and freeze the wrong rows. It still
    // shares the single `spreadsheets.get` above and the single paint `batchUpdate` below,
    // which is the part that costs quota.
    const itrTab = itrUnlistedTab;
    const itrSheet = buildItrUnlistedSchedule(itrCompanyInputs, {
      title: `${head}Details of Unlisted Equity Shares held at any time during ${fyLabel}`,
      subtitle: "Cost of acquisition is charge-free turnover — the same basis this app computes "
        + "every capital gain on, so this schedule reconciles to the capital-gains tabs. Every "
        + "acquisition is carried in the ISSUE PRICE column: the app does not record whether a "
        + "purchase was a fresh issue or was bought from an existing shareholder.",
    });

    // ONE metadata read for all three tabs. The single-tab version did a `spreadsheets.get`
    // per tab; three of those sit inside the app's heaviest operation, against a quota of 60
    // reads per minute that nothing counts.
    let props: any[] = [];
    const readProps = async () => {
      const meta: any = await withBackoff(() => (gapi.client as any).sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" }));
      props = (meta?.result?.sheets || []).map((s: any) => s.properties || {});
    };
    await readProps();
    const byTitle = (t: string) => props.find((p: any) => (p.title || "").toString().trim().toLowerCase() === t.trim().toLowerCase());

    // The single commingled tab BECOMES Combined — renamed, never left standing. An orphaned
    // "Holding as on 31st March 2026" sitting beside the new three is last run's numbers under
    // a heading that still looks current, which is the failure the legacy rename on the
    // Transaction Ledger tab already exists to prevent.
    if (!byTitle(combinedHoldingTab)) {
      const legacy = byTitle(`Holding ${asOn}`);
      if (legacy) {
        await withBackoff(() => (gapi.client as any).sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          resource: { requests: [{ updateSheetProperties: { properties: { sheetId: legacy.sheetId, title: combinedHoldingTab }, fields: "title" } }] },
        }));
        legacy.title = combinedHoldingTab;   // keep the local view in step so the create pass skips it
      }
    }
    const missing = [...variants.map(v => v.tab), itrTab].filter(t => !byTitle(t));
    if (missing.length) { await ensureSheetTabs(spreadsheetId, missing); await readProps(); }

    const paint: any[] = [];
    for (const v of variants) {
      const hSheetId = byTitle(v.tab)?.sheetId;
      await withBackoff(() => (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${v.tab}!A:Z` }));
      await withBackoff(() => (gapi.client as any).sheets.spreadsheets.values.update({
        spreadsheetId, range: `${v.tab}!A1`, valueInputOption: "USER_ENTERED", resource: { values: v.sheet.rows },
      }));

      // ── formatting: yellow title/total, green name+holding blocks, orange CLOSING-STOCK band,
      // cream charge-header band, Indian comma number formats. Reset first so stale bands don't
      // bleed (same guard as the Capital Gains tab). Cosmetic — never fails the write.
      if (hSheetId === undefined || hSheetId === null) continue;
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
      const gtRow = v.sheet.gtRow;
      const { HC, HW } = v.sheet;
      paint.push(
        { repeatCell: { range: { sheetId: hSheetId }, cell: { userEnteredFormat: { backgroundColor: WHT, textFormat: { bold: false } } }, fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold" } },
        numFmt(HC.qty, HC.qty + 1, INT),
        numFmt(HC.rate, HC.rate + 1, RATEP),
        numFmt(HC.amt, HW, INR),   // amount + charges + final amount
        bold(0, 3), bold(gtRow, gtRow + 1),
        { updateSheetProperties: { properties: { sheetId: hSheetId, gridProperties: { frozenRowCount: 3 } }, fields: "gridProperties.frozenRowCount" } },
        fill(0, 1, 0, HW, YELLOW),                 // title row (SAGUN CAPITAL / Holding …)
        fill(1, 3, HC.sno, HC.date, GREEN),        // S.No + SCRIPT NAME (+ the company columns on the PE tab) band
        fill(1, 2, HC.date, HC.brok, ORANGE),      // CLOSING STOCK-31.03.YYYY band (row 1: DATE→AMOUNT)
        fill(2, 3, HC.date, HC.brok, GREEN),       // column headers DATE→AMOUNT (row 2)
        fill(1, 3, HC.brok, HW, CREAM),            // charge-column header band
        fill(gtRow, gtRow + 1, 0, HC.brok, YELLOW),// TOTAL HOLDINGS row (label + amount)
      );
      for (const r of v.sheet.blockRanges) paint.push(fill(r.start, r.end, HC.sno, HC.brok, GREEN));   // each scrip's holding block, A→F
    }
    // ── The ITR schedule: values, then its own paint requests into the SAME batch ──────────
    //
    // RAW, not USER_ENTERED. Column H carries dd/mm/yyyy as literal TEXT, and under
    // USER_ENTERED Sheets reparses any such string whose day is <= 12 as US mm-dd and stores a
    // SWAPPED serial — 04/10/2024 would land as 10-Apr-2024 on a filed return. RAW stores each
    // JSON value as it stands: numbers stay numeric, the date strings stay strings.
    {
      itrCompanies = itrSheet.companyCount;
      itrMissingPan = itrSheet.missingPan;
      itrUnfooted = itrSheet.unfooted;
      const itrSheetId = byTitle(itrTab)?.sheetId;
      await withBackoff(() => (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${itrTab}!A:Z` }));
      await withBackoff(() => (gapi.client as any).sheets.spreadsheets.values.update({
        spreadsheetId, range: `${itrTab}!A1`, valueInputOption: "RAW", resource: { values: itrSheet.rows },
      }));
      if (itrSheetId !== undefined && itrSheetId !== null) {
        const HDRFILL = { red: 0.851, green: 0.882, blue: 0.949 };   // FFD9E1F2 — the filed file's own header fill
        const WHITE = { red: 1, green: 1, blue: 1 };
        const rng = (r0: number, r1: number, c0: number, c1: number) =>
          ({ sheetId: itrSheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
        const boldRows = (r0: number, r1: number) => ({
          repeatCell: { range: rng(r0, r1, 0, ITR_WIDTH), cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" },
        });
        // Number formats run from the first DATA row so the header text is never reformatted.
        const fmt = (c0: number, c1: number, pattern: string, type = "NUMBER") => ({
          repeatCell: {
            range: { sheetId: itrSheetId, startRowIndex: ITR_FIRST_DATA_ROW_INDEX, startColumnIndex: c0, endColumnIndex: c1 },
            cell: { userEnteredFormat: { numberFormat: { type, pattern } } },
            fields: "userEnteredFormat.numberFormat",
          },
        });
        // Indian digit grouping, as every other tab this app writes uses. The filed file stores
        // the WESTERN built-ins (#,##0.00) and only RENDERS 25,74,000.00 because that machine's
        // Excel is set to India; copied verbatim into Sheets it would read 2,574,000.00.
        const INR = "#,##,##0.00", INT = "#,##,##0";
        paint.push(
          { repeatCell: { range: { sheetId: itrSheetId }, cell: { userEnteredFormat: { backgroundColor: WHITE, textFormat: { bold: false } } }, fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold" } },
          fmt(ITR_COL.openQty, ITR_COL.openQty + 1, INT),
          fmt(ITR_COL.openCost, ITR_COL.openCost + 1, INR),
          fmt(ITR_COL.acqQty, ITR_COL.acqQty + 1, INT),
          fmt(ITR_COL.acqDate, ITR_COL.acqDate + 1, "@", "TEXT"),
          fmt(ITR_COL.faceValue, ITR_COL.purchasePrice + 1, INR),   // face value + both price columns
          fmt(ITR_COL.xferQty, ITR_COL.xferQty + 1, INT),
          fmt(ITR_COL.consideration, ITR_COL.consideration + 1, INR),
          fmt(ITR_COL.closeQty, ITR_COL.closeQty + 1, INT),
          fmt(ITR_COL.closeCost, ITR_COL.closeCost + 1, INR),
          boldRows(0, ITR_BANNER_ROWS),
          boldRows(itrSheet.totalRowIndex, itrSheet.totalRowIndex + 1),
          {
            repeatCell: {
              range: rng(ITR_HEADER_ROW_INDEX, ITR_HEADER_ROW_INDEX + 1, 0, ITR_WIDTH),
              cell: { userEnteredFormat: { backgroundColor: HDRFILL, textFormat: { bold: true }, wrapStrategy: "WRAP", verticalAlignment: "MIDDLE", horizontalAlignment: "CENTER" } },
              fields: "userEnteredFormat(backgroundColor,textFormat,wrapStrategy,verticalAlignment,horizontalAlignment)",
            },
          },
          { updateSheetProperties: { properties: { sheetId: itrSheetId, gridProperties: { frozenRowCount: ITR_HEADER_ROW_INDEX + 1 } }, fields: "gridProperties.frozenRowCount" } },
        );
        // Banner rows merged A:N, exactly as the filed file has them. `mergeCells` is issued
        // NOWHERE else against the Sheets API in this app (only ExcelJS uses it, in
        // reportXlsx.ts), so this is a new request type here. Unmerge first: a re-run would
        // otherwise merge an already-merged range, and the whole batch is one request — a
        // rejection would strip the formatting off all four tabs at once.
        for (let r = 0; r < ITR_BANNER_ROWS; r++) {
          paint.push({ unmergeCells: { range: rng(r, r + 1, 0, ITR_WIDTH - 1) } });
          paint.push({ mergeCells: { range: rng(r, r + 1, 0, ITR_WIDTH - 1), mergeType: "MERGE_ALL" } });
        }
        ITR_COL_WIDTHS.forEach((w, i) => paint.push({
          updateDimensionProperties: {
            range: { sheetId: itrSheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
            properties: { pixelSize: Math.round(w * 7 + 5) },   // Excel character units -> pixels
            fields: "pixelSize",
          },
        }));
      }
    }

    // One batchUpdate for all four sheets — a request carries its own sheetId, so there is no
    // reason to spend three.
    if (paint.length) {
      try {
        await withBackoff(() => (gapi.client as any).sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests: paint } }));
      } catch (fmtErr) {
        console.warn("Holding tab values written; formatting skipped:", fmtErr);
      }
    }
  } catch (e) {
    console.warn(`Failed to write the holding tabs (the Capital Gains tab is unaffected):`, e);
  }

  // ── 9. Transaction statement, one tab per non-listed class with activity this FY ──
  // "<Label> Transactions for FY..". Built from `trades` rather than from the capital-gains
  // blocks: a no-rule sale never reaches `Block.sales`, so a block-derived statement would omit
  // every mutual-fund and bond SELL - the rows these tabs exist to show.
  const inFyTs = (ts: number) => ts >= fyStartTs && ts < fyEndExclTs;
  const txnTabByClass = new Map<AssetClassId, string>();
  for (const id of ASSET_CLASS_IDS) {
    const mine = trades.filter(t => inFyTs(t.ts) && classOfKey(t.key) === id);
    const mySplits = splitRows.filter(s => inFyTs(s.ts) && classOfKey(s.key) === id);
    if (!mine.length && !mySplits.length) continue;      // no tab for a class this book doesn't trade
    const label = ASSET_CLASSES[id].label;
    const txnTabName = `${label} Transactions for ${fyLabel}`;
    try {
      const xRow = (): any[] => new Array(TXN_WIDTH).fill("");
      // Blank a zero charge, exactly as the capital-gains tabs do - a column of 0.00s reads as
      // "we charged nothing here", a blank reads as "not applicable", and off-market is the
      // second one.
      const xCharges = (row: any[], c: Charges) => {
        row[TX.brok] = c.brok ? r2(c.brok) : ""; row[TX.stt] = c.stt ? r2(c.stt) : "";
        row[TX.gst] = c.gst ? r2(c.gst) : ""; row[TX.et] = c.et ? r2(c.et) : "";
        row[TX.dmat] = c.dmat ? r2(c.dmat) : ""; row[TX.stamp] = c.stamp ? r2(c.stamp) : "";
        row[TX.sebi] = c.sebi ? r2(c.sebi) : ""; row[TX.ipf] = c.ipf ? r2(c.ipf) : "";
      };

      const xout: any[][] = [];
      const x0 = xRow(); x0[TX.name] = `${head}${label} \u2014 Transactions for ${fyLabel}`; xout.push(x0);
      const x1 = xRow(); x1[TX.date] = `TRANSACTIONS ${fyLabel}`; xout.push(x1);
      xout.push(TXN_HDR);

      // Group by scrip, alphabetical, chronological within a scrip - the same reading order as
      // the capital-gains tabs.
      const keys = [...new Set([...mine.map(t => t.key), ...mySplits.map(s => s.key)])]
        .sort((a, b) => (nameByKey.get(a) || a).localeCompare(nameByKey.get(b) || b, undefined,
          { numeric: true, sensitivity: "base" }));

      let xsno = 0;
      const gBuy = { qty: 0, amt: 0, net: 0, ch: { ...ZERO_CHARGES } };
      const gSell = { qty: 0, amt: 0, net: 0, ch: { ...ZERO_CHARGES } };
      for (const key of keys) {
        xsno++;
        const hdr = xRow(); hdr[TX.sno] = xsno; hdr[TX.name] = nameByKey.get(key) || key;
        xout.push(hdr);

        type XLine = { ts: number; type: string; qty: number; rate: number; amt: number;
                       net: number; ch: Charges | null; side: "BUY" | "SELL" | null };
        const lines: XLine[] = [];
        for (const t of mine.filter(t => t.key === key)) {
          // A TRANSFER carries a buy/sell side so the lot queue moves, but no money changed
          // hands - so it is listed (the quantity has to be explained) and excluded from the
          // BUY/SELL money subtotals below.
          const kind = t.xfer ? (t.type === "BUY" ? "TRANSFER IN" : "TRANSFER OUT") : t.type;
          const rate = t.qty > 0 && t.turnover > 0 ? t.turnover / t.qty : t.avgPrice;
          lines.push({
            ts: t.ts,
            type: kind + (t.isIntraday ? " (INTRA-DAY)" : ""),
            qty: t.qty, rate, amt: t.turnover || r2(rate * t.qty),
            net: t.inclSTT || 0,
            ch: t.charges,
            side: t.xfer ? null : t.type,
          });
        }
        // A split restates the holding - no money, no quantity in or out - but a statement that
        // omitted it could not explain why the share count changed.
        for (const s of mySplits.filter(s => s.key === key)) {
          lines.push({ ts: s.ts, type: "SPLIT", qty: s.qty, rate: 0, amt: 0, net: 0, ch: null, side: null });
        }
        lines.sort((a, b) => a.ts - b.ts);

        const sBuy = { qty: 0, amt: 0, net: 0, ch: { ...ZERO_CHARGES } };
        const sSell = { qty: 0, amt: 0, net: 0, ch: { ...ZERO_CHARGES } };
        for (const l of lines) {
          const row = xRow();
          row[TX.date] = fmtDate(l.ts); row[TX.type] = l.type; row[TX.qty] = l.qty;
          if (l.rate) row[TX.rate] = r6(l.rate);
          if (l.amt) row[TX.amt] = r2(l.amt);
          if (l.ch) xCharges(row, l.ch);
          if (l.net) row[TX.net] = r2(l.net);
          xout.push(row);
          if (l.side && l.ch) {
            const acc = l.side === "BUY" ? sBuy : sSell;
            acc.qty += l.qty; acc.amt += l.amt; acc.net += l.net;
            acc.ch = addCharges(acc.ch, l.ch);
          }
        }
        // One subtotal per SIDE, not one per scrip. Adding a buy amount to a sale amount would
        // produce a number that means nothing; bought-vs-sold is the pair that does.
        for (const [lbl, acc] of [["TOTAL BUY", sBuy], ["TOTAL SELL", sSell]] as [string, typeof sBuy][]) {
          if (!acc.qty) continue;
          const sub = xRow();
          sub[TX.type] = lbl; sub[TX.qty] = acc.qty; sub[TX.amt] = r2(acc.amt);
          xCharges(sub, acc.ch); sub[TX.net] = r2(acc.net);
          xout.push(sub);
        }
        gBuy.qty += sBuy.qty; gBuy.amt += sBuy.amt; gBuy.net += sBuy.net; gBuy.ch = addCharges(gBuy.ch, sBuy.ch);
        gSell.qty += sSell.qty; gSell.amt += sSell.amt; gSell.net += sSell.net; gSell.ch = addCharges(gSell.ch, sSell.ch);
        xout.push(xRow());   // spacer between scrips
      }

      for (const [lbl, acc] of [["GRAND TOTAL BUY", gBuy], ["GRAND TOTAL SELL", gSell]] as [string, typeof gBuy][]) {
        const gr = xRow();
        gr[TX.name] = lbl; gr[TX.qty] = acc.qty; gr[TX.amt] = r2(acc.amt);
        xCharges(gr, acc.ch); gr[TX.net] = r2(acc.net);
        xout.push(gr);
      }
      // States the basis, like the report scope notes do. Without it a reader cannot tell
      // whether a transfer or a split was counted into the totals above.
      const note = xRow();
      note[TX.name] = "Transfers and splits are listed but excluded from the BUY / SELL totals — "
        + "a transfer pays no consideration and a split restates an existing holding.";
      xout.push(note);

      await ensureSheetTabs(spreadsheetId, [txnTabName]);
      let xSheetId: number | undefined;
      {
        const meta: any = await withBackoff(() => (gapi.client as any).sheets.spreadsheets.get({
          spreadsheetId, fields: "sheets.properties(sheetId,title)",
        }));
        xSheetId = ((meta?.result?.sheets || []).find((s: any) =>
          (s.properties?.title || "").toString().trim().toLowerCase() === txnTabName.trim().toLowerCase()) || {}).properties?.sheetId;
      }
      // A:Z, wider than the 17 columns written, so a previous run's right-hand cells cannot be
      // stranded beside this one's - the same reason the capital-gains clear uses A:Z.
      await withBackoff(() => (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${txnTabName}!A:Z` }));
      await withBackoff(() => (gapi.client as any).sheets.spreadsheets.values.update({
        spreadsheetId, range: `${txnTabName}!A1`, valueInputOption: "USER_ENTERED", resource: { values: xout },
      }));
      txnTabByClass.set(id, txnTabName);

      // Cosmetic only, and never allowed to fail the run - but a SKIPPED repaint leaves the
      // previous run's bands over fresh values, so old paint is stripped first either way.
      if (xSheetId !== undefined && xSheetId !== null) {
        try {
          const INR = "#,##,##0.00", INT = "#,##,##0", RATE = "#,##,##0.00####";
          const numFmt = (c0: number, c1: number, pattern: string) => ({
            repeatCell: {
              range: { sheetId: xSheetId, startColumnIndex: c0, endColumnIndex: c1 },
              cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern } } },
              fields: "userEnteredFormat.numberFormat",
            },
          });
          const boldRow = (r0: number, r1: number) => ({
            repeatCell: {
              range: { sheetId: xSheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: 0, endColumnIndex: TXN_WIDTH },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat.bold",
            },
          });
          await withBackoff(() => (gapi.client as any).sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            resource: {
              requests: [
                {
                  repeatCell: {
                    range: { sheetId: xSheetId },
                    cell: { userEnteredFormat: { textFormat: { bold: false } } },
                    fields: "userEnteredFormat.textFormat.bold",
                  },
                },
                numFmt(TX.qty, TX.qty + 1, INT),
                numFmt(TX.rate, TX.rate + 1, RATE),
                numFmt(TX.amt, TX.amt + 1, INR),
                numFmt(TX.brok, TX.net + 1, INR),
                boldRow(0, 1), boldRow(2, 3),
                boldRow(xout.length - 3, xout.length - 1),
              ],
            },
          }));
        } catch (fmtErr) {
          console.warn(`"${txnTabName}" values written; formatting skipped:`, fmtErr);
        }
      } else {
        console.warn(`Transaction statement: no sheetId for "${txnTabName}" — values written, formatting skipped.`);
      }
    } catch (e) {
      // One class's statement failing must not lose the capital-gains tabs, which are already
      // written and are the document that matters.
      console.warn(`Failed to write the "${txnTabName}" tab (the capital-gains tabs are unaffected):`, e);
    }
  }

  return {
    tabName, intradayTabName, holdingTabName, fyLabel,
    holdingTabs: { equity: equityHoldingTab, pe: peHoldingTab, combined: combinedHoldingTab },
    itrUnlistedTab, itrCompanies, itrMissingPan, itrUnfooted,
    classTabs: ASSET_CLASS_IDS
      .filter(id => classCg.some(c => c.id === id) || txnTabByClass.has(id))
      .map(id => ({
        id,
        label: ASSET_CLASSES[id].label,
        cgTab: classCg.find(c => c.id === id)?.tab,
        txnTab: txnTabByClass.get(id),
      })),
    // Counts span EVERY tab: the badge reports what the run produced, not one part of it.
    scrips: delivery.scrips + intraday.scrips + classCg.reduce((s, c) => s + c.em.scrips, 0),
    buyRows: delivery.buyRows + intraday.buyRows + classCg.reduce((s, c) => s + c.em.buyRows, 0),
    sellRows: delivery.sellRows + intraday.sellRows + classCg.reduce((s, c) => s + c.em.sellRows, 0),
    unresolved: [...unresolvedMap.values()], master,
    // Counted off the master THIS run loaded, not off the sheet - the whole point is to show
    // what the code saw. `sttOffByKey` only holds keys the emission actually asked about, so
    // its true entries are exactly the scrips whose STT was blanked on a gains tab.
    sttFlaggedInMaster: master.entries.filter((e) => e.sttRemoved).length,
    sttSuppressed: [...sttOffByKey.entries()]
      .filter(([, off]) => off)
      .map(([k]) => nameByKey.get(k) || k)
      .sort((a, b) => a.localeCompare(b)),
    unclassified: unclassifiedSales,
  };
}
