import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";

/**
 * Progress marker for BATCH (date-sliced) opening-basis imports. When an account's
 * inception→31-Mar-2025 history is too large to import in one pass, it's fed in
 * chronological, non-overlapping slices. This tab records how far the running position
 * (the "Opening Holdings" tab) has been carried so the UI can:
 *   • show "continuing … through <date>", and
 *   • block a slice that overlaps an already-processed date range (which would
 *     double-count) — see the overlap guard in OpeningBasisImport.
 *
 * Lives in its own tiny "Opening Basis State" tab per portfolio (not True Entry).
 * `processedThrough` is stored as an ISO string written RAW so Sheets doesn't coerce
 * it to a date serial; the loader still tolerates a serial just in case.
 */
export const OPENING_BASIS_STATE_TAB = "Opening Basis State";

export interface OpeningBasisState { processedThrough: string; batches: number; }

const EMPTY: OpeningBasisState = { processedThrough: "", batches: 0 };

// A Sheets date serial → ISO (defensive: we write RAW, but a hand-edit could re-type it).
const SHEET_EPOCH_MS = Date.UTC(1899, 11, 30);
function normISO(v: any): string {
  if (typeof v === "number" && isFinite(v)) {
    const d = new Date(SHEET_EPOCH_MS + Math.round(v * 86400000));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  return (v ?? "").toString().trim();
}

/** Read the batch-import progress ({processedThrough:"", batches:0} if the tab is absent). */
export async function loadOpeningBasisState(spreadsheetId: string): Promise<OpeningBasisState> {
  let res: any;
  try {
    res = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId, range: `${OPENING_BASIS_STATE_TAB}!A1:B20`, valueRenderOption: "UNFORMATTED_VALUE",
    });
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || "";
    if (/unable to parse range/i.test(msg)) return { ...EMPTY };   // tab not created yet
    throw e;
  }
  const rows: any[][] = res?.result?.values || [];
  const out: OpeningBasisState = { ...EMPTY };
  for (const r of rows) {
    const k = (r?.[0] ?? "").toString().trim().toLowerCase();
    if (k.startsWith("processed")) out.processedThrough = normISO(r?.[1]);
    else if (k.startsWith("batch")) { const n = parseInt((r?.[1] ?? "0").toString(), 10); out.batches = isNaN(n) ? 0 : n; }
  }
  return out;
}

/** Overwrite the batch-import progress. */
export async function saveOpeningBasisState(spreadsheetId: string, state: OpeningBasisState): Promise<void> {
  await ensureSheetTabs(spreadsheetId, [OPENING_BASIS_STATE_TAB]);
  const rows: any[][] = [
    ["Field", "Value"],
    ["Processed Through", state.processedThrough || ""],
    ["Batches", state.batches || 0],
  ];
  await (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${OPENING_BASIS_STATE_TAB}!A:Z` });
  await (gapi.client as any).sheets.spreadsheets.values.update({
    // RAW so "2015-03-31" stays a literal string, not a coerced date serial.
    spreadsheetId, range: `${OPENING_BASIS_STATE_TAB}!A1`, valueInputOption: "RAW", resource: { values: rows },
  });
}

/** Clear the progress marker (used when a Replace/one-shot import supersedes any batches). */
export async function resetOpeningBasisState(spreadsheetId: string): Promise<void> {
  await saveOpeningBasisState(spreadsheetId, { ...EMPTY });
}
