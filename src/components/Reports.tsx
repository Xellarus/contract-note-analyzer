import { useState } from 'react';
import { FileBarChart2, ArrowLeft, ArrowRight, Loader2, AlertCircle, Download, Briefcase, CalendarDays, TrendingUp, Receipt } from 'lucide-react';
import { gapi } from 'gapi-script';
import { computeHoldingsAsOf, HistoricalHolding } from '../lib/holdingsCalc';
import { PORTFOLIOS, Portfolio } from '../lib/portfolios';
import { useVirtualRows } from './ui/useVirtualRows';

type Step = 'home' | 'portfolio' | 'config' | 'result';
type ReportType = 'holding' | 'capgains' | 'transactions';

const REPORTS: { type: ReportType; title: string; desc: string; Icon: typeof FileBarChart2; needsDate: boolean }[] = [
  { type: 'holding', title: 'Historical Holding Report', desc: 'Holdings of a portfolio as they stood on any past date — quantity, average cost and invested value.', Icon: FileBarChart2, needsDate: true },
  { type: 'capgains', title: 'Capital Gains Report', desc: 'Realised intraday / short-term / long-term gains per sale (FY25-26 onwards), from the LTST ledger.', Icon: TrendingUp, needsDate: false },
  { type: 'transactions', title: 'Transaction Report', desc: 'Every Buy / Sell recorded in True Entry — the full trade ledger for the portfolio.', Icon: Receipt, needsDate: false },
];

const todayStr = () => new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const csvEsc = (v: any) => { const s = (v ?? '').toString(); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const looksNumeric = (s: string) => /^-?[\d,]+(\.\d+)?$/.test(s.trim()) && s.trim().length > 0;

// Parse a sheet date cell (DD/MM/YYYY, DD-MM-YYYY, DD-MMM-YYYY, YYYY-MM-DD) → epoch ms, or null.
const parseCellDate = (s: string): number | null => {
  if (!s) return null;
  const c = s.trim();
  let m = c.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
  m = c.match(/^(\d{1,2})[\/\-]([A-Za-z]+)[\/\-](\d{4})$/);
  if (m) { const mo = new Date(Date.parse(`${m[2]} 1, 2000`)).getMonth(); return new Date(+m[3], mo, +m[1]).getTime(); }
  m = c.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  const t = Date.parse(c); return isNaN(t) ? null : t;
};

export default function Reports() {
  const [step, setStep] = useState<Step>('home');
  const [reportType, setReportType] = useState<ReportType>('holding');
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [asOf, setAsOf] = useState<string>(todayStr());
  const [fromDate, setFromDate] = useState<string>('');     // capital gains / transactions period
  const [toDate, setToDate] = useState<string>(todayStr());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Holding result
  const [positions, setPositions] = useState<HistoricalHolding[]>([]);
  const [totalInvested, setTotalInvested] = useState(0);
  const [tradeRows, setTradeRows] = useState(0);
  // Generic result (capital gains / transactions)
  const [genHeader, setGenHeader] = useState<string[]>([]);
  const [genRows, setGenRows] = useState<string[][]>([]);

  // Virtualize the generic report table once it gets large (thousands of rows).
  const REPORT_VIRTUALIZE_THRESHOLD = 200;
  const genVirtual = genRows.length > REPORT_VIRTUALIZE_THRESHOLD;
  const genVR = useVirtualRows(genVirtual ? genRows.length : 0, { estimatedRowHeight: 33, overscan: 16 });

  const meta = REPORTS.find(r => r.type === reportType)!;

  const readTab = async (sheetId: string, range: string): Promise<any[][]> => {
    const res = await (gapi.client as any).sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
    return (res?.result?.values || []) as any[][];
  };

  const generate = async () => {
    if (!portfolio) return;
    if (reportType === 'holding' && !asOf) return;
    setLoading(true);
    setError(null);
    setPositions([]); setGenHeader([]); setGenRows([]);
    try {
      if (reportType === 'holding') {
        const asOfTs = new Date(`${asOf}T23:59:59`).getTime();
        const res = await computeHoldingsAsOf(portfolio.sheetId, asOfTs);
        setPositions(res.positions);
        setTotalInvested(res.totalInvested);
        setTradeRows(res.tradeRows);
      } else {
        const range = reportType === 'capgains' ? 'LTST!A:Z' : 'True Entry!A:T';
        const vals = await readTab(portfolio.sheetId, range);
        if (vals.length < 1) {
          throw new Error(reportType === 'capgains'
            ? "No capital-gains data found. Import trades (capital gains sync automatically) or run Sync Capital Gains."
            : "No transactions found in True Entry — import a contract note or transaction report first.");
        }
        const header = (vals[0] || []).map((c: any) => (c ?? '').toString());
        let body = vals.slice(1)
          .filter(r => (r || []).some((c: any) => (c ?? '').toString().trim() !== ''))
          .map(r => header.map((_, i) => ((r as any[])?.[i] ?? '').toString()));

        // Filter to the requested period using the report's date column
        // (Sale Date for capital gains, Trade Date for transactions).
        const dateCol = header.findIndex(h => /date/i.test(h));
        const fromTs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : -Infinity;
        const toTs = toDate ? new Date(`${toDate}T23:59:59`).getTime() : Infinity;
        if (dateCol >= 0 && (fromDate || toDate)) {
          body = body.filter(r => {
            const ts = parseCellDate(r[dateCol]);
            return ts === null ? true : (ts >= fromTs && ts <= toTs);  // keep undated rows
          });
        }
        setGenHeader(header);
        setGenRows(body);
      }
      setStep('result');
    } catch (e: any) {
      setError(e?.result?.error?.message || e?.message || 'Could not generate the report.');
    } finally {
      setLoading(false);
    }
  };

  const downloadCsv = () => {
    if (!portfolio) return;
    let rows: any[][];
    let filename: string;
    if (reportType === 'holding') {
      rows = [["Company Name", "ISIN", "Quantity", "Avg Buy Price", "Invested Value"]];
      positions.forEach(p => rows.push([p.securityName, p.isin, String(p.quantity), String(p.avgBuyPrice), String(p.invested)]));
      rows.push(["Total", "", "", "", String(totalInvested)]);
      filename = `Holding_${portfolio.code}_as_of_${asOf}.csv`;
    } else {
      rows = [genHeader, ...genRows];
      const range = (fromDate || toDate) ? `_${fromDate || 'start'}_to_${toDate || 'today'}` : '';
      filename = `${reportType === 'capgains' ? 'CapitalGains' : 'Transactions'}_${portfolio.code}${range}.csv`;
    }
    const csv = rows.map(r => r.map(csvEsc).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const reset = () => { setStep('home'); setPortfolio(null); setError(null); setPositions([]); setGenHeader([]); setGenRows([]); };
  const openReport = (t: ReportType) => { setReportType(t); setPortfolio(null); setError(null); setStep('portfolio'); };

  const hasResult = reportType === 'holding' ? positions.length > 0 : genRows.length > 0;

  return (
    <div className="max-w-5xl mx-auto animate-fadeIn">
      {/* ── Home: report catalogue ── */}
      {step === 'home' && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-black text-slate-800 tracking-tight">Reports</h2>
            <p className="text-xs text-slate-500 mt-0.5">Generate and download reports from your portfolio ledgers.</p>
          </div>
          <div className="space-y-3">
            {REPORTS.map(({ type, title, desc, Icon }) => (
              <button
                key={type}
                onClick={() => openReport(type)}
                className="w-full sm:w-[480px] text-left p-5 rounded-2xl bg-white border border-slate-200 shadow-sm hover:border-indigo-400 hover:shadow-md transition-all cursor-pointer flex items-center gap-4 group"
              >
                <div className="p-3 rounded-xl bg-indigo-50 text-indigo-700 shrink-0">
                  <Icon className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-black text-slate-800">{title}</h3>
                  <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{desc}</p>
                </div>
                <ArrowRight className="w-5 h-5 text-slate-300 group-hover:text-indigo-600 group-hover:translate-x-0.5 transition-all shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Step 1: choose portfolio ── */}
      {step === 'portfolio' && (
        <div className="space-y-5">
          <button onClick={reset} className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-indigo-600 cursor-pointer transition-colors">
            <ArrowLeft className="w-4 h-4" /> Reports
          </button>
          <div>
            <h2 className="text-base font-black text-slate-800 tracking-tight">{meta.title}</h2>
            <p className="text-xs text-slate-500 mt-0.5">Select the portfolio to report on.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {PORTFOLIOS.map(p => (
              <button
                key={p.id}
                onClick={() => { setPortfolio(p); setError(null); setStep('config'); }}
                className="text-left p-5 rounded-2xl bg-white border border-slate-200 shadow-sm hover:border-indigo-400 hover:shadow-md transition-all cursor-pointer flex items-center justify-between gap-3 group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-150 text-indigo-600 shrink-0"><Briefcase className="w-5 h-5" /></div>
                  <div className="min-w-0">
                    <span className="px-2 py-0.5 bg-indigo-50 border border-indigo-100 text-indigo-700 text-[9px] font-black uppercase tracking-wider rounded-md">Portfolio {p.code}</span>
                    <h3 className="text-sm font-black text-slate-800 mt-1.5 truncate">{p.label}</h3>
                  </div>
                </div>
                <ArrowRight className="w-5 h-5 text-slate-300 group-hover:text-indigo-600 transition-colors shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Step 2: configure & generate ── */}
      {step === 'config' && portfolio && (
        <div className="space-y-5">
          <button onClick={() => setStep('portfolio')} className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-indigo-600 cursor-pointer transition-colors">
            <ArrowLeft className="w-4 h-4" /> Choose portfolio
          </button>
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 max-w-md">
            <h2 className="text-base font-black text-slate-800 tracking-tight">{meta.title}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              <strong className="text-slate-700">{portfolio.label}</strong> · Portfolio {portfolio.code}
            </p>

            {reportType === 'holding' ? (
              <>
                <label className="block mt-5 text-[11px] font-black uppercase tracking-wider text-slate-500">Holdings as of</label>
                <div className="flex items-center gap-2 mt-1.5">
                  <CalendarDays className="w-4 h-4 text-slate-400" />
                  <input
                    type="date"
                    value={asOf}
                    max={todayStr()}
                    onChange={(e) => setAsOf(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:outline-none focus:border-indigo-400 bg-white"
                  />
                </div>
                <p className="text-[11px] text-slate-400 mt-1.5">Positions are reconstructed by replaying every Buy/Sell on or before this date.</p>
              </>
            ) : (
              <>
                <label className="block mt-5 text-[11px] font-black uppercase tracking-wider text-slate-500">Period</label>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-bold text-slate-500 w-9">From</span>
                    <CalendarDays className="w-4 h-4 text-slate-400" />
                    <input
                      type="date"
                      value={fromDate}
                      max={toDate || todayStr()}
                      onChange={(e) => setFromDate(e.target.value)}
                      className="px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:outline-none focus:border-indigo-400 bg-white"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-bold text-slate-500 w-9">To</span>
                    <CalendarDays className="w-4 h-4 text-slate-400" />
                    <input
                      type="date"
                      value={toDate}
                      min={fromDate || undefined}
                      max={todayStr()}
                      onChange={(e) => setToDate(e.target.value)}
                      className="px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:outline-none focus:border-indigo-400 bg-white"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">{meta.desc} Leave <strong className="text-slate-500">From</strong> blank for all history.</p>
              </>
            )}

            {error && (
              <div className="flex items-start gap-2 mt-4 p-3 rounded-xl border border-rose-200 bg-rose-50 text-[12px] text-rose-700">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{error}</span>
              </div>
            )}
            <button
              onClick={generate}
              disabled={loading || (reportType === 'holding' && !asOf)}
              className="mt-5 w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-xl transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <meta.Icon className="w-4 h-4" />}
              {loading ? 'Generating…' : 'Generate Report'}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: result ── */}
      {step === 'result' && portfolio && (
        <div className="space-y-4">
          <button onClick={() => setStep('config')} className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-indigo-600 cursor-pointer transition-colors">
            <ArrowLeft className="w-4 h-4" /> Change options / portfolio
          </button>
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4 border-b border-slate-150 bg-slate-50">
              <div>
                <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">{meta.title} — {portfolio.label}</h3>
                <p className="text-[11px] text-slate-500 font-medium mt-0.5">
                  Portfolio {portfolio.code}
                  {reportType === 'holding'
                    ? ` · as of ${asOf} · ${positions.length} position${positions.length === 1 ? '' : 's'} · ${tradeRows} trades replayed`
                    : ` · ${fromDate || 'start'} → ${toDate || 'today'} · ${genRows.length} row${genRows.length === 1 ? '' : 's'}`}
                </p>
              </div>
              {hasResult && (
                <button onClick={downloadCsv} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer shrink-0">
                  <Download className="w-3.5 h-3.5" /> Download CSV
                </button>
              )}
            </div>

            {/* Holding report — structured table */}
            {reportType === 'holding' && (
              positions.length === 0 ? (
                <p className="text-center text-sm text-slate-500 italic py-16">No open positions as of {asOf}.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm border-collapse">
                    <thead className="bg-[#f8fafc] border-b border-slate-200 text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                      <tr>
                        <th className="px-5 py-3">Company</th>
                        <th className="px-5 py-3">ISIN</th>
                        <th className="px-5 py-3 text-right">Quantity</th>
                        <th className="px-5 py-3 text-right">Avg Buy Price</th>
                        <th className="px-5 py-3 text-right">Invested Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {positions.map((p, i) => (
                        <tr key={i} className="hover:bg-slate-50 transition-colors">
                          <td className="px-5 py-2.5 font-medium text-slate-800">{p.securityName}</td>
                          <td className="px-5 py-2.5 font-mono text-[12px] text-slate-500">{p.isin}</td>
                          <td className="px-5 py-2.5 text-right text-slate-700 font-mono">{p.quantity.toLocaleString('en-IN')}</td>
                          <td className="px-5 py-2.5 text-right text-slate-700 font-mono">{inr(p.avgBuyPrice)}</td>
                          <td className="px-5 py-2.5 text-right text-slate-800 font-mono font-semibold">{inr(p.invested)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t border-slate-200 bg-slate-50">
                      <tr>
                        <td className="px-5 py-3 font-black text-slate-800 uppercase text-xs" colSpan={4}>Total Invested</td>
                        <td className="px-5 py-3 text-right font-black text-slate-900 font-mono">{inr(totalInvested)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )
            )}

            {/* Capital gains / transactions — generic table straight from the sheet */}
            {reportType !== 'holding' && (
              genRows.length === 0 ? (
                <p className="text-center text-sm text-slate-500 italic py-16">No rows to show.</p>
              ) : (
                <div ref={genVR.scrollRef} onScroll={genVirtual ? genVR.onScroll : undefined} className="overflow-auto max-h-[65vh]">
                  <table className="w-full text-left text-[13px] whitespace-nowrap">
                    <thead className="bg-[#f8fafc] border-b border-slate-200 text-[10px] font-bold text-slate-600 uppercase tracking-wider sticky top-0 z-10">
                      <tr>
                        {genHeader.map((h, i) => (
                          <th key={i} className="px-4 py-3">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {genVirtual && genVR.padTop > 0 && (
                        <tr aria-hidden="true"><td colSpan={genHeader.length || 1} style={{ height: genVR.padTop, padding: 0, border: 0 }} /></tr>
                      )}
                      {(genVirtual ? genRows.slice(genVR.start, genVR.end) : genRows).map((r, li) => {
                        const ri = genVirtual ? genVR.start + li : li;
                        return (
                          <tr key={ri} ref={genVirtual && li === 0 ? genVR.measureRow : undefined} className="hover:bg-slate-50 transition-colors">
                            {genHeader.map((_, ci) => {
                              const v = r[ci] ?? '';
                              return (
                                <td key={ci} className={`px-4 py-2 ${looksNumeric(v) ? 'text-right font-mono text-slate-700' : 'text-slate-700'}`}>{v}</td>
                              );
                            })}
                          </tr>
                        );
                      })}
                      {genVirtual && genVR.padBottom > 0 && (
                        <tr aria-hidden="true"><td colSpan={genHeader.length || 1} style={{ height: genVR.padBottom, padding: 0, border: 0 }} /></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
