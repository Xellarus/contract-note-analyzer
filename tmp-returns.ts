/**
 * Verifies the headline return figures: XIRR (money-weighted) and CAGR (time-weighted).
 *
 * These are single numbers someone will quote out loud, so the bar is exact arithmetic against
 * hand-checkable cases — not "looks plausible". The XIRR cases are cross-checked against the
 * closed-form answer where one exists, and against Excel's XIRR convention (actual/365,
 * discounted from the first flow) where it doesn't.
 */
import { xirr, npv, type CashFlow } from './src/lib/xirr';
import {
  cagrPct, pickEndpoints, yearsBetween, computeReturns, MIN_YEARS_TO_ANNUALISE,
} from './src/lib/returns';
import type { NavPoint } from './src/lib/navMath';

let fails = 0;
const ok = (c: boolean, label: string, extra = '') => {
  if (!c) { fails++; console.log(`  FAIL  ${label}${extra ? '   ' + extra : ''}`); }
  else console.log(`  ok    ${label}${extra ? '   ' + extra : ''}`);
};
const near = (a: number | null, b: number, tol: number, label: string) =>
  ok(a !== null && Math.abs(a - b) < tol, label, a === null ? 'got null' : `got ${a.toFixed(6)} want ${b}`);
const eq = (a: any, b: any, label: string) =>
  ok(a === b, label, a === b ? '' : `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const DAY = 86400000;
const d = (iso: string) => Date.parse(iso + 'T00:00:00Z');

console.log('1. XIRR — cases with a known closed-form answer');
{
  // Exactly one year, doubling: the rate must be exactly 100%.
  near(xirr([{ ts: d('2024-01-01'), amount: -1000 }, { ts: d('2024-12-31'), amount: 2000 }]).rate,
    1.0, 1e-6, '−1000 → +2000 over exactly 365 days = 100%');

  // Exactly one year, +10%.
  near(xirr([{ ts: d('2024-01-01'), amount: -100000 }, { ts: d('2024-12-31'), amount: 110000 }]).rate,
    0.10, 1e-6, '−100k → +110k over 365 days = 10%');

  // Two years, doubling → √2 − 1 = 41.4214%. Uses 730 days to stay exactly 2×365.
  near(xirr([{ ts: d('2024-01-01'), amount: -1000 }, { ts: d('2025-12-31'), amount: 2000 }]).rate,
    Math.SQRT2 - 1, 1e-6, 'doubling over exactly 2 years = √2−1 (41.4214%)');

  // Half a year, +10% → (1.1)^2 − 1 = 21%. 182.5 days is exactly half of 365.
  near(xirr([{ ts: d('2024-01-01'), amount: -1000 }, { ts: d('2024-01-01') + 182.5 * DAY, amount: 1100 }]).rate,
    0.21, 1e-6, '+10% over exactly half a year annualises to 21%');

  // A loss must come back negative, not as a magnitude.
  near(xirr([{ ts: d('2024-01-01'), amount: -1000 }, { ts: d('2024-12-31'), amount: 750 }]).rate,
    -0.25, 1e-6, '−1000 → +750 over a year = −25%');

  // Break-even is exactly zero, not a tiny residual.
  near(xirr([{ ts: d('2020-01-01'), amount: -5000 }, { ts: d('2026-01-01'), amount: 5000 }]).rate,
    0, 1e-9, 'money back with no gain = 0% however long it took');
}

console.log('\n2. XIRR — the solved rate really does zero the NPV');
{
  // Irregular multi-flow series, the realistic shape: several buys, a partial sell, a close.
  const flows: CashFlow[] = [
    { ts: d('2021-06-14'), amount: -250000 },
    { ts: d('2022-02-01'), amount: -180000 },
    { ts: d('2022-11-09'), amount: 95000 },
    { ts: d('2023-07-21'), amount: -400000 },
    { ts: d('2024-03-05'), amount: 220000 },
    { ts: d('2026-08-14'), amount: 900000 },
  ];
  const r = xirr(flows);
  ok(r.rate !== null, 'irregular 6-flow series solves', r.rate === null ? '' : `${(r.rate * 100).toFixed(4)}%`);
  ok(Math.abs(npv(flows, r.rate!)) < 1e-4, 'NPV at the solved rate is zero', `npv=${npv(flows, r.rate!).toExponential(2)}`);

  // Order must not matter — the solver sorts.
  const shuffled = [flows[3], flows[0], flows[5], flows[1], flows[4], flows[2]];
  near(xirr(shuffled).rate, r.rate!, 1e-9, 'input order is irrelevant');

  // Scaling every flow by a constant cannot change a RATE.
  const scaled = flows.map((f) => ({ ...f, amount: f.amount * 137 }));
  near(xirr(scaled).rate, r.rate!, 1e-9, 'scaling all flows ×137 leaves the rate unchanged');

  // Many flows (a real ledger has thousands) — must still converge.
  const many: CashFlow[] = [];
  for (let i = 0; i < 2000; i++) many.push({ ts: d('2021-01-01') + i * 3 * DAY, amount: -1000 });
  many.push({ ts: d('2021-01-01') + 2000 * 3 * DAY, amount: 2600000 });
  const big = xirr(many);
  ok(big.rate !== null && Math.abs(npv(many, big.rate!)) < 1e-2, '2001-flow series converges',
    big.rate === null ? '' : `${(big.rate * 100).toFixed(3)}%`);
}

console.log('\n3. XIRR — refusals and caveats (never invent a number)');
{
  const one = xirr([{ ts: d('2024-01-01'), amount: -100 }]);
  eq(one.rate, null, 'a single flow has no rate');
  eq(xirr([]).rate, null, 'no flows at all');
  eq(xirr([{ ts: d('2024-01-01'), amount: -100 }, { ts: d('2025-01-01'), amount: -50 }]).rate, null,
    'all money out, nothing back → null');
  eq(xirr([{ ts: d('2024-01-01'), amount: 100 }, { ts: d('2025-01-01'), amount: 50 }]).rate, null,
    'all money in, nothing invested → null');
  eq(xirr([{ ts: d('2024-01-01'), amount: -100 }, { ts: d('2024-01-01'), amount: 150 }]).rate, null,
    'every flow on one date → no time base, null');
  ok(!!xirr([{ ts: d('2024-01-01'), amount: -100 }, { ts: d('2025-01-01'), amount: 150 }]).note === false,
    'a clean solve carries no complaint');

  // Zero-amount rows are noise from the ledger, not flows.
  near(xirr([
    { ts: d('2024-01-01'), amount: -1000 }, { ts: d('2024-06-01'), amount: 0 },
    { ts: d('2024-12-31'), amount: 2000 },
  ]).rate, 1.0, 1e-6, 'zero-amount rows are ignored, not counted as flows');

  // Capital fully out and back in → several mathematically valid rates. Flag, don't hide.
  const inOut = xirr([
    { ts: d('2020-01-01'), amount: -1000 },
    { ts: d('2021-01-01'), amount: 1200 },
    { ts: d('2022-01-01'), amount: -800 },
    { ts: d('2023-01-01'), amount: 1000 },
  ]);
  ok(inOut.rate !== null, 'in-and-out series still solves');
  eq(inOut.ambiguous, true, 'and is flagged ambiguous (running balance crosses zero twice)');

  const simple = xirr([
    { ts: d('2020-01-01'), amount: -1000 }, { ts: d('2021-01-01'), amount: -500 },
    { ts: d('2023-01-01'), amount: 2200 },
  ]);
  eq(simple.ambiguous, undefined, 'a conventional buy-buy-close series is NOT flagged');

  // AN ACTIVE TRADING ACCOUNT. Hundreds of buys and sells alternating all year — the naive
  // "count sign changes in the flows" test fires on every single account like this, making the
  // caveat noise. Norstrøm's criterion looks at the running BALANCE instead: while the account
  // stays net invested the balance never crosses zero, so the root is provably unique.
  const active: CashFlow[] = [];
  let day = d('2025-04-01');
  for (let i = 0; i < 400; i++) {
    day += 2 * DAY;
    // Buy bigger than the matching sell, so the account is always net long — as a real book is.
    active.push({ ts: day, amount: -(100000 + (i % 7) * 1000) });
    active.push({ ts: day + DAY, amount: 95000 + (i % 5) * 900 });
  }
  active.push({ ts: day + 30 * DAY, amount: 3_500_000 });        // closing value
  const heavy = xirr(active);
  ok(heavy.rate !== null, '800-trade year solves', heavy.rate === null ? '' : `${(heavy.rate * 100).toFixed(2)}%`);
  eq(heavy.ambiguous, undefined, 'and is NOT flagged — trading a lot is not the same as capital leaving');
  ok(Math.abs(npv(active, heavy.rate!)) < 1e-2, 'NPV still zeroes across 801 flows');

  // Genuinely liquidated and re-funded → correctly flagged. Written as explicit amounts so the
  // running balance is readable: −1.0m → +0.4m → −0.5m → +0.3m, i.e. it crosses zero THREE times.
  // (Selling everything is not enough on its own; what makes the root non-unique is the balance
  // going back NEGATIVE afterwards.)
  const liquidated: CashFlow[] = [
    { ts: d('2025-04-01'), amount: -1_000_000 },
    { ts: d('2025-10-01'), amount: 1_400_000 },
    { ts: d('2026-01-01'), amount: -900_000 },
    { ts: d('2026-08-01'), amount: 800_000 },
  ];
  eq(xirr(liquidated).ambiguous, true, 'but a real liquidate-and-refund IS flagged');

  // A near-total loss must not blow up the solver.
  const wipeout = xirr([{ ts: d('2024-01-01'), amount: -1000000 }, { ts: d('2025-01-01'), amount: 1 }]);
  ok(wipeout.rate !== null && wipeout.rate < -0.99, 'a near-total loss solves to ≈ −100%',
    wipeout.rate === null ? '' : `${(wipeout.rate * 100).toFixed(4)}%`);
}

console.log('\n4. CAGR arithmetic');
{
  near(cagrPct(1000, 2000, 1), 100, 1e-9, 'double in a year = 100%');
  near(cagrPct(1000, 2000, 2), (Math.SQRT2 - 1) * 100, 1e-9, 'double in two years = 41.4214%');
  near(cagrPct(1000, 1000, 5), 0, 1e-9, 'flat = 0% however long');
  near(cagrPct(1000, 500, 1), -50, 1e-9, 'halve in a year = −50%');
  near(cagrPct(1000, 1610.51, 5), 10, 1e-3, '1.1^5 over five years = 10%');
  eq(cagrPct(0, 2000, 1), null, 'zero start index → null, not Infinity');
  eq(cagrPct(1000, 0, 1), null, 'zero end index → null');
  eq(cagrPct(1000, 2000, 0), null, 'zero elapsed time → null, not division by zero');
  eq(cagrPct(-100, 2000, 1), null, 'negative index → null');
  near(yearsBetween(d('2024-01-01'), d('2024-12-31')), 1, 1e-9, '365 days = exactly 1 year');
}

console.log('\n5. Endpoint selection — the guard that protects the whole number');
{
  const pt = (iso: string, nav: number, index: number | null, coverage = 1): NavPoint =>
    ({ ts: d(iso), nav, cost: nav, coverage, discrepancy: 0, flow: 0, index });

  // Clean series: endpoints are simply the ends.
  const clean = [pt('2025-04-01', 100, 1000), pt('2025-10-01', 110, 1100), pt('2026-04-01', 120, 1200)];
  const e1 = pickEndpoints(clean)!;
  ok(!!e1, 'clean series has endpoints');
  eq(e1.start.ts, d('2025-04-01'), 'start = first session');
  eq(e1.end.ts, d('2026-04-01'), 'end = last session');
  eq(e1.trimmedStart, false, 'nothing trimmed at the start');
  eq(e1.trimmedEnd, false, 'nothing trimmed at the end');

  // THE CASE THIS EXISTS FOR: a partly-priced last session. Its NAV is understated because an
  // unpriced holding contributes nothing, so using it would report a fake collapse.
  const badEnd = [pt('2025-04-01', 100, 1000), pt('2026-03-31', 120, 1200), pt('2026-04-01', 70, 700, 0.6)];
  const e2 = pickEndpoints(badEnd)!;
  eq(e2.end.ts, d('2026-03-31'), 'a 60%-priced final session is stepped over');
  eq(e2.trimmedEnd, true, 'and the trim is reported');
  near(cagrPct(e2.start.index!, e2.end.index!, yearsBetween(e2.start.ts, e2.end.ts)), 20.0, 0.15,
    'so the CAGR is the true ~20%, not the ~−30% the bad endpoint would have given');

  // Same at the front.
  const badStart = [pt('2025-04-01', 60, 1000, 0.5), pt('2025-04-02', 100, 1000), pt('2026-04-02', 120, 1200)];
  const e3 = pickEndpoints(badStart)!;
  eq(e3.start.ts, d('2025-04-02'), 'a half-priced first session is stepped over');
  eq(e3.trimmedStart, true, 'and reported');

  // Sessions before the index starts are not endpoints.
  const lateIndex = [pt('2025-04-01', 0, null), pt('2025-04-02', 100, 1000), pt('2026-04-02', 130, 1300)];
  eq(pickEndpoints(lateIndex)!.start.ts, d('2025-04-02'), 'a null index cannot be an endpoint');

  // Too little to measure between.
  eq(pickEndpoints([]), null, 'empty series → null');
  eq(pickEndpoints([pt('2025-04-01', 100, 1000)]), null, 'one session → null');
  eq(pickEndpoints([pt('2025-04-01', 100, 1000, 0.2), pt('2026-04-01', 120, 1200, 0.3)]), null,
    'nothing meets the coverage bar → null, rather than a number built on gaps');
}

console.log('\n6. computeReturns — assembly, guards and the benchmark');
{
  const pt = (iso: string, nav: number, index: number | null, coverage = 1): NavPoint =>
    ({ ts: d(iso), nav, cost: nav, coverage, discrepancy: 0, flow: 0, index });

  // Two years, index 1000 → 1210 = exactly 10% a year.
  const total = [pt('2024-08-14', 1000000, 1000), pt('2025-08-14', 1100000, 1100), pt('2026-08-14', 1210000, 1210)];
  const flows = new Map<string, CashFlow[]>([
    ['a', [{ ts: d('2024-08-14'), amount: -1000000 }]],
  ]);
  const res = computeReturns({
    total,
    byPortfolio: [{ id: 'a', label: 'Alpha', points: total }],
    benchmark: [
      { ts: d('2024-08-14'), index: 1000 }, { ts: d('2025-08-14'), index: 1050 }, { ts: d('2026-08-14'), index: 1102.5 },
    ],
    flowsById: flows,
  });

  near(res.total.cagrPct, 10, 1e-6, 'total CAGR = 10%/yr');
  near(res.total.cumulativePct, 21, 1e-6, 'total cumulative = 21%');
  near(res.total.years, 2, 1e-6, 'window is 2 years');
  near(res.benchmarkCagrPct, 5, 1e-6, 'benchmark CAGR = 5%/yr');
  near(res.excessCagrPct, 5, 1e-6, 'excess = +5%/yr');
  eq(res.byPortfolio.length, 1, 'one portfolio row');
  eq(res.byPortfolio[0].label, 'Alpha', 'portfolio label carried through');
  near(res.byPortfolio[0].cagrPct, 10, 1e-6, 'per-portfolio CAGR');

  // XIRR: −1,000,000 in, closing value 1,210,000 two years later → exactly 10%.
  near(res.total.xirrPct, 10, 1e-4, 'XIRR = 10% (terminal value appended from the NAV endpoint)');
  eq(res.total.terminalValue, 1210000, 'terminal value = NAV at the endpoint');
  eq(res.total.xirrFlowCount, 1, 'one real cash flow (terminal is added, not counted)');

  // Under a year: cumulative yes, annualised no.
  const stub = [pt('2026-04-01', 1000000, 1000), pt('2026-07-01', 1150000, 1150)];
  const short = computeReturns({ total: stub, byPortfolio: [], flowsById: new Map() });
  near(short.total.cumulativePct, 15, 1e-6, 'short window still reports cumulative +15%');
  eq(short.total.cagrPct, null, 'but is NOT annualised under a year');
  ok(short.total.notes.some((n) => /not annualised/.test(n)), 'and says why', short.total.notes[0]);
  ok(MIN_YEARS_TO_ANNUALISE === 1, 'the annualisation floor is one year');

  // A portfolio with no history must degrade to nulls, not throw.
  const none = computeReturns({ total: [], byPortfolio: [{ id: 'z', label: 'Zed', points: [] }], flowsById: new Map() });
  eq(none.total.cagrPct, null, 'no NAV history → null CAGR');
  eq(none.total.xirrPct, null, 'and null XIRR');
  eq(none.byPortfolio[0].notes[0], 'no NAV history', 'with a plain reason');
  eq(none.benchmarkCagrPct, null, 'no benchmark either');

  // The terminal value must come from the TRIMMED endpoint, not the raw last session — else a
  // partly-priced final day understates what the book is worth and drags XIRR down.
  const trimmed = [pt('2024-08-14', 1000000, 1000), pt('2026-08-14', 1210000, 1210), pt('2026-08-15', 700000, 700, 0.5)];
  const tr = computeReturns({
    total: trimmed, byPortfolio: [],
    flowsById: new Map([['a', [{ ts: d('2024-08-14'), amount: -1000000 }]]]),
  });
  eq(tr.total.terminalValue, 1210000, 'terminal value ignores the partly-priced last session');
  near(tr.total.xirrPct, 10, 1e-3, 'so XIRR stays 10% instead of collapsing');
  ok(tr.total.notes.some((n) => /trimmed/.test(n)), 'and the trim is disclosed');

  // XIRR reaching back before the NAV series is normal — and must be called out, because the
  // two numbers then cover different periods.
  const deep = computeReturns({
    total,
    byPortfolio: [],
    flowsById: new Map([['a', [
      { ts: d('2019-01-01'), amount: -500000 },
      { ts: d('2024-08-14'), amount: -1000000 },
    ]]]),
  });
  ok(deep.total.notes.some((n) => /reaches back further/.test(n)),
    'XIRR predating the NAV series is disclosed');
  ok(deep.total.xirrFromTs === d('2019-01-01'), 'and its true start date is reported');
}

console.log('\n7. Coverage bar is RELATIVE to the book — the regression that broke the live panel');
{
  const pt = (iso: string, nav: number, index: number | null, coverage = 1): NavPoint =>
    ({ ts: d(iso), nav, cost: nav, coverage, discrepancy: 0, flow: 0, index });

  // THE LIVE BUG. One holding with no price column anywhere drags EVERY session's coverage to
  // 94%. Against a flat 98% bar not one session qualified, so the whole book reported "no
  // measurable window" — while its individual portfolios, which didn't hold that scrip, were
  // fine. A permanently missing holding understates both ends alike, so it barely touches a
  // RATIO; it must not veto the measurement.
  const always94 = [
    pt('2025-04-01', 1000000, 1000, 0.94),
    pt('2025-10-01', 1100000, 1100, 0.94),
    pt('2026-04-01', 1210000, 1210, 0.94),
  ];
  const ep = pickEndpoints(always94);
  ok(ep !== null, 'a book priced 94% on EVERY session still has a window (old code: null)');
  eq(ep?.start.ts, d('2025-04-01'), 'and uses its true first session');
  eq(ep?.end.ts, d('2026-04-01'), 'and its true last');
  near(ep ? ep.medianCoverage : null, 0.94, 1e-9, 'median coverage reported for disclosure');
  near(ep ? ep.coverageSkew : null, 0, 1e-9, 'no skew between endpoints — nothing to distort');

  const r = computeReturns({ total: always94, byPortfolio: [], flowsById: new Map() });
  near(r.total.cagrPct, 21, 1e-6, 'so the CAGR computes — exactly 21%/yr over the one-year window');
  ok(r.total.notes.some((n) => /94\.0% of the book is priced/.test(n)),
    'and the understatement is disclosed, not hidden', r.total.notes.find((n) => /priced/.test(n)));

  // But a session priced WORSE than the book's own norm is still stepped over: that is a
  // coverage CHANGE, which is what actually corrupts a ratio.
  const dip = [pt('2025-04-01', 1000000, 1000, 0.94), pt('2026-03-31', 1210000, 1210, 0.94), pt('2026-04-01', 700000, 700, 0.62)];
  const ep2 = pickEndpoints(dip)!;
  eq(ep2.end.ts, d('2026-03-31'), 'a 62% session in a 94% book is still rejected as an endpoint');
  eq(ep2.trimmedEnd, true, 'and reported as trimmed');

  // A genuinely well-priced book keeps the original strict behaviour.
  const clean = [pt('2025-04-01', 100, 1000, 1), pt('2026-04-01', 120, 1200, 1), pt('2026-04-02', 90, 900, 0.95)];
  eq(pickEndpoints(clean)!.end.ts, d('2026-04-01'), 'in a 100%-priced book, 95% is still not good enough');

  // Below the floor nothing is measurable, and it says so in plain numbers.
  const sparse = [pt('2025-04-01', 100, 1000, 0.5), pt('2026-04-01', 120, 1200, 0.55)];
  eq(pickEndpoints(sparse), null, 'a book half-priced throughout is refused outright');
  const sr = computeReturns({ total: sparse, byPortfolio: [], flowsById: new Map() });
  ok(/only 5[0-9]% of the book is priced/.test(sr.total.notes[0]),
    'and the refusal names the actual coverage', sr.total.notes[0]);
  near(sr.total.medianCoverage, 0.525, 1e-9, 'diagnostics survive the refusal');
  eq(sr.total.sessionCount, 2, 'as does the session count');

  // Endpoint skew is measured and surfaced rather than silently tolerated.
  const skew = [
    pt('2025-04-01', 1000000, 1000, 0.99),
    pt('2025-08-01', 1050000, 1050, 0.94), pt('2025-12-01', 1100000, 1100, 0.94),
    pt('2026-02-01', 1150000, 1150, 0.94), pt('2026-04-01', 1210000, 1210, 0.94),
  ];
  const ep3 = pickEndpoints(skew)!;
  ok(ep3 !== null && ep3.start.coverage === 0.99 && ep3.end.coverage === 0.94,
    'both endpoints clear the median-relative bar, so the pair IS measured');
  near(ep3.coverageSkew, 0.05, 1e-9, 'a 5pp endpoint gap is measured');
  const sk = computeReturns({ total: skew, byPortfolio: [], flowsById: new Map() });
  ok(sk.total.notes.some((n) => /5\.0pp of pricing coverage/.test(n)),
    'and disclosed with its size', sk.total.notes.find((n) => /pp/.test(n)));

  // Empty / degenerate inputs give a REASON, never a bare "no measurable window".
  const none = computeReturns({ total: [], byPortfolio: [], flowsById: new Map() });
  eq(none.total.notes[0], 'no NAV history', 'no history says so');
  const one = computeReturns({ total: [pt('2025-04-01', 100, 1000)], byPortfolio: [], flowsById: new Map() });
  eq(one.total.notes[0], 'only one usable session so far', 'a single session says so');
  const noIndex = computeReturns({
    total: [pt('2025-04-01', 0, null), pt('2025-04-02', 0, null)], byPortfolio: [], flowsById: new Map(),
  });
  eq(noIndex.total.notes[0], 'no session has both a value and a started index', 'an unstarted index says so');
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
