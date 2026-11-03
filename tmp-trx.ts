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
import { PORTFOLIOS, portfolioById, sheetIdForId, REPORT_DESTINATIONS, reportDestinationFor, reportSheetIdFor } from './src/lib/portfolios';
import { invalidatePrivateEquityCache } from './src/lib/privateEquities';
import { carryLots } from './src/lib/holdingsCalc';
import { parseRatio, freeSharesFor } from './src/lib/tradeRowSchema';

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

interface TeOpts { cls?: string; brok?: number; stt?: number; gst?: number; dmat?: number }
/** One True Entry row. Charges default to a distinct, easily-traced set. */
const te = (
  d: [number, number, number], name: string, isin: string,
  type: 'Buy' | 'Sell', qty: number, price: number, o: TeOpts = {},
) => [
  serial(...d), name, isin, type, qty, price,
  qty * price, type === 'Buy' ? qty * price + (o.brok ?? 10) : qty * price - (o.brok ?? 10),
  o.cls ?? 'Delivery', '',
  o.brok ?? 10, o.stt ?? 5, o.gst ?? 2, 1, 0.5, 0.1, 0.05, o.dmat ?? 0,
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
                 aif: any[][] = [], mf: any[][] = [], bond: any[][] = [], pe: any[][] = []) {
  g.__ranges = {
    [`${PORTFOLIO}::True Entry!A:Z`]: trueEntry,
    [`${PORTFOLIO}::Corporate Actions!A:Z`]: corp.length ? corp : undefined,
    [`${PORTFOLIO}::Opening Holdings!A1:H50000`]: opening.length ? opening : undefined,
    [`${SCRIP_MASTER_SPREADSHEET_ID}::'${MASTER_TAB}'!A1:Z50000`]: SCRIP_ROWS,
    // An EMPTY Private Equities tab still counts as a successful read. If this range is
    // missing the master sets peFailed and the register refuses to write at all — which is
    // itself correct behaviour and is asserted separately below.
    [`${SCRIP_MASTER_SPREADSHEET_ID}::Private Equities!A1:N5000`]: pe.length ? pe : [['Name', 'ISIN']],
    // The AIF and Mutual Fund tabs are read on every master load too. Left ABSENT by default
    // (the stub throws "Unable to parse range", which the loader treats as a legitimate empty
    // answer) so every existing fixture behaves exactly as before; the asset-class fixture
    // below installs them explicitly.
    [`${SCRIP_MASTER_SPREADSHEET_ID}::AIF!A1:N5000`]: aif.length ? aif : undefined,
    [`${SCRIP_MASTER_SPREADSHEET_ID}::Mutual Fund!A1:N5000`]: mf.length ? mf : undefined,
    [`${SCRIP_MASTER_SPREADSHEET_ID}::Bonds!A1:N5000`]: bond.length ? bond : undefined,
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
const TXC = { sno: 0, date: 1, name: 2, type: 3, qty: 4, rate: 5, amt: 6, brok: 7, net: 15 };
/** Rows of a transaction statement whose TYPE cell matches, e.g. 'BUY' or 'TOTAL SELL'. */
const txnRows = (tab: any[][] | undefined, type: string): any[][] =>
  (tab || []).filter(r => (r[TXC.type] || '').toString().trim() === type);

/** A holding statement's grand total (the charge-free AMOUNT column). */
const holdTotal = (tab: any[][] | undefined): number => {
  const r = (tab || []).find(x => (x[1] || '').toString().trim() === 'TOTAL HOLDINGS WITHOUT EXPENSES');
  if (!r) return NaN;
  // By HEADER, not by position: the PE statement carries a PAN column the other two do not,
  // so AMOUNT is column F on two tabs and G on the third. A positional read here would have
  // compared two different columns and called it a reconciliation.
  const amt = ((tab || [])[2] || []).indexOf('AMOUNT');
  return Number(r[amt >= 0 ? amt : 5]);
};
/** Does a holding statement carry a scrip's name row? */
const holdHas = (tab: any[][] | undefined, name: string): boolean =>
  (tab || []).some(r => (r[1] || '').toString().trim() === name);

const tabsWritten = (): string[] =>
  [...new Set((g.__updated || []).map((u: any) => (u.range || '').split('!')[0]))] as string[];

/** "FY26-27" from 2026. The register's own `fyLabelOf` is module-private. */
const fyLabelOfTest = (y: number) => `FY${String(y % 100).padStart(2, '0')}-${String((y + 1) % 100).padStart(2, '0')}`;

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
  // The headline holding tab is the COMBINED statement since the 3-way split; the other
  // two are partial by construction and naming one of them here would narrow it.
  eq('A: result names the holding tab', resA.holdingTabName, 'Holding Combined as on 31st March 2026');

  // ── FIXTURE A, the SINGLE-PERIOD LISTED TABS ──────────────────────────────
  // ALPHA is long-term (opening 2023, sold in-FY) and BETA short-term (bought and sold in-FY),
  // so the split is DISJOINT by construction: each tab must carry exactly one of them, and a
  // fixture where both scrips landed in one period could not tell a working split from a
  // broken one.
  const ST_TAB = `Short Term Capital Gains for ${FY_LABEL}`;
  const LT_TAB = `Long Term Capital Gains for ${FY_LABEL}`;
  const aSt = written(ST_TAB), aLt = written(LT_TAB);
  ok('A: the short-term tab was written', !!aSt);
  ok('A: the long-term tab was written', !!aLt);
  eq('A: the result names both', `${resA.periodTabs?.short}|${resA.periodTabs?.long}`, `${ST_TAB}|${LT_TAB}`);

  if (a && aSt && aLt) {
    const flatOf = (t: any[][]) => t.map(r => r.join('|'));
    const fSt = flatOf(aSt), fLt = flatOf(aLt), fA = flatOf(a);
    ok('A: short-term carries BETA', fSt.some(r => r.includes('BETA MOTORS LIMITED')));
    ok('A: ...and NOT the long-term scrip', !fSt.some(r => r.includes('ALPHA INDUSTRIES LIMITED')),
      'a long-term block on the short-term tab is a mis-routed sale');
    ok('A: long-term carries ALPHA', fLt.some(r => r.includes('ALPHA INDUSTRIES LIMITED')));
    ok('A: ...and NOT the short-term scrip', !fLt.some(r => r.includes('BETA MOTORS LIMITED')));

    // ONE P/L column each, which is the whole safety argument: `plCol` then THROWS if a sale
    // of the other period is ever routed here, instead of writing it into a column that does
    // not exist and losing the figure.
    eq('A: the short-term tab has its own P/L column',
      aSt[1].filter((c: any) => `${c}`.trim() === 'Short term').length, 1);
    ok('A: ...and no long-term column', !aSt[1].some((c: any) => `${c}`.trim() === 'Long term'));
    ok('A: the long-term tab has no short-term column',
      !aLt[1].some((c: any) => `${c}`.trim() === 'Short term'));
    eq('A: so a period tab is one column narrower than the main one', a[2].length - aSt[2].length, 1);
    eq('A: and its charge block still ends at IPF', aSt[2][aSt[2].length - 1], 'IPF');

    // CLOSING is deliberately absent. A closing POSITION is not a holding-period fact, and
    // printing the real one under a section showing one period's sales makes a filed page look
    // like it does not add up.
    ok('A: no closing section on the short-term tab', !fSt.some(r => r.includes('CLOSING')));
    ok('A: ...nor on the long-term tab', !fLt.some(r => r.includes('CLOSING')));
    ok('A: while the main tab keeps its own', fA.some(r => r.includes('CLOSING')),
      'the period tabs clone their blocks; mutating them would strip the main tab too');

    // NO NARRATION ON A POPULATED TAB (03-Nov-2026, owner: "I have notice these narrations in
    // all of our calculating sheet, please remove them"). These tabs carried four explanatory
    // paragraphs between the column header and the first block; they are gone.
    //
    // Checked BOTH ways on purpose. The phrase list alone would pass the day someone reworded a
    // note, and the structural check alone would pass if a paragraph moved further down the
    // page - so the first is pinned by its exact sentences and the second by the geometry.
    for (const phrase of ['at the quantity those sales actually consumed',
                          'OPENING STOCK IS NEVER SHOWN AS A PURCHASE HERE',
                          'MAY be added',
                          'still held on 31 March',
                          'do not add the two expense totals together']) {
      ok(`A: the short-term tab no longer narrates — "${phrase.slice(0, 32)}..."`,
        !fSt.some(r => r.includes(phrase)));
      ok(`A: ...nor the long-term tab — "${phrase.slice(0, 32)}..."`,
        !fLt.some(r => r.includes(phrase)));
    }
    // Structural half: the row directly under SCRIPT NAME must be a block row, not prose. A
    // sentence row carries its text in the NAME column with every other cell blank, so a long
    // string there with nothing beside it is exactly the shape that was removed.
    const underHeader = (t: any[][]) => {
      const h = t.findIndex(r => r.some((c: any) => `${c}`.trim() === 'SCRIPT NAME'));
      return h >= 0 && h + 1 < t.length ? t[h + 1] : [];
    };
    for (const [label, t] of [['short-term', aSt], ['long-term', aLt]] as [string, any[][]][]) {
      const row = underHeader(t);
      const prose = `${row[1] ?? ''}`.length > 60 && row.every((c: any, i: number) =>
        i === 1 || `${c ?? ''}`.trim() === '');
      ok(`A: the ${label} grid starts at the first block, with no note row above it`, !prose);
    }

    // THE PURCHASE COLUMN FAMILY CARRIES NO DATA, which covers two regressions at once: a
    // purchase row coming back, and a SPLIT or corp-action RESTATEMENT being filed there
    // because `restateCols` read `blk.purchases.length` off a block that still had them. The
    // COLUMNS stay - the geometry is shared with the main tab - it is the DATA that must go.
    const P_FAM = [6, 7, 8, 9];   // pDate, pQty, pRate, pAmt - see LEFT_KEYS in trxRegister.ts
    const headerEnd = (t: any[][]) => {
      let i = -1;
      t.forEach((r, k) => {
        if (r.some((c: any) => ['SCRIPT NAME', 'PURCHASE', 'IPF'].includes(`${c}`.trim()))) i = k;
      });
      return i;
    };
    const purchaseCells = (t: any[][]) =>
      t.slice(headerEnd(t) + 1).filter(r => P_FAM.some(c => `${r[c] ?? ''}`.trim() !== '')).length;
    /** Total of the PURCHASE quantity column (index 7 - see LEFT_KEYS), past the headers. */
    const purchaseQtyOn = (t: any[][]) =>
      t.slice(headerEnd(t) + 1).reduce((sum, r) => sum + (typeof r[7] === 'number' ? r[7] : 0), 0);

    // ONLY THE PURCHASES THESE SALES ATE, PRO-RATED TO WHAT THEY ATE. BETA bought 500 in-FY and
    // sold 200 of them SHORT, so the short-term tab shows that purchase at 200 - not 500, and
    // not nothing. All three answers are disjoint, which is the point of using this fixture.
    eq('A: the short-term tab shows the funding purchase at the quantity SOLD', purchaseQtyOn(aSt), 200);
    eq('A: ...where the main tab shows the whole 500 it bought', purchaseQtyOn(a), 500);

    // AN OPENING LOT IS NOT A PURCHASE, whatever period it was sold in - the owner's explicit
    // instruction. ALPHA's long-term sale came entirely out of opening stock, so the long-term
    // tab carries no purchase row at all.
    eq('A: the long-term tab shows no purchase - ALPHA sold out of OPENING stock', purchaseCells(aLt), 0);

    // AND IT NEVER CAN, which is arithmetic rather than a special case: the longest an in-FY
    // purchase can be held inside one FY is 364 days, short of the 365-day listed threshold.
    // Pinned because a future `ltDays` change would make it reachable and nobody would look.
    ok('A: ...and no in-FY purchase can EVER fund a long-term sale in the same FY',
      purchaseQtyOn(aLt) === 0,
      'if this ever fires, the long-term tab has become reachable and its notes need rewriting');

    // THE TOTALS NOW MEAN SOMETHING, and fixture A makes the right and wrong answers disjoint.
    // BETA buys in-FY and sells SHORT; ALPHA sells out of opening stock, LONG. Three in-FY
    // trades at 18.65 of charges each. Old behaviour put BETA's purchase on the short-term tab,
    // so the two summed to 55.95 - the main tab's own total, by coincidence of this fixture.
    // Now they sum to the SALE charges alone and the shortfall is exactly that purchase.
    const expTotalOf = (t: any[][]): number | null => {
      const i = t.findIndex(r => r.some((c: any) => /Expenses$/.test(`${c}`)));
      if (i < 0) return null;
      const n = (t[i + 1] || []).find((c: any) => typeof c === 'number');
      return typeof n === 'number' ? n : null;
    };
    const stE = expTotalOf(aSt) || 0, ltE = expTotalOf(aLt) || 0, mainE = expTotalOf(a) || 0;
    near("A: short-term expenses are BETA's sale PLUS the 200 shares it sold", stE, 26.11);
    near("A: long-term expenses are ALPHA's sale alone - it bought nothing", ltE, 18.65);
    near('A: the two add to 44.76', stE + ltE, 44.76);
    // 18.65 x 300/500. The 300 BETA shares still held on 31-Mar carry their buy-side charges
    // on the main tab and on neither period tab, which is the whole reason the purchase arm of
    // the partition check is a CEILING and not an equality.
    near("A: falling short of the main tab by the UNSOLD 300 shares' charges", mainE - (stE + ltE), 11.19);
    ok('A: ...and all three of these totals are distinct', new Set([
      Number(stE.toFixed(2)), Number(ltE.toFixed(2)), Number(mainE.toFixed(2)) ]).size === 3,
      'a fixture where two of them coincide cannot tell a right answer from a wrong one');
    // The tab used to SAY all of this in a note above the first block. The narration came off
    // on 03-Nov-2026, so the 11.19 shortfall is now stated nowhere on the page - it is pinned
    // here instead, and the arithmetic is still what the CEILING arm of the partition check
    // enforces on every run. Asserted absent, with the rest of the prose, further up.
    ok('A: ...and the note that used to explain the shortfall is gone',
      !fSt.some(r => r.includes('holding tabs are the authority')));

    // THE PARTITION, asserted on the FIGURE: each period's P/L must equal what is already
    // filed for that period on the main tab.
    const plAt = (t: any[][], label: string) => {
      const c = t[1].findIndex((x: any) => `${x}`.trim() === label);
      const gt = t.find(r => r[1] === 'GRAND TOTAL');
      return c >= 0 && gt ? Number(gt[c]) || 0 : NaN;
    };
    near('A: short-term P/L ties to the main tab', plAt(aSt, 'Short term'), plAt(a, 'Short term'));
    near('A: long-term P/L ties to the main tab', plAt(aLt, 'Long term'), plAt(a, 'Long term'));
    ok('A: ...and neither side is nil', Math.abs(plAt(a, 'Short term')) > 0 && Math.abs(plAt(a, 'Long term')) > 0,
      'a fixture with an empty period would satisfy the tie trivially');

    // The expense footer. Matched as an EXACT CELL, never a substring of the row: the note
    // rows quote the label in prose, so `includes` would pass on a tab whose footer had gone.
    ok('A: the short-term tab keeps its expense footer',
      aSt.some(r => r.some((c: any) => `${c}`.trim() === 'Short Term Expenses')));
    ok('A: the long-term tab keeps its expense footer',
      aLt.some(r => r.some((c: any) => `${c}`.trim() === 'Long Term Expenses')));

    // -- THE TWO ACQUISITION TABS (28-Oct-2026) ---------------------------------------
    //
    // The same ST/LT split with ONE acquisition column family instead of two: no OPENING
    // STOCK columns, and the stock FIFO carried in printed as a B/F purchase row.
    //
    // Fixture A is the right one for this because the two scrips are DISJOINT in exactly the
    // way that matters here. BETA's short-term sale was funded by an IN-YEAR buy, so its
    // acquisition tab must look like its period tab. ALPHA's long-term sale came entirely out
    // of OPENING stock, so its period tab shows no purchase at all while its acquisition tab
    // must show one - and that pair is the whole fold-in, with the right and wrong answers on
    // opposite sides of zero.
    const ST_ACQ = `Short Term Capital Gains (Acquisitions) for ${FY_LABEL}`;
    const LT_ACQ = `Long Term Capital Gains (Acquisitions) for ${FY_LABEL}`;
    const aStA = written(ST_ACQ), aLtA = written(LT_ACQ);
    ok('A: the short-term ACQUISITIONS tab was written', !!aStA);
    ok('A: the long-term ACQUISITIONS tab was written', !!aLtA);
    eq('A: the result names both', `${resA.acqTabs?.short}|${resA.acqTabs?.long}`, `${ST_ACQ}|${LT_ACQ}`);

    if (aStA && aLtA) {
      const fStA = flatOf(aStA), fLtA = flatOf(aLtA);

      // THE GEOMETRY. Four columns narrower than its period sibling, which is the opening
      // family and nothing else - and the group header must not still announce one.
      eq('A: an acquisition tab is FOUR columns narrower than its period sibling',
        aSt[2].length - aStA[2].length, 4);
      ok('A: ...and carries no OPENING STOCK heading',
        !aStA[1].some((c: any) => `${c}`.trim() === 'OPENING STOCK'));
      ok('A: while its period sibling still does',
        aSt[1].some((c: any) => `${c}`.trim() === 'OPENING STOCK'),
        'the acquisition tabs take their own variant; they must not restyle the period tabs');
      ok('A: the purchase family is headed for what it now holds',
        aStA[1].some((c: any) => `${c}`.trim() === 'PURCHASE / ACQUISITION'));
      eq('A: ...and the charge block still ends at IPF', aStA[2][aStA[2].length - 1], 'IPF');

      // The acquisition family on these tabs: pDate..pAmt at 2..5, since the opening four are
      // gone. Pinned against the HEADER rather than taken on trust - a positional constant
      // that disagreed with the layout would compare two different columns and call it a check.
      eq('A: PURCHASE follows SCRIPT NAME with nothing between, so its QTY is index 3',
        `${aStA[1][2]}|${aStA[2][2]}|${aStA[2][3]}`, 'PURCHASE / ACQUISITION|DATE|NO OF SHARE');
      const acqQtyOn = (t: any[][]) =>
        t.slice(headerEnd(t) + 1).reduce((sum, r) => sum + (typeof r[3] === 'number' ? r[3] : 0), 0);

      // BETA's 200 short-term shares came from the in-year buy, so the short-term acquisition
      // tab reads exactly as its period sibling does - and carries NO B/F row.
      eq('A: short-term acquisitions show the in-year buy at the quantity sold', acqQtyOn(aStA), 200);
      eq('A: ...the same quantity its period sibling shows', acqQtyOn(aStA), purchaseQtyOn(aSt));
      // The label is tested as an EXACT SCRIPT NAME CELL past the headers, never as a
      // substring of the row. The prose that used to quote "B/F" above the first block came
      // off on 03-Nov-2026, so `includes` would pass today - the exact-cell form stays because
      // it is the stricter test and the reason it was needed can come back. Same rule as the
      // footer, which the notes also used to quote.
      const bfRows = (t: any[][]) =>
        t.slice(headerEnd(t) + 1).filter(r => `${r[1] ?? ''}`.trim() === 'B/F').length;
      eq('A: ...and nothing brought forward - BETA bought in-year', bfRows(aStA), 0);

      // THE FOLD-IN ITSELF. ALPHA sold out of opening stock: its period tab shows no purchase
      // row at all, its acquisition tab shows those shares as B/F. Zero against a real
      // quantity - the two answers cannot be confused.
      eq('A: the long-term period tab shows no purchase', purchaseQtyOn(aLt), 0);
      ok('A: ...while the long-term ACQUISITIONS tab shows the stock FIFO consumed',
        acqQtyOn(aLtA) > 0,
        'this is the fold-in; a 0 here means opening lots never became acquisition rows');
      ok('A: ...labelled B/F, so blank charge cells read as a prior year rather than missing data',
        bfRows(aLtA) > 0);
      // And it really is charge-free ON THE ROW, not merely absent from the total: a charge
      // written into a B/F row that happened to cancel elsewhere would pass the total check.
      ok('A: ...with every charge cell on that row blank',
        aLtA.slice(headerEnd(aLtA) + 1)
          .filter(r => `${r[1] ?? ''}`.trim() === 'B/F')
          .every(r => r.slice(aLtA[2].indexOf('Brok.Total')).every((c: any) => `${c ?? ''}`.trim() === '')));

      // A B/F ROW CARRIES NO CHARGES, which is what keeps the expense total identical to the
      // sibling's. If it ever inherited the opening lot's charges, this is what fires - and
      // nothing on the tab could show it, because those cells are blank by design.
      const stAE = expTotalOf(aStA) || 0, ltAE = expTotalOf(aLtA) || 0;
      near('A: short-term acquisition expenses equal the period tab figure', stAE, stE);
      near('A: long-term acquisition expenses equal the period tab figure', ltAE, ltE);
      near('A: ...and are the same 26.11 / 18.65, not a new pair of figures', stAE + ltAE, 44.76);
      ok('A: ...a tie that is NOT trivial, since ALPHA added an acquisition row to one of them',
        acqQtyOn(aLtA) > 0 && Math.abs(ltAE - ltE) < 0.005,
        'the long-term tab gained a row and its expense total did not move - that is the point');

      // The P/L is untouched: these tabs restate sales already filed.
      near('A: short-term acquisition P/L ties to the main tab', plAt(aStA, 'Short term'), plAt(a, 'Short term'));
      near('A: long-term acquisition P/L ties to the main tab', plAt(aLtA, 'Long term'), plAt(a, 'Long term'));
      ok('A: one P/L column each here too', !aStA[1].some((c: any) => `${c}`.trim() === 'Long term'));

      // SALES less ACQUISITIONS is the P/L already filed - the property these tabs have and
      // the period tabs cannot, because every lot that paid for these sales is on the page.
      const sumCol = (t: any[][], c: number) =>
        t.slice(headerEnd(t) + 1).reduce((n, r) => n + (typeof r[c] === 'number' ? r[c] : 0), 0);
      eq('A: SALES AMOUNT is index 9 on an acquisition tab',
        `${aStA[1][6]}|${aStA[2][9]}`, 'SALES|AMOUNT');
      near('A: SALES less ACQUISITIONS is the short-term P/L already filed',
        sumCol(aStA, 9) - sumCol(aStA, 5), plAt(a, 'Short term'));
      near('A: ...and the long-term one too',
        sumCol(aLtA, 9) - sumCol(aLtA, 5), plAt(a, 'Long term'));

      // CLOSING stays absent here as well - a closing POSITION is not a holding-period fact.
      ok('A: no closing section on an acquisition tab', !fStA.some(r => r.includes('CLOSING')));

      // NARRATION IS OFF THESE TABS TOO (03-Nov-2026). Four paragraphs stood between the
      // column header and the first block; each is now asserted ABSENT, in the same both-ways
      // form the period tabs get above - exact sentences plus the geometry.
      //
      // The B/F paragraph is the one that carried a real fact: a carried-in lot's blank charge
      // cells are deliberate, not a failed import. The `B/F` LABEL on the row is what states
      // that now, which is why the label itself is pinned as an exact cell further up and why
      // dropping the sentence does not leave the page saying nothing.
      for (const phrase of ['A B/F ROW CARRIES NO CHARGES', 'identical to the figure on',
                            'less PURCHASE AMOUNT', 'appears as a sentence',
                            'holding tabs are the authority']) {
        ok(`A: the acquisition tab no longer narrates — "${phrase.slice(0, 30)}..."`,
          !fStA.some(r => r.includes(phrase)));
      }
      for (const [label, t] of [['short-term', aStA], ['long-term', aLtA]] as [string, any[][]][]) {
        const row = underHeader(t);
        const prose = `${row[1] ?? ''}`.length > 60 && row.every((c: any, i: number) =>
          i === 1 || `${c ?? ''}`.trim() === '');
        ok(`A: the ${label} acquisition grid starts at the first block`, !prose);
      }
    }
  }

  // The note rows must be PUSHED before the first block, never spliced in after the emission:
  // every index the formula view and the PAINT read (`expStart`, `expEnd`, `grandTotalRow`) is
  // recorded as the rows go out, so a splice shifts the colour bands a row off the values they
  // describe. Asserted over source because the written grid looks identical either way.
  {
    const nfs = await import('node:fs');
    const reg = nfs.readFileSync('src/lib/trxRegister.ts', 'utf8')
      .replace(/(^|[^*])\/\*[\s\S]*?\*\//g, '$1').replace(/^\s*\/\/.*$/gm, '');
    const notesAt = reg.indexOf('for (const n of notes)');
    const blocksAt = reg.indexOf('for (const b of active)');
    ok('A: note rows are emitted before the first block', notesAt > 0 && blocksAt > 0 && notesAt < blocksAt);

    // THE PERIOD TABS MUST STAY OUT OF THE CHARGE-CONSERVATION SUM. A block's purchase charges
    // appear on BOTH of them, so counting them trebles every listed figure, the guard sees
    // drift and NO REGISTER WRITES AT ALL. Same rule, same reason, as the transaction
    // statements. Asserted over source because the symptom is a total failure to write, which
    // no assertion about a written tab can reach.
    const cgSum = reg.slice(reg.indexOf('const cgGrand ='), reg.indexOf('const cgGrand =') + 240);
    ok('A: the period tabs stay OUT of the charge-conservation sum',
      cgSum.length > 40 && !cgSum.includes('periodCg'));

    // And the partition check must count the PERIOD tabs' sale rows rather than restating the
    // main tab's — a guard that compares a number to itself passes forever, and with correct
    // input nothing else can tell the difference.
    ok('A: the partition check counts the period tabs, not the main tab',
      /const rows = periodCg\.reduce\(\(s, p\) => s \+ p\.em\.sellRows, 0\);/.test(reg));

    // THE ACQUISITION TABS MUST STAY OUT OF THAT SUM TOO, and they are the THIRD restatement:
    // counting all three QUADRUPLES every listed charge, the guard sees drift, and no register
    // writes at all. Source, for the same reason - the symptom is a total failure to write.
    ok('A: the acquisition tabs stay OUT of the charge-conservation sum',
      cgSum.length > 40 && !cgSum.includes('acqCg'));

    // And `opening: []` on the acquisition clone is what makes the ABSENT opening family safe
    // rather than merely unused: with it, `openAgg` is empty on every block and `openCols()` -
    // which THROWS on that variant - is never reached. Source, because the failure is again a
    // refusal to write rather than anything visible on a tab.
    const acqClone = reg.slice(reg.indexOf('const acqCg ='), reg.indexOf('const classCg'));
    ok('A: the acquisition clone is locatable in source', acqClone.length > 400);
    ok('A: ...and empties `opening` so the absent column family is never addressed',
      /opening: \[\]/.test(acqClone));
    ok('A: ...and strips the SPLIT and corp-action FIGURES, keeping their sentences',
      /splits: \[\], corpNotes: notesOnly\(b\)/.test(acqClone));
    // A carried-in row must take a FRESH zero bundle. Inheriting the lot's own charges is a
    // deduction claimed for a cost incurred in a year already filed, and the row's charge
    // cells are blank by design so nothing on the page could show it.
    ok('A: a brought-forward row takes a fresh ZERO_CHARGES bundle',
      /charges: \{ \.\.\.ZERO_CHARGES \}/.test(reg.slice(reg.indexOf('const matchedAcquisitions'))));
  }

  // ── FIXTURE A2 — an EMPTY period is still written ─────────────────────────
  // Skipping it keeps LAST year's figures standing under THIS year's heading, which is the one
  // failure a reader of the tab cannot see. Same rule the intraday and listed tabs follow.
  install([TE_HEADER,
    te([2025, 7, 1], 'BETA MOTORS LIMITED', 'INE002A01018', 'Buy', 500, 200),
    te([2025, 9, 15], 'BETA MOTORS LIMITED', 'INE002A01018', 'Sell', 200, 250)], [OPENING_A[0]]);
  await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
  const emptyLt = written(LT_TAB);
  ok('A2: the long-term tab is written with no long-term sales', !!emptyLt);
  ok('A2: ...and says so rather than showing bare headers',
    (emptyLt || []).some(r => r.join('|').includes(`No long term listed transactions in ${FY_LABEL}`)));
  ok('A2: ...and carries no scrip block', !(emptyLt || []).some(r => r.join('|').includes('BETA MOTORS LIMITED')));
  ok('A2: while the short-term tab has the block', (written(ST_TAB) || []).some(r => r.join('|').includes('BETA MOTORS LIMITED')));

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
  g.__failRange = { [`${SCRIP_MASTER_SPREADSHEET_ID}::Private Equities!A1:N5000`]: true };
  let refused = '';
  try { await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio'); }
  catch (e: any) { refused = e?.message || ''; }
  ok('unreadable Private Equities tab still refuses to write',
    /Private Equities/.test(refused) && /not written/i.test(refused), `got: ${refused || '(no throw)'}`);

  // ── the removed Dmat column, and the figure that must not vanish with it ─────
  //
  // The column went on 26-Oct-2026 because nothing but INTEGRATED ever filled it. But dmat had
  // to leave the charge-conservation guard's `expect` at the same time, or the guard would see a
  // charge it expects and no tab emitting it and write NO REGISTER AT ALL - so this pair is the
  // whole safety case for the removal: the register still writes, AND the rupees are reported.
  {
    install(FIXTURE_A, OPENING_A);
    const plain = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    // The ordinary book, and the answer that justified removing the column in the first place.
    eq('A: a ledger with no demat charge reports none', plain.dmatNotShown, 0);

    // The SAME fixture with a DP charge on each of its THREE in-year trades. Right and wrong
    // answers are disjoint: 3 x 7.25 against 0, and against a register that refuses to write.
    const WITH_DMAT = FIXTURE_A.map((r, i) =>
      i === 0 ? r : [...r.slice(0, 17), (r[3] === 'Buy' || r[3] === 'Sell') ? 7.25 : 0]);
    install(WITH_DMAT, OPENING_A);
    let threw = ''; let withD: any = null;
    try { withD = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio'); }
    catch (e: any) { threw = e?.message || String(e); }
    ok('A: a demat charge no longer breaks the conservation guard', !threw, `got: ${threw}`);
    eq('A: ...and the rupees it no longer shows are REPORTED', withD?.dmatNotShown, 21.75);
    // On NO tab - which is the point of the removal, and is what makes the report load-bearing
    // rather than decorative.
    const dD = written(CG_TAB) || [];
    ok('A: ...while appearing on no tab at all',
      !dD.some(r => r.some((c: any) => typeof c === 'number' && Math.abs(c - 7.25) < 0.001)));
  }

  // ── the split itself ────────────────────────────────────────────
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
    eq('A: delivery is 24 columns wide', dA[2].length, 24);
    eq('A: delivery has two P/L headers', dA[2].filter((c: any) => c === 'P/L').length, 2);
    eq('A: IPF is still the last column', dA[2][dA[2].length - 1], 'IPF');
    // THE DMAT COLUMN IS GONE (26-Oct-2026, asked for directly). Nothing but INTEGRATED ever
    // populated it, so on this book it was a headed blank on every filed tab. Asserted as the
    // WHOLE charge block in order rather than as "Dmat is absent": the geometry is derived from
    // CHARGE_HDR, so a re-insertion anywhere shifts every charge one column right in a document
    // someone files, and only the full sequence catches that.
    eq('A: the charge block is the eight charges, in order, with no Dmat',
      dA[2].slice(dA[2].indexOf('Brok.Total')),
      ['Brok.Total', 'STT', 'GST', 'ET Charges', 'Stamp duty', 'SEBI Chg.', 'EXCH.Clg.', 'IPF']);
    const foot = dA.filter(r => r.some((c: any) => /Expenses$/.test(String(c))));
    eq('A: delivery footer names only delivery expenses', foot.map(r => r.find((c: any) => /Expenses$/.test(String(c)))), ['Delivery Expenses']);
  }
  if (iA) {
    eq('A: intraday keeps only the Intra-Day caption', iA[1].filter((c: any) => /term|Intra-Day/.test(String(c))), ['Intra-Day']);
    eq('A: intraday is 23 columns wide', iA[2].length, 23);
    eq('A: the intraday tab lost the Dmat column too', iA[2].indexOf('Dmat'), -1);
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
      // The transaction statement REUSES CHARGE_HDR verbatim, so it lost the column with the
      // gains tabs - by design, and enforced by the module-load alignment check. A statement
      // sitting beside a gains tab must carry the same charge block in the same order.
      eq('E: the statement lost the Dmat column with the gains tabs', (mfTxn[2] || []).indexOf('Dmat'), -1);
      eq('E: ...and NET moved left with it', (mfTxn[2] || [])[TXC.net], 'NET AMOUNT');
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
    g.__ranges[`${SCRIP_MASTER_SPREADSHEET_ID}::Private Equities!A1:N5000`] =
      [['Company', 'ISIN'], ['STRIDE VENTURES PRIVATE LIMITED', '']];
    invalidateScripCache(); invalidatePrivateEquityCache();

    let threwF = '';
    let resF: any = null;
    try { resF = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio'); }
    catch (e: any) { threwF = e?.message || String(e); }
    ok('F: a PE-only book still produces a register', !threwF, `threw: ${threwF}`);

    // ── COLLECT MODE: the off-market flag the formula twin actually receives ─────────
    //
    // Source-asserted elsewhere because neither suite could EXECUTE this channel - `derive` is
    // filled only in collect mode and read only by the gapi-driven view. It can be executed from
    // here, which is better: a source assertion proves the line exists, not that the flag
    // arrives. Fixture F writes a Private Equity gains tab beside the listed ones, so one collect
    // run carries both kinds and the two must disagree.
    {
      const collected: any[] = [];
      await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio', collected);
      const byTab = (frag: string) => collected.find(c => c.tab.includes(frag));
      const listed = byTab('Capital Gains for') && collected.find(c => c.tab === `Capital Gains for ${FY_LABEL}`);
      const pe = byTab('Private Equity');
      ok('F: collect mode carries the Private Equity tab', !!pe, `tabs: ${collected.map(c => c.tab).join(', ')}`);
      eq('F: ...flagged OFF-MARKET for the twin', pe && pe.derive.isOffMarket, true);
      eq('F: ...while the listed tab is NOT', listed && listed.derive.isOffMarket, false);
    }

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
  const resPlain = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
  const plain = written(CG_TAB);

  install(FIXTURE_G);
  g.__ranges[MASTER_RANGE] = FLAGGED_MASTER;
  // If the emission dropped STT but the conservation guard still EXPECTED it, this throws and
  // no register is written at all — the failure CLAUDE.md records twice. So reaching the next
  // line is itself the assertion that both sides were keyed off the same flag.
  const resFlagged = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
  const flagged = written(CG_TAB);

  ok('the register still writes with a scrip flagged', !!flagged);

  // The DIAGNOSTIC the badge tooltip reports. A diagnostic that lies is worse than none:
  // it would send the next debugging session down the wrong branch. Both numbers are
  // asserted in both directions, off the SAME runs the cell-diff above asserts on.
  eq('diagnostic: no scrip flagged in the unmarked master', resPlain.sttFlaggedInMaster, 0);
  eq('diagnostic: nothing suppressed in the unmarked run', resPlain.sttSuppressed.length, 0);
  eq('diagnostic: exactly one scrip flagged in the marked master', resFlagged.sttFlaggedInMaster, 1);
  ok('diagnostic: the suppressed list names the flagged scrip, and only it',
    resFlagged.sttSuppressed.length === 1 && /GAMMA/i.test(resFlagged.sttSuppressed[0]),
    JSON.stringify(resFlagged.sttSuppressed));

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

  // ── Fixture K. A BONUS re-derives its share count from the position on its own date ──
  //
  // The owner's case: buy 123, buy 456, take a 1:2 bonus (=289.5 free), then DELETE the 123.
  // The bonus used to keep 289.5 forever, because only the resulting quantity was ever stored.
  // The ledger below is exactly that book AFTER the deletion - 456 held, and a bonus row still
  // carrying its stale 289.5 - plus a `Ratio` of 1:2. The derived answer is 456/2 = 228.
  //
  // The control run is the same ledger with the Ratio column REMOVED: it must still produce
  // 289.5, because every sheet written before 14-Sep-2026 has no ratio and rewriting those
  // retroactively would change filed numbers.
  {
    const HDR_R = [
      'Trade Date', 'Stock Name', 'ISIN', 'Transaction Type', 'Number of Shares', 'Avg Price',
      'Total Amount (Turnover)', 'Total Amount with Expense (Incl STT)', 'Trade Class', 'Notes',
      'Total Brokerage', 'STT', 'IGST', 'Exchange Turnover Charges', 'Stamp Duty',
      'SEBI Turnover Fees', 'IPF Charges', 'Demat Charges', 'Ratio',
    ];
    const row = (d: [number, number, number], type: string, qty: number, price: number, ratio: string) => [
      serial(...d), 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', type, qty, price,
      qty * price, qty * price, 'Delivery', '', 0, 0, 0, 0, 0, 0, 0, 0, ratio,
    ];
    const STALE = 289.5;          // 1:2 of (123 + 456), from before the 123 was deleted
    const DERIVED = 228;          // 1:2 of the 456 that actually remains
    const FIXTURE_K = [
      HDR_R,
      row([2025, 5, 1], 'Buy', 456, 100, ''),
      row([2025, 6, 1], 'Bonus', STALE, 0, '1:2'),
    ];

    /** Total of the PURCHASE quantity column. Located from the GROUP header row so it cannot
     *  be confused with the identically-labelled opening/sales qty columns. */
    const purchaseQty = (tab: any[][] | undefined): number => {
      const grp = (tab || []).findIndex((r) => r.indexOf('PURCHASE') >= 0);
      if (grp < 0) return NaN;
      const c = (tab || [])[grp].indexOf('PURCHASE') + 1;   // DATE, NO OF SHARE, RATE, AMOUNT
      return (tab || []).reduce((sum, r, i) => sum + (i > grp + 1 && typeof r[c] === 'number' ? r[c] : 0), 0);
    };

    install(FIXTURE_K);
    await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    eq('K: the bonus re-derives from what is actually held (456 -> 228), not its stale 289.5',
      purchaseQty(written(CG_TAB)), 456 + DERIVED);

    // Control: the SAME ledger with no Ratio column at all.
    const noRatio = FIXTURE_K.map((r) => r.slice(0, HDR_R.length - 1));
    install(noRatio);
    await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    eq('K control: with no ratio stored, the frozen quantity still stands (no history rewrite)',
      purchaseQty(written(CG_TAB)), 456 + STALE);
  }

  // ── parseRatio / freeSharesFor, directly ───────────────────────────────────
  {
    ok('parseRatio reads N:M', JSON.stringify(parseRatio('1:2')) === JSON.stringify({ num: 1, den: 2 }));
    ok('parseRatio tolerates spacing and / and -', !!parseRatio(' 3 / 4 ') && !!parseRatio('3-4'));
    eq('parseRatio rejects a bare number - "1" is not a ratio', parseRatio('1'), null);
    eq('parseRatio rejects a zero denominator', parseRatio('1:0'), null);
    eq('parseRatio rejects prose', parseRatio('one for two'), null);
    // The trap that kept the ratio OUT of the Avg Price column.
    eq('...and parseFloat would have read "1:2" as the number 1', parseFloat('1:2'), 1);

    eq('Bonus 1:2 on 456 adds half', freeSharesFor('Bonus', { num: 1, den: 2 }, 456), 228);
    eq('Bonus 1:1 on 100 doubles the holding', freeSharesFor('Bonus', { num: 1, den: 1 }, 100), 100);
    eq('Split 2:1 on 100 ADDS 100 (each old becomes two)', freeSharesFor('Split', { num: 2, den: 1 }, 100), 100);
    eq('Split 5:1 on 100 adds 400', freeSharesFor('Split', { num: 5, den: 1 }, 100), 400);
    eq('a bonus on nothing is nothing', freeSharesFor('Bonus', { num: 1, den: 2 }, 0), 0);
    eq('a bonus on a NEGATIVE position is nothing', freeSharesFor('Bonus', { num: 1, den: 2 }, -50), 0);
  }

  // ── Fixture J. The holding period CARRIES through a merger / demerger ───────
  //
  // s.2(42A) Expl 1(i)(g) (demerger) and 1(i)(b) (s.47(vii) amalgamation): the period the
  // PARENT's shares were held counts towards the received shares. Until 12-Sep-2026 both
  // engines stamped the action date, filing a long-term parent's spin-off as short-term.
  //
  // The two scenarios are chosen so OLD and NEW behaviour are DISJOINT - there is no overlap
  // to pass by luck:
  //   J1 inheritance   GAMMA opening lot 01-Apr-2020, demerged 01-Jun-2025 into DELTA,
  //                    DELTA sold 01-Aug-2025. Old: 61 days -> SHORT 60,000.
  //                    New: inherited 2020 date -> LONG 60,000.
  //   J2 queue order   BETA bought on the market 01-May-2025 500 @ 300; ALPHA (opening lot
  //                    01-Apr-2019 @ 10) merges into BETA 01-Jun-2025, 500 shares carrying
  //                    10,000 of basis. BETA 500 sold 01-Jul-2025 @ 400.
  //                    Old (push -> unsorted queue): eats the May lot, SHORT 50,000.
  //                    New (insertLotByTs): eats the 2019 lot, LONG 190,000.
  // So the whole tab is ST 110,000 / LT 0 under the old code and ST 0 / LT 250,000 under the
  // new one. Fixture C could not see this change at all: its inherited dates land on the same
  // side of the 365-day line, and it never sells a received security into a pre-existing lot.
  {
    const TE_J: any[][] = [
      TE_HEADER,
      te([2025, 5, 1], 'BETA MOTORS LIMITED', 'INE002A01018', 'Buy', 500, 300, { brok: 0, stt: 0, gst: 0 }),
      te([2025, 7, 1], 'BETA MOTORS LIMITED', 'INE002A01018', 'Sell', 500, 400, { brok: 0, stt: 0, gst: 0 }),
      te([2025, 8, 1], 'DELTA POWER LIMITED', 'INE004A01012', 'Sell', 1000, 80, { brok: 0, stt: 0, gst: 0 }),
    ];
    const OPEN_J: any[][] = [
      ['Security', 'ISIN', 'Acquisition Date', 'Quantity', 'Cost Per Share', 'Total Cost', '', ''],
      ['GAMMA TECH LIMITED', 'INE003A01015', serial(2020, 4, 1), 1000, 50, 50000, '', ''],
      ['ALPHA INDUSTRIES LIMITED', 'INE001A01011', serial(2019, 4, 1), 1000, 10, 10000, '', ''],
    ];
    const CORP_J: any[][] = [
      ['Date', 'Type', 'From', 'To', 'Shares In', 'Cost', 'Notes'],
      ['01/06/2025', 'Demerger', 'GAMMA TECH LIMITED', 'DELTA POWER LIMITED', 1000, 20000, ''],
      ['01/06/2025', 'Merger', 'ALPHA INDUSTRIES LIMITED', 'BETA MOTORS LIMITED', 500, 10000, ''],
    ];

    install(TE_J, OPEN_J, CORP_J);
    // Reaching the next line is itself an assertion: the charge-conservation guard did not fire.
    await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    const tabJ = written(CG_TAB);
    ok('J: the register writes with carried-over holding periods', !!tabJ);

    const colJ = (h: string) => { for (const r of tabJ || []) { const i = r.indexOf(h); if (i >= 0) return i; } return -1; };
    const stCol = colJ('Short term'), ltCol = colJ('Long term');
    ok('J: the tab has both P/L columns', stCol >= 0 && ltCol >= 0, `st=${stCol} lt=${ltCol}`);

    const grand = (tabJ || []).find((r) => String(r[1] ?? '') === 'GRAND TOTAL');
    ok('J: a GRAND TOTAL row exists', !!grand);
    const numOf = (v: any) => (typeof v === 'number' ? v : 0);

    // The decisive pair. Under the pre-12-Sep-2026 behaviour these read 110000 / 0.
    eq('J: NOTHING is short term - both received parcels inherited a long-term parent',
      numOf(grand?.[stCol]), 0);
    eq('J: the whole 250,000 lands in LONG TERM (60,000 demerger + 190,000 merger)',
      numOf(grand?.[ltCol]), 250000);
  }

  // ── carryLots, directly ─────────────────────────────────────────────────────
  // The apportionment is shared by all four replay sites, so its edge cases are pinned once
  // here rather than four times through fixtures that can only observe them indirectly.
  {
    const src = [
      { ts: Date.UTC(2019, 3, 1), qty: 100, cost: 1000 },
      { ts: Date.UTC(2024, 3, 1), qty: 100, cost: 9000 },
    ];
    const out = carryLots(src, 200, 10000, Date.UTC(2025, 5, 1));
    eq('carryLots: one parcel per parent lot', out.length, 2);
    eq('carryLots: quantities sum to sharesIn EXACTLY', out.reduce((a, b) => a + b.qty, 0), 200);
    eq('carryLots: costs sum to the action cost EXACTLY', out.reduce((a, b) => a + b.cost, 0), 10000);
    eq('carryLots: shares split by QUANTITY', out[0]?.qty, 100);
    eq('carryLots: cost splits by BASIS SURRENDERED, not by quantity', out[0]?.cost, 1000);
    // Guarded: a regression that returns FEWER parcels must report as a FAIL, not throw and
    // abort the run before the report prints (which would hide every assertion after it).
    ok('carryLots: parcels come back oldest-first for the O(1) insert path',
      out.length === 2 && out[0].ts < out[1].ts);
    ok('carryLots: each parcel keeps its parent lot date',
      out.length === 2 && out[0].ts === src[0].ts && out[1].ts === src[1].ts);

    // Whole share counts: every qty column on the register is formatted INT, so 166.667 would
    // PRINT as 167 and three of them would foot to 501 under a subtotal of 500.
    const thirds = carryLots(
      [{ ts: 1, qty: 1000, cost: 1 }, { ts: 2, qty: 1000, cost: 1 }, { ts: 3, qty: 1000, cost: 1 }],
      500, 999, 0);
    ok('carryLots: integer sharesIn yields whole shares', thirds.every((o) => Number.isInteger(o.qty)),
      JSON.stringify(thirds.map((o) => o.qty)));
    eq('carryLots: ...that still sum to sharesIn', thirds.reduce((a, b) => a + b.qty, 0), 500);
    eq('carryLots: ...and costs that still sum exactly', thirds.reduce((a, b) => a + b.cost, 0), 999);

    // NOTHING TO INHERIT FROM. Corporate actions key on NAME only, so an unmatched parent, or a
    // parent sold out before the action, is reachable - and must not delete the received shares.
    const none = carryLots([], 300, 7000, 12345);
    eq('carryLots: empty parent falls back to ONE parcel', none.length, 1);
    eq('carryLots: ...at the action date', none[0]?.ts, 12345);
    eq('carryLots: ...keeping every share', none[0]?.qty, 300);
    eq('carryLots: ...and the whole cost, never dropped', none[0]?.cost, 7000);
    const sold = carryLots([{ ts: 1, qty: 0, cost: 0 }], 300, 7000, 999);
    eq('carryLots: a fully-sold parent is the same fallback', sold[0]?.ts, 999);
  }

  // ── Fixture H. The REAL ledger shape: True Entry has NO ISIN column ─────────
  //
  // Every other fixture in this file feeds a True Entry whose header carries "ISIN".
  // The REAL one does not - `manualTrades.ts` DEFAULT_HEADER and App.tsx both write
  // `Trade Date | Stock Name | Transaction Type | ...`, and the reader asks for it as
  // `ci("ISIN", -1)`. So every assertion above exercises the ISIN-FIRST branch of
  // lookupScrip while production runs the NAME-ONLY one. That is the exact shape of a
  // suite that stays green while the app fails, so the flag is pinned here on the real
  // header, with the owner's own scrip-master row and his own figures.
  {
    const REAL_TE_HEADER = [
      'Trade Date', 'Stock Name', 'Transaction Type', 'Number of Shares', 'Avg Price',
      'Total Amount (Turnover)', 'Total Amount with Expense (Incl STT)', 'Trade Class', 'Notes',
      'Total Brokerage', 'STT', 'IGST', 'Exchange Turnover Charges', 'Stamp Duty',
      'SEBI Turnover Fees', 'IPF Charges', 'Demat Charges',
    ];
    ok('the real ledger header genuinely carries no ISIN column',
      REAL_TE_HEADER.indexOf('ISIN') < 0);
    ok('...unlike the header every other fixture here uses', TE_HEADER.indexOf('ISIN') >= 0);

    const ETF = 'ADITYA BIRLA Sun ETF';
    const OWNER_MASTER = [
      ['ISIN', 'Security Name', 'BSE', 'NSE', 'Alias name', 'Tally Name', 'Price Exception', 'STT Removed'],
      ['INF209KB19F6', ETF, '', '', 'ADITYA BIRLA', '', '', 'x'],
      ['INE674K01013', 'ADITYA BIRLA CAPITAL LIMITED', 'ABCAPITAL | 540691', 'ABCAPITAL', '', '', '', ''],
      ['INE388Y01029', 'ADITYA BIRLA SUN LIFE AMC LIMITED', 'ABSLAMC | 543374', 'ABSLAMC', '', '', '', ''],
    ];
    // The owner's actual trades, to the paise. STT is 0.1% of turnover on both sides.
    const teNoIsin = (d: [number, number, number], type: 'Buy' | 'Sell',
                      qty: number, price: number, brok: number, stt: number) => [
      serial(...d), ETF, type, qty, price, qty * price,
      type === 'Buy' ? qty * price + brok + stt : qty * price - brok - stt,
      'Delivery', '', brok, stt, 0, 0, 0, 0, 0, 0,
    ];
    const FIXTURE_H = [
      REAL_TE_HEADER,
      teNoIsin([2025, 6, 6], 'Buy', 50000, 106.62, 2000, 5331.00),
      teNoIsin([2025, 7, 21], 'Sell', 30355, 113.902127, 1517.75, 3457.50),
      teNoIsin([2025, 7, 24], 'Sell', 19645, 115.064548, 982.25, 2260.44),
    ];

    install(FIXTURE_H);
    g.__ranges[`${SCRIP_MASTER_SPREADSHEET_ID}::'${MASTER_TAB}'!A1:Z50000`] = OWNER_MASTER;
    // Reaching the next line at all means the conservation guard did NOT fire: the emission
    // and `expect` agreed about the suppressed STT on the name-only path too.
    const resH = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    const tabH = written(CG_TAB);
    ok('name-only path: the register writes', !!tabH);

    const sttColH = (() => {
      for (const r of tabH || []) { const i = r.indexOf('STT'); if (i >= 0) return i; }
      return -1;
    })();
    ok('name-only path: the tab has an STT column', sttColH >= 0);

    const sttCells = (tabH || [])
      .map((r) => r[sttColH])
      .filter((v) => typeof v === 'number' && v !== 0);
    eq('name-only path: NO non-zero STT cell survives anywhere on the tab', sttCells.length, 0);

    eq('name-only path: the master flag is seen', resH.sttFlaggedInMaster, 1);
    ok('name-only path: the ETF is reported suppressed',
      resH.sttSuppressed.length === 1 && /ADITYA/i.test(resH.sttSuppressed[0]),
      JSON.stringify(resH.sttSuppressed));
    eq('name-only path: the scrip resolved (nothing left unresolved)', resH.unresolved.length, 0);

    // And the control: same ledger, same everything, flag cleared -> STT comes back.
    const CLEARED = OWNER_MASTER.map((r, i) => (i === 1 ? [...r.slice(0, 7), ''] : r));
    install(FIXTURE_H);
    g.__ranges[`${SCRIP_MASTER_SPREADSHEET_ID}::'${MASTER_TAB}'!A1:Z50000`] = CLEARED;
    const resH2 = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    const tabH2 = written(CG_TAB);
    const sttCells2 = (tabH2 || [])
      .map((r) => r[sttColH])
      .filter((v) => typeof v === 'number' && v !== 0);
    eq('control: with the flag cleared the master reports none flagged', resH2.sttFlaggedInMaster, 0);
    ok('control: with the flag cleared STT IS present on the tab', sttCells2.length > 0,
      `found ${sttCells2.length} non-zero STT cells`);
  }

  // ── I. The sheet-WRITING engines must read the master FORCED ─────────────────
  //
  // The master carries hand-maintained classification - the asset-class tabs, "Price Exception",
  // "STT Removed", aliases - and the owner's workflow is literally "edit the sheet, click the
  // button". `loadScripMaster` caches for 90s and the read-only hot paths keep that cache warm,
  // so an unforced read inside a write action returns the master AS IT WAS BEFORE THE EDIT and
  // writes a tab that ignores it. That is indistinguishable from the feature being broken, and
  // it is how the first "STT Removed" run came out with STT still on the tab.
  //
  // The inverse matters just as much: forcing a READ-ONLY hot path re-opens the read-quota
  // problem, so those are asserted to stay on the cache.
  {
    const fs = await import('node:fs');
    // Comments stripped first - the rule is stated in a comment beside each call site, so a
    // naive scan reports its own documentation.
    const decomment = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');

    const bodyOf = (src: string, sig: string): string => {
      const i = src.indexOf(sig);
      if (i < 0) return '';
      const end = src.indexOf('\n}', i);
      return src.slice(i, end < 0 ? src.length : end);
    };

    const trxSrc = decomment(fs.readFileSync('src/lib/trxRegister.ts', 'utf8'));
    const hcSrc = decomment(fs.readFileSync('src/lib/holdingsCalc.ts', 'utf8'));

    const CALL = /loadScripMaster\(SCRIP_MASTER_SPREADSHEET_ID([^)]*)\)/g;
    const forcedIn = (body: string) => {
      const found = [...body.matchAll(CALL)];
      return { n: found.length, allForced: found.length > 0 && found.every((m) => /force:\s*true/.test(m[1])) };
    };

    const WRITERS: Array<[string, string, string]> = [
      ['generateTrxRegister', trxSrc, 'export async function generateTrxRegister('],
      ['rebuildHoldingTab', hcSrc, 'export async function rebuildHoldingTab('],
      ['syncCapitalGains', hcSrc, 'export async function syncCapitalGains('],
    ];
    for (const [name, src, sig] of WRITERS) {
      const body = bodyOf(src, sig);
      ok(`${name}: found in source`, body.length > 0);
      const r = forcedIn(body);
      ok(`${name}: loads the master exactly once`, r.n === 1, `found ${r.n}`);
      ok(`${name}: forces it - a 90s-stale master would write the tab from PRE-EDIT data`, r.allForced);
    }

    // Read-only hot paths stay cached: these run per portfolio over 13 spreadsheets, and
    // forcing them is the read-quota doom loop all over again.
    const READERS: Array<[string, string]> = [
      ['computeAum', 'export async function computeAum('],
      ['computeIndustryAllocation', 'export async function computeIndustryAllocation('],
      ['computeHoldingsAsOf', 'export async function computeHoldingsAsOf('],
    ];
    for (const [name, sig] of READERS) {
      const body = bodyOf(hcSrc, sig);
      ok(`${name}: found in source`, body.length > 0);
      ok(`${name}: does NOT force - read-only hot path, must keep the 90s cache`,
        [...body.matchAll(CALL)].every((m) => !/force:\s*true/.test(m[1])));
    }
  }

  // ── FIXTURE L — the FY-end holding statement, split into three tabs ─────────
  //
  // One scrip per class, with DISJOINT closing amounts so a leak names its own source:
  //   ALPHA  listed  1,000 @ 100   = 100,000
  //   ZENITH PE        300 @ 700   = 210,000
  //   HELION AIF        50 @ 1,000 =  50,000
  //
  // The load-bearing assertion is the last group: AIF is on Combined and nowhere else, so
  // Equity + PE (310,000) does NOT foot to Combined (360,000). That is the owner's decision,
  // taken with the consequence stated - so what is tested is that the 50,000 difference is
  // PRINTED on the tab rather than left to be discovered inside a filed document.
  {
    const PE_ROWS = [['Company', 'ISIN', 'PAN', 'Face Value', 'Type Of Company'],
                     ['ZENITH GROWTH PARTNERS', 'INE700A01015', 'AAAPZ1234C', 10, 'Private Limited']];
    const AIF_ROWS_L = [['Company', 'ISIN'], ['HELION VENTURES FUND II', 'INE500A01019']];
    const FIXTURE_L: any[][] = [
      TE_HEADER,
      te([2025, 6, 10], 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', 'Buy', 1000, 100),
      te([2025, 7, 15], 'ZENITH GROWTH PARTNERS', 'INE700A01015', 'Buy', 300, 700),
      te([2025, 8, 20], 'HELION VENTURES FUND II', 'INE500A01019', 'Buy', 50, 1000),
    ];

    install(FIXTURE_L, [], [], AIF_ROWS_L, [], [], PE_ROWS);
    const res = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');

    const EQ_TAB = `Holding Equity+Intraday as on 31st March ${FY + 1}`;
    const PE_TAB = `Holding Private Equity Only as on 31st March ${FY + 1}`;
    const CMB_TAB = `Holding Combined as on 31st March ${FY + 1}`;
    const eqH = written(EQ_TAB), peH = written(PE_TAB), cmbH = written(CMB_TAB);

    ok('L: the Equity+Intraday holding tab is written', !!eqH, `tabs: ${tabsWritten().join(', ')}`);
    ok('L: the Private Equity Only holding tab is written', !!peH);
    ok('L: the Combined holding tab is written', !!cmbH);
    // The old commingled name must be GONE, not sitting beside the new three carrying last
    // run's numbers under a heading that still looks current.
    ok('L: the legacy single holding tab is no longer written',
      !written(`Holding as on 31st March ${FY + 1}`));

    // Each scrip on exactly the tabs it belongs on.
    ok('L: listed ALPHA is on the Equity tab', holdHas(eqH, 'ALPHA INDUSTRIES LIMITED'));
    ok('L: ...and on Combined', holdHas(cmbH, 'ALPHA INDUSTRIES LIMITED'));
    ok('L: ...and NOT on the PE tab', !holdHas(peH, 'ALPHA INDUSTRIES LIMITED'));
    ok('L: PE ZENITH is on the PE tab', holdHas(peH, 'ZENITH GROWTH PARTNERS'));
    ok('L: ...and on Combined', holdHas(cmbH, 'ZENITH GROWTH PARTNERS'));
    ok('L: ...and NOT on the Equity tab', !holdHas(eqH, 'ZENITH GROWTH PARTNERS'));
    ok('L: AIF HELION is on Combined', holdHas(cmbH, 'HELION VENTURES FUND II'));
    ok('L: ...and on NEITHER of the other two',
      !holdHas(eqH, 'HELION VENTURES FUND II') && !holdHas(peH, 'HELION VENTURES FUND II'));

    // Grand totals. Charge-free, like the Capital Gains tab's CLOSING.
    near('L: Equity tab total is the listed holding alone', holdTotal(eqH), 100000);
    near('L: PE tab total is the PE holding alone', holdTotal(peH), 210000);
    near('L: Combined total is every class', holdTotal(cmbH), 360000);

    // The shortfall, and the line that stops it being silent.
    near('L: Equity + PE falls short of Combined by exactly the AIF holding',
      holdTotal(cmbH) - (holdTotal(eqH) + holdTotal(peH)), 50000);
    const note = (cmbH || []).map(r => (r[1] || '').toString()).find(t => /appear on NO other holding tab/i.test(t)) || '';
    ok('L: Combined PRINTS the shortfall rather than leaving it to be discovered', !!note, 'no note found');
    ok('L: ...and the note names the class and the count', /\b1 holding\(s\) in AIF\b/.test(note), `note: ${note}`);
    ok('L: the two partial tabs carry no such note',
      !(eqH || []).some(r => /appear on NO other holding tab/i.test((r[1] || '').toString()))
      && !(peH || []).some(r => /appear on NO other holding tab/i.test((r[1] || '').toString())));


    // ── The company columns, on the PE statement only ──
    // PAN, Face Value and Type Of Company come off the Private Equities tab of the scrip
    // master and belong beside the company on a filed statement. The equity and combined tabs
    // keep their old geometry: those columns would be blank for every listed scrip, which is
    // noise in a tax document, and they would shift every index the paint pass uses.
    const HDR = (tab: any[][] | undefined) => (tab || [])[2] || [];
    eq('L: the PE statement carries the company columns right after SCRIPT NAME',
      HDR(peH).slice(1, 6), ['SCRIPT NAME', 'PAN', 'FACE VALUE', 'TYPE OF COMPANY', 'DATE']);
    for (const [label, col] of [['PAN', 'PAN'], ['FACE VALUE', 'FACE VALUE'], ['TYPE OF COMPANY', 'TYPE OF COMPANY']] as const) {
      eq(`L: the equity statement has no ${label} column`, HDR(eqH).indexOf(col), -1);
      eq(`L: nor does the combined one (${label})`, HDR(cmbH).indexOf(col), -1);
    }
    // On the scrip's own identity row, not repeated down its per-date lot rows.
    {
      const nameRow = (peH || []).find(r => (r[1] || '').toString().trim() === 'ZENITH GROWTH PARTNERS') || [];
      eq('L: PAN sits on the company row', nameRow[2], 'AAAPZ1234C');
      eq('L: ...face value beside it, as a NUMBER', nameRow[3], 10);
      eq('L: ...and the company type as typed', nameRow[4], 'Private Limited');
      const lotRows = (peH || []).filter(r => (r[1] || '').toString().trim() === 'CLOSING');
      ok('L: none of the three is repeated onto the lot rows',
        lotRows.length > 0 && lotRows.every(r => !r[2] && !r[3] && !r[4]));
    }
    // Geometry follows the header: with three columns inserted, AMOUNT moves from F to I.
    eq('L: every column after them shifted by three', HDR(peH).indexOf('AMOUNT'), 8);
    eq('L: ...and the equity tab is unshifted', HDR(eqH).indexOf('AMOUNT'), 5);
    near('L: the PE total is still read from the shifted AMOUNT column', holdTotal(peH), 210000);

    // The result must name all three, or the UI tooltip reports a run that half happened.
    eq('L: the result carries all three tab names',
      [res.holdingTabs?.equity, res.holdingTabs?.pe, res.holdingTabs?.combined], [EQ_TAB, PE_TAB, CMB_TAB]);
    eq('L: holdingTabName stays the COMPLETE statement', res.holdingTabName, CMB_TAB);
  }

  // ── FIXTURE L2 — a book with no private equity at all ───────────────────────
  // All three tabs are still written. A tab skipped because its class is empty keeps LAST
  // year's figures under THIS year's heading - the same reason the intraday tab is always
  // written - and an empty tab must SAY it is empty rather than show bare headers.
  {
    install(FIXTURE_A, OPENING_A);
    await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    const peH = written(`Holding Private Equity Only as on 31st March ${FY + 1}`);
    const eqH = written(`Holding Equity+Intraday as on 31st March ${FY + 1}`);
    const cmbH = written(`Holding Combined as on 31st March ${FY + 1}`);
    ok('L2: the PE holding tab is written even with no PE in the book', !!peH);
    ok('L2: ...and says so in words',
      (peH || []).some(r => /Nothing held under this heading/i.test((r[1] || '').toString())));
    near('L2: ...and totals zero', holdTotal(peH), 0);
    // With nothing but listed stock the two tabs are the same statement.
    near('L2: Equity equals Combined when the book is listed-only', holdTotal(eqH), holdTotal(cmbH));
    ok('L2: ...and Combined carries no shortfall note',
      !(cmbH || []).some(r => /appear on NO other holding tab/i.test((r[1] || '').toString())));
  }

  // ── FIXTURE L3 — the legacy single holding tab is RENAMED, not orphaned ──
  // Leaving "Holding as on 31st March 2026" standing beside the new three is last run's
  // commingled numbers under a heading that still looks current - a stale tax document that
  // nothing on screen distinguishes from a fresh one.
  {
    install(FIXTURE_A, OPENING_A);
    g.__sheetTabs[PORTFOLIO] = ['True Entry', 'Opening Holdings', 'Corporate Actions', `Holding as on 31st March ${FY + 1}`];
    await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    const renames = (g.__batched || [])
      .flatMap((b: any) => ((b.resource || {}).requests) || [])
      .filter((r: any) => r.updateSheetProperties?.properties?.title === `Holding Combined as on 31st March ${FY + 1}`);
    eq('L3: the legacy holding tab is renamed exactly once', renames.length, 1);
    ok('L3: ...so no stale "Holding as on 31st March" tab is left behind',
      !(g.__sheetTabs[PORTFOLIO] || []).includes(`Holding as on 31st March ${FY + 1}`));
    ok('L3: ...and the renamed tab is the one written to',
      !!written(`Holding Combined as on 31st March ${FY + 1}`));
  }

  // ── FIXTURE M — the ITR unlisted-equity-shares schedule, end to end ─────────
  //
  // `tmp-itr.ts` covers the LAYOUT against the owner's filed return. What only this fixture
  // can reach is the PLUMBING: which blocks the register hands the builder, and which it
  // must not. Four companies, each here for a different reason:
  //
  //   ZENITH  PE   opening 500 @ 200, buys 300 @ 700 and 200 @ 900, sells 600 @ 1,000
  //                -> TWO acquisition rows, and a sale that straddles the LT/ST boundary
  //                   (500 pre-FY shares long-term + 100 of the July buy short-term), so
  //                   ONE sale arrives as TWO parcels and has to be re-aggregated
  //   ORION   PE   opening 1,000 @ 50, sells ALL of it
  //                -> fully exited, and must STILL be on the schedule
  //   VERTEX  PE   buys 100 @ 500 and sells 100 @ 600 ON ONE DAY
  //                -> an intraday round trip, which lands in `intraBlocks` and NOT in `blocks`
  //   ALPHA / HELION  listed and AIF -> neither belongs on an unlisted-EQUITY-SHARES schedule
  {
    const PE_ROWS_M = [
      ['Company', 'ISIN', 'PAN', 'Face Value', 'Type Of Company'],
      ['ZENITH GROWTH PARTNERS', 'INE700A01015', 'AAAPZ1234C', 10, 'Domestic'],
      ['ORION UNLISTED PVT LTD', 'INE701A01013', 'AABCO9999D', 100, 'Domestic'],
      ['VERTEX HOLDINGS PVT LTD', 'INE702A01011', 'AACCV1111E', 10, 'Domestic'],
    ];
    const AIF_ROWS_M = [['Company', 'ISIN'], ['HELION VENTURES FUND II', 'INE500A01019']];
    const OPENING_M: any[][] = [
      ['Security', 'ISIN', 'Acquisition Date', 'Quantity', 'Cost Per Share', 'Total Cost', '', ''],
      ['ZENITH GROWTH PARTNER', 'INE700A01015', serial(2023, 5, 4), 500, 200, 100000, '', ''],
      ['ORION UNLISTED PVT LTD', 'INE701A01013', serial(2024, 2, 1), 1000, 50, 50000, '', ''],
    ];
    const FIXTURE_M: any[][] = [
      TE_HEADER,
      te([2025, 7, 15], 'ZENITH GROWTH PARTNER', 'INE700A01015', 'Buy', 300, 700),
      te([2025, 11, 20], 'ZENITH GROWTH PARTNER', 'INE700A01015', 'Buy', 200, 900),
      te([2026, 1, 10], 'ZENITH GROWTH PARTNER', 'INE700A01015', 'Sell', 600, 1000),
      te([2025, 8, 5], 'ORION UNLISTED PVT LTD', 'INE701A01013', 'Sell', 1000, 80),
      te([2025, 9, 12], 'VERTEX HOLDINGS PVT LTD', 'INE702A01011', 'Buy', 100, 500),
      te([2025, 9, 12], 'VERTEX HOLDINGS PVT LTD', 'INE702A01011', 'Sell', 100, 600),
      te([2025, 6, 10], 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', 'Buy', 1000, 100),
      te([2025, 8, 20], 'HELION VENTURES FUND II', 'INE500A01019', 'Buy', 50, 1000),
    ];

    install(FIXTURE_M, OPENING_M, [], AIF_ROWS_M, [], [], PE_ROWS_M);
    const res = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');

    const ITR_TAB = `Unlisted Equity Shares for ${FY_LABEL}`;
    const itr = written(ITR_TAB);
    ok('M: the ITR schedule tab is written', !!itr, `tabs: ${tabsWritten().join(', ')}`);
    eq('M: ...and the result names it', res.itrUnlistedTab, ITR_TAB);

    // Read BY HEADER, never by position — the same rule the tab itself is written under, and
    // the one the holding-statement suite had to be corrected to follow.
    const hi = (itr || []).findIndex(r => (r[1] || '').toString().trim() === 'Name of company');
    const C = (name: string) => ((itr || [])[hi] || []).findIndex((c: any) => (c || '').toString().trim() === name);
    const rowsFor = (n: string) => (itr || []).slice(hi + 1)
      .filter(r => (r[C('Name of company')] || '').toString().trim() === n);
    const cell = (r: any[] | undefined, name: string) => (r || [])[C(name)];

    ok('M: the header row is present', hi >= 0);
    eq('M: header sits on sheet row 4', hi, 3);
    ok('M: every ITR column resolves by name',
      ['Sl. No.', 'Type of Company', 'PAN of Company', 'Opening Balance - No. of shares',
       'Shares acquired - Date of subscription/purchase', 'Shares transferred - Sale consideration',
       'Closing balance - Cost of acquisition'].every(n => C(n) >= 0));

    // Scope: unlisted EQUITY SHARES only.
    eq('M: three unlisted companies reach the schedule', res.itrCompanies, 3);
    eq('M: listed ALPHA is NOT on it', rowsFor('ALPHA INDUSTRIES LIMITED').length, 0);
    eq('M: the AIF fund is NOT on it', rowsFor('HELION VENTURES FUND II').length, 0);

    // ZENITH — two acquisitions, so two rows, with the opening and the transfer on the first.
    const z = rowsFor('ZENITH GROWTH PARTNERS');
    eq('M: ZENITH gets one row per acquisition', z.length, 2);
    // The ledger spells it 'ZENITH GROWTH PARTNER' — a truncated broker name, resolved to
    // the right company by ISIN. A filed return must carry the scrip master's canonical
    // spelling, never the longest thing a counterparty's paperwork happened to say.
    eq('M: the truncated LEDGER spelling is not what gets filed', rowsFor('ZENITH GROWTH PARTNER').length, 0);
    eq('M: ZENITH PAN', cell(z[0], 'PAN of Company'), 'AAAPZ1234C');
    eq('M: ZENITH type of company', cell(z[0], 'Type of Company'), 'Domestic');
    eq('M: ZENITH face value', cell(z[0], 'Shares acquired - Face value per share'), 10);
    eq('M: ZENITH opening qty', cell(z[0], 'Opening Balance - No. of shares'), 500);
    near('M: ZENITH opening cost', Number(cell(z[0], 'Opening Balance - Cost of acquisition')), 100000);
    eq('M: ZENITH r1 acquired', cell(z[0], 'Shares acquired - No. of shares'), 300);
    eq('M: ZENITH r1 date is dd/mm/yyyy TEXT', cell(z[0], 'Shares acquired - Date of subscription/purchase'), '15/07/2025');
    near('M: ZENITH r1 issue price is derived turnover/qty', Number(cell(z[0], 'Shares acquired - Issue price per share (fresh issue)')), 700);
    eq('M: ZENITH r2 acquired', cell(z[1], 'Shares acquired - No. of shares'), 200);
    eq('M: ZENITH r2 date', cell(z[1], 'Shares acquired - Date of subscription/purchase'), '20/11/2025');
    // The transfer rides the first row and the closing distributes across both.
    eq('M: ZENITH transfer is on the first row', cell(z[0], 'Shares transferred - No. of shares'), 600);
    // 600 shares across a long-term and a short-term parcel, re-aggregated into one figure.
    near('M: ZENITH consideration sums BOTH tax parcels', Number(cell(z[0], 'Shares transferred - Sale consideration')), 600000);
    eq('M: ZENITH r2 carries no transfer', cell(z[1], 'Shares transferred - No. of shares'), '');
    eq('M: ZENITH r1 closing qty (500 + 300 - 600)', cell(z[0], 'Closing balance - No. of shares'), 200);
    eq('M: ZENITH r2 closing qty', cell(z[1], 'Closing balance - No. of shares'), 200);
    // FIFO ate the opening first, then 100 of the July lot, so r1 keeps 200 @ 700.
    near('M: ZENITH r1 closing cost', Number(cell(z[0], 'Closing balance - Cost of acquisition')), 140000);
    near('M: ZENITH r2 closing cost', Number(cell(z[1], 'Closing balance - Cost of acquisition')), 180000);
    near('M: ZENITH closing sums to the FIFO position', 200 + 200, 400);

    // ORION — sold out during the year. `heldAll` / `heldPe` filter on `closing.length > 0`,
    // so sourcing the schedule from either would drop this company off a filed return.
    const o = rowsFor('ORION UNLISTED PVT LTD');
    eq('M: an exited company is STILL on the schedule', o.length, 1);
    eq('M: ORION opening qty', cell(o[0], 'Opening Balance - No. of shares'), 1000);
    eq('M: ORION transferred everything', cell(o[0], 'Shares transferred - No. of shares'), 1000);
    near('M: ORION consideration', Number(cell(o[0], 'Shares transferred - Sale consideration')), 80000);
    eq('M: ORION closing qty is BLANK, not 0', cell(o[0], 'Closing balance - No. of shares'), '');
    eq('M: ORION closing cost is BLANK, not 0.00', cell(o[0], 'Closing balance - Cost of acquisition'), '');
    eq('M: ORION made no acquisition, so no date', cell(o[0], 'Shares acquired - Date of subscription/purchase'), '');

    // VERTEX — the one the schedule could silently lose. The same-day matcher groups purely on
    // key|ts with no asset-class test and routes the matched quantity into `intraBlocks`, so a
    // builder reading `blocks` alone drops BOTH the acquisition and the transfer while opening
    // and closing stay untouched — the row still foots, with a year's activity missing from it.
    const v = rowsFor('VERTEX HOLDINGS PVT LTD');
    eq('M: a same-day round trip still reaches the schedule', v.length, 1);
    eq('M: VERTEX acquisition survives the intraday matcher', cell(v[0], 'Shares acquired - No. of shares'), 100);
    eq('M: VERTEX acquisition date', cell(v[0], 'Shares acquired - Date of subscription/purchase'), '12/09/2025');
    eq('M: VERTEX transfer survives it too', cell(v[0], 'Shares transferred - No. of shares'), 100);
    near('M: VERTEX consideration', Number(cell(v[0], 'Shares transferred - Sale consideration')), 60000);
    eq('M: VERTEX closes at nil, printed blank', cell(v[0], 'Closing balance - No. of shares'), '');

    // Sl. No. runs over ROWS, not companies — 2 + 1 + 1 = 4.
    const dataRowsM = (itr || []).slice(hi + 1).filter(r => Number(r[C('Sl. No.')]) > 0);
    eq('M: Sl. No. is a row counter', dataRowsM.map(r => r[C('Sl. No.')]), [1, 2, 3, 4]);

    // Diagnostics: every failure mode of this tab is invisible ON the tab.
    eq('M: nothing unfooted', res.itrUnfooted, []);
    eq('M: no PAN missing', res.itrMissingPan, []);

    // Dates are written RAW. Under USER_ENTERED, Sheets reparses 15/07/2025 as US mm-dd for
    // any day <= 12 and stores a swapped serial — 12/09/2025 would be filed as 9-Dec-2025.
    const upd = (g.__updated || []).filter((u: any) => (u.range || '').startsWith(`${ITR_TAB}!`));
    eq('M: the ITR tab is written RAW, never USER_ENTERED', upd.map((u: any) => u.valueInputOption), ['RAW']);

    // The banner rows are merged. `mergeCells` is issued nowhere else against the Sheets API
    // in this app, so nothing else would catch it being dropped.
    const reqs = (g.__batched || []).flatMap((b: any) => ((b.resource || {}).requests) || []);
    eq('M: both banner rows are merged', reqs.filter((r: any) => r.mergeCells).length, 2);
    eq('M: ...each unmerged first, so a re-run cannot reject the whole batch',
      reqs.filter((r: any) => r.unmergeCells).length, 2);
  }

  // ── Fixture N: AN UNLISTED COMPANY THAT LATER LISTS ───────────────────────────────────
  //
  // Reported 21-Sep-2026. Until then the remedy for a company that listed was to DELETE its
  // row from the Private Equities tab and add it to the listed master. `assetClass` is read as
  // current state by every engine, so that quietly rewrote every year already filed: the
  // company vanished off the `Unlisted Equity Shares` schedule, its holding moved to the equity
  // tab, its gains moved to the listed capital-gains tab, and — the one that costs money — its
  // long-term threshold dropped from 730 days to 365, turning a filed SHORT-term gain into a
  // LONG-term one with nothing on any tab to show it had happened.
  //
  // The row now STAYS on the tab and carries a `Listed From` date instead.
  //
  // One company, deliberately arranged so the right and wrong answers are DISJOINT: NEXUS is
  // held from 1-Jun-2024 and sold 1-Mar-2026, which is 638 days — comfortably inside the gap
  // between the listed threshold (365) and the unlisted one (730). Filed as an unlisted company
  // that is SHORT term; read as a listed one it is LONG term. No overlap, so neither reading
  // can pass for the other.
  {
    const PE_HDR_N = ['Company', 'ISIN', 'PAN', 'Face Value', 'Type Of Company', 'Listed From'];
    const peRowsN = (listedFrom: any) => [
      PE_HDR_N,
      ['NEXUS UNLISTED PVT LTD', 'INE710A01010', 'AAECN1234F', 10, 'Domestic', listedFrom],
    ];
    const OPENING_N: any[][] = [
      ['Security', 'ISIN', 'Acquisition Date', 'Quantity', 'Cost Per Share', 'Total Cost', '', ''],
      ['NEXUS UNLISTED PVT LTD', 'INE710A01010', serial(2024, 6, 1), 1000, 100, 100000, '', ''],
    ];
    // One sale, well after the FY opens, 638 days after the lot was acquired.
    const LEDGER_N: any[][] = [
      TE_HEADER,
      te([2026, 3, 1], 'NEXUS UNLISTED PVT LTD', 'INE710A01010', 'Sell', 400, 150),
    ];

    const PE_CG = `Private Equity Capital Gains for ${FY_LABEL}`;
    const ITR_N = `Unlisted Equity Shares for ${FY_LABEL}`;
    const EQ_HOLD = `Holding Equity+Intraday as on 31st March ${FY + 1}`;
    const PE_HOLD = `Holding Private Equity Only as on 31st March ${FY + 1}`;

    const snap = () => ({
      cgPe: JSON.stringify(written(PE_CG) || null),
      cgListed: JSON.stringify(written(CG_TAB) || null),
      itr: JSON.stringify(written(ITR_N) || null),
      holdPe: JSON.stringify(written(PE_HOLD) || null),
      holdEq: JSON.stringify(written(EQ_HOLD) || null),
    });
    // Grand-total P/L off whichever capital-gains tab the block landed on.
    const pl = (tab: any[][] | undefined) => {
      const col = (h: string) => { for (const r of tab || []) { const i = r.indexOf(h); if (i >= 0) return i; } return -1; };
      const g2 = (tab || []).find(r => String(r[1] ?? '') === 'GRAND TOTAL');
      const n = (v: any) => (typeof v === 'number' ? v : 0);
      return { st: n(g2?.[col('Short term')]), lt: n(g2?.[col('Long term')]) };
    };

    // ── N1. STILL UNLISTED — the baseline every later run is compared against ────────────
    install(LEDGER_N, OPENING_N, [], [], [], [], peRowsN(''));
    const resA = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    const A = snap();
    eq('N1: an unlisted sale at 638 days is SHORT term', pl(written(PE_CG)), { st: 20000, lt: 0 });
    ok('N1: ...on the PRIVATE EQUITY gains tab', !!written(PE_CG));
    ok('N1: ...and on the unlisted-shares schedule', (written(ITR_N) || []).some(r => /NEXUS/.test(String(r))));
    ok('N1: ...and on the PE holding tab', holdHas(written(PE_HOLD), 'NEXUS UNLISTED PVT LTD'));
    eq('N1: nothing to report — it has not listed', resA.listedDuringFy, []);

    // ── N2. THE WHOLE POINT: a listing in a LATER year cannot touch this one ─────────────
    // `Listed From` is 1-Sep-2030, years after this FY closes. Deliberately far future rather
    // than merely "after the FY": it keeps the run independent of the wall clock, so the
    // company is unlisted TODAY in both runs and the two are comparable byte for byte.
    install(LEDGER_N, OPENING_N, [], [], [], [], peRowsN(serial(2030, 9, 1)));
    const resB = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    const B = snap();
    eq('N2: the PE capital-gains tab is IDENTICAL', B.cgPe, A.cgPe);
    eq('N2: the ITR unlisted schedule is IDENTICAL', B.itr, A.itr);
    eq('N2: the PE holding statement is IDENTICAL', B.holdPe, A.holdPe);
    eq('N2: the equity holding statement is IDENTICAL', B.holdEq, A.holdEq);
    eq('N2: the listed capital-gains tab is IDENTICAL', B.cgListed, A.cgListed);
    eq('N2: ...and this FY reports no listing', resB.listedDuringFy, []);

    // ── N3. THE OLD REMEDY, for contrast — the row deleted off the tab ──────────────────
    // This is what the app used to advise, and it is the reason the column exists. The
    // assertions below are the SAME year, the SAME ledger, and every one of them differs.
    install(LEDGER_N, OPENING_N, [], [], [], [], []);
    await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    eq('N3: deleting the row refiles the gain as LONG term', pl(written(CG_TAB)), { st: 0, lt: 20000 });
    ok('N3: ...off the private-equity gains tab entirely', !written(PE_CG));
    ok('N3: ...off the unlisted-shares schedule', !(written(ITR_N) || []).some(r => /NEXUS/.test(String(r))));
    ok('N3: ...and onto the equity holding tab', holdHas(written(EQ_HOLD), 'NEXUS UNLISTED PVT LTD'));

    // ── N4. THE TRANSITION YEAR — two sales, one threshold each ─────────────────────────
    // Listed 1-Nov-2025, inside this FY. The pre-listing sale is an off-market transfer of an
    // unlisted share (730 days); the post-listing one is a transfer of a listed share (365),
    // and the holding period runs unbroken through the listing — the lot is still the one
    // acquired on 1-Jun-2024, because listing is not a reacquisition.
    //
    //   1-Oct-2025  200 @ 140   487 days   unlisted -> 730 -> SHORT   gain  8,000
    //   1-Mar-2026  400 @ 150   638 days   listed   -> 365 -> LONG    gain 20,000
    //
    // A single undated answer cannot produce this pair: it yields either 28,000 short or
    // 28,000 long. Both figures appear nowhere below.
    const LEDGER_N4: any[][] = [
      TE_HEADER,
      te([2025, 10, 1], 'NEXUS UNLISTED PVT LTD', 'INE710A01010', 'Sell', 200, 140),
      te([2026, 3, 1], 'NEXUS UNLISTED PVT LTD', 'INE710A01010', 'Sell', 400, 150),
    ];
    install(LEDGER_N4, OPENING_N, [], [], [], [], peRowsN(serial(2025, 11, 1)));
    const resD = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');

    eq('N4: the two sales are split 8,000 SHORT / 20,000 LONG by their OWN dates',
      pl(written(PE_CG)), { st: 8000, lt: 20000 });
    ok('N4: the block is NOT halved across two tabs', !written(CG_TAB)
      || !(written(CG_TAB) || []).some(r => /NEXUS/.test(String(r))));

    // The block is the atom, so the whole year sits on the tab the YEAR belongs to.
    ok('N4: the year sits on the unlisted gains tab (unlisted at some point in it)', !!written(PE_CG));
    // ...and the mid-year boundary is disclosed IN the section, because the tab heading is
    // annual and this fact is not. A preparer splitting s.112A from off-market needs the date.
    // dd.mm.yyyy - the register's own `fmtDate`, which uses DOTS. Not `formatDMY`'s slashes:
    // that one is the on-screen convention and these tabs are written, not rendered.
    ok('N4: ...with a LISTED FROM note beside the trades it separates',
      (written(PE_CG) || []).some(r => /LISTED FROM 01\.11\.2025/.test(String(r))));

    // A holding statement states ONE date, so at 31-March this is listed equity - even though
    // its gains for the same year are on the unlisted tab. The two answer different questions.
    ok('N4: at 31-March it is on the EQUITY holding tab', holdHas(written(EQ_HOLD), 'NEXUS UNLISTED PVT LTD'));
    ok('N4: ...and not on the PE holding tab', !holdHas(written(PE_HOLD), 'NEXUS UNLISTED PVT LTD'));

    // "held at any time during the previous year" is the schedule's own test, and it was
    // unlisted for seven months of this one. Owner's decision 21-Sep-2026: the REAL closing
    // balance, not a blank - a zero closing would read as a disposal.
    const itrN = written(ITR_N);
    const hiN = (itrN || []).findIndex(r => (r[1] || '').toString().trim() === 'Name of company');
    const cN = (h: string) => ((itrN || [])[hiN] || []).findIndex((c: any) => (c || '').toString().trim() === h);
    const rowN = (itrN || []).slice(hiN + 1).find(r => /NEXUS/.test(String(r[cN('Name of company')])));
    ok('N4: it is STILL on the unlisted-shares schedule in its listing year', !!rowN);
    eq('N4: ...carrying its real closing balance, not a blank',
      rowN?.[cN('Closing balance - No. of shares')], 400);

    ok('N4: the register NAMES the company that listed this year',
      (resD.listedDuringFy || []).some(n => /NEXUS/.test(n)), JSON.stringify(resD.listedDuringFy));

    // ── N5. The year AFTER listing is an ordinary listed year, with nothing hand-excluded ─
    // Same company, same opening lot, run for the FY that opens after the listing. `Listed
    // From` is now at or before FY start, so every dated question answers "listed" by itself.
    //
    // The FY26-27 sale is placed to keep the two readings DISJOINT here too: 1-Jun-2024 to
    // 1-May-2026 is 699 days, which is past the listed threshold (365) and short of the
    // unlisted one (730). Filed correctly it is LONG term on the listed tab; read as still
    // unlisted it would be SHORT term on a private-equity tab that should no longer exist.
    const LEDGER_N5: any[][] = [
      ...LEDGER_N4,
      te([2026, 5, 1], 'NEXUS UNLISTED PVT LTD', 'INE710A01010', 'Sell', 100, 200),
    ];
    install(LEDGER_N5, OPENING_N, [], [], [], [], peRowsN(serial(2025, 11, 1)));
    const resE = await generateTrxRegister(PORTFOLIO, FY + 1, 'Test Portfolio');
    const NEXT = fyLabelOfTest(FY + 1);

    eq('N5: the post-listing sale is LONG term at 699 days, on the LISTED gains tab',
      pl(written(`Capital Gains for ${NEXT}`)), { st: 0, lt: 10000 });
    ok('N5: ...and no private-equity gains tab is written that year at all',
      !written(`Private Equity Capital Gains for ${NEXT}`));
    ok('N5: gone from the unlisted schedule the following year',
      !(written(`Unlisted Equity Shares for ${NEXT}`) || []).some(r => /NEXUS/.test(String(r))));
    ok('N5: ...and off the PE holding tab',
      !holdHas(written(`Holding Private Equity Only as on 31st March ${FY + 2}`), 'NEXUS UNLISTED PVT LTD'));
    eq('N5: ...and that year reports no listing of its own', resE.listedDuringFy, []);
  }

  // ── FIXTURE P — a RESTATEMENT on a period tab, which is the subtle half of dropping
  //              purchases from those tabs ────────────────────────────────────────────
  //
  // `restateCols` decides which column family a SPLIT or corp-action restatement is printed in
  // by asking `blk.purchases.length`. That is why purchases are dropped on the CLONE rather
  // than gated inside `emitTab` on `L.id` the way CLOSING is: gate the emission alone and the
  // block still answers "I have purchases", so the SPLIT line is filed under the PURCHASE
  // column family on a tab that shows no purchase rows at all.
  //
  // No other fixture can see this - none of them puts a split on a period tab beside an in-FY
  // purchase - so without this one the `purchaseCells === 0` assertions above test green while
  // the restatement half is never executed, and a future tidy-up to an `L.id` gate ships.
  {
    const HDR_P = [...TE_HEADER, 'Ratio'];
    const rowP = (d: [number, number, number], type: string, qty: number, price: number, ratio = '') => [
      serial(...d), 'DELTA POWER LIMITED', 'INE004A01012', type, qty, price,
      qty * price, type === 'Buy' ? qty * price + 10 : qty * price - 10, 'Delivery', '',
      10, 5, 2, 1, 0.5, 0.1, 0.05, 0, ratio,
    ];
    // Bought 1-May-2025, split 2:1 in August, all 200 sold 1-Mar-2026 - 304 days, so SHORT
    // term, and the whole block lands on the short-term tab.
    install([
      HDR_P,
      rowP([2025, 5, 1], 'Buy', 100, 100),
      rowP([2025, 8, 1], 'Split', 100, 0, '2:1'),
      rowP([2026, 3, 1], 'Sell', 200, 80),
    ]);
    await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    const pMain = written(`Capital Gains for ${FY_LABEL}`);
    const pSt = written(`Short Term Capital Gains for ${FY_LABEL}`);
    const flatP = (t: any[][] | undefined) => (t || []).map(r => r.join('|'));

    const P_FAM2 = [6, 7, 8, 9];
    const hEnd = (t: any[][] | undefined) => {
      let i = -1;
      (t || []).forEach((r, k) => {
        if (r.some((c: any) => ['SCRIPT NAME', 'PURCHASE', 'IPF'].includes(`${c}`.trim()))) i = k;
      });
      return i;
    };
    const famCells = (t: any[][] | undefined) =>
      (t || []).slice(hEnd(t) + 1).filter(r => P_FAM2.some(c => `${r[c] ?? ''}`.trim() !== '')).length;
    /** Rows carrying data in the OPENING family (C-F), past the headers. */
    const openCells = (t: any[][] | undefined) =>
      (t || []).slice(hEnd(t) + 1).filter(r => [2, 3, 4, 5].some(c => `${r[c] ?? ''}`.trim() !== '')).length;

    ok('P: the short-term tab carries the block', flatP(pSt).some(r => r.includes('DELTA POWER LIMITED')));
    ok('P: the main tab files the SPLIT in the PURCHASE family', famCells(pMain) > 0,
      'the main tab HAS purchases, so restateCols must use D-G there');

    // P1: the whole purchase WAS sold, so it is on the period tab in full - at the quantity
    // BOUGHT (100), not the 200 the post-split lot became. The split rescales the lot; it does
    // not rewrite the contract note. `Math.min(avail, p.qty)` is what caps it.
    ok('P: the funding purchase is on the period tab', famCells(pSt) > 0);
    eq('P: ...at the quantity BOUGHT, not the post-split lot size',
      pSt!.slice(hEnd(pSt) + 1)
        // The SPLIT restatement sits in this same column family on THIS tab (the block has
        // purchases here, so restateCols correctly uses D-G), and it carries the RESTATED
        // holding of 200. Summing the column blind counts it as a second purchase.
        .filter(r => `${r[1] ?? ''}`.trim() !== 'SPLIT')
        .reduce((sum, r) => sum + (typeof r[7] === 'number' ? r[7] : 0), 0), 100);
    ok('P: the SPLIT line survives', flatP(pSt).some(r => r.includes('SPLIT')));

    // And the arithmetic the tab exists for is untouched: 200 sold at 80 is 16,000 against a
    // 10,000 cost, so 6,000 short-term - a figure neither the split nor the dropped purchase
    // rows may move.
    const plP = (t: any[][] | undefined) => {
      const gi = (t || []).findIndex(r => r.some((c: any) => `${c}`.trim() === 'GRAND TOTAL'));
      return gi < 0 ? null : ((t || [])[gi].find((c: any) => typeof c === 'number' && c !== 0) ?? null);
    };
    near('P: the short-term gain is unmoved by any of this', plP(pSt) as number, 6000);

    // ── P2 — THE CLONE-VS-GATE PROBE TARGET, and the only shape that can see it ─────────
    //
    // A block that HAS an in-FY purchase whose period sales consumed NONE of it: opening stock
    // bought 1-Feb-2025 (still SHORT when sold in September), an untouched in-FY buy in July,
    // and a 2:1 split over both. FIFO eats the opening lot, so `matchedPurchases` returns [].
    //
    // `restateCols` must then follow THIS TAB's rows and file the SPLIT in the OPENING family.
    // Gate the purchase loop on `L.id` instead of rewriting the clone and the block still
    // answers "I have purchases" with the July buy, so the split lands in the PURCHASE family
    // on a tab showing no purchase row - right charges, wrong layout, and no arithmetic guard
    // anywhere can see it.
    install([
      HDR_P,
      rowP([2025, 7, 1], 'Buy', 100, 200),
      rowP([2025, 8, 1], 'Split', 200, 0, '2:1'),
      rowP([2025, 9, 15], 'Sell', 200, 80),
    ], [
      ['Security', 'ISIN', 'Acquisition Date', 'Quantity', 'Cost Per Share', 'Total Cost', '', ''],
      ['DELTA POWER LIMITED', 'INE004A01012', serial(2025, 2, 1), 100, 100, 10000, '', ''],
    ]);
    await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    const p2St = written(`Short Term Capital Gains for ${FY_LABEL}`);
    const p2Main = written(`Capital Gains for ${FY_LABEL}`);

    ok('P2: the short-term tab carries the block', flatP(p2St).some(r => r.includes('DELTA POWER LIMITED')));
    ok('P2: the main tab still files its July purchase', famCells(p2Main) > 0);
    eq('P2: the period tab shows NO purchase - the sale came out of opening stock', famCells(p2St), 0);
    ok('P2: ...and the SPLIT is still printed', flatP(p2St).some(r => r.includes('SPLIT')));
    ok('P2: ...in the OPENING family, because restateCols follows THIS tab', openCells(p2St) > 0);

    // ── P3 — TWO PURCHASES ON ONE DATE, which is what the `want` drawdown is for ────────
    //
    // `matchedPurchases` keys on `buyTs` alone, so two buys on 1-Jul share one bucket of
    // matched quantity. It must be DRAWN DOWN as each purchase takes its share: 200 sold means
    // 200 shown, out of the first lot FIFO ate. Leave the `want.set(...)` out and both rows
    // claim the full 200 - the page then shows 400 shares bought to fund a 200-share sale.
    //
    // The CEILING arm cannot catch this (12.43 of claimed charges against 37.30 filed is still
    // under the ceiling), which is exactly why the quantity is asserted here instead.
    install([
      HDR_P,
      rowP([2025, 7, 1], 'Buy', 300, 100),
      rowP([2025, 7, 1], 'Buy', 200, 100),
      rowP([2025, 9, 15], 'Sell', 200, 120),
    ]);
    await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    const p3St = written(`Short Term Capital Gains for ${FY_LABEL}`);
    const p3Qty = (p3St || []).slice(hEnd(p3St) + 1)
      .reduce((sum, r) => sum + (typeof r[7] === 'number' ? r[7] : 0), 0);
    eq('P3: two same-day buys fund a 200-share sale with 200 shares, not 400', p3Qty, 200);
    eq('P3: ...and the main tab still shows everything it bought',
      (p3Main => (p3Main || []).slice(hEnd(p3Main) + 1)
        .reduce((sum, r) => sum + (typeof r[7] === 'number' ? r[7] : 0), 0))(
        written(`Capital Gains for ${FY_LABEL}`)), 500);

    // -- FIXTURE Q - THE ACQUISITION FOLD-IN, built for the two probes nothing else reached --
    //
    // Three separate things have to be true at once before the carried-in half of
    // `matchedAcquisitions` is exercised at all, and fixture A has none of them:
    //
    //   1. AN OPENING LOT THAT CARRIES CHARGES. The `Opening Holdings` seed sets
    //      ZERO_CHARGES, so every fixture seeded that way makes the guard "a B/F row carries
    //      no charges" trivially true - a probe that let those rows INHERIT the lot charges
    //      came back SILENT. A pre-FY row in True Entry is replayed like any other, so its
    //      lot reaches the opening snapshot with its REAL brokerage and STT on it. That is
    //      also the production shape: the ledger is not FY-scoped, the register is.
    //
    //   2. MORE MATCHED QUANTITY AT ONE DATE THAN WAS BOUGHT THAT DATE. A 2:1 split doubles
    //      the lot while `b.purchases` still records the 100 the contract note says, so the
    //      01-Jul claim runs out mid-way.
    //
    //   3. TWO MATCHED LOTS SHARING THAT DATE, which takes two sales. With one, the drawdown
    //      and no drawdown give the same answer - which is exactly why that probe was silent.
    //
    // 1-Feb-2025 buy 200 @ 100 (pre-FY, charged) . 1-Jul buy 100 @ 200 . 2:1 split 1-Aug, so
    // the lots become 400 @ 50 and 200 @ 100 . sell 500 on 1-Sep (400 + 100) . sell 100 on
    // 1-Oct. Every parcel is SHORT term, so the whole block lands on one tab.
    //
    // Right and wrong answers are DISJOINT: 600 acquisition shares against 500, and without
    // the drawdown the quantity invariant throws and NO REGISTER WRITES AT ALL.
    install([
      HDR_P,
      rowP([2025, 2, 1], 'Buy', 200, 100),
      rowP([2025, 7, 1], 'Buy', 100, 200),
      rowP([2025, 8, 1], 'Split', 300, 0, '2:1'),
      rowP([2025, 9, 1], 'Sell', 500, 120),
      rowP([2025, 10, 1], 'Sell', 100, 130),
    ]);
    await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    const qSt = written(`Short Term Capital Gains for ${FY_LABEL}`);
    const qStA = written(`Short Term Capital Gains (Acquisitions) for ${FY_LABEL}`);
    const qMain = written(`Capital Gains for ${FY_LABEL}`);
    ok('Q: the short-term ACQUISITIONS tab was written', !!qStA);

    if (qSt && qStA && qMain) {
      const past = (t: any[][]) => t.slice(hEnd(t) + 1);
      // The acquisition family starts right after SCRIPT NAME on these tabs, so QTY is 3.
      const qtyA = past(qStA).reduce((n, r) => n + (typeof r[3] === 'number' ? r[3] : 0), 0);
      const bf = past(qStA).filter(r => `${r[1] ?? ''}`.trim() === 'B/F');

      // EVERY SHARE FIFO CONSUMED, ONCE. 400 carried in, 100 of the in-year buy, 100 more of
      // it from the second sale - which is the parcel the drawdown decides the fate of.
      eq('Q: the acquisition tab carries all 600 shares the sales consumed', qtyA, 600);
      eq('Q: ...as ONE brought-forward row beside one in-year purchase', bf.length, 1);
      eq('Q: ...the carried-in one being the 400 that predate the year',
        bf.reduce((n, r) => n + (typeof r[3] === 'number' ? r[3] : 0), 0), 400);

      // THE IN-YEAR LOT IS ONE ROW, NOT A PURCHASE PLUS A REMAINDER - which is the units bug
      // this fixture was built to find. 100 shares were bought and a 2:1 split made them 200;
      // allocating in SHARES capped the purchase at the 100 the note says and spilled the
      // other 100 into a second, brought-forward row, counting Rs 10,000 of one lot's cost
      // twice on a filed page. Allocating in COST - which a split does not change - absorbs
      // the whole lot into the purchase it came from.
      const inYear = past(qStA).filter(r => `${r[2] ?? ''}`.trim() === '01.07.2025');
      eq('Q: the in-year lot is a single acquisition row', inYear.length, 1);
      eq('Q: ...at its POST-split share count', inYear[0][3], 200);
      eq('Q: ...and its whole, undivided cost', inYear[0][5], 20000);
      eq('Q: so the acquisition column totals the 40,000 these sales really cost',
        past(qStA).reduce((n, r) => n + (typeof r[5] === 'number' ? r[5] : 0), 0), 40000);

      // The period sibling renders the SAME allocation in the CONTRACT NOTE's units: the 100
      // shares the note records, not the 200 they became. Its SPLIT restatement is filed in
      // this same column family (`restateCols`), so it has to come out of the sum - the same
      // filter fixture P1 already needs.
      eq('Q: its period sibling shows the in-year buy in NOTE units',
        past(qSt).filter(r => `${r[1] ?? ''}`.trim() !== 'SPLIT')
          .reduce((n, r) => n + (typeof r[7] === 'number' ? r[7] : 0), 0), 100);

      // THE OPENING LOT GENUINELY CARRIES CHARGES HERE - the pre-FY buy was charged 10 / 5 /
      // 2 / 1 / 0.50 / 0.10 / 0.05 and is held whole at FY start - so a B/F row inheriting
      // them is a real possibility rather than a hypothetical one. That cost was incurred in
      // a year already filed; claiming it here would be a deduction against this year's gain.
      const brokCol = qStA[2].indexOf('Brok.Total');
      ok('Q: the charge block is locatable', brokCol > 0);
      ok('Q: every brought-forward row is charge-free ON THE ROW',
        bf.every(r => r.slice(brokCol).every((c: any) => `${c ?? ''}`.trim() === '')));

      const expOf = (t: any[][]): number => {
        const i = t.findIndex(r => r.some((c: any) => /Expenses$/.test(`${c}`)));
        if (i < 0) return NaN;
        const n = (t[i + 1] || []).find((c: any) => typeof c === 'number');
        return typeof n === 'number' ? n : NaN;
      };
      // ...so the two tabs' expense totals are EQUAL, and here that is a real statement: the
      // acquisition tab has two extra rows and its total did not move.
      near('Q: so the acquisition expense total equals its period sibling', expOf(qStA), expOf(qSt));
      ok('Q: ...and neither is nil', expOf(qSt) > 0,
        'a fixture with no charges at all would satisfy the tie trivially');

      // SALES less ACQUISITIONS is the P/L already filed - which only holds because every lot
      // that paid for these sales is on the page, carried-in ones included.
      const sum = (t: any[][], c: number) =>
        past(t).reduce((n, r) => n + (typeof r[c] === 'number' ? r[c] : 0), 0);
      const qPl = (() => {
        const c = qMain[1].findIndex((x: any) => `${x}`.trim() === 'Short term');
        const gt = qMain.find(r => r[1] === 'GRAND TOTAL');
        return c >= 0 && gt ? Number(gt[c]) || 0 : NaN;
      })();
      near('Q: SALES less ACQUISITIONS is the short-term P/L already filed',
        sum(qStA, 9) - sum(qStA, 5), qPl);
      ok('Q: ...and that P/L is not zero', Math.abs(qPl) > 1);

      // The SPLIT is a sentence here, not a figure: the acquisition rows already carry the
      // restated 50 / 100 rates, so printing the restatement again would double the column.
      const flatQ = qStA.map(r => r.join('|'));
      ok('Q: the split is disclosed as a sentence', flatQ.some(r => r.includes('holding restated to')));
      eq('Q: ...and not as a SPLIT figure row',
        past(qStA).filter(r => `${r[1] ?? ''}`.trim() === 'SPLIT').length, 0);
      ok('Q: while the main tab still prints its SPLIT row',
        qMain.some(r => `${r[1] ?? ''}`.trim() === 'SPLIT'),
        'the acquisition tabs clone their blocks; stripping figures must not reach the main tab');
    }

    // -- FIXTURE R - TWO LOTS AT ONE DATE, WHICH IS WHAT `room` IS FOR -------------------
    //
    // The allocator draws down on BOTH sides as a purchase absorbs a lot: the lot's remaining
    // quantity, and the purchase's remaining COST. Fixture P3 covers the first (two same-day
    // buys at the SAME price merge into one matched lot, so only `h.qty` is in play). Nothing
    // covered the second, and a probe removing `room` came back SILENT.
    //
    // It needs two DISTINCT lots sharing one date, which means two buys at DIFFERENT prices -
    // 100 at 100 and 100 at 200 on 1-Jul, both sold. Without the `room` drawdown the first
    // purchase absorbs the second lot as well: it reports 20,000 of cost against its own
    // 10,000, so `f` comes out at 2.0 and it claims DOUBLE its brokerage, while the second
    // purchase claims half of its own. The total cost still ties and the share count still
    // ties - only the CHARGES move, which is why neither existing invariant can see it.
    //
    // What catches it is the period tabs' CEILING arm: the two tabs would claim 2.5x a
    // purchase's charges where the main tab carries 2x, and the register refuses to write.
    install([
      HDR_P,
      rowP([2025, 7, 1], 'Buy', 100, 100),
      rowP([2025, 7, 1], 'Buy', 100, 200),
      rowP([2025, 9, 1], 'Sell', 200, 300),
    ]);
    await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    const rStA = written(`Short Term Capital Gains (Acquisitions) for ${FY_LABEL}`);
    const rMain = written(`Capital Gains for ${FY_LABEL}`);
    ok('R: the short-term ACQUISITIONS tab was written', !!rStA);

    if (rStA && rMain) {
      const pastR = (t: any[][]) => t.slice(hEnd(t) + 1);
      // Both lots are fully consumed, so both purchases appear whole: 100 at 100 and 100 at
      // 200. A `room` that never ran down would report 150 shares against the first and 50
      // against the second - the same 200 in total, which is exactly why the quantity cannot
      // be what guards this.
      const rows = pastR(rStA).filter(r => typeof r[3] === 'number' && r[3] > 0);
      eq('R: both same-day lots appear as their own acquisition rows', rows.length, 2);
      eq('R: ...the cheaper one whole at 100 shares', rows[0][3], 100);
      eq('R: ...and the dearer one whole at 100 shares', rows[1][3], 100);
      eq('R: ...costing 10,000 and 20,000', `${rows[0][5]}|${rows[1][5]}`, '10000|20000');

      // And each carries its OWN charges, undoubled. Both notes were charged identically, so
      // a doubled first row and a halved second would still sum correctly down the column -
      // the per-row figure is the only place it shows.
      const brokR = rStA[2].indexOf('Brok.Total');
      eq('R: each acquisition row carries its own brokerage, neither doubled nor halved',
        `${rows[0][brokR]}|${rows[1][brokR]}`, '10|10');
    }
  }

  // ── FIXTURE S — THE REPORTS GO TO A DIFFERENT WORKBOOK ────────────────────
  //
  // (29-Oct-2026, owner request: FY26-27 for Integrated / Saket Agarwal / S713 writes its
  // reports to a separate sheet. The LEDGER does not move.)
  //
  // One identifier used to do both jobs. Splitting it is the kind of change where a single
  // missed site is silent in the worst way, and only an assertion on the DESTINATION of every
  // call can see it - the written grid is byte-identical either way.
  //
  // The stub keys its ranges on `spreadsheetId + "::" + range`, so a read pointed at the
  // report workbook finds no True Entry and throws. That is what makes the read half
  // self-proving here rather than merely asserted.
  {
    const DEST = 'REPORT-WORKBOOK-UNDER-TEST';
    // THREE separate reads come off the account's own sheet - True Entry, Opening Holdings
    // and Corporate Actions - and each needs something in it here, or a probe pointing that
    // read at the destination is a no-op and tests green while doing nothing. (The first
    // sweep found exactly that: the opening-basis probe was SILENT because this fixture had
    // no opening lots, and every fixture that HAS them passes no destination at all.)
    const S_OPENING = [
      ['Security', 'ISIN', 'Acquisition Date', 'Quantity', 'Cost Per Share', 'Total Cost', '', ''],
      ['GAMMA TECH LIMITED', 'INE003A01015', serial(2023, 4, 1), 300, 50, 15000, '', ''],
    ];
    const S_CORP = [
      ['Date', 'Type', 'From', 'To', 'Shares In', 'Cost', 'Notes'],
      ['20/06/2025', 'Demerger', 'GAMMA TECH LIMITED', 'DELTA POWER LIMITED', 300, 5000, ''],
    ];
    const installS = () => install([
      TE_HEADER,
      te([2025, 6, 10], 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', 'Buy', 100, 50),
      te([2025, 9, 20], 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', 'Sell', 100, 70),
      te([2025, 11, 5], 'GAMMA TECH LIMITED', 'INE003A01015', 'Sell', 100, 90),
    ], S_OPENING, S_CORP);
    installS();
    // The destination is a DIFFERENT workbook that knows nothing about this account. Giving it
    // only a stray "Sheet1" is the real shape: an empty sheet the owner just created.
    g.__firstTab[DEST] = 'Sheet1';
    g.__sheetTabs[DEST] = ['Sheet1'];
    const resS = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio', undefined, DEST);

    // THE READ STILL CAME FROM THE ACCOUNT'S OWN SHEET. If it had followed the destination the
    // stub would have thrown on `True Entry!A:Z` and the year would be empty - so a non-zero
    // scrip count IS the assertion, not a weaker proxy for it.
    ok('S: the ledger is still read from the account own sheet', resS.scrips > 0,
      'a 0 here means the read followed the destination and found no True Entry');
    eq('S: ...and both sales were seen', resS.sellRows, 2);

    // ...AND SO ARE THE OTHER TWO READS. The opening lot is a COST BASIS: lose it and the sale
    // becomes an uncovered quantity booked at zero P/L, which prints a finished-looking tax tab
    // carrying a gain that is wrong by the whole cost of the shares. The corporate action moves
    // basis between two scrips and leaves a sentence row that no other row can stand in for.
    const sMain = written(`Capital Gains for ${FY_LABEL}`);
    const sFlat = (sMain || []).map(r => r.join('|'));
    // ASSERTED ON THE FIGURE, not on the presence of a 300 anywhere on the tab - the first
    // version of this check was satisfied by the DEMERGER parcel, which is also 300 shares, so
    // it passed with the opening lot gone. GAMMA opens at 300 @ 50 (15,000), the demerger takes
    // 5,000 of that cost to DELTA leaving 33.333333/share, and 100 sold at 90 is a LONG-term
    // gain of 5,666.67. Lose the opening lot and the sale is an UNCOVERED quantity booked at
    // ZERO - a finished-looking tax tab whose gain is wrong by the whole cost of the shares.
    const sLt = (() => {
      const c = ((sMain || [])[1] || []).findIndex((x: any) => `${x}`.trim() === 'Long term');
      const gt = (sMain || []).find(r => r[1] === 'GRAND TOTAL');
      return c >= 0 && gt ? Number(gt[c]) || 0 : NaN;
    })();
    near('S: Opening Holdings is still read from the account own sheet', sLt, 5666.67);
    ok('S: ...and that answer is disjoint from the one a lost basis gives', Math.abs(sLt) > 1,
      'with the opening lot gone the sale is uncovered and this is exactly 0');
    ok('S: Corporate Actions is still read from the account own sheet',
      sFlat.some(r => r.toUpperCase().includes('DEMERGER')),
      'the action is gone, so basis moved between two scrips with nothing on the page saying so');

    // EVERY WRITE WENT TO THE DESTINATION, AND NOT ONE TO THE SOURCE. Asserted over the call
    // log rather than over the grid, because the grid is identical whichever sheet it lands in.
    const wrote = (g.__updated || []).concat(g.__cleared || []);
    ok('S: the run actually wrote something', wrote.length > 0);
    eq('S: every value write went to the report workbook',
      wrote.filter((u: any) => u.spreadsheetId !== DEST).length, 0);
    eq('S: ...and none to the account own sheet',
      wrote.filter((u: any) => u.spreadsheetId === PORTFOLIO).length, 0);
    // The PAINT too - a tab written to one sheet and coloured in another is a `batchUpdate`
    // against a sheetId that belongs to a different workbook.
    const painted = (g.__batched || []).filter((b: any) => b.spreadsheetId === PORTFOLIO);
    eq('S: no formatting batch touched the account own sheet', painted.length, 0);

    // And the result SAYS where they went. A badge that cannot distinguish "written elsewhere"
    // from "written here" leaves the owner opening a sheet that has none of the tabs named.
    eq('S: the result names the destination', resS.reportSheetId, DEST);
    ok('S: ...which differs from the account own sheet', resS.reportSheetId !== PORTFOLIO);

    // ── S2 — NOTHING REDIRECTED. Every other portfolio and every other FY takes this path,
    // so it is the one that must be byte-identical to how the register has always behaved.
    installS();
    const resS2 = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio');
    const wrote2 = (g.__updated || []).concat(g.__cleared || []);
    eq('S2: with no destination every write goes to the account own sheet',
      wrote2.filter((u: any) => u.spreadsheetId !== PORTFOLIO).length, 0);
    eq('S2: ...and the result reports that sheet, never an empty string', resS2.reportSheetId, PORTFOLIO);
    eq('S2: ...and nothing is reported as superseded', (resS2.staleInSource || []).length, 0);

    // ── S3 — THE SUPERSEDED COPIES. The account's own sheet still carries this FY's tabs from
    // a run made before the redirect: last year's figures under this year's heading, which is
    // the orphan the legacy-tab rename exists to prevent, arriving from a new direction.
    // They are NAMED, never deleted - once a redirect is in force this function does not write
    // to that sheet at all.
    installS();
    g.__sheetTabs[PORTFOLIO] = ['True Entry', 'Opening Holdings', 'Corporate Actions',
                                `Capital Gains for ${FY_LABEL}`, `Intra-Day for ${FY_LABEL}`];
    g.__firstTab[DEST] = 'Sheet1';
    g.__sheetTabs[DEST] = ['Sheet1'];
    const resS3 = await generateTrxRegister(PORTFOLIO, FY, 'Test Portfolio', undefined, DEST);
    ok('S3: the superseded copies in the account own sheet are NAMED',
      (resS3.staleInSource || []).includes(`Capital Gains for ${FY_LABEL}`));
    ok('S3: ...both of them', (resS3.staleInSource || []).includes(`Intra-Day for ${FY_LABEL}`));
    // The ledger tabs are NOT reports and must never be listed - naming True Entry here would
    // read as an instruction to delete the account's database.
    ok('S3: ...and the ledger tabs are not among them',
      !(resS3.staleInSource || []).some(t => ['True Entry', 'Opening Holdings', 'Corporate Actions'].includes(t)),
      'listing a ledger tab here reads as "delete this", which would destroy the account');
    // Still nothing written to the source, even though it was READ for this check.
    eq('S3: and the check itself wrote nothing to the account own sheet',
      ((g.__updated || []).concat(g.__cleared || [])).filter((u: any) => u.spreadsheetId === PORTFOLIO).length, 0);

    // ── S4 — THE REGISTRY, driven directly. It is pure, so this needs no stub at all, and
    // the two SCOPES are what the whole table is for: a redirect that leaked across years
    // would regenerate an already-filed year into a new workbook on the next click, and one
    // that leaked across accounts would file one client's gains in another client's book.
    eq('S4: S713 FY26-27 resolves to the report workbook',
      reportSheetIdFor('s713', 2026), '1W3XgGm8-vJksXeOg0EA2Gq7yNOdrfAkTk7ZJ5ShzRaA');
    eq('S4: ...and FY25-26 for the SAME account does not', reportSheetIdFor('s713', 2025), sheetIdForId('s713'));
    eq('S4: ...nor FY27-28', reportSheetIdFor('s713', 2027), sheetIdForId('s713'));
    // THE "DIFFERENT ACCOUNT" CONTROL HAS RUN OUT, and that is a fact about the book rather
    // than a gap here. It was T059; then OADR97 when T059 gained a redirect of its own; by the
    // end of 03-Nov-2026 EVERY portfolio is redirected for FY26-27, so no real account is left
    // to play that part for this year. Deleting the assertion and saying nothing is how a
    // suite quietly stops testing a scope, so the situation is ASSERTED instead - and the
    // assertion doubles as the guard for the next portfolio ADDED, which would otherwise write
    // its FY26-27 reports into its own ledger while every sibling went elsewhere.
    const redirected26 = PORTFOLIOS.filter(p => !!reportDestinationFor(p.id, 2026)).length;
    ok(`S4: every portfolio is redirected for FY26-27 (${redirected26}/${PORTFOLIOS.length})`
      + ' - the account-scope control has run out',
      redirected26 === PORTFOLIOS.length,
      'a NEW portfolio with no entry writes this FY reports into its own ledger while every '
      + 'sibling goes elsewhere - decide whether it should have one too');
    eq('S4: ...and not one of them is redirected for FY25-26',
      PORTFOLIOS.filter(p => !!reportDestinationFor(p.id, 2025)).length, 0);
    // The ACCOUNT scope is therefore carried by the unknown-id case further down, and the YEAR
    // scope by the per-account loop, which asserts FY25-26 on every one of the twelve.
    ok('S4: a destination is reported where one exists', !!reportDestinationFor('s713', 2026));
    ok('S4: ...and none where it does not', !reportDestinationFor('s713', 2025));

    // The eleven added 03-Nov-2026 - four Integrated, then Axis, Nuvama, Zerodha and the four
    // Share India accounts. Each is asserted against its OWN workbook id, so a pair of entries
    // swapped between two accounts - which resolves, writes, and looks entirely ordinary -
    // fails here rather than on a filed page.
    for (const [pid, dest] of [
      ['t059',     '12v7dp0j9c6XIMMLBDWijLZpBHdH1yHVibe1fNAGy638'],
      ['s1404',    '1HPtBzHEFLJ872APSfjLHXBwd8-5J6sfGN3ru8KXJLkE'],
      ['g058',     '1Sc5w91euToJDu7SfbkVDZuikhSVtnoRiqqNjx-1tFSs'],
      ['c087',     '1W7G6WJ3x_NsvdsXYMub2K_lWZ57gPUp3F5iQND91Ke4'],
      ['6150725',  '104OpdiU9CfKOheLsfDwtOZ9pLlLyH7gSBoYgeWtStag'],
      ['60072941', '1uyVY29doNMWGRr8zJgjxOmwPtS_ylc8IDaw2BpUUIkE'],
      ['njw724',   '1naGQUhzOfxIqLDzIzoiXVtYaDT26fgYUm1cZCqrqVqU'],
      ['oaem94',   '1ii9gl36foutt62Xq6QUfCRMLBRZQSYRb159nsCo26TY'],
      ['oadr97',   '1TFeLI-Fo6a4vtObseBhjCYRKcg_cTDo7-cChIQ9c9f4'],
      ['cs1106',   '1tdA_36Tta_EcrOJ_G0LWQiD1L-N_cVrteBZ8X1lvdwM'],
      ['oaeu09',   '1Q-Nyt1lL-Nmqk1WYQ4y-o5SpeXpfATgAF_VDd4UjKjQ'],
    ] as [string, string][]) {
      eq(`S4: ${pid.toUpperCase()} FY26-27 resolves to its own report workbook`,
        reportSheetIdFor(pid, 2026), dest);
      eq(`S4: ...and ${pid.toUpperCase()} FY25-26 still writes to its ledger`,
        reportSheetIdFor(pid, 2025), sheetIdForId(pid));
    }
    // PER HOLDER, NOT ONLY PER WORKBOOK. Three people own more than one account - Saket
    // Agarwal THREE (S713 Integrated, OADR97 Share India, 6150725 Axis), Gunjan Agarwal and
    // Aditya Agarwal two each - and as of 03-Nov-2026 every one of those is redirected. On the
    // table that reads as a repeated NAME with nothing beside it saying the workbooks must
    // differ, which is the easiest wrong paste to make here and the hardest to see.
    //
    // The general distinctness check below would catch a shared workbook too. This one is kept
    // beside it because it names the PERSON in the failure, which is what a reader scanning
    // the table actually has in front of them - and because it is what catches a registry
    // keyed on the HOLDER rather than the account, where every one of a person's accounts
    // resolves to one book and the per-id loop alone would not say why.
    {
      const byHolder = new Map<string, string[]>();
      for (const p of PORTFOLIOS) {
        const d = reportDestinationFor(p.id, 2026);
        if (d) byHolder.set(p.label, (byHolder.get(p.label) || []).concat(d.sheetId));
      }
      let pairs = 0;
      for (const [holder, books] of byHolder) {
        if (books.length < 2) continue;
        pairs++;
        ok(`S4: ${holder} holds ${books.length} redirected accounts, with a workbook each`,
          new Set(books).size === books.length,
          'one person two books is fine; one book two accounts overwrites a filed year');
      }
      // ...and the check must have something to check, or it passes forever the day the
      // grouping stops grouping anything.
      ok('S4: ...and there really are multi-account holders to check', pairs >= 3);
    }

    // An unknown id must fall back rather than resolve to something. It returns '' because
    // `sheetIdForId` does, which is what every other caller already handles.
    eq('S4: an unknown portfolio resolves to nothing, never to a redirect',
      reportSheetIdFor('no-such-account', 2026), '');

    // INVARIANTS over the table, which is what catches a typo in a hand-maintained list.
    for (const d of REPORT_DESTINATIONS) {
      ok(`S4: "${d.portfolioId}" is a real portfolio`, !!portfolioById(d.portfolioId),
        'a typo here falls back silently to the account own sheet and the redirect simply never happens');
      ok(`S4: "${d.portfolioId}" FY${d.fyStartYear} points somewhere ELSE`,
        !!d.sheetId && d.sheetId !== sheetIdForId(d.portfolioId),
        'an entry naming the account own sheet is a no-op wearing the clothes of a redirect');
      ok(`S4: "${d.portfolioId}" FY${d.fyStartYear} does not target another ACCOUNT ledger`,
        !PORTFOLIOS.some(x => x.sheetId === d.sheetId),
        'writing one account reports into another account database is the worst outcome here');
    }
    // NO TWO ENTRIES MAY SHARE A WORKBOOK. The tab names carry the FY but not the account, so
    // two accounts pointing at one book do not collide loudly - the second run OVERWRITES the
    // first's `Capital Gains for FY26-27` in place and one client's filed figures are simply
    // gone, with both runs reporting success. Self-evident with one entry; it stopped being so
    // at five, and at seven - two of which are one person - it is the thing most likely to go
    // wrong here.
    {
      const seen = new Map<string, string>();
      for (const d of REPORT_DESTINATIONS) {
        const k = `${d.sheetId}|${d.fyStartYear}`;
        ok(`S4: "${d.portfolioId}" FY${d.fyStartYear} has a workbook of its own`,
          !seen.has(k), `it shares one with "${seen.get(k)}", whose tabs it would overwrite`);
        seen.set(k, d.portfolioId);
      }
      // And a destination is never some OTHER entry's destination for a different year either,
      // which is the same overwrite one FY later.
      eq('S4: every destination workbook appears exactly once',
        new Set(REPORT_DESTINATIONS.map(d => d.sheetId)).size, REPORT_DESTINATIONS.length);
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  console.log('='.repeat(60));
  for (const f of failures) console.log('  FAIL ' + f);
console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
