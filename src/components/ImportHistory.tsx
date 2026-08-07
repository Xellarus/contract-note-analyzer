import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Loader2, History, AlertCircle, RotateCcw, Undo2 } from 'lucide-react';
import { fetchImportLog, markImportReversed } from '../lib/accessLog';
import { reverseImport } from '../lib/importReverse';
import { portfolioByCode } from '../lib/portfolios';
import { confirmDialog, toast } from './ui/overlay';
import CubeLoader from './ui/CubeLoader';

const DEFAULT_HEADER = ["Date", "Time", "Contract Note Name", "Broker", "User", "Import ID", "Portfolio", "Rows", "Status"];

export default function ImportHistory() {
  const [header, setHeader] = useState<string[]>(DEFAULT_HEADER);
  const [rows, setRows] = useState<string[][]>([]);
  const [firstDataRow, setFirstDataRow] = useState(2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reversing, setReversing] = useState<number | null>(null); // sheet row currently being rewound

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchImportLog();
      setHeader(data.header.length ? data.header : DEFAULT_HEADER);
      setRows(data.rows);
      setFirstDataRow(data.firstDataRow);
    } catch (e: any) {
      setError(e?.result?.error?.message || e?.message || "Could not load import history.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-fetch the moment the History tab is opened (and on manual refresh).
  useEffect(() => { load(); }, [load]);

  // Locate the special columns by header name (robust to older/narrower logs).
  const lc = header.map((h) => (h || '').toLowerCase());
  const cImportId = lc.findIndex((h) => /import id|import batch|batch id/.test(h));
  const cStatus = lc.findIndex((h) => /status/.test(h));
  const cPortfolio = lc.findIndex((h) => /portfolio/.test(h));
  const cRows = lc.findIndex((h) => /^rows$/.test(h));
  // Table shows every column except the internal Import ID + Status ones.
  const displayCols = header.map((_, i) => i).filter((i) => i !== cImportId && i !== cStatus);

  // Newest first, keeping each row's 1-based sheet position for in-place updates.
  const displayRows = rows.map((cells, i) => ({ cells, sheetRow: firstDataRow + i })).reverse();

  const handleRewind = async (cells: string[], sheetRow: number) => {
    const importId = cImportId >= 0 ? (cells[cImportId] || '').trim() : '';
    const code = cPortfolio >= 0 ? (cells[cPortfolio] || '').trim() : '';
    const port = portfolioByCode(code);
    if (!importId) { toast.error("This import has no Import ID, so it can't be rewound."); return; }
    if (!port?.sheetId) { toast.error(`Couldn't resolve which portfolio "${code || '?'}" maps to.`); return; }

    const noteName = cells[2] || 'this note';
    const nRows = cRows >= 0 ? (cells[cRows] || '').trim() : '';
    const ok = await confirmDialog({
      title: 'Rewind this import?',
      body: (
        <span>
          This deletes the {nRows ? <b>{nRows} row(s)</b> : 'rows'} that <b>{noteName}</b> added to{' '}
          <b>Raw Entry</b> and <b>True Entry</b> in <b>{port.label}</b>, then rebuilds the Holding tab
          and re-syncs capital gains. This can't be undone.
        </span>
      ),
      confirmLabel: 'Rewind import',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (!ok) return;

    setReversing(sheetRow);
    try {
      const { removed, holdingWarning, capGainsWarning } = await reverseImport({ spreadsheetId: port.sheetId, importId });
      if (cStatus >= 0) await markImportReversed(sheetRow, cStatus);
      const warn = [holdingWarning && 'the Holding tab', capGainsWarning && 'capital gains'].filter(Boolean).join(' and ');
      if (warn) {
        toast.error(`Removed ${removed} row(s), but couldn't rebuild ${warn}. Recompute it manually.`);
      } else {
        toast.success(`Rewound — removed ${removed} row(s) and refreshed Holding + capital gains.`);
      }
      await load();
    } catch (e: any) {
      toast.error(e?.result?.error?.message || e?.message || 'Rewind failed.');
    } finally {
      setReversing(null);
    }
  };

  const cell = (cells: string[], ci: number) => {
    const val = cells[ci] ?? '';
    if (ci === cPortfolio && val) return portfolioByCode(val)?.label || val;
    return val;
  };

  return (
    <div className="max-w-6xl mx-auto animate-fadeIn">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-150 bg-slate-50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-100 text-indigo-700 rounded-lg">
              <History className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">Import History</h3>
              <p className="text-[11px] text-slate-500 font-medium">
                {loading ? 'Loading from the log sheet…' : `${rows.length} import${rows.length === 1 ? '' : 's'} recorded`}
              </p>
            </div>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Body */}
        {loading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-slate-500 text-sm">
            <CubeLoader className="w-12" />
            <span className="animate-pulse">Fetching import history…</span>
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 m-5 p-3 rounded-xl border border-rose-200 bg-rose-50 text-[12px] text-rose-700">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        ) : rows.length === 0 ? (
          <p className="text-center text-sm text-slate-500 italic py-16">No imports logged yet. They'll appear here after you import a contract note.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[#f8fafc] border-b border-slate-200 text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                <tr>
                  {displayCols.map((ci) => (
                    <th key={ci} className={`px-5 py-3 ${ci === 0 || ci === 1 ? 'whitespace-nowrap' : ''}`}>{header[ci]}</th>
                  ))}
                  <th className="px-5 py-3 text-right whitespace-nowrap">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {displayRows.map(({ cells, sheetRow }) => {
                  const importId = cImportId >= 0 ? (cells[cImportId] || '').trim() : '';
                  const status = cStatus >= 0 ? (cells[cStatus] || '').trim().toLowerCase() : '';
                  const rowsAdded = cRows >= 0 ? (cells[cRows] || '').trim() : '';
                  const isReversed = status === 'reversed';
                  const canRewind = !!importId && rowsAdded !== '0';
                  const busy = reversing === sheetRow;
                  return (
                    <tr key={sheetRow} className={`transition-colors ${isReversed ? 'opacity-55' : 'hover:bg-slate-50'}`}>
                      {displayCols.map((ci) => (
                        <td key={ci} className={`px-5 py-2.5 text-slate-700 ${ci === 2 ? 'font-medium text-slate-800 break-all' : ''} ${ci === 0 || ci === 1 ? 'whitespace-nowrap text-slate-500' : ''} ${isReversed && ci === 2 ? 'line-through' : ''}`}>
                          {cell(cells, ci)}
                        </td>
                      ))}
                      <td className="px-5 py-2.5 text-right whitespace-nowrap">
                        {isReversed ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 text-[11px] font-bold uppercase tracking-wide">
                            <Undo2 className="w-3 h-3" /> Reversed
                          </span>
                        ) : canRewind ? (
                          <button
                            onClick={() => handleRewind(cells, sheetRow)}
                            disabled={busy || reversing !== null}
                            title="Delete this import's rows and rebuild Holding + capital gains"
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold text-rose-600 border border-rose-200 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                            {busy ? 'Rewinding…' : 'Rewind'}
                          </button>
                        ) : (
                          <span className="text-slate-300" title="Imported before Rewind was available">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
