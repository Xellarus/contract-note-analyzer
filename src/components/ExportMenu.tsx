/**
 * The one export control for every report: CSV, XLSX or PDF from a single ReportDoc.
 *
 * `doc` is a THUNK, not a value — building the document for a few-thousand-row ledger is real
 * work, and it should happen when the user picks a format, not on every render of the screen
 * that hosts this button.
 *
 * The XLSX and PDF renderers are dynamically imported inside their own modules, so neither
 * ExcelJS nor pdfmake is in the initial bundle.
 */
import { useState, useRef, useEffect } from 'react';
import { Download, ChevronDown, FileText, FileSpreadsheet, FileType2, Loader2 } from 'lucide-react';
import type { ReportDoc } from '../lib/reportDoc';
import { downloadCsv } from '../lib/reportDoc';
import { toast, confirmDialog } from './ui/overlay';
import { handleStaleChunk } from './ui/lazyImport';

type Fmt = 'csv' | 'xlsx' | 'pdf';

/** Above this many rows a PDF stops being a document and starts being a phone book. */
const PDF_WARN_ROWS = 2000;

const OPTIONS: { fmt: Fmt; label: string; hint: string; Icon: typeof FileText }[] = [
  { fmt: 'csv', label: 'CSV', hint: 'Raw data for Excel or another tool', Icon: FileText },
  { fmt: 'xlsx', label: 'Excel workbook', hint: 'Formatted, filterable, print-ready', Icon: FileSpreadsheet },
  { fmt: 'pdf', label: 'PDF statement', hint: 'Letterhead report for sharing or filing', Icon: FileType2 },
];

export default function ExportMenu({ doc, disabled = false }: { doc: () => ReportDoc; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Fmt | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const run = async (fmt: Fmt) => {
    if (busy) return;
    setOpen(false);

    let d: ReportDoc;
    try {
      d = doc();
    } catch (e: any) {
      console.error('Could not assemble the report document', e);
      toast.error(`Could not assemble the report — ${e?.message || 'unknown error'}`);
      return;
    }

    // pdfmake lays the whole document out in the browser, so a very long ledger is slow and
    // produces something nobody reads. Say so and let the user choose, rather than either
    // freezing the tab or silently truncating the report.
    if (fmt === 'pdf' && d.rows.length > PDF_WARN_ROWS) {
      const go = await confirmDialog({
        title: `Build a ${d.rows.length.toLocaleString('en-IN')}-row PDF?`,
        body: (
          <>
            A statement this long runs to roughly <strong>{Math.ceil(d.rows.length / 40).toLocaleString('en-IN')} pages</strong> and
            can take a while to render. The Excel workbook handles this size far better and stays filterable.
            {/* Last screen before a long statement leaves the machine. Naming what it covers here
                is what catches "I meant Consolidated" before 12 pages get built and filed. */}
            {d.titleTag && (
              <> This one covers <strong>{d.titleTag}</strong> only.</>
            )}
          </>
        ),
        confirmLabel: 'Build it anyway',
        cancelLabel: 'Cancel',
      });
      if (!go) return;
    }

    setBusy(fmt);
    try {
      if (fmt === 'csv') {
        downloadCsv(d);
      } else if (fmt === 'xlsx') {
        const { downloadXlsx } = await import('../lib/reportXlsx');
        await downloadXlsx(d);
      } else {
        const { downloadPdf } = await import('../lib/reportPdf');
        await downloadPdf(d);
      }
    } catch (e: any) {
      console.error(`${fmt.toUpperCase()} export failed`, e);
      // The XLSX/PDF renderers and their ExcelJS/pdfmake chunks are all lazily loaded, so a
      // redeploy mid-session lands here. That is not an export fault — see handleStaleChunk.
      if (handleStaleChunk(e)) return;
      toast.error(`Could not build the ${fmt.toUpperCase()} — ${e?.message || 'unknown error'}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled || !!busy}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy
          ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Building {busy.toUpperCase()}…</>
          : <><Download className="w-3.5 h-3.5" /> Export <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} /></>}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 z-30 rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden animate-fadeIn">
          {OPTIONS.map(({ fmt, label, hint, Icon }) => (
            <button
              key={fmt}
              onClick={() => run(fmt)}
              className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-indigo-50 transition-colors cursor-pointer border-b border-slate-100 last:border-b-0"
            >
              <Icon className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
              <span className="min-w-0">
                <span className="block text-xs font-bold text-slate-800">{label}</span>
                <span className="block text-[10px] text-slate-500 leading-snug mt-0.5">{hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
