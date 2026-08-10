import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";

/**
 * Corporate actions (merger / demerger) live in their own structured tab — they
 * don't fit the Buy/Sell ledger (they reference two securities + a swap/apportion
 * amount). Both the weighted-average Holding replay and the FIFO capital-gains
 * replay read this tab and apply each action at its date.
 *
 * Cost handling (per the user's choice): the `cost` is typed manually.
 *   • Merger  — total cost carried from `from` (Target) into `to` (Acquirer).
 *   • Demerger — cost moved out of `from` (Parent) into `to` (NewCo); the Parent's
 *     total cost is reduced by exactly this amount.
 * The new (Acquirer / NewCo) shares get a fresh acquisition date at the action
 * date, so their capital-gains holding period restarts there (documented).
 */
export const CORP_ACTIONS_TAB = "Corporate Actions";
export type CorpActionType = "Merger" | "Demerger";

export interface CorpAction {
  dateStr: string;     // parsed by each engine's own date parser
  type: CorpActionType;
  from: string;        // security losing shares/cost (Target / Parent)
  to: string;          // security gaining shares/cost (Acquirer / NewCo)
  sharesIn: number;    // shares received in `to`
  cost: number;        // see header note
  notes: string;
  /**
   * 1-based sheet row this action was read from — the edit target for
   * updateCorporateActionRow. Absent on actions built in memory (e.g. a new one being
   * composed in the Add Trade drawer). Identity has to be the ROW, not date+from+to:
   * two demergers of the same pair on one date are legal and would collide on any
   * value-derived key.
   */
  rowIndex?: number;
}

const HEADER = ["Date", "Type", "From", "To", "Shares In", "Cost", "Notes"];
const num = (s: any): number => { const v = parseFloat((s ?? "").toString().replace(/,/g, "").trim()); return isNaN(v) ? 0 : v; };

/**
 * Resolve the tab's column positions. Shared by the reader and the writer so an edit
 * always lands in the same cells the reader will read back — the tab tolerates a
 * reordered header, and hardcoding HEADER order in the writer would corrupt such a sheet.
 */
interface CorpCols { date: number; type: number; from: number; to: number; sharesIn: number; cost: number; notes: number; }
function corpCols(headerRow: any[]): CorpCols {
  const h = (headerRow || []).map((c: any) => (c ?? "").toString().trim().toLowerCase());
  const ci = (re: RegExp, fb: number) => { const i = h.findIndex((x: string) => re.test(x)); return i >= 0 ? i : fb; };
  return {
    date: ci(/date/, 0), type: ci(/type/, 1), from: ci(/from/, 2), to: ci(/to/, 3),
    sharesIn: ci(/shares in|qty in|^in$/, 4), cost: ci(/cost/, 5), notes: ci(/note/, 6),
  };
}

const colLetter = (i: number): string => {
  let s = "", n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
};

/** Read the Corporate Actions tab ([] if absent/empty). Tolerant of column order. */
export async function loadCorporateActions(spreadsheetId: string): Promise<CorpAction[]> {
  let res: any;
  try {
    res = await (gapi.client as any).sheets.spreadsheets.values.get({ spreadsheetId, range: `${CORP_ACTIONS_TAB}!A:Z` });
  } catch { return []; }
  const rows: any[][] = res?.result?.values || [];
  if (rows.length < 2) return [];

  const c = corpCols(rows[0]);
  const di = c.date, ti = c.type, fi = c.from, toi = c.to, sii = c.sharesIn, costi = c.cost, ni = c.notes;

  const out: CorpAction[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const typeRaw = (r[ti] || "").toString().trim().toLowerCase();
    const type: CorpActionType | null = typeRaw.startsWith("merg") ? "Merger" : typeRaw.startsWith("demerg") ? "Demerger" : null;
    const from = (r[fi] || "").toString().trim();
    const to = (r[toi] || "").toString().trim();
    if (!type || (!from && !to)) continue;
    out.push({
      dateStr: (r[di] || "").toString().trim(),
      type, from, to,
      sharesIn: num(r[sii]), cost: num(r[costi]),
      notes: (r[ni] || "").toString().trim(),
      rowIndex: i + 1,   // rows[0] is the header = sheet row 1, so rows[i] is row i+1
    });
  }
  return out;
}

/** Append one corporate-action row (writes the header first if the tab is empty). */
export async function appendCorporateActionRow(spreadsheetId: string, a: CorpAction): Promise<void> {
  await ensureSheetTabs(spreadsheetId, [CORP_ACTIONS_TAB]);
  let empty = false;
  try {
    const res = await (gapi.client as any).sheets.spreadsheets.values.get({ spreadsheetId, range: `${CORP_ACTIONS_TAB}!A1:A2` });
    empty = !res?.result?.values || res.result.values.length === 0;
  } catch { empty = true; }
  const row = [a.dateStr, a.type, a.from, a.to, a.sharesIn || "", a.cost || "", a.notes || ""];
  const values = empty ? [HEADER, row] : [row];
  await (gapi.client as any).sheets.spreadsheets.values.append({
    spreadsheetId, range: `${CORP_ACTIONS_TAB}!A:Z`, valueInputOption: "USER_ENTERED", resource: { values },
  });
}

/**
 * Overwrite ONE existing corporate-action row in place, targeted by its 1-based sheet row
 * (`CorpAction.rowIndex` from loadCorporateActions).
 *
 * Reads the row first and mutates only the seven mapped cells, so anything the reader
 * doesn't model — a user's own extra column, a formula off to the right — survives the
 * edit instead of being blanked.
 *
 * Callers must recompute afterwards (rebuildHoldingTab + syncCapitalGains): the amount
 * feeds the FIFO cost basis, so both the Holding tab and the capital-gains register move.
 */
export async function updateCorporateActionRow(
  spreadsheetId: string,
  rowIndex: number,
  a: CorpAction,
): Promise<void> {
  if (!(rowIndex >= 2)) throw new Error(`Refusing to write row ${rowIndex} — row 1 is the header.`);

  const hdrRes = await (gapi.client as any).sheets.spreadsheets.values.get({
    spreadsheetId, range: `${CORP_ACTIONS_TAB}!A1:Z1`,
  });
  const headerRow: any[] = hdrRes?.result?.values?.[0] || [];
  if (!headerRow.length) throw new Error(`"${CORP_ACTIONS_TAB}" tab has no header row to align the edit to.`);
  const c = corpCols(headerRow);

  const curRes = await (gapi.client as any).sheets.spreadsheets.values.get({
    spreadsheetId, range: `${CORP_ACTIONS_TAB}!A${rowIndex}:Z${rowIndex}`,
  });
  const existing: any[] = curRes?.result?.values?.[0] || [];
  if (!existing.length) throw new Error(`Row ${rowIndex} of "${CORP_ACTIONS_TAB}" is empty — it may have been deleted or reordered. Reload and try again.`);

  const width = Math.max(existing.length, headerRow.length, c.notes + 1);
  const out: any[] = Array.from({ length: width }, (_, i) => (existing[i] ?? ""));
  out[c.date] = a.dateStr;
  out[c.type] = a.type;
  out[c.from] = a.from;
  out[c.to] = a.to;
  out[c.sharesIn] = a.sharesIn || "";
  out[c.cost] = a.cost || "";
  out[c.notes] = a.notes || "";

  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${CORP_ACTIONS_TAB}!A${rowIndex}:${colLetter(width - 1)}${rowIndex}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [out] },
  });
}
