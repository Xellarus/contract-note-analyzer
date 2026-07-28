import { gapi } from "gapi-script";
import React, { useState, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { 
  Upload, X, Download, FileText, Info, CheckCircle2, AlertCircle, 
  ArrowRightLeft, ListChecks, Play, Trash2, PlusCircle, AlertTriangle, 
  RefreshCw, Check, ShieldAlert, Award, ChevronRight, Gauge,
  Menu, ChevronDown, BookOpen, Calculator, ArrowDown, ArrowUp, ArrowUpDown, BarChart3,
  Briefcase, ShieldCheck
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useGoogleLogin } from '@react-oauth/google';
import { ContractNoteResult, ReconciliationStatus, PortfolioHolding, PortfolioUser } from './types';
import { persistGoogleToken, restoreGoogleToken, clearGoogleToken, hasValidGoogleToken } from './lib/googleAuth';
import { installSheetsRetry } from './lib/sheetsRetry';
import { logAccess, logImport } from './lib/accessLog';
import { rebuildHoldingTab, syncCapitalGains } from './lib/holdingsCalc';
import { ensureSheetTabs } from './lib/sheetTabs';
import { normName, loadScripMaster, lookupScrip, SCRIP_MASTER_SPREADSHEET_ID, ScripMaster } from './lib/scripMaster';
import { mapRecordsToHeader, headerKey, toIsoDate } from './lib/tradeRowSchema';
import { PORTFOLIOS, portfolioByUcc, portfolioById, sheetIdForId, DEFAULT_PORTFOLIO_ID } from './lib/portfolios';
import SecurityConfirmModal, { ConfirmSecurity } from './components/SecurityConfirmModal';
import { toast, confirmDialog } from './components/ui/overlay';
import { useVirtualRows } from './components/ui/useVirtualRows';
import CubeLoader from './components/ui/CubeLoader';
import ThemeToggle from './components/ui/ThemeToggle';
import { processFile, mergeResults, calculateReconciliation } from './lib/parsers';
import sessionVaultSvg from './assets/session-vault.svg?url';
import CsvAuditor from './components/CsvAuditor';
import Dashboard from './components/Dashboard';
import Holdings from './components/Holdings';
import ImportHistory from './components/ImportHistory';
import Login from './components/Login';
import Reports, { StockFocus } from './components/Reports';
import ScreenerImport from './components/ScreenerImport';
import OpeningBasisImport from './components/OpeningBasisImport';
import LiveClock from './components/LiveClock';
import { seedRegressionCases, runRegressionTests, RegressionTestCase, TestResult } from './lib/regressionMemory';

const SummaryCard = ({ 
  label, 
  value, 
  highlight = false, 
  alertState = false, 
  labelStyle = {}, 
  minFractionDigits = 2, 
  maxFractionDigits = 2 
}: { 
  label: string, 
  value: number, 
  highlight?: boolean, 
  alertState?: boolean, 
  labelStyle?: React.CSSProperties, 
  minFractionDigits?: number, 
  maxFractionDigits?: number 
}) => (
  <div className={`p-4 rounded-xl border transition-all ${alertState ? 'bg-rose-50 border-rose-200' : highlight ? 'bg-indigo-50 border-indigo-200' : 'bg-white border-slate-200'} shadow-sm`}>
    <p 
      style={labelStyle}
      className={`text-xs font-semibold uppercase tracking-wider ${alertState ? 'text-rose-600' : highlight ? 'text-indigo-600' : 'text-slate-500'}`}
    >
      {label}
    </p>
    <p className={`text-lg font-bold mt-1 font-mono ${alertState ? 'text-rose-900' : highlight ? 'text-indigo-900' : 'text-slate-900'}`}>
      {value.toLocaleString('en-IN', { minimumFractionDigits: minFractionDigits, maximumFractionDigits: maxFractionDigits })}
    </p>
  </div>
);

const MAX_FILES = 31;

// Best-effort trade date from a contract-note file name (broker files normally
// carry it: "..._2024-05-03.pdf", "NJW724-03-05-2024.pdf", "20240503.pdf", …).
// → epoch ms, or 0 when no recognisable date. Used only to order an over-limit
// selection and label the cut-off — parsing the PDFs themselves would defeat
// the point of warning *before* the heavy work.
const dateFromFileName = (name: string): number => {
  let m = name.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/);          // yyyy mm dd
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(y, mo - 1, d).getTime();
  }
  m = name.match(/(\d{2})[-_.](\d{2})[-_.](20\d{2})/);                // dd mm yyyy
  if (m) {
    const d = +m[1], mo = +m[2], y = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(y, mo - 1, d).getTime();
  }
  return 0;
};

export default function App() {
  useEffect(() => {
    try {
      // Record a "session resumed" row when a saved token is reused on load.
      const logResume = () => {
        try {
          const u = JSON.parse(localStorage.getItem('portfolio_user') || 'null');
          if (u?.email) logAccess('resume', u);
        } catch { /* ignore */ }
      };
      if (typeof gapi !== 'undefined' && gapi && gapi.load) {
        gapi.load("client:auth2", () => {
          try {
            const clientIDFromEnv = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || "";
            const googleClientId = clientIDFromEnv.includes(".apps.googleusercontent.com")
              ? clientIDFromEnv
              : "1234567890-mockclientid.apps.googleusercontent.com";

            gapi.client.init({
              apiKey: "",
              clientId: googleClientId,
              scope: "https://www.googleapis.com/auth/spreadsheets",
              discoveryDocs: [
                "https://sheets.googleapis.com/$discovery/rest?version=v4",
              ],
            }).then(() => {
              // Discovery doc is loaded now → wrap the Sheets API with auto-retry +
              // backoff so a transient per-minute quota (429) self-recovers instead of
              // surfacing "Synchronisation Interrupted".
              installSheetsRetry();
              // Reuse a still-valid token from a previous session so the user
              // doesn't have to reconnect Sheets after every page reload.
              if (restoreGoogleToken()) logResume();
            }).catch((err: any) => {
              console.warn("Gapi initialization rejection: ", err);
              installSheetsRetry();
              if (restoreGoogleToken()) logResume();
            });
          } catch (err) {
            console.warn("Gapi internal setup fail: ", err);
          }
        });
      }
    } catch (e) {
      console.warn("Gapi element load exception: ", e);
    }
  }, []);

  const [isImportingToSheets, setIsImportingToSheets] = useState(false);
  const [sheetsImportStatus, setSheetsImportStatus] = useState<{ success?: boolean; error?: string } | null>(null);
  // Post-upload security-name confirmation popup (Integrated notes carry ISIN)
  const [securityConfirm, setSecurityConfirm] = useState<{ master: ScripMaster; securities: ConfirmSecurity[] } | null>(null);
  // File name(s) of the most recently uploaded contract note(s), for the import log.
  const [uploadedNoteNames, setUploadedNoteNames] = useState<string[]>([]);

  const importToSheets = async () => {
    if (!data) {
      toast.error("No parsed contract note data available to import.");
      return;
    }

    const token = gapi.client.getToken();
    if (!token || !token.access_token) {
      const confirmConnect = await confirmDialog({
        title: 'Connect Google Sheets?',
        body: 'Importing requires Google Sheets access. Authorize with Google now?',
        confirmLabel: 'Connect',
      });
      if (confirmConnect) {
        login();
      }
      return;
    }

    setIsImportingToSheets(true);
    setSheetsImportStatus(null);

    try {
      const uccUpper = (data.ucc || "").trim().toUpperCase();
      // Transaction reports have no UCC — route by the user's explicit pick.
      // Contract notes carry their UCC, so keep auto-routing for those.
      const isTxnReport = data.brokerName === 'transaction-report';
      // Auto-route by the note's UCC; when it doesn't resolve (e.g. Zerodha notes
      // carry no UCC) fall back to the user's manual destination pick.
      const portfolioKey = isTxnReport
        ? txnReportPortfolio
        : (portfolioByUcc(uccUpper)?.id ?? txnReportPortfolio);
      const spreadsheetId = sheetIdForId(portfolioKey);
      // Create any missing required tabs. Case-insensitive and one request per
      // tab — previously an existing tab with different casing made the whole
      // batched creation fail, so the "Holding" tab silently never got created.
      const requiredSheets = ["Raw Entry", "True Entry", "Holding"];
      try {
        await ensureSheetTabs(spreadsheetId, requiredSheets);
      } catch (createErr) {
        console.error("Failed to create missing sheet tabs:", createErr);
      }

      let existingSheetsMeta: any[] = [];
      try {
        const spreadsheetMeta = await (gapi.client as any).sheets.spreadsheets.get({
          spreadsheetId: spreadsheetId,
        });
        existingSheetsMeta = spreadsheetMeta?.result?.sheets || [];
      } catch (metaErr) {
        console.warn("Failed to fetch spreadsheet metadata:", metaErr);
      }

      // Check if Raw Entry sheet has protection (locking), and add it if missing
      const rawEntrySheet = existingSheetsMeta.find((s: any) => s.properties.title === "Raw Entry");
      if (rawEntrySheet) {
        const rawEntrySheetId = rawEntrySheet.properties.sheetId;
        const hasProtection = rawEntrySheet.protectedRanges && rawEntrySheet.protectedRanges.some((p: any) => {
          return p.range && p.range.sheetId === rawEntrySheetId;
        });

        if (!hasProtection) {
          try {
            await (gapi.client as any).sheets.spreadsheets.batchUpdate({
              spreadsheetId: spreadsheetId,
              resource: {
                requests: [
                  {
                    addProtectedRange: {
                      protectedRange: {
                        range: {
                          sheetId: rawEntrySheetId
                        },
                        description: "Locked Raw Entry Sheet",
                        warningOnly: false,
                        editors: {
                          users: [],
                          groups: [],
                          domainUsersCanEdit: false
                        }
                      }
                    }
                  }
                ]
              }
            });
            console.log("Successfully locked 'Raw Entry' sheet tab!");
          } catch (protectErr) {
            console.error("Failed to lock 'Raw Entry' sheet tab:", protectErr);
          }
        }
      }

      const isIntegrated = data.brokerName === 'integrated';
      const showIpf = data.brokerName === 'integrated';

      const numDecimals = data.brokerName === 'shareindia' ? 4 : 2;
      const formatCSV = (val: number) => {
        const fixed = val.toFixed(numDecimals);
        if (numDecimals === 4) {
          if (fixed.endsWith('00')) return fixed.slice(0, -2);
          if (fixed.endsWith('0')) return fixed.slice(0, -1);
        }
        return fixed;
      };

      // Written only when a tab is still empty; existing tabs are written against
      // their own header (header-aware append below). ISIN is no longer written.
      const defaultHeader = [
        "Trade Date", "Stock Name", "Transaction Type", "Number of Shares", "Avg Price",
        "Total Amount (Turnover)", "Brokerage Per Share", "Total Brokerage", "STT",
        "Exchange Turnover Charges", "SEBI Turnover Fees", ...(showIpf ? ["IPF Charges"] : []),
        ...(isIntegrated ? ["Demat Charges"] : []), isIntegrated ? "Total GST" : "IGST",
        "Stamp Duty", "Total Expenses (incl STT)", "Total Expenses (excl STT)",
        "Total Amount with Expense (Incl STT)", "Total Amount with Expense (Excl STT)", "Trade Class",
        // Stamped on every row so an import can be rewound (delete exactly its
        // rows) later from the Import History view. Far-right, ignored by every
        // downstream reader that matches columns by name.
        "Import ID"
      ];

      // One id per import, written into the "Import ID" column of every row this
      // upload appends. The Import Log records it so a later "Rewind" can find
      // and delete precisely these rows.
      const importBatchId = `IMP-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`;

      // Resolve each security to its canonical name from the shared Scrip Master,
      // so the rows written to Raw Entry / True Entry carry the official name
      // (e.g. "Goodluck India Limited") rather than the raw parsed code ("GOODLUCK").
      // Memoized — the same security repeats across fills and across existing rows.
      let scripMaster: ScripMaster | null = null;
      try {
        scripMaster = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID);
      } catch (e) {
        console.warn("Could not load Scrip Master for name resolution — keeping parsed names:", e);
      }
      // Best-effort canonical DISPLAY name written to the sheet — same resolution
      // the confirmation popup uses (incl. unique token-subset), memoized.
      const nameCache = new Map<string, string>();
      const displayName = (isin: string, parsed: string): string => {
        const ck = (isin || "") + "\t" + (parsed || "");
        const hit = nameCache.get(ck);
        if (hit !== undefined) return hit;
        let out = parsed || "";
        if (scripMaster) {
          const entry = lookupScrip(scripMaster, (isin || "").trim(), parsed || "").entry;
          if (entry) out = entry.canonicalName;
        }
        nameCache.set(ck, out);
        return out;
      };
      // STABLE dedup identity (entry.key = isin || normName(canonicalName)), keyed
      // identically on the existing-row and new-row sides so a re-import never
      // duplicates/double-counts. EXACT match only — ISIN or exact normalized
      // name/alias, deliberately NOT token-subset — so two genuinely different
      // securities can never collapse to one key and silently drop a real trade.
      // Falls back to the uppercased ISIN, else the normalized name.
      const keyCache = new Map<string, string>();
      const dedupKey = (isin: string, name: string): string => {
        const code = (isin || "").trim().toUpperCase();
        const ck = code + "\t" + (name || "");
        const hit = keyCache.get(ck);
        if (hit !== undefined) return hit;
        let out = code || normName(name || "");
        if (scripMaster) {
          const e = (code && scripMaster.byIsin.get(code)) || scripMaster.byAliasNorm.get(normName(name || ""));
          if (e) out = e.key;
        }
        keyCache.set(ck, out);
        return out;
      };

      const records = data.trades.map(t => {
        const brokeragePerShare = t.quantity > 0 ? formatCSV(t.brokerage / t.quantity) : "0.00";
        const totalWithExpenseInclSTT = t.transactionType === "Buy"
          ? t.turnover + t.totalExpensesInclSTT
          : t.turnover - t.totalExpensesInclSTT;
        const totalWithExpenseExclSTT = t.transactionType === "Buy"
          ? t.turnover + t.totalExpensesExclSTT
          : t.turnover - t.totalExpensesExclSTT;

        return {
          date: toIsoDate(t.tradeDate || ""),
          name: displayName(t.isin || "", t.securityName || ""),
          txType: t.transactionType || "",
          qty: t.quantity,
          price: formatCSV(t.avgPrice),
          turnover: formatCSV(t.turnover),
          brokeragePerShare,
          brokerage: formatCSV(t.brokerage),
          stt: formatCSV(t.stt),
          exchangeCharges: formatCSV(t.etc),
          sebiFees: formatCSV(t.sebiFees),
          ipf: showIpf ? formatCSV(t.ipf) : "",
          dmat: isIntegrated ? formatCSV(t.dmat || 0) : "",
          gst: isIntegrated ? formatCSV(t.gst) : formatCSV(t.igst || t.gst),
          stampDuty: formatCSV(t.stampDuty),
          totalExpInclSTT: formatCSV(t.totalExpensesInclSTT),
          totalExpExclSTT: formatCSV(t.totalExpensesExclSTT),
          totalWithExpInclSTT: formatCSV(totalWithExpenseInclSTT),
          totalWithExpExclSTT: formatCSV(totalWithExpenseExclSTT),
          tradeClass: t.tradeType || "",
          importId: importBatchId,
          // Parsed ISIN kept for the dedup key only — not written to the sheet.
          _isin: t.isin || "",
        } as Record<string, any>;
      });

      // ── Dedup against existing True Entry so re-imports are idempotent ──
      // Numeric-normalize qty/price (Sheets strips trailing zeros, so the
      // written "960.10" reads back as "960.1") and ISO-normalize the date, so an
      // existing DD-MM-YYYY row still matches a new ISO row for the same fill.
      const numKey = (x: any) => {
        const v = parseFloat((x ?? "").toString().replace(/,/g, "").trim());
        return isNaN(v) ? (x ?? "").toString().trim() : String(v);
      };
      const rowKey = (date: any, type: any, id: string, qty: any, price: any) =>
        [toIsoDate((date ?? "").toString().trim()), (type ?? "").toString().trim().toUpperCase(), id, numKey(qty), numKey(price)].join("|");

      // Multiset of keys already present, so genuinely repeated same-day fills
      // are kept while an identical re-upload (or contract-note/report overlap)
      // is consumed and skipped.
      const remaining = new Map<string, number>();
      try {
        const existingRes = await (gapi.client as any).sheets.spreadsheets.values.get({
          spreadsheetId, range: "True Entry!A:T",
        });
        const exRows: any[][] = existingRes?.result?.values || [];
        if (exRows.length > 1) {
          const eh = exRows[0].map((h: any) => (h || "").toString().trim());
          const ci = (n: string, fb: number) => { const i = eh.indexOf(n); return i >= 0 ? i : fb; };
          // ISIN may be absent (column removed) — fall back to -1 (→ blank), never
          // to a positional guess that would misread another column as the ISIN.
          const di = ci("Trade Date", 0), ii = ci("ISIN", -1), ni = ci("Stock Name", 1), ti = ci("Transaction Type", 2), qi = ci("Number of Shares", 3), pi = ci("Avg Price", 4);
          for (let i = 1; i < exRows.length; i++) {
            const r = exRows[i]; if (!r || r.length === 0) continue;
            // Identify the existing row by the SAME stable key new rows use (entry
            // key from its ISIN/name), so a row previously written as "GOODLUCK" or
            // with a blank/absent ISIN still matches and isn't duplicated.
            const k = rowKey(r[di], r[ti], dedupKey(ii >= 0 ? r[ii] : "", r[ni]), r[qi], r[pi]);
            remaining.set(k, (remaining.get(k) || 0) + 1);
          }
        }
      } catch (e) {
        console.warn("Could not read True Entry for dedup — importing all rows:", e);
      }

      const newRecords: Record<string, any>[] = [];
      for (const rec of records) {
        const k = rowKey(rec.date, rec.txType, dedupKey(rec._isin, rec.name), rec.qty, rec.price);
        const have = remaining.get(k) || 0;
        if (have > 0) remaining.set(k, have - 1); // already present — skip
        else newRecords.push(rec);
      }
      const dupCount = records.length - newRecords.length;

      const entrySheets = ["Raw Entry", "True Entry"];
      for (const targetSheetName of entrySheets) {
        // Align rows to whatever header the tab already has, so omitting ISIN
        // never misaligns a sheet that still carries other columns; write
        // defaultHeader only when the tab is still empty.
        let header: string[] = [];
        try {
          const hRes = await (gapi.client as any).sheets.spreadsheets.values.get({
            spreadsheetId, range: `${targetSheetName}!A1:Z1`,
          });
          header = ((hRes?.result?.values?.[0] as any[]) || []).map((h) => (h ?? "").toString()).filter((h) => h.trim() !== "");
        } catch { /* treat as empty */ }
        const isSheetEmpty = header.length === 0;
        if (isSheetEmpty) {
          header = defaultHeader;
        } else {
          // Auto-migrate: append any columns this importer needs that the tab
          // doesn't have yet, to the END of the header (order is irrelevant —
          // every downstream reader matches by header name), then rewrite row 1.
          // Existing rows keep blank cells in the new columns.
          //  • "Import ID" — for every broker, so any import can be rewound.
          //  • IPF/Demat  — Integrated-only charge columns.
          const needed = ["Import ID", ...(isIntegrated ? ["IPF Charges", "Demat Charges"] : [])];
          const missing = needed.filter(n => !header.some(h => headerKey(h) === headerKey(n)));
          if (missing.length) {
            header = [...header, ...missing];
            await (gapi.client as any).sheets.spreadsheets.values.update({
              spreadsheetId, range: `${targetSheetName}!A1`,
              valueInputOption: "RAW", resource: { values: [header] },
            });
          }
        }

        const dataRows = mapRecordsToHeader(header, newRecords);
        const valuesToUpload: any[] = [];
        if (isSheetEmpty) valuesToUpload.push(header);
        valuesToUpload.push(...dataRows);

        if (valuesToUpload.length === 0) {
          console.log(`Sheet "${targetSheetName}": no new rows to append (all ${dupCount} already present).`);
          continue;
        }

        const appendResponse = await (gapi.client as any).sheets.spreadsheets.values.append({
          spreadsheetId: spreadsheetId,
          range: `${targetSheetName}!A:Z`,
          valueInputOption: "USER_ENTERED",
          resource: {
            values: valuesToUpload,
          },
        });
        console.log(`Sheet "${targetSheetName}" Updated Successfully:`, appendResponse);
      }

      // (The shared scrip list is curated in its own Google Sheet — the app
      // reads it live and does not auto-seed rows here. The upload-time
      // confirmation popup is how new securities get added.)

      // Recalculate Holdings from ALL rows in "True Entry"
      // (shared module: date-sorted replay, ISIN↔name merging — entry-only)
      let holdingWarning: string | null = null;
      try {
        const rebuild = await rebuildHoldingTab(spreadsheetId);
        console.log("Successfully recalculated and updated 'Holding' tab:", rebuild);
      } catch (holdingErr: any) {
        console.error("Failed to update 'Holding' tab:", holdingErr);
        holdingWarning = holdingErr?.result?.error?.message || holdingErr?.message || "Unknown error";
      }

      // Auto-sync capital gains too (FIFO STCG/LTCG → LTST + PnL Summary tabs), so
      // they stay current on every import without a manual click. Best-effort.
      let capGainsWarning: string | null = null;
      try {
        const cg = await syncCapitalGains(spreadsheetId);
        console.log("Successfully recalculated capital gains:", cg);
      } catch (cgErr: any) {
        console.error("Failed to sync capital gains:", cgErr);
        capGainsWarning = cgErr?.result?.error?.message || cgErr?.message || "Unknown error";
      }

      setSheetsImportStatus({ success: true });
      const targetName = `${portfolioById(portfolioKey)?.code ?? portfolioKey.toUpperCase()} Sheet`;
      const importLine = dupCount > 0
        ? `Imported ${newRecords.length} new row(s) to ${targetName}; skipped ${dupCount} already present.`
        : `Successfully imported ${newRecords.length} trade row(s) to 'Raw Entry' and 'True Entry' in ${targetName}!`;
      if (holdingWarning || capGainsWarning) {
        toast.error(
          importLine +
          (holdingWarning ? ` Warning: the 'Holding' tab could NOT be recalculated — ${holdingWarning}.` : "") +
          (capGainsWarning ? ` Warning: capital gains (LTST / PnL Summary) could NOT be recalculated — ${capGainsWarning}.` : "")
        );
      } else {
        toast.success(importLine);
      }

      // Record the import: Date | Time | Contract Note Name | Broker | User.
      const brokerLabel = ({
        zerodha: 'Zerodha', integrated: 'Integrated', shareindia: 'ShareIndia',
        standard: 'Standard', 'transaction-report': 'Transaction Report',
      } as Record<string, string>)[data.brokerName || ''] || (data.brokerName || 'Unknown');
      const noteName = uploadedNoteNames.length
        ? uploadedNoteNames.join(', ')
        : `${brokerLabel} note`;
      logImport({
        noteName, broker: brokerLabel, user: currentUser,
        // Only tag the log with a rewindable id when rows were actually written.
        importId: newRecords.length ? importBatchId : "",
        portfolioCode: portfolioById(portfolioKey)?.code || "",
        rows: newRecords.length,
      });
    } catch (err: any) {
      console.error("Sheets Import Error:", err);
      const errorMsg = err.result?.error?.message || err.message || "Unknown error";
      setSheetsImportStatus({ error: errorMsg });
      toast.error(`Sheets import failed: ${errorMsg}`);
    } finally {
      setIsImportingToSheets(false);
      setShowExportConfirmation(false);
    }
  };

  // Drives the auto re-login modal when the ~1h Google token lapses.
  const [sessionExpired, setSessionExpired] = useState(false);

  const login = useGoogleLogin({
    scope: "https://www.googleapis.com/auth/spreadsheets",
    onSuccess: (tokenResponse) => {
      persistGoogleToken(tokenResponse as any);
      setSessionExpired(false);
      // Re-auth / fresh Sheets grant — record it.
      try { logAccess('login', JSON.parse(localStorage.getItem('portfolio_user') || 'null')); } catch { /* ignore */ }
    },
    onError: () => {
      toast.error("Sheets login failed.");
    },
  });

  const [currentUser, setCurrentUser] = useState<PortfolioUser | null>(() => {
    // No auto-login bypass: a session is restored only from a previously-saved
    // Google sign-in. With nothing saved, currentUser stays null and the Login
    // page is shown — so the deployed app always requires signing in.
    try {
      const saved = localStorage.getItem('portfolio_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [currentView, setCurrentView] = useState<'dashboard' | 'holdings' | 'imports' | 'reports'>(() => {
    const saved = localStorage.getItem('portfolio_current_view');
    return (saved as any) || 'dashboard';
  });
  // When set (via the "Report" button on a stock's detail page), the Reports view
  // opens locked to that stock + account. Cleared when Reports is opened normally.
  const [reportsFocus, setReportsFocus] = useState<StockFocus | null>(null);

  const [activePortfolio, setActivePortfolio] = useState<string>(DEFAULT_PORTFOLIO_ID);
  const [isDetailView, setIsDetailView] = useState(false);

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Light/dark theme — persisted, defaults to the OS preference. Applied by
  // toggling a `dark` class on <html>, which activates the dark override layer
  // in index.css. Purely presentational; touches no parsing/calc logic.
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('theme');
      if (saved === 'dark' || saved === 'light') return saved;
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch { return 'light'; }
  });
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
  }, [theme]);

  // Google's OAuth token lapses ~hourly. Detect it proactively and pop a
  // one-click re-login, rather than letting Sheets calls quietly fail. (Skips
  // the guest dev-bypass user, who has no Sheets token.)
  useEffect(() => {
    if (!currentUser || currentUser.email === 'guest@saguncapital.com') return;
    const check = () => setSessionExpired(!hasValidGoogleToken());
    check();
    const id = setInterval(check, 30000);
    return () => clearInterval(id);
  }, [currentUser]);

  const [holdings, setHoldings] = useState<PortfolioHolding[]>(() => {
    const saved = localStorage.getItem('portfolio_holdings');
    if (saved) return JSON.parse(saved);
    return [
      {
        id: '1',
        symbol: 'HDFCBANK',
        name: 'HDFC Bank Limited',
        isin: 'INE040A01034',
        quantity: 400,
        avgCost: 1450,
        currentPrice: 1560,
        sector: 'Financial Services'
      },
      {
        id: '2',
        symbol: 'RELIANCE',
        name: 'Reliance Industries Limited',
        isin: 'INE002A01018',
        quantity: 250,
        avgCost: 2300,
        currentPrice: 2480,
        sector: 'Energy'
      },
      {
        id: '3',
        symbol: 'TCS',
        name: 'Tata Consultancy Services Limited',
        isin: 'INE467B01029',
        quantity: 100,
        avgCost: 3505,
        currentPrice: 3820,
        sector: 'IT & Tech'
      },
      {
        id: '4',
        symbol: 'INFY',
        name: 'Infosys Limited',
        isin: 'INE009A01021',
        quantity: 300,
        avgCost: 1380,
        currentPrice: 1450,
        sector: 'IT & Tech'
      }
    ];
  });

  const [cashBalance, setCashBalance] = useState<number>(() => {
    const saved = localStorage.getItem('portfolio_cash_balance');
    return saved ? parseFloat(saved) : 500000;
  });

  useEffect(() => {
    localStorage.setItem('portfolio_current_view', currentView);
  }, [currentView]);

  useEffect(() => {
    localStorage.setItem('portfolio_holdings', JSON.stringify(holdings));
  }, [holdings]);

  useEffect(() => {
    localStorage.setItem('portfolio_cash_balance', cashBalance.toString());
  }, [cashBalance]);

  const [activeTab, setActiveTab] = useState<'analyse' | 'audit' | 'tests'>('analyse');
  // Imports page sub-view: the upload/import flow vs. the import-history log.
  const [importPageTab, setImportPageTab] = useState<'import' | 'history' | 'screener' | 'opening'>('import');
  const [data, setData] = useState<ContractNoteResult | null>(null);
  const [showRawText, setShowRawText] = useState(false);
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' } | null>(null);
  const isShareIndia = data?.brokerName === 'shareindia';

  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'desc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'desc') {
      direction = 'asc';
    } else if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      setSortConfig(null);
      return;
    }
    setSortConfig({ key, direction });
  };

  const getSortedTrades = () => {
    if (!data) return [];
    if (!sortConfig) return data.trades;

    return [...data.trades].sort((a, b) => {
      let aVal: any = (a as any)[sortConfig.key];
      let bVal: any = (b as any)[sortConfig.key];

      if (sortConfig.key === 'totalInclSTT') {
        aVal = a.transactionType === "Buy" ? a.turnover + a.totalExpensesInclSTT : a.turnover - a.totalExpensesInclSTT;
        bVal = b.transactionType === "Buy" ? b.turnover + b.totalExpensesInclSTT : b.turnover - b.totalExpensesInclSTT;
      } else if (sortConfig.key === 'totalExclSTT') {
        aVal = a.transactionType === "Buy" ? a.turnover + a.totalExpensesExclSTT : a.turnover - a.totalExpensesExclSTT;
        bVal = b.transactionType === "Buy" ? b.turnover + b.totalExpensesExclSTT : b.turnover - b.totalExpensesExclSTT;
      } else if (sortConfig.key === 'gstOrIgst') {
        aVal = broker === 'integrated' ? a.gst : (a.igst || a.gst);
        bVal = broker === 'integrated' ? b.gst : (b.igst || b.gst);
      } else if (sortConfig.key === 'sebiAndIpf') {
        aVal = a.sebiFees + a.ipf;
        bVal = b.sebiFees + b.ipf;
      } else if (sortConfig.key === 'tradeDate') {
        const parseDate = (d: string) => {
          const parts = d.split(/[-/]/);
          if (parts.length === 3) {
            // Assume DD/MM/YYYY or DD-MMM-YYYY
            const monthStr = parts[1];
            const month = isNaN(Number(monthStr)) 
              ? new Date(Date.parse(monthStr +" 1, 2012")).getMonth() 
              : parseInt(monthStr) - 1;
            return new Date(parseInt(parts[2]), month, parseInt(parts[0])).getTime();
          }
          return new Date(d).getTime();
        };
        aVal = parseDate(a.tradeDate);
        bVal = parseDate(b.tradeDate);
      }

      if (aVal === bVal) return 0;
      
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortConfig.direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      
      const aNum = Number(aVal);
      const bNum = Number(bVal);
      if (isNaN(aNum) || isNaN(bNum)) {
         if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
         if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
         return 0;
      }

      return sortConfig.direction === 'asc' ? aNum - bNum : bNum - aNum;
    });
  };

  const SortableHeader = ({ label, sortKey, align = 'left', className = '', style = {} }: { label: string, sortKey: string, align?: 'left' | 'center' | 'right', className?: string, style?: React.CSSProperties }) => {
    const isActive = sortConfig?.key === sortKey;
    return (
      <th 
        style={style}
        className={`px-6 py-4 cursor-pointer hover:bg-slate-100 transition-colors select-none ${align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'} ${className}`}
        onClick={() => requestSort(sortKey)}
      >
        <div className={`flex items-center gap-1 inline-flex ${align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'}`}>
          <span>{label}</span>
          <div className="flex items-center justify-center text-slate-400">
            {isActive ? (
              sortConfig.direction === 'asc' ? <ArrowUp className="w-3 h-3 text-indigo-600" /> : <ArrowDown className="w-3 h-3 text-indigo-600" />
            ) : (
              <ArrowUpDown className="w-3 h-3 opacity-30 hover:opacity-100 transition-opacity" />
            )}
          </div>
        </div>
      </th>
    );
  };

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileCount, setFileCount] = useState({ total: 0, processed: 0 });
  const [dragging, setDragging] = useState(false);
  const [broker, setBroker] = useState<'auto' | 'zerodha' | 'shareindia' | 'integrated' | 'standard' | 'transaction-report'>('zerodha');
  // A transaction-report CSV carries no portfolio code, so the user picks the
  // destination explicitly; this overrides UCC-based routing for that source.
  const [txnReportPortfolio, setTxnReportPortfolio] = useState<string>(DEFAULT_PORTFOLIO_ID);
  const [pdfPassword, setPdfPassword] = useState("");
  const [isPasswordRequired, setIsPasswordRequired] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const [showExportConfirmation, setShowExportConfirmation] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isLogicOpen, setIsLogicOpen] = useState(false);
  const [selectedLogicBroker, setSelectedLogicBroker] = useState<'zerodha' | 'shareindia' | 'integrated' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sort once per (data, sort, broker) change instead of re-sorting on every render.
  const sortedTrades = React.useMemo(() => getSortedTrades(), [data, sortConfig, broker]);
  // Virtualize the preview table only for large imports (e.g. transaction reports
  // with thousands of rows). Small notes render in full, exactly as before.
  const TRADE_VIRTUALIZE_THRESHOLD = 200;
  const tradesVirtual = sortedTrades.length > TRADE_VIRTUALIZE_THRESHOLD;
  const tradeVR = useVirtualRows(tradesVirtual ? sortedTrades.length : 0, { estimatedRowHeight: 56, overscan: 14 });

  const DEFAULT_LEDGER_MAPPINGS = React.useMemo(() => ({
    STT: "STT ON EQUITY-IMSPL",
    EXCHANGE: "ETC-EQUITY-IMSPL",
    SEBI: "SEBI TURNOVER CHRGES-EQUITY-IMSPL",
    IPF: "IPF-EQUITY (IMSPL)",
    GST: "GST-EQUITY (IMSPL)",
    BROKER: "Integrated Master Securities Pvt.Ltd.",
    BROKERAGE: "BROKERAGE ON EQUITY",
    STAMP_DUTY: "STAMP DUTY-EQUITY (INT)",
    CLEARING: "CLEARING CHARGES-IMSPL",
    SHARES_TEMPLATE: "{securityName} (Shares)",
    ROUNDED_OFF: "Rounded Off",
    VOUCHER_PREFIX: "COMBINED/",
    VOUCHER_START_NUMBER: "1524",
    SECURITIES_MAPPINGS: "GOODLUCK=Goodluck India Ltd (Shares)\nLIQUIDCASE=LIQUIDCASE"
  }), []);

  const [ledgerMappings, setLedgerMappings] = useState<{ [key: string]: string }>(() => {
    const saved = localStorage.getItem('accounting_ledger_mappings');
    if (saved) {
      const parsed = JSON.parse(saved);
      // Ensure we fill in defaults for any missing key, specifically STAMP_DUTY or SECURITIES_MAPPINGS
      if (parsed.STAMP_DUTY === "STAMP ON EQUITY-IMSPL") {
        parsed.STAMP_DUTY = "STAMP DUTY-EQUITY (INT)";
      }
      if (!parsed.SECURITIES_MAPPINGS) {
        parsed.SECURITIES_MAPPINGS = "GOODLUCK=Goodluck India Ltd (Shares)\nLIQUIDCASE=LIQUIDCASE";
      }
      return parsed;
    }
    return {
      STT: "STT ON EQUITY-IMSPL",
      EXCHANGE: "ETC-EQUITY-IMSPL",
      SEBI: "SEBI TURNOVER CHRGES-EQUITY-IMSPL",
      IPF: "IPF-EQUITY (IMSPL)",
      GST: "GST-EQUITY (IMSPL)",
      BROKER: "Integrated Master Securities Pvt.Ltd.",
      BROKERAGE: "BROKERAGE ON EQUITY",
      STAMP_DUTY: "STAMP DUTY-EQUITY (INT)",
      CLEARING: "CLEARING CHARGES-IMSPL",
      SHARES_TEMPLATE: "{securityName} (Shares)",
      ROUNDED_OFF: "Rounded Off",
      VOUCHER_PREFIX: "COMBINED/",
      VOUCHER_START_NUMBER: "1524",
      SECURITIES_MAPPINGS: "GOODLUCK=Goodluck India Ltd (Shares)\nLIQUIDCASE=LIQUIDCASE"
    };
  });
  const [showLedgerConfig, setShowLedgerConfig] = useState(false);

  const updateLedgerMapping = (key: string, value: string) => {
    setLedgerMappings(prev => {
      const next = { ...prev, [key]: value };
      localStorage.setItem('accounting_ledger_mappings', JSON.stringify(next));
      return next;
    });
  };

  // ── Right after a successful parse, confirm each security's name against the
  // NSE/BSE list. Runs for EVERY broker that produced named securities:
  // ISIN-bearing notes (Integrated, Zerodha, Share India, Standard) confirm
  // primarily by ISIN — but when a note's ISIN isn't in the master they'd
  // otherwise fall through to fuzzy name-matching with no human check, so the
  // popup catches that. The name-only Transaction Report confirms by name — for
  // it this is the only chance to map a name the list doesn't recognise,
  // otherwise its Holding/LTST would split. Skipped only when the parse yielded
  // no named securities (nothing to confirm). ──
  const confirmSecurities = async (parsed: ContractNoteResult) => {
    if (!parsed.trades.some(t => t.securityName && t.securityName.trim())) return;
    let master: ScripMaster;
    try {
      master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID);
    } catch (e) {
      console.warn("Could not load Scrip Master for security confirmation:", e);
      return;
    }
    const seen = new Set<string>();
    const securities: ConfirmSecurity[] = [];
    for (const t of parsed.trades) {
      if (!t.securityName) continue;
      const key = (t.isin || "").trim() || normName(t.securityName);
      if (seen.has(key)) continue;
      seen.add(key);
      securities.push({ parsedName: t.securityName, isin: (t.isin || "").trim() });
    }
    if (securities.length > 0) setSecurityConfirm({ master, securities });
  };

  // Re-fetch the scrip sheet (bypassing the cache) and re-resolve the popup —
  // used after the user adds a missing row directly in the sheet.
  const rescanSecurities = async () => {
    const master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID, { force: true });
    setSecurityConfirm(prev => prev ? { master, securities: prev.securities } : prev);
  };

  const handleFileUpload = async (files: FileList | File[] | null, password?: string) => {
    if (!files) return;
    setIsLoading(true);
    setError(null);
    setData(null);
    setIsPasswordRequired(false);
    setShowExportConfirmation(false);
    setSheetsImportStatus(null);   // fresh note → re-arm the Import button (green/pressable)

    let fileArray = Array.from(files);

    if (broker === 'zerodha') {
      const allowedFiles = fileArray.filter(file => file.name.toLowerCase().endsWith('.pdf'));
      if (allowedFiles.length === 0) {
        setError("Only PDF contract notes are allowed for Zerodha.");
        setIsLoading(false);
        return;
      }
      fileArray = allowedFiles;
    }

    // Over the per-batch limit → ask: keep the first MAX_FILES in ascending
    // (date) order and drop the rest, or abort so the user can reselect.
    if (fileArray.length > MAX_FILES) {
      const sorted = [...fileArray].sort((a, b) => {
        const da = dateFromFileName(a.name), db = dateFromFileName(b.name);
        if (da && db && da !== db) return da - db;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
      const firstExcluded = sorted[MAX_FILES];
      const exTs = dateFromFileName(firstExcluded.name);
      const exLabel = exTs
        ? `dated ${new Date(exTs).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`
        : `"${firstExcluded.name}"`;
      const proceed = await confirmDialog({
        title: `Upload limit is ${MAX_FILES} contract notes`,
        body: (
          <span>
            You selected <b>{fileArray.length}</b> files. Continue with the first <b>{MAX_FILES}</b> in
            ascending order — every note from {exLabel} onward ({fileArray.length - MAX_FILES} file
            {fileArray.length - MAX_FILES > 1 ? 's' : ''}) will be <b>excluded</b>. Or reupload with a
            smaller selection.
          </span>
        ),
        confirmLabel: `Continue with first ${MAX_FILES}`,
        cancelLabel: 'Reupload',
      });
      if (!proceed) { setIsLoading(false); return; }
      fileArray = sorted.slice(0, MAX_FILES);
    }

    setPendingFiles(fileArray);
    setUploadedNoteNames(fileArray.map(f => f.name));
    setFileCount({ total: fileArray.length, processed: 0 });

    try {
      const results: ContractNoteResult[] = [];
      for (let i = 0; i < Math.min(fileArray.length, MAX_FILES); i++) {
        const file = fileArray[i];
        try {
          let res = await processFile(file, password || pdfPassword, broker);
          if (res) results.push(res);
        } catch (err: any) {
          if (err.message === "PDF_PASSWORD_REQUIRED") {
            setIsPasswordRequired(true);
            setIsLoading(false);
            return;
          }
          throw err;
        }
        setFileCount(prev => ({ ...prev, processed: i + 1 }));
      }

      if (results.length === 0) {
        setError("No transactions found. Please ensure they are valid contract notes.");
      } else {
        const merged = mergeResults(results);
        setData(merged);
        setPendingFiles(null);
        confirmSecurities(merged);  // security-confirmation popup for every broker (Integrated, Zerodha, Share India, Standard, Transaction Report)
      }
    } catch (err: any) {
      setError(err?.message || "Failed to parse the files. Please check if they are valid contract notes.");
    } finally {
      setIsLoading(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length > 0) handleFileUpload(e.dataTransfer.files);
  };

  const calculatedTotals = React.useMemo(() => {
    if (!data) {
      return {
        gross: 0,
        stt: 0,
        brokerage: 0,
        gst: 0,
        igst: 0,
        etc: 0,
        stampDuty: 0,
        clearingCharges: 0,
        sebiFeesAndOther: 0,
        totalExpensesInclSTT: 0,
        totalExpensesExclSTT: 0,
        netSettlementInclSTT: 0,
        netSettlementExclSTT: 0,
        obligation: 0
      };
    }

    const gross = data.trades.reduce((sum, t) => sum + t.turnover, 0);
    const stt = data.trades.reduce((sum, t) => sum + t.stt, 0);
    const brokerage = data.trades.reduce((sum, t) => sum + t.brokerage, 0);
    const gst = data.trades.reduce((sum, t) => sum + t.gst, 0);
    const igst = data.trades.reduce((sum, t) => sum + (t.igst || 0), 0);
    const etc = data.trades.reduce((sum, t) => sum + t.etc, 0);
    const stampDuty = data.trades.reduce((sum, t) => sum + t.stampDuty, 0);
    const clearingCharges = data.trades.reduce((sum, t) => sum + t.clearingCharges, 0);
    const sebiFees = data.trades.reduce((sum, t) => sum + t.sebiFees, 0);
    const ipf = data.trades.reduce((sum, t) => sum + t.ipf, 0);
    const dmat = data.trades.reduce((sum, t) => sum + (t.dmat || 0), 0);
    const totalExpensesInclSTT = data.trades.reduce((sum, t) => sum + t.totalExpensesInclSTT, 0);
    const totalExpensesExclSTT = data.trades.reduce((sum, t) => sum + t.totalExpensesExclSTT, 0);

    const totalAmountWithExpenseInclSTT = data.trades.reduce((sum, t) => {
      const val = t.transactionType === "Buy" 
        ? t.turnover + t.totalExpensesInclSTT 
        : t.turnover - t.totalExpensesInclSTT;
      return sum + val;
    }, 0);

    const totalAmountWithExpenseExclSTT = data.trades.reduce((sum, t) => {
      const val = t.transactionType === "Buy" 
        ? t.turnover + t.totalExpensesExclSTT 
        : t.turnover - t.totalExpensesExclSTT;
      return sum + val;
    }, 0);

    const netSettlementInclSTT = data.trades.reduce((sum, t) => {
      // Sells are positive proceeds (+), Buys are negative costs (-)
      const val = t.transactionType === "Buy" 
        ? -(t.turnover + t.totalExpensesInclSTT) 
        : (t.turnover - t.totalExpensesInclSTT);
      return sum + val;
    }, 0);

    const netSettlementExclSTT = data.trades.reduce((sum, t) => {
      const val = t.transactionType === "Buy" 
        ? -(t.turnover + t.totalExpensesExclSTT) 
        : (t.turnover - t.totalExpensesExclSTT);
      return sum + val;
    }, 0);

    const obligation = data.trades.reduce((sum, t) => {
      const val = t.transactionType === "Buy" ? -t.turnover : t.turnover;
      return sum + val;
    }, 0);

    return {
      gross,
      stt,
      brokerage,
      gst,
      igst,
      etc,
      stampDuty,
      clearingCharges,
      sebiFees,
      ipf,
      dmat,
      totalExpensesInclSTT,
      totalExpensesExclSTT,
      totalAmountWithExpenseInclSTT,
      totalAmountWithExpenseExclSTT,
      netSettlementInclSTT,
      netSettlementExclSTT,
      obligation
    };
  }, [data]);

  const { totalGrossValue, totalWithExpenseInclSTT, totalWithExpenseExclSTT } = React.useMemo(() => {
    if (!calculatedTotals) return { totalGrossValue: 0, totalWithExpenseInclSTT: 0, totalWithExpenseExclSTT: 0 };
    return {
      totalGrossValue: calculatedTotals.gross,
      totalWithExpenseInclSTT: calculatedTotals.netSettlementInclSTT,
      totalWithExpenseExclSTT: calculatedTotals.netSettlementExclSTT
    };
  }, [calculatedTotals]);

  const downloadCSV = () => {
    if (!data) return;
    const isIntegrated = data.brokerName === 'integrated';
    const showIpf = data.brokerName === 'integrated';
    const headers = [
      "Trade Date", "ISIN", "Stock Name", "Transaction Type", "Number of Shares", "Avg Price",
      "Total Amount (Turnover)", "Brokerage Per Share", "Total Brokerage", "STT",
      "Exchange Turnover Charges", "SEBI Turnover Fees", ...(showIpf ? ["IPF Charges"] : []),
      ...(isIntegrated ? ["Demat Charges"] : []), isIntegrated ? "Total GST" : "IGST",
      "Stamp Duty", "Total Expenses (incl STT)", "Total Expenses (excl STT)",
      "Total Amount with Expense (Incl STT)", "Total Amount with Expense (Excl STT)", "Trade Class"
    ];

    const numDecimals = data.brokerName === 'shareindia' ? 4 : 2;
    const formatCSV = (val: number) => {
      const fixed = val.toFixed(numDecimals);
      if (numDecimals === 4) {
        if (fixed.endsWith('00')) return fixed.slice(0, -2);
        if (fixed.endsWith('0')) return fixed.slice(0, -1);
      }
      return fixed;
    };

    const rows = data.trades.map(t => {
      const brokeragePerShare = t.quantity > 0 ? formatCSV(t.brokerage / t.quantity) : "0.00";
      const totalWithExpenseInclSTT = t.transactionType === "Buy" 
        ? t.turnover + t.totalExpensesInclSTT 
        : t.turnover - t.totalExpensesInclSTT;
      const totalWithExpenseExclSTT = t.transactionType === "Buy" 
        ? t.turnover + t.totalExpensesExclSTT 
        : t.turnover - t.totalExpensesExclSTT;

      return [
        `"${t.tradeDate}"`, 
        `"${(t.isin || "").replace(/"/g, '""')}"`,
        `"${t.securityName.replace(/"/g, '""')}"`, 
        `"${t.transactionType}"`, 
        t.quantity,
        formatCSV(t.avgPrice),
        formatCSV(t.turnover),
        brokeragePerShare,
        formatCSV(t.brokerage),
        formatCSV(t.stt),
        formatCSV(t.etc),
        formatCSV(t.sebiFees),
        ...(showIpf ? [formatCSV(t.ipf)] : []),
        ...(isIntegrated ? [formatCSV(t.dmat || 0)] : []),
        isIntegrated ? formatCSV(t.gst) : formatCSV(t.igst || t.gst),
        formatCSV(t.stampDuty),
        formatCSV(t.totalExpensesInclSTT),
        formatCSV(t.totalExpensesExclSTT),
        formatCSV(totalWithExpenseInclSTT),
        formatCSV(totalWithExpenseExclSTT),
        `"${t.tradeType}"`
      ];
    });

    const totalRow = [
      '', // Trade Date
      '', // ISIN
      '', // Stock Name
      '', // Transaction Type
      '', // Number of Shares
      '', // Avg Price
      formatCSV(calculatedTotals.gross), // Total Amount (Turnover)
      '', // Brokerage Per Share
      formatCSV(calculatedTotals.brokerage), // Total Brokerage
      formatCSV(calculatedTotals.stt), // STT
      formatCSV(calculatedTotals.etc), // Exchange Turnover Charges
      formatCSV(calculatedTotals.sebiFees), // SEBI Turnover Fees
      ...(showIpf ? [formatCSV(calculatedTotals.ipf)] : []), // IPF Charges
      ...(isIntegrated ? [formatCSV(calculatedTotals.dmat)] : []), // Demat Charges
      isIntegrated ? formatCSV(calculatedTotals.gst) : formatCSV(calculatedTotals.igst), // IGST / GST
      formatCSV(calculatedTotals.stampDuty), // Stamp Duty
      formatCSV(calculatedTotals.totalExpensesInclSTT), // Total Expenses (incl STT)
      formatCSV(calculatedTotals.totalExpensesExclSTT), // Total Expenses (excl STT)
      formatCSV(calculatedTotals.totalAmountWithExpenseInclSTT), // Total Amount with Expense (Incl STT)
      formatCSV(calculatedTotals.totalAmountWithExpenseExclSTT), // Total Amount with Expense (Excl STT)
      '', // Trade Class
    ];

    const csvContent = [headers.join(","), ...rows.map(r => r.join(",")), totalRow.join(",")].join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    const cleanDate = (data.tradeDate || "").trim().replace(/[\s\/\\]/g, "_") || new Date().toISOString().split('T')[0];
    const cleanBroker = (data.brokerName || broker || "broker").toLowerCase().trim();
    link.setAttribute("download", `contract_note_${cleanBroker}_${cleanDate}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setShowExportConfirmation(false);
  };

  const downloadVoucherExcel = () => {
    if (!data) return;

    const getExcelDateCell = (dateStr: string) => {
      if (!dateStr) return { t: 's', v: "" };
      const cleaned = dateStr.trim();
      let dObj: Date | null = null;
      
      // Match DD-MM-YYYY or DD/MM/YYYY
      const dmy = cleaned.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
      if (dmy) {
        const day = parseInt(dmy[1], 10);
        const month = parseInt(dmy[2], 10) - 1;
        const year = parseInt(dmy[3], 10);
        dObj = new Date(Date.UTC(year, month, day));
      } else {
        // Match YYYY-MM-DD or YYYY/MM/DD
        const ymd = cleaned.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if (ymd) {
          const year = parseInt(ymd[1], 10);
          const month = parseInt(ymd[2], 10) - 1;
          const day = parseInt(ymd[3], 10);
          dObj = new Date(Date.UTC(year, month, day));
        } else {
          const ts = Date.parse(cleaned);
          if (!isNaN(ts)) {
            const parsedD = new Date(ts);
            dObj = new Date(Date.UTC(parsedD.getFullYear(), parsedD.getMonth(), parsedD.getDate()));
          }
        }
      }

      if (dObj) {
        // Calculate the Excel Date Serial Number (number of days since December 30, 1899)
        const epoch = Date.UTC(1899, 11, 30);
        const diffMs = dObj.getTime() - epoch;
        const serial = Math.floor(diffMs / (24 * 60 * 60 * 1000));
        return {
          t: 'n',
          v: serial,
          z: 'dd-mmm-yyyy'
        };
      }
      return { t: 's', v: dateStr };
    };

    // Group trades by tradeDate, securityName, and transactionType
    // This allows cumulative entries for sales of the same security on the same day
    const grouped: { [key: string]: typeof data.trades } = {};
    for (const t of data.trades) {
      const groupKey = `${t.tradeDate}_${t.securityName}_${t.transactionType}`;
      if (!grouped[groupKey]) grouped[groupKey] = [];
      grouped[groupKey].push(t);
    }

    const sheetData: any[][] = [
      ["VoucherType", "VoucherNo", "Date", "LedgerName", "EntryType", "Amount", "Narration"]
    ];

    let voucherIndex = 0;
    const startNum = parseInt(ledgerMappings.VOUCHER_START_NUMBER || "1524", 10);
    const voucherPrefix = ledgerMappings.VOUCHER_PREFIX || "COMBINED/";

    for (const key of Object.keys(grouped)) {
      const group = grouped[key];
      const first = group[0];
      const tradeDateStr = first.tradeDate ? first.tradeDate.trim() : "";
      const securityName = first.securityName;
      const tType = first.transactionType;

      const currentVoucherNo = `${voucherPrefix}${startNum + voucherIndex}`;
      voucherIndex++;

      const qty = group.reduce((sum, x) => sum + x.quantity, 0);
      const turnover_val = group.reduce((sum, x) => sum + x.turnover, 0);
      const avgPrice = turnover_val / qty;
      const stt_val = group.reduce((sum, x) => sum + x.stt, 0);
      const etc_val = group.reduce((sum, x) => sum + x.etc, 0);
      const sebi_val = group.reduce((sum, x) => sum + x.sebiFees, 0);
      const ipf_val = group.reduce((sum, x) => sum + x.ipf, 0);
      const gst_val = group.reduce((sum, x) => sum + x.gst, 0);
      const brokerage_val = group.reduce((sum, x) => sum + x.brokerage, 0);
      const stamp_val = group.reduce((sum, x) => sum + x.stampDuty, 0);
      const clearing_val = group.reduce((sum, x) => sum + x.clearingCharges, 0);

      const round = (num: number) => Math.round(num * 100) / 100;

      const drStt = round(stt_val);
      const drEtc = round(etc_val);
      const drSebi = round(sebi_val);
      const drIpf = round(ipf_val);
      const drGst = round(gst_val);
      const drBrokerage = round(brokerage_val);
      const drStamp = round(stamp_val);
      const drClearing = round(clearing_val);

      const getSharesLedgerName = (name: string): string => {
        const overridesStr = ledgerMappings.SECURITIES_MAPPINGS || "";
        const lines = overridesStr.split('\n');
        for (const line of lines) {
          const parts = line.split('=');
          if (parts.length === 2) {
            const parsedKey = parts[0].trim().toLowerCase();
            const targetValue = parts[1].trim();
            if (parsedKey && (name.toLowerCase().includes(parsedKey) || name.toLowerCase() === parsedKey)) {
              return targetValue;
            }
          }
        }
        const template = ledgerMappings.SHARES_TEMPLATE || "{securityName} (Shares)";
        return template.replace("{securityName}", name);
      };

      const sharesLedgerName = getSharesLedgerName(securityName);

      const narration = `${securityName} ${qty} Nos @ ${data.brokerName === 'shareindia' ? avgPrice.toFixed(4) : avgPrice.toFixed(2)}`;

      const addRow = (ledgerName: string, entryType: "Debit" | "Credit", amount: number, rowNarration: string = "") => {
        sheetData.push([
          "Journal",
          currentVoucherNo,
          getExcelDateCell(tradeDateStr),
          ledgerName,
          entryType,
          amount,
          rowNarration
        ]);
      };

      if (tType === "Sell") {
        const expTotal = stt_val + etc_val + sebi_val + ipf_val + gst_val + brokerage_val + stamp_val + clearing_val;
        const netReceivable = round(turnover_val - expTotal);
        const crSharesVal = round(turnover_val);

        const drSum = netReceivable + drStt + drEtc + drSebi + drIpf + drGst + drBrokerage + drStamp + drClearing;
        const crSum = crSharesVal;
        const diff = round(drSum - crSum);

        // 1. Broker Ledger (Debit) with Narration on the first line
        addRow(ledgerMappings.BROKER || "Broker Ledger", "Debit", netReceivable, narration);

        // 2. Shares Ledger (Credit)
        addRow(sharesLedgerName, "Credit", crSharesVal, "");

        // 3-10. Expenses
        if (drStt > 0) addRow(ledgerMappings.STT || "STT Ledger", "Debit", drStt, "");
        if (drEtc > 0) addRow(ledgerMappings.EXCHANGE || "Exchange Charges", "Debit", drEtc, "");
        if (drSebi > 0) addRow(ledgerMappings.SEBI || "SEBI Ledger", "Debit", drSebi, "");
        if (drIpf > 0) addRow(ledgerMappings.IPF || "IPF Ledger", "Debit", drIpf, "");
        if (drGst > 0) addRow(ledgerMappings.GST || "GST Ledger", "Debit", drGst, "");
        if (drBrokerage > 0) addRow(ledgerMappings.BROKERAGE || "Brokerage", "Debit", drBrokerage, "");
        if (drStamp > 0) addRow(ledgerMappings.STAMP_DUTY || "Stamp Duty", "Debit", drStamp, "");
        if (drClearing > 0) addRow(ledgerMappings.CLEARING || "Clearing", "Debit", drClearing, "");

        // 11. Rounded Off
        if (Math.abs(diff) >= 0.005) {
          if (diff < 0) {
            addRow(ledgerMappings.ROUNDED_OFF || "Rounded Off", "Debit", Math.abs(diff), "");
          } else {
            addRow(ledgerMappings.ROUNDED_OFF || "Rounded Off", "Credit", Math.abs(diff), "");
          }
        }
      } else {
        const expTotal = stt_val + etc_val + sebi_val + ipf_val + gst_val + brokerage_val + stamp_val + clearing_val;
        const netPayable = round(turnover_val + expTotal);
        const drSharesVal = round(turnover_val);

        const drSum = drSharesVal + drStt + drEtc + drSebi + drIpf + drGst + drBrokerage + drStamp + drClearing;
        const crSum = netPayable;
        const diff = round(drSum - crSum);

        // 1. Shares Ledger (Debit) with Narration on the first line
        addRow(sharesLedgerName, "Debit", drSharesVal, narration);

        // 2. Broker Ledger (Credit)
        addRow(ledgerMappings.BROKER || "Broker Ledger", "Credit", netPayable, "");

        // 3-10. Expenses
        if (drStt > 0) addRow(ledgerMappings.STT || "STT Ledger", "Debit", drStt, "");
        if (drEtc > 0) addRow(ledgerMappings.EXCHANGE || "Exchange Charges", "Debit", drEtc, "");
        if (drSebi > 0) addRow(ledgerMappings.SEBI || "SEBI Ledger", "Debit", drSebi, "");
        if (drIpf > 0) addRow(ledgerMappings.IPF || "IPF Ledger", "Debit", drIpf, "");
        if (drGst > 0) addRow(ledgerMappings.GST || "GST Ledger", "Debit", drGst, "");
        if (drBrokerage > 0) addRow(ledgerMappings.BROKERAGE || "Brokerage", "Debit", drBrokerage, "");
        if (drStamp > 0) addRow(ledgerMappings.STAMP_DUTY || "Stamp Duty", "Debit", drStamp, "");
        if (drClearing > 0) addRow(ledgerMappings.CLEARING || "Clearing", "Debit", drClearing, "");

        // 11. Rounded Off
        if (Math.abs(diff) >= 0.005) {
          if (diff < 0) {
            addRow(ledgerMappings.ROUNDED_OFF || "Rounded Off", "Debit", Math.abs(diff), "");
          } else {
            addRow(ledgerMappings.ROUNDED_OFF || "Rounded Off", "Credit", Math.abs(diff), "");
          }
        }
      }
    }

    const wb = XLSX.utils.book_new();
    // Do NOT pass cellDates: true, to prevent auto-conversion of strings to dates with timestamps
    const ws = XLSX.utils.aoa_to_sheet(sheetData);

    // Explicitly set date format (dd-mmm-yyyy) and strip fractional timestamps on date cells in column C
    for (const key in ws) {
      if (key.startsWith('C') && key !== 'C1') {
        const cell = ws[key];
        if (cell) {
          if (cell.t === 'd' || cell.v instanceof Date) {
            cell.z = 'dd-mmm-yyyy';
          } else if (cell.t === 'n' && typeof cell.v === 'number' && cell.v > 30000 && cell.v < 60000) {
            cell.v = Math.floor(cell.v); // Ensure strictly whole number serial (date only, no time part)
            cell.z = 'dd-mmm-yyyy';
          }
        }
      }
    }

    ws['!cols'] = [
      { wch: 15 }, // VoucherType
      { wch: 20 }, // VoucherNo
      { wch: 15 }, // Date
      { wch: 45 }, // LedgerName
      { wch: 12 }, // EntryType
      { wch: 15 }, // Amount
      { wch: 60 }  // Narration
    ];

    XLSX.utils.book_append_sheet(wb, ws, "Vouchers");

    const cleanDate = (data.tradeDate || "").trim().replace(/[\s\/\\]/g, "_") || new Date().toISOString().split('T')[0];
    const cleanBroker = (data.brokerName || broker || "broker").toLowerCase().trim();
    XLSX.writeFile(wb, `voucher_${cleanBroker}_${cleanDate}.xlsx`);
  };

  const downloadVoucherXML = () => {
    if (!data) return;

    const parseDateToYYYYMMDD = (dateStr: string): string => {
      if (!dateStr) return "";
      const cleaned = dateStr.trim();
      let dObj: Date | null = null;
      
      const dmy = cleaned.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
      if (dmy) {
        const day = parseInt(dmy[1], 10);
        const month = parseInt(dmy[2], 10) - 1;
        const year = parseInt(dmy[3], 10);
        dObj = new Date(Date.UTC(year, month, day));
      } else {
        const ymd = cleaned.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if (ymd) {
          const year = parseInt(ymd[1], 10);
          const month = parseInt(ymd[2], 10) - 1;
          const day = parseInt(ymd[3], 10);
          dObj = new Date(Date.UTC(year, month, day));
        } else {
          const ts = Date.parse(cleaned);
          if (!isNaN(ts)) {
            const parsedD = new Date(ts);
            dObj = new Date(Date.UTC(parsedD.getFullYear(), parsedD.getMonth(), parsedD.getDate()));
          }
        }
      }

      if (dObj) {
        const yyyy = dObj.getUTCFullYear();
        const mm = String(dObj.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(dObj.getUTCDate()).padStart(2, '0');
        return `${yyyy}${mm}${dd}`;
      }
      return cleaned.replace(/[^0-9]/g, "");
    };

    const grouped: { [key: string]: typeof data.trades } = {};
    for (const t of data.trades) {
      const groupKey = `${t.tradeDate}_${t.securityName}_${t.transactionType}`;
      if (!grouped[groupKey]) grouped[groupKey] = [];
      grouped[groupKey].push(t);
    }

    let xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>\n`;

    let voucherIndex = 0;
    const startNum = parseInt(ledgerMappings.VOUCHER_START_NUMBER || "1524", 10);
    const voucherPrefix = ledgerMappings.VOUCHER_PREFIX || "COMBINED/";

    for (const key of Object.keys(grouped)) {
      const group = grouped[key];
      const first = group[0];
      const tradeDateStr = first.tradeDate ? first.tradeDate.trim() : "";
      const tallyDate = parseDateToYYYYMMDD(tradeDateStr);
      const securityName = first.securityName;
      const tType = first.transactionType;

      const currentVoucherNo = `${voucherPrefix}${startNum + voucherIndex}`;
      voucherIndex++;

      const qty = group.reduce((sum, x) => sum + x.quantity, 0);
      const turnover_val = group.reduce((sum, x) => sum + x.turnover, 0);
      const avgPrice = turnover_val / qty;
      const stt_val = group.reduce((sum, x) => sum + x.stt, 0);
      const etc_val = group.reduce((sum, x) => sum + x.etc, 0);
      const sebi_val = group.reduce((sum, x) => sum + x.sebiFees, 0);
      const ipf_val = group.reduce((sum, x) => sum + x.ipf, 0);
      const gst_val = group.reduce((sum, x) => sum + x.gst, 0);
      const brokerage_val = group.reduce((sum, x) => sum + x.brokerage, 0);
      const stamp_val = group.reduce((sum, x) => sum + x.stampDuty, 0);
      const clearing_val = group.reduce((sum, x) => sum + x.clearingCharges, 0);

      const round = (num: number) => Math.round(num * 100) / 100;

      const drStt = round(stt_val);
      const drEtc = round(etc_val);
      const drSebi = round(sebi_val);
      const drIpf = round(ipf_val);
      const drGst = round(gst_val);
      const drBrokerage = round(brokerage_val);
      const drStamp = round(stamp_val);
      const drClearing = round(clearing_val);

      const getSharesLedgerName = (name: string): string => {
        const overridesStr = ledgerMappings.SECURITIES_MAPPINGS || "";
        const lines = overridesStr.split('\n');
        for (const line of lines) {
          const parts = line.split('=');
          if (parts.length === 2) {
            const parsedKey = parts[0].trim().toLowerCase();
            const targetValue = parts[1].trim();
            if (parsedKey && (name.toLowerCase().includes(parsedKey) || name.toLowerCase() === parsedKey)) {
              return targetValue;
            }
          }
        }
        const template = ledgerMappings.SHARES_TEMPLATE || "{securityName} (Shares)";
        return template.replace("{securityName}", name);
      };

      const sharesLedgerName = getSharesLedgerName(securityName);
      const narration = `${securityName} ${qty} Nos @ ${data.brokerName === 'shareindia' ? avgPrice.toFixed(4) : avgPrice.toFixed(2)}`;

      const brokerLedger = ledgerMappings.BROKER || "Broker Ledger";

      // Represent entries. For Tally, Debits are negative, Credits are positive amounts.
      const entries: { ledgerName: string; isDebit: boolean; amount: number }[] = [];

      const addEntry = (ledgerName: string, isDebit: boolean, amt: number) => {
        if (amt <= 0) return;
        entries.push({ ledgerName, isDebit, amount: round(amt) });
      };

      if (tType === "Sell") {
        // Correct Sell direction according to successful Tally setup (Share = Debit, Broker = Credit)
        // Share Ledger (Debit) is gross turnover
        // Broker Ledger (Credit) is net receivable/payable plus expenses (turnover_val + expTotal)
        const expTotal = stt_val + etc_val + sebi_val + ipf_val + gst_val + brokerage_val + stamp_val + clearing_val;
        const netBrokerVal = round(turnover_val + expTotal);
        const drSharesVal = round(turnover_val);

        addEntry(sharesLedgerName, true, drSharesVal); // Debit
        addEntry(brokerLedger, false, netBrokerVal);  // Credit
        addEntry(ledgerMappings.STT || "STT Ledger", true, drStt);
        addEntry(ledgerMappings.EXCHANGE || "Exchange Charges", true, drEtc);
        addEntry(ledgerMappings.SEBI || "SEBI Ledger", true, drSebi);
        addEntry(ledgerMappings.IPF || "IPF Ledger", true, drIpf);
        addEntry(ledgerMappings.GST || "GST Ledger", true, drGst);
        addEntry(ledgerMappings.BROKERAGE || "Brokerage", true, drBrokerage);
        addEntry(ledgerMappings.STAMP_DUTY || "Stamp Duty", true, drStamp);
        addEntry(ledgerMappings.CLEARING || "Clearing", true, drClearing);
      } else {
        // Correct Buy direction according to successful Tally setup (Broker = Debit, Share = Credit)
        // Broker Ledger (Debit) is net Broker payment (turnover_val - expTotal)
        // Share Ledger (Credit) is gross turnover
        const expTotal = stt_val + etc_val + sebi_val + ipf_val + gst_val + brokerage_val + stamp_val + clearing_val;
        const netBrokerVal = round(turnover_val - expTotal);
        const crSharesVal = round(turnover_val);

        addEntry(brokerLedger, true, netBrokerVal);   // Debit
        addEntry(sharesLedgerName, false, crSharesVal); // Credit
        addEntry(ledgerMappings.STT || "STT Ledger", true, drStt);
        addEntry(ledgerMappings.EXCHANGE || "Exchange Charges", true, drEtc);
        addEntry(ledgerMappings.SEBI || "SEBI Ledger", true, drSebi);
        addEntry(ledgerMappings.IPF || "IPF Ledger", true, drIpf);
        addEntry(ledgerMappings.GST || "GST Ledger", true, drGst);
        addEntry(ledgerMappings.BROKERAGE || "Brokerage", true, drBrokerage);
        addEntry(ledgerMappings.STAMP_DUTY || "Stamp Duty", true, drStamp);
        addEntry(ledgerMappings.CLEARING || "Clearing", true, drClearing);
      }

      // Compute Dr and Cr sums, then balance precisely with Rounded Off
      const sumDr = entries.filter(e => e.isDebit).reduce((s, e) => s + e.amount, 0);
      const sumCr = entries.filter(e => !e.isDebit).reduce((s, e) => s + e.amount, 0);
      const diff = round(sumDr - sumCr);

      if (Math.abs(diff) >= 0.005) {
        if (diff < 0) {
          // Dr is less than Cr, so we Debit Rounded Off to balance
          addEntry(ledgerMappings.ROUNDED_OFF || "Rounded Off", true, Math.abs(diff));
        } else {
          // Dr is more than Cr, so we Credit Rounded Off to balance
          addEntry(ledgerMappings.ROUNDED_OFF || "Rounded Off", false, Math.abs(diff));
        }
      }

      // Safeguard escape xml strings
      const escapeXml = (str: string) => {
        return str
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&apos;');
      };

      xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER DATE="${escapeXml(tallyDate)}" VCHTYPE="Journal" ACTION="Create">
            <DATE>${escapeXml(tallyDate)}</DATE>
            <VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${escapeXml(currentVoucherNo)}</VOUCHERNUMBER>
            <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
            <ISINVOICE>No</ISINVOICE>
            <ISOPTIONAL>No</ISOPTIONAL>
            <EFFECTIVEDATE>${escapeXml(tallyDate)}</EFFECTIVEDATE>
            <NARRATION>${escapeXml(narration)}</NARRATION>\n`;

      for (const ent of entries) {
        // In Tally XML, Debit amount is negative and ISDEEMEDPOSITIVE is Yes
        // Credit amount is positive and ISDEEMEDPOSITIVE is No
        const isDeemedPositive = ent.isDebit ? "Yes" : "No";
        const tallyAmtStr = ent.isDebit ? `-${ent.amount.toFixed(2)}` : ent.amount.toFixed(2);

        xml += `            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(ent.ledgerName)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${isDeemedPositive}</ISDEEMEDPOSITIVE>
              <LEDGERFROMITEM>No</LEDGERFROMITEM>
              <AMOUNT>${tallyAmtStr}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>\n`;
      }

      xml += `          </VOUCHER>
        </TALLYMESSAGE>\n`;
    }

    xml += `      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    const blob = new Blob([xml], { type: 'application/xml;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    const cleanDate = (data.tradeDate || "").trim().replace(/[\s\/\\]/g, "_") || new Date().toISOString().split('T')[0];
    const cleanBroker = (data.brokerName || broker || "broker").toLowerCase().trim();
    link.setAttribute("download", `tally_vouchers_${cleanBroker}_${cleanDate}.xml`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportClick = () => {
    const isUncertain = data?.reconciliation && !data.reconciliation.isValid;
    if (isUncertain) {
      setShowExportConfirmation(true);
    } else {
      importToSheets();
    }
  };

  // State for Regression Testing tab
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [isRunningTests, setIsRunningTests] = useState(false);
  const [customCases, setCustomCases] = useState<RegressionTestCase[]>(() => {
    const saved = localStorage.getItem('custom_regression_cases');
    return saved ? JSON.parse(saved) : [];
  });
  const [activeTestDetail, setActiveTestDetail] = useState<string | null>(null);

  const runAllTests = async () => {
    setIsRunningTests(true);
    try {
      const results = await runRegressionTests(customCases);
      setTestResults(results);
    } catch (e) {
      console.error("Error running regression tests", e);
    } finally {
      setIsRunningTests(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'tests') {
      runAllTests();
    }
  }, [activeTab, customCases]);

  const clearCustomCases = async () => {
    const ok = await confirmDialog({
      title: 'Delete all custom regression cases?',
      body: 'This removes every custom test case you added. This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete all',
    });
    if (ok) {
      localStorage.removeItem('custom_regression_cases');
      setCustomCases([]);
      setTestResults([]);
    }
  };

  if (!currentUser) {
    return (
      <Login
        onLoginSuccess={(user) => {
          setCurrentUser(user);
          localStorage.setItem('portfolio_user', JSON.stringify(user));
          setSessionExpired(false);
          logAccess('login', user);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#f4efe3] via-[#f1ebdc] to-[#ebe4d1] dark:from-[#121110] dark:via-[#121110] dark:to-[#161410] text-slate-900 dark:text-slate-100 font-sans pb-20 animate-fadeIn">

      {/* Live IST time, pinned bottom-right of the viewport. */}
      <LiveClock />

      {/* Auto re-login: Google's token lapses ~hourly; this pops the moment it
          does so the user signs back in (one click) instead of hitting failures. */}
      {sessionExpired && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 p-6 text-center">
            <img src={sessionVaultSvg} alt="" aria-hidden="true" className="mx-auto w-28 h-28 mb-2 select-none pointer-events-none" />
            <h3 className="text-sm font-black text-slate-800 dark:text-slate-100 uppercase tracking-tight">Session expired</h3>
            <button
              onClick={() => login()}
              className="mt-5 w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-2"
            >
              <ShieldCheck className="w-4 h-4" /> Sign in again
            </button>
          </div>
        </div>
      )}


      {/* Post-upload security-name confirmation (Integrated notes) */}
      {securityConfirm && (
        <SecurityConfirmModal
          spreadsheetId={SCRIP_MASTER_SPREADSHEET_ID}
          master={securityConfirm.master}
          securities={securityConfirm.securities}
          onClose={() => setSecurityConfirm(null)}
          onRefresh={rescanSecurities}
        />
      )}

      {/* LEFT NAVIGATION SIDEBAR (The "3-dash" hamburger menu on side) */}
      <AnimatePresence>
        {isSidebarOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSidebarOpen(false)}
              className="fixed inset-0 bg-slate-900/35 backdrop-blur-xs z-[80]"
            />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'tween', duration: 0.2, ease: 'easeOut' }}
              className="fixed left-0 top-0 h-full w-64 bg-slate-900/80 backdrop-blur-xl text-slate-100 shadow-2xl z-[85] border-r border-slate-700/50 flex flex-col justify-between"
            >
              <div>
                <div className="p-6 border-b border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="bg-indigo-600 text-white p-2 rounded-xl">
                      <Briefcase className="w-5 h-5 text-indigo-200" />
                    </div>
                    <div>
                      <span className="font-extrabold text-xs tracking-wider uppercase tracking-tight block text-white">Backoffice</span>
                    </div>
                  </div>
                  <button
                    onClick={() => setIsSidebarOpen(false)}
                    className="p-1 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div className="p-4 space-y-1.5">
                  <button
                    onClick={() => { setCurrentView('dashboard'); setIsSidebarOpen(false); }}
                    className={`w-full text-left p-3 rounded-xl transition-all flex items-center gap-3 text-xs font-bold ${currentView === 'dashboard' ? 'bg-indigo-600 text-white font-black shadow shadow-indigo-500/25' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
                  >
                    <Gauge className="w-4 h-4" /> Dashboard
                  </button>
                  <button
                    onClick={() => { setCurrentView('holdings'); setIsSidebarOpen(false); }}
                    className={`w-full text-left p-3 rounded-xl transition-all flex items-center gap-3 text-xs font-bold ${currentView === 'holdings' ? 'bg-indigo-600 text-white font-black shadow shadow-indigo-500/25' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
                  >
                    <Briefcase className="w-4 h-4" /> Holdings
                  </button>
                  <button
                    onClick={() => { setCurrentView('imports'); setIsSidebarOpen(false); }}
                    className={`w-full text-left p-3 rounded-xl transition-all flex items-center gap-3 text-xs font-bold ${currentView === 'imports' ? 'bg-indigo-600 text-white font-black shadow shadow-indigo-500/25' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
                  >
                    <Upload className="w-4 h-4" /> Imports
                  </button>
                  <button
                    onClick={() => { setReportsFocus(null); setCurrentView('reports'); setIsSidebarOpen(false); }}
                    className={`w-full text-left p-3 rounded-xl transition-all flex items-center gap-3 text-xs font-bold ${currentView === 'reports' ? 'bg-indigo-600 text-white font-black shadow shadow-indigo-500/25' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
                  >
                    <BarChart3 className="w-4 h-4" /> Reports
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <header className="bg-white/70 dark:bg-[#16140f]/80 backdrop-blur-xl backdrop-saturate-150 border-b border-white/50 dark:border-[#2a2721] sticky top-0 z-50 px-6 h-16 shadow-sm flex items-center">
        <div className="flex-1 flex items-center space-x-2">
          <button
            id="btn-open-menu"
            onClick={() => setIsSidebarOpen(true)}
            className="p-2 hover:bg-slate-100 rounded-xl transition-all text-slate-600 hover:text-slate-950 flex items-center justify-center border border-slate-200 shadow-xs cursor-pointer mr-2"
            title="Open backoffice navigation drawer"
          >
            <Menu className="w-5 h-5 font-bold" />
          </button>
          <div className="flex items-center space-x-2.5">
            <div className="bg-indigo-600 text-white p-1.5 rounded-lg shadow-sm flex items-center justify-center">
              {currentView === 'dashboard' ? <Gauge className="w-4 h-4" /> : currentView === 'holdings' ? <Briefcase className="w-4 h-4" /> : currentView === 'reports' ? <BarChart3 className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
            </div>
            <div>
              <h1 className="text-xs sm:text-base font-black text-slate-800 tracking-tight leading-none uppercase">
                {currentView === 'dashboard' ? "Executive Dashboard" : currentView === 'holdings' ? "Portfolios" : currentView === 'reports' ? "Reports" : "Broker Note Imports"}
              </h1>
            </div>
          </div>
        </div>

        <div className="flex-1 hidden md:block" />

        <div className="flex-1 flex justify-end items-center gap-3">
          <ThemeToggle theme={theme} onToggle={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} />
          {currentView === 'imports' && (
            <>
              {/* Sheets access is granted at login; this only appears if the
                  token is missing or has expired (Google caps it at ~1 hour). */}
              {!hasValidGoogleToken() && (
                <button
                  onClick={() => login()}
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white text-[10px] font-bold rounded-lg transition-colors cursor-pointer shadow-sm"
                >
                  Reconnect Sheets
                </button>
              )}
              {/* Show a destination picker when the note carries no resolvable UCC
                  (transaction reports never do; Zerodha notes don't either) so the
                  import doesn't silently fall back to the default portfolio. */}
              {data && (data.brokerName === 'transaction-report' || !portfolioByUcc(data.ucc || '')) && (
                <div className="inline-flex flex-col gap-1">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-amber-600">
                    {data.ucc ? `UCC ${data.ucc} not recognised — pick destination` : 'No account code in note — pick destination'}
                  </span>
                  <select
                    value={txnReportPortfolio}
                    onChange={(e) => setTxnReportPortfolio(e.target.value)}
                    title="Choose which portfolio sheet to import this note into"
                    className="px-2.5 py-1.5 text-[11px] font-bold text-slate-700 bg-white border border-slate-200 rounded-lg outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer max-w-xs"
                  >
                    {PORTFOLIOS.map((p) => (
                      <option key={p.id} value={p.id}>{p.code} · {p.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          {currentUser && (
            <div className="flex items-center gap-2 bg-slate-50 p-1 pr-3 rounded-full border border-slate-200 shadow-sm shrink-0">
              <img src={currentUser.picture} alt="Avatar" className="w-6 h-6 rounded-full shadow-xs" referrerPolicy="no-referrer" />
              <span className="text-[10px] font-extrabold text-slate-700 hidden sm:inline max-w-[90px] truncate">{currentUser.given_name || currentUser.name.split(' ')[0]}</span>
              <button
                onClick={() => {
                  localStorage.removeItem('portfolio_user');
                  clearGoogleToken();
                  setCurrentUser(null);
                }}
                className="text-[9px] font-black text-slate-400 hover:text-rose-600 hover:bg-rose-50 border border-slate-200 px-1.5 py-0.5 rounded-full transition-all ml-1 cursor-pointer"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Reference Side Drawer / Dynamic Math & Logic reference */}
      <AnimatePresence>
        {isDrawerOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setIsDrawerOpen(false);
                setSelectedLogicBroker(null);
                setIsLogicOpen(false);
              }}
              className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-[90]"
            />

            {/* Slide-out Panel */}
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 220 }}
              className="fixed right-0 top-0 h-full w-[440px] max-w-full bg-white shadow-2xl z-[100] border-l border-slate-200 flex flex-col"
            >
              <div className="p-5 border-b border-slate-150 flex items-center justify-between bg-slate-50">
                <div className="flex items-center gap-2">
                  <Calculator className="w-5 h-5 text-indigo-600" />
                  <h2 className="text-sm font-black text-slate-800 uppercase tracking-wider">Calculation & Logic Summary</h2>
                </div>
                <button
                  onClick={() => {
                    setIsDrawerOpen(false);
                    setSelectedLogicBroker(null);
                    setIsLogicOpen(false);
                  }}
                  className="p-1 px-1.5 hover:bg-slate-200 rounded-md transition-colors text-slate-500 hover:text-slate-850"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {selectedLogicBroker === null ? (
                  <div className="space-y-3">
                    <p className="text-xs text-slate-500 font-medium">
                      Select an option below to inspect the mathematical logic and formulas implemented in the parsing engine.
                    </p>

                    {/* Accordion List */}
                    <div className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-xs">
                      {/* First Option: Logic */}
                      <button
                        onClick={() => setIsLogicOpen(!isLogicOpen)}
                        className="w-full flex items-center justify-between p-4 bg-white hover:bg-slate-50 transition-colors text-left"
                      >
                        <div className="flex items-center gap-3">
                          <BookOpen className="w-5 h-5 text-indigo-500" />
                          <div>
                            <p className="text-sm font-bold text-slate-800">Calculation Logic</p>
                            <p className="text-xs text-slate-450">View formulas, pricing allocations, taxes & STT</p>
                          </div>
                        </div>
                        <ChevronDown 
                          className={`w-4 h-4 text-slate-400 transition-transform duration-250 ${isLogicOpen ? 'rotate-180 font-bold' : ''}`} 
                        />
                      </button>

                      {/* Dropdown nested options */}
                      <AnimatePresence initial={false}>
                        {isLogicOpen && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="bg-slate-50 border-t border-slate-150 overflow-hidden"
                          >
                            <div className="p-2 space-y-1">
                              <button
                                onClick={() => setSelectedLogicBroker('zerodha')}
                                className="w-full text-left p-3 px-4 rounded-lg hover:bg-white hover:shadow-xs transition-all flex items-center justify-between text-xs font-bold text-slate-700 hover:text-indigo-605"
                              >
                                <span className="flex items-center gap-2">
                                  <span className="w-1.5 h-1.5 rounded-full bg-[#12b8f1]" />
                                  Zerodha Logic Model
                                </span>
                                <ChevronRight className="w-3.5 h-3.5 text-slate-450" />
                              </button>
                              
                              <button
                                onClick={() => setSelectedLogicBroker('shareindia')}
                                className="w-full text-left p-3 px-4 rounded-lg hover:bg-white hover:shadow-xs transition-all flex items-center justify-between text-xs font-bold text-slate-700 hover:text-indigo-605"
                              >
                                <span className="flex items-center gap-2">
                                  <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                                  Share India Logic Model
                                </span>
                                <ChevronRight className="w-3.5 h-3.5 text-slate-450" />
                              </button>
                              
                              <button
                                onClick={() => setSelectedLogicBroker('integrated')}
                                className="w-full text-left p-3 px-4 rounded-lg hover:bg-white hover:shadow-xs transition-all flex items-center justify-between text-xs font-bold text-slate-700 hover:text-indigo-605"
                              >
                                <span className="flex items-center gap-2">
                                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                                  Integrated Logic Model
                                </span>
                                <ChevronRight className="w-3.5 h-3.5 text-slate-450" />
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Back header */}
                    <button
                      onClick={() => setSelectedLogicBroker(null)}
                      className="text-xs font-black text-indigo-600 hover:text-indigo-800 transition-colors flex items-center gap-1.5 mb-2 group"
                    >
                      <ChevronRight className="w-3.5 h-3.5 rotate-180 group-hover:-translate-x-0.5 transition-transform font-bold" />
                      Back to options
                    </button>

                    {selectedLogicBroker === 'zerodha' ? (
                      <div className="space-y-4 animate-fadeIn">
                        <div className="p-4 rounded-xl bg-slate-900 text-white shadow-md">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="w-2 h-2 rounded-full bg-[#12b8f1] animate-pulse" />
                            <h3 className="text-xs font-black tracking-wider uppercase text-[#12b8f1]">Zerodha Mathematical Engine</h3>
                          </div>
                          <p className="text-[11px] text-slate-300 leading-relaxed font-sans">
                            High-precision formulas and validation boundaries designed specifically for Zerodha contract notes.
                          </p>
                        </div>

                        {/* Calculations summary */}
                        <div className="space-y-3.5 text-xs text-slate-700 leading-relaxed">
                          
                          <div className="bg-slate-100 p-3 rounded-xl border border-slate-200">
                            <h4 className="font-bold text-slate-800 flex items-center justify-between mb-1">
                              <span>1. Turnovers & Net Rates</span>
                              <span className="text-[10px] uppercase font-mono text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">Core Formula</span>
                            </h4>
                            <p className="mb-1 text-slate-650">The primary calculation handles raw trades:</p>
                            <code className="block bg-white p-2 rounded border border-slate-250 font-mono text-[10px] text-indigo-700 leading-normal">
                              Turnover = Quantity × Average Price
                            </code>
                          </div>

                          <div className="bg-slate-100 p-3 rounded-xl border border-slate-200">
                            <h4 className="font-bold text-slate-800 flex items-center justify-between mb-1">
                              <span>2. High-Precision Proration</span>
                              <span className="text-[10px] uppercase font-mono text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded font-bold">Proration</span>
                            </h4>
                            <p className="mb-1.5 text-slate-655 font-sans">
                              For composite contract fee lines (e.g., total GST, exchange charges, clearing charges), expenses are distributed proportionally based on trade value share:
                            </p>
                            <code className="block bg-white p-2 rounded border border-slate-250 font-mono text-[10px] text-emerald-800 leading-normal mb-1">
                              Ratio = Trade Turnover / Total Turnover
                            </code>
                            <code className="block bg-white p-2 rounded border border-slate-250 font-mono text-[10px] text-emerald-800 leading-normal">
                              Allocated Charge = Total Charge × Ratio
                            </code>
                          </div>

                          <div className="bg-slate-100 p-3 rounded-xl border border-slate-200">
                            <h4 className="font-bold text-slate-800 flex items-center justify-between mb-1.5">
                              <span>3. STT (Securities Transaction Tax)</span>
                              <span className="text-[10px] uppercase font-mono text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">Taxation</span>
                            </h4>
                            <p className="text-slate-655 mb-2">STT is computed programmatically by trade class:</p>
                            <div className="bg-white rounded border border-slate-250 overflow-hidden text-[10px]">
                              <table className="w-full text-left border-collapse">
                                <thead className="bg-slate-50 border-b border-slate-200">
                                  <tr>
                                    <th className="p-1 px-2 font-black text-slate-700 text-[9px] uppercase">Class</th>
                                    <th className="p-1 px-2 font-black text-slate-700 text-[9px] uppercase">Buy side</th>
                                    <th className="p-1 px-2 font-black text-slate-700 text-[9px] uppercase">Sell side</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  <tr className="border-b border-slate-100">
                                    <td className="p-1 px-2 font-semibold text-slate-755">Equity Delivery</td>
                                    <td className="p-1 px-2 text-indigo-700 font-mono font-medium">0.10% (0.001)</td>
                                    <td className="p-1 px-2 text-indigo-700 font-mono font-medium">0.10% (0.001)</td>
                                  </tr>
                                  <tr className="border-b border-slate-100">
                                    <td className="p-1 px-2 font-semibold text-slate-755">Equity Intraday</td>
                                    <td className="p-1 px-2 text-slate-400 font-mono">0.00%</td>
                                    <td className="p-1 px-2 text-indigo-700 font-mono font-medium">0.025% (0.00025)</td>
                                  </tr>
                                  <tr>
                                    <td className="p-1 px-2 font-semibold text-slate-755">ETFs (All)</td>
                                    <td className="p-1 px-2 text-slate-400 font-mono">0.00%</td>
                                    <td className="p-1 px-2 text-slate-400 font-mono">0.00%</td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          </div>

                          <div className="bg-slate-100 p-3 rounded-xl border border-slate-200">
                            <h4 className="font-bold text-slate-800 flex items-center justify-between mb-1">
                              <span>4. Stamp Duty Allocation</span>
                              <span className="text-[10px] uppercase font-mono text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded">Levies</span>
                            </h4>
                            <p className="mb-1.5 text-slate-655 font-sans">
                              Stamp Duty is legally charged strictly on <strong>BUY</strong> transactions:
                            </p>
                            <code className="block bg-white p-2 rounded border border-slate-250 font-mono text-[10px] text-purple-800 leading-normal">
                              Buy_Ratio = Buy Turnover / Total Buy Turnover
                              {"\n"}
                              Stamp_Duty_Alloc = Total Stamp Duty × Buy_Ratio
                            </code>
                          </div>

                          <div className="bg-slate-100 p-3 rounded-xl border border-slate-200">
                            <h4 className="font-bold text-slate-800 flex items-center justify-between mb-1">
                              <span>5. Goods & Services Tax (GST)</span>
                              <span className="text-[10px] uppercase font-mono text-blue-605 bg-blue-50 px-1.5 py-0.5 rounded">GST</span>
                            </h4>
                            <p className="mb-1 text-slate-655">
                              GST is calculated at 18% of sum of services values:
                            </p>
                            <code className="block bg-white p-2 rounded border border-slate-250 font-mono text-[10px] text-blue-800 leading-normal">
                              GST Base = Brokerage + ETC + SEBI Fee + Clearing Charges
                              {"\n"}
                              Calculated GST = GST Base × 18%
                            </code>
                          </div>
                          
                        </div>
                      </div>
                    ) : selectedLogicBroker === 'shareindia' ? (
                      <div className="space-y-4 animate-fadeIn">
                        <div className="p-4 rounded-xl bg-slate-900 text-white shadow-md">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                            <h3 className="text-xs font-black tracking-wider uppercase text-red-400">Share India Calculation Model</h3>
                          </div>
                          <p className="text-[11px] text-slate-300 leading-relaxed font-sans">
                            Mathematical rules used dynamically by the Share India extension of the Standard note layout engine.
                          </p>
                        </div>

                        {/* Share India details */}
                        <div className="space-y-3.5 text-xs text-slate-700 leading-relaxed">
                          
                          <div className="bg-slate-100 p-3 rounded-xl border border-slate-200">
                            <h4 className="font-bold text-slate-800 flex items-center justify-between mb-1">
                              <span>1. Taxable Value & Services</span>
                              <span className="text-[10px] uppercase font-mono text-slate-600 bg-slate-200 px-1.5 py-0.5 rounded">Source</span>
                            </h4>
                            <p className="text-slate-655">
                              Extracts the precise taxable values lines directly from the HTML/PDF summary block. If the CGST/SGST/IGST coordinates are not matching perfectly, the engine triggers a local 18% GST recalculation safety checker.
                            </p>
                          </div>

                          <div className="bg-slate-100 p-3 rounded-xl border border-slate-200">
                            <h4 className="font-bold text-slate-800 flex items-center justify-between mb-1">
                              <span>2. STT Classification & Logic</span>
                              <span className="text-[10px] uppercase font-mono text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">Classification</span>
                            </h4>
                            <p className="mb-2 text-slate-655">
                              Classifies trades automatically based on same-day round-tripping or explicit keywords (<em>CNC, MIS, Intraday</em>):
                            </p>
                            <code className="block bg-white p-2 rounded border border-slate-250 font-mono text-[10px] text-amber-800 leading-normal">
                              If Intraday Buy: STT = 0% {"\n"}
                              If Intraday Sell: STT = 0.025% × Turnover {"\n"}
                              If Delivery (Buy or Sell): STT = 0.1% × Turnover
                            </code>
                          </div>

                          <div className="bg-slate-100 p-3 rounded-xl border border-slate-200">
                            <h4 className="font-bold text-slate-800 flex items-center justify-between mb-1">
                              <span>3. Allocations Framework</span>
                              <span className="text-[10px] uppercase font-mono text-rose-600 bg-rose-50 px-1.5 py-0.5 rounded font-bold">Proration Math</span>
                            </h4>
                            <p className="mb-1 text-slate-655">The proration ensures exact totals balance:</p>
                            <code className="block bg-white p-2 rounded border border-slate-250 font-mono text-[10px] text-rose-800 leading-normal">
                              Trade Brokerage = Summary Taxable Value × Ratio{"\n"}
                              Trade ETC = Summary ETC × Ratio{"\n"}
                              GST = (Allocated Brokerage + Allocated ETC) × 18%
                            </code>
                          </div>

                          <div className="bg-slate-100 p-3 rounded-xl border border-slate-200">
                            <h4 className="font-bold text-slate-800 flex items-center justify-between mb-1">
                              <span>4. Stamp Duty Allocation</span>
                              <span className="text-[10px] uppercase font-mono text-purple-650 bg-purple-50 px-1.5 py-0.5 rounded">Rules</span>
                            </h4>
                            <p className="text-slate-655">
                              Like the Zerodha engine, Share India allocates stamp duty exclusively back to buying actions. Intraday or delivery buys share total stamp duty based on buy share volume metrics.
                            </p>
                          </div>

                        </div>
                      </div>
                    ) : selectedLogicBroker === 'integrated' ? (
                      <div className="space-y-4 animate-fadeIn">
                        <div className="p-4 rounded-xl bg-slate-900 text-white shadow-md">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
                            <h3 className="text-xs font-black tracking-wider uppercase text-indigo-400">Integrated Calculation Model</h3>
                          </div>
                          <p className="text-[11px] text-slate-300 leading-relaxed font-sans">
                            Mathematical rules used dynamically by the Integrated Master Securities parser.
                          </p>
                        </div>

                        <div className="space-y-3.5 text-xs text-slate-700 leading-relaxed">
                          <div className="bg-slate-100 p-3 rounded-xl border border-slate-200">
                            <h4 className="font-bold text-slate-800 flex items-center justify-between mb-1">
                              <span>1. Direct Allocation</span>
                              <span className="text-[10px] uppercase font-mono text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">Source</span>
                            </h4>
                            <p className="text-slate-655">
                              Extracts the values directly per row instead of pro-rating the final total from the summary page like Zerodha and Share India.
                            </p>
                          </div>
                          <div className="bg-slate-100 p-3 rounded-xl border border-slate-200">
                            <h4 className="font-bold text-slate-800 flex items-center justify-between mb-1">
                              <span>2. High-Precision Check</span>
                              <span className="text-[10px] uppercase font-mono text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded font-bold">Summing</span>
                            </h4>
                            <p className="mb-1.5 text-slate-655 font-sans">
                              Verifies that the sum of the rows equals exactly the grand total shown on the summary page.
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="p-4 border-t border-slate-150 bg-slate-50 text-[11px] text-slate-450 leading-relaxed font-sans">
                Need to fine-tune the mathematical ratios or add customized rates? Open a file change request directly in the editor under <code className="bg-slate-200 px-1.5 py-0.5 rounded text-slate-705">/src/lib/brokers</code>.
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <main className="max-w-7xl mx-auto px-4 py-8 bg-transparent">
        {currentView === 'dashboard' ? (
          <Dashboard
            holdings={holdings}
            cashBalance={cashBalance}
            setCashBalance={setCashBalance}
            onNavigate={setCurrentView}
            onOpenPortfolio={(id) => {
              setActivePortfolio(id);
              setIsDetailView(true);
              setCurrentView('holdings');
            }}
          />
        ) : currentView === 'holdings' ? (
          <Holdings
            holdings={holdings}
            setHoldings={setHoldings}
            parsedContractNote={data}
            activePortfolio={activePortfolio}
            setActivePortfolio={setActivePortfolio}
            isDetailView={isDetailView}
            setIsDetailView={setIsDetailView}
            onOpenReport={(f) => { setReportsFocus(f); setCurrentView('reports'); }}
          />
        ) : currentView === 'reports' ? (
          <Reports
            focus={reportsFocus}
            onClearFocus={() => setReportsFocus(null)}
          />
        ) : (
          <>
            {/* Imports sub-view toggle: Import vs Import History */}
            <div className="flex justify-center mb-6">
              <div className="inline-flex items-center p-1 bg-white border border-slate-200 rounded-xl shadow-xs">
                <button
                  type="button"
                  onClick={() => setImportPageTab('import')}
                  className={`px-5 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer ${importPageTab === 'import' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-50'}`}
                >
                  Import
                </button>
                <button
                  type="button"
                  onClick={() => setImportPageTab('history')}
                  className={`px-5 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer ${importPageTab === 'history' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-50'}`}
                >
                  Import History
                </button>
                <button
                  type="button"
                  onClick={() => setImportPageTab('screener')}
                  className={`px-5 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer ${importPageTab === 'screener' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-50'}`}
                >
                  Securities &amp; Prices
                </button>
                <button
                  type="button"
                  onClick={() => setImportPageTab('opening')}
                  className={`px-5 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer ${importPageTab === 'opening' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:bg-slate-50'}`}
                >
                  Opening Basis
                </button>
              </div>
            </div>

            {importPageTab === 'history' && <ImportHistory />}

            {importPageTab === 'screener' && <ScreenerImport />}

            {importPageTab === 'opening' && <OpeningBasisImport />}

            {importPageTab === 'import' && activeTab === 'analyse' && (
              <div className="space-y-6">
            {!data && !isLoading && (
              <div className="text-center max-w-3xl mx-auto mt-6 space-y-5">
                {/* Broker Selection Control Panel */}
                <div className="flex flex-col items-center justify-center space-y-2 mb-2">
                  <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Select Broker Contract Note Source</span>
                  <div className="inline-flex items-center justify-center p-1 bg-white border border-slate-200/80 shadow-xs rounded-xl overflow-hidden max-w-full">
                    <button
                      id="btn-broker-zerodha"
                      type="button"
                      onClick={() => setBroker('zerodha')}
                      className={`flex items-center justify-center gap-2 px-5 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer ${broker === 'zerodha' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-650 hover:text-slate-900 hover:bg-slate-50'}`}
                    >
                      <span>Zerodha</span>
                    </button>
                    <button
                      id="btn-broker-shareindia"
                      type="button"
                      onClick={() => setBroker('shareindia')}
                      className={`flex items-center justify-center gap-2 px-5 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer ${broker === 'shareindia' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-650 hover:text-slate-900 hover:bg-slate-50'}`}
                    >
                      <span className="flex items-center gap-1 font-bold">
                        <span>Share</span>
                        <span>India</span>
                      </span>
                    </button>
                    <button
                      id="btn-broker-integrated"
                      type="button"
                      onClick={() => setBroker('integrated')}
                      className={`flex items-center justify-center gap-2 px-5 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer ${broker === 'integrated' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-650 hover:text-slate-900 hover:bg-slate-50'}`}
                    >
                      <span>Integrated</span>
                    </button>
                    <button
                      id="btn-broker-txnreport"
                      type="button"
                      onClick={() => setBroker('transaction-report')}
                      title="Upload a broker transaction report PDF to seed historical trades"
                      className={`flex items-center justify-center gap-2 px-5 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer ${broker === 'transaction-report' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-650 hover:text-slate-900 hover:bg-slate-50'}`}
                    >
                      <span>Txn Report</span>
                    </button>
                  </div>
                </div>

                {/* Transaction report has no embedded portfolio code — pick the destination sheet */}
                {broker === 'transaction-report' && (
                  <div className="flex flex-col items-center justify-center space-y-2 mb-2">
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Export To Portfolio Sheet</span>
                    <select
                      value={txnReportPortfolio}
                      onChange={(e) => setTxnReportPortfolio(e.target.value)}
                      className="px-4 py-2 text-xs font-bold text-slate-700 bg-white border border-slate-200/80 shadow-xs rounded-xl outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
                    >
                      {PORTFOLIOS.map((p) => (
                        <option key={p.id} value={p.id}>{p.code} · {p.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div
                  className={`relative flex flex-col items-center justify-center h-64 border-2 border-dashed rounded-2xl transition-all ${dragging ? 'border-indigo-500 bg-indigo-50/50' : 'border-slate-300/70 glass-soft shadow-sm hover:border-indigo-400'}`}
                  onDragEnter={() => setDragging(true)}
                  onDragLeave={() => setDragging(false)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={onDrop}
                >
                  <input 
                    ref={fileInputRef} 
                    type="file" 
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" 
                    onChange={(e) => e.target.files && handleFileUpload(e.target.files)} 
                    accept={broker === 'transaction-report' ? '.csv,.pdf' : broker === 'zerodha' ? '.pdf' : broker === 'integrated' ? '.htm,.html' : '.pdf,.html,.htm'}
                    multiple 
                    disabled={isLoading} 
                  />
                  <div className="text-center px-4 pointer-events-none">
                    <div className="relative inline-block mb-4">
                      <Upload className="mx-auto w-12 h-12 text-indigo-400" />
                    </div>
                    
                    <p className="text-xl md:text-2xl font-black text-slate-800 tracking-tight leading-tight">
                      {broker === 'transaction-report'
                        ? "Drop the broker transaction report here"
                        : `Drop ${broker === 'shareindia' ? "Share India" : broker === 'zerodha' ? "Zerodha" : broker === 'integrated' ? "Integrated" : "your"} contract notes here`}
                    </p>
                    <div className="flex items-center justify-center gap-2 mt-3">
                      <span className="px-4 py-2 bg-indigo-50 text-indigo-700 rounded-lg text-sm font-bold shadow-sm pointer-events-auto">Browse Files</span>
                    </div>
                    <p className="text-xs font-semibold text-slate-500 mt-3">
                      {broker === 'integrated'
                        ? `Only HTM/HTML files.`
                        : broker === 'transaction-report'
                          ? `Transaction report CSV (preferred) or PDF — seeds historical trades.`
                          : `PDFs Contract Note valid only`
                      }
                    </p>
                  </div>
                </div>
              </div>
            )}

            {isLoading && (
              <div className="text-center py-20 max-w-md mx-auto">
                <CubeLoader className="w-16 mx-auto mb-4 text-indigo-600" />
                <p className="text-slate-800 font-bold text-md">Parsing Contract Notes</p>
                <p className="text-slate-400 text-xs mt-1">Processing {fileCount.processed}/{fileCount.total} files inside sandboxed container...</p>
              </div>
            )}

            <AnimatePresence>
              {isPasswordRequired && (
                <div className="max-w-md mx-auto mb-8 bg-indigo-50 p-6 rounded-2xl border border-indigo-250 shadow-sm animate-fadeIn">
                  <div className="flex gap-2.5 items-center mb-3">
                    <AlertCircle className="w-5 h-5 text-indigo-700" />
                    <p className="text-sm text-indigo-900 font-black uppercase tracking-wide">Enter PDF Password</p>
                  </div>
                  <div className="flex gap-2">
                    <input type="password" placeholder="e.g. ABCDE1234F" value={pdfPassword} onChange={(e) => setPdfPassword(e.target.value)} className="flex-1 px-4 py-2 text-xs font-mono uppercase rounded-xl border border-indigo-200 outline-none max-w-[200px]" />
                    <button onClick={() => handleFileUpload(pendingFiles)} className="bg-indigo-600 text-white px-5 py-2 rounded-xl text-xs font-bold shadow shadow-indigo-200">Unlock PDF</button>
                    <button onClick={() => { setIsPasswordRequired(false); setPendingFiles(null); }} className="px-3 py-2 text-slate-500 font-bold text-xs bg-slate-100 rounded-xl">Cancel</button>
                  </div>
                </div>
              )}
              {error && <div className="max-w-2xl mx-auto mb-8 p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm font-medium flex items-center gap-2"><AlertCircle className="w-5 h-5 flex-shrink-0" />{error}</div>}
            </AnimatePresence>

            {data && (
              <div className="space-y-6">
                
                {/* RECONCILIATION TEACHER STATUS BAR (Step 4) */}
                {data.reconciliation && (
                  <div className={`p-5 rounded-2xl border flex flex-col md:flex-row items-start justify-between gap-6 shadow-sm ${data.reconciliation.isValid ? 'bg-emerald-50/70 border-emerald-250 text-emerald-900' : 'bg-red-55/90 border-rose-300 text-rose-950'}`}>
                    <div className="flex items-start gap-4">
                      <div className={`p-3 rounded-full mt-0.5 ${data.reconciliation.isValid ? 'bg-emerald-100/90 text-emerald-700' : 'bg-rose-100/90 text-red-650'}`}>
                        {data.reconciliation.isValid ? <Check className="w-6 h-6 stroke-[3px]" /> : <ShieldAlert className="w-6 h-6 stroke-[2px]" />}
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2.5">
                          <h3 className="text-lg font-black tracking-tight leading-none">
                            {data.reconciliation.isSuspiciousStt ? "Suspicious STT Extraction Detected" : (data.reconciliation.isSttMismatch ? "STT Validation Mismatch" : (data.reconciliation.isValid ? "Reconciliation Audit Passed" : "Parser uncertain"))}
                          </h3>
                          <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded font-mono ${data.reconciliation.isValid ? 'bg-emerald-200 text-emerald-900' : 'bg-red-250 text-red-900'}`}>
                            {data.reconciliation.statusText}
                          </span>
                        </div>
                        <p className="text-xs opacity-85 leading-relaxed max-w-3xl">
                          {data.reconciliation.isSuspiciousStt
                            ? `Mathematical safety alert: Extracted STT is critically low (₹${data.summary.stt}) given your high turnover of ₹${(data.reconciliation.totalBuys + data.reconciliation.totalSells).toLocaleString('en-IN')}. This usually implies the extraction isolated a spurious list item or footnote integer.`
                            : data.reconciliation.isSttMismatch
                              ? `STT validation failure: The trade-level STT calculation sums to ₹${data.trades.reduce((sum, t) => sum + t.stt, 0).toLocaleString('en-IN')} (Delivery: 0.1%, Intraday Sell: 0.025%), but the note's summary STT is ₹${data.summary.stt.toLocaleString('en-IN')}. This mismatch exceeds our tolerance.`
                              : (data.reconciliation.isValid 
                                  ? `Mathematical verification perfect: Sells (₹${data.reconciliation.totalSells.toLocaleString('en-IN')}) minus Buys (₹${data.reconciliation.totalBuys.toLocaleString('en-IN')}) minus Charges (₹${data.reconciliation.totalCharges.toLocaleString('en-IN')}) aligns perfectly with the extracted net receivable of ₹${data.reconciliation.extractedNet.toLocaleString('en-IN')}.`
                                  : `Accounting check failure: Sells minus Buys minus Charges does not equal the Net Settlement value. Our mismatch calculation shows a difference of ₹${data.reconciliation.difference.toLocaleString('en-IN')} (Tolerance is 10 paise).`
                                )
                          }
                        </p>
                      </div>
                    </div>
                    
                    <div className="text-left md:text-right shrink-0">
                      <span className="text-[10px] font-semibold uppercase tracking-wider block opacity-75">Verification Variance</span>
                      <span className={`text-md font-black font-mono block mt-0.5 ${data.reconciliation.isValid ? 'text-emerald-800' : 'text-rose-900'}`}>
                        {data.reconciliation.isValid ? '₹0.00' : `₹${data.reconciliation.difference.toLocaleString('en-IN')}`}
                      </span>
                    </div>
                  </div>
                )}

                {/* DETAILED TEACHER CALCULATION PANEL IF MISMATCH ON ANALYSE */}
                {data.reconciliation && !data.reconciliation.isValid && (
                  <div className="bg-rose-50/50 p-6 rounded-2xl border border-rose-200 shadow-inner grid grid-cols-1 md:grid-cols-2 gap-6 text-xs text-rose-950">
                    <div className="space-y-4">
                      <div>
                        <h4 className="font-extrabold text-sm text-rose-900 flex items-center gap-1.5 font-sans uppercase">
                          <AlertTriangle className="w-4 h-4 text-red-600" /> Reconciliation Arithmetic Discrepancy details
                        </h4>
                        <p className="text-rose-800/80 mt-1 leading-relaxed">
                          This reconciliation teacher calculates exactly where the parser is failing constraints. Here is the strict validation audit trail run against this note:
                        </p>
                      </div>

                      <div className="bg-white/80 p-4 rounded-xl border border-rose-150 space-y-2.5 font-mono shadow-sm">
                        <div className="flex justify-between border-b border-rose-100 pb-1.5">
                          <span className="text-slate-500">Sells Gross</span>
                          <span className="font-bold text-slate-800">₹{data.reconciliation.totalSells.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between border-b border-rose-100 pb-1.5">
                          <span className="text-slate-500">Buys Gross</span>
                          <span className="font-bold text-slate-800">₹{data.reconciliation.totalBuys.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between border-b border-rose-100/50 pb-1.5">
                          <span className="text-slate-500 font-bold">A) Buy/Sell Obligation (Sells - Buys)</span>
                          <span className={`font-bold ${data.reconciliation.calculatedObligation >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                            ₹{data.reconciliation.calculatedObligation.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                          </span>
                        </div>
                        <div className="flex justify-between border-b border-rose-100 pb-1.5">
                          <span className="text-slate-500 font-bold">B) Extracted Obligation of CN</span>
                          <span className="font-bold text-slate-800">₹{data.reconciliation.extractedObligation.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col justify-between">
                      <div className="bg-white/80 p-4 rounded-xl border border-rose-150 space-y-2.5 font-mono shadow-sm">
                        <div className="flex justify-between border-b border-rose-100 pb-1.5">
                          <span className="text-slate-500 font-bold">C) Sum of Charges + Brokerage (Levies)</span>
                          <span className="font-bold text-amber-700">₹{data.reconciliation.totalCharges.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between border-b border-rose-100 pb-1.5">
                          <span className="text-slate-500 font-bold">Calculated Net Settlement (A - C)</span>
                          <span className={`font-bold ${data.reconciliation.calculatedNet >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                            ₹{data.reconciliation.calculatedNet.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                          </span>
                        </div>
                        <div className="flex justify-between border-b border-rose-100 pb-1.5 text-indigo-800 font-bold">
                          <span>Extracted Net Settlement of CN</span>
                          <span>₹{data.reconciliation.extractedNet.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between text-red-700 font-black">
                          <span>D) Arithmetic Mismatch Variance</span>
                          <span>₹{data.reconciliation.difference.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      </div>

                      <div className="p-3 bg-red-100 border border-red-200 rounded-xl text-[11px] text-red-800 font-bold mt-4 leading-relaxed">
                        {data.reconciliation.isSuspiciousStt
                          ? `⚠️ ALERT: Securities Transaction Tax (STT) extracted is ₹${data.summary.stt} which is statistically impossible on a turnover of ₹${(data.reconciliation.totalBuys + data.reconciliation.totalSells).toLocaleString('en-IN')}. This suggests spurious footnotes or list tags were incorrectly parsed as the STT fee.`
                          : data.reconciliation.isSttMismatch
                            ? `⚠️ ALERT: There is an STT mismatch of ₹${Math.abs(data.trades.reduce((sum, t) => sum + t.stt, 0) - data.summary.stt).toLocaleString('en-IN')}. Delivery STT is strictly 0.1% of turnover and Intraday STT is 0.025% on Sell trades. Ensure the extracted securities and categories are complete.`
                            : "⚠️ ALERT: Sells minus Buys minus Charges fails to equal the Net Settlement value. Do not trust these extracted values for regulatory tax filings directly without verification."
                        }
                      </div>
                    </div>
                  </div>
                )}

                {/* Main panel header card */}
                <div 
                  className="relative flex flex-col md:flex-row justify-between items-start md:items-center gap-6 bg-white overflow-hidden rounded-xl border border-slate-200 mb-6"
                  style={{ 
                    boxShadow: '0 1px 2px rgba(15,23,42,0.06), 0 8px 24px rgba(15,23,42,0.08)'
                  }}
                >
                  {/* Subtle top gradient accent */}
                  <div className="absolute top-0 left-0 right-0 h-[4px] bg-gradient-to-r from-blue-600 via-indigo-650 to-violet-600"></div>
                  
                  {/* Subtle glow / noise background effect */}
                  <div className="absolute top-0 left-0 w-full h-full pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle at top left, rgba(59,130,246,0.08), transparent 45%), url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22 opacity=%220.02%22/%3E%3C/svg%3E")' }}></div>

                  {/* Subtle abstract trading graph watermark in the middle background */}
                  <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-48 hidden lg:flex items-center justify-center opacity-[0.04] pointer-events-none select-none">
                    <svg viewBox="0 0 100 40" className="w-full h-12 text-slate-900 fill-none stroke-current" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="10" y1="30" x2="10" y2="10" />
                      <rect x="7" y="15" width="6" height="10" fill="currentColor" />
                      <line x1="25" y1="35" x2="25" y2="15" />
                      <rect x="22" y="20" width="6" height="12" fill="currentColor" />
                      <line x1="40" y1="20" x2="40" y2="5" strokeWidth="1" />
                      <rect x="37" y="8" width="6" height="8" fill="none" />
                      <line x1="55" y1="28" x2="55" y2="12" strokeWidth="1" />
                      <rect x="52" y="15" width="6" height="10" fill="currentColor" />
                      <line x1="70" y1="18" x2="70" y2="32" strokeWidth="1" />
                      <rect x="67" y="20" width="6" height="8" fill="none" />
                      <line x1="85" y1="15" x2="85" y2="35" />
                      <rect x="82" y="22" width="6" height="10" fill="currentColor" />
                    </svg>
                  </div>

                  <div className="relative flex flex-col z-10 p-6 sm:p-10">
                    <div className="flex items-center gap-4">
                      <div className="p-3 bg-blue-50/80 text-blue-600 rounded-xl border border-blue-100 flex items-center justify-center">
                        <BarChart3 className="w-7 h-7 stroke-[2.25px]" />
                      </div>
                      <div className="flex flex-col">
                        <h2 className="text-[32px] sm:text-[36px] font-bold text-slate-900 leading-[1.1]" style={{ letterSpacing: '-0.03em', fontFamily: 'Inter, system-ui, sans-serif' }}>
                          Trade Summary
                        </h2>
                        <span className="text-sm font-medium text-slate-600 mt-1.5 opacity-90">
                          Extracted from <span className="font-extrabold text-slate-800">{data.trades.length}</span> processed trades
                        </span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="relative z-10 p-6 sm:p-10 w-full md:w-auto flex flex-col sm:flex-row gap-4 items-center justify-start md:justify-end">
                    {(data.brokerName === 'shareindia' || data.brokerName === 'integrated') && data.ucc && (
                      <div className="bg-[#0f172a] text-white rounded-[12px] px-6 py-5 flex flex-col justify-center min-w-[170px] shadow-[0_4px_20px_rgba(15,23,42,0.15)] border border-slate-800 hover:shadow-2xl transition-all relative overflow-hidden w-full sm:w-auto text-center sm:text-right">
                        {/* Subtle highlight in the UCC card */}
                        <div className="absolute inset-x-0 top-0 h-px bg-slate-600 opacity-40"></div>
                        <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 mb-0.5 leading-none">UCC</span>
                        <span className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white leading-none mt-1">{data.ucc}</span>
                      </div>
                    )}
                    {data.tradeDate && (
                      <div className="bg-[#0f172a] text-white rounded-[12px] px-6 py-5 flex flex-col justify-center min-w-[170px] shadow-[0_4px_20px_rgba(15,23,42,0.15)] border border-slate-800 hover:shadow-2xl transition-all relative overflow-hidden w-full sm:w-auto text-center sm:text-right">
                        {/* Subtle highlight in the date card */}
                        <div className="absolute inset-x-0 top-0 h-px bg-slate-600 opacity-40"></div>
                        <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 mb-0.5 leading-none">Trade Date</span>
                        <span className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white leading-none mt-1">{(() => {
                          const parts = data.tradeDate.split(/[-/]/);
                          if (parts.length === 3) {
                            const isMonthNum = !isNaN(Number(parts[1]));
                            if (isMonthNum) {
                              const d = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
                              if (!isNaN(d.getTime())) {
                                const day = d.getDate().toString().padStart(2, '0');
                                const month = d.toLocaleString('en-US', { month: 'short' });
                                const year = d.getFullYear();
                                return `${day} ${month} ${year}`;
                              }
                            } else {
                              return data.tradeDate;
                            }
                          }
                          return data.tradeDate;
                        })()}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-start sm:justify-end gap-3 mb-4">
                    <button 
                      onClick={() => setShowLedgerConfig(!showLedgerConfig)} 
                      className={`px-4 py-2.5 text-xs font-bold rounded-xl flex items-center gap-1.5 border transition-all duration-200 transform hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] ${
                        showLedgerConfig 
                          ? 'bg-indigo-50 text-indigo-750 border-indigo-200' 
                          : 'bg-white hover:bg-slate-50 text-slate-755 border-slate-200'
                      }`}
                      style={{ boxShadow: '0 1px 2px rgba(15,23,42,0.05)' }}
                      title="Configure ledger names for accounting import"
                    >
                      <Calculator className="w-3.5 h-3.5 text-slate-500" />
                      Ledger Mappings
                    </button>

                    <button 
                      onClick={() => setData(null)} 
                      className="px-4 py-2.5 text-xs font-bold rounded-xl transition-all duration-200 transform hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] border border-red-900"
                      style={{ 
                        boxShadow: '0 1px 2px rgba(15,23,42,0.05)',
                        backgroundColor: '#7f0000',
                        color: '#ffffff'
                      }}
                    >
                      Clear Note
                    </button>
                    
                    <button
                      onClick={downloadVoucherXML}
                      className="px-5 py-2.5 text-xs font-black text-white bg-[#0f766e] hover:bg-[#0d5c56] rounded-xl transition-all duration-200 transform hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] flex items-center gap-1.5"
                      style={{ boxShadow: '0 1px 2px rgba(15,118,110,0.06), 0 6px 16px rgba(15,118,110,0.1)' }}
                    >
                      <Download className="w-4 h-4" />
                      Export Tally XML
                    </button>

                    <button
                      onClick={downloadVoucherExcel}
                      className="px-4 py-2.5 text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 transition-all duration-200 transform hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] flex items-center gap-1.5 rounded-xl"
                      style={{ boxShadow: '0 1px 2px rgba(15,23,42,0.05)' }}
                    >
                      <FileText className="w-3.5 h-3.5 text-slate-500" />
                      Export Tally Excel
                    </button>

                    <div className="relative">
                      <button
                        onClick={handleExportClick}
                        disabled={isImportingToSheets || sheetsImportStatus?.success === true}
                        className={`px-5 py-2.5 text-xs font-black text-white rounded-xl transition-all duration-200 transform active:translate-y-0 active:scale-[0.98] flex items-center gap-1.5 ${
                          sheetsImportStatus?.success
                            ? 'bg-blue-600 cursor-not-allowed'
                            : sheetsImportStatus?.error
                              ? 'bg-rose-600 hover:bg-rose-700 hover:-translate-y-0.5'
                              : data.reconciliation && !data.reconciliation.isValid
                                ? 'bg-amber-600 hover:bg-amber-700 hover:-translate-y-0.5'
                                : 'bg-[#10b981] hover:bg-[#059669] hover:-translate-y-0.5'
                        } ${isImportingToSheets ? 'opacity-75 cursor-not-allowed' : ''}`}
                        style={{
                          boxShadow: sheetsImportStatus?.success
                            ? '0 1px 2px rgba(37,99,235,0.06), 0 8px 18px rgba(37,99,235,0.12)'
                            : sheetsImportStatus?.error
                              ? '0 1px 2px rgba(225,29,72,0.06), 0 8px 18px rgba(225,29,72,0.12)'
                              : data.reconciliation && !data.reconciliation.isValid
                                ? '0 1px 2px rgba(217,119,6,0.06), 0 6px 16px rgba(217,119,6,0.1)'
                                : '0 1px 2px rgba(16,185,129,0.06), 0 8px 18px rgba(16,185,129,0.1)'
                        }}
                      >
                        {isImportingToSheets ? (
                          <RefreshCw className="w-4 h-4 animate-spin" />
                        ) : sheetsImportStatus?.success ? (
                          <CheckCircle2 className="w-4 h-4" />
                        ) : sheetsImportStatus?.error ? (
                          <AlertTriangle className="w-4 h-4" />
                        ) : data.reconciliation && !data.reconciliation.isValid ? (
                          <AlertTriangle className="w-4 h-4" />
                        ) : (
                          <Upload className="w-4 h-4" />
                        )}
                        {isImportingToSheets
                          ? "Importing..."
                          : sheetsImportStatus?.success
                            ? "Imported"
                            : sheetsImportStatus?.error
                              ? "Import Failed — Retry"
                              : data.reconciliation && !data.reconciliation.isValid
                                ? "Import (Mismatch Warning)"
                                : "Import"}
                      </button>

                      {/* Sliding Inline Import Warning Banner overlay */}
                      {showExportConfirmation && (
                        <div className="absolute right-0 top-12 mt-2 p-4 bg-white border border-rose-200 rounded-2xl shadow-xl z-50 min-w-[340px] text-xs space-y-3 animate-fadeIn">
                          <p className="font-bold text-rose-900 flex items-center gap-1">
                            <AlertTriangle className="w-4 h-4 text-red-500" /> Import Warning: Parser Uncertain
                          </p>
                          <p className="text-slate-600 leading-relaxed font-sans">
                            The parser is mathematically uncertain on this note (Discrepancy: ₹${data.reconciliation?.difference}). Do you still wish to proceed with the import?
                          </p>
                          <div className="flex justify-end gap-2 pt-1">
                            <button onClick={() => setShowExportConfirmation(false)} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-750 font-bold rounded-lg">Cancel</button>
                            <button 
                              onClick={importToSheets} 
                              disabled={isImportingToSheets}
                              className="px-3 py-1.5 bg-red-655 hover:bg-red-700 text-white font-bold rounded-lg shadow-sm disabled:opacity-50"
                            >
                              {isImportingToSheets ? "Importing..." : "Yes, Import Anyway"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                {/* Collapsible Ledger Mapping Content */}
                {showLedgerConfig && (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 animate-fadeIn space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
                      <div>
                        <h4 className="text-xs font-black tracking-wider uppercase text-slate-700 flex items-center gap-1.5">
                          <Calculator className="w-4 h-4 text-indigo-600" />
                          Tally Ledger Name Mappings
                        </h4>
                        <p className="text-[10px] text-slate-500 mt-0.5 leading-relaxed font-sans">
                          Enter the exact Ledger Name used in your accounting system. The voucher exporter matches these fields dynamically.
                        </p>
                      </div>
                      <button 
                        onClick={() => {
                          setLedgerMappings(DEFAULT_LEDGER_MAPPINGS);
                          localStorage.setItem('accounting_ledger_mappings', JSON.stringify(DEFAULT_LEDGER_MAPPINGS));
                        }}
                        className="text-[10px] font-bold text-indigo-600 bg-white border border-slate-200 px-3 py-1 rounded-lg hover:bg-slate-100 transition-all self-start sm:self-auto"
                      >
                        Reset Defaults
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                      <div className="space-y-1">
                        <label className="block text-[10px] uppercase font-bold text-slate-500">Broker Ledger</label>
                        <input
                          type="text"
                          value={ledgerMappings.BROKER || ""}
                          onChange={(e) => updateLedgerMapping('BROKER', e.target.value)}
                          className="w-full bg-white px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono outline-indigo-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-[10px] uppercase font-bold text-slate-500">STT Ledger</label>
                        <input
                          type="text"
                          value={ledgerMappings.STT || ""}
                          onChange={(e) => updateLedgerMapping('STT', e.target.value)}
                          className="w-full bg-white px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono outline-indigo-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-[10px] uppercase font-bold text-slate-500">Exchange Charges (ETC)</label>
                        <input
                          type="text"
                          value={ledgerMappings.EXCHANGE || ""}
                          onChange={(e) => updateLedgerMapping('EXCHANGE', e.target.value)}
                          className="w-full bg-white px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono outline-indigo-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-[10px] uppercase font-bold text-slate-500">SEBI Charges Ledger</label>
                        <input
                          type="text"
                          value={ledgerMappings.SEBI || ""}
                          onChange={(e) => updateLedgerMapping('SEBI', e.target.value)}
                          className="w-full bg-white px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono outline-indigo-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-[10px] uppercase font-bold text-slate-500">IPF Charges Ledger</label>
                        <input
                          type="text"
                          value={ledgerMappings.IPF || ""}
                          onChange={(e) => updateLedgerMapping('IPF', e.target.value)}
                          className="w-full bg-white px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono outline-indigo-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-[10px] uppercase font-bold text-slate-500">GST Ledger</label>
                        <input
                          type="text"
                          value={ledgerMappings.GST || ""}
                          onChange={(e) => updateLedgerMapping('GST', e.target.value)}
                          className="w-full bg-white px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono outline-indigo-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-[10px] uppercase font-bold text-slate-500">Brokerage Ledger</label>
                        <input
                          type="text"
                          value={ledgerMappings.BROKERAGE || ""}
                          onChange={(e) => updateLedgerMapping('BROKERAGE', e.target.value)}
                          className="w-full bg-white px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono outline-indigo-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-[10px] uppercase font-bold text-slate-500">Stamp Duty Ledger</label>
                        <input
                          type="text"
                          value={ledgerMappings.STAMP_DUTY || ""}
                          onChange={(e) => updateLedgerMapping('STAMP_DUTY', e.target.value)}
                          className="w-full bg-white px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono outline-indigo-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-[10px] uppercase font-bold text-slate-500">Clearing Charges Ledger</label>
                        <input
                          type="text"
                          value={ledgerMappings.CLEARING || ""}
                          onChange={(e) => updateLedgerMapping('CLEARING', e.target.value)}
                          className="w-full bg-white px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono outline-indigo-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-[10px] uppercase font-bold text-slate-500">Rounded Off Ledger</label>
                        <input
                          type="text"
                          value={ledgerMappings.ROUNDED_OFF || ""}
                          onChange={(e) => updateLedgerMapping('ROUNDED_OFF', e.target.value)}
                          className="w-full bg-white px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono outline-indigo-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-[10px] uppercase font-bold text-slate-500">Voucher Prefix</label>
                        <input
                          type="text"
                          value={ledgerMappings.VOUCHER_PREFIX || ""}
                          onChange={(e) => updateLedgerMapping('VOUCHER_PREFIX', e.target.value)}
                          placeholder="COMBINED/"
                          className="w-full bg-white px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono outline-indigo-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-[10px] uppercase font-bold text-slate-500">Starting Voucher No</label>
                        <input
                          type="text"
                          value={ledgerMappings.VOUCHER_START_NUMBER || ""}
                          onChange={(e) => updateLedgerMapping('VOUCHER_START_NUMBER', e.target.value)}
                          placeholder="1524"
                          className="w-full bg-white px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono outline-indigo-500"
                        />
                      </div>
                      <div className="space-y-1 md:col-span-2">
                        <label className="block text-[10px] uppercase font-bold text-slate-500">Shares Name Format Template</label>
                        <input
                          type="text"
                          value={ledgerMappings.SHARES_TEMPLATE || ""}
                          onChange={(e) => updateLedgerMapping('SHARES_TEMPLATE', e.target.value)}
                          placeholder="{securityName} (Shares)"
                          className="w-full bg-white px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono outline-indigo-500"
                        />
                        <span className="text-[9px] text-slate-400 font-sans block block-inline mt-0.5">Use <code>{`{securityName}`}</code> as a dynamic placeholder.</span>
                      </div>
                      <div className="space-y-1 md:col-span-2">
                        <label className="block text-[10px] uppercase font-bold text-slate-500">Securities Mapping Overrides (One per line: Key=Tally Ledger Name)</label>
                        <textarea
                          rows={3}
                          value={ledgerMappings.SECURITIES_MAPPINGS || ""}
                          onChange={(e) => updateLedgerMapping('SECURITIES_MAPPINGS', e.target.value)}
                          placeholder="GOODLUCK=Goodluck India Ltd (Shares)&#10;LIQUIDCASE=LIQUIDCASE"
                          className="w-full bg-white px-3 py-1.5 border border-slate-150 rounded-lg text-xs font-mono outline-indigo-500"
                        />
                        <span className="text-[9px] text-slate-400 font-sans block block-inline mt-0.5">Define custom mapping rules (e.g. <code>LIQUIDCASE=LIQUIDCASE</code>). Unmatched securities default to the format template above.</span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  <SummaryCard label="Pay In/Out Obligation" value={calculatedTotals.obligation} highlight minFractionDigits={2} maxFractionDigits={isShareIndia ? 4 : 2} />
                  <SummaryCard label="Net Settlement (Incl STT)" value={calculatedTotals.netSettlementInclSTT} highlight minFractionDigits={2} maxFractionDigits={isShareIndia ? 4 : 2} />
                  <SummaryCard label="Net Settlement (Excl STT)" value={calculatedTotals.netSettlementExclSTT} highlight minFractionDigits={2} maxFractionDigits={isShareIndia ? 4 : 2} />
                  <SummaryCard label="Brokerage" value={calculatedTotals.brokerage} labelStyle={{ color: '#000000' }} minFractionDigits={2} maxFractionDigits={isShareIndia ? 4 : 2} />
                  <SummaryCard label="Total STT" value={calculatedTotals.stt} alertState={data.reconciliation && data.reconciliation.isSttMismatch} labelStyle={{ borderColor: '#ffffff', color: '#000000' }} minFractionDigits={2} maxFractionDigits={isShareIndia ? 4 : 2} />
                  <SummaryCard label="Stamp Duty" value={calculatedTotals.stampDuty} labelStyle={{ color: '#000000' }} minFractionDigits={2} maxFractionDigits={isShareIndia ? 4 : 2} />
                  <SummaryCard label="Exchange Charges" value={calculatedTotals.etc} labelStyle={{ color: '#000000' }} minFractionDigits={2} maxFractionDigits={isShareIndia ? 4 : 2} />
                  {data?.brokerName === 'integrated' ? (
                    <SummaryCard label="Total GST" value={calculatedTotals.gst} labelStyle={{ color: '#000000' }} minFractionDigits={2} maxFractionDigits={isShareIndia ? 4 : 2} />
                  ) : (
                    <SummaryCard label="IGST" value={calculatedTotals.igst || calculatedTotals.gst} labelStyle={{ color: '#000000' }} minFractionDigits={2} maxFractionDigits={isShareIndia ? 4 : 2} />
                  )}
                  <SummaryCard label="SEBI Turnover Fees" value={calculatedTotals.sebiFees} labelStyle={{ color: '#000000' }} minFractionDigits={2} maxFractionDigits={isShareIndia ? 4 : 2} />
                  {data?.brokerName === 'integrated' && (
                    <SummaryCard label="IPF Charges" value={calculatedTotals.ipf} labelStyle={{ color: '#000000' }} minFractionDigits={2} maxFractionDigits={isShareIndia ? 4 : 2} />
                  )}
                  {data?.brokerName === 'integrated' && (
                    <SummaryCard label="Demat Charges" value={calculatedTotals.dmat} labelStyle={{ color: '#000000' }} minFractionDigits={2} maxFractionDigits={isShareIndia ? 4 : 2} />
                  )}
                </div>

                <div
                  ref={tradeVR.scrollRef}
                  onScroll={tradesVirtual ? tradeVR.onScroll : undefined}
                  className={`bg-white border border-slate-200 rounded-2xl shadow-sm ${tradesVirtual ? 'overflow-auto max-h-[70vh]' : 'overflow-hidden overflow-x-auto'}`}
                >
                  <table className="w-full text-sm text-left">
                    <thead className={`bg-slate-50 text-slate-600 text-[10px] font-bold uppercase tracking-wider border-b border-slate-200 ${tradesVirtual ? 'sticky top-0 z-10' : ''}`}>
                      <tr>
                        <SortableHeader label="Date" sortKey="tradeDate" className="text-slate-705" />
                        <SortableHeader label="Security" sortKey="securityName" className="text-slate-705" />
                        <SortableHeader label="Type" sortKey="transactionType" align="center" className="text-slate-705" />
                        <SortableHeader label="Shares" sortKey="quantity" align="right" className="text-slate-710" />
                        <SortableHeader label="Price" sortKey="avgPrice" align="right" className="text-slate-720 border-r border-slate-200" />
                        <SortableHeader label="Turnover" sortKey="turnover" align="right" className="text-slate-700 font-bold border-r border-slate-200" />
                        <SortableHeader label="Brokerage" sortKey="brokerage" align="right" className="text-slate-700 font-bold border-r border-slate-200" />
                        <SortableHeader label="STT" sortKey="stt" align="right" className="text-slate-700 font-bold border-r border-slate-200" />
                        {data?.brokerName === 'integrated' ? (
                          <SortableHeader label="Total GST" sortKey="gstOrIgst" align="right" className="text-slate-700 font-bold border-r border-slate-200" />
                        ) : (
                          <SortableHeader label="IGST" sortKey="gstOrIgst" align="right" className="text-slate-700 font-bold border-r border-slate-200" />
                        )}
                        <SortableHeader label="ETC" sortKey="etc" align="right" className="text-slate-700 font-bold border-r border-slate-200" />
                        <SortableHeader label="Stamp Duty" sortKey="stampDuty" align="right" className="text-slate-700 font-bold border-r border-slate-200" />
                        <SortableHeader label="SEBI Fees" sortKey="sebiFees" align="right" className="text-slate-700 font-bold border-r border-slate-200" />
                        {data?.brokerName === 'integrated' && (
                          <SortableHeader label="IPF" sortKey="ipf" align="right" className="text-slate-700 font-bold border-r border-slate-200" />
                        )}
                        <SortableHeader label="Exp (Incl STT)" sortKey="totalExpensesInclSTT" align="right" className="text-slate-700 font-extrabold border-r border-slate-200" />
                        <SortableHeader label="Exp (Excl STT)" sortKey="totalExpensesExclSTT" align="right" className="text-slate-700 font-semibold border-r border-slate-200" />
                        <SortableHeader label="Net (Incl STT)" sortKey="totalInclSTT" align="right" className="text-indigo-900 font-extrabold border-r border-slate-200" />
                        <SortableHeader label="Net (Excl STT)" sortKey="totalExclSTT" align="right" className="text-sky-900 font-extrabold border-r border-slate-200" />
                        <SortableHeader label="Obligation" sortKey="netTotalBeforeLevies" align="right" className="text-slate-900 font-extrabold border-r border-slate-200" />
                        <SortableHeader label="Class" sortKey="tradeType" align="center" className="text-slate-700 font-bold" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-150 font-mono text-xs">
                      {tradesVirtual && tradeVR.padTop > 0 && (
                        <tr aria-hidden="true"><td colSpan={99} style={{ height: tradeVR.padTop, padding: 0, border: 0 }} /></tr>
                      )}
                      {(tradesVirtual ? sortedTrades.slice(tradeVR.start, tradeVR.end) : sortedTrades).map((t, _vi) => {
                        const totalInclSTT = t.transactionType === "Buy"
                          ? t.turnover + t.totalExpensesInclSTT 
                          : t.turnover - t.totalExpensesInclSTT;
                        const totalExclSTT = t.transactionType === "Buy" 
                          ? t.turnover + t.totalExpensesExclSTT 
                          : t.turnover - t.totalExpensesExclSTT;

                        const numDigits = isShareIndia ? 4 : 2;
                        const fmt = (val: number) => val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: isShareIndia ? 4 : 2 });

                        return (
                           <tr key={t.id} ref={tradesVirtual && _vi === 0 ? tradeVR.measureRow : undefined} className="hover:bg-slate-50 transition-colors">
                            <td className="px-6 py-4 text-slate-400 bg-slate-50/10">{t.tradeDate}</td>
                            <td className="px-6 py-4 font-bold text-slate-800 uppercase not-italic bg-slate-50/10">{t.securityName}</td>
                            <td className="px-6 py-4 text-center bg-slate-50/10">
                               <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${t.transactionType === 'Buy' ? 'bg-emerald-100 text-emerald-700 animate-pulse' : 'bg-rose-100 text-rose-700'}`}>{t.transactionType}</span>
                            </td>
                            <td className="px-6 py-4 text-right font-semibold text-slate-700 bg-slate-50/10">{t.quantity}</td>
                            <td className="px-6 py-4 text-right text-slate-700 bg-slate-50/10 border-r border-slate-200">₹{fmt(t.avgPrice)}</td>
                            <td className="px-6 py-4 text-right font-bold text-emerald-950 bg-emerald-50/15 border-r border-emerald-100/30">₹{fmt(t.turnover)}</td>
                            <td className="px-6 py-4 text-right font-semibold text-blue-800 bg-blue-50/15 border-r border-blue-100/30">₹{fmt(t.brokerage)}</td>
                            <td className="px-6 py-4 text-right font-bold text-rose-700 bg-rose-50/20 border-r border-rose-100/30">₹{fmt(t.stt)}</td>
                            {data?.brokerName === 'integrated' ? (
                              <td className="px-6 py-4 text-right font-bold text-violet-800 bg-violet-50/15 border-r border-violet-100/30">₹{fmt(t.gst)}</td>
                            ) : (
                              <td className="px-6 py-4 text-right font-bold text-violet-800 bg-violet-50/15 border-r border-violet-100/30">₹{fmt(t.igst || t.gst)}</td>
                            )}
                            <td className="px-6 py-4 text-right text-amber-900 font-semibold bg-amber-50/15 border-r border-amber-100/30">₹{fmt(t.etc)}</td>
                            <td className="px-6 py-4 text-right text-teal-900 bg-teal-50/15 border-r border-teal-100/30">₹{fmt(t.stampDuty)}</td>
                            <td className="px-6 py-4 text-right text-purple-950 bg-purple-50/15 border-r border-purple-100/30">₹{fmt(t.sebiFees)}</td>
                            {data?.brokerName === 'integrated' && (
                              <td className="px-6 py-4 text-right text-fuchsia-950 bg-fuchsia-50/15 border-r border-fuchsia-100/30">₹{fmt(t.ipf)}</td>
                            )}
                            <td className="px-6 py-4 text-right text-orange-950 font-bold bg-orange-50/15 border-r border-orange-100/30">₹{fmt(t.totalExpensesInclSTT)}</td>
                            <td className="px-6 py-4 text-right text-stone-900 bg-stone-50/15 border-r border-stone-100/30">₹{fmt(t.totalExpensesExclSTT)}</td>
                            <td className="px-6 py-4 text-right text-indigo-950 font-extrabold bg-indigo-50/25 border-r border-indigo-100/40">₹{fmt(totalInclSTT)}</td>
                            <td className="px-6 py-4 text-right text-sky-950 font-bold bg-sky-50/20 border-r border-sky-100/40">₹{fmt(totalExclSTT)}</td>
                            <td className={`px-6 py-4 text-right font-black border-r border-slate-200 ${t.netTotalBeforeLevies >= 0 ? 'text-emerald-700 bg-emerald-50/10' : 'text-rose-700 bg-rose-50/10'}`}>
                              {t.netTotalBeforeLevies >= 0 ? '+' : ''}{fmt(t.netTotalBeforeLevies)}
                            </td>
                            <td className="px-6 py-4 text-center bg-violet-50/10">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${t.tradeType === 'Delivery' ? 'bg-indigo-150 text-indigo-800' : 'bg-amber-150 text-amber-800'}`}>{t.tradeType}</span>
                            </td>
                          </tr>
                        );
                      })}
                      {tradesVirtual && tradeVR.padBottom > 0 && (
                        <tr aria-hidden="true"><td colSpan={99} style={{ height: tradeVR.padBottom, padding: 0, border: 0 }} /></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {data.rawText && (
                  <div className="bg-slate-900 text-slate-100 rounded-3xl border border-slate-800 shadow-xl overflow-hidden p-6 mt-6">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex items-start gap-3">
                        <div className="p-2 bg-slate-800 rounded-xl border border-slate-700 text-slate-300">
                          <FileText className="w-5 h-5 text-indigo-400" />
                        </div>
                        <div>
                          <h3 className="font-bold text-base text-white font-sans">Raw PDF/HTML Extracted Text</h3>
                          <p className="text-xs text-slate-400 font-sans mt-0.5">Below is the literal, whitespace-normalized text extracted from your document, used directly by the parser regex engines.</p>
                        </div>
                      </div>
                      <button
                        onClick={() => setShowRawText(!showRawText)}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white rounded-lg text-xs font-semibold cursor-pointer transition-colors shrink-0"
                      >
                        {showRawText ? "Hide Parsed Text" : "Show Parsed Text"}
                      </button>
                    </div>
                    {showRawText && (
                      <div className="mt-4 relative">
                        <textarea
                          readOnly
                          value={data.rawText}
                          className="w-full h-85 bg-slate-950 text-slate-300 font-mono text-xs p-4 rounded-xl border border-slate-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 leading-relaxed overflow-y-auto resize-y"
                        />
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(data.rawText || '');
                          }}
                          className="absolute right-4 top-4 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white px-2.5 py-1.5 rounded-md text-[10px] font-mono transition-colors border border-slate-700 cursor-pointer"
                        >
                          Copy Text
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'audit' && (
          <CsvAuditor parsedContractNote={data} onImportContractNote={(cn) => setData(cn)} />
        )}

        {/* REGRESSION TEST CENTER (Step 5) */}
        {activeTab === 'tests' && (
          <div className="space-y-6 animate-fadeIn">
            <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-4">
                <div>
                  <h3 className="text-lg font-black text-slate-800 flex items-center gap-2">
                    <ListChecks className="w-5 h-5 text-indigo-600 animate-pulse" />
                    Regression Testing Center
                  </h3>
                  <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                    Protect your parsers against future code breakdowns. Running the test library evaluates the extraction rules instantly against core Indian brokerage templates (including normal, broken, multi-asset, and custom-uploaded structures).
                  </p>
                </div>

                <div className="flex gap-2 shrink-0">
                  <button 
                    onClick={runAllTests} 
                    disabled={isRunningTests}
                    className="bg-indigo-600 hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 text-xs text-white font-black py-2.5 px-4 rounded-xl shadow-sm flex items-center gap-1.5 transition-all cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isRunningTests ? 'animate-spin' : ''}`} />
                    {isRunningTests ? "Executing Tests..." : "Run Validation Suite"}
                  </button>
                  {customCases.length > 0 && (
                    <button 
                      onClick={clearCustomCases}
                      className="bg-slate-100 hover:bg-rose-50 border border-slate-300 hover:border-rose-200 text-slate-600 hover:text-rose-700 text-xs font-bold py-2.5 px-4 rounded-xl transition-all"
                    >
                      Delete Custom Cases ({customCases.length})
                    </button>
                  )}
                </div>
              </div>

              {/* Grid of seed and test case categories */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-4 border-t border-slate-150">
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center gap-3">
                  <Award className="w-10 h-10 text-emerald-600 bg-emerald-100/60 p-2 rounded-xl" />
                  <div>
                    <span className="text-[9px] uppercase font-bold text-slate-400">Golden Test Suite</span>
                    <strong className="block text-sm text-slate-800">{seedRegressionCases.length} Standard Cases</strong>
                  </div>
                </div>
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center gap-3">
                  <PlusCircle className="w-10 h-10 text-indigo-600 bg-indigo-100/60 p-2 rounded-xl" />
                  <div>
                    <span className="text-[9px] uppercase font-bold text-slate-400">User Tests (Persisted)</span>
                    <strong className="block text-sm text-slate-800">{customCases.length} Custom formats</strong>
                  </div>
                </div>
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center gap-3">
                  <Gauge className="w-10 h-10 text-indigo-600 bg-indigo-100/60 p-2 rounded-xl" />
                  <div>
                    <span className="text-[9px] uppercase font-bold text-slate-400">Verification Accuracy</span>
                    <strong className="block text-sm text-slate-800">
                      {testResults.length > 0 
                        ? `${Math.round((testResults.filter(t => t.passed).length / testResults.length) * 100)}% Pass Ratio`
                        : "Ready to Evaluate"}
                    </strong>
                  </div>
                </div>
              </div>
            </div>

            {/* Test Case Outputs Rows */}
            <div className="space-y-4">
              <h4 className="text-xs font-black text-slate-400 font-mono tracking-wider uppercase">Running Test Cases Verification</h4>
              
              {testResults.length === 0 ? (
                <div className="bg-white border rounded-2xl p-10 text-center text-slate-500 text-sm italic shadow-sm hover:border-slate-300 transition-all">
                  <CubeLoader className="w-14 text-slate-400 mx-auto mb-3" />
                  Evaluating test suite libraries in browser loop...
                </div>
              ) : (
                <div className="space-y-3">
                  {testResults.map((tc) => {
                    const seedCase = [...seedRegressionCases, ...customCases].find(c => c.id === tc.caseId);
                    const isExpanded = activeTestDetail === tc.caseId;

                    return (
                      <div key={tc.caseId} className={`border rounded-2xl overflow-hidden transition-all bg-white shadow-sm ${tc.passed ? 'border-emerald-200' : tc.actual?.isValid === false ? 'border-amber-200 hover:border-amber-300' : 'border-rose-250 hover:border-rose-300'}`}>
                        <div 
                          onClick={() => setActiveTestDetail(isExpanded ? null : tc.caseId)}
                          className="px-5 py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 cursor-pointer hover:bg-slate-50/50"
                        >
                          <div className="flex items-start sm:items-center gap-3">
                            <div className={`p-2 rounded-xl mt-0.5 sm:mt-0 ${tc.passed ? 'bg-emerald-50 text-emerald-600' : tc.actual?.isValid === false ? 'bg-amber-50 text-amber-600' : 'bg-rose-50 text-rose-600'}`}>
                              {tc.passed ? <Check className="w-4 h-4 stroke-[3px]" /> : <ShieldAlert className="w-4 h-4" />}
                            </div>
                            <div>
                              <p className="font-extrabold text-xs text-slate-800 tracking-tight">{tc.name}</p>
                              <p className="text-[10px] text-slate-400 leading-none mt-0.5">{seedCase?.description}</p>
                            </div>
                          </div>

                          <div className="flex items-center gap-3">
                            {seedCase?.id.startsWith('custom-') && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const idToDelete = seedCase.id;
                                  const updated = customCases.filter(c => c.id !== idToDelete);
                                  setCustomCases(updated);
                                  localStorage.setItem('custom_regression_cases', JSON.stringify(updated));
                                }}
                                className="bg-slate-100 hover:bg-rose-100 text-slate-500 hover:text-rose-600 p-1.5 rounded-lg border border-slate-200 hover:border-rose-200 transition-all"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded inline-block font-mono ${tc.passed ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' : tc.actual?.isValid === false ? 'bg-amber-100 text-amber-800 border border-amber-200' : 'bg-rose-100 text-rose-800 border border-rose-200'}`}>
                              {tc.passed ? "PASS" : tc.actual?.isValid === false ? "PASS / Uncertain" : "TEST REJECTED"}
                            </span>
                            <ChevronRight className={`w-4 h-4 text-slate-400 transition-all ${isExpanded ? 'rotate-90' : ''}`} />
                          </div>
                        </div>

                        {/* Expandable test logs */}
                        {isExpanded && (
                          <div className="p-6 bg-slate-50 border-t border-slate-100 space-y-4 font-mono text-xs text-slate-600 animate-fadeIn">
                            {tc.error ? (
                              <div className="p-4 bg-rose-50 text-rose-700 border border-rose-150 rounded-xl leading-relaxed">
                                <strong>Runtime Parse Fail:</strong> {tc.error}
                              </div>
                            ) : (
                              <div className="space-y-4">
                                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                                  <div className="bg-white p-3.5 border border-slate-150 rounded-xl shadow-sm">
                                    <span className="text-[9px] font-bold text-slate-400 block uppercase">Trades Count</span>
                                    <span className="text-xs font-bold font-mono text-slate-800 block mt-1">Expected: {seedCase?.expected.tradesCount} | Actual: {tc.actual?.tradesCount}</span>
                                  </div>
                                  <div className="bg-white p-3.5 border border-slate-150 rounded-xl shadow-sm">
                                    <span className="text-[9px] font-bold text-slate-400 block uppercase">STT Levy Charge</span>
                                    <span className="text-xs font-bold font-mono text-slate-800 block mt-1">Expected: ₹{seedCase?.expected.stt.toFixed(2)} | Actual: ₹{tc.actual?.stt.toFixed(2)}</span>
                                  </div>
                                  <div className="bg-white p-3.5 border border-slate-150 rounded-xl shadow-sm">
                                    <span className="text-[9px] font-bold text-slate-400 block uppercase">Brokerage (Taxable Services)</span>
                                    <span className="text-xs font-bold font-mono text-slate-800 block mt-1">Expected: ₹{seedCase?.expected.brokerage.toFixed(2)} | Actual: ₹{tc.actual?.brokerage.toFixed(2)}</span>
                                  </div>
                                  <div className="bg-white p-3.5 border border-slate-150 rounded-xl shadow-sm">
                                    <span className="text-[9px] font-bold text-slate-400 block uppercase">Net Obligation</span>
                                    <span className="text-xs font-bold font-mono text-slate-800 block mt-1">Expected: ₹{seedCase?.expected.payinObligation.toFixed(2)} | Actual: ₹{tc.actual?.payinObligation.toFixed(2)}</span>
                                  </div>
                                  <div className="bg-white p-3.5 border border-slate-150 rounded-xl shadow-sm">
                                    <span className="text-[9px] font-bold text-slate-400 block uppercase">Final Net Settlement</span>
                                    <span className="text-xs font-bold font-mono text-slate-800 block mt-1">Expected: ₹{seedCase?.expected.netSettlement.toFixed(2)} | Actual: ₹{tc.actual?.netSettlement.toFixed(2)}</span>
                                  </div>
                                  <div className="bg-white p-3.5 border border-slate-150 rounded-xl shadow-sm">
                                    <span className="text-[9px] font-bold text-slate-400 block uppercase">Parser Validation Status</span>
                                    <span className={`text-xs font-black block mt-1 font-mono uppercase ${tc.actual?.isValid ? 'text-emerald-700' : 'text-rose-700'}`}>
                                      {tc.actual?.isValid ? 'PASSED / RECONCILED' : 'Parser Uncertain'}
                                    </span>
                                  </div>
                                </div>

                                {/* Mathematical logic summary inside details */}
                                <div className="p-4 bg-indigo-50/50 border border-indigo-150 rounded-xl text-[11px] leading-relaxed font-sans text-indigo-900">
                                  <p className="font-bold">🧪 Regression Mathematical Verification Audit:</p>
                                  <p className="mt-1">
                                    Sells Gross minus Buys Gross minus Charges extracted equals <strong>₹{(tc.actual!.payinObligation - (tc.actual!.stt + tc.actual!.brokerage)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong>, 
                                    which matches the parsed Net Settlement of <strong>₹{tc.actual!.netSettlement.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong> within 
                                    a micro-variance of <strong>₹{tc.actual?.difference.toFixed(4)}</strong>. 
                                    Formula compliant mathematically? <strong className="font-bold whitespace-nowrap">{tc.actual?.isValid ? "✓ YES (100% Correct)" : "❌ NO (Parser Uncertain flag triggered correctly!)"}</strong>.
                                  </p>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
          </>
        )}
      </main>
    </div>
  );
}
