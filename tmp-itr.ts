// The ITR "Details of Unlisted Equity Shares" schedule builder.
//
// Most fixtures below are REAL companies out of the owner's own filed FY2024-25 return
// (acknowledgement 645654391261125, filed 26-Nov-2025) with their filed figures. That matters
// more than usual here: this is the one tab in the app whose correct output already exists as
// an external document, so the suite can check against a filed page rather than against its own
// idea of what the code should do. Anywhere a fixture is invented it says so.
//
// Run: npx tsx tmp-itr.ts
import {
  buildItrUnlistedSchedule, ITR_HEADER, ITR_COL, ITR_WIDTH,
  ITR_HEADER_ROW_INDEX, ITR_FIRST_DATA_ROW_INDEX, ITR_BANNER_ROWS,
  ItrCompanyInput,
} from './src/lib/itrUnlistedSchedule';

let pass = 0, fail = 0;
const eq = (label: string, got: any, want: any) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

const D = (d: number, m: number, y: number) => new Date(y, m - 1, d).getTime();
const OPTS = { title: 'T', subtitle: 'S' };

/** A company with every field defaulted, so each fixture states only what it is about. */
const co = (p: Partial<ItrCompanyInput> & { name: string }): ItrCompanyInput => ({
  pan: 'AAACA0000A', companyType: 'Domestic', faceValue: 10,
  openingQty: 0, openingCost: 0, acquisitions: [], transferredQty: 0, consideration: 0,
  closingQty: 0, closingCost: 0, ...p,
});

/** Data rows only — banners, the blank spacer, the header, the spacer and TOTAL all dropped. */
const dataRows = (s: ReturnType<typeof buildItrUnlistedSchedule>) =>
  s.rows.slice(s.firstDataRowIndex, s.lastDataRowIndex + 1);

// ── 1. The header, verbatim ────────────────────────────────────────────────────────────────
// Pinned as literal strings because the ITR utility's own column names are the contract; a
// tidy-up that shortens "Shares acquired - Date of subscription/purchase" produces a schedule
// that still looks right and no longer matches the form it is filed under.
{
  eq('header: 15 columns', ITR_HEADER.length, 15);
  eq('header: width agrees', ITR_WIDTH, 15);
  eq('header: C', ITR_HEADER[ITR_COL.type], 'Type of Company');
  eq('header: D', ITR_HEADER[ITR_COL.pan], 'PAN of Company');
  eq('header: F', ITR_HEADER[ITR_COL.openCost], 'Opening Balance - Cost of acquisition');
  eq('header: H', ITR_HEADER[ITR_COL.acqDate], 'Shares acquired - Date of subscription/purchase');
  eq('header: J', ITR_HEADER[ITR_COL.issuePrice], 'Shares acquired - Issue price per share (fresh issue)');
  eq('header: K', ITR_HEADER[ITR_COL.purchasePrice], 'Shares acquired - Purchase price per share (existing shareholder)');
  eq('header: M', ITR_HEADER[ITR_COL.consideration], 'Shares transferred - Sale consideration');
  eq('header: O', ITR_HEADER[ITR_COL.closeCost], 'Closing balance - Cost of acquisition');
}

// ── 2. Geometry: banners on 1-2, header on 4, data from 5 ──────────────────────────────────
// The filed file freezes at A5. These constants drive the paint pass in trxRegister, which
// CANNOT reuse the holding tabs' geometry (there every row index is hardcoded to a 3-row
// preamble), so a drift here silently paints the wrong bands.
{
  const s = buildItrUnlistedSchedule([co({ name: 'Acme', closingQty: 10, closingCost: 100 })], OPTS);
  eq('geometry: banner rows', ITR_BANNER_ROWS, 2);
  eq('geometry: header is sheet row 4', ITR_HEADER_ROW_INDEX, 3);
  eq('geometry: data starts sheet row 5', ITR_FIRST_DATA_ROW_INDEX, 4);
  eq('geometry: title on row 1', s.rows[0][0], 'T');
  eq('geometry: subtitle on row 2', s.rows[1][0], 'S');
  eq('geometry: row 3 is blank', s.rows[2].join(''), '');
  eq('geometry: header lands on the declared row', s.rows[ITR_HEADER_ROW_INDEX], ITR_HEADER);
  eq('geometry: first data row is where the constant says', s.firstDataRowIndex, ITR_FIRST_DATA_ROW_INDEX);
  eq('geometry: every row is full width', s.rows.every(r => r.length === ITR_WIDTH), true);
}

// ── 3. 9M India Ltd — the row rule itself ──────────────────────────────────────────────────
// Filed rows 5 and 6. Two acquisitions, no opening, nothing sold. This is the fixture that
// proves CLOSING IS PER ROW: the filed page carries 18,000 and 12,000 on the two rows, not
// 30,000 on one of them and a blank on the other. Everything else in the layout follows from
// that reading.
{
  const s = buildItrUnlistedSchedule([co({
    name: '9M India Ltd', pan: 'AABCZ3236B',
    acquisitions: [
      { ts: D(4, 10, 2024), qty: 18000, turnover: 18000 * 143 },
      { ts: D(31, 3, 2025), qty: 12000, turnover: 12000 * 490 },
    ],
    closingQty: 30000, closingCost: 18000 * 143 + 12000 * 490,
  })], OPTS);
  const r = dataRows(s);
  eq('9M: two rows', r.length, 2);
  eq('9M: Sl. No. is per ROW, not per company', [r[0][ITR_COL.sno], r[1][ITR_COL.sno]], [1, 2]);
  eq('9M: name repeats on every row', [r[0][ITR_COL.name], r[1][ITR_COL.name]], ['9M India Ltd', '9M India Ltd']);
  eq('9M: PAN repeats on every row', r[1][ITR_COL.pan], 'AABCZ3236B');
  eq('9M: r1 acquired', r[0][ITR_COL.acqQty], 18000);
  eq('9M: r1 date is dd/mm/yyyy text', r[0][ITR_COL.acqDate], '04/10/2024');
  eq('9M: r1 issue price', r[0][ITR_COL.issuePrice], 143);
  eq('9M: r2 acquired', r[1][ITR_COL.acqQty], 12000);
  eq('9M: r2 date', r[1][ITR_COL.acqDate], '31/03/2025');
  eq('9M: r2 issue price', r[1][ITR_COL.issuePrice], 490);
  // The filed figures, to the rupee.
  eq('9M: r1 closing qty (filed 18,000)', r[0][ITR_COL.closeQty], 18000);
  eq('9M: r1 closing cost (filed 25,74,000)', r[0][ITR_COL.closeCost], 2574000);
  eq('9M: r2 closing qty (filed 12,000)', r[1][ITR_COL.closeQty], 12000);
  eq('9M: r2 closing cost (filed 58,80,000)', r[1][ITR_COL.closeCost], 5880000);
  // No opening: BLANK, never 0. This is the commonest blank-vs-zero case in the whole
  // schedule — every company bought for the first time during the year — and summing an empty
  // lot list yields 0, which on a filed page asserts the shares were held on 1-Apr at nil cost.
  eq('9M: no opening qty prints blank', r[0][ITR_COL.openQty], '');
  eq('9M: no opening cost prints blank', r[0][ITR_COL.openCost], '');
  eq('9M: nothing transferred prints blank', [r[0][ITR_COL.xferQty], r[0][ITR_COL.consideration]], ['', '']);
  eq('9M: K is 0 on every row', [r[0][ITR_COL.purchasePrice], r[1][ITR_COL.purchasePrice]], [0, 0]);
  eq('9M: footing, row 1', r[0][ITR_COL.closeQty], 18000);
  eq('9M: it foots as one company too', 18000 + 12000, 30000);
}

// ── 4. Curis Lifescience — a bonus, and the blank closing COST ─────────────────────────────
// Filed rows 13 and 14. The second acquisition is 29,120 shares at issue price 0. The filed
// page prints its closing QUANTITY and leaves its closing COST empty: shares that cost nothing
// have no cost of acquisition, and 0.00 in a cost column is a different claim from blank.
{
  const s = buildItrUnlistedSchedule([co({
    name: 'Curis Lifescience Ltd', pan: 'AAGCC4108A',
    acquisitions: [
      { ts: D(1, 10, 2024), qty: 2912, turnover: 2912 * 1076 },
      { ts: D(4, 2, 2025), qty: 29120, turnover: 0 },
    ],
    closingQty: 32032, closingCost: 2912 * 1076,
  })], OPTS);
  const r = dataRows(s);
  eq('Curis: two rows', r.length, 2);
  eq('Curis: r1 closing cost (filed 31,33,312)', r[0][ITR_COL.closeCost], 3133312);
  eq('Curis: bonus row issue price is 0', r[1][ITR_COL.issuePrice], 0);
  eq('Curis: bonus row still shows its quantity', r[1][ITR_COL.closeQty], 29120);
  eq('Curis: bonus row closing COST is blank, not 0.00', r[1][ITR_COL.closeCost], '');
}

// ── 5. ARCHIT NUWOOD — held all year, nothing bought, nothing sold ─────────────────────────
// Filed row 8. One row. G and H are empty, but the filed page prints ZERO across I/J/K rather
// than blanks — the "shares acquired" group is nil, not unknown. This is the one place the
// schedule deliberately disagrees with the PE holding statement, which blanks a missing face
// value. Both are right for their own document.
{
  const s = buildItrUnlistedSchedule([co({
    name: 'ARCHIT NUWOOD INDUSTRIES LIMITED', pan: 'AAQCA0765K',
    openingQty: 5200, openingCost: 936000, closingQty: 5200, closingCost: 936000,
  })], OPTS);
  const r = dataRows(s);
  eq('Archit: one row', r.length, 1);
  eq('Archit: opening (filed 5,200 / 9,36,000)', [r[0][ITR_COL.openQty], r[0][ITR_COL.openCost]], [5200, 936000]);
  eq('Archit: closing (filed 5,200 / 9,36,000)', [r[0][ITR_COL.closeQty], r[0][ITR_COL.closeCost]], [5200, 936000]);
  eq('Archit: no acquisition qty', r[0][ITR_COL.acqQty], '');
  eq('Archit: no acquisition date', r[0][ITR_COL.acqDate], '');
  eq('Archit: face value prints 0, as the filed file does', r[0][ITR_COL.faceValue], 0);
  eq('Archit: issue price prints 0', r[0][ITR_COL.issuePrice], 0);
  eq('Archit: purchase price prints 0', r[0][ITR_COL.purchasePrice], 0);
}

// ── 6. NSE — opening, a bonus, and a transfer, all on one row ──────────────────────────────
// Filed row 37, and the single row that exercises the whole rule at once:
//   24,000 opening + 96,000 bonus - 24,000 transferred = 96,000 closing, closing cost BLANK.
// The survivors are the bonus shares, so the cost left with the shares that were sold.
{
  const s = buildItrUnlistedSchedule([co({
    name: 'NSE', pan: 'AAACN1797L', faceValue: 1,
    openingQty: 24000, openingCost: 72438700,
    acquisitions: [{ ts: D(11, 11, 2024), qty: 96000, turnover: 0 }],
    transferredQty: 24000, consideration: 40576500,
    closingQty: 96000, closingCost: 0,
  })], OPTS);
  const r = dataRows(s);
  eq('NSE: one row', r.length, 1);
  eq('NSE: face value 1, not defaulted to 10', r[0][ITR_COL.faceValue], 1);
  eq('NSE: opening (filed 24,000 / 7,24,38,700)', [r[0][ITR_COL.openQty], r[0][ITR_COL.openCost]], [24000, 72438700]);
  eq('NSE: acquired (filed 96,000 @ 0)', [r[0][ITR_COL.acqQty], r[0][ITR_COL.issuePrice]], [96000, 0]);
  eq('NSE: transferred (filed 24,000 / 4,05,76,500)', [r[0][ITR_COL.xferQty], r[0][ITR_COL.consideration]], [24000, 40576500]);
  eq('NSE: closing qty (filed 96,000)', r[0][ITR_COL.closeQty], 96000);
  eq('NSE: closing cost blank (filed empty)', r[0][ITR_COL.closeCost], '');
  eq('NSE: the row foots', 24000 + 96000 - 24000, 96000);
}

// ── 7. GOODLUCK DEFENCE — a part sale out of opening, no acquisition ───────────────────────
// Filed row 22. 3,00,000 @ 150 opening, 50,000 sold, 2,50,000 left at 37,50,000.
{
  const s = buildItrUnlistedSchedule([co({
    name: 'GOODLUCK DEFENCE', pan: 'AAKCG6927D',
    openingQty: 300000, openingCost: 45000000,
    transferredQty: 50000, consideration: 12100000,
    closingQty: 250000, closingCost: 37500000,
  })], OPTS);
  const r = dataRows(s);
  eq('Goodluck: transferred (filed 50,000 / 1,21,00,000)', [r[0][ITR_COL.xferQty], r[0][ITR_COL.consideration]], [50000, 12100000]);
  eq('Goodluck: closing (filed 2,50,000 / 3,75,00,000)', [r[0][ITR_COL.closeQty], r[0][ITR_COL.closeCost]], [250000, 37500000]);
  eq('Goodluck: the row foots', 300000 - 50000, 250000);
}

// ── 8. POLYMATECH — fully exited during the year ───────────────────────────────────────────
// Filed row 40. The company is GONE by 31-March and still appears: the schedule reports what
// was held AT ANY TIME. In the app such a block survives in `blocks` with an empty `closing`,
// which is exactly why the register's builder must not source `heldAll` / `heldPe` — both
// filter on `closing.length > 0` and would drop this company off a filed return.
{
  const s = buildItrUnlistedSchedule([co({
    name: 'POLYMATECH ELECTRONICS LIMITED', pan: 'AAECP2981Q',
    openingQty: 40000, openingCost: 12000000,
    transferredQty: 40000, consideration: 19396500,
    closingQty: 0, closingCost: 0,
  })], OPTS);
  const r = dataRows(s);
  eq('Polymatech: it is still on the schedule', r.length, 1);
  eq('Polymatech: closing qty blank, not 0', r[0][ITR_COL.closeQty], '');
  eq('Polymatech: closing cost blank, not 0.00', r[0][ITR_COL.closeCost], '');
  eq('Polymatech: opening still stated', [r[0][ITR_COL.openQty], r[0][ITR_COL.openCost]], [40000, 12000000]);
}

// ── 9. KIMBAL / VIKRAM SOLAR — opening plus an acquisition on one row ──────────────────────
// Filed rows 29 and 51. Vikram is the one that sells its ENTIRE opening: the cost leaves with
// the shares, so closing cost is exactly the acquisition's cost.
{
  const s = buildItrUnlistedSchedule([
    co({
      name: 'KIMBAL PRIVATE LIMITED (Sinhal Udyog)', pan: 'ABJCS6588C',
      openingQty: 9217, openingCost: 30001335,
      acquisitions: [{ ts: D(15, 10, 2024), qty: 3334, turnover: 3334 * 8249 }],
      closingQty: 12551, closingCost: 57503501,
    }),
    co({
      name: 'VIKRAM SOLAR', pan: 'AABCI5168D',
      openingQty: 179000, openingCost: 25060000,
      acquisitions: [{ ts: D(8, 7, 2024), qty: 327869, turnover: 40000018 }],
      transferredQty: 179000, consideration: 37962700,
      closingQty: 327869, closingCost: 40000018,
    }),
  ], OPTS);
  const r = dataRows(s);
  eq('sorted: KIMBAL before VIKRAM', [r[0][ITR_COL.name], r[1][ITR_COL.name]].map(String).map(x => x[0]), ['K', 'V']);
  eq('Kimbal: closing (filed 12,551 / 5,75,03,501)', [r[0][ITR_COL.closeQty], r[0][ITR_COL.closeCost]], [12551, 57503501]);
  eq('Kimbal: it foots', 9217 + 3334, 12551);
  eq('Vikram: closing (filed 3,27,869 / 4,00,00,018)', [r[1][ITR_COL.closeQty], r[1][ITR_COL.closeCost]], [327869, 40000018]);
  eq('Vikram: it foots', 179000 + 327869 - 179000, 327869);
  eq('Vikram: issue price is derived, not the filed 2-dp figure', r[1][ITR_COL.issuePrice], Math.round((40000018 / 327869) * 100) / 100);
}

// ── 10. Every row foots, INCLUDING opening plus two acquisitions ───────────────────────────
// No company in the filed file has both an opening balance and more than one acquisition, so
// the filed page cannot settle this case. It is settled by the rule the file DOES prove —
// closing is per row — which forces the transfer to be allocated oldest-first (the order FIFO
// consumes lots in). Pinning the transfer to row 1 instead makes row 1 print a NEGATIVE
// closing balance as soon as the sale is bigger than opening + first purchase. Invented
// figures, chosen so the transfer spans the boundary.
{
  const s = buildItrUnlistedSchedule([co({
    name: 'Spanner Ltd',
    openingQty: 10, openingCost: 100,
    acquisitions: [
      { ts: D(1, 5, 2024), qty: 20, turnover: 20 * 10 },
      { ts: D(1, 9, 2024), qty: 30, turnover: 30 * 20 },
    ],
    transferredQty: 45, consideration: 900,
    closingQty: 15, closingCost: 300,       // FIFO ate opening + acq1 + 15 of acq2
  })], OPTS);
  const r = dataRows(s);
  const n = (v: any) => (v === '' ? 0 : Number(v));
  eq('span: two rows', r.length, 2);
  eq('span: transfer allocated oldest-first', [n(r[0][ITR_COL.xferQty]), n(r[1][ITR_COL.xferQty])], [30, 15]);
  eq('span: row 1 foots', n(r[0][ITR_COL.openQty]) + n(r[0][ITR_COL.acqQty]) - n(r[0][ITR_COL.xferQty]), n(r[0][ITR_COL.closeQty]));
  eq('span: row 2 foots', n(r[1][ITR_COL.openQty]) + n(r[1][ITR_COL.acqQty]) - n(r[1][ITR_COL.xferQty]), n(r[1][ITR_COL.closeQty]));
  eq('span: no row prints a negative closing balance', r.every(x => n(x[ITR_COL.closeQty]) >= 0), true);
  eq('span: closing sums to the FIFO position', n(r[0][ITR_COL.closeQty]) + n(r[1][ITR_COL.closeQty]), 15);
  eq('span: closing cost sums to the FIFO cost', n(r[0][ITR_COL.closeCost]) + n(r[1][ITR_COL.closeCost]), 300);
  eq('span: consideration sums to the total', n(r[0][ITR_COL.consideration]) + n(r[1][ITR_COL.consideration]), 900);
  eq('span: exhausted row 1 prints blank, not 0', r[0][ITR_COL.closeQty], '');
}

// ── 11. Grouping: by date AND rate ─────────────────────────────────────────────────────────
// Two fills of one order on one day at one price are ONE subscription. A bonus landing on the
// same day as a cash purchase is not — merging them would put a weighted-average rate in
// column J, a price nobody paid for anything. The register's own `consolidate` groups on the
// timestamp alone, which is right for a holding statement and wrong here.
{
  const s = buildItrUnlistedSchedule([co({
    name: 'Grouped Ltd',
    acquisitions: [
      { ts: D(10, 6, 2024), qty: 100, turnover: 100 * 50 },
      { ts: D(10, 6, 2024), qty: 400, turnover: 400 * 50 },   // same day, same price -> one row
      { ts: D(10, 6, 2024), qty: 250, turnover: 0 },          // same day, bonus      -> its own row
    ],
    closingQty: 750, closingCost: 500 * 50,
  })], OPTS);
  const r = dataRows(s);
  eq('group: same date + same rate merge', r.length, 2);
  eq('group: merged quantity', r[0][ITR_COL.acqQty], 500);
  eq('group: merged rate unchanged', r[0][ITR_COL.issuePrice], 50);
  eq('group: the bonus keeps its own row', [r[1][ITR_COL.acqQty], r[1][ITR_COL.issuePrice]], [250, 0]);
  eq('group: the bonus row carries no cost', r[1][ITR_COL.closeCost], '');
}

// ── 12. The TOTAL row ──────────────────────────────────────────────────────────────────────
// Sums E, F, G, L, M, N, O and NOTHING else. Totalling a per-share column (I, J or K) would
// add up prices, which is not a quantity of anything; the filed file's own =SUM range skips
// them for that reason.
{
  const s = buildItrUnlistedSchedule([
    co({ name: 'Alpha', openingQty: 100, openingCost: 1000, acquisitions: [{ ts: D(1, 6, 2024), qty: 50, turnover: 750 }], closingQty: 150, closingCost: 1750 }),
    co({ name: 'Beta', openingQty: 200, openingCost: 4000, transferredQty: 200, consideration: 9000, closingQty: 0, closingCost: 0 }),
  ], OPTS);
  const t = s.rows[s.totalRowIndex];
  eq('total: labelled', t[ITR_COL.name], 'TOTAL');
  eq('total: opening qty', t[ITR_COL.openQty], 300);
  eq('total: opening cost', t[ITR_COL.openCost], 5000);
  eq('total: acquired qty', t[ITR_COL.acqQty], 50);
  eq('total: transferred qty', t[ITR_COL.xferQty], 200);
  eq('total: consideration', t[ITR_COL.consideration], 9000);
  eq('total: closing qty', t[ITR_COL.closeQty], 150);
  eq('total: closing cost', t[ITR_COL.closeCost], 1750);
  eq('total: face value is NOT summed', t[ITR_COL.faceValue], '');
  eq('total: issue price is NOT summed', t[ITR_COL.issuePrice], '');
  eq('total: purchase price is NOT summed', t[ITR_COL.purchasePrice], '');
  eq('total: Sl. No. is NOT summed', t[ITR_COL.sno], '');
  eq('total: date column empty', t[ITR_COL.acqDate], '');
  // Values, not =SUM(): the register has never written a cell formula, and a formula with no
  // cached result reads back as undefined through a workbook reader — a broken total row would
  // then pass a round-trip test as an empty one.
  eq('total: written as a value, never a formula', typeof t[ITR_COL.openQty] === 'number', true);
  eq('total: sits below the last data row', s.totalRowIndex > s.lastDataRowIndex, true);
}

// ── 13. Diagnostics, because every failure here is silent on the tab itself ────────────────
{
  const s = buildItrUnlistedSchedule([
    co({ name: 'HasPan', pan: 'AAACH0000A', openingQty: 1, openingCost: 1, closingQty: 1, closingCost: 1 }),
    co({ name: 'NoPan', pan: '', openingQty: 1, openingCost: 1, closingQty: 1, closingCost: 1 }),
    co({ name: 'Charged', hasCharges: true, openingQty: 1, openingCost: 1, closingQty: 1, closingCost: 1 }),
  ], OPTS);
  eq('diag: company count', s.companyCount, 3);
  eq('diag: a missing PAN is NAMED, not just left blank', s.missingPan, ['NoPan']);
  eq('diag: a charged lot is named, so turnover != all-in is visible', s.charged, ['Charged']);
  eq('diag: nothing unfooted here', s.unfooted, []);
}

// ── 14. A company that cannot foot is NAMED, and its closing stays the FIFO truth ──────────
// Shares can arrive or leave with no row of their own: a SPLIT rescales lots in place and
// emits no acquisition; a merger/demerger receipt is a corpNote; a cross-portfolio transfer
// carries its quantity only inside a prose string. The closing balance is the one figure that
// must be right on a filed page, so it is corrected and the company is listed under the total
// rather than the difference being absorbed where nobody would find it.
{
  const s = buildItrUnlistedSchedule([co({
    name: 'Split Co',
    openingQty: 100, openingCost: 1000,
    closingQty: 200, closingCost: 1000,     // 1:1 split — twice the shares, same cost
  })], OPTS);
  const r = dataRows(s);
  eq('unfooted: the company is named', s.unfooted, ['Split Co']);
  eq('unfooted: closing balance is the FIFO position', r[0][ITR_COL.closeQty], 200);
  eq('unfooted: closing cost unchanged', r[0][ITR_COL.closeCost], 1000);
  const note = s.rows.slice(s.totalRowIndex).map(x => String(x[ITR_COL.name])).join(' ');
  eq('unfooted: and explained under the total', /Split Co/.test(note) && /will not foot/.test(note), true);
}

// ── 15. An empty book still writes a tab that says so ──────────────────────────────────────
// Same rule as the holding tabs: a tab skipped because its class is empty keeps LAST year's
// figures under THIS year's heading, and bare column headers read as a failed run.
{
  const s = buildItrUnlistedSchedule([], OPTS);
  eq('empty: header still written', s.rows[ITR_HEADER_ROW_INDEX], ITR_HEADER);
  eq('empty: says so in words', String(s.rows[ITR_FIRST_DATA_ROW_INDEX][ITR_COL.name]),
    'No unlisted equity shares were held at any time during this year.');
  eq('empty: no companies', s.companyCount, 0);
  eq('empty: a total row is still present', s.rows[s.totalRowIndex][ITR_COL.name], 'TOTAL');
}

// ── 16. Dates never come back as anything but dd/mm/yyyy text ──────────────────────────────
// Column H is written RAW for this reason: under USER_ENTERED, Sheets reparses a dd/mm/yyyy
// string whose day is <= 12 as US mm-dd and stores a SWAPPED serial. 04/10/2024 would be filed
// as 10-Apr-2024. Every date in the filed file with a day <= 12 is one of these.
{
  const s = buildItrUnlistedSchedule([co({
    name: 'Dates Ltd',
    acquisitions: [
      { ts: D(4, 10, 2024), qty: 1, turnover: 1 },
      { ts: D(11, 11, 2024), qty: 1, turnover: 1 },
      { ts: D(8, 4, 2024), qty: 1, turnover: 1 },
      { ts: D(31, 3, 2025), qty: 1, turnover: 1 },
    ],
    closingQty: 4, closingCost: 4,
  })], OPTS);
  const got = dataRows(s).map(r => r[ITR_COL.acqDate]);
  eq('dates: ambiguous days stay dd/mm/yyyy', got, ['08/04/2024', '04/10/2024', '11/11/2024', '31/03/2025']);
  eq('dates: all are strings, never serials', got.every(x => typeof x === 'string'), true);
  eq('dates: sorted oldest-first within the company', got[0], '08/04/2024');
}

console.log(`\ntmp-itr: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
