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
}

const HEADER = ["Date", "Type", "From", "To", "Shares In", "Cost", "Notes"];
const num = (s: any): number => { const v = parseFloat((s ?? "").toString().replace(/,/g, "").trim()); return isNaN(v) ? 0 : v; };

/** Read the Corporate Actions tab ([] if absent/empty). Tolerant of column order. */
export async function loadCorporateActions(spreadsheetId: string): Promise<CorpAction[]> {
  let res: any;
  try {
    res = await (gapi.client as any).sheets.spreadsheets.values.get({ spreadsheetId, range: `${CORP_ACTIONS_TAB}!A:Z` });
  } catch { return []; }
  const rows: any[][] = res?.result?.values || [];
  if (rows.length < 2) return [];

  const h = rows[0].map((c: any) => (c ?? "").toString().trim().toLowerCase());
  const ci = (re: RegExp, fb: number) => { const i = h.findIndex((x: string) => re.test(x)); return i >= 0 ? i : fb; };
  const di = ci(/date/, 0), ti = ci(/type/, 1), fi = ci(/from/, 2), toi = ci(/to/, 3),
    sii = ci(/shares in|qty in|^in$/, 4), costi = ci(/cost/, 5), ni = ci(/note/, 6);

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
