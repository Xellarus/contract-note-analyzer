import type { AumResult, IndustryAllocationResult } from "./holdingsCalc";
import type { CrossHolding } from "./crossHoldings";
import type { NavResult } from "./navTimeline";
import { formatDMMMY } from "./dates";

/**
 * The portfolio factsheet model. Not a summary poster — the whole book, with the analysis the
 * underlying data actually supports: risk and drawdown from the daily NAV series, sector and
 * per-account breakdowns with their own P&L, concentration measured properly (Herfindahl and
 * effective holdings, not just a top-10 percentage), and every open position listed.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. A published fund factsheet carries figures this app has
 * no source for, and inventing them would be worse than omitting them:
 *   • POST-tax NAV — no tax provision is modelled, so the NAV here is explicitly pre-tax.
 *   • "Since inception" — the NAV index cannot start before 01-Apr-2025, because `Opening
 *     Holdings` is a snapshot of surviving lots rather than a transaction history. The headline
 *     return is labelled with its real base date, never as inception-to-date.
 *   • Unlisted holdings, cash balances and AMFI market-cap classification — not tracked at all.
 * Every gap is stated on the sheet itself, so the document can't be mistaken for saying more than
 * it knows.
 */

export interface FactsheetSectorRow {
  sector: string;
  companies: number;
  invested: number;
  current: number;
  /** % of portfolio market value. */
  weight: number;
  pnlPct: number;
}

export interface FactsheetPortfolioRow {
  code: string;
  label: string;
  companies: number;
  invested: number;
  current: number;
  weight: number;
  pnlPct: number;
}

export interface FactsheetHoldingRow {
  rank: number;
  name: string;
  sector: string;
  isin: string;
  qty: number;
  avgCost: number;
  cmp: number | null;
  invested: number;
  current: number;
  weight: number;
  pnl: number;
  pnlPct: number;
  /** False ⇒ valued at cost because no market price was on file. */
  priced: boolean;
  /** Which accounts hold it. */
  accounts: string[];
}

export interface PeriodReturn {
  label: string;
  /** Percent, or null when the period reaches further back than the series. */
  pct: number | null;
  note?: string;
}

export interface RiskStats {
  sessions: number;
  /** Annualised standard deviation of daily flow-adjusted returns, %. */
  annVol: number | null;
  /** Worst peak-to-trough fall on the NAV index, %. */
  maxDrawdown: number | null;
  maxDdPeak: string;
  maxDdTrough: string;
  /** Still below the prior peak at the end of the series. */
  inDrawdown: boolean;
  bestSession: number | null;
  bestSessionDate: string;
  worstSession: number | null;
  worstSessionDate: string;
  positivePct: number | null;
  /** vs the benchmark, from paired daily returns. */
  beta: number | null;
  correlation: number | null;
  /** Annualised stdev of (portfolio − benchmark) daily returns, %. */
  trackingError: number | null;
}

export interface Factsheet {
  title: string;
  asOf: string;
  aum: number;
  invested: number;
  unrealised: number;
  unrealisedPct: number;
  companies: number;
  navIndex: number | null;
  navReturnPct: number | null;
  navBase: string;
  returns: PeriodReturn[];
  benchmarkLabel: string;
  benchmarkReturns: PeriodReturn[];
  /** Portfolio minus benchmark, per period. */
  excessReturns: PeriodReturn[];
  risk: RiskStats;
  sectors: FactsheetSectorRow[];
  unclassifiedCompanies: number;
  portfolioRows: FactsheetPortfolioRow[];
  holdings: FactsheetHoldingRow[];
  concentration: { top5: number; top10: number; top20: number; top30: number; hhi: number; effectiveN: number };
  pricedPct: number;
  unpricedCount: number;
  unpricedNames: string[];
  discrepancies: { name: string; qty: number }[];
  noHistoryNames: string[];
  lowCoverageSessions: number;
  portfolios: { code: string; label: string }[];
  caveats: string[];
  perfSvg: string | null;
  aumSvg: string | null;
}

const DAY = 86400000;
const TRADING_DAYS = 252;
const pctOf = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const ymd = (ts: number) => new Date(ts).toISOString().slice(0, 10);

// ── statistics ───────────────────────────────────────────────────────────────

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function stdev(a: number[]): number | null {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/** Successive index-to-index returns, skipping sessions where the index isn't defined. */
function dailyReturns(series: { ts: number; v: number }[]): { ts: number; r: number }[] {
  const out: { ts: number; r: number }[] = [];
  for (let i = 1; i < series.length; i++) {
    const p = series[i - 1].v, c = series[i].v;
    if (p > 0 && isFinite(c)) out.push({ ts: series[i].ts, r: c / p - 1 });
  }
  return out;
}

function computeRisk(nav: NavResult | null): RiskStats {
  const empty: RiskStats = {
    sessions: 0, annVol: null, maxDrawdown: null, maxDdPeak: "—", maxDdTrough: "—", inDrawdown: false,
    bestSession: null, bestSessionDate: "—", worstSession: null, worstSessionDate: "—",
    positivePct: null, beta: null, correlation: null, trackingError: null,
  };
  if (!nav) return empty;
  const idx = nav.total.filter(p => p.index !== null).map(p => ({ ts: p.ts, v: p.index as number }));
  if (idx.length < 3) return { ...empty, sessions: idx.length };

  const rp = dailyReturns(idx);
  const sd = stdev(rp.map(x => x.r));

  // Max drawdown, tracking the running peak.
  let peak = idx[0].v, peakTs = idx[0].ts, worst = 0, ddPeakTs = idx[0].ts, ddTroughTs = idx[0].ts;
  for (const p of idx) {
    if (p.v > peak) { peak = p.v; peakTs = p.ts; }
    const dd = peak > 0 ? p.v / peak - 1 : 0;
    if (dd < worst) { worst = dd; ddPeakTs = peakTs; ddTroughTs = p.ts; }
  }

  let best = rp[0], worstD = rp[0];
  for (const x of rp) { if (x.r > best.r) best = x; if (x.r < worstD.r) worstD = x; }

  // Benchmark pairing, by session timestamp.
  let beta: number | null = null, corr: number | null = null, te: number | null = null;
  if (nav.benchmark.length > 2) {
    const rb = dailyReturns(nav.benchmark.map(b => ({ ts: b.ts, v: b.index })));
    const bMap = new Map(rb.map(x => [x.ts, x.r]));
    const pairs: [number, number][] = [];
    for (const x of rp) { const b = bMap.get(x.ts); if (b !== undefined) pairs.push([x.r, b]); }
    if (pairs.length > 2) {
      const pa = pairs.map(p => p[0]), ba = pairs.map(p => p[1]);
      const mp = mean(pa), mb = mean(ba);
      const cov = pairs.reduce((s, [a, b]) => s + (a - mp) * (b - mb), 0) / (pairs.length - 1);
      const varB = ba.reduce((s, b) => s + (b - mb) ** 2, 0) / (ba.length - 1);
      const sp = stdev(pa), sb = stdev(ba);
      if (varB > 0) beta = cov / varB;
      if (sp && sb && sp > 0 && sb > 0) corr = cov / (sp * sb);
      const diffs = pairs.map(([a, b]) => a - b);
      const sdiff = stdev(diffs);
      if (sdiff !== null) te = sdiff * Math.sqrt(TRADING_DAYS) * 100;
    }
  }

  return {
    sessions: idx.length,
    annVol: sd !== null ? sd * Math.sqrt(TRADING_DAYS) * 100 : null,
    maxDrawdown: worst * 100,
    maxDdPeak: formatDMMMY(ymd(ddPeakTs)),
    maxDdTrough: formatDMMMY(ymd(ddTroughTs)),
    inDrawdown: idx[idx.length - 1].v < peak - 1e-9,
    bestSession: best.r * 100,
    bestSessionDate: formatDMMMY(ymd(best.ts)),
    worstSession: worstD.r * 100,
    worstSessionDate: formatDMMMY(ymd(worstD.ts)),
    positivePct: rp.length ? (rp.filter(x => x.r > 0).length / rp.length) * 100 : null,
    beta, correlation: corr, trackingError: te,
  };
}

// ── periodic returns ─────────────────────────────────────────────────────────

function seriesReturn(series: { ts: number; v: number }[], label: string, days: number, whatStarts: string): PeriodReturn {
  if (series.length < 2) return { label, pct: null, note: `no ${whatStarts}` };
  const last = series[series.length - 1];
  const target = last.ts - days * DAY;
  if (target < series[0].ts - DAY) {
    return { label, pct: null, note: `starts ${formatDMMMY(ymd(series[0].ts))}` };
  }
  let then: number | null = null;
  for (const p of series) { if (p.ts > target) break; then = p.v; }
  if (then === null || then <= 0) return { label, pct: null, note: `no ${whatStarts}` };
  return { label, pct: (last.v / then - 1) * 100 };
}

export interface FactsheetInput {
  title: string;
  aum: AumResult | null;
  holdings: CrossHolding[];
  nav: NavResult | null;
  industries: IndustryAllocationResult | null;
  portfolios: { code: string; label: string }[];
  benchmarkLabel?: string;
}

export function buildFactsheet(inp: FactsheetInput): Factsheet {
  const { title, aum, holdings, nav, industries, portfolios } = inp;
  const benchmarkLabel = inp.benchmarkLabel ?? "NIFTY Smallcap 250";
  const asOf = formatDMMMY(ymd(Date.now()));

  // Open positions only. A negative quantity is a ledger error: it's reported separately, because
  // folding it into a weight would make every percentage on the sheet wrong.
  const open = holdings.filter(h => h.qty > 1e-9);
  const totalCurrent = open.reduce((s, h) => s + h.current, 0);
  const totalInvested = open.reduce((s, h) => s + h.invested, 0);
  const sectorByKey = industries?.sectorByKey ?? new Map<string, string>();

  const ranked = [...open].sort((a, b) => b.current - a.current);
  const rows: FactsheetHoldingRow[] = ranked.map((h, i) => {
    const pnl = h.current - h.invested;
    return {
      rank: i + 1,
      name: h.name || h.isin || "—",
      sector: sectorByKey.get(h.key) || "Unclassified",
      isin: h.isin || "",
      qty: h.qty,
      avgCost: h.avgCost,
      cmp: h.cmp ?? null,
      invested: h.invested,
      current: h.current,
      weight: pctOf(h.current, totalCurrent),
      pnl,
      pnlPct: h.invested > 0 ? (pnl / h.invested) * 100 : 0,
      priced: h.priced,
      accounts: [...new Set(h.lots.map(l => l.code))].sort(),
    };
  });

  const cum = (n: number) => pctOf(ranked.slice(0, n).reduce((s, h) => s + h.current, 0), totalCurrent);
  // Herfindahl on market-value weights: Σw² on the 0-10,000 scale, plus its reciprocal, which reads
  // as "this book behaves like N equally-sized positions" — far more informative than a top-10 %.
  const hhi = rows.reduce((s, r) => s + (r.weight / 100) ** 2, 0);

  const sectorTotal = industries ? industries.slices.reduce((t, s) => t + s.current, 0) : 0;
  const sectors: FactsheetSectorRow[] = industries
    ? industries.slices
        .map(s => ({
          sector: s.industry,
          companies: s.companies,
          invested: s.invested,
          current: s.current,
          weight: pctOf(s.current, sectorTotal),
          pnlPct: s.invested > 0 ? ((s.current - s.invested) / s.invested) * 100 : 0,
        }))
        .filter(s => s.current > 0)
        .sort((a, b) => b.weight - a.weight)
    : [];

  // Per-account rollup, from each holding's lots.
  const byAcct = new Map<string, { companies: number; invested: number; current: number; label: string }>();
  for (const h of open) {
    for (const l of h.lots) {
      if (!(l.qty > 1e-9)) continue;
      let a = byAcct.get(l.code);
      if (!a) { a = { companies: 0, invested: 0, current: 0, label: l.label }; byAcct.set(l.code, a); }
      a.companies++; a.invested += l.invested; a.current += l.current;
    }
  }
  const acctTotal = [...byAcct.values()].reduce((s, a) => s + a.current, 0);
  const portfolioRows: FactsheetPortfolioRow[] = [...byAcct.entries()]
    .map(([code, a]) => ({
      code, label: a.label, companies: a.companies, invested: a.invested, current: a.current,
      weight: pctOf(a.current, acctTotal),
      pnlPct: a.invested > 0 ? ((a.current - a.invested) / a.invested) * 100 : 0,
    }))
    .sort((x, y) => y.current - x.current);

  const pricedValue = open.filter(h => h.priced).reduce((s, h) => s + h.current, 0);

  const navSeries = nav ? nav.total.filter(p => p.index !== null).map(p => ({ ts: p.ts, v: p.index as number })) : [];
  const benchSeries = nav ? nav.benchmark.map(b => ({ ts: b.ts, v: b.index })) : [];
  const navIndex = navSeries.length ? navSeries[navSeries.length - 1].v : null;
  const navBase = navSeries.length ? formatDMMMY(ymd(navSeries[0].ts)) : "—";

  const PERIODS: [string, number][] = [["1 Month", 30], ["3 Months", 91], ["6 Months", 182], ["1 Year", 365]];
  const sinceP: PeriodReturn = { label: `Since ${navBase}`, pct: navIndex !== null ? (navIndex / 1000 - 1) * 100 : null };
  const sinceB: PeriodReturn = {
    label: `Since ${navBase}`,
    pct: benchSeries.length >= 2 ? (benchSeries[benchSeries.length - 1].v / benchSeries[0].v - 1) * 100 : null,
  };
  const returns = navSeries.length ? [sinceP, ...PERIODS.map(([l, d]) => seriesReturn(navSeries, l, d, "NAV history"))] : [];
  const benchmarkReturns = navSeries.length ? [sinceB, ...PERIODS.map(([l, d]) => seriesReturn(benchSeries, l, d, "benchmark history"))] : [];
  const excessReturns: PeriodReturn[] = returns.map((r, i) => {
    const b = benchmarkReturns[i];
    return {
      label: r.label,
      pct: r.pct !== null && b && b.pct !== null ? r.pct - b.pct : null,
      note: r.pct === null ? r.note : b?.pct === null ? b?.note : undefined,
    };
  });

  const unpricedNames = open.filter(h => !h.priced).map(h => h.name || h.isin).sort();
  const discrepancies = holdings.filter(h => h.discrepancy).map(h => ({ name: h.name || h.isin, qty: h.qty }));
  const unclassified = sectors.find(s => s.sector === "Unclassified");

  const caveats: string[] = [
    "NAV is PRE-TAX and before fees. No tax provision or expense accrual is applied, so it is not comparable to a post-tax fund NAV.",
    `NAV is indexed to 1000 on ${navBase} — not at inception. Market value before that date cannot be derived from the ledger, whose pre-FY26 position is a 31-Mar-2025 snapshot of surviving lots rather than a transaction history.`,
    "Returns are TIME-WEIGHTED: each session's return is measured after removing capital paid in or taken out, so deploying or withdrawing money is never counted as performance.",
    "Historical prices are stored un-adjusted (the price actually traded), and share counts come from the ledger, so splits and bonuses are counted once rather than twice.",
    "Listed equity positions only. Unlisted holdings, cash balances and AMFI market-cap classification are not tracked by this system.",
    "Cost basis is FIFO and charge-inclusive. Cost per share is carried at full precision, not rounded to paise.",
  ];
  if (pricedValue < totalCurrent - 1) {
    caveats.push(`${(100 - pctOf(pricedValue, totalCurrent)).toFixed(2)}% of portfolio value is carried at COST because no market price was on file; those positions show no gain or loss.`);
  }
  if (discrepancies.length) {
    caveats.push(`${discrepancies.length} position${discrepancies.length === 1 ? "" : "s"} with a negative net quantity are excluded from every figure here and need reconciling.`);
  }
  if (industries && industries.classified < industries.totalCompanies) {
    caveats.push(`${industries.totalCompanies - industries.classified} of ${industries.totalCompanies} companies have no sector on file and are grouped as Unclassified.`);
  }
  if (nav?.unpriced.length) {
    caveats.push(`${nav.unpriced.length} scrip${nav.unpriced.length === 1 ? "" : "s"} had no price history and contribute nothing to the NAV series or to any return on this sheet.`);
  }
  return {
    title,
    asOf,
    aum: aum ? aum.totalCurrent : totalCurrent,
    invested: aum ? aum.totalInvested : totalInvested,
    unrealised: totalCurrent - totalInvested,
    unrealisedPct: totalInvested > 0 ? ((totalCurrent - totalInvested) / totalInvested) * 100 : 0,
    companies: open.length,
    navIndex,
    navReturnPct: navIndex !== null ? (navIndex / 1000 - 1) * 100 : null,
    navBase,
    returns,
    benchmarkLabel,
    benchmarkReturns,
    excessReturns,
    risk: computeRisk(nav),
    sectors,
    unclassifiedCompanies: unclassified?.companies ?? 0,
    portfolioRows,
    holdings: rows,
    concentration: {
      top5: cum(5), top10: cum(10), top20: cum(20), top30: cum(30),
      hhi: hhi * 10000,
      effectiveN: hhi > 0 ? 1 / hhi : 0,
    },
    pricedPct: pctOf(pricedValue, totalCurrent),
    unpricedCount: unpricedNames.length,
    unpricedNames,
    discrepancies,
    noHistoryNames: nav?.unpriced ?? [],
    lowCoverageSessions: nav?.lowCoverageCount ?? 0,
    portfolios,
    caveats,
    perfSvg: navSeries.length >= 2 ? indexChartSvg(navSeries, benchSeries, benchmarkLabel) : null,
    aumSvg: nav && nav.total.length >= 2 ? aumChartSvg(nav) : null,
  };
}

// ── charts ───────────────────────────────────────────────────────────────────
//
// Rendered as SVG strings and embedded by pdfmake through its bundled svg-to-pdfkit, so they stay
// real vectors — sharp in print — rather than becoming a bitmap. Kept independent of the React
// chart on purpose: these must run with no DOM, and a factsheet wants a fixed, print-tuned frame
// rather than the interactive chart's zoomable one.
//
// `font-family="Roboto"` is resolved by pdfmake's own fontCallback (Renderer.js) to the embedded
// Roboto file, so labels match the document. Running under bare Node logs
// `SVGElemText: failed to open font` per label, because pdfkit there looks for a real file while
// pdfmake only patches its filesystem in the browser build — harmless, and not a reason to change
// families (an unregistered one just falls back to Roboto anyway).

const BRASS = "#8a6a1e";
const BRASS_DEEP = "#6d5417";
const BRASS_PALE = "#c9ad6a";
const CHART_INK = "#16130d";
const CHART_MUTED = "#756b57";
const CHART_RULE = "#ddd2b4";
const POS = "#0d8a4f";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monLabel = (ts: number) => { const d = new Date(ts); return `${MON[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(2)}`; };

interface Pt { ts: number; v: number }

/** Shared frame: axes, grid and tick labels. Returns the scales for the caller to draw into. */
function frame(all: Pt[], W: number, H: number, ML: number, fmtY: (v: number) => string, zeroAnchored: boolean) {
  const MR = 10, MT = 16, MB = 24;
  const iw = W - ML - MR, ih = H - MT - MB;
  const t0 = Math.min(...all.map(p => p.ts)), t1 = Math.max(...all.map(p => p.ts));
  const lo = Math.min(...all.map(p => p.v)), hi = Math.max(...all.map(p => p.v));
  const pad = (hi - lo) * 0.12 + 1;
  const yLo = zeroAnchored ? 0 : Math.max(0, lo - pad);
  const yHi = hi + pad;
  const span = Math.max(t1 - t0, 1), ySpan = Math.max(yHi - yLo, 1);
  const x = (ts: number) => ML + ((ts - t0) / span) * iw;
  const y = (v: number) => MT + ih - ((v - yLo) / ySpan) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => yLo + f * ySpan);
  const xt = [0, 0.25, 0.5, 0.75, 1].map(f => t0 + f * span);
  const svg = [
    ...ticks.map(t => `<line x1="${ML}" y1="${y(t).toFixed(1)}" x2="${ML + iw}" y2="${y(t).toFixed(1)}" stroke="${CHART_RULE}" stroke-width="0.5"/>`),
    ...ticks.map(t => `<text x="${ML - 5}" y="${(y(t) + 2.8).toFixed(1)}" font-family="Roboto" font-size="7" fill="${CHART_MUTED}" text-anchor="end">${esc(fmtY(t))}</text>`),
    ...xt.map((t, i) => `<text x="${x(t).toFixed(1)}" y="${H - 7}" font-family="Roboto" font-size="7" fill="${CHART_MUTED}" text-anchor="${i === 0 ? "start" : i === xt.length - 1 ? "end" : "middle"}">${monLabel(t)}</text>`),
  ].join("\n");
  const path = (s: Pt[]) => s.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = (s: Pt[]) => `${path(s)} L${x(s[s.length - 1].ts).toFixed(1)},${(MT + ih).toFixed(1)} L${x(s[0].ts).toFixed(1)},${(MT + ih).toFixed(1)} Z`;
  return { svg, x, y, path, area, MT, ih, ML, iw };
}

/** Performance: the NAV index against the benchmark, both based at 1000. */
export function indexChartSvg(port: Pt[], bench: Pt[], benchLabel: string): string | null {
  if (port.length < 2) return null;
  const W = 700, H = 250;
  const f = frame([...port, ...bench], W, H, 34, v => v.toFixed(0), false);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${f.svg}
<line x1="${f.ML}" y1="${f.y(1000).toFixed(1)}" x2="${(f.ML + f.iw).toFixed(1)}" y2="${f.y(1000).toFixed(1)}" stroke="${CHART_MUTED}" stroke-width="0.6" stroke-dasharray="2 3"/>
<path d="${f.area(port)}" fill="${BRASS}" fill-opacity="0.14"/>
${bench.length > 1 ? `<path d="${f.path(bench)}" fill="none" stroke="${BRASS_PALE}" stroke-width="1.3" stroke-dasharray="4 3"/>` : ""}
<path d="${f.path(port)}" fill="none" stroke="${BRASS_DEEP}" stroke-width="1.9"/>
<text x="${f.ML + 4}" y="${f.MT + 9}" font-family="Roboto" font-size="8" fill="${BRASS_DEEP}">Portfolio pre-tax NAV</text>
${bench.length > 1 ? `<text x="${f.ML + 4}" y="${f.MT + 20}" font-family="Roboto" font-size="8" fill="${CHART_MUTED}">${esc(benchLabel)}</text>` : ""}
</svg>`;
}

/** Deployment: invested cost against market value, in ₹ crore. */
export function aumChartSvg(nav: NavResult): string | null {
  const mkt: Pt[] = nav.total.map(p => ({ ts: p.ts, v: p.nav / 1e7 }));
  const cost: Pt[] = nav.total.map(p => ({ ts: p.ts, v: p.cost / 1e7 }));
  if (mkt.length < 2) return null;
  const W = 700, H = 190;
  const f = frame([...mkt, ...cost], W, H, 34, v => v.toFixed(2), true);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${f.svg}
<path d="${f.area(mkt)}" fill="${POS}" fill-opacity="0.10"/>
<path d="${f.path(cost)}" fill="none" stroke="${BRASS}" stroke-width="1.5" stroke-dasharray="3 2"/>
<path d="${f.path(mkt)}" fill="none" stroke="${POS}" stroke-width="1.7"/>
<text x="${f.ML + 4}" y="${f.MT + 9}" font-family="Roboto" font-size="8" fill="${POS}">Market value (₹ Cr)</text>
<text x="${f.ML + 4}" y="${f.MT + 20}" font-family="Roboto" font-size="8" fill="${BRASS}">Invested cost (₹ Cr)</text>
</svg>`;
}
