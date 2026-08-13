/**
 * Verifies the Imports-page rewrite: the Import Log column resolution, row mapping,
 * Rewind eligibility, and the new search / filter behaviour.
 *
 * This is where the risk actually sits. The log has grown from 5 columns to 9, so every
 * column is found BY NAME with a positional fallback — and two of those names collide if
 * the patterns aren't anchored ("Contract Note Name" contains "name"; a loose /date/ would
 * grab a future "Date Added"). Getting `status` wrong is the dangerous one: it writes
 * "Reversed" into whatever column happens to sit at that index.
 */
import {
  resolveImportLogCols, buildImportLogRows, filterImportLogRows, distinctValues,
} from './src/lib/importLogRows';

let fails = 0;
const ok = (c: boolean, label: string, extra = '') => {
  if (!c) { fails++; console.log(`  FAIL  ${label}${extra ? '   ' + extra : ''}`); }
  else console.log(`  ok    ${label}${extra ? '   ' + extra : ''}`);
};
const eq = (a: any, b: any, label: string) =>
  ok(a === b, label, a === b ? '' : `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// The live schema, as accessLog.IMPORT_HEADER writes it.
const FULL = ["Date", "Time", "Contract Note Name", "Broker", "User", "Import ID", "Portfolio", "Rows", "Status"];

console.log('1. Column resolution — the live 9-column header');
{
  const c = resolveImportLogCols(FULL);
  eq(c.date, 0, 'date  → 0');
  eq(c.time, 1, 'time  → 1');
  eq(c.note, 2, 'note  → 2');
  eq(c.broker, 3, 'broker → 3');
  // The collision this test exists for: /name/ unanchored matches "Contract Note Name" (2).
  eq(c.user, 4, 'user  → 4  (NOT 2 — "Contract Note Name" must not win)');
  eq(c.importId, 5, 'importId → 5');
  eq(c.portfolio, 6, 'portfolio → 6');
  eq(c.rows, 7, 'rows → 7');
  eq(c.status, 8, 'status → 8');
}

console.log('\n2. Column resolution — older / odd headers');
{
  // The original 5-column log: no Import ID, no Portfolio, no Rows, no Status.
  const legacy = resolveImportLogCols(["Date", "Time", "Contract Note Name", "Broker", "User"]);
  eq(legacy.user, 4, 'legacy user → 4');
  eq(legacy.importId, -1, 'legacy importId → -1  (no positional guess)');
  eq(legacy.status, -1, 'legacy status → -1  (no positional guess)');
  eq(legacy.portfolio, 6, 'legacy portfolio → 6 fallback (row is short → reads blank)');

  // Columns moved around: everything must follow the NAME, not the position.
  const shuffled = resolveImportLogCols(["Status", "Portfolio", "Broker", "Date", "Time", "User", "Rows", "Import ID", "Contract Note Name"]);
  eq(shuffled.status, 0, 'shuffled status → 0');
  eq(shuffled.portfolio, 1, 'shuffled portfolio → 1');
  eq(shuffled.broker, 2, 'shuffled broker → 2');
  eq(shuffled.date, 3, 'shuffled date → 3');
  eq(shuffled.user, 5, 'shuffled user → 5');
  eq(shuffled.rows, 6, 'shuffled rows → 6');
  eq(shuffled.importId, 7, 'shuffled importId → 7');
  eq(shuffled.note, 8, 'shuffled note → 8');

  // Case and padding must not matter (a hand-edited sheet).
  const messy = resolveImportLogCols(["  date ", "TIME", "contract note name", " Broker", "user", "import id", "PORTFOLIO", "rows", "status"]);
  eq(messy.date, 0, 'messy date → 0');
  eq(messy.user, 4, 'messy user → 4');
  eq(messy.status, 8, 'messy status → 8');

  // No header at all → pure positional fallback, and still no rewind.
  const none = resolveImportLogCols([]);
  eq(none.date, 0, 'empty header date → 0');
  eq(none.rows, 7, 'empty header rows → 7');
  eq(none.importId, -1, 'empty header importId → -1');
}

console.log('\n3. Row mapping');
{
  const cols = resolveImportLogCols(FULL);
  const rows = [
    // oldest first, exactly as fetchImportLog returns them
    ["13 Aug 2026", "10:42 am", "note-A.pdf", "Zerodha", "Arash", "imp-1", "T059", "12", ""],
    ["14 Aug 2026", "09:05 am", "note-B.htm", "Integrated", "Gunjan", "imp-2", "S1404", "3", "Reversed"],
    ["15 Aug 2026", "04:30 pm", "txn-stmt.csv", "Transaction Report", "Arash", "imp-3", "OAEM94", "0", ""],
    ["16 Aug 2026", "11:00 am", "legacy.pdf", "ShareIndia", "Saket"],            // short row, pre-rewind
  ];
  const out = buildImportLogRows(rows, cols, 2);

  eq(out.length, 4, '4 rows in → 4 rows out');
  // Newest first.
  eq(out[0].note, 'legacy.pdf', 'newest first — [0] is the last sheet row');
  eq(out[3].note, 'note-A.pdf', 'oldest last');
  // sheetRow must still point at the ORIGINAL sheet position after the reverse, or the
  // "Reversed" write lands on the wrong import.
  eq(out[0].sheetRow, 5, 'sheetRow survives the reverse — newest is sheet row 5');
  eq(out[3].sheetRow, 2, 'oldest is sheet row 2 (firstDataRow)');

  // Dates render dd/mm/yyyy ([[date-display-format]]) but keep the raw for searching.
  eq(out[3].date, '13/08/2026', 'date formatted dd/mm/yyyy');
  eq(out[3].dateRaw, '13 Aug 2026', 'raw date kept');
  eq(out[3].time, '10:42 am', 'time kept verbatim');

  // Portfolio code → label.
  eq(out[3].portfolio, 'Taparia Holdings', 'T059 → label');
  eq(out[3].portfolioCode, 'T059', 'code kept for the sheet lookup');
  eq(out[1].portfolio, 'Gunjan Agarwal (ShareIndia)', 'OAEM94 → label');

  // Reversed + rewind eligibility.
  eq(out[2].reversed, true, 'Status "Reversed" → reversed');
  eq(out[3].reversed, false, 'blank Status → not reversed');
  eq(out[3].canRewind, true, '12 rows + import id → rewindable');
  eq(out[1].canRewind, false, '0 rows → NOT rewindable');
  eq(out[0].canRewind, false, 'short legacy row (no import id) → NOT rewindable');
  eq(out[0].importId, '', 'missing cell reads as "" not undefined');
  eq(out[0].rows, '', 'missing Rows cell reads as ""');

  // A row with an id but a blank Rows cell stays rewindable (pre-Rows logs) — parity with
  // the behaviour before this rewrite.
  const blankRows = buildImportLogRows([["1 Apr 2026", "9:00 am", "x.pdf", "Zerodha", "A", "imp-9", "T059", "", ""]], cols, 2);
  eq(blankRows[0].canRewind, true, 'blank Rows + import id → still rewindable');

  // Case-insensitive status, and an unknown portfolio code falls back to the code itself.
  const odd = buildImportLogRows([["2 Apr 2026", "9:00 am", "y.pdf", "Zerodha", "A", "imp-8", "ZZ999", "4", "reversed"]], cols, 2);
  eq(odd[0].reversed, true, 'lower-case "reversed" recognised');
  eq(odd[0].portfolio, 'ZZ999', 'unknown code → shown as the code');

  // Empty input must not throw.
  eq(buildImportLogRows([], cols, 2).length, 0, 'no rows → empty');
}

console.log('\n4. Date shapes the log has actually held');
{
  const cols = resolveImportLogCols(FULL);
  const shapes: [string, string][] = [
    ['13 Aug 2026', '13/08/2026'],
    ['13-Aug-2026', '13/08/2026'],
    ['13/08/2026', '13/08/2026'],
    ['2026-08-13', '13/08/2026'],
    ['Aug 13, 2026', '13/08/2026'],
  ];
  for (const [raw, want] of shapes) {
    const r = buildImportLogRows([[raw, '9:00 am', 'n.pdf', 'Zerodha', 'A', 'i', 'T059', '1', '']], cols, 2);
    eq(r[0].date, want, `"${raw}"`);
  }
  // Something unparseable is shown as-is rather than mangled into a wrong date.
  const junk = buildImportLogRows([['sometime', '9:00 am', 'n.pdf', 'Zerodha', 'A', 'i', 'T059', '1', '']], cols, 2);
  eq(junk[0].date, 'sometime', 'unparseable date passes through verbatim');
}

console.log('\n5. Search + filters');
{
  const cols = resolveImportLogCols(FULL);
  const all = buildImportLogRows([
    ["13 Aug 2026", "10:42 am", "TAPARIA-CN-0912.pdf", "Zerodha", "Arash", "i1", "T059", "12", ""],
    ["14 Aug 2026", "09:05 am", "sagun-note.htm", "Integrated", "Gunjan", "i2", "S1404", "3", ""],
    ["15 Aug 2026", "04:30 pm", "gunjan-txns.csv", "Transaction Report", "Arash", "i3", "OAEM94", "40", ""],
    ["16 Aug 2026", "11:00 am", "balaji.pdf", "ShareIndia", "Saket", "i4", "CS1106", "7", ""],
  ], cols, 2);

  const q = (query: string) => filterImportLogRows(all, { query }).map((r) => r.note);

  eq(q('').length, 4, 'empty query → everything');
  eq(q('   ').length, 4, 'whitespace-only query → everything');
  eq(JSON.stringify(q('taparia')), JSON.stringify(['TAPARIA-CN-0912.pdf']), 'note name, case-insensitive');
  eq(JSON.stringify(q('zerodha')), JSON.stringify(['TAPARIA-CN-0912.pdf']), 'by broker');
  eq(JSON.stringify(q('saket')), JSON.stringify(['balaji.pdf']), 'by user');
  eq(JSON.stringify(q('shree balaji')), JSON.stringify(['balaji.pdf']), 'by resolved portfolio LABEL (not just the code)');
  eq(JSON.stringify(q('cs1106')), JSON.stringify(['balaji.pdf']), 'by portfolio code');
  // Both date renderings are searchable.
  eq(JSON.stringify(q('13/08/2026')), JSON.stringify(['TAPARIA-CN-0912.pdf']), 'by formatted date');
  eq(JSON.stringify(q('13 aug')), JSON.stringify(['TAPARIA-CN-0912.pdf']), 'by raw date as typed on the sheet');
  eq(JSON.stringify(q('04:30')), JSON.stringify(['gunjan-txns.csv']), 'by time');
  // Multi-term is AND across fields, in any order.
  eq(JSON.stringify(q('arash zerodha')), JSON.stringify(['TAPARIA-CN-0912.pdf']), 'two terms, different fields → AND');
  eq(JSON.stringify(q('zerodha arash')), JSON.stringify(['TAPARIA-CN-0912.pdf']), 'term order irrelevant');
  eq(q('arash integrated').length, 0, 'AND that matches nothing → empty');
  eq(q('nonesuch').length, 0, 'no match → empty');

  // Dropdown filters are exact, and compose with the query.
  eq(filterImportLogRows(all, { broker: 'Zerodha' }).length, 1, 'broker filter');
  eq(filterImportLogRows(all, { broker: 'zerodha' }).length, 0, 'broker filter is exact, not fuzzy');
  eq(filterImportLogRows(all, { portfolio: 'Sagun Capital' }).length, 1, 'portfolio filter uses the label');
  eq(filterImportLogRows(all, { broker: 'Zerodha', query: 'arash' }).length, 1, 'filter + query together');
  eq(filterImportLogRows(all, { broker: 'Zerodha', query: 'gunjan' }).length, 0, 'filter + query, disjoint');
  eq(filterImportLogRows(all, {}).length, 4, 'no filter at all → everything');

  // Newest-first order survives filtering.
  const twoArash = filterImportLogRows(all, { query: 'arash' }).map((r) => r.note);
  eq(JSON.stringify(twoArash), JSON.stringify(['gunjan-txns.csv', 'TAPARIA-CN-0912.pdf']), 'filtered rows stay newest-first');

  // Dropdown option lists.
  eq(JSON.stringify(distinctValues(all, (r) => r.broker)),
    JSON.stringify(['Integrated', 'ShareIndia', 'Transaction Report', 'Zerodha']), 'brokers deduped + sorted');
  eq(distinctValues(all, (r) => r.portfolio).length, 4, 'four distinct portfolios');
  // Blanks are dropped so the dropdown never shows an empty option.
  const withBlank = buildImportLogRows([["13 Aug 2026", "1:00 pm", "a.pdf", "", "A", "i", "T059", "1", ""]], cols, 2);
  eq(distinctValues(withBlank, (r) => r.broker).length, 0, 'blank broker excluded from the dropdown');
}

console.log('\n6. Browser BACK through the Imports page (appBack depth dispatch)');
{
  // appBack arms itself against the real window, so stub one before importing it.
  const popstate: Array<() => void> = [];
  let pushes = 0;
  (globalThis as any).window = {
    history: { pushState: () => { pushes++; } },
    addEventListener: (ev: string, fn: () => void) => { if (ev === 'popstate') popstate.push(fn); },
  };
  const { registerBackStep } = await import('./src/lib/appBack');
  const pressBack = () => popstate.forEach((fn) => fn());

  // Mirror App.tsx's state and its three registered steps EXACTLY.
  let currentView = 'dashboard';
  let importPageTab: 'history' | 'screener' | 'opening' = 'history';
  let openingSection: 'menu' | 'basis' | 'corp' = 'menu';
  let importFlow: 'notes' | 'txn' | null = null;

  registerBackStep(3, () => currentView === 'imports' && importFlow !== null, () => { importFlow = null; });
  registerBackStep(
    2,
    () => currentView === 'imports' && importPageTab === 'opening' && openingSection !== 'menu',
    () => { openingSection = 'menu'; },
  );
  registerBackStep(1, () => currentView !== 'dashboard', () => { currentView = 'dashboard'; });

  ok(popstate.length === 1, 'appBack armed exactly one popstate listener');
  const state = () => `${currentView}/${importPageTab}/${openingSection}/${importFlow}`;
  const reset = (v: any, t: any, s: any, f: any) => { currentView = v; importPageTab = t; openingSection = s; importFlow = f; };

  // The defect this term was added for: a tool left open on the Opening Basis tab, then a
  // switch to another tab. Without `importPageTab === 'opening'` the depth-2 step is still
  // "active", so Back spends the press resetting state nobody can see.
  reset('imports', 'history', 'basis', null);
  pressBack();
  eq(state(), 'dashboard/history/basis/null', 'stale openingSection on another tab does NOT swallow Back');

  // Same, from the Securities & Prices tab.
  reset('imports', 'screener', 'corp', null);
  pressBack();
  eq(currentView, 'dashboard', 'stale openingSection on Securities & Prices does not swallow Back either');

  // A tool that IS on screen: Back closes it, then the next Back leaves the page.
  reset('imports', 'opening', 'basis', null);
  pressBack();
  eq(state(), 'imports/opening/menu/null', 'Back closes the open Opening Basis tool');
  pressBack();
  eq(currentView, 'dashboard', 'the next Back leaves the Imports page');

  // The upload flow is deeper than the tool: it must unwind first, one level per press.
  reset('imports', 'opening', 'basis', 'txn');
  pressBack();
  eq(state(), 'imports/opening/basis/null', 'Back closes the upload flow before the tool (depth 3 > 2)');
  pressBack();
  eq(state(), 'imports/opening/menu/null', 'then the tool');
  pressBack();
  eq(currentView, 'dashboard', 'then the page');

  // Flow opened from the Imports tab — one press back to the log, one more out.
  reset('imports', 'history', 'menu', 'notes');
  pressBack();
  eq(state(), 'imports/history/menu/null', 'Back from the contract-note flow returns to the log');
  pressBack();
  eq(currentView, 'dashboard', 'and then to the Dashboard');

  // At home, Back runs nothing and must never unload the app — it only re-arms.
  reset('dashboard', 'history', 'menu', null);
  const before = pushes;
  pressBack();
  eq(state(), 'dashboard/history/menu/null', 'Back at the Dashboard is a no-op');
  ok(pushes > before, 'and still re-arms the history trap (Back never leaves the app)');

  // Imports-page steps must not fire from another view, even with stale state.
  reset('holdings', 'opening', 'basis', 'notes');
  pressBack();
  eq(state(), 'dashboard/opening/basis/notes', 'stale imports state is inert while another view is open');
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
