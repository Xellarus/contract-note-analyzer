import { downloadBlob, fileSafe } from './reportDoc';
import { OPENING_CUTOFF_ISO, TEMPLATE_SHEET } from './stockOpeningImport';

/**
 * The downloadable opening-trades template — a two-sheet workbook: the data tab you fill in,
 * and an Instructions tab describing every column.
 *
 * Why .xlsx and not the "sample CSV" it is called in the UI: a CSV is one flat text file and
 * cannot carry two tabs. The instructions have to live SOMEWHERE the data tab is not, or the
 * first row of the import is a paragraph of prose. The importer accepts .csv all the same, so
 * anyone who prefers one can still save the data tab out as CSV and upload that.
 *
 * ExcelJS, not the `xlsx` package: SheetJS's community build silently drops cell styles on
 * write (see reportXlsx.ts), and an unstyled template with no header emphasis, no column
 * widths and no BUY/SELL dropdown is materially worse at its one job. Loaded on demand so it
 * stays out of the first-load bundle.
 *
 * The data tab ships with NO example row, deliberately — the reference template the owner
 * supplied has none either, and a pre-filled row in the sheet you are about to upload is a
 * phantom trade waiting to be imported. The worked example lives in the Instructions table.
 */

const BRASS = 'FF8A6A1E';
const INK = 'FF2F2A1F';
const PAPER = 'FFF3EDDD';
const HAIRLINE = 'FFE7DFC9';

export interface TemplateCol {
  header: string;
  width: number;
  mandatory: boolean;
  description: string;
  fieldType: string;
  example: string;
}

/**
 * The column set, mirroring the reference template. `mandatory` drives both the `*` in the
 * header and the Mandatory column of the Instructions tab, so the two can never disagree.
 *
 * Every charge column is present because a broker statement has them and stripping them would
 * make the file harder to paste into — but they are READ AND IGNORED on import. Capital gains
 * in this app are computed on turnover, and under s.48 STT is not a deductible expense, so a
 * charge folded into the cost basis here would be wrong in both directions at once.
 */
export const TEMPLATE_COLS: TemplateCol[] = [
  { header: 'Date', width: 13, mandatory: true, description: 'Date of trade', fieldType: 'Date (DD/MM/YYYY)', example: '27/03/2025' },
  { header: 'Company Name', width: 30, mandatory: false, description: 'Checked against the stock you opened this from — a different company is rejected, never relabelled', fieldType: 'Text', example: '' },
  { header: 'ISIN', width: 16, mandatory: false, description: 'ISIN, or the BSE code / NSE symbol. Checked the same way as the name', fieldType: 'INE00WC01027 / 542752 / AFFLE', example: '' },
  { header: 'Trans Type', width: 12, mandatory: true, description: 'Whether the trade was a buy or a sell', fieldType: 'Dropdown (BUY / SELL)', example: 'BUY' },
  { header: 'Quantity', width: 12, mandatory: true, description: 'Number of shares', fieldType: 'Number', example: '100' },
  { header: 'Price', width: 14, mandatory: true, description: 'Price per share, excluding charges. Keep the full precision your broker shows', fieldType: 'Number', example: '250.09' },
  { header: 'Total Amount (Turnover)', width: 20, mandatory: false, description: 'Quantity × Price, EXCLUDING every charge. Fill it and it becomes the cost basis (more precise than a rounded price); leave it blank and Price is used', fieldType: 'Number', example: '25009.00' },
  { header: 'Brokerage Per Share', width: 18, mandatory: false, description: 'Recorded only — see the note on charges below', fieldType: 'Number', example: '' },
  { header: 'Total Brokerage', width: 15, mandatory: false, description: 'Recorded only', fieldType: 'Number', example: '' },
  { header: 'STT', width: 11, mandatory: false, description: 'Recorded only', fieldType: 'Number', example: '' },
  { header: 'Exchange Turnover Charges', width: 22, mandatory: false, description: 'Recorded only', fieldType: 'Number', example: '' },
  { header: 'Fees', width: 11, mandatory: false, description: 'Recorded only', fieldType: 'Number', example: '' },
  { header: 'IPF Charges', width: 13, mandatory: false, description: 'Recorded only', fieldType: 'Number', example: '' },
  { header: 'Demat Charges', width: 14, mandatory: false, description: 'Recorded only', fieldType: 'Number', example: '' },
];

const headerLabel = (c: TemplateCol) => (c.mandatory ? `${c.header}*` : c.header);

/** Rows that must be true of the import, stated where the person filling the sheet will read them. */
const notes = (stockName: string): string[] => [
  `Only the columns marked with an asterisk * are compulsory.`,
  `Every row must be this stock's own trade — ${stockName || 'the stock you opened this from'}. Rows naming another company (or another ISIN) are rejected and counted, never filed under this one.`,
  `Only trades dated ON OR BEFORE ${OPENING_CUTOFF_ISO} are imported. Anything later belongs in the trade book and is counted as dropped.`,
  `Trades are ADDED to what is already there — nothing is replaced. A SELL consumes the oldest shares already on the sheet, FIFO.`,
  `Uploading the same file twice is safe: a row already present (same date, type, quantity and price) is skipped.`,
  `Add older trades BEFORE newer ones when a batch also contains sells, so the FIFO order matches the order the trades actually happened in.`,
  `Charges (brokerage, STT, fees, IPF, demat) are recorded but do NOT enter the cost basis: every gain in this app is computed on turnover, and under s.48 STT is not a deductible expense.`,
  `Bonus, split and rights rows are not handled here — enter those on the stock's page so their ratio is stored.`,
];

/**
 * The workbook itself. Exported (rather than inlined into the download) so a test can build it
 * and read it straight back through the importer — the one check that catches this file's
 * column headers drifting away from the keywords findHeader looks for, which would ship a
 * template the app cannot read.
 */
export async function buildOpeningTemplateBlob(stockName: string, isin: string): Promise<Blob> {
  const mod: any = await import('exceljs');
  const ExcelJS = mod.default || mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Contract Note Analyser';

  // ── Sheet 1: the grid you fill in ────────────────────────────────────────────────────────
  const ws = wb.addWorksheet(TEMPLATE_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = TEMPLATE_COLS.map(c => ({ header: headerLabel(c), key: c.header, width: c.width }));

  const head = ws.getRow(1);
  head.height = 22;
  head.eachCell((cell: any, col: number) => {
    cell.font = { bold: true, size: 10, color: { argb: INK } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: BRASS } } };
    if (TEMPLATE_COLS[col - 1]?.mandatory) cell.font = { bold: true, size: 10, color: { argb: BRASS } };
  });

  // Typed, validated blank rows. Without these the date column comes back as text in whatever
  // the machine's locale is, and "Trans Type" comes back as whatever was typed — the two most
  // common ways a hand-filled sheet fails to import.
  const ROWS = 500;
  const colLetter = (i: number) => ws.getColumn(i + 1).letter;
  const dateCol = colLetter(0), typeCol = colLetter(3);
  for (let r = 2; r <= ROWS + 1; r++) {
    ws.getCell(`${dateCol}${r}`).numFmt = 'dd/mm/yyyy';
    ws.getCell(`${typeCol}${r}`).dataValidation = {
      type: 'list', allowBlank: true, formulae: ['"BUY,SELL"'],
      showErrorMessage: true, errorTitle: 'Trans Type', error: 'Enter BUY or SELL.',
    };
  }

  // ── Sheet 2: how to use it ───────────────────────────────────────────────────────────────
  const inst = wb.addWorksheet('Instructions');
  inst.columns = [
    { width: 26 }, { width: 64 }, { width: 34 }, { width: 18 }, { width: 12 },
  ];

  const title = inst.addRow(['How to use the upload template sheet?']);
  title.font = { bold: true, size: 12, color: { argb: INK } };
  title.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER } };
  inst.addRow([]);

  notes(stockName).forEach((n, i) => {
    const r = inst.addRow([i + 1, n]);
    r.getCell(1).alignment = { horizontal: 'right' };
    r.getCell(1).font = { color: { argb: BRASS }, bold: true };
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    r.height = 28;
  });

  inst.addRow([]);
  if (stockName) {
    const ctx = inst.addRow(['This copy was generated for:', isin ? `${stockName}  ·  ${isin}` : stockName]);
    ctx.font = { bold: true, color: { argb: BRASS } };
    inst.addRow([]);
  }

  const hdr = inst.addRow(['Field Name', 'Description', 'Field type', 'Example', 'Mandatory']);
  hdr.eachCell((cell: any) => {
    cell.font = { bold: true, size: 10, color: { argb: INK } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER } };
    cell.border = { bottom: { style: 'thin', color: { argb: BRASS } } };
  });

  for (const c of TEMPLATE_COLS) {
    const example = c.header === 'Company Name' ? (stockName || c.example)
      : c.header === 'ISIN' ? (isin || c.example)
      : c.example;
    const r = inst.addRow([c.header, c.description, c.fieldType, example, c.mandatory ? 'YES' : 'No']);
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    r.getCell(5).alignment = { horizontal: 'center' };
    if (c.mandatory) r.getCell(5).font = { bold: true, color: { argb: BRASS } };
    r.eachCell((cell: any) => { cell.border = { bottom: { style: 'hair', color: { argb: HAIRLINE } } }; });
    r.height = 26;
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** Build and download the template for one stock. */
export async function downloadOpeningTemplate(stockName: string, isin: string): Promise<void> {
  const blob = await buildOpeningTemplateBlob(stockName, isin);
  const stem = fileSafe(stockName) || 'Opening';
  downloadBlob(blob, `${stem}_Opening_Trades_Template.xlsx`);
}
