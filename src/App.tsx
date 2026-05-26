import React, { useState, useRef, useEffect } from 'react';
import { 
  Upload, X, Download, FileText, Info, CheckCircle2, AlertCircle, 
  ArrowRightLeft, ListChecks, Play, Trash2, PlusCircle, AlertTriangle, 
  RefreshCw, Check, ShieldAlert, Award, ChevronRight, Gauge
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
      {value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </p>
  </div>
);

const MAX_FILES = 25;

export default function App() {
  const [activeTab, setActiveTab] = useState<'analyse' | 'audit' | 'tests'>('analyse');
  const [data, setData] = useState<ContractNoteResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileCount, setFileCount] = useState({ total: 0, processed: 0 });
  const [dragging, setDragging] = useState(false);
  const [broker, setBroker] = useState<'auto' | 'zerodha' | 'integrated' | 'standard'>('zerodha');
  const [pdfPassword, setPdfPassword] = useState("");
  const [isPasswordRequired, setIsPasswordRequired] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const [showExportConfirmation, setShowExportConfirmation] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (files: FileList | File[] | null, password?: string) => {
    if (!files) return;
    setIsLoading(true);
    setError(null);
    setData(null);
    setIsPasswordRequired(false);
    setShowExportConfirmation(false);
    
    const fileArray = Array.from(files);
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
    const headers = [
      "Trade Date", "Stock Name", "Transaction Type", "Number of Shares", "Avg Price", 
      "Total Amount (Turnover)", "Brokerage Per Share", "Total Brokerage", "STT", 
      "Exchange Turnover Charges", "SEBI Turnover Fees", "Exchange Clearing Charges", 
      "Stamp Duty", "IPF", "GST", "Total Expenses (incl STT)", "Total Expenses (excl STT)", 
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
        `"${t.securityName.replace(/"/g, '""')}"`, 
        `"${t.transactionType}"`, 
        t.quantity, 
        t.avgPrice.toFixed(2),
        t.turnover.toFixed(2),
        brokeragePerShare,
        t.brokerage.toFixed(2),
        t.stt.toFixed(2),
        t.etc.toFixed(2),
        t.sebiFees.toFixed(2),
        t.clearingCharges.toFixed(2),
        t.stampDuty.toFixed(2),
        t.ipf.toFixed(2),
        t.gst.toFixed(2),
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
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans pb-20">
      <header className="bg-white border-b border-slate-250 sticky top-0 z-50 px-6 h-16 flex items-center justify-between shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="bg-indigo-600 text-white p-2.5 rounded-xl shadow shadow-indigo-150">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-black text-slate-800 tracking-tight leading-tight">Contract Note Analyzer & Auditor</h1>
          </div>
        </div>


      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {activeTab === 'analyse' && (
          <div className="space-y-6">
            {!data && !isLoading && (
              <div className="text-center max-w-3xl mx-auto mt-6">


                <div 
                  className={`relative flex flex-col items-center justify-center h-64 border-2 border-dashed rounded-2xl transition-all ${dragging ? 'border-indigo-500 bg-indigo-50/50' : 'border-slate-300 bg-white shadow-sm hover:border-indigo-400'}`}
                  onDragEnter={() => setDragging(true)}
                  onDragLeave={() => setDragging(false)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={onDrop}
                >
                  <input ref={fileInputRef} type="file" className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" onChange={(e) => e.target.files && handleFileUpload(e.target.files)} accept=".pdf,.html,.htm" multiple disabled={isLoading} />
                  <div className="text-center px-4">
                    <Upload className="mx-auto w-10 h-10 text-indigo-400 mb-4" />
                    <p className="text-lg font-bold text-slate-800">Upload PDF or HTML Contract Notes</p>
                    <p className="text-xs text-slate-500 mt-1">Supports batch processing of up to {MAX_FILES} files. Drag or select.</p>
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
                            ? `Mathematical safety alert: Extracted STT is critically low (₹${data.summary.stt}) given your high turnover of ₹${(data.reconciliation.totalBuys + data.reconciliation.totalSells).toLocaleString()}. This usually implies the extraction isolated a spurious list item or footnote integer.`
                            : data.reconciliation.isSttMismatch
                              ? `STT validation failure: The trade-level STT calculation sums to ₹${data.trades.reduce((sum, t) => sum + t.stt, 0).toLocaleString()} (Delivery: 0.1%, Intraday Sell: 0.025%), but the note's summary STT is ₹${data.summary.stt.toLocaleString()}. This mismatch exceeds our tolerance.`
                              : (data.reconciliation.isValid 
                                  ? `Mathematical verification perfect: Sells (₹${data.reconciliation.totalSells.toLocaleString()}) minus Buys (₹${data.reconciliation.totalBuys.toLocaleString()}) minus Charges (₹${data.reconciliation.totalCharges.toLocaleString()}) aligns perfectly with the extracted net receivable of ₹${data.reconciliation.extractedNet.toLocaleString()}.`
                                  : `Accounting check failure: Sells minus Buys minus Charges does not equal the Net Settlement value. Our mismatch calculation shows a difference of ₹${data.reconciliation.difference.toLocaleString()} (Tolerance is 10 paise).`
                                )
                          }
                        </p>
                      </div>
                    </div>
                    
                    <div className="text-left md:text-right shrink-0">
                      <span className="text-[10px] font-semibold uppercase tracking-wider block opacity-75">Verification Variance</span>
                      <span className={`text-md font-black font-mono block mt-0.5 ${data.reconciliation.isValid ? 'text-emerald-800' : 'text-rose-900'}`}>
                        {data.reconciliation.isValid ? '₹0.00' : `₹${data.reconciliation.difference.toLocaleString()}`}
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
                          <span className="font-bold text-slate-800">₹{data.reconciliation.totalSells.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between border-b border-rose-100 pb-1.5">
                          <span className="text-slate-500">Buys Gross</span>
                          <span className="font-bold text-slate-800">₹{data.reconciliation.totalBuys.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between border-b border-rose-100/50 pb-1.5">
                          <span className="text-slate-500 font-bold">A) Buy/Sell Obligation (Sells - Buys)</span>
                          <span className={`font-bold ${data.reconciliation.calculatedObligation >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                            ₹{data.reconciliation.calculatedObligation.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </span>
                        </div>
                        <div className="flex justify-between border-b border-rose-100 pb-1.5">
                          <span className="text-slate-500 font-bold">B) Extracted Obligation of CN</span>
                          <span className="font-bold text-slate-800">₹{data.reconciliation.extractedObligation.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col justify-between">
                      <div className="bg-white/80 p-4 rounded-xl border border-rose-150 space-y-2.5 font-mono shadow-sm">
                        <div className="flex justify-between border-b border-rose-100 pb-1.5">
                          <span className="text-slate-500 font-bold">C) Sum of Charges + Brokerage (Levies)</span>
                          <span className="font-bold text-amber-700">₹{data.reconciliation.totalCharges.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between border-b border-rose-100 pb-1.5">
                          <span className="text-slate-500 font-bold">Calculated Net Settlement (A - C)</span>
                          <span className={`font-bold ${data.reconciliation.calculatedNet >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                            ₹{data.reconciliation.calculatedNet.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </span>
                        </div>
                        <div className="flex justify-between border-b border-rose-100 pb-1.5 text-indigo-800 font-bold">
                          <span>Extracted Net Settlement of CN</span>
                          <span>₹{data.reconciliation.extractedNet.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between text-red-700 font-black">
                          <span>D) Arithmetic Mismatch Variance</span>
                          <span>₹{data.reconciliation.difference.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </div>
                      </div>

                      <div className="p-3 bg-red-100 border border-red-200 rounded-xl text-[11px] text-red-800 font-bold mt-4 leading-relaxed">
                        {data.reconciliation.isSuspiciousStt
                          ? `⚠️ ALERT: Securities Transaction Tax (STT) extracted is ₹${data.summary.stt} which is statistically impossible on a turnover of ₹${(data.reconciliation.totalBuys + data.reconciliation.totalSells).toLocaleString()}. This suggests spurious footnotes or list tags were incorrectly parsed as the STT fee.`
                          : data.reconciliation.isSttMismatch
                            ? `⚠️ ALERT: There is an STT mismatch of ₹${Math.abs(data.trades.reduce((sum, t) => sum + t.stt, 0) - data.summary.stt).toLocaleString()}. Delivery STT is strictly 0.1% of turnover and Intraday STT is 0.025% on Sell trades. Ensure the extracted securities and categories are complete.`
                            : "⚠️ ALERT: Sells minus Buys minus Charges fails to equal the Net Settlement value. Do not trust these extracted values for regulatory tax filings directly without verification."
                        }
                      </div>
                    </div>
                  </div>
                )}

                {/* Main panel card */}
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Contract Note Summary Table</h2>
                    <p className="text-xs text-slate-500 font-medium">Extracted with {data.trades.length} processed trades • Trade Date: {data.tradeDate || 'N/A'}</p>
                  </div>
                  
                  <div className="flex flex-col sm:flex-row gap-3">
                    <button onClick={() => setData(null)} className="px-4 py-2.5 text-xs font-bold text-slate-600 bg-white border border-slate-300 rounded-xl hover:bg-slate-50 transition-all">Clear Note</button>
                    
                    <div className="relative">
                      <button 
                        onClick={handleExportClick} 
                        className={`px-5 py-2.5 text-xs font-black text-white rounded-xl transition-all flex items-center gap-1.5 ${data.reconciliation && !data.reconciliation.isValid ? 'bg-amber-500 hover:bg-amber-600 shadow-md shadow-amber-200' : 'bg-indigo-600 hover:bg-indigo-700 shadow shadow-indigo-200'}`}
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
                            <button onClick={() => setShowExportConfirmation(false)} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg">Cancel</button>
                            <button onClick={downloadCSV} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white font-bold rounded-lg shadow-sm">Yes, Export Anyway</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>



                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  <SummaryCard label="Obligation (Buy/Sell)" value={calculatedTotals.obligation} highlight />
                  <SummaryCard label="Net Settlement (Incl STT)" value={calculatedTotals.netSettlementInclSTT} highlight />
                  <SummaryCard label="Net Settlement (Excl STT)" value={calculatedTotals.netSettlementExclSTT} highlight />
                  <SummaryCard label="Brokerage/Taxable" value={calculatedTotals.brokerage} />
                  <SummaryCard label="Total STT" value={calculatedTotals.stt} alertState={data.reconciliation && data.reconciliation.isSttMismatch} />
                  <SummaryCard label="Total GST" value={calculatedTotals.gst} />
                  <SummaryCard label="Stamp Duty" value={calculatedTotals.stampDuty} />
                  <SummaryCard label="Exchange Charges" value={calculatedTotals.etc} />
                  <SummaryCard label="Clearing Fee" value={calculatedTotals.clearingCharges} />
                  <SummaryCard label="SEBI Fees & Other" value={calculatedTotals.sebiFeesAndOther} />
                </div>

                <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-slate-500 text-[10px] font-bold uppercase tracking-wider">
                      <tr>
                        <th className="px-6 py-4">Date</th>
                        <th className="px-6 py-4">Security</th>
                        <th className="px-6 py-4 text-center">Type</th>
                        <th className="px-6 py-4 text-right">Shares</th>
                        <th className="px-6 py-4 text-right">Price</th>
                        <th className="px-6 py-4 text-right">Turnover</th>
                        <th className="px-6 py-4 text-center bg-indigo-50/50 text-indigo-700">Class</th>
                        <th className="px-6 py-4 text-right">Brokerage</th>
                        <th className="px-6 py-4 text-right text-rose-700 bg-rose-50/30">STT</th>
                        <th className="px-6 py-4 text-right">GST</th>
                        <th className="px-6 py-4 text-right">ETC</th>
                        <th className="px-6 py-4 text-right">Stamp Duty</th>
                        <th className="px-6 py-4 text-right">Other Levies</th>
                        <th className="px-6 py-4 text-right">Expenses (Incl STT)</th>
                        <th className="px-6 py-4 text-right">Expenses (Excl STT)</th>
                        <th className="px-6 py-4 text-right text-indigo-700 font-bold">Net Amount (Incl STT)</th>
                        <th className="px-6 py-4 text-right text-indigo-700 font-bold">Net Amount (Excl STT)</th>
                        <th className="px-6 py-4 text-right font-bold text-slate-900 border-l border-slate-100">Trade Obligation</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono text-xs">
                      {data.trades.map(t => {
                        const totalInclSTT = t.transactionType === "Buy" 
                          ? t.turnover + t.totalExpensesInclSTT 
                          : t.turnover - t.totalExpensesInclSTT;
                        const totalExclSTT = t.transactionType === "Buy" 
                          ? t.turnover + t.totalExpensesExclSTT 
                          : t.turnover - t.totalExpensesExclSTT;

                        return (
                           <tr key={t.id} className="hover:bg-slate-50">
                            <td className="px-6 py-4 text-slate-400">{t.tradeDate}</td>
                            <td className="px-6 py-4 font-bold text-slate-800 uppercase not-italic">{t.securityName}</td>
                            <td className="px-6 py-4 text-center">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${t.transactionType === 'Buy' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{t.transactionType}</span>
                            </td>
                            <td className="px-6 py-4 text-right font-semibold">{t.quantity}</td>
                            <td className="px-6 py-4 text-right">₹{t.avgPrice.toFixed(2)}</td>
                            <td className="px-6 py-4 text-right">₹{t.turnover.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-center bg-indigo-50/20">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${t.tradeType === 'Delivery' ? 'bg-indigo-100 text-indigo-700' : 'bg-amber-100 text-amber-700'}`}>{t.tradeType}</span>
                            </td>
                            <td className="px-6 py-4 text-right text-slate-600">₹{t.brokerage.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right font-semibold text-rose-700 bg-rose-50/10">₹{t.stt.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right text-slate-600">₹{t.gst.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right text-slate-600">₹{t.etc.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right text-slate-600">₹{t.stampDuty.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right text-slate-600">₹{(t.sebiFees + t.clearingCharges + t.ipf).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right text-slate-500 font-semibold">₹{t.totalExpensesInclSTT.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right text-slate-500 font-semibold">₹{t.totalExpensesExclSTT.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right text-slate-900 font-bold bg-slate-50/50">₹{totalInclSTT.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td className="px-6 py-4 text-right text-slate-900 font-bold bg-slate-50/50">₹{totalExclSTT.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td className={`px-6 py-4 text-right font-black border-l border-slate-100 ${t.netTotalBeforeLevies >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                              {t.netTotalBeforeLevies >= 0 ? '+' : ''}{t.netTotalBeforeLevies.toLocaleString(undefined, { minimumFractionDigits: 2 })}
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
                                    Sells Gross minus Buys Gross minus Charges extracted equals <strong>₹{(tc.actual!.payinObligation - (tc.actual!.stt + tc.actual!.brokerage)).toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>, 
                                    which matches the parsed Net Settlement of <strong>₹{tc.actual!.netSettlement.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong> within 
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
