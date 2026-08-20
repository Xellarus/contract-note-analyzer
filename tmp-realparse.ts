// End-to-end check against REAL contract-note PDFs. Unlike tmp-nuvama.ts, which feeds
// hand-transcribed text, this drives the parser with text produced by the app's own
// extractTextFromPDF - the step that was actually broken. Hand-made fixtures cannot
// catch an extraction bug, which is exactly how the V3 buy misparse shipped green.
import { NuvamaBrokerStrategy } from './src/lib/brokers/nuvama';
import { calculateReconciliation } from './src/lib/brokers/utils';

declare const __TEXTS__: Record<string, string>;

const r2 = (n: number) => Math.round(n * 100) / 100;
let pass = 0, fail = 0;
const eq = (label: string, got: any, want: any) => {
  const ok = typeof want === 'number' && typeof got === 'number'
    ? Math.abs(got - want) < 0.02 : got === want;
  if (ok) { pass++; } else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

const run = async (name: string, expect: any) => {
  const text = __TEXTS__[name];
  if (!text) { console.log(`SKIP ${name} (no text)`); return; }
  console.log(`\n== ${name} ==`);
  const res = await new NuvamaBrokerStrategy('v3').parsePdfText(text);
  if (!res) { fail++; console.log('  FAIL parse returned null'); return; }
  const { summary, trades } = res;
  eq('trade count', trades.length, expect.trades.length);
  trades.forEach((t, i) => {
    const e = expect.trades[i]; if (!e) return;
    eq(`[${i}] name`, t.securityName, e.name);
    eq(`[${i}] type`, t.transactionType, e.type);
    eq(`[${i}] qty`, t.quantity, e.qty);
    eq(`[${i}] price`, r2(t.avgPrice), r2(e.price));
    eq(`[${i}] turnover`, r2(t.turnover), r2(e.turnover));
    eq(`[${i}] brokerage`, r2(t.brokerage), r2(e.brokerage));
  });
  eq('ucc', res.ucc, expect.ucc);
  eq('summary stampDuty', r2(summary.stampDuty), r2(expect.stampDuty));
  eq('summary payin', r2(summary.payinObligation), r2(expect.payin));
  eq('summary netSettlement', r2(summary.netSettlement), r2(expect.net));
  const rec = calculateReconciliation(summary, trades);
  eq('recon isFractionalQuantity', !!rec.isFractionalQuantity, false);
  eq('recon isObligationMismatch', !!rec.isObligationMismatch, false);
  eq('recon status', rec.statusText, expect.status);
  console.log(`  -> ${trades.length} trade(s), status ${rec.statusText}, diff ${rec.difference}`);
};

// CN 113911 - the buy that misparsed. 10,000 AEROFLEX at WAP Mkt Rate 292.6125.
await run('buy', {
  ucc: '60072941', stampDuty: 439.0, payin: 2926125.0, net: -2933052.14, status: 'PASSED',
  trades: [{ name: 'AEROFLEX', type: 'Buy', qty: 10000, price: 292.6125, turnover: 2926125.0, brokerage: 2926.0 }],
});

// CN 893207 - the two-scrip sell that already worked; must not regress.
await run('sell', {
  ucc: '60072941', stampDuty: 0, payin: -9940342.76, net: 9918303.49, status: 'PASSED',
  trades: [
    { name: 'GAIL', type: 'Sell', qty: 47088, price: 174.1348, turnover: 8199659.46, brokerage: 8198.02 },
    { name: 'INDUSTOWER', type: 'Sell', qty: 4561, price: 381.6451, turnover: 1740683.3, brokerage: 1740.48 },
  ],
});

// The exact text the OLD extractor produced for CN 113911. Before the guards this parsed
// to a 292.9051-share SELL at Rs 1.00 whose own arithmetic agreed to the paise, so the
// audit reported PASSED while every figure on screen was wrong. It must now be REJECTED.
console.log('\n== old scrambled extraction (must now be rejected) ==');
{
  const scrambled = __TEXTS__['scrambled'];
  const res = await new NuvamaBrokerStrategy('v3').parsePdfText(scrambled);
  if (!res || res.trades.length === 0) {
    pass++; console.log('  -> rejected outright (no trades)');
  } else {
    const rec = calculateReconciliation(res.summary, res.trades);
    eq('scrambled qty fractional', !!rec.isFractionalQuantity, true);
    eq('scrambled obligation mismatch', !!rec.isObligationMismatch, true);
    eq('scrambled isValid', rec.isValid, false);
    eq('scrambled status', rec.statusText, 'Fractional quantity');
    console.log(`  -> qty ${res.trades[0].quantity}, type ${res.trades[0].transactionType}, status ${rec.statusText}, isValid ${rec.isValid}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
