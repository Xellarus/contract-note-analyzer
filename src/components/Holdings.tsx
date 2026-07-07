import React, { useState, useEffect, useMemo } from 'react';
import { 
  Plus, Search, Edit2, Trash2, ArrowUpDown, RefreshCw, CheckCircle, 
  HelpCircle, AlertCircle, FileSpreadsheet, PlusCircle, Bookmark, DollarSign,
  Compass, Briefcase, ShieldCheck, AlertTriangle, TrendingUp, Wallet, Sparkles, Key, Globe,
  ArrowLeft, ChevronLeft, Download, ExternalLink, Wrench
} from 'lucide-react';
import { PortfolioHolding, ContractNoteResult } from '../types';
import { useGoogleLogin } from '@react-oauth/google';
import { gapi } from "gapi-script";
import { persistGoogleToken, hasValidGoogleToken } from '../lib/googleAuth';
import { rebuildHoldingTab, syncCapitalGains, RebuildHoldingResult, UnresolvedScrip } from '../lib/holdingsCalc';
import { generateTrxRegister, TrxRegisterResult } from '../lib/trxRegister';
import { loadScripMaster, lookupScrip, normName, ScripMaster, SCRIP_MASTER_SPREADSHEET_ID } from '../lib/scripMaster';
import { loadScripPrices, ScripPrice } from '../lib/scripPrices';
import ScripReviewModal from './ScripReviewModal';
import AddTradeModal from './AddTradeModal';
import { migrateTrueRawEntry } from '../lib/sheetMigration';
import { PORTFOLIOS, portfolioById, sheetIdForId, portfolioSheetUrl, DEFAULT_PORTFOLIO_ID } from '../lib/portfolios';
import { toast, confirmDialog } from './ui/overlay';

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

const csvEscape = (v: any) => { const s = (v ?? '').toString(); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

interface HoldingsProps {
  holdings: PortfolioHolding[];
  setHoldings: (h: PortfolioHolding[] | ((prev: PortfolioHolding[]) => PortfolioHolding[])) => void;
  parsedContractNote: ContractNoteResult | null;
  activePortfolio: string;
  setActivePortfolio: (id: string) => void;
  isDetailView: boolean;
  setIsDetailView: (val: boolean) => void;
}

interface SheetHolding {
  companyName: string;
  isin: string;
  quantity: number;
  avgBuyPrice: number;
  investedValue: number;
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
}

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
  type: string;
  original: any;
}

export default function Holdings({ 
  holdings, 
  setHoldings, 
  parsedContractNote,
  activePortfolio,
  setActivePortfolio,
  isDetailView,
  setIsDetailView
}: HoldingsProps) {
  const [sheetCmpOverrides, setSheetCmpOverrides] = useState<Record<string, number>>({});

  // Drilldown states
  const [selectedStock, setSelectedStock] = useState<SheetHolding | PortfolioHolding | null>(null);
  // Scrip master (NSE/BSE/ISIN reference) for the stock-detail header pills.
  const [scrip, setScrip] = useState<ScripMaster | null>(null);
  // Current-price snapshot (from the screener.in import) — values holdings live-ish.
  const [priceRows, setPriceRows] = useState<ScripPrice[]>([]);
  useEffect(() => {
    loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID).then(setScrip).catch(() => {});
    loadScripPrices(SCRIP_MASTER_SPREADSHEET_ID).then(setPriceRows).catch(() => {});
  }, []);

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
  const getRealCmp = (isin: string, name: string): number | undefined => {
    if (scrip) { const e = lookupScrip(scrip, isin, name).entry; if (e) { const v = priceMap.get('key:' + e.key); if (v !== undefined) return v; } }
    if (isin) { const v = priceMap.get('isin:' + isin.toUpperCase()); if (v !== undefined) return v; }
    return priceMap.get('name:' + normName(name));
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
  const [activeDetailTab, setActiveDetailTab] = useState<'trade_book' | 'inventory' | 'realised_inventory'>('trade_book');
  const [customCmp, setCustomCmp] = useState<number | null>(null);
  const [isEditingCmp, setIsEditingCmp] = useState(false);
  const [cmpInputVal, setCmpInputVal] = useState('');
  const [txSearchTerm, setTxSearchTerm] = useState('');
  
  // States for fetching spreadsheet holdings
  const [sheetHoldings, setSheetHoldings] = useState<SheetHolding[]>([]);
  const [sheetTotal, setSheetTotal] = useState<number>(0);
  // Per-portfolio Holding-tab totals for the summary cards. Keyed by portfolio id,
  // so each card keeps its own last-synced value — syncing/opening one portfolio
  // never zeroes the others (which happened when all cards read one sheetTotal).
  const [portfolioTotals, setPortfolioTotals] = useState<Record<string, number>>({});
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  // original local portfolios state
  const [searchTerm, setSearchTerm] = useState('');
  const [sortField, setSortField] = useState<'symbol' | 'quantity' | 'avgCost' | 'currentValue' | 'profit'>('currentValue');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  
  // Manual adding forms state
  const [showAddForm, setShowAddForm] = useState(false);
  // Manual trade entry drawer (writes real trades to the portfolio's sheet).
  const [showAddTrade, setShowAddTrade] = useState(false);
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
  const [migratingFor, setMigratingFor] = useState<string | null>(null);
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
        range: `Holding!A:E`,
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
          quantity: qty,
          avgBuyPrice: avgPrice,
          investedValue: actualInvested
        });

        totalValue += actualInvested;
      }

      setSheetHoldings(parsed);
      setSheetTotal(totalValue);
      setPortfolioTotals(prev => ({ ...prev, [portfolio]: totalValue }));
      setLastSyncedAt(new Date());
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
        spreadsheetId, range: `Holding!A:E`,
      });
      const rows = res?.result?.values || [];
      let total = 0;
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;
        const name = (row[0] || "").toString().trim();
        if (!name || name.toLowerCase().startsWith("total")) continue;
        const qty = parseFloat((row[2] || "").toString().replace(/,/g, "").trim());
        const avg = parseFloat((row[3] || "").toString().replace(/,/g, "").trim());
        const inv = parseFloat((row[4] || "").toString().replace(/,/g, "").trim());
        if (isNaN(qty) || isNaN(avg)) continue;
        total += isNaN(inv) ? qty * avg : inv;
      }
      setPortfolioTotals(prev => ({ ...prev, [pid]: total }));
    } catch { /* keep any prior value on error — don't zero a good card */ }
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

  // One-time cleanup: drop the ISIN column and convert Trade Date cells to real
  // ISO dates in True Entry / Raw Entry, then recompute downstream tabs.
  const migrateSheets = async (pid: string) => {
    if (!hasValidGoogleToken()) {
      toast.error("Google Sheets connection required. Please authorize with Google first.");
      return;
    }
    const ok = await confirmDialog({
      title: `Clean up ${pid.toUpperCase()}'s ledger?`,
      body: (
        <>
          This rewrites True Entry &amp; Raw Entry to:
          <ul className="list-disc pl-4 mt-1 space-y-0.5">
            <li>Remove the ISIN column</li>
            <li>Convert every Trade Date to a real date (YYYY-MM-DD) so pivots can group by date</li>
          </ul>
          <span className="block mt-2">It then rebuilds Holding + capital gains. This is a one-time operation.</span>
        </>
      ),
      confirmLabel: 'Clean up',
    });
    if (!ok) return;
    setMigratingFor(pid);
    try {
      const res = await migrateTrueRawEntry(sheetIdForId(pid));
      const fixed = res.tabs.reduce((s, t) => s + t.datesFixed, 0);
      const removed = res.tabs.some(t => t.removedIsin);
      if (activePortfolio === pid) await fetchSheetHoldings(pid, true);
      const summary =
        `Done for ${pid.toUpperCase()}. ` +
        `${removed ? 'ISIN column removed. ' : 'No ISIN column found. '}` +
        `${fixed} date cell(s) converted to real dates.`;
      if (res.holdingWarning || res.capGainsWarning) {
        toast.error(
          summary +
          (res.holdingWarning ? ` Warning: Holding rebuild — ${res.holdingWarning}.` : '') +
          (res.capGainsWarning ? ` Warning: capital gains — ${res.capGainsWarning}.` : '')
        );
      } else {
        toast.success(summary);
      }
    } catch (err: any) {
      toast.error("Cleanup failed: " + (err?.result?.error?.message || err?.message || "unknown error"));
    } finally {
      setMigratingFor(null);
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
        const type = t.transactionType.toUpperCase();
        if (type.includes("BUY") || type.includes("RIGHT") || type.includes("PAID")) {
          currentBal += t.quantity;
        } else if (type.includes("SELL")) {
          currentBal -= t.quantity;
        }
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
        range: `True Entry!A:T`,
      });

      const rows = response?.result?.values || [];
      const parsed: Transaction[] = [];

      if (rows.length > 1) {
        const headers = rows[0].map((h: any) => h.toString().trim());
        const dateIdx = headers.indexOf("Trade Date");
        const isinIdx = headers.indexOf("ISIN");
        const nameIdx = headers.indexOf("Stock Name");
        const typeIdx = headers.indexOf("Transaction Type");
        const qtyIdx = headers.indexOf("Number of Shares");
        const priceIdx = headers.indexOf("Avg Price");
        const amountIdx = headers.indexOf("Total Amount (Turnover)");
        const brokerageIdx = headers.indexOf("Total Brokerage");

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;

          const rowIsin = (row[isinIdx !== -1 ? isinIdx : 1] || "").toString().trim();
          const rowName = (row[nameIdx !== -1 ? nameIdx : 2] || "").toString().trim();

          const matchIsin = isin && rowIsin && rowIsin.toLowerCase() === isin.toLowerCase();
          const matchName = companyName && rowName && (
            rowName.toLowerCase().includes(companyName.toLowerCase()) || 
            companyName.toLowerCase().includes(rowName.toLowerCase())
          );

          if (matchIsin || matchName) {
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
              amount: isNaN(turnover) ? 0 : turnover
            });
          }
        }
      }

      parsed.sort((a, b) => parseDateStr(b.tradeDate) - parseDateStr(a.tradeDate));

      // Calculate rolling balance quantities oldest-to-newest
      const oldestFirst = [...parsed].sort((a, b) => parseDateStr(a.tradeDate) - parseDateStr(b.tradeDate));
      let currentBal = 0;
      oldestFirst.forEach(t => {
        const type = t.transactionType.toUpperCase();
        if (type.includes("BUY") || type.includes("RIGHT") || type.includes("PAID") || type === "PARTLY PAID") {
          currentBal += t.quantity;
        } else if (type.includes("SELL")) {
          currentBal -= t.quantity;
        }
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

  // Extract Series (PEQ/EQ) and Clean Name
  const getCompanyDisplayInfo = (name: string, isin: string) => {
    let type = "EQ";
    let cleanName = name;
    
    // Check key patterns in company name or isin
    if (name.toUpperCase().includes("PEQ") || isin.toUpperCase().startsWith("PEQ") || name.toUpperCase().includes("PRE-EQUITY")) {
      type = "PEQ";
      cleanName = name.replace(/PEQ/gi, "").replace(/PRE-EQUITY/gi, "").trim();
    } else if (name.toUpperCase().includes("CHD")) {
      type = "PEQ"; // matching PEQ CHD in the image description
    }
    
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

  const formatValueOnly = (num: number) => {
    return new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(num);
  };

  const formatNum = (num: number) => {
    return new Intl.NumberFormat('en-IN').format(num);
  };

  const requestSort = (field: 'symbol' | 'quantity' | 'avgCost' | 'currentValue' | 'profit') => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
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

  const handleSavePriceEdit = (id: string) => {
    const val = parseFloat(editingPriceValue);
    if (!isNaN(val) && val >= 0) {
      if (activePortfolio === 'local') {
        setHoldings(prev => prev.map(h => h.id === id ? { ...h, currentPrice: val } : h));
      } else {
        const matched = displayHoldings.find(item => item.id === id);
        if (matched) {
          const key = matched.isin || matched.name;
          setSheetCmpOverrides(prev => ({
            ...prev,
            [key]: val
          }));
        }
      }
    }
    setEditingPriceId(null);
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
          type,
          original: h
        };
      });
    } else {
      const activeSheetHoldings = sheetHoldings.length > 0
        ? sheetHoldings
        : getPreloadedHoldingsForSheet(activePortfolio);

      return activeSheetHoldings.map((h, index) => {
        const { type, cleanName } = getCompanyDisplayInfo(h.companyName, h.isin);
        const { symbol, sector } = getCompanySymbolAndSector(h.companyName, h.isin);
        
        const overrideKey = h.isin || h.companyName;
        let cmp = sheetCmpOverrides[overrideKey];
        if (cmp === undefined) {
          const real = getRealCmp(h.isin, h.companyName);
          if (real !== undefined) {
            cmp = real;                          // imported screener price
          } else {
            // No imported price for this stock → value at cost (never fabricate a
            // current price). Real prices arrive via the screener.in CSV import.
            cmp = h.avgBuyPrice;
          }
        }

        const totalValue = h.quantity * cmp;
        const profit = totalValue - h.investedValue;
        const profitPct = h.investedValue > 0 ? (profit / h.investedValue) * 105 / 105 * 100 : 0; // standard format

        return {
          id: `sheet-${index}`,
          symbol,
          name: cleanName,
          isin: h.isin,
          sector,
          quantity: h.quantity,
          avgCost: h.avgBuyPrice,
          currentPrice: cmp,
          currentValue: totalValue,
          unrealizedGain: profit,
          unrealizedGainPct: profitPct,
          type,
          original: h
        };
      });
    }
  };

  const displayHoldings = getDisplayHoldings();

  const filteredHoldings = displayHoldings.filter(h => 
    h.symbol.toLowerCase().includes(searchTerm.toLowerCase()) || 
    h.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    h.sector.toLowerCase().includes(searchTerm.toLowerCase()) || 
    (h.isin && h.isin.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const sortedHoldings = [...filteredHoldings].sort((a, b) => {
    let aVal: any = a[sortField as keyof DisplayHolding] || '';
    let bVal: any = b[sortField as keyof DisplayHolding] || '';

    if (sortField === 'currentValue') {
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
    }

    if (typeof aVal === 'string') {
      return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
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
    const inferredSymbol = (selectedStock as any).symbol || (cleanName.split(' ')[0] || "STOCK").toUpperCase();

    // Resolve NSE / BSE / ISIN from the shared scrip master (same sheet).
    const scripEntry = scrip ? lookupScrip(scrip, isin, name).entry : null;
    const nseSymbol = scripEntry?.nse || (selectedStock as any).symbol || inferredSymbol;
    const bseCode = scripEntry?.bse || '';
    const displayIsin = isin || scripEntry?.isin || '';

    // Compute CMP values — prefer the imported screener price; otherwise value at
    // cost once any prices exist, else fall back to the legacy placeholder.
    let defaultCmp = avgBuyPrice * 1.0636;
    if (cleanName.toLowerCase().includes("adani")) {
      defaultCmp = 2908.80;
    }
    const realDetailCmp = getRealCmp(isin, name);
    if (realDetailCmp !== undefined) defaultCmp = realDetailCmp;
    else if (priceRows.length > 0) defaultCmp = avgBuyPrice;
    const cmpPrice = customCmp !== null ? customCmp : defaultCmp;
    const changePct = avgBuyPrice > 0 ? ((cmpPrice - avgBuyPrice) / avgBuyPrice) * 100 : 0;

    // FIFO processing variables
    interface InventoryLot {
      date: string;
      quantity: number;
      remainingQty: number;
      price: number;
    }

    interface RealisedTransaction {
      qtySold: number;
      buyPrice: number;
      sellPrice: number;
      buyDate: string;
      sellDate: string;
      gain: number;
    }

    const chronxs = [...transactions].sort((a, b) => parseDateStr(a.tradeDate) - parseDateStr(b.tradeDate));
    
    const activeInventory: InventoryLot[] = [];
    const realisedTrades: RealisedTransaction[] = [];
    let totalDividend = 0;
    let totalBuyAmount = 0;
    let totalSellAmount = 0;

    for (const t of chronxs) {
      const type = t.transactionType.toUpperCase();
      const actionAmt = t.quantity * t.price;

      if (type.includes("DIVIDEND")) {
        const divAmt = t.amount > 0 ? t.amount : (t.quantity > 0 ? t.quantity * t.price : 0);
        totalDividend += divAmt;
        continue;
      }

      if (type.includes("BUY") || type.includes("RIGHT") || type.includes("PAID") || type === "PARTLY PAID") {
        totalBuyAmount += actionAmt;
        activeInventory.push({
          date: t.tradeDate,
          quantity: t.quantity,
          remainingQty: t.quantity,
          price: t.price
        });
      } else if (type.includes("SELL")) {
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

    const hasTransactions = transactions.length > 0;
    const holdingQty = hasTransactions ? filteredInventory.reduce((sum, l) => sum + l.remainingQty, 0) : quantity;
    const finalHoldingQty = holdingQty > 0 ? holdingQty : quantity;
    
    const finalAvgBuyPrice = hasTransactions && filteredInventory.reduce((sum, l) => sum + l.remainingQty, 0) > 0
      ? (filteredInventory.reduce((sum, l) => sum + (l.remainingQty * l.price), 0) / filteredInventory.reduce((sum, l) => sum + l.remainingQty, 0))
      : avgBuyPrice;
    
    const finalInvestedValue = finalHoldingQty * finalAvgBuyPrice;
    // Position-size Invested Value / Avg Buy Price mirror the Holding tab (which now
    // uses the Incl-STT all-in cost) so the detail matches the summary page. The
    // transaction FIFO replay above (turnover-based) still feeds the inventory/
    // realised tables + Total Buy/Sell amounts. Falls back to the replay for the
    // local sandbox or when the tab lacks a figure.
    const displayInvestedValue = (!isLocal && investedValue > 0) ? investedValue : finalInvestedValue;
    const displayAvgBuyPrice = (!isLocal && investedValue > 0) ? avgBuyPrice : finalAvgBuyPrice;
    const totalHoldingValue = finalHoldingQty * cmpPrice;
    const unrealizedGain = totalHoldingValue - displayInvestedValue;
    const totalGain = unrealizedGain + realisedGain + totalDividend;

    // XIRR calculation with terminal asset value cash flow
    const cashFlows: { date: Date; amount: number }[] = [];
    chronxs.forEach(t => {
      const type = t.transactionType.toUpperCase();
      if (type.includes("BUY") || type.includes("RIGHT") || type.includes("PAID")) {
        cashFlows.push({ date: new Date(parseDateStr(t.tradeDate)), amount: -1 * (t.quantity * t.price) });
      } else if (type.includes("SELL")) {
        cashFlows.push({ date: new Date(parseDateStr(t.tradeDate)), amount: t.quantity * t.price });
      } else if (type.includes("DIVIDEND")) {
        const divAmt = t.amount > 0 ? t.amount : (t.quantity > 0 ? t.quantity * t.price : 0);
        cashFlows.push({ date: new Date(parseDateStr(t.tradeDate)), amount: divAmt });
      }
    });
    cashFlows.push({ date: new Date(), amount: totalHoldingValue });

    const computedXirr = calculateXIRR(cashFlows);
    const xirrValue = computedXirr !== 0 ? computedXirr : changePct;

    // Portfolio profile markers
    const _p = portfolioById(activePortfolio);
    const clientName = activePortfolio === 'local' ? 'Local Sandbox User' : (_p?.label ?? activePortfolio);
    const portfolioLabel = activePortfolio === 'local' ? 'Local Sandbox Portfolio' : (_p ? `${_p.label}/${_p.code}` : activePortfolio);

    const formatNum = (v: number) => {
      return new Intl.NumberFormat('en-IN').format(v);
    };

    // Filter transaction list inside granular view searching block
    const filteredTxs = transactions.filter(t => 
      t.tradeDate.toLowerCase().includes(txSearchTerm.toLowerCase()) ||
      t.transactionType.toLowerCase().includes(txSearchTerm.toLowerCase()) ||
      t.price.toString().includes(txSearchTerm) ||
      t.quantity.toString().includes(txSearchTerm)
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
              className="group flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-indigo-600 cursor-pointer transition-colors"
              id="back-to-consolidated-btn"
            >
              <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" /> Back to Consolidated Holdings
            </button>
            <div className="flex items-center gap-2 mt-2">
              <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight" id="detail-company-heading">
                {cleanName}
              </h1>
              <span className={`font-black text-[10px] px-2 py-0.5 rounded-md border select-none ${
                seriesType === 'PEQ' 
                  ? 'bg-orange-50 text-orange-700 border-orange-200' 
                  : 'bg-indigo-50 text-indigo-700 border-indigo-200'
              }`} id="detail-series-badge">
                {seriesType}
              </span>
            </div>
            
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 font-medium pt-1">
              <div id="detail-client-meta">Client Name: <strong className="text-slate-800 font-bold">{clientName}</strong></div>
              <div id="detail-portfolio-meta">Portfolio Name/Code: <strong className="text-slate-800 font-semibold">{portfolioLabel}</strong></div>
            </div>
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

            {/* CMP Interactive Panel */}
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-150 px-3 py-1.5 rounded-xl mt-1">
              <span className="text-[10px] uppercase font-black text-slate-400">CMP</span>
              {isEditingCmp ? (
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    step="0.01"
                    value={cmpInputVal}
                    onChange={(e) => setCmpInputVal(e.target.value)}
                    className="w-20 px-1 py-0.5 border border-indigo-400 text-xs font-mono font-bold text-right outline-none rounded bg-white"
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
                    className="bg-slate-200 hover:bg-slate-350 text-slate-600 font-black text-[9px] px-1.5 py-0.5 rounded cursor-pointer"
                    id="cancel-cmp-btn"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-black font-mono text-slate-850" id="cmp-display-price">
                    {formatINR(cmpPrice)}
                  </span>
                  <span className={`text-[10px] font-black ${changePct >= 0 ? 'text-emerald-700' : 'text-rose-700'}`} id="cmp-price-percentage">
                    ({changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%)
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Dynamic Dual-Container Grid Stats Card cluster */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" id="stock-detail-stats-grid">
          
          {/* Container 1: Position details */}
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 grid grid-cols-3 gap-y-4 divide-x divide-slate-150 relative" id="holding-metrics-panel">
            <div className="absolute top-3 left-3 bg-indigo-50/70 border border-indigo-100 text-indigo-805 text-[8px] font-black tracking-widest uppercase px-1.5 py-0.5 rounded">
              Position size
            </div>
            
            <div className="pl-0 pr-4 pt-4 space-y-4">
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider block">Holding Qty.</span>
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="text-base font-black font-mono text-slate-800" id="detail-holding-qty">
                    {formatNum(finalHoldingQty)}
                  </span>
                  <span className="bg-sky-50 border border-sky-100 text-sky-700 font-bold text-[9px] px-1.5 py-0.5 rounded flex items-center gap-0.5" title="Long Term Locked blocks">
                    <ShieldCheck className="w-2.5 h-2.5" /> LT {formatNum(Math.round(finalHoldingQty * 0.81))}
                  </span>
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
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 grid grid-cols-3 gap-y-4 divide-x divide-slate-150 relative" id="returns-metrics-panel">
            <div className="absolute top-3 left-3 bg-emerald-50/70 border border-emerald-100 text-emerald-850 text-[8px] font-black tracking-widest uppercase px-1.5 py-0.5 rounded">
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
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider block">Unrealized Gain</span>
                <div className="flex items-center justify-between gap-1">
                  <span className={`text-sm font-black font-mono truncate ${unrealizedGain >= 0 ? 'text-emerald-700' : 'text-rose-700'}`} id="detail-unrealized-gain">
                    {unrealizedGain >= 0 ? '+' : ''}{formatINR(unrealizedGain)}
                  </span>
                  <button className="bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-400 hover:text-indigo-600 rounded p-0.5 cursor-pointer shrink-0 transition-colors" title="Sync unrealized snapshot to Ledger">
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
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
                <div className="flex items-center justify-between gap-1">
                  <span className={`text-sm font-black font-mono truncate ${realisedGain >= 0 ? 'text-emerald-700' : 'text-rose-700'}`} id="detail-realised-gain">
                    {realisedGain >= 0 ? '+' : ''}{formatINR(realisedGain)}
                  </span>
                  <button className="bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-400 hover:text-indigo-600 rounded p-0.5 cursor-pointer shrink-0 transition-colors" title="Export matching block details">
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            <div className="pl-5 pt-4 space-y-3">
              <div className="space-y-1">
                <span className="text-[10px] text-transparent select-none font-black uppercase block">_</span>
                <span className="text-sm font-black text-transparent select-none block">_</span>
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
          <div className="flex border-b border-slate-200 bg-slate-50 px-4">
            <button
              onClick={() => setActiveDetailTab('trade_book')}
              className={`px-4 py-3 text-xs font-black tracking-tight border-b-2 cursor-pointer transition-all ${
                activeDetailTab === 'trade_book' 
                  ? 'border-indigo-650 text-indigo-700 font-bold' 
                  : 'border-transparent text-slate-500 hover:text-slate-805'
              }`}
              id="tab-trade-book"
            >
              Trade Book
            </button>
            <button
              onClick={() => setActiveDetailTab('inventory')}
              className={`px-4 py-3 text-xs font-black tracking-tight border-b-2 cursor-pointer transition-all ${
                activeDetailTab === 'inventory' 
                  ? 'border-indigo-650 text-indigo-700 font-bold' 
                  : 'border-transparent text-slate-500 hover:text-slate-805'
              }`}
              id="tab-inventory"
            >
              Inventory (Cost Lots)
            </button>
            <button
              onClick={() => setActiveDetailTab('realised_inventory')}
              className={`px-4 py-3 text-xs font-black tracking-tight border-b-2 cursor-pointer transition-all ${
                activeDetailTab === 'realised_inventory' 
                  ? 'border-indigo-650 text-indigo-700 font-bold' 
                  : 'border-transparent text-slate-500 hover:text-slate-805'
              }`}
              id="tab-realised-inventory"
            >
              Realised Inventory
            </button>
          </div>

          <div className="p-4 bg-slate-50/50 border-b border-slate-150 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="relative max-w-xs w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input
                type="text"
                placeholder="Search ledger details..."
                value={txSearchTerm}
                onChange={(e) => setTxSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 border border-slate-205 rounded-lg outline-none text-xs bg-white focus:ring-1 focus:ring-indigo-500 font-medium"
                id="tab-search-input"
              />
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
              <div className="py-24 flex flex-col items-center justify-center gap-3 animate-pulse" id="transactions-loading-spinner">
                <RefreshCw className="w-8 h-8 text-indigo-650 animate-spin" />
                <span className="text-xs text-slate-500 font-bold uppercase tracking-wider select-none">Syncing ledger records live...</span>
              </div>
            ) : (
              <>
                {activeDetailTab === 'trade_book' && (
                  <table className="w-full text-xs text-left" id="trade-book-table">
                    <thead className="bg-[#f8fafc] border-b border-slate-205 font-bold text-slate-600 uppercase tracking-wider">
                      <tr>
                        <th className="px-6 py-3">DATE</th>
                        <th className="px-6 py-3">TRANSACTION TYPE</th>
                        <th className="px-6 py-3 text-right">QUANTITY</th>
                        <th className="px-6 py-3 text-right">PRICE</th>
                        <th className="px-6 py-3 text-right">BROKERAGE</th>
                        <th className="px-6 py-3 text-right">AMOUNT</th>
                        <th className="px-6 py-3 text-right">BAL QTY</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-150">
                      {filteredTxs.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-6 py-12 text-center text-slate-400 italic font-medium">
                            No matching ledger line items found.
                          </td>
                        </tr>
                      ) : (
                        filteredTxs.map((t, idx) => {
                          const type = t.transactionType.toUpperCase();
                          const isBuy = type.includes("BUY") || type.includes("RIGHT") || type.includes("PAID") || type === "PARTLY PAID";
                          const isSell = type.includes("SELL");
                          const isDiv = type.includes("DIVIDEND");
                          
                          return (
                            <tr key={idx} className="hover:bg-slate-50/50 transition-colors">
                              <td className="px-6 py-3.5 font-medium text-slate-600">{t.tradeDate}</td>
                              <td className="px-6 py-3.5">
                                <span className={`inline-block px-2.5 py-0.5 rounded-[6px] text-[10px] font-black border tracking-wider select-none ${
                                  isBuy ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                                  isSell ? 'bg-rose-50 text-rose-800 border-rose-200' :
                                  isDiv ? 'bg-amber-50 text-amber-800 border-amber-200' :
                                  'bg-slate-50 text-slate-800 border-slate-200'
                                }`}>
                                  {t.transactionType}
                                </span>
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono font-bold text-slate-700">
                                {isDiv ? '0' : formatNum(t.quantity)}
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono text-slate-500">
                                {isDiv ? '—' : formatINR(t.price)}
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono text-slate-400">
                                {formatINR(t.brokerage)}
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono font-bold text-slate-850">
                                {formatINR(t.amount)}
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono text-slate-450 border-l border-slate-50">
                                {t.balanceQuantity !== undefined ? formatNum(t.balanceQuantity) : '—'}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                )}

                {activeDetailTab === 'inventory' && (
                  <table className="w-full text-xs text-left" id="inventory-cost-lots-table">
                    <thead className="bg-[#f8fafc] border-b border-slate-205 font-bold text-slate-600 uppercase tracking-wider">
                      <tr>
                        <th className="px-6 py-3">LOT PURCHASE DATE</th>
                        <th className="px-6 py-3 text-right">QUANTITY HELD</th>
                        <th className="px-6 py-3 text-right">PURCHASE PRICE</th>
                        <th className="px-6 py-3 text-right">ORIGINAL COST</th>
                        <th className="px-6 py-3 text-right">CURRENT VALUE</th>
                        <th className="px-6 py-3 text-right">UNREALIZED PROFIT/LOSS</th>
                        <th className="px-6 py-3 text-right">LOT AGE (DAYS)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-150">
                      {filteredInventory.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-6 py-12 text-center text-slate-400 italic font-medium">
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

                          return (
                            <tr key={idx} className="hover:bg-slate-50/50 transition-colors">
                              <td className="px-6 py-3.5 font-medium text-slate-600">{lot.date}</td>
                              <td className="px-6 py-3.5 text-right font-mono font-bold text-slate-700">
                                {formatNum(lot.remainingQty)} <span className="text-[10px] text-slate-400 font-normal">/ {formatNum(lot.quantity)}</span>
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono text-slate-500">
                                {formatINR(lot.price)}
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono text-slate-705">
                                {formatINR(lotCost)}
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono font-bold text-slate-800">
                                {formatINR(lotValue)}
                              </td>
                              <td className={`px-6 py-3.5 text-right font-mono font-black ${isPos ? 'text-emerald-700' : 'text-rose-700'}`}>
                                {isPos ? '+' : ''}{formatINR(lotGain)}
                              </td>
                              <td className="px-6 py-3.5 text-right font-mono text-slate-550">
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
                    <thead className="bg-[#f8fafc] border-b border-slate-205 font-bold text-slate-600 uppercase tracking-wider">
                      <tr>
                        <th className="px-6 py-3">SELL DATE</th>
                        <th className="px-6 py-3">MATCHED BUY DATE</th>
                        <th className="px-6 py-3 text-right">QUANTITY SOLD</th>
                        <th className="px-6 py-3 text-right">AVG BUY PRICE</th>
                        <th className="px-6 py-3 text-right">SELLING PRICE</th>
                        <th className="px-6 py-3 text-right">REALISED GAIN/LOSS</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-150">
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
                              <td className="px-6 py-3.5 font-medium text-slate-650">{r.sellDate}</td>
                              <td className="px-6 py-3.5 text-slate-500 font-medium">{r.buyDate}</td>
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
      </div>
    );
  };

  const getPortfolioSummary = (id: string) => {
    if (id !== 'local') {
      // Every configured portfolio shows real numbers only — no demo placeholders.
      // Invested = that portfolio's own synced Holding-tab total (from the
      // per-portfolio map), so each card is independent. Shows 0 until synced.
      const p = portfolioById(id);
      const invested = portfolioTotals[id] ?? 0;
      return {
        name: p?.label ?? id.toUpperCase(),
        subtext: p ? `${p.label} - ${p.code}` : id,
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
        onSaved={(pid) => { if (pid === activePortfolio) fetchSheetHoldings(pid, true); }}
      />
      {lastPriceUpdate && (
        <div className="flex justify-end">
          <span className="text-[11px] text-slate-400">
            CMP last updated: <span className="font-semibold text-slate-500">{lastPriceUpdate}</span> IST
          </span>
        </div>
      )}
      {!isDetailView ? (
        <div id="portfolio-selection-panel" className="bg-white border border-slate-200/90 rounded-2xl shadow-sm overflow-hidden animate-fadeIn">
          <div className="p-5 border-b border-slate-100 bg-slate-50/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h4 className="text-sm font-black text-slate-800 tracking-tight flex items-center gap-1.5 uppercase">
                <Compass className="w-4 h-4 text-indigo-650" /> Account Portfolios Summary
              </h4>
              <p className="text-[11px] text-slate-400">
                Click on any account portfolio below to open its dedicated live ledger page and scan full metrics.
              </p>
            </div>
          </div>
          
          <div className="p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-2 gap-3">
            {PORTFOLIOS.map((p) => {
              const id = p.id;
              const summary = getPortfolioSummary(id);
              const isPositiveGain = summary.unrealisedGain >= 0;
              const isPositiveToday = summary.todaysGain >= 0;
              const cg = capGainsSyncStatus?.pid === id ? capGainsSyncStatus : null;
              const rb = holdingRebuildStatus?.pid === id ? holdingRebuildStatus : null;
              const trx = trxStatus?.pid === id ? trxStatus : null;
              const anyBusy = isLoadingSheet || isSyncingCapGains || isRebuildingHolding || isGeneratingTrx || !!downloadingFor || !!migratingFor;
              const stop = (e: React.MouseEvent) => e.stopPropagation();
              return (
                <div
                  key={id}
                  onClick={() => { setActivePortfolio(id); setSelectedStock(null); setIsDetailView(true); }}
                  className="group rounded-xl border border-slate-200 bg-white hover:border-indigo-300 hover:shadow-sm transition-all cursor-pointer overflow-hidden flex flex-col"
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
                      <span className="font-mono font-black text-slate-900 text-base">{formatValueOnly(summary.currentValue)}</span>
                      <span className={`text-xs font-bold ${isPositiveGain ? 'text-emerald-700' : 'text-rose-600'}`}>
                        {isPositiveGain ? '▲' : '▼'} {isPositiveGain ? '+' : ''}{summary.unrealisedGainPct.toFixed(2)}%
                      </span>
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
                      aria-label="Financial year for the transaction register"
                      title="Financial year for the transaction register"
                      className="text-[10px] font-bold text-slate-700 bg-white border border-slate-200 rounded-md px-1 py-1 outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer disabled:opacity-50"
                    >
                      {fyOptions.map((y) => (
                        <option key={y} value={y}>{`FY${String(y).slice(2)}-${String(y + 1).slice(2)}`}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => generateTrx(id)} disabled={anyBusy}
                      aria-label="Generate transaction register" title="Generate the scrip-wise FY transaction register (opening → purchases → sales → closing) as a new tab"
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
                    <button
                      onClick={() => migrateSheets(id)} disabled={anyBusy}
                      aria-label="Clean up ledger (drop ISIN, fix dates)" title="One-time cleanup: drop the ISIN column + convert Trade Dates to real dates (for pivots)"
                      className="p-1.5 bg-slate-100 border border-slate-200 text-slate-700 hover:bg-slate-200 rounded-md transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <Wrench className={`w-3.5 h-3.5 ${migratingFor === id ? 'animate-pulse' : ''}`} />
                    </button>

                    {cg && (cg.success ? (
                      <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-lg">
                        ✓ STCG ₹{(cg.stcg || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })} · LTCG ₹{(cg.ltcg || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-1 rounded-lg" title={cg.error}>✗ Capital gains failed</span>
                    ))}
                    {rb && (rb.result ? (
                      <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-lg" title={`${rb.result.tradeRows} trades replayed`}>
                        ✓ {rb.result.positions} positions · ₹{rb.result.totalInvested.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-1 rounded-lg" title={rb.error}>✗ Rebuild failed</span>
                    ))}
                    {trx && (trx.result ? (
                      <span className="text-[10px] font-bold text-violet-700 bg-violet-50 border border-violet-200 px-2 py-1 rounded-lg" title={`Wrote tab "${trx.result.tabName}" — ${trx.result.buyRows} buys · ${trx.result.sellRows} sells`}>
                        ✓ {trx.result.fyLabel} · {trx.result.scrips} scrips
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-1 rounded-lg" title={trx.error}>✗ Register failed</span>
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
                <p className="text-xs text-slate-450 font-medium">
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
                    className="px-4 py-2 bg-indigo-55 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> Open Google Sheet
                  </a>
                  {lastSyncedAt && (
                    <span className="text-[10px] font-semibold text-slate-500 bg-slate-50 border border-slate-200 px-2 py-1 rounded-lg" title="Holdings auto-refresh from the sheet every 2 minutes">
                      Auto-sync · {lastSyncedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  <span className="text-[10px] text-slate-400 font-medium">Sync / Rebuild / Download moved to the Holdings summary page</span>
                </>
              ) : (
                <div className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-110 px-3 py-1.5 rounded-full">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-450 opacity-75"></span>
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
                  <div className="p-2.5 bg-amber-105 text-amber-800 rounded-xl mt-0.5 shrink-0">
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
                  className="px-4 py-2 bg-indigo-650 hover:bg-slate-900 text-white font-black text-xs rounded-xl shadow-xs uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 shrink-0 select-none cursor-pointer"
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
                  <span className={`text-[10px] font-black uppercase tracking-widest ${getPortfolioSummary(activePortfolio).unrealisedGain >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>Unrealized profit/gain</span>
                  <span className={`text-xl font-bold font-mono mt-1 ${getPortfolioSummary(activePortfolio).unrealisedGain >= 0 ? 'text-emerald-800' : 'text-rose-800'}`}>
                    {getPortfolioSummary(activePortfolio).unrealisedGain >= 0 ? '+' : ''}₹{getPortfolioSummary(activePortfolio).unrealisedGain.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div className={`p-4 rounded-xl border shadow-sm flex flex-col justify-between min-h-[90px] ${getPortfolioSummary(activePortfolio).todaysGain >= 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'}`}>
                  <span className={`text-[10px] font-black uppercase tracking-widest ${getPortfolioSummary(activePortfolio).todaysGain >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>Today's yield / gain</span>
                  <span className={`text-xl font-bold font-mono mt-1 ${getPortfolioSummary(activePortfolio).todaysGain >= 0 ? 'text-emerald-850' : 'text-rose-850'}`}>
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
                      className="w-full pl-9 pr-4 py-2.5 text-xs rounded-xl border border-slate-200 focus:ring-1 focus:ring-indigo-500 outline-none"
                    />
                  </div>
                  {activePortfolio === 'local' ? (
                    <button
                      onClick={() => setShowAddForm(prev => !prev)}
                      className="px-4 py-2.5 bg-slate-900 border border-slate-900 hover:bg-slate-800 text-white font-black text-xs rounded-xl transition-all flex items-center gap-1 cursor-pointer shrink-0 shadow-sm"
                    >
                      <Plus className="w-4 h-4 font-bold" /> Record Manual Asset
                    </button>
                  ) : (
                    <button
                      onClick={() => setShowAddTrade(true)}
                      className="px-4 py-2.5 bg-slate-900 border border-slate-900 hover:bg-slate-800 text-white font-black text-xs rounded-xl transition-all flex items-center gap-1.5 cursor-pointer shrink-0 shadow-sm"
                    >
                      <Plus className="w-4 h-4 font-bold" /> Add Trade
                    </button>
                  )}
                </div>

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
                        className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl cursor-pointer transition-colors"
                      >
                        Log Field Position
                      </button>
                    </div>
                  </form>
                )}

                {/* Live spreadsheet synchronization loaders */}
                {isLoadingSheet ? (
                  <div className="py-20 text-center space-y-3">
                    <RefreshCw className="w-10 h-10 text-indigo-600 animate-spin mx-auto" />
                    <p className="text-xs font-black text-slate-500 animate-pulse">Loading holdings ledger values...</p>
                  </div>
                ) : sheetError ? (
                  <div className="p-8 bg-rose-50 border border-rose-150 rounded-2xl text-center space-y-4 max-w-md mx-auto my-4 animate-scaleIn">
                    <AlertTriangle className="w-10 h-10 text-rose-650 mx-auto" />
                    <div>
                      <h5 className="font-bold text-rose-900 text-sm">Synchronisation Interrupted</h5>
                      <p className="text-xs text-rose-700 mt-1">{sheetError}</p>
                    </div>
                    <div className="flex items-center justify-center gap-2">
                      {!hasAuthorizedGoogle() && (
                        <button
                          onClick={() => login()}
                          className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-lg shadow-sm cursor-pointer transition-colors"
                        >
                          Reconnect Google Sheets
                        </button>
                      )}
                      <button
                        onClick={() => fetchSheetHoldings(activePortfolio as string)}
                        className="px-5 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs rounded-lg shadow-sm cursor-pointer transition-colors"
                      >
                        Try Re-fetching
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="overflow-x-auto border border-slate-200 rounded-2xl">
                    <table className="w-full text-xs text-left whitespace-nowrap">
                      <thead className="bg-[#f8fafc] border-b border-slate-200 font-extrabold text-slate-650 uppercase tracking-wider select-none">
                        <tr>
                          <th className="px-6 py-4">
                            Security Name
                          </th>
                          <th className="px-6 py-4 text-right cursor-pointer hover:bg-slate-100" onClick={() => requestSort('quantity')}>
                            <div className="flex items-center justify-end gap-1">
                              Shares Qty <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
                            </div>
                          </th>
                          <th className="px-6 py-4 text-right cursor-pointer hover:bg-slate-100" onClick={() => requestSort('avgCost')}>
                            <div className="flex items-center justify-end gap-1">
                              Avg Buy Price <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
                            </div>
                          </th>
                          <th className="px-6 py-4 text-right">
                            Current Price
                          </th>
                          <th className="px-6 py-4 text-right cursor-pointer hover:bg-slate-100" onClick={() => requestSort('currentValue')}>
                            <div className="flex items-center justify-end gap-1">
                              Current Value <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
                            </div>
                          </th>
                          <th className="px-6 py-4 text-right cursor-pointer hover:bg-slate-100" onClick={() => requestSort('profit')}>
                            <div className="flex items-center justify-end gap-1">
                              Unrealisled Profit/Gain <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
                            </div>
                          </th>
                          {activePortfolio === 'local' && (
                            <th className="px-6 py-4 text-center">Settings</th>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-150">
                        {sortedHoldings.map((h) => {
                          const isPositive = h.unrealizedGain >= 0;

                          return (
                            <tr
                              key={h.id}
                              onClick={(e) => {
                                const target = e.target as HTMLElement;
                                if (target.closest('button') || target.closest('input') || target.closest('select')) return;

                                setSelectedStock(h.original);
                                setCustomCmp(null);
                                fetchTransactionsForStock(h.original.companyName || h.original.name, h.original.isin);
                              }}
                              className="hover:bg-slate-50/80 cursor-pointer transition-colors"
                            >
                              <td className="px-6 py-4">
                                <span className="font-bold text-slate-800 block truncate max-w-[260px]" title={h.name}>
                                  {h.name}
                                </span>
                                <span className="font-mono text-[9px] text-slate-400 select-all leading-none mt-1 block">{h.isin}</span>
                              </td>

                              <td className="px-6 py-4 text-right font-mono font-bold text-slate-700">
                                {formatNum(h.quantity)}
                              </td>

                              <td className="px-6 py-4 text-right font-mono text-slate-505">
                                {formatINR(h.avgCost)}
                              </td>

                              <td className="px-6 py-4 text-right select-none font-mono">
                                {editingPriceId === h.id ? (
                                  <div className="flex items-center justify-end gap-1.5">
                                    <input
                                      type="number"
                                      step="0.01"
                                      value={editingPriceValue}
                                      onChange={(e) => setEditingPriceValue(e.target.value)}
                                      className="w-20 px-1 py-0.5 rounded outline-none border border-indigo-400 text-xs text-right font-mono bg-white"
                                      autoFocus
                                    />
                                    <button
                                      onClick={() => handleSavePriceEdit(h.id)}
                                      className="bg-indigo-600 hover:bg-emerald-600 font-extrabold text-[10px] text-white px-1.5 py-0.5 rounded shadow cursor-pointer"
                                    >
                                      Save
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex items-center justify-end gap-1">
                                    <span className="text-slate-750 font-bold">
                                      {formatINR(h.currentPrice)}
                                    </span>
                                  </div>
                                )}
                              </td>

                              <td className="px-6 py-4 text-right font-mono font-extrabold text-slate-900">
                                {formatINR(h.currentValue)}
                              </td>

                              <td className={`px-6 py-4 text-right font-mono font-bold ${isPositive ? 'text-emerald-700' : 'text-rose-700'}`}>
                                <div>
                                  {isPositive ? '+' : ''}{formatINR(h.unrealizedGain)}
                                </div>
                                <div className="text-[10px] font-semibold block">
                                  {isPositive ? '+' : ''}{h.unrealizedGainPct.toFixed(2)}%
                                </div>
                              </td>

                              {activePortfolio === 'local' && (
                                <td className="px-6 py-4 text-center">
                                  <button
                                    onClick={() => handleDeleteHolding(h.id, h.name)}
                                    className="p-1 px-1.5 hover:bg-rose-55 text-slate-400 hover:text-rose-600 border border-transparent rounded transition-colors cursor-pointer"
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
                            <td colSpan={10} className="py-12 text-center text-slate-405 italic text-xs">
                              No matching asset holdings found in this portfolio view.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }