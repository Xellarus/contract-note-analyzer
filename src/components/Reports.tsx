import { useState, useEffect } from 'react';
import { FileBarChart2, ArrowLeft, ArrowRight, Loader2, AlertCircle, Briefcase, CalendarDays, TrendingUp, Receipt, Coins, Layers, X } from 'lucide-react';
import { gapi } from 'gapi-script';
import { computeHoldingsAsOf, HistoricalHolding, type DeferredTransfer } from '../lib/holdingsCalc';
import { PORTFOLIOS, Portfolio } from '../lib/portfolios';
import { normName, loadScripMaster, lookupScrip, classOfEntryAsOf, ScripMaster, SCRIP_MASTER_SPREADSHEET_ID } from '../lib/scripMaster';
import { ASSET_CLASSES, ASSET_CLASS_IDS, AssetClassId } from '../lib/privateEquities';
import { formatDMY, formatDMMMY, isDateHeader, isDateInputSane, DATE_INPUT_MIN } from '../lib/dates';
import { loadOpeningHoldings } from '../lib/openingHoldings';
import { useVirtualRows } from './ui/useVirtualRows';
import ExportMenu from './ExportMenu';
import type { ReportDoc, ReportCol, ReportRow } from '../lib/reportDoc';
import { inferCols, rowsFromGrid, fileSafe, fmtMoney } from '../lib/reportDoc';
import {
  loadPriceGrid, makeColumnResolver, priceAsOf, gridExtent, EMPTY_GRID, type PriceGrid,
} from '../lib/priceHistory';
import { backfillMissingPriceHistory, hasYahooWebApp, type HistoryGapResult } from '../lib/yahooPrices';
import { invalidatePriceCache } from '../lib/scripPrices';

/**
 * A historical position with the market price it carried ON THE REPORT'S OWN DATE.
 *
 * The whole point of the two extra fields is that they are dated the same as the quantity beside
 * them. Valuing a 31-Mar-2025 position at today's price produces a page on which every figure is
 * plausible and nothing contradicts anything — the worst failure this app has, and the reason
 * `mktPrice` is `null` rather than a fallback whenever the right price cannot be had.
 */
interface PricedPosition extends HistoricalHolding {
  /** Close on the last session at or before the report date. `null` = unpriced. NEVER 0. */
  mktPrice: number | null;
  mktValue: number | null;
  /** The session the price actually came from; '' when unpriced. */
  priceDate: string;
  /** Priced from a session EARLIER than the report's own effective pricing session. */
  stale: boolean;
  /** Short label printed IN the Current Value cell in place of a figure; '' when priced. */
  blankReason: string;
}

/**
 * Why a Current Value cell is empty — printed in the cell itself, not only in a footnote.
 *
 * Reported 23-Sep-2026 against a real S713 run: 15 of 103 rows came back blank and nothing on the
 * page said which of them were EXPECTED. An ETF deliberately excluded from the price feed, a
 * pre-IPO allotment that has never traded, and a listed company the price script has simply never
 * managed to fetch all print an identical empty cell — and they have completely different
 * remedies, one of which is "nothing".
 *
 * The first three are decided from the scrip master BEFORE the grid is consulted, because a scrip
 * with no exchange code also has no column, and "no exchange code" is the useful half of that pair.
 */
const BLANK: Record<string, { label: string; why: string }> = {
  unlisted: {
    label: 'Unlisted',
    why: 'held as an unlisted company on this date, so no traded price exists. The valuation on the scrip master is a present-day figure and stating it here would date it to this report.',
  },
  exception: {
    label: 'Price exception',
    why: 'flagged “Price Exception” on the scrip master, so the price feed skips it deliberately — ETFs and liquid funds are marked this way.',
  },
  notListed: {
    label: 'Not listed',
    why: 'the scrip master carries no NSE or BSE code for it, so it has never had a traded price — normally a pre-IPO allotment, where the IPO has not happened yet. If it HAS since listed, put its exchange code on the scrip-master row and re-run the price-history backfill.',
  },
  noHistory: {
    label: 'No price history',
    why: 'it carries an exchange code but has no column in the price history at all, so the price script has never fetched it — a configuration gap rather than an absent price. The “Price Status” tab records why a scrip was skipped.',
  },
  beforeHistory: {
    label: 'No price history',
    why: 'the price history does not reach back to this date.',
  },
  noClose: {
    label: 'No recent close',
    why: 'it has price history but no close within seven sessions of this date — suspended, delisted, or simply not traded around then.',
  },
};

/** What the pricing pass has to DISCLOSE, so a blank column is never mistaken for a zero one. */
interface PriceMeta {
  /** Extent of the price history actually held, for saying when a date simply precedes it. */
  gridFrom: string;
  gridTo: string;
  /**
   * The session MOST positions were actually priced from — the report's own pricing date.
   *
   * It is frequently not the as-on date, and stating it once is what stops the per-scrip note
   * below becoming noise. The as-on date can resolve to a grid row that is nearly empty (a
   * holiday row, or a top-up that ran before the close), in which case every scrip carries by one
   * session: on the 31-Mar-2026 S713 run that flagged 86 of 103 positions as "priced from an
   * earlier session", which is a disclosure nobody reads.
   */
  pricedOn: string;
  /** Blank cells grouped by the reason they are blank — a `BLANK` key and the names under it. */
  blanks: { reason: string; names: string[] }[];
  /** Positions priced EARLIER than `pricedOn` — the genuine stragglers, not the whole market. */
  stale: { name: string; date: string }[];
  /** Sum of the market value that COULD be established. */
  totalValue: number;
  /** Invested cost sitting in positions with no market price — the footing shortfall. */
  unpricedInvested: number;
}

/**
 * Attach each position's close as at the report date.
 *
 * Deliberately NOT done inside `computeHoldingsAsOf`: that function is also what the Add Trade
 * drawer calls for "shares held as at this date", memoised per portfolio and date, and dragging a
 * ~165k-cell grid read onto that path would pay for a valuation nobody asked for on every
 * back-dated corporate action.
 *
 * Unlisted holdings are left unpriced (owner's decision, 22-Sep-2026). The scrip master carries a
 * single hand-entered valuation per unlisted company, which is a statement about TODAY; printing
 * it against a past position would put this year's number on last year's statement. The class
 * test is `classOfEntryAsOf` at the REPORT's date, not `assetClass` raw, so a company that has
 * since listed is priced for the sessions it was actually listed for.
 */
async function priceAsOfDate(
  positions: HistoricalHolding[],
  asOfTs: number,
  master: ScripMaster | null,
): Promise<{ priced: PricedPosition[]; meta: PriceMeta }> {
  let grid: PriceGrid = EMPTY_GRID;
  // A missing or unreadable Price History tab degrades to "nothing is priced", which the
  // footnotes then state. It must never fail the report — the cost columns are still valid.
  try { grid = await loadPriceGrid(); } catch { /* no market history */ }
  const colOf = makeColumnResolver(grid, master);
  const ext = gridExtent(grid);
  const blanks = new Map<string, string[]>();
  let totalValue = 0, unpricedInvested = 0;

  const priced = positions.map((p): PricedPosition => {
    const entry = master ? lookupScrip(master, p.isin, p.securityName).entry : null;
    // The scrip-master reasons win over whatever the grid would say, because they are the more
    // specific fact: a scrip with no exchange code is ALSO missing from the grid, and telling the
    // owner to check the price script for a company that has not IPO'd sends them nowhere.
    const fromMaster =
      entry && classOfEntryAsOf(entry, asOfTs) ? 'unlisted'
      : entry?.priceExcept ? 'exception'
      : !(entry?.nse || entry?.bse) ? 'notListed'
      : '';
    const r = fromMaster ? null : priceAsOf(grid, colOf(p.isin, p.securityName), asOfTs);
    if (r && r.price !== null) {
      const value = p.quantity * r.price;
      totalValue += value;
      return { ...p, mktPrice: r.price, mktValue: value, priceDate: r.sessionDate, stale: false, blankReason: '' };
    }
    const reason = fromMaster
      || (r!.miss === 'no-close' ? 'noClose' : r!.miss === 'before-history' ? 'beforeHistory' : 'noHistory');
    const seen = blanks.get(reason);
    if (seen) seen.push(p.securityName); else blanks.set(reason, [p.securityName]);
    unpricedInvested += p.invested;
    return { ...p, mktPrice: null, mktValue: null, priceDate: '', stale: false, blankReason: BLANK[reason].label };
  });

  // The report's OWN pricing session: the one the most positions came from. Ties go to the later
  // session, so a thin trading day cannot outvote the real one on count alone.
  const tally = new Map<string, number>();
  for (const p of priced) if (p.priceDate) tally.set(p.priceDate, (tally.get(p.priceDate) || 0) + 1);
  let pricedOn = '';
  for (const [d, n] of tally) {
    const best = pricedOn ? tally.get(pricedOn)! : -1;
    if (n > best || (n === best && d > pricedOn)) pricedOn = d;
  }
  // Only what is OLDER than that is a straggler worth naming. Flagging everything priced before
  // the as-on date names the whole market whenever that date resolves to a thin session.
  const stale: { name: string; date: string }[] = [];
  for (const p of priced) {
    if (p.priceDate && p.priceDate < pricedOn) {
      p.stale = true;
      stale.push({ name: p.securityName, date: p.priceDate });
    }
  }

  return {
    priced,
    meta: {
      gridFrom: ext ? grid.dates[0] : '',
      gridTo: ext ? grid.dates[grid.dates.length - 1] : '',
      pricedOn,
      blanks: [...blanks.entries()].map(([reason, names]) => ({ reason, names })),
      stale, totalValue, unpricedInvested,
    },
  };
}

/**
 * Turn a gap-fill run into one sentence the owner can act on.
 *
 * The two outcomes are NOT the same and must not be blurred: scrips that were fetched are fixed
 * by re-generating the report, while scrips with no exchange code on their master row are
 * untouched and always will be — the history writer skips them before it fetches anything. Saying
 * only "filled N" would leave the owner re-running this forever against the ones it cannot help.
 */
function describeGapFix(r: HistoryGapResult): string {
  const parts: string[] = [];
  // "Nothing was missing" and "nothing could be fetched" are OPPOSITE outcomes and the first
  // version of this line printed the former for both — it told the owner there was no gap while
  // 79 scrips were queued and none had come back. `filled === 0` means nothing was FETCHED.
  const tried = r.targets ?? 0;
  parts.push(
    tried === 0
      ? 'No scrip was missing a price-history column.'
      : r.filled
        ? `Fetched price history for ${r.filled} of ${tried} scrip${tried === 1 ? '' : 's'}. Generate the report again to see the prices.`
        : `Tried ${tried} scrip${tried === 1 ? '' : 's'} and the feed returned data for none of them, so this is not a per-scrip problem. Nothing was written to the price history.`,
  );
  // The reason, grouped. This is the line that says whether to retry or to go fix the sheet.
  if (r.failReasons?.length) {
    parts.push('Why: ' + r.failReasons.map(f => `${f.count}\u00d7 ${f.reason}${f.sample ? ` (e.g. ${f.sample})` : ''}`).join('; ') + '.');
    if (r.failReasons.some(f => /429|blocked|HTTP 5/.test(f.reason))) {
      parts.push('That is the price feed refusing the request rather than a problem with these scrips — wait a few minutes and run it again.');
    }
  }
  if (r.remaining) parts.push(`${r.remaining} more ${r.remaining === 1 ? 'is' : 'are'} queued behind the per-run cap — run it again to continue.`);
  if (r.stillMissing?.length) parts.push(`Affected: ${nameSome(r.stillMissing)}.`);
  if (r.noSymbol) {
    parts.push(
      `${r.noSymbol} scrip${r.noSymbol === 1 ? '' : 's'} cannot be fetched at all: the scrip master carries no NSE or BSE code for ${r.noSymbol === 1 ? 'it' : 'them'}, so the price script skips ${r.noSymbol === 1 ? 'it' : 'them'} before fetching anything. ${r.noSymbol === 1 ? 'It is' : 'They are'}: ${nameSome(r.noSymbolNames || [])}. Add the exchange code where the company has listed; where the IPO has not happened there is nothing to add.`,
    );
  }
  if (r.late && !r.filled) parts.push(`${r.late} column${r.late === 1 ? '' : 's'} start later than the rest of the grid; those are only refetched by the deep pass.`);
  return parts.join(' ');
}

/** Name up to `n` of a list, then say how many more there are — never a silent truncation. */
const nameSome = (xs: string[], n = 8): string =>
  xs.slice(0, n).join(', ') + (xs.length > n ? `, and ${xs.length - n} more` : '');

/**
 * The disclosure block for the two price columns. Every line exists because the alternative is a
 * blank cell the reader has to guess at, and this file gets filed.
 */
function buildPriceNotes(pm: PriceMeta, asOf: string): string[] {
  const asOfTs = new Date(`${asOf}T23:59:59`).getTime();
  const out: string[] = [];

  if (!pm.gridFrom) {
    out.push('No market price history was available when this report was generated, so Current Price and Current Value are blank throughout. The cost columns are unaffected.');
    return out;
  }

  // Say which session the report actually priced at. Naming it once is what lets the straggler
  // note below stay quiet: without it, every holding on a thin as-on date reads as an anomaly.
  out.push(
    pm.pricedOn && pm.pricedOn !== asOf
      ? `Current Price is the close of ${formatDMMMY(pm.pricedOn)} — the last session on or before ${formatDMMMY(asOf)} carrying market data. Current Value is that price multiplied by the quantity held on ${formatDMMMY(asOf)}. Closes are as reported, un-adjusted for splits and bonuses.`
      : `Current Price is the closing market price on ${formatDMMMY(asOf)}. Current Value is that price multiplied by the quantity held on the same date. Closes are as reported, un-adjusted for splits and bonuses.`,
  );

  // A date before the grid starts blanks EVERY price, which otherwise reads as "none of these
  // securities had a price" rather than "this app does not hold prices that far back".
  if (asOfTs < Date.parse(`${pm.gridFrom}T00:00:00Z`)) {
    out.push(`The price history held by this app begins ${formatDMMMY(pm.gridFrom)}, which is after the date of this report, so no Current Price could be established for any holding.`);
  }

  // One line per REASON, each naming the holdings under it. Grouping matters more than it looks:
  // an undifferentiated list of blanks invites the owner to chase the ones that are working as
  // intended and to overlook the one that is a real configuration fault.
  for (const b of pm.blanks) {
    const d = BLANK[b.reason];
    if (!d) continue;
    const many = b.names.length !== 1;
    out.push(
      `${b.names.length} holding${many ? 's' : ''} shown as “${d.label}” — ${d.why} ${many ? 'They are' : 'It is'}: ${nameSome(b.names)}.`,
    );
  }

  // The footing consequence, stated where the reader is looking at the totals. Two statements
  // that do not tie and do not say why is the thing nobody can debug six months later.
  if (pm.unpricedInvested > 0) {
    out.push(
      `Total Current Value therefore covers only part of the table: ₹${fmtMoney(pm.unpricedInvested)} of invested cost sits in positions carrying no market price, so the two totals are not comparable.`,
    );
  }

  // A carry across a corporate action would state the price in pre-adjustment terms beside a
  // post-adjustment quantity. The grid holds no event data at a single date, so this is
  // disclosed per position rather than silently prevented.
  if (pm.stale.length > 0) {
    out.push(
      `Priced from a session older still, being the last on which the security actually traded: ${nameSome(pm.stale.map(c => `${c.name} (${formatDMMMY(c.date)})`))}. A price carried across a bonus or split ex-date is stated before that adjustment — check any of these that had a corporate action in the interval.`,
    );
  }

  return out;
}

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
/**
 * 'eq' is listed equity; 'pe' / 'aif' / 'mf' / 'bond' each narrow to ONE non-listed
 * scrip-master tab; 'consolidated' is everything. The class scopes share all their machinery
 * - only which tab's membership set is built differs - so they are derived from ASSET_CLASSES
 * rather than spelled out. Adding the Bonds tab needed no change in this file at all, and
 * a fifth tab will not either.
 */
type ReportScope = 'eq' | 'consolidated' | Lowercase<AssetClassId>;

/** Scope -> the asset class it narrows to, or undefined for 'eq' / 'consolidated'. */
const SCOPE_CLASS: Partial<Record<ReportScope, AssetClassId>> =
  Object.fromEntries(ASSET_CLASS_IDS.map(id => [id.toLowerCase(), id])) as any;

const SCOPES: { key: ReportScope; label: string; hint: string }[] = [
  { key: 'eq', label: 'Equity', hint: 'Listed securities only' },
  ...ASSET_CLASS_IDS.map(id => ({
    key: id.toLowerCase() as ReportScope,
    label: ASSET_CLASSES[id].label,
    hint: `Only holdings on the “${ASSET_CLASSES[id].tab}” tab`,
  })),
  { key: 'consolidated', label: 'Consolidated', hint: 'Every asset class together' },
];

const SCOPE_LABEL: Record<ReportScope, string> = {
  eq: 'Equity only (listed securities)',
  consolidated: 'Consolidated — every asset class',
  ...Object.fromEntries(ASSET_CLASS_IDS.map(id =>
    [id.toLowerCase(), `${ASSET_CLASSES[id].label} only (from the “${ASSET_CLASSES[id].tab}” tab)`])),
} as Record<ReportScope, string>;

/** Filename fragment. Consolidated adds nothing, so existing filenames are untouched. */
const SCOPE_TAG: Record<ReportScope, string> = {
  eq: 'Equity_',
  consolidated: '',
  ...Object.fromEntries(ASSET_CLASS_IDS.map(id =>
    [id.toLowerCase(), `${ASSET_CLASSES[id].label.replace(/\s+/g, '')}_`])),
} as Record<ReportScope, string>;

/** Short qualifier carried into the PDF's running header, the XLSX tab name and the print
 *  footer, so a narrowed report identifies itself on every page and not only on page 1. */
const SCOPE_SLUG: Record<ReportScope, string> = {
  eq: 'Equity',
  consolidated: '',
  ...Object.fromEntries(ASSET_CLASS_IDS.map(id => [id.toLowerCase(), ASSET_CLASSES[id].label])),
} as Record<ReportScope, string>;

/**
 * The disclosure printed under a narrowed report. It names the BASIS of the split, because the
 * reader of an exported file has no other way to know what "Equity" meant here — the split is
 * not a market fact, it is this book's own scrip-master tabs.
 */
const SCOPE_NOTE: Record<ReportScope, string> = {
  eq: `Scope: LISTED securities only. Holdings on the ${ASSET_CLASS_IDS.map(id => `“${ASSET_CLASSES[id].tab}”`).join(' / ')} tabs of the shared scrip master are excluded from this report.`,
  consolidated: '',
  ...Object.fromEntries(ASSET_CLASS_IDS.map(id =>
    [id.toLowerCase(),
     `Scope: ${ASSET_CLASSES[id].label.toUpperCase()} only, as listed in the “${ASSET_CLASSES[id].tab}” tab of the shared scrip master. Every other asset class is excluded from this report.`])),
} as Record<ReportScope, string>;

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
/**
 * `ts` is the date the SCOPE is asked about, and it is not decoration: a company that has
 * since listed carries its unlisted class on the master forever (with a `Listed From` date),
 * so asking undated would drop it out of a Private Equity holding report run as of a date
 * when it genuinely was unlisted — which is the whole reason that report exists.
 *
 * Holding reports pass their own As-on; period reports pass the START of the period, matching
 * the register's "unlisted at any time in the year" rule so the two never disagree.
 */
const buildPeMembership = (master: ScripMaster, cls: AssetClassId, ts: number): PeMembership => {
  const names = new Set<string>();
  const isins = new Set<string>();
  for (const e of master.entries) {
    if (classOfEntryAsOf(e, ts) !== cls) continue;
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
  const [positions, setPositions] = useState<PricedPosition[]>([]);
  const [priceMeta, setPriceMeta] = useState<PriceMeta | null>(null);
  // The gap-fill run, if one has been started from this result. Null until then.
  const [gapFix, setGapFix] = useState<{ busy: boolean; msg: string; bad?: boolean } | null>(null);
  const [totalInvested, setTotalInvested] = useState(0);
  const [tradeRows, setTradeRows] = useState(0);
  // Transfer legs held back because the shares had not moved by the as-on date.
  const [deferred, setDeferred] = useState<DeferredTransfer[]>([]);
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
    setPositions([]); setPriceMeta(null); setGapFix(null); setDeferred([]); setGenHeader([]); setGenRows([]);
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
    setPositions([]); setPriceMeta(null); setGapFix(null); setDeferred([]); setGenHeader([]); setGenRows([]);
    try {
      // Both the stock scope and the asset-class scope resolve through the scrip master, so
      // load it once. For a stock-scoped report the master lets a scrip RENAMED in the master
      // (old name now an alias) still match its True Entry / LTST rows, which were written
      // under the old canonical name at import.
      // The holding report needs it too, and not for a scope: the price columns resolve each
      // holding to its Price History column through the master, and ask it which holdings were
      // unlisted on the report's date. A failed read still only THROWS for a scoped run — an
      // unpriced consolidated report is a lesser failure than no report.
      const needsMaster = !!focus || scopeActive || reportType === 'holding';
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
            `Couldn't read the shared Scrip Master (${masterError}), so asset classes can't be told apart — and a ${SCOPE_SLUG[scope] || 'scoped'} report would be mislabelled. A fresh read was already attempted. Check the connection to Google Sheets, or choose Consolidated (which needs no classification).`,
          );
        }
        if (master.peFailed) {
          // `peFailed` means AT LEAST ONE non-listed tab could not be read, so neither direction
          // of the split can be trusted: a class report would come back empty and read as "the
          // account holds none", and an Equity report would silently include the very holdings
          // it claims to exclude. Both are wrong in a way the reader of the file cannot see.
          const cls = SCOPE_CLASS[scope];
          throw new Error(
            cls
              ? `Couldn’t read the “${ASSET_CLASSES[cls].tab}” tab of the scrip master, so nothing can be identified as ${ASSET_CLASSES[cls].label} — this report would come back empty and read as though the account holds none. Fix the tab, or choose Consolidated.`
              : 'Couldn’t read one of the non-listed tabs of the scrip master, so every holding would be classified as listed — this report would silently include the holdings it claims to exclude. Fix the tab, or choose Consolidated.',
          );
        }
      }

      const matchScrip: ScripMatcher | null = focus ? makeScripMatcher(master, focus) : null;

      // The asset-class predicate: precomputed sets, one build per run.
      let inScope: ((name: string, isin: string) => boolean) | null = null;
      const unknownNames = new Set<string>();
      let emptyPeList = false;
      if (scopeActive && master) {
        // 'eq' narrows to "on none of the non-listed tabs", so its membership set is the UNION of
        // every class; a class scope uses just its own. Without the union an Equity report would
        // exclude only private equity and quietly keep the AIF and mutual-fund rows.
        const scopeCls = SCOPE_CLASS[scope];
        // A holding report is a SNAPSHOT, so it is scoped as at its own As-on date. Everything
        // else covers a PERIOD, and is scoped as at the period's start — "was this unlisted at
        // any point in what I am reporting on?". An empty From means inception, i.e. 0, under
        // which every company that ever listed still counts as unlisted for part of the span.
        const scopeTs = reportType === 'holding'
          ? new Date(`${asOf}T23:59:59`).getTime()
          : (fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : 0);
        const mem = scopeCls
          ? buildPeMembership(master, scopeCls, scopeTs)
          : ASSET_CLASS_IDS.map(id => buildPeMembership(master, id, scopeTs)).reduce((a, b) => ({
              names: new Set([...a.names, ...b.names]),
              isins: new Set([...a.isins, ...b.isins]),
            }));
        // An empty list is a FACT here, not a failure: a genuinely absent tab caches as empty
        // and a failed read already threw above. A stated fact beats an empty statement.
        if (mem.names.size === 0 && mem.isins.size === 0) {
          if (scopeCls) {
            throw new Error(`The scrip master lists nothing as ${ASSET_CLASSES[scopeCls].label}, so this report has nothing to cover. Add rows to the “${ASSET_CLASSES[scopeCls].tab}” tab, or choose Equity / Consolidated.`);
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
              // Match the set that was built: one class for a class scope, any class for 'eq'.
              // Through the same dated test the membership sets were built with, or a name
              // that only `lookupScrip` can resolve would be classified on today's answer
              // while every name the sets already hold was classified on the report's date.
              if (e) { const c = classOfEntryAsOf(e, scopeTs); pe = scopeCls ? c === scopeCls : !!c; }
              else unknownNames.add(nk);   // in no master entry at all → treated as listed
            }
            memo.set(key, pe);
          }
          return scopeCls ? pe : !pe;
        };
      }
      if (reportType === 'holding') {
        const asOfTs = new Date(`${asOf}T23:59:59`).getTime();
        const res = await computeHoldingsAsOf(portfolio.sheetId, asOfTs);
        let positions = res.positions;
        if (matchScrip) positions = positions.filter(p => matchScrip!(p.securityName, p.isin));
        if (inScope) positions = positions.filter(p => inScope!(p.securityName, p.isin));
        // Priced AFTER filtering, so a narrowed report reads no more of the grid than it needs
        // and the disclosure counts describe the rows actually printed.
        const { priced, meta: pm } = await priceAsOfDate(positions, asOfTs, master);
        setPositions(priced);
        setPriceMeta(pm);
        // Any filter at all → the total must be re-summed from what's left, or the footer would
        // report the whole portfolio's cost against a subset of its rows.
        setTotalInvested((matchScrip || inScope) ? positions.reduce((s, p) => s + p.invested, 0) : res.totalInvested);
        setTradeRows(res.tradeRows);
        // Narrowed the same way the rows were: a scoped report must not name a holding it never
        // listed. DeferredTransfer carries no ISIN (True Entry has no ISIN column), so both
        // predicates are given the name alone — which is the identity they already fall back to.
        setDeferred(res.deferredTransfers.filter(d =>
          (!matchScrip || matchScrip!(d.name, '')) && (!inScope || inScope!(d.name, ''))));
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
      // Everything the price columns cannot say for themselves. A blank cell is indistinguishable
      // from a zero one on a printed page, so each REASON a cell is blank is named and counted —
      // same discipline as the register's STT pair and the Combined tab's shortfall note.
      const priceNotes = priceMeta ? buildPriceNotes(priceMeta, asOf) : [];
      // Shares that had not reached (or left) this demat on the report's date. Stated because the
      // row DOES exist in the ledger, dated earlier — anyone reconciling this statement against
      // the trade book would otherwise find a purchase with no holding behind it.
      const inbound = deferred.filter(d => d.side === 'in');
      const outbound = deferred.filter(d => d.side === 'out');
      const transferNote = deferred.length === 0 ? '' : [
        inbound.length
          ? `${inbound.length} transferred holding${inbound.length === 1 ? '' : 's'} ${inbound.length === 1 ? 'is' : 'are'} excluded: the shares were acquired earlier but only reached this demat afterwards, so they were not held in this account on the date above. ${nameSome(inbound.map(d => `${d.name} (acquired ${formatDMMMY(d.acquired)}, received ${formatDMMMY(d.arrives)})`))}.`
          : '',
        outbound.length
          ? `${outbound.length} transferred-out holding${outbound.length === 1 ? '' : 's'} ${outbound.length === 1 ? 'is' : 'are'} still included, because the shares had not left this demat by the date above: ${nameSome(outbound.map(d => `${d.name} (left ${formatDMMMY(d.arrives)})`))}.`
          : '',
        'The acquisition date on those rows is unchanged, so their holding period and every capital-gains figure are unaffected — only which account held them on this date.',
      ].filter(Boolean).join(' ');
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
        // Named as every broker's valuation report names them. "Current" is anchored by the
        // "As on" line in the parameter block above and restated in the footnote below — the
        // price is that date's close, not today's.
        { key: 'cmp', label: 'Current Price', type: 'rate' },
        { key: 'val', label: 'Current Value', type: 'money' },
      ];
      const rows: ReportRow[] = positions.map(pos => ({
        cells: {
          name: pos.securityName, isin: pos.isin, qty: pos.quantity, avg: pos.avgBuyPrice, inv: pos.invested,
          // null renders BLANK in all four formats. A 0 here would read as a worthless holding
          // and would foot into the total as though it had been valued. Where there is no figure
          // the VALUE cell carries the reason instead — `formatCell` prints a non-numeric cell in
          // a money column verbatim, so this needs no new column type.
          cmp: pos.mktPrice, val: pos.mktValue === null ? pos.blankReason : pos.mktValue,
        },
      }));
      // Matches the on-screen footer, and the row the CSV has always carried. The price column
      // gets no total — averaging or summing per-share prices means nothing.
      rows.push({ cells: { name: 'Total', isin: '', qty: '', avg: '', inv: totalInvested, cmp: '', val: priceMeta ? priceMeta.totalValue : '' }, total: true });
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
          transferNote,
          ...priceNotes,
          SCOPE_NOTE[ranScope],
          emptyListNote,
          unclassifiedNote,
          'Amounts in ₹. Cost per share is carried at full precision, not rounded to paise. Negative amounts appear in parentheses; a negative quantity indicates an unreconciled position.',
        ].filter(Boolean),
        // Seven columns no longer fit upright. The generic branch below already flips at the
        // same width.
        landscape: true,
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

  const reset = () => { setStep('home'); setPortfolio(null); setError(null); setScope('consolidated'); setPositions([]); setPriceMeta(null); setGapFix(null); setDeferred([]); setGenHeader([]); setGenRows([]); };
  const openReport = (t: ReportType) => {
    // Scope resets with the report type: carrying "Private Equity" from a Capital Gains run
    // into a Transaction Report would silently narrow a report the user did not narrow.
    setReportType(t); setError(null); setScope('consolidated'); setPositions([]); setPriceMeta(null); setGapFix(null); setDeferred([]); setGenHeader([]); setGenRows([]);
    // Scoped mode: portfolio is already locked to the stock's account → jump straight
    // to date/period config. Otherwise fall through to the portfolio picker.
    if (focus && portfolio) setStep('config');
    else { setPortfolio(null); setStep('portfolio'); }
  };
  const exitFocus = () => { onClearFocus?.(); setPortfolio(null); setStep('home'); setError(null); setScope('consolidated'); setPositions([]); setPriceMeta(null); setGapFix(null); setDeferred([]); setGenHeader([]); setGenRows([]); };

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
                    min={DATE_INPUT_MIN}
                    max={todayStr()}
                    onChange={(e) => { if (isDateInputSane(e.target.value)) setAsOf(e.target.value); }}
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
                      min={DATE_INPUT_MIN}
                      max={toDate || todayStr()}
                      onChange={(e) => { if (isDateInputSane(e.target.value)) setFromDate(e.target.value); }}
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
                      min={fromDate || DATE_INPUT_MIN}
                      max={todayStr()}
                      onChange={(e) => { if (isDateInputSane(e.target.value)) setToDate(e.target.value); }}
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
                        <th className="px-5 py-3 text-right">Current Price</th>
                        <th className="px-5 py-3 text-right">Current Value</th>
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
                          {/* Never ₹0.00: a holding with no price and a holding worth nothing are
                              different facts. The VALUE cell carries the reason, so a blank row
                              is readable without scrolling to the notes. */}
                          <td className="px-5 py-2.5 text-right text-slate-700 font-mono" title={p.stale ? `Close of ${formatDMY(p.priceDate)} — the last session this security traded` : undefined}>
                            {p.mktPrice === null ? <span className="text-slate-400">—</span> : inr(p.mktPrice)}
                          </td>
                          <td className="px-5 py-2.5 text-right text-slate-800 font-mono font-semibold">
                            {p.mktValue === null
                              ? <span className="text-[11px] font-sans font-normal text-slate-500">{p.blankReason || '—'}</span>
                              : inr(p.mktValue)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t border-slate-200 bg-slate-50">
                      <tr>
                        <td className="px-5 py-3 font-black text-slate-800 uppercase text-xs" colSpan={4}>Total</td>
                        <td className="px-5 py-3 text-right font-black text-slate-900 font-mono">{inr(totalInvested)}</td>
                        <td className="px-5 py-3" />
                        <td className="px-5 py-3 text-right font-black text-slate-900 font-mono">{priceMeta ? inr(priceMeta.totalValue) : '—'}</td>
                      </tr>
                    </tfoot>
                  </table>
                  {/* The same disclosure the exported file carries. Without it the screen shows
                      blank price cells and a total that does not tie, with nothing saying why —
                      and the person reading the screen is the one deciding whether to export. */}
                  {(() => {
                    // The leading note explains what "Current Price" means, which the As-on date
                    // above already says on screen — so only the EXCEPTIONS are shown here. When
                    // there is no price history at all that single note IS the exception, and
                    // dropping it would leave the emptiest table with the emptiest explanation.
                    const notes = priceMeta ? buildPriceNotes(priceMeta, asOf) : [];
                    const shown = priceMeta?.gridFrom ? notes.slice(1) : notes;
                    if (deferred.length) {
                      const inb = deferred.filter(d => d.side === 'in');
                      const outb = deferred.filter(d => d.side === 'out');
                      if (inb.length) shown.unshift(`${inb.length} transferred holding${inb.length === 1 ? '' : 's'} excluded — acquired earlier, but only received into this demat afterwards: ${nameSome(inb.map(d => `${d.name} (received ${formatDMY(d.arrives)})`))}. Holding periods and capital gains are unaffected.`);
                      if (outb.length) shown.unshift(`${outb.length} transferred-out holding${outb.length === 1 ? '' : 's'} still included — the shares had not left this demat yet: ${nameSome(outb.map(d => `${d.name} (leaves ${formatDMY(d.arrives)})`))}.`);
                    }
                    if (shown.length === 0) return null;
                    return (
                      <div className="m-5 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[12px] text-amber-800 space-y-1.5">
                        {shown.map((n, i) => <p key={i}>{n}</p>)}
                        {/* Offered only for the blanks a fetch can actually fix. A pre-IPO
                            allotment or a deliberate price exception is not a gap, and a button
                            that cannot help the row beside it is worse than none. */}
                        {hasYahooWebApp() && (priceMeta?.blanks || []).some(b => b.reason === 'noHistory' || b.reason === 'noClose') && (
                          <div className="pt-1.5 space-y-1.5">
                            <button
                              type="button"
                              disabled={!!gapFix?.busy}
                              onClick={async () => {
                                setGapFix({ busy: true, msg: 'Fetching the missing price history — this runs on the server and can take a few minutes.' });
                                try {
                                  const r = await backfillMissingPriceHistory();
                                  // The grid was just written; the cached prices are now behind it.
                                  invalidatePriceCache();
                                  setGapFix({ busy: false, msg: describeGapFix(r) });
                                } catch (e: any) {
                                  setGapFix({ busy: false, bad: true, msg: e?.message || 'The price-history backfill could not be reached.' });
                                }
                              }}
                              className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-[12px] font-semibold hover:bg-indigo-700 disabled:opacity-60"
                            >
                              {gapFix?.busy ? 'Fetching…' : 'Fetch the missing price history'}
                            </button>
                            {gapFix && (
                              <p className={gapFix.bad ? 'text-rose-700' : 'text-amber-800'}>{gapFix.msg}</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}
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
