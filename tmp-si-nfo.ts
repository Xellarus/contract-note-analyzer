/**
 * Share India: NFO / BFO contracts are NOT imported (03-Nov-2026).
 *
 * Reported against two mixed CM + FO notes for CS1106. Until 17-Sep-2026 the F&O rows were kept
 * out by accident — `finalizeContractNote` dropped any row without an ISIN, and a contract row
 * has none. Removing that gate (so wrapped equity rows would import) let every option in:
 * 145 of 146 trades on 29-10-2026, 50 of 51 on 30-10-2026. And the STT anchor, Annexure II's
 * `Total STT`, spans every segment, so the F&O STT has to come off it as well.
 *
 * Fixtures are the owner's REAL notes, extracted locally, never committed (`*.extracted.txt`
 * is gitignored — they carry PAN and holdings):
 *
 *   pdftotext -layout samples/CS1106_29-10-2026.pdf samples/CS1106_29-10-2026.extracted.txt
 *   node tmp-extract.mjs samples/CS1106_29-10-2026.pdf   → move to samples/<n>.pdfjs.extracted.txt
 *
 * The pdftotext text is what was asked for; the pdf.js text is what the APP parses, and is the
 * only one whose summary block reads correctly, so the STT and reconciliation checks run on it.
 *
 *   node tmp-si-nfo-run.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { ShareIndiaBrokerStrategy, isDerivativeContract, derivativeSttInAnnexure } from './src/lib/brokers/shareindia';
import { dropDerivativeTrades } from './src/lib/brokers/utils';

const ROOT = process.env.SI_ROOT || '.';
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`FAIL ${label}${detail ? `  — ${detail}` : ''}`); }
};

// The one CM scrip on both notes; every surviving trade must be it.
const SAMBHV = (t: any) => t.isin === 'INE12NJ01018' || /sambhv/i.test(t.securityName);

// ── A. the contract test itself ─────────────────────────────────────────────────────────────
for (const s of ['NIFTY03NOV202621550PE', 'SENSEX29OCT202674600CE', 'NIFTY25NOV2026FUT',
                 'BANKNIFTY26NOV202651000.5CE', 'NIFTY(OPTIDX-21550-03-11-2026)', 'RELIANCE(FUTSTK-27-11-2026)']) {
  ok(`contract: ${s}`, isDerivativeContract(s));
}
// FUTURES with no strike and no "FUT" — the exact names that reached the confirm-company popup on
// 03-Nov-2026 as "matched by name" after the first fix, which demanded a CE|PE|FUT ending.
for (const s of ['ULTRACEMCO25AUG2026', 'ULTRACEMCO28JUL2026', 'COFORGE25AUG2026', 'ETERNAL25AUG2026',
                 'HDFCBANK25AUG2026', 'M&M25AUG2026', 'BAJAJ-AUTO25AUG2026', 'NIFTY25NOV2026 FUT']) {
  ok(`future: ${s}`, isDerivativeContract(s));
}
// ETFs named after an index are SHARES, and must never be caught by the contract test; nor may
// a name whose "month" is not a month.
for (const s of ['Sambhv Steel Tubes Limited', 'Venus Pipes & Tubes Limited', 'NIFTYBEES', 'BANKBEES',
                 'Rel Etf Lquid Bees', 'Manbro Industries Limited', 'SENSEX ETF', 'Scrip Summary',
                 'SGBJUN28', 'ABC12XYZ2026', '']) {
  ok(`not a contract: "${s}"`, !isDerivativeContract(s));
}

// ── A2. the broker-independent net in processFile ───────────────────────────────────────────
{
  const mk = (securityName: string) => ({ securityName } as any);
  const trades = [mk('Venus Pipes & Tubes Limited'), mk('ULTRACEMCO25AUG2026'), mk('HDFCBANK25AUG2026')];
  const dropped = dropDerivativeTrades(trades);
  ok('net: drops the futures', dropped.length === 2, `${dropped.length}`);
  ok('net: keeps the share, in the SAME array', trades.length === 1 && trades[0].securityName === 'Venus Pipes & Tubes Limited');

  // processFile is gapi/File-driven and not executable here, so its wiring is asserted on SOURCE.
  const src = readFileSync(`${ROOT}/src/lib/parsers.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  ok('processFile applies the net', /dropDerivativeTrades\(res\.trades\)/.test(src));
  ok('processFile re-runs reconciliation after dropping', /res\.reconciliation\s*=\s*calculateReconciliation/.test(src));
  // The F&O message was SWALLOWED: the catch re-threw only "FnO", so the user got a silent null.
  ok('processFile re-throws the F&O message', /includes\("F&O"\)/.test(src));
}

// ── B. the real notes ───────────────────────────────────────────────────────────────────────
const NOTES = [
  // foStt ties to each note's own `NCL FO` obligation row (32,662 / 14,320, settled to the rupee).
  { name: 'CS1106_29-10-2026', qty: 2595, stt: 412.61, foStt: 32662.06 },
  { name: 'CS1106_30-10-2026', qty: 13155, stt: 2065.07, foStt: 14320.06 },
];

for (const n of NOTES) {
  for (const kind of ['extracted', 'pdfjs.extracted'] as const) {
    const file = `${ROOT}/samples/${n.name}.${kind}.txt`;
    if (!existsSync(file)) {
      ok(`${n.name}.${kind}: fixture present`, false, `missing ${file} — see the header for how to regenerate`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const tag = `${n.name} [${kind === 'extracted' ? 'pdftotext' : 'pdf.js'}]`;

    // The fixture must actually CONTAIN NFO trade rows, or every assertion below passes vacuously.
    const foRows = text.split('\n').filter(l => /\b(NIFTY|SENSEX)\d{2}[A-Z]{3}\d{4}\d+(CE|PE)\b.*\b(BUY|SELL)\b/.test(l)).length;
    ok(`${tag}: fixture carries NFO trade rows`, foRows > 20, `${foRows}`);

    const res: any = await new ShareIndiaBrokerStrategy().parsePdfText(text);
    const trades: any[] = res?.trades || [];
    ok(`${tag}: some trades imported`, trades.length > 0);

    const leaked = trades.filter(t => isDerivativeContract(t.securityName));
    ok(`${tag}: no NFO contract imported`, leaked.length === 0,
      leaked.slice(0, 3).map(t => t.securityName).join(', '));
    ok(`${tag}: no subtotal label imported`, !trades.some(t => /scrip summary/i.test(t.securityName)));
    const foreign = trades.filter(t => !SAMBHV(t));
    ok(`${tag}: every trade is the note's one CM scrip`, foreign.length === 0,
      foreign.slice(0, 3).map(t => `${t.securityName} ${t.quantity}@${t.avgPrice}`).join(', '));

    if (kind === 'pdfjs.extracted') {
      // What the app really receives: exactly the equity buy, with equity-only STT.
      ok(`${tag}: exactly one trade`, trades.length === 1, `${trades.length}`);
      ok(`${tag}: quantity ${n.qty}`, trades[0]?.quantity === n.qty, `${trades[0]?.quantity}`);
      ok(`${tag}: F&O STT read off Annexure II`, Math.abs(derivativeSttInAnnexure(text) - n.foStt) < 0.005,
        `${derivativeSttInAnnexure(text)}`);
      ok(`${tag}: summary STT is equity-only (${n.stt})`, Math.abs(res.summary.stt - n.stt) < 0.005, `${res.summary.stt}`);
      ok(`${tag}: trade carries all of it`, Math.abs(trades[0]?.stt - n.stt) < 0.005, `${trades[0]?.stt}`);
      ok(`${tag}: reconciles`, res.reconciliation?.isValid === true, res.reconciliation?.status);
    }
  }
}

// ── C. an F&O-only note says so, truthfully ─────────────────────────────────────────────────
// The 30-Oct pdf.js note with its one equity row taken out: every remaining row is a contract.
{
  const file = `${ROOT}/samples/CS1106_30-10-2026.pdfjs.extracted.txt`;
  if (existsSync(file)) {
    const foOnly = readFileSync(file, 'utf8').split('\n').filter(l => !/sambhv|INE12NJ01018/i.test(l)).join('\n');
    let msg = '';
    try { await new ShareIndiaBrokerStrategy().parsePdfText(foOnly); } catch (e: any) { msg = e?.message || ''; }
    ok('F&O-only note is refused as F&O', /only has F&O transactions/.test(msg), msg || '(did not throw)');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
