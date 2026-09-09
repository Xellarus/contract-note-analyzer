/**
 * Row navigation: the key mapping, its clamping, and the keys it must NOT claim.
 *
 * The silent failures here are the interesting ones. If `rowNavIntent` returned a move for Tab,
 * the handler would `preventDefault()` it and the user would be TRAPPED in the table with no way
 * out by keyboard — the exact opposite of the feature. If it failed to clamp, the tab stop would
 * point at a row that does not exist and the table would become unreachable by Tab entirely.
 * Neither breaks a build and neither throws.
 *
 * Run: npx tsx tmp-rownav.ts
 */
import io from 'node:fs';
import { rowNavIntent, PAGE_ROWS, ROW_NAV_ATTR } from './src/lib/rowNav';

let pass = 0;
const fails: string[] = [];
const ok = (label: string, cond: any, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fails.push(label + (detail ? '\n       ' + detail : '')); console.log('  FAIL ' + label); }
};
const eq = (label: string, got: any, want: any) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want),
    `got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

const move = (to: number) => ({ kind: 'move', to });
const NONE = { kind: 'none' };

// ── moving ──────────────────────────────────────────────────────────────────────────────────
console.log('\n── moving ' + '─'.repeat(47));
{
  eq('ArrowDown steps one row', rowNavIntent('ArrowDown', 0, 5), move(1));
  eq('ArrowUp steps one row back', rowNavIntent('ArrowUp', 3, 5), move(2));
  eq('Home jumps to the first row', rowNavIntent('Home', 3, 5), move(0));
  eq('End jumps to the last row', rowNavIntent('End', 0, 5), move(4));
  eq(`PageDown jumps ${PAGE_ROWS}`, rowNavIntent('PageDown', 0, 100), move(PAGE_ROWS));
  eq(`PageUp jumps ${PAGE_ROWS} back`, rowNavIntent('PageUp', 50, 100), move(50 - PAGE_ROWS));
  eq('Enter activates the row', rowNavIntent('Enter', 7, 100), { kind: 'activate' });
}

// ── clamping: the ends must not wrap ────────────────────────────────────────────────────────
// A wrap in a 300-row grid is indistinguishable from a mis-tracked index, and one keypress
// teleporting from the bottom to the top reads as a bug.
console.log('\n── clamping ' + '─'.repeat(45));
{
  eq('ArrowDown on the last row stays put', rowNavIntent('ArrowDown', 4, 5), move(4));
  eq('ArrowUp on the first row stays put', rowNavIntent('ArrowUp', 0, 5), move(0));
  eq('PageDown near the end clamps, it does not wrap', rowNavIntent('PageDown', 0, 5), move(4));
  eq('PageUp near the start clamps', rowNavIntent('PageUp', 3, 100), move(0));
  eq('a single-row list has nowhere to go', rowNavIntent('ArrowDown', 0, 1), move(0));
  // A filter can empty the list between render and keypress.
  eq('an EMPTY list yields no intent at all', rowNavIntent('ArrowDown', 0, 0), NONE);
  eq('End on an empty list does not return -1', rowNavIntent('End', 0, 0), NONE);
  eq('Enter on an empty list activates nothing', rowNavIntent('Enter', 0, 0), NONE);
  // A stale index — the list shrank under a filter and a keypress raced the re-render.
  eq('an index past the end is clamped, not trusted', rowNavIntent('ArrowDown', 99, 5), move(4));
  eq('a negative index is clamped too', rowNavIntent('ArrowUp', -3, 5), move(0));
}

// ── keys this must NOT claim ────────────────────────────────────────────────────────────────
console.log('\n── keys left alone ' + '─'.repeat(38));
{
  // THE important one. The handler preventDefaults anything that is not "none", so claiming Tab
  // would trap the user inside the table with no keyboard way out.
  eq('Tab is NOT claimed — it is the only way out of the table', rowNavIntent('Tab', 2, 5), NONE);
  eq('Escape is left to whoever owns it', rowNavIntent('Escape', 2, 5), NONE);
  // Space is page-down everywhere, and the trade book wants it for row selection.
  eq('Space is NOT activate', rowNavIntent(' ', 2, 5), NONE);
  eq('a plain letter falls through to the global shortcuts', rowNavIntent('d', 2, 5), NONE);
  eq('so does the help key', rowNavIntent('?', 2, 5), NONE);
  eq('ArrowLeft is free for column use', rowNavIntent('ArrowLeft', 2, 5), NONE);
  eq('ArrowRight likewise', rowNavIntent('ArrowRight', 2, 5), NONE);
}

// ── the wiring the pure function cannot check ───────────────────────────────────────────────
console.log('\n── wiring ' + '─'.repeat(47));
{
  const src = io.readFileSync(new URL('./src/lib/rowNav.ts', import.meta.url), 'utf8');
  const decomment = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
  const code = decomment(src);

  // Without this guard, ArrowUp inside a row's number input or <select> changes the value AND
  // moves the row — React's onKeyDown bubbles from every descendant.
  ok('the key handler only acts when the ROW itself has focus',
    /if \(e\.target !== e\.currentTarget\) return;/.test(code));
  ok('...and the focus sync is guarded the same way',
    /onFocus: \(e\) => \{ if \(e\.target === e\.currentTarget\)/.test(code));
  ok('a modifier is left to the browser', /e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey/.test(code));
  ok('a move preventDefaults, so the page does not scroll too', /e\.preventDefault\(\)/.test(code));
  ok('the active index is clamped when the row count shrinks',
    /Math\.min\(a, count - 1\)/.test(code));
  ok('scrolling uses block:"nearest", not a jump', /block: "nearest"/.test(code));
  ok('focusIndex bounds itself against the DOM, not the count prop',
    /rows\.length - 1/.test(code));

  // The focus ring has to reach a plain [tabindex] element, or the cards and rows get a tab stop
  // with nothing visible to show it — keyboard navigation you cannot see is not navigation.
  const css = io.readFileSync(new URL('./src/index.css', import.meta.url), 'utf8');
  ok('index.css rings a plain [tabindex] element',
    /\[tabindex\]:not\(\[tabindex="-1"\]\):focus-visible/.test(css));
  ok('...in both themes', /--focus-ring/.test(css) && (css.match(/--focus-ring/g) || []).length >= 3);

  eq('the row marker attribute is what focusFirstRow queries', ROW_NAV_ATTR, 'data-rownav');
}

// ── the integration, and the one silent failure it has ──────────────────────────────────────
// THE BUG THIS SECTION EXISTS FOR: a list whose rows carry rowProps but whose container never
// carries `containerRef`. The rows are focusable and Tab reaches them, so it LOOKS wired — but
// `focusIndex` queries inside the container, finds nothing, and every arrow key is a silent
// no-op. Shipped once during this change (the portfolio cards) and caught by hand.
console.log('\n── consumers ' + '─'.repeat(44));
{
  const decomment = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
  const read = (f: string) =>
    decomment(io.readFileSync(new URL(f, import.meta.url), 'utf8'));

  const CONSUMERS = [
    ['./src/components/Holdings.tsx', 'Holdings (cards + grid)', 2],
    ['./src/components/AllHoldingsTable.tsx', 'AllHoldingsTable', 1],
  ] as const;

  for (const [file, name, expected] of CONSUMERS) {
    const code = read(file);
    const hooks = (code.match(/useRowNav\(/g) || []).length;
    const refs = (code.match(/\.containerRef\b/g) || []).length;
    eq(`${name}: ${expected} list(s) navigable`, hooks, expected);
    // The invariant. One hook, one container — anything else means a list with dead arrow keys.
    eq(`${name}: every hook's container ref is attached`, refs, hooks);
    ok(`${name}: rows carry rowProps`, /rowProps\(/.test(code));
  }

  const hold = read('./src/components/Holdings.tsx');
  const all = read('./src/components/AllHoldingsTable.tsx');

  // A card CONTAINS buttons. role="button" with interactive descendants is invalid ARIA, which is
  // worse than no role — so the card gets tabIndex + aria-label and no role.
  ok('the portfolio card is focusable', /cardNav\.rowProps\(cardIdx/.test(hold));
  ok('...activates on Space as well as Enter, being card-shaped',
    /activateOnSpace: true/.test(hold));
  ok('...and does NOT claim role="button" over its own buttons',
    !/role="button"[\s\S]{0,200}cardNav/.test(hold) && !/cardNav[\s\S]{0,200}role="button"/.test(hold));
  ok('...and is labelled, having no role to announce', /aria-label=\{`Open \$\{portfolioDisplayLabel/.test(hold));

  // A sort header must stay a `columnheader`: aria-sort is only valid on one, and role="button"
  // would replace it. So tabIndex, never role.
  for (const [src, name] of [[hold, 'holdings grid'], [all, 'all-holdings']] as const) {
    ok(`${name} sort headers are focusable`, /tabIndex=\{sortKey \? 0 : undefined\}|<th\s+tabIndex=\{0\}/.test(src));
    ok(`${name} sort headers report direction with aria-sort`, /aria-sort=/.test(src));
  }

  // The trade book deliberately uses plain tab stops, not the hook — its row list is computed
  // below an early return. Still keyboard-operable, and still findable by `l`.
  ok('trade-book rows are focusable', /tabIndex=\{0\}\s*\n\s*data-rownav=""/.test(hold));
  ok('...Space selects only while selecting rows for deletion',
    /const isSpaceSelect = e\.key === ' ' && editMode && selecting;/.test(hold));

  // Focus you cannot see is not navigation.
  const css = io.readFileSync(new URL('./src/index.css', import.meta.url), 'utf8');
  ok('an arrow-focused row rings even before its tabIndex updates',
    /\[data-rownav\]:focus-visible/.test(css));
}

console.log('\n' + '='.repeat(58));
for (const f of fails) console.log('  FAIL ' + f);
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) process.exitCode = 1;
