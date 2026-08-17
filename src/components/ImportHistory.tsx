import { useEffect, useState, useCallback, useMemo, type ReactNode } from 'react';
import { RefreshCw, Loader2, History, AlertCircle, RotateCcw, Undo2, Search, X, Plus, Upload } from 'lucide-react';
import { fetchImportLog, markImportReversed } from '../lib/accessLog';
import { reverseImport } from '../lib/importReverse';
import { portfolioByCode } from '../lib/portfolios';
import { hasValidGoogleToken } from '../lib/googleAuth';
import {
  resolveImportLogCols, buildImportLogRows, filterImportLogRows, distinctValues, ImportLogRow,
} from '../lib/importLogRows';
import { confirmDialog, toast } from './ui/overlay';
import CubeLoader from './ui/CubeLoader';

const DEFAULT_HEADER = ["Date", "Time", "Contract Note Name", "Broker", "User", "Import ID", "Portfolio", "Rows", "Status"];

/** Module scope, not inside the component: a type declared in render is a NEW type every
 *  render, so React would tear down and rebuild the whole header row on every keystroke
 *  in the search box. */
const TH = ({ children, right = false }: { children: ReactNode; right?: boolean }) => (
  <th className={`px-5 py-3 font-bold whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}>{children}</th>
);

/**
 * The Imports landing page: the primary Import action, then the log of every import with
 * a search box and the per-row Rewind. This used to be two sibling tabs ("Import" and
 * "Import History"); the upload flow is now a page you enter from the button here, so the
 * default screen is the record of what has already been imported.
 */
export default function ImportHistory({ onNewImport }: { onNewImport?: () => void }) {
  const [header, setHeader] = useState<string[]>(DEFAULT_HEADER);
  const [rows, setRows] = useState<string[][]>([]);
  const [firstDataRow, setFirstDataRow] = useState(2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reversing, setReversing] = useState<number | null>(null); // sheet row currently being rewound
  const [query, setQuery] = useState('');
  const [brokerFilter, setBrokerFilter] = useState('');
  const [portfolioFilter, setPortfolioFilter] = useState('');

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

  // Auto-fetch the moment the page is opened (and on manual refresh).
  //
  // The token guard matters now that this is the LANDING page rather than a tab you had to
  // click: App pushes the saved OAuth token into gapi asynchronously (the gapi.load →
  // client.init chain), and fetchImportLog throws "Not connected to Google Sheets" the
  // instant getToken() is empty. Fetching on mount therefore loses that race on every cold
  // load and latched a false error card over a perfectly valid session. So wait for the
  // token instead of failing, and only fetch-and-report once it lands or the budget runs
  // out. Same guard the Dashboard and Holdings use for the same reason.
  useEffect(() => {
    if (hasValidGoogleToken()) { load(); return; }
    let tries = 0;
    const id = window.setInterval(() => {
      tries++;
      if (hasValidGoogleToken() || tries >= 15) { window.clearInterval(id); load(); }
    }, 1000);
    return () => window.clearInterval(id);
  }, [load]);

  const cols = useMemo(() => resolveImportLogCols(header), [header]);
  const allRows = useMemo(() => buildImportLogRows(rows, cols, firstDataRow), [rows, cols, firstDataRow]);
  const brokers = useMemo(() => distinctValues(allRows, (r) => r.broker), [allRows]);
  const portfolios = useMemo(() => distinctValues(allRows, (r) => r.portfolio), [allRows]);
  const visible = useMemo(
    () => filterImportLogRows(allRows, { query, broker: brokerFilter, portfolio: portfolioFilter }),
    [allRows, query, brokerFilter, portfolioFilter],
  );

  const filtering = !!(query.trim() || brokerFilter || portfolioFilter);
  const clearFilters = () => { setQuery(''); setBrokerFilter(''); setPortfolioFilter(''); };

  const handleRewind = async (r: ImportLogRow) => {
    const port = portfolioByCode(r.portfolioCode);
    if (!r.importId) { toast.error("This import has no Import ID, so it can't be rewound."); return; }
    if (!port?.sheetId) { toast.error(`Couldn't resolve which portfolio "${r.portfolioCode || '?'}" maps to.`); return; }

    const noteName = r.note || 'this note';
    const ok = await confirmDialog({
      title: 'Rewind this import?',
      body: (
        <span>
          This deletes the {r.rows ? <b>{r.rows} row(s)</b> : 'rows'} that <b>{noteName}</b> added to{' '}
          <b>Raw Entry</b> and <b>True Entry</b> in <b>{port.label}</b>, then rebuilds the Holding tab
          and re-syncs capital gains. This can't be undone.
        </span>
      ),
      confirmLabel: 'Rewind import',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (!ok) return;

    setReversing(r.sheetRow);
    try {
      const { removed, holdingWarning, capGainsWarning } = await reverseImport({ spreadsheetId: port.sheetId, importId: r.importId });
      if (cols.status >= 0) await markImportReversed(r.sheetRow, cols.status);
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

  return (
    <div className="max-w-6xl mx-auto animate-fadeIn space-y-5">
      {/* ── Primary action: enter the upload flow ─────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-indigo-50 border border-indigo-100 shrink-0">
            <Upload className="w-5 h-5 text-indigo-600" />
          </div>
          <div>
            <h3 className="text-sm font-black text-slate-800 tracking-tight">Import contract notes</h3>
            <p className="text-[12px] text-slate-500 mt-0.5 leading-relaxed max-w-xl">
              Zerodha, Share India, Integrated or Nuvama. Drop the notes, check the reconciliation audit, then
              write them to <b className="font-bold text-slate-600">Raw Entry</b> and <b className="font-bold text-slate-600">True Entry</b>.
            </p>
          </div>
        </div>
        <button
          onClick={onNewImport}
          className="btn-press shrink-0 inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-black rounded-xl shadow-sm cursor-pointer"
        >
          <Plus className="w-4 h-4 stroke-[3]" /> Import
        </button>
      </div>

      {/* ── The log ───────────────────────────────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-150 bg-slate-50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-100 text-indigo-700 rounded-lg">
              <History className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">Import History</h3>
              <p className="text-[11px] text-slate-500 font-medium">
                {loading
                  ? 'Loading from the log sheet…'
                  : filtering
                    ? `${visible.length} of ${allRows.length} import${allRows.length === 1 ? '' : 's'} shown`
                    : `${allRows.length} import${allRows.length === 1 ? '' : 's'} recorded`}
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

        {/* Search / filters */}
        {!loading && !error && allRows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2.5 px-5 py-3 border-b border-slate-150 bg-white">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search note name, broker, user, portfolio or date…"
                className="w-full pl-9 pr-8 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-xl outline-none focus:ring-1 focus:ring-indigo-500"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  title="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-900 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {brokers.length > 1 && (
              <select
                value={brokerFilter}
                onChange={(e) => setBrokerFilter(e.target.value)}
                title="Filter by broker"
                className="px-3 py-2 text-xs font-bold text-slate-700 bg-white border border-slate-200 rounded-xl outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
              >
                <option value="">All brokers</option>
                {brokers.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            )}
            {portfolios.length > 1 && (
              <select
                value={portfolioFilter}
                onChange={(e) => setPortfolioFilter(e.target.value)}
                title="Filter by portfolio"
                className="px-3 py-2 text-xs font-bold text-slate-700 bg-white border border-slate-200 rounded-xl outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
              >
                <option value="">All portfolios</option>
                {portfolios.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            )}
            {filtering && (
              <button
                onClick={clearFilters}
                className="inline-flex items-center gap-1 px-2.5 py-2 text-[11px] font-bold text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg cursor-pointer"
              >
                <X className="w-3.5 h-3.5" /> Clear
              </button>
            )}
          </div>
        )}

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
        ) : allRows.length === 0 ? (
          <p className="text-center text-sm text-slate-500 italic py-16">No imports logged yet. They'll appear here after you import a contract note.</p>
        ) : visible.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-slate-500 italic">No import matches that search.</p>
            <button onClick={clearFilters} className="mt-2 text-xs font-bold text-indigo-600 hover:underline cursor-pointer">Clear filters</button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[#f8fafc] border-b border-slate-200 text-[11px] text-slate-600 uppercase tracking-wider">
                <tr>
                  <TH>Date-Time</TH>
                  <TH>Contract Note Name</TH>
                  <TH>Broker</TH>
                  <TH>User</TH>
                  <TH>Portfolio</TH>
                  <TH right>Action</TH>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((r) => {
                  const busy = reversing === r.sheetRow;
                  return (
                    <tr key={r.sheetRow} className={`transition-colors ${r.reversed ? 'opacity-55' : 'hover:bg-slate-50'}`}>
                      {/* Date-Time — one column, date then clock */}
                      <td className="px-5 py-2.5 whitespace-nowrap">
                        <span className="font-medium text-slate-700">{r.date || '—'}</span>
                        {r.time && <span className="text-slate-400 ml-1.5 text-[12px]">{r.time}</span>}
                      </td>

                      {/* Contract note + how many rows it wrote (the Rewind's blast radius) */}
                      <td className="px-5 py-2.5">
                        <span className={`font-medium text-slate-800 break-all ${r.reversed ? 'line-through' : ''}`}>{r.note || '—'}</span>
                        {r.rows && (
                          <span className="ml-2 align-middle inline-block px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500 text-[10px] font-bold whitespace-nowrap">
                            {r.rows} row{r.rows === '1' ? '' : 's'}
                          </span>
                        )}
                      </td>

                      <td className="px-5 py-2.5 whitespace-nowrap">
                        {r.broker ? (
                          <span className="inline-block px-2 py-0.5 rounded-md border border-slate-200 bg-slate-50 text-slate-700 text-[10px] font-black uppercase tracking-wider">
                            {r.broker}
                          </span>
                        ) : <span className="text-slate-300">—</span>}
                      </td>

                      <td className="px-5 py-2.5 text-slate-700">{r.user || '—'}</td>

                      <td className="px-5 py-2.5 whitespace-nowrap text-slate-700">
                        {r.portfolio || '—'}
                        {r.portfolioCode && r.portfolio !== r.portfolioCode && (
                          <span className="ml-1.5 text-[10px] font-bold text-slate-400 font-mono">{r.portfolioCode}</span>
                        )}
                      </td>

                      <td className="px-5 py-2.5 text-right whitespace-nowrap">
                        {r.reversed ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 text-[11px] font-bold uppercase tracking-wide">
                            <Undo2 className="w-3 h-3" /> Reversed
                          </span>
                        ) : r.canRewind ? (
                          <button
                            onClick={() => handleRewind(r)}
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
