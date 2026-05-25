import React, { useState, useRef } from 'react';
import { Upload, X, Download, FileText, Info, CheckCircle2, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ContractNoteResult } from './types';
import { processFile, mergeResults } from './lib/parsers';

const SummaryCard = ({ label, value, highlight = false }: { label: string, value: number, highlight?: boolean }) => (
  <div className={`p-4 rounded-xl border ${highlight ? 'bg-indigo-50 border-indigo-200' : 'bg-white border-slate-200'} shadow-sm`}>
    <p className={`text-xs font-medium uppercase tracking-wider ${highlight ? 'text-indigo-600' : 'text-slate-500'}`}>{label}</p>
    <p className={`text-lg font-bold mt-1 ${highlight ? 'text-indigo-900' : 'text-slate-900'}`}>
      {value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </p>
  </div>
);

const MAX_FILES = 25;

export default function App() {
  const [data, setData] = useState<ContractNoteResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileCount, setFileCount] = useState({ total: 0, processed: 0 });
  const [dragging, setDragging] = useState(false);
  const [broker, setBroker] = useState<'auto' | 'zerodha' | 'integrated' | 'standard'>('zerodha');
  const [pdfPassword, setPdfPassword] = useState("");
  const [isPasswordRequired, setIsPasswordRequired] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (files: FileList | File[] | null, password?: string) => {
    if (!files) return;
    setIsLoading(true);
    setError(null);
    setData(null);
    setIsPasswordRequired(false);
    
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

  const { totalGrossValue, totalWithExpenseInclSTT, totalWithExpenseExclSTT } = React.useMemo(() => {
    if (!data) return { totalGrossValue: 0, totalWithExpenseInclSTT: 0, totalWithExpenseExclSTT: 0 };
    const gross = data.trades.reduce((sum, t) => sum + (t.quantity * t.avgPrice), 0);
    const incl = data.trades.reduce((sum, t) => {
      const val = t.transactionType === "Buy" 
        ? t.turnover + t.totalExpensesInclSTT 
        : t.turnover - t.totalExpensesInclSTT;
      return sum + val;
    }, 0);
    const excl = data.trades.reduce((sum, t) => {
      const val = t.transactionType === "Buy" 
        ? t.turnover + t.totalExpensesExclSTT 
        : t.turnover - t.totalExpensesExclSTT;
      return sum + val;
    }, 0);
    return { totalGrossValue: gross, totalWithExpenseInclSTT: incl, totalWithExpenseExclSTT: excl };
  }, [data]);

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
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans pb-20">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50 px-4 h-16 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="bg-indigo-600 text-white p-2 rounded-lg"><FileText className="w-5 h-5" /></div>
          <h1 className="text-xl font-bold text-slate-800">Contract Note Analyzer</h1>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {!data && !isLoading && (
          <div className="text-center mb-8">
            <div className="flex flex-wrap justify-center gap-3 mb-8">
              {['zerodha', 'integrated'].map(opt => (
                <button
                  key={opt}
                  onClick={() => setBroker(opt as any)}
                  className={`px-4 py-2 rounded-full text-xs font-bold transition-all border shadow-sm ${broker === opt ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200'}`}
                >
                  {opt.toUpperCase()}
                </button>
              ))}
            </div>
            <div 
              className={`relative flex flex-col items-center justify-center h-64 border-2 border-dashed rounded-2xl transition-all ${dragging ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 bg-white'}`}
              onDragEnter={() => setDragging(true)}
              onDragLeave={() => setDragging(false)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
            >
              <input ref={fileInputRef} type="file" className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" onChange={(e) => e.target.files && handleFileUpload(e.target.files)} accept=".pdf,.html,.htm" multiple disabled={isLoading} />
              <div className="text-center px-4">
                <Upload className="mx-auto w-10 h-10 text-indigo-400 mb-4" />
                <p className="text-lg font-bold text-slate-800">Upload PDF or HTML Contract Notes</p>
                <p className="text-sm text-slate-500">Supports batch processing of up to {MAX_FILES} files</p>
              </div>
            </div>
          </div>
        )}

        {isLoading && (
          <div className="text-center py-20">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
            <p className="text-slate-500 font-medium">Processing {fileCount.processed}/{fileCount.total} files...</p>
          </div>
        )}

        <AnimatePresence>
          {isPasswordRequired && (
            <div className="max-w-md mx-auto mb-8 bg-indigo-50 p-6 rounded-2xl border border-indigo-200">
              <p className="text-sm text-indigo-700 font-bold mb-4">PDF Password Required</p>
              <div className="flex gap-2">
                <input type="password" placeholder="Enter password" value={pdfPassword} onChange={(e) => setPdfPassword(e.target.value)} className="flex-1 px-4 py-2 rounded-xl border border-indigo-200 outline-none" />
                <button onClick={() => handleFileUpload(pendingFiles)} className="bg-indigo-600 text-white px-6 py-2 rounded-xl font-bold">Unlock</button>
              </div>
            </div>
          )}
          {error && <div className="max-w-2xl mx-auto mb-8 p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm font-medium">{error}</div>}
        </AnimatePresence>

        {data && (
          <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold text-slate-900">Note Summary</h2>
                <p className="text-sm text-slate-500">{data.trades.length} transactions processed</p>
              </div>
              <div className="flex gap-3">
                <button onClick={() => setData(null)} className="px-4 py-2 text-sm font-bold text-slate-600 bg-white border border-slate-300 rounded-xl">Clear</button>
                <button onClick={downloadCSV} className="px-4 py-2 text-sm font-bold text-white bg-indigo-600 rounded-xl">Export CSV</button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
              <SummaryCard label="Total Amount" value={totalGrossValue} highlight />
              <SummaryCard label="Total w/ Expense (Incl STT)" value={totalWithExpenseInclSTT} highlight />
              <SummaryCard label="Total w/ Expense (Excl STT)" value={totalWithExpenseExclSTT} highlight />
              <SummaryCard label="Brokerage" value={data.summary.taxableValue} />
              <SummaryCard label="Total STT" value={data.summary.stt} />
              <SummaryCard label="Total GST" value={data.summary.cgst + data.summary.sgst} />
              <SummaryCard label="Stamp Duty" value={data.summary.stampDuty} />
              <SummaryCard label="Exchange Tx" value={data.summary.etc} />
              <SummaryCard label="SEBI Fees" value={data.summary.sebiFees} />
              <SummaryCard label="Clearing" value={data.summary.clearingCharges} />
              <SummaryCard label="IPF" value={data.summary.ipf} />
              <SummaryCard label="Net Settlement" value={data.summary.netSettlement} highlight />
              <SummaryCard label="Total Charges" value={data.summary.stt + data.summary.cgst + data.summary.sgst + data.summary.etc + data.summary.sebiFees + data.summary.clearingCharges + data.summary.stampDuty + data.summary.ipf} highlight />
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
                    <th className="px-6 py-4 text-right">Total Amount</th>
                    <th className="px-6 py-4 text-right">Total (Incl STT)</th>
                    <th className="px-6 py-4 text-right">Total (Excl STT)</th>
                    <th className="px-6 py-4 text-right font-bold text-slate-900 border-l border-slate-100">Net Obligation (Before Levies)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 italic font-mono text-xs">
                  {data.trades.map(t => {
                    const totalQntXPrice = t.quantity * t.avgPrice;
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
                        <td className="px-6 py-4 text-right font-medium">{t.quantity}</td>
                        <td className="px-6 py-4 text-right">{t.avgPrice.toFixed(2)}</td>
                        <td className="px-6 py-4 text-right">{totalQntXPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className="px-6 py-4 text-right font-semibold text-slate-700">{totalInclSTT.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className="px-6 py-4 text-right font-semibold text-slate-700">{totalExclSTT.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className={`px-6 py-4 text-right font-black border-l border-slate-100 ${t.netTotalBeforeLevies >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{t.netTotalBeforeLevies.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2 text-slate-400 text-[10px] font-bold uppercase">
              <Info className="w-3 h-3" />
              <span>Note: All taxes and payout obligations are source-of-truth values extracted from the broker summary table.</span>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
