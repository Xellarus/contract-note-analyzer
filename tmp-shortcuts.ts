/**
 * Keyboard shortcuts: the registry invariants, the typing/modifier guards, and the two
 * source-level checks that keep the registry, the handler and the help overlay in step.
 *
 * The interesting failures here are all silent ones. A duplicate key means one shortcut is dead
 * and nothing says so. A registry entry with no `case` in App means a documented key does
 * nothing. A hand-written help list means the overlay lies. None of those break a build.
 *
 * Run: npx tsx tmp-shortcuts.ts
 */
import io from 'node:fs';

// `installShortcuts` binds to `window`. Stubbed so the REAL handler can be driven with
// synthetic events - this tests the shipped guard logic, not a re-implementation of it.
let keyHandler: ((e: any) => void) | null = null;
(globalThis as any).window = {
  addEventListener: (t: string, h: any) => { if (t === 'keydown') keyHandler = h; },
  removeEventListener: (t: string) => { if (t === 'keydown') keyHandler = null; },
};

const {
  SHORTCUTS, SHORTCUT_GROUPS, installShortcuts, isTypingTarget, keyLabel,
} = await import('./src/lib/shortcuts');

let pass = 0;
const fails: string[] = [];
const ok = (label: string, cond: any, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fails.push(label + (detail ? '\n       ' + detail : '')); console.log('  FAIL ' + label); }
};
const eq = (label: string, got: any, want: any) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want),
    `got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

// ── the registry ────────────────────────────────────────────────────────────────────────────
console.log('\n── registry ' + '─'.repeat(46));
{
  const keys = SHORTCUTS.flatMap((s) => s.keys);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  // A duplicate key means `find` returns the first and the second is unreachable - a shortcut
  // that is documented in the overlay and simply never fires.
  eq('no key is bound twice', dupes, []);

  const actions = SHORTCUTS.map((s) => s.action);
  eq('no action is registered twice', actions.filter((a, i) => actions.indexOf(a) !== i), []);

  ok('every entry has a key, a label and a hint',
    SHORTCUTS.every((s) => s.keys.length > 0 && !!s.label.trim() && !!s.hint.trim()));
  ok('every entry sits in a known group',
    SHORTCUTS.every((s) => SHORTCUT_GROUPS.includes(s.group)),
    SHORTCUTS.filter((s) => !SHORTCUT_GROUPS.includes(s.group)).map((s) => s.action).join(', '));
  // Every group must render something, or the overlay shows an empty heading.
  ok('every group has at least one entry',
    SHORTCUT_GROUPS.every((g) => SHORTCUTS.some((s) => s.group === g)));

  // Single letters, "/" and "?" only. A multi-character key ("Enter", "ArrowUp") would collide
  // with the palette's own handling; a modifier combo is rejected by the handler outright.
  ok('every key is a single letter, "/" or "?"',
    SHORTCUTS.every((s) => s.keys.every((k) => /^[a-z/?]$/.test(k))),
    SHORTCUTS.flatMap((s) => s.keys).filter((k) => !/^[a-z/?]$/.test(k)).join(', '));

  eq('keyLabel upper-cases letters and leaves punctuation alone',
    [keyLabel('d'), keyLabel('/'), keyLabel('?')], ['D', '/', '?']);
}

// ── the guards, driven through the real handler ─────────────────────────────────────────────
console.log('\n── guards ' + '─'.repeat(48));
{
  const seen: string[] = [];
  const stop = installShortcuts((a) => seen.push(a));
  ok('installing binds a keydown listener', !!keyHandler);

  const ev = (over: any = {}) => {
    let prevented = false;
    const e = {
      key: 'd', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      defaultPrevented: false, target: { tagName: 'DIV' },
      preventDefault() { prevented = true; },
      ...over,
    };
    keyHandler!(e);
    return () => prevented;
  };

  seen.length = 0;
  const p1 = ev({ key: 'd' });
  eq('"d" runs goDashboard', seen, ['goDashboard']);
  ok('and the default is prevented, so the key is not typed anywhere', p1());

  seen.length = 0;
  ev({ key: 'D' });
  eq('a capital "D" works too - Shift must not break navigation', seen, ['goDashboard']);

  // Ctrl/Cmd/Alt belong to the browser and the OS. Ctrl+R is reload, Cmd+D is bookmark.
  seen.length = 0;
  const p2 = ev({ key: 'r', ctrlKey: true });
  eq('Ctrl+R is left to the browser', seen, []);
  ok('and its default is NOT prevented', !p2());
  seen.length = 0;
  ev({ key: 'd', metaKey: true });
  eq('Cmd+D is left to the browser', seen, []);
  seen.length = 0;
  ev({ key: 'd', altKey: true });
  eq('Alt+D is left to the browser', seen, []);

  // THE guard that matters most: typing a portfolio name must not navigate the app.
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    seen.length = 0;
    ev({ key: 'p', target: { tagName: tag } });
    eq(`typing "p" in a <${tag.toLowerCase()}> does not navigate`, seen, []);
  }
  seen.length = 0;
  ev({ key: 'p', target: { tagName: 'DIV', isContentEditable: true } });
  eq('nor in a contenteditable', seen, []);

  seen.length = 0;
  ev({ key: 'p', target: { tagName: 'DIV' } });
  eq('but "p" outside a field does navigate', seen, ['goPortfolios']);

  // An unbound key must pass straight through untouched.
  seen.length = 0;
  const p3 = ev({ key: 'z' });
  eq('an unbound key runs nothing', seen, []);
  ok('and keeps its default behaviour', !p3());

  // Something upstream already handled it (a menu, a modal) - do not act twice.
  seen.length = 0;
  ev({ key: 'd', defaultPrevented: true });
  eq('an already-handled event is ignored', seen, []);

  stop();
  ok('uninstalling removes the listener', keyHandler === null);
}

// ── isTypingTarget on its own ───────────────────────────────────────────────────────────────
{
  ok('isTypingTarget: null is not typing', !isTypingTarget(null));
  ok('isTypingTarget: a div is not typing', !isTypingTarget({ tagName: 'DIV' } as any));
  ok('isTypingTarget: an input is', isTypingTarget({ tagName: 'input' } as any));
}

// ── source-level: the handler and the overlay cannot drift from the registry ────────────────
console.log('\n── wiring ' + '─'.repeat(48));
{
  const app = io.readFileSync(new URL('./src/App.tsx', import.meta.url), 'utf8');
  // A registry entry with no `case` is a key the help overlay advertises and nothing performs.
  // tsc catches the reverse (a case for an action that does not exist), not this direction.
  const unhandled = SHORTCUTS.map((s) => s.action).filter((a) => !app.includes(`case '${a}':`));
  eq('every registered action has a case in App.tsx', unhandled, []);

  ok('App installs the listener', /installShortcuts\(run\)/.test(app));
  ok('the Settings view is a real branch, not just a sidebar button',
    /currentView === 'settings' \? \(/.test(app));
  ok("APP_VIEWS includes 'settings', so a reload lands back on it",
    /const APP_VIEWS = \[[^\]]*'settings'[^\]]*\] as const;/.test(app));
  // The account controls were asked to live in Settings ONLY.
  ok('the theme toggle is gone from the header', !/<ThemeToggle theme=\{theme\}/.test(app));
  ok('the Sign out pill is gone from the header', !/Sign out\s*<\/button>/.test(app));

  // ModalShell's backdrop is `absolute inset-0`, and CSS paints a positioned element in a LATER
  // layer than a non-positioned in-flow sibling - so a panel without positioning renders UNDER
  // the blurred, half-opaque backdrop: washed out and deaf to clicks. Every other ModalShell
  // caller carries `relative z-10`; these two shipped without it and that is exactly how it was
  // reported ("a UI blur error"). Asserted so it cannot come back.
  for (const [file, what] of [
    ['./src/components/ui/ShortcutHelp.tsx', 'the help overlay'],
    ['./src/components/PortfolioSwitcher.tsx', 'the portfolio switcher'],
  ] as [string, string][]) {
    const src2 = io.readFileSync(new URL(file, import.meta.url), 'utf8');
    ok(`${what}'s panel is positioned above the backdrop (relative z-10)`,
      /<div className="relative z-10 bg-white/.test(src2),
      'without it the blurred backdrop paints over the panel and eats every click');
  }

  const help = io.readFileSync(new URL('./src/components/ui/ShortcutHelp.tsx', import.meta.url), 'utf8');
  ok('the help overlay renders FROM the registry, not a copied list',
    /SHORTCUTS\.filter\(/.test(help) && /SHORTCUT_GROUPS\.map\(/.test(help));
  ok('and it states which actions are deliberately unbound',
    /write to Google Sheets/.test(help));

  const hold = io.readFileSync(new URL('./src/components/Holdings.tsx', import.meta.url), 'utf8');
  ok('the holdings filter carries the id "/" focuses', /id=\{HOLDINGS_SEARCH_ID\}/.test(hold));
  ok('Holdings listens for the addTrade shortcut',
    /onShortcut\(\(a\) => \{ if \(a === 'addTrade'\)/.test(hold));

  // ── `q` = Back, and the reason it is NOT history.back() ──
  // appBack.ts only arms its trap history entry once some view has registered a back step, so a
  // `history.back()` fired before that walks OUT of the SPA - the very bug that module exists to
  // stop ("mouse previous goes to a new tab"). Calling the step directly consumes no history
  // entry and cannot navigate away. It reads like a pointless indirection, which is exactly why
  // a future tidy-up would collapse it; pinned here so that fails loudly.
  const back = SHORTCUTS.find((s) => s.action === 'goBack');
  eq('q is bound to Back', back?.keys, ['q']);

  // Comments stripped FIRST. The rule this checks is stated in a comment two lines above the code
  // it guards, so a naive scan matches the prose describing the ban and reports the ban itself as
  // a violation - a checker that reads its own documentation as evidence. Newlines are preserved
  // so nothing downstream shifts.
  const decomment = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
  const appCode = decomment(app);
  ok('the Back case calls goBack(), not history.back()',
    /case 'goBack': goBack\(\); break;/.test(appCode) && !/history\.back\(\)/.test(appCode),
    `case present: ${/case 'goBack': goBack\(\);/.test(appCode)}, history.back in CODE: ${/history\.back\(\)/.test(appCode)}`);

  const backSrc = io.readFileSync(new URL('./src/lib/appBack.ts', import.meta.url), 'utf8');
  ok('appBack exports goBack and it runs the deepest step',
    /export function goBack\(\): void \{\s*runDeepestStep\(\);/.test(backSrc));
  ok('...and goBack does not touch history itself',
    !/goBack[\s\S]{0,240}window\.history/.test(backSrc));

  // The safety boundary, asserted rather than trusted: no Sheets-writing action is bound.
  const banned = ['rebuild', 'syncCapitalGains', 'generateTrx', 'transfer'];
  const bad = SHORTCUTS.filter((s) => banned.some((b) => s.action.toLowerCase().includes(b.toLowerCase())));
  eq('no shortcut is bound to a Sheets-writing action', bad.map((s) => s.action), []);
}

console.log('\n' + '='.repeat(58));
for (const f of fails) console.log('  FAIL ' + f);
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) process.exitCode = 1;
