// Verify the holdings-grid comparator by EXTRACTING it from Holdings.tsx, not by retyping it -
// a retyped copy would prove my arithmetic and miss a typo in the file that actually ships.
//
// Also asserts the declared DEFAULTS in the source, so "biggest first on load" is checked
// against the file rather than assumed.
import fs from 'node:fs';

const SRC = new URL("./src/components/Holdings.tsx", import.meta.url);
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fails.push(label + (detail ? '\n       ' + detail : '')); console.log('  FAIL ' + label); }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

// ── the declared defaults ───────────────────────────────────────────────────────────────────
ok('default sortField is currentValue',
  /useState<'symbol' \| 'quantity' \| 'avgCost' \| 'currentPrice' \| 'currentValue' \| 'profit'>\('currentValue'\)/.test(src));
ok('default sortDirection is desc',
  /const \[sortDirection, setSortDirection\] = useState<'asc' \| 'desc'>\('desc'\)/.test(src));
ok('a numeric column starts descending on first click',
  /setSortDirection\(field === 'symbol' \? 'asc' : 'desc'\)/.test(src));

// ── extract the comparator body verbatim, brace-matched ─────────────────────────────────────
const HEAD = 'const sortedHoldings = [...filteredHoldings].sort((a, b) => {';
const i = src.indexOf(HEAD);
ok('comparator located in the source', i >= 0);
let body = null;
if (i >= 0) {
  let d = 1, j = i + HEAD.length;
  for (; j < src.length && d > 0; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') d--;
  }
  body = src.slice(i + HEAD.length, j - 1);
}
ok('comparator body extracted', !!body && body.includes('localeCompare'));

// Strip the TS-only bits (`: any`, `as keyof DisplayHolding`) so plain node can run it.
const js = body
  .replace(/let (aVal|bVal): any/g, 'let $1')
  .replace(/ as keyof DisplayHolding/g, '');

const makeCmp = (sortField, sortDirection) =>
  new Function('sortField', 'sortDirection', `return (a, b) => {${js}};`)(sortField, sortDirection);

const h = (name, currentValue, quantity = 1, unrealizedGain = 0) =>
  ({ name, symbol: name.slice(0, 4), currentValue, quantity, unrealizedGain,
     avgCost: 1, currentPrice: 1 });

// ── the ask: biggest first ──────────────────────────────────────────────────────────────────
{
  const rows = [h('Zydus', 500_000), h('Alpha', 9_00_00_000), h('Mid Co', 25_00_000)];
  const out = [...rows].sort(makeCmp('currentValue', 'desc')).map(r => r.name);
  eq('biggest holding first, smallest last', out, ['Alpha', 'Mid Co', 'Zydus']);
}
// Clicking again must reverse it, not re-sort arbitrarily.
{
  const rows = [h('Zydus', 500_000), h('Alpha', 9_00_00_000), h('Mid Co', 25_00_000)];
  const out = [...rows].sort(makeCmp('currentValue', 'asc')).map(r => r.name);
  eq('asc reverses it', out, ['Zydus', 'Mid Co', 'Alpha']);
}
// ── the unsynced portfolio: every row Rs 0 (holdings-no-mock-data) ──────────────────────────
{
  const rows = [h('Zydus Wellness', 0), h('Alpha Industries', 0), h('Mid Co', 0)];
  const out = [...rows].sort(makeCmp('currentValue', 'desc')).map(r => r.name);
  eq('all-zero rows fall back to A-Z, not build order',
    out, ['Alpha Industries', 'Mid Co', 'Zydus Wellness']);
}
// A genuine tie between two priced holdings.
{
  const rows = [h('Zeta', 10_00_000), h('Beta', 10_00_000), h('Alpha', 50_00_000)];
  const out = [...rows].sort(makeCmp('currentValue', 'desc')).map(r => r.name);
  eq('ties break A-Z beneath the bigger holding', out, ['Alpha', 'Beta', 'Zeta']);
}
// The tiebreaker must NOT flip with the direction - A-Z either way, or a re-click shuffles
// equal rows for no reason.
{
  const rows = [h('Zeta', 0), h('Beta', 0)];
  eq('tiebreaker stays A-Z in asc too',
    [...rows].sort(makeCmp('currentValue', 'asc')).map(r => r.name), ['Beta', 'Zeta']);
}
// ── the text column still sorts A-Z, and a discrepancy row still sorts ──────────────────────
{
  const rows = [h('Zydus', 1), h('Alpha', 2)];
  eq('Security Name asc is still A-Z',
    [...rows].sort(makeCmp('symbol', 'asc')).map(r => r.name), ['Alpha', 'Zydus']);
}
{
  // A negative-quantity discrepancy row must not be dropped or crash the sort.
  const rows = [h('Good Co', 10_00_000, 100), h('Discrepancy Co', 0, -500)];
  const out = [...rows].sort(makeCmp('currentValue', 'desc')).map(r => r.name);
  eq('a discrepancy row sorts to the bottom, not out', out, ['Good Co', 'Discrepancy Co']);
}

// ── the Portfolios page (currentView 'holdings' is titled "Portfolios") ─────────────────────
// The cards were rendered in registry order; they now sort by each book's current value.
{
  // Anchored on the literal source text, so if the expression is edited these indexOf lookups
  // fail and the suite says so - rather than testing a comparator this file made up.
  const CARD_MAP = '.map((p) => ({ p, summary: getPortfolioSummary(p.id) }))';
  const CARD_CMP = '(a, b) => b.summary.currentValue - a.summary.currentValue';
  const mapAt = src.indexOf(CARD_MAP);
  const sortAt = src.indexOf('.sort(' + CARD_CMP + ')');

  ok('portfolio cards sort on summary.currentValue', sortAt >= 0);
  ok('the summary is computed once per card, in a .map()', mapAt >= 0);
  // THE structural assertion. `PORTFOLIOS.sort(...)` would sort the module-level registry IN
  // PLACE, silently reordering it for every dropdown, the importer and the Dashboard as a side
  // effect of rendering one page. Mapping first means .sort() only touches the new array.
  ok('the sort follows that .map(), so PORTFOLIOS is never sorted in place',
    mapAt >= 0 && sortAt > mapAt && (sortAt - mapAt) < 900,
    `map at ${mapAt}, sort at ${sortAt}`);
  ok('and nothing anywhere calls PORTFOLIOS.sort()', !/\bPORTFOLIOS\s*\.\s*sort\s*\(/.test(src));

  const cardCmp = new Function('return ' + CARD_CMP + ';')();
  const book = (id, currentValue) => ({ p: { id }, summary: { currentValue } });

  eq('the biggest book is listed first',
    [book('t059', 4_00_00_000), book('s713', 90_00_00_000), book('c087', 12_00_00_000)]
      .sort(cardCmp).map(b => b.p.id),
    ['s713', 'c087', 't059']);

  // Cold load: nothing synced, every card reports 0. Ties MUST keep registry order (sort is
  // stable per ES2019), so the page opens looking exactly as it did before rather than
  // re-alphabetising itself and then moving again as each sheet arrives.
  eq('an unsynced page keeps registry order, card for card',
    [book('t059', 0), book('s713', 0), book('c087', 0), book('s1404', 0)]
      .sort(cardCmp).map(b => b.p.id),
    ['t059', 's713', 'c087', 's1404']);

  // A sheet Google refuses reports 0 - it must sink, not error or jump to the top.
  eq('a no-access book sinks to the bottom',
    [book('blocked', 0), book('real', 5_00_000)].sort(cardCmp).map(b => b.p.id),
    ['real', 'blocked']);
}

console.log('='.repeat(58));
for (const f of fails) console.log('  FAIL ' + f);
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) process.exitCode = 1;
