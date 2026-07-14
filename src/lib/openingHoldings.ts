import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import { OpeningLot } from "./openingBasis";

/**
 * Per-portfolio opening tax lots as of 1-Apr-2025 (reconstructed from the broker's
 * 31-Mar-2025 holding statement + FY25 transaction statement — see openingBasis.ts).
 * Lives in an "Opening Holdings" tab in each portfolio's spreadsheet. The FIFO
 * capital-gains engine and the Holding rebuild seed their queues from this BEFORE
 * replaying FY26 True Entry, so FY26 gains + holdings are correct without any
 * pre-FY26 transaction history.
 */
export const OPENING_HOLDINGS_TAB = "Opening Holdings";
const HEADER = ["Security", "ISIN", "Acquisition Date", "Quantity", "Cost/Share", "Invested", "Long Term", "Note"];

export interface OpeningSeedLot { name: string; isin: string; acqDate: string; qty: number; costPerShare: number; longTerm: boolean; note?: string; rowIndex?: number; }

const toNum = (s: any): number => { const v = parseFloat((s ?? "").toString().replace(/,/g, "").trim()); return isNaN(v) ? NaN : v; };

// A Sheets date serial → ISO yyyy-mm-dd (dates written USER_ENTERED come back as
// serials when read UNFORMATTED, which we normalize here; a plain string passes through).
const SHEET_EPOCH_MS = Date.UTC(1899, 11, 30);
function normalizeAcqDate(v: any): string {
  if (typeof v === "number" && isFinite(v)) {
    const d = new Date(SHEET_EPOCH_MS + Math.round(v * 86400000));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  return (v ?? "").toString().trim();
}

/** Overwrite the Opening Holdings tab with the reconstructed lots. */
export async function saveOpeningHoldings(spreadsheetId: string, lots: OpeningLot[]): Promise<{ written: number }> {
  await ensureSheetTabs(spreadsheetId, [OPENING_HOLDINGS_TAB]);
  const rows: any[][] = [HEADER];
  for (const l of lots) {
    rows.push([l.name, l.isin || "", l.acqDate, l.qty, l.costPerShare, l.invested, l.longTerm ? "Yes" : "", l.note]);
  }
  await (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${OPENING_HOLDINGS_TAB}!A:Z` });
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId, range: `${OPENING_HOLDINGS_TAB}!A1`, valueInputOption: "USER_ENTERED", resource: { values: rows },
  });
  return { written: lots.length };
}

/** Update a single Opening Holdings row in place (1-based sheet row), preserving
 *  Security / ISIN / Note; recomputes Invested from qty × cost/share. Used by the
 *  Trade Book "Edit Entry" popup so a carried-in lot can be corrected. */
export async function updateOpeningHoldingRow(
  spreadsheetId: string, rowIndex: number,
  patch: { acqDate: string; qty: number; costPerShare: number; longTerm: boolean },
): Promise<void> {
  const res = await (gapi.client as any).sheets.spreadsheets.values.get({
    spreadsheetId, range: `${OPENING_HOLDINGS_TAB}!A${rowIndex}:H${rowIndex}`, valueRenderOption: "UNFORMATTED_VALUE",
  });
  const existing: any[] = res?.result?.values?.[0] || [];
  const invested = Math.round(patch.qty * patch.costPerShare * 100) / 100;
  const row = [
    existing[0] ?? "",              // Security
    existing[1] ?? "",              // ISIN
    patch.acqDate,                  // Acquisition Date
    patch.qty,                      // Quantity
    patch.costPerShare,             // Cost/Share
    invested,                       // Invested
    patch.longTerm ? "Yes" : "",    // Long Term
    existing[7] ?? "",              // Note
  ];
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId, range: `${OPENING_HOLDINGS_TAB}!A${rowIndex}`, valueInputOption: "USER_ENTERED", resource: { values: [row] },
  });
}

/** Read the Opening Holdings tab ([] if the tab doesn't exist yet). Dates are
 *  read as serials and normalized to ISO so the engine's date parser is happy. */
export async function loadOpeningHoldings(spreadsheetId: string): Promise<OpeningSeedLot[]> {
  let res: any;
  try {
    res = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId, range: `${OPENING_HOLDINGS_TAB}!A1:H50000`,
      valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER",
    });
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || "";
    if (/unable to parse range/i.test(msg)) return [];   // tab not created yet
    throw e;
  }
  const rows: any[][] = res?.result?.values || [];
  if (rows.length < 2) return [];
  const start = /security|acquisition|quantity|cost/i.test((rows[0] || []).join(",")) ? 1 : 0;
  const out: OpeningSeedLot[] = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const name = (r[0] || "").toString().trim();
    const qty = toNum(r[3]);
    if (!name || isNaN(qty) || qty <= 0) continue;
    const cps = toNum(r[4]);
    out.push({
      name,
      isin: (r[1] || "").toString().trim().toUpperCase(),
      acqDate: normalizeAcqDate(r[2]),
      qty,
      costPerShare: isNaN(cps) ? 0 : cps,
      longTerm: /^(yes|true|y|lt)$/i.test((r[6] ?? "").toString().trim()),
      note: (r[7] ?? "").toString(),
      rowIndex: i + 1,   // 1-based sheet row (rows[0] is sheet row 1), for in-place edits
    });
  }
  return out;
}
