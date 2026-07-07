import { useState, useRef } from 'react';
import {
  UploadCloud, FileSpreadsheet, Loader2, CheckCircle2, AlertCircle,
  TrendingUp, Database, X, PieChart,
} from 'lucide-react';
import { parseScreenerCsv, isScreenerCsv, ScreenerSecurity } from '../lib/screener';
import { loadScripMaster, appendScreenerSecurities, SCRIP_MASTER_SPREADSHEET_ID } from '../lib/scripMaster';
import { saveScripPrices } from '../lib/scripPrices';
import { saveScripIndustries } from '../lib/scripIndustries';
import { hasValidGoogleToken } from '../lib/googleAuth';

interface ImportResult { added: number; addedNames: string[]; pricesUpdated: number; pricesTotal: number; industriesUpdated: number; }

const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ScreenerImport() {
  const [securities, setSecurities] = useState<ScreenerSecurity[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setSecurities(null); setFileName(''); setParseError(null);
    setResult(null); setImportError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;
    reset();
    setFileName(file.name);
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.csv')) {
      setParseError("Please upload the CSV export from screener.in — a PDF of this table won't parse reliably.");
      return;
    }
    try {
      const text = await file.text();
      if (!isScreenerCsv(text)) {
        setParseError("This doesn't look like a screener.in export — it needs an ISIN and a Current Price column.");
        return;
      }
      const parsed = parseScreenerCsv(text);
      if (parsed.length === 0) {
        setParseError("No valid securities found (no rows with a recognizable ISIN).");
        return;
      }
      setSecurities(parsed);
    } catch (e: any) {
      setParseError(e?.message || "Could not read the file.");
    }
  };

  const runImport = async () => {
    if (!securities) return;
    if (!hasValidGoogleToken()) {
      setImportError("Google Sheets connection required. Open the Holdings tab and authorize with Google first.");
      return;
    }
    setImporting(true);
    setImportError(null);
    setResult(null);
    try {
      const master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID, { force: true });
      const sec = await appendScreenerSecurities(SCRIP_MASTER_SPREADSHEET_ID, master,
        securities.map(s => ({ isin: s.isin, name: s.name, bse: s.bse, nse: s.nse, industry: s.industry })));
      const priced = securities.filter(s => s.price > 0).map(s => ({ isin: s.isin, name: s.name, price: s.price }));
      const pr = await saveScripPrices(SCRIP_MASTER_SPREADSHEET_ID, priced);
      // Industry / sector classification → its own upsert-by-ISIN tab (feeds the
      // Dashboard sector-allocation pie). Refreshes existing securities too.
      const withIndustry = securities.filter(s => s.industry).map(s => ({ isin: s.isin, name: s.name, industry: s.industry }));
      // Only touch the Industries tab when this export actually carries industry data.
      const ind = withIndustry.length ? await saveScripIndustries(SCRIP_MASTER_SPREADSHEET_ID, withIndustry) : { updated: 0, total: 0 };
      setResult({ added: sec.added, addedNames: sec.addedNames, pricesUpdated: pr.updated, pricesTotal: pr.total, industriesUpdated: ind.updated });
    } catch (e: any) {
      setImportError(e?.result?.error?.message || e?.message || "Import failed.");
    } finally {
      setImporting(false);
    }
  };

  const withPrice = securities ? securities.filter(s => s.price > 0).length : 0;
  const withIndustry = securities ? securities.filter(s => s.industry).length : 0;

  return (
    <div className="max-w-4xl mx-auto animate-fadeIn space-y-5">
      <div>
        <h2 className="text-lg font-black text-slate-800 tracking-tight">Securities &amp; Prices</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Import a <strong className="text-slate-700">screener.in</strong> CSV export to add new securities (ISIN · BSE · NSE)
          to the scrip master, refresh current prices used to value your holdings, and classify securities by
          industry (powers the Dashboard sector-allocation chart).
        </p>
      </div>

      {/* Upload zone */}
      {!result && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0] || null); }}
          onClick={() => inputRef.current?.click()}
          className={`rounded-2xl border-2 border-dashed p-8 text-center cursor-pointer transition-all ${
            dragOver ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 bg-white hover:border-indigo-300'
          }`}
        >
          <input ref={inputRef} type="file" accept=".csv" className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] || null)} />
          <UploadCloud className="w-9 h-9 mx-auto text-slate-300" />
          <p className="mt-2 text-sm font-bold text-slate-700">Drop your screener.in CSV here, or click to browse</p>
          <p className="text-[11px] text-slate-400 mt-1">Export from screener.in → must include ISIN Code &amp; Current Price columns</p>
          {fileName && <p className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-600 bg-slate-100 px-2.5 py-1 rounded-lg"><FileSpreadsheet className="w-3.5 h-3.5" /> {fileName}</p>}
        </div>
      )}

      {parseError && (
        <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[12px] text-amber-800">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{parseError}</span>
        </div>
      )}

      {/* Preview + import */}
      {securities && !result && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-slate-150 bg-slate-50">
            <div className="flex items-center gap-4 text-xs">
              <span className="inline-flex items-center gap-1.5 font-bold text-slate-700"><Database className="w-4 h-4 text-indigo-600" /> {securities.length} securities</span>
              <span className="inline-flex items-center gap-1.5 font-bold text-slate-700"><TrendingUp className="w-4 h-4 text-emerald-600" /> {withPrice} with prices</span>
              <span className="inline-flex items-center gap-1.5 font-bold text-slate-700"><PieChart className="w-4 h-4 text-violet-600" /> {withIndustry} with industry</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={reset} className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-100 rounded-lg cursor-pointer transition-colors"><X className="w-3.5 h-3.5" /> Clear</button>
              <button onClick={runImport} disabled={importing}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg transition-colors cursor-pointer disabled:opacity-50">
                {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
                {importing ? 'Importing…' : 'Import to scrip master & prices'}
              </button>
            </div>
          </div>
          <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[#f8fafc] border-b border-slate-200 text-[11px] font-bold text-slate-600 uppercase tracking-wider sticky top-0">
                <tr>
                  <th className="px-5 py-2.5">Name</th>
                  <th className="px-5 py-2.5">ISIN</th>
                  <th className="px-5 py-2.5">BSE</th>
                  <th className="px-5 py-2.5">NSE</th>
                  <th className="px-5 py-2.5">Industry</th>
                  <th className="px-5 py-2.5 text-right">Current Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {securities.map((s, i) => (
                  <tr key={i} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-2 font-medium text-slate-800">{s.name}</td>
                    <td className="px-5 py-2 font-mono text-[12px] text-slate-500">{s.isin}</td>
                    <td className="px-5 py-2 text-slate-600 font-mono text-[12px]">{s.bse || '—'}</td>
                    <td className="px-5 py-2 text-slate-600 font-mono text-[12px]">{s.nse || '—'}</td>
                    <td className="px-5 py-2 text-slate-600 text-[12px]">{s.industry || '—'}</td>
                    <td className="px-5 py-2 text-right font-mono text-slate-800">{s.price > 0 ? inr(s.price) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {importError && (
        <div className="flex items-start gap-2 p-3 rounded-xl border border-rose-200 bg-rose-50 text-[12px] text-rose-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{importError}</span>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="w-5 h-5" /><h3 className="text-sm font-black">Import complete</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-xl border border-slate-150 bg-slate-50 p-4">
              <p className="text-2xl font-black text-slate-800">{result.added}</p>
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mt-0.5">New securities added</p>
            </div>
            <div className="rounded-xl border border-slate-150 bg-slate-50 p-4">
              <p className="text-2xl font-black text-slate-800">{result.pricesUpdated}</p>
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mt-0.5">Prices updated</p>
            </div>
            <div className="rounded-xl border border-slate-150 bg-slate-50 p-4">
              <p className="text-2xl font-black text-slate-800">{result.industriesUpdated}</p>
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mt-0.5">Industries classified</p>
            </div>
            <div className="rounded-xl border border-slate-150 bg-slate-50 p-4">
              <p className="text-2xl font-black text-slate-800">{result.pricesTotal}</p>
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mt-0.5">Prices on file</p>
            </div>
          </div>
          {result.addedNames.length > 0 && (
            <div className="text-[11px] text-slate-500">
              <span className="font-bold text-slate-600">Added:</span> {result.addedNames.slice(0, 30).join(', ')}{result.addedNames.length > 30 ? ` +${result.addedNames.length - 30} more` : ''}
            </div>
          )}
          <p className="text-[11px] text-slate-400">
            Prices are a snapshot from this file — re-import a fresh export to refresh. Holdings will value at these prices (where matched); reload the Holdings tab to see them.
          </p>
          <button onClick={reset} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl transition-colors cursor-pointer">Import another file</button>
        </div>
      )}
    </div>
  );
}
