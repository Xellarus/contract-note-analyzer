/**
 * Render smoke test for PortfolioCharts: proves the component mounts in all three modes with
 * realistic and degenerate data, and — the part tsc cannot check — that no NaN reaches an SVG
 * path. A NaN in a `d` attribute renders an invisible chart with no error anywhere.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

// The component reads the theme off the document at render time.
(globalThis as any).document = {
  documentElement: { classList: { contains: (_c: string) => false } },
};

const PortfolioCharts = (await import('./src/components/PortfolioCharts')).default;
const { applyTwr } = await import('./src/lib/navMath');
import type { NavPoint, NavResult } from './src/lib/navTimeline';

let fails = 0;
const ok = (c: boolean, label: string, extra = '') => {
  if (!c) { fails++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`); }
  else console.log(`  ok    ${label}${extra ? '  ' + extra : ''}`);
};

const DAY = 86400000;
const APR1 = Date.parse('2025-04-01T00:00:00Z');

// ── synthetic but realistic inputs ──────────────────────────────────────────
// Cost line reaching back to 2006, as the oldest carried-in lots do.
const cost = [
  { ts: Date.parse('2006-06-11T00:00:00Z'), invested: 500000 },
  { ts: Date.parse('2020-09-13T00:00:00Z'), invested: 4000000 },
  { ts: Date.parse('2025-04-01T00:00:00Z'), invested: 18416709.71 },
  { ts: Date.parse('2026-08-12T00:00:00Z'), invested: 20511880 },
];

function mkNav(n: number, opts: { flowOn?: number; gapCoverage?: boolean } = {}): NavResult {
  const pts: NavPoint[] = [];
  for (let i = 0; i < n; i++) {
    const nav = 18000000 * (1 + 0.0009 * i) + Math.sin(i / 9) * 400000;
    pts.push({
      ts: APR1 + i * DAY,
      nav,
      cost: 18416709.71,
      coverage: opts.gapCoverage && i < 5 ? 0.82 : 1,
      discrepancy: i === n - 1 ? 125000 : 0,
      flow: opts.flowOn === i ? 5000000 : 0,
      index: null,
    });
  }
  applyTwr(pts);
  const anchor = pts.findIndex(p => p.index !== null);
  const benchmark = pts.slice(anchor).map((p, k) => ({ ts: p.ts, index: 1000 * (1 + 0.0004 * k) }));
  return {
    total: pts,
    byPortfolio: [
      { id: 't059', points: pts.map(p => ({ ...p, nav: p.nav * 0.6 })) },
      { id: 's713', points: pts.map(p => ({ ...p, nav: p.nav * 0.3 })) },
      { id: 'c087', points: pts.map(p => ({ ...p, nav: 0 })) },        // never held → must be dropped
    ],
    benchmark,
    fromTs: pts[0].ts,
    toTs: pts[pts.length - 1].ts,
    unpriced: ['Some Delisted Ltd', 'Another Old Name', 'Third', 'Fourth', 'Fifth'],
    lowCoverageCount: opts.gapCoverage ? 5 : 0, flowsById: new Map(), partialFlowIds: [],
  };
}

const PORTFOLIOS = [
  { id: 't059', code: 'T059', label: 'Taparia Holdings' },
  { id: 's713', code: 'S713', label: 'Saket Agarwal (Integrated)' },
  { id: 'c087', code: 'C087', label: 'Chaitanya Agarwal' },
];

const badNum = (html: string) => /(NaN|Infinity|undefined)/.test(html);
const svgPathsClean = (html: string) => {
  const ds = [...html.matchAll(/\sd="([^"]*)"/g)].map(m => m[1]);
  return { count: ds.length, bad: ds.filter(d => /NaN|Infinity|undefined/.test(d)) };
};

function render(props: any, label: string) {
  let html = '';
  try {
    html = renderToStaticMarkup(createElement(PortfolioCharts, props));
  } catch (e: any) {
    ok(false, `${label} — renders without throwing`, e?.message);
    return null;
  }
  ok(true, `${label} — renders without throwing`);
  const p = svgPathsClean(html);
  ok(p.bad.length === 0, `${label} — no NaN/Infinity in any SVG path`, `${p.count} paths, ${p.bad.length} bad${p.bad[0] ? ': ' + p.bad[0].slice(0, 60) : ''}`);
  ok(!badNum(html), `${label} — no NaN/Infinity/undefined anywhere in the markup`);
  return html;
}

console.log('\n1. Full data, default (AUM) mode');
{
  const nav = mkNav(340, { flowOn: 100 });
  const html = render({ points: cost, nav, aumToday: 20511880, portfolios: PORTFOLIOS }, 'aum');
  if (html) {
    ok(html.includes('Invested capital (cost)'), 'cost series in the legend');
    ok(html.includes('Market value'), 'market series in the legend');
    ok(/AUM/.test(html) && /Performance/.test(html) && /By portfolio/.test(html), 'all three mode tabs present');
    ok(html.includes('Market value begins'), 'footnote explains where market value starts');
    ok(/oversold/.test(html), 'discrepancy is surfaced, not folded in');
    ok(/had no price history/.test(html), 'unpriced scrips are named');
    ok(/\+1 more/.test(html), 'unpriced list is truncated with a count');
    // The clamp shading must exist, since the ALL window starts in 2006.
    ok(/opacity="0.04"/.test(html) || /opacity=\"0\.04\"/.test(html), 'pre-NAV stretch is shaded');
  }
}

console.log('\n2. No market history at all (tab not backfilled)');
{
  const html = render({ points: cost, nav: null, aumToday: 20511880, portfolios: PORTFOLIOS }, 'no-nav');
  if (html) {
    ok(html.includes('No market-value history yet'), 'tells the user to run the backfill');
    ok(html.includes('cursor-not-allowed'), 'the two market-value modes are disabled');
    ok(html.includes('Invested capital (cost)'), 'cost line still renders');
  }
}

console.log('\n3. Degenerate inputs');
{
  // Two cost points only, nav present but empty.
  const empty: NavResult = { total: [], byPortfolio: [], benchmark: [], fromTs: null, toTs: null, unpriced: [], lowCoverageCount: 0 , flowsById: new Map(), partialFlowIds: []};
  render({ points: cost.slice(0, 2), nav: empty, aumToday: null, portfolios: [] }, 'empty-nav');
  // A single NAV session (nothing to draw a line with).
  render({ points: cost, nav: mkNav(1), aumToday: 100, portfolios: PORTFOLIOS }, 'one-session');
  // All-zero NAV — index never starts, so every index is null.
  const zero = mkNav(20);
  zero.total.forEach(p => { p.nav = 0; p.index = null; });
  zero.byPortfolio.forEach(pf => pf.points.forEach(p => { p.nav = 0; }));
  render({ points: cost, nav: zero, aumToday: 0, portfolios: PORTFOLIOS }, 'all-zero-nav');
  // No benchmark column.
  const noBench = mkNav(60);
  noBench.benchmark = [];
  render({ points: cost, nav: noBench, aumToday: 1, portfolios: PORTFOLIOS }, 'no-benchmark');
  // Low coverage sessions.
  render({ points: cost, nav: mkNav(40, { gapCoverage: true }), aumToday: 1, portfolios: PORTFOLIOS }, 'low-coverage');
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
