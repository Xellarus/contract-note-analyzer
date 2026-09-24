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
    Utilities: {
      sleep() {},
      base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
    },
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
    '({loadMasterSymbols_, symbolsFor_, normName_, symbolOverrideFor_, masterPrefixHit_, probeSymbol_, samcoBhavUrl_, parseBhavcopy_, parseBhavcopyNse_, bhavTargets_, RESOLVER_VERSION_})'
  ).runInContext(ctx);
}

/**
 * `load` with a SpreadsheetApp that behaves like a sheet: it returns `rows` and captures whatever
 * is written back. Needed because `writePriceHistory_` is the only part of the price-history path
 * that talks to Sheets, and it carries the fill-only rule everything else depends on.
 */
function loadWithSheet(rows, onWrite) {
  const ctx = {
    console,
    Logger: { log() {} },
    Utilities: { sleep() {}, base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64') },
    UrlFetchApp: { fetchAll: () => [], fetch: () => ({ getResponseCode: () => 500, getContentText: () => '' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: {
      flush() {},
      openById: () => ({
        getSheetByName: () => ({
          getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
          getMaxRows: () => 1000,
          getMaxColumns: () => 100,
          insertRowsAfter() {}, insertColumnsAfter() {},
          deleteRows() {}, deleteColumns() {},
          getRange: () => ({
            setNumberFormat() { return this; },
            setValues(v) { onWrite(v); return this; },
            setValue() { return this; },
          }),
          clear() {}, clearContents() {},
        }),
        insertSheet: () => null,
      }),
    },
  };
  vm.createContext(ctx);
  new vm.Script(SRC).runInContext(ctx);
  return new vm.Script('({writePriceHistory_})').runInContext(ctx);
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

// ── Samco bhavcopy URL ──────────────────────────────────────────────────────────────────────
//
// Samco republishes the daily BSE/NSE bhavcopy and, unlike bseindia.com/download, its links are
// DETERMINISTIC: base64 of the file's path on their server, with the padding stripped. That is
// what makes a backfill possible at all — and it means one silent slip (a wrong path segment, the
// padding left on, a date formatted one way in the folder and another in the filename) fetches a
// 404 for every date, which is indistinguishable from "the source is blocked".
//
// Pinned against a link the owner actually downloaded, 24-Sep-2026. Same rule the parser fixtures
// follow: from real output, never hand-typed.
{
  const { samcoBhavUrl_ } = load([]);
  const REAL = 'https://www.samco.in/bse_nse_mcx/datacopy/'
    + 'L3Zhci93d3cvaHRtbC9zYW1jby9wdWJsaWNfaHRtbC9Eb3dubG9hZHMvYmhhdmNvcHlfZGF0YS8yMDI2LTAzLTMwLzIwMjYwMzMwX0JTRS5jc3Y';
  const decode = (u) => Buffer.from(u.split('/datacopy/')[1], 'base64').toString('utf8');

  eq('samco: the builder reproduces a link the owner really downloaded',
    samcoBhavUrl_(new Date(2026, 2, 30), 'BSE'), REAL);

  // The decoded path is the actual contract. Asserting it says WHAT changed when this breaks,
  // rather than leaving a diff of two base64 blobs.
  eq('samco: ...and the path it encodes is the one on their server',
    decode(samcoBhavUrl_(new Date(2026, 2, 30), 'BSE')),
    '/var/www/html/samco/public_html/Downloads/bhavcopy_data/2026-03-30/20260330_BSE.csv');

  // The date appears TWICE in two different formats. Padding one and not the other is the easiest
  // way to build a URL that looks entirely plausible and 404s.
  eq('samco: a single-digit month and day pad in BOTH places',
    decode(samcoBhavUrl_(new Date(2016, 3, 1), 'BSE')),
    '/var/www/html/samco/public_html/Downloads/bhavcopy_data/2016-04-01/20160401_BSE.csv');

  eq('samco: the segment is a parameter, so NSE costs nothing',
    decode(samcoBhavUrl_(new Date(2026, 2, 30), 'NSE')),
    '/var/www/html/samco/public_html/Downloads/bhavcopy_data/2026-03-30/20260330_NSE.csv');

  // Left on, the padding makes a different string and every fetch 404s.
  ok('samco: base64 padding is stripped', samcoBhavUrl_(new Date(2026, 2, 30), 'BSE').indexOf('=') < 0);
}


// ── bhavcopy parsing ────────────────────────────────────────────────────────────────────────
//
// Both fixture rows are REAL: the header and first data row of the files the probe actually
// fetched on 24-Sep-2026. Hand-typing them would defeat the point, exactly as it would for a
// contract-note parser.
{
  const { parseBhavcopy_, bhavTargets_, normName_ } = load([]);

  const HDR = 'SC_CODE,SC_NAME,SC_GROUP,SC_TYPE,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,NO_TRADES,NO_OF_SHRS,NET_TURNOV,TDCLOINDI';
  const ROW_2026 = '500002,"ABB INDIA LIMITED",A,STK,5970,6100,5908,5936.5,5936.5,6106.7,3371,14736,88308032,';
  const ROW_2016 = '500002,"ABB LTD.",A,Q,1272.00,1312.00,1264.00,1291.25,1291.25,1276.50,2469,14976,19433236.00,';
  const RUDRA = '514010,"RUDRA ECOVATION LTD",XT,STK,24.5,25.46,23.1,24.67,24.67,24.7,318,91000,2244700,';

  const want = { '500002': 'INE117A01022', '514010': 'INE723D01021' };

  // CLOSE is column 8 of 14. Taking OPEN, HIGH or LAST instead is the kind of wrong that looks
  // entirely plausible on a report.
  //
  // The real rows above have CLOSE === LAST (5936.5 and 5936.5), which is usual and which made
  // the first version of this check BLIND: a probe swapping CLOSE for LAST changed nothing and
  // came back silent. This row separates them, so each neighbouring column is a distinct number
  // and picking the wrong one cannot pass.
  const SPREAD = '500003,"DISTINCT COLUMNS LTD",A,STK,11,22,33,44,55,66,7,8,9,';
  const rs = parseBhavcopy_([HDR, SPREAD].join('\n'), { '500003': 'K' });
  eq('bhav: CLOSE is picked, not OPEN (11), HIGH (22), LOW (33) or LAST (55)', rs.closes['K'], 44);

  const r26 = parseBhavcopy_([HDR, ROW_2026, RUDRA].join('\n'), want);
  eq('bhav: the real 2026 row reads through', r26.closes['INE117A01022'], 5936.5);
  eq('bhav: ...for every wanted code in the file', r26.closes['INE723D01021'], 24.67);
  eq('bhav: ...and only the wanted ones', Object.keys(r26.closes).length, 2);

  // THE 2016 FILES USE A DIFFERENT SC_TYPE. 2026 says STK, 2016 says Q — an equity filter that
  // knew only STK would silently drop every row of the older half of the backfill.
  const r16 = parseBhavcopy_([HDR, ROW_2016].join('\n'), want);
  eq('bhav: a 2016 file (SC_TYPE "Q") is read, not silently dropped', r16.closes['INE117A01022'], 1291.25);

  // SC_NAME is quoted and may contain a comma. A naive split shifts every later column left, so
  // CLOSE would come back as PREVCLOSE for exactly those rows and nothing would look wrong.
  const COMMA = '500002,"ABB INDIA LIMITED, THE",A,STK,5970,6100,5908,5936.5,5936.5,6106.7,3371,14736,88308032,';
  eq('bhav: a comma inside the quoted name does not shift the columns',
    parseBhavcopy_([HDR, COMMA].join('\n'), want).closes['INE117A01022'], 5936.5);

  // Header-driven, never positional: a column inserted upstream must not turn OPEN into CLOSE.
  const MOVED = 'SC_CODE,SC_NAME,SC_GROUP,SC_TYPE,EXTRA,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE';
  eq('bhav: an inserted column is survived, because the header is read',
    parseBhavcopy_([MOVED, '500002,"ABB",A,STK,zzz,5970,6100,5908,5936.5,5936.5,6106.7'].join('\n'), want)
      .closes['INE117A01022'], 5936.5);

  // A file whose columns cannot be identified contributes NOTHING rather than the wrong column.
  const NOHDR = parseBhavcopy_(['a,b,c,d', '1,2,3,4'].join('\n'), want);
  eq('bhav: an unrecognisable header yields no prices at all', Object.keys(NOHDR.closes).length, 0);
  ok('bhav: ...and says so', NOHDR.noHeader === true);

  // 0 is not a price, it is the absence of one - the same rule the grid already follows.
  const ZERO = parseBhavcopy_([HDR, '514010,"RUDRA",XT,STK,0,0,0,0,0,0,0,0,0,'].join('\n'), want);
  eq('bhav: a zero close is rejected, never stored', Object.keys(ZERO.closes).length, 0);

  // Debt and other instruments sit in the same file; a bond's close in an equity column is a
  // wrong valuation that reads perfectly.
  const BOND = parseBhavcopy_([HDR, '514010,"SOME BOND",F,DB,100,100,100,100,100,100,1,1,1,'].join('\n'), want);
  eq('bhav: a non-equity instrument is skipped', Object.keys(BOND.closes).length, 0);

  // The master stores BSE codes as typed; the file pads them. Neither side may win by accident.
  const PADDED = parseBhavcopy_([HDR, '0514010,"RUDRA ECOVATION LTD",XT,STK,24.5,25.46,23.1,24.67,24.67,24.7,1,1,1,'].join('\n'), want);
  eq('bhav: a leading-zero scrip code still matches', PADDED.closes['INE723D01021'], 24.67);

  // The target map must compute the SAME key the price-history writer computes, or the backfill
  // creates a second column for a scrip that already has one.
  const master = {
    byIsin: { 'INE723D01021': { isin: 'INE723D01021', bse: '514010', nse: '' } },
    byName: { [normName_('RUDRA ECOVATION LIMITED')]: { isin: 'INE723D01021', bse: '514010', nse: '' } },
  };
  const tg = bhavTargets_(master, [{ isin: '', name: 'RUDRA ECOVATION LIMITED' }]);
  eq('bhav: a held scrip maps its BSE code to the grid key', tg.byCode['514010'], 'INE723D01021');
  eq('bhav: ...counted once', tg.count, 1);

  const none = bhavTargets_({ byIsin: {}, byName: {} }, [{ isin: '', name: 'NOT IN MASTER' }]);
  eq('bhav: a scrip with no BSE code is not a target', none.count, 0);
}

// ── fill-only, driven through the REAL writer ───────────────────────────────────────────────
//
// This is the rule that stops the bhavcopy backfill and the Yahoo top-up contending for a cell,
// and it was untested: a probe deleting it came back silent. It also makes a re-run idempotent,
// which is the whole of the backfill's resumability.
{
  const GRID = [
    ['Date', 'KEEP', 'FILL'],
    ['2026-03-30', 111, ''],          // KEEP already has a close; FILL is blank
  ];
  let written = null;
  const { writePriceHistory_ } = loadWithSheet(GRID, (v) => { written = v; });

  writePriceHistory_(['KEEP', 'FILL'], { '2026-03-30': { KEEP: 999, FILL: 222 } }, false, null, true);

  const hdr = written[0];
  const row = written[1];
  eq('fill-only: an existing close is NOT overwritten', row[hdr.indexOf('KEEP')], 111);
  eq('fill-only: ...while a blank cell IS filled', row[hdr.indexOf('FILL')], 222);

  // Without the flag the writer must still overwrite, or the Yahoo top-up could never correct a
  // value it had previously written.
  written = null;
  const w2 = loadWithSheet(GRID, (v) => { written = v; }).writePriceHistory_;
  w2(['KEEP'], { '2026-03-30': { KEEP: 999 } }, false, null, false);
  eq('fill-only: OFF still overwrites, so the normal top-up is unchanged',
    written[1][written[0].indexOf('KEEP')], 999);
}


// ── NSE bhavcopy parsing ────────────────────────────────────────────────────────────────────
//
// Real header and real row, from the file the probe fetched on 24-Sep-2026. A DIFFERENT shape
// from the BSE one, which is why it is a separate parser rather than a flag.
{
  const { parseBhavcopyNse_ } = load([]);

  const HDR = 'SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP,TOTALTRADES,ISIN';
  const GOLD = 'SGBJUN28,GB,13681.01,13750,13602,13617.6,13610,13679.58,537,7328807.71,30-Mar-2026,109,IN0020200104';
  const EQ   = 'INFY,EQ,1500,1520,1490,1510.5,1509,1495,100,200,30-Mar-2026,50,INE009A01021';

  const byIsin = { 'INE009A01021': 'INE009A01021' };
  const bySym = { 'INFY': 'INE009A01021' };

  // ISIN is the STRONGER join and the one this file makes possible: the grid keys on
  // `isin || …`, so an ISIN match is the identity itself rather than a lookup through a ticker.
  const r = parseBhavcopyNse_([HDR, GOLD, EQ].join('\n'), byIsin, {});
  eq('nse: joins on ISIN, which is the grid key itself', r.closes['INE009A01021'], 1510.5);
  eq('nse: ...and takes nothing it was not asked for', Object.keys(r.closes).length, 1);

  // CLOSE (1510.5) sits between LOW (1490) and LAST (1509) — every neighbour reads as a price.
  const SPREAD = 'AAA,EQ,11,22,33,44,55,66,1,2,30-Mar-2026,3,INE000A01000';
  eq('nse: CLOSE is picked, not LOW (33) or LAST (55)',
    parseBhavcopyNse_([HDR, SPREAD].join('\n'), { 'INE000A01000': 'K' }, {}).closes['K'], 44);

  // Symbol is the FALLBACK, for a holding whose master row carries no ISIN.
  eq('nse: falls back to SYMBOL when the ISIN is not one we hold',
    parseBhavcopyNse_([HDR, EQ].join('\n'), {}, bySym).closes['INE009A01021'], 1510.5);

  // SERIES guards the SYMBOL path only. One symbol can appear under EQ and BE in one file, so an
  // unqualified match could take the wrong row's close.
  const BOND_SYM = 'INFY,GB,1,1,1,9999,1,1,1,1,30-Mar-2026,1,IN0020200104';
  eq('nse: a non-equity SERIES is skipped on the symbol path',
    Object.keys(parseBhavcopyNse_([HDR, BOND_SYM].join('\n'), {}, bySym).closes).length, 0);
  // ...but an ISIN match needs no series test at all: a gold bond has its OWN isin.
  eq('nse: the SME series is equity and is kept',
    parseBhavcopyNse_([HDR, 'AAA,SM,1,1,1,77,1,1,1,1,30-Mar-2026,1,INE000A01000'].join('\n'),
      {}, { 'AAA': 'K' }).closes['K'], 77);

  // First writer wins WITHIN a file too, or a later series row overwrites the one already taken.
  const TWICE = ['INFY,EQ,1,1,1,100,1,1,1,1,30-Mar-2026,1,INE009A01021',
                 'INFY,BE,1,1,1,200,1,1,1,1,30-Mar-2026,1,INE009A01021'];
  eq('nse: a second row for the same scrip does not replace the first',
    parseBhavcopyNse_([HDR].concat(TWICE).join('\n'), byIsin, {}).closes['INE009A01021'], 100);

  const NOHDR = parseBhavcopyNse_(['a,b,c', '1,2,3'].join('\n'), byIsin, bySym);
  eq('nse: an unrecognisable header yields nothing', Object.keys(NOHDR.closes).length, 0);
  ok('nse: ...and says so', NOHDR.noHeader === true);

  eq('nse: a zero close is rejected',
    Object.keys(parseBhavcopyNse_([HDR, 'AAA,EQ,0,0,0,0,0,0,0,0,30-Mar-2026,0,INE000A01000'].join('\n'),
      { 'INE000A01000': 'K' }, {}).closes).length, 0);
}


console.log('\n' + '='.repeat(58));
for (const f of fails) console.log('  FAIL ' + f);
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) process.exitCode = 1;
