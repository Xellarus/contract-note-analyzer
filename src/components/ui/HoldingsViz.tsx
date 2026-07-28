// At-a-glance visuals for the Holdings summary, both driven by REAL data only
// (no synthesized series — the app stores current+previous price, not a history,
// so true per-holding sparklines aren't possible; see the holdings-no-mock-data rule):
//
//   <AllocationDonut>  portfolio weight by current market value. Single-accent
//                      sequential shading via currentColor opacity, so the theme
//                      remap paints it ink (light) / gold (dark) — not a rainbow
//                      that would fight the Mono/Brass themes.
//   <GainBar>          a compact diverging bar (emerald right / rose left) showing
//                      one holding's unrealised gain %, the real stand-in for a
//                      per-row "P&L sparkline".
import { useMemo } from 'react';

const compactINR = (n: number): string =>
  n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr`
  : n >= 1e5 ? `₹${(n / 1e5).toFixed(2)} L`
  : `₹${Math.round(n).toLocaleString('en-IN')}`;

export interface AllocationItem { name: string; currentValue: number; unrealizedGainPct: number; }

/** Donut of allocation by current market value. Top 6 positions + an "Others"
 *  slice; renders nothing until there's a positive total (i.e. prices are synced). */
export function AllocationDonut({ items }: { items: AllocationItem[] }) {
  const { arcs, total, count } = useMemo(() => {
    const pos = items.filter(i => i.currentValue > 0).sort((a, b) => b.currentValue - a.currentValue);
    const total = pos.reduce((s, i) => s + i.currentValue, 0);
    const TOP = 6;
    const slices = pos.slice(0, TOP).map(i => ({ name: i.name, value: i.currentValue }));
    const rest = pos.slice(TOP);
    if (rest.length) slices.push({ name: `Others (${rest.length})`, value: rest.reduce((s, i) => s + i.currentValue, 0) });

    let cum = 0;
    const arcs = slices.map((s, i) => {
      const frac = total > 0 ? s.value / total : 0;
      // Sequential opacity ramp: biggest slice fully opaque, tapering down.
      const op = slices.length > 1 ? 1 - (i / slices.length) * 0.62 : 1;
      const arc = { name: s.name, value: s.value, frac, op, len: frac * 100, offset: -cum * 100 };
      cum += frac;
      return arc;
    });
    return { arcs, total, count: pos.length };
  }, [items]);

  if (total <= 0 || arcs.length === 0) return null;

  return (
    <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 flex flex-col sm:flex-row items-center gap-5 animate-riseIn">
      {/* Donut */}
      <div className="relative shrink-0 text-indigo-600" style={{ width: 132, height: 132 }}>
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-0" role="img" aria-label="Allocation by current value">
          <circle cx={50} cy={50} r={38} fill="none" stroke="currentColor" strokeOpacity={0.08} strokeWidth={15} />
          {arcs.map((a, i) => (
            <circle
              key={i}
              className="donut-arc"
              style={{ animationDelay: `${i * 90}ms` }}
              cx={50} cy={50} r={38} fill="none"
              stroke="currentColor" strokeOpacity={a.op} strokeWidth={15}
              pathLength={100}
              strokeDasharray={`${a.len} ${100 - a.len}`}
              strokeDashoffset={a.offset}
              transform="rotate(-90 50 50)"
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-[13px] font-black text-slate-800 leading-none font-mono">{compactINR(total)}</span>
          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mt-1">{count} holding{count === 1 ? '' : 's'}</span>
        </div>
      </div>

      {/* Legend */}
      <div className="flex-1 min-w-0 w-full grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-1.5 text-indigo-600">
        {arcs.map((a, i) => (
          <div key={i} className="flex items-center gap-2 min-w-0">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-current shrink-0" style={{ opacity: a.op }} aria-hidden="true" />
            <span className="text-[11px] font-semibold text-slate-600 truncate flex-1" title={a.name}>{a.name}</span>
            <span className="text-[11px] font-black font-mono text-slate-800 shrink-0">{(a.frac * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Diverging magnitude bar for one holding's unrealised gain %. Emerald extends
 *  right (gain), rose extends left (loss); |pct| ≥ CAP saturates the half-width. */
export function GainBar({ pct }: { pct: number }) {
  const CAP = 50;
  const mag = Math.min(Math.abs(pct), CAP) / CAP;   // 0..1
  const up = pct >= 0;
  return (
    <div className="mt-1 h-1 w-full rounded-full bg-slate-400/20 relative overflow-hidden" aria-hidden="true">
      <div className="absolute inset-y-0 left-1/2 w-px bg-slate-400/40" />
      <div
        className={`absolute inset-y-0 rounded-full bar-grow ${up ? 'left-1/2 bg-emerald-500' : 'right-1/2 bg-rose-500'}`}
        style={{ width: `${mag * 50}%`, transformOrigin: up ? 'left' : 'right' }}
      />
    </div>
  );
}
