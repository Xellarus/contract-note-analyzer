/**
 * Per-stock opening-trades import: the template reader and the ADDITIVE merge.
 *
 * Run via tmp-opening-import-run.mjs (esbuild + browser-only stubs) — stockOpeningImport pulls
 * in holdingsCalc, which imports gapi-script.
 *
 * The fixture that matters is F: adding a batch that SELLS on top of lots already on the sheet.
 * A lot-append — reconstructing the new file on its own and concatenating — produces a
 * DISJOINT answer there (the sell replays against an empty queue and evaporates), which is
 * exactly what makes it a test rather than a restatement of the code.
 */
import {
  findHeader, parseCellDate, rowIsForeign, parseStockTxnGrid, parseSingleStockTxnCsv,
  dedupeAgainstExisting, batchIsOutOfOrder, reconstructStockOpening, txnKey,
  creditCorpActionRows,
} from './src/lib/stockOpeningImport';
import type { SeedLot, TxnStatementRow } from './src/lib/openingBasis';

let pass = 0, fail = 0;
const failures: string[] = [];

/** Every assertion takes a THUNK: one that throws is a single failure, not an aborted run.
 *  (A test that threw mid-file once hid every result after it.) */
function eq(label: string, fn: () => any, expected: any): void {
  let actual: any;
  try { actual = fn(); }
  catch (e: any) { fail++; failures.push(`${label} — threw: ${e?.message || e}`); return; }
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; return; }
  fail++; failures.push(`${label}\n    expected ${b}\n    actual   ${a}`);
}

function close(label: string, fn: () => number, expected: number, tol = 1e-6): void {
  let actual: number;
  try { actual = fn(); }
  catch (e: any) { fail++; failures.push(`${label} — threw: ${e?.message || e}`); return; }
  if (Math.abs(actual - expected) <= tol) { pass++; return; }
  fail++; failures.push(`${label}\n    expected ${expected}\n    actual   ${actual}`);
}

const STOCK = 'Sambhv Steel Tubes Limited';
const ISIN_A = 'INE01WC01027';
const ISIN_B = 'INE002A01018';

// ───────────────────────────────────────────────────────────────────────────────────────────
// A. Header detection
// ───────────────────────────────────────────────────────────────────────────────────────────

// The template's own header row, asterisks and all — verbatim from the reference workbook.
const TEMPLATE_HEADER = [
  'Date*', 'Company Name', 'ISIN*', 'Trans Type*', 'Quantity*', 'Price*', 'Total Amount (Turnover)',
  'Brokerage Per Share', 'Total Brokerage', 'STT', 'Exchange Turnover Charges', 'Fees', 'IPF Charges', 'Demat Charges',
];

eq('A1 template header resolves every column', () => {
  const h = findHeader([TEMPLATE_HEADER]);
  return h && { hi: h.hi, ...h.ci };
}, { hi: 0, type: 3, date: 0, qty: 4, price: 5, bal: -1, name: 1, isin: 2, amount: 6 });

// The Instructions tab lists Date / Quantity / Price DOWN a Field Name column. If findHeader
// matched a column rather than a row, the reader would pick the wrong sheet and import prose.
const INSTRUCTIONS_GRID = [
  ['How to use the upload template sheet?'],
  [],
  [1, 'Only the columns marked with an asterisk * are compulsory'],
  [2, 'You can upload Holdings and Trades of the portfolios using this template.'],
  [],
  ['Field Name', 'Description', 'Field type', 'Example', 'Mandatory'],
  ['Date', 'Date of trade', 'Date format (DD/MM/YYYY)', '29/02/2023', 'YES'],
  ['Company Name', '', '', '', 'YES'],
  ['Trans Type', 'Trade has been buy or sell', 'Dropdown (BUY/ SELL)', '', 'YES'],
  ['Quantity', 'Quantity of trade, say units', 'Number', 100, 'YES'],
  ['Price', 'Price at which units are bought for trade', 'Number', 250.09, 'YES'],
];
eq('A2 the Instructions sheet is NOT mistaken for the data sheet', () => findHeader(INSTRUCTIONS_GRID), null);

eq('A3 a plain broker header resolves, with no name/isin/turnover', () => {
  const h = findHeader([['Type', 'Date', 'Quantity', 'Price', 'Total Quantity']]);
  return h && { ...h.ci };
}, { type: 0, date: 1, qty: 2, price: 3, bal: 4, name: -1, isin: -1, amount: -1 });

// A bare "Amount" on a broker statement is usually all-in. replayScrip PREFERS amount over
// price, so adopting one would move brokerage into the cost basis of every lot silently.
eq('A4 a bare Amount column is never adopted as turnover', () => {
  const h = findHeader([['Type', 'Date', 'Quantity', 'Price', 'Amount', 'Net Amount']]);
  return h && h.ci.amount;
}, -1);

eq('A5 no header at all', () => findHeader([['a', 'b'], ['c', 'd']]), null);

// ───────────────────────────────────────────────────────────────────────────────────────────
// B. Date cells — an .xlsx date IS a serial; a display string is the thing we must not trust
// ───────────────────────────────────────────────────────────────────────────────────────────

const iso = (v: any) => parseCellDate(v).iso;
const dated = (v: any) => parseCellDate(v).ts > 0;

eq('B1 Excel serial 45747', () => iso(45747), '2025-03-31');
eq('B2 Excel serial 45748 (the day past the cutoff)', () => iso(45748), '2025-04-01');
eq('B3 dd/mm/yyyy', () => iso('31/03/2025'), '2025-03-31');
eq('B4 dd-mm-yyyy', () => iso('31-03-2025'), '2025-03-31');
eq('B5 ISO with a time', () => iso('2025-03-31 09:15:00'), '2025-03-31');
eq('B6 a real Date object', () => iso(new Date(2025, 2, 31)), '2025-03-31');
// A bare year or a quantity in the date column must NOT mint a 1905 lot.
eq('B7 a bare year is not a date', () => dated(2025), false);
eq('B8 an out-of-range serial is not a date', () => dated(100000), false);
eq('B9 junk is not a date', () => dated('n/a'), false);

// ───────────────────────────────────────────────────────────────────────────────────────────
// C. Identity — reject another security, never relabel it
// ───────────────────────────────────────────────────────────────────────────────────────────

eq('C1 a different ISIN is foreign', () => rowIsForeign('', ISIN_B, STOCK, ISIN_A), true);
eq('C2 a matching ISIN wins over a different name', () => rowIsForeign('Reliance Industries', ISIN_A, STOCK, ISIN_A), false);
eq('C3 Ltd vs Limited is the same company', () => rowIsForeign('Sambhv Steel Tubes Ltd.', '', STOCK, ISIN_A), false);
eq('C4 a different name with no ISIN is foreign', () => rowIsForeign('Reliance Industries', '', STOCK, ISIN_A), true);
// "BSE/NSE code/ ISIN" accepts a code or a symbol; neither can decide identity.
eq('C5 a BSE code cannot decide', () => rowIsForeign('', '542752', STOCK, ISIN_A), false);
eq('C6 an NSE symbol cannot decide', () => rowIsForeign('', 'AFFLE', STOCK, ISIN_A), false);
eq('C7 a blank identity is accepted (the page supplies it)', () => rowIsForeign('', '', STOCK, ISIN_A), false);
// Without our own ISIN there is nothing to compare against — fall through to the name.
eq('C8 no ISIN on our side → name decides', () => rowIsForeign('Reliance Industries', ISIN_B, STOCK, ''), true);

// ───────────────────────────────────────────────────────────────────────────────────────────
// D. Reading a filled template
// ───────────────────────────────────────────────────────────────────────────────────────────

const FILLED = [
  TEMPLATE_HEADER,
  ['31/03/2025', STOCK, ISIN_A, 'BUY', 100, 250, 25000, '', '', 25, '', '', '', ''],
  ['01/04/2025', STOCK, ISIN_A, 'BUY', 999, 111, '', '', '', '', '', '', '', ''],       // after cutoff
  ['15/02/2025', 'Reliance Industries', ISIN_B, 'BUY', 5, 1000, '', '', '', '', '', '', '', ''],  // other security
  ['20/01/2025', STOCK, ISIN_A, 'BUY', 50, 100, '', '', '', '', '', '', '', ''],          // no turnover → price
  ['10/01/2025', STOCK, ISIN_A, 'BUY', 10, 100, 1050, '', '', '', '', '', '', ''],        // turnover ≠ qty×price
];
const filled = parseStockTxnGrid(FILLED, STOCK, ISIN_A);

eq('D1 counts', () => ({ total: filled.total, kept: filled.kept, dropped: filled.dropped, foreign: filled.foreign }),
  { total: 5, kept: 3, dropped: 1, foreign: 1 });
eq('D2 the rejected row is named', () => filled.foreignNames, ['Reliance Industries']);
eq('D3 the turnover column is counted where filled', () => filled.amountRows, 2);
eq('D4 and its divergence from qty × price is counted', () => filled.amountDiverged, 1);
eq('D5 every kept row carries the page stock name', () => filled.txns.every(t => t.name === STOCK), true);
eq('D6 the STT column never reaches the row', () => filled.txns[0].amount, 25000);
eq('D7 a blank turnover leaves amount at 0 (price is the basis)', () => filled.txns[1].amount, 0);

// Rows with no identity columns at all — the shape every existing broker CSV has.
const BROKER_CSV = [
  'Type,Date,Quantity,Price,Total Quantity',
  'Buy,10-01-2025,100,50,100',
  'Sell,20-01-2025,40,80,60',
  'Buy,10-06-2025,10,90,70',
].join('\n');
const brokerCsv = parseSingleStockTxnCsv(BROKER_CSV, STOCK, ISIN_A);
eq('D8 a headerless-identity broker CSV still parses', () => ({ kept: brokerCsv.kept, dropped: brokerCsv.dropped, foreign: brokerCsv.foreign }),
  { kept: 2, dropped: 1, foreign: 0 });
eq('D9 semicolon-delimited reads identically', () => parseSingleStockTxnCsv(BROKER_CSV.replace(/,/g, ';'), STOCK, ISIN_A).kept, 2);
eq('D10 tab-delimited reads identically', () => parseSingleStockTxnCsv(BROKER_CSV.replace(/,/g, '\t'), STOCK, ISIN_A).kept, 2);
eq('D11 an empty file says so', () => !!parseSingleStockTxnCsv('', STOCK, ISIN_A).error, true);
eq('D12 an unrecognisable header says so', () => !!parseSingleStockTxnCsv('a,b,c\n1,2,3', STOCK, ISIN_A).error, true);

// ───────────────────────────────────────────────────────────────────────────────────────────
// E. The duplicate guard — re-uploading a file must not double the position
// ───────────────────────────────────────────────────────────────────────────────────────────

const row = (isoDate: string, type: string, qty: number, price: number): TxnStatementRow => ({
  dateStr: isoDate, iso: isoDate, ts: new Date(+isoDate.slice(0, 4), +isoDate.slice(5, 7) - 1, +isoDate.slice(8, 10)).getTime(),
  type, name: STOCK, qty, price, amount: 0, balQty: 0,
});

const onSheet = [row('2024-01-10', 'BUY', 100, 50), row('2024-02-10', 'SELL', 40, 80)];
eq('E1 a re-upload of the same rows adds nothing', () => dedupeAgainstExisting(onSheet, onSheet.slice()).fresh.length, 0);
eq('E2 ...and says how many it skipped', () => dedupeAgainstExisting(onSheet, onSheet.slice()).duplicates, 2);
eq('E3 a genuinely new row survives', () => dedupeAgainstExisting(onSheet, [row('2024-03-10', 'BUY', 5, 60)]).fresh.length, 1);
// Only date+type+qty+price decide, so a re-export that differs in price is NOT the same trade.
eq('E4 a different price is a different trade', () => dedupeAgainstExisting(onSheet, [row('2024-01-10', 'BUY', 100, 51)]).fresh.length, 1);
// Two identical fills on one day are real; the guard only compares against what is on the sheet.
eq('E5 duplicates WITHIN one upload are both kept', () => {
  const two = [row('2024-05-10', 'BUY', 10, 20), row('2024-05-10', 'BUY', 10, 20)];
  return dedupeAgainstExisting([], two).fresh.length;
}, 2);
eq('E6 "Buy" and "BUY" are one trade', () => dedupeAgainstExisting([row('2024-01-10', 'Buy', 100, 50)], [row('2024-01-10', 'BUY', 100, 50)]).fresh.length, 0);
eq('E7 the key is stable across a float re-parse', () => txnKey(row('2024-01-10', 'BUY', 0.1 + 0.2, 50)) === txnKey(row('2024-01-10', 'BUY', 0.3, 50)), true);

// ───────────────────────────────────────────────────────────────────────────────────────────
// F. THE MERGE — adding a batch on top of lots already on the sheet
// ───────────────────────────────────────────────────────────────────────────────────────────

// 100 shares bought at ₹10 in 2020, already reconciled onto Opening Holdings.
const SEED: SeedLot[] = [{ name: STOCK, isin: ISIN_A, acqDate: '2020-01-01', qty: 100, costPerShare: 10, note: 'Opening (2020-01-01)' }];

// The batch being added: sell 40 of those, then buy 60 more.
const BATCH = [row('2024-06-01', 'SELL', 40, 90), row('2024-07-01', 'BUY', 60, 50)];

const merged = reconstructStockOpening(BATCH, ISIN_A, SEED);
// 60 of the 2020 lot survive (₹600) + 60 new at ₹50 (₹3,000).
close('F1 the sell consumes the EXISTING lot, not nothing', () => merged.qty, 120);
close('F2 ...and the surviving basis is both lots', () => merged.invested, 3600, 0.01);
eq('F3 two lots, the old one still dated 2020', () => merged.lots.map(l => l.acqDate), ['2020-01-01', '2024-07-01']);
close('F4 the 2020 lot kept its own cost', () => merged.lots[0].costPerShare, 10);
close('F5 ...and is what the sell shrank', () => merged.lots[0].qty, 60);
eq('F6 holding period is per lot, not per import', () => merged.lots.map(l => l.longTerm), [true, false]);
eq('F7 a clean replay reports no issues', () => merged.issues.length, 0);

// The probe: the SAME batch reconstructed on its own — what a lot-append would have produced.
// Disjoint from F1/F2 in both numbers, so F cannot pass under the wrong implementation.
const standalone = reconstructStockOpening(BATCH, ISIN_A, []);
close('F8 PROBE — without the seed the sell evaporates', () => standalone.qty, 60);
close('F9 PROBE — ...and the basis is the new buy alone', () => standalone.invested, 3000, 0.01);
eq('F10 PROBE — ...and the replay flags the oversell', () => standalone.issues.length > 0, true);

// Buy-only: the common case. Nothing is consumed, both lots stand.
const buyOnly = reconstructStockOpening([row('2024-07-01', 'BUY', 50, 20)], ISIN_A, SEED);
close('F11 a buy-only batch adds without touching the old lot', () => buyOnly.qty, 150);
close('F12 ...and its basis', () => buyOnly.invested, 2000, 0.01);

// A sell that takes the whole existing position leaves nothing — and must not go negative.
const soldOut = reconstructStockOpening([row('2024-06-01', 'SELL', 100, 90)], ISIN_A, SEED);
close('F13 selling out leaves zero, not a negative lot', () => soldOut.qty, 0);
eq('F14 ...and no lots at all', () => soldOut.lots.length, 0);

// Intraday square-off still applies with a seed: a same-day round trip must not bury the lot.
const roundTrip = reconstructStockOpening([row('2024-06-01', 'BUY', 30, 50), row('2024-06-01', 'SELL', 30, 55)], ISIN_A, SEED);
close('F15 a same-day round trip leaves the position untouched', () => roundTrip.qty, 100);
eq('F16 ...and raises no oversell', () => roundTrip.issues.length, 0);

// The turnover column must survive the square-off into the lot's cost.
const viaTurnover = reconstructStockOpening(
  [{ ...row('2024-07-01', 'BUY', 10, 100), amount: 1050 }], ISIN_A, [],
);
close('F17 turnover ÷ qty becomes the cost per share', () => viaTurnover.lots[0].costPerShare, 105);

// ───────────────────────────────────────────────────────────────────────────────────────────
// G. The FIFO-order warning
// ───────────────────────────────────────────────────────────────────────────────────────────

eq('G1 buys older than the seed + a sell → out of order', () => batchIsOutOfOrder(SEED, [row('2019-01-01', 'BUY', 10, 5), row('2024-06-01', 'SELL', 5, 90)]), true);
eq('G2 the same buys with no sell are harmless', () => batchIsOutOfOrder(SEED, [row('2019-01-01', 'BUY', 10, 5)]), false);
eq('G3 newer buys with a sell are fine', () => batchIsOutOfOrder(SEED, [row('2024-06-01', 'BUY', 10, 5), row('2024-07-01', 'SELL', 5, 90)]), false);
eq('G4 nothing on the sheet yet → nothing to get out of order', () => batchIsOutOfOrder([], [row('2019-01-01', 'BUY', 10, 5), row('2024-06-01', 'SELL', 5, 90)]), false);
eq('G5 a sell-only batch is in order', () => batchIsOutOfOrder(SEED, [row('2024-06-01', 'SELL', 5, 90)]), false);

// ───────────────────────────────────────────────────────────────────────────────────────────
// H. ROUND TRIP — build the shipped template, read it back through the shipped reader
//
// Everything above tests the reader against a hand-typed header. This is the one check that
// the template we HAND OUT is a file this app can read: rename a column in openingTemplate.ts
// away from findHeader's keywords and the app ships a sample it rejects, under a green suite.
// ───────────────────────────────────────────────────────────────────────────────────────────

async function templateRoundTrip(): Promise<void> {
  const { buildOpeningTemplateBlob } = await import('./src/lib/openingTemplate');
  const XLSX: any = await import('xlsx');

  const blob = await buildOpeningTemplateBlob(STOCK, ISIN_A);
  const wb = XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
  const gridOf = (sn: string) => XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, blankrows: false }) as any[][];

  eq('H1 two tabs, data first', () => wb.SheetNames, ['Equity Trades template', 'Instructions']);

  const dataGrid = gridOf(wb.SheetNames[0]);
  eq('H2 the shipped data tab resolves every column', () => {
    const h = findHeader(dataGrid);
    return h && { hi: h.hi, ...h.ci };
  }, { hi: 0, type: 3, date: 0, qty: 4, price: 5, bal: -1, name: 1, isin: 2, amount: 6 });

  eq('H3 the shipped Instructions tab is skipped, not imported', () => findHeader(gridOf(wb.SheetNames[1])), null);
  eq('H4 the shipped tab ships EMPTY — no phantom trade to import', () => dataGrid.length, 1);

  // Fill the shipped header with real rows and run them through the real reader.
  const filledFromShipped = parseStockTxnGrid([
    dataGrid[0],
    ['15/01/2025', STOCK, ISIN_A, 'BUY', 100, 250, 25000, 0.5, 50, 25, 3, 1, 0.2, 15],
    ['20/02/2025', 'Reliance Industries', ISIN_B, 'SELL', 5, 1000, 5000, '', '', '', '', '', '', ''],
    ['12/09/2025', STOCK, ISIN_A, 'BUY', 7, 300, '', '', '', '', '', '', '', ''],
  ], STOCK, ISIN_A);

  eq('H5 a filled shipped template reads correctly', () =>
    ({ kept: filledFromShipped.kept, dropped: filledFromShipped.dropped, foreign: filledFromShipped.foreign }),
    { kept: 1, dropped: 1, foreign: 1 });
  close('H6 the turnover column drives the basis', () => filledFromShipped.txns[0].amount, 25000);
  // The charge columns sit to the RIGHT of turnover; if any of them leaked into the row the
  // cost per share would not be 250.
  close('H7 not one charge column reaches the cost basis', () =>
    reconstructStockOpening(filledFromShipped.txns, ISIN_A, []).lots[0].costPerShare, 250);
  close('H8 ...nor the invested total', () =>
    reconstructStockOpening(filledFromShipped.txns, ISIN_A, []).invested, 25000, 0.01);
}

// ───────────────────────────────────────────────────────────────────────────────────────────

await templateRoundTrip().catch((e: any) => { fail++; failures.push(`H round trip — threw: ${e?.message || e}`); });


// ── I. The duplicate guard counts, it does not merely recognise ─────────────────────────────
//
// Two identical fills on one day are real — one broker order split across two contract notes.
// The guard used a Set of existing keys, so ONE such row already on the sheet masked EVERY
// incoming row sharing its key. The difference is "one of your three is already filed" versus
// "none of your three will be added", which is the shape the owner reported on 16-Sep-2026.
{
  const sheetHasOne = [row('2024-05-02', 'BUY', 10, 100)];
  const fileHasThree = [
    row('2024-05-02', 'BUY', 10, 100),
    row('2024-05-02', 'BUY', 10, 100),
    row('2024-05-02', 'BUY', 10, 100),
  ];
  eq('I1 one existing row masks exactly ONE of three identical incoming rows',
    () => dedupeAgainstExisting(sheetHasOne, fileHasThree).fresh.length, 2);
  eq('I2 ...and counts one duplicate, not three',
    () => dedupeAgainstExisting(sheetHasOne, fileHasThree).duplicates, 1);
  eq('I3 two on the sheet mask two',
    () => dedupeAgainstExisting([...sheetHasOne, ...sheetHasOne], fileHasThree).fresh.length, 1);
  eq('I4 three on the sheet mask all three',
    () => dedupeAgainstExisting([...sheetHasOne, ...sheetHasOne, ...sheetHasOne], fileHasThree).fresh.length, 0);
  eq('I5 nothing on the sheet masks nothing',
    () => dedupeAgainstExisting([], fileHasThree).fresh.length, 3);
}

// ── J. Bonus / Rights rows are CREDITED, and nothing is dropped in silence ───────────────────
//
// Reported 16-Sep-2026: "it is not adding the trades I asked it to via excel." The cause was
// `replayScrip` deriving a corp action's share count from a stored RATIO while this importer
// passes `{}` as the resolutions map — so every Bonus / Split / Rights row was parsed, counted
// as "for this stock", WRITTEN to Opening Txns, and then contributed nothing at all. The
// position came out short, and re-uploading could never fix it because the row was by then a
// duplicate of itself.
//
// A row on this template does not need a ratio: it carries a QUANTITY the owner typed.
{
  // The owner's own NSE shape, off their filed ITR schedule: 24,000 held, a 96,000 share
  // allotment at nil cost on 11-Nov-2024, then 24,000 sold. The filed closing is 96,000.
  const nse = [
    row('2023-06-15', 'BUY', 24000, 3018.28),
    row('2024-11-11', 'BONUS', 96000, 0),
    row('2025-01-20', 'SELL', 24000, 1690.69),
  ];
  const built = reconstructStockOpening(nse, 'INE721A01013');
  // DISJOINT from the old behaviour, which silently dropped the bonus row and left the sells
  // consuming everything: 0 shares, which is exactly what the owner was shown.
  close('J1 the bonus is credited, so the filed 96,000 survives', () => built.qty, 96000);
  eq('J2 ...and it is reported, not applied behind the owner\'s back', () => built.corpActions.credited.length, 1);
  eq('J3 ...naming the date and quantity', () => built.corpActions.credited[0].iso, '2024-11-11');
  close('J4 ...at the quantity typed on the row', () => built.corpActions.credited[0].qty, 96000);
  eq('J5 ...at NO cost', () => built.corpActions.credited[0].price, 0);
  eq('J6 nothing was ignored', () => built.corpActions.ignored.length, 0);
  // The cost is the original purchase alone — bonus shares add shares, never basis.
  close('J7 the bonus adds shares but no cost', () => Math.round(built.invested), Math.round(24000 * 3018.28 - 24000 * 3018.28));

  // The control: strip the bonus row and the position collapses to zero, which is the number
  // the owner was actually shown. Without this the fixture would pass on a bonus that was
  // ignored but happened to leave shares behind for some other reason.
  const withoutBonus = reconstructStockOpening(nse.filter(r => r.type !== 'BONUS'), 'INE721A01013');
  close('J8 CONTROL: with no bonus row the position is 0 — the reported symptom', () => withoutBonus.qty, 0);
}

// A RIGHTS row is a PAID credit: its price is the cost basis, not zero.
{
  const built = reconstructStockOpening([
    row('2024-02-01', 'BUY', 1000, 100),
    row('2024-08-01', 'RIGHTS', 500, 60),
  ], '');
  close('J9 rights are credited at their quantity', () => built.qty, 1500);
  close('J10 ...and cost what the row says', () => Math.round(built.invested), 100000 + 30000);
  eq('J11 ...reported at that price, not zeroed like a bonus', () => built.corpActions.credited[0].price, 60);
}

// A statement that carries BOTH a Bonus line and a same-day ₹0 share credit describes ONE
// event. Crediting both doubles the position.
{
  const built = reconstructStockOpening([
    row('2024-01-01', 'BUY', 1000, 10),
    row('2024-06-01', 'BONUS', 1000, 0),
    row('2024-06-01', 'BUY', 1000, 0),      // the accompanying credit for the SAME shares
  ], '');
  close('J12 a bonus accompanied by a same-day zero-price credit is NOT doubled', () => built.qty, 2000);
  eq('J13 ...and the corp-action row is not reported as credited', () => built.corpActions.credited.length, 0);
}

// A SPLIT is NOT credited from its quantity: that column is ambiguous (shares added, or the
// resulting total?) and guessing doubles or halves a position. Ignored — and SAID.
{
  const built = reconstructStockOpening([
    row('2024-01-01', 'BUY', 100, 500),
    row('2024-09-01', 'SPLIT', 900, 0),
  ], '');
  close('J14 a split adds no shares', () => built.qty, 100);
  eq('J15 ...and is REPORTED as unapplied rather than dropped quietly', () => built.corpActions.ignored.length, 1);
  eq('J16 ...naming what it was', () => built.corpActions.ignored[0].kind, 'SPLIT');
  eq('J17 ...and why', () => /ambiguous/.test(built.corpActions.ignored[0].reason), true);
}

// A bonus with no quantity has nothing to credit AND no ratio to derive one from. It must say
// so rather than look like it worked.
{
  const built = reconstructStockOpening([
    row('2024-01-01', 'BUY', 100, 500),
    row('2024-09-01', 'BONUS', 0, 0),
  ], '');
  close('J18 a quantity-less bonus adds nothing', () => built.qty, 100);
  eq('J19 ...and is reported', () => built.corpActions.ignored.length, 1);
  eq('J20 ...as a bonus with no quantity', () => /no quantity/.test(built.corpActions.ignored[0].reason), true);
}

// A BONUS row that CARRIES A PRICE is noise — a mistake, or a notional figure some broker
// exports. Bonus shares are free by definition, so that price must never reach the cost basis:
// letting it in inflates the basis and under-reports every later gain, silently and forever.
// (Added because the probe that swaps `price: 0` for `t.price` originally changed nothing —
// every bonus fixture happened to have a zero price already, so the rule was unpinned.)
{
  const built = reconstructStockOpening([
    row('2024-01-01', 'BUY', 100, 500),
    row('2024-09-01', 'BONUS', 100, 250),
  ], '');
  close('J27 a priced bonus row is still credited', () => built.qty, 200);
  close('J28 ...at NIL cost, not at the price on the row', () => Math.round(built.invested), 50000);
  eq('J29 ...and reported as costing nothing', () => built.corpActions.credited[0].price, 0);
}

// A corporate action landing on the SAME DAY as a sale must not be netted against it.
// `squareOffDaily` implements the intraday square-off convention — a same-day buy and sell in a
// trading account cancel — and a bonus allotment is not a trade. The owner's NSE file sells on
// 11-Nov-2024, the very day 96,000 bonus shares were allotted.
//
// Both answers hold the same 118,000 shares, so only the COST BASIS tells them apart, and the
// two are disjoint: FIFO must consume the older PRICED lot (66,402,160 left) rather than net
// the free shares away (72,438,720 left). Their filed return puts NSE's closing cost at nil,
// which is the un-netted reading.
{
  const built = reconstructStockOpening([
    row('2023-06-15', 'BUY', 24000, 3018.28),
    row('2024-11-11', 'BONUS', 96000, 0),
    row('2024-11-11', 'SELL', 2000, 1555),
  ], '');
  close('J30 a same-day bonus and sale both stand', () => built.qty, 118000);
  close('J31 ...and the SALE consumes the older priced lot, not the free shares',
    () => Math.round(built.invested), Math.round(22000 * 3018.28));
}

// The pure helper on its own, so the conversion is pinned independently of the replay.
{
  const { rows, credited, report } = creditCorpActionRows([
    row('2024-01-01', 'BUY', 10, 5),
    row('2024-02-01', 'BONUS', 20, 0),
    row('2024-03-01', 'SPLIT', 30, 0),
  ]);
  // The credit is handed back SEPARATELY, not spliced into the trades. That separation is what
  // keeps it out of `squareOffDaily` — see J30.
  eq('J21 ordinary trades come back on their own', () => rows.map(r => r.type), ['BUY']);
  eq('J22 the bonus comes back as a BUY, carrying its own quantity', () => credited[0].qty, 20);
  eq('J23 ...at zero price', () => credited[0].price, 0);
  eq('J24 the split is in NEITHER list', () => [...rows, ...credited].some(r => r.type === 'SPLIT'), false);
  eq('J25 ...and appears in the ignored list instead', () => report.ignored.length, 1);
  eq('J26 ordinary rows pass through untouched', () => rows[0].qty, 10);
}

console.log(`\nopening-import: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
