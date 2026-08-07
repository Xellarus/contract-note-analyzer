import { useState, type ChangeEvent } from 'react';
import { Upload, Loader2, AlertTriangle, X, FileText } from 'lucide-react';
import { ModalShell, toast } from './ui/overlay';
import { formatDMY } from '../lib/dates';
import {
  parseSingleStockTxnCsv, reconstructStockOpening, previewStockOpeningRemoval, applyStockOpeningImport,
  OPENING_CUTOFF_ISO, ParsedStockCsv, OpeningReconstruction, RemovalPreview,
} from '../lib/stockOpeningImport';

/**
 * Per-stock opening-basis CSV import (temporary tool). Upload this stock's broker transaction
 * statement; only rows ≤ 31-Mar-2025 are used to REBUILD its opening position (Opening Holdings
 * + Opening Txns) for the current account. Shows a full preview before touching anything, since
 * it deletes + overwrites the stock's existing opening-basis rows. Other stocks are untouched.
 */

const fmtINR = (n: number) =>
  '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fmtNum = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 4 });

interface Props {
  open: boolean;
  onClose: () => void;
  spreadsheetId: string;
  stockName: string;
  isin: string;
  accountLabel?: string;
  onDone: () => void;
}

export default function StockOpeningImportModal({ open, onClose, spreadsheetId, stockName, isin, accountLabel, onDone }: Props) {
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedStockCsv | null>(null);
  const [recon, setRecon] = useState<OpeningReconstruction | null>(null);
  const [removal, setRemoval] = useState<RemovalPreview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  const reset = () => { setFileName(''); setParsed(null); setRecon(null); setRemoval(null); setError(''); };
  const close = () => { if (applying) return; reset(); onClose(); };

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';   // allow re-selecting the same file
    if (!file) return;
    reset();
    setFileName(file.name);
    setLoading(true);
    try {
      if (!/\.csv$/i.test(file.name)) throw new Error('Please choose a .csv file.');
      const text = await file.text();
      const p = parseSingleStockTxnCsv(text, stockName);
      if (p.error) throw new Error(p.error);
      if (p.kept === 0) throw new Error(`No rows dated on/before ${OPENING_CUTOFF_ISO} were found in this file.`);
      const r = reconstructStockOpening(p.txns, isin);
      const rem = await previewStockOpeningRemoval(spreadsheetId, stockName, isin);
      setParsed(p); setRecon(r); setRemoval(rem);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function apply() {
    if (applying) return;
    if (!parsed || !recon) {
      // Always give feedback — never a dead click. (Button stays clickable so this can show.)
      setError(loading ? 'Still reading the file — wait a moment and try again.'
        : fileName ? 'That file produced no importable rows — see the message above.'
        : 'Choose the transaction-statement CSV first (the button at the top of this dialog).');
      return;
    }
    setError('');
    setApplying(true);
    try {
      const res = await applyStockOpeningImport(spreadsheetId, stockName, isin, recon.lots, parsed.txns);
      toast.success(
        `${stockName}: opening basis rebuilt — ${res.lotsWritten} lot(s), ${res.txnsWritten} txn(s) ` +
        `(replaced ${res.lotsRemoved} lot / ${res.txnsRemoved} txn).`,
      );
      try { onDone(); } catch { /* a refresh hiccup shouldn't read as an import failure */ }
      reset();
      onClose();
    } catch (err: any) {
      const msg = err?.result?.error?.message || err?.message || String(err);
      // Surface it IN the modal — a toast can render behind the overlay, so failures looked silent.
      console.error('Opening-basis import failed:', err);
      setError(`Import failed: ${msg}`);
      toast.error(`Import failed: ${msg}`);
    } finally {
      setApplying(false);
    }
  }

  return (
    <ModalShell open={open} onClose={close} busy={applying} labelledBy="stock-import-title">
      <div className="relative z-10 w-[min(94vw,560px)] max-h-[88vh] flex flex-col bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-200 bg-slate-50">
          <div>
            <h2 id="stock-import-title" className="text-sm font-black text-slate-900 flex items-center gap-1.5">
              <Upload className="w-4 h-4 text-indigo-600" /> Import opening trades — {stockName}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Rebuilds this stock's opening position (through {OPENING_CUTOFF_ISO}){accountLabel ? ` · ${accountLabel}` : ''}. FY26 trades are left untouched.
            </p>
          </div>
          <button onClick={close} disabled={applying} className="text-slate-400 hover:text-slate-700 disabled:opacity-40 cursor-pointer" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
          {/* File picker */}
          <label className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border border-dashed cursor-pointer text-[12px] font-bold ${loading ? 'opacity-60 pointer-events-none' : ''} border-slate-300 text-slate-600 hover:border-indigo-400 hover:bg-indigo-50/40`}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            {fileName || 'Choose the transaction-statement CSV…'}
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} disabled={loading || applying} data-autofocus />
          </label>

          {error && (
            <div className="flex items-start gap-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
            </div>
          )}

          {/* Preview */}
          {parsed && recon && removal && (
            <div className="space-y-3">
              <div className="text-[11px] text-slate-500">
                {parsed.total} rows in file · <span className="font-bold text-slate-700">{parsed.kept} kept</span> (≤ {OPENING_CUTOFF_ISO})
                {parsed.dropped > 0 && <> · <span className="text-amber-700">{parsed.dropped} dropped</span> (after {OPENING_CUTOFF_ISO})</>}
              </div>

              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-[10px] font-black uppercase tracking-wider text-slate-500">
                  Reconstructed position as of {OPENING_CUTOFF_ISO}
                </div>
                <div className="divide-y divide-slate-100">
                  {recon.lots.length === 0 && (
                    <div className="px-3 py-3 text-[12px] text-slate-500">No shares remain after {OPENING_CUTOFF_ISO} (fully sold). This will clear the stock's opening basis.</div>
                  )}
                  {recon.lots.map((l, i) => (
                    <div key={i} className="px-3 py-2 flex items-center justify-between text-[12px]">
                      <div className="flex items-center gap-2">
                        <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded ${l.longTerm ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>{l.longTerm ? 'Long' : 'Short'}</span>
                        <span className="font-mono text-slate-700">{formatDMY(l.acqDate)}</span>
                      </div>
                      <div className="font-mono text-slate-800">{fmtNum(l.qty)} × {fmtINR(l.costPerShare)} = {fmtINR(l.invested)}</div>
                    </div>
                  ))}
                </div>
                {recon.lots.length > 0 && (
                  <div className="px-3 py-2 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-[12px] font-black text-slate-900">
                    <span>{fmtNum(recon.qty)} shares · {recon.longLots} long / {recon.shortLots} short lot(s)</span>
                    <span className="font-mono">{fmtINR(recon.invested)}</span>
                  </div>
                )}
              </div>

              <div className="flex items-start gap-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  This <b>replaces</b> {stockName}'s opening basis: removes its existing{' '}
                  <b>{removal.lots}</b> opening lot(s) + <b>{removal.txns}</b> opening txn(s), and writes{' '}
                  <b>{recon.lots.length}</b> lot(s) + <b>{parsed.kept}</b> txn(s). Other stocks and FY26 trades are untouched.
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-2">
          {/* Always-visible state — if you can see this line, you're on the latest build. */}
          <span className="text-[10px] text-slate-400 font-mono select-none" data-import-state>
            {applying ? 'importing…' : loading ? 'reading file…' : recon ? `ready · ${recon.lots.length} lot(s)` : fileName ? 'no importable rows' : 'no file chosen'}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={close} disabled={applying} className="px-3 py-1.5 text-[11px] font-black uppercase tracking-wider rounded-md border border-slate-200 bg-white text-slate-600 hover:border-slate-300 disabled:opacity-40 cursor-pointer">Cancel</button>
            <button
              onClick={apply}
              disabled={applying}
              aria-disabled={!parsed || !recon}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[11px] font-black uppercase tracking-wider rounded-md text-white cursor-pointer ${(!parsed || !recon) ? 'bg-slate-400 hover:bg-slate-400' : 'bg-indigo-600 hover:bg-indigo-500'} disabled:opacity-40`}
            >
              {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              {applying ? 'Importing…' : 'Replace opening basis'}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
