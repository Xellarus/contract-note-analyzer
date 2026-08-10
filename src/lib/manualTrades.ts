import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import { loadScripMaster, lookupScrip, SCRIP_MASTER_SPREADSHEET_ID, ScripMaster } from "./scripMaster";
import { rebuildHoldingTab, syncCapitalGains } from "./holdingsCalc";
import { mapRecordsToHeader, toIsoDate, headerKey } from "./tradeRowSchema";
import { appendCorporateActionRow, updateCorporateActionRow, CorpAction } from "./corporateActions";

/**
 * Manual trade entry → the same `True Entry` / `Raw Entry` ledger an imported
 * contract note writes to, so the Holding tab + capital gains recompute exactly
 * as they do after an import.
 *
 * Trade types map onto the Buy/Sell engine like this:
 *   • Buy / Sell  — direct, with full granular charges.
 *   • IPO         — a Buy at the issue price (delivery), keeps any charges.
 *   • Bonus       — free shares: a Buy at ₹0 → quantity rises, cost unchanged,
 *                   average dilutes (also the correct zero cost basis).
 *   • Split       — for a weighted-average book this is mechanically identical
 *                   to a bonus (add shares at ₹0, total cost unchanged).
 */
export type ManualAction = "Buy" | "Sell" | "IPO" | "Bonus" | "Split" | "Rights";

export interface ManualTradeLine {
  isin: string;
  securityName: string;
  action: ManualAction;
  quantity: number;
  price: number;            // per-share; forced to 0 for Bonus / Split
  tradeClass: "Delivery" | "Intraday";
  brokerage: number;
  stt: number;
  exchangeCharges: number;  // Exchange Turnover Charges
  sebiFees: number;
  stampDuty: number;
  gst: number;              // IGST / total GST
  ipf: number;
  notes?: string;           // free-text note (optional) — shown in the Trade Book entry popup
}

export interface AppendManualResult {
  added: number;
  holdingWarning?: string;
  capGainsWarning?: string;
}

// Superset header used only when a tab is still empty (most sheets already carry
// a header from a prior import, which we align to instead). Includes IPF + IGST
// so every granular field has a home. ISIN is intentionally not written.
const DEFAULT_HEADER = [
  "Trade Date", "Stock Name", "Transaction Type", "Number of Shares", "Avg Price",
  "Total Amount (Turnover)", "Brokerage Per Share", "Total Brokerage", "STT",
  "Exchange Turnover Charges", "SEBI Turnover Fees", "IPF Charges", "IGST",
  "Stamp Duty", "Total Expenses (incl STT)", "Total Expenses (excl STT)",
  "Total Amount with Expense (Incl STT)", "Total Amount with Expense (Excl STT)", "Trade Class", "Notes",
];

const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
const r6 = (n: number): number => Math.round((Number(n) || 0) * 1e6) / 1e6;

interface RowRecord {
  date: string; isin: string; name: string; txType: string; qty: number; price: number;
  turnover: number; brokeragePerShare: number; brokerage: number; stt: number;
  exchangeCharges: number; sebiFees: number; ipf: number; gst: number; stampDuty: number;
  totalExpInclSTT: number; totalExpExclSTT: number; totalWithExpInclSTT: number;
  totalWithExpExclSTT: number; tradeClass: string; notes: string;
}

function buildRecord(line: ManualTradeLine, tradeDate: string, master: ScripMaster | null): RowRecord {
  // Resolve canonical name / fill ISIN from the shared scrip master (same as import).
  let name = (line.securityName || "").trim();
  let isin = (line.isin || "").trim().toUpperCase();
  if (master) {
    const e = lookupScrip(master, isin, name).entry;
    if (e) { name = e.canonicalName; if (!isin) isin = e.isin || ""; }
  }

  const isBuySide = line.action !== "Sell";
  // Store the REAL action ("Bonus" / "Split" / "IPO" / "Rights" / "Buy" / "Sell") so the
  // Trade Book shows what actually happened; the calc engines classify it back to a
  // buy/sell side via ledgerSide() (Bonus/Split are buy-side at ₹0).
  const txType = line.action;
  const freeShares = line.action === "Bonus" || line.action === "Split";  // ₹0, no charges
  // IPO allotment and rights subscription are buys at a real price, always delivery.
  const forceDelivery = freeShares || line.action === "IPO" || line.action === "Rights";

  const qty = Number(line.quantity) || 0;
  // A RATE keeps full precision (r6) — only money sits at paise. Rounding price to 2dp used to
  // break the amount→price round-trip (₹1000 over 3 shares → 333.33 → turnover ₹999.99).
  const price = freeShares ? 0 : r6(line.price);
  const turnover = r2(qty * price);

  const brokerage = freeShares ? 0 : r2(line.brokerage);
  const stt = freeShares ? 0 : r2(line.stt);
  const exchangeCharges = freeShares ? 0 : r2(line.exchangeCharges);
  const sebiFees = freeShares ? 0 : r2(line.sebiFees);
  const stampDuty = freeShares ? 0 : r2(line.stampDuty);
  const gst = freeShares ? 0 : r2(line.gst);
  const ipf = freeShares ? 0 : r2(line.ipf);

  const totalExpInclSTT = r2(brokerage + stt + exchangeCharges + sebiFees + stampDuty + gst + ipf);
  const totalExpExclSTT = r2(totalExpInclSTT - stt);
  const totalWithExpInclSTT = r2(isBuySide ? turnover + totalExpInclSTT : turnover - totalExpInclSTT);
  const totalWithExpExclSTT = r2(isBuySide ? turnover + totalExpExclSTT : turnover - totalExpExclSTT);
  const brokeragePerShare = qty > 0 ? r2(brokerage / qty) : 0;

  return {
    date: toIsoDate(tradeDate), isin: "", name, txType, qty, price, turnover, brokeragePerShare, brokerage, stt,
    exchangeCharges, sebiFees, ipf, gst, stampDuty, totalExpInclSTT, totalExpExclSTT,
    totalWithExpInclSTT, totalWithExpExclSTT,
    tradeClass: forceDelivery ? "Delivery" : line.tradeClass,
    notes: (line.notes || "").trim(),
  };
}

async function appendRecordsToTab(spreadsheetId: string, tab: string, records: RowRecord[]): Promise<void> {
  // Align to the tab's existing header so rows land in the right columns no
  // matter which broker schema (IGST vs Total GST, with/without IPF) created it.
  let header: string[] = [];
  let empty = false;
  try {
    const res = await (gapi.client as any).sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A1:Z1` });
    header = ((res?.result?.values?.[0] as any[]) || []).map((h) => (h ?? "").toString()).filter((h) => h.trim() !== "");
  } catch {
    /* treat as empty/new */
  }
  if (header.length === 0) { header = DEFAULT_HEADER; empty = true; }

  // Auto-append a "Notes" column if a row carries a note and the sheet doesn't have one
  // yet (existing sheets predate the feature). We add the header cell in place — old rows
  // stay blank in that column — so the note lands in the right column on the appended rows.
  if (!empty && records.some((r) => (r.notes || "").toString().trim() !== "") && !header.some((h) => headerKey(h) === "notes")) {
    header = [...header, "Notes"];
    await (gapi.client as any).sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!${colA1(header.length - 1)}1`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [["Notes"]] },
    });
  }

  const rows = mapRecordsToHeader(header, records);
  const payload = empty ? [header, ...rows] : rows;

  await (gapi.client as any).sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A:Z`,
    valueInputOption: "USER_ENTERED",
    resource: { values: payload },
  });
}

// 0-based column index → A1 column letter (0→A, 25→Z, 26→AA). Used to place a newly
// auto-appended header cell (e.g. "Notes") at the next free column of row 1.
function colA1(i: number): string {
  let n = i + 1, s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * Write manually-entered trades to a portfolio's ledger and recompute downstream
 * tabs — identical to the post-import pipeline. `tradeDate` (ISO YYYY-MM-DD;
 * normalised regardless) applies to every line. Rebuild / capital-gains failures
 * are returned as warnings, not thrown, so the rows are still saved.
 */
export async function appendManualTrades(
  spreadsheetId: string,
  lines: ManualTradeLine[],
  tradeDate: string,
): Promise<AppendManualResult> {
  try { await ensureSheetTabs(spreadsheetId, ["Raw Entry", "True Entry", "Holding"]); } catch (e) {
    console.warn("ensureSheetTabs failed (continuing):", e);
  }

  let master: ScripMaster | null = null;
  try { master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID); } catch (e) {
    console.warn("Could not load Scrip Master for name resolution — keeping entered names:", e);
  }

  const records = lines.map((l) => buildRecord(l, tradeDate, master));

  // Mirror imports: write the same rows to both Raw Entry and True Entry.
  for (const tab of ["Raw Entry", "True Entry"]) {
    await appendRecordsToTab(spreadsheetId, tab, records);
  }

  let holdingWarning: string | undefined;
  try { await rebuildHoldingTab(spreadsheetId); } catch (e: any) {
    holdingWarning = e?.result?.error?.message || e?.message || "Unknown error";
  }
  let capGainsWarning: string | undefined;
  try { await syncCapitalGains(spreadsheetId); } catch (e: any) {
    capGainsWarning = e?.result?.error?.message || e?.message || "Unknown error";
  }

  return { added: records.length, holdingWarning, capGainsWarning };
}

/**
 * Record a corporate action (merger / demerger) in the Corporate Actions tab and
 * recompute the Holding tab + capital gains so the action is reflected. Rebuild /
 * capital-gains failures are returned as warnings, not thrown.
 */
export async function updateCorporateAction(
  spreadsheetId: string,
  rowIndex: number,
  action: CorpAction,
): Promise<{ holdingWarning?: string; capGainsWarning?: string }> {
  await updateCorporateActionRow(spreadsheetId, rowIndex, action);
  // The amount feeds the FIFO cost basis, so BOTH sides move: the parent's remaining lots are
  // rescaled and the NewCo's lot is repriced. Realised gains on parent shares sold after the
  // action date change too — hence the capital-gains resync, not just the holding rebuild.
  let holdingWarning: string | undefined;
  try { await rebuildHoldingTab(spreadsheetId); } catch (e: any) {
    holdingWarning = e?.result?.error?.message || e?.message || "Unknown error";
  }
  let capGainsWarning: string | undefined;
  try { await syncCapitalGains(spreadsheetId); } catch (e: any) {
    capGainsWarning = e?.result?.error?.message || e?.message || "Unknown error";
  }
  return { holdingWarning, capGainsWarning };
}

export async function appendCorporateAction(
  spreadsheetId: string,
  action: CorpAction,
): Promise<{ holdingWarning?: string; capGainsWarning?: string }> {
  await appendCorporateActionRow(spreadsheetId, action);
  let holdingWarning: string | undefined;
  try { await rebuildHoldingTab(spreadsheetId); } catch (e: any) {
    holdingWarning = e?.result?.error?.message || e?.message || "Unknown error";
  }
  let capGainsWarning: string | undefined;
  try { await syncCapitalGains(spreadsheetId); } catch (e: any) {
    capGainsWarning = e?.result?.error?.message || e?.message || "Unknown error";
  }
  return { holdingWarning, capGainsWarning };
}
