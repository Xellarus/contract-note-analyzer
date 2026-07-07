import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import { loadScripMaster, lookupScrip, SCRIP_MASTER_SPREADSHEET_ID, ScripMaster } from "./scripMaster";
import { rebuildHoldingTab, syncCapitalGains } from "./holdingsCalc";
import { mapRecordsToHeader, toIsoDate } from "./tradeRowSchema";
import { appendCorporateActionRow, CorpAction } from "./corporateActions";

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
  "Total Amount with Expense (Incl STT)", "Total Amount with Expense (Excl STT)", "Trade Class",
];

const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

interface RowRecord {
  date: string; isin: string; name: string; txType: string; qty: number; price: number;
  turnover: number; brokeragePerShare: number; brokerage: number; stt: number;
  exchangeCharges: number; sebiFees: number; ipf: number; gst: number; stampDuty: number;
  totalExpInclSTT: number; totalExpExclSTT: number; totalWithExpInclSTT: number;
  totalWithExpExclSTT: number; tradeClass: string;
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
  const txType = isBuySide ? "Buy" : "Sell";
  const freeShares = line.action === "Bonus" || line.action === "Split";  // ₹0, no charges
  // IPO allotment and rights subscription are buys at a real price, always delivery.
  const forceDelivery = freeShares || line.action === "IPO" || line.action === "Rights";

  const qty = Number(line.quantity) || 0;
  const price = freeShares ? 0 : r2(line.price);
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

  const rows = mapRecordsToHeader(header, records);
  const payload = empty ? [header, ...rows] : rows;

  await (gapi.client as any).sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A:Z`,
    valueInputOption: "USER_ENTERED",
    resource: { values: payload },
  });
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
