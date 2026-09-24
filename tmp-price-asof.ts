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
// The `/*` opener must NOT be preceded by `*`. Without that guard the Accept header
// 'application/json, text/plain, */*' opens a phantom comment at the `/` of `*/*`, and the
// strip then deletes every line up to the NEXT real `*/` - which silently removed a whole
// function and made three unrelated assertions fail. A stripper that eats code is worse than
// no stripper: it makes source assertions pass or fail for reasons that are not in the code.
const strip = (s: string) =>
  s.replace(/(^|[^*])\/\*[\s\S]*?\*\//g, '$1').replace(/^[ \t]*\/\/.*$/gm, '');
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
for (const key of ['unlisted', 'exception', 'notListed', 'noHistory', 'bseOnly', 'beforeHistory', 'noClose']) {
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
// PROVEN 23-Sep-2026 by the two controls: RELIANCE.NS returns candles, 500325.BO (the same
// company on BSE) answers "No data found, symbol may be delisted". A BSE-only scrip therefore
// cannot be fetched at all, and sending the owner to the Price Status tab about it is worse
// than saying nothing.
ok('C9 a BSE-only scrip is told apart from one the price script merely skipped',
  reports.includes("const noColumn = entry?.bse && !entry?.nse ? 'bseOnly' : 'noHistory';"));
ok('C10 ...and the reason says a backfill cannot fix it, plus what does',
  /Re-running the backfill cannot fix these/.test(reports)
  && /putting its NSE symbol on the scrip-master row fixes it immediately/.test(reports));
ok('C11 ...and the Fetch button is not offered for it',
  (() => {
    // Asserted on the CONDITION, not on a comment beside it: comments are stripped before this
    // scan, so a check for the explanatory note could never have matched.
    const at = reports.indexOf('(priceMeta?.blanks || []).some(b =>');
    const cond = at < 0 ? '' : reports.slice(at, at + 140);
    return cond.includes("b.reason === 'noHistory'") && cond.includes("b.reason === 'noClose'")
      && !cond.includes('bseOnly');
  })());

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


// ── H. telling the three 404s apart ──────────────────────────────────────────
//
// The gap-fill came back `60x symbol not found (HTTP 404)` for WELL-FORMED symbols (514010.BO).
// Three faults produce exactly that, and they have nothing in common: the endpoint is blocked
// here, Yahoo serves .NS but not .BO, or those companies genuinely have no candles.
ok('H1 the probe always runs two known-good CONTROLS, one per exchange',
  gs.includes("{ label: 'control NSE', symbol: 'RELIANCE.NS' }")
  && gs.includes("{ label: 'control BSE', symbol: '500325.BO' }"));
// A probe that tested only the failing symbol could not separate any of the three — which is
// exactly why the original 404 was useless.
ok('H2 ...and reaches a verdict naming which of the three it is',
  gs.includes('The candle endpoint is not serving this script AT ALL')
  && gs.includes('Yahoo serves NSE but not BSE from here')
  && gs.includes('Yahoo simply has no candles for'));
ok('H3 ...reporting the response code, candle count and a body snippet',
  gs.includes('row.code = resp.getResponseCode()') && gs.includes('row.candles =')
  && gs.includes('row.body = String(resp.getContentText()'));
ok('H4 ...on its own route, leaving the price probes alone',
  gs.includes("e.parameter.probe === 'hist'") && gs.includes('probeHistory_(e.parameter.sym'));
ok('H5 ...and carries the deploy marker, like every other probe',
  /return \{ ok: true, version: RESOLVER_VERSION_, verdict/.test(gs));

// A malformed symbol is invisible in a list of company names, and is the first thing to rule out.
ok('H6 each failed scrip is reported WITH the symbol that was tried',
  gapFn.includes("affected.push(fa.name + '  [' + fa.symbol + ']')"));
ok('H7 ...and the app prefers that list over the names-only one',
  gapSummary.includes('const affected = r.affected?.length ? r.affected : r.stillMissing;'));


// An unknown probe MUST NOT fall through to the default branch: every probe test above is an
// exact match, so `?probe=hist` against a deployment that predates that probe quietly ran a
// PRICE UPDATE and answered `{ok:true, updated:..}` — which reads as a probe that worked.
// Asserted on the GUARD as well as the message: disabling the `if` left the error string in the
// file and the first version of this check passed with the fall-through fully restored.
// It must be the FIRST branch in doGet, not merely present. Placed last, `probe=hist&sym=...`
// on a deployment predating that probe reached `if (e.parameter.sym)` and answered with the
// SYMBOL RESOLVER — a well-formed reply to a question nobody asked, mistaken for the probe twice.
ok('H8a the unknown-probe guard is the FIRST thing doGet does',
  (() => {
    const at = gs.indexOf('function doGet(e) {');
    const g = gs.indexOf("['hist', 'bse', 'tv', 'nse'].indexOf(String(e.parameter.probe)) < 0");
    return at >= 0 && g > at && g - at < 400;   // no other branch may precede it
  })());
ok('H8 an unrecognised probe is refused, and names the ones this deployment has',
  gs.includes("['hist', 'bse', 'tv', 'nse'].indexOf(String(e.parameter.probe)) < 0")
  && gs.includes("error: 'Unknown probe \"' + e.parameter.probe + '\". This deployment knows: hist, bse, tv, nse. '")
  && gs.includes('the Apps Script editor has newer code than the deployment'));
ok('H9 ...and every response carries the deploy marker, including the default one',
  /\{ ok: true, version: RESOLVER_VERSION_, updated: r\.updated/.test(gs));


// ── I. a full rebuild must not delete what it could not refetch ──────────────
//
// A real `?hist=full` fetched 312 of 391 scrips and took the other 79 columns with it — the feed
// 404ing a symbol today says nothing about the closes already recorded for it, and the tab is the
// only copy. 312/391 is 80%, so the downgrade guard did not (and should not) fire: the answer is
// to PRESERVE the failures, not to abandon the rebuild.
// Sliced FORWARD to the next top-level function: writePriceHistory_ sits AFTER uncoveredNames_
// in the file, so slicing between them by name produced an empty string and two assertions
// passed on nothing.
const wph = gs.slice(gs.indexOf('function writePriceHistory_'),
                     gs.indexOf('function installPriceHistoryTrigger'));
ok('I1 the writer takes the keys to preserve',
  gs.includes('function writePriceHistory_(newCols, byDate, full, keepKeys, fillOnly)'));
ok('I2 ...a full rebuild reads back only those, a merge reads back everything',
  wph.includes('var carryOnly = !!(full && keepKeys);') && wph.includes('if (!full || carryOnly) {'));
ok('I3 ...and the failed keys are what gets passed',
  gs.includes('for (var kf = 0; kf < res.failed.length; kf++) keepKeys[res.failed[kf].key] = true;')
  && gs.includes('writePriceHistory_(cols, byDate, writeFull, keepKeys)'));

// The row read walked the DEDUPED column list while indexing the RAW header position, so one
// duplicate or blank heading shifted every column after it — loading one scrip's closes into
// another scrip's column. Money, wrong, and invisible on the tab.
ok('I4 rows are read by header position, not by deduped position',
  wph.includes('var dst = slotOf[c2 - 1];') && !wph.includes('vals[r][c2 + 1]'));

// A list of company names cannot show that a well-known scrip was sent to the wrong ticker.
ok('I5 every uncovered scrip is named with the symbol that was tried',
  gs.includes("out.push(t.name + '  [' + (t.symbol || '?') + ']')"));
ok('I6 the no-symbol list is deduped', gs.includes('if (!seenNoSym[u.name])'));


// Two runs reported 79 identical 404s and neither could say whether the feed was refusing an
// EXCHANGE or those 79 companies. Counting both sides by suffix answers it from the run itself:
// all-.BO failures beside all-.NS successes is a feed decision, not a per-scrip one.
ok('I7 failures AND successes are counted by exchange suffix',
  gs.includes('function countBySuffix_') && gs.includes('failBySuffix: countBySuffix_(')
  && gs.includes('okBySuffix: countBySuffix_(got)'));
ok('I8 ...on the gap-fill path too', gapFn.includes('out.failBySuffix = countBySuffix_'));
ok('I9 ...and the app prints both sides, because one alone proves nothing',
  gapSummary.includes('By exchange — failed:') && gapSummary.includes('fetched:'));


// ── J. the BSE route ─────────────────────────────────────────────────────────
//
// Yahoo has dropped .BO entirely, so BSE-only scrips need another source. BSE publishes its own
// and api.bseindia.com is already reachable from this script. What must NOT happen is a parser
// written against a guessed response shape — the hand-typed fixture this repo keeps being bitten
// by — so the probe reports what each candidate route actually returns, and nothing is parsed yet.
ok('J1 the probe varies the HEADERS against the download host, not the URL again',
  gs.includes("label: 'api-style (Origin + Referer) - what round two sent'")
  && gs.includes("label: 'browser navigation (no Origin, page Referer)'")
  && gs.includes("label: 'bare (no headers but a UA)'"));
// THE ROUND-TWO OMISSION. A 403 body names what refused it, and capturing it only on a 200 threw
// away the single piece of evidence the failure carried.
ok('J2 ...and captures every response body, not only the successful ones',
  gs.includes('body: r.text.slice(0, 220),') && !gs.includes('if (rb.code === 200 && rb.text) brow.head'));
ok('J3 ...with a liveness control, so "reached BSE and was refused" is not read as "never ran"',
  gs.includes("group: 'control', label: 'StockReachGraph intraday (known to work)'"));
ok('J4 ...still reusing the header recipe the api host is known to accept',
  gs.includes("'Origin': 'https://www.bseindia.com'") && gs.includes('headers: headers || BSE_HEADERS_'));
// The probe must be able to end the investigation, not only continue it.
ok('J5 ...and its verdict names the fallback when BSE has no route at all',
  gs.includes('per-scrip backfill is on.')
  && gs.includes('backfill goes day by day across the whole exchange.')
  && gs.includes('record closes FORWARD from the quote feed.'));
// "Does this URL work from Apps Script?" is a different question from "does it work in my
// browser", and it is the whole story of 24-Sep: the owner's browser downloads BSE's bhavcopy
// while this script gets Access Denied, because the block is on Google's IPs. Every candidate
// source has to be asked from THERE, and each one used to cost a paste-save-run cycle.
ok('J5a a URL can be tested from Apps Script without editing the probe',
  gs.includes('var PROBE_URL_ =') && gs.includes('function runUrlProbe() {'));
ok('J5b ...with two header profiles, because both failing means an IP rule and one working means a header rule',
  gs.includes("label: 'plain (UA only)'") && gs.includes("label: 'browser-shaped'")
  && gs.includes('it is an IP rule and no header will fix it.'));
// Asserted UNCONDITIONAL: wrapping the same line in `if (row.code === 200)` left the text in
// place and `includes` was satisfied by it, which is exactly the omission round two shipped.
ok('J5c ...capturing the body whatever the status, since a 403 body is the only thing that says why',
  (() => {
    const at = gs.indexOf('function runUrlProbe() {');
    const block = at < 0 ? '' : gs.slice(at, gs.indexOf('function runBseHistoryProbe'));
    return block.includes('\n      row.body = body.slice(0, 300);')
      && !/if\s*\([^)]*\)\s*row\.body/.test(block);
  })());
// The web app is deployed "Anyone". A fetch-any-URL route on it would be an open proxy.
ok('J5d ...and it is EDITOR-ONLY, never a doGet route',
  !gs.includes("e.parameter.probe === 'url'") && !gs.includes('probeUrl_(e.parameter'));

// ── the bhavcopy backfill's resume ───────────────────────────────────────────
//
// Measured on the first real run: 350 targets, 13,161 closes over 38 sessions — about 346 a day,
// because roughly four scrips simply do not trade. So "all targets filled" is a test that almost
// never holds, and "any target filled" is useless too, since 350 of them are ALSO Yahoo-fed and
// carry values whether or not the bhavcopy ever ran for that date. Neither can be read off the
// tab, so the run records how far back it reached.
ok('J5e the backfill resumes from a recorded high-water mark',
  gs.includes("var BHAV_MARK_KEY_ = 'BHAV_BACKFILL_OLDEST';")
  && gs.includes('var mark = props.getProperty(BHAV_MARK_KEY_);')
  // The LOOP must start from it. Reading the mark and then walking from `to` anyway leaves every
  // line of this feature present and refetches the same days forever.
  && gs.includes('for (var d = new Date(startAt.getTime());'));
// Written AFTER the single write, or a run that died mid-fetch would be skipped rather than
// repeated — and the whole point of fill-only is that repeating is free. Asserted as "exactly
// once, and after": a stray second assignment before the write satisfied an ordering regex.
ok('J5f ...advanced only after the write lands',
  (() => {
    const setAt = gs.indexOf('props.setProperty(BHAV_MARK_KEY_, firstDone);');
    const writeAt = gs.indexOf('writePriceHistory_(cols, byDate, false, null, true);');
    const once = gs.split('props.setProperty(BHAV_MARK_KEY_').length - 1;
    return setAt > 0 && writeAt > 0 && setAt > writeAt && once === 1;
  })());
ok('J5g ...and it is a HINT — fill-only means a wrong mark costs fetches, not correctness',
  gs.includes('function resetBhavBackfillMark()')
  && gs.includes('writePriceHistory_(cols, byDate, false, null, true)'));
// The cap is measured, not guessed: 40 days took 104s, so ~2.6s a fetch.
// A day cap alone is a guess about the network: 40 days took 104s on one run and 90 days had not
// finished in EIGHT MINUTES on the next. The clock is what makes a run LAND — exceed the limit
// and every fetch already paid for dies in memory with the process.
ok('J5h fetching stops on a TIME budget, not only a day count',
  gs.includes('var BHAV_FETCH_BUDGET_MS = 210 * 1000;')
  && gs.includes("if (new Date().getTime() - t0 > BHAV_FETCH_BUDGET_MS) { stoppedOn = 'time'; remaining++; continue; }"));
// The day cap is deliberately HIGH now: with a clock in place it is a backstop, not the limit,
// so a fast run gets more days and a slow one stops safely without a hand-tuned number.
ok('J5i ...with the day cap left high, as a backstop rather than the real bound',
  gs.includes('var BHAV_DAYS_PER_RUN = 150;'));
ok('J5j ...and the run says which limit stopped it',
  gs.includes("stoppedOn = 'cap'") && gs.includes("stoppedOn = 'time'")
  && gs.includes('stoppedOn: stoppedOn,'));

// ── the daily top-up ─────────────────────────────────────────────────────────
//
// Without it the BSE-only scrips get two years of history and then nothing further — the same
// gap at the recent end that started all of this.
ok('J5k a daily top-up exists and is wired to a trigger',
  gs.includes('function dailyBhavTopUp() {') && gs.includes('function installBhavTopUpTrigger() {')
  && gs.includes('function removeBhavTopUpTrigger() {'));
// ORDER IS THE DESIGN. Yahoo's pass is 19:30; this is 20:30. Fill-only then means Yahoo keeps
// first claim on every cell it can fill, so nothing changes while Yahoo is healthy and the blanks
// simply start coming from here if it is not. A fallback needing no precedence rules.
ok('J5l ...AFTER the Yahoo pass, so Yahoo keeps first claim on every cell',
  /atHour\(20\)\.nearMinute\(30\)[\s\S]{0,120}dailyBhavTopUp|dailyBhavTopUp[\s\S]{0,200}atHour\(20\)\.nearMinute\(30\)/.test(gs)
  && gs.includes("atHour(19).nearMinute(30)"));
// Three sessions, not one: a missed run, a holiday or a late bhavcopy must self-heal unnoticed,
// the same reason the Yahoo pass re-fetches a month.
ok('J5m ...covering several sessions so a missed run heals itself',
  gs.includes('while (weekdays < 3 && back < 10)'));
// The backfill's mark points at the OLDEST date reached walking backwards; the top-up walks the
// newest few. Letting them share it would make each undo the other's progress.
ok('J5n ...and it does not disturb the backfill’s resume mark',
  gs.includes('PropertiesService.getScriptProperties().deleteProperty(BHAV_MARK_KEY_);')
  && gs.includes('if (saved) PropertiesService.getScriptProperties().setProperty(BHAV_MARK_KEY_, saved);'));
// The NSE file is a DIFFERENT shape — keyed on a SYMBOL string, not a numeric SC_CODE — so its
// parser must be written against the real columns.
ok('J5o the NSE header is probed, not assumed',
  gs.includes("label: 'NSE bhavcopy (header only, for the parser)'")
  && gs.includes("samcoBhavUrl_(new Date(2026, 2, 30), 'NSE')"));

// ── a refusal is not a holiday ───────────────────────────────────────────────
//
// Observed an hour after the backfill's ~500 fetches: dates that had returned 460 KB of
// `application/csv` started answering 200 with `text/html` and ZERO bytes. That is throttling.
// Counted as a market holiday it is invisible — and in a DAILY job invisible means it stops
// working and nobody finds out until a report comes back blank.
ok('J5p a throttled response is told apart from a missing session',
  gs.includes("if (/html/i.test(ctype) || (body.length === 0 && ctype.indexOf('csv') < 0)) {")
  && gs.includes('refused++;'));
ok('J5q ...counted separately from holidays in the result',
  gs.includes('holidaysOrMissing: holidays, refused: refused,'));
// A number in a field nobody reads is not a diagnostic.
ok('J5r ...and the note SAYS it when the source is mostly refusing',
  gs.includes('THE SOURCE IS REFUSING US: '));
// The mark would otherwise step past days that were never really read, and fill-only would then
// never revisit them — the one way this design could lose data rather than just time.
ok('J5s ...and the resume mark does not advance over a refused run',
  gs.includes('if (firstDone && !(refused > 0 && refused >= fetched / 2)) props.setProperty(BHAV_MARK_KEY_, firstDone);'));

ok('J6 the route is wired and the unknown-probe guard knows about it',
  gs.includes("e.parameter.probe === 'bse'")
  && gs.includes("['hist', 'bse', 'tv', 'nse'].indexOf(String(e.parameter.probe)) < 0"));
ok('J7 ...and the deploy marker moved with the file',
  gs.includes("RESOLVER_VERSION_ = '2026-09-24 bse history probe'"));
// A trailing underscore makes a function PRIVATE in Apps Script, so it never appears in the
// editor's Run dropdown and is reachable only through a DEPLOYMENT — the one step that had not
// happened on three consecutive attempts, each of which then answered about the old code.
// Named for the SOURCE and the SUBJECT. `testBseProbe` already exists and probes BSE CORPORATE
// ACTIONS; a `runBseProbe` sitting beside it in the Run dropdown was picked by mistake, and its
// well-formed corp-action report looked enough like an answer to be pasted back as one.
ok('J8 both probes have an editor-runnable wrapper with no underscore',
  gs.includes('function runBseHistoryProbe() {') && gs.includes('function runYahooHistoryProbe() {'));
ok('J8b ...and neither collides with the corp-action probe already in that dropdown',
  gs.includes('function testBseProbe() {') && !gs.includes('function runBseProbe() {'));
// BOTH of them, counted WITHIN the wrapper block: `includes` was satisfied by the other
// wrapper's copy when one was deleted, and a file-wide count is satisfied by two unrelated
// functions that log the same way. Neither version could see half the feature going missing.
ok('J9 ...which BOTH log their result, since the editor shows no return value',
  (() => {
    const at = gs.indexOf('function runBseHistoryProbe() {');
    const block = at < 0 ? '' : gs.slice(at, gs.indexOf('function historyFailReason_'));
    return (block.split('Logger.log(JSON.stringify(r, null, 2));').length - 1) === 2;
  })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
