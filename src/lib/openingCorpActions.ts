import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import { ActionResolution, CorpActionKind } from "./openingBasis";

/**
 * Resolved corporate actions (Bonus / Split / Rights) that the user filled in during
 * an opening-basis import. Bonus/Split/Rights ratios can't be derived reliably from a
 * plain transaction statement, so the user supplies them in a popup; we persist them
 * here so a re-import of the same statement doesn't re-ask.
 *
 * Lives in a dedicated "Opening Corp Actions" tab in each portfolio's spreadsheet —
 * deliberately NOT in True Entry, which must stay FY26-only (replayable pre-FY26 rows
 * there would double-count capital gains). Keyed by PendingAction.key, which is stable
 * for a given transaction statement (scrip · type · occurrence).
 */
export const OPENING_CORP_ACTIONS_TAB = "Opening Corp Actions";
const HEADER = ["Key", "Security", "Type", "Date", "Numerator", "Denominator", "Price", "Note"];

export interface SavedCorpAction {
  key: string;
  name: string;
  type: CorpActionKind;
  date: string;        // dd-mm-yyyy as shown to the user
  num: number;
  den: number;
  price: number;       // rights price (0 for bonus/split)
}

const toNum = (s: any): number => { const v = parseFloat((s ?? "").toString().replace(/,/g, "").trim()); return isNaN(v) ? NaN : v; };

const noteFor = (a: SavedCorpAction) =>
  a.type === "RIGHT" ? `Rights ${a.num}:${a.den} @ ₹${a.price}` : `${a.type === "SPLIT" ? "Split" : "Bonus"} ${a.num}:${a.den}`;

/** Overwrite the Opening Corp Actions tab with the resolved actions. */
export async function saveOpeningCorpActions(spreadsheetId: string, actions: SavedCorpAction[]): Promise<{ written: number }> {
  await ensureSheetTabs(spreadsheetId, [OPENING_CORP_ACTIONS_TAB]);
  const rows: any[][] = [HEADER];
  for (const a of actions) rows.push([a.key, a.name, a.type, a.date, a.num, a.den, a.price, noteFor(a)]);
  await (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${OPENING_CORP_ACTIONS_TAB}!A:Z` });
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId, range: `${OPENING_CORP_ACTIONS_TAB}!A1`, valueInputOption: "USER_ENTERED", resource: { values: rows },
  });
  return { written: actions.length };
}

/** Read the Opening Corp Actions tab as full rows ([] if the tab doesn't exist yet).
 *  Used both to build the resolutions map and to MERGE across batch imports (a later
 *  slice's write must not wipe an earlier slice's resolved actions). */
export async function loadOpeningCorpActionRows(spreadsheetId: string): Promise<SavedCorpAction[]> {
  let res: any;
  try {
    res = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId, range: `${OPENING_CORP_ACTIONS_TAB}!A1:H50000`, valueRenderOption: "UNFORMATTED_VALUE",
    });
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || "";
    if (/unable to parse range/i.test(msg)) return [];   // tab not created yet
    throw e;
  }
  const rows: any[][] = res?.result?.values || [];
  if (rows.length < 2) return [];
  const start = /^key$/i.test((rows[0]?.[0] ?? "").toString().trim()) ? 1 : 0;
  const out: SavedCorpAction[] = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const key = (r[0] || "").toString().trim();
    const num = toNum(r[4]), den = toNum(r[5]), price = toNum(r[6]);
    if (!key || isNaN(num) || isNaN(den) || den <= 0) continue;
    out.push({
      key, name: (r[1] ?? "").toString().trim(), type: ((r[2] ?? "").toString().trim().toUpperCase() as CorpActionKind),
      date: (r[3] ?? "").toString().trim(), num, den, price: isNaN(price) ? 0 : price,
    });
  }
  return out;
}

/** Read the Opening Corp Actions tab → a resolutions map keyed by PendingAction.key
 *  ({} if the tab doesn't exist yet). */
export async function loadOpeningCorpActions(spreadsheetId: string): Promise<Record<string, ActionResolution>> {
  const rows = await loadOpeningCorpActionRows(spreadsheetId);
  const out: Record<string, ActionResolution> = {};
  for (const a of rows) out[a.key] = { num: a.num, den: a.den, price: a.price };
  return out;
}
