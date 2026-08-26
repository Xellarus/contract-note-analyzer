/**
 * One typed document model for every report the app generates, plus the CSV renderer and
 * the shared number/date formatting. `reportXlsx.ts` and `reportPdf.ts` render the SAME
 * model, so a report only has to describe itself once to gain all three formats.
 *
 * Why a model at all: the report screens used to hand `string[][]` straight to a hand-rolled
 * CSV writer, and `String(qty)` throws the type away. A stringified number lands in Excel as
 * left-aligned text you cannot sum, and leaves a PDF renderer no way to know a column wants
 * decimal alignment. The column types are declared once, here.
 *
 * Formatting conventions, which are what make the output read as a financial statement:
 *   • Indian grouping (1,02,450.00) via en-IN — never 102,450.00
 *   • negative MONEY in parentheses, the accounting convention — never a leading minus
 *   • negative QUANTITY keeps its minus, because a bracketed share count reads as a footnote
 *     and a negative balance here means a real discrepancy the reader must notice
 *   • money at 2 dp (paise) but per-share rates at up to 6 — cost/share is never rounded to
 *     paise in this app ([[no-rounding-cost-basis]])
 *   • dates as dd-Mmm-yyyy, spelled out, because a report can leave this machine
 */
import { isDateHeader, parseDMY, formatDMMMY } from './dates';

/** How a column is aligned, formatted, and typed in the XLSX cell. */
export type ColType =
  | 'text'    // left-aligned, written as a string
  | 'int'     // right, grouped, no decimals — quantities
  | 'money'   // right, 2 dp — amounts, charges, realised P&L
  | 'rate'    // right, 2-6 dp — per-share price/cost, never rounded to paise
  | 'date'    // right-of-left, dd-Mmm-yyyy, a real date cell in XLSX
  | 'pct';    // right, 2 dp with a % suffix

export interface ReportCol {
  /** Key into each row's `cells`. */
  key: string;
  label: string;
  type: ColType;
}

export type CellValue = string | number | null | undefined;

export interface ReportRow {
  cells: Record<string, CellValue>;
  /**
   * Marks a total/subtotal row that is already part of the data (the expense report and the
   * holding report both build their own). Rendered ruled and bold, and excluded from the
   * XLSX autofilter range so filtering can't hide or mislabel it. Nothing here INVENTS a
   * total — a report that doesn't already compute one doesn't get one.
   */
  total?: boolean;
}

export interface ReportDoc {
  /** Letterhead heading — the portfolio holder's name. */
  holder: string;
  /** e.g. "Capital Gains Statement". */
  title: string;
  /**
   * Short qualifier that narrows what the report covers — e.g. "Equity", "Private Equity".
   * Undefined when the report covers everything.
   *
   * Deliberately a SEPARATE field rather than something the caller appends to `title`: each
   * renderer places it where that format's per-page identity lives (a PDF's running header on
   * pages 2+, an XLSX tab name and print footer), and the XLSX sheet name is hard-capped at 31
   * characters — appending would truncate mid-word and lose exactly the part that distinguishes
   * two otherwise identical statements.
   */
  titleTag?: string;
  /** Parameter block stating exactly what was computed: [label, value] pairs. */
  params: Array<[string, string]>;
  cols: ReportCol[];
  rows: ReportRow[];
  /** Disclosure lines printed beneath the table (cost basis, conventions, caveats). */
  footnotes?: string[];
  /** Wide tables want landscape. */
  landscape?: boolean;
  /** Filename stem, without extension. */
  filenameBase: string;
}

// ── numbers ────────────────────────────────────────────────────────────────────

const group = (n: number, min: number, max: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: min, maximumFractionDigits: max });

/** Accounting convention: negative amounts in parentheses. */
export const fmtMoney = (n: number) => (n < 0 ? `(${group(-n, 2, 2)})` : group(n, 2, 2));
/** Per-share rates: 2 dp minimum, up to 6 kept when they carry real precision. */
export const fmtRate = (n: number) => (n < 0 ? `(${group(-n, 2, 6)})` : group(n, 2, 6));
/** Quantities keep a visible minus — a negative holding is a discrepancy, not a credit. */
export const fmtInt = (n: number) => group(n, 0, 0);
export const fmtPct = (n: number) => `${group(n, 2, 2)}%`;

/**
 * Sheet cells reach us as display strings ("1,24,500.00", "(5,08,347.06)", "₹120", "").
 * Returns null for anything that isn't a number, so a caller can fall back to the raw text
 * rather than write a silent 0.
 */
export const toNum = (v: CellValue): number | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = v.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }   // accounting negative
  s = s.replace(/[,\s₹]/g, '');                            // grouping, spaces, ₹
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
};

/** The display string for a cell, per its column type. Used by the PDF renderer. */
export function formatCell(col: ReportCol, v: CellValue): string {
  if (v === null || v === undefined || v === '') return '';
  if (col.type === 'text') return v.toString();
  if (col.type === 'date') return formatDMMMY(v);
  const n = toNum(v);
  if (n === null) return v.toString();          // not numeric after all — show it verbatim
  switch (col.type) {
    case 'int': return fmtInt(n);
    case 'money': return fmtMoney(n);
    case 'rate': return fmtRate(n);
    case 'pct': return fmtPct(n);
    default: return v.toString();
  }
}

/** True when the column's values sit on the right-hand, decimal-aligned side of the table. */
export const isNumericType = (t: ColType) => t === 'int' || t === 'money' || t === 'rate' || t === 'pct';

// ── column type inference for sheet-backed reports ─────────────────────────────

/**
 * Columns whose values are numeric-LOOKING but are identifiers, never quantities. Grouping a
 * BSE scrip code into "5,12,595" is the classic way an export betrays that nothing understood
 * the data, so these are pinned to text before any other rule runs.
 */
const NEVER_NUMERIC =
  /isin|scrip\s*code|security\s*code|\bcode\b|\bpan\b|folio|dp\s*id|client|\bucc\b|contract|note\s*no|voucher|order\s*(id|no)|trade\s*id|\bid\b|symbol|series|phone|pin/i;

const TEXTY =
  /name|company|scrip|asset|narration|remark|note|broker|exchange|status|type|segment|category|description|action|ratio|source/i;

/**
 * Infer a column's type from its header, with the cell values as a tiebreak. The reports that
 * read a sheet tab (capital gains, transactions) take their headers from whatever the tab
 * holds, so the type cannot be declared up front.
 *
 * This is inference, so it is deliberately conservative: a header that matches nothing falls
 * back to `text` unless EVERY non-empty sample parses as a number. Getting it wrong towards
 * text costs alignment; getting it wrong towards money would reformat a value.
 */
export function inferColType(label: string, samples: CellValue[] = []): ColType {
  const h = (label || '').trim();
  if (!h) return 'text';

  if (isDateHeader(h)) return 'date';
  if (NEVER_NUMERIC.test(h)) return 'text';
  if (/\bqty\b|quantity|number of shares|\bshares\b|\bunits\b|days|\bcount\b/i.test(h)) return 'int';
  if (/(avg|average)\s*(buy\s*)?(price|cost)|\bprice\b|\brate\b|cost per|per share/i.test(h)) return 'rate';
  if (/%|percent/i.test(h)) return 'pct';
  if (/amount|value|turnover|brokerage|\bstt\b|\bgst\b|igst|charges|chgs|duty|fees|p\s*&?\s*l|profit|loss|gain|\bnet\b|total|invested|expense|stamp|\bipf\b|demat|\bsebi\b|debit|credit|balance/i.test(h)) return 'money';
  if (TEXTY.test(h)) return 'text';

  // Header told us nothing. Promote only if every value present is genuinely a number.
  const present = samples.filter(v => v !== null && v !== undefined && v.toString().trim() !== '');
  if (present.length === 0) return 'text';
  const nums = present.map(toNum);
  if (nums.some(n => n === null)) return 'text';
  return nums.some(n => !Number.isInteger(n as number)) ? 'money' : 'int';
}

/**
 * Build typed columns for a report whose header row came from a sheet. `rows` are the raw
 * string rows, positionally aligned with `header`.
 */
export function inferCols(header: string[], rows: string[][], sampleLimit = 200): ReportCol[] {
  const sample = rows.slice(0, sampleLimit);
  return header.map((label, i) => ({
    key: String(i),
    label,
    type: inferColType(label, sample.map(r => r?.[i])),
  }));
}

/** Wrap raw sheet rows as ReportRows keyed by column index, flagging any TOTAL row. */
export function rowsFromGrid(header: string[], rows: string[][]): ReportRow[] {
  return rows.map(r => {
    const cells: Record<string, CellValue> = {};
    header.forEach((_, i) => { cells[String(i)] = r?.[i] ?? ''; });
    const first = (r?.[0] ?? '').toString().trim().toUpperCase();
    return { cells, total: first === 'TOTAL' || first === 'GRAND TOTAL' };
  });
}

// ── CSV ────────────────────────────────────────────────────────────────────────

const csvEsc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** A cell's RAW value for CSV — a number as plain digits, a string untouched. */
const rawCell = (v: CellValue): string => {
  if (v === null || v === undefined) return '';
  return typeof v === 'number' ? String(v) : v;
};

/**
 * Header row + data rows, CRLF-terminated. Deliberately carries NO letterhead, no parameter
 * block and no formatting: CSV's job here is to stay machine-readable and byte-compatible
 * with what this app already emitted, so anything downstream that parses these files keeps
 * working. The letterhead lives in the XLSX and PDF renderers.
 */
export function toCsv(doc: ReportDoc): string {
  const lines = [doc.cols.map(c => csvEsc(c.label)).join(',')];
  for (const r of doc.rows) lines.push(doc.cols.map(c => csvEsc(rawCell(r.cells[c.key]))).join(','));
  return lines.join('\r\n');
}

// ── download plumbing ──────────────────────────────────────────────────────────

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking synchronously can beat the download in Firefox; one tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(doc: ReportDoc): void {
  downloadBlob(new Blob([toCsv(doc)], { type: 'text/csv;charset=utf-8;' }), `${doc.filenameBase}.csv`);
}

/** Sanitise a string for use in a filename. */
export const fileSafe = (s: string) => (s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** A cell as a real Date when the column is a date and the value parses, else null. */
export function cellDate(v: CellValue): Date | null {
  const p = parseDMY(v);
  if (!p || p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) return null;
  // Midday local time, so neither a timezone shift nor Excel's serial rounding can move the
  // cell onto the adjacent day.
  return new Date(p.y, p.m - 1, p.d, 12, 0, 0);
}
