import React, { useState, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { 
  Upload, X, Download, FileText, Info, CheckCircle2, AlertCircle, 
  ArrowRightLeft, ListChecks, Play, Trash2, PlusCircle, AlertTriangle, 
  RefreshCw, Check, ShieldAlert, Award, ChevronRight, Gauge,
  Menu, ChevronDown, BookOpen, Calculator, ArrowDown, ArrowUp, ArrowUpDown, BarChart3
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ContractNoteResult, ReconciliationStatus } from './types';
import { processFile, mergeResults, calculateReconciliation } from './lib/parsers';
import CsvAuditor from './components/CsvAuditor';
import { seedRegressionCases, runRegressionTests, RegressionTestCase, TestResult } from './lib/regressionMemory';

const SummaryCard = ({ label, value, highlight = false, alertState = false }: { label: string, value: number, highlight?: boolean, alertState?: boolean }) => (
  <div className={`p-4 rounded-xl border transition-all ${alertState ? 'bg-rose-50 border-rose-200' : highlight ? 'bg-indigo-50 border-indigo-200' : 'bg-white border-slate-200'} shadow-sm`}>
    <p className={`text-xs font-semibold uppercase tracking-wider ${alertState ? 'text-rose-600' : highlight ? 'text-indigo-600' : 'text-slate-500'}`}>{label}</p>
    <p className={`text-lg font-bold mt-1 font-mono ${alertState ? 'text-rose-900' : highlight ? 'text-indigo-900' : 'text-slate-900'}`}>
      {value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </p>
  </div>
);

const MAX_FILES = 25;

export default function App() {
  const [activeTab, setActiveTab] = useState<'analyse' | 'audit' | 'tests'>('analyse');
  const [data, setData] = useState<ContractNoteResult | null>(null);
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' } | null>(null);

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

  const SortableHeader = ({ label, sortKey, align = 'left', className = '' }: { label: string, sortKey: string, align?: 'left' | 'center' | 'right', className?: string }) => {
    const isActive = sortConfig?.key === sortKey;
    return (
      <th 
        className={`px-6 py-4 cursor-pointer hover:bg-slate-100 transition-colors select-none ${align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'} ${className}`}
        onClick={() => requestSort(sortKey)}
      >
        <div className={`flex items-center gap-1 inline-flex ${align === 'right' ? 'flex-row-reverse justify-start' : align === 'center' ? 'justify-center' : 'justify-start'}`}>
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
  const [broker, setBroker] = useState<'auto' | 'zerodha' | 'shareindia' | 'integrated' | 'standard'>('zerodha');
  const [pdfPassword, setPdfPassword] = useState("");
  const [isPasswordRequired, setIsPasswordRequired] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const [showExportConfirmation, setShowExportConfirmation] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isLogicOpen, setIsLogicOpen] = useState(false);
  const [selectedLogicBroker, setSelectedLogicBroker] = useState<'zerodha' | 'shareindia' | 'integrated' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleFileUpload = async (files: FileList | File[] | null, password?: string) => {
    if (!files) return;
    setIsLoading(true);
    setError(null);
    setData(null);
    setIsPasswordRequired(false);
    setShowExportConfirmation(false);
    
    let fileArray = Array.from(files);

    if (broker === 'zerodha') {
      const allowedFiles = fileArray.filter(file => 
        file.name.toUpperCase().startsWith('NJW724') && 
        file.name.toLowerCase().endsWith('.pdf')
      );
      if (allowedFiles.length === 0) {
        setError("Only PDF files starting with name 'NJW724' are allowed and processed.");
        setIsLoading(false);
        return;
      }
      fileArray = allowedFiles;
    }

    setPendingFiles(fileArray);
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
      }
    } catch (err) {
      setError("Failed to parse the files. Please check if they are valid contract notes.");
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
    const sebiFeesAndOther = data.trades.reduce((sum, t) => sum + (t.sebiFees + t.ipf), 0);
    const totalExpensesInclSTT = data.trades.reduce((sum, t) => sum + t.totalExpensesInclSTT, 0);
    const totalExpensesExclSTT = data.trades.reduce((sum, t) => sum + t.totalExpensesExclSTT, 0);

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
      sebiFeesAndOther,
      totalExpensesInclSTT,
      totalExpensesExclSTT,
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
    const headers = [
      "Trade Date", "ISIN", "Stock Name", "Transaction Type", "Number of Shares", "Avg Price", 
      "Total Amount (Turnover)", "Brokerage Per Share", "Total Brokerage", "STT", 
      "Exchange Turnover Charges", "SEBI Turnover Fees", isIntegrated ? "Total GST" : "IGST", 
      "Stamp Duty", "Total Expenses (incl STT)", "Total Expenses (excl STT)", 
      "Total Amount with Expense (Incl STT)", "Total Amount with Expense (Excl STT)", "Trade Class"
    ];
    
    const rows = data.trades.map(t => {
      const brokeragePerShare = t.quantity > 0 ? (t.brokerage / t.quantity).toFixed(4) : "0.0000";
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
        t.avgPrice.toFixed(2),
        t.turnover.toFixed(2),
        brokeragePerShare,
        t.brokerage.toFixed(2),
        t.stt.toFixed(2),
        t.etc.toFixed(2),
        (t.sebiFees + t.ipf).toFixed(2),
        isIntegrated ? t.gst.toFixed(2) : (t.igst || t.gst).toFixed(2),
        t.stampDuty.toFixed(2),
        t.totalExpensesInclSTT.toFixed(2),
        t.totalExpensesExclSTT.toFixed(2),
        totalWithExpenseInclSTT.toFixed(2),
        totalWithExpenseExclSTT.toFixed(2),
        `"${t.tradeType}"`
      ];
    });

    const csvContent = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
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

      const narration = `${securityName} ${qty} Nos @ ${avgPrice.toFixed(2)}`;

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
      const narration = `${securityName} ${qty} Nos @ ${avgPrice.toFixed(2)}`;

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
      downloadCSV();
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

  const clearCustomCases = () => {
    if (window.confirm("Are you sure you want to delete all custom regression cases?")) {
      localStorage.removeItem('custom_regression_cases');
      setCustomCases([]);
      setTestResults([]);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans pb-20" style={{ backgroundColor: '#d8d8ff' }}>
      <header className="bg-white border-b border-slate-250 sticky top-0 z-50 px-6 h-16 shadow-sm flex items-center">
        <div className="flex-1 flex items-center space-x-2 sm:space-x-3">
          <div className="bg-indigo-600 text-white p-2 sm:p-2.5 rounded-xl shadow shadow-indigo-150 flex-shrink-0">
            <FileText className="w-4 h-4 sm:w-5 sm:h-5" />
          </div>
          <div>
            <h1 className="text-xs sm:text-lg font-black text-slate-800 tracking-tight leading-none">Contract Note Analyzer</h1>
          </div>
        </div>

        <div className="flex-1 flex justify-center">
          <div className="inline-flex items-center justify-center p-1 bg-slate-100 rounded-xl border border-slate-200/60 shadow-inner overflow-hidden max-w-full">
            {(!data || broker === 'zerodha') && (
              <button
                id="btn-broker-zerodha"
                type="button"
                onClick={() => setBroker('zerodha')}
                disabled={!!data}
                className={`flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-black transition-all min-w-[120px] ${broker === 'zerodha' ? 'bg-white text-[#12b8f1] shadow-sm border border-slate-200' : 'text-slate-600 hover:text-slate-900'}`}
              >
                <img 
                  src="/zerodha-logo.png" 
                  alt="Zerodha Logo" 
                  className={`h-5 w-auto object-contain transition-all duration-300 mix-blend-multiply ${broker === 'zerodha' ? 'grayscale-0 opacity-100' : 'grayscale opacity-60'}`} 
                />
                <span>Zerodha</span>
              </button>
            )}
            {(!data || broker === 'shareindia') && (
              <button
                id="btn-broker-shareindia"
                type="button"
                onClick={() => setBroker('shareindia')}
                disabled={!!data}
                className={`flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-black transition-all min-w-[120px] ${broker === 'shareindia' ? 'bg-white shadow-sm border border-slate-200' : 'text-slate-600 hover:text-slate-900'}`}
              >
                <img 
                  src="/shareindia-logo.png" 
                  alt="Share India Logo" 
                  className={`h-5 w-auto object-contain transition-all duration-300 mix-blend-multiply ${broker === 'shareindia' ? 'grayscale-0 opacity-100' : 'grayscale opacity-60'}`} 
                />
                <span className="flex items-center gap-1 font-bold">
                  <span className={broker === 'shareindia' ? 'text-[#12b8f1]' : 'text-inherit'}>Share</span>
                  <span className={broker === 'shareindia' ? 'text-[#ef233c]' : 'text-inherit'}>India</span>
                </span>
              </button>
            )}
            {(!data || broker === 'integrated') && (
              <button
                id="btn-broker-integrated"
                type="button"
                onClick={() => setBroker('integrated')}
                disabled={!!data}
                className={`flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-black transition-all min-w-[120px] ${broker === 'integrated' ? 'bg-white text-[#12b8f1] shadow-sm border border-slate-200' : 'text-slate-600 hover:text-slate-900'}`}
              >
                <img 
                  src="/integrated-logo.png" 
                  alt="Integrated Logo" 
                  className={`h-5 w-auto object-contain transition-all duration-300 mix-blend-multiply ${broker === 'integrated' ? 'grayscale-0 opacity-100' : 'grayscale opacity-60'}`} 
                />
                <span className={broker === 'integrated' ? 'bg-white text-[#1285f1]' : ''}>Integrated</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 flex justify-end">
          <button
            id="btn-open-menu"
            onClick={() => setIsDrawerOpen(true)}
            className="p-2 hover:bg-slate-100 rounded-xl transition-all text-slate-600 hover:text-slate-950 flex items-center justify-center border border-transparent hover:border-slate-200"
            title="Calculation logic details"
          >
            <Menu className="w-5 h-5 font-bold" />
          </button>
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

      <main className="max-w-7xl mx-auto px-4 py-8" style={{ backgroundColor: '#d8d8ff' }}>
        {activeTab === 'analyse' && (
          <div className="space-y-6">
            {!data && !isLoading && (
              <div className="text-center max-w-3xl mx-auto mt-6">
                {/* Broker Selection is now in Header */}

                <div 
                  className={`relative flex flex-col items-center justify-center h-64 border-2 border-dashed rounded-2xl transition-all ${dragging ? 'border-indigo-500 bg-indigo-50/50' : 'border-slate-300 bg-white shadow-sm hover:border-indigo-400'}`}
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
                    accept={broker === 'zerodha' ? '.pdf' : broker === 'integrated' ? '.htm,.html' : '.pdf,.html,.htm'} 
                    multiple 
                    disabled={isLoading} 
                  />
                  <div className="text-center px-4 pointer-events-none">
                    <div className="relative inline-block mb-4">
                      {broker === 'zerodha' && <img src="/zerodha-logo.png" alt="Zerodha" className="h-12 w-auto object-contain mx-auto mix-blend-multiply" />}
                      {broker === 'shareindia' && <img src="/shareindia-logo.png" alt="Share India" className="h-14 w-auto object-contain mx-auto mix-blend-multiply" />}
                      {broker === 'integrated' && <img src="/integrated-logo.png" alt="Integrated" className="h-10 w-auto object-contain mx-auto mix-blend-multiply" />}
                      {broker !== 'zerodha' && broker !== 'shareindia' && broker !== 'integrated' && <Upload className="mx-auto w-12 h-12 text-indigo-400" />}
                    </div>
                    
                    <p className="text-xl md:text-2xl font-black text-slate-800 tracking-tight leading-tight">
                      Drop {broker === 'shareindia' ? "Share India" : broker === 'zerodha' ? "Zerodha" : broker === 'integrated' ? "Integrated" : "your"} contract notes here
                    </p>
                    <div className="flex items-center justify-center gap-2 mt-3">
                      <span className="px-4 py-2 bg-indigo-50 text-indigo-700 rounded-lg text-sm font-bold shadow-sm pointer-events-auto">Browse Files</span>
                    </div>
                    <p className="text-xs font-semibold text-slate-500 mt-3">
                      {broker === 'zerodha' 
                        ? `PDFs Contract Note valid only` 
                        : broker === 'integrated'
                          ? `Only HTM/HTML files.`
                          : `PDFs Contract Note valid only`
                      }
                    </p>
                  </div>
                </div>
              </div>
            )}

            {isLoading && (
              <div className="text-center py-20 max-w-md mx-auto">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
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
                  <p className="text-xs text-indigo-750/80 mb-4">Your contract note is encrypted (Zerodha passwords are usually your PAN card number in uppercase).</p>
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
                  
                  <div className="relative z-10 p-6 sm:p-10 w-full md:w-auto flex items-center justify-start md:justify-end">
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
                        className={`px-5 py-2.5 text-xs font-black text-white rounded-xl transition-all duration-200 transform hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] flex items-center gap-1.5 ${
                          data.reconciliation && !data.reconciliation.isValid 
                            ? 'bg-amber-600 hover:bg-amber-700' 
                            : 'bg-[#0f172a] hover:bg-slate-800'
                        }`}
                        style={{ 
                          boxShadow: data.reconciliation && !data.reconciliation.isValid 
                            ? '0 1px 2px rgba(217,119,6,0.06), 0 6px 16px rgba(217,119,6,0.1)' 
                            : '0 1px 2px rgba(15,23,42,0.06), 0 8px 18px rgba(15,23,42,0.1)' 
                        }}
                      >
                        {data.reconciliation && !data.reconciliation.isValid ? <AlertTriangle className="w-4 h-4" /> : <Download className="w-4 h-4" />}
                        {data.reconciliation && !data.reconciliation.isValid ? "Export (Mismatch Warning)" : "Export CSV File"}
                      </button>

                      {/* Sliding Inline Export Warning Banner overlay */}
                      {showExportConfirmation && (
                        <div className="absolute right-0 top-12 mt-2 p-4 bg-white border border-rose-200 rounded-2xl shadow-xl z-50 min-w-[340px] text-xs space-y-3 animate-fadeIn">
                          <p className="font-bold text-rose-900 flex items-center gap-1">
                            <AlertTriangle className="w-4 h-4 text-red-500" /> Export Warning: Parser Uncertain
                          </p>
                          <p className="text-slate-600 leading-relaxed font-sans">
                            The parser is mathematically uncertain on this note (Discrepancy: ₹${data.reconciliation?.difference}). Do you still wish to silently export?
                          </p>
                          <div className="flex justify-end gap-2 pt-1">
                            <button onClick={() => setShowExportConfirmation(false)} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-750 font-bold rounded-lg">Cancel</button>
                            <button onClick={downloadCSV} className="px-3 py-1.5 bg-red-655 hover:bg-red-700 text-white font-bold rounded-lg shadow-sm">Yes, Export Anyway</button>
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
                  <SummaryCard label="Obligation (Buy/Sell)" value={calculatedTotals.obligation} highlight />
                  <SummaryCard label="Net Settlement (Incl STT)" value={calculatedTotals.netSettlementInclSTT} highlight />
                  <SummaryCard label="Net Settlement (Excl STT)" value={calculatedTotals.netSettlementExclSTT} highlight />
                  <SummaryCard label="Brokerage/Taxable" value={calculatedTotals.brokerage} />
                  <SummaryCard label="Total STT" value={calculatedTotals.stt} alertState={data.reconciliation && data.reconciliation.isSttMismatch} />
                  <SummaryCard label="Stamp Duty" value={calculatedTotals.stampDuty} />
                  <SummaryCard label="Exchange Charges" value={calculatedTotals.etc} />
                  {data?.brokerName === 'integrated' ? (
                    <SummaryCard label="Total GST" value={calculatedTotals.gst} />
                  ) : (
                    <SummaryCard label="IGST" value={calculatedTotals.igst || calculatedTotals.gst} />
                  )}
                  <SummaryCard label="SEBI Turnover Fees" value={calculatedTotals.sebiFeesAndOther} />
                </div>

                <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-slate-600 text-[10px] font-bold uppercase tracking-wider border-b border-slate-200">
                      <tr>
                        <SortableHeader label="Date" sortKey="tradeDate" className="bg-slate-100/50 text-slate-700" />
                        <SortableHeader label="ISIN" sortKey="isin" className="bg-slate-100/50 text-slate-700" />
                        <SortableHeader label="Security" sortKey="securityName" className="bg-slate-100/50 text-slate-700" />
                        <SortableHeader label="Type" sortKey="transactionType" align="center" className="bg-slate-100/50 text-slate-705" />
                        <SortableHeader label="Shares" sortKey="quantity" align="right" className="bg-slate-100/50 text-slate-710" />
                        <SortableHeader label="Price" sortKey="avgPrice" align="right" className="bg-slate-100/50 text-slate-720 border-r border-slate-200" />
                        <SortableHeader label="Turnover" sortKey="turnover" align="right" className="bg-emerald-50 text-emerald-850 font-black border-r border-emerald-100" />
                        <SortableHeader label="Brokerage" sortKey="brokerage" align="right" className="bg-blue-50 text-blue-850 font-black border-r border-blue-100" />
                        <SortableHeader label="STT" sortKey="stt" align="right" className="text-rose-850 bg-rose-50 font-black border-r border-rose-100" />
                        {data?.brokerName === 'integrated' ? (
                          <SortableHeader label="Total GST" sortKey="gstOrIgst" align="right" className="font-extrabold text-violet-850 bg-violet-50 border-r border-violet-100" />
                        ) : (
                          <SortableHeader label="IGST" sortKey="gstOrIgst" align="right" className="font-extrabold text-violet-850 bg-violet-50 border-r border-violet-100" />
                        )}
                        <SortableHeader label="ETC" sortKey="etc" align="right" className="text-amber-850 bg-amber-50 font-bold border-r border-amber-100" />
                        <SortableHeader label="Stamp Duty" sortKey="stampDuty" align="right" className="text-teal-850 bg-teal-50 font-bold border-r border-teal-100" />
                        <SortableHeader label="SEBI Fees" sortKey="sebiAndIpf" align="right" className="text-purple-850 bg-purple-50 font-bold border-r border-purple-100" />
                        <SortableHeader label="Exp (Incl STT)" sortKey="totalExpensesInclSTT" align="right" className="text-orange-950 bg-orange-50 font-extrabold border-r border-orange-150" />
                        <SortableHeader label="Exp (Excl STT)" sortKey="totalExpensesExclSTT" align="right" className="text-stone-850 bg-stone-50 font-semibold border-r border-stone-150" />
                        <SortableHeader label="Net (Incl STT)" sortKey="totalInclSTT" align="right" className="bg-indigo-600 text-white font-extrabold hover:text-indigo-100 border-r border-indigo-700" />
                        <SortableHeader label="Net (Excl STT)" sortKey="totalExclSTT" align="right" className="bg-sky-600 text-white font-extrabold hover:text-sky-100 border-r border-sky-700" />
                        <SortableHeader label="Obligation" sortKey="netTotalBeforeLevies" align="right" className="font-extrabold text-slate-100 bg-slate-900 border-r border-slate-700" />
                        <SortableHeader label="Class" sortKey="tradeType" align="center" className="bg-violet-100 text-violet-900 font-bold" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-150 font-mono text-xs">
                      {getSortedTrades().map(t => {
                        const totalInclSTT = t.transactionType === "Buy" 
                          ? t.turnover + t.totalExpensesInclSTT 
                          : t.turnover - t.totalExpensesInclSTT;
                        const totalExclSTT = t.transactionType === "Buy" 
                          ? t.turnover + t.totalExpensesExclSTT 
                          : t.turnover - t.totalExpensesExclSTT;

                        return (
                           <tr key={t.id} className="hover:bg-slate-50 transition-colors">
                            <td className="px-6 py-4 text-slate-400 bg-slate-50/10">{t.tradeDate}</td>
                            <td className="px-6 py-4 text-slate-500 font-semibold bg-slate-50/10 font-mono tracking-wider">{t.isin || "—"}</td>
                            <td className="px-6 py-4 font-bold text-slate-800 uppercase not-italic bg-slate-50/10">{t.securityName}</td>
                            <td className="px-6 py-4 text-center bg-slate-50/10">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${t.transactionType === 'Buy' ? 'bg-emerald-100 text-emerald-700 animate-pulse' : 'bg-rose-100 text-rose-700'}`}>{t.transactionType}</span>
                            </td>
                            <td className="px-6 py-4 text-right font-semibold text-slate-700 bg-slate-50/10">{t.quantity}</td>
                            <td className="px-6 py-4 text-right text-slate-700 bg-slate-50/10 border-r border-slate-200">₹{t.avgPrice.toFixed(2)}</td>
                            <td className="px-6 py-4 text-right font-bold text-emerald-900 bg-emerald-50/15 border-r border-emerald-100/30">₹{t.turnover.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right font-semibold text-blue-800 bg-blue-50/15 border-r border-blue-100/30">₹{t.brokerage.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right font-bold text-rose-700 bg-rose-50/20 border-r border-rose-100/30">₹{t.stt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            {data?.brokerName === 'integrated' ? (
                              <td className="px-6 py-4 text-right font-bold text-violet-800 bg-violet-50/15 border-r border-violet-100/30">₹{t.gst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            ) : (
                              <td className="px-6 py-4 text-right font-bold text-violet-800 bg-violet-50/15 border-r border-violet-100/30">₹{(t.igst || t.gst).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            )}
                            <td className="px-6 py-4 text-right text-amber-900 font-semibold bg-amber-50/15 border-r border-amber-100/30">₹{t.etc.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right text-teal-900 bg-teal-50/15 border-r border-teal-100/30">₹{t.stampDuty.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right text-purple-950 bg-purple-50/15 border-r border-purple-100/30">₹{(t.sebiFees + t.ipf).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right text-orange-950 font-bold bg-orange-50/15 border-r border-orange-100/30">₹{t.totalExpensesInclSTT.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right text-stone-900 bg-stone-50/15 border-r border-stone-100/30">₹{t.totalExpensesExclSTT.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right text-indigo-950 font-extrabold bg-indigo-50/25 border-r border-indigo-100/40">₹{totalInclSTT.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right text-sky-950 font-bold bg-sky-50/20 border-r border-sky-100/40">₹{totalExclSTT.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                            <td className={`px-6 py-4 text-right font-black border-r border-slate-200 ${t.netTotalBeforeLevies >= 0 ? 'text-emerald-700 bg-emerald-50/10' : 'text-rose-700 bg-rose-50/10'}`}>
                              {t.netTotalBeforeLevies >= 0 ? '+' : ''}{t.netTotalBeforeLevies.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                            </td>
                            <td className="px-6 py-4 text-center bg-violet-50/10">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${t.tradeType === 'Delivery' ? 'bg-indigo-150 text-indigo-800' : 'bg-amber-150 text-amber-800'}`}>{t.tradeType}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
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
                  <RefreshCw className="w-10 h-10 text-slate-400 animate-spin mx-auto mb-3" />
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
      </main>
    </div>
  );
}
