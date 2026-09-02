import { useMemo, useState } from 'react';
import {
  Search, X, Download, ArrowUp, ArrowDown, ArrowUpDown, ChevronRight, ChevronDown,
  AlertTriangle, Layers,
} from 'lucide-react';
import { CrossHolding } from '../lib/crossHoldings';
import CubeLoader from './ui/CubeLoader';

/**
 * Every security held across every portfolio, one row each — the Dashboard's consolidated
 * position view (it replaced the per-portfolio shortcut cards).
 *
 * Expanding a row lists the portfolios holding it; clicking one jumps straight to that
 * stock's detail page in that account via `onOpenStock`.
 *
 * THEME: authored in light Tailwind utilities that index.css remaps for dark. Every colour
 * class here is one of the pairs covered in BOTH blocks. Specifically avoided: `odd:`/`even:`
 * zebra and arbitrary variants (the remaps are literal class-token selectors, so neither is
 * ever caught), `bg-slate-50` as a step against `bg-white` (identical in dark), `text-green-*`
 * (no rule anywhere), and `hover:text-slate-600` (resolves to a cool grey that vanishes on
 * the dark ground). See [[mono-light-theme]].
 */

interface Props {
  rows: CrossHolding[];
  loading: boolean;
  onOpenStock: (focus: { portfolioId: string; scripName: string; isin: string }) => void;
}

type SortKey = 'name' | 'qty' | 'avgCost' | 'invested' | 'cmp' | 'current' | 'pl' | 'plPct';

const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 4 });
const csvEsc = (v: any) => { const s = (v ?? '').toString(); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

const plOf = (h: CrossHolding) => h.current - h.invested;
const plPctOf = (h: CrossHolding) => (h.invested > 0 ? ((h.current - h.invested) / h.invested) * 100 : 0);

export default function AllHoldingsTable({ rows, loading, onOpenStock }: Props) {
  const [q, setQ] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');   // A-Z ascending by default
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (key: string) => setOpen(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const requestSort = (k: SortKey) => {
    if (k === sortKey) setDir(d => (d === 'asc' ? 'desc' : 'asc'));
    // Text starts A-Z; numbers start biggest-first, which is what you want from one click.
    else { setSortKey(k); setDir(k === 'name' ? 'asc' : 'desc'); }
  };

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    const filtered = term
      ? rows.filter(h =>
          h.name.toLowerCase().includes(term) ||
          h.isin.toLowerCase().includes(term) ||
          h.lots.some(l => l.code.toLowerCase().includes(term) || l.label.toLowerCase().includes(term)))
      : rows;
    const val = (h: CrossHolding): number | string => {
      switch (sortKey) {
        case 'qty': return h.qty;
        case 'avgCost': return h.avgCost;
        case 'invested': return h.invested;
        case 'cmp': return h.cmp ?? -Infinity;   // unpriced sinks to the bottom either way
        case 'current': return h.current;
        case 'pl': return plOf(h);
        case 'plPct': return plPctOf(h);
        default: return h.name.toLowerCase();
      }
    };
    const sorted = [...filtered].sort((a, b) => {
      const av = val(a), bv = val(b);
      const c = typeof av === 'string' || typeof bv === 'string'
        ? String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' })
        : (av as number) - (bv as number);
      return dir === 'asc' ? c : -c;
    });
    return sorted;
  }, [rows, q, sortKey, dir]);

  const totals = useMemo(() => visible.reduce(
    (a, h) => ({ invested: a.invested + h.invested, current: a.current + h.current }),
    { invested: 0, current: 0 },
  ), [visible]);

  // Two different states, deliberately counted apart. A LISTED security with no price is a gap
  // in the feed — something to chase. An UNLISTED one is never priced by design, so folding it
  // in here would inflate a number the reader is meant to act on.
  const unpricedShown = visible.filter(h => !h.priced && !h.pe).length;
  // At cost = no valuation AND never traded. A position valued at its last trade already has
  // a defensible price and must not be nagged about.
  const peAtCostShown = visible.filter(h => h.pe && !((h.peValuation ?? 0) > 0) && !((h.lastTradePrice ?? 0) > 0)).length;

  const downloadCsv = () => {
    // Exports exactly what's on screen — same filter, same sort — plus the per-portfolio
    // split flattened into one column so the breakdown survives the export.
    const head = ['Security', 'ISIN', 'Quantity', 'Avg Cost', 'Invested', 'CMP', 'Current Value', 'P/L', 'P/L %', 'Priced', 'Portfolios'];
    const body = visible.map(h => [
      h.name, h.isin, h.qty, h.avgCost.toFixed(6), h.invested.toFixed(2),
      h.cmp !== undefined ? h.cmp : '', h.current.toFixed(2),
      plOf(h).toFixed(2), plPctOf(h).toFixed(2),
      // An unlisted company's figure is a VALUATION, not a market price. This export leaves the
      // machine, so "yes" against one would be read as a traded price by whoever opens it.
      h.pe ? ((h.peValuation ?? 0) > 0 ? 'valuation' : (h.lastTradePrice ?? 0) > 0 ? 'last trade' : 'at cost') : (h.priced ? 'yes' : 'at cost'),
      h.lots.map(l => `${l.code}:${qtyFmt(l.qty)}`).join(' | '),
    ]);
    body.push(['Total', '', '', '', totals.invested.toFixed(2), '', totals.current.toFixed(2),
      (totals.current - totals.invested).toFixed(2), '', '', '']);
    const csv = [head, ...body].map(r => r.map(csvEsc).join(',')).join('\r\n');
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `All_Holdings_${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const th = (key: SortKey, label: string, align: 'left' | 'right' = 'right') => {
    const active = sortKey === key;
    return (
      <th
        onClick={() => requestSort(key)}
        className={`px-4 py-3 select-none cursor-pointer hover:bg-slate-100 ${align === 'right' ? 'text-right' : 'text-left'}`}
      >
        <div className={`flex items-center gap-1 ${align === 'right' ? 'justify-end' : 'justify-start'}`}>
          <span>{label}</span>
          {active
            ? (dir === 'asc' ? <ArrowUp className="w-3 h-3 text-indigo-600 shrink-0" /> : <ArrowDown className="w-3 h-3 text-indigo-600 shrink-0" />)
            : <ArrowUpDown className="w-3 h-3 text-slate-400 shrink-0" />}
        </div>
      </th>
    );
  };

  const money = (v: number) => (v >= 0 ? 'text-emerald-600' : 'text-rose-600');

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      {/* Header: title + search + download */}
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-indigo-600" />
          <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">All Holdings</h3>
          <span className="text-[11px] font-bold text-slate-500">
            {visible.length}{visible.length !== rows.length ? ` of ${rows.length}` : ''} securities
          </span>
        </div>

        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search security, ISIN or account…"
            aria-label="Search holdings"
            className="w-full pl-9 pr-8 py-1.5 border border-slate-200 rounded-lg outline-none text-xs bg-white text-slate-800 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 font-medium"
          />
          {q && (
            <button
              onClick={() => setQ('')} aria-label="Clear search" title="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-400 hover:text-slate-900 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <button
          onClick={downloadCsv}
          disabled={visible.length === 0}
          title="Download the rows shown, as CSV"
          className="btn-press flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-indigo-600 border border-indigo-200 hover:bg-indigo-50 rounded-lg cursor-pointer disabled:opacity-40"
        >
          <Download className="w-3.5 h-3.5" /> CSV
        </button>
      </div>

      {loading && rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-14">
          <CubeLoader className="w-12" />
          <span className="text-xs font-bold text-slate-500">Loading holdings…</span>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-center text-sm text-slate-500 italic py-14">
          No holdings found. Connect Google Sheets, or run Rebuild on a portfolio.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-center text-sm text-slate-500 italic py-14">Nothing matches “{q}”.</p>
      ) : (
        <div className="overflow-auto max-h-[70vh]">
          <table className="w-full text-left text-[13px] whitespace-nowrap">
            <thead className="bg-[#f8fafc] border-b border-slate-200 text-[10px] font-bold text-slate-600 uppercase tracking-wider sticky top-0 z-10">
              <tr>
                <th className="px-2 py-3 w-8" aria-label="Expand" />
                {th('name', 'Security', 'left')}
                {th('qty', 'Qty')}
                {th('avgCost', 'Avg Cost')}
                {th('invested', 'Invested')}
                {th('cmp', 'CMP')}
                {th('current', 'Current')}
                {th('pl', 'P/L')}
                {th('plPct', 'P/L %')}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.map((h) => {
                const expanded = open.has(h.key);
                const pl = plOf(h), plPct = plPctOf(h);
                return [
                  <tr
                    key={h.key}
                    onClick={() => toggle(h.key)}
                    title={h.lots.length === 1 ? `Held in ${h.lots[0].label}` : `Held across ${h.lots.length} portfolios`}
                    className="hover:bg-slate-50 transition-colors cursor-pointer"
                  >
                    <td className="px-2 py-2 text-slate-400">
                      {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </td>
                    <td className="px-4 py-2 font-semibold text-slate-800">
                      <span className="inline-flex items-center gap-1.5">
                        {h.name}
                        {h.discrepancy && (
                          <AlertTriangle className="w-3.5 h-3.5 text-rose-600 shrink-0"
                            aria-label="Negative quantity" />
                        )}
                        {/* Unlisted. Without this the CMP column reads as a market price. */}
                        {h.pe && (
                          <span
                            className="px-1.5 py-0.5 rounded-md bg-orange-50 border border-orange-200 text-orange-700 text-[9px] font-black shrink-0 select-none"
                            title={h.peValuation
                              ? `Unlisted — valued at ${inr(h.peValuation)}/share${h.peValuationDate ? ` as on ${h.peValuationDate}` : ''}`
                              : (h.lastTradePrice ?? 0) > 0
                                ? `Unlisted — no valuation entered, so valued at its last traded price ${inr(h.lastTradePrice!)}`
                                : 'Unlisted — no valuation entered and never traded, carried at cost'}
                          >
                            PE
                          </span>
                        )}
                        {h.lots.length > 1 && (
                          <span className="px-1.5 py-0.5 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-700 text-[9px] font-black">
                            {h.lots.length}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums ${h.discrepancy ? 'text-rose-600 font-bold' : 'text-slate-700'}`}>{qtyFmt(h.qty)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700">{inr(h.avgCost)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700">{inr(h.invested)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                      {h.cmp !== undefined
                        ? inr(h.cmp)
                        : <span className="text-slate-400" title="No imported price — valued at cost">at cost</span>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold text-slate-800">{inr(h.current)}</td>
                    <td className={`px-4 py-2 text-right tabular-nums font-semibold ${money(pl)}`}>{pl >= 0 ? '+' : ''}{inr(pl)}</td>
                    <td className={`px-4 py-2 text-right tabular-nums font-bold ${money(pl)}`}>{pl >= 0 ? '+' : ''}{plPct.toFixed(2)}%</td>
                  </tr>,

                  // ── Expansion: who holds it. Each line jumps to that account's detail page.
                  ...(expanded ? h.lots.map((l) => (
                    <tr
                      key={`${h.key}::${l.portfolioId}`}
                      onClick={() => onOpenStock({ portfolioId: l.portfolioId, scripName: h.name, isin: h.isin })}
                      title={`Open ${h.name} in ${l.label}`}
                      className="bg-[#f8fafc] hover:bg-slate-200 transition-colors cursor-pointer"
                    >
                      <td className="px-2 py-1.5" />
                      <td className="px-4 py-1.5 pl-8">
                        <span className="inline-flex items-center gap-2">
                          <span className="px-1.5 py-0.5 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-700 text-[9px] font-black uppercase tracking-wider">{l.code}</span>
                          <span className="text-slate-600 font-medium">{l.label}</span>
                          <ArrowUpRightGlyph />
                        </span>
                      </td>
                      <td className="px-4 py-1.5 text-right tabular-nums text-slate-600">{qtyFmt(l.qty)}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums text-slate-600">{inr(l.avgCost)}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums text-slate-600">{inr(l.invested)}</td>
                      <td className="px-4 py-1.5" />
                      <td className="px-4 py-1.5 text-right tabular-nums text-slate-700 font-medium">{inr(l.current)}</td>
                      <td className={`px-4 py-1.5 text-right tabular-nums ${money(l.current - l.invested)}`}>
                        {l.current - l.invested >= 0 ? '+' : ''}{inr(l.current - l.invested)}
                      </td>
                      <td className="px-4 py-1.5" />
                    </tr>
                  )) : []),
                ];
              })}
            </tbody>
            <tfoot className="border-t border-slate-200 bg-[#f8fafc] sticky bottom-0">
              <tr className="text-[12px]">
                <td />
                <td className="px-4 py-3 font-black text-slate-800 uppercase text-[10px] tracking-wider">
                  Total{visible.length !== rows.length ? ' (filtered)' : ''}
                </td>
                <td colSpan={2} />
                <td className="px-4 py-3 text-right tabular-nums font-black text-slate-800">{inr(totals.invested)}</td>
                <td />
                <td className="px-4 py-3 text-right tabular-nums font-black text-slate-800">{inr(totals.current)}</td>
                <td className={`px-4 py-3 text-right tabular-nums font-black ${money(totals.current - totals.invested)}`}>
                  {totals.current - totals.invested >= 0 ? '+' : ''}{inr(totals.current - totals.invested)}
                </td>
                <td className={`px-4 py-3 text-right tabular-nums font-black ${money(totals.current - totals.invested)}`}>
                  {totals.invested > 0
                    ? `${totals.current - totals.invested >= 0 ? '+' : ''}${(((totals.current - totals.invested) / totals.invested) * 100).toFixed(2)}%`
                    : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {(unpricedShown > 0 || peAtCostShown > 0) && (
        <p className="px-4 py-2.5 border-t border-slate-200 text-[11px] text-slate-500">
          {unpricedShown > 0 && (
            <>{unpricedShown} {unpricedShown === 1 ? 'security has' : 'securities have'} no imported price and {unpricedShown === 1 ? 'is' : 'are'} valued at cost.</>
          )}
          {unpricedShown > 0 && peAtCostShown > 0 ? ' ' : ''}
          {peAtCostShown > 0 && (
            <>{peAtCostShown} unlisted {peAtCostShown === 1 ? 'company is' : 'companies are'} carried at cost — enter a valuation in the Private Equities tab to mark {peAtCostShown === 1 ? 'it' : 'them'}.</>
          )}
        </p>
      )}
    </div>
  );
}

/** Small affordance on each portfolio line so it reads as "this navigates". */
function ArrowUpRightGlyph() {
  return (
    <svg viewBox="0 0 12 12" className="w-3 h-3 text-slate-400 shrink-0" fill="none" aria-hidden="true">
      <path d="M3.5 8.5 L8.5 3.5 M8.5 3.5 H4.75 M8.5 3.5 V7.25"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
