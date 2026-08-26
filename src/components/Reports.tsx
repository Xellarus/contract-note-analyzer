import { useState, useEffect } from 'react';
import { FileBarChart2, ArrowLeft, ArrowRight, Loader2, AlertCircle, Briefcase, CalendarDays, TrendingUp, Receipt, Coins, Layers, X } from 'lucide-react';
import { gapi } from 'gapi-script';
import { computeHoldingsAsOf, HistoricalHolding } from '../lib/holdingsCalc';
import { PORTFOLIOS, Portfolio } from '../lib/portfolios';
import { normName, loadScripMaster, lookupScrip, ScripMaster, SCRIP_MASTER_SPREADSHEET_ID } from '../lib/scripMaster';
import { formatDMY, formatDMMMY, isDateHeader } from '../lib/dates';
import { loadOpeningHoldings } from '../lib/openingHoldings';
import { useVirtualRows } from './ui/useVirtualRows';
import ExportMenu from './ExportMenu';
import type { ReportDoc, ReportCol, ReportRow } from '../lib/reportDoc';
import { inferCols, rowsFromGrid, fileSafe } from '../lib/reportDoc';

type Step = 'home' | 'portfolio' | 'config' | 'result';
type ReportType = 'holding' | 'capgains' | 'transactions' | 'expenses' | 'expenses-detailed';

/**
 * Which asset class a report covers. Listed equity and unlisted (private-equity) companies
 * share one ledger, so a report over a portfolio spans both unless it is narrowed here.
 *
 * `consolidated` is the DEFAULT and is exactly what these reports have always produced — no
 * classification is performed for it, so it cannot be affected by the scrip master being
 * unavailable. The other two are a real restriction on the rows, and every generated file
 * says which one it is (see buildDoc): an equity-only capital-gains statement and a
 * consolidated one are different tax documents and must never be mistaken for each other.
 */
type ReportScope = 'eq' | 'pe' | 'consolidated';

const SCOPES: { key: ReportScope; label: string; hint: string }[] = [
  { key: 'eq', label: 'Equity', hint: 'Listed securities only' },
  { key: 'pe', label: 'Private Equity', hint: 'Unlisted companies only' },
  { key: 'consolidated', label: 'Consolidated', hint: 'Listed and unlisted together' },
];

const SCOPE_LABEL: Record<ReportScope, string> = {
  eq: 'Equity only (listed securities)',
  pe: 'Private equity only (unlisted companies)',
  consolidated: 'Consolidated — listed and unlisted',
};

/** Filename fragment. Consolidated adds nothing, so existing filenames are untouched. */
const SCOPE_TAG: Record<ReportScope, string> = { eq: 'Equity_', pe: 'PrivateEquity_', consolidated: '' };

/** Short qualifier carried into the PDF's running header, the XLSX tab name and the print
 *  footer, so a narrowed report identifies itself on every page and not only on page 1. */
const SCOPE_SLUG: Record<ReportScope, string> = { eq: 'Equity', pe: 'Private Equity', consolidated: '' };

/**
 * The disclosure printed under a narrowed report. It names the BASIS of the split, because the
 * reader of an exported file has no other way to know what "Equity" meant here — the split is
 * not a market fact, it is this book's own Private Equities list.
 */
const SCOPE_NOTE: Record<ReportScope, string> = {
  eq: 'Scope: LISTED securities only. Unlisted companies — those on the “Private Equities” list in the shared scrip master — are excluded from this report.',
  pe: 'Scope: UNLISTED companies only, as listed in the “Private Equities” tab of the shared scrip master. Listed securities are excluded from this report.',
  consolidated: '',
};

/**
 * Unlisted-security membership as two O(1) sets, built ONCE per report run.
 *
 * Not a per-row `isPeScrip`: that calls `lookupScrip`, whose token-subset fallback rescans
 * every master entry (~5,000) for any name it can't match exactly — which on a multi-thousand
 * row ledger is a full scan per row. Same reason `makeScripMatcher` above precomputes.
 *
 * Keyed on `aliasNorms`, i.e. every name an entry is known by, so a company RENAMED in the
 * master still matches the rows written under its old name at import time.
 */
interface PeMembership { names: Set<string>; isins: Set<string>; }
const buildPeMembership = (master: ScripMaster): PeMembership => {
  const names = new Set<string>();
  const isins = new Set<string>();
  for (const e of master.entries) {
    if (!e.isPe) continue;
    for (const a of e.aliasNorms) names.add(a);
    if (e.isin) isins.add(e.isin.trim().toUpperCase());
  }
  return { names, isins };
};
const rowIsPe = (m: PeMembership, name: string, isin: string): boolean => {
  const i = (isin || '').trim().toUpperCase();
  if (i && m.isins.has(i)) return true;
  return m.names.has(normName(name || ''));
};

// A single stock the report should be scoped to (set when the user clicks "Report"
// on a stock's detail page). Portfolio is locked; every report is filtered to it.
export interface StockFocus { portfolioId: string; scripName: string; isin: string; }

// Build a matcher that decides whether a sheet/position row belongs to the focused scrip.
// Priority: (1) exact ISIN when both sides carry one; (2) same CANONICAL entry via the
// scrip master — resolve BOTH the row name and the focus name and compare `entry.key`, so a
// scrip that was RENAMED in the master (its OLD name, still stored in True Entry / LTST from
// the original import, is now an alias of the entry) still matches its rows; (3) exact
// normalized-name equality as a fallback when the master can't resolve a side. `lookupScrip`
// is read-only (no master mutation). Some target tabs (LTST / True Entry) keep no ISIN
// column, so the master-key path is what makes renamed/aliased scrips line up.
type ScripMatcher = (name: string, isin: string) => boolean;
const makeScripMatcher = (master: ScripMaster | null, focus: StockFocus): ScripMatcher => {
  const fn = normName(focus.scripName || '');
  // Resolve the focus scrip ONCE (a single, acceptable token-subset scan) to its entry, then
  // reuse the entry's `aliasNorms` — the set of ALL normalized names it's known by (canonical
  // + every alias, INCLUDING the old name after a rename). Per-row matching is then an O(1)
  // Set/ISIN test — NOT a per-row `lookupScrip`, whose token-subset fallback would rescan all
  // ~5,000 master entries for every row and make a large report crawl.
  const focusEntry = master ? lookupScrip(master, focus.isin || '', focus.scripName || '').entry : null;
  const aliasNorms = focusEntry?.aliasNorms || null;
  const focusIsin = ((focusEntry?.isin || focus.isin || '').trim()).toUpperCase();
  return (name: string, isin: string): boolean => {
    if (focusIsin && (isin || '').trim().toUpperCase() === focusIsin) return true;
    const nk = normName(name || '');
    if (aliasNorms && aliasNorms.has(nk)) return true;   // canonical or any alias (old name incl.)
    return nk === fn;                                    // fallback when the master can't resolve
  };
};

// `scoped` — offers the Equity / Private Equity / Consolidated choice. The two EXPENSE reports
// deliberately don't: they aggregate charges per DATE (the detailed one per date and scrip), and
// a broker's charges are levied on exchange trades, so splitting them by asset class would
// produce a "private equity" expense report that is structurally empty. Left whole.
const REPORTS: { type: ReportType; title: string; desc: string; Icon: typeof FileBarChart2; needsDate: boolean; scoped: boolean }[] = [
  { type: 'holding', title: 'Historical Holding Report', desc: 'Holdings of a portfolio as they stood on any past date — quantity, average cost and invested value.', Icon: FileBarChart2, needsDate: true, scoped: true },
  { type: 'capgains', title: 'Capital Gains Report', desc: 'Realised intraday / short-term / long-term gains per sale (FY25-26 onwards), from the LTST ledger.', Icon: TrendingUp, needsDate: false, scoped: true },
  { type: 'transactions', title: 'Transaction Report', desc: 'Every Buy / Sell recorded in True Entry — the full trade ledger for the portfolio.', Icon: Receipt, needsDate: false, scoped: true },
  { type: 'expenses', title: 'Expense Report', desc: 'Total of each expense (brokerage, STT, GST, charges…) summed per date over the chosen period.', Icon: Coins, needsDate: false, scoped: false },
  { type: 'expenses-detailed', title: 'Detailed Expense Report', desc: 'Total of each expense summed per date and per company (scrip) over the chosen period.', Icon: Layers, needsDate: false, scoped: false },
];

// The expense columns in True Entry, in report order. Each carries the header
// name(s) to look up (Integrated uses "Total GST", the rest "IGST"; IPF/Demat may
// be absent for some brokers → that column just stays blank).
const EXPENSE_COLS: { label: string; names: string[] }[] = [
  { label: 'Brokerage', names: ['Total Brokerage', 'Brokerage'] },
  { label: 'STT', names: ['STT'] },
  { label: 'GST', names: ['IGST', 'Total GST', 'GST'] },
  { label: 'Exchange Chgs', names: ['Exchange Turnover Charges', 'ETC'] },
  { label: 'SEBI', names: ['SEBI Turnover Fees', 'SEBI'] },
  { label: 'Stamp Duty', names: ['Stamp Duty'] },
  { label: 'IPF', names: ['IPF Charges', 'IPF'] },
  { label: 'Demat', names: ['Demat Charges', 'Demat Chrg', 'Demat'] },
];

// Build a date-wise (or date+company-wise) expense report from a True Entry grid.
function buildExpenseReport(vals: any[][], detailed: boolean, fromDate: string, toDate: string, matchScrip?: ScripMatcher | null): { header: string[]; rows: string[][] } {
  const hdr = (vals[0] || []).map((c: any) => (c ?? '').toString().trim());
  const findCol = (...names: string[]) => { for (const n of names) { const i = hdr.indexOf(n); if (i >= 0) return i; } return -1; };
  const dateIdx = findCol('Trade Date', 'Date');
  const nameIdx = findCol('Stock Name', 'Security Name');
  const isinIdx = findCol('ISIN');
  const expIdx = EXPENSE_COLS.map(e => findCol(...e.names));
  const num = (v: any) => { const n = parseFloat((v ?? '').toString().replace(/,/g, '').trim()); return isNaN(n) ? 0 : n; };
  const fromTs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : -Infinity;
  const toTs = toDate ? new Date(`${toDate}T23:59:59`).getTime() : Infinity;

  const groups = new Map<string, { ts: number; dateStr: string; company: string; sums: number[] }>();
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i]; if (!r) continue;
    const dateCell = (r[dateIdx] ?? '').toString().trim();
    const ts = parseCellDate(dateCell);
    if (ts === null || ts < fromTs || ts > toTs) continue;   // a date report needs a dated row in range
    const company = (r[nameIdx] ?? '').toString().trim();
    // Scoped to a single stock → drop every other scrip's rows before summing.
    if (matchScrip && !matchScrip(company, isinIdx >= 0 ? (r[isinIdx] ?? '').toString() : '')) continue;
    const key = detailed ? `${ts}|${company}` : `${ts}`;
    let g = groups.get(key);
    if (!g) { g = { ts, dateStr: dateCell, company, sums: EXPENSE_COLS.map(() => 0) }; groups.set(key, g); }
    expIdx.forEach((ci, k) => { if (ci >= 0) g!.sums[k] += num(r[ci]); });
  }
  const list = [...groups.values()].sort((a, b) => (a.ts - b.ts) || a.company.localeCompare(b.company));

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const fmt = (n: number) => n === 0 ? '' : r2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const header = detailed
    ? ['Date', 'Company', ...EXPENSE_COLS.map(e => e.label), 'Total']
    : ['Date', ...EXPENSE_COLS.map(e => e.label), 'Total'];

  const rows: string[][] = [];
  let prevDate = '';
  for (const g of list) {
    const total = g.sums.reduce((s, x) => s + x, 0);
    const cells = g.sums.map(fmt);
    if (detailed) {
      const d = g.dateStr === prevDate ? '' : g.dateStr;   // blank a repeated date → grouped look
      prevDate = g.dateStr;
      rows.push([d, g.company, ...cells, fmt(total)]);
    } else {
      rows.push([g.dateStr, ...cells, fmt(total)]);
    }
  }
  // Grand total across the whole period.
  if (list.length) {
    const grand = EXPENSE_COLS.map((_, k) => list.reduce((s, g) => s + g.sums[k], 0));
    const grandCells = grand.map(fmt);
    const grandTotal = fmt(grand.reduce((s, x) => s + x, 0));
    rows.push(detailed ? ['TOTAL', '', ...grandCells, grandTotal] : ['TOTAL', ...grandCells, grandTotal]);
  }
  return { header, rows };
}

const todayStr = () => new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const looksNumeric = (s: string) => /^-?[\d,]+(\.\d+)?$/.test(s.trim()) && s.trim().length > 0;

// Parse a sheet date cell (DD/MM/YYYY, DD-MM-YYYY, DD-MMM-YYYY, YYYY-MM-DD) → epoch ms, or null.
const parseCellDate = (s: string): number | null => {
  if (!s) return null;
  const c = s.trim();
  let m = c.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
  m = c.match(/^(\d{1,2})[\/\-]([A-Za-z]+)[\/\-](\d{4})$/);
  if (m) { const mo = new Date(Date.parse(`${m[2]} 1, 2000`)).getMonth(); return new Date(+m[3], mo, +m[1]).getTime(); }
  m = c.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  const t = Date.parse(c); return isNaN(t) ? null : t;
};

export default function Reports({ focus = null, onClearFocus }: { focus?: StockFocus | null; onClearFocus?: () => void }) {
  const [step, setStep] = useState<Step>('home');
  const [reportType, setReportType] = useState<ReportType>('holding');
  // Asset class the report covers. Defaults to consolidated, which is what every report
  // produced before this existed — so a run nobody touched behaves identically.
  const [scope, setScope] = useState<ReportScope>('consolidated');
  // The scope the CURRENT RESULT was actually generated with. The exported file and the result
  // heading label themselves from this, never from `scope` — `scope` is a control, and a control
  // can be moved after a report has been produced. Deriving the label from the picker instead of
  // from the run is how a file ends up stamped "Equity only" over consolidated rows; there is no
  // path today that does it, but the cost of depending on that staying true is a mislabelled tax
  // document, and the cost of not depending on it is this one line.
  const [ranScope, setRanScope] = useState<ReportScope>('consolidated');
  // Distinct company names in the source rows that match NO entry in the scrip master. Those
  // rows cannot be classified, so they fall to "listed" — which is wrong in both directions at
  // once (added to Equity, missing from Private Equity). It is a bounded unknown rather than a
  // detectable error, so the report DISCLOSES the count instead of implying certainty.
  const [unclassified, setUnclassified] = useState(0);
  // The Private Equities list was empty on the run that produced the current result. Only
  // meaningful for an Equity-scoped report, where it means nothing was actually excluded.
  const [emptyPeList, setEmptyPeList] = useState(false);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [asOf, setAsOf] = useState<string>(todayStr());
  const [fromDate, setFromDate] = useState<string>('');     // capital gains / transactions period
  const [toDate, setToDate] = useState<string>(todayStr());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Holding result
  const [positions, setPositions] = useState<HistoricalHolding[]>([]);
  const [totalInvested, setTotalInvested] = useState(0);
  const [tradeRows, setTradeRows] = useState(0);
  // Generic result (capital gains / transactions)
  const [genHeader, setGenHeader] = useState<string[]>([]);
  const [genRows, setGenRows] = useState<string[][]>([]);

  // Virtualize the generic report table once it gets large (thousands of rows).
  const REPORT_VIRTUALIZE_THRESHOLD = 200;
  const genVirtual = genRows.length > REPORT_VIRTUALIZE_THRESHOLD;
  const genVR = useVirtualRows(genVirtual ? genRows.length : 0, { estimatedRowHeight: 33, overscan: 16 });

  const meta = REPORTS.find(r => r.type === reportType)!;
  // The asset-class choice is offered — and applied — only when it can mean something: a report
  // type that spans securities, no single-stock focus (one stock is already one class), and a
  // choice other than Consolidated (which is the unfiltered report and needs no classification).
  const scopeOffered = meta.scoped && !focus;
  const scopeActive = scopeOffered && scope !== 'consolidated';

  // Scoped-to-a-stock mode: lock the portfolio to the stock's account and start on
  // the report picker (the portfolio-choose step is skipped). Clearing focus (e.g.
  // "Show all reports") resets to a normal, unscoped Reports home. Re-runs whenever
  // focus changes — App passes a fresh focus object per stock-Report click.
  useEffect(() => {
    setPortfolio(focus ? (PORTFOLIOS.find(p => p.id === focus.portfolioId) || null) : null);
    setStep('home');
    setError(null);
    setScope('consolidated');
    setPositions([]); setGenHeader([]); setGenRows([]);
  }, [focus]);

  const readTab = async (sheetId: string, range: string): Promise<any[][]> => {
    const res = await (gapi.client as any).sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
    return (res?.result?.values || []) as any[][];
  };

  const generate = async () => {
    if (!portfolio) return;
    if (reportType === 'holding' && !asOf) return;
    setLoading(true);
    setError(null);
    setPositions([]); setGenHeader([]); setGenRows([]);
    try {
      // Both the stock scope and the asset-class scope resolve through the scrip master, so
      // load it once. For a stock-scoped report the master lets a scrip RENAMED in the master
      // (old name now an alias) still match its True Entry / LTST rows, which were written
      // under the old canonical name at import.
      const needsMaster = !!focus || scopeActive;
      let master: ScripMaster | null = null;
      let masterError: string | null = null;
      if (needsMaster) {
        try { master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID); }
        catch (e: any) { masterError = e?.message || 'the shared Scrip Master could not be read'; }
        // A scoped run cannot proceed on a stale failure, and `loadScripMaster` caches for 90
        // seconds — including a master whose Private Equities tab failed to load. So telling the
        // user to "retry" would hand them the identical error for a minute and a half. Re-read
        // once, forced (which bypasses the PE tab's own cache too), on the failure path ONLY, so
        // the extra fetch costs something only where it buys something.
        if (scopeActive && (!master || master.peFailed)) {
          try {
            master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID, { force: true });
            masterError = null;
          } catch (e: any) {
            masterError = e?.message || 'the shared Scrip Master could not be read';
            // The forced read threw, so whatever `master` still holds is the stale first attempt.
            // Report the READ failure rather than falling through to the Private Equities branch
            // and blaming a tab that was never reached.
            master = null;
          }
        }
      }

      // An asset-class scope is a CLASSIFICATION, and it must not be guessed. Without the
      // master — or with its Private Equities tab unreadable — `isPe` is false for everything,
      // which would hand back an "Equity" report quietly containing unlisted holdings, or a
      // "Private Equity" report quietly empty. Both are mislabelled documents that look
      // complete, and these get filed. So refuse, and name the way out: Consolidated needs no
      // classification and is always available.
      if (scopeActive) {
        // Both messages name the CONSEQUENCE, not just the cause: the reader of this error is
        // about to produce a document, and "couldn't read a sheet" doesn't convey that carrying
        // on would mislabel it. Both also name the way through, because Consolidated genuinely
        // always works.
        if (!master) {
          throw new Error(
            `Couldn't read the shared Scrip Master (${masterError}), so listed and unlisted securities can't be told apart — and a ${scope === 'pe' ? 'Private Equity' : 'Equity'} report would be mislabelled. A fresh read was already attempted. Check the connection to Google Sheets, or choose Consolidated (which needs no classification).`,
          );
        }
        if (master.peFailed) {
          throw new Error(
            scope === 'pe'
              ? 'Couldn’t read the "Private Equities" tab of the scrip master, so no company can be identified as unlisted — this report would come back empty and read as though the account holds none. Fix the tab, or choose Consolidated.'
              : 'Couldn’t read the "Private Equities" tab of the scrip master, so every company would be classified as listed — this report would silently include the unlisted holdings it claims to exclude. Fix the tab, or choose Consolidated.',
          );
        }
      }

      const matchScrip: ScripMatcher | null = focus ? makeScripMatcher(master, focus) : null;

      // The asset-class predicate: precomputed sets, one build per run.
      let inScope: ((name: string, isin: string) => boolean) | null = null;
      const unknownNames = new Set<string>();
      let emptyPeList = false;
      if (scopeActive && master) {
        const mem = buildPeMembership(master);
        // An empty list is a FACT here, not a failure: a genuinely absent tab caches as empty
        // and a failed read already threw above. A stated fact beats an empty statement.
        if (mem.names.size === 0 && mem.isins.size === 0) {
          if (scope === 'pe') {
            throw new Error('The scrip master lists no unlisted companies, so a Private Equity report has nothing to cover. Add them to the Private Equities tab, or choose Equity / Consolidated.');
          }
          // Equity scope with an empty list: nothing was excluded. Correct if the list really is
          // empty, and misleading if the tab was renamed (which reads as "absent", not "failed").
          // Disclosed rather than guessed at.
          emptyPeList = true;
        }
        const known = master.byAliasNorm;
        // Memoized per DISTINCT security, not per row. The fast path is the precomputed sets;
        // only a name they miss falls through to `lookupScrip`, whose token-subset and
        // truncation-prefix tiers are what catch a broker-truncated or abbreviated spelling —
        // the same tiers the rest of the app resolves scrips with. Running that per ROW would be
        // a ~5,000-entry scan on every line of a multi-thousand-row ledger; per distinct name it
        // runs a few dozen times. `lookupScrip` is read-only, so the shared cached master is not
        // mutated by generating a report.
        const memo = new Map<string, boolean>();
        inScope = (name: string, isin: string) => {
          const nk = normName(name || '');
          const key = `${(isin || '').trim().toUpperCase()}|${nk}`;
          let pe = memo.get(key);
          if (pe === undefined) {
            pe = rowIsPe(mem, name, isin);
            if (!pe && nk && !known.has(nk)) {
              const e = lookupScrip(master!, isin, name).entry;
              if (e) pe = !!e.isPe;
              else unknownNames.add(nk);   // in no master entry at all → treated as listed
            }
            memo.set(key, pe);
          }
          return scope === 'pe' ? pe : !pe;
        };
      }
      if (reportType === 'holding') {
        const asOfTs = new Date(`${asOf}T23:59:59`).getTime();
        const res = await computeHoldingsAsOf(portfolio.sheetId, asOfTs);
        let positions = res.positions;
        if (matchScrip) positions = positions.filter(p => matchScrip!(p.securityName, p.isin));
        if (inScope) positions = positions.filter(p => inScope!(p.securityName, p.isin));
        setPositions(positions);
        // Any filter at all → the total must be re-summed from what's left, or the footer would
        // report the whole portfolio's cost against a subset of its rows.
        setTotalInvested((matchScrip || inScope) ? positions.reduce((s, p) => s + p.invested, 0) : res.totalInvested);
        setTradeRows(res.tradeRows);
      } else if (reportType === 'expenses' || reportType === 'expenses-detailed') {
        const vals = await readTab(portfolio.sheetId, 'True Entry!A:Z');
        if (vals.length < 2) throw new Error("No transactions found in True Entry — import a contract note or transaction report first.");
        const { header, rows } = buildExpenseReport(vals, reportType === 'expenses-detailed', fromDate, toDate, matchScrip);
        setGenHeader(header);
        setGenRows(rows);
      } else {
        const range = reportType === 'capgains' ? 'LTST!A:Z' : 'True Entry!A:T';
        const vals = await readTab(portfolio.sheetId, range);
        if (vals.length < 1) {
          throw new Error(reportType === 'capgains'
            ? "No capital-gains data found. Import trades (capital gains sync automatically) or run Sync Capital Gains."
            : "No transactions found in True Entry — import a contract note or transaction report first.");
        }
        const header = (vals[0] || []).map((c: any) => (c ?? '').toString());
        let body = vals.slice(1)
          .filter(r => (r || []).some((c: any) => (c ?? '').toString().trim() !== ''))
          .map(r => header.map((_, i) => ((r as any[])?.[i] ?? '').toString()));

        // Transaction Report: prepend the carried-in opening lots as "Opening Buy" rows so
        // the ledger starts from the real opening position rather than the first FY26 trade.
        // (The Trade Book on a stock's detail page already seeds these; the report did not.)
        // They then flow through the same date + stock-scope filters as the True Entry rows.
        if (reportType === 'transactions') {
          try {
            const opening = await loadOpeningHoldings(portfolio.sheetId);
            if (opening.length) {
              const findHdr = (...names: string[]) => { for (const n of names) { const i = header.findIndex(h => (h ?? '').toString().trim().toLowerCase() === n.toLowerCase()); if (i >= 0) return i; } return -1; };
              const dIdx = findHdr('Trade Date', 'Date');
              const isinIdx2 = findHdr('ISIN');
              const nameIdx2 = findHdr('Stock Name', 'Security Name');
              const typeIdx = findHdr('Transaction Type');
              const qtyIdx = findHdr('Number of Shares', 'Quantity');
              const priceIdx = findHdr('Avg Price', 'Price');
              const turnIdx = findHdr('Total Amount (Turnover)', 'Turnover');
              const openRows = opening.map(ol => {
                const row = header.map(() => '');
                if (dIdx >= 0) row[dIdx] = ol.acqDate || '';
                if (isinIdx2 >= 0) row[isinIdx2] = ol.isin || '';
                if (nameIdx2 >= 0) row[nameIdx2] = ol.name || '';
                if (typeIdx >= 0) row[typeIdx] = 'Opening Buy';
                if (qtyIdx >= 0) row[qtyIdx] = String(ol.qty);
                if (priceIdx >= 0) row[priceIdx] = String(ol.costPerShare);
                if (turnIdx >= 0) row[turnIdx] = String(Math.round(ol.qty * ol.costPerShare * 100) / 100);
                return row;
              });
              // Oldest first, ahead of the FY26 trades (they're the carried-in basis).
              openRows.sort((a, b) => (parseCellDate(dIdx >= 0 ? a[dIdx] : '') ?? -Infinity) - (parseCellDate(dIdx >= 0 ? b[dIdx] : '') ?? -Infinity));
              body = [...openRows, ...body];
            }
          } catch { /* no Opening Holdings tab → transactions stay FY26-only */ }
        }

        // Filter to the requested period using the report's date column
        // (Sale Date for capital gains, Trade Date for transactions).
        const dateCol = header.findIndex(h => /date/i.test(h));
        const fromTs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : -Infinity;
        const toTs = toDate ? new Date(`${toDate}T23:59:59`).getTime() : Infinity;
        if (dateCol >= 0 && (fromDate || toDate)) {
          body = body.filter(r => {
            const ts = parseCellDate(r[dateCol]);
            return ts === null ? true : (ts >= fromTs && ts <= toTs);  // keep undated rows
          });
        }
        // Which column names the security. Differs per tab: True Entry uses "Stock Name", the
        // LTST capital-gains tab uses "Asset Name". Neither carries an ISIN column, which is why
        // the name is the identity here — and why an unlisted company (usually no ISIN) matches
        // on name alone. Found once and shared by both filters below.
        const nameCol = header.findIndex(h => /stock name|security name|asset name|scrip|company|^name$/i.test(h));
        const isinCol = header.findIndex(h => /isin/i.test(h));
        const cellName = (r: string[]) => (nameCol >= 0 ? (r[nameCol] ?? '') : '');
        const cellIsin = (r: string[]) => (isinCol >= 0 ? (r[isinCol] ?? '') : '');

        // Scoped to a single stock → keep only its rows (by ISIN or canonical name).
        if (matchScrip && nameCol >= 0) {
          body = body.filter(r => matchScrip!(cellName(r), cellIsin(r)));
        }

        // Scoped to an asset class → keep only that class's rows. A tab with no recognisable
        // name column can't be classified at all; failing loudly beats emitting a file labelled
        // "Equity only" whose contents were never actually filtered.
        if (inScope) {
          if (nameCol < 0) {
            throw new Error(`This report's sheet has no recognisable company-name column, so its rows can't be split into listed and unlisted. Choose Consolidated.`);
          }
          body = body.filter(r => inScope!(cellName(r), cellIsin(r)));
        }
        setGenHeader(header);
        setGenRows(body);
      }
      setRanScope(scopeActive ? scope : 'consolidated');
      setUnclassified(unknownNames.size);
      setEmptyPeList(emptyPeList);
      setStep('result');
    } catch (e: any) {
      setError(e?.result?.error?.message || e?.message || 'Could not generate the report.');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Describe the generated report as a typed document, which the CSV / XLSX / PDF renderers
   * all consume. Built on demand (when a format is picked) rather than per render.
   *
   * Filenames and the CSV's own shape are deliberately unchanged from the previous
   * CSV-only export, so anything downstream that already consumes these files keeps working.
   */
  const buildDoc = (): ReportDoc => {
    const p = portfolio!;
    // Stock-scoped reports lead the filename with the scrip name (sanitised for a filename).
    const stockTag = focus ? `${fileSafe(focus.scripName)}_` : '';
    // Filename fragment for a narrowed report. Empty for Consolidated, so every filename this
    // app has ever produced is unchanged — and a narrowed one is impossible to mistake for it.
    // This matters most for CSV, which is deliberately raw and carries no parameter block, so
    // the filename is its ONLY statement of scope.
    const scopeTag = SCOPE_TAG[ranScope];
    // Bounds the reliability of the split. Only meaningful on a narrowed report — a consolidated
    // one includes every row whether or not it could be classified.
    const unclassifiedNote = (ranScope !== 'consolidated' && unclassified > 0)
      ? `${unclassified} company name${unclassified === 1 ? '' : 's'} in the source ledger matched no entry in the shared scrip master and ${unclassified === 1 ? 'was' : 'were'} therefore treated as listed. Check ${unclassified === 1 ? 'it' : 'them'} before relying on this split.`
      : '';
    const emptyListNote = (ranScope === 'eq' && emptyPeList)
      ? 'The “Private Equities” list in the shared scrip master is empty, so no securities were excluded from this report — it is equivalent to a consolidated one.'
      : '';
    const params: Array<[string, string]> = [['Portfolio', `${p.code} — ${p.label}`]];
    if (focus) params.push(['Stock', focus.scripName + (focus.isin ? ` · ${focus.isin}` : '')]);
    // Stated for Consolidated too, not only when narrowed: a report that says what it covers
    // can't be misread, and one that says nothing has to be trusted.
    if (scopeOffered) params.push(['Scope', SCOPE_LABEL[ranScope]]);

    if (reportType === 'holding') {
      params.push(['As on', formatDMMMY(asOf)]);
      params.push(['Positions', `${positions.length}`]);
      // Relabelled, not refiltered: the replay must span every holding (a corporate action on
      // one moves another), so the number is right and only its label was misleading. A wrong
      // figure inside a letterhead is worse than a vague one — the letterhead is the part a
      // reader does not check.
      params.push([(ranScope !== 'consolidated' || focus) ? 'Trades replayed (whole portfolio)' : 'Trades replayed', `${tradeRows}`]);
      const cols: ReportCol[] = [
        { key: 'name', label: 'Company Name', type: 'text' },
        { key: 'isin', label: 'ISIN', type: 'text' },
        { key: 'qty', label: 'Quantity', type: 'int' },
        { key: 'avg', label: 'Avg Buy Price', type: 'rate' },
        { key: 'inv', label: 'Invested Value', type: 'money' },
      ];
      const rows: ReportRow[] = positions.map(pos => ({
        cells: { name: pos.securityName, isin: pos.isin, qty: pos.quantity, avg: pos.avgBuyPrice, inv: pos.invested },
      }));
      // Matches the on-screen footer, and the row the CSV has always carried.
      rows.push({ cells: { name: 'Total', isin: '', qty: '', avg: '', inv: totalInvested }, total: true });
      return {
        holder: p.label,
        title: meta.title,
        titleTag: focus ? focus.scripName : (SCOPE_SLUG[ranScope] || undefined),
        params,
        cols,
        rows,
        footnotes: [
          // "full trade history" describes the REPLAY, which genuinely does span everything —
          // but printed above a filtered table it reads as a claim that the table is complete.
          ranScope === 'consolidated'
            ? 'Positions are replayed from the portfolio’s full trade history as it stood on the date above, including mergers, demergers, splits and bonuses.'
            : 'Positions are replayed from the portfolio’s full trade history as it stood on the date above, including mergers, demergers, splits and bonuses. The replay covers the whole portfolio; only the positions in scope are listed below.',
          SCOPE_NOTE[ranScope],
          emptyListNote,
          unclassifiedNote,
          'Amounts in ₹. Cost per share is carried at full precision, not rounded to paise. Negative amounts appear in parentheses; a negative quantity indicates an unreconciled position.',
        ].filter(Boolean),
        filenameBase: `Holding_${scopeTag}${stockTag}${p.code}_as_of_${asOf}`,
      };
    }

    const cols = inferCols(genHeader, genRows);
    const rows = rowsFromGrid(genHeader, genRows);
    params.push(['Period', `${fromDate ? formatDMMMY(fromDate) : 'inception'} to ${toDate ? formatDMMMY(toDate) : 'today'}`]);
    params.push(['Rows', `${genRows.length}`]);
    const range = `_${fromDate || 'inception'}_to_${toDate || 'today'}`;
    const fnMap: Record<ReportType, string> = { holding: 'Holding', capgains: 'CapitalGains', transactions: 'Transactions', expenses: 'ExpenseReport', 'expenses-detailed': 'DetailedExpenseReport' };
    const SOURCE: Record<ReportType, string> = {
      holding: '',
      capgains: 'Source: the portfolio’s capital-gains ledger (LTST tab), which records one row per sale.',
      transactions: 'Source: the portfolio’s True Entry trade ledger. Carried-in opening lots appear as “Opening Buy” rows.',
      expenses: 'Charges summed per trade date from the True Entry ledger. Blank cells are charges the broker did not levy.',
      'expenses-detailed': 'Charges summed per trade date and scrip from the True Entry ledger. A blank date repeats the date above it.',
    };
    return {
      holder: p.label,
      title: meta.title,
      titleTag: focus ? focus.scripName : (SCOPE_SLUG[ranScope] || undefined),
      params,
      cols,
      rows,
      footnotes: [
        SOURCE[reportType],
        SCOPE_NOTE[ranScope],
        emptyListNote,
        unclassifiedNote,
        // The two expense reports are never narrowed, and they get filed alongside ones that
        // are — same portfolio, same period. Say so, or the pair invites a reconciliation that
        // cannot balance.
        meta.scoped ? '' : 'This report always covers the whole portfolio — charges are not split by asset class.',
        'Amounts in ₹. Negative amounts are shown in parentheses.',
      ].filter(Boolean),
      // Wide ledgers need the extra width; the 5-column reports read better upright.
      landscape: cols.length > 6,
      filenameBase: `${fnMap[reportType]}_${scopeTag}${stockTag}${p.code}${range}`,
    };
  };

  const reset = () => { setStep('home'); setPortfolio(null); setError(null); setScope('consolidated'); setPositions([]); setGenHeader([]); setGenRows([]); };
  const openReport = (t: ReportType) => {
    // Scope resets with the report type: carrying "Private Equity" from a Capital Gains run
    // into a Transaction Report would silently narrow a report the user did not narrow.
    setReportType(t); setError(null); setScope('consolidated'); setPositions([]); setGenHeader([]); setGenRows([]);
    // Scoped mode: portfolio is already locked to the stock's account → jump straight
    // to date/period config. Otherwise fall through to the portfolio picker.
    if (focus && portfolio) setStep('config');
    else { setPortfolio(null); setStep('portfolio'); }
  };
  const exitFocus = () => { onClearFocus?.(); setPortfolio(null); setStep('home'); setError(null); setScope('consolidated'); setPositions([]); setGenHeader([]); setGenRows([]); };

  const hasResult = reportType === 'holding' ? positions.length > 0 : genRows.length > 0;

  return (
    <div className="max-w-5xl mx-auto animate-fadeIn">
      {/* ── Home: report catalogue ── */}
      {step === 'home' && (
        <div className="space-y-4">
          {focus ? (
            <div className="flex items-start justify-between gap-3 p-4 rounded-2xl bg-indigo-50 border border-indigo-200">
              <div className="min-w-0">
                <span className="text-[10px] font-black uppercase tracking-widest text-indigo-500">Reports for</span>
                <h2 className="text-base font-black text-indigo-900 tracking-tight truncate">{focus.scripName}</h2>
                <p className="text-[11px] text-indigo-600 font-medium mt-0.5">
                  {portfolio ? <>Portfolio {portfolio.code} · {portfolio.label}</> : 'this account'} · every report below is filtered to this stock
                </p>
              </div>
              <button onClick={exitFocus} className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold text-indigo-600 hover:bg-indigo-100 rounded-lg transition-colors cursor-pointer shrink-0">
                <X className="w-3.5 h-3.5" /> Show all reports
              </button>
            </div>
          ) : (
            <div>
              <h2 className="text-lg font-black text-slate-800 tracking-tight">Reports</h2>
              <p className="text-xs text-slate-500 mt-0.5">Generate and download reports from your portfolio ledgers.</p>
            </div>
          )}
          <div className="space-y-3">
            {REPORTS.map(({ type, title, desc, Icon }) => (
              <button
                key={type}
                onClick={() => openReport(type)}
                className="w-full sm:w-[480px] text-left p-5 rounded-2xl bg-white border border-slate-200 shadow-sm hover:border-indigo-400 hover:shadow-md transition-all cursor-pointer flex items-center gap-4 group"
              >
                <div className="p-3 rounded-xl bg-indigo-50 text-indigo-700 shrink-0">
                  <Icon className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-black text-slate-800">{title}</h3>
                  <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{desc}</p>
                </div>
                <ArrowRight className="w-5 h-5 text-slate-300 group-hover:text-indigo-600 group-hover:translate-x-0.5 transition-all shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Step 1: choose portfolio ── */}
      {step === 'portfolio' && (
        <div className="space-y-5">
          <button onClick={reset} className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-indigo-600 cursor-pointer transition-colors">
            <ArrowLeft className="w-4 h-4" /> Reports
          </button>
          <div>
            <h2 className="text-base font-black text-slate-800 tracking-tight">{meta.title}</h2>
            <p className="text-xs text-slate-500 mt-0.5">Select the portfolio to report on.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {PORTFOLIOS.map(p => (
              <button
                key={p.id}
                // Scope resets with the account. Private-equity membership is master-wide but
                // HOLDINGS are per-account, so a "Private Equity" carried over from the previous
                // portfolio produces an empty report on an account holding none — a narrowing
                // the user never asked for on this account.
                onClick={() => { setPortfolio(p); setError(null); setScope('consolidated'); setStep('config'); }}
                className="text-left p-5 rounded-2xl bg-white border border-slate-200 shadow-sm hover:border-indigo-400 hover:shadow-md transition-all cursor-pointer flex items-center justify-between gap-3 group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-150 text-indigo-600 shrink-0"><Briefcase className="w-5 h-5" /></div>
                  <div className="min-w-0">
                    <span className="px-2 py-0.5 bg-indigo-50 border border-indigo-100 text-indigo-700 text-[9px] font-black uppercase tracking-wider rounded-md">Portfolio {p.code}</span>
                    <h3 className="text-sm font-black text-slate-800 mt-1.5 truncate">{p.label}</h3>
                  </div>
                </div>
                <ArrowRight className="w-5 h-5 text-slate-300 group-hover:text-indigo-600 transition-colors shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Step 2: configure & generate ── */}
      {step === 'config' && portfolio && (
        <div className="space-y-5">
          <button onClick={() => setStep(focus ? 'home' : 'portfolio')} className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-indigo-600 cursor-pointer transition-colors">
            <ArrowLeft className="w-4 h-4" /> {focus ? 'Choose report' : 'Choose portfolio'}
          </button>
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 max-w-md">
            <h2 className="text-base font-black text-slate-800 tracking-tight">{meta.title}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              <strong className="text-slate-700">{portfolio.label}</strong> · Portfolio {portfolio.code}
              {focus && <> · <strong className="text-indigo-700">{focus.scripName}</strong></>}
            </p>

            {/* Asset class. Offered for every report except the two expense ones, and not in
                single-stock mode where the stock is already one class. Consolidated is the
                default and is exactly the report this screen produced before. */}
            {scopeOffered && (
              <>
                <label className="block mt-5 text-[11px] font-black uppercase tracking-wider text-slate-500">Asset class</label>
                <div className="inline-flex items-center p-1 mt-1.5 bg-slate-100 border border-slate-200 rounded-xl">
                  {SCOPES.map((sc) => (
                    <button
                      key={sc.key}
                      type="button"
                      onClick={() => setScope(sc.key)}
                      aria-pressed={scope === sc.key}
                      title={sc.hint}
                      className={`px-3 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer ${
                        scope === sc.key ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {sc.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-400 mt-1.5">
                  {scope === 'consolidated'
                    ? 'Every holding in the portfolio, listed and unlisted together.'
                    : scope === 'eq'
                      ? 'Listed securities only — unlisted companies are left out.'
                      : 'Unlisted companies only, as listed in the Private Equities tab of the scrip master.'}
                </p>
              </>
            )}

            {reportType === 'holding' ? (
              <>
                <label className="block mt-5 text-[11px] font-black uppercase tracking-wider text-slate-500">Holdings as of</label>
                <div className="flex items-center gap-2 mt-1.5">
                  <CalendarDays className="w-4 h-4 text-slate-400" />
                  <input
                    type="date"
                    value={asOf}
                    max={todayStr()}
                    onChange={(e) => setAsOf(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:outline-none focus:border-indigo-400 bg-white"
                  />
                </div>
                <p className="text-[11px] text-slate-400 mt-1.5">Positions are reconstructed by replaying every Buy/Sell on or before this date.</p>
              </>
            ) : (
              <>
                <label className="block mt-5 text-[11px] font-black uppercase tracking-wider text-slate-500">Period</label>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-bold text-slate-500 w-9">From</span>
                    <CalendarDays className="w-4 h-4 text-slate-400" />
                    <input
                      type="date"
                      value={fromDate}
                      max={toDate || todayStr()}
                      onChange={(e) => setFromDate(e.target.value)}
                      className="px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:outline-none focus:border-indigo-400 bg-white"
                    />
                    <button
                      type="button"
                      onClick={() => setFromDate('')}
                      title="Include everything from the first trade / opening position"
                      className={`text-[11px] font-bold px-2.5 py-2 rounded-lg border transition-colors cursor-pointer ${fromDate === '' ? 'bg-indigo-600 text-white border-indigo-600' : 'text-slate-500 border-slate-200 hover:bg-slate-100'}`}
                    >
                      Since inception
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-bold text-slate-500 w-9">To</span>
                    <CalendarDays className="w-4 h-4 text-slate-400" />
                    <input
                      type="date"
                      value={toDate}
                      min={fromDate || undefined}
                      max={todayStr()}
                      onChange={(e) => setToDate(e.target.value)}
                      className="px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:outline-none focus:border-indigo-400 bg-white"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">{meta.desc} Pick <strong className="text-slate-500">Since inception</strong> (or clear From) for all history.</p>
              </>
            )}

            {error && (
              <div className="flex items-start gap-2 mt-4 p-3 rounded-xl border border-rose-200 bg-rose-50 text-[12px] text-rose-700">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{error}</span>
              </div>
            )}
            <button
              onClick={generate}
              disabled={loading || (reportType === 'holding' && !asOf)}
              className="mt-5 w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-xl transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <meta.Icon className="w-4 h-4" />}
              {loading ? 'Generating…' : 'Generate Report'}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: result ── */}
      {step === 'result' && portfolio && (
        <div className="space-y-4">
          <button onClick={() => setStep('config')} className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-indigo-600 cursor-pointer transition-colors">
            <ArrowLeft className="w-4 h-4" /> Change options / portfolio
          </button>
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4 border-b border-slate-150 bg-slate-50">
              <div>
                <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">{meta.title} — {portfolio.label}</h3>
                <p className="text-[11px] text-slate-500 font-medium mt-0.5">
                  Portfolio {portfolio.code}
                  {focus && <> · <strong className="text-indigo-700">{focus.scripName}</strong></>}
                  {/* Named on screen as well as in the exported file — the table itself gives
                      no clue that rows were withheld. */}
                  {ranScope !== 'consolidated' && <> · <strong className="text-indigo-700">{ranScope === 'pe' ? 'private equity only' : 'equity only'}</strong></>}
                  {reportType === 'holding'
                    ? ` · as of ${formatDMY(asOf)} · ${positions.length} position${positions.length === 1 ? '' : 's'} · ${tradeRows} trades replayed${(ranScope !== 'consolidated' || focus) ? ' (whole portfolio)' : ''}`
                    : ` · ${fromDate ? formatDMY(fromDate) : 'inception'} → ${toDate ? formatDMY(toDate) : 'today'} · ${genRows.length} row${genRows.length === 1 ? '' : 's'}`}
                </p>
              </div>
              {hasResult && <ExportMenu doc={buildDoc} />}
            </div>

            {/* The same caveats the exported file carries as footnotes. Shown here because the
                person generating the report is the one who can act on them — and until now they
                appeared only inside a PDF or workbook nobody re-opens. */}
            {ranScope !== 'consolidated' && (unclassified > 0 || (ranScope === 'eq' && emptyPeList)) && (
              <div className="flex items-start gap-2 px-5 py-3 border-b border-slate-150 bg-amber-50 text-[11px] text-amber-800">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  {unclassified > 0 && (
                    <>
                      <strong>{unclassified}</strong> company name{unclassified === 1 ? '' : 's'} in this
                      ledger matched no entry in the scrip master and {unclassified === 1 ? 'was' : 'were'} treated
                      as listed.{' '}
                    </>
                  )}
                  {ranScope === 'eq' && emptyPeList && (
                    <>The Private Equities list is empty, so nothing was excluded — this is the same as a consolidated report.</>
                  )}
                </span>
              </div>
            )}

            {/* Holding report — structured table */}
            {reportType === 'holding' && (
              positions.length === 0 ? (
                <p className="text-center text-sm text-slate-500 italic py-16">
                  {ranScope !== 'consolidated'
                    ? `No ${ranScope === 'pe' ? 'unlisted' : 'listed'} positions in this portfolio as of ${formatDMY(asOf)}.`
                    : `No open positions as of ${formatDMY(asOf)}.`}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm border-collapse">
                    <thead className="bg-[#f8fafc] border-b border-slate-200 text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                      <tr>
                        <th className="px-5 py-3">Company</th>
                        <th className="px-5 py-3">ISIN</th>
                        <th className="px-5 py-3 text-right">Quantity</th>
                        <th className="px-5 py-3 text-right">Avg Buy Price</th>
                        <th className="px-5 py-3 text-right">Invested Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {positions.map((p, i) => (
                        <tr key={i} className="hover:bg-slate-50 transition-colors">
                          <td className="px-5 py-2.5 font-medium text-slate-800">{p.securityName}</td>
                          <td className="px-5 py-2.5 font-mono text-[12px] text-slate-500">{p.isin}</td>
                          <td className="px-5 py-2.5 text-right text-slate-700 font-mono">{p.quantity.toLocaleString('en-IN')}</td>
                          <td className="px-5 py-2.5 text-right text-slate-700 font-mono">{inr(p.avgBuyPrice)}</td>
                          <td className="px-5 py-2.5 text-right text-slate-800 font-mono font-semibold">{inr(p.invested)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t border-slate-200 bg-slate-50">
                      <tr>
                        <td className="px-5 py-3 font-black text-slate-800 uppercase text-xs" colSpan={4}>Total Invested</td>
                        <td className="px-5 py-3 text-right font-black text-slate-900 font-mono">{inr(totalInvested)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )
            )}

            {/* Capital gains / transactions — generic table straight from the sheet */}
            {reportType !== 'holding' && (
              genRows.length === 0 ? (
                <p className="text-center text-sm text-slate-500 italic py-16">
                  {ranScope !== 'consolidated'
                    ? `No rows for ${ranScope === 'pe' ? 'unlisted companies' : 'listed securities'} in this period.`
                    : 'No rows to show.'}
                </p>
              ) : (
                <div ref={genVR.scrollRef} onScroll={genVirtual ? genVR.onScroll : undefined} className="overflow-auto max-h-[65vh]">
                  <table className="w-full text-left text-[13px] whitespace-nowrap">
                    <thead className="bg-[#f8fafc] border-b border-slate-200 text-[10px] font-bold text-slate-600 uppercase tracking-wider sticky top-0 z-10">
                      <tr>
                        {genHeader.map((h, i) => (
                          <th key={i} className="px-4 py-3">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {genVirtual && genVR.padTop > 0 && (
                        <tr aria-hidden="true"><td colSpan={genHeader.length || 1} style={{ height: genVR.padTop, padding: 0, border: 0 }} /></tr>
                      )}
                      {(genVirtual ? genRows.slice(genVR.start, genVR.end) : genRows).map((r, li) => {
                        const ri = genVirtual ? genVR.start + li : li;
                        return (
                          <tr key={ri} ref={genVirtual && li === 0 ? genVR.measureRow : undefined} className="hover:bg-slate-50 transition-colors">
                            {genHeader.map((h, ci) => {
                              const raw = r[ci] ?? '';
                              // Cells are untyped sheet strings here, so date columns are
                              // identified by their HEADER ("Trade Date", "Sale Date", …).
                              const v = isDateHeader(h) ? formatDMY(raw) : raw;
                              return (
                                <td key={ci} className={`px-4 py-2 ${looksNumeric(raw) && !isDateHeader(h) ? 'text-right font-mono text-slate-700' : 'text-slate-700'}`}>{v}</td>
                              );
                            })}
                          </tr>
                        );
                      })}
                      {genVirtual && genVR.padBottom > 0 && (
                        <tr aria-hidden="true"><td colSpan={genHeader.length || 1} style={{ height: genVR.padBottom, padding: 0, border: 0 }} /></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
