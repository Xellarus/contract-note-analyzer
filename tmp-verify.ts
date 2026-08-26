/**
 * End-to-end check of the report renderers: generate a real PDF and a real XLSX, then read
 * both back and assert on their actual contents (not just that the call didn't throw).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ReportDoc } from './src/lib/reportDoc';
import { toCsv, inferColType, fmtMoney, fmtInt, fmtRate, toNum } from './src/lib/reportDoc';
import { buildPdfDocDefinition } from './src/lib/reportPdf';
import { buildXlsxWorkbook, indianFmt } from './src/lib/reportXlsx';

const OUT = process.env.OUTDIR || '.';
let fails = 0;
const ok = (cond: boolean, label: string, extra = '') => {
  if (!cond) { fails++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`); }
  else console.log(`  ok    ${label}`);
};

// ── a document exercising every hard case ───────────────────────────────────
const doc: ReportDoc = {
  holder: 'Taparia Holdings',
  title: 'Capital Gains Statement',
  params: [
    ['Portfolio', 'T059 — Taparia Holdings'],
    ['Period', '01-Apr-2025 to 31-Mar-2026'],
    ['Basis', 'FIFO · charge-inclusive'],
  ],
  cols: [
    { key: 'name', label: 'Asset Name', type: 'text' },
    { key: 'isin', label: 'ISIN', type: 'text' },
    { key: 'qty', label: 'Quantity', type: 'int' },
    { key: 'sd', label: 'Sale Date', type: 'date' },
    { key: 'rate', label: 'Avg Buy Price', type: 'rate' },
    { key: 'val', label: 'Sale Value', type: 'money' },
    { key: 'pl', label: 'P&L', type: 'money' },
  ],
  rows: [
    { cells: { name: 'Pulz Electronics Ltd', isin: 'INE425D01010', qty: 1000, sd: '2025-09-08', rate: 634.567891, val: 124500, pl: -508347.06 } },
    { cells: { name: 'Time Technoplast', isin: 'INE1SR001012', qty: 500, sd: '12-09-2025', rate: 98.2, val: 98200, pl: 12940 } },
    { cells: { name: 'High Energy Batteries (India)', isin: 'INE783E01023', qty: 25, sd: '03-Jan-2026', rate: 1652.4, val: 41300, pl: 8110.5 } },
    { cells: { name: 'Large crore-scale row', isin: 'INE000A01011', qty: 1234567, sd: '2026-03-31', rate: 0.5, val: 18416709.71, pl: -12345678.9 } },
    { cells: { name: 'Unparseable date row', isin: 'INE111A01011', qty: -300, sd: 'STALE', rate: '', val: 0, pl: 0 } },
    { cells: { name: 'TOTAL', isin: '', qty: 1236792, sd: '', rate: '', val: 18700709.71, pl: -12833975.46 }, total: true },
  ],
  footnotes: [
    'Cost basis: FIFO. Amounts in ₹. Negative amounts are shown in parentheses.',
    'Negative quantities indicate an unreconciled position and are shown with a minus sign.',
  ],
  landscape: true,
  filenameBase: 'CapitalGains_T059_test',
};

// ── 1. formatting unit checks ───────────────────────────────────────────────
console.log('\n1. Formatting');
ok(fmtMoney(-508347.06) === '(5,08,347.06)', 'money negative → bracketed Indian', fmtMoney(-508347.06));
ok(fmtMoney(18416709.71) === '1,84,16,709.71', 'money crore grouping', fmtMoney(18416709.71));
ok(fmtInt(-300) === '-300', 'quantity negative keeps minus', fmtInt(-300));
ok(fmtInt(1234567) === '12,34,567', 'quantity Indian grouping', fmtInt(1234567));
ok(fmtRate(634.567891) === '634.567891', 'rate keeps 6 dp (no paise rounding)', fmtRate(634.567891));
ok(fmtRate(98.2) === '98.20', 'rate pads to 2 dp', fmtRate(98.2));
ok(toNum('(5,08,347.06)') === -508347.06, 'toNum reads accounting negative');
ok(toNum('₹1,24,500.00') === 124500, 'toNum strips ₹ and grouping');
ok(toNum('INE425D01010') === null, 'toNum rejects an ISIN');

console.log('\n2. Type inference');
ok(inferColType('Sale Date') === 'date', 'Sale Date → date');
ok(inferColType('ISIN') === 'text', 'ISIN → text');
ok(inferColType('Scrip Code', ['512595']) === 'text', 'Scrip Code stays text (never grouped)');
ok(inferColType('Number of Shares') === 'int', 'Number of Shares → int');
ok(inferColType('Avg Price') === 'rate', 'Avg Price → rate');
ok(inferColType('Total Amount (Turnover)') === 'money', 'Turnover → money');
ok(inferColType('Stock Name') === 'text', 'Stock Name → text');
ok(inferColType('Mystery', ['1.5', '2.25']) === 'money', 'unknown header, decimal samples → money');
ok(inferColType('Mystery', ['1', '2']) === 'int', 'unknown header, integer samples → int');
ok(inferColType('Mystery', ['abc', '2']) === 'text', 'unknown header, mixed samples → text');

// ── 3. CSV stays raw ────────────────────────────────────────────────────────
console.log('\n3. CSV');
const csv = toCsv(doc);
const csvLines = csv.split('\r\n');
ok(csvLines[0] === 'Asset Name,ISIN,Quantity,Sale Date,Avg Buy Price,Sale Value,P&L', 'header row verbatim');
ok(csvLines[1].includes('-508347.06'), 'CSV keeps the RAW number (no parens, no grouping)');
// Numeric FIELDS must be raw — a name legitimately contains "(India)", so check the
// money/int/rate columns specifically rather than the whole file.
const numericIdx = doc.cols.map((c, i) => ({ c, i })).filter(x => x.c.type !== 'text' && x.c.type !== 'date').map(x => x.i);
const numericFieldsClean = csvLines.slice(1).every(line => {
  const f = line.split(',');
  return numericIdx.every(i => !/[(),]/.test(f[i] ?? ''));
});
ok(numericFieldsClean, 'numeric CSV fields carry no parens and no grouping commas');
ok(csvLines[1].includes('2025-09-08'), 'CSV keeps the raw date string');
ok(csv.endsWith('-12833975.46'), 'CSV ends at the last data value');
fs.writeFileSync(path.join(OUT, 'verify-report.csv'), csv, 'utf8');

// ── 4. PDF ──────────────────────────────────────────────────────────────────
console.log('\n4. PDF');
const docDef = buildPdfDocDefinition(doc, { now: new Date(2026, 7, 12, 16, 20) });
ok(docDef.pageOrientation === 'landscape', 'landscape honoured');
ok(docDef.defaultStyle.font === 'Roboto', 'Roboto (the font that HAS ₹)');
const widths: number[] = docDef.content[docDef.content.length - 2].table.widths;
const sumW = widths.reduce((s, w) => s + w, 0);
// pdfmake adds cell padding OUTSIDE these widths, so the declared widths plus every column's
// 2×4pt padding must equal the content width — otherwise the last column is clipped away.
const contentW = 841.89 - 56;
const expectW = contentW - doc.cols.length * 8;
ok(Math.abs(sumW - expectW) < 1.5, 'widths + cell padding == content width (no overflow)', `sum=${sumW.toFixed(2)} expect=${expectW.toFixed(2)}`);
ok(Math.abs(sumW + doc.cols.length * 8 - contentW) < 1.5, 'table total spans the page exactly');
ok(docDef.header(1) === null, 'page 1 has no running header (letterhead instead)');
ok(!!docDef.header(2), 'page 2+ has a running header');
ok(docDef.footer(2, 5).columns[1].text === 'Page 2 of 5', 'footer paginates');

const pdfPath = path.join(OUT, 'verify-report.pdf');

(async () => {
  // Node build: no addVirtualFileSystem, so write the fonts into virtualfs by hand.
  const pdfMake: any = (await import('pdfmake')).default ?? (await import('pdfmake'));
  const vfsMod: any = await import('pdfmake/build/vfs_fonts.js');
  const vfs: any = vfsMod.default ?? vfsMod;
  for (const k of Object.keys(vfs)) pdfMake.virtualfs.writeFileSync(k, vfs[k], 'base64');
  pdfMake.addFonts({
    Roboto: {
      normal: 'Roboto-Regular.ttf',
      bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
  });

  const buf: Buffer = await pdfMake.createPdf(docDef).getBuffer();
  fs.writeFileSync(pdfPath, buf);
  ok(buf.length > 20000, 'PDF generated and non-trivial', `${(buf.length / 1024).toFixed(1)} KB`);
  ok(buf.slice(0, 5).toString('latin1') === '%PDF-', 'has a PDF header');

  // Read the text back out with the pdf.js already in this project.
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false }).promise;
  let text = '';
  let compact = '';        // all whitespace removed — pdf.js splits runs on glyph positioning,
                           // so inter-item spacing is an extraction artifact, not document content
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    text += tc.items.map((i: any) => i.str).join(' ') + '\n';
    compact += tc.items.map((i: any) => i.str).join('').replace(/\s+/g, '');
  }
  console.log(`        (${pdf.numPages} page(s), ${text.length} chars of text extracted)`);

  ok(text.includes('Taparia Holdings'), 'letterhead holder name present');
  ok(text.includes('Capital Gains Statement'), 'report title present');
  // The LAST column is the one a width miscalculation silently clips, so assert its header and
  // a full value from it explicitly — a truncated "(5,08,3" must fail here.
  ok(/P&L/.test(text), 'last column HEADER survives (not clipped off the page)');
  ok(compact.includes('(5,08,347.06)'), 'negative P&L bracketed + Indian-grouped in the PDF');
  ok(compact.includes('(1,23,45,678.90)'), 'crore-scale NEGATIVE bracketed + grouped');
  ok(compact.includes('1,84,16,709.71'), 'crore-scale amount grouped Indian-style');
  ok(compact.includes('634.567891'), 'per-share rate kept at 6 dp');
  ok(compact.includes('₹'), 'RUPEE SIGN renders (the jsPDF trap avoided)');
  ok(compact.includes('08-Sep-2025'), 'ISO date rendered dd-Mmm-yyyy');
  ok(compact.includes('12-Sep-2025'), 'dd-mm-yyyy date rendered dd-Mmm-yyyy');
  ok(compact.includes('03-Jan-2026'), 'dd-Mmm-yyyy date passes through unchanged');
  ok(compact.includes('STALE'), 'unparseable date passed through verbatim, not blanked');
  ok(compact.includes('-300'), 'negative quantity keeps its minus sign');
  ok(!compact.includes('(300)'), 'negative quantity is NOT bracketed like money');
  ok(text.includes('Page 1 of'), 'footer pagination rendered');
  ok(/ASSET NAME/.test(text), 'header row rendered');

// ── 6. Scope labelling (titleTag) ───────────────────────────────────────────
// A narrowed report must identify itself on EVERY page and in the workbook tab, not only on
// the letterhead. A capital-gains statement gets printed, split and filed page by page, so an
// equity-only statement whose pages 2+ look identical to the consolidated one is a filing
// hazard, not a cosmetic gap.
console.log('\n6. Scope labelling');
{
  const scoped: ReportDoc = { ...doc, titleTag: 'Private Equity' };
  const sd = buildPdfDocDefinition(scoped, { now: new Date(2026, 7, 12, 16, 20) });

  // Letterhead (page 1).
  const flat = JSON.stringify(sd.content);
  ok(flat.includes('Capital Gains Statement \u2014 Private Equity'), 'PDF letterhead carries the scope');

  // Pages 2+ running header — the part that would otherwise be indistinguishable.
  const hdr2: any = typeof sd.header === 'function' ? sd.header(2) : null;
  const hdr1: any = typeof sd.header === 'function' ? sd.header(1) : null;
  ok(hdr1 === null, 'page 1 has no running header (the letterhead is in the content)');
  ok(JSON.stringify(hdr2 || {}).includes('Private Equity'), 'PDF running header on page 2 carries the scope',
    JSON.stringify(hdr2));

  // What a document manager indexes.
  ok((sd.info?.title || '').includes('Private Equity'), 'PDF info.title carries the scope', sd.info?.title);
  ok((sd.info?.subject || '').includes('Private Equity'), 'PDF info.subject carries the scope', sd.info?.subject);

  // An unnarrowed report must be untouched — no stray separator.
  const plain = buildPdfDocDefinition(doc, { now: new Date(2026, 7, 12, 16, 20) });
  const plainHdr: any = typeof plain.header === 'function' ? plain.header(2) : null;
  ok(!JSON.stringify(plainHdr || {}).includes('\u2014 undefined'), 'consolidated report gains no scope text');
  ok((plain.info?.subject || '') === 'Capital Gains Statement', 'consolidated subject unchanged', plain.info?.subject);
}

  // ── 5. XLSX ───────────────────────────────────────────────────────────────
  console.log('\n5. XLSX');
  const wb = await buildXlsxWorkbook(doc);
  const xlsxPath = path.join(OUT, 'verify-report.xlsx');
  await wb.xlsx.writeFile(xlsxPath);
  ok(fs.statSync(xlsxPath).size > 5000, 'XLSX written', `${(fs.statSync(xlsxPath).size / 1024).toFixed(1)} KB`);

  const ExcelJS: any = (await import('exceljs')).default ?? (await import('exceljs'));
  const rb = new ExcelJS.Workbook();
  await rb.xlsx.readFile(xlsxPath);
  const ws = rb.worksheets[0];
  ok(ws.name === 'Capital Gains Statement', 'sheet named after the report', ws.name);

  // Find the header row by its first label.
  let hdr = -1;
  ws.eachRow((row: any, n: number) => { if (hdr < 0 && String(row.getCell(1).value).trim() === 'Asset Name') hdr = n; });
  ok(hdr > 0, 'header row located', `row ${hdr}`);
  ok(String(ws.getCell(1, 1).value) === 'Taparia Holdings', 'letterhead in row 1');

  const first = hdr + 1;
  const qty = ws.getCell(first, 3);
  const sd = ws.getCell(first, 4);
  const pl = ws.getCell(first, 7);
  ok(typeof qty.value === 'number' && qty.value === 1000, 'quantity is a REAL number (summable)', `${typeof qty.value}`);
  ok(pl.value === -508347.06, 'P&L is a real negative number', String(pl.value));
  ok(/\[Red\]/.test(pl.numFmt || ''), 'negative money carries a red bracketed format', pl.numFmt);
  // ExcelJS's READER strips the backslash escapes; the file on disk keeps them (verified
  // against xl/styles.xml). So compare buckets through a backslash-insensitive form here,
  // and unit-test the exact escaped output separately below.
  const nf = (s: string) => (s || '').replace(/\\/g, '');
  ok(nf(pl.numFmt) === '##,##,##0.00;[Red](##,##,##0.00)', 'lakh-bucket format on the lakh row', pl.numFmt);
  ok(sd.value instanceof Date, 'date cell is a REAL Date (sortable/filterable)', String(sd.value));
  const d = sd.value as Date;
  ok(d.getFullYear() === 2025 && d.getMonth() === 8 && d.getDate() === 8,
     'date did NOT drift a day through Excel serial conversion', d.toDateString());
  ok(sd.numFmt === 'dd-mmm-yyyy', 'date shows dd-mmm-yyyy', sd.numFmt);

  const croreCell = ws.getCell(first + 3, 6);
  ok(nf(croreCell.numFmt) === '##,##,##,##0.00;[Red](##,##,##,##0.00)', 'crore-bucket format on the crore row', croreCell.numFmt);
  const smallCell = ws.getCell(first + 2, 6);        // 41,300 → thousand bucket
  ok(nf(smallCell.numFmt) === '##,##0.00;[Red](##,##0.00)', 'thousand-bucket format', smallCell.numFmt);

  // The exact escaped strings, which are what Excel actually parses.
  ok(indianFmt(508347.06, '.00', true) === '##\\,##\\,##0.00;[Red](##\\,##\\,##0.00)', 'lakh bucket escapes its commas', indianFmt(508347.06, '.00', true));
  ok(indianFmt(18416709.71, '.00', true) === '##\\,##\\,##\\,##0.00;[Red](##\\,##\\,##\\,##0.00)', 'crore bucket escapes its commas');
  ok(indianFmt(41300, '.00', true) === '##\\,##0.00;[Red](##\\,##0.00)', 'thousand bucket escapes its comma');
  ok(indianFmt(678, '.00', true) === '##0.00;[Red](##0.00)', 'sub-thousand bucket has NO comma (else it would leak a leading ",")');
  ok(indianFmt(-300, '', false) === '##0;[Red]-##0', 'quantity bucket uses a minus, not parens');

  ok(!!ws.autoFilter, 'autofilter present');
  const af: any = ws.autoFilter;
  // The reader may hand back either a ref string ("A14:G19") or the {from,to} form.
  const afTo = typeof af === 'string'
    ? (/:[A-Z]+(\d+)$/.exec(af) ? +/:[A-Z]+(\d+)$/.exec(af)![1] : null)
    : (af?.to?.row ?? null);
  ok(afTo === hdr + 5, 'autofilter STOPS above the total row', `to row ${afTo}, total at ${hdr + 6}, raw=${JSON.stringify(af)}`);
  ok(ws.views?.[0]?.state === 'frozen' && ws.views[0].ySplit === hdr, 'header row frozen', JSON.stringify(ws.views?.[0]));
  ok(ws.pageSetup?.printTitlesRow === `${hdr}:${hdr}`, 'header repeats on printed pages', ws.pageSetup?.printTitlesRow);
  ok(ws.pageSetup?.orientation === 'landscape', 'landscape page setup');
  ok(ws.pageSetup?.fitToWidth === 1, 'fits to one page wide');

  const totalRow = hdr + 6;
  ok(ws.getCell(totalRow, 1).value === 'TOTAL', 'total row present');
  ok(ws.getCell(totalRow, 7).font?.bold === true, 'total row is bold');
  ok(ws.getCell(totalRow, 7).border?.bottom?.style === 'double', 'total row double-ruled');
  ok(ws.getCell(hdr, 1).fill?.fgColor?.argb === 'FF8A6A1E', 'header band is brass', JSON.stringify(ws.getCell(hdr, 1).fill));

  const unparsed = ws.getCell(first + 4, 4);
  ok(unparsed.value === 'STALE', 'unparseable date stays a string, not a wrong date', String(unparsed.value));


  // Scope in the workbook tab name and the print footer. The tab name is capped at 31 chars by
  // Excel, so the qualifier is placed FIRST — truncation must never be able to eat the one word
  // that distinguishes two otherwise identical statements.
  const scopedWb = await buildXlsxWorkbook({ ...doc, titleTag: 'Private Equity' });
  const sws: any = scopedWb.worksheets[0];
  ok(sws.name.startsWith('Private Equity'), 'XLSX tab name leads with the scope', sws.name);
  ok(sws.name.length <= 31, 'XLSX tab name respects Excel\u2019s 31-char cap', `${sws.name.length}: ${sws.name}`);
  ok(String(sws.headerFooter?.oddFooter || '').includes('Private Equity'),
    'XLSX print footer carries the scope (the only identity on printed page 2+)',
    String(sws.headerFooter?.oddFooter));
  ok(!String(ws.headerFooter?.oddFooter || '').includes('undefined'),
    'consolidated print footer has no stray qualifier', String(ws.headerFooter?.oddFooter));

  console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
  console.log(`artifacts: ${pdfPath}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('\nTHREW:', e); process.exit(1); });
