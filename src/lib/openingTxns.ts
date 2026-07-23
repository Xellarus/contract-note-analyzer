import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import { TxnStatementRow, obKey } from "./openingBasis";

/**
 * Raw dated transaction history from a BATCH (date-sliced) opening-basis import. Each batch
 * appends its transaction slice's rows here. This is the single source for BOTH:
 *   • the "position from transactions through <date>" check in the import screen, and
 *   • the Historical Holding Report (Reports), which replays these to ANY past date so a
 *     pre-FY26 date shows what was actually held then (True Entry is FY26-only).
 *
 * Lives in its own "Opening Txns" tab per portfolio. Names are stored already-canonicalized
 * (the caller maps them through the scrip master first). Verification/history only — the
 * FY26 lots come from "Opening Holdings" (the Holding Period Report).
 */
export const OPENING_TXNS_TAB = "Opening Txns";

const SHEET_EPOCH_MS = Date.UTC(1899, 11, 30);
const toNum = (v: any): number => { const n = parseFloat((v ?? "").toString().replace(/,/g, "").trim()); return isNaN(n) ? 0 : n; };
// Date cell → { iso, ts }. Written RAW as ISO, but tolerate a hand-typed serial.
function readDate(v: any): { iso: string; ts: number } {
  if (typeof v === "number" && isFinite(v)) {
    const d = new Date(SHEET_EPOCH_MS + Math.round(v * 86400000));
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    return { iso, ts: new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime() };
  }
  const c = (v ?? "").toString().trim();
  const m = c.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { iso: c, ts: new Date(+m[1], +m[2] - 1, +m[3]).getTime() };
  return { iso: c, ts: 0 };
}

/** Read the accumulated raw transaction history ([] if the tab is absent). */
export async function loadOpeningTxns(spreadsheetId: string): Promise<TxnStatementRow[]> {
  let res: any;
  try {
    res = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId, range: `${OPENING_TXNS_TAB}!A1:G100000`, valueRenderOption: "UNFORMATTED_VALUE",
    });
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || "";
    if (/unable to parse range/i.test(msg)) return [];   // tab not created yet
    throw e;
  }
  const rows: any[][] = res?.result?.values || [];
  const out: TxnStatementRow[] = [];
  for (let i = 1; i < rows.length; i++) {   // row 0 = header
    const r = rows[i] || [];
    const name = (r[2] ?? "").toString().trim();
    const type = (r[1] ?? "").toString().trim();
    if (!name || !type) continue;
    const { iso, ts } = readDate(r[0]);
    out.push({ dateStr: iso, iso, ts, type, name, qty: toNum(r[3]), price: toNum(r[4]), amount: toNum(r[5]), balQty: toNum(r[6]) });
  }
  return out;
}

/** Overwrite the whole history. */
export async function saveOpeningTxns(spreadsheetId: string, rows: TxnStatementRow[]): Promise<void> {
  await ensureSheetTabs(spreadsheetId, [OPENING_TXNS_TAB]);
  const sorted = rows.slice().sort((a, b) => (a.ts - b.ts) || a.name.localeCompare(b.name));
  const values: any[][] = [["Date", "Type", "Name", "Qty", "Price", "Amount", "BalQty"]];
  for (const r of sorted) values.push([r.iso, r.type, r.name, r.qty, r.price, r.amount, r.balQty]);
  await (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${OPENING_TXNS_TAB}!A:Z` });
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId, range: `${OPENING_TXNS_TAB}!A1`, valueInputOption: "RAW", resource: { values },
  });
}

/** Clear it (used when a Replace/one-shot import supersedes any batches). */
export async function resetOpeningTxns(spreadsheetId: string): Promise<void> {
  await ensureSheetTabs(spreadsheetId, [OPENING_TXNS_TAB]);
  await (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${OPENING_TXNS_TAB}!A:Z` });
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId, range: `${OPENING_TXNS_TAB}!A1`, valueInputOption: "RAW", resource: { values: [["Date", "Type", "Name", "Qty", "Price", "Amount", "BalQty"]] },
  });
}

/**
 * Merge a new slice into the existing history: any existing rows whose date falls inside the
 * slice's [min,max] range are dropped first, then the slice is appended. This makes
 * re-uploading a slice idempotent (it replaces that date range) while preserving genuinely
 * duplicate trades within a slice. Chronological, non-overlapping slices never drop anything.
 * Pure.
 */
export function mergeOpeningTxnsSlice(existing: TxnStatementRow[], slice: TxnStatementRow[]): TxnStatementRow[] {
  if (slice.length === 0) return existing.slice();
  const dated = slice.filter(t => t.ts > 0).map(t => t.ts);
  if (dated.length === 0) return existing.concat(slice);
  const lo = Math.min(...dated), hi = Math.max(...dated);
  const kept = existing.filter(t => t.ts <= 0 || t.ts < lo || t.ts > hi);
  return kept.concat(slice).sort((a, b) => (a.ts - b.ts) || obKey(a.name).localeCompare(obKey(b.name)));
}
