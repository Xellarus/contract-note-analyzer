/**
 * Axis Securities parser check.
 *
 * The fixture is READ AT RUNTIME from the gitignored `*.extracted.txt` produced by
 * tmp-extract.mjs — deliberately NOT pasted into this file. A contract note carries a
 * PAN, a home address and a full trade history, and this file is tracked by git
 * (`tmp-nuvama.ts` embeds one, which is how a client's PAN reached a public repo).
 * Same rule as CLAUDE.md: contract notes never leave the machine.
 *
 * Regenerate the fixture with:
 *   node tmp-extract.mjs "C:/path/to/6150725 - Contract Note.pdf"
 */
import * as fs from 'fs';
import * as path from 'path';
import { AxisBrokerStrategy } from './src/lib/brokers/axis';

const FIXTURE = process.env.AXIS_FIXTURE || '6150725 - Contract Note.extracted.txt';

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
const ok = (label: string, cond: boolean) => eq(label, !!cond, true);

const run = async () => {
  const p = path.resolve(FIXTURE);
  if (!fs.existsSync(p)) {
    console.log(`SKIPPED - fixture not found: ${FIXTURE}`);
    console.log('Generate it with:  node tmp-extract.mjs "<axis note>.pdf"');
    return;
  }
  const text = fs.readFileSync(p, 'utf8');
  const axis = new AxisBrokerStrategy();

  ok('detect() claims the note', axis.detect(text, true));

  const res = await axis.parsePdfText(text);
  if (!res) {
    console.log('  FAIL parsePdfText returned null');
    console.log(`\n${pass} passed, ${fail + 1} failed`);
    process.exitCode = 1;
    return;
  }

  // ── shape ────────────────────────────────────────────────────────────────────
  eq('brokerName', res.brokerName, 'axis');
  eq('ucc', res.ucc, '6150725');
  eq('noteCount (5 notes in one pdf)', res.noteCount, 5);
  eq('dateRange.from', res.dateRange?.from, '31/07/2024');
  eq('dateRange.to', res.dateRange?.to, '03/03/2025');
  eq('tradeDate = latest', res.tradeDate, '03/03/2025');

  // 6 scrip+side groups: ORIENT buy, ORIENT sell, ADANI buy, ADANI sell, BAAZAR buy, BAAZAR sell
  eq('trade count', res.trades.length, 6);

  // ── the SEBI registration trap ───────────────────────────────────────────────
  // "SEBI Reg. No.: NSE,BSE,MCX,NCDEX - INZ000161633" is on every note and satisfies
  // the ISIN pattern. It must never become a scrip.
  ok('no trade carries the broker SEBI reg as an ISIN',
    !res.trades.some((t) => (t.isin || '').toUpperCase() === 'INZ000161633'));
  ok('every trade has a real INE ISIN', res.trades.every((t) => /^INE[A-Z0-9]{9}$/.test(t.isin || '')));

  // ── names cleaned of the "-Cash-" marker and the glued ISIN ──────────────────
  const names = [...new Set(res.trades.map((t) => t.securityName))].sort();
  eq('distinct security names', names.length, 3);
  ok('no name still carries "Cash"', !names.some((n) => /cash/i.test(n)));
  ok('no name still carries an ISIN', !names.some((n) => /IN[A-Z0-9]{9}[0-9]/.test(n)));
  eq('name[0]', names[0], 'ADANI WILMAR LIMITED');
  eq('name[1]', names[1], 'BAAZAR STYLE RETAIL LTD');
  eq('name[2]', names[2], 'ORIENT ELECTRIC LIMITED');

  // ── per-note figures, all taken from the note's own printed totals ───────────
  // [date, isin, side, qty, turnover(gross), stt]
  const expect: [string, string, string, number, number, number][] = [
    ['31/07/2024', 'INE142Z01019', 'Buy',  10000, 2929961.10, 2930.00],
    ['02/08/2024', 'INE142Z01019', 'Sell', 10000, 2780176.05, 2780.00],
    ['05/08/2024', 'INE699H01024', 'Buy',  10000, 3928740.75, 3929.00],
    ['23/10/2024', 'INE699H01024', 'Sell', 10000, 3150000.00, 0],
    ['23/10/2024', 'INE01FR01028', 'Buy',  10000, 3400132.00, 0],
    ['03/03/2025', 'INE01FR01028', 'Sell', 10000, 2062678.70, 2063.00],
  ];
  for (const [date, isin, side, qty, turnover, stt] of expect) {
    const t = res.trades.find((x) => x.tradeDate === date && x.isin === isin && x.transactionType === side);
    if (!t) { fail++; console.log(`  FAIL missing trade ${date} ${isin} ${side}`); continue; }
    eq(`${date} ${isin} ${side} qty`, t.quantity, qty);
    eq(`${date} ${isin} ${side} turnover`, t.turnover, turnover, 0.01);
    eq(`${date} ${isin} ${side} avgPrice`, t.avgPrice, turnover / qty, 1e-6);
    eq(`${date} ${isin} ${side} tradeType`, t.tradeType, 'Delivery');
    // Sell = cash in, buy = cash out: the only signed field.
    eq(`${date} ${isin} ${side} netTotalBeforeLevies sign`,
      Math.sign(t.netTotalBeforeLevies), side === 'Sell' ? 1 : -1);
    // Stamp duty is a BUYER-side levy.
    if (side === 'Sell') eq(`${date} ${isin} sell stampDuty`, t.stampDuty, 0);
    if (stt > 0) eq(`${date} ${isin} ${side} stt`, t.stt, stt, 0.02);
  }

  // The two-scrip note (23-Oct-24) splits one printed STT total across both scrips.
  const oct = res.trades.filter((t) => t.tradeDate === '23/10/2024');
  eq('23/10 trade count', oct.length, 2);
  eq('23/10 STT sums to the note total', oct.reduce((a, t) => a + t.stt, 0), 6550.00, 0.02);
  eq('23/10 stamp duty is buy-side only',
    oct.reduce((a, t) => a + t.stampDuty, 0), 510.00, 0.02);

  // ── merged summary = Σ of the five notes' printed levies ─────────────────────
  eq('summary.stt', res.summary.stt, 2930 + 2780 + 3929 + 6550 + 2063, 0.02);
  eq('summary.taxableValue (brokerage)', res.summary.taxableValue,
    2343.98 + 2224.22 + 3142.96 + 5240.10 + 1650.17, 0.02);
  eq('summary.stampDuty', res.summary.stampDuty, 440 + 0 + 589 + 510 + 0, 0.02);
  eq('summary.gst', res.summary.gst, 439.34 + 416.70 + 589.12 + 979.50 + 308.36, 0.02);
  eq('summary.sebiFees', res.summary.sebiFees, 2.88 + 2.68 + 3.93 + 6.54 + 2.04, 0.02);
  eq('summary.etc', res.summary.etc, 94.31 + 89.53 + 126.55 + 194.55 + 61.29, 0.02);

  // Σ(per-trade stt) must equal the summary, or the STT-mismatch audit trips.
  eq('Σ trade.stt == summary.stt',
    res.trades.reduce((a, t) => a + t.stt, 0), res.summary.stt, 0.02);

  // ── the audit ────────────────────────────────────────────────────────────────
  ok('reconciliation present', !!res.reconciliation);
  ok('reconciliation passed', !!res.reconciliation?.isValid);
  ok('reconciliation names the per-note fold', /5 contract note/.test(res.reconciliation?.notes || ''));
  ok('no fractional quantity', res.trades.every((t) => Number.isInteger(t.quantity)));

  // ── dates survive the ledger writer ──────────────────────────────────────────
  // toIsoDate needs a 4-digit year; "31-JUL-24" would be written through verbatim.
  ok('every tradeDate is dd/mm/yyyy with a 4-digit year',
    res.trades.every((t) => /^\d{2}\/\d{2}\/\d{4}$/.test(t.tradeDate)));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
};

run().catch((e) => { console.error(e); process.exitCode = 1; });
