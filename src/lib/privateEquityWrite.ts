/**
 * Registering a company on the "Private Equities" tab.
 *
 * That tab is the ONLY thing that marks a company as unlisted, and it lives in the SHARED scrip
 * master — so a row written here changes how every portfolio classifies that name, and it drives
 * a tax figure (long-term at 24 months instead of 12). Everything below exists because of that.
 *
 * Why its own module rather than `privateEquities.ts`: that file states, deliberately, that it
 * "imports nothing from scripMaster so that fold-in direction stays one-way". The identity guard
 * needs `lookupScrip`, so the writer sits downstream of both instead of inverting that edge.
 *
 * Why not in `scripMaster.saveScripMaster`: that function refuses PE entries outright, because it
 * appends to the master's FIRST tab and a PE row there would create a second entry for the same
 * company — the duplicate-identity split where a name resolves to one of two entries and the
 * position silently divides between them.
 */
import { gapi } from "gapi-script";
import {
  detectPeColumns, parsePrivateEquityVals, PRIVATE_EQUITIES_TAB,
  ASSET_CLASSES, AssetClassId,
} from "./privateEquities";
import { normName, invalidateScripCache, lookupScrip, ScripMaster } from "./scripMaster";

/**
 * Written only when the tab has to be created, or is completely empty. Ordered so
 * `detectPeColumns` maps every one of them: "Valuation Date" must stay distinguishable from
 * "Valuation" (the date test runs first), and "Company" must not contain a value-like cell or
 * the row would be read as data rather than a header.
 */
const PE_HEADER = ["Company", "Drive Link", "ISIN", "Valuation", "Valuation Date", "Notes"];

export type PeAppendRefusal =
  | "blank"              // no company name given
  | "no-master"          // identity cannot be checked, so the write cannot be safe
  | "pe-unreadable"      // the tab itself failed to read - a duplicate cannot be ruled out
  | "already-pe"         // already registered as unlisted; nothing to do
  | "listed-collision";  // the name resolves to a LISTED security

/**
 * Discriminated on a STRING, not on `ok: boolean`. This project has no `strict`, and boolean
 * literal discriminants do not narrow reliably without it - `if (!r.ok)` left `r.message` a type
 * error. A string tag narrows in both directions regardless of strictness.
 */
export type PeAppendResult =
  | { status: "added"; company: string; createdTab: boolean }
  | { status: "refused"; reason: PeAppendRefusal; message: string };

const isMissingRange = (e: any): boolean =>
  /unable to parse range/i.test(e?.result?.error?.message || e?.message || "");

/**
 * Add `company` to the Private Equities tab.
 *
 * Refuses rather than guesses in every ambiguous case. The caller shows `message` as-is; each
 * one names the fix, because "it didn't work" on a shared sheet invites a second manual attempt
 * that creates exactly the duplicate this guards against.
 */
export async function appendPrivateEquity(
  spreadsheetId: string,
  master: ScripMaster | null,
  companyRaw: string,
  /**
   * Which tab to register on. Was hard-coded to Private Equities, which meant a new AIF or
   * mutual fund entered from the drawer landed on the PE tab and inherited PE treatment -
   * 730 days and no STT. For a mutual fund that is worse than useless: it would then be
   * CLASSIFIED on a guessed rule rather than deliberately refused.
   */
  assetClass: AssetClassId = "PE",
): Promise<PeAppendResult> {
  const TAB = ASSET_CLASSES[assetClass].tab;
  const company = (companyRaw || "").trim();
  if (!company) return { status: "refused", reason: "blank", message: "Enter a company name first." };

  // ── Identity guards ────────────────────────────────────────────────────────────────────────
  // No master means no way to tell whether this name is already taken. Writing anyway is the
  // "guess rather than refuse" move that the classification rules exist to forbid.
  if (!master) {
    return { status: "refused", reason: "no-master", message: "The scrip master hasn't loaded, so this name can't be checked yet. Try again in a moment." };
  }
  if (master.peFailed) {
    return { status: "refused", reason: "pe-unreadable", message: `Couldn't read the non-listed tabs, so it's not possible to tell whether ${company} is already on one. Try again shortly.` };
  }

  const hit = lookupScrip(master, "", company).entry;
  if (hit?.assetClass) {
    // Already registered - possibly on a DIFFERENT tab, which is exactly why the message names
    // the one it is on. Adding it again elsewhere would give one company two identities.
    return {
      status: "refused", reason: "already-pe",
      message: `${hit.canonicalName} is already on the "${ASSET_CLASSES[hit.assetClass].tab}" tab.`,
    };
  }
  if (hit) {
    // `normName` strips limited/ltd/private/pvt/the/co, so "Acme Private Limited" and "Acme"
    // collapse to the same key. Appending would hand this listed company's identity to an
    // unlisted one and reclassify its holding.
    return {
      status: "refused",
      reason: "listed-collision",
      message: `${company} matches the LISTED security "${hit.canonicalName}", so adding it would merge the two. Use a more specific name, or record the trade as listed equity.`,
    };
  }

  // ── Read the tab as it is NOW ──────────────────────────────────────────────────────────────
  // Not from the cached master: this sheet is shared, so someone may have added the company
  // since the master was built. The fresh read is a second duplicate check, and it is the only
  // way to learn the column layout to write into.
  let vals: any[][] = [];
  let tabMissing = false;
  try {
    const res: any = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${TAB}!A1:J5000`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    vals = res?.result?.values || [];
  } catch (e: any) {
    if (!isMissingRange(e)) throw e;   // a real failure must not be mistaken for an absent tab
    tabMissing = true;
  }

  const nk = normName(company);
  const existing = parsePrivateEquityVals(vals);
  const dup = existing.find(r => r.company.toLowerCase() === company.toLowerCase() || normName(r.company) === nk);
  if (dup) {
    return { status: "refused", reason: "already-pe", message: `${dup.company} is already on the "${TAB}" tab.` };
  }

  // ── Write ──────────────────────────────────────────────────────────────────────────────────
  let createdTab = false;
  if (tabMissing) {
    await (gapi.client as any).sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    });
    createdTab = true;
  }

  // A brand-new or empty tab gets the header first, so the sheet documents its own columns and
  // the next reader detects them instead of falling back to "company is column A".
  const needsHeader = tabMissing || vals.length === 0;
  const { ci, width } = needsHeader
    ? { ci: { company: 0, driveLink: 1, isin: 2, valuation: 3, valuationDate: 4, notes: 5 }, width: PE_HEADER.length }
    : detectPeColumns(vals);

  // Place the name in the column THIS SHEET uses for it, padding to the sheet's own width so a
  // trailing Notes column isn't shifted. Positional writing is what the header-aware rule
  // forbids: a name landing in the Drive column never reads back as a company at all, and the
  // holding stays classified as listed equity with nothing to show that it went wrong.
  const row: any[] = new Array(Math.max(width, ci.company + 1)).fill("");
  row[ci.company] = company;

  await (gapi.client as any).sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values: needsHeader ? [PE_HEADER, row] : [row] },
  });

  // The master folds this tab in, so both caches have to go or the company the user just added
  // still won't resolve. invalidateScripCache clears the PE cache too, on purpose.
  invalidateScripCache();

  return { status: "added", company, createdTab };
}

/** Exported for the test suite, which asserts the header maps back through detectPeColumns. */
export const PE_HEADER_ROW = PE_HEADER;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Writing CMP back to the tab
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One company's CMP to consider writing. `ts` is when that price was observed (ms epoch). */
export interface PeCmpUpdate {
  isin: string;
  name: string;
  price: number;
  ts: number;
}

export type PeCmpSkip = "no-row" | "no-cmp-column" | "hand-entered" | "not-newer" | "bad-price";

export interface PeCmpResult {
  written: { company: string; price: number }[];
  skipped: { company: string; reason: PeCmpSkip }[];
  /** True when the tab has no CMP/valuation column at all, so nothing could be written. */
  noCmpColumn: boolean;
}

/** Sheets serial → ms epoch, matching `fromSerial` in dates.ts. */
const serialToMs = (n: number): number => Date.UTC(1899, 11, 30) + Math.round(n) * 86400000;
/** ms epoch → Sheets serial. Written as a number so no locale can reinterpret it. */
const msToSerial = (ms: number): number => Math.round((ms - Date.UTC(1899, 11, 30)) / 86400000);

const colLetter = (i: number): string => {
  let s = "", n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
};

/**
 * Update the CMP column of the Private Equities tab from observed trade prices.
 *
 * The rule, chosen deliberately: a hand-entered CMP is replaced ONLY when a trade happened
 * after the date that CMP is stamped with.
 *
 *   CMP blank                            → write (nothing to protect)
 *   CMP set, valuation date blank        → LEAVE ALONE (an undated figure is a deliberate
 *                                          statement with no expiry; guessing would erase it)
 *   CMP set, dated, trade is newer       → write
 *   CMP set, dated, trade is not newer   → leave alone
 *
 * The date is written alongside the price, and that is load-bearing rather than cosmetic: it is
 * what makes the comparison converge. Without it every rebuild would re-fire on the same trade,
 * and a rebuild of a portfolio holding an OLDER trade in the same company would drag the price
 * backwards - the date guard is what makes the tab settle on the globally most recent trade
 * even though each rebuild only sees one portfolio.
 *
 * Header-aware in both directions: the CMP column is located by header name, and each company's
 * ROW by ISIN first, then name. Never appends - a company absent from the tab is not unlisted,
 * so there is nothing to price.
 */
export async function updatePrivateEquityCmp(
  spreadsheetId: string,
  updates: PeCmpUpdate[],
  /**
   * Skip the newer-trade test entirely. Only for a price the USER typed: they are stating it,
   * so there is nothing to protect it from. Without this a manual edit onto an existing
   * UNDATED CMP would hit the "hand-entered, leave alone" branch and silently do nothing -
   * which is the most common case there is, since an undated figure is what you get by typing
   * a number into the sheet.
   */
  force = false,
): Promise<PeCmpResult> {
  const out: PeCmpResult = { written: [], skipped: [], noCmpColumn: false };
  if (updates.length === 0) return out;

  const res: any = await (gapi.client as any).sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${PRIVATE_EQUITIES_TAB}!A1:J5000`,
    valueRenderOption: "UNFORMATTED_VALUE",   // a date must arrive as a serial, never as text
  });
  const vals: any[][] = res?.result?.values || [];
  const { hasHeader, ci } = detectPeColumns(vals);

  if (ci.valuation < 0) {
    // Nothing to write into. Reported rather than thrown: the caller is a rebuild, and failing
    // a whole rebuild because an optional column is absent would be the worse outcome.
    out.noCmpColumn = true;
    for (const u of updates) out.skipped.push({ company: u.name, reason: "no-cmp-column" });
    return out;
  }

  const first = hasHeader ? 1 : 0;
  const data: { range: string; values: any[][] }[] = [];

  for (const u of updates) {
    if (!(u.price > 0) || !(u.ts > 0)) { out.skipped.push({ company: u.name, reason: "bad-price" }); continue; }

    const isin = (u.isin || "").trim().toUpperCase();
    const nk = normName(u.name);
    let rowIdx = -1;
    for (let i = first; i < vals.length; i++) {
      const r = vals[i]; if (!r) continue;
      const rIsin = ci.isin >= 0 ? (r[ci.isin] ?? "").toString().trim().toUpperCase() : "";
      if (isin && rIsin && rIsin === isin) { rowIdx = i; break; }
      const rName = (r[ci.company] ?? "").toString().trim();
      // Name is the fallback identity, exactly as the reader treats it. Not `break`-first, so
      // an ISIN match later in the sheet still wins over an earlier name match.
      if (rowIdx < 0 && rName && normName(rName) === nk) rowIdx = i;
    }
    if (rowIdx < 0) { out.skipped.push({ company: u.name, reason: "no-row" }); continue; }

    const row = vals[rowIdx];
    const existing = parseFloat((row[ci.valuation] ?? "").toString().replace(/,/g, "").trim());
    const hasExisting = !isNaN(existing) && existing > 0;
    const dateCell = ci.valuationDate >= 0 ? row[ci.valuationDate] : undefined;
    const dateNum = parseFloat((dateCell ?? "").toString().trim());
    const stampedMs = !isNaN(dateNum) && dateNum > 20000 && dateNum < 80000 ? serialToMs(dateNum) : NaN;

    if (hasExisting && !force) {
      if (isNaN(stampedMs)) { out.skipped.push({ company: u.name, reason: "hand-entered" }); continue; }
      if (u.ts <= stampedMs) { out.skipped.push({ company: u.name, reason: "not-newer" }); continue; }
    }

    const sheetRow = rowIdx + 1;   // A1 notation is 1-based
    data.push({
      range: `${PRIVATE_EQUITIES_TAB}!${colLetter(ci.valuation)}${sheetRow}`,
      values: [[parseFloat(u.price.toFixed(4))]],
    });
    // Only when the tab HAS a date column. Without one the price still updates, but it can
    // never be protected from the next trade - which is the sheet's own shape, not ours to fix.
    if (ci.valuationDate >= 0) {
      data.push({
        range: `${PRIVATE_EQUITIES_TAB}!${colLetter(ci.valuationDate)}${sheetRow}`,
        values: [[msToSerial(u.ts)]],
      });
    }
    out.written.push({ company: (row[ci.company] ?? u.name).toString().trim() || u.name, price: u.price });
  }

  if (data.length === 0) return out;

  // ONE call for every cell. A per-company update would be dozens of writes to a shared sheet
  // inside a rebuild that is already the app's heaviest operation.
  await (gapi.client as any).sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    resource: { valueInputOption: "USER_ENTERED", data },
  });

  invalidateScripCache();
  return out;
}

/**
 * Set one company's CMP by hand, from the app. Unconditional - the user is stating the price, so
 * no newer-trade test applies. Stamps today so the automatic update can tell whether a later
 * trade supersedes it.
 */
export async function setPrivateEquityCmp(
  spreadsheetId: string,
  isin: string,
  name: string,
  price: number,
  nowMs: number,
): Promise<PeCmpResult> {
  // Reuse the whole header-aware path so the two can never disagree about where the column is
  // or how the date is encoded - but FORCED, because a price the user typed outranks whatever
  // is there, dated or not.
  return updatePrivateEquityCmp(spreadsheetId, [{ isin, name, price, ts: nowMs }], true);
}
