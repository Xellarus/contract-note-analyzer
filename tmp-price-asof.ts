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
  priceAsOf(grid, A, at('2025-03-31')), { price: 103.5, sessionDate: '2025-03-28', carried: false, miss: '' });
ok('A2 ...and never the session AFTER it',
  priceAsOf(grid, A, at('2025-03-31')).price !== 104.5);

eq('A3 a report date that IS a session takes that session',
  priceAsOf(grid, A, at('2025-03-27')), { price: 102.5, sessionDate: '2025-03-27', carried: false, miss: '' });

// A blank cell on the resolved session is the scrip not trading, not the scrip being worthless.
eq('A4 a scrip with no bar that session carries back, and SAYS it carried',
  priceAsOf(grid, B, at('2025-03-28')), { price: 202.0, sessionDate: '2025-03-27', carried: true, miss: '' });

// The carry is what stops a suspended or delisted scrip printing a price forever.
eq('A5 the carry expires — a long-dead scrip is unpriced, not stale-priced',
  priceAsOf(grid, C, at('2025-04-10')), { price: null, sessionDate: '', carried: false, miss: 'no-close' });
// The boundary, at the DEFAULT bound, which is what production runs on.
eq('A6 ...still carried at exactly the bound (7 sessions on)',
  priceAsOf(grid, C, at('2025-04-04')), { price: 300.0, sessionDate: '2025-03-25', carried: true, miss: '' });
eq('A7 ...and gone one session past it',
  priceAsOf(grid, C, at('2025-04-07')), { price: null, sessionDate: '', carried: false, miss: 'no-close' });
eq('A8 the default bound is the one the NAV fill uses', MAX_CARRY_SESSIONS, 7);

// A date the app holds no history for must yield NOTHING. Reaching forward to the grid's first
// session would price a 2019 report at 2025 closes, which is the whole disaster in one cell.
eq('A9 a date BEFORE the grid is unpriced, never the grid’s first close',
  priceAsOf(grid, A, at('2019-01-01')), { price: null, sessionDate: '', carried: false, miss: 'before-history' });
// Forward is the opposite case and is correct: "as on today" means the latest close.
eq('A10 a date AFTER the grid clamps to the last session',
  priceAsOf(grid, A, at('2030-01-01')), { price: 111.5, sessionDate: '2025-04-10', carried: false, miss: '' });

// THE DISTINCTION THE 23-Sep REPORT TURNED ON. "Never fetched" and "has not traded lately" are
// the same empty cell and have nothing to do with each other: one is a configuration gap the
// owner can fix, the other is a fact about the security.
eq('A15 a scrip absent from the grid says NO COLUMN',
  priceAsOf(grid, 'INE0ZZZ01019', at('2025-04-10')).miss, 'no-column');
eq('A16 ...while one present but long silent says NO CLOSE',
  priceAsOf(grid, C, at('2025-04-10')).miss, 'no-close');
eq('A17 ...and a date the history does not reach says so separately',
  priceAsOf(grid, A, at('2019-01-01')).miss, 'before-history');
eq('A18 a priced scrip carries no miss reason at all',
  priceAsOf(grid, A, at('2025-03-27')).miss, '');

eq('A11 a scrip with no column at all is unpriced',
  priceAsOf(grid, 'INE0ZZZ01019', at('2025-03-27')), { price: null, sessionDate: '', carried: false, miss: 'no-column' });
eq('A12 an unresolved column key is unpriced (the resolver returns "" for these)',
  priceAsOf(grid, '', at('2025-03-27')), { price: null, sessionDate: '', carried: false, miss: 'no-column' });
eq('A13 an empty grid prices nothing rather than throwing',
  priceAsOf(EMPTY_GRID, A, at('2025-03-27')), { price: null, sessionDate: '', carried: false, miss: 'no-column' });

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
  ['one line per REASON, naming the holdings under it', /for \(const b of pm\.blanks\)/],
  ['the totals no longer tie', /pm\.unpricedInvested > 0/],
  ['positions older than the report’s own pricing session', /pm\.stale\.length > 0/],
  ['the date precedes the history held', /asOfTs < Date\.parse/],
  ['no price history at all', /if \(!pm\.gridFrom\)/],
  ['which session the report actually priced at', /pm\.pricedOn && pm\.pricedOn !== asOf/],
] as [string, RegExp][]) {
  ok(`B16 the footnotes disclose: ${label}`, re.test(reports));
}

// ── C. WHY a cell is blank ───────────────────────────────────────────────────
//
// Reported 23-Sep-2026 on a real S713 run: 15 of 103 rows blank, and nothing said which were
// expected. An ETF excluded on purpose, a pre-IPO allotment, and a listed company the price
// script has never fetched are the same empty cell with three different remedies.

// The reason is IN the cell, not only in a footnote — a reader should not have to cross-reference
// a 15-name list to find out whether one row is fine.
ok('C1 the Current Value cell carries the reason when there is no figure',
  /val: pos\.mktValue === null \? pos\.blankReason : pos\.mktValue/.test(reports));
ok('C2 ...and the Current PRICE cell is not given a reason too (a reason is not a price)',
  /cmp: pos\.mktPrice,/.test(reports));

// Order is load-bearing: a scrip with no exchange code is ALSO absent from the grid, so asking
// the grid first would tell the owner to go debug the price script for a company that has not
// IPO'd. The specific fact wins over the general one.
ok('C3 the scrip-master reasons are decided BEFORE the grid is consulted',
  /const r = fromMaster \? null : priceAsOf\(/.test(reports));
ok('C4 "not listed" is "no NSE and no BSE code", which is exactly what the price script skips on',
  /!\(entry\?\.nse \|\| entry\?\.bse\) \? 'notListed'/.test(reports));
ok('C5 a deliberate Price Exception is told apart from a failure',
  /entry\?\.priceExcept \? 'exception'/.test(reports));

// No regex here on purpose: two earlier attempts at this check were defeated by escaping
// (a backticked pattern turns  into a backspace) and reported all six reasons missing
// while every one of them was present. A check that cannot pass is worse than no check.
const blankBlock = reports.slice(reports.indexOf('const BLANK:'),
                                 reports.indexOf('async function priceAsOfDate'));
for (const key of ['unlisted', 'exception', 'notListed', 'noHistory', 'beforeHistory', 'noClose']) {
  const at = blankBlock.indexOf(key + ': {');
  const seg = at < 0 ? '' : blankBlock.slice(at, at + 600);
  ok(`C6 a labelled, explained reason exists for: ${key}`,
    at >= 0 && seg.includes("label: '") && seg.includes("why: '"));
}
// The one the owner asked for by name, and the one that is actionable.
ok('C7 "not listed" says the IPO has not happened, and what to do if it since has',
  /IPO has not happened yet/.test(reports) && /re-run the price-history backfill/.test(reports));
ok('C8 "no price history" says it is a CONFIGURATION gap, not an absent price',
  /a configuration gap rather than an absent price/.test(reports));

// ── D. the report's own pricing session ──────────────────────────────────────
//
// The as-on date can resolve to a nearly-empty grid row — a holiday row, or a top-up that ran
// before the close — and then EVERY holding is "carried by one session". The 31-Mar-2026 run
// flagged 86 of 103 positions, which is a disclosure nobody reads.
ok('D1 the report computes the session MOST positions were priced from',
  /const tally = new Map<string, number>\(\)/.test(reports) && /let pricedOn = ''/.test(reports));
ok('D2 ...breaking ties towards the LATER session, so a thin day cannot win on count alone',
  /n === best && d > pricedOn/.test(reports));
ok('D3 ...and flags only what is older than THAT, not older than the as-on date',
  /p\.priceDate < pricedOn/.test(reports));

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


// ── E. filling the gaps ──────────────────────────────────────────────────────
//
// 23-Sep-2026: "we need to figure out a way to add the price history of those stocks which were
// trading and present on that day". The existing `?hist=full` is not that — it REBUILDS the tab,
// refetches everything, and skips the very scrips that are missing. None of this can be exercised
// without a live Sheets + Yahoo, so what is pinned here is the handful of properties whose
// failure would be silent and destructive.
const gs = src('apps-script/YahooPriceUpdate.gs');
const gapFn = gs.slice(gs.indexOf('function backfillMissingHistory'),
                       gs.indexOf('function updatePriceHistory'));

// THE ONE THAT MATTERS. `writePriceHistory_(cols, byDate, full)` with full=true rebuilds the tab
// from only the scrips in this run — a gap-fill that erased every other column would look like a
// successful run, and the tab is the only copy of that history.
ok('E1 the gap-fill MERGES, it does not rebuild the tab',
  gapFn.includes('writePriceHistory_(cols, byDate, false)'));
ok('E2 ...while the full backfill is still the one that rebuilds',
  gs.includes('function backfillPriceHistory() { return priceHistoryLocked_(CONFIG.HISTORY_RANGE, true); }'));

// A scrip with no ticker can never be fetched, so re-running is futile — the owner has to put the
// exchange code on the master row. That list used to be a bare count.
ok('E3 scrips with no resolvable ticker are NAMED, not just counted',
  gapFn.includes('noSymbol.push(u.name)') && gapFn.includes('noSymbolNames:'));
ok('E4 ...and the full pass names them too, where it only counted before',
  gs.includes('noSymbolNames.length < 60'));

// Bounded, or a large gap list dies mid-run against the 6-minute limit.
ok('E5 the run is capped and says what it held back',
  gapFn.includes('HISTORY_GAP_CAP') && gapFn.includes('remaining'));
// Re-derived from the tab each call, which is what makes a second run continue rather than repeat.
ok('E6 the gap set is read back off the tab, not remembered',
  gapFn.includes('firstByKey') && gapFn.includes('CONFIG.HISTORY_TAB'));
// A column that merely starts late is a different case and is not chased by default: a company
// that genuinely listed recently would be refetched on every run for nothing.
ok('E7 late-starting columns need the deep pass, and are reported either way',
  gapFn.includes('if (!deep) continue;') && gapFn.includes('lateNames:'));
ok('E8 the route is wired, with deep and cap',
  gs.includes("e.parameter.hist === 'missing'") && gs.includes("e.parameter.deep === '1'"));
ok('E9 it reports the deploy marker, so "not fixed" and "not deployed" stay distinguishable',
  gapFn.includes('version: RESOLVER_VERSION_'));

// App side: the button is offered only where a fetch could actually help, and the summary must
// keep "fetched" and "can never be fetched" apart.
ok('E10 the button is offered only for the blanks a fetch can fix',
  reports.includes("b.reason === 'noHistory' || b.reason === 'noClose'"));
ok('E11 ...and never without a web app configured', reports.includes('hasYahooWebApp() &&'));
// Scoped to the summary FUNCTION, not the whole file: the same phrase appears in the `BLANK`
// table, so a file-wide search passed cleanly with the summary's own copy deleted.
const gapSummary = reports.slice(reports.indexOf('function describeGapFix'),
                                 reports.indexOf('const nameSome'));
ok('E12 the summary names the scrips no backfill can help, and why',
  gapSummary.includes('no NSE or BSE code for') && gapSummary.includes('before fetching anything'));
ok('E13 ...and says to generate the report again, since the grid changed under it',
  gapSummary.includes('Generate the report again'));
ok('E14 the price cache is dropped after the grid is written',
  reports.includes('invalidatePriceCache();'));


// ── F. the Transferred badge ─────────────────────────────────────────────────
//
// 23-Sep-2026: "in the app you have mentioned it in buy its good but for the ui purpose only also
// add a transfered small logo just like buy beside the green buy logo". A TAXABLE cross-portfolio
// transfer is written as an ordinary Sell + Buy, so the receiving row says "Buy" and is right to
// — the only surviving marker is the note the transfer tool wrote.
const schema = src('src/lib/tradeRowSchema.ts');
const hold = src('src/components/Holdings.tsx');

// Display only. If anything about valuation, tax or the replay keyed off a NOTE, a hand-typed
// note would start moving filed figures.
ok('F1 the marker is a separate helper, not a widening of isTransferType',
  schema.includes('export const isTransferLeg') && schema.includes('XFER_NOTE_RE'));
ok('F2 isTransferType still matches only the two real transfer TYPES',
  schema.includes('return XFER_OUT_RE.test(t) || XFER_IN_RE.test(t);'));
ok('F3 no tax or valuation engine consults the note-based one',
  !src('src/lib/trxRegister.ts').includes('isTransferLeg')
  && !src('src/lib/navTimeline.ts').includes('isTransferLeg')
  && !src('src/lib/openingBasis.ts').includes('isTransferLeg'));
// holdingsCalc DOES call it — once, and only to LIST the rows that still need a demat date so
// the rebuild can name them. It must never reach the row's classification: `xfer`, which decides
// whether the same-day square-off leaves a row alone, stays on the TYPE. A hand-typed note would
// otherwise start moving positions.
{
  const calc = src('src/lib/holdingsCalc.ts');
  ok('F3b ...and holdingsCalc calls it exactly once, to list rows, never to classify one',
    (calc.split('isTransferLeg(').length - 1) === 1
    && /if \(isTransferLeg\(r\[typeIdx\], notesIdx >= 0 \? r\[notesIdx\] : ""\)\) \{/.test(calc)
    && /const xfer = isTransferType\(r\[typeIdx\]\);/.test(calc));
}

// All four phrasings the transfer tool writes, and nothing else.
const xfer = src('src/lib/transferHolding.ts');
for (const phrase of ['Transferred to ', 'Transferred from ', 'Bought from ', 'Sold to ']) {
  ok(`F4 the note the tool writes is still matched: "${phrase.trim()}"`, xfer.includes(phrase));
}
ok('F5 the pattern is anchored at the start and on a word boundary',
  /^const XFER_NOTE_RE = \/\^/m.test(schema)
  && /sold.s.to\).b\/i;$/m.test(schema));

// Not shown beside a badge that already says "Transfer In" — that reads as a duplicate.
ok('F6 the badge is suppressed where the type already says transfer',
  hold.includes('!isTransferType(t.transactionType) && isTransferLeg(t.transactionType, t.notes)'));
ok('F7 ...and carries the note itself as its tooltip',
  hold.includes("title={t.notes || 'Written by the cross-portfolio transfer tool'}"));


// ── G. WHY the feed returned nothing ─────────────────────────────────────────
//
// 23-Sep-2026: a real run fetched 0 of 60 scrips and reported "No scrip was missing a
// price-history column" — the opposite of the truth — while `parseHistory_` collapsed a
// rate-limit, a missing symbol and an empty series into one `null`.
ok('G1 a failed candle fetch records WHY, per response code',
  gs.includes("if (code === 429) return 'rate limited (HTTP 429)'")
  && gs.includes("if (code === 404) return 'symbol not found (HTTP 404)'")
  && gs.includes("return 'no candles in this range'"));
ok('G2 ...and the reasons are grouped with a count and an example',
  gs.includes('function groupFailReasons_') && gapFn.includes('out.failReasons = groupFailReasons_'));
ok('G3 ...a throttled batch backs off instead of poisoning the rest of the run',
  gs.includes('if (throttled) { Utilities.sleep(2000); throttled = false; }'));

// Writing ~330 columns x ~500 rows to add nothing is a large pointless write against the only
// copy of this history, and a partial failure in it is unrecoverable.
ok('G4 a run that fetched nothing does not touch the tab at all',
  /var written = \{ dates: 0, cols: 0 \};\s*\n\s*if \(got\.length > 0\) \{/.test(gapFn));

// THE DESTRUCTIVE ONE. `?hist=full` REBUILDS: every column not in this run's results disappears.
// The same 0-of-60 failure through that path would have emptied the entire history.
ok('G5 a FULL rebuild that lost most of its fetches is downgraded to a merge',
  gs.includes('if (writeFull && got.length < Math.ceil(targets.length * 0.6))')
  && gs.includes('downgradedToMerge = true'));
ok('G6 ...and says so, rather than reporting a successful rebuild',
  gs.includes('rebuilt: writeFull, downgradedToMerge: downgradedToMerge'));

// The summary must not call "nothing was fetched" the same thing as "nothing was missing".
ok('G7 the summary tells those two apart',
  gapSummary.includes("tried === 0") && gapSummary.includes('No scrip was missing a price-history column.')
  && gapSummary.includes('the feed returned data for none of them'));
ok('G8 ...and says nothing was written when nothing was',
  gapSummary.includes('Nothing was written to the price history.'));
ok('G9 ...and names the reason, with retry advice only when it IS a feed refusal',
  gapSummary.includes("parts.push('Why: '")
  && /429\|blocked\|HTTP 5/.test(gapSummary));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
