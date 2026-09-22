/**
 * The SHARED reconciler — `calculateReconciliation` in `src/lib/brokers/utils.ts`.
 *
 * Written 22-Sep-2026, when the net-settlement arithmetic was removed from it on the owner's
 * instruction ("remove it this reconciler it isnt accurate at all"). What survived is the set
 * of checks that compare a parse against an INDEPENDENT source rather than recomputing from
 * the cells being audited — and a probe immediately showed that every one of them could be
 * disabled outright with the whole suite still green.
 *
 * The coverage that existed was entirely POSITIVE: real notes that pass. The one assertion
 * that looked like a negative case —
 *
 *     const wapOnV1 = await v3.parsePdfText(V1);
 *     if (wapOnV1 && wapOnV1.trades.length > 0) { ...does not falsely pass... }
 *     else { eq('V3 parser on a V1 note yields no trades', true, true); }
 *
 * — takes the `else` branch, because the V3 parser returns `null` on a V1 note. `eq(true, true)`
 * is a tautology, so the misparse assertion has NEVER executed. The detectors caught the real
 * Nuvama V3 column shift in production; nothing pinned that they still would.
 *
 * So this file drives the function DIRECTLY. It is pure — a Summary and a Trade[] in, a verdict
 * out — so a synthetic fixture here is not a weaker test than a PDF, it is a sharper one: each
 * case isolates exactly one defect and asserts the specific flag, not just `isValid`.
 *
 *   node tmp-recon-run.mjs
 */
import { calculateReconciliation } from './src/lib/brokers/utils';
import type { Summary, Trade } from './src/types';

let pass = 0, fail = 0;
const eq = (label: string, got: any, want: any) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const ok = (label: string, cond: any, extra = '') => eq(label + (extra ? ` (${extra})` : ''), !!cond, true);

const ZERO_SUMMARY = (): Summary => ({
  payinObligation: 0, taxableValue: 0, stt: 0, etc: 0, sebiFees: 0, clearingCharges: 0,
  stampDuty: 0, ipf: 0, gst: 0, cgst: 0, sgst: 0, igst: 0, netSettlement: 0,
} as unknown as Summary);

let seq = 0;
const trade = (type: 'Buy' | 'Sell', qty: number, price: number, stt = 0): Trade => ({
  id: `t${++seq}`, securityName: 'ACME LTD', isin: 'INE001A01011',
  transactionType: type, quantity: qty, avgPrice: price, turnover: qty * price,
  tradeType: 'Delivery', tradeDate: '01/04/2026',
  brokerage: 0, stt, etc: 0, sebiFees: 0, stampDuty: 0, ipf: 0,
  gst: 0, cgst: 0, sgst: 0, igst: 0,
  totalExpensesInclSTT: stt, totalExpensesExclSTT: 0,
} as unknown as Trade);

console.log('=== the shared reconciler ===\n');

// ── 1. A clean note passes, and passes for the right reason ──────────────────────────────
{
  const s = ZERO_SUMMARY();
  s.payinObligation = 100000;          // the note's own printed obligation
  s.stt = 100;                          // 0.1% of the 1,00,000 sell
  const trades = [trade('Sell', 1000, 100, 100)];
  const r = calculateReconciliation(s, trades);
  eq('clean: PASSED', r.statusText, 'PASSED');
  eq('clean: isValid', r.isValid, true);
  eq('clean: qty x rate reproduces the printed obligation', r.calculatedObligation, 100000);
  eq('clean: ...and the printed figure is carried through', r.extractedObligation, 100000);
  eq('clean: no flag is set', [r.isFractionalQuantity, r.isObligationMismatch, r.isSuspiciousStt, r.isSttMismatch],
    [false, false, false, false]);
}

// ── 2. FRACTIONAL QUANTITY — the column-shift catcher ────────────────────────────────────
// Exchange equity trades in whole shares, so a fraction is not suspicious, it is impossible:
// a rate or an amount has been read into the quantity column. This is the cheap,
// broker-agnostic check that catches the whole class at the door.
{
  const s = ZERO_SUMMARY();
  s.payinObligation = 100000;
  s.stt = 100;
  // 292.9051 shares — the shape of the real Nuvama V3 misparse, where a buy of 10,000 at
  // 292.6125 was read as a sell of 292.9051 at 1.00.
  const r = calculateReconciliation(s, [trade('Sell', 292.9051, 341.4, 100)]);
  ok('fractional: flagged', r.isFractionalQuantity);
  eq('fractional: it is the REPORTED cause, not a generic failure', r.statusText, 'Fractional quantity');
  eq('fractional: and the note is refused', r.isValid, false);

  // The control: the same figures rounded to a whole share are NOT flagged, so the check is
  // testing the fraction and not merely the fixture.
  const c = calculateReconciliation(s, [trade('Sell', 293, 341.4, 100)]);
  eq('fractional: a whole quantity is not flagged', c.isFractionalQuantity, false);
}

// ── 3. OBLIGATION MISMATCH — the self-consistent-misparse catcher ────────────────────────
// This is the one the net-settlement test could never do. That test recomputed from the same
// cells it was auditing, so a misparse that agreed with itself sailed through; this compares
// quantity x rate against a figure printed on a DIFFERENT part of the page.
{
  const s = ZERO_SUMMARY();
  s.payinObligation = 2926125.00;      // what the note prints
  s.stt = 2926;
  // The trades say 292.91 — a column shift of four orders of magnitude.
  const bad = calculateReconciliation(s, [trade('Sell', 1, 292.91, 2926)]);
  ok('obligation: a four-order-of-magnitude shift is flagged', bad.isObligationMismatch);
  eq('obligation: it is the REPORTED cause', bad.statusText, 'Obligation mismatch');
  eq('obligation: and the note is refused', bad.isValid, false);

  // Control A: the trades agree with the printed figure -> no flag.
  const good = calculateReconciliation(s, [trade('Sell', 10000, 292.6125, 2926)]);
  eq('obligation: agreeing trades are not flagged', good.isObligationMismatch, false);

  // Control B: SIGN. A buy makes calculatedObligation negative while the note prints an
  // unsigned gross figure, so the comparison is on MAGNITUDE. Get this wrong and every buy
  // note in the book is flagged.
  const buy = calculateReconciliation(s, [trade('Buy', 10000, 292.6125, 2926)]);
  eq('obligation: a BUY is compared on magnitude, not signed', buy.isObligationMismatch, false);
  eq('obligation: ...and its own figure stays negative', buy.calculatedObligation, -2926125);

  // Control C: TOLERANCE. Brokers disagree on what the obligation line means - Nuvama V3
  // prints it GROSS, V1/V2 print it NET of brokerage - so the gap is allowed to reach the
  // note's own charges. A brokerage-sized difference must NOT be flagged.
  const netOfBrok = ZERO_SUMMARY();
  netOfBrok.payinObligation = 967042.00;   // printed net of a 968.00 brokerage
  netOfBrok.taxableValue = 968;            // brokerage
  netOfBrok.stt = 968;
  const conv = calculateReconciliation(netOfBrok, [trade('Sell', 1000, 968.01, 968)]);
  eq('obligation: a brokerage-sized gap is a CONVENTION, not a mismatch', conv.isObligationMismatch, false);

  // Control D: a note that prints NO obligation cannot be checked, and must not be failed
  // for it. Silently flagging these would refuse every broker that omits the line.
  const noPrint = ZERO_SUMMARY();
  noPrint.stt = 100;
  const np = calculateReconciliation(noPrint, [trade('Sell', 1000, 100, 100)]);
  eq('obligation: no printed obligation -> not checked', np.isObligationMismatch, false);
  eq('obligation: ...and the note still passes', np.isValid, true);
}

// ── 4. STT, both ways ────────────────────────────────────────────────────────────────────
{
  // Suspicious: a rupees-and-paise turnover with essentially no STT means the extractor
  // grabbed a footnote integer rather than the tax.
  const s = ZERO_SUMMARY();
  s.payinObligation = 1000000;
  s.stt = 3;                              // < 10 on a 10,00,000 turnover
  const r = calculateReconciliation(s, [trade('Sell', 10000, 100, 3)]);
  ok('stt: a near-zero STT on a large turnover is suspicious', r.isSuspiciousStt);
  eq('stt: ...and is the reported cause', r.statusText, 'Suspicious STT');
  eq('stt: ...and the note is refused', r.isValid, false);
}
{
  // Mismatch: the trades' own STT does not sum to the note's printed total. `allocateStt`
  // exists to make these tie exactly, so any gap is a real allocation failure.
  const s = ZERO_SUMMARY();
  s.payinObligation = 1000000;
  s.stt = 1000;
  const r = calculateReconciliation(s, [trade('Sell', 10000, 100, 250)]);   // trades say 250
  ok('stt: trade-level STT not summing to the note is flagged', r.isSttMismatch);
  eq('stt: ...and the note is refused', r.isValid, false);

  const c = calculateReconciliation(s, [trade('Sell', 10000, 100, 1000)]);
  eq('stt: ...ties exactly -> not flagged', c.isSttMismatch, false);
  eq('stt: a 10-paise tolerance is allowed',
    calculateReconciliation(s, [trade('Sell', 10000, 100, 1000.05)]).isSttMismatch, false);
}

// ── 5. THE ARITHMETIC AUDIT IS GONE, and stays gone ──────────────────────────────────────
// Removed 22-Sep-2026. It degenerated whenever a note printed no net settlement: `difference`
// was |calculatedNet - extractedNet|, so with extractedNet at 0 it collapsed to the note's own
// net settlement and reported it as a discrepancy. Observed on a 16-note batch as a
// "discrepancy" of Rs 78,24,133.96 while that note's own obligation lines were Rs 14,400 apart.
//
// A source check, because a well-meaning restoration would look like a bug fix.
{
  const fs = await import('node:fs');
  const src = fs.readFileSync('src/lib/brokers/utils.ts', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  eq('removed: no `difference` is computed', /\bconst difference\b/.test(code), false);
  eq('removed: no `calculatedNet`', /\bcalculatedNet\b/.test(code), false);
  eq('removed: no `extractedNet`', /\bextractedNet\b/.test(code), false);
  eq('removed: `isValid` does not test a difference', /difference\s*<=/.test(code), false);

  // And the field is off the type, so a consumer cannot quietly read a stale one.
  const types = fs.readFileSync('src/types.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const block = types.slice(types.indexOf('interface ReconciliationStatus'));
  const iface = block.slice(0, block.indexOf('}'));
  eq('removed: ReconciliationStatus carries no difference/net fields',
    /difference|calculatedNet|extractedNet/.test(iface), false);
  ok('removed: ...but keeps the obligation pair the surviving check needs',
    /calculatedObligation/.test(iface) && /extractedObligation/.test(iface));
}

// ── 6. The multi-file merge must be batch-wide in EVERY field ────────────────────────────
// `...first` used to carry the obligation figures from ONE file while Sells/Buys/Charges were
// summed across all of them, so the card showed a row captioned "(Sells - Buys)" sitting under
// a Sells and a Buys it was not the difference of. Source-checked: the merge is in parsers.ts,
// which cannot be driven from here without a parse.
{
  const fs = await import('node:fs');
  const src = fs.readFileSync('src/lib/parsers.ts', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['totalBuys', 'totalSells', 'totalCharges', 'calculatedObligation', 'extractedObligation']) {
    ok(`merge: ${f} is summed across the batch`,
      new RegExp(`${f}: recs\\.reduce\\(`).test(code));
  }
  // OR-ed, not taken from `first`: a fractional quantity in file 7 must not be hidden behind
  // an STT mismatch in file 1, because the flags are what pick the message the owner reads.
  for (const f of ['isSuspiciousStt', 'isSttMismatch', 'isFractionalQuantity', 'isObligationMismatch']) {
    ok(`merge: ${f} is OR-ed across the batch`,
      new RegExp(`${f}: recs\\.some\\(`).test(code));
  }
}

console.log(`\n${'='.repeat(60)}\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
