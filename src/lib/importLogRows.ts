/**
 * Turning the raw `Import Log` sheet into the rows the Imports page shows.
 *
 * Kept out of the component (and free of any gapi import) for two reasons: the column
 * layout is the fiddly part — the log has grown from 5 columns to 9 over time, so every
 * column is located BY NAME with a positional fallback — and "can this row be rewound?"
 * is a rule the table and the Rewind confirmation must agree on exactly.
 *
 * The log is written by `logImport` in [accessLog](./accessLog.ts); see its IMPORT_HEADER
 * for the current schema.
 */
import { formatDMY } from "./dates";
import { portfolioByCode } from "./portfolios";

/** 0-based column index for each field; -1 when the log doesn't have that column. */
export interface ImportLogCols {
  date: number;
  time: number;
  note: number;
  broker: number;
  user: number;
  importId: number;
  portfolio: number;
  rows: number;
  status: number;
}

/**
 * Locate every column by header name, falling back to its position in the current schema.
 *
 * The patterns are ANCHORED where a loose one would collide: a bare /name/ matches
 * "Contract Note Name" long before it reaches "User", and /date/ would match a future
 * "Date Added". Import ID and Status have no positional fallback — a log old enough to
 * lack them cannot be rewound at all, and guessing a column there would write "Reversed"
 * into whatever happens to sit at index 8.
 */
export function resolveImportLogCols(header: string[]): ImportLogCols {
  const lc = (header || []).map((h) => (h ?? "").toString().trim().toLowerCase());
  const at = (re: RegExp, fallback: number) => {
    const i = lc.findIndex((h) => re.test(h));
    return i >= 0 ? i : fallback;
  };
  return {
    date: at(/^date$/, 0),
    time: at(/^time$/, 1),
    note: at(/note|file/, 2),
    broker: at(/^broker$/, 3),
    user: at(/^user$/, 4),
    importId: at(/import id|import batch|batch id/, -1),
    portfolio: at(/portfolio/, 6),
    rows: at(/^rows$/, 7),
    status: at(/status/, -1),
  };
}

/** One import, resolved for display. */
export interface ImportLogRow {
  /** 1-based sheet row, so the Status cell can be written back in place. */
  sheetRow: number;
  /** The date exactly as stored — kept so a search for "13 Aug" still matches. */
  dateRaw: string;
  /** dd/mm/yyyy (the app's display convention). */
  date: string;
  time: string;
  note: string;
  broker: string;
  user: string;
  portfolioCode: string;
  /** Resolved portfolio label, falling back to the raw code when unknown. */
  portfolio: string;
  rows: string;
  importId: string;
  reversed: boolean;
  /** Rewind needs an Import ID to match ledger rows by, and something to remove. */
  canRewind: boolean;
  /** Lower-cased haystack for the search box. */
  search: string;
}

/**
 * Map sheet rows (oldest first, as `fetchImportLog` returns them) to display rows,
 * NEWEST FIRST. Sheet order is insertion order, so that's just a reverse — no date
 * parsing involved, which keeps a row with an unreadable date in its true position.
 */
export function buildImportLogRows(rows: string[][], cols: ImportLogCols, firstDataRow: number): ImportLogRow[] {
  const out: ImportLogRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i] || [];
    const get = (ci: number) => (ci >= 0 ? (cells[ci] ?? "").toString().trim() : "");
    const dateRaw = get(cols.date);
    const code = get(cols.portfolio);
    const nRows = get(cols.rows);
    const importId = get(cols.importId);
    const r: ImportLogRow = {
      sheetRow: firstDataRow + i,
      dateRaw,
      date: formatDMY(dateRaw),
      time: get(cols.time),
      note: get(cols.note),
      broker: get(cols.broker),
      user: get(cols.user),
      portfolioCode: code,
      portfolio: (code && portfolioByCode(code)?.label) || code,
      rows: nRows,
      importId,
      reversed: get(cols.status).toLowerCase() === "reversed",
      canRewind: !!importId && nRows !== "0",
      search: "",
    };
    r.search = [r.date, r.dateRaw, r.time, r.note, r.broker, r.user, r.portfolio, r.portfolioCode]
      .join(" ").toLowerCase();
    out.push(r);
  }
  return out.reverse();
}

export interface ImportLogFilter {
  /** Free text; every whitespace-separated term must match (AND), in any field. */
  query?: string;
  /** Exact broker match, as stored in the log. "" = all. */
  broker?: string;
  /** Exact resolved portfolio label. "" = all. */
  portfolio?: string;
}

export function filterImportLogRows(all: ImportLogRow[], f: ImportLogFilter): ImportLogRow[] {
  const terms = (f.query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const broker = f.broker || "";
  const portfolio = f.portfolio || "";
  return all.filter((r) => {
    if (broker && r.broker !== broker) return false;
    if (portfolio && r.portfolio !== portfolio) return false;
    return terms.every((t) => r.search.includes(t));
  });
}

/** Distinct, sorted values of one field — populates the broker / portfolio dropdowns. */
export function distinctValues(all: ImportLogRow[], pick: (r: ImportLogRow) => string): string[] {
  return Array.from(new Set(all.map(pick).filter(Boolean))).sort();
}
