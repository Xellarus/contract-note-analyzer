/**
 * Controlled `<input type="date">` — the one rule, and a sweep of every date input in the app.
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
import { dateInputValue } from './src/lib/dates';

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
  const src = readFileSync(f, 'utf8');
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

console.log(`\ndate-input: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
