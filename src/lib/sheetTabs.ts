import { gapi } from "gapi-script";

/**
 * Ensure the given tabs exist in the spreadsheet, creating any that are missing.
 * Title comparison is case-insensitive ("Closing FY24-25" satisfies "Closing Fy24-25" —
 * Google Sheets treats tab names as case-insensitively unique), and each tab is
 * created in its own request so one duplicate-name failure can't block the others.
 */
export async function ensureSheetTabs(spreadsheetId: string, titles: string[]): Promise<void> {
  const meta = await (gapi.client as any).sheets.spreadsheets.get({ spreadsheetId });
  const existing = new Set(
    (meta?.result?.sheets || []).map((s: any) => (s.properties?.title || "").toString().trim().toLowerCase())
  );

  for (const title of titles) {
    if (existing.has(title.trim().toLowerCase())) continue;
    try {
      await (gapi.client as any).sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: { requests: [{ addSheet: { properties: { title } } }] },
      });
    } catch (e: any) {
      const msg = e?.result?.error?.message || "";
      // Tolerate races / casing variants the metadata didn't reveal
      if (!/already exists/i.test(msg)) throw e;
    }
  }
}
