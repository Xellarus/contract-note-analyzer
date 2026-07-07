import { useEffect, useState } from 'react';
import { Wallet, RefreshCw, Loader2, AlertCircle, TrendingUp, TrendingDown, ArrowRight } from 'lucide-react';
import { PortfolioHolding } from '../types';
import { computeAum, AumResult } from '../lib/holdingsCalc';
import { hasValidGoogleToken } from '../lib/googleAuth';
import { PORTFOLIOS } from '../lib/portfolios';

interface DashboardProps {
  holdings: PortfolioHolding[];
  cashBalance: number;
  setCashBalance: (val: number | ((prev: number) => number)) => void;
  onNavigate: (view: 'dashboard' | 'holdings' | 'imports') => void;
  onOpenPortfolio: (id: string) => void;
}

const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cr = (n: number) => (n / 1e7).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Cr';

export default function Dashboard({ onOpenPortfolio }: DashboardProps) {
  const [aum, setAum] = useState<AumResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!hasValidGoogleToken()) {
      setError('Connect Google Sheets from the Holdings tab to load live AUM.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await computeAum(PORTFOLIOS.map(p => ({ id: p.id, label: p.label, sheetId: p.sheetId })));
      setAum(res);
    } catch (e: any) {
      setError(e?.result?.error?.message || e?.message || 'Could not compute AUM.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Token may still be restoring right after a page reload — retry briefly.
    if (!hasValidGoogleToken()) {
      let tries = 0;
      const id = window.setInterval(() => {
        tries++;
        if (hasValidGoogleToken()) { window.clearInterval(id); load(); }
        else if (tries >= 15) window.clearInterval(id);
      }, 1000);
      return () => window.clearInterval(id);
    }
  }, []);

  const gain = aum ? aum.totalCurrent - aum.totalInvested : 0;
  const gainPct = aum && aum.totalInvested > 0 ? (gain / aum.totalInvested) * 100 : 0;
  const up = gain >= 0;

  return (
    <div className="max-w-5xl mx-auto animate-fadeIn space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black text-slate-800 tracking-tight">Dashboard</h2>
          <p className="text-xs text-slate-500 mt-0.5">Live assets under management across all portfolios.</p>
        </div>
        <button
          onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* AUM hero */}
      <div className="rounded-3xl border border-indigo-700 bg-gradient-to-br from-indigo-600 to-indigo-800 text-white shadow-lg p-7 sm:p-9">
        <div className="flex items-center gap-2 text-indigo-100">
          <Wallet className="w-5 h-5" />
          <span className="text-[11px] font-black uppercase tracking-[0.15em]">Current AUM</span>
        </div>
        {loading && !aum ? (
          <div className="flex items-center gap-2 mt-4 text-indigo-100"><Loader2 className="w-5 h-5 animate-spin" /> <span className="text-sm font-bold">Computing…</span></div>
        ) : aum ? (
          <>
            <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-1">
              <span className="text-4xl sm:text-5xl font-black tracking-tight font-mono tabular-nums">{inr(aum.totalCurrent)}</span>
              <span className="text-sm font-bold text-indigo-200 pb-1">≈ {cr(aum.totalCurrent)}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
              <span className="text-indigo-100">Invested <strong className="font-mono">{inr(aum.totalInvested)}</strong></span>
              <span className={`inline-flex items-center gap-1 font-bold ${up ? 'text-emerald-300' : 'text-rose-300'}`}>
                {up ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                {up ? '+' : ''}{inr(gain)} ({up ? '+' : ''}{gainPct.toFixed(2)}%)
              </span>
            </div>
            {!aum.fullyPriced && (
              <p className="mt-3 text-[11px] text-indigo-200/90">Some holdings are valued at cost — import current prices (Imports → Securities &amp; Prices) for full live valuation.</p>
            )}
          </>
        ) : (
          <p className="mt-3 text-sm text-indigo-100">—</p>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[12px] text-amber-800">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}

      {/* Per-portfolio breakdown */}
      {aum && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {aum.perPortfolio.map((p) => {
            const pg = p.currentValue - p.investedValue;
            const pgPct = p.investedValue > 0 ? (pg / p.investedValue) * 100 : 0;
            const pUp = pg >= 0;
            const meta = PORTFOLIOS.find(x => x.id === p.id);
            return (
              <button
                key={p.id}
                onClick={() => onOpenPortfolio(p.id)}
                className="text-left rounded-2xl border border-slate-200 bg-white shadow-sm hover:border-indigo-300 hover:shadow-md transition-all cursor-pointer p-5 group"
              >
                <div className="flex items-center justify-between">
                  <span className="px-2 py-0.5 bg-indigo-50 border border-indigo-100 text-indigo-700 text-[9px] font-black uppercase tracking-wider rounded-md">Portfolio {meta?.code}</span>
                  <ArrowRight className="w-4 h-4 text-slate-300 group-hover:text-indigo-600 transition-colors" />
                </div>
                <h3 className="text-sm font-black text-slate-800 mt-2">{p.label}</h3>
                <p className="text-2xl font-black text-slate-900 font-mono mt-2 tabular-nums">{inr(p.currentValue)}</p>
                <div className="mt-1.5 flex items-center gap-3 text-[12px]">
                  <span className="text-slate-500">Inv <span className="font-mono">{inr(p.investedValue)}</span></span>
                  <span className={`font-bold ${pUp ? 'text-emerald-700' : 'text-rose-600'}`}>{pUp ? '+' : ''}{pgPct.toFixed(2)}%</span>
                </div>
                <p className="text-[10px] text-slate-400 mt-1.5">{p.positions} position{p.positions === 1 ? '' : 's'} · {p.priced}/{p.positions} priced</p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
