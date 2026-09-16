/**
 * One date formatter for everything the UI SHOWS. The user's rule: every displayed date is
 * `dd/mm/yyyy`, everywhere — Trade Book, inventory, realised gains, reports, importers.
 *
 * This is a DISPLAY layer only. Nothing here changes what is written to a sheet or exported
 * to CSV/XLSX/Tally: the ledger's own format ([[trade-ledger-schema]]: ISO) and the parsers
 * that read it are untouched. Call it at render time, keep the raw string in the model.
 *
 * It has to cope with every shape the sheets actually hold, because the app has accumulated
 * several over time:
 *   • ISO            "2025-04-30"            (what the writers emit today)
 *   • US             "04-30-2025"            (older True Entry rows)
 *   • Indian         "22-02-2024", "4/1/2024"
 *   • Long form      "25 Mar 2026"
 *   • Sheets serial  45658                   (a cell Sheets re-typed as a date)
 * Day/month is decided by whichever component EXCEEDS 12; when both are ≤ 12 the string is
 * genuinely ambiguous and we assume Indian dd-mm, which is how this app's own writers meant
 * it. Anything unrecognisable is returned unchanged rather than mangled into a wrong date.
 */

const pad = (n: number) => String(n).padStart(2, "0");
const dmy = (d: number, m: number, y: number) => `${pad(d)}/${pad(m)}/${y}`;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Sheets/Excel serial → {d,m,y}. Epoch is 1899-12-30; read in UTC so no TZ drift. */
const fromSerial = (n: number) => {
  const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
  return { d: dt.getUTCDate(), m: dt.getUTCMonth() + 1, y: dt.getUTCFullYear() };
};

/** A parsed calendar date, with `m` 1-based. */
export interface DMY { d: number; m: number; y: number; }

/**
 * Parse any of the shapes above into its calendar parts, or null when the value isn't a
 * date we recognise. This is the one parse step behind every formatter in this file, and
 * it is exported so the report exporters can render a date differently (`dd-Mmm-yyyy` in a
 * PDF, a real date cell in XLSX) WITHOUT growing a second parser — divergent date parsing
 * is exactly how this app has broken before.
 */
export function parseDMY(value: any): DMY | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : { d: value.getDate(), m: value.getMonth() + 1, y: value.getFullYear() };
  }

  const s = value.toString().trim();
  if (!s) return null;

  // Bare number → a Sheets serial (guarded to a plausible 1954-2119 window so a stray
  // quantity or price that reached a date column isn't rewritten as a date).
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    return n > 20000 && n < 80000 ? fromSerial(n) : null;
  }

  // ISO yyyy-mm-dd (optionally with a time part) — unambiguous, check it first.
  let m0 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]|$)/);
  if (m0) return { d: +m0[3], m: +m0[2], y: +m0[1] };

  // d-m-yyyy / m-d-yyyy / d.m.yyyy — resolve by whichever part is > 12.
  m0 = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m0) {
    const a = +m0[1], b = +m0[2], y = +m0[3];
    if (a > 12 && b <= 12) return { d: a, m: b, y };   // certainly dd-mm
    if (b > 12 && a <= 12) return { d: b, m: a, y };   // certainly mm-dd (legacy US rows)
    return { d: a, m: b, y };                          // ambiguous → Indian dd-mm
  }

  // "25 Mar 2026" / "25-Mar-2026" / "Mar 25, 2026"
  m0 = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{4})$/);
  if (m0) { const mo = MONTHS[m0[2].slice(0, 3).toLowerCase()]; if (mo) return { d: +m0[1], m: mo, y: +m0[3] }; }
  m0 = s.match(/^([A-Za-z]{3,})[\s-]+(\d{1,2}),?[\s-]+(\d{4})$/);
  if (m0) { const mo = MONTHS[m0[1].slice(0, 3).toLowerCase()]; if (mo) return { d: +m0[2], m: mo, y: +m0[3] }; }

  return null;   // not a date we know
}

/** Format any of the shapes above as `dd/mm/yyyy`. Returns "" for empty, and the input
 *  verbatim when it isn't a date we recognise. */
export function formatDMY(value: any): string {
  if (value == null || value === "") return "";
  const p = parseDMY(value);
  if (p) return dmy(p.d, p.m, p.y);
  if (value instanceof Date) return "";              // an invalid Date shows as nothing
  return value.toString().trim();                    // not a date we know — show it as-is rather than guess
}

const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `dd-Mmm-yyyy` — the form used in GENERATED REPORTS (PDF/XLSX) rather than the app's own
 * dd/mm/yyyy screens. A report can leave this machine and be read by someone who doesn't
 * know which convention it was written in, so the month is spelled out. Falls back to the
 * same as-is string as formatDMY when the value isn't a date.
 */
export function formatDMMMY(value: any): string {
  const p = parseDMY(value);
  if (!p || p.m < 1 || p.m > 12) return formatDMY(value);
  return `${pad(p.d)}-${MON3[p.m - 1]}-${p.y}`;
}

/** `dd/mm/yyyy hh:mm[:ss]` for stamps that carry a time (e.g. the Prices tab's "updated"). */
export function formatDMYTime(value: any): string {
  const s = (value ?? "").toString().trim();
  if (!s) return "";
  const t = s.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);          // keep the clock exactly as stored
  const datePart = t ? s.slice(0, t.index).trim().replace(/[,T]$/, "").trim() : s;
  const d = formatDMY(datePart);
  if (!t) return d;
  return d === datePart && !/^\d/.test(datePart) ? s : `${d} ${t[1]}`;
}

/** True when a column header names a date column — used to format generic sheet-backed
 *  tables (Reports) where cells are untyped strings. */
export const isDateHeader = (header: string): boolean =>
  /\bdate\b|^date$/i.test((header || "").trim());

/**
 * The `value` for a controlled `<input type="date">` that shows a DEFAULT until the user
 * sets its own date.
 *
 * The obvious spelling — `value={stored || fallback}` — is broken, and broken in a way no
 * type checker or build can see. A native date input reports `value === ""` for every
 * INTERMEDIATE state while it is being typed into: it only yields a date once day, month and
 * year are all filled. So the first keystroke sets `stored` to "", the `||` recomputes the
 * fallback, and because the fallback differs from the "" the DOM currently holds, React
 * writes it back to the node and WIPES the segment just typed. To the user the field snaps
 * to the default date on every keypress (reported 14-Sep-2026 on the Add Trade line date).
 *
 * `touched` breaks the loop: once the field is being edited, a half-typed date renders as ""
 * — equal to what the DOM already holds — so React leaves the node alone and typing works.
 *
 * The caller owns `touched`: set it in `onChange`, and clear it in `onBlur` WHEN THE FIELD IS
 * EMPTY, which is the only way back to showing the default.
 */
export const dateInputValue = (stored: string, fallback: string, touched: boolean): string =>
  touched ? stored : (stored || fallback);

/**
 * Bounds for EVERY `<input type="date">` in the app, and the guard that goes with them.
 *
 * A native date input's year segment is not four digits. Left unbounded it accepts up to SIX
 * (the HTML date range runs to 275760-09-13), so typing one digit too many in the year turns
 * `21-11-2025` into `21-11-20251` — reported 16-Sep-2026 on the Add Trade line date. The value
 * that comes out is a real, well-formed date string (`20251-11-21`), so nothing downstream
 * rejects it: it is written to the sheet, parsed back as a year twenty thousand years away, and
 * lands outside every FY the register knows about. The row simply vanishes from the tab it
 * belonged on.
 *
 * Two defences, because the first one is a browser behaviour rather than a guarantee:
 *
 *   1. `min` / `max` on the element. Chrome sizes the year segment from `max`, so a four-digit
 *      bound is what stops the fifth keystroke being accepted at all.
 *   2. `isDateInputSane` in `onChange`. Reject the change — do NOT rewrite it — and the
 *      controlled input's unchanged `value` prop makes React restore the node on the next
 *      render. Rewriting it here instead would re-open the wipe that `dateInputValue` exists to
 *      prevent, because any non-empty write differs from the "" a half-typed field reports.
 *
 * The empty string MUST pass: it is what the DOM reports for every intermediate typing state.
 */
export const DATE_INPUT_MIN = "1900-01-01";
export const DATE_INPUT_MAX = "2099-12-31";

export const isDateInputSane = (v: string): boolean => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v);
