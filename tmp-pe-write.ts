/**
 * Coverage for appendPrivateEquity — the writer that registers a company on the shared
 * "Private Equities" tab.
 *
 * This is the highest-consequence write in the app: the tab is the ONLY thing that marks a
 * company unlisted, it lives in the SHARED scrip master, and it moves a tax figure (long-term
 * at 24 months instead of 12). Nothing else in the toolchain can see a wrong row here — a name
 * appended into the Drive column simply never reads back as a company, and the holding stays
 * classified as listed equity with no error anywhere.
 *
 * Run: node tmp-pe-write-run.mjs
 */
import { appendPrivateEquity, PE_HEADER_ROW, updatePrivateEquityCmp, setPrivateEquityCmp } from './src/lib/privateEquityWrite';
import { detectPeColumns, parsePrivateEquityVals, PRIVATE_EQUITIES_TAB } from './src/lib/privateEquities';
import { loadScripMaster, invalidateScripCache, SCRIP_MASTER_SPREADSHEET_ID } from './src/lib/scripMaster';
import { invalidatePrivateEquityCache } from './src/lib/privateEquities';

const g: any = globalThis;
let pass = 0, fail = 0;

const ok = (name: string, cond: any, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const eq = (name: string, got: any, want: any) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  ok(name, a === b, `got ${a}, want ${b}`);
};

// scripMaster quotes its tab (`quoteTab`); privateEquities deliberately does not. Both
// strings below are the ones the real code builds - a mismatch here would fake a passing test.
const MASTER_RANGE = `'Scrips'!A1:Z50000`;
const PE_RANGE = `${PRIVATE_EQUITIES_TAB}!A1:J5000`;
const SID = SCRIP_MASTER_SPREADSHEET_ID;

/** The master's first tab: ISIN | Security Name | BSE | NSE | Alias name. */
const MASTER_ROWS = [
  ['ISIN', 'Security Name', 'BSE', 'NSE', 'Alias name'],
  ['INE001A01011', 'ACME INFRA LIMITED', '500001', 'ACMEINFRA', ''],
  ['INE002A01018', 'TATA MOTORS LIMITED', '500570', 'TATAMOTORS', ''],
];

/** Reset every cache and stub global between cases — the master caches for 90s, PE for 60s. */
const install = (peVals: any[][] | undefined, opts: { missing?: boolean; peFail?: boolean } = {}) => {
  g.__sheetTabs = ['Scrips', PRIVATE_EQUITIES_TAB];
  g.__ranges = { [`${SID}::${MASTER_RANGE}`]: MASTER_ROWS } as any;
  if (peVals !== undefined) g.__ranges[`${SID}::${PE_RANGE}`] = peVals;
  g.__missingRange = opts.missing ? `${SID}::${PE_RANGE}` : null;
  g.__failRange = opts.peFail ? `${SID}::${PE_RANGE}` : null;
  g.__appended = [];
  g.__batched = [];
  invalidateScripCache();
  invalidatePrivateEquityCache();
};

const lastAppend = () => (g.__appended || [])[g.__appended.length - 1];

async function main() {
  console.log('\n── appendPrivateEquity ' + '─'.repeat(38));

  // ── 1. the header the writer creates must map back through the READER ─────────────────────
  // If these two ever disagree the tab it creates is unreadable by the app that created it.
  {
    const { hasHeader, ci } = detectPeColumns([PE_HEADER_ROW]);
    ok('created header is detected AS a header', hasHeader);
    eq('created header maps every column', ci,
      { company: 0, driveLink: 1, isin: 2, valuation: 3, valuationDate: 4, notes: 5 });
  }

  // ── 2. the happy path on a conventional tab ───────────────────────────────────────────────
  {
    install([['Company', 'Drive Link', 'ISIN', 'Valuation', 'Valuation Date', 'Notes'],
             ['STRIDE VENTURES LLP', '', '', 100, '', '']]);
    const master = await loadScripMaster(SID);
    const r = await appendPrivateEquity(SID, master, '  Jeena Sikho Lifecare  ');
    ok('accepts a genuinely new company', r.status === 'added', JSON.stringify(r));
    if (r.status === 'added') {
      eq('name is trimmed', r.company, 'Jeena Sikho Lifecare');
      eq('no tab had to be created', r.createdTab, false);
    }
    const req = lastAppend();
    ok('one append was issued', !!req);
    if (req) {
      eq('appended to the Private Equities tab', req.range, `${PRIVATE_EQUITIES_TAB}!A1`);
      eq('inserts rows rather than overwriting', req.insertDataOption, 'INSERT_ROWS');
      eq('exactly one row (no header re-written)', req.resource.values.length, 1);
      eq('name in the company column, padded to the sheet width',
        req.resource.values[0], ['Jeena Sikho Lifecare', '', '', '', '', '']);
      // The decisive assertion: read the sheet back the way the app will.
      const after = parsePrivateEquityVals([...g.__ranges[`${SID}::${PE_RANGE}`], req.resource.values[0]]);
      ok('reads back as an unlisted company', after.some(x => x.company === 'Jeena Sikho Lifecare'));
      eq('reads back with no valuation, so it is carried at cost',
        after.find(x => x.company === 'Jeena Sikho Lifecare')?.valuation, 0);
    }
  }

  // ── 3. THE header-aware case: a tab whose columns are in a different order ────────────────
  // Positional writing passes every other test in this file and fails only here.
  {
    install([['Notes', 'ISIN', 'Valuation Date', 'Company Name', 'Fair Value', 'Drive Folder'],
             ['seed', '', '', 'STRIDE VENTURES LLP', 100, '']]);
    const master = await loadScripMaster(SID);
    const r = await appendPrivateEquity(SID, master, 'Jeena Sikho Lifecare');
    ok('accepts on a reordered tab', r.status === 'added', JSON.stringify(r));
    const req = lastAppend();
    if (req) {
      eq('name lands in column D, where THIS sheet keeps the company',
        req.resource.values[0], ['', '', '', 'Jeena Sikho Lifecare', '', '']);
      const after = parsePrivateEquityVals([...g.__ranges[`${SID}::${PE_RANGE}`], req.resource.values[0]]);
      ok('and reads back correctly from the reordered tab',
        after.some(x => x.company === 'Jeena Sikho Lifecare'));
    }
  }

  // ── 4. duplicate guards ───────────────────────────────────────────────────────────────────
  {
    install([['Company', 'Valuation'], ['STRIDE VENTURES LLP', 100]]);
    const master = await loadScripMaster(SID);

    const exact = await appendPrivateEquity(SID, master, 'STRIDE VENTURES LLP');
    eq('refuses an exact duplicate', exact.status === 'refused' && exact.reason, 'already-pe');

    const cased = await appendPrivateEquity(SID, master, 'stride ventures llp');
    eq('refuses a case-only difference', cased.status === 'refused' && cased.reason, 'already-pe');

    eq('and nothing was written for either', (g.__appended || []).length, 0);
  }

  // ── 5. the normName collapse — the dangerous near-duplicate ───────────────────────────────
  // `normName` strips limited/ltd/private/pvt/the/co, so these collapse to one key. Two entries
  // claiming one identity is how a position silently divides between them.
  {
    install([['Company', 'Valuation'], ['ACME HOLDINGS PRIVATE LIMITED', 100]]);
    const master = await loadScripMaster(SID);
    const r = await appendPrivateEquity(SID, master, 'Acme Holdings Ltd');
    eq('refuses a name that normalises onto an existing PE row',
      r.status === 'refused' && r.reason, 'already-pe');
    eq('nothing written', (g.__appended || []).length, 0);
  }

  // ── 6. collision with a LISTED security ───────────────────────────────────────────────────
  // Appending here would hand a listed company's identity to an unlisted one and reclassify a
  // real holding. The message has to say so.
  {
    install([['Company', 'Valuation'], ['STRIDE VENTURES LLP', 100]]);
    const master = await loadScripMaster(SID);
    const r = await appendPrivateEquity(SID, master, 'Acme Infra Ltd');
    eq('refuses a name matching a listed security', r.status === 'refused' && r.reason, 'listed-collision');
    ok('and names the security it would have merged with',
      r.status === 'refused' && /ACME INFRA LIMITED/.test(r.message), r.status === 'refused' ? r.message : '');
    eq('nothing written', (g.__appended || []).length, 0);
  }

  // ── 7. refuse rather than guess when identity cannot be established ───────────────────────
  {
    install([['Company', 'Valuation'], ['STRIDE VENTURES LLP', 100]]);
    const noMaster = await appendPrivateEquity(SID, null, 'Anything');
    eq('refuses with no master at all', noMaster.status === 'refused' && noMaster.reason, 'no-master');

    const blank = await appendPrivateEquity(SID, await loadScripMaster(SID), '   ');
    eq('refuses a blank name', blank.status === 'refused' && blank.reason, 'blank');
    eq('nothing written', (g.__appended || []).length, 0);
  }

  // ── 8. a FAILED PE read must not be read as "not there yet" ──────────────────────────────
  // On a failed read every company looks absent, so the plain "add it" path would talk the user
  // into a duplicate row for a company already on the tab.
  {
    install([['Company', 'Valuation'], ['STRIDE VENTURES LLP', 100]], { peFail: true });
    const master = await loadScripMaster(SID);
    ok('the master recorded the PE read failure', master.peFailed === true);
    const r = await appendPrivateEquity(SID, master, 'Jeena Sikho Lifecare');
    eq('refuses while the tab is unreadable', r.status === 'refused' && r.reason, 'pe-unreadable');
    eq('nothing written', (g.__appended || []).length, 0);
  }

  // ── 9. an ABSENT tab is created, with its header ──────────────────────────────────────────
  {
    install(undefined, { missing: true });
    const master = await loadScripMaster(SID);
    const r = await appendPrivateEquity(SID, master, 'Jeena Sikho Lifecare');
    ok('accepts when the tab does not exist yet', r.status === 'added', JSON.stringify(r));
    if (r.status === 'added') eq('reports that it created the tab', r.createdTab, true);
    const created = (g.__batched || []).flatMap((b: any) => b.resource?.requests || [])
      .find((q: any) => q.addSheet);
    ok('an addSheet request was issued', !!created);
    eq('with the exact tab name the reader looks for',
      created?.addSheet?.properties?.title, PRIVATE_EQUITIES_TAB);
    const req = lastAppend();
    if (req) {
      eq('header written above the first company', req.resource.values.length, 2);
      eq('the header is the canonical one', req.resource.values[0], PE_HEADER_ROW);
      eq('the company row follows it', req.resource.values[1],
        ['Jeena Sikho Lifecare', '', '', '', '', '']);
      const after = parsePrivateEquityVals(req.resource.values);
      eq('and the created tab reads back as exactly one company', after.length, 1);
      eq('with the right name', after[0]?.company, 'Jeena Sikho Lifecare');
    }
  }

  // ── 10. a tab that exists but is empty also gets the header ───────────────────────────────
  {
    install([]);
    const master = await loadScripMaster(SID);
    const r = await appendPrivateEquity(SID, master, 'Jeena Sikho Lifecare');
    ok('accepts on an empty tab', r.status === 'added', JSON.stringify(r));
    if (r.status === 'added') eq('but does NOT claim to have created the tab', r.createdTab, false);
    eq('no addSheet was issued', (g.__batched || []).length, 0);
    const req = lastAppend();
    if (req) eq('header + row written', req.resource.values.length, 2);
  }

  // ── 11. a REAL read error must propagate, not be swallowed as "absent" ───────────────────
  // The `missing` stub throws "Unable to parse range" (absent tab, legitimate). A 500 is a
  // different thing entirely and must never lead to a write.
  {
    install([['Company', 'Valuation'], ['STRIDE VENTURES LLP', 100]]);
    const master = await loadScripMaster(SID);
    // Fail the read only now, AFTER the master loaded cleanly, so peFailed is false and the
    // write reaches its own read.
    g.__failRange = `${SID}::${PE_RANGE}`;
    let threw = false;
    try { await appendPrivateEquity(SID, master, 'Jeena Sikho Lifecare'); } catch { threw = true; }
    ok('a 500 on the write-time read throws rather than writing', threw);
    eq('nothing written', (g.__appended || []).length, 0);
  }

  // ── registering onto a DIFFERENT class tab ────────────────────────────────
  // The class was hard-coded to Private Equities. A mutual fund landing there inherits 730 days
  // and no STT - and becomes CLASSIFIABLE on a rule that does not apply to it, which is worse
  // than the refusal it is supposed to get.
  {
    install([['Company', 'ISIN'], ['STRIDE VENTURES LLP', '']]);
    g.__ranges[`${SID}::AIF!A1:J5000`] = [['Company', 'ISIN'], ['HELION FUND II', '']];
    invalidateScripCache(); invalidatePrivateEquityCache();
    const master = await loadScripMaster(SID);

    const r = await appendPrivateEquity(SID, master, 'Parag Parikh Flexi Cap Fund', 'MF');
    ok('accepts a new company on the Mutual Fund tab', r.status === 'added', JSON.stringify(r));
    const req = lastAppend();
    eq('appended to the MUTUAL FUND tab, not Private Equities', req?.range, 'Mutual Fund!A1');
    const created = (g.__batched || []).flatMap((b: any) => b.resource?.requests || []).find((q: any) => q.addSheet);
    eq('and created that tab, since it did not exist', created?.addSheet?.properties?.title, 'Mutual Fund');

    // Already on the AIF tab -> refused, and the message must name AIF rather than the tab we
    // happen to be writing to, or the user adds a second identity for one company.
    const dup = await appendPrivateEquity(SID, master, 'HELION FUND II', 'PE');
    eq('a company already on ANOTHER class tab is refused', dup.status === 'refused' && dup.reason, 'already-pe');
    ok('and the message names the tab it is actually on',
      dup.status === 'refused' && /AIF/.test(dup.message), dup.status === 'refused' ? dup.message : '');
  }

  // ── updatePrivateEquityCmp ────────────────────────────────────────────────
  console.log('\n── updatePrivateEquityCmp ' + '─'.repeat(35));

  const MS = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
  const SER = (y: number, m: number, d: number) =>
    Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
  const cells = () => {
    const b = (g.__batched || []).filter((x: any) => x.resource?.data);
    return b.length ? b[b.length - 1].resource.data : [];
  };
  const cellAt = (range: string) => cells().find((d: any) => d.range === range)?.values?.[0]?.[0];
  const writeCalls = () => (g.__batched || []).filter((x: any) => x.resource?.data).length;

  // THE user's actual layout: ISIN in column A, CMP in column D.
  const USER_TAB = [
    ['ISIN', 'Company', 'Drive Link', 'CMP', 'Valuation Date', 'Notes'],
    ['INE900A01019', 'ACME VENTURES PRIVATE LIMITED', '', '', '', ''],
    ['INE901A01017', 'ZENITH CAPITAL LLP', '', 250, SER(2025, 6, 30), ''],
    ['INE902A01015', 'ORBIT LABS PRIVATE LIMITED', '', 90, '', ''],
  ];

  {
    const { hasHeader, ci } = detectPeColumns(USER_TAB);
    ok('the user layout is detected as a header', hasHeader);
    eq('ISIN in A, company in B, CMP read as the valuation column', ci,
      { company: 1, driveLink: 2, isin: 0, valuation: 3, valuationDate: 4, notes: 5 });
    const parsed = parsePrivateEquityVals(USER_TAB);
    eq('three companies read, by NAME not by ISIN', parsed.map(r => r.company),
      ['ACME VENTURES PRIVATE LIMITED', 'ZENITH CAPITAL LLP', 'ORBIT LABS PRIVATE LIMITED']);
    eq('"CMP" is read as the per-share value', parsed[1]?.valuation, 250);
  }

  // A tab that leads with ISIN and has NO name-like header must not read the ISIN as the name.
  {
    const { ci } = detectPeColumns([['ISIN', 'Particulars', 'CMP'], ['INE900A01019', 'ACME', 12]]);
    eq('company falls back past the ISIN column, not onto it', ci.company, 1);
  }

  // blank CMP → write (nothing to protect)
  {
    install(USER_TAB);
    const master = await loadScripMaster(SID);
    const r = await updatePrivateEquityCmp(SID, [
      { isin: 'INE900A01019', name: 'ACME VENTURES PRIVATE LIMITED', price: 412.5, ts: MS(2025, 9, 20) },
    ]);
    eq('a blank CMP is filled', r.written.map(w => w.price), [412.5]);
    eq('written into column D of the right row', cellAt(`${PRIVATE_EQUITIES_TAB}!D2`), 412.5);
    eq('with the trade date as a SERIAL in column E',
      cellAt(`${PRIVATE_EQUITIES_TAB}!E2`), SER(2025, 9, 20));
    eq('one batch call, two cells', cells().length, 2);
  }

  // CMP set + dated, trade NEWER → overwrite
  {
    install(USER_TAB);
    await loadScripMaster(SID);
    const r = await updatePrivateEquityCmp(SID, [
      { isin: 'INE901A01017', name: 'ZENITH CAPITAL LLP', price: 300, ts: MS(2025, 11, 5) },
    ]);
    eq('a dated CMP is replaced by a NEWER trade', r.written.map(w => w.price), [300]);
    eq('into row 3', cellAt(`${PRIVATE_EQUITIES_TAB}!D3`), 300);
    eq('and the stamp moves to the trade date', cellAt(`${PRIVATE_EQUITIES_TAB}!E3`), SER(2025, 11, 5));
  }

  // CMP set + dated, trade OLDER → leave alone. This is what stops a rebuild of a portfolio
  // holding an older trade from dragging the price backwards.
  {
    install(USER_TAB);
    await loadScripMaster(SID);
    const r = await updatePrivateEquityCmp(SID, [
      { isin: 'INE901A01017', name: 'ZENITH CAPITAL LLP', price: 300, ts: MS(2025, 2, 1) },
    ]);
    eq('an OLDER trade does not replace a dated CMP', r.written.length, 0);
    eq('skipped as not-newer', r.skipped.map(s => s.reason), ['not-newer']);
    eq('nothing was written at all', writeCalls(), 0);
  }

  // CMP set, NO date → never touched automatically.
  {
    install(USER_TAB);
    await loadScripMaster(SID);
    const r = await updatePrivateEquityCmp(SID, [
      { isin: 'INE902A01015', name: 'ORBIT LABS PRIVATE LIMITED', price: 500, ts: MS(2026, 1, 1) },
    ]);
    eq('an UNDATED hand-entered CMP is left alone', r.written.length, 0);
    eq('skipped as hand-entered', r.skipped.map(s => s.reason), ['hand-entered']);
  }

  // ...but a manual edit forces through it. Without `force` this silently did nothing, which is
  // the most common case there is: typing a number into the sheet leaves the date blank.
  {
    install(USER_TAB);
    await loadScripMaster(SID);
    const r = await setPrivateEquityCmp(SID, 'INE902A01015', 'ORBIT LABS PRIVATE LIMITED', 500, MS(2026, 1, 1));
    eq('a MANUAL edit overrides an undated CMP', r.written.map(w => w.price), [500]);
    eq('into row 4', cellAt(`${PRIVATE_EQUITIES_TAB}!D4`), 500);
    eq('and stamps the date it was set', cellAt(`${PRIVATE_EQUITIES_TAB}!E4`), SER(2026, 1, 1));
  }

  // row located by NAME when the update carries no ISIN
  {
    install(USER_TAB);
    await loadScripMaster(SID);
    const r = await updatePrivateEquityCmp(SID, [
      { isin: '', name: 'acme ventures private limited', price: 77, ts: MS(2025, 9, 20) },
    ]);
    eq('falls back to a normalised NAME match', r.written.length, 1);
    eq('still the right row', cellAt(`${PRIVATE_EQUITIES_TAB}!D2`), 77);
  }

  // a company not on the tab is not unlisted - nothing to price, nothing to write
  {
    install(USER_TAB);
    await loadScripMaster(SID);
    const r = await updatePrivateEquityCmp(SID, [
      { isin: 'INE999A01011', name: 'NOT ON THE TAB LIMITED', price: 10, ts: MS(2025, 9, 20) },
    ]);
    eq('an absent company is skipped, never appended', r.skipped.map(s => s.reason), ['no-row']);
    eq('no write', writeCalls(), 0);
  }

  // no CMP column at all → reported, not thrown (the caller is a rebuild)
  {
    install([['Company', 'ISIN'], ['ACME VENTURES PRIVATE LIMITED', 'INE900A01019']]);
    await loadScripMaster(SID);
    const r = await updatePrivateEquityCmp(SID, [
      { isin: 'INE900A01019', name: 'ACME VENTURES PRIVATE LIMITED', price: 10, ts: MS(2025, 9, 20) },
    ]);
    ok('a tab with no CMP column reports it', r.noCmpColumn === true);
    eq('and skips every update', r.skipped.map(s => s.reason), ['no-cmp-column']);
  }

  // several companies, ONE call
  {
    install(USER_TAB);
    await loadScripMaster(SID);
    const r = await updatePrivateEquityCmp(SID, [
      { isin: 'INE900A01019', name: 'ACME VENTURES PRIVATE LIMITED', price: 100, ts: MS(2025, 9, 20) },
      { isin: 'INE901A01017', name: 'ZENITH CAPITAL LLP', price: 200, ts: MS(2025, 11, 5) },
    ]);
    eq('both written', r.written.length, 2);
    eq('in a single batch of four cells', cells().length, 4);
    eq('exactly one API call', writeCalls(), 1);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
