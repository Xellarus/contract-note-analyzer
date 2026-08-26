/**
 * XLSX renderer for a ReportDoc — a styled, print-ready workbook rather than a grid of text.
 *
 * Why ExcelJS and not the `xlsx` package already in this project: SheetJS's community build
 * does not write cell STYLES. Fonts, fills and borders are a Pro feature, and the `s` property
 * is silently dropped on write — which is why the Tally voucher export only ever sets column
 * widths and number formats, the two things that DO survive. `xlsx` stays where it is for
 * READING imports; this file owns styled output.
 *
 * What makes the sheet feel finished:
 *   • a letterhead block above the table, so a printed sheet identifies itself
 *   • real typed cells — numbers you can sum, dates you can sort, not strings
 *   • frozen header + first column, and an autofilter that stops short of the total row
 *   • Indian lakh/crore grouping, and negatives red and bracketed
 *   • pageSetup that fits to width and repeats the header row on every printed page
 */
import type { ReportDoc, ReportCol, CellValue } from './reportDoc';
import { toNum, cellDate, isNumericType, downloadBlob, formatCell } from './reportDoc';

const BRASS = 'FF8A6A1E';
const INK = 'FF2F2A1F';
const MUTED = 'FF6B6252';
const HAIRLINE = 'FFE7DFC9';
const ZEBRA = 'FFFAF7EF';
const TOTAL_BG = 'FFF3EDDD';

/**
 * Indian digit grouping in Excel needs LITERAL commas placed by hand: a format comma is a
 * group-by-three separator, so `#,##0` can never produce the 2-digit lakh/crore groups. The
 * placeholder pattern therefore depends on the value's magnitude, which is fine because we
 * write each cell individually and know its value.
 *
 * Both sections are always emitted (`positive;negative`) so a negative renders red and
 * bracketed. `dec` is the decimal placeholder tail, and `paren` picks the accounting
 * convention for money vs a plain minus for share counts.
 */
export function indianFmt(value: number, dec: string, paren: boolean): string {
  const a = Math.abs(value);
  const digits =
    a >= 1e7 ? '##\\,##\\,##\\,##0' :
    a >= 1e5 ? '##\\,##\\,##0' :
    a >= 1e3 ? '##\\,##0' :
    '##0';                                // below a thousand, a literal comma would leak out
  const body = digits + dec;
  return paren ? `${body};[Red](${body})` : `${body};[Red]-${body}`;
}

const numFmtFor = (col: ReportCol, n: number): string => {
  switch (col.type) {
    case 'int': return indianFmt(n, '', false);
    case 'money': return indianFmt(n, '.00', true);
    case 'rate': return indianFmt(n, '.00####', true);      // 2-6 dp, trailing zeros dropped
    case 'pct': return '0.00"%"';
    default: return 'General';
  }
};

/** Excel forbids : \ / ? * [ ] in a sheet name and caps it at 31 chars. */
const sheetName = (s: string) => (s || 'Report').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Report';

/**
 * Build the workbook for a report. Kept separate from the download so the layout can be
 * exercised (and read back) outside a browser.
 */
export async function buildXlsxWorkbook(doc: ReportDoc): Promise<any> {
  // Loaded on demand: ExcelJS is ~900 KB and nobody should pay for it until they export.
  const mod: any = await import('exceljs');
  const ExcelJS: any = mod?.default ?? mod;

  const wb = new ExcelJS.Workbook();
  wb.creator = doc.holder || 'Portfolio';
  wb.created = new Date();
  const titled = doc.titleTag ? `${doc.title} — ${doc.titleTag}` : doc.title;
  // Tab name puts the qualifier FIRST, because `sheetName` hard-truncates at Excel's 31-char
  // limit: "Capital Gains Report — Private Equity" would come back as "Capital Gains Report —
  // Private " and lose the one word that distinguishes it. Leading, it always survives.
  const tabTitle = doc.titleTag ? `${doc.titleTag} — ${doc.title}` : doc.title;
  const ws = wb.addWorksheet(sheetName(tabTitle), {
    views: [{ showGridLines: false }],
    pageSetup: {
      orientation: doc.landscape ? 'landscape' : 'portrait',
      paperSize: 9,                                       // A4
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });

  const ncols = doc.cols.length;
  const lastColLetter = (n: number) => {
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };

  // ── letterhead ───────────────────────────────────────────────────────────────
  let r = 1;
  const spanMerge = (row: number) => { if (ncols > 1) ws.mergeCells(row, 1, row, ncols); };

  ws.getCell(r, 1).value = doc.holder;
  ws.getCell(r, 1).font = { name: 'Calibri', size: 15, bold: true, color: { argb: BRASS } };
  spanMerge(r);
  ws.getRow(r).height = 21;
  r++;

  ws.getCell(r, 1).value = titled;
  ws.getCell(r, 1).font = { name: 'Calibri', size: 11, bold: true, color: { argb: INK } };
  spanMerge(r);
  r++;

  // A brass rule, drawn as a bottom border on an empty row.
  for (let c = 1; c <= ncols; c++) ws.getCell(r, c).border = { bottom: { style: 'medium', color: { argb: BRASS } } };
  ws.getRow(r).height = 5;
  r++;
  r++;                                                    // breathing room under the rule

  for (const [label, value] of doc.params) {
    ws.getCell(r, 1).value = label;
    ws.getCell(r, 1).font = { name: 'Calibri', size: 9, bold: true, color: { argb: MUTED } };
    ws.getCell(r, 2).value = value;
    ws.getCell(r, 2).font = { name: 'Calibri', size: 9, color: { argb: INK } };
    if (ncols > 2) ws.mergeCells(r, 2, r, Math.min(ncols, 5));
    r++;
  }
  r++;

  // ── header row ───────────────────────────────────────────────────────────────
  const hdrRow = r;
  doc.cols.forEach((col, i) => {
    const cell = ws.getCell(hdrRow, i + 1);
    cell.value = col.label;
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRASS } };
    cell.alignment = { horizontal: isNumericType(col.type) ? 'right' : 'left', vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: BRASS } } };
  });
  ws.getRow(hdrRow).height = 24;
  r++;

  // ── data ─────────────────────────────────────────────────────────────────────
  const firstDataRow = r;
  let lastFilterRow = hdrRow;                             // grows only over non-total rows
  let bodyIndex = 0;

  for (const row of doc.rows) {
    const excelRow = r;
    const isTotal = !!row.total;
    doc.cols.forEach((col, i) => {
      const cell = ws.getCell(excelRow, i + 1);
      const raw: CellValue = row.cells[col.key];

      if (col.type === 'date') {
        const d = cellDate(raw);
        if (d) { cell.value = d; cell.numFmt = 'dd-mmm-yyyy'; }
        else cell.value = raw === null || raw === undefined ? '' : raw.toString();
      } else if (isNumericType(col.type)) {
        const n = toNum(raw);
        if (n === null) cell.value = raw === null || raw === undefined ? '' : raw.toString();
        else { cell.value = n; cell.numFmt = numFmtFor(col, n); }
      } else {
        cell.value = raw === null || raw === undefined ? '' : raw.toString();
      }

      cell.font = { name: 'Calibri', size: 10, bold: isTotal, color: { argb: INK } };
      cell.alignment = {
        horizontal: isNumericType(col.type) ? 'right' : (col.type === 'date' ? 'center' : 'left'),
        vertical: 'middle',
      };
      if (isTotal) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_BG } };
        cell.border = { top: { style: 'thin', color: { argb: BRASS } }, bottom: { style: 'double', color: { argb: BRASS } } };
      } else {
        if (bodyIndex % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } };
        cell.border = { bottom: { style: 'hair', color: { argb: HAIRLINE } } };
      }
    });
    if (!isTotal) { lastFilterRow = excelRow; bodyIndex++; }
    r++;
  }

  // ── footnotes ────────────────────────────────────────────────────────────────
  if (doc.footnotes?.length) {
    r++;
    for (const note of doc.footnotes) {
      ws.getCell(r, 1).value = note;
      ws.getCell(r, 1).font = { name: 'Calibri', size: 8, italic: true, color: { argb: MUTED } };
      spanMerge(r);
      r++;
    }
  }

  // ── widths, panes, filter, print ─────────────────────────────────────────────
  doc.cols.forEach((col, i) => {
    let widest = col.label.length;
    for (const row of doc.rows) {
      const len = formatCell(col, row.cells[col.key]).length;
      if (len > widest) widest = len;
    }
    ws.getColumn(i + 1).width = Math.min(46, Math.max(9, widest + 3));
  });

  // Freeze the header and the first column, so a wide ledger keeps its labels in view.
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: hdrRow, showGridLines: false }];

  // The filter deliberately stops above any total row — a filtered total is a wrong total.
  if (lastFilterRow > hdrRow) {
    ws.autoFilter = { from: { row: hdrRow, column: 1 }, to: { row: lastFilterRow, column: ncols } };
  }

  ws.pageSetup.printTitlesRow = `${hdrRow}:${hdrRow}`;
  ws.pageSetup.printArea = `A1:${lastColLetter(ncols)}${r - 1}`;
  ws.headerFooter = {
    // printTitlesRow repeats only the column headers, so on printed page 2+ this footer is the
    // sheet's only statement of what it is. It must carry the scope.
    oddFooter: `&L&8${doc.holder} — ${titled}&R&8Page &P of &N`,
    evenFooter: `&L&8${doc.holder} — ${titled}&R&8Page &P of &N`,
  };

  void firstDataRow;                                      // (kept for readability of the layout above)

  return wb;
}

export async function downloadXlsx(doc: ReportDoc): Promise<void> {
  const wb = await buildXlsxWorkbook(doc);
  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${doc.filenameBase}.xlsx`,
  );
}
