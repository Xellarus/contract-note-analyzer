import { useMemo } from 'react';
import { TrendingUp, Info } from 'lucide-react';
import type { NavResult } from '../lib/navTimeline';
import { computeReturns, type ReturnRow } from '../lib/returns';
import { formatDMY } from '../lib/dates';

interface Props {
  nav: NavResult | null;
  portfolios: { id: string; code: string; label: string }[];
}

const ymd = (ts: number) => {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

/** Signed percentage, 2dp. A dash when there is no number — never a zero standing in for one. */
const pct = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`);
const tone = (v: number | null) => (v === null ? 'text-slate-400' : v >= 0 ? 'text-emerald-700' : 'text-rose-700');

/**
 * The two headline return figures, for the whole book and per portfolio.
 *
 * Both are shown TOGETHER on purpose. They answer different questions and routinely disagree —
 * CAGR strips out when money arrived (so it judges stock selection, and is what the benchmark is
 * comparable to), XIRR keeps it (so it judges what the capital actually earned). Showing one
 * alone invites it to be read as "the" return. The gap between them is itself information: it is
 * the value of the timing of the money.
 */
export default function ReturnsPanel({ nav, portfolios }: Props) {
  const res = useMemo(() => {
    if (!nav || !nav.total.length) return null;
    const labelOf = (id: string) => portfolios.find((p) => p.id === id)?.label || id;
    return computeReturns({
      total: nav.total,
      byPortfolio: nav.byPortfolio.map((p) => ({ id: p.id, label: labelOf(p.id), points: p.points })),
      benchmark: nav.benchmark,
      flowsById: nav.flowsById,
    });
  }, [nav, portfolios]);

  if (!res) return null;

  const t = res.total;
  const window = t.fromTs !== null && t.toTs !== null
    ? `${formatDMY(ymd(t.fromTs))} – ${formatDMY(ymd(t.toTs))} · ${t.years.toFixed(1)} yr`
      + (t.medianCoverage !== null && t.medianCoverage < 1 ? ` · ${(t.medianCoverage * 100).toFixed(0)}% priced` : '')
    : t.notes[0] || 'no measurable window';

  // Only portfolios with something to say. A row of dashes is noise.
  const rows = res.byPortfolio.filter((r) => r.cagrPct !== null || r.cumulativePct !== null || r.xirrPct !== null);

  // Caveats are collected once for the whole panel rather than repeated per row.
  const notes: string[] = [];
  // When the headline can't be computed, the reason belongs at the top — not as a footnote
  // under four dashes. It is almost always upstream (price coverage), not the return maths.
  if (t.cagrPct === null && t.cumulativePct === null) {
    notes.push(`No headline figure: ${t.notes[0]}.`);
  }
  // Scrips with no price column at all. These are the direct cause of low coverage, so naming
  // them turns "no measurable window" into a to-do list.
  if (nav?.unpriced.length) {
    const shown = nav.unpriced.slice(0, 8).join(', ');
    const rest = nav.unpriced.length > 8 ? ` and ${nav.unpriced.length - 8} more` : '';
    notes.push(`${nav.unpriced.length} holding${nav.unpriced.length === 1 ? '' : 's'} have no price history at all, so they are missing from every NAV: ${shown}${rest}. Each one lowers coverage for as long as it's held.`);
  }
  const missing = res.byPortfolio.filter((r) => r.cagrPct === null && r.cumulativePct === null);
  if (missing.length) {
    notes.push(`${missing.length} portfolio${missing.length === 1 ? '' : 's'} could not be measured: ${missing.map((m) => `${m.label} (${m.notes[0]})`).join('; ')}.`);
  }
  if (t.notes.some((n) => /not annualised/.test(n))) {
    notes.push(`The NAV history is under a year, so this is the cumulative return — not annualised. Annualising a stub produces a confident-looking number with nothing behind it.`);
  }
  if (t.notes.some((n) => /trimmed/.test(n)) || rows.some((r) => r.notes.some((n) => /trimmed/.test(n)))) {
    notes.push(`Window trimmed to the nearest fully-priced sessions. A session missing a price understates NAV, and a CAGR rests on just two points — so an endpoint gap would corrupt the whole figure with nothing to cancel it.`);
  }
  if (nav?.partialFlowIds.length) {
    const who = nav.partialFlowIds.map((id) => portfolios.find((p) => p.id === id)?.code || id).join(', ');
    notes.push(`XIRR for ${who} counts only the pre-FY26 lots that survived to 31-Mar-2025, because there's no transaction history reaching back that far. Positions opened and closed before then are missing entirely — both legs — which biases the rate. Feeding the full history through Opening Basis → Add batch closes the gap.`);
  }
  if (t.xirrAmbiguous || rows.some((r) => r.xirrAmbiguous)) {
    notes.push(`Capital left and re-entered, so more than one rate mathematically satisfies the cash flows. The one shown is real but not uniquely determined.`);
  }
  if (t.xirrFromTs !== null && t.fromTs !== null && t.xirrFromTs < t.fromTs) {
    notes.push(`XIRR runs from ${formatDMY(ymd(t.xirrFromTs))}, earlier than the NAV series — it discounts cash flows rather than replaying positions, so the 1-Apr-2025 opening-basis cutoff doesn't bind it. The two figures therefore cover different periods.`);
  }

  const Tile = ({ label, value, sub, strong = false }: { label: string; value: string; sub: string; strong?: boolean }) => (
    <div className={`rounded-xl border p-4 ${strong ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200 bg-white'}`}>
      <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`text-2xl font-black tracking-tight mt-1 ${strong ? 'text-indigo-700' : 'text-slate-800'}`}>{value}</p>
      <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{sub}</p>
    </div>
  );

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-b border-slate-150 bg-slate-50">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-indigo-100 text-indigo-700 rounded-lg"><TrendingUp className="w-4 h-4" /></div>
          <div>
            <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">Returns</h3>
            <p className="text-[11px] text-slate-500 font-medium">{window}</p>
          </div>
        </div>
      </div>

      <div className="p-5 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile
            strong
            label={t.cagrPct !== null ? 'CAGR · time-weighted' : 'Return · cumulative'}
            value={pct(t.cagrPct !== null ? t.cagrPct : t.cumulativePct)}
            sub={t.cagrPct !== null ? 'Per year, neutral to when money arrived' : 'Total so far — too short to annualise'}
          />
          <Tile
            label="XIRR · money-weighted"
            value={pct(t.xirrPct)}
            sub={t.xirrFromTs !== null ? `Per year on capital deployed since ${formatDMY(ymd(t.xirrFromTs))}` : 'No cash-flow history'}
          />
          <Tile
            label={res.benchmarkLabel}
            value={pct(res.benchmarkCagrPct)}
            sub="Same window, same basis"
          />
          <Tile
            label="Excess vs benchmark"
            value={pct(res.excessCagrPct)}
            sub="CAGR minus the benchmark's"
          />
        </div>

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[#f8fafc] border-y border-slate-200 text-[10px] font-bold text-slate-600 uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-2.5">Portfolio</th>
                  <th className="px-4 py-2.5 whitespace-nowrap">Measured from</th>
                  <th className="px-4 py-2.5 text-right whitespace-nowrap">Cumulative</th>
                  <th className="px-4 py-2.5 text-right whitespace-nowrap">CAGR</th>
                  <th className="px-4 py-2.5 text-right whitespace-nowrap">XIRR</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r: ReturnRow) => (
                  <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-2.5 font-medium text-slate-800">{r.label}</td>
                    <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap text-[12px]">
                      {r.fromTs !== null ? formatDMY(ymd(r.fromTs)) : '—'}
                      {r.years > 0 && <span className="text-slate-400 ml-1.5">{r.years.toFixed(1)} yr</span>}
                    </td>
                    <td className={`px-4 py-2.5 text-right font-mono font-bold ${tone(r.cumulativePct)}`}>{pct(r.cumulativePct)}</td>
                    <td className={`px-4 py-2.5 text-right font-mono font-black ${tone(r.cagrPct)}`}>{pct(r.cagrPct)}</td>
                    <td className={`px-4 py-2.5 text-right font-mono font-black ${tone(r.xirrPct)}`}>{pct(r.xirrPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-2">
          <p className="text-[11px] text-slate-600 leading-relaxed">
            <b className="text-slate-700">CAGR</b> removes the effect of money moving in and out, so it measures the
            picks — it's the figure comparable to {res.benchmarkLabel}. <b className="text-slate-700">XIRR</b> keeps
            that effect, so it measures what the capital earned. They are meant to differ: the gap between them is the
            value of the timing.
          </p>
          {notes.map((n, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[11px] text-slate-500 leading-relaxed">
              <Info className="w-3.5 h-3.5 shrink-0 mt-[1px] text-slate-400" /><span>{n}</span>
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
