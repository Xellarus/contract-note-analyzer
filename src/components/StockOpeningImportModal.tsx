import { useState, type ChangeEvent } from 'react';
import { Upload, Loader2, AlertTriangle, X, FileText, Download, Plus, Info } from 'lucide-react';
import { ModalShell, toast } from './ui/overlay';
import { formatDMY } from '../lib/dates';
import {
  parseTradeFile, previewStockOpeningAdd, addStockOpeningImport,
  OPENING_CUTOFF_ISO, ParsedStockCsv, AddPreview,
} from '../lib/stockOpeningImport';
import { downloadOpeningTemplate } from '../lib/openingTemplate';

/**
 * Per-stock opening-trades import. Two ways in: upload this stock's trades (.xlsx or .csv), or
 * download the two-tab template to fill in first.
 *
 * The upload ADDS to what is already recorded for the stock — it does not replace it (user
 * directive 2026-09-14). The preview therefore shows THREE numbers that matter: what is on the
 * sheet now, what is being added, and what the position becomes. Showing only the file's own
 * reconstruction, as the replace version did, would read as the whole position and make an
 * additive import look like it had lost shares.
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
  const [preview, setPreview] = useState<AddPreview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const reset = () => { setFileName(''); setParsed(null); setPreview(null); setError(''); };
  const close = () => { if (applying) return; reset(); onClose(); };

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';   // allow re-selecting the same file
    if (!file) return;
    reset();
    setFileName(file.name);
    setLoading(true);
    try {
      const p = await parseTradeFile(file, stockName, isin);
      if (p.error) throw new Error(p.error);
      if (p.kept === 0) {
        throw new Error(
          p.foreign > 0 && p.total === p.foreign
            ? `Every row in this file belongs to a different security (${p.foreignNames.join(', ')}). Open that stock's page to import it there.`
            : `No rows dated on or before ${OPENING_CUTOFF_ISO} were found in this file.`,
        );
      }
      const pv = await previewStockOpeningAdd(spreadsheetId, stockName, isin, p.txns);
      // Clear the error HERE, not only in `reset()` at the top. The Add button stays clickable
      // while a file is being read, on purpose, so that a click during the read gives feedback
      // instead of doing nothing — and that feedback ("Still reading the file") is then left
      // standing once the read finishes, sitting in red above a preview that rendered perfectly.
      // Reported 16-Sep-2026, and it reads as though the import had failed when it had not.
      setParsed(p); setPreview(pv); setError('');
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function downloadTemplate() {
    if (downloading) return;
    setDownloading(true);
    setError('');
    try {
      await downloadOpeningTemplate(stockName, isin);
      toast.success('Template downloaded — fill the "Equity Trades template" tab, then upload it here.');
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error('Template download failed:', err);
      setError(`Couldn't build the template: ${msg}`);
    } finally {
      setDownloading(false);
    }
  }

  async function apply() {
    if (applying) return;
    if (!parsed || !preview) {
      // Always give feedback — never a dead click. (Button stays clickable so this can show.)
      setError(loading ? 'Still reading the file — wait a moment and try again.'
        : fileName ? 'That file produced no importable rows — see the message above.'
        : 'Choose the trades file first (the button at the top of this dialog).');
      return;
    }
    if (preview.freshRows === 0) {
      setError(`Every row in this file is already recorded for ${stockName} — nothing to add.`);
      return;
    }
    setError('');
    setApplying(true);
    try {
      const res = await addStockOpeningImport(spreadsheetId, stockName, isin, parsed.txns);
      toast.success(
        `${stockName}: ${res.txnsWritten} trade(s) added — ${fmtNum(res.qtyBefore)} → ${fmtNum(res.qtyAfter)} shares ` +
        `(${res.lotsBefore} → ${res.lotsAfter} lot(s))` +
        (res.duplicatesSkipped > 0 ? `, ${res.duplicatesSkipped} duplicate(s) skipped.` : '.'),
      );
      try { onDone(); } catch { /* a refresh hiccup shouldn't read as an import failure */ }
      reset();
      onClose();
    } catch (err: any) {
      const msg = err?.result?.error?.message || err?.message || String(err);
      // Surface it IN the modal — a toast can render behind the overlay, so failures looked silent.
      console.error('Stock trade import failed:', err);
      setError(`Import failed: ${msg}`);
      toast.error(`Import failed: ${msg}`);
    } finally {
      setApplying(false);
    }
  }

  const landing = !parsed && !loading;

  return (
    <ModalShell open={open} onClose={close} busy={applying} labelledBy="stock-import-title">
      <div className="relative z-10 w-[min(94vw,560px)] max-h-[88vh] flex flex-col bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-200 bg-slate-50">
          <div>
            <h2 id="stock-import-title" className="text-sm font-black text-slate-900 flex items-center gap-1.5">
              <Upload className="w-4 h-4 text-indigo-600" /> Import trades — {stockName}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Adds trades dated on or before {OPENING_CUTOFF_ISO} to this stock's recorded history{accountLabel ? ` · ${accountLabel}` : ''}. Nothing already there is replaced; FY26 trades are untouched.
            </p>
          </div>
          <button onClick={close} disabled={applying} className="text-slate-400 hover:text-slate-700 disabled:opacity-40 cursor-pointer" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
          {/* Two ways in. Once a file is read the preview takes over and the picker shrinks to
              one line, so the dialog never shows a call to action below a result. */}
          {landing ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col items-start gap-1.5 px-4 py-4 rounded-xl border border-dashed border-slate-300 text-slate-600 hover:border-indigo-400 hover:bg-indigo-50/40 cursor-pointer">
                <Upload className="w-5 h-5 text-indigo-600" />
                <span className="text-[12px] font-black text-slate-800">Import trades</span>
                <span className="text-[11px] text-slate-500 leading-snug">Upload a filled template, or any broker .xlsx / .csv with Date, Type, Quantity and Price columns.</span>
                <input type="file" accept=".xlsx,.xls,.csv,text/csv" className="hidden" onChange={onFile} disabled={loading || applying} data-autofocus />
              </label>

              <button
                type="button"
                onClick={downloadTemplate}
                disabled={downloading}
                className="flex flex-col items-start gap-1.5 px-4 py-4 rounded-xl border border-dashed border-slate-300 text-left text-slate-600 hover:border-indigo-400 hover:bg-indigo-50/40 disabled:opacity-50 cursor-pointer"
              >
                {downloading ? <Loader2 className="w-5 h-5 animate-spin text-indigo-600" /> : <Download className="w-5 h-5 text-indigo-600" />}
                <span className="text-[12px] font-black text-slate-800">Download sample template</span>
                <span className="text-[11px] text-slate-500 leading-snug">A two-tab workbook — the grid to fill in, plus instructions for every column.</span>
              </button>
            </div>
          ) : (
            <label className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border border-dashed cursor-pointer text-[12px] font-bold ${loading ? 'opacity-60 pointer-events-none' : ''} border-slate-300 text-slate-600 hover:border-indigo-400 hover:bg-indigo-50/40`}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
              {fileName || 'Choose a different file…'}
              <input type="file" accept=".xlsx,.xls,.csv,text/csv" className="hidden" onChange={onFile} disabled={loading || applying} />
            </label>
          )}

          {error && (
            <div className="flex items-start gap-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
            </div>
          )}

          {/* Preview */}
          {parsed && preview && (
            <div className="space-y-3">
              <div className="text-[11px] text-slate-500">
                {parsed.total} rows in file · <span className="font-bold text-slate-700">{parsed.kept} for this stock</span> (≤ {OPENING_CUTOFF_ISO})
                {parsed.dropped > 0 && <> · <span className="text-amber-700">{parsed.dropped} dropped</span> (dated after {OPENING_CUTOFF_ISO}, or no readable date)</>}
                {parsed.foreign > 0 && <> · <span className="text-rose-700">{parsed.foreign} other security</span> ({parsed.foreignNames.join(', ')})</>}
                {preview.duplicates > 0 && <> · <span className="text-amber-700">{preview.duplicates} already imported</span> (skipped)</>}
                {parsed.sheetName && <> · from sheet “{parsed.sheetName}”</>}
              </div>

              {/* Before → after, so an ADD never reads as a replacement. */}
              <div className="flex items-center justify-between gap-2 text-[12px] px-3 py-2 rounded-xl border border-slate-200 bg-slate-50">
                <div>
                  <div className="text-[10px] font-black uppercase tracking-wider text-slate-500">On the sheet now</div>
                  <div className="font-mono text-slate-700">{fmtNum(preview.existingQty)} sh · {preview.existingLots} lot(s)</div>
                </div>
                <Plus className="w-4 h-4 text-indigo-600 shrink-0" />
                <div>
                  <div className="text-[10px] font-black uppercase tracking-wider text-slate-500">Adding</div>
                  <div className="font-mono text-slate-700">{preview.freshRows} trade(s)</div>
                </div>
                <span className="text-slate-400">→</span>
                <div className="text-right">
                  <div className="text-[10px] font-black uppercase tracking-wider text-slate-500">Becomes</div>
                  <div className="font-mono font-black text-slate-900">{fmtNum(preview.result.qty)} sh · {preview.result.lots.length} lot(s)</div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-[10px] font-black uppercase tracking-wider text-slate-500">
                  Resulting position as of {OPENING_CUTOFF_ISO}
                </div>
                <div className="divide-y divide-slate-100">
                  {preview.result.lots.length === 0 && (
                    <div className="px-3 py-3 text-[12px] text-slate-500">No shares remain after {OPENING_CUTOFF_ISO} — the sells in this file consume everything held.</div>
                  )}
                  {preview.result.lots.map((l, i) => (
                    <div key={i} className="px-3 py-2 flex items-center justify-between text-[12px]">
                      <div className="flex items-center gap-2">
                        <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded ${l.longTerm ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>{l.longTerm ? 'Long' : 'Short'}</span>
                        <span className="font-mono text-slate-700">{formatDMY(l.acqDate)}</span>
                      </div>
                      <div className="font-mono text-slate-800">{fmtNum(l.qty)} × {fmtINR(l.costPerShare)} = {fmtINR(l.invested)}</div>
                    </div>
                  ))}
                </div>
                {preview.result.lots.length > 0 && (
                  <div className="px-3 py-2 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-[12px] font-black text-slate-900">
                    <span>{fmtNum(preview.result.qty)} shares · {preview.result.longLots} long / {preview.result.shortLots} short lot(s)</span>
                    <span className="font-mono">{fmtINR(preview.result.invested)}</span>
                  </div>
                )}
              </div>

              {/* Anything the replay itself wants to say — an oversell is the one that matters:
                  it means this file sells more than was ever held, so a buy is missing. */}
              {preview.result.issues.map((iss, i) => (
                <div key={i} className="flex items-start gap-2 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{iss.message}</span>
                </div>
              ))}

              {preview.outOfOrder && (
                <div className="flex items-start gap-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    This batch buys at dates <b>older</b> than lots already on the sheet <i>and</i> sells in the same file. FIFO consumes what is already there first, so the sells may take the wrong lots. Import the oldest trades first.
                  </span>
                </div>
              )}

              {parsed.amountDiverged > 0 && (
                <div className="flex items-start gap-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    <b>{parsed.amountDiverged}</b> row(s) have a Total Amount that isn't Quantity × Price — Total Amount wins and becomes the cost basis. If those figures include brokerage, clear the column so Price is used: charges must not enter the basis.
                  </span>
                </div>
              )}

              {/* Corporate-action rows. These used to be parsed, counted, written and then
                  contribute NOTHING — the replay derives a bonus from a stored ratio and this
                  importer has none to give it. Saying what happened to them is the difference
                  between a short position you can act on and one you cannot explain. */}
              {preview.result.corpActions.credited.length > 0 && (
                <div className="flex items-start gap-2 text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                  <Info className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    <b>{preview.result.corpActions.credited.length}</b> bonus / rights row(s) credited at the quantity typed on the row
                    {' '}({preview.result.corpActions.credited.map(c => `${fmtNum(c.qty)} on ${c.iso}`).join(', ')}).
                    A bonus carries <b>no cost</b>; rights are costed at their Price.
                  </span>
                </div>
              )}

              {preview.result.corpActions.ignored.length > 0 && (
                <div className="flex items-start gap-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    <b>{preview.result.corpActions.ignored.length}</b> row(s) add <b>no shares</b> and are not in the figures above:{' '}
                    {preview.result.corpActions.ignored.map(x => `${x.kind} ${x.iso} — ${x.reason}`).join('; ')}.
                    Enter the resulting shares as a <b>Buy</b> row with the quantity, priced 0 for a bonus.
                  </span>
                </div>
              )}

              <div className="flex items-start gap-2 text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                <Info className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  These <b>{preview.freshRows}</b> trade(s) are <b>added</b> to what is already recorded for {stockName} — its existing{' '}
                  <b>{preview.existingLots}</b> lot(s) are kept and any sell here consumes the oldest of them, FIFO. Other stocks and FY26 trades are untouched.
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-2">
          {/* Always-visible state — if you can see this line, you're on the latest build. */}
          <span className="text-[10px] text-slate-400 font-mono select-none" data-import-state>
            {applying ? 'importing…' : loading ? 'reading file…' : preview ? `ready · +${preview.freshRows} trade(s)` : fileName ? 'no importable rows' : 'no file chosen'}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={close} disabled={applying} className="px-3 py-1.5 text-[11px] font-black uppercase tracking-wider rounded-md border border-slate-200 bg-white text-slate-600 hover:border-slate-300 disabled:opacity-40 cursor-pointer">Cancel</button>
            <button
              onClick={apply}
              disabled={applying}
              aria-disabled={!parsed || !preview}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[11px] font-black uppercase tracking-wider rounded-md text-white cursor-pointer ${(!parsed || !preview) ? 'bg-slate-400 hover:bg-slate-400' : 'bg-indigo-600 hover:bg-indigo-500'} disabled:opacity-40`}
            >
              {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              {applying ? 'Importing…' : 'Add trades'}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
