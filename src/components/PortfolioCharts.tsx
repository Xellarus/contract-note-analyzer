import { useState, useRef, useMemo, type PointerEvent as ReactPointerEvent } from 'react';
import { LineChart, SlidersHorizontal, TrendingUp, Layers, AlertTriangle } from 'lucide-react';
import type { AumTimelinePoint } from '../lib/aumTimeline';
import type { NavResult, NavPoint } from '../lib/navTimeline';
import { COVERAGE_OK } from '../lib/priceGrid';

/**
 * The portfolio charts, in three modes over one shared frame (range presets, navigator brush,
 * hover readout):
 *
 *   aum          invested cost through time + the real market value of the positions held
 *   performance  time-weighted index vs NIFTY Smallcap 250, both based at 1000
 *   portfolios   market value per portfolio, in ₹ crore
 *
 * TWO SPANS, DELIBERATELY. Invested cost is derived from the trade ledger and is accurate back to
 * the first acquisition (2006 for the oldest carried-in lots). Market value is not: `Opening
 * Holdings` is a snapshot of the lots that survived to 31-Mar-2025, so replayed share counts
 * before that are understated (holdingsCalc.ts:263). So the cost line keeps its whole history
 * while the NAV line starts 01-Apr-2025, and any range reaching further back says so rather than
 * quietly drawing half a chart. The two market-value modes, which cannot exist before the clamp,
 * disable the presets that would reach past it.
 */

type Mode = 'aum' | 'performance' | 'portfolios';
type SeriesPt = { ts: number; v: number };

const DAY_MS = 86400000;
const MIN_WINDOW_MS = 7 * DAY_MS;

/** Earthy categorical hues, matching the palette the allocation chart uses. */
const SERIES_HUES = [
  '#8a6a1e', '#4f7a52', '#2f6d8c', '#9c5c3c', '#6b5b8f',
  '#a8862c', '#3f7f6f', '#8c4a5c', '#5d7a3a', '#7a6652',
];

/** Clip a series to the window, carrying the last pre-window value in at the left edge. */
function clipSeries(arr: SeriesPt[], from: number, to: number, extendRight: boolean): SeriesPt[] {
  if (!arr.length) return [];
  const out: SeriesPt[] = [];
  let carried: SeriesPt | null = null;
  for (const p of arr) {
    if (p.ts < from) { carried = { ts: from, v: p.v }; continue; }
    if (p.ts > to) break;
    if (carried) { out.push(carried); carried = null; }
    out.push(p);
  }
  if (!out.length && carried) out.push(carried);
  if (extendRight && out.length && out[out.length - 1].ts < to) {
    out.push({ ts: to, v: out[out.length - 1].v });
  }
  return out;
}

const inr = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
/** ₹ in crore / lakh — the units these figures are actually discussed in. */
function fmtCr(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${(v / 1e7).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Cr`;
  if (a >= 1e5) return `₹${(v / 1e5).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L`;
  return `₹${inr(v)}`;
}
const fmtIdx = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

interface Line {
  key: string;
  label: string;
  color: string;
  pts: SeriesPt[];
  dashed?: boolean;
  area?: boolean;
  /** Formatter for the hover readout and axis. */
  fmt: (v: number) => string;
}

export interface PortfolioChartsProps {
  /** Invested cost through time, full history. */
  points: AumTimelinePoint[];
  /** Market-value history; null/empty until the Price History tab is backfilled. */
  nav: NavResult | null;
  /** Live AUM for the "today" marker. */
  aumToday: number | null;
  portfolios: { id: string; code: string; label: string }[];
}

/**
 * The range the chart opens on, and the one it returns to when the mode changes. ALL spans back to
 * the first acquisition (2006 for the oldest book), which compresses the part anyone is actually
 * reading into the last inch of the axis.
 */
const DEFAULT_PRESET = '6M';

export default function PortfolioCharts({ points, nav, aumToday, portfolios }: PortfolioChartsProps) {
  const [mode, setMode] = useState<Mode>('aum');
  const [win, setWin] = useState<{ from: number; to: number } | null>(null);
  const [preset, setPreset] = useState<string>(DEFAULT_PRESET);
  const [showNav, setShowNav] = useState(false);
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: 'pan' | 'left' | 'right'; from: number; to: number; startTs: number } | null>(null);

  const dark = document.documentElement.classList.contains('dark');
  const brass = dark ? '#d9a441' : '#8a6a1e';
  const green = dark ? '#4fc584' : '#0d8a4f';
  const muted = dark ? '#938b7c' : '#756b57';
  const grid = dark ? '#332d24' : '#e7dfc9';
  const surface = dark ? '#1a1815' : '#fbf6eb';
  const ink = dark ? '#eae5da' : '#16130d';

  const navPoints: NavPoint[] = nav?.total ?? [];
  const hasNav = navPoints.length >= 2;
  const navFrom = nav?.fromTs ?? null;

  // ── build the series for the active mode ──────────────────────────────────
  const { lines, zeroAnchored, primaryIdx, dataFrom } = useMemo(() => {
    if (mode === 'performance') {
      const idx = navPoints.filter(p => p.index !== null).map(p => ({ ts: p.ts, v: p.index as number }));
      const bench = (nav?.benchmark ?? []).map(b => ({ ts: b.ts, v: b.index }));
      const ls: Line[] = [
        { key: 'idx', label: 'Portfolio (time-weighted)', color: brass, pts: idx, area: true, fmt: fmtIdx },
      ];
      if (bench.length >= 2) {
        ls.push({ key: 'bench', label: 'NIFTY Smallcap 250', color: green, pts: bench, dashed: true, fmt: fmtIdx });
      }
      return { lines: ls, zeroAnchored: false, primaryIdx: 0, dataFrom: idx.length ? idx[0].ts : null };
    }
    if (mode === 'portfolios') {
      const ls: Line[] = (nav?.byPortfolio ?? [])
        .map((pf, i) => {
          const meta = portfolios.find(p => p.id === pf.id);
          return {
            key: pf.id,
            label: meta ? meta.label : pf.id.toUpperCase(),
            color: SERIES_HUES[i % SERIES_HUES.length],
            pts: pf.points.map(p => ({ ts: p.ts, v: p.nav })),
            fmt: fmtCr,
          };
        })
        // A portfolio that never held anything in the window is noise on the legend.
        .filter(l => l.pts.some(p => p.v > 0));
      return { lines: ls, zeroAnchored: true, primaryIdx: 0, dataFrom: navFrom };
    }
    // aum
    const cost: SeriesPt[] = points.map(p => ({ ts: p.ts, v: p.invested }));
    const market: SeriesPt[] = navPoints.map(p => ({ ts: p.ts, v: p.nav }));
    const ls: Line[] = [
      { key: 'cost', label: 'Invested capital (cost)', color: brass, pts: cost, area: true, fmt: fmtCr },
    ];
    if (market.length >= 2) {
      ls.push({ key: 'mkt', label: 'Market value', color: green, pts: market, fmt: fmtCr });
    }
    return { lines: ls, zeroAnchored: true, primaryIdx: 0, dataFrom: cost.length ? cost[0].ts : null };
  }, [mode, points, nav, navPoints, portfolios, brass, green, navFrom]);

  // ── window ────────────────────────────────────────────────────────────────
  const allTs = lines.flatMap(l => l.pts.map(p => p.ts));
  const T0 = allTs.length ? Math.min(...allTs) : Date.now() - 30 * DAY_MS;
  const T1 = Math.max(allTs.length ? Math.max(...allTs) : Date.now(), Date.now());

  // ── range presets, gated on what the mode can actually show ────────────────
  const PRESETS: { key: string; label: string; title: string }[] = [
    { key: '1M', label: '1M', title: 'Last month' },
    { key: '3M', label: '3M', title: 'Last 3 months' },
    { key: '6M', label: '6M', title: 'Last 6 months' },
    { key: 'FY', label: 'FY', title: 'Since 1 April (current FY)' },
    { key: '1Y', label: '1Y', title: 'Last 12 months' },
    { key: 'ALL', label: 'ALL', title: 'Full history' },
  ];
  const startOf = (k: string): number => {
    if (k === 'ALL') return T0;
    if (k === '1M') return T1 - 30 * DAY_MS;
    if (k === '3M') return T1 - 91 * DAY_MS;
    if (k === '6M') return T1 - 182 * DAY_MS;
    if (k === '1Y') return T1 - 365 * DAY_MS;
    const d = new Date(T1);
    const fy = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    return Date.UTC(fy, 3, 1);
  };
  /**
   * Disable a preset whose window would start before the mode's data does — a 1Y axis carrying
   * four months of line invites reading the empty stretch as a flat portfolio.
   *
   * One rule serves every mode because `dataFrom` differs per mode: in `aum` it is the first
   * acquisition (2006), so nothing is disabled and the footnote explains where market value
   * begins; in the market-value modes it is the NAV clamp, so anything reaching past it goes.
   * 'ALL' means "all that exists" by definition and is never disabled.
   */
  const presetDisabled = (k: string): boolean => {
    if (dataFrom === null) return true;
    if (k === 'ALL') return false;
    return startOf(k) < dataFrom - DAY_MS;
  };

  /**
   * `win` is null until the user picks a preset or drags the brush, and a null window follows
   * `preset` — which starts at DEFAULT_PRESET, not ALL. Six months is the range actually worth
   * reading day to day; ALL squashes it into one rising line with 2006 on the left edge.
   *
   * Derived here rather than seeded into `win` at mount on purpose: NAV history arrives after the
   * first render, so T0/T1 move underneath us, and a window frozen at mount would be stale by the
   * time the data lands. If the default is impossible in this mode (its data starts later than the
   * window would), fall back to ALL so the highlighted button matches what is drawn.
   */
  const effPreset = preset && preset !== 'ALL' && presetDisabled(preset) ? 'ALL' : preset;
  const autoWin = effPreset && effPreset !== 'ALL'
    ? { from: Math.max(startOf(effPreset), T0), to: T1 }
    : null;
  const winNow = win ?? autoWin;
  const from = winNow ? Math.max(winNow.from, T0) : T0;
  const to = winNow ? Math.min(winNow.to, T1) : T1;
  const span = Math.max(to - from, DAY_MS);

  const W = 720, H = 250, ML = 14, MR = 84, MT = 16, MB = 30;
  const iw = W - ML - MR, ih = H - MT - MB;

  const clipped = lines.map(l => ({ ...l, pts: clipSeries(l.pts, from, to, l.key === 'cost') }));
  const vis = clipped.flatMap(l => l.pts.map(p => p.v));
  const markerVisible = mode === 'aum' && aumToday !== null && T1 >= from && T1 <= to;
  const rawMax = Math.max(...vis, markerVisible ? (aumToday as number) : 0, 1);
  // Guard the empty window: Math.min of nothing is Infinity, which would poison the padded domain
  // below into NaN and render an invisible chart rather than an empty one.
  const rawMin = vis.length ? Math.min(...vis) : 0;
  // Performance indices cluster near 1000; a zero-anchored axis would flatten every move into a
  // straight line, so that mode gets a padded min/max domain instead.
  const yMax = zeroAnchored ? rawMax * 1.1 : rawMax + (rawMax - rawMin) * 0.12 + 1;
  const yMin = zeroAnchored ? 0 : Math.max(0, rawMin - (rawMax - rawMin) * 0.12 - 1);
  const ySpan = Math.max(yMax - yMin, 1);

  const x = (ts: number) => ML + ((ts - from) / span) * iw;
  const y = (v: number) => MT + ih - ((v - yMin) / ySpan) * ih;
  const pathOf = (s: SeriesPt[]) => s.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const areaOf = (s: SeriesPt[]) => s.length
    ? `${pathOf(s)} L${x(s[s.length - 1].ts).toFixed(1)},${(MT + ih).toFixed(1)} L${x(s[0].ts).toFixed(1)},${(MT + ih).toFixed(1)} Z`
    : '';

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => yMin + f * ySpan);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map(f => from + f * span);
  const shortWin = span < 150 * DAY_MS;
  const fmtTick = (ts: number) => new Date(ts).toLocaleDateString('en-IN', shortWin ? { day: '2-digit', month: 'short' } : { month: 'short', year: '2-digit' });
  const fmtRange = (ts: number) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const axisFmt = lines[primaryIdx]?.fmt ?? fmtCr;

  /** True when the CURRENT window reaches back past where market value exists. */
  const windowPredatesNav = navFrom !== null && from < navFrom - DAY_MS;

  const applyPreset = (k: string) => {
    setPreset(k); setHoverTs(null);
    if (k === 'ALL') { setWin(null); return; }
    setWin({ from: Math.max(startOf(k), T0), to: T1 });
  };

  // ── navigator (brush) ─────────────────────────────────────────────────────
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
    let m: 'pan' | 'left' | 'right';
    if (Math.abs(ts - f) <= tol) m = 'left';
    else if (Math.abs(ts - t) <= tol) m = 'right';
    else if (ts > f && ts < t) m = 'pan';
    else {
      const w = t - f;
      f = Math.min(Math.max(ts - w / 2, T0), T1 - w);
      setWin({ from: f, to: f + w }); setPreset('');
      m = 'pan';
    }
    dragRef.current = { mode: m, from: f, to: t, startTs: ts };
  };
  const onNavMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const ts = navTsAt(e.clientX);
    const delta = ts - d.startTs;
    if (d.mode === 'pan') {
      const w = d.to - d.from;
      const f = Math.min(Math.max(d.from + delta, T0), T1 - w);
      setWin({ from: f, to: f + w });
    } else if (d.mode === 'left') {
      setWin({ from: Math.min(Math.max(d.from + delta, T0), d.to - MIN_WINDOW_MS), to: d.to });
    } else {
      setWin({ from: d.from, to: Math.max(Math.min(d.to + delta, T1), d.from + MIN_WINDOW_MS) });
    }
    setPreset('');
  };

  const NW = 720, NH = 46;
  const navSeries = lines[primaryIdx]?.pts ?? [];
  const navMax = Math.max(...navSeries.map(p => p.v), 1) * 1.05;
  const navMin = zeroAnchored ? 0 : Math.min(...navSeries.map(p => p.v), navMax);
  const nSpan = Math.max(T1 - T0, 1);
  const nx = (ts: number) => ((ts - T0) / nSpan) * NW;
  const ny = (v: number) => NH - 4 - ((v - navMin) / Math.max(navMax - navMin, 1)) * (NH - 10);
  const navLine = navSeries.map((p, i) => `${i === 0 ? 'M' : 'L'}${nx(p.ts).toFixed(1)},${ny(p.v).toFixed(1)}`).join(' ');

  // ── hover ─────────────────────────────────────────────────────────────────
  const onMove = (e: { clientX: number }) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ts = from + (((e.clientX - rect.left) / rect.width) * W - ML) / iw * span;
    setHoverTs(Math.min(Math.max(ts, from), to));
  };
  const nearest = (s: SeriesPt[], ts: number): SeriesPt | null => {
    if (!s.length) return null;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < s.length; i++) {
      const d = Math.abs(s[i].ts - ts);
      if (d < bestD) { bestD = d; best = i; }
    }
    return s[best];
  };
  const hoverAt = hoverTs !== null ? nearest(clipped[primaryIdx]?.pts ?? [], hoverTs) : null;
  const hoverCoverage = hoverAt && hasNav
    ? navPoints.reduce<NavPoint | null>((acc, p) => (Math.abs(p.ts - hoverAt.ts) < Math.abs((acc?.ts ?? -Infinity) - hoverAt.ts) ? p : acc), null)
    : null;

  const MODES: { key: Mode; label: string; Icon: typeof LineChart; disabled: boolean; why?: string }[] = [
    { key: 'aum', label: 'AUM', Icon: LineChart, disabled: false },
    { key: 'performance', label: 'Performance', Icon: TrendingUp, disabled: !hasNav, why: 'Needs the Price History backfill' },
    { key: 'portfolios', label: 'By portfolio', Icon: Layers, disabled: !hasNav, why: 'Needs the Price History backfill' },
  ];

  const lowCoverage = hoverCoverage !== null && hoverCoverage.coverage < COVERAGE_OK;
  const lastNav = navPoints.length ? navPoints[navPoints.length - 1] : null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-6">
      {/* mode tabs + window readout */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-100">
          {MODES.map(m => (
            <button
              key={m.key}
              onClick={() => { if (!m.disabled) { setMode(m.key); setPreset(DEFAULT_PRESET); setWin(null); setHoverTs(null); } }}
              disabled={m.disabled}
              title={m.disabled ? m.why : undefined}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-bold transition-colors ${
                mode === m.key ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              } ${m.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <m.Icon className="w-3.5 h-3.5" /> {m.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 text-[11px] font-bold text-slate-500 tabular-nums">
          <span>{fmtRange(from)}</span><span className="text-slate-400">→</span><span>{fmtRange(to)}</span>
        </div>
      </div>

      {/* presets */}
      <div className="flex flex-wrap items-center gap-1 mb-2">
        {PRESETS.map(p => {
          const off = presetDisabled(p.key);
          return (
            <button
              key={p.key} onClick={() => !off && applyPreset(p.key)} title={off ? 'No market-value history for this range yet' : p.title}
              disabled={off}
              className={`px-2 py-1 rounded-md text-[11px] font-bold tracking-wide transition-colors ${
                effPreset === p.key ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-100'
              } ${off ? 'opacity-35 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              {p.label}
            </button>
          );
        })}
        <button
          onClick={() => setShowNav(v => !v)}
          title={showNav ? 'Hide the range bar' : 'Show the range bar (drag to pan, drag edges to zoom)'}
          aria-label="Toggle range bar"
          className={`ml-auto p-1.5 rounded-md border transition-colors cursor-pointer ${showNav ? 'bg-indigo-600 text-white border-indigo-600' : 'text-slate-500 border-slate-200 hover:bg-slate-100'}`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-[11px] font-semibold text-slate-500">
        {clipped.map(l => (
          <span key={l.key} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-4 h-0.5 rounded"
              style={l.dashed
                ? { backgroundImage: `repeating-linear-gradient(to right, ${l.color} 0 4px, transparent 4px 7px)`, height: 2 }
                : { backgroundColor: l.color }}
            />
            {l.label}
          </span>
        ))}
        {mode === 'performance' && <span className="text-slate-400">both based at 1000 · flows removed</span>}
      </div>

      {/* chart */}
      <div ref={wrapRef} className="relative text-slate-500" onMouseMove={onMove} onMouseLeave={() => setHoverTs(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label={`Portfolio chart — ${mode}`}>
          {yTicks.map((t, i) => (
            <g key={i}>
              <line x1={ML} x2={ML + iw} y1={y(t)} y2={y(t)} stroke={grid} strokeWidth="1" strokeDasharray={i === 0 ? undefined : '3 4'} />
              <text x={ML + iw + 6} y={y(t) + 3.5} fontSize="9" fill={muted} className="tabular-nums">{axisFmt(t)}</text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text key={i} x={x(t)} y={H - 10} fontSize="9" fill={muted} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>{fmtTick(t)}</text>
          ))}

          {/* the stretch with no market value, in the AUM view */}
          {mode === 'aum' && windowPredatesNav && navFrom !== null && navFrom > from && (
            <>
              <rect x={ML} y={MT} width={Math.max(0, x(navFrom) - ML)} height={ih} fill={dark ? '#ffffff' : '#16130d'} opacity={0.04} />
              <line x1={x(navFrom)} x2={x(navFrom)} y1={MT} y2={MT + ih} stroke={green} strokeWidth="1" strokeDasharray="2 3" opacity={0.6} />
            </>
          )}

          {clipped.map(l => (
            <g key={l.key}>
              {l.area && l.pts.length > 1 && <path d={areaOf(l.pts)} fill={l.color} opacity={0.13} />}
              {l.pts.length > 1 && (
                <path d={pathOf(l.pts)} fill="none" stroke={l.color} strokeWidth="1.8"
                      strokeDasharray={l.dashed ? '4 3' : undefined} strokeLinejoin="round" />
              )}
            </g>
          ))}

          {markerVisible && aumToday !== null && (
            <circle cx={x(T1)} cy={y(aumToday)} r="3.5" fill={green} stroke={surface} strokeWidth="1.5" />
          )}

          {hoverAt && (
            <>
              <line x1={x(hoverAt.ts)} x2={x(hoverAt.ts)} y1={MT} y2={MT + ih} stroke={muted} strokeWidth="1" strokeDasharray="3 3" opacity={0.7} />
              {clipped.map(l => {
                const p = nearest(l.pts, hoverAt.ts);
                return p ? <circle key={l.key} cx={x(p.ts)} cy={y(p.v)} r="3" fill={l.color} stroke={surface} strokeWidth="1.5" /> : null;
              })}
            </>
          )}
        </svg>

        {hoverAt && (
          <div
            className="absolute pointer-events-none rounded-lg px-2.5 py-2 shadow-lg text-[11px] font-bold tabular-nums"
            style={{
              left: `${(x(hoverAt.ts) / W) * 100}%`,
              top: 4,
              transform: x(hoverAt.ts) > W * 0.6 ? 'translateX(-104%)' : 'translateX(4%)',
              backgroundColor: surface, color: ink, border: `1px solid ${grid}`,
            }}
          >
            <div className="text-[10px] font-black uppercase tracking-wide mb-1" style={{ color: muted }}>{fmtRange(hoverAt.ts)}</div>
            {clipped.map(l => {
              const p = nearest(l.pts, hoverAt.ts);
              if (!p) return null;
              return (
                <div key={l.key} className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
                  <span className="flex-1">{l.label}</span>
                  <span>{l.fmt(p.v)}</span>
                </div>
              );
            })}
            {lowCoverage && hoverCoverage && (
              <div className="mt-1 pt-1 border-t text-[10px] font-semibold" style={{ borderColor: grid, color: '#a3341f' }}>
                only {(hoverCoverage.coverage * 100).toFixed(0)}% of cost priced
              </div>
            )}
          </div>
        )}

        {showNav && (
          <div
            ref={navRef}
            onPointerDown={onNavDown}
            onPointerMove={onNavMove}
            onPointerUp={() => { dragRef.current = null; }}
            className="relative mt-2 rounded-md cursor-grab select-none"
            style={{ backgroundColor: dark ? '#211d17' : '#f5efe0', touchAction: 'none' }}
          >
            <svg viewBox={`0 0 ${NW} ${NH}`} className="w-full block" style={{ height: NH }} aria-hidden="true">
              <path d={`${navLine} L${NW},${NH - 4} L0,${NH - 4} Z`} fill={brass} opacity={0.16} />
              <path d={navLine} fill="none" stroke={brass} strokeWidth="1.2" />
              <rect x={nx(from)} width={Math.max(2, nx(to) - nx(from))} y={0} height={NH} fill={brass} opacity={0.12} />
              <line x1={nx(from)} x2={nx(from)} y1={0} y2={NH} stroke={brass} strokeWidth="1.5" />
              <line x1={nx(to)} x2={nx(to)} y1={0} y2={NH} stroke={brass} strokeWidth="1.5" />
            </svg>
          </div>
        )}
      </div>

      {/* footnotes — what the chart can and cannot say */}
      <div className="mt-3 space-y-1 text-[10px] font-semibold leading-relaxed" style={{ color: muted }}>
        {!hasNav && (
          <p className="flex items-start gap-1.5" style={{ color: '#a3341f' }}>
            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
            No market-value history yet — run the Price History backfill to enable the Performance and By-portfolio views.
          </p>
        )}
        {mode === 'aum' && windowPredatesNav && navFrom !== null && (
          <p>Market value begins {fmtRange(navFrom)}; the shaded stretch shows invested cost only. Positions before then come from a 31-Mar-2025 snapshot rather than a full ledger, so they cannot be valued.</p>
        )}
        {mode === 'performance' && (
          <p>Time-weighted: each session’s return is measured after removing money paid in or taken out, so deploying capital is not counted as a gain.</p>
        )}
        {lastNav && lastNav.discrepancy > 1 && (
          <p style={{ color: '#a3341f' }}>
            {fmtCr(lastNav.discrepancy)} of oversold (negative) quantity is excluded from these figures — reconcile it on the Holdings page.
          </p>
        )}
        {nav && nav.unpriced.length > 0 && (
          <p>{nav.unpriced.length} scrip{nav.unpriced.length === 1 ? '' : 's'} had no price history and contribute nothing to market value: {nav.unpriced.slice(0, 4).join(', ')}{nav.unpriced.length > 4 ? ` +${nav.unpriced.length - 4} more` : ''}.</p>
        )}
        {nav && nav.lowCoverageCount > 0 && (
          <p>{nav.lowCoverageCount} session{nav.lowCoverageCount === 1 ? '' : 's'} priced under {(COVERAGE_OK * 100).toFixed(0)}% of the book by cost.</p>
        )}
      </div>
    </div>
  );
}
