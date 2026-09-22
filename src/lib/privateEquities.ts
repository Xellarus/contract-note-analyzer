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
 *   PAN            — optional. The company's Permanent Account Number, carried onto the
 *                    FY-end private-equity holding statement (a preparer needs the PAN of
 *                    each unlisted company beside the holding).
 *   Face Value     — optional. Per-share face value. 0 / blank ⇒ not given.
 *   Type Of Company— optional. Passed through verbatim. The owner keeps the ITR vocabulary
 *                    here — Domestic / Foreign — because it IS column C of the unlisted-
 *                    equity-shares schedule. The reader does not police it: an unexpected
 *                    value prints as typed rather than being blanked.
 *   Listed From    — optional. The date this company's shares STARTED TRADING on an exchange.
 *                    Blank ⇒ still unlisted, which is the normal state for every row here.
 *                    THE ROW STAYS ON THIS TAB FOREVER once set: it is what lets the app
 *                    reproduce a past year exactly. See `classAsOf` in scripMaster.ts.
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
const BOND_TAB = "Bonds";

/**
 * The NON-LISTED asset classes, each on its own hand-maintained tab of the shared scrip master.
 * All four tabs share the identical column shape and reader; what differs is the POLICY the
 * fold-in applies, which is why that lives here as data rather than as branches.
 */
export type AssetClassId = "PE" | "AIF" | "MF" | "BOND";

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
   *
   * BOND: null, and DELIBERATELY NOT DECIDED YET - the holding, valuation and AUM side of bonds
   * is wanted now, the tax side is explicitly deferred. Bonds have no single rule either, and
   * the two halves pull in opposite directions: a LISTED bond or debenture is long-term at 12
   * months, whereas an UNLISTED one is worse than merely undecided - under s.50AA (extended to
   * unlisted bonds and debentures by the Finance (No.2) Act 2024) a transfer on or after
   * 23-Jul-2024 is ALWAYS deemed short-term at slab whatever the holding period, and a
   * market-linked debenture has been always-short-term since Apr-2023. So 365 would understate
   * the tax on an unlisted NCD and always-short-term would overstate it on a listed one. Buys,
   * sells, the FIFO position, the valuation and the AUM all work normally; only the SHORT/LONG
   * split is withheld, and those sales surface in `unclassified` rather than being filed on a
   * guess. See the vault's "Bond Holding-Period Rule" problem entry before deciding.
   */
  ltDays: number | null;
  /**
   * Off-market: no exchange leg, so Delivery is forced and STT / exchange turnover / SEBI / IPF
   * cannot arise. True for PE and AIF. FALSE for MF - an equity-oriented redemption really does
   * bear STT, and hiding the box would silently drop it from the cost basis.
   *
   * FALSE for BOND, for the same reason and one more: the listed/unlisted question above is
   * open, and `false` is the only safe side of it because it merely OFFERS the charge boxes.
   * `true` would force Delivery and zero out exchange turnover / SEBI / IPF / stamp duty on a
   * bond actually bought on the exchange's debt segment, silently understating its cost basis -
   * and unlike a wrong holding period, nothing downstream could detect it. STT never applies to
   * debt either way, so an offered-and-left-blank STT box costs nothing.
   */
  offMarket: boolean;
}

export const ASSET_CLASSES: Record<AssetClassId, AssetClassPolicy> = {
  PE: { id: "PE", tab: PE_TAB, label: "Private Equity", badge: "PE", ltDays: 730, offMarket: true },
  AIF: { id: "AIF", tab: AIF_TAB, label: "AIF", badge: "AIF", ltDays: 730, offMarket: true },
  MF: { id: "MF", tab: MF_TAB, label: "Mutual Fund", badge: "MF", ltDays: null, offMarket: false },
  // Label singular against a plural tab, exactly as "Private Equity" sits against
  // "Private Equities" - the label is a class name, the tab is a list of things.
  BOND: { id: "BOND", tab: BOND_TAB, label: "Bond", badge: "BOND", ltDays: null, offMarket: false },
};

export const ASSET_CLASS_IDS: AssetClassId[] = ["PE", "AIF", "MF", "BOND"];

/**
 * The A1 range every reader of an asset-class tab asks for. ONE definition, because until
 * 21-Sep-2026 there were FOUR hand-kept copies of the string `A1:J5000` — here, the batched
 * read in `scripMaster.ts`, and both reads in `privateEquityWrite.ts` — one of which even
 * carried a comment promising it was "the SAME range string loadAssetClass builds". Widening
 * the tab by one column for `Listed From` moved one copy and left three behind, and the
 * failure is silent in the worst way: the batched fast path would return ten columns while the
 * per-class fallback returned nine, so a listing date would exist or not depending on which
 * path a given load happened to take.
 *
 * N, not J: there are ten recognised columns now and J is the tenth, so J left exactly zero
 * headroom. Trailing empty columns cost nothing — the reader is header-aware and the request
 * count is unchanged.
 */
export const CLASS_TAB_RANGE = "A1:N5000";

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
  /** Permanent Account Number as typed, upper-cased. "" when the column or cell is blank.
   *  Passed through, NOT validated: this is a display field on a statement, and rejecting
   *  an unfamiliar shape would blank a PAN the owner had entered correctly. */
  pan: string;
  /** Per-share face value. 0 ⇒ none given ⇒ a blank cell on the statement. */
  faceValue: number;
  /** Free text as typed — Domestic / Foreign, the ITR vocabulary. NOT upper-cased (unlike a
   *  PAN, which is written that way): this is prose and the sheet's capitalisation is the
   *  owner's. */
  companyType: string;
  /**
   * ISO `yyyy-mm-dd` — the date the shares started trading on an exchange. "" ⇒ still
   * unlisted (the normal case).
   *
   * This company is UNLISTED BEFORE this date and LISTED ON OR AFTER IT, and both halves are
   * load-bearing. Until 21-Sep-2026 the remedy for a company that listed was to delete its row
   * from this tab, which silently REWROTE history: `assetClass` is read as current state by
   * every engine, so regenerating FY2024-25 after the move dropped the company off the
   * `Unlisted Equity Shares` schedule that had already been FILED, moved its holding to the
   * equity tab and flipped its long-term threshold from 730 days to 365 — changing a filed
   * short-term gain into a long-term one, with nothing on any tab to show it had happened.
   */
  listedFrom: string;
  /** The raw cell text when a `Listed From` cell was NON-EMPTY but could not be read as a
   *  date, else "". A blank cell and an unreadable one both leave `listedFrom` empty, and
   *  they mean opposite things: blank is "still unlisted" (correct), unreadable is "the owner
   *  entered a listing date and the app is silently ignoring it". Surfaced, never swallowed. */
  listedFromBad: string;
  notes: string;
}

// Keyed by `${spreadsheetId}::${assetClass}` - three tabs are read per master load and a
// single-slot cache would have each one evict the last, turning a 60s cache into none.
let _cache = new Map<string, { rows: PrivateEquityRow[]; ts: number; unread: string[] }>();
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

/** Unrecognised, data-carrying columns on a class tab AS THIS LOAD READ IT. Read off the
 *  same cache entry the rows came from, so it cannot describe a different fetch. */
export function classHeadersUnread(spreadsheetId: string, assetClass: AssetClassId): string[] {
  return _cache.get(`${spreadsheetId}::${assetClass}`)?.unread || [];
}

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
  pan: number;
  faceValue: number;
  companyType: number;
  listedFrom: number;
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
  const hasKeyword = header.some((h) => /company|name|drive|link|folder|url|isin|valuation|value|cmp|price|note|remark|sector|\bpan\b|face|type/.test(h));
  const hasValueCell = row0.some((c: any) => typeof c === "number" || /^https?:\/\//i.test((c ?? "").toString().trim()));
  const hasHeader = hasKeyword && !hasValueCell;
  const ci: PeColumns = { company: 0, driveLink: 1, isin: -1, valuation: -1, valuationDate: -1, pan: -1, faceValue: -1, companyType: -1, listedFrom: -1, notes: -1 };
  if (hasHeader) {
    let companySet = false, driveSet = false;
    header.forEach((h, idx) => {
      if (!h) return;
      // FIRST in this chain, and specifically ahead of the valuation-date test: a header
      // spelled "Listed As On" contains "as on" and would otherwise be read as the valuation
      // date — which fails in the worst possible way, because the column would look correctly
      // filled while every listing date silently became a valuation date and no company ever
      // reclassified. Matching on the bare words `listed` / `listing` covers every spelling the
      // owner might use (Listed From / Listing Date / Listed On / Listed w.e.f.) and collides
      // with none of the other headers below.
      // `ipo` is here because the owner's own sheet used it and the column went unread in
      // total silence (22-Sep-2026). No other header on this tab contains it as a word -
      // \b keeps it off "Type Of Company" - so it costs nothing and covers "IPO Date",
      // "Date of IPO" and "IPO'd On".
      if (/\blisted\b|\blisting\b|\bipo\b/.test(h)) ci.listedFrom = idx;
      else if (/valuation date|value date|val date|as on|as at|as of/.test(h)) ci.valuationDate = idx;
      else if (/drive|folder|link|url|docs/.test(h)) { if (!driveSet) { ci.driveLink = idx; driveSet = true; } }
      else if (/isin/.test(h)) ci.isin = idx;
      // Ahead of the company test on purpose: a header of "Company PAN" contains "company"
      // and would otherwise be claimed as the NAME column. \b anchors it so "Expansion" and
      // the like cannot match.
      else if (/\bpan\b/.test(h)) ci.pan = idx;
      // BEFORE the valuation test: "Face Value Per Share" contains "value per", so the
      // valuation test would claim it and every unlisted holding would be priced at its
      // face value — wrong, and invisible, because the column looks correctly filled in.
      else if (/face value|face val|^fv$/.test(h)) ci.faceValue = idx;
      // BEFORE the company test, for the same reason "Company PAN" is: this contains
      // "company" and would otherwise be claimed as the NAME column. A bare "Type" is
      // taken as the company type — on a tab that lists companies there is nothing else
      // it could be typing.
      else if (/type of company|type of entity|company type|entity type|constitution|^type$/.test(h)) ci.companyType = idx;
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
      const taken = new Set([ci.driveLink, ci.isin, ci.valuation, ci.valuationDate, ci.pan, ci.faceValue, ci.companyType, ci.listedFrom, ci.notes].filter(i => i >= 0));
      ci.company = taken.has(0) ? header.findIndex((_, i) => !taken.has(i)) : 0;
      if (ci.company < 0) ci.company = 0;   // nothing else to choose - A is all there is
    }
  }
  return { hasHeader, ci, width: row0.length };
}

/** A0 → "A", 26 → "AA". For naming a column that carries data under no header at all. */
const colLetter = (i: number): string => {
  let s = "", n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
};

/**
 * Headers on this tab that the reader mapped to NOTHING, and whose column still carries data.
 *
 * This exists because of the worst property of this tab: **every way it can be wrong is silent
 * ON the tab**. Header detection here has now mis-fired six times, and the last one cost two
 * companies. The owner added a listing-date column, filled it in for `Kusumgar Pvt Ltd` and
 * `ESDS SOFTWARE SOLUTION PVT LTD`, and the header did not match `listed|listing`, so every
 * date was read by nothing at all. On screen that is indistinguishable from the feature being
 * broken: the column is there, it is filled, and no company ever reclassifies.
 *
 * Only a column that CARRIES something is reported. An empty spare column is not a
 * misconfiguration, and listing it would train the owner to ignore this list — which is the
 * failure mode of every diagnostic that cries wolf.
 *
 * A column with data and NO header is named by its letter, because that is the one case where
 * there is no text to quote back and also the easiest mistake to make.
 */
export function unmappedClassHeaders(vals: any[][]): string[] {
  if (!vals || vals.length === 0) return [];
  const { hasHeader, ci } = detectPeColumns(vals);
  if (!hasHeader) return [];
  const taken = new Set([
    ci.company, ci.driveLink, ci.isin, ci.valuation, ci.valuationDate,
    ci.pan, ci.faceValue, ci.companyType, ci.listedFrom, ci.notes,
  ].filter(i => i >= 0));
  const header = (vals[0] || []).map((h: any) => (h ?? "").toString().trim());
  const out: string[] = [];
  header.forEach((h, idx) => {
    if (taken.has(idx)) return;
    if (!vals.slice(1).some(r => (r?.[idx] ?? "").toString().trim() !== "")) return;
    out.push(h ? `"${h}"` : `column ${colLetter(idx)} (no header)`);
  });
  // A column with data past the end of the header row is the same failure, one step further on.
  const widest = vals.reduce((w, r) => Math.max(w, (r || []).length), 0);
  for (let idx = header.length; idx < widest; idx++) {
    if (taken.has(idx)) continue;
    if (vals.slice(1).some(r => (r?.[idx] ?? "").toString().trim() !== "")) {
      out.push(`column ${colLetter(idx)} (no header)`);
    }
  }
  return out;
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
      pan: ci.pan >= 0 ? (r[ci.pan] ?? "").toString().trim().toUpperCase() : "",
      faceValue: ci.faceValue >= 0 ? Math.max(0, toNum(r[ci.faceValue])) : 0,
      companyType: ci.companyType >= 0 ? (r[ci.companyType] ?? "").toString().trim() : "",
      // Through the same `isoDate` every other date here goes through, so a Sheets SERIAL and
      // every string shape `parseDMY` knows both land as ISO. An unparseable cell yields "",
      // i.e. STILL UNLISTED — the conservative side: a garbled date must never silently
      // reclassify a company out of the unlisted schedule. `listedFromUnparsed` below is what
      // stops that being invisible.
      listedFrom: ci.listedFrom >= 0 ? isoDate(r[ci.listedFrom]) : "",
      listedFromBad: ci.listedFrom >= 0 && (r[ci.listedFrom] ?? "").toString().trim() !== ""
        && !isoDate(r[ci.listedFrom]) ? (r[ci.listedFrom] ?? "").toString().trim() : "",
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
      range: `${tab}!${CLASS_TAB_RANGE}`,
      valueRenderOption: "UNFORMATTED_VALUE",
    }));
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || "";
    if (/unable to parse range/i.test(msg)) {
      // Tab absent - a real, cacheable answer. An AIF or Mutual Fund tab that does not exist
      // yet simply means the book holds none, which is the normal state for most portfolios.
      _cache.set(key, { rows: [], ts: now, unread: [] });
      return [];
    }
    throw e;
  }

  const vals = res?.result?.values || [];
  const rows = parsePrivateEquityVals(vals, assetClass);
  _cache.set(key, { rows, ts: now, unread: unmappedClassHeaders(vals) });
  return rows;
}

/**
 * Seed one class's cache from values SOMEBODY ELSE already fetched.
 *
 * Exists so `loadScripMaster` can read all four class tabs in ONE `batchGet` instead of four
 * `values.get` calls, without those rows then being invisible to every direct `loadAssetClass`
 * caller. The cache key and the parser are the same ones `loadAssetClass` uses, so a primed
 * entry is indistinguishable from a fetched one - which is the point: prime it, and the next
 * `loadAssetClass` costs nothing rather than re-fetching what the batch already has.
 */
export function primeAssetClass(
  spreadsheetId: string,
  assetClass: AssetClassId,
  values: any[][],
): PrivateEquityRow[] {
  const rows = parsePrivateEquityVals(values || [], assetClass);
  _cache.set(`${spreadsheetId}::${assetClass}`, { rows, ts: Date.now(), unread: unmappedClassHeaders(values || []) });
  return rows;
}

/** Back-compat alias: the Private Equities tab specifically. */
export const loadPrivateEquities = (spreadsheetId: string, opts?: { force?: boolean }) =>
  loadAssetClass(spreadsheetId, "PE", opts);

/** The tab's name, for messages that tell the user where to add a company. */
export const PRIVATE_EQUITIES_TAB = PE_TAB;
