import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Wallet, RefreshCw, Loader2, AlertCircle, TrendingUp, TrendingDown, ArrowRight, LineChart, SlidersHorizontal } from 'lucide-react';
import { PortfolioHolding } from '../types';
import { computeAum, AumResult } from '../lib/holdingsCalc';
import { computeInvestedTimeline, AumTimelinePoint } from '../lib/aumTimeline';
import { logAumSnapshot, loadAumHistory, AumSnapshot } from '../lib/aumHistory';
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
 * AUM timeline — invested capital (cost of open positions) through time, plus
 * the market-value line accumulated from daily AUM History snapshots (starts
 * today; grows one point per day the dashboard is opened). Range presets +
 * a toggleable navigator strip (drag to pan, drag edges to resize).
 */
const DAY_MS = 86400000;
const MIN_WINDOW_MS = 7 * DAY_MS;
type SeriesPt = { ts: number; v: number };

// Clip a step-series to [from,to]: carry the last value before the window in
// at the left edge; optionally extend the last value flat to the right edge.
function clipSeries(arr: SeriesPt[], from: number, to: number, extendRight: boolean): SeriesPt[] {
  const out: SeriesPt[] = [];
  let carry: number | null = null;
  for (const p of arr) {
    if (p.ts < from) { carry = p.v; continue; }
    if (p.ts > to) break;
    if (out.length === 0 && carry !== null && p.ts > from) out.push({ ts: from, v: carry });
    out.push(p);
  }
  if (out.length === 0 && carry !== null) out.push({ ts: from, v: carry }, { ts: to, v: carry });
  else if (extendRight && out.length > 0 && out[out.length - 1].ts < to) out.push({ ts: to, v: out[out.length - 1].v });
  return out;
}

function AumTimelineChart({ points, market, aumToday }: { points: AumTimelinePoint[]; market: AumSnapshot[]; aumToday: number | null }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: 'pan' | 'left' | 'right'; from: number; to: number; startTs: number } | null>(null);
  const [win, setWin] = useState<{ from: number; to: number } | null>(null);   // null = ALL
  const [preset, setPreset] = useState<string>('ALL');
  const [showNav, setShowNav] = useState(false);
  const [hoverTs, setHoverTs] = useState<number | null>(null);

  const T0 = Math.min(points[0].ts, market.length ? market[0].ts : Infinity);
  const T1 = points[points.length - 1].ts;
  const from = Math.max(win?.from ?? T0, T0);
  const to = Math.max(Math.min(win?.to ?? T1, T1), from + 1);

  const invAll: SeriesPt[] = points.map(p => ({ ts: p.ts, v: p.invested }));
  const mktAll: SeriesPt[] = market.map(m => ({ ts: m.ts, v: m.current }));
  const inv = clipSeries(invAll, from, to, true);
  const mkt = clipSeries(mktAll, from, to, false);

  const W = 720, H = 250, ML = 14, MR = 76, MT = 16, MB = 30;
  const iw = W - ML - MR, ih = H - MT - MB;
  const span = Math.max(to - from, 1);
  const markerVisible = aumToday !== null && aumToday > 0 && to >= T1;
  const yMax = Math.max(...inv.map(p => p.v), ...mkt.map(p => p.v), markerVisible ? (aumToday as number) : 0, 1) * 1.1;
  const x = (ts: number) => ML + ((ts - from) / span) * iw;
  const y = (v: number) => MT + ih - (v / yMax) * ih;

  // Theme-tuned marks (Dashboard re-renders on theme toggle, so reading the
  // class at render is safe). Gold needs a deeper step on the cream surface.
  const dark = document.documentElement.classList.contains('dark');
  const lineCol = dark ? '#d9a441' : '#8a6a1e';
  const upCol = dark ? '#4fc584' : '#0d8a4f';
  const surface = dark ? '#1a1815' : '#fbf6eb';

  const pathOf = (s: SeriesPt[]) => s.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const linePath = pathOf(inv);
  const areaPath = inv.length ? `${linePath} L${x(inv[inv.length - 1].ts).toFixed(1)},${(MT + ih).toFixed(1)} L${x(inv[0].ts).toFixed(1)},${(MT + ih).toFixed(1)} Z` : '';
  const mktPath = mkt.length >= 2 ? pathOf(mkt) : '';

  const yTicks = [0.25, 0.5, 0.75, 1].map(f => f * yMax);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map(f => from + f * span);
  const shortWin = span < 150 * DAY_MS;
  const fmtTick = (ts: number) => new Date(ts).toLocaleDateString('en-IN', shortWin ? { day: '2-digit', month: 'short' } : { month: 'short', year: '2-digit' });
  const fmtRange = (ts: number) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  // ── Range presets ──
  const PRESETS: { key: string; label: string; title: string }[] = [
    { key: '1M', label: '1M', title: 'Last month' },
    { key: '3M', label: '3M', title: 'Last 3 months' },
    { key: '6M', label: '6M', title: 'Last 6 months' },
    { key: 'FY', label: 'FY', title: 'Since 1 April (current FY)' },
    { key: '1Y', label: '1Y', title: 'Last 12 months' },
    { key: 'ALL', label: 'ALL', title: 'Full history' },
  ];
  const applyPreset = (k: string) => {
    setPreset(k); setHoverTs(null);
    if (k === 'ALL') { setWin(null); return; }
    let f = T0;
    if (k === '1M') f = T1 - 30 * DAY_MS;
    else if (k === '3M') f = T1 - 91 * DAY_MS;
    else if (k === '6M') f = T1 - 182 * DAY_MS;
    else if (k === '1Y') f = T1 - 365 * DAY_MS;
    else if (k === 'FY') {
      const d = new Date(T1);
      const fy = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
      f = Date.UTC(fy, 3, 1);
    }
    setWin({ from: Math.max(f, T0), to: T1 });
  };

  // ── Navigator (brush): drag the window to pan, drag its edges to resize ──
  const navTsAt = (clientX: number): number => {
    const rect = navRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return T0;
    return T0 + Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * (T1 - T0);
  };
  const onNavDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    const rect = navRef.current?.getBoundingClientRect();
    const ts = navTsAt(e.clientX);
    const tol = rect && rect.width > 0 ? (12 / rect.width) * (T1 - T0) : 0;
    let f = from, t = to;
    let mode: 'pan' | 'left' | 'right';
    if (Math.abs(ts - f) <= tol) mode = 'left';
    else if (Math.abs(ts - t) <= tol) mode = 'right';
    else if (ts > f && ts < t) mode = 'pan';
    else {
      // Click outside the window → jump: recentre the window on the click.
      const w = t - f;
      f = Math.min(Math.max(ts - w / 2, T0), T1 - w);
      t = f + w;
      setWin({ from: f, to: t }); setPreset('');
      mode = 'pan';
    }
    dragRef.current = { mode, from: f, to: t, startTs: ts };
  };
  const onNavMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const ts = navTsAt(e.clientX);
    const delta = ts - d.startTs;
    if (d.mode === 'pan') {
      const w = d.to - d.from;
      let f = Math.min(Math.max(d.from + delta, T0), T1 - w);
      setWin({ from: f, to: f + w });
    } else if (d.mode === 'left') {
      const f = Math.min(Math.max(d.from + delta, T0), d.to - MIN_WINDOW_MS);
      setWin({ from: f, to: d.to });
    } else {
      const t = Math.max(Math.min(d.to + delta, T1), d.from + MIN_WINDOW_MS);
      setWin({ from: d.from, to: t });
    }
    setPreset('');
  };
  const onNavUp = () => { dragRef.current = null; };

  // Navigator geometry (full history, own compact y-scale).
  const NW = 720, NH = 46;
  const navMax = Math.max(...invAll.map(p => p.v), ...mktAll.map(p => p.v), 1) * 1.05;
  const nSpan = Math.max(T1 - T0, 1);
  const nx = (ts: number) => ((ts - T0) / nSpan) * NW;
  const ny = (v: number) => NH - 4 - (v / navMax) * (NH - 10);
  const navLine = invAll.map((p, i) => `${i === 0 ? 'M' : 'L'}${nx(p.ts).toFixed(1)},${ny(p.v).toFixed(1)}`).join(' ');
  const navArea = `${navLine} L${NW},${NH - 4} L0,${NH - 4} Z`;

  // ── Hover / tooltip (nearest invested point; carried market value if any) ──
  const onMove = (e: { clientX: number }) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ts = from + (((e.clientX - rect.left) / rect.width) * W - ML) / iw * span;
    setHoverTs(Math.min(Math.max(ts, from), to));
  };
  let hp: SeriesPt | null = null;
  if (hoverTs !== null && inv.length) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < inv.length; i++) {
      const d = Math.abs(inv[i].ts - hoverTs);
      if (d < bestD) { bestD = d; best = i; }
    }
    hp = inv[best];
  }
  let hoverMkt: number | null = null;
  if (hp) { for (const m of mktAll) { if (m.ts <= hp.ts) hoverMkt = m.v; else break; } }

  const lastInv = inv[inv.length - 1];
  const lastMkt = mkt.length ? mkt[mkt.length - 1] : null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-6">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <LineChart className="w-4 h-4 text-indigo-600" />
        <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">AUM Timeline</h3>
        <div className="ml-auto flex items-center gap-2 text-[11px] font-bold text-slate-500 tabular-nums">
          <span>{fmtRange(from)}</span><span className="text-slate-400">→</span><span>{fmtRange(to)}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 mb-2">
        {PRESETS.map(p => (
          <button
            key={p.key} onClick={() => applyPreset(p.key)} title={p.title}
            className={`px-2 py-1 rounded-md text-[11px] font-bold tracking-wide transition-colors cursor-pointer ${preset === p.key ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-100'}`}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setShowNav(v => !v)}
          title={showNav ? 'Hide the range bar' : 'Show the range bar (drag to pan, drag edges to zoom)'}
          aria-label="Toggle range bar"
          className={`ml-auto p-1.5 rounded-md border transition-colors cursor-pointer ${showNav ? 'bg-indigo-600 text-white border-indigo-600' : 'text-slate-500 border-slate-200 hover:bg-slate-100'}`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-[11px] font-semibold text-slate-500">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: lineCol }} /> Invested capital (cost)</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: upCol }} /> AUM (market, logged daily)</span>
      </div>
      <div ref={wrapRef} className="relative text-slate-500" onMouseMove={onMove} onMouseLeave={() => setHoverTs(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label="AUM over time">
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
          {/* invested: area + line */}
          {areaPath && <path d={areaPath} fill={lineCol} fillOpacity="0.09" />}
          {linePath && <path d={linePath} fill="none" stroke={lineCol} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
          {lastInv && <circle cx={x(lastInv.ts)} cy={y(lastInv.v)} r="3.5" fill={lineCol} />}
          {/* market: line once ≥2 snapshots, dots while sparse */}
          {mktPath && <path d={mktPath} fill="none" stroke={upCol} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
          {mkt.length > 0 && mkt.length <= 2 && mkt.map((m, i) => (
            <circle key={i} cx={x(m.ts)} cy={y(m.v)} r="3" fill={upCol} />
          ))}
          {/* today's market AUM marker */}
          {markerVisible && (
            <g>
              {lastInv && <line x1={x(to)} x2={x(to)} y1={y(lastInv.v)} y2={y(aumToday as number)} stroke={upCol} strokeOpacity="0.5" strokeWidth="1" strokeDasharray="3 3" />}
              <circle cx={x(to)} cy={y(aumToday as number)} r="4.5" fill={upCol} stroke={surface} strokeWidth="2" />
              <text x={x(to) - 8} y={y(aumToday as number) - 8} textAnchor="end" fontSize="11" fontWeight="700" fill={upCol}>{compactInr(aumToday as number)}</text>
            </g>
          )}
          {/* hover crosshair */}
          {hp && (
            <g>
              <line x1={x(hp.ts)} x2={x(hp.ts)} y1={MT} y2={MT + ih} stroke="currentColor" strokeOpacity="0.25" strokeWidth="1" />
              <circle cx={x(hp.ts)} cy={y(hp.v)} r="4" fill={lineCol} stroke={surface} strokeWidth="2" />
              {hoverMkt !== null && lastMkt && hp.ts >= mkt[0].ts && <circle cx={x(hp.ts)} cy={y(hoverMkt)} r="3.5" fill={upCol} stroke={surface} strokeWidth="1.5" />}
            </g>
          )}
        </svg>
        {hp && (
          <div
            className="absolute pointer-events-none px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white shadow-md text-[11px] leading-tight whitespace-nowrap"
            style={{
              left: `${(x(hp.ts) / W) * 100}%`,
              top: `${(y(hp.v) / H) * 100}%`,
              transform: `translate(${x(hp.ts) > W * 0.7 ? '-108%' : '10px'}, -120%)`,
            }}
          >
            <div className="font-bold text-slate-800">Invested {compactInr(hp.v)}</div>
            {hoverMkt !== null && hp.ts >= (mktAll[0]?.ts ?? Infinity) && (
              <div className="font-bold" style={{ color: upCol }}>AUM {compactInr(hoverMkt)}</div>
            )}
            <div className="text-slate-500">{new Date(hp.ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
          </div>
        )}
      </div>
      {/* Navigator strip — full history with a draggable window */}
      {showNav && (
        <div
          ref={navRef}
          className="relative mt-3 text-slate-500 select-none touch-none cursor-pointer"
          onPointerDown={onNavDown} onPointerMove={onNavMove} onPointerUp={onNavUp} onPointerCancel={onNavUp}
        >
          <svg viewBox={`0 0 ${NW} ${NH}`} className="w-full h-auto block rounded-lg" preserveAspectRatio="none" aria-label="Range selector">
            <rect x="0" y="0" width={NW} height={NH} fill="currentColor" fillOpacity="0.05" />
            <path d={navArea} fill={lineCol} fillOpacity="0.15" />
            <path d={navLine} fill="none" stroke={lineCol} strokeWidth="1.2" />
            {/* selected window */}
            <rect x={nx(from)} y="0" width={Math.max(nx(to) - nx(from), 2)} height={NH} fill={lineCol} fillOpacity="0.12" stroke={lineCol} strokeOpacity="0.5" strokeWidth="1" />
            <rect x={nx(from) - 2.5} y={NH * 0.2} width="5" height={NH * 0.6} rx="2" fill={lineCol} />
            <rect x={nx(to) - 2.5} y={NH * 0.2} width="5" height={NH * 0.6} rx="2" fill={lineCol} />
          </svg>
        </div>
      )}
    </div>
  );
}

export default function Dashboard({ onOpenPortfolio }: DashboardProps) {
  const [aum, setAum] = useState<AumResult | null>(null);
  const [timeline, setTimeline] = useState<AumTimelinePoint[] | null>(null);
  const [marketHist, setMarketHist] = useState<AumSnapshot[]>([]);
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
      // Log today's AUM snapshot (once per IST day; same-day reloads refresh
      // the row) and pull the accumulated market-value history for the chart.
      // Best-effort: a failure here never blocks the dashboard.
      try {
        if (aumRes.status === 'fulfilled') {
          setMarketHist(await logAumSnapshot(aumRes.value.totalInvested, aumRes.value.totalCurrent));
        } else {
          setMarketHist(await loadAumHistory());
        }
      } catch { /* snapshot logging is non-critical */ }
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

      {/* AUM timeline — invested capital through time + logged market AUM */}
      {timeline && timeline.length >= 2 && (
        <AumTimelineChart points={timeline} market={marketHist} aumToday={aum ? aum.totalCurrent : null} />
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
