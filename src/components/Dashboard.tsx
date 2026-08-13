import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Wallet, RefreshCw, AlertCircle, AlertTriangle, TrendingUp, TrendingDown, LineChart, SlidersHorizontal, FileText, Loader2 } from 'lucide-react';
import { formatDMY } from '../lib/dates';
import { PortfolioHolding } from '../types';
import { computeAum, computeIndustryAllocation, AumResult } from '../lib/holdingsCalc';
import { computeInvestedTimeline, AumTimelinePoint } from '../lib/aumTimeline';
import { logAumSnapshot, loadAumHistory, AumSnapshot } from '../lib/aumHistory';
import { hasValidGoogleToken } from '../lib/googleAuth';
import { PORTFOLIOS } from '../lib/portfolios';
import { computeCrossHoldings, CrossHolding } from '../lib/crossHoldings';
import { computePendingCorpActions, dismissCorpActionAlert, PendingCorpAction } from '../lib/corpActionAlerts';
import { computeNavTimeline, type NavResult } from '../lib/navTimeline';
import PortfolioCharts from './PortfolioCharts';
import { toast } from './ui/overlay';
import CubeLoader from './ui/CubeLoader';
import PriceStatusButton from './PriceStatusButton';
import AllHoldingsTable from './AllHoldingsTable';

interface DashboardProps {
  holdings: PortfolioHolding[];
  cashBalance: number;
  setCashBalance: (val: number | ((prev: number) => number)) => void;
  onNavigate: (view: 'dashboard' | 'holdings' | 'imports') => void;
  /** Jump straight to one security's detail page in one account (from the holdings table). */
  onOpenStock: (focus: { portfolioId: string; scripName: string; isin: string }) => void;
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

export default function Dashboard({ onOpenStock }: DashboardProps) {
  const [aum, setAum] = useState<AumResult | null>(null);
  const [timeline, setTimeline] = useState<AumTimelinePoint[] | null>(null);
  const [marketHist, setMarketHist] = useState<AumSnapshot[]>([]);
  /** Real market-value history (Price History tab). null until loaded / if not backfilled. */
  const [navHist, setNavHist] = useState<NavResult | null>(null);
  const [holdingRows, setHoldingRows] = useState<CrossHolding[]>([]);
  const [holdingsFailed, setHoldingsFailed] = useState<string[]>([]);
  // Splits/bonuses detected on held scrips with no matching ledger entry. The card is
  // self-clearing: record the action and the row stops qualifying on the next load.
  const [pendingActions, setPendingActions] = useState<PendingCorpAction[]>([]);
  const [dismissing, setDismissing] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [factsheetBusy, setFactsheetBusy] = useState(false);

  /**
   * Build the factsheet from what's already on screen, so it can never disagree with the numbers
   * the user is looking at. Sector allocation is the one extra read (the Dashboard doesn't load it
   * otherwise); a failure there leaves the sector block empty rather than blocking the download.
   */
  const downloadFactsheet = async () => {
    if (factsheetBusy) return;
    setFactsheetBusy(true);
    try {
      const list = PORTFOLIOS.map(p => ({ id: p.id, label: p.label, sheetId: p.sheetId }));
      const industries = await computeIndustryAllocation(list).catch(() => null);
      const { buildFactsheet } = await import('../lib/factsheet');
      const { downloadFactsheetPdf } = await import('../lib/factsheetPdf');
      const sheet = buildFactsheet({
        title: 'Consolidated Portfolio',
        aum, holdings: holdingRows, nav: navHist, industries,
        portfolios: PORTFOLIOS.map(p => ({ code: p.code, label: p.label })),
      });
      await downloadFactsheetPdf(sheet);
    } catch (e: any) {
      console.error('Factsheet failed', e);
      toast.error(`Could not build the factsheet — ${e?.message || 'unknown error'}`);
    } finally {
      setFactsheetBusy(false);
    }
  };

  const load = async () => {
    if (!hasValidGoogleToken()) {
      setError('Connect Google Sheets from the Holdings tab to load live AUM.');
      return;
    }
    setLoading(true);
    setError(null);
    const list = PORTFOLIOS.map(p => ({ id: p.id, label: p.label, sheetId: p.sheetId }));
    const full = PORTFOLIOS.map(p => ({ id: p.id, code: p.code, label: p.label, sheetId: p.sheetId }));
    try {
      // AUM, the invested-capital timeline and the consolidated holdings run together; a
      // failure in one never blocks the others, so one bad sheet can't blank the page.
      const [aumRes, tlRes, chRes, caRes, navRes] = await Promise.allSettled([
        computeAum(list), computeInvestedTimeline(list), computeCrossHoldings(full),
        computePendingCorpActions(full), computeNavTimeline(list),
      ]);
      if (aumRes.status === 'fulfilled') setAum(aumRes.value);
      else setError(aumRes.reason?.result?.error?.message || aumRes.reason?.message || 'Could not compute AUM.');
      if (tlRes.status === 'fulfilled') setTimeline(tlRes.value);
      // Market-value history from the Price History tab. Advisory: if the tab hasn't been
      // backfilled the chart falls back to the cost-only view rather than failing the page.
      if (navRes.status === 'fulfilled') setNavHist(navRes.value);
      else console.warn('NAV timeline unavailable', navRes.reason);
      if (chRes.status === 'fulfilled') { setHoldingRows(chRes.value.rows); setHoldingsFailed(chRes.value.failed); }
      // Unrecorded splits/bonuses. Advisory only, so a failure is silent — the tab may not
      // exist yet if the weekly scanCorpActions() hasn't run.
      if (caRes.status === 'fulfilled') setPendingActions(caRes.value);
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
        <div className="flex items-center gap-2">
          <PriceStatusButton />
          <button
            onClick={downloadFactsheet} disabled={loading || factsheetBusy || !aum}
            title={aum ? 'Download the portfolio factsheet as a PDF' : 'Waiting for AUM'}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {factsheetBusy
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Building…</>
              : <><FileText className="w-3.5 h-3.5" /> Factsheet</>}
          </button>
          <button
            onClick={load} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {/* AUM hero */}
      {/* Light (Mono): warm-white card, ink border/text. Dark (Brass): warm graphite panel, gold label. */}
      <div className="rounded-3xl border border-[#16130d] bg-gradient-to-br from-[#fbf6eb] to-[#f8f2e3] text-[#16130d] shadow-lg p-7 sm:p-9 dark:border-[#332d24] dark:from-[#1a1815] dark:to-[#1a1815] dark:text-[#eae5da]">
        <div className="flex items-center gap-2 text-[#756b57] dark:text-[#d9a441]">
          <Wallet className="w-5 h-5" />
          <span className="text-[11px] font-black uppercase tracking-[0.15em]">Current AUM</span>
        </div>
        {loading && !aum ? (
          <div className="flex items-center gap-2 mt-4 text-[#756b57] dark:text-[#938b7c]"><CubeLoader className="w-7" /> <span className="text-sm font-bold">Computing…</span></div>
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

      {/* Portfolio charts — AUM (cost + real market value), Performance vs benchmark, per-portfolio */}
      {timeline && timeline.length >= 2 && (
        <PortfolioCharts
          points={timeline}
          nav={navHist}
          aumToday={aum ? aum.totalCurrent : null}
          portfolios={PORTFOLIOS.map(p => ({ id: p.id, code: p.code, label: p.label }))}
        />
      )}

      {/* Unrecorded splits / bonuses. Renders ONLY when something needs entering, so a clean
          ledger shows nothing at all — and recording the action makes the row disappear on the
          next load rather than needing a "done" tick. Amber, not red: Yahoo's split feed has
          false positives (an exact inverse ratio pair usually means a corrected entry), so this
          asks you to check rather than asserting the ledger is wrong. Hence Dismiss. */}
      {pendingActions.length > 0 && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-amber-200">
            <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
            <span className="text-[11px] font-black uppercase tracking-widest text-amber-800">
              Corporate action{pendingActions.length > 1 ? 's' : ''} to record
            </span>
            <span className="text-[10px] font-bold text-amber-700 bg-amber-100 border border-amber-300 rounded-full px-2 py-0.5">
              {pendingActions.length}
            </span>
            <span className="ml-auto text-[10px] text-amber-700 hidden sm:block">
              Detected from price data — confirm against the exchange notice before recording
            </span>
          </div>

          <div className="divide-y divide-amber-200">
            {pendingActions.map((pa) => {
              const rd = pa.reading;
              // BONUS / SPLIT / ambiguous each get their own badge tone. Only literal colour
              // classes here — the dark theme remaps those, not arbitrary variants.
              const badge =
                rd?.kind === 'BONUS' ? 'ca-badge-bonus'
                : rd?.kind === 'SPLIT' ? 'ca-badge-split'
                : 'ca-badge-either';
              return (
                <div key={`${pa.alert.rowIndex}:${pa.portfolioId}`} className="px-4 py-3">
                  {/* Line 1 — what happened */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => onOpenStock({ portfolioId: pa.portfolioId, scripName: pa.alert.name, isin: pa.alert.isin })}
                      className="text-[13px] font-black text-amber-900 hover:underline cursor-pointer text-left"
                      title="Open this stock to add the entry"
                    >
                      {pa.alert.name}
                    </button>
                    <span
                      className={`text-[10px] font-black uppercase tracking-wider border rounded px-1.5 py-0.5 ${badge}`}
                      title={rd?.note || 'Ratio could not be interpreted — check the exchange notice.'}
                    >
                      {rd ? rd.label : pa.alert.ratio}
                    </span>
                    {pa.alert.source === 'bse' && rd?.kind !== 'EITHER' ? (
                      <span className="text-[10px] font-bold text-amber-700" title="Type confirmed by the BSE corporate-actions feed, not inferred from the price ratio.">
                        &#10003; exchange-confirmed
                      </span>
                    ) : rd?.kind === 'EITHER' ? (
                      <span className="text-[10px] font-bold text-amber-700" title={rd.note}>needs confirming</span>
                    ) : null}
                    <button
                      onClick={async () => {
                        setDismissing(pa.alert.rowIndex);
                        try {
                          await dismissCorpActionAlert(pa.alert.rowIndex, pa.alert.statusCol);
                          setPendingActions(cur => cur.filter(x => x.alert.rowIndex !== pa.alert.rowIndex));
                        } catch (e: any) {
                          setError('Could not dismiss: ' + (e?.result?.error?.message || e?.message || 'error'));
                        } finally { setDismissing(null); }
                      }}
                      disabled={dismissing === pa.alert.rowIndex}
                      className="ml-auto text-[10px] font-bold uppercase tracking-wider text-amber-700 hover:text-white hover:bg-amber-600 border border-amber-300 hover:border-amber-600 rounded px-2 py-1 cursor-pointer disabled:opacity-50 transition-colors"
                      title="Not a real action, or already handled — silence this permanently"
                    >
                      {dismissing === pa.alert.rowIndex ? 'Dismissing…' : 'Dismiss'}
                    </button>
                  </div>

                  {/* Line 2 — the facts you need to enter it */}
                  <div className="mt-1 flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px] text-amber-700">
                    <span>Ex-date <span className="font-mono font-bold text-amber-900">{formatDMY(pa.alert.exDate)}</span></span>
                    <span>{pa.portfolioLabel}</span>
                    <span>Holding <span className="font-mono font-bold text-amber-900">{pa.heldQty.toLocaleString('en-IN')}</span></span>
                    {pa.impliedNewShares > 0 && (
                      <span>
                        Expect <span className="font-mono font-bold text-amber-900">+{Math.round(pa.impliedNewShares).toLocaleString('en-IN')}</span>
                        {' '}&rarr; <span className="font-mono font-bold text-amber-900">{Math.round(pa.heldQty + pa.impliedNewShares).toLocaleString('en-IN')}</span>
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Consolidated holdings across every portfolio (replaced the per-portfolio shortcut
          cards). Expanding a row shows which accounts hold it and jumps into one. */}
      {holdingsFailed.length > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[12px] text-amber-800">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>Couldn't read the Holding tab for {holdingsFailed.join(', ')} — those positions are missing from the table below.</span>
        </div>
      )}
      <AllHoldingsTable rows={holdingRows} loading={loading} onOpenStock={onOpenStock} />
    </div>
  );
}
