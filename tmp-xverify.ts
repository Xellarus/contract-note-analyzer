// Verifies that the ba1e5f7 extraction change did not alter what the OTHER brokers parse.
// For each real PDF: extract with the OLD algorithm and the NEW one, run the SAME strategy
// on both, and diff the parsed output. Identical output = provably no regression.
import { detectBroker } from './src/lib/brokers/registry';
import { calculateReconciliation } from './src/lib/brokers/utils';

declare const __PAIRS__: Record<string, { old: string; nw: string }>;

const fp = (r: any) => {
  if (!r) return 'NULL';
  const t = r.trades.map((x: any) =>
    [x.tradeDate, x.securityName, x.transactionType, x.quantity, x.avgPrice?.toFixed(4),
     x.turnover?.toFixed(2), x.brokerage?.toFixed(2), x.stt?.toFixed(2)].join('|')).join('\n');
  const s = r.summary;
  return [`ucc=${r.ucc}`, `broker=${r.brokerName}`, `date=${r.tradeDate}`,
    `payin=${s.payinObligation?.toFixed(2)}`, `net=${s.netSettlement?.toFixed(2)}`,
    `brok=${s.taxableValue?.toFixed(2)}`, `stt=${s.stt?.toFixed(2)}`,
    `trades=${r.trades.length}`, t].join('\n');
};

let regressions = 0;
for (const [name, pair] of Object.entries(__PAIRS__)) {
  const strat = detectBroker(pair.nw, true);
  let oldRes: any = null, newRes: any = null, err = '';
  try { oldRes = await strat.parsePdfText(pair.old); } catch (e: any) { err += ` oldThrew(${e.message})`; }
  try { newRes = await strat.parsePdfText(pair.nw); } catch (e: any) { err += ` newThrew(${e.message})`; }

  const a = fp(oldRes), b = fp(newRes);
  const same = a === b;
  const rec = newRes ? calculateReconciliation(newRes.summary, newRes.trades) : null;
  const tag = same ? 'IDENTICAL' : 'CHANGED  ';
  console.log(`${tag} [${strat.id}] ${name}${err}`);
  console.log(`          trades old=${oldRes ? oldRes.trades.length : 'null'} new=${newRes ? newRes.trades.length : 'null'}` +
              (rec ? `  audit=${rec.statusText} valid=${rec.isValid} diff=${rec.difference}` : ''));
  if (!same) {
    regressions++;
    const al = a.split('\n'), bl = b.split('\n');
    for (let i = 0; i < Math.max(al.length, bl.length); i++) {
      if (al[i] !== bl[i]) {
        console.log(`          OLD: ${JSON.stringify(al[i] ?? null)}`);
        console.log(`          NEW: ${JSON.stringify(bl[i] ?? null)}`);
      }
    }
  }
}
console.log(`\n${Object.keys(__PAIRS__).length} file(s) compared, ${regressions} changed`);
