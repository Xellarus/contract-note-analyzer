/**
 * Generates the factsheet PDF and reads it back. Two things only an end-to-end run can prove:
 * that the embedded SVG charts actually render (a silent failure leaves blank space), and that the
 * risk statistics are arithmetically right rather than merely plausible.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildFactsheet, indexChartSvg, type Factsheet } from './src/lib/factsheet';
import { buildFactsheetDocDefinition } from './src/lib/factsheetPdf';
import { applyTwr, type NavPoint } from './src/lib/navMath';
import type { NavResult } from './src/lib/navTimeline';
import type { CrossHolding } from './src/lib/crossHoldings';
import type { AumResult, IndustryAllocationResult } from './src/lib/holdingsCalc';

const OUT = process.env.OUTDIR || '.';
let fails = 0;
const ok = (c: boolean, label: string, extra = '') => {
  if (!c) { fails++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`); }
  else console.log(`  ok    ${label}${extra ? '  ' + extra : ''}`);
};
const near = (a: number | null, b: number, tol = 0.01) => a !== null && Math.abs(a - b) < tol;

const DAY = 86400000;
const APR1 = Date.parse('2025-04-01T00:00:00Z');

// Business days: 340 SESSIONS is ~16 calendar months, which is what makes a 1-year lookback real.
const sessionTs: number[] = [];
for (let d = APR1; sessionTs.length < 340; d += DAY) {
  const dow = new Date(d).getUTCDay();
  if (dow !== 0 && dow !== 6) sessionTs.push(d);
}
const FLOW_AT = 120, FLOW = 5_000_000;
const navPts: NavPoint[] = sessionTs.map((ts, i) => ({
  ts,
  nav: 18_000_000 * (1 + 0.0008 * i) + Math.sin(i / 11) * 500_000 + (i >= FLOW_AT ? FLOW : 0),
  cost: 18_416_709.71,
  coverage: 1,
  discrepancy: i === 339 ? 125_000 : 0,
  flow: i === FLOW_AT ? FLOW : 0,
  index: null,
}));
applyTwr(navPts);
const anchor = navPts.findIndex(p => p.index !== null);
const nav: NavResult = {
  total: navPts,
  byPortfolio: [],
  benchmark: navPts.slice(anchor).map((p, k) => ({ ts: p.ts, index: 1000 * (1 + 0.00035 * k) })),
  fromTs: navPts[0].ts, toTs: navPts[339].ts,
  unpriced: ['Some Delisted Ltd', 'Another Old Name'],
  lowCoverageCount: 3, flowsById: new Map(), partialFlowIds: [],
};

const SEED: [string, string][] = [
  ['E2E Networks Ltd.', 'Data Center'], ['Sterlite Technologies Ltd.', 'Data Center'],
  ['Centum Electronics Ltd.', 'Aerospace/Defence'], ['Neogen Chemicals Ltd.', 'Energy Storage/Smart Grid'],
  ['Borosil Renewables Ltd.', 'Renewables'], ['Shivalik Bimetal Controls Ltd.', 'Electronics/EMS'],
  ['Avantel Ltd.', 'Aerospace/Defence'], ['Sambhv Steel Tubes Ltd.', 'Infrastructure'],
  ['Time Technoplast Ltd.', 'Chemicals'], ['Manbro Industries Ltd.', 'Recycling'],
  ['Pulz Electronics Ltd.', 'Electronics/EMS'], ["Jost's Engineering Company Ltd.", 'Capital Goods'],
];
const ACCTS = [
  { id: 't059', code: 'T059', label: 'Taparia Holdings' },
  { id: 's713', code: 'S713', label: 'Saket Agarwal (Integrated)' },
];
const holdings: CrossHolding[] = SEED.map(([name], i) => {
  const invested = 1_500_000 - i * 90_000;
  const current = 2_000_000 - i * 120_000;
  const a = ACCTS[i % 2];
  return {
    key: `K${i}`, name, isin: `INE00${i}A01011`,
    qty: 1000 - i * 40, avgCost: 100 + i,
    invested, cmp: i === 11 ? undefined : 200 + i, current,
    priced: i !== 11, discrepancy: false,
    lots: [{ portfolioId: a.id, code: a.code, label: a.label, qty: 1000 - i * 40, avgCost: 100 + i, invested, current }],
  };
});
holdings.push({
  key: 'KNEG', name: 'Kisan Mouldings Ltd.', isin: 'INE999A01011', qty: -100000, avgCost: 10,
  invested: -50000, cmp: 12, current: -1_200_000, priced: true, discrepancy: true, lots: [],
});

const aum: AumResult = { totalCurrent: 20_511_880, totalInvested: 18_416_709.71, perPortfolio: [], fullyPriced: false };

const bySector = new Map<string, { companies: number; invested: number; current: number }>();
SEED.forEach(([, sec], i) => {
  const s = bySector.get(sec) ?? { companies: 0, invested: 0, current: 0 };
  s.companies++; s.invested += 1_500_000 - i * 90_000; s.current += 2_000_000 - i * 120_000;
  bySector.set(sec, s);
});
bySector.set('Unclassified', { companies: 2, invested: 300_000, current: 340_000 });
const industries: IndustryAllocationResult = {
  slices: [...bySector.entries()].map(([industry, v]) => ({ industry, ...v })),
  totalCompanies: 14, classified: 12,
  sectorByKey: new Map(SEED.map(([, sec], i) => [`K${i}`, sec])),
};
const PORTFOLIOS = ACCTS.map(a => ({ code: a.code, label: a.label }));

// ── 1. model ────────────────────────────────────────────────────────────────
console.log('\n1. buildFactsheet');
const sheet: Factsheet = buildFactsheet({ title: 'Sagun Capital — Consolidated', aum, holdings, nav, industries, portfolios: PORTFOLIOS });

ok(sheet.companies === SEED.length, 'oversold position excluded from the company count');
ok(sheet.discrepancies.length === 1, 'oversold position captured in the register');
ok(sheet.holdings.length === SEED.length, 'EVERY open position is listed, not just the top 10', String(sheet.holdings.length));
ok(sheet.holdings[0].sector === 'Data Center', 'per-holding SECTOR now resolved via sectorByKey', sheet.holdings[0].sector);
ok(sheet.holdings.every(h => h.sector.length > 0), 'no holding is left without a sector label');
ok(sheet.holdings[11].sector === 'Unclassified' || sheet.holdings.some(h => h.sector === 'Capital Goods'), 'sectors mapped per key');
ok(sheet.holdings[0].accounts.length > 0, 'holdings carry their account codes', sheet.holdings[0].accounts.join(','));
ok(Math.abs(sheet.holdings.reduce((s, h) => s + h.weight, 0) - 100) < 0.01, 'holding weights total 100%');
ok(sheet.concentration.top5 <= sheet.concentration.top10 + 1e-9, 'concentration monotonic');
ok(sheet.concentration.effectiveN > 1 && sheet.concentration.effectiveN <= SEED.length + 1e-9,
   'effective holdings within 1..N', sheet.concentration.effectiveN.toFixed(2));
ok(sheet.concentration.hhi > 0 && sheet.concentration.hhi <= 10000, 'HHI on the 0-10,000 scale', sheet.concentration.hhi.toFixed(0));
ok(sheet.portfolioRows.length === 2, 'per-account rollup built from lots', String(sheet.portfolioRows.length));
ok(Math.abs(sheet.portfolioRows.reduce((s, p) => s + p.weight, 0) - 100) < 0.01, 'account weights total 100%');
ok(Math.abs(sheet.unrealised - (sheet.holdings.reduce((s, h) => s + h.current, 0) - sheet.holdings.reduce((s, h) => s + h.invested, 0))) < 1,
   'unrealised gain reconciles to the book');
ok(sheet.excessReturns.length === sheet.returns.length, 'excess return per period');
ok(sheet.aumSvg !== null && sheet.perfSvg !== null, 'both charts produced');

// ── 2. risk maths, on a hand-checkable series ───────────────────────────────
console.log('\n2. Risk statistics — arithmetic');
{
  // index 1000 -> 1100 -> 990 -> 1050 :  +10%, -10%, +6.0606%
  const idx = [1000, 1100, 990, 1050];
  const pts: NavPoint[] = idx.map((v, i) => ({
    ts: sessionTs[i], nav: v * 1000, cost: 1_000_000, coverage: 1, discrepancy: 0, flow: 0, index: v,
  }));
  const bench = idx.map((_, i) => ({ ts: sessionTs[i], index: 1000 }));   // flat benchmark
  const s = buildFactsheet({
    title: 'T', aum, holdings, nav: { ...nav, total: pts, benchmark: bench }, industries, portfolios: PORTFOLIOS,
  });
  const r = s.risk;
  ok(r.sessions === 4, 'session count', String(r.sessions));
  ok(near(r.maxDrawdown, -10, 0.001), 'max drawdown = −10% (peak 1100 → trough 990)', String(r.maxDrawdown?.toFixed(4)));
  ok(near(r.bestSession, 10, 0.001), 'best session = +10%', String(r.bestSession?.toFixed(4)));
  ok(near(r.worstSession, -10, 0.001), 'worst session = −10%', String(r.worstSession?.toFixed(4)));
  ok(near(r.positivePct, 200 / 3, 0.01), 'positive sessions = 2 of 3', String(r.positivePct?.toFixed(2)));
  ok(r.inDrawdown === true, 'flags that 1050 is still below the 1100 peak');
  // stdev of [0.10, -0.10, 0.060606] (sample) x sqrt(252)
  const rs = [0.1, -0.1, 1050 / 990 - 1];
  const m = rs.reduce((a, b) => a + b, 0) / 3;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / 2);
  ok(near(r.annVol, sd * Math.sqrt(252) * 100, 0.01), 'annualised volatility matches sample stdev x sqrt(252)', String(r.annVol?.toFixed(3)));
  ok(near(s.returns[0].pct, 5, 0.001), 'since-base return = +5% (1000 -> 1050)', String(s.returns[0].pct?.toFixed(3)));
  ok(near(s.excessReturns[0].pct, 5, 0.001), 'excess vs a flat benchmark = +5%', String(s.excessReturns[0].pct?.toFixed(3)));
  // A perfectly flat benchmark has zero variance, so beta and correlation are undefined — they
  // must come back null rather than NaN or Infinity from a divide-by-zero.
  ok(r.beta === null && r.correlation === null,
     'flat benchmark -> beta/correlation NULL, not NaN', `beta=${r.beta} corr=${r.correlation}`);
  ok(r.trackingError !== null && isFinite(r.trackingError),
     'tracking error still computable against a flat benchmark', String(r.trackingError?.toFixed(2)));
}
{
  // A benchmark that moves gives a real beta: make the portfolio exactly 2x the benchmark's moves.
  const b = [1000, 1010, 1000, 1020];
  const p = [1000, 1020, 1000, 1040];
  const pts: NavPoint[] = p.map((v, i) => ({ ts: sessionTs[i], nav: v * 1000, cost: 1e6, coverage: 1, discrepancy: 0, flow: 0, index: v }));
  const s = buildFactsheet({
    title: 'T', aum, holdings,
    nav: { ...nav, total: pts, benchmark: b.map((v, i) => ({ ts: sessionTs[i], index: v })) },
    industries, portfolios: PORTFOLIOS,
  });
  ok(near(s.risk.beta, 2, 0.05), 'beta ~2 when the portfolio moves twice the benchmark', String(s.risk.beta?.toFixed(3)));
  ok(near(s.risk.correlation, 1, 0.01), 'correlation ~1 for perfectly proportional moves', String(s.risk.correlation?.toFixed(3)));
}

// ── 3. degenerate ───────────────────────────────────────────────────────────
console.log('\n3. Degenerate inputs');
{
  const s = buildFactsheet({ title: 'T', aum, holdings, nav: null, industries: null, portfolios: PORTFOLIOS });
  ok(s.navIndex === null && s.returns.length === 0, 'no NAV -> no index, no returns');
  ok(s.perfSvg === null && s.aumSvg === null, 'no charts');
  ok(s.risk.sessions === 0 && s.risk.annVol === null, 'risk stats null, not NaN');
  ok(s.holdings.length === SEED.length, 'the book still renders');
  ok(s.holdings.every(h => h.sector === 'Unclassified'), 'sector falls back to Unclassified with no industry data');
  ok(indexChartSvg([{ ts: 1, v: 1000 }], [], 'B') === null, 'chart needs >= 2 points');
}

// ── 4. PDF ──────────────────────────────────────────────────────────────────
console.log('\n4. PDF');
const docDef = buildFactsheetDocDefinition(sheet);
ok(typeof docDef.background === 'function', 'parchment ground painted per page (pdfmake pages are white)');
ok(JSON.stringify(docDef.content).includes('<svg'), 'SVG nodes present');

(async () => {
  const pdfMake: any = (await import('pdfmake')).default ?? (await import('pdfmake'));
  const vfsMod: any = await import('pdfmake/build/vfs_fonts.js');
  const vfs: any = vfsMod.default ?? vfsMod;
  for (const k of Object.keys(vfs)) pdfMake.virtualfs.writeFileSync(k, vfs[k], 'base64');
  pdfMake.addFonts({ Roboto: { normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf', italics: 'Roboto-Italic.ttf', bolditalics: 'Roboto-MediumItalic.ttf' } });

  const buf: Buffer = await pdfMake.createPdf(docDef).getBuffer();
  const p = path.join(OUT, 'verify-factsheet.pdf');
  fs.writeFileSync(p, buf);
  ok(buf.length > 30000, 'PDF generated', `${(buf.length / 1024).toFixed(1)} KB`);

  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  // The book's length drives the page count, so assert on the whole document rather than fixed
  // page indices — only the cover is positionally guaranteed.
  ok(pdf.numPages >= 5, 'at least five pages', String(pdf.numPages));
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    pages.push((await (await pdf.getPage(i)).getTextContent()).items.map((x: any) => x.str).join(' '));
  }
  const text = pages.join('\n');

  // Headings must survive text extraction verbatim — the letter-spacing regression.
  for (const h of ['SECTOR ALLOCATION', 'HOLDINGS', 'DATA QUALITY REGISTER', 'BASIS & METHODOLOGY',
                   'CONCENTRATION', 'BY ACCOUNT', 'PERFORMANCE', 'PERIODIC RETURNS', 'RISK & QUALITY']) {
    ok(text.includes(h), `heading searchable verbatim: "${h}"`);
  }
  ok(pages[0].includes('PRIVATE & CONFIDENTIAL'), 'confidentiality mark extracts cleanly');
  ok(pages[0].includes('PRE-TAX NAV'), 'NAV label extracts cleanly');
  ok(pages[0].includes('ASSETS UNDER MANAGEMENT'), 'KPI label extracts cleanly');

  ok(/Sagun Capital/.test(pages[0]), 'cover title');
  ok(/T059 · S713/.test(pages[0]), 'account codes on the cover');
  ok(/UNREALISED GAIN/i.test(pages[0]), 'unrealised gain KPI');
  ok(/Portfolio pre-tax NAV/.test(pages[0]), 'PERFORMANCE SVG RENDERED (label lives only inside the SVG)');
  ok(/Excess/.test(pages[0]), 'excess-return row');
  ok(/BETA VS BENCHMARK/i.test(pages[0]) && /TRACKING ERROR/i.test(pages[0]), 'risk grid rendered');

  ok(/Market value \(₹ Cr\)/.test(text), 'DEPLOYMENT SVG RENDERED');
  ok(/Data Center/.test(text), 'sector table rows');
  ok(/HERFINDAHL INDEX/i.test(text) && /EFFECTIVE HOLDINGS/i.test(text), 'concentration measures reported');
  ok(/Taparia Holdings/.test(text) && /Saket Agarwal/.test(text), 'per-account rollup');

  ok(/E2E Networks/.test(text) && /Jost/.test(text), 'first AND last holding present (whole book)');
  ok(/Aerospace\/Defence/.test(text), 'sector shown against each holding');
  ok(/Kisan Mouldings/.test(text), 'the oversold position is named in the register');
  ok(/TIME-WEIGHTED/i.test(text), 'time-weighting disclosed');
  ok(/not at inception/i.test(text), 'NAV base disclosed as not-inception');
  ok(/not been audited/i.test(text), 'closing disclaimer');
  ok(!/NaN|Infinity|undefined/.test(text), 'no NaN/Infinity/undefined anywhere');

  console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
  console.log(`artifact: ${p}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('\nTHREW:', e); process.exit(1); });
