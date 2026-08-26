import { gapi } from "gapi-script";
import { parseDMY } from "./dates";

/**
 * The **Private Equities** tab of the shared scrip-master spreadsheet — the list of
 * UNLISTED companies the book holds. Maintained BY HAND in the sheet (there is no
 * contract note for a private placement, so nothing can seed it automatically); the
 * app only ever reads it.
 *
 * Minimum shape is `Company | Drive Link`. Columns are located from the HEADER rather
 * than by position, so they can sit in any order and extra columns can be added later
 * without a code change — the same rule the scrip master itself follows, and the reason
 * [[Opening Holdings Positional Reader]] is on the problem list.
 *
 * Recognised headers:
 *   Company        — the company name. This is the identity: PE has no ISIN, so the
 *                    name is what a trade resolves against.
 *   Drive Link     — the Google Drive folder holding that company's documents. Shown
 *                    on the company page in the same slot as a listed company's
 *                    Screener.in link.
 *   ISIN           — optional. Some unlisted companies do have one; supplying it makes
 *                    the match exact instead of name-based.
 *   Valuation      — optional per-share fair value. BLANK MEANS HELD AT COST — the app
 *                    never invents a valuation for an unlisted holding.
 *   Valuation Date — optional as-on date for that valuation, shown beside it.
 *   Notes          — optional free text.
 *
 * These rows are folded into the in-memory `ScripMaster` at load (see `loadScripMaster`),
 * which is what makes a PE company resolvable everywhere the app already resolves a
 * scrip — the typeahead, manual trade entry, the FIFO engines, capital gains, reports.
 * This module deliberately imports nothing from `scripMaster` so that fold-in direction
 * stays one-way and cycle-free.
 */
const PE_TAB = "Private Equities";

export interface PrivateEquityRow {
  company: string;
  driveLink: string;
  isin: string;
  /** Per-share fair value. 0 ⇒ none given ⇒ the holding is valued at cost. */
  valuation: number;
  /** ISO `yyyy-mm-dd`, or "" when absent/unparseable. */
  valuationDate: string;
  notes: string;
}

let _cache: { id: string; rows: PrivateEquityRow[]; ts: number } | null = null;
const TTL_MS = 60_000;

/**
 * Retry a transient Sheets failure (429 / 5xx). This read is LOAD-CRITICAL in the same way the
 * scrip master's own read is: a single rate-limited attempt sets `peFailed`, which blocks every
 * asset-class-scoped report and drops the unlisted long-term holding period from 24 months back
 * to 12. Mirrors `sheetsBackoff` in scripMaster.ts — duplicated rather than imported because
 * that module imports THIS one, and the fold-in direction has to stay one-way.
 */
async function peBackoff<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e: any) {
      last = e;
      const code = Number(e?.result?.error?.code ?? e?.status ?? 0);
      const msg = String(e?.result?.error?.message ?? e?.message ?? "");
      // An absent tab is a permanent, meaningful answer — never retry it.
      if (/unable to parse range/i.test(msg)) throw e;
      if (code !== 429 && code !== 500 && code !== 503) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw last;
}

export function invalidatePrivateEquityCache(): void { _cache = null; }

const toNum = (v: any): number => {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const n = parseFloat((v ?? "").toString().replace(/[₹,\s]/g, "").trim());
  return isNaN(n) ? 0 : n;
};

/**
 * Only an http(s) URL becomes a link. A cell holding a note, a folder id or anything
 * else stays out of the DOM rather than becoming an href — and `javascript:` can never
 * reach an anchor this way.
 */
const cleanUrl = (v: any): string => {
  const s = (v ?? "").toString().trim();
  return /^https?:\/\//i.test(s) ? s : "";
};

/** Raw cell → ISO `yyyy-mm-dd`. Handles a Sheets serial (we read UNFORMATTED) and every
 *  string shape `parseDMY` knows; anything else yields "" rather than a wrong date. */
const isoDate = (v: any): string => {
  const p = parseDMY(v);
  return p ? `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}` : "";
};

export function parsePrivateEquityVals(vals: any[][]): PrivateEquityRow[] {
  if (!vals || vals.length === 0) return [];

  // Column order is read from the header. Detection order matters: "Valuation Date"
  // contains "valuation", so the date test has to run first or the date column would be
  // read as the price. Same shape of trap the scrip master's "Tally Name" hit.
  const row0 = vals[0] || [];
  const header = row0.map((h: any) => (h ?? "").toString().toLowerCase().trim());
  // Row 0 is a HEADER only if it reads like LABELS: a recognised keyword, and nothing that is
  // plainly a value. Keyword alone isn't enough — a Drive URL contains the word "drive", so a
  // headerless sheet's first company row would be swallowed as the header and vanish.
  const hasKeyword = header.some((h) => /company|name|drive|link|folder|url|isin|valuation|value|note|remark|sector/.test(h));
  const hasValueCell = row0.some((c: any) => typeof c === "number" || /^https?:\/\//i.test((c ?? "").toString().trim()));
  const hasHeader = hasKeyword && !hasValueCell;
  const ci = { company: 0, driveLink: 1, isin: -1, valuation: -1, valuationDate: -1, notes: -1 };
  if (hasHeader) {
    let companySet = false, driveSet = false;
    header.forEach((h, idx) => {
      if (!h) return;
      if (/valuation date|value date|val date|as on|as at|as of/.test(h)) ci.valuationDate = idx;
      else if (/drive|folder|link|url|docs/.test(h)) { if (!driveSet) { ci.driveLink = idx; driveSet = true; } }
      else if (/isin/.test(h)) ci.isin = idx;
      else if (/valuation|fair value|value per|price per|per share/.test(h)) ci.valuation = idx;
      else if (/note|remark|comment/.test(h)) ci.notes = idx;
      else if (!companySet && /company|name|scrip|security|entity/.test(h)) { ci.company = idx; companySet = true; }
    });
    // A header with no name-like column at all → fall back to column A, which is where
    // the user was told to put the company.
    if (!companySet) ci.company = 0;
    if (!driveSet) ci.driveLink = -1;
  }

  const rows: PrivateEquityRow[] = [];
  const seen = new Set<string>();
  const start = hasHeader ? 1 : 0;
  for (let i = start; i < vals.length; i++) {
    const r = vals[i]; if (!r) continue;
    const company = (r[ci.company] ?? "").toString().trim();
    if (!company) continue;                              // the name IS the identity — no name, no row
    const dedup = company.toLowerCase();
    if (seen.has(dedup)) continue;                       // first row wins, like the scrip master
    seen.add(dedup);
    rows.push({
      company,
      driveLink: ci.driveLink >= 0 ? cleanUrl(r[ci.driveLink]) : "",
      isin: ci.isin >= 0 ? (r[ci.isin] ?? "").toString().trim().toUpperCase() : "",
      valuation: ci.valuation >= 0 ? Math.max(0, toNum(r[ci.valuation])) : 0,
      valuationDate: ci.valuationDate >= 0 ? isoDate(r[ci.valuationDate]) : "",
      notes: ci.notes >= 0 ? (r[ci.notes] ?? "").toString().trim() : "",
    });
  }
  return rows;
}

/**
 * Read the Private Equities tab.
 *
 * Returns `[]` only when the tab genuinely doesn't exist yet (so the feature is inert
 * until the user creates it). A REAL read error is thrown, never swallowed into an empty
 * list: an empty list means "there are no private companies", and the caller acts on
 * that — it would drop every PE holding back into the listed-equity grid and value it as
 * if it were an ordinary unpriced stock. Same lesson as the price read that got cached
 * as "no prices" and showed the book's cost as its AUM.
 *
 * Read UNFORMATTED so a valuation arrives as a number and a date as a serial, rather
 * than as whatever string the sheet's locale renders (see [[date-serials]]).
 */
export async function loadPrivateEquities(spreadsheetId: string, opts?: { force?: boolean }): Promise<PrivateEquityRow[]> {
  const now = Date.now();
  if (!opts?.force && _cache && _cache.id === spreadsheetId && now - _cache.ts < TTL_MS) return _cache.rows;

  let res: any;
  try {
    res = await peBackoff(() => (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${PE_TAB}!A1:J5000`,
      valueRenderOption: "UNFORMATTED_VALUE",
    }));
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || "";
    if (/unable to parse range/i.test(msg)) {
      _cache = { id: spreadsheetId, rows: [], ts: now };   // tab absent — a real, cacheable answer
      return [];
    }
    throw e;
  }

  const rows = parsePrivateEquityVals(res?.result?.values || []);
  _cache = { id: spreadsheetId, rows, ts: now };
  return rows;
}

/** The tab's name, for messages that tell the user where to add a company. */
export const PRIVATE_EQUITIES_TAB = PE_TAB;
