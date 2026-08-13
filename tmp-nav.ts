/**
 * Tests for the pieces that decide whether the new charts tell the truth:
 * the flow-adjusted (time-weighted) index, the bounded price fill, and the session lookups.
 */
import { applyTwr, type NavPoint } from './src/lib/navMath';
import { fillColumn, sessionIndexAsOf, sessionIndexOnOrAfter, tsOfYmd, type PriceGrid } from './src/lib/priceGrid';

let fails = 0;
const ok = (c: boolean, label: string, extra = '') => {
  if (!c) { fails++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`); }
  else console.log(`  ok    ${label}${extra ? '  ' + extra : ''}`);
};
const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

const pt = (nav: number, flow = 0): NavPoint =>
  ({ ts: 0, nav, cost: 0, coverage: 1, discrepancy: 0, flow, index: null });

// ── 1. time-weighted index ──────────────────────────────────────────────────
console.log('\n1. applyTwr — flows must not read as performance');
{
  // Pure price movement: 100 -> 110 is +10%.
  const s = [pt(100), pt(110)];
  applyTwr(s);
  ok(s[0].index === 1000, 'first holding session anchors at 1000', String(s[0].index));
  ok(close(s[1].index!, 1100), '+10% price move -> 1100', String(s[1].index));
}
{
  // THE headline case: NAV doubles purely because ₹100 of new capital arrived.
  const s = [pt(100), pt(200, 100)];
  applyTwr(s);
  ok(close(s[1].index!, 1000), 'NAV doubling from a pure INFLOW is 0% return', String(s[1].index));
}
{
  // A withdrawal must likewise be neutral.
  const s = [pt(100), pt(50, -50)];
  applyTwr(s);
  ok(close(s[1].index!, 1000), 'NAV halving from a pure OUTFLOW is 0% return', String(s[1].index));
}
{
  // Inflow AND a gain: put in 100, book grows to 220 => underlying earned 10%.
  const s = [pt(100), pt(220, 100)];
  applyTwr(s);
  ok(close(s[1].index!, 1200), 'inflow + 20 of real gain -> +20%', String(s[1].index));
}
{
  // Naive rebasing would report +120% here. Prove the two differ, i.e. the bug is real.
  const naive = 220 / 100 * 1000;
  const s = [pt(100), pt(220, 100)];
  applyTwr(s);
  ok(Math.abs(naive - s[1].index!) > 500, 'naive NAV rebasing would be wildly different', `naive=${naive} twr=${s[1].index}`);
}
{
  // Compounding across three sessions with a flow in the middle.
  const s = [pt(100), pt(110), pt(232, 100)];   // +10%, then (232-100)/110 = +20%
  applyTwr(s);
  ok(close(s[2].index!, 1320, 1e-6), 'returns compound across a flow session', String(s[2].index));
}
{
  // Fully exited then redeployed: the redeployment is not a return.
  const s = [pt(100), pt(0, -100), pt(500, 500)];
  applyTwr(s);
  ok(close(s[2].index!, 1000), 'exit then redeploy is not a gain', String(s[2].index));
}
{
  // No position yet -> no index at all (rather than a fake 1000 on an empty book).
  const s = [pt(0), pt(0), pt(100)];
  applyTwr(s);
  ok(s[0].index === null && s[1].index === null, 'index stays null while nothing is held');
  ok(s[2].index === 1000, 'index starts when the first position appears');
}
{
  // A flow bigger than the whole book must not produce a negative or NaN index.
  const s = [pt(100), pt(10, 200)];
  applyTwr(s);
  ok(s[1].index !== null && isFinite(s[1].index!) && s[1].index! > 0,
     'a flow exceeding the book leaves a finite positive index', String(s[1].index));
}

// ── 2. bounded forward fill ─────────────────────────────────────────────────
console.log('\n2. fillColumn — the two bounds that stop a 10x lie');
const mkGrid = (col: (number | null)[]): PriceGrid => {
  const dates = col.map((_, i) => `2025-04-${String(i + 1).padStart(2, '0')}`);
  return {
    dates,
    ts: dates.map(tsOfYmd),
    colIndex: new Map([['K', 0]]),
    rows: col.map(v => [v]),
    indexOf: new Map(dates.map((d, i) => [d, i])),
  };
};
{
  const g = mkGrid([100, null, null, 105]);
  const f = fillColumn(g, 'K', new Set(), 7);
  ok(f.values[1] === 100 && f.values[2] === 100, 'gaps carry the last close forward');
  ok(f.carried[1] && f.carried[2] && !f.carried[0], 'carried flags mark inferred values');
  ok(f.observed === 2, 'observed counts only real closes', String(f.observed));
}
{
  // A boundary at index 2 (a split ex-date). Carrying 100 past it would value post-split shares
  // at the pre-split price.
  const g = mkGrid([100, null, null, null, 12]);
  const f = fillColumn(g, 'K', new Set([2]), 7);
  ok(f.values[1] === 100, 'carries UP TO the boundary');
  ok(f.values[2] === null, 'does NOT carry across a corporate-action boundary');
  ok(f.values[3] === null, 'stays unpriced after the boundary until a real close');
  ok(f.values[4] === 12, 'resumes at the next observed close');
}
{
  const g = mkGrid([100, null, null, null, null, null]);
  const f = fillColumn(g, 'K', new Set(), 2);
  ok(f.values[1] === 100 && f.values[2] === 100, 'carries up to maxCarry sessions');
  ok(f.values[3] === null && f.values[5] === null, 'stops carrying past maxCarry (no phantom value)');
}
{
  const g = mkGrid([null, null, 50]);
  const f = fillColumn(g, 'K', new Set(), 7);
  ok(f.values[0] === null && f.values[1] === null, 'leading blanks are NULL, never 0');
  ok(f.values[2] === 50, 'first real close lands');
}
{
  const g = mkGrid([1, 2, 3]);
  const f = fillColumn(g, 'MISSING', new Set(), 7);
  ok(f.values.every(v => v === null), 'a key with no column is entirely unpriced');
  ok(f.observed === 0, 'no observations for a missing column');
}

// ── 3. session lookups ──────────────────────────────────────────────────────
console.log('\n3. session index lookups — event dates never land on a session by luck');
{
  // Sessions Mon 7 Apr .. Fri 11 Apr, then Mon 14 (a weekend gap).
  const dates = ['2025-04-07', '2025-04-08', '2025-04-09', '2025-04-10', '2025-04-11', '2025-04-14'];
  const g: PriceGrid = {
    dates, ts: dates.map(tsOfYmd), colIndex: new Map(), rows: dates.map(() => []),
    indexOf: new Map(dates.map((d, i) => [d, i])),
  };
  ok(sessionIndexAsOf(g, tsOfYmd('2025-04-09')) === 2, 'as-of an exact session date');
  ok(sessionIndexAsOf(g, tsOfYmd('2025-04-12')) === 4, 'as-of a SATURDAY falls back to Friday', String(sessionIndexAsOf(g, tsOfYmd('2025-04-12'))));
  ok(sessionIndexAsOf(g, tsOfYmd('2025-04-01')) === -1, 'as-of before the grid is -1');
  ok(sessionIndexAsOf(g, tsOfYmd('2025-05-01')) === 5, 'as-of after the grid clamps to the last session');
  ok(sessionIndexOnOrAfter(g, tsOfYmd('2025-04-12')) === 5, 'on-or-after a SATURDAY lands on Monday', String(sessionIndexOnOrAfter(g, tsOfYmd('2025-04-12'))));
  ok(sessionIndexOnOrAfter(g, tsOfYmd('2025-04-07')) === 0, 'on-or-after an exact date is that date');
  ok(sessionIndexOnOrAfter(g, tsOfYmd('2025-04-01')) === 0, 'on-or-after before the grid is the first session');
  ok(sessionIndexOnOrAfter(g, tsOfYmd('2025-05-01')) === -1, 'on-or-after past the grid is -1');
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
