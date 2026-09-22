/**
 * TWO WAYS THE HOLDINGS ON SCREEN CAN BELONG TO SOMETHING ELSE — the wrong ACCOUNT, or the
 * wrong DATE. Both were reported on 22-Sep-2026 and neither is visible to `tsc`, the build, or
 * any other suite here; there is no browser in the loop.
 *
 *  1. *"when the API fetch runs out in OADR97 Account it shows old holding of T059"* — every
 *     guard in `fetchSheetHoldings` returned BEFORE the line that clears `sheetHoldings`, and
 *     the portfolio-switch effect cleared `selectedStock` / `customCmp` / `transactions` but
 *     not the holdings. A token that had expired by the time you switched accounts therefore
 *     left the previous account's rows on screen under the new account's name.
 *
 *  2. *"look at goodluck india qnt as on 24/07/2026 it shows 210000 but when i am adding a
 *     bonus it shows auto qnt of 200000"* — the bonus was dated 21-Aug-2026, the holding on
 *     that date was 2,10,000, and the auto-fill read the Holding tab, which states the position
 *     NOW. The 10,000 difference is a sell on 31-Aug, AFTER the action.
 *
 * Both failures are silent and both look plausible on screen, which is why they are pinned as
 * SOURCE facts rather than left to review. Comments are stripped first — the rules are written
 * down beside the code that implements them, and a naive scan reports its own documentation as
 * the violation (the trap `tmp-shortcuts.ts` and `tmp-date-input.ts` already strip for).
 *
 *   npx tsx tmp-holdings-scope.ts
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); }
};

/** Source with block and line comments removed, so prose about a rule never matches as code. */
const strip = (p: string) =>
  readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const MODAL = strip('src/components/AddTradeModal.tsx');
const HOLD = strip('src/components/Holdings.tsx');

// ══ 1. THE AUTO-FILL IS AS AT THE LINE'S DATE, NOT TODAY ════════════════════════════════
console.log('\n=== "shares held" is the position on the ACTION\'s date ===');

ok('heldFor takes a date',
  /const heldFor = \(company: string, isin: string, onDate\?: string\)/.test(MODAL));

// No two-argument call may survive: that is the old, undated signature, and it typechecks
// perfectly because the parameter is optional.
const heldCalls = [...MODAL.matchAll(/heldFor\(([^)]*)\)/g)].map(m => m[1]);
ok('every heldFor call passes a date', heldCalls.length > 0 && heldCalls.every(a => a.split(',').length >= 3),
  `calls: ${JSON.stringify(heldCalls)}`);
ok('...and all five are accounted for (effect, identity, carry-forward, render, type-switch)',
  heldCalls.length === 5, `found ${heldCalls.length}`);

// The shared FIFO replay, not a second implementation: the drawer and the as-of report must
// not be able to disagree about what was held on a date.
ok('the position comes from the shared computeHoldingsAsOf',
  /import \{ computeHoldingsAsOf \} from '\.\.\/lib\/holdingsCalc'/.test(MODAL)
  && /computeHoldingsAsOf\(sid, new Date\(/.test(MODAL));

// End of day, so a trade stamped the action's own date is INCLUDED — an allotment sits on top
// of whatever that day's trading left.
ok('the as-of instant is the END of the action\'s day',
  /new Date\(`\$\{d\}T23:59:59`\)\.getTime\(\)/.test(MODAL));

// ── THE READ MUST ACTUALLY COMPLETE ─────────────────────────────────────────────────────
// Reported 22-Sep-2026: *"2 mins in still couldnt read the ledger"*. The first version of this
// effect depended on a freshly-built ARRAY (new identity on every `lines` change, i.e. every
// keystroke) and on `asOfPos`, and carried a `cancelled` flag in its cleanup. So typing the
// ratio - the one interaction guaranteed to happen while the read is in flight - re-ran the
// effect, the cleanup cancelled the run that owned the request, the reply was DISCARDED, and
// the key stayed in the issued set so it was never asked for again. Permanently stuck.
{
  const fn = MODAL.slice(MODAL.indexOf('const fetchAsOf ='));
  const body = fn.slice(0, fn.indexOf('\n  useEffect('));
  ok('the as-of read carries NO cancellation flag',
    !/cancelled/.test(body),
    'a late reply is keyed by portfolio+date and is simply correct - discarding it strands the key');

  // NEVER silent. A swallowed error leaves "reading the ledger…" on screen indefinitely, which
  // is indistinguishable from a slow read - exactly how this was reported.
  ok('a failed read is recorded with its reason, not swallowed',
    /setAsOfFailed\(\(p\) => \(\{[\s\S]*?e\?\.result\?\.error\?\.message \|\| e\?\.message/.test(body));
  ok('...and the key is released so it can be retried',
    /asOfIssued\.current\.delete\(key\)/.test(body));
  // Starting is not guaranteed either: no token means no read, and saying nothing there is the
  // same eternal "reading the ledger…".
  ok('...and a read that cannot even START says so',
    /Google Sheets is not connected/.test(body));
}

// The dep is a PRIMITIVE, so the effect fires when the SET of dates changes and not on every
// keystroke; and `asOfPos` is NOT a dep, or every successful write re-runs it.
ok('the effect is keyed on a primitive, not a rebuilt array',
  /const neededAsOfKey = useMemo\(/.test(MODAL)
  && /\}, \[open, portfolio, neededAsOfKey\]\);/.test(MODAL));
ok('...and the result cache is not one of its dependencies',
  !/\[open, portfolio, neededAsOfKey, asOfPos\]/.test(MODAL));

// The retry has to re-issue the read directly: clearing the failure alone would not fire the
// effect, because the set of needed dates has not changed.
ok('the retry button calls the fetch directly',
  /onClick=\{\(\) => fetchAsOf\(heldOn\)\}/.test(MODAL));

// Keyed by BOTH, or switching account inside the drawer reuses the other account's position.
ok('the cache is keyed by portfolio AND date',
  /`\$\{portfolio\}\|\$\{d\}`/.test(MODAL) && /`\$\{portfolio\}\|\$\{\(onDate \|\| ''\)\.trim\(\)\}`/.test(MODAL));

// THE rule. Falling back to the Holding tab "until the replay lands" is the original bug with
// a delay in front of it: the user reads the wrong number and it corrects itself afterwards.
ok('no as-of set yet -> returns null rather than today\'s figure',
  /if \(!dated && portfolio !== 'local'\) return null;/.test(MODAL));

// Moving the date invalidates the figure that was computed for the old one.
ok('changing a free-share line\'s date clears the held figure',
  /const invalidates = isFreeShares\(l\.action\) && e\.target\.value !== \(l\.date \|\| tradeDate\)/.test(MODAL)
  && /\{ date: e\.target\.value, dateSet: true, held: '', qty: '' \}/.test(MODAL));

// The figure legitimately differs from the holdings grid whenever the action is back-dated.
// Without the date on screen that difference reads as a bug, which is how this was reported.
ok('the field says which date it answered', /· as at \{formatDMY\(heldOn\)\}/.test(MODAL));
// FOUR states, not one. The first version showed "reading the ledger…" whenever there was no
// answer - running, failed, or never started - so a read that had given up looked identical to
// a slow one, which is what left the box stuck for two minutes with nothing to act on.
ok('the four outcomes are distinguished',
  /const heldLoading = free && !heldKnown && !!asOfLoading\[asOfKey\];/.test(MODAL)
  && /const heldFailedMsg = free && !heldKnown \? \(asOfFailed\[asOfKey\] \|\| ''\) : '';/.test(MODAL)
  && /const heldNone = free && !heldKnown && !heldLoading && !heldFailedMsg/.test(MODAL));
ok('...and each says something different on screen',
  /couldn.t read the ledger/.test(MODAL)
  && /nothing held on \{formatDMY\(heldOn\)\}/.test(MODAL)
  && /reading the ledger/.test(MODAL));
ok('a failed read still lets the figure be typed',
  /type the shares held yourself/.test(MODAL));

// The auto-fill effect must re-run when a replay lands, or the box stays empty until an
// unrelated keystroke happens to re-render it.
ok('the auto-fill effect depends on the as-of cache',
  /\}, \[open, portfolio, heldRows, holdingsLen, asOfPos, tradeDate\]\);/.test(MODAL));

// ══ 2. HOLDINGS ON SCREEN BELONG TO THE ACCOUNT ON SCREEN ═══════════════════════════════
console.log('\n=== rows are stamped with the account they came from ===');

ok('the rows carry the portfolio they were read from',
  /const \[sheetHoldingsFor, setSheetHoldingsFor\] = useState<string \| null>\(null\)/.test(HOLD)
  && /const sheetHoldingsForRef = useRef<string \| null>\(null\)/.test(HOLD));

// A ref as well as state, because `fetchSheetHoldings` closes over it and must test the
// CURRENT stamp rather than the one captured when the closure was made.
ok('the stamp is mirrored into a ref for the fetch closure',
  /const stampHoldings = \(pid: string \| null\) => \{ sheetHoldingsForRef\.current = pid; setSheetHoldingsFor\(pid\); \}/.test(HOLD));

ok('a successful read stamps the rows', /stampHoldings\(portfolio\);/.test(HOLD));

ok('the UI reads a GATED array, not the raw state',
  /const ownedHoldings = sheetHoldingsFor === activePortfolio \? sheetHoldings : NO_HOLDINGS;/.test(HOLD));

// The clear has to run BEFORE the first `return`, which is the whole defect: every guard
// jumped over the clearing block that sat further down.
{
  const fn = HOLD.slice(HOLD.indexOf('const fetchSheetHoldings ='));
  const body = fn.slice(0, fn.indexOf('\n  };'));
  const clearAt = body.indexOf('stampHoldings(null);');
  const firstReturn = body.indexOf('return;');
  ok('the cross-account clear runs BEFORE the first guard returns',
    clearAt >= 0 && firstReturn >= 0 && clearAt < firstReturn,
    `clear@${clearAt} firstReturn@${firstReturn}`);

  // ...and it must be conditional on the portfolio differing, or a failed refresh of the
  // account you are ON would wipe the table you are reading (owner's decision, 22-Sep-2026:
  // keep the figures, mark them stale).
  ok('...and only when the rows belong to a DIFFERENT account',
    /if \(sheetHoldingsForRef\.current !== null && sheetHoldingsForRef\.current !== portfolio\) \{/.test(body));

  // The old clear sat inside `if (!silent)`; nothing may put the row-clearing back there.
  const silentBlock = body.slice(body.indexOf('if (!silent) {'));
  ok('the non-silent block no longer clears the rows',
    !/setSheetHoldings\(\[\]\)/.test(silentBlock.slice(0, silentBlock.indexOf('}'))));
}

// Up to 15 seconds of retrying happen here while a token is restored; every one of those
// seconds used to render the previous account's positions.
{
  const eff = HOLD.slice(HOLD.indexOf('setSelectedStock(null);\n    setCustomCmp(null);\n    setTransactions([]);'));
  ok('switching account drops the old rows immediately',
    /setSheetHoldings\(\[\]\)/.test(eff.slice(0, 600)) && /stampHoldings\(null\)/.test(eff.slice(0, 600)));
}

// ══ 3. A FAILED REFRESH IS VISIBLE, INCLUDING THE SILENT ONE ════════════════════════════
console.log('\n=== a refresh that failed says so ===');

ok('failure is recorded even on the silent path',
  /const failRefresh = \(why: string\) => \{/.test(HOLD)
  && /if \(sheetHoldingsForRef\.current === portfolio\) setSheetRefreshFailed\(why\);/.test(HOLD));

// The 2-minute auto-refresh reported nothing at all, so a quota-exhausted account simply
// stopped updating and still looked current.
{
  const cat = HOLD.slice(HOLD.indexOf('console.error("Fetch holdings error:"'));
  const block = cat.slice(0, cat.indexOf('} finally {'));
  ok('the catch marks the rows stale OUTSIDE the !silent branch',
    /failRefresh\(errorMsg\);/.test(block) && !/if \(!silent\) \{[\s\S]*failRefresh/.test(block));
}

ok('a successful read clears the stale marker', /setSheetRefreshFailed\(null\);/.test(HOLD));
ok('the grid shows a "not live" banner rather than hiding the rows',
  /\{sheetRefreshFailed && \(/.test(HOLD) && /Not live/.test(HOLD));

// The full-page error card must only take over when there is genuinely nothing to show;
// otherwise a passing blip blanks a table being read.
ok('the error card only replaces the grid when there are NO rows',
  /\) : \(sheetError && ownedHoldings\.length === 0\) \? \(/.test(HOLD));

// ══ 4. NO CONSUMER READS THE UNGATED ARRAY ══════════════════════════════════════════════
console.log('\n=== every consumer reads the gated array ===');

// Above all the Add Trade drawers: offering one account's positions while the trade saves
// into another account's ledger is how a wrong holding becomes a wrong ROW.
const propUses = [...HOLD.matchAll(/holdings=\{(\w+)\.map\(h => \(\{ name: h\.companyName/g)].map(m => m[1]);
ok('both Add Trade drawers are fed the gated array',
  propUses.length === 2 && propUses.every(v => v === 'ownedHoldings'),
  JSON.stringify(propUses));

ok('the grid builds from the gated array',
  /const activeSheetHoldings = ownedHoldings\.length > 0/.test(HOLD));

// ══ 5. THE SHEET MOVED ON AND THE PAGE DID NOT ═════════════════════════════════════════
//
// Reported 22-Sep-2026: Kusumgar and ESDS both IPO'd, both got a `Listed From` date on the
// Private Equities tab, and both kept their PE badge, their 730-day holding period and their
// hand-entered valuation afterwards. Nothing was wrong with the classification engine - a
// probe over the owner's real rows returns ONE entry keyed by the listed ISIN, 730 days
// before the listing and 365 after. The page had simply never re-read the master.
console.log('\n=== the page picks the sheet back up ===');

// The mount read is UNFORCED and happens once, which is right for a read-only view and wrong
// the moment the owner edits the sheet in another tab - which is the actual workflow.
ok('the master is re-read when the tab comes back to the front',
  /document\.addEventListener\('visibilitychange', onVisible\)/.test(HOLD)
  && /loadScripMaster\(SCRIP_MASTER_SPREADSHEET_ID, \{ force: true \}\)/.test(HOLD.slice(HOLD.indexOf('const onVisible'))),
  'an edit made in another tab has no other event in this app');

// FORCED, or the 90s cache returns the master as it was before the edit - the same trap the
// sheet-WRITING engines pass `{ force: true }` for.
{
  const fn = HOLD.slice(HOLD.indexOf('const onVisible = () => {'));
  const body = fn.slice(0, fn.indexOf('};'));
  ok('...forced, so the 90s cache cannot serve the pre-edit master',
    /force: true/.test(body));
  ok('...and rate-limited, so flicking between tabs costs no reads',
    /Date\.now\(\) - scripReadAt\.current < 60_000/.test(body));
  ok('...and does nothing while hidden or signed out',
    /if \(document\.hidden \|\| !hasAuthorizedGoogle\(\)\) return;/.test(body));
}
// The mount read must stamp the clock too, or the first visibility change spends a read
// immediately after one was just made.
ok('the mount read stamps the same clock',
  /scripReadAt\.current = Date\.now\(\);\s*\n\s*loadScripMaster\(SCRIP_MASTER_SPREADSHEET_ID\)\.then\(setScrip\)/.test(HOLD));

// ── A row that PREDATES its company's listing ──
//
// The grid reads the `Holding` tab (rewritten only by Rebuild) while the badge beside it is
// computed live from the master, so the two legitimately disagree after a listing: the row
// still says "Kusumgar Pvt Ltd" and carries the position as at that rebuild. Reported as a
// wrong quantity. Unexplained, it reads as a bug; named, it reads as "press Rebuild".
{
  const memo = HOLD.slice(HOLD.indexOf('const listedSinceRebuild = useMemo('));
  const body = memo.slice(0, memo.indexOf('}, [scrip, displayHoldings]);'));
  ok('a holding that predates its listing is named on screen',
    /const listedSinceRebuild = useMemo\(/.test(HOLD) && /listedSinceRebuild\.length > 0 &&/.test(HOLD));
  // normNamePrivate is the whole test: the ledger row keeps the "pvt" token the listed
  // canonical name does not, which is exactly the pair normName collapses into one entry.
  ok('...detected by the token normName throws away',
    /normNamePrivate\(h\.name\) === normNamePrivate\(e\.canonicalName\)/.test(body));
  // Infinity means NEVER listed. `<= now` fails for it, which is the conservative side: a
  // garbled cell must not claim a company has listed.
  ok('...only once the listing date has actually PASSED',
    /!\(listedFromTs\(e\) <= now\)/.test(body));
  ok('...and each company is named once, not once per holding row',
    /seen\.has\(e\.key\)/.test(body) && /seen\.add\(e\.key\)/.test(body));
  // The owner's stated fear when this feature was designed: that a listing would rewrite a
  // year already filed. It does not, and the note must say so where the doubt arises.
  ok('...and the note says filed years are unaffected',
    /Years already filed are unaffected/.test(HOLD));
}

console.log(`\n${'='.repeat(60)}\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
