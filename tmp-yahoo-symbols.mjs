// Does the price script resolve a held scrip to an exchange symbol?
//
// Runs the REAL functions out of apps-script/YahooPriceUpdate.gs - evaluated in a sandbox with
// the Apps Script globals stubbed - rather than re-implementing them here. That matters: the
// whole bug was that this script resolves names DIFFERENTLY from the app, so a test that
// re-implemented the logic would have agreed with whichever version I happened to write.
//
// Run: node tmp-yahoo-symbols.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('./apps-script/YahooPriceUpdate.gs', import.meta.url), 'utf8');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fails.push(label + (detail ? '\n       ' + detail : '')); console.log('  FAIL ' + label); }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

const NONE = { primary: '', fallback: '' };

/**
 * Evaluate the .gs with a scrip-master sheet of `rows`, and hand back its functions.
 * `opts.noOverrides` empties SYMBOL_OVERRIDES first, so a test can prove a scrip resolves
 * through the GENERAL path rather than because somebody hand-listed it.
 */
function load(rows, opts = {}) {
  const ctx = {
    console,
    Logger: { log() {} },
    UrlFetchApp: { fetchAll: () => [], fetch: () => ({ getResponseCode: () => 500, getContentText: () => '' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: {
      openById: () => ({
        getSheets: () => [{ getDataRange: () => ({ getValues: () => rows }) }],
        getSheetByName: () => null,
      }),
    },
  };
  vm.createContext(ctx);
  new vm.Script(SRC).runInContext(ctx);
  if (opts.noOverrides) new vm.Script('SYMBOL_OVERRIDES.length = 0;').runInContext(ctx);
  return new vm.Script(
    '({loadMasterSymbols_, symbolsFor_, normName_, symbolOverrideFor_, masterPrefixHit_, probeSymbol_, RESOLVER_VERSION_})'
  ).runInContext(ctx);
}

// A master shaped like the real one: the app's column headers, including Alias name.
const HDR = ['ISIN', 'Security Name', 'BSE Code', 'NSE Symbol', 'Alias name'];

// The reported scrip, exactly as it appears on both sides.
const HELD = 'ANAWIL WIRE& ENGINEERI';        // the Holding tab's (truncated, mis-spaced) name
const CANON = 'ANAWIL WIRE & ENGINEERING LIMITED';
const ISIN = 'INE1J5V01013';

// ── the reported bug ────────────────────────────────────────────────────────────────────────
console.log('\n── ANAWIL, as reported ' + '─'.repeat(35));
{
  // Master spelled properly; the HOLDING carries the broker's truncated, mis-spaced name.
  const g = load([HDR, [ISIN, CANON, '', 'ANAWIL', '']]);
  const master = g.loadMasterSymbols_();

  // The exact failure the toast reported: name-keyed lookup cannot match a truncated name.
  ok('the truncated held name does NOT match the master name (this was the bug)',
    g.normName_(HELD) !== g.normName_(CANON),
    `${g.normName_(HELD)}  vs  ${g.normName_(CANON)}`);

  eq('resolves by ISIN + name', g.symbolsFor_(master, ISIN, HELD), { primary: 'ANAWIL.NS', fallback: '' });
  eq('resolves from the NAME ALONE, with no ISIN on the Holding row',
    g.symbolsFor_(master, '', HELD), { primary: 'ANAWIL.NS', fallback: '' });
  eq('and by ISIN alone, whatever the name says',
    g.symbolsFor_(master, ISIN, 'whatever the broker felt like'), { primary: 'ANAWIL.NS', fallback: '' });
}

// ── the actual fix: the TICKER is a way IN, not just a payload ──────────────────────────────
// "I put the ticker in the scrip master and it still will not fetch, it is still going by name."
// Correct: every held scrip arrives with NO ISIN (the Holding tab has no ISIN column), so a name
// match is the only way in - and the ticker sat INSIDE the row the name match could not find.
// These run with SYMBOL_OVERRIDES EMPTIED, so nothing here passes because of a hand-written entry.
console.log('\n── the ticker as a way in (no overrides) ' + '─'.repeat(18));
{
  const g = load([HDR, [ISIN, CANON, '', 'ANAWIL', '']], { noOverrides: true });
  const master = g.loadMasterSymbols_();

  eq('the reported scrip resolves with NO override at all - the ticker did it',
    g.symbolsFor_(master, '', HELD), { primary: 'ANAWIL.NS', fallback: '' });
  eq('and the ticker itself is now a lookup key, matched exactly',
    g.symbolsFor_(master, '', 'ANAWIL'), { primary: 'ANAWIL.NS', fallback: '' });

  // BOTH new rules are load-bearing; neither resolves this alone. Asserted as plain string
  // facts so the reason survives a refactor of either rule.
  const nk = g.normName_(HELD);
  ok('exact-matching the ticker key alone could NOT have hit it', nk !== g.normName_('ANAWIL'));
  ok('prefix-matching the canonical name alone could NOT have hit it either',
    nk.indexOf(g.normName_(CANON)) !== 0 && g.normName_(CANON).indexOf(nk) !== 0,
    `"wire&" vs "wire &": ${nk}  vs  ${g.normName_(CANON)}`);
  ok('it takes the ticker AS A KEY plus the prefix rule', nk.indexOf(g.normName_('ANAWIL')) === 0);

  // The control: same row, same held name, but the NSE cell empty. The row still carries a BSE
  // code, so this is not "no symbols to give" - it is "the canonical name cannot bridge the
  // truncation on its own". Proves the ticker is what closed it.
  const g2 = load([HDR, [ISIN, CANON, '539001', '', '']], { noOverrides: true });
  eq('with the ticker cell EMPTY the same held name resolves to nothing',
    g2.symbolsFor_(g2.loadMasterSymbols_(), '', HELD), NONE);
}

// ── the truncation (prefix) rule, and its guards ────────────────────────────────────────────
console.log('\n── prefix matching ' + '─'.repeat(39));
{
  // Truncation the OTHER way round: the held name is shorter than the master's.
  const g = load([HDR, ['INE777A01017', 'KISAN MOULDINGS LIMITED', '', 'KISAN', '']], { noOverrides: true });
  eq('a held name truncated SHORTER than the master name resolves',
    g.symbolsFor_(g.loadMasterSymbols_(), '', 'KISAN MOULDIN'), { primary: 'KISAN.NS', fallback: '' });

  // AMBIGUITY MUST REFUSE. Two companies prefix-matching one held name means we do not know
  // which one this is, and guessing writes a wrong PRICE - money, silently wrong.
  const g2 = load([
    HDR,
    ['INE888A01018', 'TATA MOTORS LIMITED', '', 'TATAMOTORS', ''],
    ['INE888A01026', 'TATA MOTORS DVR LIMITED', '', 'TATAMTRDVR', ''],
  ], { noOverrides: true });
  eq('two rows prefix-matching one held name refuses rather than guessing',
    g2.symbolsFor_(g2.loadMasterSymbols_(), '', 'TATA MOTOR'), NONE);
  // ...but an EXACT hit still wins outright, even where the prefix rule alone would be
  // ambiguous. Adding the prefix fallback must not turn a name that already matched into a
  // refusal - "TATA MOTORS" is row 1's canonical key AND a prefix of row 2's.
  eq('an exact name match beats an otherwise-ambiguous prefix',
    g2.symbolsFor_(g2.loadMasterSymbols_(), '', 'Tata Motors Ltd'),
    { primary: 'TATAMOTORS.NS', fallback: '' });

  // ...but a row matching on SEVERAL OF ITS OWN keys must not veto itself.
  const g3 = load([HDR, [ISIN, 'ANAWIL WIRE', '', 'ANAWIL', 'ANAWIL WIRE & ENG']], { noOverrides: true });
  eq('a row matching on three of its own keys is not self-ambiguous',
    g3.symbolsFor_(g3.loadMasterSymbols_(), '', 'ANAWIL WIRE & ENGINEERING'),
    { primary: 'ANAWIL.NS', fallback: '' });

  // Short held names do not get to prefix-match: PREFIX_MIN is 6, the app's value.
  const g4 = load([HDR, ['INE333A01013', 'ACME INDUSTRIES LIMITED', '', 'ACMEIND', '']], { noOverrides: true });
  eq('a held name under 6 chars does not prefix-match anything',
    g4.symbolsFor_(g4.loadMasterSymbols_(), '', 'ACME'), NONE);
}

// ── the root-cause fix, on its own: aliases are now indexed ─────────────────────────────────
console.log('\n── the alias column ' + '─'.repeat(38));
{
  // No override for this one - it must resolve purely because the alias column is read now.
  const g = load([HDR, ['INE999Z01011', 'SOME LONG PROPER NAME LIMITED', '', 'SLPN', 'SOME LONG PROPR|BROKER SPELLING']]);
  const master = g.loadMasterSymbols_();
  eq('a held name that only matches an ALIAS now resolves',
    g.symbolsFor_(master, '', 'BROKER SPELLING'), { primary: 'SLPN.NS', fallback: '' });
  eq('the second pipe-separated alias works too',
    g.symbolsFor_(master, '', 'Some Long Propr'), { primary: 'SLPN.NS', fallback: '' });
  eq('the canonical name still resolves',
    g.symbolsFor_(master, '', 'Some Long Proper Name Ltd'), { primary: 'SLPN.NS', fallback: '' });
  eq('an unrelated name still resolves to nothing',
    g.symbolsFor_(master, '', 'Totally Different Co'), NONE);
}

// ── the guards that stop symbol/alias indexing causing new mis-resolutions ──────────────────
console.log('\n── key guards ' + '─'.repeat(44));
{
  // A 2-char key must not claim a name slot: "LT" is short enough to collide with real words,
  // and the app documents dropping it for exactly that reason. This matters MORE now that the
  // NSE Symbol column is indexed - "LT" arrives as a key whether or not anyone typed an alias.
  const g = load([
    HDR,
    ['INE111A01011', 'LARSEN AND TOUBRO LIMITED', '', 'LT', 'LT'],
    ['INE222A01012', 'LT FOODS LIMITED', '', 'LTFOODS', ''],
  ]);
  const master = g.loadMasterSymbols_();
  eq('a 2-char symbol/alias does not hijack a name', g.symbolsFor_(master, '', 'LT Foods'),
    { primary: 'LTFOODS.NS', fallback: '' });
  eq('and Larsen still resolves on its own name',
    g.symbolsFor_(master, '', 'Larsen and Toubro Ltd'), { primary: 'LT.NS', fallback: '' });

  // A canonical name outranks a symbol/alias claiming the same key - in EITHER row order.
  // Order-independence is the point: the app's claimAlias() has the same rule because the
  // rights ("-RE") rows carry the parent's full name in their Alias column.
  const canonFirst = load([
    HDR,
    ['INE333A01013', 'ACME LIMITED', '', 'ACMELTD', ''],           // canonical key "acme"
    ['INE444A01014', 'BETA INDUSTRIES LIMITED', '', 'ACME', ''],   // its TICKER is also "acme"
  ]);
  eq('a canonical name outranks a LATER row’s ticker for the same key',
    canonFirst.symbolsFor_(canonFirst.loadMasterSymbols_(), '', 'Acme Ltd'),
    { primary: 'ACMELTD.NS', fallback: '' });

  const aliasFirst = load([
    HDR,
    ['INE444A01014', 'BETA INDUSTRIES LIMITED', '', 'ACME', ''],   // ticker claims "acme" first
    ['INE333A01013', 'ACME LIMITED', '', 'ACMELTD', ''],           // canonical must displace it
  ]);
  eq('...and outranks an EARLIER row’s ticker too (order-independent)',
    aliasFirst.symbolsFor_(aliasFirst.loadMasterSymbols_(), '', 'Acme Ltd'),
    { primary: 'ACMELTD.NS', fallback: '' });

  // First writer still wins between two claims of EQUAL rank.
  const g2 = load([
    HDR,
    ['INE333A01013', 'ACME INDUSTRIES LIMITED', '', 'ACMEIND', ''],
    ['INE444A01014', 'DIFFERENT CO LIMITED', '', 'DIFFCO', 'ACME INDUSTRIES'],
  ]);
  eq('a canonical name outranks a later row’s alias for the same string',
    g2.symbolsFor_(g2.loadMasterSymbols_(), '', 'Acme Industries Ltd'), { primary: 'ACMEIND.NS', fallback: '' });
}

// ── the existing behaviour this must not have broken ────────────────────────────────────────
console.log('\n── regressions ' + '─'.repeat(43));
{
  const g = load([
    HDR,
    ['INE002A01018', 'RELIANCE INDUSTRIES LIMITED', '500325', 'RELIANCE', ''],
    ['INE555A01015', 'BSE ONLY SCRIP LIMITED', '539001', '', ''],
  ]);
  const master = g.loadMasterSymbols_();
  eq('NSE is primary, BSE the fallback', g.symbolsFor_(master, 'INE002A01018', 'Reliance Industries'),
    { primary: 'RELIANCE.NS', fallback: '500325.BO' });
  eq('a BSE-only scrip uses BSE as primary, with no fallback',
    g.symbolsFor_(master, 'INE555A01015', 'BSE Only Scrip'), { primary: '539001.BO', fallback: '' });
  eq('an unknown scrip still returns nothing rather than a bogus symbol',
    g.symbolsFor_(master, 'INE000X01019', 'Nothing Like This'), NONE);
  // The pre-existing overrides must survive the edits to the array.
  eq('an existing override still resolves', g.symbolsFor_(master, 'INE348N01042', 'Manbro Industries'),
    { primary: 'MANBRO.BO', fallback: '' });
}

// ── the diagnostic must not lie about itself ────────────────────────────────────────────────
// /exec?sym= exists to answer "why did this not fetch" against the LIVE sheet. A diagnostic that
// reports the wrong rule - or claims a match it did not make - is worse than none, because it
// manufactures confidence. So it gets asserted like anything else.
console.log('\n── the ?sym= probe ' + '─'.repeat(39));
{
  const g = load([HDR, [ISIN, CANON, '', 'ANAWIL', '']], { noOverrides: true });
  const p = g.probeSymbol_(HELD, '');
  eq('the probe names the rule that actually fired', p.rule, 'truncated prefix');
  eq('...and the row it locked onto, so a human can see it is the right company',
    p.matchedRow, { name: CANON, isin: ISIN, nse: 'ANAWIL', bse: '' });
  eq('...and the ticker it returns agrees with symbolsFor_',
    [p.primary, p.fallback], [g.symbolsFor_(g.loadMasterSymbols_(), '', HELD).primary, '']);
  ok('...and carries a version marker, so "not fixed" and "not deployed" are distinguishable',
    typeof p.version === 'string' && p.version === g.RESOLVER_VERSION_ && p.version.length > 0,
    JSON.stringify(p.version));

  // An honest miss must read as a miss, not as a match with empty fields.
  const miss = g.probeSymbol_('Nothing Like This At All', '');
  ok('a genuine miss says NOTHING MATCHED and returns no row',
    /NOTHING MATCHED/.test(miss.rule) && miss.matchedRow === null && miss.primary === '',
    JSON.stringify(miss.rule) + ' / ' + JSON.stringify(miss.matchedRow));

  // With the override restored it must say so - "it works" and "somebody hand-listed it" are
  // different answers, and only one of them means the general fix is doing anything.
  const g2 = load([HDR, [ISIN, CANON, '', 'ANAWIL', '']]);
  eq('with the override in place the probe credits the override, not the prefix rule',
    g2.probeSymbol_(HELD, '').rule, 'SYMBOL_OVERRIDES (hand-written)');
}

console.log('\n' + '='.repeat(58));
for (const f of fails) console.log('  FAIL ' + f);
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) process.exitCode = 1;
