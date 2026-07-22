import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import { TxnNetEntry } from "./openingBasis";

/**
 * Running per-scrip position reconstructed from the transaction statement during a BATCH
 * (date-sliced) opening-basis import. Each batch appends a transaction slice; `advanceTxnNet`
 * folds it into this map, which is persisted here so the next batch continues from it. The
 * UI shows this as "position from transactions through <date>" so the user can compare it to
 * the broker holding report for that date and fix a missed bonus/split before the next slice.
 *
 * This is a VERIFICATION aid only — it is NOT read by rebuildHoldingTab / syncCapitalGains
 * (those use "Opening Holdings", which is sourced from the Holding Period Report). Lives in
 * its own "Opening Txn Net" tab per portfolio (keyed by the same obKey as the lots).
 */
export const OPENING_TXN_NET_TAB = "Opening Txn Net";

// key → { name, qty (our additive computation), brokerBal (broker's running balance, or null) }
export type TxnNetMap = Record<string, TxnNetEntry>;

const parseNum = (v: any): number => {
  const t = (v ?? "").toString().replace(/,/g, "").trim();
  const n = parseFloat(t);
  return isNaN(n) ? 0 : n;
};

/** Read the accumulated transaction position ({} if the tab is absent). */
export async function loadOpeningTxnNet(spreadsheetId: string): Promise<TxnNetMap> {
  let res: any;
  try {
    res = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId, range: `${OPENING_TXN_NET_TAB}!A1:D5000`, valueRenderOption: "UNFORMATTED_VALUE",
    });
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || "";
    if (/unable to parse range/i.test(msg)) return {};   // tab not created yet
    throw e;
  }
  const rows: any[][] = res?.result?.values || [];
  const out: TxnNetMap = {};
  for (let i = 1; i < rows.length; i++) {   // row 0 = header
    const r = rows[i] || [];
    const key = (r[0] ?? "").toString().trim();
    if (!key) continue;
    const name = (r[1] ?? "").toString().trim();
    const qty = parseNum(r[2]);
    const balCell = (r[3] ?? "").toString().trim();
    out[key] = { name, qty, brokerBal: balCell === "" ? null : parseNum(r[3]) };
  }
  return out;
}

/** Overwrite the accumulated transaction position. */
export async function saveOpeningTxnNet(spreadsheetId: string, map: TxnNetMap): Promise<void> {
  await ensureSheetTabs(spreadsheetId, [OPENING_TXN_NET_TAB]);
  const rows: any[][] = [["Key", "Name", "Computed Qty", "Broker Bal"]];
  for (const key of Object.keys(map).sort()) {
    const e = map[key];
    rows.push([key, e.name, e.qty, e.brokerBal == null ? "" : e.brokerBal]);
  }
  await (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${OPENING_TXN_NET_TAB}!A:Z` });
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId, range: `${OPENING_TXN_NET_TAB}!A1`, valueInputOption: "RAW", resource: { values: rows },
  });
}

/** Clear it (used when a Replace/one-shot import supersedes any batches). */
export async function resetOpeningTxnNet(spreadsheetId: string): Promise<void> {
  await ensureSheetTabs(spreadsheetId, [OPENING_TXN_NET_TAB]);
  await (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${OPENING_TXN_NET_TAB}!A:Z` });
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId, range: `${OPENING_TXN_NET_TAB}!A1`, valueInputOption: "RAW", resource: { values: [["Key", "Name", "Computed Qty", "Broker Bal"]] },
  });
}
