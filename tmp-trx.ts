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

function install(trueEntry: any[][], opening: any[][] = [], corp: any[][] = []) {
  g.__ranges = {
    [`${PORTFOLIO}::True Entry!A:Z`]: trueEntry,
    [`${PORTFOLIO}::Corporate Actions!A:Z`]: corp.length ? corp : undefined,
    [`${PORTFOLIO}::Opening Holdings!A1:H50000`]: opening.length ? opening : undefined,
    [`${SCRIP_MASTER_SPREADSHEET_ID}::'${MASTER_TAB}'!A1:Z50000`]: SCRIP_ROWS,
    // An EMPTY Private Equities tab still counts as a successful read. If this range is
    // missing the master sets peFailed and the register refuses to write at all — which is
    // itself correct behaviour and is asserted separately below.
    [`${SCRIP_MASTER_SPREADSHEET_ID}::Private Equities!A1:J5000`]: [['Name', 'ISIN']],
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

  // ── golden capture / comparison ───────────────────────────────────────────
  // TRX_DUMP=<path> writes what the register produced. Captured ONCE before the
  // delivery/intraday split, then compared after, because tsc and vite cannot see a
  // register whose columns have shifted by one.
  if (process.env.TRX_DUMP) {
    const fs = await import('node:fs');
    fs.writeFileSync(process.env.TRX_DUMP, JSON.stringify({ A: g.__goldenA, B: g.__goldenB, tabs: g.__tabs }, null, 1));
    console.log('golden written to ' + process.env.TRX_DUMP);
  }

  // ── report ────────────────────────────────────────────────────────────────
  console.log('='.repeat(60));
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
