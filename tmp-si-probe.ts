/**
 * One-off diagnostic: run the REAL Share India PDF parser over the REAL extracted text of a
 * note, print every trade WITH its charge block, and reconcile the charges against the note's
 * own printed obligation figures.
 *
 * Reported 17-Sep-2026: *"SHARE INDIA CONTRACT NOTE HAS A BIG PROBLEM THIS IS CONSIDERING A
 * FEW CONTRACT NOTES AS FNO TRANSACTIONS"*. The message the owner saw came from a branch that
 * only runs when the parser produced nothing, so "FnO" was never a classification — it was what
 * this parser said when it failed. This prints the difference, and then checks the money.
 *
 *   node tmp-si-probe-run.mjs <note>.extracted.txt [more.extracted.txt ...]
 */
import { readFileSync } from 'node:fs';
import { ShareIndiaBrokerStrategy, looksLikeDerivativesNote } from './src/lib/brokers/shareindia';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node tmp-si-probe-run.mjs <note>.extracted.txt ...'); process.exit(1); }

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n: number) => (n === 0 ? '0' : n.toFixed(2));

for (const f of files) {
  const text = readFileSync(f, 'utf8');
  console.log('\n' + '='.repeat(74));
  console.log(f.split(/[\\/]/).pop());

  // The OLD test, kept here to show it can never be false on a Share India note.
  const oldWords = ['fno', 'f&o', 'f & o', 'future', 'option', 'derivative'].filter(w => text.toLowerCase().includes(w));
  console.log(`  old FnO test would fire on: ${oldWords.join(', ') || '(nothing)'}`);
  console.log(`  looksLikeDerivativesNote:   ${looksLikeDerivativesNote(text)}`);

  const p = new ShareIndiaBrokerStrategy();
  let res: any;
  try {
    res = await p.parsePdfText(text);
  } catch (e: any) {
    console.log(`  THREW: ${e?.message}`);
    continue;
  }
  if (!res) { console.log('  RESULT: null'); continue; }

  console.log(`\n  ${res.trades.length} trade(s), trade date ${res.tradeDate}, UCC ${res.ucc}`);
  for (const t of res.trades as any[]) {
    console.log(`    ${t.transactionType} ${t.quantity} x ${t.avgPrice}  turnover ${money(t.turnover)}  [${t.tradeType}]`);
    console.log(`      "${t.securityName}"  isin=${t.isin || '(none)'}`);
    console.log(`      brokerage ${money(t.brokerage)} · stt ${money(t.stt)} · etc ${money(t.etc)} · sebi ${money(t.sebiFees)}`
      + ` · stamp ${money(t.stampDuty)} · ipf ${money(t.ipf)} · gst ${money(t.gst)} (c ${money(t.cgst)}/s ${money(t.sgst)}/i ${money(t.igst)})`);
    console.log(`      expenses incl STT ${money(t.totalExpensesInclSTT)} · excl STT ${money(t.totalExpensesExclSTT)}`);
  }

  const s = res.summary;
  console.log(`\n  SUMMARY read off the note:`);
  console.log(`    payin/obligation ${money(s.payinObligation)} · stt ${money(s.stt)} · taxable ${money(s.taxableValue)}`);
  console.log(`    gst ${money(s.gst)} (c ${money(s.cgst)}/s ${money(s.sgst)}/i ${money(s.igst)}) · etc ${money(s.etc)}`
    + ` · sebi ${money(s.sebiFees)} · stamp ${money(s.stampDuty)} · ipf ${money(s.ipf)} · net ${money(s.netSettlement)}`);

  const rec: any = res.reconciliation;
  if (rec) {
    console.log(`\n  RECONCILIATION (this is what drives the Mismatch Warning):`);
    console.log(`    totalCharges ${money(rec.totalCharges)} -> calculatedNet ${money(rec.calculatedNet)}`
      + `   note's own net ${money(rec.extractedNet)}   diff ${money(rec.difference)}`);
    console.log(`    status: ${rec.statusText}   isValid=${rec.isValid}`);
  }

  // ── Conservation: what the trades carry must equal what the note's summary said ──────────
  const sum = (k: string) => (res.trades as any[]).reduce((a, t) => a + (t[k] || 0), 0);
  const rows: [string, number, number][] = [
    ['STT', r2(sum('stt')), r2(s.stt)],
    ['Exchange txn charges', r2(sum('etc')), r2(s.etc)],
    ['SEBI fees', r2(sum('sebiFees')), r2(s.sebiFees)],
    ['Stamp duty', r2(sum('stampDuty')), r2(s.stampDuty)],
    ['GST', r2(sum('gst')), r2(s.gst)],
  ];
  console.log(`\n  ALLOCATION CHECK — charges on the trades vs the note's own totals:`);
  let bad = 0;
  for (const [label, got, want] of rows) {
    const ok = Math.abs(got - want) < 0.015;    // a paisa of allocation rounding
    if (!ok) bad++;
    console.log(`    ${ok ? 'ok  ' : 'DIFF'} ${label.padEnd(22)} trades ${money(got).padStart(9)}   note ${money(want).padStart(9)}`);
  }
  console.log(bad === 0 ? '    → every charge ties to the note.' : `    → ${bad} line(s) do not tie.`);
}
