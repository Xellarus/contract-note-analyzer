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

/** Format any of the shapes above as `dd/mm/yyyy`. Returns "" for empty, and the input
 *  verbatim when it isn't a date we recognise. */
export function formatDMY(value: any): string {
  if (value == null || value === "") return "";
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? "" : dmy(value.getDate(), value.getMonth() + 1, value.getFullYear());
  }

  const s = value.toString().trim();
  if (!s) return "";

  // Bare number → a Sheets serial (guarded to a plausible 1954-2119 window so a stray
  // quantity or price that reached a date column isn't rewritten as a date).
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    if (n > 20000 && n < 80000) { const { d, m, y } = fromSerial(n); return dmy(d, m, y); }
    return s;
  }

  // ISO yyyy-mm-dd (optionally with a time part) — unambiguous, check it first.
  let m0 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]|$)/);
  if (m0) return dmy(+m0[3], +m0[2], +m0[1]);

  // d-m-yyyy / m-d-yyyy / d.m.yyyy — resolve by whichever part is > 12.
  m0 = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m0) {
    const a = +m0[1], b = +m0[2], y = +m0[3];
    if (a > 12 && b <= 12) return dmy(a, b, y);        // certainly dd-mm
    if (b > 12 && a <= 12) return dmy(b, a, y);        // certainly mm-dd (legacy US rows)
    return dmy(a, b, y);                                // ambiguous → Indian dd-mm
  }

  // "25 Mar 2026" / "25-Mar-2026" / "Mar 25, 2026"
  m0 = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{4})$/);
  if (m0) { const mo = MONTHS[m0[2].slice(0, 3).toLowerCase()]; if (mo) return dmy(+m0[1], mo, +m0[3]); }
  m0 = s.match(/^([A-Za-z]{3,})[\s-]+(\d{1,2}),?[\s-]+(\d{4})$/);
  if (m0) { const mo = MONTHS[m0[1].slice(0, 3).toLowerCase()]; if (mo) return dmy(+m0[2], mo, +m0[3]); }

  return s;   // not a date we know — show it as-is rather than guess
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
