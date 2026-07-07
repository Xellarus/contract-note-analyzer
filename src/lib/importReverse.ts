import { gapi } from "gapi-script";
import { rebuildHoldingTab, syncCapitalGains } from "./holdingsCalc";

// The two ledger tabs every import appends to. A rewind removes this import's
// stamped rows from both, then rebuilds the derived tabs.
const ENTRY_TABS = ["Raw Entry", "True Entry"];

export interface ReverseResult {
  /** Rows removed from the canonical ledger (True Entry, falling back to Raw). */
  removed: number;
  /** Per-tab removal counts, for diagnostics. */
  removedPerTab: Record<string, number>;
  /** Non-fatal warnings if a derived tab couldn't be recomputed after removal. */
  holdingWarning?: string;
  capGainsWarning?: string;
}

/**
 * Undo one import: delete every Raw Entry / True Entry row stamped with `importId`
 * (in the given portfolio sheet), then rebuild the Holding tab and re-sync capital
 * gains so the derived numbers match the trimmed ledger.
 *
 * Precise and safe: it only touches rows carrying this exact import's id — never
 * a legitimately-repeated fill or a row from a different note. Rows written before
 * the Import ID column existed have no stamp and are therefore not rewindable.
 */
export async function reverseImport(opts: { spreadsheetId: string; importId: string }): Promise<ReverseResult> {
  const { spreadsheetId, importId } = opts;
  const token = (gapi?.client as any)?.getToken?.();
  if (!token?.access_token) throw new Error("Not connected to Google Sheets — sign in first.");
  if (!importId) throw new Error("This import has no Import ID, so it can't be rewound.");

  // Row deletion works on numeric sheet ids (gids), so map tab title → gid.
  const metaRes: any = await (gapi.client as any).sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });
  const gidByTitle = new Map<string, number>();
  for (const s of (metaRes?.result?.sheets || [])) {
    gidByTitle.set(s.properties.title, s.properties.sheetId);
  }

  const removedPerTab: Record<string, number> = {};
  for (const tab of ENTRY_TABS) {
    const gid = gidByTitle.get(tab);
    if (gid == null) continue; // tab absent — nothing to remove there

    // Read the whole used range so we capture the far-right Import ID column
    // whatever position it sits in.
    const res: any = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId,
      range: tab,
    });
    const rows: any[][] = res?.result?.values || [];
    if (rows.length < 2) continue;

    const header = (rows[0] || []).map((h: any) => (h ?? "").toString().trim().toLowerCase());
    const idCol = header.findIndex((h) => /import id|import batch|batch id/.test(h));
    if (idCol < 0) continue; // no Import ID column here → nothing stamped

    // Row index in `rows` == 0-based sheet row index (we read from A1), which is
    // exactly what deleteDimension expects.
    const toDelete: number[] = [];
    for (let i = 1; i < rows.length; i++) {
      const cell = ((rows[i]?.[idCol]) ?? "").toString().trim();
      if (cell && cell === importId) toDelete.push(i);
    }
    if (!toDelete.length) { removedPerTab[tab] = 0; continue; }

    // Delete bottom-up so earlier indices stay valid as rows shift.
    toDelete.sort((a, b) => b - a);
    const requests = toDelete.map((i) => ({
      deleteDimension: { range: { sheetId: gid, dimension: "ROWS", startIndex: i, endIndex: i + 1 } },
    }));
    await (gapi.client as any).sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests },
    });
    removedPerTab[tab] = toDelete.length;
  }

  // Refresh the derived tabs so Holding + capital gains reflect the removal.
  let holdingWarning: string | undefined;
  let capGainsWarning: string | undefined;
  try {
    await rebuildHoldingTab(spreadsheetId);
  } catch (e: any) {
    holdingWarning = e?.result?.error?.message || e?.message || "Unknown error";
  }
  try {
    await syncCapitalGains(spreadsheetId);
  } catch (e: any) {
    capGainsWarning = e?.result?.error?.message || e?.message || "Unknown error";
  }

  const removed = removedPerTab["True Entry"] ?? removedPerTab["Raw Entry"] ?? 0;
  return { removed, removedPerTab, holdingWarning, capGainsWarning };
}
