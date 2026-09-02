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
const AIF_TAB = "AIF";
const MF_TAB = "Mutual Fund";

/**
 * The NON-LISTED asset classes, each on its own hand-maintained tab of the shared scrip master.
 * All three tabs share the identical column shape and reader; what differs is the POLICY the
 * fold-in applies, which is why that lives here as data rather than as branches.
 */
export type AssetClassId = "PE" | "AIF" | "MF";

export interface AssetClassPolicy {
  id: AssetClassId;
  /** The sheet tab this class is read from. */
  tab: string;
  /** Full name, for prose and report scopes. */
  label: string;
  /** Short badge text for a table cell. */
  badge: string;
  /**
   * Long-term threshold in days, or NULL when the rule is deliberately not decided yet - the
   * capital-gains engines must then REFUSE to classify a sale rather than pick a number.
   *
   * PE and AIF: 730. Unlisted securities, and AIF Cat I/II units are unlisted units.
   *
   * MF: null, on purpose. There is no single answer - an equity-oriented fund is long-term at
   * 12 months WITH STT on redemption, a debt fund bought after 1-Apr-2023 is ALWAYS short-term
   * at slab with no holding-period benefit at all, and other/specified funds sit at 24 months
   * post-Jul-2024. Picking one would file the other two wrongly with nothing downstream able to
   * detect it, so the classification is refused until the sheet says which kind each row is.
   */
  ltDays: number | null;
  /**
   * Off-market: no exchange leg, so Delivery is forced and STT / exchange turnover / SEBI / IPF
   * cannot arise. True for PE and AIF. FALSE for MF - an equity-oriented redemption really does
   * bear STT, and hiding the box would silently drop it from the cost basis.
   */
  offMarket: boolean;
}

export const ASSET_CLASSES: Record<AssetClassId, AssetClassPolicy> = {
  PE: { id: "PE", tab: PE_TAB, label: "Private Equity", badge: "PE", ltDays: 730, offMarket: true },
  AIF: { id: "AIF", tab: AIF_TAB, label: "AIF", badge: "AIF", ltDays: 730, offMarket: true },
  MF: { id: "MF", tab: MF_TAB, label: "Mutual Fund", badge: "MF", ltDays: null, offMarket: false },
};

export const ASSET_CLASS_IDS: AssetClassId[] = ["PE", "AIF", "MF"];

export interface PrivateEquityRow {
  /** Which tab this row came from, so the fold-in knows which policy to apply. */
  assetClass: AssetClassId;
  company: string;
  driveLink: string;
  isin: string;
  /** Per-share fair value. 0 ⇒ none given ⇒ the holding is valued at cost. */
  valuation: number;
  /** ISO `yyyy-mm-dd`, or "" when absent/unparseable. */
  valuationDate: string;
  notes: string;
}

// Keyed by `${spreadsheetId}::${assetClass}` - three tabs are read per master load and a
// single-slot cache would have each one evict the last, turning a 60s cache into none.
let _cache = new Map<string, { rows: PrivateEquityRow[]; ts: number }>();
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

export function invalidatePrivateEquityCache(): void { _cache = new Map(); }

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

/** Which column holds what. -1 = the sheet has no such column. */
export interface PeColumns {
  company: number;
  driveLink: number;
  isin: number;
  valuation: number;
  valuationDate: number;
  notes: number;
}

/**
 * Work out the tab's column layout from its header row.
 *
 * Exported because the WRITER (`privateEquityWrite.ts`) has to place a new company in the same
 * column this reader will look in. A second copy of these regexes would drift, and the failure
 * mode is silent: a company name appended into the Drive column simply never appears as a
 * company, so an unlisted holding stays classified as listed equity.
 *
 * Detection order matters: "Valuation Date" contains "valuation", so the date test has to run
 * first or the date column would be read as the price. Same shape of trap the scrip master's
 * "Tally Name" hit.
 */
export function detectPeColumns(vals: any[][]): { hasHeader: boolean; ci: PeColumns; width: number } {
  const row0 = (vals && vals[0]) || [];
  const header = row0.map((h: any) => (h ?? "").toString().toLowerCase().trim());
  // Row 0 is a HEADER only if it reads like LABELS: a recognised keyword, and nothing that is
  // plainly a value. Keyword alone isn't enough — a Drive URL contains the word "drive", so a
  // headerless sheet's first company row would be swallowed as the header and vanish.
  const hasKeyword = header.some((h) => /company|name|drive|link|folder|url|isin|valuation|value|cmp|price|note|remark|sector/.test(h));
  const hasValueCell = row0.some((c: any) => typeof c === "number" || /^https?:\/\//i.test((c ?? "").toString().trim()));
  const hasHeader = hasKeyword && !hasValueCell;
  const ci: PeColumns = { company: 0, driveLink: 1, isin: -1, valuation: -1, valuationDate: -1, notes: -1 };
  if (hasHeader) {
    let companySet = false, driveSet = false;
    header.forEach((h, idx) => {
      if (!h) return;
      if (/valuation date|value date|val date|as on|as at|as of/.test(h)) ci.valuationDate = idx;
      else if (/drive|folder|link|url|docs/.test(h)) { if (!driveSet) { ci.driveLink = idx; driveSet = true; } }
      else if (/isin/.test(h)) ci.isin = idx;
      // "CMP" is the header the sheet actually uses for this. It matched none of the earlier
      // words, so the whole column was being ignored and every unlisted holding read as
      // unvalued - the column was there, filled in, and invisible.
      else if (/valuation|fair value|value per|price per|per share|cmp|market price|current price|mkt/.test(h)) ci.valuation = idx;
      else if (/note|remark|comment/.test(h)) ci.notes = idx;
      else if (!companySet && /company|name|scrip|security|entity/.test(h)) { ci.company = idx; companySet = true; }
    });
    // Clear the unmatched Drive default BEFORE the company fallback below. Leaving it at its
    // initial 1 made the fallback treat column B as already spoken for, so a tab headed
    // ISIN | Particulars | CMP found no free column and fell back onto the ISIN anyway.
    if (!driveSet) ci.driveLink = -1;

    // A header with no name-like column at all → fall back to column A, which is where the
    // user was told to put the company. But NOT if column A is some other column we already
    // identified: the tab now leads with ISIN, and reading an ISIN as the company name gives
    // every row a garbage identity while the real names go unread.
    if (!companySet) {
      const taken = new Set([ci.driveLink, ci.isin, ci.valuation, ci.valuationDate, ci.notes].filter(i => i >= 0));
      ci.company = taken.has(0) ? header.findIndex((_, i) => !taken.has(i)) : 0;
      if (ci.company < 0) ci.company = 0;   // nothing else to choose - A is all there is
    }
  }
  return { hasHeader, ci, width: row0.length };
}

export function parsePrivateEquityVals(vals: any[][], assetClass: AssetClassId = "PE"): PrivateEquityRow[] {
  if (!vals || vals.length === 0) return [];

  const { hasHeader, ci } = detectPeColumns(vals);

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
      assetClass,
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
export async function loadAssetClass(
  spreadsheetId: string,
  assetClass: AssetClassId,
  opts?: { force?: boolean },
): Promise<PrivateEquityRow[]> {
  const tab = ASSET_CLASSES[assetClass].tab;
  const key = `${spreadsheetId}::${assetClass}`;
  const now = Date.now();
  const hit = _cache.get(key);
  if (!opts?.force && hit && now - hit.ts < TTL_MS) return hit.rows;

  let res: any;
  try {
    res = await peBackoff(() => (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A1:J5000`,
      valueRenderOption: "UNFORMATTED_VALUE",
    }));
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || "";
    if (/unable to parse range/i.test(msg)) {
      // Tab absent - a real, cacheable answer. An AIF or Mutual Fund tab that does not exist
      // yet simply means the book holds none, which is the normal state for most portfolios.
      _cache.set(key, { rows: [], ts: now });
      return [];
    }
    throw e;
  }

  const rows = parsePrivateEquityVals(res?.result?.values || [], assetClass);
  _cache.set(key, { rows, ts: now });
  return rows;
}

/** Back-compat alias: the Private Equities tab specifically. */
export const loadPrivateEquities = (spreadsheetId: string, opts?: { force?: boolean }) =>
  loadAssetClass(spreadsheetId, "PE", opts);

/** The tab's name, for messages that tell the user where to add a company. */
export const PRIVATE_EQUITIES_TAB = PE_TAB;
