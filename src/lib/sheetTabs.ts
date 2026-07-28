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

/**
 * Delete a single row (1-based, as the sheet numbers it) from a tab, shifting the
 * rows below it up. Resolves the tab's numeric sheetId first (deleteDimension needs
 * the gid, not the title). Used by the Trade Book "Edit Entry → Delete" action to
 * remove a True Entry / Opening Holdings row entirely.
 */
export async function deleteSheetRow(spreadsheetId: string, tabTitle: string, rowIndex1Based: number): Promise<void> {
  if (!(rowIndex1Based >= 1)) throw new Error(`Invalid row index ${rowIndex1Based}`);
  const meta = await (gapi.client as any).sheets.spreadsheets.get({ spreadsheetId });
  const sheet = (meta?.result?.sheets || []).find(
    (s: any) => (s.properties?.title || "").toString().trim().toLowerCase() === tabTitle.trim().toLowerCase()
  );
  if (!sheet) throw new Error(`Tab "${tabTitle}" not found in this spreadsheet.`);
  const sheetId = sheet.properties.sheetId;
  await (gapi.client as any).sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: rowIndex1Based - 1, endIndex: rowIndex1Based },
        },
      }],
    },
  });
}

/**
 * Insert a blank row at the given 1-based index (shifting rows below it down) and
 * write `values` into it. The inverse of deleteSheetRow — used to "Undo" a deleted
 * Trade Book / Opening Holdings row, restoring it to its original position. Values
 * should be captured with valueRenderOption: "UNFORMATTED_VALUE" and are written
 * RAW so dates (serials) and numbers round-trip exactly.
 */
export async function insertSheetRow(
  spreadsheetId: string, tabTitle: string, rowIndex1Based: number, values: any[],
): Promise<void> {
  if (!(rowIndex1Based >= 1)) throw new Error(`Invalid row index ${rowIndex1Based}`);
  const meta = await (gapi.client as any).sheets.spreadsheets.get({ spreadsheetId });
  const sheet = (meta?.result?.sheets || []).find(
    (s: any) => (s.properties?.title || "").toString().trim().toLowerCase() === tabTitle.trim().toLowerCase()
  );
  if (!sheet) throw new Error(`Tab "${tabTitle}" not found in this spreadsheet.`);
  const sheetId = sheet.properties.sheetId;
  await (gapi.client as any).sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [{
        insertDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: rowIndex1Based - 1, endIndex: rowIndex1Based },
          inheritFromBefore: false,
        },
      }],
    },
  });
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabTitle}'!A${rowIndex1Based}`,
    valueInputOption: "RAW",
    resource: { values: [values] },
  });
}
