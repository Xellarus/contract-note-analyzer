import React, { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus, Search, Edit2, Trash2, ArrowUpDown, RefreshCw, CheckCircle,
  HelpCircle, AlertCircle, FileSpreadsheet, PlusCircle, Bookmark, DollarSign,
  Briefcase, ShieldCheck, AlertTriangle, TrendingUp, Wallet, Sparkles, Key, Globe,
  ArrowLeft, ChevronLeft, Download, ExternalLink, X, Loader2, Save, Upload, StickyNote,
  ArrowUp, ArrowDown, Lock, FolderOpen, ArrowRightLeft, ChevronDown, MoreHorizontal,
} from 'lucide-react';
import { PortfolioHolding, ContractNoteResult } from '../types';
import { useGoogleLogin } from '@react-oauth/google';
import { gapi } from "gapi-script";
import { persistGoogleToken, hasValidGoogleToken } from '../lib/googleAuth';
import { rebuildHoldingTab, syncCapitalGains, RebuildHoldingResult, UnresolvedScrip } from '../lib/holdingsCalc';
import { generateTrxRegister, TrxRegisterResult } from '../lib/trxRegister';
import { loadScripMaster, lookupScrip, normName, isPeScrip, assetClassOf, peEntry, ltDaysFor, ScripMaster, SCRIP_MASTER_SPREADSHEET_ID } from '../lib/scripMaster';
import { PRIVATE_EQUITIES_TAB, ASSET_CLASSES, ASSET_CLASS_IDS, AssetClassId } from '../lib/privateEquities';
import { setPrivateEquityCmp } from '../lib/privateEquityWrite';
import { loadScripPrices, invalidatePriceCache, ScripPrice, PriceSource } from '../lib/scripPrices';
import { refreshYahooPrices, hasYahooWebApp } from '../lib/yahooPrices';
import PriceStatusButton from './PriceStatusButton';
import SourceBadge from './SourceBadge';
import { loadOpeningHoldings, updateOpeningHoldingRow, OPENING_HOLDINGS_TAB } from '../lib/openingHoldings';
import { loadCorporateActions, CORP_ACTIONS_TAB, CorpActionType, CorpAction } from '../lib/corporateActions';
import { updateCorporateAction } from '../lib/manualTrades';
import {
  loadOpeningCorpActionRows, deleteOpeningCorpActions, restoreOpeningCorpActions,
  OPENING_CORP_ACTIONS_TAB, SavedCorpAction,
} from '../lib/openingCorpActions';
import { deleteSheetRow, insertSheetRow } from '../lib/sheetTabs';
import { registerBackStep } from '../lib/appBack';
import { ledgerSide, isSplitType, isTransferType, solveQtyPriceAmount } from '../lib/tradeRowSchema';
import { TransferHoldingModal } from './TransferHoldingModal';
import { formatDMY, formatDMYTime } from '../lib/dates';
import ScripReviewModal from './ScripReviewModal';
import AddTradeModal from './AddTradeModal';
import StockOpeningImportModal from './StockOpeningImportModal';
import CubeLoader from './ui/CubeLoader';
import { GainBar } from './ui/HoldingsViz';
import { PORTFOLIOS, portfolioById, sheetIdForId, portfolioSheetUrl, DEFAULT_PORTFOLIO_ID } from '../lib/portfolios';
import { classifySheetsError, sheetsAccessLabel, SheetsErrorKind } from '../lib/sheetsAccess';
import { toast, confirmDialog, ModalShell } from './ui/overlay';

// Parse a "23 Jun 2026, 02:30 PM"-style IST stamp (as written to the Prices tab)
// to epoch ms, so we can pick the most recent one. Tolerant of am/pm casing and
// minor format drift across browsers; falls back to Date.parse, then 0.
const STAMP_MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const parsePriceStamp = (s: string): number => {
  const m = s.match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})[,\s]+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/);
  if (!m) { const t = Date.parse(s); return isNaN(t) ? 0 : t; }
  let hh = parseInt(m[4]);
  const ap = (m[6] || '').toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  return new Date(parseInt(m[3]), STAMP_MONTHS[m[2].toLowerCase()] ?? 0, parseInt(m[1]), hh, parseInt(m[5])).getTime();
};

// NSE/BSE close at 15:30 IST. A price stamped at or after that is a SETTLED close for its
// own session; anything earlier is a live intraday tick that will still move. Shown in the
// UI by colouring the CMP (see `.cmp-settled`), so the closing print is identifiable at a
// glance. Deliberately a property of the stamp alone — no trading-holiday calendar needed,
// so Friday's 15:45 capture stays "settled" over the weekend. A pre-bell refresh the next
// morning reads as unsettled, which is correct: that session's close isn't in yet.
const MARKET_CLOSE_MIN = 15 * 60 + 30;
const isSettledClose = (stamp: string): boolean => {
  const ts = parsePriceStamp(stamp || '');
  if (!ts) return false;
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes() >= MARKET_CLOSE_MIN;
};

const csvEscape = (v: any) => { const s = (v ?? '').toString(); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

// "Edit Entry" popup field specs. `header` is the True Entry sheet column; a field is
// only shown/written when that column exists in the current sheet's header row.
const TE_CORE_FIELDS: { key: string; label: string; header: string; kind: 'text' | 'type' | 'num' | 'class' }[] = [
  { key: 'tradeDate', label: 'Trade Date', header: 'Trade Date', kind: 'text' },
  { key: 'transactionType', label: 'Type', header: 'Transaction Type', kind: 'type' },
  { key: 'tradeClass', label: 'Trade Class', header: 'Trade Class', kind: 'class' },
  { key: 'quantity', label: 'Quantity', header: 'Number of Shares', kind: 'num' },
  { key: 'price', label: 'Avg Price', header: 'Avg Price', kind: 'num' },
  { key: 'turnover', label: 'Turnover', header: 'Total Amount (Turnover)', kind: 'num' },
];
const TE_EXPENSE_FIELDS: { key: string; label: string; header: string }[] = [
  { key: 'brokerage', label: 'Total Brokerage', header: 'Total Brokerage' },
  { key: 'stt', label: 'STT', header: 'STT' },
  { key: 'etc', label: 'Exchange Charges', header: 'Exchange Turnover Charges' },
  { key: 'sebi', label: 'SEBI Fees', header: 'SEBI Turnover Fees' },
  { key: 'ipf', label: 'IPF Charges', header: 'IPF Charges' },
  { key: 'demat', label: 'Demat Charges', header: 'Demat Charges' },
  { key: 'gst', label: 'Total GST', header: 'Total GST' },
  { key: 'igst', label: 'IGST', header: 'IGST' },
  { key: 'stamp', label: 'Stamp Duty', header: 'Stamp Duty' },
];
const numCell = (v: any): number => { const n = parseFloat((v ?? '').toString().replace(/,/g, '')); return isNaN(n) ? 0 : n; };

interface HoldingsProps {
  holdings: PortfolioHolding[];
  setHoldings: (h: PortfolioHolding[] | ((prev: PortfolioHolding[]) => PortfolioHolding[])) => void;
  parsedContractNote: ContractNoteResult | null;
  activePortfolio: string;
  setActivePortfolio: (id: string) => void;
  isDetailView: boolean;
  setIsDetailView: (val: boolean) => void;
  // Open the Reports view locked to one stock + account (the "Report" button on a
  // stock's detail page). Structurally matches Reports' StockFocus.
  onOpenReport?: (focus: { portfolioId: string; scripName: string; isin: string }) => void;
  // Set by App when the user presses Back from a stock-scoped Report: re-open THIS stock's
  // detail page (Holdings unmounted when Reports opened, losing its selection). One-shot —
  // Holdings calls onReopenHandled once it has re-selected the stock (or given up).
  reopenStock?: { portfolioId: string; scripName: string; isin: string } | null;
  onReopenHandled?: () => void;
}

interface SheetHolding {
  companyName: string;
  isin: string;
  quantity: number;
  avgBuyPrice: number;
  investedValue: number;
  /** Column F: the price this scrip last actually transacted at. 0 when it never has (a
   *  position carried in from Opening Holdings and never traded since), or when the Holding
   *  tab predates the column - in which case an unlisted position still shows at cost until
   *  the next rebuild, which is the safe way round. */
  lastTradePrice?: number;
  /** Column G: Sheets serial of that trade. `formatDMY` reads a bare serial directly. */
  lastTradeDate?: number;
}

interface Transaction {
  tradeDate: string;
  isin: string;
  assetName: string;
  transactionType: string;
  quantity: number;
  price: number;
  turnover: number;
  brokerage: number;
  brokeragePerShare: number;
  amount: number;
  balanceQuantity?: number;
  isOpening?: boolean;   // seeded from the Opening Holdings tab (carried-in basis)
  longTerm?: boolean;    // opening lot's long-term flag (pre-Apr-2024 block)
  // Edit-in-place metadata (Google portfolios only): which sheet a row came from and
  // its 1-based row number, so the "Edit Entry" popup can write the change straight back.
  editSource?: 'trueEntry' | 'opening';
  sheetRow?: number;
  rawRow?: any[];        // the full True Entry row (preserves columns the popup doesn't edit)
  notes?: string;        // free-text note from the ledger's Notes column, shown in the entry popup
  // A row synthesised from the "Corporate Actions" tab (merger / demerger), so this view's
  // FIFO transforms the lots exactly like the Holding-tab and capital-gains engines do.
  // `role` is this scrip's side of the action: 'in' = it's the `to` (Acquirer / NewCo,
  // receives shares + carried cost), 'out' = it's the `from` (Target absorbed by a merger,
  // or Parent whose cost a demerger reduces). Never editable — corp actions are edited in
  // their own tab, so these rows carry no `editSource`.
  /**
   * Synthetic row derived from the "Corporate Actions" tab. ONE tab row produces TWO of these
   * — an 'out' leg on the parent's detail page and an 'in' leg on the NewCo's — both reading
   * the same `cost`, so editing either edits the same `rowIndex`. That shared identity is the
   * point: a demerger must move exactly as much cost out as it puts in.
   */
  corpAction?: {
    kind: 'MERGER' | 'DEMERGER'; role: 'in' | 'out'; sharesIn: number; cost: number;
    rowIndex?: number; type?: CorpActionType; from?: string; to?: string; notes?: string;
  };
  // A pre-FY26 Bonus / Split / Rights recorded in the "Opening Corp Actions" tab.
  // DISPLAY ONLY — it is deliberately NOT replayed here. That tab is a memo of the ratios
  // typed during an opening-basis import; the 31-Mar-2025 Opening Holdings snapshot ALREADY
  // reflects the action, so applying it again would double-count. It's shown because it was
  // otherwise invisible in the app: you could delete a scrip's opening lot and never know
  // these were left behind. `key` is the tab's row key, for the cascade-delete offer.
  openingAction?: { key: string; type: string; num: number; den: number; price: number };
}

/**
 * Same-day event order, mirroring `replayFifoHoldings` and the capital-gains engine:
 * BUY (0) → SPLIT / MERGER / DEMERGER (1) → SELL (2). A split must rescale, and a
 * demerger must apportion cost out, BEFORE a same-day sell consumes the lots —
 * otherwise the sell matches a pre-action cost and the order would silently depend
 * on which row happens to sit higher in the sheet.
 */
/**
 * Date of an Opening Corp Actions row, as ISO `yyyy-mm-dd` (what `parseDateStr` handles).
 *
 * Read the KEY, not the date cell. `corpActionKey()` builds `scrip#KIND#yyyy-mm-dd`, which is
 * unambiguous — whereas the Date COLUMN is corrupt for a subset of rows. `saveOpeningCorpActions`
 * writes it as `dd-mm-yyyy` with `valueInputOption:"USER_ENTERED"`, so Sheets re-reads any date
 * whose day is ≤ 12 as US `mm-dd` and stores a SWAPPED serial:
 *   Reliance bonus 07-09-2017 (7 Sep) → serial 42925 = 9 Jul 2017
 *   Infosys  bonus 04-09-2018 (4 Sep) → serial 43199 = 9 Apr 2018
 * Rows with a day > 12 ("22-02-2024") can't parse as US, so they survive as plain text — which
 * is why the column is a mix of correct strings and wrong serials [[date-serials]]. Harmless to
 * the replay (it matches on `key`), but it would render nonsense dates here.
 */
const openingActionDate = (key: string, dateCell: any): string => {
  const fromKey = (key || '').match(/#(\d{4}-\d{2}-\d{2})$/);
  if (fromKey) return fromKey[1];
  const s = (dateCell ?? '').toString().trim();
  if (!s) return '';
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    if (n > 20000 && n < 80000) {          // plausible serial (1954-2119), not a stray number
      return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
    }
    return s;
  }
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);   // dd-mm-yyyy → yyyy-mm-dd
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
};

/**
 * Checkbox rendered INSIDE the delete-confirm dialog when removing a scrip's last opening
 * lot while pre-FY26 action memos remain. `confirmDialog` only resolves a boolean, so the
 * choice is reported through a caller-owned ref; this keeps its own state so it re-renders.
 */
const CascadeDeleteToggle = ({ count, onChange }: { count: number; onChange: (v: boolean) => void }) => {
  const [on, setOn] = useState(true);
  return (
    <label className="mt-3 flex items-start gap-2 p-2.5 rounded-lg bg-violet-50 border border-violet-200 cursor-pointer">
      <input type="checkbox" checked={on} className="mt-0.5 accent-violet-600"
        onChange={(e) => { setOn(e.target.checked); onChange(e.target.checked); }} />
      {/* violet-800, not -900: only 800 has a dark-theme remap [[mono-light-theme]] */}
      <span className="text-[11px] text-violet-800 leading-relaxed">
        Also remove the <b>{count}</b> pre-FY26 corporate action{count === 1 ? '' : 's'} recorded for this stock
        in “{OPENING_CORP_ACTIONS_TAB}”. They only describe how to rebuild this lot, so with the lot gone
        they are orphaned — and they would re-apply if you ever re-import this stock's statement.
      </span>
    </label>
  );
};

const txEvOrd = (t: Transaction): number =>
  t.corpAction ? 1 : isSplitType(t.transactionType) ? 1 : ledgerSide(t.transactionType) === 'SELL' ? 2 : 0;

interface DisplayHolding {
  id: string;
  symbol: string;
  name: string;
  isin: string;
  sector: string;
  quantity: number;
  avgCost: number;
  currentPrice: number;
  currentValue: number;
  unrealizedGain: number;
  unrealizedGainPct: number;
  todayGain: number;   // qty × (CMP − previous-day price); 0 when no prev price recorded
  type: string;
  sold?: boolean;   // exited position (traded historically, no current holding)
  discrepancy?: boolean;   // impossible NEGATIVE net qty → a data error to trace/fix
  // Unlisted (private-equity) facts, carried so the row can render honestly. `type === 'PE'`
  // says it IS unlisted; peValuation says whether a per-share value was actually entered —
  // which is a different question, and the one that decides between a figure and "at cost".
  peValuation?: number;
  peValuationDate?: string;
  /** The price this unlisted company last transacted at, and when (Sheets serial). Used when
   *  no valuation was entered - it is real evidence, where the average cost is none. */
  lastTradePrice?: number;
  lastTradeDate?: number;
  driveLink?: string;
  original: any;
}

// Screener.in company URL from a scrip's exchange identifiers. Screener's page slug
// is the NSE symbol when the company is listed there, else the numeric BSE scrip code
// — both live in the scrip master (entry.nse / entry.bse). "" when neither is known,
// since Screener has no ISIN-based URL. The bare /company/<code>/ form redirects to the
// consolidated or standalone view automatically.
const screenerUrl = (nse?: string, bse?: string): string => {
  const code = ((nse || '').trim() || (bse || '').trim()).split(/[\s,|]/)[0].trim();
  return code ? `https://www.screener.in/company/${encodeURIComponent(code)}/` : '';
};

// Screener.in mark — the ascending green bar chart on a dark tile. Inline SVG so it's
// crisp at any size and needs no external request.
const ScreenerLogo = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect width="32" height="32" rx="7" fill="#0e1526" />
    <rect x="6.5" y="17" width="4.5" height="8.5" rx="1.3" fill="#3fae46" />
    <rect x="13.75" y="11.5" width="4.5" height="14" rx="1.3" fill="#54c65a" />
    <rect x="21" y="6.5" width="4.5" height="19" rx="1.3" fill="#6ddc71" />
  </svg>
);

export default function Holdings({
  holdings, 
  setHoldings, 
  parsedContractNote,
  activePortfolio,
  setActivePortfolio,
  isDetailView,
  setIsDetailView,
  onOpenReport,
  reopenStock,
  onReopenHandled
}: HoldingsProps) {
  const [sheetCmpOverrides, setSheetCmpOverrides] = useState<Record<string, number>>({});
  /** Which unlisted holding's CMP is being written to the Private Equities tab right now. */
  const [savingPeCmp, setSavingPeCmp] = useState<string | null>(null);

  // Drilldown states
  const [selectedStock, setSelectedStock] = useState<SheetHolding | PortfolioHolding | null>(null);

  // Browser / mouse BACK button → close an open stock detail (deepest level, → back to the list).
  // The app has no router; a shared handler ([appBack](../lib/appBack.ts)) runs the deepest active
  // level so Back walks detail → list → top-view instead of unloading the SPA. The ref keeps the
  // predicate reading CURRENT state; registered once. The list & top-level steps live in App.tsx
  // (they own isDetailView / currentView). See [[spa-navigation-back-button]].
  const selectedStockRef = useRef(selectedStock);
  selectedStockRef.current = selectedStock;
  useEffect(() => registerBackStep(3, () => selectedStockRef.current != null, () => { setSelectedStock(null); setCustomCmp(null); }), []);
  // Scrip master (NSE/BSE/ISIN reference) for the stock-detail header pills.
  const [scrip, setScrip] = useState<ScripMaster | null>(null);
  // Current-price snapshot (from the screener.in import) — values holdings live-ish.
  const [priceRows, setPriceRows] = useState<ScripPrice[]>([]);
  // Both reads need a LIVE Google token, and the saved token is restored ASYNCHRONOUSLY after
  // mount. Firing once on mount therefore raced the auth and usually lost: loadScripPrices
  // swallows its error and returns [], so priceRows stayed EMPTY for the whole session — every
  // holding then fell back to avg cost, which is why values equalled "Invested" and every card
  // read +0.00%. Retry until authorized, exactly like the portfolio-total prefetch below.
  useEffect(() => {
    let loaded = false;
    const run = () => {
      if (loaded || !hasAuthorizedGoogle()) return false;
      loaded = true;
      loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID).then(setScrip).catch(() => {});
      loadScripPrices(SCRIP_MASTER_SPREADSHEET_ID).then(setPriceRows).catch(() => {});
      return true;
    };
    if (run()) return;
    let tries = 0;
    const id = window.setInterval(() => {
      tries++;
      if (run() || tries >= 30) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // On-demand market-price refresh (Yahoo, via the Apps Script web app), then re-value.
  // If no web app is configured, or the live pull fails, fall back to re-reading the
  // last-saved Prices tab (the scheduled trigger keeps it reasonably fresh regardless).
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  // Bumped after a price refresh so the "unpriced" button re-reads the Price Status tab.
  const [priceRefreshTick, setPriceRefreshTick] = useState(0);
  const handleRefreshPrices = async () => {
    setRefreshingPrices(true);
    try {
      if (hasYahooWebApp()) {
        try {
          const r = await refreshYahooPrices();
          if (r.busy) {
            toast.info('A price update is already running — give it a moment and try again.');
          } else {
            // `missed` includes the deferred ones; report them apart so a rate-limited run doesn't
            // look like a pile of genuinely unpriceable scrips.
            const unpriced = Math.max(0, (r.missed ?? 0) - (r.deferred ?? 0));
            toast.success(
              `Prices updated — ${r.updated ?? 0} of ${r.total ?? 0} scrips`
              + (unpriced ? ` · ${unpriced} unpriced` : '')
              + (r.deferred ? ` · ${r.deferred} deferred to next run` : '')
            );
          }
        } catch (e: any) {
          toast.error('Live price refresh failed: ' + (e?.message || 'error') + ' — showing last saved prices');
        }
      } else {
        toast.info('Reloaded saved prices. Configure the Yahoo web-app URL for a live refresh.');
      }
      invalidatePriceCache();
      try {
        // loadScripPrices now throws rather than reporting a failed read as "no prices"
        // (that silent [] is what valued the whole book at cost). invalidatePriceCache
        // just cleared the fallback, so this is the one call site with nothing to serve.
        const rows = await loadScripPrices(SCRIP_MASTER_SPREADSHEET_ID, { force: true });
        setPriceRows(rows);
        setPriceRefreshTick(t => t + 1);
      } catch (e: any) {
        toast.error('Could not read the Prices tab: ' + (e?.result?.error?.message || e?.message || 'error')
          + ' — keeping the prices already on screen.');
      }
    } finally {
      setRefreshingPrices(false);
    }
  };

  // Index the imported prices under several keys (canonical scrip key, raw ISIN,
  // normalized name) so a holding matches whether it carries an ISIN or not.
  const priceMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of priceRows) {
      if (!(p.price > 0)) continue;
      if (p.isin) m.set('isin:' + p.isin.toUpperCase(), p.price);
      if (p.name) m.set('name:' + normName(p.name), p.price);
      if (scrip) { const e = lookupScrip(scrip, p.isin, p.name).entry; if (e) m.set('key:' + e.key, p.price); }
    }
    return m;
  }, [priceRows, scrip]);

  // Real current price for a holding (undefined when we have no imported price for it).
  // Mirrors makePriceResolver in scripPrices.ts, including its private-equity fallback —
  // the two must agree or a stock's page would value a position differently from the AUM.
  const getRealCmp = (isin: string, name: string, lastTradePrice?: number): number | undefined => {
    const e = scrip ? lookupScrip(scrip, isin, name).entry : null;
    if (e) { const v = priceMap.get('key:' + e.key); if (v !== undefined) return v; }
    if (isin) { const v = priceMap.get('isin:' + isin.toUpperCase()); if (v !== undefined) return v; }
    const byName = priceMap.get('name:' + normName(name));
    if (byName !== undefined) return byName;
    // An unlisted company has no fetched price. Two fallbacks, most authoritative first: a
    // hand-entered per-share valuation from the Private Equities tab, then the price it last
    // actually transacted at. Both checked last, so a real market price always wins. PE only -
    // substituting a stale trade for a LISTED stock would hide a broken price import.
    // Must stay in step with makePriceResolver (scripPrices.ts) or a stock's page would value
    // its position differently from the AUM.
    if (e && e.assetClass) {
      if ((e.peValuation ?? 0) > 0) return e.peValuation;
      if (lastTradePrice !== undefined && lastTradePrice > 0) return lastTradePrice;
    }
    return undefined;
  };

  // Which feed set a scrip's shown price (Yahoo / Screener) — powers the CMP source badge.
  // Indexed exactly like priceMap so a holding matches with or without an ISIN.
  const priceSourceMap = useMemo(() => {
    const m = new Map<string, PriceSource>();
    for (const p of priceRows) {
      if (!(p.price > 0) || !p.source) continue;
      if (p.isin) m.set('isin:' + p.isin.toUpperCase(), p.source);
      if (p.name) m.set('name:' + normName(p.name), p.source);
      if (scrip) { const e = lookupScrip(scrip, p.isin, p.name).entry; if (e) m.set('key:' + e.key, p.source); }
    }
    return m;
  }, [priceRows, scrip]);
  const getCmpSource = (isin: string, name: string): PriceSource | undefined => {
    if (scrip) { const e = lookupScrip(scrip, isin, name).entry; if (e) { const v = priceSourceMap.get('key:' + e.key); if (v) return v; } }
    if (isin) { const v = priceSourceMap.get('isin:' + isin.toUpperCase()); if (v) return v; }
    return priceSourceMap.get('name:' + normName(name));
  };

  // When each scrip's shown price was captured (Prices tab "Updated") — drives the settled-
  // close colouring on the CMP. Indexed exactly like priceMap.
  const priceUpdatedMap = useMemo(() => {
    const m = new Map<string, { updated: string; priceDate: string }>();
    for (const p of priceRows) {
      if (!(p.price > 0) || !p.updated) continue;
      const v = { updated: p.updated, priceDate: p.priceDate || '' };
      if (p.isin) m.set('isin:' + p.isin.toUpperCase(), v);
      if (p.name) m.set('name:' + normName(p.name), v);
      if (scrip) { const e = lookupScrip(scrip, p.isin, p.name).entry; if (e) m.set('key:' + e.key, v); }
    }
    return m;
  }, [priceRows, scrip]);
  const getCmpStamp = (isin: string, name: string): { updated: string; priceDate: string } | undefined => {
    if (scrip) { const e = lookupScrip(scrip, isin, name).entry; if (e) { const v = priceUpdatedMap.get('key:' + e.key); if (v) return v; } }
    if (isin) { const v = priceUpdatedMap.get('isin:' + isin.toUpperCase()); if (v) return v; }
    return priceUpdatedMap.get('name:' + normName(name));
  };
  // The newest session present anywhere in the Prices tab IS the current one — the same
  // self-calibrating trick the updater uses, so no trading-holiday calendar is needed here
  // either. '' on sheets written before the "Price Date" column existed.
  const currentSession = useMemo(
    () => priceRows.reduce((mx, p) => (p.priceDate && p.priceDate > mx ? p.priceDate : mx), ''),
    [priceRows],
  );

  // Previous-day price baseline (Prices tab "Previous Price" column, rolled once per
  // day at import) → powers "today's gain". Indexed the same way as the CMP map.
  const prevPriceMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of priceRows) {
      const pp = p.previousPrice || 0;
      if (!(pp > 0)) continue;
      if (p.isin) m.set('isin:' + p.isin.toUpperCase(), pp);
      if (p.name) m.set('name:' + normName(p.name), pp);
      if (scrip) { const e = lookupScrip(scrip, p.isin, p.name).entry; if (e) m.set('key:' + e.key, pp); }
    }
    return m;
  }, [priceRows, scrip]);

  // Previous-day price for a holding (undefined when none is recorded yet).
  const getRealPrevCmp = (isin: string, name: string): number | undefined => {
    if (scrip) { const e = lookupScrip(scrip, isin, name).entry; if (e) { const v = prevPriceMap.get('key:' + e.key); if (v !== undefined) return v; } }
    if (isin) { const v = prevPriceMap.get('isin:' + isin.toUpperCase()); if (v !== undefined) return v; }
    return prevPriceMap.get('name:' + normName(name));
  };

  // The most recent "Updated" stamp across imported prices — shown top-right.
  const lastPriceUpdate = useMemo(() => {
    const stamps = priceRows.map(p => p.updated).filter(Boolean);
    if (stamps.length === 0) return '';
    let best = stamps[0], bestT = parsePriceStamp(stamps[0]);
    for (const s of stamps) { const t = parsePriceStamp(s); if (t > bestT) { bestT = t; best = s; } }
    return best;
  }, [priceRows]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoadingTransactions, setIsLoadingTransactions] = useState(false);
  // True Entry header row for the current drill-down (maps field → column when writing an edit).
  const [trueEntryHeaders, setTrueEntryHeaders] = useState<string[]>([]);
  // "Edit Entry" popup state.
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  // Trade Book row whose bifurcated expenses are shown in the breakdown popup (view mode).
  const [expenseTx, setExpenseTx] = useState<Transaction | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingEdit, setDeletingEdit] = useState(false);
  // Corporate-action row being edited (its own popup — the inline row editor is built for
  // qty/price/charges, none of which a merger/demerger has).
  const [caEditTx, setCaEditTx] = useState<Transaction | null>(null);
  const [caEditForm, setCaEditForm] = useState({ dateISO: '', sharesIn: '', cost: '', notes: '' });
  const [caEditSaving, setCaEditSaving] = useState(false);
  // Row that just saved successfully — flashes emerald once, then clears.
  const [justSavedRow, setJustSavedRow] = useState<{ editSource: string; sheetRow: number } | null>(null);
  // Args of the current drill-down, so an edit can re-fetch the same scrip after saving.
  const [lastTxFetch, setLastTxFetch] = useState<{ companyName: string; isin: string } | null>(null);
  // "Show Sold" toggle: also list companies that were traded but are no longer held.
  // Derived from True Entry + Opening Holdings — NOT the Holding tab, which only
  // ever contains qty > 0 positions (rebuildHoldingTab filters them out).
  const [showSold, setShowSold] = useState(false);
  // Which asset class the grid lists. Listed equity and unlisted companies live in the SAME
  // ledger and both count toward this account's totals; this only narrows the list. Deliberately
  // not persisted (like showSold) — a filter silently restored on a later visit would show an
  // account at a fraction of its real value with nothing on screen explaining why.
  // 'all' | 'eq' | one per non-listed class. Derived from the registry so a new tab needs no
  // change here.
  const [assetClass, setAssetClass] = useState<'all' | 'eq' | AssetClassId>('all');
  const [soldHoldings, setSoldHoldings] = useState<SheetHolding[]>([]);
  const [isLoadingSold, setIsLoadingSold] = useState(false);
  const [rebuildingHoldings, setRebuildingHoldings] = useState(false);
  const [activeDetailTab, setActiveDetailTab] = useState<'trade_book' | 'inventory' | 'realised_inventory'>('trade_book');
  const [customCmp, setCustomCmp] = useState<number | null>(null);
  const [isEditingCmp, setIsEditingCmp] = useState(false);
  const [cmpInputVal, setCmpInputVal] = useState('');
  const [txSearchTerm, setTxSearchTerm] = useState('');
  const [txSort, setTxSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'tradeDate', dir: 'desc' });
  
  // States for fetching spreadsheet holdings
  const [sheetHoldings, setSheetHoldings] = useState<SheetHolding[]>([]);
  const [sheetTotal, setSheetTotal] = useState<number>(0);

  // Keep the open stock-detail card in sync with the (re-)fetched Holding tab. `selectedStock`
  // is a SNAPSHOT taken when the row was clicked; after an edit/delete, saveEdit rebuilds the
  // Holding tab and refetches `sheetHoldings` but never re-points `selectedStock`, so the
  // Position Size card kept showing the OLD invested/avg (only Holding Qty updated, since that
  // comes from the re-fetched transactions). Re-point it to the fresh row so Invested Value /
  // Avg Buy Price update immediately — no manual "Rebuild" needed.
  useEffect(() => {
    if (!selectedStock || activePortfolio === 'local') return;
    const sel = selectedStock as SheetHolding;
    const fresh = sheetHoldings.find(h =>
      (sel.isin && h.isin && h.isin.toLowerCase() === sel.isin.toLowerCase()) ||
      (!!h.companyName && h.companyName === sel.companyName));
    if (fresh && (fresh.quantity !== sel.quantity || fresh.investedValue !== sel.investedValue || fresh.avgBuyPrice !== sel.avgBuyPrice)) {
      setSelectedStock(fresh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetHoldings]);

  // Re-open a stock's detail page after the user returns from its scoped Report via Back.
  // App hands us the stock in `reopenStock`; once THIS portfolio's holdings have loaded we
  // match the row (by ISIN, else canonical name), open its detail, and clear the request so
  // it fires only once. Waits for the right account + a populated Holding tab.
  useEffect(() => {
    if (!reopenStock || activePortfolio === 'local') return;
    if (activePortfolio !== reopenStock.portfolioId) return;
    if (!sheetHoldings.length) return;
    const target = sheetHoldings.find(h =>
      (reopenStock.isin && h.isin && h.isin.toLowerCase() === reopenStock.isin.toLowerCase()) ||
      (!!h.companyName && normName(h.companyName) === normName(reopenStock.scripName)));
    if (target) {
      setSelectedStock(target);
      setIsDetailView(true);
    }
    onReopenHandled?.();   // one-shot, whether or not a row matched
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reopenStock, sheetHoldings, activePortfolio]);
  // Per-portfolio Holding-tab totals for the summary cards. Keyed by portfolio id,
  // so each card keeps its own last-synced value — syncing/opening one portfolio
  // never zeroes the others (which happened when all cards read one sheetTotal).
  const [portfolioTotals, setPortfolioTotals] = useState<Record<string, number>>({});
  // Which portfolios this user cannot read. Sheets sharing is the real boundary, so
  // this records Google's answer rather than deciding anything itself.
  const [portfolioAccess, setPortfolioAccess] = useState<Record<string, SheetsErrorKind>>({});
  // Each portfolio's Holding rows (name / ISIN / qty / invested), so EVERY summary card can be
  // valued at the live CMP — not just the one that's open. Stored RAW rather than pre-valued so
  // the cards re-price themselves the moment the Prices tab finishes loading.
  const [portfolioRows, setPortfolioRows] = useState<Record<string, { name: string; isin: string; qty: number; invested: number }[]>>({});
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);

  // original local portfolios state
  const [searchTerm, setSearchTerm] = useState('');
  // Default: Security Name ascending (0-9 → A-Z), per user request.
  const [sortField, setSortField] = useState<'symbol' | 'quantity' | 'avgCost' | 'currentPrice' | 'currentValue' | 'profit'>('symbol');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // ── Resizable holdings-grid columns (Excel-style drag) ────────────────────────
  // Per-column pixel widths, persisted in localStorage so a user's sizing sticks. Keys
  // match the data columns below; the trailing "settings" column exists only for `local`.
  const HOLDINGS_COLW_KEY = 'holdingsColWidthsV1';
  const HOLDINGS_COL_DEFAULTS: Record<string, number> = {
    name: 280, quantity: 110, avgCost: 120, currentPrice: 120, currentValue: 140, profit: 170, settings: 80,
  };
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try { const s = localStorage.getItem(HOLDINGS_COLW_KEY); if (s) return { ...HOLDINGS_COL_DEFAULTS, ...JSON.parse(s) }; } catch { /* ignore */ }
    return { ...HOLDINGS_COL_DEFAULTS };
  });
  useEffect(() => { try { localStorage.setItem(HOLDINGS_COLW_KEY, JSON.stringify(colWidths)); } catch { /* ignore */ } }, [colWidths]);
  // A drag ends with a synthesized `click` on the <th> (mousedown on the handle, mouseup on a
  // sibling) — this flag lets requestSort ignore that one click so resizing never re-sorts.
  const didColResizeRef = useRef(false);
  // Drag a column's right edge to resize it (min 60px). Uses window listeners so the drag
  // continues even when the pointer leaves the thin handle.
  const startColResize = (e: React.MouseEvent, key: string) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[key] ?? HOLDINGS_COL_DEFAULTS[key] ?? 120;
    const onMove = (ev: MouseEvent) => {
      didColResizeRef.current = true;   // set on real movement, so a click with no drag still sorts
      const w = Math.max(60, startW + (ev.clientX - startX));
      setColWidths((prev) => ({ ...prev, [key]: w }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      // The trailing click fires synchronously right after mouseup; clear on the next tick.
      setTimeout(() => { didColResizeRef.current = false; }, 0);
    };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
  };
  
  // Manual adding forms state
  const [showAddForm, setShowAddForm] = useState(false);
  // Manual trade entry drawer (writes real trades to the portfolio's sheet).
  const [showAddTrade, setShowAddTrade] = useState(false);
  // Temporary per-stock opening-basis CSV import (detail page → Trade Book toolbar).
  const [showOpeningImport, setShowOpeningImport] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  // The detail page's single "Actions" menu (Add Trade / Edit Entry / Import / Transfer).
  // One control in the Trade Book tab bar instead of four competing buttons.
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsBtnRef = useRef<HTMLButtonElement>(null);
  // The panel is PORTALLED to <body>, so it needs viewport coordinates rather than
  // `absolute right-0 top-full`. See the placement effect for why it cannot stay in flow.
  const actionsPanelRef = useRef<HTMLDivElement>(null);
  const [actionsPos, setActionsPos] = useState<{ top: number; right: number } | null>(null);
  // "Edit Trade" mode — reveals inline row editing in the Trade Book (replaces the
  // always-on per-row Edit button). Toggled from the detail page's Position card.
  const [editMode, setEditMode] = useState(false);
  // Anchor the portalled Actions panel under its trigger, and keep it there while the page
  // scrolls. `true` on the scroll listener is load-bearing: scroll does not bubble, and the
  // trigger sits inside the ledger's own scrolling containers.
  useLayoutEffect(() => {
    if (!actionsOpen) return;
    const place = () => {
      const r = actionsBtnRef.current?.getBoundingClientRect();
      if (!r) return;
      // clientWidth, not innerWidth - innerWidth includes the scrollbar and would push the
      // right-anchored panel off by its width.
      setActionsPos({ top: r.bottom + 6, right: Math.max(8, document.documentElement.clientWidth - r.right) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [actionsOpen]);
  // Close the Actions menu on an outside click or Escape - same pattern as ExportMenu and
  // the Nuvama variant menu in App.tsx. No focus trap: the menu owns no modal surface.
  useEffect(() => {
    if (!actionsOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The panel is NOT a DOM descendant of the wrapper any more (it is portalled), so it
      // has to be spared explicitly. Miss this and mousedown unmounts the item before its
      // own click can fire - every entry in the menu would silently do nothing.
      if (actionsMenuRef.current?.contains(t) || actionsPanelRef.current?.contains(t)) return;
      setActionsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActionsOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [actionsOpen]);
  // Multi-select delete (edit mode): selected row keys `${editSource}:${sheetRow}`.
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [newSymbol, setNewSymbol] = useState('');
  const [newName, setNewName] = useState('');
  const [newIsin, setNewIsin] = useState('');
  const [newQty, setNewQty] = useState('');
  const [newCost, setNewCost] = useState('');
  const [newCurrentPrice, setNewCurrentPrice] = useState('');
  const [newSector, setNewSector] = useState('Financial Services');

  const [editingPriceId, setEditingPriceId] = useState<string | null>(null);
  const [editingPriceValue, setEditingPriceValue] = useState('');
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [isSyncingCapGains, setIsSyncingCapGains] = useState(false);
  const [capGainsSyncStatus, setCapGainsSyncStatus] = useState<{ pid?: string; success?: boolean; error?: string; stcg?: number; ltcg?: number } | null>(null);
  const [isRebuildingHolding, setIsRebuildingHolding] = useState(false);
  const [holdingRebuildStatus, setHoldingRebuildStatus] = useState<{ pid?: string; result?: RebuildHoldingResult; error?: string } | null>(null);
  // Which portfolio a main-page action is currently running for (spinner/disable per row).
  const [actionPid, setActionPid] = useState<string | null>(null);
  const [downloadingFor, setDownloadingFor] = useState<string | null>(null);
  // FY transaction-register generator (scrip-wise Excel Trx tab)
  const [isGeneratingTrx, setIsGeneratingTrx] = useState(false);
  const [trxStatus, setTrxStatus] = useState<{ pid?: string; result?: TrxRegisterResult; error?: string } | null>(null);
  const [selectedFy, setSelectedFy] = useState<number>(() => {
    const now = new Date();
    const cur = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;   // Indian FY starts 1-Apr
    return cur - 1;   // default to the latest completed financial year
  });
  const fyOptions = useMemo(() => {
    const now = new Date();
    const cur = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return Array.from({ length: 7 }, (_, i) => cur - i);   // current FY + 6 prior
  }, []);
  // Securities the resolver couldn't auto-match (for the in-app review popup)
  const [scripReview, setScripReview] = useState<{ pid?: string; master: ScripMaster; unresolved: UnresolvedScrip[] } | null>(null);
  const [showScripModal, setShowScripModal] = useState(false);

  // Live fetching trigger from Google Sheet.
  // silent=true → background refresh: no spinner, keep current rows visible, never blank the view on error.
  const fetchSheetHoldings = async (portfolio: string, silent = false) => {
    if (!gapi || !gapi.client) {
      if (!silent) setSheetError("Google API library is loading. Please try again in a few seconds.");
      return;
    }
    const token = (gapi.client as any).getToken();
    if (!token || !token.access_token) {
      if (!silent) setSheetError("Google Sheets connection is required. Please authorize first with the secure log in client below.");
      return;
    }

    const spreadsheetId = sheetIdForId(portfolio);
    if (!spreadsheetId) { if (!silent) setSheetError("Unknown portfolio."); return; }

    if (!silent) {
      setIsLoadingSheet(true);
      setSheetError(null);
      setSheetHoldings([]);
      setSheetTotal(0);
    }

    try {
      const response = await (gapi.client as any).sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        // A:G - F is Last Trade Price, G its date. Both appended by rebuildHoldingTab, so a
        // tab written before they existed simply returns short rows.
        range: `Holding!A:G`,
      });

      const rows = response?.result?.values || [];
      if (rows.length < 2) {
        setPortfolioTotals(prev => ({ ...prev, [portfolio]: 0 }));   // empty Holding tab → genuinely 0
        if (!silent) {
          setSheetError("The 'Holding' spreadsheet tab appears empty. Try importing a contract note first to recalculate active holdings.");
          setIsLoadingSheet(false);
        }
        return;
      }

      const parsed: SheetHolding[] = [];
      let totalValue = 0;

      // Skip header row
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;
        
        const companyName = (row[0] || "").toString().trim();
        const isin = (row[1] || "").toString().trim();
        const qty = parseFloat((row[2] || "").toString().replace(/,/g, "").trim());
        const avgPrice = parseFloat((row[3] || "").toString().replace(/,/g, "").trim());
        const investedVal = parseFloat((row[4] || "").toString().replace(/,/g, "").trim());
        const lastPx = parseFloat((row[5] || "").toString().replace(/,/g, "").trim());
        const lastDt = parseFloat((row[6] || "").toString().replace(/,/g, "").trim());

        if (!companyName) continue;

        // Skip total label rows
        if (companyName.toLowerCase() === "total" || companyName.toLowerCase().startsWith("total")) {
          continue;
        }

        if (isNaN(qty) || isNaN(avgPrice)) continue;

        const actualInvested = isNaN(investedVal) ? (qty * avgPrice) : investedVal;

        parsed.push({
          companyName,
          isin,
          lastTradePrice: isNaN(lastPx) ? undefined : lastPx,
          lastTradeDate: isNaN(lastDt) ? undefined : lastDt,
          quantity: qty,
          avgBuyPrice: avgPrice,
          investedValue: actualInvested
        });

        totalValue += actualInvested;
      }

      setSheetHoldings(parsed);
      setSheetTotal(totalValue);
      setPortfolioTotals(prev => ({ ...prev, [portfolio]: totalValue }));
      // Keep this portfolio's card rows fresh too, so its summary stays priced after you
      // navigate away (the card falls back to this list once it's no longer the active one).
      setPortfolioRows(prev => ({
        ...prev,
        // `lastPx` matters here as much as in the card-only loader: without it the ACTIVE
        // portfolio's card values an unlisted holding at cost while its own grid values it at
        // the last traded price, and the same account reads two different totals on one screen.
        [portfolio]: parsed.map(h => ({
          name: h.companyName, isin: h.isin, qty: h.quantity, invested: h.investedValue,
          lastPx: h.lastTradePrice,
        })),
      }));
    } catch (err: any) {
      console.error("Fetch holdings error:", err);
      if (!silent) {
        const errorMsg = err.result?.error?.message || err.message || "Failed to retrieve compiled sheet tab data.";
        setSheetError(errorMsg + " Ensure you have permissions to the active sheet.");
      }
    } finally {
      if (!silent) setIsLoadingSheet(false);
    }
  };

  // Companies with trade history that are NOT in the current Holding tab — fully
  // sold / exited (or merged away). Reads True Entry + Opening Holdings, resolves
  // every name through the scrip master, and diffs against the live holdings list.
  const fetchSoldHoldings = async (portfolio: string) => {
    if (portfolio === 'local') { setSoldHoldings([]); return; }
    const token = (gapi.client as any)?.getToken?.();
    if (!token || !token.access_token) return;
    const spreadsheetId = sheetIdForId(portfolio);
    if (!spreadsheetId) return;
    setIsLoadingSold(true);
    try {
      const m = scrip || await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID).catch(() => null);
      const keyFor = (isin: string, name: string): string => {
        const e = m ? lookupScrip(m, isin, name).entry : null;
        if (e) return e.key;
        // Fallback must be IDENTICAL for the same company whether or not a given row carries
        // an ISIN — True Entry rows have none, the Opening Holdings lot does. Key on the
        // normalized NAME first so the two don't split into duplicate "sold" rows (and so
        // heldKeys, built from the ISIN-bearing Holding tab, still matches a no-ISIN True
        // Entry row for the same name). Only used when the master didn't resolve the scrip.
        return normName(name) || (isin || '').trim().toLowerCase();
      };
      interface SeenScrip { name: string; isin: string; }
      const seen = new Map<string, SeenScrip>();
      const note = (isin: string, name: string) => {
        if (!name) return;
        const k = keyFor(isin, name);
        const cur = seen.get(k);
        if (!cur) seen.set(k, { name, isin });
        else {
          if (name.length > cur.name.length) cur.name = name;   // prefer the fullest name
          if (!cur.isin && isin) cur.isin = isin;
        }
      };
      const res = await (gapi.client as any).sheets.spreadsheets.values.get({ spreadsheetId, range: 'True Entry!A:T' });
      const rows: any[][] = res?.result?.values || [];
      if (rows.length > 1) {
        const headers = rows[0].map((h: any) => h.toString().trim());
        const nameIdx = headers.indexOf('Stock Name');
        const isinIdx = headers.indexOf('ISIN');
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i]; if (!r || r.length === 0) continue;
          note(isinIdx !== -1 ? (r[isinIdx] || '').toString().trim() : '', (r[nameIdx !== -1 ? nameIdx : 2] || '').toString().trim());
        }
      }
      const opening = await loadOpeningHoldings(spreadsheetId).catch(() => []);
      for (const ol of opening) note(ol.isin, ol.name);

      const heldKeys = new Set(sheetHoldings.map(h => keyFor(h.isin, h.companyName)));
      const sold: SheetHolding[] = [];
      for (const [k, s] of seen) {
        if (heldKeys.has(k)) continue;
        sold.push({ companyName: s.name, isin: s.isin, quantity: 0, avgBuyPrice: 0, investedValue: 0 });
      }
      sold.sort((a, b) => a.companyName.localeCompare(b.companyName));
      setSoldHoldings(sold);
    } catch (err: any) {
      console.error('Failed to compute sold companies:', err);
      toast.error('Could not load sold companies.');
    } finally {
      setIsLoadingSold(false);
    }
  };

  // Refresh the sold list whenever the toggle is on and the holdings change
  // (portfolio switch, resync, an edit's rebuild) — the diff is against live holdings.
  useEffect(() => {
    if (showSold && activePortfolio !== 'local') fetchSoldHoldings(activePortfolio);
    else setSoldHoldings([]);
  }, [showSold, activePortfolio, sheetHoldings]);

  // Lightweight read of ONE portfolio's Holding-tab total for its summary card.
  // Deliberately does NOT touch sheetHoldings/sheetTotal (the detail-view state),
  // so prefetching every card can't clobber the currently-open portfolio's view.
  const fetchPortfolioTotal = async (pid: string) => {
    const spreadsheetId = sheetIdForId(pid);
    if (!spreadsheetId || !gapi?.client) return;
    const token = (gapi.client as any).getToken();
    if (!token || !token.access_token) return;
    try {
      const res = await (gapi.client as any).sheets.spreadsheets.values.get({
        // A:G so an unlisted position on a card is valued the same way the grid values it.
        spreadsheetId, range: `Holding!A:G`,
      });
      const rows = res?.result?.values || [];
      let total = 0;
      const held: { name: string; isin: string; qty: number; invested: number; lastPx?: number }[] = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;
        const name = (row[0] || "").toString().trim();
        if (!name || name.toLowerCase().startsWith("total")) continue;
        const isin = (row[1] || "").toString().trim();
        const qty = parseFloat((row[2] || "").toString().replace(/,/g, "").trim());
        const avg = parseFloat((row[3] || "").toString().replace(/,/g, "").trim());
        const inv = parseFloat((row[4] || "").toString().replace(/,/g, "").trim());
        const lastPx = parseFloat((row[5] || "").toString().replace(/,/g, "").trim());
        if (isNaN(qty) || isNaN(avg)) continue;
        const invested = isNaN(inv) ? qty * avg : inv;
        total += invested;
        held.push({ name, isin, qty, invested, lastPx: isNaN(lastPx) ? undefined : lastPx });
      }
      setPortfolioTotals(prev => ({ ...prev, [pid]: total }));
      setPortfolioRows(prev => ({ ...prev, [pid]: held }));
      // A read that succeeds clears any earlier denial (access was just granted, or the
      // token was simply missing on the first attempt).
      setPortfolioAccess(prev => (prev[pid] ? (() => { const n = { ...prev }; delete n[pid]; return n; })() : prev));
    } catch (e) {
      // Still don't zero a good card — but stop hiding a permission problem behind it.
      const kind = classifySheetsError(e);
      if (kind !== 'other') setPortfolioAccess(prev => (prev[pid] === kind ? prev : { ...prev, [pid]: kind }));
    }
  };

  const syncCapitalGainsToSheet = async (pid: string = (activePortfolio === 'local' ? DEFAULT_PORTFOLIO_ID : activePortfolio)) => {
    const token = (gapi.client as any).getToken();
    if (!token || !token.access_token) {
      toast.error("Google Sheets connection required. Please authorize with Google first.");
      return;
    }

    setActionPid(pid);
    setIsSyncingCapGains(true);
    setCapGainsSyncStatus(null);

    try {
      const res = await syncCapitalGains(sheetIdForId(pid));
      setCapGainsSyncStatus({ pid, success: true, stcg: res.stcg, ltcg: res.ltcg });
      setScripReview(res.unresolved.length > 0 ? { pid, master: res.master, unresolved: res.unresolved } : null);
    } catch (err: any) {
      const msg = err?.result?.error?.message || err?.message || "Unknown error";
      setCapGainsSyncStatus({ pid, error: msg });
      console.error("Capital gains sync error:", err);
    } finally {
      setIsSyncingCapGains(false);
      setActionPid(null);
    }
  };

  // Rebuild the Holding tab from True Entry on demand
  const rebuildHolding = async (pid: string = (activePortfolio === 'local' ? DEFAULT_PORTFOLIO_ID : activePortfolio)) => {
    if (!hasValidGoogleToken()) {
      toast.error("Google Sheets connection required. Please authorize with Google first.");
      return;
    }
    setActionPid(pid);
    setIsRebuildingHolding(true);
    setHoldingRebuildStatus(null);
    try {
      const spreadsheetId = sheetIdForId(pid);
      const result = await rebuildHoldingTab(spreadsheetId);
      setHoldingRebuildStatus({ pid, result });
      setScripReview(result.unresolved.length > 0 ? { pid, master: result.master, unresolved: result.unresolved } : null);
      // The rebuild also refreshes unlisted CMPs on the shared Private Equities tab. Reported
      // out loud both ways: a silent write to a shared sheet is not something to discover later,
      // and a silent FAILURE would leave a stale price looking authoritative.
      if (result.peCmpError) {
        toast.error(`Holding rebuilt, but unlisted CMPs were not updated — ${result.peCmpError}`);
      } else if (result.peCmpWritten.length > 0) {
        const names = result.peCmpWritten.slice(0, 4).map(w => w.company).join(', ');
        toast.info(`Updated the CMP of ${result.peCmpWritten.length} unlisted ${result.peCmpWritten.length === 1 ? 'company' : 'companies'} on the ${PRIVATE_EQUITIES_TAB} tab: ${names}${result.peCmpWritten.length > 4 ? '…' : ''}`);
        loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID, { force: true }).then(setScrip).catch(() => {});
      }
      if (result.nameCollisions.length > 0) {
        const names = result.nameCollisions.slice(0, 6).map(c => `"${c.name}"`).join(', ');
        toast.info(`⚠ ${result.nameCollisions.length} name(s) map to 2+ scrip-master entries — those trades may split instead of merging into one holding: ${names}${result.nameCollisions.length > 6 ? '…' : ''}. Keep ONE master entry per stock (old name as an alias, same ISIN).`);
      }
      // Pull the freshly written Holding tab into the view if it's the active one
      if (activePortfolio === pid) await fetchSheetHoldings(pid);
    } catch (err: any) {
      const msg = err?.result?.error?.message || err?.message || "Unknown error";
      setHoldingRebuildStatus({ pid, error: msg });
      console.error("Holding rebuild error:", err);
    } finally {
      setIsRebuildingHolding(false);
      setActionPid(null);
    }
  };

  // Generate the scrip-wise FY transaction register (Excel-Trx replica) in a new tab.
  const generateTrx = async (pid: string) => {
    if (!hasValidGoogleToken()) {
      toast.error("Google Sheets connection required. Please authorize with Google first.");
      return;
    }
    setActionPid(pid);
    setIsGeneratingTrx(true);
    setTrxStatus(null);
    try {
      const spreadsheetId = sheetIdForId(pid);
      const result = await generateTrxRegister(spreadsheetId, selectedFy, portfolioById(pid)?.label);
      setTrxStatus({ pid, result });
      setScripReview(result.unresolved.length > 0 ? { pid, master: result.master, unresolved: result.unresolved } : null);
    } catch (err: any) {
      const msg = err?.result?.error?.message || err?.message || "Unknown error";
      setTrxStatus({ pid, error: msg });
      console.error("Trx register error:", err);
    } finally {
      setIsGeneratingTrx(false);
      setActionPid(null);
    }
  };

  // Sync a portfolio's holdings view from its sheet (main-page button). Also make
  // it the active portfolio so the summary's sheet-total stays aligned with it.
  const syncFeed = async (pid: string) => {
    setActionPid(pid);
    setActivePortfolio(pid);
    try { await fetchSheetHoldings(pid); }
    finally { setActionPid(null); }
  };

  // Download a portfolio's current Holding tab as CSV (no view-state changes).
  const downloadHoldingCsv = async (pid: string) => {
    if (!hasValidGoogleToken()) {
      toast.error("Google Sheets connection required. Please authorize with Google first.");
      return;
    }
    setDownloadingFor(pid);
    try {
      const res = await (gapi.client as any).sheets.spreadsheets.values.get({
        spreadsheetId: sheetIdForId(pid), range: 'Holding!A:Z',
      });
      const rows: any[][] = res?.result?.values || [];
      if (rows.length < 2) { toast.error("The Holding tab is empty — run Rebuild Holding first."); return; }
      const csv = rows.map(r => (r || []).map(csvEscape).join(",")).join("\r\n");
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `Holding_${pid.toUpperCase()}_${stamp}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error("Download failed: " + (err?.result?.error?.message || err?.message || "unknown error"));
    } finally {
      setDownloadingFor(null);
    }
  };

  // Google Sign-In hook inside Holdings
  const login = useGoogleLogin({
    scope: "https://www.googleapis.com/auth/spreadsheets",
    onSuccess: (tokenResponse) => {
      persistGoogleToken(tokenResponse as any);
      // Retrieve immediately after login
      if (activePortfolio !== 'local') {
        fetchSheetHoldings(activePortfolio);
      }
    },
    onError: () => {
      toast.error("Sheets login verification failed.");
    },
  });

  // The local sandbox portfolio is retired — bounce any stray navigation to T059
  useEffect(() => {
    if (activePortfolio === 'local') setActivePortfolio(DEFAULT_PORTFOLIO_ID);
  }, [activePortfolio]);

  // Execute live reload on tab shift automatic hook
  useEffect(() => {
    setSelectedStock(null);
    setCustomCmp(null);
    setTransactions([]);
    if (activePortfolio === 'local') return;

    if (hasAuthorizedGoogle()) {
      fetchSheetHoldings(activePortfolio);
      return;
    }
    // gapi may still be loading or the saved token is still being restored
    // (e.g. right after a page reload) — retry briefly instead of giving up.
    let tries = 0;
    const retryId = window.setInterval(() => {
      tries++;
      if (hasAuthorizedGoogle()) {
        window.clearInterval(retryId);
        fetchSheetHoldings(activePortfolio);
      } else if (tries >= 15) {
        window.clearInterval(retryId);
      }
    }, 1000);
    return () => window.clearInterval(retryId);
  }, [activePortfolio]);

  // Auto-refresh holdings from the sheet every 2 minutes (paused while the
  // browser tab is hidden or Sheets isn't connected).
  useEffect(() => {
    if (activePortfolio === 'local') return;
    const refreshId = window.setInterval(() => {
      if (document.hidden) return;
      if (!hasAuthorizedGoogle()) return;
      fetchSheetHoldings(activePortfolio, true);
    }, 120_000);
    return () => window.clearInterval(refreshId);
  }, [activePortfolio]);

  // On the summary page, prefetch EVERY portfolio's total so all cards populate
  // at once (no per-card clicking) and each stays put when another is synced.
  // Retries briefly while gapi/the saved token finish loading after a reload.
  useEffect(() => {
    if (isDetailView) return;
    const run = () => {
      if (!hasAuthorizedGoogle()) return false;
      PORTFOLIOS.forEach(p => { if (p.id !== 'local') fetchPortfolioTotal(p.id); });
      return true;
    };
    if (run()) return;
    let tries = 0;
    const id = window.setInterval(() => {
      tries++;
      if (run() || tries >= 15) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [isDetailView]);

  // Token present AND not expired (helper also checks the stored expiry timestamp)
  const hasAuthorizedGoogle = () => hasValidGoogleToken();

  // Safe Date string parser supporting custom formatting like "25 Mar 2026" or ISO strings
  const parseDateStr = (d: string): number => {
    if (!d) return 0;
    try {
      const parts = d.split(' ');
      if (parts.length === 3) {
        const day = parseInt(parts[0]);
        const monthStr = parts[1].toLowerCase();
        const year = parseInt(parts[2]);
        const months: any = { 
          jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
          january: 0, february: 1, march: 2, april: 3, may_full: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
        };
        const cleanMonthStr = monthStr.substring(0, 3);
        const month = months[cleanMonthStr] !== undefined ? months[cleanMonthStr] : 0;
        return new Date(year, month, day).getTime();
      }
      
      const partsD = d.split('-');
      if (partsD.length === 3) {
        if (partsD[0].length === 4) {
          return new Date(parseInt(partsD[0]), parseInt(partsD[1]) - 1, parseInt(partsD[2])).getTime();
        }
      }
    } catch (e) {}
    
    const parsed = Date.parse(d);
    return isNaN(parsed) ? 0 : parsed;
  };

  // Fetch all matching True Entry transactions live for a specific item
  const fetchTransactionsForStock = async (companyName: string, isin: string) => {
    setIsLoadingTransactions(true);
    setTransactions([]);
    setSelectedRows(new Set());   // drop any multi-select carried over from another stock
    setLastTxFetch({ companyName, isin });

    if (activePortfolio === 'local') {
      // Pull trades from parsedContractNote
      const matches = parsedContractNote 
        ? parsedContractNote.trades.filter(t => (t.isin && isin && t.isin.toLowerCase() === isin.toLowerCase()) || t.securityName.toLowerCase().includes(companyName.toLowerCase()))
        : [];
      
      const parsed: Transaction[] = matches.map(t => ({
        tradeDate: t.tradeDate || "11 Dec 2025",
        isin: t.isin || isin || "",
        assetName: t.securityName || companyName,
        transactionType: t.transactionType,
        quantity: t.quantity,
        price: t.avgPrice,
        turnover: t.turnover,
        brokerage: t.brokerage,
        brokeragePerShare: t.quantity > 0 ? t.brokerage / t.quantity : 0,
        amount: t.turnover
      }));

      // Fallback: seed a Buy transaction to prevent empty transaction history of sandbox-created positions
      if (parsed.length === 0 && selectedStock) {
        const fallbackQty = (selectedStock as any).quantity || 12366;
        const fallbackPrice = (selectedStock as any).avgCost || (selectedStock as any).avgBuyPrice || 2734.93;
        parsed.push({
          tradeDate: "11 Dec 2025",
          isin: (selectedStock as any).isin || isin || "",
          assetName: selectedStock.name || (selectedStock as any).companyName || companyName,
          transactionType: "Buy",
          quantity: fallbackQty,
          price: fallbackPrice,
          turnover: fallbackQty * fallbackPrice,
          brokerage: 0,
          brokeragePerShare: 0,
          amount: fallbackQty * fallbackPrice
        });
      }

      // Rolling balances
      let currentBal = 0;
      const sortedLocal = [...parsed].sort((a, b) => parseDateStr(a.tradeDate) - parseDateStr(b.tradeDate));
      sortedLocal.forEach(t => {
        const side = ledgerSide(t.transactionType);
        if (side === "BUY") currentBal += t.quantity;
        else if (side === "SELL") currentBal -= t.quantity;
        t.balanceQuantity = currentBal;
      });

      parsed.sort((a, b) => parseDateStr(b.tradeDate) - parseDateStr(a.tradeDate));
      setTransactions(parsed);
      setIsLoadingTransactions(false);
      return;
    }

    // Google spreadsheets active portfolios
    try {
      const token = (gapi.client as any).getToken();
      if (!token || !token.access_token) {
        // Not connected → show nothing rather than fabricated trades.
        setTransactions([]);
        setIsLoadingTransactions(false);
        return;
      }

      const spreadsheetId = sheetIdForId(activePortfolio);

      const response = await (gapi.client as any).sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: `True Entry!A:Z`,   // wide enough to include the (auto-appended) Notes column past Import ID
      });

      const rows = response?.result?.values || [];
      const parsed: Transaction[] = [];

      // Resolve the selected holding to its canonical scrip key ONCE, then match every
      // candidate row (True Entry + opening lots) through the scrip master — the same
      // resolution the importer uses — instead of only raw ISIN / name-substring. This
      // catches rows whose name spelling differs but resolve to the same scrip.
      const selKey = scrip ? (lookupScrip(scrip, isin, companyName).entry?.key || "") : "";
      const rowMatchesSel = (rowIsin: string, rowName: string): boolean => {
        if (isin && rowIsin && rowIsin.toLowerCase() === isin.toLowerCase()) return true;
        if (scrip && selKey) { const e = lookupScrip(scrip, rowIsin, rowName).entry; if (e && e.key === selKey) return true; }
        const cn = (companyName || "").toLowerCase(), rn = (rowName || "").toLowerCase();
        return !!cn && !!rn && (rn.includes(cn) || cn.includes(rn));
      };

      if (rows.length > 1) {
        const headers = rows[0].map((h: any) => h.toString().trim());
        setTrueEntryHeaders(headers);
        const dateIdx = headers.indexOf("Trade Date");
        const isinIdx = headers.indexOf("ISIN");
        const nameIdx = headers.indexOf("Stock Name");
        const typeIdx = headers.indexOf("Transaction Type");
        const qtyIdx = headers.indexOf("Number of Shares");
        const priceIdx = headers.indexOf("Avg Price");
        const amountIdx = headers.indexOf("Total Amount (Turnover)");
        const brokerageIdx = headers.indexOf("Total Brokerage");
        const notesIdx = headers.findIndex((h: string) => /note|remark/i.test(h));

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;

          const rowIsin = (row[isinIdx !== -1 ? isinIdx : 1] || "").toString().trim();
          const rowName = (row[nameIdx !== -1 ? nameIdx : 2] || "").toString().trim();

          if (rowMatchesSel(rowIsin, rowName)) {
            const tradeDate = (row[dateIdx !== -1 ? dateIdx : 0] || "").toString().trim();
            const transactionType = (row[typeIdx !== -1 ? typeIdx : 3] || "").toString().trim();
            const quantity = parseFloat((row[qtyIdx !== -1 ? qtyIdx : 4] || "0").toString().replace(/,/g, ""));
            const price = parseFloat((row[priceIdx !== -1 ? priceIdx : 5] || "0").toString().replace(/,/g, ""));
            const turnover = parseFloat((row[amountIdx !== -1 ? amountIdx : 6] || "0").toString().replace(/,/g, ""));
            const brokerage = parseFloat((row[brokerageIdx !== -1 ? brokerageIdx : 8] || "0").toString().replace(/,/g, ""));

            parsed.push({
              tradeDate,
              isin: rowIsin,
              assetName: rowName,
              transactionType,
              quantity: isNaN(quantity) ? 0 : quantity,
              price: isNaN(price) ? 0 : price,
              turnover: isNaN(turnover) ? 0 : turnover,
              brokerage: isNaN(brokerage) ? 0 : brokerage,
              brokeragePerShare: quantity > 0 && !isNaN(brokerage) ? brokerage / quantity : 0,
              amount: isNaN(turnover) ? 0 : turnover,
              notes: notesIdx !== -1 ? (row[notesIdx] || "").toString().trim() : "",
              editSource: 'trueEntry',
              sheetRow: i + 1,   // rows[0] is sheet row 1
              rawRow: row,
            });
          }
        }
      }

      // Seed the scrip's opening lots (pre-FY26 basis) so the trade book, inventory
      // and realised tables start from the carried-in position — not from zero. A
      // scrip held before FY26 and then sold down (e.g. Goodluck) otherwise reads as
      // a negative balance because this view only sees FY26 True Entry rows.
      try {
        const opening = await loadOpeningHoldings(spreadsheetId);
        if (opening.length) {
          for (const ol of opening.filter(ol => rowMatchesSel(ol.isin, ol.name))) {
            parsed.push({
              tradeDate: ol.acqDate,
              isin: ol.isin || isin || "",
              assetName: ol.name,
              transactionType: "Opening Buy",
              quantity: ol.qty,
              price: ol.costPerShare,
              turnover: ol.qty * ol.costPerShare,
              brokerage: 0,
              brokeragePerShare: 0,
              amount: ol.qty * ol.costPerShare,
              isOpening: true,
              longTerm: ol.longTerm,
              editSource: 'opening',
              sheetRow: ol.rowIndex,
            });
          }
        }
      } catch { /* no Opening Holdings tab → view stays FY26-only */ }

      // Seed the scrip's corporate actions (merger / demerger). They live in their own tab —
      // NOT in True Entry — so without this the detail view's FIFO was blind to them while the
      // Holding tab and the capital-gains engine both applied them: a demerged Parent kept its
      // full pre-demerger cost (DCM Shriram Industries: ₹2.08 cr of lots instead of ₹88.7 lakh),
      // and a NewCo with no buy rows at all (Shankara Buildpro) replayed as sells-against-nothing
      // → a negative running balance and a "sold out" card.
      try {
        const actions = await loadCorporateActions(spreadsheetId);
        // Stricter than rowMatchesSel: no loose substring fallback here, because a corp action
        // names TWO securities that usually share a prefix ("DCM Shriram Industries" vs "DCM
        // Shriram Fine Chemicals") and matching the wrong leg would corrupt the cost basis.
        const inr = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const qtyStr = (v: number) => v.toLocaleString('en-IN');
        const caMatches = (nm: string): boolean => {
          const n = (nm || '').trim();
          if (!n) return false;
          if (scrip && selKey) { const e = lookupScrip(scrip, '', n).entry; if (e) return e.key === selKey; }
          return normName(n) === normName(companyName || '');
        };
        for (const ca of actions) {
          const kind: 'MERGER' | 'DEMERGER' = ca.type === 'Merger' ? 'MERGER' : 'DEMERGER';
          const isTo = caMatches(ca.to), isFrom = caMatches(ca.from);
          if (isTo === isFrom) continue;   // neither leg, or an unresolvable both-legs match → skip
          const role: 'in' | 'out' = isTo ? 'in' : 'out';
          const px = role === 'in' && ca.sharesIn > 0 ? ca.cost / ca.sharesIn : 0;
          parsed.push({
            tradeDate: ca.dateStr,
            isin: isin || '',
            assetName: role === 'in' ? ca.to : ca.from,
            transactionType: `${ca.type} ${role === 'in' ? 'In' : 'Out'}`,
            quantity: role === 'in' ? ca.sharesIn : 0,
            price: px,
            turnover: role === 'in' ? ca.cost : 0,
            brokerage: 0,
            brokeragePerShare: 0,
            amount: ca.cost,
            corpAction: { kind, role, sharesIn: ca.sharesIn, cost: ca.cost, rowIndex: ca.rowIndex, type: ca.type, from: ca.from, to: ca.to, notes: ca.notes },
            notes: [
              role === 'in'
                ? `Received ${qtyStr(ca.sharesIn)} shares from ${ca.from} carrying ₹${inr(ca.cost)} of cost.`
                : kind === 'MERGER'
                  ? `Absorbed into ${ca.to} — lots extinguished, no gain booked here.`
                  : `₹${inr(ca.cost)} of cost apportioned out to ${ca.to}; share count unchanged.`,
              ca.notes,
            ].filter(Boolean).join(' '),
          });
        }
      } catch { /* no Corporate Actions tab → nothing to apply */ }

      // Surface the scrip's PRE-FY26 Bonus / Split / Rights from the "Opening Corp Actions"
      // tab. Display only — see `Transaction.openingAction`. Until now these were invisible
      // everywhere in the app, so deleting an opening lot silently orphaned them.
      try {
        const oca = await loadOpeningCorpActionRows(spreadsheetId);
        for (const a of oca) {
          if (!rowMatchesSel('', a.name)) continue;
          const kind = (a.type || '').toUpperCase();
          const label = kind === 'SPLIT' ? 'Split' : kind === 'RIGHT' ? 'Rights' : 'Bonus';
          parsed.push({
            tradeDate: openingActionDate(a.key, a.date),
            isin: isin || '',
            assetName: a.name,
            transactionType: `${label} ${a.num}:${a.den} (opening)`,
            quantity: 0,
            price: a.price || 0,
            turnover: 0, brokerage: 0, brokeragePerShare: 0, amount: 0,
            openingAction: { key: a.key, type: kind, num: a.num, den: a.den, price: a.price || 0 },
            notes: `Pre-FY26 ${label.toLowerCase()} of ${a.num}:${a.den}${a.price ? ` @ ₹${a.price}` : ''}, recorded while building the opening basis. Already reflected in the 31-Mar-2025 opening lots, so it is NOT replayed again here.`,
          });
        }
      } catch { /* no Opening Corp Actions tab → nothing to show */ }

      parsed.sort((a, b) => parseDateStr(b.tradeDate) - parseDateStr(a.tradeDate));

      // Calculate rolling balance quantities oldest-to-newest
      // Same-day ordering as the FIFO engines: buys (0) → splits / corporate actions (1) →
      // sells (2), so a balance never dips through a sell that a same-day action funds.
      const oldestFirst = [...parsed].sort((a, b) =>
        (parseDateStr(a.tradeDate) - parseDateStr(b.tradeDate)) || (txEvOrd(a) - txEvOrd(b)));
      let currentBal = 0;
      oldestFirst.forEach(t => {
        if (t.openingAction) { t.balanceQuantity = currentBal; return; }   // display only
        if (t.corpAction) {
          // 'in' adds the shares received; a merger 'out' extinguishes the whole position;
          // a demerger 'out' only moves cost, so the parent's share count is untouched.
          if (t.corpAction.role === 'in') currentBal += t.corpAction.sharesIn;
          else if (t.corpAction.kind === 'MERGER') currentBal = 0;
          t.balanceQuantity = currentBal;
          return;
        }
        const side = ledgerSide(t.transactionType);
        if (side === "BUY") currentBal += t.quantity;
        else if (side === "SELL") currentBal -= t.quantity;
        t.balanceQuantity = currentBal;
      });

      parsed.sort((a, b) => parseDateStr(b.tradeDate) - parseDateStr(a.tradeDate));
      setTransactions(parsed);
    } catch (err: any) {
      console.error("Failed to fetch transactions live: ", err);
    } finally {
      setIsLoadingTransactions(false);
    }
  };

  // ── Edit Entry (Trade Book) ───────────────────────────────────────────────
  // Open the popup, prefilling the form from the row's source (True Entry raw row,
  // or the opening lot's fields).
  const openEdit = (t: Transaction) => {
    const form: Record<string, string> = {};
    if (t.editSource === 'opening') {
      form.tradeDate = t.tradeDate;
      form.quantity = String(t.quantity);
      form.price = String(t.price);          // cost/share
      form.longTerm = t.longTerm ? 'yes' : '';
    } else {
      form.tradeDate = t.tradeDate;
      form.transactionType = t.transactionType;
      form.quantity = String(t.quantity);
      form.price = String(t.price);
      form.turnover = String(t.turnover);
      const raw = t.rawRow || [];
      for (const f of [...TE_CORE_FIELDS, ...TE_EXPENSE_FIELDS]) {
        const idx = trueEntryHeaders.indexOf(f.header);
        if (idx !== -1) form[f.key] = (raw[idx] ?? '').toString();
      }
    }
    setEditForm(form);
    setEditingTx(t);
  };

  // Tick / untick one Trade Book row in the multi-select set.
  const toggleRowSel = (t: Transaction) => setSelectedRows(prev => {
    const next = new Set(prev);
    const k = `${t.editSource}:${t.sheetRow}`;
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  });

  // Rebuild a full True Entry row from the edited form, preserving untouched columns
  // (Trade Class, Import ID, …) and recomputing the derived expense/total columns.
  const saveTrueEntryRow = async (spreadsheetId: string, t: Transaction) => {
    const headers = trueEntryHeaders;
    const idx = (h: string) => headers.indexOf(h);
    const raw = t.rawRow || [];
    const width = Math.max(headers.length, raw.length);
    const row: any[] = [];
    for (let i = 0; i < width; i++) row[i] = raw[i] !== undefined ? raw[i] : '';
    const setCol = (h: string, val: any) => { const i = idx(h); if (i !== -1) row[i] = val; };

    const type = (editForm.transactionType || t.transactionType || '').trim();

    // A TRANSFER row is one half of a pair written into two DIFFERENT spreadsheets, and it
    // deliberately carries a cost basis that is NOT turnover +/- expenses: turnover holds the
    // charge-free basis the capital-gains engines read, while Total Amount with Expense holds
    // the all-in cost the Holding tab reads. The derived-totals block below would recompute
    // that column as turnover +/- expenses (expenses being zero on a transfer), silently
    // flattening the carried all-in cost - and editing one leg would desynchronise it from
    // its counterpart in the other portfolio's book with nothing to detect the drift.
    // Refuse, rather than rewrite it and look like it worked.
    if (isTransferType(type)) {
      toast.error('This row is one leg of a cross-portfolio transfer and cannot be edited here - '
        + 'its cost basis is carried from the source lot, and the matching row lives in the other '
        + 'portfolio. Reverse the transfer and redo it instead.');
      return;
    }

    const qty = numCell(editForm.quantity);
    const price = numCell(editForm.price);
    const turnover = numCell(editForm.turnover);
    const brokerage = numCell(editForm.brokerage);
    const stt = numCell(editForm.stt);
    const etc = numCell(editForm.etc);
    const sebi = numCell(editForm.sebi);
    const ipf = idx('IPF Charges') !== -1 ? numCell(editForm.ipf) : 0;
    const demat = idx('Demat Charges') !== -1 ? numCell(editForm.demat) : 0;
    const gst = numCell(editForm.gst);
    const igst = numCell(editForm.igst);
    const gstVal = idx('Total GST') !== -1 ? gst : igst;   // whichever column this sheet has
    const stamp = numCell(editForm.stamp);

    setCol('Trade Date', (editForm.tradeDate || '').trim());
    setCol('Transaction Type', type);
    if (editForm.tradeClass) setCol('Trade Class', editForm.tradeClass.trim());
    setCol('Number of Shares', qty);
    setCol('Avg Price', price);
    setCol('Total Amount (Turnover)', turnover);
    setCol('Total Brokerage', brokerage);
    setCol('Brokerage Per Share', qty > 0 ? Math.round((brokerage / qty) * 1e6) / 1e6 : 0);
    setCol('STT', stt);
    setCol('Exchange Turnover Charges', etc);
    setCol('SEBI Turnover Fees', sebi);
    setCol('IPF Charges', ipf);
    setCol('Demat Charges', demat);
    setCol('Total GST', gst);
    setCol('IGST', igst);
    setCol('Stamp Duty', stamp);

    // Derived totals — same formula the importer uses (Sell nets expenses out).
    const totalExclSTT = brokerage + etc + sebi + ipf + demat + gstVal + stamp;
    const totalInclSTT = totalExclSTT + stt;
    const isBuy = ledgerSide(type) === "BUY";   // Buy/IPO/Bonus/Split/Rights are buy-side
    const r2 = (n: number) => Math.round(n * 100) / 100;
    setCol('Total Expenses (incl STT)', r2(totalInclSTT));
    setCol('Total Expenses (excl STT)', r2(totalExclSTT));
    setCol('Total Amount with Expense (Incl STT)', r2(isBuy ? turnover + totalInclSTT : turnover - totalInclSTT));
    setCol('Total Amount with Expense (Excl STT)', r2(isBuy ? turnover + totalExclSTT : turnover - totalExclSTT));

    await (gapi.client as any).sheets.spreadsheets.values.update({
      spreadsheetId, range: `True Entry!A${t.sheetRow}`, valueInputOption: 'USER_ENTERED', resource: { values: [row] },
    });
  };

  /**
   * dd/mm/yyyy (formatDMY's tested output) → yyyy-mm-dd for <input type="date">. Reusing the
   * formatter means we don't re-implement its format sniffing; '' when it can't be read, which
   * the save gate rejects rather than guessing.
   */
  const toISODate = (v: any): string => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(formatDMY(v));
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
  };

  const openCorpActionEdit = (t: Transaction) => {
    const ca = t.corpAction;
    if (!ca || ca.rowIndex == null) return;
    setCaEditTx(t);
    setCaEditForm({
      dateISO: toISODate(t.tradeDate),
      sharesIn: ca.sharesIn ? String(ca.sharesIn) : '',
      cost: ca.cost ? String(ca.cost) : '',
      notes: ca.notes || '',
    });
  };

  const saveCorpActionEdit = async () => {
    const t = caEditTx, ca = t?.corpAction;
    if (!t || !ca || ca.rowIndex == null) return;
    const spreadsheetId = sheetIdForId(activePortfolio);
    if (!spreadsheetId) { toast.error('No spreadsheet for this portfolio.'); return; }
    const cost = numCell(caEditForm.cost);
    const sharesIn = numCell(caEditForm.sharesIn);
    if (!caEditForm.dateISO) { toast.error("Couldn't read this action's date — fix it in the “" + CORP_ACTIONS_TAB + "” tab first."); return; }
    if (!(cost > 0)) { toast.error('Amount must be greater than zero.'); return; }
    if (ca.kind === 'DEMERGER' && !(sharesIn > 0)) { toast.error('Shares In must be greater than zero for a demerger.'); return; }

    setCaEditSaving(true);
    try {
      // Write the date back as ISO. The tab's readers all accept it, and it removes the
      // dd-mm/mm-dd ambiguity that makes Sheets re-parse a day <= 12 as a US month under
      // USER_ENTERED — the bug that corrupted dates in the Opening Corp Actions tab.
      const next: CorpAction = {
        dateStr: caEditForm.dateISO,
        type: (ca.type || (ca.kind === 'MERGER' ? 'Merger' : 'Demerger')) as CorpActionType,
        from: ca.from || '', to: ca.to || '',
        sharesIn, cost, notes: caEditForm.notes.trim(),
      };
      const res = await updateCorporateAction(spreadsheetId, ca.rowIndex, next);
      setCaEditTx(null);
      toast.success('Corporate action updated — rebuilding Holdings & capital gains…');
      if (res.holdingWarning) toast.error('Holding rebuild failed: ' + res.holdingWarning);
      if (res.capGainsWarning) toast.error('Capital-gains sync failed: ' + res.capGainsWarning);
      await fetchSheetHoldings(activePortfolio, true);
      if (lastTxFetch) await fetchTransactionsForStock(lastTxFetch.companyName, lastTxFetch.isin);
    } catch (e: any) {
      toast.error('Update failed: ' + (e?.result?.error?.message || e?.message || 'error'));
    } finally {
      setCaEditSaving(false);
    }
  };

  const saveEdit = async () => {
    const t = editingTx;
    if (!t || t.sheetRow == null) return;
    const spreadsheetId = sheetIdForId(activePortfolio);
    if (!spreadsheetId) { toast.error('No spreadsheet for this portfolio.'); return; }
    // Identity of the row we're saving, so the refreshed Trade Book can flash it.
    const savedId = t.editSource ? { editSource: t.editSource, sheetRow: t.sheetRow } : null;
    setSavingEdit(true);
    try {
      if (t.editSource === 'opening') {
        await updateOpeningHoldingRow(spreadsheetId, t.sheetRow, {
          acqDate: (editForm.tradeDate || '').trim(),
          qty: numCell(editForm.quantity),
          costPerShare: numCell(editForm.price),
          longTerm: editForm.longTerm === 'yes',
        });
      } else {
        await saveTrueEntryRow(spreadsheetId, t);
      }
      setEditingTx(null);
      toast.success('Entry updated — rebuilding Holdings & capital gains…');
      // Recompute so Holdings, CG and the Trx register all reflect the edit (per user choice).
      try { await rebuildHoldingTab(spreadsheetId); } catch (e: any) { toast.error('Holding rebuild failed: ' + (e?.result?.error?.message || e?.message || 'error')); }
      try { await syncCapitalGains(spreadsheetId); } catch (e: any) { toast.error('Capital-gains sync failed: ' + (e?.result?.error?.message || e?.message || 'error')); }
      await fetchSheetHoldings(activePortfolio, true);
      if (lastTxFetch) await fetchTransactionsForStock(lastTxFetch.companyName, lastTxFetch.isin);
      // Flash the just-saved row green (once the refreshed rows are on screen).
      if (savedId) {
        setJustSavedRow(savedId);
        window.setTimeout(() => setJustSavedRow(cur =>
          cur && cur.editSource === savedId.editSource && cur.sheetRow === savedId.sheetRow ? null : cur), 1400);
      }
    } catch (e: any) {
      toast.error('Save failed: ' + (e?.result?.error?.message || e?.message || 'error'),
        { action: { label: 'Retry', onClick: () => { void saveEdit(); } } });
    } finally {
      setSavingEdit(false);
    }
  };

  // Rebuild Holding + capital gains from the (now-changed) ledger, then refresh the
  // on-screen holdings and Trade Book. Shared by the delete + undo paths.
  const rebuildAndRefresh = async (spreadsheetId: string) => {
    try { await rebuildHoldingTab(spreadsheetId); } catch (e: any) { toast.error('Holding rebuild failed: ' + (e?.result?.error?.message || e?.message || 'error')); }
    try { await syncCapitalGains(spreadsheetId); } catch (e: any) { toast.error('Capital-gains sync failed: ' + (e?.result?.error?.message || e?.message || 'error')); }
    await fetchSheetHoldings(activePortfolio, true);
    if (lastTxFetch) await fetchTransactionsForStock(lastTxFetch.companyName, lastTxFetch.isin);
  };

  // Force a full rebuild of the Holding tab (+ capital gains) from the ledger, for when the
  // cached tab has drifted from Opening Holdings / True Entry (e.g. opening lots added without
  // a rebuild — see the Deccan stale-tab case). Rewrites the WHOLE tab for every stock.
  const rebuildHoldingsNow = async () => {
    const spreadsheetId = sheetIdForId(activePortfolio);
    if (!spreadsheetId) { toast.error('No spreadsheet for this portfolio.'); return; }
    setRebuildingHoldings(true);
    try {
      await rebuildAndRefresh(spreadsheetId);
      toast.success('Holdings rebuilt from the ledger.');
    } finally {
      setRebuildingHoldings(false);
    }
  };

  // Re-insert a just-deleted row at its original position, then recompute.
  const undoDelete = async (
    spreadsheetId: string, tab: string, rowIndex: number, values: any[],
    restoreActions: SavedCorpAction[] = [],   // pre-FY26 memos the delete cascaded away
  ) => {
    try {
      await insertSheetRow(spreadsheetId, tab, rowIndex, values);
      if (restoreActions.length) await restoreOpeningCorpActions(spreadsheetId, restoreActions);
      toast.success('Delete undone — rebuilding Holdings & capital gains…');
      await rebuildAndRefresh(spreadsheetId);
    } catch (e: any) {
      toast.error('Undo failed: ' + (e?.result?.error?.message || e?.message || 'error'));
    }
  };

  // Delete the entry entirely: removes its row from True Entry (or the Opening
  // Holdings lot), then rebuilds Holdings + capital gains so everything reflects
  // the removal. Confirmed first — it's destructive and shifts the sheet's rows.
  // The exact row is captured (unformatted) beforehand so the result toast can
  // offer a faithful Undo that re-inserts it at its original position.
  const deleteEntry = async () => {
    const t = editingTx;
    if (!t || t.sheetRow == null) return;
    const spreadsheetId = sheetIdForId(activePortfolio);
    if (!spreadsheetId) { toast.error('No spreadsheet for this portfolio.'); return; }
    const isOpening = t.editSource === 'opening';
    const tab = isOpening ? OPENING_HOLDINGS_TAB : 'True Entry';
    // Removing a scrip's LAST opening lot orphans its pre-FY26 action memos — invisible
    // until now, and the reason a deleted-then-re-added lot could pick the actions back up.
    // Offer to take them along (default on); the choice comes back via a ref, since
    // confirmDialog only resolves a boolean.
    const lastOpeningLot = isOpening &&
      transactions.filter(x => x.editSource === 'opening').length <= 1;
    const orphanActions = lastOpeningLot ? transactions.filter(x => x.openingAction) : [];
    const alsoRemove = { current: orphanActions.length > 0 };
    const ok = await confirmDialog({
      title: 'Delete this entry?',
      body: (
        <span>
          Remove this {isOpening ? 'opening lot' : 'ledger row'} for <b>{t.assetName}</b>
          {' '}({(t.transactionType || 'lot')} · {formatNum(t.quantity)} @ {formatINR(t.price)}, {formatDMY(t.tradeDate)}).
          {' '}Holdings and capital gains will be recomputed — you'll have a moment to undo.
          {orphanActions.length > 0 && (
            <CascadeDeleteToggle count={orphanActions.length} onChange={(v) => { alsoRemove.current = v; }} />
          )}
        </span>
      ),
      danger: true,
      confirmLabel: 'Delete entry',
      cancelLabel: 'Keep it',
    });
    if (!ok) return;
    setDeletingEdit(true);
    try {
      // Capture the exact row (serials/numbers unformatted) so Undo restores it verbatim.
      const restoreRow = t.sheetRow;
      let captured: any[] | null = null;
      try {
        const resp = await (gapi.client as any).sheets.spreadsheets.values.get({
          spreadsheetId, range: `'${tab}'!${restoreRow}:${restoreRow}`, valueRenderOption: 'UNFORMATTED_VALUE',
        });
        const v = resp?.result?.values?.[0];
        if (v && v.length) captured = v;
      } catch { /* undo simply won't be offered */ }

      await deleteSheetRow(spreadsheetId, tab, restoreRow);

      // Cascade the orphaned pre-FY26 action memos, capturing them so Undo restores both.
      let removedActions: SavedCorpAction[] = [];
      if (alsoRemove.current && orphanActions.length) {
        try {
          const all = await loadOpeningCorpActionRows(spreadsheetId);
          const wanted = new Set<string>(orphanActions.map(x => x.openingAction!.key));
          removedActions = all.filter(a => wanted.has(a.key));
          await deleteOpeningCorpActions(spreadsheetId, [...wanted]);
        } catch (e: any) {
          // The lot is already gone; surface this rather than failing the whole delete.
          toast.error('Lot deleted, but its pre-FY26 actions could not be removed: ' +
            (e?.result?.error?.message || e?.message || 'error'));
        }
      }

      setEditingTx(null);
      await rebuildAndRefresh(spreadsheetId);
      const msg = removedActions.length
        ? `Entry deleted, along with ${removedActions.length} pre-FY26 corporate action${removedActions.length === 1 ? '' : 's'}.`
        : 'Entry deleted.';
      toast.success(msg, captured
        ? { action: { label: 'Undo', onClick: () => { void undoDelete(spreadsheetId, tab, restoreRow, captured!, removedActions); } }, duration: 8000 }
        : undefined);
    } catch (e: any) {
      toast.error('Delete failed: ' + (e?.result?.error?.message || e?.message || 'error'));
    } finally {
      setDeletingEdit(false);
    }
  };

  // ── Bulk delete (multi-select in edit mode) ───────────────────────────────
  // Re-insert every captured row, so Undo restores the whole batch. Insert ASCENDING by
  // original index with a running offset (each prior insert shifts the tab down by one), so
  // rows land back at their original positions. Per-tab (True Entry / Opening Holdings are
  // independent). Immediate action (toast), so no other edits intervene.
  const undoBulkDelete = async (spreadsheetId: string, captured: { tab: string; row: number; values: any[] }[]) => {
    try {
      const byTab = new Map<string, { row: number; values: any[] }[]>();
      for (const c of captured) (byTab.get(c.tab) || byTab.set(c.tab, []).get(c.tab)!).push(c);
      for (const [tab, list] of byTab) {
        list.sort((a, b) => a.row - b.row);
        let inserted = 0;
        for (const c of list) { await insertSheetRow(spreadsheetId, tab, c.row + inserted, c.values); inserted++; }
      }
      toast.success('Delete undone — rebuilding Holdings & capital gains…');
      await rebuildAndRefresh(spreadsheetId);
    } catch (e: any) {
      toast.error('Undo failed: ' + (e?.result?.error?.message || e?.message || 'error'));
    }
  };

  const deleteSelectedEntries = async () => {
    const spreadsheetId = sheetIdForId(activePortfolio);
    if (!spreadsheetId) { toast.error('No spreadsheet for this portfolio.'); return; }
    const rows = transactions.filter(t => t.editSource && t.sheetRow != null && selectedRows.has(`${t.editSource}:${t.sheetRow}`));
    if (rows.length === 0) return;
    const n = rows.length;
    const ok = await confirmDialog({
      title: `Delete ${n} ${n === 1 ? 'entry' : 'entries'}?`,
      body: (
        <span>
          Remove the <b>{n}</b> selected {n === 1 ? 'row' : 'rows'} for <b>{name}</b>.
          {' '}Holdings and capital gains will be recomputed — you'll have a moment to undo.
        </span>
      ),
      danger: true,
      confirmLabel: `Delete ${n}`,
      cancelLabel: 'Keep them',
    });
    if (!ok) return;
    setBulkDeleting(true);
    try {
      // Group selected rows by their sheet tab.
      const byTab = new Map<string, number[]>();
      for (const t of rows) {
        const tab = t.editSource === 'opening' ? OPENING_HOLDINGS_TAB : 'True Entry';
        (byTab.get(tab) || byTab.set(tab, []).get(tab)!).push(t.sheetRow!);
      }
      const captured: { tab: string; row: number; values: any[] }[] = [];
      for (const [tab, sheetRows] of byTab) {
        // Capture each row's values BEFORE any delete in this tab (indices still original).
        for (const r of sheetRows) {
          try {
            const resp = await (gapi.client as any).sheets.spreadsheets.values.get({
              spreadsheetId, range: `'${tab}'!${r}:${r}`, valueRenderOption: 'UNFORMATTED_VALUE',
            });
            const v = resp?.result?.values?.[0];
            if (v && v.length) captured.push({ tab, row: r, values: v });
          } catch { /* undo just won't include this row */ }
        }
        // Delete HIGHEST index first so earlier deletes don't shift the not-yet-deleted rows.
        for (const r of [...sheetRows].sort((a, b) => b - a)) await deleteSheetRow(spreadsheetId, tab, r);
      }
      setEditingTx(null);
      setSelectedRows(new Set());
      await rebuildAndRefresh(spreadsheetId);
      toast.success(`${n} ${n === 1 ? 'entry' : 'entries'} deleted.`, captured.length
        ? { action: { label: 'Undo', onClick: () => { void undoBulkDelete(spreadsheetId, captured); } }, duration: 8000 }
        : undefined);
    } catch (e: any) {
      toast.error('Bulk delete failed: ' + (e?.result?.error?.message || e?.message || 'error'));
    } finally {
      setBulkDeleting(false);
    }
  };

  // Edit Entry popup (Trade Book) — writes straight back to True Entry / Opening Holdings.
  // Declared once and rendered in BOTH top-level return branches: the component early-returns
  // renderStockDetailView() when a stock is selected, and the Trade Book (with its Edit
  // buttons) lives in THAT branch — a modal present only in the main return never mounts there.
  const editEntryModal = (
      <ModalShell open={!!editingTx} onClose={() => !savingEdit && !deletingEdit && setEditingTx(null)} busy={savingEdit || deletingEdit} labelledBy="edit-entry-title">
        <div className="relative z-10 w-full max-w-xl max-h-[88vh] flex flex-col bg-white rounded-2xl shadow-2xl animate-fadeIn">
          <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
            <div>
              <h3 id="edit-entry-title" className="text-sm font-black text-slate-800 flex items-center gap-2"><Edit2 className="w-4 h-4 text-indigo-600" /> Edit Entry</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {editingTx?.assetName}
                <span className={`ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${editingTx?.editSource === 'opening' ? 'bg-violet-50 text-violet-700' : 'bg-slate-100 text-slate-600'}`}>
                  {editingTx?.editSource === 'opening' ? 'Opening lot' : 'True Entry'}
                </span>
              </p>
            </div>
            <button onClick={() => !savingEdit && !deletingEdit && setEditingTx(null)} className="p-1.5 hover:bg-slate-100 rounded-lg cursor-pointer"><X className="w-4 h-4 text-slate-500" /></button>
          </div>

          <div className="overflow-y-auto px-5 py-4">
            {editingTx?.editSource === 'opening' ? (
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[10px] font-bold uppercase text-slate-500">Acquisition Date</span>
                  <input type="date" value={editForm.tradeDate ?? ''} onChange={e => setEditForm(p => ({ ...p, tradeDate: e.target.value }))}
                    className="mt-0.5 w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg font-mono" />
                </label>
                <label className="block">
                  <span className="text-[10px] font-bold uppercase text-slate-500">Quantity</span>
                  <input type="number" step="any" value={editForm.quantity ?? ''} onChange={e => setEditForm(p => ({ ...p, quantity: e.target.value }))}
                    className="mt-0.5 w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg font-mono" />
                </label>
                <label className="block">
                  <span className="text-[10px] font-bold uppercase text-slate-500">Cost / Share</span>
                  <input type="number" step="any" value={editForm.price ?? ''} onChange={e => setEditForm(p => ({ ...p, price: e.target.value }))}
                    className="mt-0.5 w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg font-mono" />
                </label>
                <label className="col-span-2 flex items-center gap-2 mt-1 cursor-pointer">
                  <input type="checkbox" checked={editForm.longTerm === 'yes'} onChange={e => setEditForm(p => ({ ...p, longTerm: e.target.checked ? 'yes' : '' }))}
                    className="w-4 h-4 accent-indigo-600" />
                  <span className="text-[12px] font-medium text-slate-700">Long-term (acquired before 1-Apr-2024)</span>
                </label>
                <p className="col-span-2 text-[11px] text-slate-400">Invested is recomputed as Quantity × Cost/Share on save.</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  {TE_CORE_FIELDS.filter(f => trueEntryHeaders.indexOf(f.header) !== -1).map(f => (
                    <label key={f.key} className="block">
                      <span className="text-[10px] font-bold uppercase text-slate-500">{f.label}</span>
                      {f.kind === 'class' ? (
                        <select value={editForm[f.key] || 'Delivery'}
                          onChange={e => setEditForm(p => ({ ...p, [f.key]: e.target.value }))}
                          className="mt-0.5 w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg bg-white cursor-pointer">
                          <option value="Delivery">Delivery</option>
                          <option value="Intraday">Intraday</option>
                        </select>
                      ) : (
                        <input type={f.kind === 'num' ? 'number' : 'text'} step="any" value={editForm[f.key] ?? ''}
                          onChange={e => setEditForm(p => {
                            const next = { ...p, [f.key]: e.target.value };
                            // Quantity / Avg Price / Turnover are linked — any two fill in the third.
                            const fld = f.key === 'quantity' ? 'qty' : f.key === 'turnover' ? 'amount' : f.key === 'price' ? 'price' : '';
                            if (fld) {
                              const s = solveQtyPriceAmount(fld as 'qty' | 'price' | 'amount', next.quantity ?? '', next.price ?? '', next.turnover ?? '');
                              next.quantity = s.qty; next.price = s.price; next.turnover = s.amount;
                            }
                            return next;
                          })}
                          title={['quantity', 'price', 'turnover'].includes(f.key) ? 'Fill any two of Quantity / Avg Price / Turnover — the third is worked out.' : undefined}
                          className="mt-0.5 w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg font-mono" />
                      )}
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-slate-400">Set both legs of a same-day buy+sell to <strong className="text-slate-600">Intraday</strong> for the matched quantity to post to the Intra-Day P/L column (the surplus stays delivery).</p>
                <p className="mt-4 mb-1.5 text-[10px] font-black uppercase tracking-wider text-slate-400">Expenses</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {TE_EXPENSE_FIELDS.filter(f => trueEntryHeaders.indexOf(f.header) !== -1).map(f => (
                    <label key={f.key} className="block">
                      <span className="text-[10px] font-bold uppercase text-slate-500">{f.label}</span>
                      <input type="number" step="any" value={editForm[f.key] ?? ''}
                        onChange={e => setEditForm(p => ({ ...p, [f.key]: e.target.value }))}
                        className="mt-0.5 w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg font-mono" />
                    </label>
                  ))}
                </div>
                <p className="mt-3 text-[11px] text-slate-400">Brokerage/share, Total Expenses and Total-Amount-with-Expense columns are recalculated automatically on save.</p>
              </>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-slate-200">
            <button onClick={deleteEntry} disabled={savingEdit || deletingEdit}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-rose-600 border border-rose-200 hover:bg-rose-50 rounded-lg cursor-pointer disabled:opacity-50">
              {deletingEdit ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              {deletingEdit ? 'Deleting…' : 'Delete entry'}
            </button>
            <div className="flex items-center gap-2">
              <button onClick={() => setEditingTx(null)} disabled={savingEdit || deletingEdit} className="px-4 py-2 text-xs font-bold text-slate-500 hover:bg-slate-100 rounded-lg cursor-pointer disabled:opacity-50">Cancel</button>
              <button onClick={saveEdit} disabled={savingEdit || deletingEdit} data-autofocus
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg cursor-pointer disabled:opacity-50">
                {savingEdit ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {savingEdit ? 'Saving & recomputing…' : 'Save & recompute'}
              </button>
            </div>
          </div>
        </div>
      </ModalShell>
  );

  // Series badge (PE / PEQ / EQ) and the cleaned display name.
  //
  // The series is taken from the SCRIP MASTER, not guessed from the name. It used to be
  // guessed, and one of the guesses was `name.includes("CHD")` → "PEQ", which tagged any
  // ordinary listed company whose name happened to contain those three letters. An unlisted
  // company is now a fact on its entry (the "Private Equities" tab), so there is nothing
  // left to infer. The "PEQ"/"PRE-EQUITY" name patterns are kept only for their name
  // CLEANING, since some ledger rows really do carry the marker in the text.
  const getCompanyDisplayInfo = (name: string, isin: string) => {
    let type = "EQ";
    let cleanName = name;

    if (name.toUpperCase().includes("PEQ") || isin.toUpperCase().startsWith("PEQ") || name.toUpperCase().includes("PRE-EQUITY")) {
      type = "PEQ";
      cleanName = name.replace(/PEQ/gi, "").replace(/PRE-EQUITY/gi, "").trim();
    }
    // A row on ANY non-listed tab wins over the name-derived guess, and carries which tab it
    // came from ("PE" / "AIF" / "MF") - the segment toggle and every badge read this.
    const cls = assetClassOf(scrip, isin, name);
    if (cls) type = cls;

    cleanName = cleanName.replace(/\s+/g, ' ').replace(/"/g, '');
    return { type, cleanName };
  };

  const formatINR = (num: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 2,
      minimumFractionDigits: 2
    }).format(num);
  };

  /**
   * Corporate-action edit popup. A merger/demerger has no qty/price/charges, so it gets its own
   * form rather than the inline row editor: Date, Shares In, Amount, Notes.
   *
   * The banner is the important part of the UI. One "Corporate Actions" row drives BOTH legs, so
   * this same popup opens from the parent's "Demerger Out" row and the NewCo's "Demerger In" row,
   * and editing either changes both. That's deliberate — a demerger must take exactly as much
   * cost out of the parent as it puts into the NewCo, so there is one amount, not two.
   * Rendered alongside editEntryModal in both top-level return branches.
   */
  const corpActionEditModal = (() => {
    const t = caEditTx, ca = t?.corpAction;
    if (!t || !ca) return null;
    const isDemerger = ca.kind === 'DEMERGER';
    const sharesIn = numCell(caEditForm.sharesIn);
    const cost = numCell(caEditForm.cost);
    const perShare = sharesIn > 0 ? cost / sharesIn : 0;
    const fld = 'w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-white text-slate-800 outline-none focus:ring-1 focus:ring-indigo-500';
    const lbl = 'text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1';
    return (
      <ModalShell open={!!caEditTx} onClose={() => setCaEditTx(null)} labelledBy="ca-edit-title">
        <div className="relative z-10 w-full max-w-md max-h-[88vh] flex flex-col bg-white rounded-2xl shadow-2xl animate-fadeIn">
          <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
            <div>
              <h3 id="ca-edit-title" className="text-sm font-black text-slate-800 flex items-center gap-2">
                <Edit2 className="w-4 h-4 text-indigo-600" /> Edit {ca.type || (isDemerger ? 'Demerger' : 'Merger')}
              </h3>
              <p className="text-[11px] text-slate-500 mt-0.5">
                <span className="font-semibold text-slate-600">{ca.from || '—'}</span>
                <span className="mx-1.5 text-slate-300">→</span>
                <span className="font-semibold text-slate-600">{ca.to || '—'}</span>
                <span className="mx-1.5 text-slate-300">·</span>
                <span className="font-mono">row {ca.rowIndex}</span>
              </p>
            </div>
            <button onClick={() => setCaEditTx(null)} className="p-1.5 hover:bg-slate-100 rounded-lg cursor-pointer"><X className="w-4 h-4 text-slate-500" /></button>
          </div>

          <div className="overflow-y-auto px-5 py-4 space-y-3">
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200">
              <Lock className="w-3.5 h-3.5 text-amber-700 mt-0.5 shrink-0" />
              <p className="text-[11px] text-amber-800 leading-relaxed">
                This is <strong>one</strong> amount shared by both legs — {isDemerger ? 'cost moved out of' : 'cost carried from'}{' '}
                <strong>{ca.from || '—'}</strong> and into <strong>{ca.to || '—'}</strong>. Editing it here updates both sides,
                and re-syncs capital gains for anything sold after this date.
              </p>
            </div>

            <div>
              <label className={lbl}>Action Date</label>
              <input type="date" className={fld} value={caEditForm.dateISO}
                onChange={(e) => setCaEditForm(f => ({ ...f, dateISO: e.target.value }))} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={lbl}>Shares In ({ca.to || 'new'})</label>
                <input type="number" step="any" className={fld} value={caEditForm.sharesIn}
                  onChange={(e) => setCaEditForm(f => ({ ...f, sharesIn: e.target.value }))} />
              </div>
              <div>
                <label className={lbl}>Amount (₹)</label>
                <input type="number" step="any" className={fld} value={caEditForm.cost}
                  onChange={(e) => setCaEditForm(f => ({ ...f, cost: e.target.value }))} />
              </div>
            </div>

            <p className="text-[11px] text-slate-500">
              Cost per share in <span className="font-semibold text-slate-600">{ca.to || 'the new company'}</span>:{' '}
              <span className="font-mono font-bold text-slate-700">{perShare > 0 ? `₹${perShare.toFixed(4)}` : '—'}</span>
              {isDemerger && <> · <span className="font-semibold text-slate-600">{ca.from || 'parent'}</span>&apos;s total cost drops by <span className="font-mono font-bold text-slate-700">₹{cost.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></>}
            </p>

            <div>
              <label className={lbl}>Notes <span className="font-normal normal-case text-slate-400">(optional)</span></label>
              <input type="text" className={fld} value={caEditForm.notes}
                placeholder="e.g. scheme of arrangement ref"
                onChange={(e) => setCaEditForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
            <button onClick={() => setCaEditTx(null)} disabled={caEditSaving}
              className="px-3 py-1.5 text-[11px] font-bold text-slate-600 hover:text-slate-800 cursor-pointer disabled:opacity-50">Cancel</button>
            <button onClick={saveCorpActionEdit} disabled={caEditSaving}
              className="btn-press inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[11px] font-black uppercase tracking-wider rounded-md bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer disabled:opacity-50">
              {caEditSaving ? <><Loader2 className="w-3 h-3 animate-spin" /> Saving…</> : <>Save &amp; Recompute</>}
            </button>
          </div>
        </div>
      </ModalShell>
    );
  })();

  // Bifurcated-expenses popup (Trade Book) — clicking a row in view mode shows the
  // individual charges booked against that entry, read straight from its True Entry
  // charge columns (the same source the Edit popup edits). Opening lots carry none.
  // Rendered alongside editEntryModal in both top-level return branches.
  const expenseModal = (() => {
    const t = expenseTx;
    const raw = t?.rawRow || [];
    const noteText = (t?.notes || "").trim();
    const hasNote = noteText !== "";
    const val = (header: string): number => {
      const i = trueEntryHeaders.indexOf(header);
      return i === -1 ? 0 : numCell(raw[i]);
    };
    const items = t ? [
      { label: 'Brokerage', value: val('Total Brokerage') },
      { label: 'STT', value: val('STT') },
      { label: 'Exchange Turnover Charges', value: val('Exchange Turnover Charges') },
      { label: 'SEBI Turnover Fees', value: val('SEBI Turnover Fees') },
      { label: 'IPF Charges', value: val('IPF Charges') },
      { label: 'Demat Charges', value: val('Demat Charges') },
      { label: 'GST', value: val('Total GST') || val('IGST') },
      { label: 'Stamp Duty', value: val('Stamp Duty') },
    ].filter(x => Math.abs(x.value) > 0.0001) : [];
    const storedTotal = val('Total Expenses (incl STT)');
    const total = storedTotal > 0.0001 ? storedTotal : items.reduce((a, b) => a + b.value, 0);
    const isOpening = t?.editSource === 'opening';
    const isCorpAction = !!t?.corpAction;
    const isOpeningAction = !!t?.openingAction;
    return (
      <ModalShell open={!!expenseTx} onClose={() => setExpenseTx(null)} labelledBy="expense-breakdown-title">
        <div className={`relative z-10 w-full ${hasNote ? 'max-w-lg' : 'max-w-sm'} max-h-[88vh] flex flex-col bg-white rounded-2xl shadow-2xl animate-fadeIn`}>
          <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
            <div>
              <h3 id="expense-breakdown-title" className="text-sm font-black text-slate-800 flex items-center gap-2"><Wallet className="w-4 h-4 text-indigo-600" /> Expense breakdown</h3>
              {t && (
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {t.assetName}<span className="mx-1.5 text-slate-300">·</span>
                  <span className="font-semibold text-slate-600">{t.transactionType}</span><span className="mx-1.5 text-slate-300">·</span>
                  <span className="font-mono">{formatDMY(t.tradeDate)}</span>
                </p>
              )}
            </div>
            <button onClick={() => setExpenseTx(null)} className="p-1.5 hover:bg-slate-100 rounded-lg cursor-pointer"><X className="w-4 h-4 text-slate-500" /></button>
          </div>
          <div className="overflow-y-auto px-5 py-4">
            <div className={hasNote ? 'grid grid-cols-1 sm:grid-cols-2 gap-4' : ''}>
              <div>
                {isOpeningAction ? (
                  <p className="text-[12px] text-slate-500 py-4 text-center">Pre-FY26 corporate action, recorded in the “{OPENING_CORP_ACTIONS_TAB}” tab. Shown for visibility only — it is already baked into the opening lots, so it is not replayed.</p>
                ) : isCorpAction ? (
                  <div className="py-4 text-center space-y-3">
                    <p className="text-[12px] text-slate-500">Corporate action — no cash changed hands, so there are no charges.</p>
                    {t?.corpAction?.rowIndex != null ? (
                      <button
                        onClick={() => { const row = t; setExpenseTx(null); openCorpActionEdit(row); }}
                        className="btn-press inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-black uppercase tracking-wider rounded-md text-amber-700 hover:text-white hover:bg-amber-600 border border-amber-300 hover:border-amber-600 transition-colors cursor-pointer"
                      >
                        <Edit2 className="w-3 h-3" /> Edit amount &amp; shares
                      </button>
                    ) : (
                      <p className="text-[11px] text-slate-400">Edit it in the “{CORP_ACTIONS_TAB}” tab.</p>
                    )}
                  </div>
                ) : isOpening ? (
                  <p className="text-[12px] text-slate-500 py-4 text-center">Carried-in opening lot — no charges recorded.</p>
                ) : items.length === 0 ? (
                  <p className="text-[12px] text-slate-500 py-4 text-center">No charges recorded for this entry.</p>
                ) : (
                  <div className="space-y-1.5">
                    {items.map(it => (
                      <div key={it.label} className="flex items-center justify-between text-[12px]">
                        <span className="text-slate-500">{it.label}</span>
                        <span className="font-mono text-slate-700">{formatINR(it.value)}</span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between pt-2 mt-1 border-t border-slate-200 text-[12px]">
                      <span className="font-black uppercase tracking-wider text-slate-600">Total expenses (incl STT)</span>
                      <span className="font-mono font-black text-slate-800">{formatINR(total)}</span>
                    </div>
                  </div>
                )}
              </div>
              {hasNote && (
                <div className="sm:border-l sm:border-slate-200 sm:pl-4">
                  <div className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1.5 flex items-center gap-1.5"><StickyNote className="w-3.5 h-3.5 text-indigo-600" /> Note</div>
                  <p className="text-[12px] text-slate-700 whitespace-pre-wrap break-words">{noteText}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </ModalShell>
    );
  })();

  const formatValueOnly = (num: number) => {
    return new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(num);
  };

  const formatNum = (num: number) => {
    return new Intl.NumberFormat('en-IN').format(num);
  };

  const requestSort = (field: 'symbol' | 'quantity' | 'avgCost' | 'currentPrice' | 'currentValue' | 'profit') => {
    if (didColResizeRef.current) { didColResizeRef.current = false; return; }   // ignore the click a resize-drag leaves behind
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // One holdings-grid header cell: click to sort (arrow reflects the active column/direction)
  // + a right-edge drag handle to resize the column (Excel-style). `colKey` sizes the column;
  // `sortKey` (omit for non-sortable) drives the sort.
  type HoldSortKey = 'symbol' | 'quantity' | 'avgCost' | 'currentPrice' | 'currentValue' | 'profit';
  const headCell = (colKey: string, label: string, align: 'left' | 'right' | 'center', sortKey?: HoldSortKey) => {
    const active = !!sortKey && sortField === sortKey;
    const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';
    return (
      <th
        key={colKey}
        onClick={sortKey ? () => requestSort(sortKey) : undefined}
        className={`relative px-3 py-2.5 select-none border-r border-slate-200 last:border-r-0 ${sortKey ? 'cursor-pointer hover:bg-slate-100' : ''}`}
      >
        <div className={`flex items-center gap-1 ${justify}`}>
          <span className="truncate">{label}</span>
          {sortKey && (active
            ? (sortDirection === 'asc' ? <ArrowUp className="w-3.5 h-3.5 text-indigo-600 shrink-0" /> : <ArrowDown className="w-3.5 h-3.5 text-indigo-600 shrink-0" />)
            : <ArrowUpDown className="w-3.5 h-3.5 text-slate-300 shrink-0" />)}
        </div>
        {/* Resize handle — stop propagation so dragging/clicking the edge never triggers a sort. */}
        <span
          onMouseDown={(e) => startColResize(e, colKey)}
          onClick={(e) => e.stopPropagation()}
          className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-indigo-500 active:bg-indigo-600"
          aria-hidden="true"
        />
      </th>
    );
  };

  // Sync Parse Contract Note trades local
  const handleSyncContractNoteTrades = () => {
    if (!parsedContractNote || parsedContractNote.trades.length === 0) return;

    setHoldings(prev => {
      const updated = [...prev];
      parsedContractNote.trades.forEach(t => {
        const symbol = t.isin ? t.isin : t.securityName.split(' ')[0] || 'ASSET';
        const name = t.securityName;
        const qty = t.quantity;
        const avgPrice = t.avgPrice;
        const transactionType = t.transactionType;

        // Check if holding already exists in sandbox
        const existingIndex = updated.findIndex(h => h.isin === t.isin || h.symbol === symbol);

        if (existingIndex >= 0) {
          const h = updated[existingIndex];
          if (transactionType === 'Buy') {
            const newQuantity = h.quantity + qty;
            const newAvgCost = ((h.quantity * h.avgCost) + (qty * avgPrice)) / newQuantity;
            updated[existingIndex] = {
              ...h,
              quantity: newQuantity,
              avgCost: Math.round(newAvgCost * 100) / 100
            };
          } else {
            // Sell
            const remainingQty = Math.max(0, h.quantity - qty);
            updated[existingIndex] = {
              ...h,
              quantity: remainingQty
            };
          }
        } else {
          // Add new
          if (transactionType === 'Buy') {
            updated.push({
              id: `${Date.now()}-${Math.random()}`,
              symbol,
              name,
              isin: t.isin || '',
              quantity: qty,
              avgCost: avgPrice,
              currentPrice: avgPrice * 1.05, // Seed with 5% gain
              sector: 'Tactical Allocation'
            });
          }
        }
      });
      return updated;
    });

    setSyncMessage(`Imported ${parsedContractNote.trades.length} trades successfully into your local sandbox holdings!`);
    setTimeout(() => setSyncMessage(null), 5000);
  };

  // Add Manual Position
  const handleAddManualHolding = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSymbol || !newName || !newQty || !newCost || !newCurrentPrice) return;

    const item: PortfolioHolding = {
      id: `${Date.now()}`,
      symbol: newSymbol.trim().toUpperCase(),
      name: newName.trim(),
      isin: newIsin.trim().toUpperCase() || `IN00${Date.now()}`,
      quantity: parseInt(newQty),
      avgCost: parseFloat(newCost),
      currentPrice: parseFloat(newCurrentPrice),
      sector: newSector
    };

    setHoldings(prev => [...prev, item]);
    
    // Clear forms
    setNewSymbol('');
    setNewName('');
    setNewIsin('');
    setNewQty('');
    setNewCost('');
    setNewCurrentPrice('');
    setNewSector('Financial Services');
    setShowAddForm(false);
  };

  // Delete position
  const handleDeleteHolding = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: `Delete ${name}?`,
      body: 'This removes the position from your sandbox portfolio.',
      danger: true,
      confirmLabel: 'Delete',
    });
    if (ok) {
      setHoldings(prev => prev.filter(h => h.id !== id));
    }
  };

  // In-line price updates
  const handleStartEditingPrice = (id: string, currentVal: number) => {
    setEditingPriceId(id);
    setEditingPriceValue(currentVal.toString());
  };

  /**
   * Save an edited CMP.
   *
   * For an UNLISTED company this is now PERSISTED to the "Private Equities" tab, because that
   * tab is where its price actually lives - the previous behaviour put it in React state, so it
   * vanished on reload and never reached the Dashboard or any report. For a listed security it
   * stays a local override on purpose: its price belongs to the feed, and writing a typed number
   * into the shared Prices tab would be overwritten by the next refresh anyway.
   */
  const handleSavePriceEdit = async (id: string) => {
    const val = parseFloat(editingPriceValue);
    setEditingPriceId(null);
    if (isNaN(val) || val < 0) return;

    if (activePortfolio === 'local') {
      setHoldings(prev => prev.map(h => h.id === id ? { ...h, currentPrice: val } : h));
      return;
    }

    const matched = displayHoldings.find(item => item.id === id);
    if (!matched) return;
    const key = matched.isin || matched.name;
    // Applied locally first either way, so the grid reflects the edit immediately rather than
    // after a round trip to Sheets.
    setSheetCmpOverrides(prev => ({ ...prev, [key]: val }));

    if (matched.type !== 'PE') return;                      // listed → local override only

    setSavingPeCmp(key);
    try {
      const r = await setPrivateEquityCmp(
        SCRIP_MASTER_SPREADSHEET_ID, matched.isin || '', matched.name, val, Date.now(),
      );
      if (r.noCmpColumn) {
        toast.error(`Add a "CMP" column to the ${PRIVATE_EQUITIES_TAB} tab — there is nowhere to save this.`);
      } else if (r.written.length === 0) {
        const why = r.skipped[0]?.reason;
        toast.error(why === 'no-row'
          ? `${matched.name} isn’t on the ${PRIVATE_EQUITIES_TAB} tab, so its CMP can’t be saved there.`
          : `Couldn’t save the CMP for ${matched.name}.`);
      } else {
        toast.success(`${matched.name} CMP saved to the ${PRIVATE_EQUITIES_TAB} tab.`);
        // The write invalidated the master's cache; reload so every other view (Dashboard, AUM,
        // reports) reads the new figure instead of this page's local override.
        loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID, { force: true }).then(setScrip).catch(() => {});
      }
    } catch (e: any) {
      toast.error(`Couldn’t save the CMP — ${e?.result?.error?.message || e?.message || 'unknown error'}`);
    } finally {
      setSavingPeCmp(null);
    }
  };

  const getCompanySymbolAndSector = (name: string, isin: string) => {
    const ucName = name.toUpperCase();
    const ucIsin = (isin || "").toUpperCase();

    if (ucName.includes("HDFC") || ucIsin.includes("INE040A01034")) {
      return { symbol: "HDFCBANK", sector: "Financial Services", cleanName: "HDFC Bank Limited" };
    }
    if (ucName.includes("INFOSYS") || ucName.includes("INFY") || ucIsin.includes("INE009A01021")) {
      return { symbol: "INFY", sector: "IT & Tech", cleanName: "Infosys Limited" };
    }
    if (ucName.includes("RELIANCE") || ucIsin.includes("INE002A01018")) {
      return { symbol: "RELIANCE", sector: "Energy", cleanName: "Reliance Industries Limited" };
    }
    if (ucName.includes("TCS") || ucName.includes("CONSULTANCY") || ucIsin.includes("INE467B01029")) {
      return { symbol: "TCS", sector: "IT & Tech", cleanName: "Tata Consultancy Services" };
    }
    if (ucName.includes("ICICI") || ucIsin.includes("INE090A01021")) {
      return { symbol: "ICICIBANK", sector: "Financial Services", cleanName: "ICICI Bank Limited" };
    }
    if (ucName.includes("STATE BANK") || ucName.includes("SBIN") || ucIsin.includes("INE062A01020")) {
      return { symbol: "SBIN", sector: "Financial Services", cleanName: "State Bank of India" };
    }
    if (ucName.includes("WIPRO") || ucIsin.includes("INE075A01022")) {
      return { symbol: "WIPRO", sector: "IT & Tech", cleanName: "Wipro Limited" };
    }
    if (ucName.includes("TATA MOTOR") || ucIsin.includes("INE155A01022")) {
      return { symbol: "TATAMOTORS", sector: "Automobile", cleanName: "Tata Motors Limited" };
    }
    if (ucName.includes("ITC") || ucIsin.includes("INE154A01540")) {
      return { symbol: "ITC", sector: "Consumer Goods", cleanName: "ITC Limited" };
    }

    // Default derivation
    const clean = name.replace(/PEQ/gi, "").replace(/PRE-EQUITY/gi, "").trim();
    const words = clean.split(/\s+/).filter(Boolean);
    let sym = words[0]?.toUpperCase() || "ASSET";
    sym = sym.replace(/[^A-Z0-9]/g, "");
    if (sym.length > 10) sym = sym.substring(0, 8);
    
    // Sector derivation
    let sec = "Tactical Allocation";
    if (ucName.includes("BANK") || ucName.includes("FINANCE") || ucName.includes("CAPITAL") || ucName.includes("MUTUAL")) {
      sec = "Financial Services";
    } else if (ucName.includes("TECH") || ucName.includes("SOFTWARE") || ucName.includes("DIGITAL")) {
      sec = "IT & Tech";
    } else if (ucName.includes("ENERGY") || ucName.includes("POWER") || ucName.includes("OIL") || ucName.includes("GAS")) {
      sec = "Energy";
    } else if (ucName.includes("HEALTH") || ucName.includes("PHARMA") || ucName.includes("DRUG")) {
      sec = "Healthcare";
    } else if (ucName.includes("CONSUMER") || ucName.includes("FOOD") || ucName.includes("GOODS")) {
      sec = "Consumer Goods";
    }

    return { symbol: sym || "PORTFOLIO", sector: sec, cleanName: clean };
  };

  const getPreloadedHoldingsForSheet = (_portfolio: string): SheetHolding[] => {
    // No demo seeds — every portfolio shows real sheet data once synced (empty
    // until then). Kept as a function so callers stay simple.
    return [];
  };

  const getDisplayHoldings = (): DisplayHolding[] => {
    if (activePortfolio === 'local') {
      return holdings.map(h => {
        const totalCost = h.quantity * h.avgCost;
        const totalValue = h.quantity * h.currentPrice;
        const profit = totalValue - totalCost;
        const profitPct = totalCost > 0 ? (profit / totalCost) * 100 : 0;
        const { type } = getCompanyDisplayInfo(h.name, h.isin);

        return {
          id: h.id,
          symbol: h.symbol,
          name: h.name,
          isin: h.isin,
          sector: h.sector,
          quantity: h.quantity,
          avgCost: h.avgCost,
          currentPrice: h.currentPrice,
          currentValue: totalValue,
          unrealizedGain: profit,
          unrealizedGainPct: profitPct,
          todayGain: 0,   // local sandbox has no imported previous-day price
          type,
          original: h
        };
      });
    } else {
      const activeSheetHoldings = sheetHoldings.length > 0
        ? sheetHoldings
        : getPreloadedHoldingsForSheet(activePortfolio);

      // Toggle on → append exited companies (qty 0) after the live positions; they
      // render like any holding and click through to the same scrip drill-down.
      const withSold = showSold ? [...activeSheetHoldings, ...soldHoldings] : activeSheetHoldings;

      return withSold.map((h, index) => {
        const { type, cleanName } = getCompanyDisplayInfo(h.companyName, h.isin);
        const { symbol, sector } = getCompanySymbolAndSector(h.companyName, h.isin);
        
        const overrideKey = h.isin || h.companyName;
        let cmp = sheetCmpOverrides[overrideKey];
        if (cmp === undefined) {
          const real = getRealCmp(h.isin, h.companyName, h.lastTradePrice);
          if (real !== undefined) {
            cmp = real;                          // imported screener price
          } else {
            // No imported price for this stock → value at cost (never fabricate a
            // current price). Real prices arrive via the screener.in CSV import.
            cmp = h.avgBuyPrice;
          }
        }

        // A NEGATIVE net quantity is impossible for a real holding — it means the
        // ledger is inconsistent (a missing buy, or a dropped/duplicated sell). Flag
        // it as a discrepancy and DON'T value it (no cost basis, no CMP applied), so
        // it can't distort the summary cards; the negative qty is shown, in red, as
        // the signal to trace and fix it.
        const discrepancy = h.quantity < -1e-9;
        const totalValue = discrepancy ? 0 : h.quantity * cmp;
        const profit = discrepancy ? 0 : totalValue - h.investedValue;
        const profitPct = (!discrepancy && h.investedValue > 0) ? (profit / h.investedValue) * 100 : 0;

        // Today's gain = qty × (CMP − previous-day price). 0 until a previous-day
        // baseline exists (i.e. after the first import on a later day).
        const prevCmp = getRealPrevCmp(h.isin, h.companyName);
        const todayGain = (!discrepancy && cmp > 0 && prevCmp !== undefined && prevCmp > 0) ? h.quantity * (cmp - prevCmp) : 0;

        // Unlisted? Then carry its Drive folder and any hand-entered valuation onto the row.
        // Keyed on the RAW companyName for the reason noted above.
        const peInfo = peEntry(scrip, h.isin, h.companyName);

        return {
          id: `sheet-${index}`,
          symbol,
          name: cleanName,
          isin: h.isin,
          sector,
          quantity: h.quantity,
          avgCost: h.avgBuyPrice,
          currentPrice: discrepancy ? 0 : cmp,
          currentValue: totalValue,
          unrealizedGain: profit,
          unrealizedGainPct: profitPct,
          todayGain,
          type,
          sold: h.quantity === 0,
          discrepancy,
          peValuation: peInfo?.peValuation,
          peValuationDate: peInfo?.peValuationDate,
          lastTradePrice: h.lastTradePrice,
          lastTradeDate: h.lastTradeDate,
          driveLink: peInfo?.driveLink,
          original: h
        };
      });
    }
  };

  const displayHoldings = getDisplayHoldings();

  // Listed equity vs unlisted companies. Both live in the SAME ledger and both count toward
  // this account's totals — the split is a view of the list, never of the money. The summary
  // cards above the grid are deliberately left whole-account (see getPortfolioSummary): they
  // answer "what is this account worth", and that has to be one number no matter which segment
  // is selected, or the same portfolio would read differently here than on the picker page and
  // on the Dashboard. The segment's own subtotal is shown beside the toggle instead.
  //
  // The account CENSUS per class is `classCensus` below - every row of that class, including a
  // negative-quantity one, since those are ledger errors that must stay visible and flagged as a
  // discrepancy [[holdings-edit-discrepancy]]. It answers "does this account hold this class at
  // all", which is what gates a segment, so it must NOT move with the search box.
  // `peHoldings` / `peValue` / `peAtCost` are the money, so they take only real positions.
  const peHoldings = displayHoldings.filter(h => h.type === 'PE' && !h.sold && h.quantity > 0);
  const peValue = peHoldings.reduce((s, h) => s + h.currentValue, 0);
  // Genuinely at cost = no valuation AND never transacted. A position valued at its last
  // trade is NOT at cost, and counting it as such would make the "enter a valuation" prompt
  // nag about companies that already have a defensible price.
  const peAtCost = peHoldings.filter(h => !((h.peValuation ?? 0) > 0) && !((h.lastTradePrice ?? 0) > 0)).length;

  /** Every non-listed class id, for the "is this listed" test. */
  const NON_LISTED = new Set<string>(ASSET_CLASS_IDS);
  const inClass = (h: DisplayHolding): boolean =>
    assetClass === 'all' ? true
      : assetClass === 'eq' ? !NON_LISTED.has(h.type)
      // Equity means "on none of the non-listed tabs". Testing `!== 'PE'` would have kept the
      // AIF and mutual-fund rows in the Equity segment the moment those tabs existed.
      : h.type === assetClass;

  const matchesSearch = (h: DisplayHolding): boolean => {
    const t = searchTerm.toLowerCase();
    return h.symbol.toLowerCase().includes(t)
      || h.name.toLowerCase().includes(t)
      || h.sector.toLowerCase().includes(t)
      || !!(h.isin && h.isin.toLowerCase().includes(t));
  };

  // The badge on each segment counts rows the grid WOULD show for it — so it is computed after
  // the search, not before. A badge reading "All 42" above three search results is a number the
  // user has to reconcile for no reason; matching the search makes the pair self-explanatory
  // ("aero" → All 2 · Equity 1 · Private Equity 1). The disabled test still uses the census
  // above, or a search that happens to exclude the PE rows would disable the segment mid-typing.
  const searchedHoldings = displayHoldings.filter(matchesSearch);
  const nonListedShown = searchedHoldings.filter(h => NON_LISTED.has(h.type)).length;
  const segmentCounts: Record<string, number> = {
    all: searchedHoldings.length,
    // Equity is everything on NO non-listed tab, so it subtracts all of them, not just PE.
    eq: searchedHoldings.length - nonListedShown,
    ...Object.fromEntries(ASSET_CLASS_IDS.map(id =>
      [id, searchedHoldings.filter(h => h.type === id).length])),
  };
  /** Account census per class - what gates a segment. Never moves with the search box. */
  const classCensus: Record<string, number> = Object.fromEntries(
    ASSET_CLASS_IDS.map(id => [id, displayHoldings.filter(h => h.type === id).length]));

  const filteredHoldings = searchedHoldings.filter(inClass);

  // Totals for whatever the grid is currently showing — the answer to "and what is the slice I
  // selected worth?", since the account cards deliberately never move. Sold, non-positive and
  // discrepancy rows are excluded on exactly the same terms the cards use, so under "All" this
  // reproduces the cards to the paise rather than offering a second, subtly different number.
  const segmentTotals = useMemo(() => {
    let invested = 0, current = 0;
    for (const h of displayHoldings) {
      // Must honour the SEARCH too, not just the class: the segment badges count what the grid
      // shows after the search, so a subtotal that ignored it would sit beside "Equity 1" quoting
      // the whole equity slice.
      if (!inClass(h) || !matchesSearch(h) || h.sold || h.quantity <= 0 || h.discrepancy) continue;
      invested += h.original?.investedValue ?? h.quantity * h.avgCost;
      current += h.currentValue;
    }
    return { invested, current, gain: current - invested };
    // `inClass` / `matchesSearch` are re-made every render, so their captured values are the real
    // dependencies. Both are declared ABOVE this hook deliberately: a `const` arrow referenced
    // from a useMemo callback that runs during the same render throws on the temporal dead zone.
  }, [displayHoldings, assetClass, searchTerm]);

  // A segment that stops being available must not stay selected. Switching to an account with no
  // unlisted holdings while "Private Equity" is active would otherwise leave the grid empty with
  // its own filter greyed out — the control that caused it unable to undo it.
  useEffect(() => {
    if (assetClass !== 'all' && assetClass !== 'eq'
        && scrip !== null && classCensus[assetClass] === 0) setAssetClass('all');
    // Depend on the ONE count that matters, not the whole map: `classCensus` is rebuilt every
    // render, so passing it would re-run this effect on every render for nothing.
  }, [assetClass, scrip, classCensus[assetClass as string] ?? -1]);

  const sortedHoldings = [...filteredHoldings].sort((a, b) => {
    let aVal: any = a[sortField as keyof DisplayHolding] || '';
    let bVal: any = b[sortField as keyof DisplayHolding] || '';

    if (sortField === 'symbol') {
      // The Security Name column shows h.name — sort by that (fall back to the ticker).
      aVal = (a.name || a.symbol || '').toString();
      bVal = (b.name || b.symbol || '').toString();
    } else if (sortField === 'currentValue') {
      aVal = a.currentValue;
      bVal = b.currentValue;
    } else if (sortField === 'profit') {
      aVal = a.unrealizedGain;
      bVal = b.unrealizedGain;
    } else if (sortField === 'quantity') {
      aVal = a.quantity;
      bVal = b.quantity;
    } else if (sortField === 'avgCost') {
      aVal = a.avgCost;
      bVal = b.avgCost;
    } else if (sortField === 'currentPrice') {
      aVal = a.currentPrice;
      bVal = b.currentPrice;
    }

    if (typeof aVal === 'string') {
      return sortDirection === 'asc'
        ? aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' })
        : bVal.localeCompare(aVal, undefined, { numeric: true, sensitivity: 'base' });
    }
    return sortDirection === 'asc' ? (aVal - bVal) : (bVal - aVal);
  });

  // Standalone Newton-Raphson solver for exact XIRR position returns
  const calculateXIRR = (cashFlows: { date: Date; amount: number }[]): number => {
    if (cashFlows.length < 2) return 0;
    
    let hasPos = false;
    let hasNeg = false;
    for (const cf of cashFlows) {
      if (cf.amount > 0) hasPos = true;
      if (cf.amount < 0) hasNeg = true;
    }
    if (!hasPos || !hasNeg) return 0;

    const E12 = 1e-12;
    const maxIteration = 100;
    const guess = 0.1; // 10% anchor

    const xirrEquation = (r: number) => {
      let f = 0;
      for (const cf of cashFlows) {
        const d = (cf.date.getTime() - cashFlows[0].date.getTime()) / (1000 * 60 * 60 * 24 * 365);
        f += cf.amount / Math.pow(1 + r, d);
      }
      return f;
    };

    const xirrDeriv = (r: number) => {
      let df = 0;
      for (const cf of cashFlows) {
        const d = (cf.date.getTime() - cashFlows[0].date.getTime()) / (1000 * 60 * 60 * 24 * 365);
        if (d > 0) {
          df -= d * cf.amount / Math.pow(1 + r, d + 1);
        }
      }
      return df;
    };

    let r = guess;
    for (let i = 0; i < maxIteration; i++) {
      const f = xirrEquation(r);
      const df = xirrDeriv(r);
      if (Math.abs(df) < E12) break;
      const nextR = r - f / df;
      if (isNaN(nextR) || !isFinite(nextR)) break;
      if (Math.abs(nextR - r) < 1e-6) {
        return nextR * 100;
      }
      r = nextR;
    }
    return 0; // NR fallback
  };

  // Build high-affinity render element of stock granular details
  const renderStockDetailView = () => {
    if (!selectedStock) return null;

    const isLocal = activePortfolio === 'local';
    const name = isLocal ? (selectedStock as PortfolioHolding).name : (selectedStock as SheetHolding).companyName;
    const isin = selectedStock.isin || '';
    const quantity = isLocal ? (selectedStock as PortfolioHolding).quantity : (selectedStock as SheetHolding).quantity;
    const avgBuyPrice = isLocal ? (selectedStock as PortfolioHolding).avgCost : (selectedStock as SheetHolding).avgBuyPrice;
    const investedValue = isLocal ? (quantity * avgBuyPrice) : (selectedStock as SheetHolding).investedValue;

    const { type: seriesType, cleanName } = getCompanyDisplayInfo(name, isin);

    // Resolve NSE / BSE / ISIN from the shared scrip master (same sheet).
    const scripEntry = scrip ? lookupScrip(scrip, isin, name).entry : null;
    const displayIsin = isin || scripEntry?.isin || '';
    // Unlisted company? Then it has a Drive folder of documents instead of a Screener page,
    // and its long-term holding period is 24 months rather than 12. Declared BEFORE the
    // exchange identifiers because they now depend on it.
    const peInfo = peEntry(scrip, isin, name);

    /**
     * Exchange identifiers: the scrip master, or nothing.
     *
     * `nseSymbol` used to read `scripEntry?.nse || selectedStock.symbol || inferredSymbol`,
     * where `inferredSymbol` was THE FIRST WORD OF THE COMPANY NAME, UPPERCASED. So anything
     * the master didn't match displayed a confident "NSE: <GUESS>" for a ticker that exists on
     * no exchange - and an unlisted company matches no ticker by definition, so every single
     * one of them showed a fabricated symbol. `selectedStock.symbol` is no better a source:
     * `getCompanySymbolAndSector` falls back to a name-derived guess and finally to the literal
     * string "PORTFOLIO".
     *
     * An UNLISTED company has no exchange identity at all. Both pills are suppressed outright,
     * even if a contradictory ticker sits on its master entry (foldPrivateEquities warns about
     * that case) - the sheet says unlisted, so ISIN is the identity and the only thing shown.
     *
     * This is the rule the Screener link below has always followed. The pills just weren't
     * held to it, so they asserted an identifier the app itself refused to build a URL from.
     */
    const nseSymbol = peInfo ? '' : (scripEntry?.nse || '');
    const bseCode = peInfo ? '' : (scripEntry?.bse || '');
    // Either correct or absent, never a 404-y guess - and never for an unlisted company.
    const screenerHref = peInfo ? '' : screenerUrl(scripEntry?.nse, scripEntry?.bse);
    const driveHref = peInfo?.driveLink || '';
    // NULL when this security's class has no decided holding-period rule (a mutual fund).
    // It must NOT fall through as a number: `now - null * 86400000` is `now`, which makes
    // nothing long-term, while `ageDays > null` is `> 0`, which makes EVERYTHING long-term -
    // the same page would then disagree with itself. No strictNullChecks here to catch either.
    const ltDays = ltDaysFor(scrip, isin, name);
    const ltKnown = ltDays !== null;

    // Compute CMP values — prefer the imported screener price; otherwise value at
    // cost once any prices exist, else fall back to the legacy placeholder.
    let defaultCmp = avgBuyPrice * 1.0636;
    if (cleanName.toLowerCase().includes("adani")) {
      defaultCmp = 2908.80;
    }
    const detailLastPx = isLocal ? undefined : (selectedStock as SheetHolding).lastTradePrice;
    const detailLastDt = isLocal ? undefined : (selectedStock as SheetHolding).lastTradeDate;
    const realDetailCmp = getRealCmp(isin, name, detailLastPx);
    if (realDetailCmp !== undefined) defaultCmp = realDetailCmp;
    else if (priceRows.length > 0) defaultCmp = avgBuyPrice;
    const cmpPrice = customCmp !== null ? customCmp : defaultCmp;
    // Lifetime gain over cost — feeds the return/XIRR stat's fallback (NOT the CMP corner).
    const changePct = avgBuyPrice > 0 ? ((cmpPrice - avgBuyPrice) / avgBuyPrice) * 100 : 0;
    // Day's move for the CMP corner: CMP vs yesterday's close (getRealPrevCmp → Prices tab
    // "Previous Price"). Undefined — so the corner shows NO % rather than a misleading one —
    // when there's no previous close, or the shown price is just the avg-cost fallback.
    const usingAvgCostFallback = realDetailCmp === undefined && customCmp === null;
    // Is the price on screen the session's settled close? Only meaningful for a real fetched
    // CMP — a typed override or the avg-cost fallback has no capture time behind it.
    const showingRealCmp = customCmp === null && realDetailCmp !== undefined;
    const detailStamp = showingRealCmp ? getCmpStamp(isin, name) : undefined;
    const detailCmpUpdated = detailStamp?.updated;
    // GOLD means "this IS the session's closing price". Two conditions, and the second one is
    // the important one: the price must belong to the CURRENT session, not merely have been
    // fetched after the bell. Without it, a scrip Yahoo has gone blind on renders gold every
    // evening while showing the previous close (Accent Microcell, 7-Aug-2026).
    // Sheets predating the "Price Date" column have no session to check, so they fall back to
    // the stamp alone rather than losing the indicator entirely.
    const priceIsCurrentSession = !currentSession || detailStamp?.priceDate === currentSession;
    const cmpIsStale = !!currentSession && !!detailStamp?.priceDate && detailStamp.priceDate < currentSession;
    const cmpIsSettled = !!detailCmpUpdated && isSettledClose(detailCmpUpdated) && priceIsCurrentSession;
    const detailPrevClose = getRealPrevCmp(isin, name);
    const dayChangePct = !usingAvgCostFallback && detailPrevClose && detailPrevClose > 0
      ? ((cmpPrice - detailPrevClose) / detailPrevClose) * 100
      : undefined;

    // FIFO processing variables
    interface InventoryLot {
      date: string;
      quantity: number;
      remainingQty: number;
      price: number;
      /** ALL-IN cost per share (charges capitalised). `price` is the charge-free Avg Price,
       *  which is the capital-gains basis; a transfer needs both so the destination shows the
       *  same invested value while inheriting the same tax basis. */
      inclPrice?: number;
      isOpening?: boolean;
      longTerm?: boolean;
    }

    interface RealisedTransaction {
      qtySold: number;
      buyPrice: number;
      sellPrice: number;
      buyDate: string;
      sellDate: string;
      gain: number;
    }

    // Date order with a buy→split/action→sell tiebreak for same-day rows (see `txEvOrd`).
    const chronxs = [...transactions].sort((a, b) =>
      (parseDateStr(a.tradeDate) - parseDateStr(b.tradeDate)) || (txEvOrd(a) - txEvOrd(b)));

    const activeInventory: InventoryLot[] = [];
    const realisedTrades: RealisedTransaction[] = [];
    let totalDividend = 0;
    let totalBuyAmount = 0;
    let totalSellAmount = 0;
    // Corporate actions move cost between two securities without any cash changing hands.
    // On THIS scrip's page the transfer still has to enter the return calculation, or a
    // NewCo's shares would look free (infinite return) and an absorbed Target would look
    // like a total loss. So each action contributes a synthetic flow at its carrying value:
    // cost carried IN is an outflow, cost carried OUT is an inflow.
    const corpFlows: { date: Date; amount: number }[] = [];

    for (const t of chronxs) {
      // Pre-FY26 bonus/split/rights memo — shown in the Trade Book, never replayed: the
      // opening lots it produced already carry its effect.
      if (t.openingAction) continue;

      const type = t.transactionType.toUpperCase();
      const actionAmt = t.quantity * t.price;

      if (type.includes("DIVIDEND")) {
        const divAmt = t.amount > 0 ? t.amount : (t.quantity > 0 ? t.quantity * t.price : 0);
        totalDividend += divAmt;
        continue;
      }

      // Merger / demerger — transform the lot queue exactly like `replayFifoHoldings` (the
      // engine behind the Holding tab) so this page's cost basis agrees with it. Full
      // precision on the scaled cost/share: no r2 here [[no-rounding-cost-basis]].
      if (t.corpAction) {
        const ca = t.corpAction;
        const when = new Date(parseDateStr(t.tradeDate));
        if (ca.role === 'in') {
          // Acquirer / NewCo: a fresh lot at the carried cost. Its acquisition date is the
          // ACTION date, so the holding-period clock restarts — the documented trade-off of
          // typing the cost manually rather than carrying each original lot's date.
          const px = ca.sharesIn > 0 ? ca.cost / ca.sharesIn : 0;
          totalBuyAmount += ca.cost;
          corpFlows.push({ date: when, amount: -ca.cost });
          activeInventory.push({ date: t.tradeDate, quantity: ca.sharesIn, remainingQty: ca.sharesIn, price: px });
        } else if (ca.kind === 'MERGER') {
          // Target absorbed: every lot goes, and NO gain is booked (the cost rides across
          // into the Acquirer, where it becomes that lot's basis).
          const carried = activeInventory.reduce((s, l) => s + l.remainingQty * l.price, 0);
          for (const l of activeInventory) l.remainingQty = 0;
          corpFlows.push({ date: when, amount: carried });
        } else {
          // Parent of a demerger: share count unchanged, remaining cost scaled down so that
          // exactly `ca.cost` leaves for the NewCo.
          const remCost = activeInventory.reduce((s, l) => s + l.remainingQty * l.price, 0);
          const f = remCost > 0 ? Math.max(0, (remCost - ca.cost) / remCost) : 1;
          for (const l of activeInventory) l.price = l.price * f;
          corpFlows.push({ date: when, amount: remCost - remCost * f });
        }
        continue;
      }

      if (isSplitType(t.transactionType)) {
        // Split: subdivide the held lots (qty ×factor, cost/share ÷factor), keeping each
        // lot's acquisition date — NOT a ₹0 add on the split date.
        const held = activeInventory.reduce((s, l) => s + l.remainingQty, 0);
        if (held > 1e-9 && t.quantity > 0) {
          const f = (held + t.quantity) / held;
          for (const l of activeInventory) { l.quantity *= f; l.remainingQty *= f; l.price = l.price / f; }
        }
        continue;
      }

      const side = ledgerSide(t.transactionType);   // Buy/IPO/Bonus/Rights → BUY (Bonus at ₹0)
      if (side === "BUY") {
        totalBuyAmount += actionAmt;
        // All-in cost/share for a transfer: read the incl-STT column off the raw ledger row.
        // Transaction.amount is only the charge-free turnover, so it cannot serve here. An
        // opening lot has no rawRow and falls back to its carried cost per share.
        const inclIdx = trueEntryHeaders.indexOf("Total Amount with Expense (Incl STT)");
        const inclAmt = t.rawRow && inclIdx >= 0 ? Number(t.rawRow[inclIdx]) : NaN;
        activeInventory.push({
          date: t.tradeDate,
          quantity: t.quantity,
          remainingQty: t.quantity,
          price: t.price,
          inclPrice: t.quantity > 0 && isFinite(inclAmt) && inclAmt > 0 ? inclAmt / t.quantity : t.price,
          isOpening: t.isOpening,
          longTerm: t.longTerm
        });
      } else if (side === "SELL") {
        totalSellAmount += actionAmt;
        let sellQty = t.quantity;
        
        for (const lot of activeInventory) {
          if (sellQty <= 0) break;
          if (lot.remainingQty <= 0) continue;

          if (sellQty >= lot.remainingQty) {
            const qtyToDeduct = lot.remainingQty;
            sellQty -= qtyToDeduct;
            realisedTrades.push({
              qtySold: qtyToDeduct,
              buyPrice: lot.price,
              sellPrice: t.price,
              buyDate: lot.date,
              sellDate: t.tradeDate,
              gain: (t.price - lot.price) * qtyToDeduct
            });
            lot.remainingQty = 0;
          } else {
            const qtyToDeduct = sellQty;
            lot.remainingQty -= qtyToDeduct;
            realisedTrades.push({
              qtySold: qtyToDeduct,
              buyPrice: lot.price,
              sellPrice: t.price,
              buyDate: lot.date,
              sellDate: t.tradeDate,
              gain: (t.price - lot.price) * qtyToDeduct
            });
            sellQty = 0;
          }
        }
      }
    }

    const filteredInventory = activeInventory.filter(l => l.remainingQty > 0);
    const realisedGain = realisedTrades.reduce((sum, r) => sum + r.gain, 0);

    // Display-only rows don't count: a scrip whose ONLY rows are pre-FY26 action memos has
    // nothing to replay, so it must still fall back to the sheet's quantity rather than
    // replaying to zero and reading as sold out.
    const hasTransactions = transactions.some(t => !t.openingAction);
    const holdingQty = hasTransactions ? filteredInventory.reduce((sum, l) => sum + l.remainingQty, 0) : quantity;
    // Trust the ledger's FIFO when we have the transactions — including a legitimate 0
    // (fully sold). Only fall back to the sheet quantity when there is nothing to replay.
    // (Previously `holdingQty > 0 ? holdingQty : quantity` treated a sold-out 0 as "no
    // data" and showed the stale sheet qty — e.g. Onesource: 860 opening − 860 sold = 0
    // but the card displayed 860 with a phantom unrealised gain.)
    // Surviving FIFO lots can never go below zero — a sell with no lot left to consume is simply
    // dropped — so `holdingQty` floors at 0 and an OVERSELL (more sold than ever held, a data
    // error) reads as "sold out". The Holding tab doesn't hide it: replayFifoHoldings tracks
    // netQty independently of the lots for exactly this reason, and the holdings list flags
    // `h.quantity < 0` as a discrepancy. That's why the list showed -1,00,000 while this card
    // showed 0.
    //
    // Rather than re-derive a second net quantity here (which could drift), take the one the
    // Trade Book already computed: the rolling `balanceQuantity` on the LAST chronological row.
    // Same ordering rule (buys → actions → sells), so the card and the Bal Qty column agree by
    // construction.
    const ledgerNetQty = (() => {
      const rows = chronxs.filter(t => !t.openingAction && t.balanceQuantity !== undefined);
      return rows.length ? (rows[rows.length - 1].balanceQuantity as number) : null;
    })();
    const finalHoldingQty = hasTransactions ? (ledgerNetQty ?? holdingQty) : quantity;
    // An oversold position is NOT sold out — it's broken. Keep them apart so a negative doesn't
    // silently take the sold-out path (which zeroes cost and reads as a clean exit).
    const detailDiscrepancy = hasTransactions && finalHoldingQty < -1e-4;
    const soldOut = hasTransactions && Math.abs(finalHoldingQty) <= 1e-4;

    const finalAvgBuyPrice = hasTransactions && filteredInventory.reduce((sum, l) => sum + l.remainingQty, 0) > 0
      ? (filteredInventory.reduce((sum, l) => sum + (l.remainingQty * l.price), 0) / filteredInventory.reduce((sum, l) => sum + l.remainingQty, 0))
      : avgBuyPrice;
    
    const finalInvestedValue = finalHoldingQty * finalAvgBuyPrice;
    // Position-size Invested Value / Avg Buy Price normally mirror the Holding tab (all-in
    // incl-STT cost) so the detail matches the summary card — BUT only when the tab is in
    // SYNC with the live ledger, i.e. its quantity equals the FIFO's. When they diverge, the
    // Holding tab is STALE (rebuilt before some opening lots / trades were added — e.g. Deccan:
    // the tab holds only the first lot's 25,000 @ ₹48.22 while three opening lots total 63,180),
    // and pairing that stale cost with the live quantity fabricates a gain. So when out of sync,
    // fall back to the ledger's own weighted-average cost, which is self-consistent with
    // finalHoldingQty. (Rebuild the Holding tab to resync the summary/list — see the detail note.)
    // A sold-out position has no cost / market value / unrealised gain left.
    const holdingTabInSync = !isLocal && investedValue > 0 &&
      Math.abs(quantity - finalHoldingQty) <= Math.max(1, finalHoldingQty * 0.01);
    // A discrepancy has no meaningful cost basis (the lots ran out before the sells did), so it
    // is not valued — mirroring the holdings list, which zeroes cost/CMP/gain on `discrepancy`
    // rather than multiplying a negative quantity into a fake number.
    const displayInvestedValue = (soldOut || detailDiscrepancy) ? 0 : (holdingTabInSync ? investedValue : finalInvestedValue);
    const displayAvgBuyPrice = (soldOut || detailDiscrepancy) ? 0 : (holdingTabInSync ? avgBuyPrice : finalAvgBuyPrice);

    // Real long-term quantity: lots acquired MORE than the LTCG threshold before today,
    // summed from the live inventory — replaces the old hardcoded `finalHoldingQty × 0.81`
    // placeholder [[holdings-no-mock-data]]. Only meaningful when we have the per-lot dates
    // (hasTransactions); the badge is hidden otherwise.
    //
    // The threshold is 12 months for listed equity but 24 for an UNLISTED company, so this
    // is derived from `ltDays` rather than fixed at one year.
    const ltCutoffTs = ltKnown ? Date.now() - ltDays! * 86400000 : 0;
    // Undecided rule → report 0 long-term rather than a number derived from a guess.
    const longTermQty = hasTransactions && ltKnown
      ? filteredInventory.reduce((s, l) => { const ts = parseDateStr(l.date); return s + (ts > 0 && ts < ltCutoffTs ? l.remainingQty : 0); }, 0)
      : 0;
    const totalHoldingValue = (soldOut || detailDiscrepancy) ? 0 : finalHoldingQty * cmpPrice;
    const unrealizedGain = totalHoldingValue - displayInvestedValue;
    const totalGain = unrealizedGain + realisedGain + totalDividend;

    // XIRR calculation with terminal asset value cash flow
    const cashFlows: { date: Date; amount: number }[] = [...corpFlows];
    chronxs.forEach(t => {
      if (t.corpAction || t.openingAction) return;   // no cash: handled above / display only
      const type = t.transactionType.toUpperCase();
      const side = ledgerSide(t.transactionType);   // Bonus/Split are ₹0 → no cash-flow impact
      if (side === "BUY") {
        cashFlows.push({ date: new Date(parseDateStr(t.tradeDate)), amount: -1 * (t.quantity * t.price) });
      } else if (side === "SELL") {
        cashFlows.push({ date: new Date(parseDateStr(t.tradeDate)), amount: t.quantity * t.price });
      } else if (type.includes("DIVIDEND")) {
        const divAmt = t.amount > 0 ? t.amount : (t.quantity > 0 ? t.quantity * t.price : 0);
        cashFlows.push({ date: new Date(parseDateStr(t.tradeDate)), amount: divAmt });
      }
    });
    cashFlows.push({ date: new Date(), amount: totalHoldingValue });

    // Oversold ⇒ the sell cash-flows have no matching buys, so XIRR solves against a phantom
    // return (Kisan Mouldings: one ₹26 L outflow against ₹72 L of inflows → 178,366%). Refuse to
    // publish a number rather than print a meaningless one.
    const computedXirr = detailDiscrepancy ? 0 : calculateXIRR(cashFlows);
    const xirrValue = detailDiscrepancy ? 0 : (computedXirr !== 0 ? computedXirr : changePct);

    // Whose holding this is. The ACCOUNT is deliberately not shown here any more - the page you
    // came from already names it and Back returns to it, so repeating "Name/Code" on every
    // stock was noise. `portfolioLabel` went with it rather than being left dead: this project
    // has no `noUnusedLocals`, so an orphaned const compiles silently and reads as still-used.
    const _p = portfolioById(activePortfolio);
    const clientName = activePortfolio === 'local' ? 'Local Sandbox User' : (_p?.label ?? activePortfolio);

    const formatNum = (v: number) => {
      return new Intl.NumberFormat('en-IN').format(v);
    };

    // Filter the ledger — every column is searchable (date, type, qty, price,
    // brokerage, amount, bal qty).
    const q = txSearchTerm.trim().toLowerCase();
    const filteredTxs = transactions.filter(t =>
      !q ||
      t.tradeDate.toLowerCase().includes(q) ||
      formatDMY(t.tradeDate).includes(q) ||   // search what's DISPLAYED (dd/mm/yyyy), not just the stored form
      t.transactionType.toLowerCase().includes(q) ||
      t.price.toString().includes(q) ||
      t.quantity.toString().includes(q) ||
      t.brokerage.toString().includes(q) ||
      t.amount.toString().includes(q) ||
      (t.balanceQuantity !== undefined && t.balanceQuantity.toString().includes(q))
    );

    // Sort by any column (headers are clickable). Date sorts chronologically, text
    // columns alphabetically, the rest numerically.
    const txSortVal = (t: Transaction, key: string): number | string => {
      switch (key) {
        case 'transactionType': return t.transactionType.toLowerCase();
        case 'quantity': return t.quantity;
        case 'price': return t.price;
        case 'brokerage': return t.brokerage;
        case 'amount': return t.amount;
        case 'balanceQuantity': return t.balanceQuantity ?? -Infinity;
        case 'tradeDate':
        default: return parseDateStr(t.tradeDate);
      }
    };
    const sortedTxs = [...filteredTxs].sort((a, b) => {
      const av = txSortVal(a, txSort.key), bv = txSortVal(b, txSort.key);
      const c = (typeof av === 'string' || typeof bv === 'string')
        ? String(av).localeCompare(String(bv))
        : (av as number) - (bv as number);
      return txSort.dir === 'asc' ? c : -c;
    });
    const toggleTxSort = (key: string) =>
      setTxSort(s => s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'tradeDate' ? 'desc' : 'asc' });
    const sortTh = (label: string, sortKey: string, align: 'left' | 'right' = 'left') => (
      <th className={`px-6 py-3 ${align === 'right' ? 'text-right' : 'text-left'}`}>
        <button
          onClick={() => toggleTxSort(sortKey)}
          className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-indigo-600 transition-colors cursor-pointer select-none"
          title={`Sort by ${label.toLowerCase()}`}
        >
          <span>{label}</span>
          {txSort.key === sortKey
            ? <span className="text-indigo-500 text-[9px] leading-none">{txSort.dir === 'asc' ? '▲' : '▼'}</span>
            : <ArrowUpDown className="w-3 h-3 opacity-40" />}
        </button>
      </th>
    );

    const handleEditCmpClick = () => {
      setIsEditingCmp(true);
      setCmpInputVal(cmpPrice.toFixed(2));
    };

    const handleCmpSave = () => {
      const parsedVal = parseFloat(cmpInputVal);
      if (!isNaN(parsedVal) && parsedVal >= 0) {
        setCustomCmp(parsedVal);
      }
      setIsEditingCmp(false);
    };

    return (
      <div className="space-y-6 animate-fadeIn pb-12" id="stock-detail-view-container">
        
        {/* Breadcrumb row and visual headers */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <button
              onClick={() => { setSelectedStock(null); setCustomCmp(null); }}
              className="group inline-flex items-center gap-2 mb-2 px-3.5 py-2 rounded-xl text-xs font-black tracking-wide shadow-sm border transition-all cursor-pointer active:scale-[0.98] text-indigo-700 bg-indigo-500/10 border-indigo-300/60 hover:bg-indigo-500/20 hover:border-indigo-400 dark:bg-[#d9a441]/10 dark:border-[#d9a441]/40 dark:hover:bg-[#d9a441]/20"
              id="back-to-consolidated-btn"
            >
              <span className="flex items-center justify-center w-5 h-5 rounded-lg border border-indigo-300/50 bg-indigo-500/15 text-indigo-700 transition-transform group-hover:-translate-x-0.5 dark:bg-[#d9a441]/20 dark:border-[#d9a441]/30">
                <ArrowLeft className="w-3.5 h-3.5" />
              </span>
              Back to Portfolios
            </button>
            <div className="flex items-center gap-2 mt-2">
              <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight" id="detail-company-heading">
                {cleanName}
              </h1>
              <span
                className={`font-black text-[10px] px-2 py-0.5 rounded-md border select-none ${
                  seriesType === 'PEQ' || seriesType === 'PE'
                    ? 'bg-orange-50 text-orange-700 border-orange-200'
                    : 'bg-indigo-50 text-indigo-700 border-indigo-200'
                }`}
                id="detail-series-badge"
                title={seriesType === 'PE'
                  ? 'Unlisted company — no market price; long-term after 24 months'
                  : undefined}
              >
                {seriesType}
              </span>
              {screenerHref && (
                <a
                  href={screenerHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  id="detail-screener-link"
                  title="Open on Screener.in"
                  aria-label="Open on Screener.in"
                  className="inline-flex items-center shrink-0 rounded-md opacity-85 hover:opacity-100 hover:scale-105 transition-all cursor-pointer"
                >
                  <ScreenerLogo size={20} />
                </a>
              )}
              {/* An unlisted company's document folder, from the Private Equities tab. Occupies
                  the same slot as the Screener link — the two never compete, since a private
                  company has no NSE/BSE code for `screenerUrl` to build a link from. */}
              {driveHref && (
                <a
                  href={driveHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  id="detail-drive-link"
                  title="Open this company's Drive folder"
                  aria-label="Open this company's Drive folder"
                  className="inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-md border border-indigo-200 bg-indigo-50 text-indigo-700 text-[10px] font-black hover:bg-indigo-100 transition-colors cursor-pointer"
                >
                  <FolderOpen className="w-3 h-3" /> Docs
                </a>
              )}
            </div>
            
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 font-medium pt-1">
              <div id="detail-client-meta">Client Name: <strong className="text-slate-800 font-bold">{clientName}</strong></div>
            </div>

            {/* This page is where a wrong holding period is actually READ — the long-term badges
                in the lot table below, and the long-term quantity on the position card. When the
                Private Equities tab can't be read the app cannot tell whether this company is
                unlisted, so it silently falls back to the 12-month listed threshold. Say so here
                and not only on the portfolio page: this page is reachable straight from the
                Dashboard's holdings table, without passing that banner. */}
            {scrip?.peFailed && (
              <div className="mt-2 inline-flex items-start gap-1.5 px-2.5 py-1.5 rounded-lg border border-amber-200 bg-amber-50 text-[11px] text-amber-800 font-medium">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>
                  Couldn't read the <strong>{PRIVATE_EQUITIES_TAB}</strong> tab, so if this company is
                  unlisted its long-term threshold is being applied as 12 months instead of 24 — treat the
                  long/short split below as unverified until it loads.
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-col items-start sm:items-end gap-2 shrink-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              {nseSymbol && (
                <span className="bg-slate-100 text-slate-700 border border-slate-200 text-[10px] font-bold px-2 py-0.5 rounded-lg" id="detail-symbol-pill">
                  NSE: {nseSymbol}
                </span>
              )}
              {bseCode && (
                <span className="bg-slate-100 text-slate-700 border border-slate-200 text-[10px] font-bold px-2 py-0.5 rounded-lg" id="detail-bse-pill">
                  BSE: {bseCode}
                </span>
              )}
              {displayIsin && (
                <span className="bg-slate-100 text-slate-700 border border-slate-200 text-[10px] font-mono px-2 py-0.5 rounded-lg tracking-wider" id="detail-isin-pill">
                  ISIN: {displayIsin}
                </span>
              )}
            </div>

            {/* CMP Interactive Panel. An unlisted company has no "current market price" — the
                figure is a hand-entered valuation, the price it last transacted at, or its own
                cost, so the label says WHICH rather than implying a market. Showing "CMP" over
                an average cost was the thing that made the number look like a quote. */}
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-xl mt-1">
              <span
                className="text-[10px] uppercase font-black text-slate-400"
                title={peInfo
                  ? (peInfo.peValuation
                      ? `Valuation from the ${PRIVATE_EQUITIES_TAB} tab${peInfo.peValuationDate ? `, as on ${formatDMY(peInfo.peValuationDate)}` : ''}`
                      : (detailLastPx ?? 0) > 0
                        ? `No valuation entered — valued at the price it last traded at${detailLastDt ? ` on ${formatDMY(detailLastDt)}` : ''}. Enter a valuation on the ${PRIVATE_EQUITIES_TAB} tab to override.`
                        : 'No valuation entered and never traded — carried at cost')
                  : undefined}
              >
                {peInfo
                  ? (peInfo.peValuation ? 'VALUATION' : (detailLastPx ?? 0) > 0 ? 'LAST TRADE' : 'AT COST')
                  : 'CMP'}
              </span>
              {isEditingCmp ? (
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    step="0.01"
                    value={cmpInputVal}
                    onChange={(e) => setCmpInputVal(e.target.value)}
                    className="w-20 px-1 py-0.5 border border-indigo-400 text-xs font-mono font-bold text-right rounded bg-white"
                    autoFocus
                    id="cmp-input-editor"
                  />
                  <button 
                    onClick={handleCmpSave}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[9px] px-1.5 py-0.5 rounded shadow cursor-pointer"
                    id="save-cmp-btn"
                  >
                    Set
                  </button>
                  <button 
                    onClick={() => setIsEditingCmp(false)}
                    className="bg-slate-200 hover:bg-slate-300 text-slate-600 font-black text-[9px] px-1.5 py-0.5 rounded cursor-pointer"
                    id="cancel-cmp-btn"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  {/* Gold once the shown price is the session's SETTLED close (captured at/after
                      the 15:30 bell) — brass on paper, gold on the terminal. Only ever for a real
                      fetched CMP: a manual override or an avg-cost fallback stays default ink. */}
                  <span
                    className={`text-sm font-black font-mono ${cmpIsSettled ? 'cmp-settled' : cmpIsStale ? 'text-slate-500' : 'text-slate-800'}`}
                    id="cmp-display-price"
                    title={cmpIsStale
                      ? `STALE — this is the ${formatDMY(detailStamp?.priceDate)} close. The feed had no price for ${formatDMY(currentSession)}, though we checked at ${formatDMYTime(detailCmpUpdated)} IST.`
                      : cmpIsSettled
                        ? `Closing price for ${formatDMY(detailStamp?.priceDate || currentSession)} — captured ${formatDMYTime(detailCmpUpdated)} IST, after the 15:30 bell.`
                        : detailCmpUpdated
                          ? `Live price — captured ${formatDMYTime(detailCmpUpdated)} IST, before the 15:30 close.`
                          : undefined}
                  >
                    {formatINR(cmpPrice)}
                  </span>
                  {cmpIsStale && (
                    <span className="px-1.5 py-0.5 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-[9px] font-black uppercase tracking-wider"
                      title={`No price for ${formatDMY(currentSession)} — showing the ${formatDMY(detailStamp?.priceDate)} close.`}>
                      Stale
                    </span>
                  )}
                  {/* Day's move vs yesterday's close — hidden when there's no previous close to
                      compare against (never the gain-over-cost, which lives in the return stat). */}
                  {dayChangePct !== undefined && (
                    <span className={`text-[10px] font-black ${dayChangePct >= 0 ? 'text-emerald-700' : 'text-rose-700'}`} id="cmp-price-percentage" title="Change vs previous close">
                      ({dayChangePct >= 0 ? '+' : ''}{dayChangePct.toFixed(2)}%)
                    </span>
                  )}
                  {/* Which feed the shown price came from — only when it's the real fetched CMP
                      (not a manual override or an avg-cost fallback). */}
                  <SourceBadge source={customCmp === null && realDetailCmp !== undefined ? getCmpSource(isin, name) : undefined} />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Dynamic Dual-Container Grid Stats Card cluster */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" id="stock-detail-stats-grid">
          
          {/* Container 1: Position details */}
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 grid grid-cols-3 gap-y-4 divide-x divide-slate-200 relative" id="holding-metrics-panel">
            <div className="absolute top-3 left-3 bg-indigo-50/70 border border-indigo-100 text-indigo-800 text-[8px] font-black tracking-widest uppercase px-1.5 py-0.5 rounded">
              Position size
            </div>
            
            <div className="pl-0 pr-4 pt-4 space-y-4">
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider block">Holding Qty.</span>
                <div className="flex items-center gap-1 flex-wrap">
                  <span className={`text-base font-black font-mono ${detailDiscrepancy ? 'text-rose-600' : 'text-slate-800'}`} id="detail-holding-qty">
                    {formatNum(finalHoldingQty)}
                  </span>
                  {detailDiscrepancy && (
                    <span
                      className="bg-rose-50 border border-rose-200 text-rose-700 font-bold text-[9px] px-1.5 py-0.5 rounded flex items-center gap-0.5"
                      title="Impossible negative quantity — more shares sold than were ever held. Cost, market value, gain and XIRR are withheld until the ledger is corrected."
                    >
                      <AlertTriangle className="w-2.5 h-2.5" /> Discrepancy
                    </span>
                  )}
                  {hasTransactions && !detailDiscrepancy && (
                    <span className="bg-sky-50 border border-sky-100 text-sky-700 font-bold text-[9px] px-1.5 py-0.5 rounded flex items-center gap-0.5" title="Long-term shares — lots held more than 12 months (listed-equity LTCG threshold)">
                      <ShieldCheck className="w-2.5 h-2.5" /> LT {formatNum(longTermQty)}
                    </span>
                  )}
                </div>
              </div>
              <div className="space-y-1 border-t border-slate-100 pt-3">
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider block">Total Holding Value</span>
                <span className="text-sm font-black font-mono text-slate-800 block truncate" id="detail-total-value">
                  {formatINR(totalHoldingValue)}
                </span>
              </div>
            </div>

            <div className="pl-5 pr-4 pt-4 space-y-4">
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider block">Avg. Buy Price</span>
                <span className="text-base font-black font-mono text-slate-800 block truncate" id="detail-avg-price">
                  {formatINR(displayAvgBuyPrice)}
                </span>
              </div>
              <div className="space-y-1 border-t border-slate-100 pt-3">
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider block">Total Buy Amount</span>
                <span className="text-sm font-black font-mono text-slate-800 block truncate" id="detail-total-buys">
                  {formatINR(totalBuyAmount || finalInvestedValue)}
                </span>
              </div>
            </div>

            <div className="pl-5 pt-4 space-y-4">
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider block">Invested Value</span>
                <span className="text-base font-black font-mono text-slate-800 block truncate" id="detail-invested-value">
                  {formatINR(displayInvestedValue)}
                </span>
              </div>
              <div className="space-y-1 border-t border-slate-100 pt-3">
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider block">Total Sell Amount</span>
                <span className="text-sm font-black font-mono text-slate-800 block truncate" id="detail-total-sells">
                  {formatINR(totalSellAmount)}
                </span>
              </div>
            </div>
          </div>

          {/* Container 2: Returns details */}
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 grid grid-cols-3 gap-y-4 divide-x divide-slate-200 relative" id="returns-metrics-panel">
            <div className="absolute top-3 left-3 bg-emerald-50/70 border border-emerald-100 text-emerald-800 text-[8px] font-black tracking-widest uppercase px-1.5 py-0.5 rounded">
              Performance & Yield
            </div>

            <div className="pl-0 pr-4 pt-4 space-y-3">
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider block">Total Gain</span>
                <span className={`text-base font-black font-mono block truncate ${totalGain >= 0 ? 'text-emerald-700' : 'text-rose-700'}`} id="detail-total-gain">
                  {totalGain >= 0 ? '+' : ''}{formatINR(totalGain)}
                </span>
              </div>
              <div className="space-y-1 border-t border-slate-100 pt-3">
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider block">Unrealised Gain</span>
                <span className={`text-sm font-black font-mono truncate block ${unrealizedGain >= 0 ? 'text-emerald-700' : 'text-rose-700'}`} id="detail-unrealized-gain">
                  {unrealizedGain >= 0 ? '+' : ''}{formatINR(unrealizedGain)}
                </span>
              </div>
            </div>

            <div className="pl-5 pr-4 pt-4 space-y-3">
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider block">XIRR</span>
                <span className="text-base font-black font-mono text-indigo-700 block truncate" id="detail-xirr-rate">
                  {xirrValue.toFixed(2)}%
                </span>
              </div>
              <div className="space-y-1 border-t border-slate-100 pt-3">
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider block">Realised Gain</span>
                <span className={`text-sm font-black font-mono truncate block ${realisedGain >= 0 ? 'text-emerald-700' : 'text-rose-700'}`} id="detail-realised-gain">
                  {realisedGain >= 0 ? '+' : ''}{formatINR(realisedGain)}
                </span>
              </div>
            </div>

            <div className="pl-5 pt-4 space-y-3">
              <div className="space-y-1">
                <span className="text-[10px] text-transparent select-none font-black uppercase block">_</span>
                {onOpenReport ? (
                  <button
                    onClick={() => onOpenReport({ portfolioId: activePortfolio === 'local' ? DEFAULT_PORTFOLIO_ID : activePortfolio, scripName: name, isin })}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-black uppercase tracking-wider rounded-lg transition-colors cursor-pointer shadow-sm"
                    title={`Open reports for ${name} in this account`}
                    id="detail-open-report"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" /> Report
                  </button>
                ) : (
                  <span className="text-sm font-black text-transparent select-none block">_</span>
                )}
              </div>
              <div className="space-y-1 border-t border-slate-100 pt-3">
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider block">Dividend</span>
                <span className="text-sm font-black font-mono text-slate-800 block truncate font-medium" id="detail-dividends">
                  {formatINR(totalDividend)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Nested Tabs Panel */}
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden" id="detail-granular-tabs-container">
          <div className="flex items-center border-b border-slate-200 bg-slate-50 px-4">
            <button
              onClick={() => setActiveDetailTab('trade_book')}
              className={`px-4 py-3 text-xs font-black tracking-tight border-b-2 cursor-pointer transition-all ${
                activeDetailTab === 'trade_book' 
                  ? 'border-indigo-600 text-indigo-700 font-bold' 
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
              id="tab-trade-book"
            >
              Trade Book
            </button>
            <button
              onClick={() => setActiveDetailTab('inventory')}
              className={`px-4 py-3 text-xs font-black tracking-tight border-b-2 cursor-pointer transition-all ${
                activeDetailTab === 'inventory' 
                  ? 'border-indigo-600 text-indigo-700 font-bold' 
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
              id="tab-inventory"
            >
              Inventory (Cost Lots)
            </button>
            <button
              onClick={() => setActiveDetailTab('realised_inventory')}
              className={`px-4 py-3 text-xs font-black tracking-tight border-b-2 cursor-pointer transition-all ${
                activeDetailTab === 'realised_inventory' 
                  ? 'border-indigo-600 text-indigo-700 font-bold' 
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
              id="tab-realised-inventory"
            >
              Realised Inventory
            </button>
            {activePortfolio !== 'local' && (
              <div className="ml-auto flex items-center gap-1.5 py-1.5">
                {/* Delete the checkbox-selected rows in one go (edit mode only). Deliberately
                    NOT folded into the Actions menu: it is destructive, its label carries the
                    count, and it exists only while rows are selected. Putting an irreversible
                    "Delete 3" one click further away makes the bar tidier, not safer. */}
                {editMode && selectedRows.size > 0 && (
                  <button
                    onClick={deleteSelectedEntries}
                    disabled={bulkDeleting}
                    title={`Delete the ${selectedRows.size} selected ${selectedRows.size === 1 ? 'entry' : 'entries'}`}
                    className="btn-press inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-wider rounded-md cursor-pointer border border-rose-300 bg-rose-600 text-white hover:bg-rose-500 disabled:opacity-50"
                  >
                    {bulkDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} Delete {selectedRows.size}
                  </button>
                )}

                {/* One control for the four things you can do to this stock's book. Three of
                    them are alike — they open a modal. "Edit Entry" is NOT: it is a MODE that
                    rewrites the Trade Book underneath you (row checkboxes, per-row EDIT, the
                    Delete N button above). So the trigger itself carries that state, going
                    indigo and reading "Editing" exactly as the old standalone button did —
                    otherwise the mode is invisible and there is no obvious way back out. */}
                <div ref={actionsMenuRef} className="relative">
                  <button
                    id="detail-actions"
                    ref={actionsBtnRef}
                    type="button"
                    onClick={() => setActionsOpen(o => !o)}
                    aria-haspopup="menu"
                    aria-expanded={actionsOpen}
                    title={editMode ? 'Editing the Trade Book inline — open for more actions' : `Actions for ${name}`}
                    className={`btn-press inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-wider rounded-md cursor-pointer border ${editMode ? 'bg-indigo-600 border-indigo-600 text-white hover:bg-indigo-500' : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300'}`}
                  >
                    {editMode ? <Edit2 className="w-3 h-3" /> : <MoreHorizontal className="w-3 h-3" />}
                    {editMode ? 'Editing' : 'Actions'}
                    <ChevronDown className={`w-3 h-3 transition-transform ${actionsOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {/* PORTALLED to <body> on purpose. The panel's ancestor
                      #detail-granular-tabs-container is `overflow-hidden` for its rounded
                      corners, which clips absolutely-positioned children no matter what
                      z-index they carry - on a stock with an empty ledger there is only
                      ~214px below the tab bar and the last entry would be cut off. A portal
                      also survives the other trap this file is full of: any ancestor that
                      grows a `transform` becomes the containing block, which would break
                      plain `position: fixed` too. overlay.tsx portals for the same reason. */}
                  {actionsOpen && actionsPos && createPortal((
                    <div
                      ref={actionsPanelRef}
                      role="menu"
                      style={{ position: 'fixed', top: actionsPos.top, right: actionsPos.right }}
                      className="w-72 max-h-[70vh] overflow-y-auto z-50 rounded-xl bg-white border border-slate-200 shadow-lg animate-fadeIn text-left"
                    >
                      {[
                        {
                          id: 'detail-add-trade', Icon: Plus, label: 'Add Trade',
                          hint: 'Record a buy, sell or corporate action — the company is pre-filled',
                          pressed: false,
                          run: () => setShowAddTrade(true),
                        },
                        {
                          id: 'detail-edit-trade', Icon: Edit2,
                          label: editMode ? 'Stop Editing' : 'Edit Entry',
                          hint: editMode
                            ? 'Leave inline editing and clear the row selection'
                            : 'Edit or delete Trade Book rows in place',
                          pressed: editMode,
                          // Verbatim from the old button, side effects and all — relocating a
                          // control is not the moment to change what it does.
                          run: () => setEditMode(m => { const next = !m; if (next) setActiveDetailTab('trade_book'); else { setEditingTx(null); setSelectedRows(new Set()); } return next; }),
                        },
                        {
                          id: 'detail-import-opening', Icon: Upload, label: 'Import',
                          hint: `Rebuild ${name}'s opening basis from a CSV of trades through 31-Mar-2025`,
                          pressed: false,
                          run: () => setShowOpeningImport(true),
                        },
                        {
                          id: 'detail-transfer', Icon: ArrowRightLeft, label: 'Transfer',
                          hint: 'Move shares to another account FIFO, carrying the cost basis and purchase dates',
                          pressed: false,
                          run: () => setShowTransfer(true),
                        },
                      ].map(({ id, Icon, label, hint, pressed, run }) => (
                        <button
                          key={id}
                          id={id}
                          type="button"
                          role="menuitem"
                          aria-pressed={pressed}
                          onClick={() => { setActionsOpen(false); run(); }}
                          className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left border-b border-slate-100 last:border-b-0 cursor-pointer transition-colors ${pressed ? 'bg-indigo-50' : 'hover:bg-indigo-50'}`}
                        >
                          <Icon className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
                          <span className="min-w-0">
                            <span className="block text-xs font-black text-slate-800">{label}</span>
                            <span className="block text-[10px] font-semibold text-slate-500 leading-snug mt-0.5">{hint}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ), document.body)}
                </div>
              </div>
            )}
          </div>

          <div className="p-4 bg-slate-50/50 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="relative max-w-xs w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input
                type="text"
                placeholder="Search ledger details..."
                value={txSearchTerm}
                onChange={(e) => setTxSearchTerm(e.target.value)}
                className="w-full pl-9 pr-8 py-1.5 border border-slate-200 rounded-lg outline-none text-xs bg-white focus:ring-1 focus:ring-indigo-500 font-medium"
                id="tab-search-input"
              />
              {txSearchTerm && (
                <button type="button" onClick={() => setTxSearchTerm('')} aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 rounded cursor-pointer">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <div className="shrink-0">
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider block">
                Record Count: {
                  activeDetailTab === 'trade_book' ? filteredTxs.length :
                  activeDetailTab === 'inventory' ? filteredInventory.length : realisedTrades.length
                }
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            {isLoadingTransactions ? (
              <div className="py-24 flex flex-col items-center justify-center gap-3" id="transactions-loading-spinner">
                <CubeLoader className="w-16" />
                <span className="text-xs text-slate-500 font-bold uppercase tracking-wider select-none animate-pulse">Syncing ledger records live...</span>
              </div>
            ) : (
              <>
                {activeDetailTab === 'trade_book' && (
                  <table className="w-full text-xs text-left" id="trade-book-table">
                    <thead className="bg-[#f8fafc] border-b border-slate-200 font-bold text-slate-600 uppercase tracking-wider">
                      <tr>
                        {editMode && (
                          <th className="px-3 py-3 text-center w-8">
                            {(() => {
                              const keys = sortedTxs.filter(t => t.editSource && t.sheetRow != null).map(t => `${t.editSource}:${t.sheetRow}`);
                              const allSel = keys.length > 0 && keys.every(k => selectedRows.has(k));
                              return (
                                <input type="checkbox" aria-label="Select all rows" checked={allSel} disabled={keys.length === 0}
                                  onChange={() => setSelectedRows(allSel ? new Set() : new Set(keys))}
                                  className="cursor-pointer accent-indigo-600 align-middle" />
                              );
                            })()}
                          </th>
                        )}
                        {sortTh('DATE', 'tradeDate')}
                        {sortTh('TRANSACTION TYPE', 'transactionType')}
                        {sortTh('QUANTITY', 'quantity', 'right')}
                        {sortTh('PRICE', 'price', 'right')}
                        {sortTh('AMOUNT', 'amount', 'right')}
                        {sortTh('BAL QTY', 'balanceQuantity', 'right')}
                        {editMode && <th className="px-6 py-3 text-center">EDIT</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {sortedTxs.length === 0 ? (
                        <tr>
                          <td colSpan={editMode ? 8 : 6} className="px-6 py-12 text-center text-slate-400 italic font-medium">
                            No matching ledger line items found.
                          </td>
                        </tr>
                      ) : (
                        sortedTxs.map((t, idx) => {
                          const type = t.transactionType.toUpperCase();
                          const side = ledgerSide(t.transactionType);
                          // Corporate actions get their own badge. /MERGER/ catches "Demerger In/Out" too.
                          const isCorp = /BONUS|SPLIT|IPO|RIGHT|MERGER/.test(type);
                          const isSell = side === "SELL";
                          const isBuy = side === "BUY" && !isCorp;
                          const isDiv = type.includes("DIVIDEND");
                          const editable = !!t.editSource && activePortfolio !== 'local';
                          const isOpening = t.editSource === 'opening';
                          const isEditingThis = editMode && editingTx != null && t.sheetRow != null &&
                            editingTx.editSource === t.editSource && editingTx.sheetRow === t.sheetRow;
                          const justSaved = !isEditingThis && justSavedRow != null && t.sheetRow != null &&
                            justSavedRow.editSource === t.editSource && justSavedRow.sheetRow === t.sheetRow;
                          const rowSelected = selectedRows.has(`${t.editSource}:${t.sheetRow}`);
                          // Once anything is ticked we're in "selection mode": a row click toggles the
                          // tick instead of opening the single-entry editor.
                          const selecting = selectedRows.size > 0;

                          // Inline-edit input styling + a setter that keeps turnover = qty × price in sync.
                          const inCls = "w-full px-1.5 py-1 text-xs border border-indigo-200 rounded-md font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white";
                          // Quantity / Price / Turnover are linked — type any two, the third follows.
                          const setF = (k: string, v: string) => setEditForm(p => {
                            const next: Record<string, string> = { ...p, [k]: v };
                            const fld = k === 'quantity' ? 'qty' : k === 'turnover' ? 'amount' : k === 'price' ? 'price' : '';
                            if (fld) {
                              const s = solveQtyPriceAmount(fld as 'qty' | 'price' | 'amount', next.quantity ?? '', next.price ?? '', next.turnover ?? '');
                              next.quantity = s.qty; next.price = s.price; next.turnover = s.amount;
                            }
                            return next;
                          });

                          if (isEditingThis) {
                            return (
                              <tr key={idx} className="bg-indigo-50/40">
                                {editMode && <td className="px-3 py-2" />}
                                <td className="px-3 py-2">
                                  <input value={editForm.tradeDate ?? ''} onChange={e => setF('tradeDate', e.target.value)} className={inCls} />
                                </td>
                                <td className="px-3 py-2">
                                  {isOpening
                                    ? <span className="text-[10px] font-bold uppercase text-violet-700">Opening Buy</span>
                                    : <input value={editForm.transactionType ?? ''} onChange={e => setF('transactionType', e.target.value)} className={inCls} />}
                                </td>
                                <td className="px-3 py-2">
                                  <input type="number" step="any" value={editForm.quantity ?? ''} onChange={e => setF('quantity', e.target.value)} className={`${inCls} text-right`} />
                                </td>
                                <td className="px-3 py-2">
                                  <input type="number" step="any" value={editForm.price ?? ''} onChange={e => setF('price', e.target.value)} className={`${inCls} text-right`} />
                                </td>
                                <td className="px-3 py-2">
                                  <input type="number" step="any" value={editForm.turnover ?? ''} onChange={e => setF('turnover', e.target.value)}
                                    title="Amount (turnover) — fill any two of Quantity / Price / Amount and the third is worked out."
                                    className={`${inCls} text-right`} />
                                </td>
                                <td className="px-3 py-2 text-right text-slate-300">—</td>
                                <td className="px-3 py-2">
                                  <div className="flex items-center justify-center gap-1">
                                    <button onClick={saveEdit} disabled={savingEdit || deletingEdit} title="Save & recompute"
                                      className="btn-press p-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer disabled:opacity-50">
                                      {savingEdit ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                                    </button>
                                    <button onClick={() => setEditingTx(null)} disabled={savingEdit || deletingEdit} title="Cancel"
                                      className="btn-press p-1.5 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-100 cursor-pointer disabled:opacity-50">
                                      <X className="w-3.5 h-3.5" />
                                    </button>
                                    <button onClick={deleteEntry} disabled={savingEdit || deletingEdit} title="Delete entry"
                                      className="btn-press p-1.5 rounded-md border border-rose-200 text-rose-600 hover:bg-rose-50 cursor-pointer disabled:opacity-50">
                                      {deletingEdit ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          }

                          return (
                            <tr key={idx}
                              onClick={editMode
                                ? (editable ? () => { selecting ? toggleRowSel(t) : openEdit(t); } : undefined)
                                : () => setExpenseTx(t)}
                              title={editMode ? (selecting ? 'Click to select / deselect this row' : undefined) : 'View expense breakdown'}
                              // Rose tint from the row where the running balance first goes
                              // negative onward — the eye lands straight on where the ledger broke,
                              // instead of having to scan the Bal Qty column for a minus sign.
                              className={`transition-colors ${justSaved ? 'row-flash-save' : ''} ${rowSelected ? 'bg-indigo-50/60' : (t.balanceQuantity !== undefined && t.balanceQuantity < -1e-9 ? 'row-neg-bal' : '')} ${(editMode && editable) || !editMode ? 'cursor-pointer hover:bg-indigo-50/40' : 'hover:bg-slate-50/50'}`}>
                              {editMode && (
                                // The whole cell is the hit target — clicking just beside the box used to
                                // fall through to the row and open the single-entry editor.
                                <td className={`px-3 py-3.5 text-center ${editable ? 'cursor-pointer' : ''}`}
                                  onClick={e => { e.stopPropagation(); if (editable) toggleRowSel(t); }}>
                                  {editable ? (
                                    <input
                                      type="checkbox"
                                      aria-label="Select row for deletion"
                                      className="pointer-events-none accent-indigo-600 align-middle"
                                      checked={rowSelected}
                                      readOnly
                                    />
                                  ) : null}
                                </td>
                              )}
                              <td className="px-6 py-3.5 font-medium text-slate-600">{formatDMY(t.tradeDate)}</td>
                              <td className="px-6 py-3.5">
                                <span className={`inline-block px-2.5 py-0.5 rounded-[6px] text-[10px] font-black border tracking-wider select-none ${
                                  isBuy ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                                  isSell ? 'bg-rose-50 text-rose-800 border-rose-200' :
                                  isCorp ? 'bg-violet-50 text-violet-800 border-violet-200' :
                                  isDiv ? 'bg-amber-50 text-amber-800 border-amber-200' :
                                  'bg-slate-50 text-slate-800 border-slate-200'
                                }`}>
                                  {t.transactionType}
                                </span>
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono font-bold text-slate-700">
                                {/* A demerger leaves the parent's share count alone — it only moves cost;
                                    an opening memo carries a ratio, not a quantity. */}
                                {t.openingAction || (t.corpAction && t.corpAction.role === 'out') ? '—'
                                  : isDiv ? '0' : formatNum(t.quantity)}
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono text-slate-500">
                                {isDiv || (t.corpAction && t.corpAction.role === 'out') ? '—'
                                  : t.openingAction ? (t.price > 0 ? formatINR(t.price) : '—')
                                  : formatINR(t.price)}
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono font-bold text-slate-800">
                                {t.openingAction ? '—' : formatINR(t.amount)}
                              </td>
                              <td className={`px-6 py-3.5 text-right font-mono ${t.balanceQuantity !== undefined && t.balanceQuantity < -1e-9 ? 'text-rose-600 font-bold' : 'text-slate-500'}`}
                                title={t.balanceQuantity !== undefined && t.balanceQuantity < -1e-9 ? 'Negative balance — more shares sold than held at this point in the ledger' : undefined}>
                                {t.balanceQuantity !== undefined ? formatNum(t.balanceQuantity) : '—'}
                              </td>
                              {editMode && (
                                <td className="px-6 py-3.5 text-center">
                                  {t.corpAction?.rowIndex != null ? (
                                    // Corp actions aren't True Entry rows, so they have no
                                    // editSource/sheetRow and never satisfied `editable` — they
                                    // get their own popup, keyed on the Corporate Actions row.
                                    <button
                                      onClick={(e) => { e.stopPropagation(); openCorpActionEdit(t); }}
                                      title={`Edit this ${t.corpAction.type || 'corporate action'} — amount, shares and date`}
                                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-amber-700 hover:text-white hover:bg-amber-600 border border-amber-300 hover:border-amber-600 rounded-md transition-colors cursor-pointer"
                                    >
                                      <Edit2 className="w-3 h-3" /> Edit
                                    </button>
                                  ) : editable ? (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); openEdit(t); }}
                                      title="Edit this entry inline"
                                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-indigo-600 hover:text-white hover:bg-indigo-600 border border-indigo-200 hover:border-indigo-600 rounded-md transition-colors cursor-pointer"
                                    >
                                      <Edit2 className="w-3 h-3" /> Edit
                                    </button>
                                  ) : (
                                    <span className="text-slate-300">—</span>
                                  )}
                                </td>
                              )}
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                )}

                {activeDetailTab === 'inventory' && (
                  <table className="w-full text-xs text-left" id="inventory-cost-lots-table">
                    <thead className="bg-[#f8fafc] border-b border-slate-200 font-bold text-slate-600 uppercase tracking-wider">
                      <tr>
                        <th className="px-6 py-3">LOT PURCHASE DATE</th>
                        <th className="px-6 py-3">TERM</th>
                        <th className="px-6 py-3 text-right">QUANTITY HELD</th>
                        <th className="px-6 py-3 text-right">PURCHASE PRICE</th>
                        <th className="px-6 py-3 text-right">ORIGINAL COST</th>
                        <th className="px-6 py-3 text-right">CURRENT VALUE</th>
                        <th className="px-6 py-3 text-right">UNREALIZED PROFIT/LOSS</th>
                        <th className="px-6 py-3 text-right">LOT AGE (DAYS)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {filteredInventory.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-6 py-12 text-center text-slate-400 italic font-medium">
                            No active holding cost lots computed. All quantities fully liquidated.
                          </td>
                        </tr>
                      ) : (
                        filteredInventory.map((lot, idx) => {
                          const buyTime = parseDateStr(lot.date);
                          const ageDays = buyTime > 0 ? Math.floor((Date.now() - buyTime) / (1000 * 60 * 60 * 24)) : 0;

                          const lotCost = lot.remainingQty * lot.price;
                          const lotValue = lot.remainingQty * cmpPrice;
                          const lotGain = lotValue - lotCost;
                          const isPos = lotGain >= 0;
                          // Opening lots carry their own long-term flag from the reconstruction;
                          // regular FY26 lots turn long-term at the security's own threshold —
                          // 365 days listed, 730 for an unlisted company (see ltDays).
                          // An undecided rule shows as neither long nor short: the lot is real,
                          // its classification is not ours to invent.
                          const isLong = lot.isOpening ? !!lot.longTerm : (ltKnown && ageDays > ltDays!);

                          return (
                            <tr key={idx} className="hover:bg-slate-50/50 transition-colors">
                              <td className="px-6 py-3.5 font-medium text-slate-600">
                                {formatDMY(lot.date)}
                                {lot.isOpening && (
                                  <span className="ml-2 inline-block px-2 py-0.5 rounded-[6px] text-[9px] font-black tracking-wider select-none bg-indigo-50 text-indigo-700 border border-indigo-200 align-middle">
                                    OPENING
                                  </span>
                                )}
                              </td>
                              <td className="px-6 py-3.5">
                                <span className={`inline-block px-2.5 py-0.5 rounded-[6px] text-[10px] font-black border tracking-wider select-none ${
                                  isLong ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-amber-50 text-amber-800 border-amber-200'
                                }`}>
                                  {isLong ? 'LONG TERM' : 'SHORT TERM'}
                                </span>
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono font-bold text-slate-700">
                                {formatNum(lot.remainingQty)} <span className="text-[10px] text-slate-400 font-normal">/ {formatNum(lot.quantity)}</span>
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono text-slate-500">
                                {formatINR(lot.price)}
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono text-slate-700">
                                {formatINR(lotCost)}
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono font-bold text-slate-800">
                                {formatINR(lotValue)}
                              </td>
                              <td className={`px-6 py-3.5 text-right font-mono font-black ${isPos ? 'text-emerald-700' : 'text-rose-700'}`}>
                                {isPos ? '+' : ''}{formatINR(lotGain)}
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono text-slate-500">
                                {ageDays > 365 ? `${(ageDays/365).toFixed(1)}y` : `${ageDays} d`}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                )}

                {activeDetailTab === 'realised_inventory' && (
                  <table className="w-full text-xs text-left" id="realised-inventory-table">
                    <thead className="bg-[#f8fafc] border-b border-slate-200 font-bold text-slate-600 uppercase tracking-wider">
                      <tr>
                        <th className="px-6 py-3">SELL DATE</th>
                        <th className="px-6 py-3">MATCHED BUY DATE</th>
                        <th className="px-6 py-3 text-right">QUANTITY SOLD</th>
                        <th className="px-6 py-3 text-right">AVG BUY PRICE</th>
                        <th className="px-6 py-3 text-right">SELLING PRICE</th>
                        <th className="px-6 py-3 text-right">REALISED GAIN/LOSS</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {realisedTrades.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-6 py-12 text-center text-slate-400 italic font-medium">
                            No finished/realised trades computed for sell history.
                          </td>
                        </tr>
                      ) : (
                        realisedTrades.map((r, idx) => {
                          const isPos = r.gain >= 0;
                          return (
                            <tr key={idx} className="hover:bg-slate-50/50 transition-colors">
                              <td className="px-6 py-3.5 font-medium text-slate-600">{formatDMY(r.sellDate)}</td>
                              <td className="px-6 py-3.5 text-slate-500 font-medium">{formatDMY(r.buyDate)}</td>
                              <td className="px-6 py-3.5 text-right font-mono font-bold text-slate-700">{formatNum(r.qtySold)}</td>
                              <td className="px-6 py-3.5 text-right font-mono text-slate-500">{formatINR(r.buyPrice)}</td>
                              <td className="px-6 py-3.5 text-right font-mono font-bold text-slate-700">{formatINR(r.sellPrice)}</td>
                              <td className={`px-6 py-3.5 text-right font-mono font-black ${isPos ? 'text-emerald-700' : 'text-rose-700'}`}>
                                {isPos ? '+' : ''}{formatINR(r.gain)}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </div>
        </div>
        {editEntryModal}
        {expenseModal}
        {corpActionEditModal}
        {/* Transfer dialog. Mounted HERE because `activeInventory` — this scrip's surviving
            FIFO lots, oldest first — only exists inside the detail render. */}
        {activePortfolio !== 'local' && (
          <TransferHoldingModal
            open={showTransfer}
            onClose={() => setShowTransfer(false)}
            fromPortfolioId={activePortfolio}
            securityName={name}
            isin={displayIsin || isin}
            lots={activeInventory
              .filter((l) => l.remainingQty > 1e-9)
              .map((l) => ({
                acquiredDMY: formatDMY(l.date),
                remaining: l.remainingQty,
                purPrice: l.price,
                inclPrice: l.inclPrice,
              }))}
            onDone={() => {
              // Same refresh path Add Trade uses: reload the portfolio's holdings and this
              // scrip's trade book, so the moved lots disappear from the view immediately.
              setShowTransfer(false);
              fetchSheetHoldings(activePortfolio, true);
              if (lastTxFetch) fetchTransactionsForStock(lastTxFetch.companyName, lastTxFetch.isin);
            }}
          />
        )}
        {/* Add Trade drawer, pre-filled with THIS security. Mounted here too because the
            detail view early-returns before the main return's copy would render. */}
        <AddTradeModal
          open={showAddTrade}
          onClose={() => setShowAddTrade(false)}
          defaultPortfolio={activePortfolio === 'local' ? DEFAULT_PORTFOLIO_ID : activePortfolio}
          master={scrip}
          holdings={sheetHoldings.map(h => ({ name: h.companyName, isin: h.isin, qty: h.quantity }))}
          prefill={{ company: name, isin: displayIsin || isin }}
          onSaved={(pid) => {
            if (pid !== activePortfolio) return;
            fetchSheetHoldings(pid, true);
            if (lastTxFetch) fetchTransactionsForStock(lastTxFetch.companyName, lastTxFetch.isin);
          }}
        />
        {/* Temporary per-stock opening-basis import (Google portfolios only). */}
        {activePortfolio !== 'local' && (
          <StockOpeningImportModal
            open={showOpeningImport}
            onClose={() => setShowOpeningImport(false)}
            spreadsheetId={sheetIdForId(activePortfolio)}
            stockName={name}
            isin={displayIsin || isin}
            accountLabel={portfolioById(activePortfolio)?.label}
            onDone={() => {
              fetchSheetHoldings(activePortfolio, true);
              if (lastTxFetch) fetchTransactionsForStock(lastTxFetch.companyName, lastTxFetch.isin);
            }}
          />
        )}
      </div>
    );
  };

  const getPortfolioSummary = (id: string) => {
    if (id !== 'local') {
      // Every configured portfolio shows real numbers only — no demo placeholders.
      const p = portfolioById(id);
      const name = p?.label ?? id.toUpperCase();
      const subtext = p ? `${p.label} - ${p.code}` : id;

      // For the portfolio that's currently OPEN, the live rows (displayHoldings)
      // already value each position at the imported screener CMP — so the summary
      // cards must sum THOSE, otherwise they read current = invested with 0 gain
      // even though every row shows a gain. (portfolioTotals[id] is built as the
      // sum of the same rows' investedValue, so Invested Capital is unchanged.)
      if (id === activePortfolio && sheetHoldings.length > 0) {
        let currentValue = 0, investedValue = 0, todaysGain = 0;
        for (const h of displayHoldings) {
          if (h.sold || h.quantity <= 0) continue;
          currentValue += h.currentValue;
          investedValue += (h.original?.investedValue ?? h.quantity * h.avgCost);
          todaysGain += h.todayGain || 0;
        }
        const unrealisedGain = currentValue - investedValue;
        const unrealisedGainPct = investedValue > 0 ? (unrealisedGain / investedValue) * 100 : 0;
        // Today's gain = Σ qty × (CMP − previous-day price). Stays 0 until a previous-day
        // baseline exists (first import on a later day). % is vs the previous-day value.
        const prevValue = currentValue - todaysGain;
        const todaysGainPct = prevValue > 0 ? (todaysGain / prevValue) * 100 : 0;
        return { name, subtext, currentValue, investedValue, unrealisedGain, unrealisedGainPct, todaysGain, todaysGainPct };
      }

      // Any other portfolio (the account-list cards): value its prefetched Holding rows at the
      // live CMP, exactly like the open portfolio. Previously these returned current = invested
      // with a hard-coded 0 gain, so every card read "+0.00%" no matter how prices moved.
      const rows = portfolioRows[id];
      if (rows && rows.length > 0) {
        let currentValue = 0, investedValue = 0, todaysGain = 0;
        for (const r of rows) {
          if (!(r.qty > 0)) continue;                 // negative qty = a ledger error; never valued (matches the holdings list)
          investedValue += r.invested;
          const cmp = getRealCmp(r.isin, r.name, r.lastPx);
          const avg = r.qty > 0 ? r.invested / r.qty : 0;
          const px = (cmp !== undefined && cmp > 0) ? cmp : avg;   // no price yet → hold at cost
          currentValue += r.qty * px;
          const prev = getRealPrevCmp(r.isin, r.name);
          if (cmp !== undefined && cmp > 0 && prev !== undefined && prev > 0) todaysGain += r.qty * (cmp - prev);
        }
        const unrealisedGain = currentValue - investedValue;
        const unrealisedGainPct = investedValue > 0 ? (unrealisedGain / investedValue) * 100 : 0;
        const prevValue = currentValue - todaysGain;
        const todaysGainPct = prevValue > 0 ? (todaysGain / prevValue) * 100 : 0;
        return { name, subtext, currentValue, investedValue, unrealisedGain, unrealisedGainPct, todaysGain, todaysGainPct };
      }

      // Not prefetched yet (no token / still loading) → show the cost basis, no invented gain.
      const invested = portfolioTotals[id] ?? 0;
      return {
        name, subtext,
        currentValue: invested,
        investedValue: invested,
        unrealisedGain: 0,
        unrealisedGainPct: 0,
        todaysGain: 0,
        todaysGainPct: 0,
      };
    } else {
      const localInvested = holdings.reduce((sum, h) => sum + (h.quantity * h.avgCost), 0);
      const localCurrent = holdings.reduce((sum, h) => sum + (h.quantity * h.currentPrice), 0);
      const localGain = localCurrent - localInvested;
      const localGainPct = localInvested > 0 ? (localGain / localInvested) * 100 : 0;
      const localToday = localCurrent * 0.0125;
      const localTodayPct = 1.25;

      return {
        name: "Local Sandbox Portfolio",
        subtext: "Local Sandbox & Mock Entries",
        currentValue: localInvested > 0 ? localCurrent : 1250000.00,
        investedValue: localInvested > 0 ? localInvested : 1180000.00,
        unrealisedGain: localInvested > 0 ? localGain : 70000.00,
        unrealisedGainPct: localInvested > 0 ? localGainPct : 5.93,
        todaysGain: localInvested > 0 ? localToday : 12400.00,
        todaysGainPct: localInvested > 0 ? localTodayPct : 1.05
      };
    }
  };

   // Switch views when drawing granular stocks details
  if (selectedStock) {
    return renderStockDetailView();
  }

  return (
    <div className="space-y-6">
      {showScripModal && scripReview && (
        <ScripReviewModal
          spreadsheetId={SCRIP_MASTER_SPREADSHEET_ID}
          master={scripReview.master}
          unresolved={scripReview.unresolved}
          onClose={() => setShowScripModal(false)}
          onSaved={async () => {
            const pid = scripReview?.pid || (activePortfolio === 'local' ? DEFAULT_PORTFOLIO_ID : activePortfolio);
            setShowScripModal(false);
            setScripReview(null);
            // Re-run both calcs so the now-linked scrips merge correctly
            await rebuildHolding(pid);
            await syncCapitalGainsToSheet(pid);
          }}
        />
      )}
      <AddTradeModal
        open={showAddTrade}
        onClose={() => setShowAddTrade(false)}
        defaultPortfolio={activePortfolio === 'local' ? DEFAULT_PORTFOLIO_ID : activePortfolio}
        master={scrip}
        // Recording from the "Private Equity" segment means an unlisted trade. Only scopes the
        // drawer's form - the saved row is still classified from the scrip master.
        scope={assetClass === 'pe' ? 'pe' : undefined}
        holdings={sheetHoldings.map(h => ({ name: h.companyName, isin: h.isin, qty: h.quantity }))}
        onSaved={(pid) => { if (pid === activePortfolio) fetchSheetHoldings(pid, true); }}
      />

      {editEntryModal}
      {expenseModal}
      {corpActionEditModal}
      {/* Rendered whether or not a timestamp exists. Gating it on `lastPriceUpdate` would mean a
          sheet whose prices have NEVER been fetched shows no control at all - the affordance
          appearing only once its own precondition is met, which is unreachable by definition. */}
      {activePortfolio !== 'local' && (
        <div className="flex justify-end">
          {/* The timestamp IS the refresh control - the separate "Refresh Prices" button is gone.
              Same text, same size, same colours: a <button> reset to inherit so nothing about the
              line changes until it is hovered or running. While running it says so in place,
              because the only feedback a text control can give is its own label. */}
          <button
            onClick={handleRefreshPrices}
            disabled={refreshingPrices}
            aria-busy={refreshingPrices}
            title="Fetch the latest market prices from Yahoo Finance and re-value holdings"
            className="text-[11px] text-slate-400 bg-transparent border-0 p-0 hover:text-indigo-600 disabled:cursor-wait cursor-pointer transition-colors"
          >
            {refreshingPrices ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" /> Updating prices…
              </span>
            ) : lastPriceUpdate ? (
              <>CMP last updated: <span className="font-semibold text-slate-500">{formatDMYTime(lastPriceUpdate)}</span> IST</>
            ) : (
              <>Update prices</>
            )}
          </button>
        </div>
      )}
      {!isDetailView ? (
        // Freestanding portfolio cards on the page ground — no wrapping panel/header.
        <div id="portfolio-selection-panel" className="grid grid-cols-1 lg:grid-cols-2 gap-4 animate-fadeIn">
            {(() => {
              // Access is granted on the Google Sheet, not in the app, so the only useful
              // thing to say is which sheets are missing and who can grant them.
              const blocked = PORTFOLIOS.filter(p => portfolioAccess[p.id]);
              if (blocked.length === 0) return null;
              return (
                <div className="lg:col-span-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
                  <p className="flex items-center gap-2 text-[13px] font-bold text-amber-900">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    {blocked.length} of {PORTFOLIOS.length} portfolios aren't shared with your account
                  </p>
                  <p className="mt-1 text-[12px] text-amber-800">
                    {blocked.map(p => p.code).join(', ')} — these show no data because Google is
                    refusing the read, not because the books are empty. Ask for access to the
                    <strong> backoffice</strong> Drive folder; nothing in the app can grant it.
                  </p>
                </div>
              );
            })()}
            {PORTFOLIOS.map((p) => {
              const id = p.id;
              const summary = getPortfolioSummary(id);
              const noAccess = portfolioAccess[id];
              const isPositiveGain = summary.unrealisedGain >= 0;
              const isPositiveToday = summary.todaysGain >= 0;
              const cg = capGainsSyncStatus?.pid === id ? capGainsSyncStatus : null;
              const rb = holdingRebuildStatus?.pid === id ? holdingRebuildStatus : null;
              const trx = trxStatus?.pid === id ? trxStatus : null;
              const anyBusy = isLoadingSheet || isSyncingCapGains || isRebuildingHolding || isGeneratingTrx || !!downloadingFor;
              const stop = (e: React.MouseEvent) => e.stopPropagation();
              return (
                <div
                  key={id}
                  onClick={() => { setActivePortfolio(id); setSelectedStock(null); setIsDetailView(true); }}
                  className="group rounded-2xl border border-slate-200 bg-white shadow-sm hover:border-indigo-300 hover:shadow-md transition-all cursor-pointer overflow-hidden flex flex-col"
                >
                  {/* Header: code + name + sheet link */}
                  <div className="flex items-center justify-between gap-2 px-3.5 pt-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 text-[10px] font-black font-mono tracking-wider shrink-0 group-hover:bg-indigo-50 group-hover:text-indigo-700 transition-colors">{p.code}</span>
                      <h3 className="font-bold text-slate-900 group-hover:text-indigo-600 transition-colors text-sm truncate">{summary.name}</h3>
                    </div>
                    <a
                      href={portfolioSheetUrl(id)} target="_blank" rel="noopener noreferrer" onClick={stop}
                      title="Open this portfolio's Google Sheet in a new tab"
                      className="text-slate-400 hover:text-indigo-600 shrink-0"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>

                  {/* Metrics — compact */}
                  <div className="px-3.5 pt-2 pb-1">
                    <div className="flex items-baseline justify-between gap-2">
                      {noAccess ? (
                        <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-amber-700">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {sheetsAccessLabel(noAccess)}
                        </span>
                      ) : (
                        <>
                          <span className="font-mono font-black text-slate-900 text-base">{formatValueOnly(summary.currentValue)}</span>
                          <span className={`text-xs font-bold ${isPositiveGain ? 'text-emerald-700' : 'text-rose-600'}`}>
                            {isPositiveGain ? '▲' : '▼'} {isPositiveGain ? '+' : ''}{summary.unrealisedGainPct.toFixed(2)}%
                          </span>
                        </>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 mt-0.5">
                      <span>Inv <span className="font-mono text-slate-600">{formatValueOnly(summary.investedValue)}</span></span>
                      <span className={isPositiveToday ? 'text-emerald-600' : 'text-rose-500'}>Today {isPositiveToday ? '+' : ''}{summary.todaysGainPct.toFixed(2)}%</span>
                    </div>
                  </div>

                  {/* Action bar — compact icon buttons (labels in tooltips) */}
                  <div className="flex flex-wrap items-center gap-1.5 px-3.5 py-2.5 mt-auto bg-slate-50/60 border-t border-slate-100" onClick={stop}>
                    <button
                      onClick={() => syncFeed(id)} disabled={anyBusy}
                      aria-label="Sync holdings from sheet" title="Sync database feed (reload holdings from the sheet)"
                      className="p-1.5 bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 rounded-md transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isLoadingSheet && actionPid === id ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                      onClick={() => syncCapitalGainsToSheet(id)} disabled={anyBusy}
                      aria-label="Sync capital gains" title="Sync capital gains — FIFO STCG/LTCG from True Entry → LTST / PnL Summary tabs"
                      className="p-1.5 bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 rounded-md transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <TrendingUp className={`w-3.5 h-3.5 ${isSyncingCapGains && actionPid === id ? 'animate-pulse' : ''}`} />
                    </button>
                    <button
                      onClick={() => rebuildHolding(id)} disabled={anyBusy}
                      aria-label="Rebuild Holding tab" title="Rebuild Holding tab from every Buy/Sell in True Entry"
                      className="p-1.5 bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 rounded-md transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <Wallet className={`w-3.5 h-3.5 ${isRebuildingHolding && actionPid === id ? 'animate-pulse' : ''}`} />
                    </button>
                    <select
                      value={selectedFy}
                      onChange={(e) => setSelectedFy(Number(e.target.value))}
                      disabled={anyBusy}
                      aria-label="Financial year for the Capital Gains report"
                      title="Financial year for the Capital Gains report"
                      className="text-[10px] font-bold text-slate-700 bg-white border border-slate-200 rounded-md px-1 py-1 outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer disabled:opacity-50"
                    >
                      {fyOptions.map((y) => (
                        <option key={y} value={y}>{`FY${String(y).slice(2)}-${String(y + 1).slice(2)}`}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => generateTrx(id)} disabled={anyBusy}
                      aria-label="Generate Capital Gains" title="Generate the scrip-wise FY Capital Gains report (opening → purchases → sales → closing) + a 'Holding as on 31st March' snapshot tab"
                      className="p-1.5 bg-violet-50 border border-violet-200 text-violet-700 hover:bg-violet-100 rounded-md transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <FileSpreadsheet className={`w-3.5 h-3.5 ${isGeneratingTrx && actionPid === id ? 'animate-pulse' : ''}`} />
                    </button>
                    <button
                      onClick={() => downloadHoldingCsv(id)} disabled={anyBusy}
                      aria-label="Download Holding tab as CSV" title="Download the current Holding tab as CSV"
                      className="p-1.5 bg-slate-100 border border-slate-200 text-slate-700 hover:bg-slate-200 rounded-md transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <Download className={`w-3.5 h-3.5 ${downloadingFor === id ? 'animate-pulse' : ''}`} />
                    </button>
                    {cg && (cg.success ? (
                      <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-lg">
                        ✓ STCG ₹{(cg.stcg || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })} · LTCG ₹{(cg.ltcg || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-1 rounded-lg" title={cg.error}>✗ Capital gains failed</span>
                    ))}
                    {rb && (rb.result ? (
                      <>
                        <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-lg" title={`${rb.result.tradeRows} trades replayed`}>
                          ✓ {rb.result.positions} positions · ₹{rb.result.totalInvested.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                        </span>
                        {rb.result.nameCollisions.length > 0 && (
                          <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-lg"
                            title={`These names each map to 2+ scrip-master entries — trades under them split instead of merging. Keep ONE entry per stock (old name as an alias).\n\n${rb.result.nameCollisions.map(c => `"${c.name}" → ${c.entries.join('  /  ')}`).join('\n')}`}>
                            ⚠ {rb.result.nameCollisions.length} name collision{rb.result.nameCollisions.length > 1 ? 's' : ''}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-1 rounded-lg" title={rb.error}>✗ Rebuild failed</span>
                    ))}
                    {trx && (trx.result ? (
                      <span className="text-[10px] font-bold text-violet-700 bg-violet-50 border border-violet-200 px-2 py-1 rounded-lg" title={`Wrote "${trx.result.tabName}" + "${trx.result.intradayTabName}" + "${trx.result.holdingTabName}" — ${trx.result.buyRows} buys · ${trx.result.sellRows} sells`}>
                        ✓ {trx.result.fyLabel} · {trx.result.scrips} scrips
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-1 rounded-lg" title={trx.error}>✗ Capital Gains failed</span>
                    ))}
                    {scripReview && scripReview.pid === id && scripReview.unresolved.length > 0 && (
                      <button
                        onClick={() => setShowScripModal(true)}
                        title="Some securities couldn't be auto-matched — review and link them"
                        className="px-3 py-1.5 bg-orange-50 border border-orange-200 text-orange-700 hover:bg-orange-100 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer animate-pulse"
                      >
                        <AlertTriangle className="w-3.5 h-3.5" /> Review {scripReview.unresolved.length} unmatched
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
        </div>
      ) : (
        <div className="space-y-6 animate-fadeIn">
          {/* Header & Back Button */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setIsDetailView(false)}
                className="group flex items-center gap-1.5 pl-2 pr-3.5 py-2 bg-white hover:bg-indigo-600 border border-slate-200 hover:border-indigo-600 text-slate-600 hover:text-white rounded-full shadow-xs hover:shadow-md transition-all cursor-pointer"
                title="Back to Summary"
              >
                <ArrowLeft className="w-4 h-4 transition-transform group-hover:-translate-x-0.5" />
                <span className="text-xs font-bold">Back</span>
              </button>
              <div>
                <h2 className="text-lg font-black text-slate-800 tracking-tight uppercase flex items-center gap-2">
                  {getPortfolioSummary(activePortfolio).name}
                </h2>
                <p className="text-xs text-slate-500 font-medium">
                  {getPortfolioSummary(activePortfolio).subtext}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {activePortfolio !== 'local' ? (
                <>
                  <a
                    href={portfolioSheetUrl(activePortfolio as string)}
                    target="_blank" rel="noopener noreferrer"
                    title="Open this portfolio's Google Sheet in a new tab"
                    className="px-4 py-2 bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> Open Google Sheet
                  </a>
                </>
              ) : (
                <div className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-100 px-3 py-1.5 rounded-full">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  <span className="text-[9px] font-black tracking-wider text-emerald-800 uppercase">Sandbox Environment</span>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-6">
            {activePortfolio !== 'local' && !hasAuthorizedGoogle() && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xs select-none animate-scaleIn">
                <div className="flex items-start gap-3">
                  <div className="p-2.5 bg-amber-100 text-amber-800 rounded-xl mt-0.5 shrink-0">
                    <AlertTriangle className="w-5 h-5 animate-pulse" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h5 className="font-extrabold text-amber-900 text-sm">Google Sheets not connected</h5>
                    <p className="text-xs text-amber-700 mt-1 leading-normal">
                      Live portfolio ledgers load from Google Sheets. Connect to sync — values stay at ₹0 until then (no placeholder data is shown).
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => login()}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs rounded-xl shadow-xs uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 shrink-0 select-none cursor-pointer"
                >
                  <Globe className="w-4 h-4" /> Sync Google Sheet
                </button>
              </div>
            )}

            {/* Stats overview bento grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-4 rounded-xl border border-slate-200 bg-slate-900 text-white shadow-sm flex flex-col justify-between min-h-[90px]">
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Total Valuation</span>
                  <span className="text-xl font-bold font-mono text-white mt-1">₹{getPortfolioSummary(activePortfolio).currentValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="p-4 rounded-xl border border-slate-200 bg-white shadow-sm flex flex-col justify-between min-h-[90px]">
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Invested Capital</span>
                  <span className="text-xl font-bold font-mono text-slate-800 mt-1">₹{getPortfolioSummary(activePortfolio).investedValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div className={`p-4 rounded-xl border shadow-sm flex flex-col justify-between min-h-[90px] ${getPortfolioSummary(activePortfolio).unrealisedGain >= 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'}`}>
                  <span className={`text-[10px] font-black uppercase tracking-widest ${getPortfolioSummary(activePortfolio).unrealisedGain >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>Unrealised Gain</span>
                  <span className={`text-xl font-bold font-mono mt-1 ${getPortfolioSummary(activePortfolio).unrealisedGain >= 0 ? 'text-emerald-800' : 'text-rose-800'}`}>
                    {getPortfolioSummary(activePortfolio).unrealisedGain >= 0 ? '+' : ''}₹{getPortfolioSummary(activePortfolio).unrealisedGain.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div className={`p-4 rounded-xl border shadow-sm flex flex-col justify-between min-h-[90px] ${getPortfolioSummary(activePortfolio).todaysGain >= 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'}`}>
                  <span className={`text-[10px] font-black uppercase tracking-widest ${getPortfolioSummary(activePortfolio).todaysGain >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>Today's Gain</span>
                  <span className={`text-xl font-bold font-mono mt-1 ${getPortfolioSummary(activePortfolio).todaysGain >= 0 ? 'text-emerald-800' : 'text-rose-800'}`}>
                    {getPortfolioSummary(activePortfolio).todaysGain >= 0 ? '+' : ''}₹{getPortfolioSummary(activePortfolio).todaysGain.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>

              {/* Search filter input block + add record button */}
              <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-5">
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
                  <div className="flex-grow max-w-md relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Filter holdings by symbol, name, sector..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="w-full pl-9 pr-9 py-2.5 text-xs rounded-xl border border-slate-200 focus:ring-1 focus:ring-indigo-500 outline-none"
                    />
                    {searchTerm && (
                      <button type="button" onClick={() => setSearchTerm('')} aria-label="Clear search"
                        className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 rounded cursor-pointer">
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  {activePortfolio === 'local' ? (
                    <button
                      onClick={() => setShowAddForm(prev => !prev)}
                      className="px-4 py-2.5 bg-slate-900 border border-slate-900 hover:bg-slate-800 text-white font-black text-xs rounded-xl transition-all flex items-center gap-1 cursor-pointer shrink-0 shadow-sm"
                    >
                      <Plus className="w-4 h-4 font-bold" /> Record Manual Asset
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 shrink-0">
                      <PriceStatusButton refreshKey={priceRefreshTick} />
                      <button
                        onClick={rebuildHoldingsNow}
                        disabled={rebuildingHoldings}
                        title="Recompute the Holding tab from Opening Holdings + True Entry — use if the list looks out of date after editing opening lots"
                        className="btn-press px-3.5 py-2.5 bg-white border border-slate-200 text-slate-600 hover:border-indigo-300 font-black text-xs rounded-xl flex items-center gap-1.5 cursor-pointer shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        <RefreshCw className={`w-4 h-4 ${rebuildingHoldings ? 'animate-spin' : ''}`} /> {rebuildingHoldings ? 'Rebuilding…' : 'Rebuild'}
                      </button>
                      <button
                        onClick={() => setShowSold(v => !v)}
                        role="switch" aria-checked={showSold}
                        title="Also list companies that were fully sold (no current holding) — click one to open its trade history"
                        className={`px-3.5 py-2.5 border font-black text-xs rounded-xl transition-all flex items-center gap-2 cursor-pointer shadow-sm ${
                          showSold
                            ? 'bg-indigo-600 border-indigo-600 text-white hover:bg-indigo-500'
                            : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300'
                        }`}
                      >
                        <span className={`relative inline-flex w-7 h-4 rounded-full transition-colors ${showSold ? 'bg-white/30' : 'bg-slate-300'}`}>
                          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${showSold ? 'left-3.5' : 'left-0.5'}`} />
                        </span>
                        {isLoadingSold ? 'Loading sold…' : 'Show Sold'}
                      </button>
                      <button
                        onClick={() => setShowAddTrade(true)}
                        className="btn-press px-4 py-2.5 bg-slate-900 border border-slate-900 hover:bg-slate-800 text-white font-black text-xs rounded-xl flex items-center gap-1.5 cursor-pointer shrink-0 shadow-sm"
                      >
                        <Plus className="w-4 h-4 font-bold" /> Add Trade
                      </button>
                    </div>
                  )}
                </div>

                {/* ── Asset class: All / Equity / Private Equity ───────────────────────────
                    Listed and unlisted holdings share one ledger and both count toward this
                    account's totals; this narrows the LIST only. The cards above never move,
                    so the segment carries its own subtotal — otherwise picking "Private
                    Equity" would show you three rows and no idea what they're worth. */}
                {activePortfolio !== 'local' && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="inline-flex items-center p-1 bg-white border border-slate-200 rounded-xl shadow-xs shrink-0">
                      {([
                        { key: 'all' as const, label: 'All', count: segmentCounts.all, hint: 'Every holding in this account' },
                        { key: 'eq' as const, label: 'Equity', count: segmentCounts.eq, hint: 'Listed securities only' },
                        // One segment per non-listed tab, from the registry: adding a fourth tab
                        // adds its segment with no change here.
                        ...ASSET_CLASS_IDS.map(id => ({
                          key: id,
                          label: ASSET_CLASSES[id].label,
                          count: segmentCounts[id],
                          hint: `Holdings on the “${ASSET_CLASSES[id].tab}” tab only`,
                        })),
                      ]).map((seg) => {
                        const active = assetClass === seg.key;
                        // Disabled only once we KNOW the account holds none of that class. While
                        // the scrip master is still loading every class answers 0, which is not
                        // a fact yet — disabling on it would flicker and could hide real
                        // holdings behind a dead control.
                        const off = seg.key !== 'all' && seg.key !== 'eq'
                          && scrip !== null && classCensus[seg.key] === 0;
                        return (
                          <button
                            key={seg.key}
                            type="button"
                            onClick={() => setAssetClass(seg.key)}
                            disabled={off}
                            aria-pressed={active}
                            title={off ? `No ${seg.label} holdings in this account` : seg.hint}
                            className={`px-3.5 py-1.5 rounded-lg text-xs font-black transition-all flex items-center gap-1.5 ${
                              off
                                ? 'text-slate-600 opacity-40 cursor-not-allowed'
                                : active
                                  ? 'bg-indigo-600 text-white shadow-xs cursor-pointer'
                                  : 'text-slate-600 hover:bg-slate-50 cursor-pointer'
                            }`}
                          >
                            {seg.label}
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-black tabular-nums ${
                              active ? 'bg-white/30' : 'bg-slate-100 text-slate-600'
                            }`}>
                              {seg.count}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {/* The selected slice's own numbers. Hidden on "All", where the cards above
                        already say it and a second copy would just invite a comparison. */}
                    {assetClass !== 'all' && (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
                        <span>
                          Invested <strong className="text-slate-700 tabular-nums font-mono">{formatINR(segmentTotals.invested)}</strong>
                        </span>
                        <span>
                          Value <strong className="text-slate-700 tabular-nums font-mono">{formatINR(segmentTotals.current)}</strong>
                        </span>
                        <span className={segmentTotals.gain >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                          {segmentTotals.gain >= 0 ? '+' : ''}
                          <strong className="tabular-nums font-mono">{formatINR(segmentTotals.gain)}</strong>
                          {segmentTotals.invested > 0 && (
                            <> ({segmentTotals.gain >= 0 ? '+' : ''}{((segmentTotals.gain / segmentTotals.invested) * 100).toFixed(2)}%)</>
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* The Private Equities tab couldn't be read. This is NOT cosmetic: without it
                    every unlisted company silently behaves like an ordinary unpriced stock —
                    no badge, its cost shown as a market price, and its long-term holding period
                    back at 12 months instead of 24, which is a tax classification error. */}
                {scrip?.peFailed && (
                  <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[12px] text-amber-800">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      Couldn't read the <strong>{PRIVATE_EQUITIES_TAB}</strong> tab of the scrip-master sheet, so
                      unlisted companies can't be told apart from listed ones right now — they'll show as ordinary
                      stocks with no price, and their capital-gains holding period will be computed as 12 months
                      instead of 24. Reload the page; if it persists, check that the tab still exists.
                    </span>
                  </div>
                )}

                {/* Inline manual addition form */}
                {activePortfolio === 'local' && showAddForm && (
                  <form onSubmit={handleAddManualHolding} className="p-5 border border-slate-200 bg-slate-50 rounded-2xl grid grid-cols-1 md:grid-cols-4 gap-4 animate-fadeIn">
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Symbol</label>
                      <input
                        type="text"
                        placeholder="e.g. RELIANCE"
                        value={newSymbol}
                        onChange={(e) => setNewSymbol(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Asset Name</label>
                      <input
                        type="text"
                        placeholder="e.g. Reliance Industries Limited"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">ISIN (Optional)</label>
                      <input
                        type="text"
                        placeholder="e.g. INE002A01018"
                        value={newIsin}
                        onChange={(e) => setNewIsin(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Sector</label>
                      <select
                        value={newSector}
                        onChange={(e) => setNewSector(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
                      >
                        <option value="Financial Services">Financial Services</option>
                        <option value="Energy">Energy</option>
                        <option value="IT & Tech">IT & Tech</option>
                        <option value="Consumer Goods">Consumer Goods</option>
                        <option value="Healthcare">Healthcare</option>
                        <option value="Tactical Allocation">Tactical Allocation</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Quantity</label>
                      <input
                        type="number"
                        min="1"
                        placeholder="e.g. 100"
                        value={newQty}
                        onChange={(e) => setNewQty(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Average cost price (INR)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        placeholder="e.g. 2350"
                        value={newCost}
                        onChange={(e) => setNewCost(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white shadow-xs"
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Current Price (INR)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        placeholder="e.g. 2480"
                        value={newCurrentPrice}
                        onChange={(e) => setNewCurrentPrice(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white shadow-xs"
                        required
                      />
                    </div>
                    <div className="flex items-end">
                      <button
                        type="submit"
                        className="btn-press w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl cursor-pointer"
                      >
                        Log Field Position
                      </button>
                    </div>
                  </form>
                )}

                {/* Live spreadsheet synchronization loaders */}
                {isLoadingSheet ? (
                  <div className="py-20 text-center space-y-3">
                    <CubeLoader className="w-24 mx-auto" />
                    <p className="text-xs font-black text-slate-500 animate-pulse">Loading holdings ledger values...</p>
                  </div>
                ) : sheetError ? (
                  <div className="p-8 bg-rose-50 border border-rose-100 rounded-2xl text-center space-y-4 max-w-md mx-auto my-4 animate-scaleIn">
                    <AlertTriangle className="w-10 h-10 text-rose-600 mx-auto" />
                    <div>
                      <h5 className="font-bold text-rose-900 text-sm">Synchronisation Interrupted</h5>
                      <p className="text-xs text-rose-700 mt-1">{sheetError}</p>
                    </div>
                    <div className="flex items-center justify-center gap-2">
                      {!hasAuthorizedGoogle() && (
                        <button
                          onClick={() => login()}
                          className="btn-press px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-lg shadow-sm cursor-pointer"
                        >
                          Reconnect Google Sheets
                        </button>
                      )}
                      <button
                        onClick={() => fetchSheetHoldings(activePortfolio as string)}
                        className="btn-press px-5 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs rounded-lg shadow-sm cursor-pointer"
                      >
                        Try Re-fetching
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="overflow-x-auto border border-slate-200 rounded-2xl">
                    {(() => { const holdingColKeys = ['name','quantity','avgCost','currentPrice','currentValue','profit', ...(activePortfolio === 'local' ? ['settings'] : [])]; const holdingsWidth = holdingColKeys.reduce((s, k) => s + (colWidths[k] ?? HOLDINGS_COL_DEFAULTS[k] ?? 120), 0); return (
                    <table
                      className="border-collapse whitespace-nowrap text-xs text-left [&_td]:overflow-hidden"
                      style={{ tableLayout: 'fixed', width: holdingsWidth }}
                    >
                      <colgroup>
                        {holdingColKeys.map((k) => <col key={k} style={{ width: (colWidths[k] ?? HOLDINGS_COL_DEFAULTS[k] ?? 120) + 'px' }} />)}
                      </colgroup>
                      <thead className="bg-[#f8fafc] border-b border-slate-200 font-extrabold text-slate-600 uppercase tracking-wider select-none">
                        <tr>
                          {headCell('name', 'Security Name', 'left', 'symbol')}
                          {headCell('quantity', 'Shares Qty', 'right', 'quantity')}
                          {headCell('avgCost', 'Avg Buy Price', 'right', 'avgCost')}
                          {headCell('currentPrice', 'Current Price', 'right', 'currentPrice')}
                          {headCell('currentValue', 'Current Value', 'right', 'currentValue')}
                          {headCell('profit', 'Unrealised Profit/Gain', 'right', 'profit')}
                          {activePortfolio === 'local' && headCell('settings', 'Settings', 'center')}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {sortedHoldings.map((h, idx) => {
                          const isPositive = h.unrealizedGain >= 0;
                          // Unlisted AND never marked: its "current" figure is its own cost, so
                          // any gain shown would be zero by construction rather than by market.
                          const unvaluedPe = h.type === 'PE' && activePortfolio !== 'local'
                            && !((h.peValuation ?? 0) > 0) && !((h.lastTradePrice ?? 0) > 0);

                          return (
                            <tr
                              key={h.id}
                              onClick={(e) => {
                                const target = e.target as HTMLElement;
                                if (target.closest('button') || target.closest('input') || target.closest('select') || target.closest('a')) return;

                                setSelectedStock(h.original);
                                setCustomCmp(null);
                                fetchTransactionsForStock(h.original.companyName || h.original.name, h.original.isin);
                              }}
                              style={{ animationDelay: `${Math.min(idx, 15) * 30}ms` }}
                              className="hover:bg-slate-50/80 cursor-pointer transition-colors animate-riseIn"
                            >
                              <td className="px-3 py-2.5 overflow-hidden border-r border-slate-100 last:border-r-0">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="font-bold text-slate-800 truncate" title={h.name}>
                                    {h.name}
                                  </span>
                                  {/* Unlisted. Needed under "All", where this row sits next to
                                      listed ones and its Current Price column would otherwise
                                      read as a market price. Same badge as the Dashboard's
                                      consolidated table, so the two tables agree. */}
                                  {h.type === 'PE' && (
                                    <span
                                      className="px-1.5 py-0.5 rounded-md bg-orange-50 border border-orange-200 text-orange-700 text-[9px] font-black shrink-0 select-none"
                                      title={(h.peValuation ?? 0) > 0
                                        ? `Unlisted — valued at ${formatINR(h.peValuation!)}/share${h.peValuationDate ? ` as on ${formatDMY(h.peValuationDate)}` : ''}`
                                        : (h.lastTradePrice ?? 0) > 0
                                        ? `Unlisted — no valuation entered, so valued at its last traded price ${formatINR(h.lastTradePrice!)}${h.lastTradeDate ? ` (${formatDMY(h.lastTradeDate)})` : ''}`
                                        : 'Unlisted — no valuation entered, carried at cost'}
                                    >
                                      PE
                                    </span>
                                  )}
                                  {h.driveLink && (
                                    <a
                                      href={h.driveLink}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      title={`Open the Drive folder for ${h.name}`}
                                      aria-label={`Open the Drive folder for ${h.name}`}
                                      className="shrink-0 text-slate-400 hover:text-indigo-600 transition-colors cursor-pointer"
                                    >
                                      <FolderOpen className="w-3.5 h-3.5" />
                                    </a>
                                  )}
                                  {h.discrepancy ? (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider bg-rose-50 text-rose-700 border border-rose-300 shrink-0 select-none"
                                      title="Negative net quantity — the ledger for this stock is inconsistent (a missing buy, or a dropped/duplicated sell). Open the stock to trace it in the Trade Book.">
                                      <AlertTriangle className="w-3 h-3" /> Discrepancy
                                    </span>
                                  ) : h.sold && (
                                    <span className="px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider bg-rose-50 text-rose-600 border border-rose-200 shrink-0 select-none">
                                      Sold
                                    </span>
                                  )}
                                </div>
                              </td>

                              <td className={`px-3 py-2.5 text-right font-mono font-bold border-r border-slate-100 last:border-r-0 ${h.discrepancy ? 'text-rose-600' : 'text-slate-700'}`}>
                                {formatNum(h.quantity)}
                              </td>

                              <td className="px-3 py-2.5 text-right font-mono text-slate-500 border-r border-slate-100 last:border-r-0">
                                {formatINR(h.avgCost)}
                              </td>

                              <td className="px-3 py-2.5 text-right select-none font-mono border-r border-slate-100 last:border-r-0">
                                {editingPriceId === h.id ? (
                                  <div className="flex items-center justify-end gap-1.5">
                                    <input
                                      type="number"
                                      step="0.01"
                                      value={editingPriceValue}
                                      onChange={(e) => setEditingPriceValue(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleSavePriceEdit(h.id);
                                        else if (e.key === 'Escape') setEditingPriceId(null);
                                      }}
                                      className="w-20 px-1 py-0.5 rounded border border-indigo-400 text-xs text-right font-mono bg-white"
                                      autoFocus
                                    />
                                    <button
                                      onClick={() => handleSavePriceEdit(h.id)}
                                      disabled={savingPeCmp !== null}
                                      className="btn-press bg-indigo-600 hover:bg-emerald-600 font-extrabold text-[10px] text-white px-1.5 py-0.5 rounded shadow disabled:opacity-50 cursor-pointer"
                                    >
                                      {savingPeCmp !== null ? '…' : 'Save'}
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex items-center justify-end gap-1">
                                    {unvaluedPe ? (
                                      <span className="text-slate-400 font-medium" title="Unlisted — no valuation entered, so this holding is carried at cost">
                                        at cost
                                      </span>
                                    ) : (
                                      <span
                                        className="text-slate-700 font-bold"
                                        title={h.type === 'PE'
                                          ? ((h.peValuation ?? 0) > 0
                                              ? `Valuation from the ${PRIVATE_EQUITIES_TAB} tab${h.peValuationDate ? `, as on ${formatDMY(h.peValuationDate)}` : ' (no as-on date given)'}`
                                              : `Its last traded price${h.lastTradeDate ? `, ${formatDMY(h.lastTradeDate)}` : ''} — no valuation is entered on the ${PRIVATE_EQUITIES_TAB} tab`)
                                          : undefined}
                                      >
                                        {formatINR(h.currentPrice)}
                                      </span>
                                    )}
                                    {/* The editor markup below has existed all along with nothing
                                        to open it - handleStartEditingPrice was never called from
                                        anywhere. Offered for UNLISTED holdings only: their price
                                        genuinely is a judgement the user makes, and it is saved to
                                        the Private Equities tab. A listed price is the feed's and
                                        typing over it would just be undone on the next refresh.
                                        The row's own onClick already ignores clicks on a button. */}
                                    {h.type === 'PE' && activePortfolio !== 'local' && (
                                      <button
                                        onClick={() => handleStartEditingPrice(h.id, h.currentPrice)}
                                        disabled={savingPeCmp !== null}
                                        aria-label={`Set CMP for ${h.name}`}
                                        title={`Set the CMP for ${h.name} — saved to the ${PRIVATE_EQUITIES_TAB} tab`}
                                        className="btn-press p-0.5 rounded text-slate-400 hover:text-indigo-600 disabled:opacity-40 cursor-pointer"
                                      >
                                        {savingPeCmp === (h.isin || h.name)
                                          ? <Loader2 className="w-3 h-3 animate-spin" />
                                          : <Edit2 className="w-3 h-3" />}
                                      </button>
                                    )}
                                  </div>
                                )}
                              </td>

                              <td className="px-3 py-2.5 text-right font-mono font-extrabold text-slate-900 border-r border-slate-100 last:border-r-0">
                                {formatINR(h.currentValue)}
                              </td>

                              <td className={`px-3 py-2.5 text-right font-mono font-bold border-r border-slate-100 last:border-r-0 ${unvaluedPe ? 'text-slate-400' : isPositive ? 'text-emerald-700' : 'text-rose-700'}`}>
                                {unvaluedPe ? (
                                  <div title="No valuation entered, so there is nothing to compare cost against — this is not a flat return">—</div>
                                ) : (
                                  <>
                                    <div>
                                      {isPositive ? '+' : ''}{formatINR(h.unrealizedGain)}
                                    </div>
                                    <div className="text-[10px] font-semibold block">
                                      {isPositive ? '+' : ''}{h.unrealizedGainPct.toFixed(2)}%
                                    </div>
                                    {h.currentValue > 0 && !h.discrepancy && (
                                      <div className="w-24 ml-auto"><GainBar pct={h.unrealizedGainPct} /></div>
                                    )}
                                  </>
                                )}
                              </td>

                              {activePortfolio === 'local' && (
                                <td className="px-3 py-2.5 text-center">
                                  <button
                                    onClick={() => handleDeleteHolding(h.id, h.name)}
                                    className="p-1 px-1.5 hover:bg-rose-50 text-slate-400 hover:text-rose-600 border border-transparent rounded transition-colors cursor-pointer"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </td>
                              )}
                            </tr>
                          );
                        })}

                        {sortedHoldings.length === 0 && (
                          <tr>
                            <td colSpan={10} className="py-12 text-center text-slate-500 italic text-xs">
                              {/* Now that a segment can legitimately be empty, say WHICH filter
                                  emptied it — "no holdings found" on an account holding forty
                                  stocks reads as a fault. */}
                              {searchTerm.trim()
                                ? `Nothing matches “${searchTerm.trim()}”${assetClass === 'pe' ? ' among the unlisted holdings' : assetClass === 'eq' ? ' among the listed holdings' : ''}.`
                                : assetClass === 'pe'
                                  ? 'No unlisted holdings in this account.'
                                  : assetClass === 'eq'
                                    ? 'No listed holdings in this account.'
                                    : 'No matching asset holdings found in this portfolio view.'}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    ); })()}
                  </div>
                )}

                {/* Notes under the grid. Which one applies depends on the segment: the point is
                    that a narrowed list never leaves the cards above looking wrong. */}
                {activePortfolio !== 'local' && (
                  assetClass === 'pe'
                  || (assetClass === 'eq' && peHoldings.length > 0)
                  || (assetClass === 'all' && peAtCost > 0)
                ) && (
                  <div className="px-4 py-2.5 border-t border-slate-200 space-y-1 text-[11px] text-slate-500">
                    {assetClass === 'eq' && peHoldings.length > 0 && (
                      <p>
                        Not listed here: <strong className="text-slate-700">{peHoldings.length}</strong> unlisted{' '}
                        {peHoldings.length === 1 ? 'holding' : 'holdings'} worth{' '}
                        <strong className="text-slate-700 tabular-nums">{formatINR(peValue)}</strong>. They are still
                        counted in the account totals above — switch to Private Equity to see them.
                      </p>
                    )}
                    {assetClass === 'pe' && (
                      <p>
                        Unlisted holdings only. The cards above cover the whole account, listed and unlisted together.
                      </p>
                    )}
                    {/* A company with no valuation has a gain of exactly zero by construction. Say
                        so, or a screen full of ₹0.00 reads as a flat market rather than as no mark. */}
                    {peAtCost > 0 && (assetClass === 'pe' || assetClass === 'all') && (
                      <p>
                        <strong className="text-slate-700">{peAtCost}</strong> unlisted{' '}
                        {peAtCost === 1 ? 'company is' : 'companies are'} carried at cost — enter a per-share
                        value in the <strong className="text-slate-700">{PRIVATE_EQUITIES_TAB}</strong> tab of the
                        scrip-master sheet to mark {peAtCost === 1 ? 'it' : 'them'}.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }