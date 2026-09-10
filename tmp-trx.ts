/**
 * Coverage for `generateTrxRegister` — the Capital Gains register writer.
 *
 * This file existed for one reason: the register had NO automated coverage at all, and
 * `npx tsc --noEmit` plus `npx vite build` both pass over a register whose columns are
 * shifted by one and whose tax buckets are swapped. Every assertion here is about the
 * VALUES that reach Google Sheets, captured from the stubbed `values.update` calls.
 *
 * Run it with `node tmp-trx-run.mjs` (esbuild bundles it and stubs `gapi-script`).
 *
 * Two fixtures, deliberately:
 *   A — no intraday at all. This is the one the delivery tab must reproduce EXACTLY,
 *       column-for-column, apart from the Intra-Day column being spliced out.
 *   B — a full round trip, a PARTIAL round trip (the Park Medi World shape), and a scrip
 *       whose only in-FY trade is intraday but which carries a holding all year. B is
 *       where the split can leak or double-count, so it is checked by conservation:
 *       every rupee of charge on the source rows must land on exactly one tab.
 */
import { generateTrxRegister } from './src/lib/trxRegister';
import { SCRIP_MASTER_SPREADSHEET_ID, invalidateScripCache } from './src/lib/scripMaster';
import { invalidatePrivateEquityCache } from './src/lib/privateEquities';

// ── tiny assert harness (same shape as the other tmp-* suites) ──────────────
let passed = 0;
const failures: string[] = [];
function eq(label: string, got: any, want: any) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; return; }
  failures.push(`${label}\n     got:  ${g}\n     want: ${w}`);
}
function ok(label: string, cond: boolean, detail = '') {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? `\n     ${detail}` : ''}`);
}
function near(label: string, got: number, want: number, tol = 0.005) {
  if (Math.abs(got - want) <= tol) { passed++; return; }
  failures.push(`${label}\n     got:  ${got}\n     want: ${want}`);
}

// ── fixture plumbing ────────────────────────────────────────────────────────
const g: any = globalThis;
const PORTFOLIO = 'SHEET-UNDER-TEST';

/** Google Sheets serial: whole days since 1899-12-30, which is what the register reads. */
const SHEET_EPOCH = Date.UTC(1899, 11, 30);
const serial = (y: number, m: number, d: number) => Math.round((Date.UTC(y, m - 1, d) - SHEET_EPOCH) / 86400000);

const TE_HEADER = [
  'Trade Date', 'Stock Name', 'ISIN', 'Transaction Type', 'Number of Shares', 'Avg Price',
  'Total Amount (Turnover)', 'Total Amount with Expense (Incl STT)', 'Trade Class', 'Notes',
  'Total Brokerage', 'STT', 'IGST', 'Exchange Turnover Charges', 'Stamp Duty',
  'SEBI Turnover Fees', 'IPF Charges', 'Demat Charges',
];

interface TeOpts { cls?: string; brok?: number; stt?: number; gst?: number }
/** One True Entry row. Charges default to a distinct, easily-traced set. */
const te = (
  d: [number, number, number], name: string, isin: string,
  type: 'Buy' | 'Sell', qty: number, price: number, o: TeOpts = {},
) => [
  serial(...d), name, isin, type, qty, price,
  qty * price, type === 'Buy' ? qty * price + (o.brok ?? 10) : qty * price - (o.brok ?? 10),
  o.cls ?? 'Delivery', '',
  o.brok ?? 10, o.stt ?? 5, o.gst ?? 2, 1, 0.5, 0.1, 0.05, 0,
];

const MASTER_TAB = 'Scrip Master';
const SCRIP_ROWS = [
  ['ISIN', 'Security Name', 'BSE', 'NSE', 'Alias name'],
  ['INE001A01011', 'ALPHA INDUSTRIES LIMITED', '500001', 'ALPHA', ''],
  ['INE002A01018', 'BETA MOTORS LIMITED', '500002', 'BETA', ''],
  ['INE003A01015', 'GAMMA TECH LIMITED', '500003', 'GAMMA', ''],
  ['INE004A01012', 'DELTA POWER LIMITED', '500004', 'DELTA', ''],
];

function install(trueEntry: any[][], opening: any[][] = [], corp: any[][] = [],
                 aif: any[][] = [], mf: any[][] = [], bond: any[][] = []) {
  g.__ranges = {
    [`${PORTFOLIO}::True Entry!A:Z`]: trueEntry,
    [`${PORTFOLIO}::Corporate Actions!A:Z`]: corp.length ? corp : undefined,
    [`${PORTFOLIO}::Opening Holdings!A1:H50000`]: opening.length ? opening : undefined,
    [`${SCRIP_MASTER_SPREADSHEET_ID}::'${MASTER_TAB}'!A1:Z50000`]: SCRIP_ROWS,
    // An EMPTY Private Equities tab still counts as a successful read. If this range is
    // missing the master sets peFailed and the register refuses to write at all — which is
    // itself correct behaviour and is asserted separately below.
    [`${SCRIP_MASTER_SPREADSHEET_ID}::Private Equities!A1:J5000`]: [['Name', 'ISIN']],
    // The AIF and Mutual Fund tabs are read on every master load too. Left ABSENT by default
    // (the stub throws "Unable to parse range", which the loader treats as a legitimate empty
    // answer) so every existing fixture behaves exactly as before; the asset-class fixture
    // below installs them explicitly.
    [`${SCRIP_MASTER_SPREADSHEET_ID}::AIF!A1:J5000`]: aif.length ? aif : undefined,
    [`${SCRIP_MASTER_SPREADSHEET_ID}::Mutual Fund!A1:J5000`]: mf.length ? mf : undefined,
    [`${SCRIP_MASTER_SPREADSHEET_ID}::Bonds!A1:J5000`]: bond.length ? bond : undefined,
  };
  g.__firstTab = { [PORTFOLIO]: 'True Entry', [SCRIP_MASTER_SPREADSHEET_ID]: MASTER_TAB };
  g.__sheetTabs = { [PORTFOLIO]: ['True Entry', 'Opening Holdings', 'Corporate Actions'] };
  g.__updated = [];
  g.__batched = [];
  g.__cleared = [];
  // The master is cached for 90s. Without this every fixture after the first would reuse
  // the previous one's master - and the PE-refusal case could never fire at all.
  invalidateScripCache();
  invalidatePrivateEquityCache();
  g.__failRange = {};
}

/** The values written to one tab, by tab name. */
const written = (tab: string): any[][] | undefined => {
  const hit = (g.__updated || []).filter((u: any) => (u.range || '').startsWith(`${tab}!`));
  return hit.length ? hit[hit.length - 1].resource.values : undefined;
};
/** TRANSACTION STATEMENT column indices - see TXN_HDR in trxRegister.ts. */
const TXC = { sno: 0, date: 1, name: 2, type: 3, qty: 4, rate: 5, amt: 6, brok: 7, net: 16 };
/** Rows of a transaction statement whose TYPE cell matches, e.g. 'BUY' or 'TOTAL SELL'. */
const txnRows = (tab: any[][] | undefined, type: string): any[][] =>
  (tab || []).filter(r => (r[TXC.type] || '').toString().trim() === type);

const tabsWritten = (): string[] =>
  [...new Set((g.__updated || []).map((u: any) => (u.range || '').split('!')[0]))] as string[];

const FY = 2025;                       // FY25-26: 1-Apr-2025 → 31-Mar-2026
const FY_LABEL = 'FY25-26';
const CG_TAB = `Capital Gains for ${FY_LABEL}`;
const INTRA_TAB = `Intra-Day for ${FY_LABEL}`;

// ── FIXTURE A — no intraday anywhere ────────────────────────────────────────
// ALPHA: opening 1,000 @ 100 (pre-FY), sells 400 in-FY  → long-term
// BETA : buys 500 @ 200 in-FY, sells 200 @ 250 in-FY    → short-term
// GAMMA: opening 300 @ 50, never traded in-FY           → must NOT appear
const FIXTURE_A: any[][] = [
  TE_HEADER,
  te([2025, 6, 10], 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', 'Sell', 400, 150),
  te([2025, 7, 1], 'BETA MOTORS LIMITED', 'INE002A01018', 'Buy', 500, 200),
  te([2025, 9, 15], 'BETA MOTORS LIMITED', 'INE002A01018', 'Sell', 200, 250),
];
const OPENING_A: any[][] = [
  ['Security', 'ISIN', 'Acquisition Date', 'Quantity', 'Cost Per Share', 'Total Cost', '', ''],
  ['ALPHA INDUSTRIES LIMITED', 'INE001A01011', serial(2023, 5, 4), 1000, 100, 100000, '', ''],
  ['GAMMA TECH LIMITED', 'INE003A01015', serial(2024, 2, 1), 300, 50, 15000, '', ''],
];

// ── FIXTURE B — every intraday shape that can leak ──────────────────────────
// ALPHA: full same-day round trip, 100 buy + 100 sell        → intraday only
// BETA : PARTIAL round trip, buy 1,500 / sell 3,000 on a day → 1,500 intraday
//        + 1,500 delivery sale drawn from the carried holding
// DELTA: carried holding 800, ONLY in-FY trade is a round trip
//        → its OPENING/CLOSING must survive on the delivery tab
const FIXTURE_B: any[][] = [
  TE_HEADER,
  te([2025, 5, 6], 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', 'Buy', 100, 90, { brok: 7, stt: 3, gst: 1 }),
  te([2025, 5, 6], 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', 'Sell', 100, 95, { brok: 8, stt: 4, gst: 1 }),
  te([2025, 8, 12], 'BETA MOTORS LIMITED', 'INE002A01018', 'Buy', 1500, 40, { brok: 30, stt: 12, gst: 6 }),
  te([2025, 8, 12], 'BETA MOTORS LIMITED', 'INE002A01018', 'Sell', 3000, 44, { brok: 60, stt: 24, gst: 12 }),
  te([2025, 11, 3], 'DELTA POWER LIMITED', 'INE004A01012', 'Buy', 200, 70, { brok: 9, stt: 2, gst: 1 }),
  te([2025, 11, 3], 'DELTA POWER LIMITED', 'INE004A01012', 'Sell', 200, 73, { brok: 9, stt: 2, gst: 1 }),
];
const OPENING_B: any[][] = [
  ['Security', 'ISIN', 'Acquisition Date', 'Quantity', 'Cost Per Share', 'Total Cost', '', ''],
  ['BETA MOTORS LIMITED', 'INE002A01018', serial(2024, 1, 15), 2000, 30, 60000, '', ''],
  ['DELTA POWER LIMITED', 'INE004A01012', serial(2023, 8, 20), 800, 60, 48000, '', ''],
];

// ── FIXTURE C — a demerger, both shapes of restatement ──────────────────────
// ALPHA: BOUGHT IN-YEAR 13.10, demerged 14.10 into BETA, sold 12.11.
//        Its cost sits in the PURCHASE columns, so the restated basis must too.
// GAMMA: carried in as opening stock, demerged into DELTA.
//        Its cost sits in OPENING STOCK, so the restated basis must stay there.
const FIXTURE_C: any[][] = [
  TE_HEADER,
  te([2025, 10, 13], 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', 'Buy', 24000, 660.75, { brok: 0, stt: 0, gst: 0 }),
  te([2025, 11, 12], 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', 'Sell', 24000, 403.752267, { brok: 0, stt: 0, gst: 0 }),
  te([2025, 11, 12], 'BETA MOTORS LIMITED', 'INE002A01018', 'Sell', 24000, 324.070625, { brok: 0, stt: 0, gst: 0 }),
];
const OPENING_C: any[][] = [
  ['Security', 'ISIN', 'Acquisition Date', 'Quantity', 'Cost Per Share', 'Total Cost', '', ''],
  ['GAMMA TECH LIMITED', 'INE003A01015', serial(2023, 4, 1), 300, 50, 15000, '', ''],
];
const CORP_C: any[][] = [
  ['Date', 'Type', 'From', 'To', 'Shares In', 'Cost', 'Notes'],
  ['14/10/2025', 'Demerger', 'ALPHA INDUSTRIES LIMITED', 'BETA MOTORS LIMITED', 24000, 4941600, ''],
  ['20/06/2025', 'Demerger', 'GAMMA TECH LIMITED', 'DELTA POWER LIMITED', 300, 5000, ''],
];

// Charge columns in the order the register writes them.
const CHARGE_KEYS = ['brok', 'stt', 'gst', 'et', 'stamp', 'sebi', 'ipf', 'dmat'] as const;
/** What the SOURCE rows say the total charges are — the anchor a conservation check needs.
 *  Deliberately computed from the fixture, NOT from anything the register produces. */
function sourceCharges(rows: any[][]) {
  const t: Record<string, number> = { brok: 0, stt: 0, gst: 0, et: 0, stamp: 0, sebi: 0, ipf: 0, dmat: 0 };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    t.brok += r[10]; t.stt += r[11]; t.gst += r[12]; t.et += r[13];
    t.stamp += r[14]; t.sebi += r[15]; t.ipf += r[16]; t.dmat += r[17];
  }
  return t;
}

export async function run() {
  // ── FIXTURE A ─────────────────────────────────────────────────────────────
  install(FIXTURE_A, OPENING_A);
  const resA = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
  const a = written(CG_TAB);
  ok('A: capital gains tab was written', !!a);

  if (a) {
    const width = Math.max(...a.map(r => r.length));
    eq('A: header row is the third row', a[2][0], 'S.No');
    eq('A: every row is the same width', new Set(a.map(r => r.length)).size, 1);

    const flat = a.map(r => r.join('|'));
    ok('A: ALPHA block present', flat.some(r => r.includes('ALPHA INDUSTRIES LIMITED')));
    ok('A: BETA block present', flat.some(r => r.includes('BETA MOTORS LIMITED')));
    ok('A: untraded GAMMA is omitted', !flat.some(r => r.includes('GAMMA TECH LIMITED')),
      'an opening-only holding must not appear on the register');

    const gt = a.find(r => r[1] === 'GRAND TOTAL');
    ok('A: GRAND TOTAL row exists', !!gt);
    // No intraday anywhere in fixture A, so the intra bucket must be empty however the
    // columns are laid out.
    const hdr = a[1];
    const intraCol = hdr.indexOf('Intra-Day');
    if (gt && intraCol >= 0) eq('A: no intra-day P/L', gt[intraCol] || '', '');

    // Charge conservation, anchored to the fixture rather than to the register.
    const src = sourceCharges(FIXTURE_A);
    const brokCol = hdr.length ? a[2].indexOf('Brok.Total') : -1;
    if (gt && brokCol >= 0) near('A: GRAND TOTAL brokerage ties to the source rows', Number(gt[brokCol]) || 0, src.brok);

    g.__goldenA = { values: a, width, tabs: tabsWritten() };
  }

  eq('A: result names the capital gains tab', resA.tabName, CG_TAB);
  eq('A: result names the holding tab', resA.holdingTabName, 'Holding as on 31st March 2026');

  // ── FIXTURE B ─────────────────────────────────────────────────────────────
  install(FIXTURE_B, OPENING_B);
  await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
  const b = written(CG_TAB);
  ok('B: capital gains tab was written', !!b);

  if (b) {
    const hdr = b[1], colHdr = b[2];
    const flat = b.map(r => r.join('|'));
    // DELTA's only in-FY trade is a round trip, but it carries a holding all year. Its
    // position MUST stay visible somewhere in the register - losing it silently deletes
    // a real position from a filed tax document.
    ok('B: DELTA (intraday-only, but carries a holding) still appears', flat.some(r => r.includes('DELTA POWER LIMITED')));

    const gt = b.find(r => r[1] === 'GRAND TOTAL');
    const brokCol = colHdr.indexOf('Brok.Total');
    const src = sourceCharges(FIXTURE_B);
    if (gt && brokCol >= 0) {
      // Pre-split this is the whole book; post-split it is the delivery half, so the
      // suite records it rather than pinning it, and the two-tab total is checked below.
      g.__bGrandBrok = Number(gt[brokCol]) || 0;
    }
    g.__bSourceCharges = src;
    g.__goldenB = { values: b, tabs: tabsWritten() };

    const intraCol = hdr.indexOf('Intra-Day');
    if (gt && intraCol >= 0) {
      // ALPHA 100 x (95-90) = 500; BETA 1500 x (44-40) = 6000; DELTA 200 x (73-70) = 600
      near('B: intra-day P/L totals the three round trips', Number(gt[intraCol]) || 0, 7100, 0.02);
    }
  }

  // ── the PE refusal must survive the refactor ──────────────────────────────
  install(FIXTURE_A, OPENING_A);
  // A 500, not a missing tab. An absent Private Equities tab is a legitimate cacheable
  // answer (peFailed stays false); only a genuine read failure must block the write.
  g.__failRange = { [`${SCRIP_MASTER_SPREADSHEET_ID}::Private Equities!A1:J5000`]: true };
  let refused = '';
  try { await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio'); }
  catch (e: any) { refused = e?.message || ''; }
  ok('unreadable Private Equities tab still refuses to write',
    /Private Equities/.test(refused) && /not written/i.test(refused), `got: ${refused || '(no throw)'}`);

  // ── the split itself ──────────────────────────────────────────────────────
  // Fixture A has no intraday at all, so the delivery tab must be BYTE-IDENTICAL to the
  // pre-split register with one column removed and the two intra-day footer rows dropped.
  // Anything else means the refactor moved a figure.
  install(FIXTURE_A, OPENING_A);
  await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
  const dA = written(CG_TAB), iA = written(INTRA_TAB);

  ok('A: both tabs are written even with zero intraday', !!dA && !!iA);
  if (dA) {
    eq('A: delivery drops the Intra-Day caption', dA[1].indexOf('Intra-Day'), -1);
    eq('A: delivery keeps Short term', dA[1].indexOf('Short term') >= 0, true);
    eq('A: delivery keeps Long term', dA[1].indexOf('Long term') >= 0, true);
    eq('A: delivery is 25 columns wide', dA[2].length, 25);
    eq('A: delivery has two P/L headers', dA[2].filter((c: any) => c === 'P/L').length, 2);
    eq('A: IPF is still the last column', dA[2][dA[2].length - 1], 'IPF');
    const foot = dA.filter(r => r.some((c: any) => /Expenses$/.test(String(c))));
    eq('A: delivery footer names only delivery expenses', foot.map(r => r.find((c: any) => /Expenses$/.test(String(c)))), ['Delivery Expenses']);
  }
  if (iA) {
    eq('A: intraday keeps only the Intra-Day caption', iA[1].filter((c: any) => /term|Intra-Day/.test(String(c))), ['Intra-Day']);
    eq('A: intraday is 24 columns wide', iA[2].length, 24);
    eq('A: intraday has one P/L header', iA[2].filter((c: any) => c === 'P/L').length, 1);
    ok('A: empty intraday says so rather than looking like a lost tab',
      iA.some(r => r.some((c: any) => /No intra-day/.test(String(c)))));
  }

  // The baseline is captured from the PRE-SPLIT code with TRX_DUMP; without it this check
  // is skipped rather than silently passing.
  if (process.env.TRX_BASELINE && dA) {
    const fs = await import('node:fs');
    const base = JSON.parse(fs.readFileSync(process.env.TRX_BASELINE, 'utf8')).A;
    if (!base) { failures.push('baseline file has no fixture-A capture'); }
    else {
      const INTRA_COL = 14;                       // where Intra-Day P/L sat in the old 26-wide layout
      const expect = base.values
        .map((r: any[]) => r.filter((_: any, i: number) => i !== INTRA_COL))
        .filter((_: any[], i: number, arr: any[][]) => i < arr.length - 2);   // drop the two intra-day footer rows
      eq('A: delivery tab equals the pre-split register minus the Intra-Day column', dA, expect);
    }
  } else if (dA) {
    console.log('  (baseline comparison skipped — set TRX_BASELINE to the pre-split dump)');
  }

  // ── fixture B: nothing may be double-counted or lost ──────────────────────
  install(FIXTURE_B, OPENING_B);
  await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
  const dB = written(CG_TAB), iB = written(INTRA_TAB);
  g.__tabs = { delivery: dB, intraday: iB };
  ok('B: both tabs written', !!dB && !!iB);

  if (dB && iB) {
    const dFlat = dB.map(r => r.join('|')), iFlat = iB.map(r => r.join('|'));
    // DELTA's only trade was a round trip, but it carries a position all year: its trades
    // belong on the intraday tab and its POSITION still belongs on the delivery tab.
    ok('B: DELTA position survives on the delivery tab', dFlat.some(r => r.includes('DELTA POWER')));
    ok('B: DELTA round trip is on the intraday tab', iFlat.some(r => r.includes('DELTA POWER')));
    ok('B: no CLOSING rows on the intraday tab', !iFlat.some(r => r.includes('CLOSING')),
      'a same-day round trip holds nothing overnight');

    const dGt = dB.find(r => r[1] === 'GRAND TOTAL')!, iGt = iB.find(r => r[1] === 'GRAND TOTAL')!;
    const dBrok = dB[2].indexOf('Brok.Total'), iBrok = iB[2].indexOf('Brok.Total');
    const src = sourceCharges(FIXTURE_B);
    // THE conservation check: every rupee of brokerage on the source rows lands on exactly
    // one tab. (generateTrxRegister also asserts this internally and refuses to write.)
    near('B: delivery + intraday brokerage == the source rows',
      (Number(dGt[dBrok]) || 0) + (Number(iGt[iBrok]) || 0), src.brok, 0.02);

    // Each tab's GRAND TOTAL charge row must equal its own expense footer — the footer no
    // longer derives one side by subtracting the other.
    const footRow = (t: any[][], label: string) => t.find(r => r.some((c: any) => c === label));
    const dFoot = footRow(dB, 'Delivery Expenses'), iFoot = footRow(iB, 'Intra-day Expenses');
    ok('B: delivery footer present', !!dFoot);
    ok('B: intraday footer present', !!iFoot);
    if (dFoot) near('B: delivery GRAND TOTAL brokerage == its footer', Number(dGt[dBrok]) || 0, Number(dFoot[dBrok]) || 0, 0.02);
    if (iFoot) near('B: intraday GRAND TOTAL brokerage == its footer', Number(iGt[iBrok]) || 0, Number(iFoot[iBrok]) || 0, 0.02);

    // P/L must not leak across the tabs.
    const iIntra = iB[1].indexOf('Intra-Day');
    if (iIntra >= 0) near('B: intraday P/L totals the three round trips', Number(iGt[iIntra]) || 0, 7100, 0.02);
    eq('B: delivery tab has no Intra-Day column at all', dB[1].indexOf('Intra-Day'), -1);
  }

  // ── the paint must follow the layout, not a literal ───────────────────────
  // A one-column drift here misfiles every charge and neither tsc nor vite can see it.
  {
    const fills = (g.__batched || []).flatMap((b: any) => (b.resource?.requests || []))
      .filter((r: any) => r.repeatCell?.cell?.userEnteredFormat?.backgroundColor)
      .map((r: any) => r.repeatCell.range);
    ok('paint requests were issued (the formatting path actually ran)', fills.length > 0);
    const widths = new Set(fills.map((r: any) => r.endColumnIndex).filter((x: any) => x !== undefined));
    ok('no paint band runs past the narrower intraday width + 1', Math.max(...(widths as Set<number>)) <= 25,
      `max endColumnIndex seen: ${Math.max(...(widths as Set<number>))}`);
  }

  // ── fixture C: a demerger restates where the cost already is ──────────────
  install(FIXTURE_C, OPENING_C, CORP_C);
  await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
  const dC = written(CG_TAB);
  ok('C: delivery tab written', !!dC);

  if (dC) {
    const H = dC[2];
    const pAmt = H.indexOf('AMOUNT', H.indexOf('AMOUNT') + 1);   // 2nd AMOUNT = PURCHASE
    const oAmt = H.indexOf('AMOUNT');                            // 1st AMOUNT = OPENING STOCK
    const pQty = pAmt - 2, oQty = oAmt - 2;   // DATE, QTY, RATE, AMOUNT
    const rowsWith = (re: RegExp) => dC.findIndex(r => re.test(String(r[1] ?? '')));

    // The label must be readable, which means it has a row to itself: putting it beside the
    // figures clipped it at the SCRIPT NAME column and hid the cost-out amount.
    const gi = rowsWith(/DEMERGER → BETA MOTORS/);
    ok('C: demerger-out label present', gi >= 0);
    if (gi >= 0) {
      eq('C: the label row carries no figures of its own', dC[gi].filter((c: any) => c !== '').length, 1);

      // THE POINT: ALPHA was bought this year, so the adjustment belongs in PURCHASE - and it
      // is a CONTRA line, not a restated position. A restated 24,000 sitting under the 24,000
      // already purchased made the column read as two positions and twice the cost.
      const fig = dC[gi + 1];
      eq('C: the demerger carries NO quantity (cost moved, shares did not)', fig[pQty], '');
      eq('C: the cost that left is a negative adjustment', fig[pAmt], -4941600);
      eq('C: and nothing lands in the OPENING STOCK columns', [fig[oQty], fig[oAmt]], ['', '']);

      // The regression that prompted this: the PURCHASE amount column must sum to the basis
      // the sale is measured against, not to double it.
      const alphaStart = dC.findIndex(r => /ALPHA INDUSTRIES/.test(String(r[1] ?? '')));
      // End the block at the next SCRIP header, identified by its S.No - not by a name
      // pattern: ALPHA's own block contains the label "DEMERGER → BETA MOTORS LIMITED",
      // which a name match cuts the slice on, hiding the contra line this asserts.
      const alphaEnd = dC.findIndex((r, k) => k > alphaStart && (typeof r[0] === 'number' || r[1] === 'GRAND TOTAL'));
      const pSum = dC.slice(alphaStart, alphaEnd < 0 ? undefined : alphaEnd)
        .reduce((t, r) => t + (typeof r[pAmt] === 'number' ? r[pAmt] : 0), 0);
      near('C: PURCHASE column sums to the post-demerger basis, not twice the position', pSum, 10916400, 0.02);
    }

    // GAMMA was carried in, so its restated basis stays in OPENING STOCK.
    const gj = rowsWith(/DEMERGER → DELTA POWER/);
    ok('C: opening-stock demerger label present', gj >= 0);
    if (gj >= 0) {
      const fig = dC[gj + 1];
      eq('C: carried-in position adjusts in OPENING STOCK, with no quantity', fig[oQty], '');
      eq('C: carried-in cost out is a negative adjustment', fig[oAmt], -5000);
      eq('C: and NOT in the PURCHASE columns', [fig[pQty], fig[pAmt]], ['', '']);
    }

    // The receiving side is an acquisition, so it is always a purchase.
    const bi = rowsWith(/DEMERGER from ALPHA INDUSTRIES/);
    ok('C: demerger-in label present', bi >= 0);
    if (bi >= 0) eq('C: the shares received print as a purchase', [dC[bi + 1][pQty], dC[bi + 1][pAmt]], [24000, 4941600]);

    // And the whole thing must still reconcile on the page.
    const st = H.indexOf('P/L');
    const pl = dC.filter(r => typeof r[st] === 'number').map(r => r[st]);
    // r6 on cost-per-share: the basis is now exact, so these tie to the paisa.
    ok('C: ALPHA short-term loss is the post-demerger basis less the sale',
      pl.some((v: number) => Math.abs(v - (9690054.41 - 10916400)) < 0.02), `P/L seen: ${JSON.stringify(pl)}`);
    ok('C: BETA short-term gain is the sale less the cost carried in',
      pl.some((v: number) => Math.abs(v - (7777695 - 4941600)) < 0.02), `P/L seen: ${JSON.stringify(pl)}`);
  }

  // ── FIXTURE D — asset classes: AIF is PE-like; a MUTUAL FUND and a BOND have no rule ──
  //
  // The point of this fixture is a NEGATIVE: an MF or bond sale must appear in NEITHER P/L
  // column. `ltDaysFor` returns null for both, and with no strictNullChecks `days >= null`
  // compiles and coerces to `>= 0`, which would file every one of them as LONG TERM under a
  // green build. Only an explicit test can see that.
  //
  // TWO no-rule scrips, not one, and that is the load-bearing part. Both carry charges (`te`
  // stamps brok 10 / stt 5 / gst 2 / et 1 / dmat 0.5 / stamp 0.1 / sebi 0.05 on every row) but
  // neither sale is emitted, so the charge-conservation guard has to exclude BOTH from what it
  // expects on the tabs. Miss one and the guard fires and no register is written at all - the
  // check doing its job over a scrip it was never told to skip.
  {
    const AIF_ROWS = [['Company', 'ISIN'], ['HELION VENTURES FUND II', 'INE500A01019']];
    const MF_ROWS = [['Company', 'ISIN'], ['PARAG PARIKH FLEXI CAP FUND', 'INF879O01027']];
    const BOND_ROWS = [['Company', 'ISIN'], ['TATA CAPITAL 8.5% NCD 2029', 'INE976I08014']];
    const FIXTURE_D: any[][] = [
      TE_HEADER,
      // AIF: bought pre-FY, sold 20 months later -> SHORT term at 730 days, like PE.
      te([2024, 6, 1], 'HELION VENTURES FUND II', 'INE500A01019', 'Buy', 100, 1000),
      te([2025, 12, 1], 'HELION VENTURES FUND II', 'INE500A01019', 'Sell', 100, 1500),
      // Mutual fund: held 20 months. Long at 12, short at 24, slab if debt - no answer.
      te([2024, 6, 1], 'PARAG PARIKH FLEXI CAP FUND', 'INF879O01027', 'Buy', 200, 50),
      te([2025, 12, 1], 'PARAG PARIKH FLEXI CAP FUND', 'INF879O01027', 'Sell', 200, 80),
      // Bond: same holding period, and no answer for the same kind of reason - a LISTED bond is
      // long at 12 months, but an unlisted one transferred post-23-Jul-2024 is always short at
      // slab under s.50AA. Gain is 50 x (1100-1000) = 5,000, deliberately distinct from the
      // AIF's 49,990 and the fund's 6,000 so a leak into a P/L column names its own source.
      te([2024, 6, 1], 'TATA CAPITAL 8.5% NCD 2029', 'INE976I08014', 'Buy', 50, 1000),
      te([2025, 12, 1], 'TATA CAPITAL 8.5% NCD 2029', 'INE976I08014', 'Sell', 50, 1100),
    ];

    install(FIXTURE_D, [], [], AIF_ROWS, MF_ROWS, BOND_ROWS);
    const res = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    const d = written(CG_TAB);
    ok('D: delivery tab written', !!d);

    // The register writing AT ALL is the charge-conservation assertion: two unemitted sales
    // carrying charges would otherwise throw before any tab was produced.
    ok('D: the register still wrote with TWO no-rule scrips carrying charges', !!d,
      'the charge-conservation guard fired - a no-rule scrip\'s charges were still expected');

    eq('D: exactly two sales refused classification', res.unclassified.length, 2);
    const refused = res.unclassified.map(u => u.name).sort();
    eq('D: they are the MUTUAL FUND and the BOND, not the AIF', refused,
      ['PARAG PARIKH FLEXI CAP FUND', 'TATA CAPITAL 8.5% NCD 2029']);
    eq('D: the whole MF quantity is reported, not a remnant',
      res.unclassified.find(u => /PARAG/.test(u.name))?.qty, 200);
    eq('D: the whole BOND quantity is reported, not a remnant',
      res.unclassified.find(u => /TATA CAPITAL/.test(u.name))?.qty, 50);

    // ── the class split: each sale on exactly ONE tab ──
    const aifTab = written(`AIF Capital Gains for ${FY_LABEL}`);
    ok('D: an AIF Capital Gains tab is written', !!aifTab, `tabs: ${tabsWritten().join(', ')}`);
    ok('D: no PE tab is written - there are no PE trades in this fixture',
      !written(`Private Equity Capital Gains for ${FY_LABEL}`));
    ok('D: no MF tab is written - a mutual fund has no gains to compute',
      !written(`Mutual Fund Capital Gains for ${FY_LABEL}`));

    if (aifTab) {
      const aFlat = aifTab.map(r => r.join('|')).join('\n');
      ok('D: the AIF is on its OWN capital-gains tab', /HELION VENTURES/.test(aFlat));
      const AH = aifTab[2];
      const ast = AH.indexOf('P/L'), alt = AH.indexOf('P/L', AH.indexOf('P/L') + 1);
      const apls = aifTab.flatMap(r => [r[ast], r[alt]]).filter(v => typeof v === 'number') as number[];
      // 100 x (1500-1000) = 50,000 less charges, and 20 months < 730 days, so SHORT term -
      // the concessional 12-month listed period does not apply to an AIF unit.
      ok('D: the AIF sale is short-term at 20 months (730-day rule, as PE)',
        apls.some(v => Math.abs(v - 49990) < 30), `P/L seen: ${JSON.stringify(apls)}`);
    }

    if (d) {
      const flat = d.map(r => r.join('|')).join('\n');
      // The main tab is now LISTED ONLY. Leaving the AIF here as well as on its own tab would
      // put the same gain on two tabs - a double count nothing downstream could detect.
      ok('D: the AIF is NOT on the main (listed) capital-gains tab', !/HELION VENTURES/.test(flat),
        'a non-listed gain is on two tabs at once');
      // THE assertion. A ₹6,000 gain (200 x (80-50)) must not be sitting in a P/L column.
      ok('D: the mutual fund is NOT on the register at all', !/PARAG PARIKH/.test(flat),
        'an MF sale reached a tax tab');
      ok('D: the bond is NOT on the register at all', !/TATA CAPITAL/.test(flat),
        'a bond sale reached a tax tab');

      const H = d[2];
      const st = H.indexOf('P/L'), lt = H.indexOf('P/L', H.indexOf('P/L') + 1);
      const pls = d.flatMap(r => [r[st], r[lt]]).filter(v => typeof v === 'number') as number[];
      ok('D: and its 49,990 gain is not on the listed tab either',
        !pls.some(v => Math.abs(v - 49990) < 30), `P/L seen: ${JSON.stringify(pls)}`);
      ok('D: no 6,000 mutual-fund gain leaked into either P/L column',
        !pls.some(v => Math.abs(v - 6000) < 30), `P/L seen: ${JSON.stringify(pls)}`);
      ok('D: no 5,000 bond gain leaked into either P/L column',
        !pls.some(v => Math.abs(v - 5000) < 30), `P/L seen: ${JSON.stringify(pls)}`);
    }

    // ── the sales that no capital-gains tab will ever show ──
    // This is most of the point of the statement: an MF or bond sale is refused by both engines
    // and reported only in `unclassified`, which nothing in the UI surfaces. Before this tab
    // existed, a real sale left no trace in the spreadsheet at all.
    const mfD = written(`Mutual Fund Transactions for ${FY_LABEL}`);
    const bdD = written(`Bond Transactions for ${FY_LABEL}`);
    const aifD = written(`AIF Transactions for ${FY_LABEL}`);
    ok('D: the refused mutual-fund SALE is visible on its transaction statement',
      !!mfD && txnRows(mfD, 'SELL').length === 1,
      `rows: ${JSON.stringify((mfD || []).map(r => r[TXC.type]))}`);
    ok('D: the refused bond SALE is visible on its transaction statement',
      !!bdD && txnRows(bdD, 'SELL').length === 1);
    ok('D: the AIF gets a statement as well as a gains tab',
      !!aifD && txnRows(aifD, 'SELL').length === 1);
    ok('D: no Private Equity statement - this fixture holds none',
      !written(`Private Equity Transactions for ${FY_LABEL}`));
    // The pre-FY BUYs are outside the selected year, so the statement must show the sale only.
    ok('D: the statement is FY-scoped - the pre-FY purchase is not on it',
      !!mfD && txnRows(mfD, 'BUY').length === 0,
      'a purchase from outside the selected FY reached an FY statement');
  }

  // ── FIXTURE E — a no-rule scrip bought AND SOLD in the SAME financial year ──
  //
  // Fixture D above buys its fund PRE-FY, so `inFY` is false at the buy and no PURCHASE row is
  // ever emitted for it - the charge books balance by accident. Buy it INSIDE the year and the
  // two sides disagree: `chargeCells` puts the purchase row's charges into `delivery.grand`,
  // while `noRule` (built from `unclassifiedSales`) excludes that scrip from `expect`. Drift in
  // one direction, and the charge-conservation guard THROWS rather than writing - so buying and
  // selling a mutual fund or a bond in the same FY produced no register at all.
  //
  // The fix is to key the exclusion on the ASSET CLASS (does it have an LT rule?) rather than
  // on whether the scrip happened to sell this year, and to keep no-rule scrips off the
  // capital-gains tabs entirely rather than half-on via their purchases.
  {
    const MF_ROWS_E = [['Company', 'ISIN'], ['QUANT SMALL CAP FUND', 'INF966L01374']];
    const BOND_ROWS_E = [['Company', 'ISIN'], ['HDFC 7.95% NCD 2030', 'INE001A08040']];
    const FIXTURE_E: any[][] = [
      TE_HEADER,
      // A listed scrip so the guard has a real, non-zero expectation to reconcile against.
      te([2025, 5, 1], 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', 'Buy', 100, 90),
      te([2025, 10, 1], 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', 'Sell', 100, 95),
      // Both bought AND sold inside FY25-26 - this is the case fixture D cannot reach.
      te([2025, 6, 1], 'QUANT SMALL CAP FUND', 'INF966L01374', 'Buy', 100, 100),
      te([2025, 12, 1], 'QUANT SMALL CAP FUND', 'INF966L01374', 'Sell', 100, 120),
      te([2025, 6, 1], 'HDFC 7.95% NCD 2030', 'INE001A08040', 'Buy', 50, 1000),
      te([2025, 12, 1], 'HDFC 7.95% NCD 2030', 'INE001A08040', 'Sell', 50, 1100),
    ];

    install(FIXTURE_E, [], [], [], MF_ROWS_E, BOND_ROWS_E);
    let threw = '';
    let resE: any = null;
    try { resE = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio'); }
    catch (e: any) { threw = e?.message || String(e); }

    // THE assertion. A green build and a passing fixture D both hide this.
    ok('E: an in-FY buy+sell of a no-rule scrip does not block the whole register',
      !threw, `threw: ${threw}`);

    const e = written(CG_TAB);
    ok('E: delivery tab written', !!e);
    if (e) {
      const flatE = e.map(r => r.join('|')).join('\n');
      ok('E: the listed scrip is on the register', /ALPHA INDUSTRIES/.test(flatE));
      // The PURCHASE row is the leak: a no-rule scrip must be wholly absent, not half-present
      // through a buy whose charges nothing accounts for.
      ok('E: the mutual fund is wholly absent, purchases included', !/QUANT SMALL CAP/.test(flatE),
        'a no-rule scrip leaked a PURCHASE row onto a capital-gains tab');
      ok('E: the bond is wholly absent, purchases included', !/HDFC 7.95/.test(flatE),
        'a no-rule scrip leaked a PURCHASE row onto a capital-gains tab');
    }
    if (resE) {
      eq('E: both no-rule sales are reported as unclassified', resE.unclassified.length, 2);
    }

    // ── the transaction statements carry what the gains tabs refuse ──
    const mfTxn = written(`Mutual Fund Transactions for ${FY_LABEL}`);
    const bdTxn = written(`Bond Transactions for ${FY_LABEL}`);
    ok('E: a Mutual Fund transaction statement is written', !!mfTxn, `tabs: ${tabsWritten().join(', ')}`);
    ok('E: a Bond transaction statement is written', !!bdTxn);
    ok('E: no statement for a class with no trades', !written(`AIF Transactions for ${FY_LABEL}`));

    if (mfTxn) {
      const buys = txnRows(mfTxn, 'BUY'), sells = txnRows(mfTxn, 'SELL');
      eq('E: the fund has exactly one BUY row', buys.length, 1);
      eq('E: and exactly one SELL row - the row no other tab shows', sells.length, 1);
      eq('E: the BUY row carries qty / amount / net', [buys[0]?.[TXC.qty], buys[0]?.[TXC.amt], buys[0]?.[TXC.net]],
        [100, 10000, 10010]);
      // 100 x 120 = 12,000 turnover, net of the 10 brokerage = 11,990.
      eq('E: the SELL row carries qty / amount / net', [sells[0]?.[TXC.qty], sells[0]?.[TXC.amt], sells[0]?.[TXC.net]],
        [100, 12000, 11990]);
      // Per-SIDE subtotals: adding a buy amount to a sale amount would mean nothing.
      eq('E: one TOTAL BUY subtotal', txnRows(mfTxn, 'TOTAL BUY').length, 1);
      eq('E: one TOTAL SELL subtotal', txnRows(mfTxn, 'TOTAL SELL').length, 1);
      // The statement's charges must equal what True Entry charged this scrip - `te` stamps
      // brok 10 per row, so 10 on each side. This is the check that the statement is a record
      // of the ledger and not a re-derivation of it.
      const gb = (mfTxn).find(r => (r[TXC.name] || '').toString() === 'GRAND TOTAL BUY');
      const gs = (mfTxn).find(r => (r[TXC.name] || '').toString() === 'GRAND TOTAL SELL');
      eq('E: GRAND TOTAL BUY ties to True Entry (amount, brokerage)', [gb?.[TXC.amt], gb?.[TXC.brok]], [10000, 10]);
      eq('E: GRAND TOTAL SELL ties to True Entry (amount, brokerage)', [gs?.[TXC.amt], gs?.[TXC.brok]], [12000, 10]);
    }
    if (bdTxn) {
      const flatB = bdTxn.map(r => r.join('|')).join('\n');
      ok('E: the bond statement names the bond', /HDFC 7.95/.test(flatB));
      eq('E: and shows its sale', txnRows(bdTxn, 'SELL').length, 1);
    }
  }

  // ── FIXTURE F — a book holding ONLY private equity ──
  //
  // PE is the class this whole split was asked for and it had no register coverage at all
  // (fixture D is AIF / MF / Bond; everything else is listed equity). It also produces a state
  // that was unreachable before the split: NO listed transactions, so the historic
  // "Capital Gains for FY.." tab is empty and has to say where the figures went.
  {
    const FIXTURE_F: any[][] = [
      TE_HEADER,
      te([2025, 5, 1], 'STRIDE VENTURES PRIVATE LIMITED', '', 'Buy', 1000, 100),
      te([2025, 11, 1], 'STRIDE VENTURES PRIVATE LIMITED', '', 'Sell', 400, 150),
    ];
    install(FIXTURE_F);
    // The PE tab is stubbed empty by `install`; this fixture needs the company ON it, which is
    // what makes the name resolve to class PE rather than to an unknown listed scrip.
    g.__ranges[`${SCRIP_MASTER_SPREADSHEET_ID}::Private Equities!A1:J5000`] =
      [['Company', 'ISIN'], ['STRIDE VENTURES PRIVATE LIMITED', '']];
    invalidateScripCache(); invalidatePrivateEquityCache();

    let threwF = '';
    let resF: any = null;
    try { resF = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio'); }
    catch (e: any) { threwF = e?.message || String(e); }
    ok('F: a PE-only book still produces a register', !threwF, `threw: ${threwF}`);

    const peCg = written(`Private Equity Capital Gains for ${FY_LABEL}`);
    ok('F: a Private Equity Capital Gains tab is written', !!peCg, `tabs: ${tabsWritten().join(', ')}`);
    if (peCg) {
      const pFlat = peCg.map(r => r.join('|')).join('\n');
      ok('F: the PE company is on its own gains tab', /STRIDE VENTURES/.test(pFlat));
      const PH = peCg[2];
      const pst = PH.indexOf('P/L'), plt = PH.indexOf('P/L', PH.indexOf('P/L') + 1);
      const ppls = peCg.flatMap(r => [r[pst], r[plt]]).filter(v => typeof v === 'number') as number[];
      // 400 x (150 - 100) = 20,000. Held 1-May-2025 to 1-Nov-2025 = ~184 days, well under the
      // 730-day unlisted threshold, so SHORT term - the P/L must sit in the FIRST P/L column.
      const stCol = peCg.find(r => typeof r[pst] === 'number' && Math.abs(Number(r[pst]) - 20000) < 40);
      ok('F: the PE gain is SHORT term at ~6 months (730-day rule)', !!stCol,
        `P/L seen: ${JSON.stringify(ppls)}`);
      ok('F: and nothing landed in the LONG term column',
        !peCg.some(r => typeof r[plt] === 'number' && Math.abs(Number(r[plt]) - 20000) < 40));
    }

    // The historic tab must still be written, and must explain itself rather than looking broken.
    const listedF = written(CG_TAB);
    ok('F: the listed tab is still written when there are no listed trades', !!listedF);
    if (listedF) {
      const lFlat = listedF.map(r => r.join('|')).join('\n');
      ok('F: it says there were no LISTED transactions', /No LISTED transactions/.test(lFlat),
        'an empty listed tab reads as a failed run');
      ok('F: and names the tab the figures went to',
        /Private Equity Capital Gains for FY25-26/.test(lFlat),
        'an empty tab beside a populated one reads as though the split dropped the figures');
      ok('F: the PE company is NOT on the listed tab', !/STRIDE VENTURES/.test(lFlat));
    }

    const peTxn = written(`Private Equity Transactions for ${FY_LABEL}`);
    ok('F: a Private Equity transaction statement is written', !!peTxn);
    if (peTxn) {
      eq('F: it shows the buy', txnRows(peTxn, 'BUY').length, 1);
      eq('F: and the part sale', txnRows(peTxn, 'SELL').length, 1);
      const gb = peTxn.find(r => (r[TXC.name] || '').toString() === 'GRAND TOTAL BUY');
      const gs = peTxn.find(r => (r[TXC.name] || '').toString() === 'GRAND TOTAL SELL');
      eq('F: GRAND TOTAL BUY is the full 1,000 shares at 100', [gb?.[TXC.qty], gb?.[TXC.amt]], [1000, 100000]);
      eq('F: GRAND TOTAL SELL is the 400 sold at 150', [gs?.[TXC.qty], gs?.[TXC.amt]], [400, 60000]);
    }
    if (resF) {
      eq('F: PE is classifiable, so nothing is unclassified', resF.unclassified.length, 0);
      eq('F: the result reports the PE tabs it wrote',
        (resF.classTabs || []).map((c: any) => [c.id, c.cgTab, c.txnTab]),
        [['PE', `Private Equity Capital Gains for ${FY_LABEL}`, `Private Equity Transactions for ${FY_LABEL}`]]);
    }
  }

  // ── golden capture / comparison ───────────────────────────────────────────
  // TRX_DUMP=<path> writes what the register produced. Captured ONCE before the
  // delivery/intraday split, then compared after, because tsc and vite cannot see a
  // register whose columns have shifted by one.
  if (process.env.TRX_DUMP) {
    const fs = await import('node:fs');
    fs.writeFileSync(process.env.TRX_DUMP, JSON.stringify({ A: g.__goldenA, B: g.__goldenB, tabs: g.__tabs }, null, 1));
    console.log('golden written to ' + process.env.TRX_DUMP);
  }

  // ── FIXTURE G — "STT Removed" hides STT on the gains tab, and changes NOTHING else ────────
  // The whole claim in one test. STT never entered a gain: the P/L is
  // `sale turnover - purchase turnover`, and turnover is charge-free. So flipping the flag must
  // move exactly ONE column and leave every other cell — every rate, amount, subtotal and P/L —
  // byte-identical. Running the same fixture twice and diffing the two written tabs proves that
  // far better than reading a P/L cell would, because it also proves nothing ELSE moved.
  {
  const MASTER_RANGE = `${SCRIP_MASTER_SPREADSHEET_ID}::'${MASTER_TAB}'!A1:Z50000`;
  // GAMMA is the ETF stand-in: marked. ALPHA is the control, in the same register.
  const FLAGGED_MASTER = [
    ['ISIN', 'Security Name', 'BSE', 'NSE', 'Alias name', 'STT Removed'],
    ['INE001A01011', 'ALPHA INDUSTRIES LIMITED', '500001', 'ALPHA', '', ''],
    ['INE002A01018', 'BETA MOTORS LIMITED', '500002', 'BETA', '', ''],
    ['INE003A01015', 'GAMMA TECH LIMITED', '500003', 'GAMMA', '', 'x'],
    ['INE004A01012', 'DELTA POWER LIMITED', '500004', 'DELTA', '', ''],
  ];
  const FIXTURE_G: any[][] = [
    TE_HEADER,
    te([2025, 5, 2], 'GAMMA TECH LIMITED', 'INE003A01015', 'Buy', 100, 100, { stt: 11 }),
    te([2025, 8, 4], 'GAMMA TECH LIMITED', 'INE003A01015', 'Sell', 100, 150, { stt: 13 }),
    te([2025, 5, 2], 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', 'Buy', 50, 200, { stt: 7 }),
    te([2025, 8, 4], 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', 'Sell', 50, 260, { stt: 9 }),
  ];
  /** Index of a header cell anywhere in a written tab. */
  const colOf = (tab: any[][] | undefined, header: string): number => {
    for (const r of tab || []) { const i2 = r.indexOf(header); if (i2 >= 0) return i2; }
    return -1;
  };
  const colTotal = (tab: any[][] | undefined, c: number): number =>
    (tab || []).reduce((sum, r) => sum + (typeof r[c] === 'number' ? r[c] : 0), 0);

  install(FIXTURE_G);
  await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
  const plain = written(CG_TAB);

  install(FIXTURE_G);
  g.__ranges[MASTER_RANGE] = FLAGGED_MASTER;
  // If the emission dropped STT but the conservation guard still EXPECTED it, this throws and
  // no register is written at all — the failure CLAUDE.md records twice. So reaching the next
  // line is itself the assertion that both sides were keyed off the same flag.
  await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
  const flagged = written(CG_TAB);

  ok('the register still writes with a scrip flagged', !!flagged);

  const sttCol = colOf(plain, 'STT');
  ok('the gains tab has an STT column to begin with', sttCol >= 0);

  const brokCol = colOf(plain, 'Brok.Total');
  const stampCol = colOf(plain, 'Stamp duty');
  const REMOVED = 11 + 13;                     // GAMMA's buy + sell STT, and nothing else

  interface Change { r: number; c: number; from: any; to: any }
  const changes: Change[] = [];
  (plain || []).forEach((row, r) => row.forEach((v: any, c: number) => {
    const w = flagged?.[r]?.[c];
    if (JSON.stringify(v) !== JSON.stringify(w)) changes.push({ r, c, from: v, to: w });
  }));
  if (process.env.STT_DEBUG) for (const d of changes) console.log(`  DIFF r${d.r} c${d.c}: ${JSON.stringify(d.from)} -> ${JSON.stringify(d.to)}`);

  // TWO columns may move, and only two: STT itself, and the expenses TOTAL that sums the
  // charge block (it lands in the brokerage column). Everything else - every rate, amount,
  // quantity, subtotal and P/L cell - must be byte-identical, which is the real claim: the
  // gain is `sale turnover - purchase turnover`, so no charge has ever been part of it.
  eq('only the STT column and the expenses total move',
    [...new Set(changes.map((d) => d.c))].sort((x, y) => x - y),
    [brokCol, sttCol].sort((x, y) => x - y));

  const sttDrop = changes.filter((d) => d.c === sttCol)
    .reduce((sum, d) => sum + ((typeof d.from === 'number' ? d.from : 0) - (typeof d.to === 'number' ? d.to : 0)), 0);
  // Two blanked cells (11, 13) plus two total rows that each fall by 24.
  eq('STT falls by exactly the flagged scrip figures, twice over in the totals', sttDrop, REMOVED * 3);

  const brokChanges = changes.filter((d) => d.c === brokCol);
  eq('exactly ONE cell in the brokerage column moves - the expenses total', brokChanges.length, 1);
  eq('...and it falls by exactly the STT removed, so the block still adds up',
    (brokChanges[0]?.from as number) - (brokChanges[0]?.to as number), REMOVED);

  eq('stamp duty is untouched - it IS deductible under s.48',
    colTotal(flagged, stampCol), colTotal(plain, stampCol));
  }

  // ── report ────────────────────────────────────────────────────────────────
  console.log('='.repeat(60));
  for (const f of failures) console.log('  FAIL ' + f);
console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
