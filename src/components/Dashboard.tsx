import { useEffect, useRef, useState } from 'react';
import { Wallet, RefreshCw, Loader2, AlertCircle, TrendingUp, TrendingDown, ArrowRight, LineChart } from 'lucide-react';
import { PortfolioHolding } from '../types';
import { computeAum, AumResult } from '../lib/holdingsCalc';
import { computeInvestedTimeline, AumTimelinePoint } from '../lib/aumTimeline';
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

// Palette for the sector-allocation donut. "Unclassified" always renders grey.
// Earthy 10-hue categorical set tuned to the theme (brass dark / parchment light):
// validated with the dataviz palette checker against BOTH surfaces (#1a1815,
// #fbf6eb) — lightness band, chroma floor, CVD + normal-vision separation,
// contrast. Order is deliberate (lightness-staggered neighbors); don't shuffle.
// Compact ₹ for chart axes/labels ("₹1.86 Cr", "₹42.3 L").
const compactInr = (n: number): string =>
  n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr`
  : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)} L`
  : `₹${Math.round(n).toLocaleString('en-IN')}`;

/**
 * AUM timeline — invested capital (cost of open positions) through time, with
 * today's live market AUM as a distinct annotated marker. A market-value
 * HISTORY isn't computable (prices are a snapshot, not a feed), so the line is
 * honest cost basis; the marker is the only market number.
 */
function AumTimelineChart({ points, aumToday }: { points: AumTimelinePoint[]; aumToday: number | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const W = 720, H = 250, ML = 14, MR = 76, MT = 16, MB = 30;
  const iw = W - ML - MR, ih = H - MT - MB;
  const t0 = points[0].ts, t1 = points[points.length - 1].ts;
  const span = Math.max(t1 - t0, 1);
  const yMax = Math.max(...points.map(p => p.invested), aumToday ?? 0, 1) * 1.1;
  const x = (ts: number) => ML + ((ts - t0) / span) * iw;
  const y = (v: number) => MT + ih - (v / yMax) * ih;

  // Theme-tuned marks (Dashboard re-renders on theme toggle, so reading the
  // class at render is safe). Gold needs a deeper step on the cream surface.
  const dark = document.documentElement.classList.contains('dark');
  const lineCol = dark ? '#d9a441' : '#8a6a1e';
  const upCol = dark ? '#4fc584' : '#0d8a4f';

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.invested).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${x(t1).toFixed(1)},${(MT + ih).toFixed(1)} L${x(t0).toFixed(1)},${(MT + ih).toFixed(1)} Z`;

  // ~4 y gridlines, ~5 x time ticks.
  const yTicks = [0.25, 0.5, 0.75, 1].map(f => f * yMax);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map(f => t0 + f * span);
  const fmtTick = (ts: number) => new Date(ts).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });

  const onMove = (e: { clientX: number }) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ts = t0 + ((e.clientX - rect.left) / rect.width * W - ML) / iw * span;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].ts - ts);
      if (d < bestD) { bestD = d; best = i; }
    }
    setHover(best);
  };

  const hp = hover !== null ? points[hover] : null;
  const last = points[points.length - 1];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-6">
      <div className="flex items-center gap-2 mb-1">
        <LineChart className="w-4 h-4 text-indigo-600" />
        <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">AUM Timeline</h3>
      </div>
      <p className="text-[11px] text-slate-500 mb-1">
        Capital invested (cost of open positions) from inception to today, across all portfolios.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-[11px] font-semibold text-slate-500">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: lineCol }} /> Invested capital (cost)</span>
        {aumToday !== null && aumToday > 0 && (
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: upCol }} /> AUM today (market)</span>
        )}
      </div>
      <div ref={wrapRef} className="relative text-slate-500" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label="Invested capital over time">
          {/* grid + y labels (right-aligned into the right margin) */}
          {yTicks.map((v, i) => (
            <g key={i}>
              <line x1={ML} x2={ML + iw} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity="0.14" strokeWidth="1" />
              <text x={W - 4} y={y(v) + 3} textAnchor="end" fontSize="10" fill="currentColor" fillOpacity="0.75">{compactInr(v)}</text>
            </g>
          ))}
          <line x1={ML} x2={ML + iw} y1={MT + ih} y2={MT + ih} stroke="currentColor" strokeOpacity="0.3" strokeWidth="1" />
          {xTicks.map((ts, i) => (
            <text key={i} x={x(ts)} y={H - 8} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'} fontSize="10" fill="currentColor" fillOpacity="0.75">{fmtTick(ts)}</text>
          ))}
          {/* area + line */}
          <path d={areaPath} fill={lineCol} fillOpacity="0.09" />
          <path d={linePath} fill="none" stroke={lineCol} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {/* endpoint (latest invested) */}
          <circle cx={x(last.ts)} cy={y(last.invested)} r="3.5" fill={lineCol} />
          {/* today's market AUM marker */}
          {aumToday !== null && aumToday > 0 && (
            <g>
              <line x1={x(t1)} x2={x(t1)} y1={y(last.invested)} y2={y(aumToday)} stroke={upCol} strokeOpacity="0.5" strokeWidth="1" strokeDasharray="3 3" />
              <circle cx={x(t1)} cy={y(aumToday)} r="4.5" fill={upCol} stroke={dark ? '#1a1815' : '#fbf6eb'} strokeWidth="2" />
              <text x={x(t1) - 8} y={y(aumToday) - 8} textAnchor="end" fontSize="11" fontWeight="700" fill={upCol}>{compactInr(aumToday)}</text>
            </g>
          )}
          {/* hover crosshair */}
          {hp && (
            <g>
              <line x1={x(hp.ts)} x2={x(hp.ts)} y1={MT} y2={MT + ih} stroke="currentColor" strokeOpacity="0.25" strokeWidth="1" />
              <circle cx={x(hp.ts)} cy={y(hp.invested)} r="4" fill={lineCol} stroke={dark ? '#1a1815' : '#fbf6eb'} strokeWidth="2" />
            </g>
          )}
        </svg>
        {hp && (
          <div
            className="absolute pointer-events-none px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white shadow-md text-[11px] leading-tight whitespace-nowrap"
            style={{
              left: `${(x(hp.ts) / W) * 100}%`,
              top: `${(y(hp.invested) / H) * 100}%`,
              transform: `translate(${x(hp.ts) > W * 0.7 ? '-108%' : '10px'}, -120%)`,
            }}
          >
            <div className="font-bold text-slate-800">{compactInr(hp.invested)}</div>
            <div className="text-slate-500">{new Date(hp.ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Dashboard({ onOpenPortfolio }: DashboardProps) {
  const [aum, setAum] = useState<AumResult | null>(null);
  const [timeline, setTimeline] = useState<AumTimelinePoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!hasValidGoogleToken()) {
      setError('Connect Google Sheets from the Holdings tab to load live AUM.');
      return;
    }
    setLoading(true);
    setError(null);
    const list = PORTFOLIOS.map(p => ({ id: p.id, label: p.label, sheetId: p.sheetId }));
    try {
      // Run AUM + the invested-capital timeline together; a failure in one doesn't block the other.
      const [aumRes, tlRes] = await Promise.allSettled([computeAum(list), computeInvestedTimeline(list)]);
      if (aumRes.status === 'fulfilled') setAum(aumRes.value);
      else setError(aumRes.reason?.result?.error?.message || aumRes.reason?.message || 'Could not compute AUM.');
      if (tlRes.status === 'fulfilled') setTimeline(tlRes.value);
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
      {/* Light (Mono): warm-white card, ink border/text. Dark (Brass): warm graphite panel, gold label. */}
      <div className="rounded-3xl border border-[#16130d] bg-gradient-to-br from-[#fbf6eb] to-[#f8f2e3] text-[#16130d] shadow-lg p-7 sm:p-9 dark:border-[#332d24] dark:from-[#1a1815] dark:to-[#1a1815] dark:text-[#eae5da]">
        <div className="flex items-center gap-2 text-[#756b57] dark:text-[#d9a441]">
          <Wallet className="w-5 h-5" />
          <span className="text-[11px] font-black uppercase tracking-[0.15em]">Current AUM</span>
        </div>
        {loading && !aum ? (
          <div className="flex items-center gap-2 mt-4 text-[#756b57] dark:text-[#938b7c]"><Loader2 className="w-5 h-5 animate-spin" /> <span className="text-sm font-bold">Computing…</span></div>
        ) : aum ? (
          <>
            <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-1">
              <span className="text-4xl sm:text-5xl font-black tracking-tight font-mono tabular-nums">{inr(aum.totalCurrent)}</span>
              <span className="text-sm font-bold text-[#756b57] dark:text-[#938b7c] pb-1">≈ {cr(aum.totalCurrent)}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
              <span className="text-[#756b57] dark:text-[#938b7c]">Invested <strong className="font-mono text-[#16130d] dark:text-[#eae5da]">{inr(aum.totalInvested)}</strong></span>
              <span className={`inline-flex items-center gap-1 font-bold ${up ? 'text-[#0d8a4f] dark:text-[#4fc584]' : 'text-[#d33a2c] dark:text-[#f2705f]'}`}>
                {up ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                {up ? '+' : ''}{inr(gain)} ({up ? '+' : ''}{gainPct.toFixed(2)}%)
              </span>
            </div>
            {!aum.fullyPriced && (
              <p className="mt-3 text-[11px] text-[#756b57] dark:text-[#938b7c]">Some holdings are valued at cost — import current prices (Imports → Securities &amp; Prices) for full live valuation.</p>
            )}
          </>
        ) : (
          <p className="mt-3 text-sm text-[#756b57] dark:text-[#938b7c]">—</p>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[12px] text-amber-800">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}

      {/* AUM timeline — invested capital through time + today's market AUM */}
      {timeline && timeline.length >= 2 && (
        <AumTimelineChart points={timeline} aumToday={aum ? aum.totalCurrent : null} />
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
