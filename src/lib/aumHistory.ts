import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import { SCRIP_MASTER_SPREADSHEET_ID } from "./scripMaster";

/**
 * Daily AUM snapshots — the market-value history the sheets otherwise lack.
 * One row per IST calendar day: Date | Invested | Current AUM, appended (or
 * refreshed in place for same-day reloads) whenever the Dashboard computes a
 * live AUM. Lives in the shared scrip-master spreadsheet, since the figure
 * spans all portfolios. Grows into the chart's true market line over time.
 *
 * Dates are written RAW as ISO strings so Sheets can't coerce them into
 * locale-ambiguous serials (same convention as the Opening Basis state tab);
 * reads still tolerate serials in case a row was hand-entered.
 */
export const AUM_HISTORY_TAB = "AUM History";

export interface AumSnapshot { ts: number; invested: number; current: number }

const SHEET_EPOCH_MS = Date.UTC(1899, 11, 30);
const tsOf = (v: any): number => {
  if (typeof v === "number" && isFinite(v)) return SHEET_EPOCH_MS + Math.round(v * 86400000);
  const s = (v ?? "").toString().trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const t = Date.parse(s);
  return isNaN(t) ? NaN : t;
};
const toNum = (s: any): number => { const v = parseFloat((s ?? "").toString().replace(/,/g, "").trim()); return isNaN(v) ? NaN : v; };

// Today's IST calendar date as yyyy-mm-dd (en-CA locale formats exactly that).
const istToday = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

async function fetchRows(): Promise<any[][]> {
  try {
    const res = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId: SCRIP_MASTER_SPREADSHEET_ID, range: `${AUM_HISTORY_TAB}!A1:C50000`,
      valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER",
    });
    return res?.result?.values || [];
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || "";
    if (/unable to parse range/i.test(msg)) return [];   // tab not created yet
    throw e;
  }
}

function parseRows(rows: any[][]): AumSnapshot[] {
  const out: AumSnapshot[] = [];
  const start = rows.length > 0 && /date|invested|aum|current/i.test((rows[0] || []).join(",")) ? 1 : 0;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const ts = tsOf(r[0]), invested = toNum(r[1]), current = toNum(r[2]);
    if (isNaN(ts) || isNaN(current)) continue;
    out.push({ ts, invested: isNaN(invested) ? 0 : invested, current });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Read the snapshot history ([] when none yet). */
export async function loadAumHistory(): Promise<AumSnapshot[]> {
  return parseRows(await fetchRows());
}

/**
 * Record today's AUM (append, or overwrite today's existing row so intraday
 * reloads keep the freshest value). Returns the full updated history so the
 * caller doesn't need a second read.
 */
export async function logAumSnapshot(invested: number, current: number): Promise<AumSnapshot[]> {
  const spreadsheetId = SCRIP_MASTER_SPREADSHEET_ID;
  await ensureSheetTabs(spreadsheetId, [AUM_HISTORY_TAB]);
  const rows = await fetchRows();
  const today = istToday();
  const todayTs = tsOf(today);
  const inv = Math.round(invested * 100) / 100;
  const cur = Math.round(current * 100) / 100;

  if (rows.length === 0) {
    await (gapi.client as any).sheets.spreadsheets.values.update({
      spreadsheetId, range: `${AUM_HISTORY_TAB}!A1`, valueInputOption: "RAW",
      resource: { values: [["Date", "Invested", "Current AUM"], [today, inv, cur]] },
    });
    return [{ ts: todayTs, invested: inv, current: cur }];
  }

  // Same-day reload → refresh that row in place; otherwise append.
  let todayRow = -1;
  for (let i = rows.length - 1; i >= 1; i--) {
    if (tsOf(rows[i]?.[0]) === todayTs) { todayRow = i; break; }
  }
  if (todayRow >= 0) {
    await (gapi.client as any).sheets.spreadsheets.values.update({
      spreadsheetId, range: `${AUM_HISTORY_TAB}!A${todayRow + 1}`, valueInputOption: "RAW",
      resource: { values: [[today, inv, cur]] },
    });
    rows[todayRow] = [today, inv, cur];
  } else {
    await (gapi.client as any).sheets.spreadsheets.values.append({
      spreadsheetId, range: `${AUM_HISTORY_TAB}!A:C`, valueInputOption: "RAW",
      resource: { values: [[today, inv, cur]] },
    });
    rows.push([today, inv, cur]);
  }
  return parseRows(rows);
}
