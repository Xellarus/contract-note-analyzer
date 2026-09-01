/**
 * FIFO lot-ordering guard.
 *
 * Every FIFO engine seeds its queue from Opening Holdings, sorts ONCE, then pushes later
 * buys onto the end. That is correct only while every pushed lot is newer than every seeded
 * one. A BACK-DATED buy - which the cross-portfolio transfer feature introduces, because the
 * receiving row carries the ORIGINAL acquisition date - makes the queue [2024-seed, 2019-buy]
 * and the next sale consumes the WRONG lot: wrong cost basis and wrong holding period, in a
 * filed capital-gains register.
 *
 * `npx tsc --noEmit` and `npx vite build` are both blind to it, so this file is the guard.
 */
import { replayFifoHoldings, insertLotByTs, squareOffIntraday } from './src/lib/holdingsCalc';
import { ledgerSide, isTransferType, isTransferOut, XFER_IN_TYPE, XFER_OUT_TYPE } from './src/lib/tradeRowSchema';
import { planTransfer, buildTransferRecords, buildSaleRecords } from './src/lib/transferHolding';

let pass = 0, fail = 0;
const eq = (label: string, got: any, want: any, tol = 0) => {
  const ok = typeof want === 'number' && typeof got === 'number'
    ? Math.abs(got - want) <= tol
    : got === want;
  if (ok) { pass++; } else {
    fail++;
    console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
};

const ts = (iso: string) => new Date(iso + 'T00:00:00Z').getTime();

// ── insertLotByTs itself ──────────────────────────────────────────────────────
{
  const a: { ts: number }[] = [];
  [3, 1, 5, 2, 4].forEach((n) => insertLotByTs(a, { ts: n }, (l) => l.ts));
  eq('insert keeps ascending order', a.map((l) => l.ts).join(','), '1,2,3,4,5');

  const b: { ts: number }[] = [];
  [1, 2, 3].forEach((n) => insertLotByTs(b, { ts: n }, (l) => l.ts));
  eq('already-ordered input is untouched', b.map((l) => l.ts).join(','), '1,2,3');

  const c: { ts: number; tag: string }[] = [];
  insertLotByTs(c, { ts: 5, tag: 'first' }, (l) => l.ts);
  insertLotByTs(c, { ts: 5, tag: 'second' }, (l) => l.ts);
  // Equal timestamps must keep insertion order - FIFO within a day is arrival order.
  eq('ties keep insertion order', c.map((l) => l.tag).join(','), 'first,second');
}

// ── the real bug: a back-dated buy behind a seeded lot ────────────────────────
{
  // B already holds an opening lot: 100 @ Rs.200, acquired 2024-06-01.
  const seed = new Map([['X', [{ qty: 100, price: 200, ts: ts('2024-06-01') }]]]);
  // A transfer arrives carrying its ORIGINAL acquisition date, 2019-07-04, at Rs.50.
  const out = replayFifoHoldings(seed, [
    { kind: 'BUY', key: 'X', ts: ts('2019-07-04'), qty: 100, price: 50 },
    { kind: 'SELL', key: 'X', ts: ts('2026-08-31'), qty: 100 },
  ]);
  const x = out.get('X')!;
  eq('net qty after selling half', x.netQty, 100);
  // FIFO must consume the OLDEST lot - the 2019 one at Rs.50 - leaving the 2024 lot at
  // Rs.200. Getting 5,000 here means the queue was [2024, 2019] and the wrong lot went.
  eq('oldest (back-dated) lot consumed first', x.invested, 100 * 200);
}

// ── unchanged behaviour for ordinary, in-date-order data ──────────────────────
{
  const seed = new Map([['Y', [{ qty: 50, price: 10, ts: ts('2024-01-01') }]]]);
  const out = replayFifoHoldings(seed, [
    { kind: 'BUY', key: 'Y', ts: ts('2025-05-01'), qty: 50, price: 30 },
    { kind: 'SELL', key: 'Y', ts: ts('2026-01-01'), qty: 50 },
  ]);
  const y = out.get('Y')!;
  eq('in-order: qty', y.netQty, 50);
  eq('in-order: oldest consumed, newer lot survives', y.invested, 50 * 30);
}

// ── a back-dated lot must also be sellable in its own right ───────────────────
{
  const seed = new Map([['Z', [{ qty: 10, price: 100, ts: ts('2024-06-01') }]]]);
  const out = replayFifoHoldings(seed, [
    { kind: 'BUY', key: 'Z', ts: ts('2019-01-01'), qty: 10, price: 20 },
    { kind: 'SELL', key: 'Z', ts: ts('2026-01-01'), qty: 15 },
  ]);
  const z = out.get('Z')!;
  eq('partial across two lots: qty', z.netQty, 5);
  // 10 from the 2019 lot + 5 from the 2024 lot -> 5 left of the 2024 lot @ 100.
  eq('partial across two lots: invested', z.invested, 5 * 100);
}

// ── the transfer vocabulary ───────────────────────────────────────────────────
{
  // The canonical labels move shares in the right direction.
  eq('Transfer In  -> BUY', ledgerSide(XFER_IN_TYPE), 'BUY');
  eq('Transfer Out -> SELL', ledgerSide(XFER_OUT_TYPE), 'SELL');
  eq('Transfer In  is a transfer', isTransferType(XFER_IN_TYPE), true);
  eq('Transfer Out is a transfer', isTransferType(XFER_OUT_TYPE), true);
  eq('Transfer Out is the OUT leg', isTransferOut(XFER_OUT_TYPE), true);
  eq('Transfer In is NOT the OUT leg', isTransferOut(XFER_IN_TYPE), false);
  eq('case and spacing tolerated', ledgerSide('  transfer   out '), 'SELL');

  // Trap label: must NOT be dragged buy-side by RIGHT as a rights issue, and must still
  // count as a transfer so no capital gain is booked against it.
  eq('Transfer In (Rights) -> BUY', ledgerSide('Transfer In (Rights)'), 'BUY');
  eq('Transfer In (Rights) is a transfer', isTransferType('Transfer In (Rights)'), true);

  // Trap label: genuinely ambiguous, so it stays a PLAIN TAXABLE SALE rather than
  // escaping capital gains through a loose /transfer/ test.
  eq('Transfer Sale -> SELL', ledgerSide('Transfer Sale'), 'SELL');
  eq('Transfer Sale is NOT a transfer', isTransferType('Transfer Sale'), false);

  // Neither in nor out: unclassified, so engines skip rather than guess a direction.
  eq('bare Transfer is unclassified', ledgerSide('Transfer'), '');
  eq('Transfer Into does not satisfy the IN form', ledgerSide('Transfer Into'), '');

  // Every pre-existing label keeps its meaning - this classifier is on every ledger read.
  eq('Buy unchanged', ledgerSide('Buy'), 'BUY');
  eq('Sell unchanged', ledgerSide('Sell'), 'SELL');
  eq('Bonus unchanged', ledgerSide('Bonus'), 'BUY');
  eq('Split unchanged', ledgerSide('Split'), 'BUY');
  eq('Rights unchanged', ledgerSide('Rights'), 'BUY');
  eq('Buyback unchanged', ledgerSide('Buyback'), 'SELL');
  eq('IPO unchanged', ledgerSide('IPO'), 'BUY');
  eq('blank unchanged', ledgerSide(''), '');
  eq('Bonus is not a transfer', isTransferType('Bonus'), false);
  eq('Sell is not a transfer', isTransferType('Sell'), false);
}

// ── the same-day square-off must never net a transfer against a trade ─────────
{
  const key = () => 'K';
  const day = ts('2026-08-31');
  const mk = (type: string, qty: number, price: number, xfer?: boolean) =>
    ({ ts: day, idx: 0, isin: '', name: 'K', type, qty, price, xfer });

  // An ORDINARY same-day buy + sell of equal size IS a round-trip: it nets to nothing and
  // is booked as intraday. This is existing behaviour and must not change.
  const roundTrip = squareOffIntraday([mk('BUY', 100, 10), mk('SELL', 100, 12)], key);
  eq('ordinary same-day buy+sell still nets to zero', roundTrip.length, 0);

  // Buy 100 today, transfer 100 out today. WITHOUT the exemption these net to zero: the
  // transfer disappears from the holding and the matched qty is emitted as an intraday
  // round-trip - speculative business income for a disposal that never happened.
  const withXfer = squareOffIntraday([mk('BUY', 100, 10), mk('SELL', 100, 0, true)], key);
  eq('buy + same-day transfer survive as two rows', withXfer.length, 2);
  eq('the transfer leg is still flagged', withXfer.filter((t) => t.xfer).length, 1);
  eq('the buy leg is untouched', withXfer.filter((t) => t.type === 'BUY' && !t.xfer).length, 1);

  // A transfer IN on the same day as a sell must not net either.
  const inLeg = squareOffIntraday([mk('BUY', 50, 10, true), mk('SELL', 50, 11)], key);
  eq('transfer-in + same-day sell survive as two rows', inLeg.length, 2);
}

// ── FIFO selection for a transfer ─────────────────────────────────────────────
{
  const avail = [
    { acquiredDMY: '04/07/2019', remaining: 600, purPrice: 50, inclPrice: 50.4 },
    { acquiredDMY: '01/06/2024', remaining: 800, purPrice: 200, inclPrice: 201.5 },
  ];

  const exact = planTransfer(avail, 600);
  eq('exact single lot: one lot', exact.lots.length, 1);
  eq('exact single lot: qty', exact.qty, 600);
  eq('exact single lot: no shortfall', exact.shortfall, 0);
  eq('exact single lot: oldest taken', exact.lots[0].acquiredDMY, '04/07/2019');

  // 1,000 shares must SPLIT the second lot: 600 @ 2019 + 400 @ 2024.
  const span = planTransfer(avail, 1000);
  eq('spanning: two lots', span.lots.length, 2);
  eq('spanning: total qty', span.qty, 1000);
  eq('spanning: first lot qty', span.lots[0].qty, 600);
  eq('spanning: second lot partial', span.lots[1].qty, 400);
  eq('spanning: dates preserved per lot', span.lots.map((l) => l.acquiredDMY).join('|'), '04/07/2019|01/06/2024');
  eq('spanning: costs preserved per lot', span.lots.map((l) => l.purPrice).join('|'), '50|200');

  // Asking for more than held must REPORT a shortfall, never quietly transfer less.
  const over = planTransfer(avail, 2000);
  eq('over-request: takes everything available', over.qty, 1400);
  eq('over-request: reports the shortfall', over.shortfall, 600);

  // Empty and exhausted lots are skipped rather than producing zero-qty rows.
  const withEmpty = planTransfer(
    [{ acquiredDMY: '01/01/2020', remaining: 0, purPrice: 10 }, ...avail], 100);
  eq('zero-remaining lot skipped', withEmpty.lots[0].acquiredDMY, '04/07/2019');

  // A lot with no recorded all-in cost falls back to its charge-free cost, not to zero -
  // a zero basis would book 100% of a later sale as capital gain.
  const noIncl = planTransfer([{ acquiredDMY: '01/01/2020', remaining: 10, purPrice: 42 }], 10);
  eq('missing inclPrice falls back to purPrice', noIncl.lots[0].inclPrice, 42);
}

// ── the two legs, and the columns each engine reads ───────────────────────────
{
  const plan = planTransfer([
    { acquiredDMY: '04/07/2019', remaining: 600, purPrice: 50, inclPrice: 50.4 },
    { acquiredDMY: '01/06/2024', remaining: 800, purPrice: 200, inclPrice: 201.5 },
  ], 1000);

  const { outRecords, inRecords } = buildTransferRecords({
    plan, securityName: 'ORIENT ELECTRIC LIMITED', isin: 'INE142Z01019',
    transferDMY: '31/08/2026', fromLabel: 'Saket Agarwal (Axis)', toLabel: 'Sagun Capital',
    transferRef: 'XFER-TEST-1',
  });

  eq('one OUT row per lot', outRecords.length, 2);
  eq('one IN row per lot', inRecords.length, 2);

  // THE CRUX: the OUT leg is dated when the shares left; the IN leg carries the ORIGINAL
  // acquisition date, which is what preserves the long-term holding period.
  eq('OUT dated the transfer date', outRecords[0].date, '2026-08-31');
  eq('IN dated the ORIGINAL acquisition date', inRecords[0].date, '2019-07-04');
  eq('IN second lot keeps its own date', inRecords[1].date, '2024-06-01');

  // Charge-free basis for the capital-gains engines.
  eq('turnover is the CHARGE-FREE cost', inRecords[0].turnover, 600 * 50);
  // All-in carried cost for the Holding tab's invested figure.
  eq('withExpInclSTT is the ALL-IN cost', inRecords[0].totalWithExpInclSTT, 600 * 50.4);
  eq('the two cost columns genuinely differ', inRecords[0].turnover !== inRecords[0].totalWithExpInclSTT, true);

  // No new charges are incurred by moving shares, and copying the source's charges would
  // count the same brokerage as a cost in two portfolios' registers.
  for (const k of ['brokerage', 'stt', 'exchangeCharges', 'sebiFees', 'gst', 'stampDuty', 'ipf']) {
    eq(`no ${k} on a transfer row`, inRecords[0][k], 0);
  }

  eq('OUT type is the canonical label', outRecords[0].txType, 'Transfer Out');
  eq('IN type is the canonical label', inRecords[0].txType, 'Transfer In');
  eq('OUT classifies as SELL', ledgerSide(outRecords[0].txType), 'SELL');
  eq('IN classifies as BUY', ledgerSide(inRecords[0].txType), 'BUY');
  eq('OUT is recognised as a transfer', isTransferType(outRecords[0].txType), true);
  eq('IN is recognised as a transfer', isTransferType(inRecords[0].txType), true);

  eq('never tagged Intraday', inRecords[0].tradeClass, 'Delivery');
  eq('OUT note names the destination', /Sagun Capital/.test(outRecords[0].notes), true);
  eq('IN note names the source', /Saket Agarwal \(Axis\)/.test(inRecords[0].notes), true);
  eq('every row carries the transfer ref', [...outRecords, ...inRecords].every((r) => r.importId === 'XFER-TEST-1'), true);
  eq('quantities tie to the plan', inRecords.reduce((s, r) => s + r.qty, 0), 1000);
}

// ── the taxable variant is an ordinary disposal ───────────────────────────────
{
  const plan = planTransfer([{ acquiredDMY: '04/07/2019', remaining: 600, purPrice: 50 }], 600);
  const { outRecords, inRecords } = buildSaleRecords({
    plan, securityName: 'X', isin: '', transferDMY: '31/08/2026',
    fromLabel: 'A', toLabel: 'B', transferRef: 'XFER-SALE-1', salePrice: 300,
  });
  eq('sale: single OUT row', outRecords.length, 1);
  eq('sale: uses Sell, not Transfer Out', outRecords[0].txType, 'Sell');
  eq('sale: uses Buy, not Transfer In', inRecords[0].txType, 'Buy');
  eq('sale: NOT treated as a transfer', isTransferType(outRecords[0].txType), false);
  eq('sale: buyer dated the transfer date (clock restarts)', inRecords[0].date, '2026-08-31');
  eq('sale: turnover at the agreed price', outRecords[0].turnover, 600 * 300);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
