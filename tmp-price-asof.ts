/**
 * PRICING A PAST POSITION — the two columns the Historical Holding Report gained on 22-Sep-2026.
 *
 * Everything here guards one sentence: a price printed beside a 31-Mar-2025 quantity must be the
 * close of 31-Mar-2025. The failure this suite exists to prevent is not a crash — it is a page on
 * which every figure is plausible, the totals foot, and the prices are from the wrong year.
 *
 *   npx tsx tmp-price-asof.ts
 *
 * Sections:
 *   A  priceAsOf   — the session lookup and the bounded carry, driven directly (pure, no gapi)
 *   B  source      — the wiring the type checker cannot see, over comment-stripped source
 */
import { readFileSync } from 'fs';
import { priceAsOf, EMPTY_GRID, MAX_CARRY_SESSIONS, tsOfYmd, type PriceGrid } from './src/lib/priceGrid';

let pass = 0, fail = 0;
const eq = (label: string, got: any, want: any) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`);
};
const ok = (label: string, cond: boolean) => eq(label, !!cond, true);

// ── A. priceAsOf ─────────────────────────────────────────────────────────────
//
// A hand-built grid rather than a parsed fixture: the parser lives behind gapi, and what is under
// test here is the lookup, not the read. 31-Mar-2025 is deliberately ABSENT — it was an NSE
// holiday (Ramzan Id), and 31-March lands on a non-trading day most years, which is exactly the
// date these reports are run for.
// The grid must be LONGER than the carry bound, or the bound is never reached and the expiry
// below passes for the wrong reason — the first version of this fixture had six sessions against
// a bound of seven and asserted an expiry that could not happen.
const DATES = [
  '2025-03-25', '2025-03-26', '2025-03-27', '2025-03-28',
  '2025-04-01', '2025-04-02', '2025-04-03', '2025-04-04',
  '2025-04-07', '2025-04-08', '2025-04-09', '2025-04-10',
];
const KEYS = ['INE0AAA01011', 'INE0BBB01012', 'INE0CCC01013'];
const CLOSES: (number | null)[][] = [
  //  A       B       C
  [100.5, 200.0, 300.0],   // 25-Mar   C's last ever bar
  [101.5, 201.0, null],    // 26-Mar
  [102.5, 202.0, null],    // 27-Mar
  [103.5, null, null],     // 28-Mar   B has no bar on the session everyone else is priced at
  [104.5, 204.0, null],    // 01-Apr
  [105.5, 205.0, null],    // 02-Apr
  [106.5, 206.0, null],    // 03-Apr
  [107.5, 207.0, null],    // 04-Apr   C: exactly 7 sessions on — still carried
  [108.5, 208.0, null],    // 07-Apr   C: 8 sessions on — expired
  [109.5, 209.0, null],    // 08-Apr
  [110.5, 210.0, null],    // 09-Apr
  [111.5, 211.0, null],    // 10-Apr
];
const grid: PriceGrid = {
  dates: DATES,
  ts: DATES.map(tsOfYmd),
  colIndex: new Map(KEYS.map((k, i) => [k, i])),
  rows: CLOSES,
  indexOf: new Map(DATES.map((d, i) => [d, i])),
};
const [A, B, C] = KEYS;
const at = (ymd: string) => new Date(`${ymd}T23:59:59`).getTime();

// THE CASE THE WHOLE FEATURE TURNS ON. A report headed 31-Mar-2025 must price at the last session
// on or before it — 28-Mar — not fail to match and not reach forward into April.
eq('A1 a report date that is NOT a trading session takes the session BEFORE it',
  priceAsOf(grid, A, at('2025-03-31')), { price: 103.5, sessionDate: '2025-03-28', carried: false });
ok('A2 ...and never the session AFTER it',
  priceAsOf(grid, A, at('2025-03-31')).price !== 104.5);

eq('A3 a report date that IS a session takes that session',
  priceAsOf(grid, A, at('2025-03-27')), { price: 102.5, sessionDate: '2025-03-27', carried: false });

// A blank cell on the resolved session is the scrip not trading, not the scrip being worthless.
eq('A4 a scrip with no bar that session carries back, and SAYS it carried',
  priceAsOf(grid, B, at('2025-03-28')), { price: 202.0, sessionDate: '2025-03-27', carried: true });

// The carry is what stops a suspended or delisted scrip printing a price forever.
eq('A5 the carry expires — a long-dead scrip is unpriced, not stale-priced',
  priceAsOf(grid, C, at('2025-04-10')), { price: null, sessionDate: '', carried: false });
// The boundary, at the DEFAULT bound, which is what production runs on.
eq('A6 ...still carried at exactly the bound (7 sessions on)',
  priceAsOf(grid, C, at('2025-04-04')), { price: 300.0, sessionDate: '2025-03-25', carried: true });
eq('A7 ...and gone one session past it',
  priceAsOf(grid, C, at('2025-04-07')), { price: null, sessionDate: '', carried: false });
eq('A8 the default bound is the one the NAV fill uses', MAX_CARRY_SESSIONS, 7);

// A date the app holds no history for must yield NOTHING. Reaching forward to the grid's first
// session would price a 2019 report at 2025 closes, which is the whole disaster in one cell.
eq('A9 a date BEFORE the grid is unpriced, never the grid’s first close',
  priceAsOf(grid, A, at('2019-01-01')), { price: null, sessionDate: '', carried: false });
// Forward is the opposite case and is correct: "as on today" means the latest close.
eq('A10 a date AFTER the grid clamps to the last session',
  priceAsOf(grid, A, at('2030-01-01')), { price: 111.5, sessionDate: '2025-04-10', carried: false });

eq('A11 a scrip with no column at all is unpriced',
  priceAsOf(grid, 'INE0ZZZ01019', at('2025-03-27')), { price: null, sessionDate: '', carried: false });
eq('A12 an unresolved column key is unpriced (the resolver returns "" for these)',
  priceAsOf(grid, '', at('2025-03-27')), { price: null, sessionDate: '', carried: false });
eq('A13 an empty grid prices nothing rather than throwing',
  priceAsOf(EMPTY_GRID, A, at('2025-03-27')), { price: null, sessionDate: '', carried: false });

// null, not 0. A 0 would foot into Current Value as a real valuation and read as a total loss.
ok('A14 an unpriced result is null — never 0',
  priceAsOf(grid, C, at('2025-04-10')).price === null);

// ── B. source ────────────────────────────────────────────────────────────────
//
// Comments are stripped first: this file and the ones it reads discuss `assetClass` and zero
// fallbacks in prose, and a raw scan would report the documentation as the violation — the trap
// tmp-shortcuts.ts and tmp-date-input.ts already strip for.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const src = (p: string) => strip(readFileSync(p, 'utf8'));

const reports = src('src/components/Reports.tsx');
const holdings = src('src/lib/holdingsCalc.ts');
const history = src('src/lib/priceHistory.ts');
const nav = src('src/lib/navTimeline.ts');

// The price must be asked for at the REPORT's date. `Date.now()` anywhere in this path is the bug.
ok('B1 the pricing pass is handed the report’s own timestamp',
  /priceAsOfDate\(positions,\s*asOfTs,\s*master\)/.test(reports));
ok('B2 ...and priceAsOf is called with that same asOfTs',
  /priceAsOf\(grid,\s*colOf\([^)]*\),\s*asOfTs\)/.test(reports));
ok('B3 ...and nothing in the pricing pass reads the clock',
  !/Date\.now\(\)/.test(reports.slice(reports.indexOf('async function priceAsOfDate'),
                                      reports.indexOf('type Step'))));

// Unlisted-ness is a question about the REPORT's date too. A raw `assetClass` read here would
// re-file a company that has since listed as unlisted for every past year.
ok('B4 the unlisted test is dated, not a raw assetClass read',
  /classOfEntryAsOf\(entry,\s*asOfTs\)/.test(reports));
ok('B5 ...and the pricing pass never touches entry.assetClass',
  !/entry\.assetClass/.test(reports));

// null all the way to the cell. `?? 0` at any point makes a blank read as a worthless holding.
ok('B6 the price cells pass null straight through',
  /cmp:\s*pos\.mktPrice,\s*val:\s*pos\.mktValue/.test(reports));
ok('B7 ...with no zero fallback on either',
  !/mktPrice\s*\?\?\s*0/.test(reports) && !/mktValue\s*\?\?\s*0/.test(reports));
ok('B8 the per-share column gets no total — summing prices means nothing',
  /cells:\s*\{\s*name:\s*'Total'[^}]*cmp:\s*''/.test(reports));

// Seven columns do not fit upright, and the holding branch returns before the generic flip.
ok('B9 the holding document is landscape', /landscape:\s*true/.test(reports));

// THE HOT-PATH GUARD. computeHoldingsAsOf is also what the Add Trade drawer calls per keystroke-
// dated replay; a 165k-cell grid read in there is a quota fault nobody would attribute to this.
ok('B10 computeHoldingsAsOf does NOT read the price grid',
  !/loadPriceGrid|priceHistory/.test(holdings));
ok('B11 ...and the report is where the grid is read',
  /loadPriceGrid\(\)/.test(reports));

// ONE resolver. Two copies drifting is how this repo got four spellings of one read range.
ok('B12 makeColumnResolver is defined once, in priceHistory.ts',
  /export function makeColumnResolver/.test(history));
ok('B13 ...and navTimeline imports it rather than keeping its own',
  !/function makeColumnResolver/.test(nav) && /makeColumnResolver/.test(nav));

// A failed grid read must not fail the report: the cost columns are still valid without it.
ok('B14 an unreadable price history degrades to unpriced, it does not throw',
  /try \{ grid = await loadPriceGrid\(\); \} catch/.test(reports));

// The master is needed for pricing whatever the scope, but a failed read still only refuses a
// SCOPED run — an unpriced consolidated report beats no report.
ok('B15 the holding report always loads the master',
  /needsMaster\s*=\s*!!focus \|\| scopeActive \|\| reportType === 'holding'/.test(reports));

// Every reason a cell is blank is named. A blank column with no explanation is indistinguishable
// from a zero one on a printed page.
for (const [label, re] of [
  ['unlisted holdings', /pm\.unlisted > 0/],
  ['listed but unpriced', /pm\.unpriced\.length > 0/],
  ['carried from an earlier session', /pm\.carried\.length > 0/],
  ['the totals no longer tie', /pm\.unpricedInvested > 0/],
  ['the date precedes the history held', /asOfTs < Date\.parse/],
  ['no price history at all', /if \(!pm\.gridFrom\)/],
] as [string, RegExp][]) {
  ok(`B16 the footnotes disclose: ${label}`, re.test(reports));
}

// A truncated list that does not say it was truncated reads as a complete one.
ok('B17 a long list of names says how many it left out',
  /and \$\{xs\.length - n\} more/.test(reports));

// The person reading the SCREEN is the one deciding whether to export, so the disclosure has to
// reach them too — the footnotes only exist inside the generated file.
// Asserted on the RENDER, not on the call that computes the notes: the first version checked
// only that `buildPriceNotes` was invoked below the table, which a probe that threw the result
// away passed cleanly.
ok('B18 the screen RENDERS the same disclosure the file carries',
  /shown\.map\(\(n, i\) => <p key=\{i\}>\{n\}<\/p>\)/.test(reports)
  && /const shown = priceMeta\?\.gridFrom/.test(reports));
// The leading note is dropped on screen (the As-on date is already visible) — but when there is
// NO price history it is the only note there is, and dropping it would leave the emptiest table
// with no explanation at all.
ok('B19 ...including when the single "no price history" note is all there is',
  /priceMeta\?\.gridFrom \? notes\.slice\(1\) : notes/.test(reports));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
