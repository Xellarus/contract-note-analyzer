/**
 * Native input affordances that change a figure behind your back — and the sweeps that pin them.
 *
 * Two families live here because they are the same kind of bug: the browser does something to a
 * field that no `tsc`, no `vite build` and no other test in this repo can see, and the altered
 * value reaches a FILED TAX TAB looking exactly like a typed one. Sections A-E are the date
 * input; section F is the number input's stepper.
 *
 * The bug this exists for (reported 14-Sep-2026, Add Trade line date): a native date input
 * reports `value === ""` for every INTERMEDIATE state while it is typed into, so
 * `value={stored || fallback}` recomputes the fallback on the first keystroke, React sees a
 * value that differs from the DOM's current "", writes it back, and wipes the segment just
 * typed. The field snaps to the default date on every keypress.
 *
 * Neither `tsc` nor `vite build` can see any of this, and there is no browser in the loop —
 * so the rule is pinned twice: behaviourally on `dateInputValue`, and as a SOURCE sweep, so a
 * date input added next year cannot reintroduce it quietly.
 *
 * Run: npx tsx tmp-date-input.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dateInputValue, isDateInputSane, DATE_INPUT_MIN, DATE_INPUT_MAX } from './src/lib/dates';

let pass = 0;
const failures: string[] = [];
function eq(label: string, fn: () => any, expected: any): void {
  let actual: any;
  try { actual = fn(); }
  catch (e: any) { failures.push(`${label} — threw: ${e?.message || e}`); return; }
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; return; }
  failures.push(`${label}\n     expected ${JSON.stringify(expected)}\n     actual   ${JSON.stringify(actual)}`);
}
function ok(label: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; return; }
  failures.push(`${label}${detail ? `\n     ${detail}` : ''}`);
}

const DEFAULT = '2024-01-08';   // the drawer's date, as in the screenshot

// ── A. dateInputValue: the lifecycle of one line's date field ───────────────────────────────

// Untouched and empty — the line follows the drawer's date. This is the behaviour the `||`
// was there for, and it must survive the fix.
eq('A1 an untouched empty field shows the default', () => dateInputValue('', DEFAULT, false), DEFAULT);

// THE BUG. First keystroke: the browser holds a partial date, so onChange delivered "".
// Rendering the default here is what wiped the digit the user had just typed.
eq('A2 MID-TYPING the field renders EMPTY, not the default', () => dateInputValue('', DEFAULT, true), '');

// Typing completes — the input yields a real date and it is shown as typed.
eq('A3 a completed date is shown as typed', () => dateInputValue('2025-06-30', DEFAULT, true), '2025-06-30');

// A line that already carries its own date keeps it across re-mounts, flag or no flag.
eq('A4 a stored date wins over the default even untouched', () => dateInputValue('2025-06-30', DEFAULT, false), '2025-06-30');

// Blur clears the flag when the field is empty, and THAT is the only way back to the default.
eq('A5 clearing + blurring hands the line back to the default', () => dateInputValue('', DEFAULT, false), DEFAULT);

// With no drawer date there is nothing to fall back to, and it must not invent one.
eq('A6 no default and nothing typed is empty, not undefined', () => dateInputValue('', '', false), '');

// The invariant underneath all of it: while touched, the rendered value is EXACTLY what is
// stored. Any divergence is React writing over the DOM mid-keystroke.
ok('A7 while touched, rendered === stored for every input',
  ['', '2', '2025-06-30', '0'].every(v => dateInputValue(v, DEFAULT, true) === v));

// ── B. Source sweep: no date input anywhere may carry a fallback in `value` ─────────────────

const SRC = join(process.cwd(), 'src');
const tsxFiles: string[] = [];
(function walk(dir: string) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.tsx')) tsxFiles.push(p);
  }
})(SRC);

ok('B1 the sweep found source files to scan', tsxFiles.length > 0, `found ${tsxFiles.length}`);

/**
 * Comments, gone, BEFORE anything is scanned.
 *
 * `Holdings.tsx` carries a doc comment containing a literal `<input type="date">` as prose.
 * Scanned raw, this sweep reports that DOCUMENTATION as an unbounded, unguarded input — which
 * is worse than silence, because it sends the next reader to a line with no code on it. Same
 * trap `tmp-shortcuts.ts` already strips for, and it fired here the moment section D was added.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Every `<input …>` element in a file, as raw text. */
const inputElements = (src: string): string[] => {
  const out: string[] = [];
  const re = /<input\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // To the element's own '>' — brace-aware, so a '>' inside a {…} expression is not the end.
    let depth = 0;
    let i = m.index;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
};

/** The `value={…}` expression of one element, braces balanced. "" when there is none. */
const valueExpr = (el: string): string => {
  const at = el.search(/\bvalue=\{/);
  if (at < 0) return '';
  let i = el.indexOf('{', at), depth = 0;
  const start = i;
  for (; i < el.length; i++) {
    if (el[i] === '{') depth++;
    else if (el[i] === '}') { depth--; if (depth === 0) break; }
  }
  return el.slice(start + 1, i);
};

const offenders: string[] = [];
let dateInputs = 0;
for (const f of tsxFiles) {
  const src = stripComments(readFileSync(f, 'utf8'));
  for (const el of inputElements(src)) {
    if (!/type=["']date["']/.test(el)) continue;
    dateInputs++;
    const v = valueExpr(el);
    // `?? ''` is harmless — it falls back to the EMPTY string, which is what the DOM already
    // holds mid-typing, so React never writes over the node. Only a non-empty fallback bites.
    const stripped = v.replace(/\?\?\s*(''|"")/g, '');
    if (/\|\||\?\?/.test(stripped)) {
      offenders.push(`${f.replace(process.cwd(), '.')} → value={${v.trim()}}`);
    }
  }
}

ok('B2 the sweep actually found the app\'s date inputs', dateInputs >= 5, `found ${dateInputs}`);
ok('B3 NO date input falls back to a non-empty value — that wipes the segment being typed',
  offenders.length === 0, offenders.join('\n     '));

// The fixed input must still be the guarded shape, not merely fallback-free: a date field
// showing a default needs the onBlur, or an emptied line can never return to "(default)".
{
  const src = readFileSync(join(SRC, 'components', 'AddTradeModal.tsx'), 'utf8');
  const el = inputElements(src).find(e => /type=["']date["']/.test(e) && /dateInputValue/.test(e)) || '';
  ok('B4 the line date input uses the shared helper', !!el);
  ok('B5 ...sets the touched flag as it is typed into', /dateSet:\s*true/.test(el), el.slice(0, 200));
  ok('B6 ...and clears it on blur, the only route back to the default',
    /onBlur=/.test(el) && /dateSet:\s*false/.test(el), el.slice(0, 300));
}

// ── C. isDateInputSane: the six-digit year ──────────────────────────────────────────────────
//
// Reported 16-Sep-2026 on the Add Trade line date. A native date input's year segment is not
// four digits — the HTML date range runs to 275760-09-13 — so one keystroke too many turns
// 21-11-2025 into 21-11-20251. What comes out is a WELL-FORMED date string, so nothing
// downstream rejects it: it reaches the sheet, parses as a year twenty thousand years away,
// falls outside every FY the register knows, and the row disappears off the tab it belonged on.

// The empty string MUST pass. It is what the DOM reports for every intermediate typing state,
// and rejecting it would re-open the wipe that section A exists to prevent.
eq('C1 an empty value passes — it is what a half-typed field reports', () => isDateInputSane(''), true);
eq('C2 an ordinary date passes', () => isDateInputSane('2025-11-21'), true);
eq('C3 the lower bound passes', () => isDateInputSane(DATE_INPUT_MIN), true);
eq('C4 the upper bound passes', () => isDateInputSane(DATE_INPUT_MAX), true);
// THE BUG: the fifth digit.
eq('C5 a FIVE-digit year is rejected', () => isDateInputSane('20251-11-21'), false);
eq('C6 a six-digit year is rejected', () => isDateInputSane('202511-11-21'), false);
eq('C7 the HTML maximum is rejected', () => isDateInputSane('275760-09-13'), false);
// A leading-plus form is what some engines emit for expanded years.
eq('C8 an expanded-year form is rejected', () => isDateInputSane('+020251-11-21'), false);
eq('C9 a three-digit year is rejected too', () => isDateInputSane('202-11-21'), false);
eq('C10 junk is rejected', () => isDateInputSane('not a date'), false);

// The guard must REJECT, never rewrite: returning a clamped string from onChange would write a
// non-empty value over a half-typed field, which is the original bug wearing a different hat.
ok('C11 the guard is a predicate, not a transformer', typeof isDateInputSane('2025-11-21') === 'boolean');

ok('C12 the bounds are four-digit years — Chrome sizes the year segment from `max`',
  /^\d{4}-\d{2}-\d{2}$/.test(DATE_INPUT_MIN) && /^\d{4}-\d{2}-\d{2}$/.test(DATE_INPUT_MAX));

// ── D. Source sweep: every date input is bounded AND guarded ────────────────────────────────
//
// `min`/`max` is the defence that stops the fifth keystroke being accepted at all, and the
// onChange guard is the one that does not depend on a browser behaviour. Both, everywhere —
// a single unbounded input is the whole bug back.
{
  const unbounded: string[] = [];
  const unguarded: string[] = [];
  let seen = 0;
  for (const f of tsxFiles) {
    const src = stripComments(readFileSync(f, 'utf8'));
    for (const el of inputElements(src)) {
      if (!/type=["']date["']/.test(el)) continue;
      seen++;
      const where = `${f.replace(process.cwd(), '.')} → ${(valueExpr(el) || '?').trim().slice(0, 40)}`;
      // A tighter bound of the screen's own (Reports caps at today) counts: what matters is
      // that SOME max is present, because that is what fixes the year-segment width.
      if (!/\bmax=\{/.test(el)) unbounded.push(where);
      if (!/isDateInputSane\(/.test(el)) unguarded.push(where);
    }
  }
  ok('D1 the sweep found the date inputs', seen >= 8, `found ${seen}`);
  ok('D2 EVERY date input carries a max — without it the year segment takes six digits',
    unbounded.length === 0, unbounded.join('\n     '));
  ok('D3 EVERY date input rejects an out-of-shape value in onChange',
    unguarded.length === 0, unguarded.join('\n     '));
}

// ── E. A zero price or amount must be SAVEABLE ──────────────────────────────────────────────
//
// Owner directive, 16-Sep-2026: "remove the hardlock of buy and sell, the amount and price if 0
// should be submittable". Shares do change hands for nothing — a gift, a transmission, a
// written-off unlisted holding, an allotment against an earlier advance — and refusing them
// forced a fictitious rupee into the cost basis, which is worse than the zero it avoided.
//
// Source-checked because `lineError` is a closure inside a React component with no seam to call
// it through, and because the failure is a re-added guard, which is exactly the kind of thing a
// later tidy-up reintroduces "for safety".
{
  const src = readFileSync(join(SRC, 'components', 'AddTradeModal.tsx'), 'utf8');
  // Comments stripped first: the rule is explained in prose right beside the code it governs,
  // and a naive scan reports its own documentation as the violation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok('E1 nothing blocks a save on a zero PRICE', !/Price must be greater than 0/.test(code));
  ok('E2 nothing blocks a save on a zero AMOUNT', !/Amount must be greater than 0/.test(code));
  // Quantity is NOT part of the directive and must stay blocked: a trade of no shares moves
  // nothing, and there is no reading of it that is correct.
  ok('E3 a zero QUANTITY is still refused', /Quantity must be greater than 0/.test(code));

  // Unblocked is not the same as unremarked. A zero-cost buy leaves the lot with no basis, so a
  // later sale is taxed on the whole proceeds; a zero-consideration sell books the entire cost
  // as a loss. Both are invisible on the row once written.
  ok('E4 a zero-value line still WARNS', /const lineWarning\b/.test(code));
  ok('E5 ...and the warning is rendered', /\{!err && warn &&/.test(code));
  ok('E6 ...in amber, not the rose the blocking error uses',
    /!err && warn &&[\s\S]{0,120}text-amber-700/.test(code));
  ok('E7 ...and says something different for a sell than for a buy',
    /lineWarning[\s\S]{0,700}l\.action === 'Sell'/.test(code));
  // Bonus and Split are free BY DEFINITION — warning on them would train the user to ignore it.
  ok('E8 free-share actions are not warned about',
    /const lineWarning[\s\S]{0,200}isFreeShares\(l\.action\)\) return null;/.test(code));
}

// ── F. Number inputs carry NO stepper ────────────────────────────────────
//
// Owner directive, 16-Sep-2026: "remove this add/reduce amount from everywhere we have it".
// A spinner that nudges a price by ±1 is wrong in every way that matters here — the step is
// meaningless on money, a mis-click cannot be told from a typed figure, and the figure is filed.
//
// There is no CSS test of any kind in this repo and no browser in the loop, so the ONLY thing
// standing between a tidy-up and 32 fields growing their arrows back is this section.

const cssPath = join(process.cwd(), 'src', 'index.css');
const css = readFileSync(cssPath, 'utf8');

// Both halves are load-bearing and they cover DIFFERENT engines. Chrome/Edge draw the spinner as
// a pseudo-element; Firefox draws it with no pseudo-element to target and needs `appearance`.
// Dropping either leaves the arrows standing on one browser — invisible to whoever removed it.
ok('F1 the webkit spin buttons are removed',
  /::-webkit-(outer|inner)-spin-button[\s\S]{0,160}appearance:\s*none/.test(css));
ok('F2 ...and Firefox\'s, which has no pseudo-element to target',
  /input\[type="number"\][^{]*\{[^}]*appearance:\s*textfield/.test(css));

// UNLAYERED on purpose. The focus ring above it sits inside `@layer base` precisely so a
// component CAN override it; this is the opposite case — nothing may re-grow a spinner. Moving
// the rule into a layer would let any Tailwind utility outrank it and would look like tidying.
const spinAt = css.search(/input\[type="number"\]::-webkit-outer-spin-button/);
ok('F3 the sweep located the rule', spinAt > 0);
let depth = 0;
for (let i = 0; i < spinAt; i++) {
  if (css[i] === '{') depth++;
  else if (css[i] === '}') depth--;
}
ok('F4 ...and it is UNLAYERED, so nothing can outrank it', depth === 0, `brace depth ${depth}`);

// A second, per-field definition of the same rule is how the two drift apart. One place only.
const arbitrarySpin = tsxFiles.filter(f => /\[&::-webkit-[a-z-]*spin/.test(readFileSync(f, 'utf8')));
ok('F5 no component re-declares the spinner as an arbitrary variant',
  arbitrarySpin.length === 0, arbitrarySpin.join(', '));

// The canary. Every assertion above is about a rule that protects number inputs; if the app had
// none, they would all pass while protecting nothing.
let numberInputs = 0;
for (const f of tsxFiles) {
  for (const el of inputElements(stripComments(readFileSync(f, 'utf8')))) {
    if (/type=\{?["']number["']\}?/.test(el)) numberInputs++;
  }
}
ok('F6 there are number inputs for the rule to reach', numberInputs >= 25, `found ${numberInputs}`);

// ── The other stepper: the mouse wheel ──────────────────────────────────
// A browser steps a FOCUSED number input on every wheel tick over it. Removing the arrows makes
// this worse, not better — they were the only clue the field stepped at all — so the guard and
// the CSS ship together and are pinned together.
const appSrc = stripComments(readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8'));
const wheelEffect = (appSrc.match(/const onWheel[\s\S]{0,700}?removeEventListener\('wheel'[^)]*\)/) || [''])[0];
ok('F7 App installs a document-level wheel guard', wheelEffect.length > 0);
ok('F8 ...that is removed on unmount', /removeEventListener\('wheel'/.test(wheelEffect));

// PASSIVE, and therefore BLUR. `preventDefault()` on a passive listener does nothing at all, so
// a future edit that switches to preventDefault without also dropping `passive` would stop
// guarding silently. And a NON-passive wheel listener makes the browser wait on JS before every
// scroll frame in the app — paid on the 300-row holdings grid, to fix a field nobody is using.
ok('F9 ...registered passive, so page scrolling keeps its fast path',
  /addEventListener\('wheel',\s*onWheel,\s*\{\s*passive:\s*true\s*\}/.test(appSrc));
ok('F10 ...and it BLURS rather than calling preventDefault, which passive would ignore',
  /\.blur\(\)/.test(wheelEffect) && !/preventDefault/.test(wheelEffect));

// Only the FOCUSED field steps, and only under the pointer. Acting on any number input the
// pointer crosses would steal focus mid-scroll from a field the user is typing into.
ok('F11 ...only for the focused element', /document\.activeElement/.test(wheelEffect));
ok('F12 ...and only when the pointer is over that same field',
  /contains\(e\.target/.test(wheelEffect));
ok('F13 ...and only for number inputs', /\.type === 'number'/.test(wheelEffect));

// Blur is only safe while blurring a NUMBER input does nothing. The guard blurs those and
// nothing else, so that — not the app's onBlur count — is the question. An onBlur on a number
// field would be fired by a stray scroll; one that wrote to Sheets would make a scroll a WRITE.
//
// Written as "no number input has an onBlur" rather than "the app has N onBlurs" deliberately:
// the first version counted every onBlur in the app, so it failed on `ScripCombobox`'s text box
// — a field this guard cannot reach — and would have failed again on the next dropdown added.
// A test that fires on things that are not the bug gets disabled, and then it guards nothing.
const numberInputsWithBlur = tsxFiles.flatMap(f =>
  inputElements(stripComments(readFileSync(f, 'utf8')))
    .filter(el => /type=\{?["']number["']\}?/.test(el) && /onBlur=/.test(el))
    .map(() => f));
ok('F14 no number input has an onBlur for a stray wheel to fire',
  numberInputsWithBlur.length === 0, [...new Set(numberInputsWithBlur)].join(', '));

console.log(`\ndate-input: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
