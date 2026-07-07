import { gapi } from "gapi-script";
import { toIsoDate } from "./tradeRowSchema";
import { rebuildHoldingTab, syncCapitalGains } from "./holdingsCalc";

/**
 * One-time cleanup of an existing portfolio ledger:
 *   1. Removes the ISIN column from True Entry / Raw Entry (header + every row).
 *   2. Rewrites the Trade Date column to ISO YYYY-MM-DD so Google Sheets stores
 *      real dates (DD-MM-YYYY text can't be pivoted/grouped by date).
 * Then recomputes the Holding tab + capital gains from the cleaned ledger.
 *
 * Each tab is read in full, transformed in memory, then rewritten (clear → write)
 * so the now-removed column is physically gone, not just blanked.
 */
const TABS = ["True Entry", "Raw Entry"];

export interface MigrationTabResult { tab: string; existed: boolean; removedIsin: boolean; datesFixed: number; rows: number; }
export interface MigrationResult { tabs: MigrationTabResult[]; holdingWarning?: string; capGainsWarning?: string; }

export async function migrateTrueRawEntry(spreadsheetId: string): Promise<MigrationResult> {
  const tabs: MigrationTabResult[] = [];

  for (const tab of TABS) {
    let res: any;
    try {
      res = await (gapi.client as any).sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A:Z` });
    } catch (e: any) {
      const msg = e?.result?.error?.message || e?.message || "";
      if (/unable to parse range/i.test(msg)) { tabs.push({ tab, existed: false, removedIsin: false, datesFixed: 0, rows: 0 }); continue; }
      throw e;
    }

    const rows: any[][] = res?.result?.values || [];
    if (rows.length === 0) { tabs.push({ tab, existed: false, removedIsin: false, datesFixed: 0, rows: 0 }); continue; }

    const header = (rows[0] || []).map((h: any) => (h ?? "").toString());
    const isinIdx = header.findIndex((h: string) => /isin/i.test(h));
    const dateIdx = header.findIndex((h: string) => { const s = h.toLowerCase().trim(); return /trade date|^date$/.test(s); });

    // Nothing to do for this tab.
    if (isinIdx < 0 && dateIdx < 0) { tabs.push({ tab, existed: true, removedIsin: false, datesFixed: 0, rows: Math.max(0, rows.length - 1) }); continue; }

    let datesFixed = 0;
    const out = rows.map((r, ri) => {
      let row = (r || []).slice();
      if (dateIdx >= 0 && ri > 0) {
        const orig = (row[dateIdx] ?? "").toString();
        const iso = toIsoDate(orig);
        if (iso !== orig) datesFixed++;
        row[dateIdx] = iso;
      }
      if (isinIdx >= 0) row = row.filter((_: any, ci: number) => ci !== isinIdx); // drop ISIN column
      return row;
    });

    // Rewrite the tab: clear first so the removed (trailing) column is gone, then
    // write the transformed values from A1 (USER_ENTERED → ISO strings become real dates).
    await (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tab}!A:Z` });
    await (gapi.client as any).sheets.spreadsheets.values.update({
      spreadsheetId, range: `${tab}!A1`, valueInputOption: "USER_ENTERED", resource: { values: out },
    });

    tabs.push({ tab, existed: true, removedIsin: isinIdx >= 0, datesFixed, rows: Math.max(0, out.length - 1) });
  }

  // Recompute downstream tabs from the cleaned ledger (best-effort).
  let holdingWarning: string | undefined;
  try { await rebuildHoldingTab(spreadsheetId); } catch (e: any) { holdingWarning = e?.result?.error?.message || e?.message || "Unknown error"; }
  let capGainsWarning: string | undefined;
  try { await syncCapitalGains(spreadsheetId); } catch (e: any) { capGainsWarning = e?.result?.error?.message || e?.message || "Unknown error"; }

  return { tabs, holdingWarning, capGainsWarning };
}
