import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";

// Dedicated spreadsheet for the access/login log (separate from the trading
// ledgers and the scrip master). Repoint here to use a different sheet.
export const LOGIN_LOG_SPREADSHEET_ID = "1gWk96EGFun6tGiMbrt06_T2kCKF67D-Upg1cHfC9YxQ";
const TAB = "Login Log";
const IMPORT_TAB = "Import Log";

export type AccessEvent = "login" | "resume";

const GUEST_EMAIL = "guest@saguncapital.com";

/**
 * Append one row to the Login Log: who signed in (or resumed a session) and when.
 * Fire-and-forget — failures are swallowed so logging never blocks the app.
 * This is a client-side usage log written with the signed-in user's own Sheets
 * access (not a tamper-proof audit). The guest dev-bypass user is never logged.
 */
export async function logAccess(event: AccessEvent, user: { email?: string; name?: string } | null | undefined): Promise<void> {
  try {
    const email = (user?.email || "").trim();
    if (!email || email === GUEST_EMAIL) return;
    // Need a live Sheets token to write.
    const token = (gapi?.client as any)?.getToken?.();
    if (!token?.access_token) return;

    await ensureSheetTabs(LOGIN_LOG_SPREADSHEET_ID, [TAB]);

    // Write a header row the first time the tab is used.
    let isEmpty = false;
    try {
      const res: any = await (gapi.client as any).sheets.spreadsheets.values.get({
        spreadsheetId: LOGIN_LOG_SPREADSHEET_ID,
        range: `${TAB}!A1:A1`,
      });
      isEmpty = !res?.result?.values || res.result.values.length === 0;
    } catch {
      isEmpty = true;
    }

    const now = new Date();
    const ts = now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const label = event === "resume" ? "Session resumed" : "Login";

    const values: any[][] = [];
    if (isEmpty) values.push(["Timestamp (IST)", "Event", "Email", "Name", "Browser", "ISO Time"]);
    values.push([ts, label, email, user?.name || "", ua, now.toISOString()]);

    await (gapi.client as any).sheets.spreadsheets.values.append({
      spreadsheetId: LOGIN_LOG_SPREADSHEET_ID,
      range: `${TAB}!A:F`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      resource: { values },
    });
  } catch (e) {
    console.warn("Access log failed (non-fatal):", e);
  }
}

export interface ImportLogData {
  header: string[];
  rows: string[][];
  /** 1-based sheet row of the first data row (2 when a header is present, else 1),
   *  so callers can map a data row back to its cell for in-place updates. */
  firstDataRow: number;
}

// Full schema. The last four columns power the "Rewind" action in Import History:
//  Import ID  — matches the stamp on the ledger rows this import wrote.
//  Portfolio  — client code, resolves to the backing sheet (portfolioByCode).
//  Rows       — how many rows it added (shown; 0 → nothing to rewind).
//  Status     — blank when live, "Reversed" once rewound.
const IMPORT_HEADER = ["Date", "Time", "Contract Note Name", "Broker", "User", "Import ID", "Portfolio", "Rows", "Status"];

/** 0-based column index → A1 letter(s) (0→A, 8→I, 26→AA). */
function colLetter(i: number): string {
  let s = "", n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Read the Import Log tab (for the Import History view). Returns rows in sheet
 *  order (oldest first); the caller can reverse for newest-first display. */
export async function fetchImportLog(): Promise<ImportLogData> {
  const token = (gapi?.client as any)?.getToken?.();
  if (!token?.access_token) throw new Error("Not connected to Google Sheets — sign in to view import history.");
  await ensureSheetTabs(LOGIN_LOG_SPREADSHEET_ID, [IMPORT_TAB]);
  const res: any = await (gapi.client as any).sheets.spreadsheets.values.get({
    spreadsheetId: LOGIN_LOG_SPREADSHEET_ID,
    range: `${IMPORT_TAB}!A1:I100000`,
  });
  const all: string[][] = res?.result?.values || [];
  if (all.length === 0) return { header: IMPORT_HEADER, rows: [], firstDataRow: 2 };
  const hasHeader = !!(all[0] && /date|time|note|broker|user/i.test(all[0].join(" ")));
  const header = hasHeader ? all[0] : IMPORT_HEADER;
  const rows = hasHeader ? all.slice(1) : all;
  return { header, rows, firstDataRow: hasHeader ? 2 : 1 };
}

/**
 * Append one row to the Import Log when a contract note is imported to Sheets:
 * Date | Time | Contract Note Name | Broker | User | Import ID | Portfolio | Rows |
 * Status. Migrates an older (5-column) log header to the full schema on the fly.
 * Fire-and-forget.
 */
export async function logImport(info: {
  noteName: string;
  broker: string;
  user: { email?: string; name?: string } | null | undefined;
  importId?: string;
  portfolioCode?: string;
  rows?: number;
}): Promise<void> {
  try {
    const email = (info.user?.email || "").trim();
    if (email === GUEST_EMAIL) return;
    const token = (gapi?.client as any)?.getToken?.();
    if (!token?.access_token) return;

    await ensureSheetTabs(LOGIN_LOG_SPREADSHEET_ID, [IMPORT_TAB]);

    // Read the current header so we can (a) write it if the tab is new, or
    // (b) append any missing columns if it predates the Import ID/Status schema.
    let headerRow: string[] = [];
    try {
      const res: any = await (gapi.client as any).sheets.spreadsheets.values.get({
        spreadsheetId: LOGIN_LOG_SPREADSHEET_ID,
        range: `${IMPORT_TAB}!A1:I1`,
      });
      headerRow = ((res?.result?.values?.[0] as any[]) || []).map((h) => (h ?? "").toString());
    } catch { /* treat as empty */ }

    const values: any[][] = [];
    if (headerRow.filter((h) => h.trim() !== "").length === 0) {
      values.push(IMPORT_HEADER);
    } else {
      const missing = IMPORT_HEADER.filter((h) => !headerRow.some((x) => x.trim().toLowerCase() === h.toLowerCase()));
      if (missing.length) {
        await (gapi.client as any).sheets.spreadsheets.values.update({
          spreadsheetId: LOGIN_LOG_SPREADSHEET_ID,
          range: `${IMPORT_TAB}!A1`,
          valueInputOption: "RAW",
          resource: { values: [[...headerRow, ...missing]] },
        });
      }
    }

    const now = new Date();
    const date = now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
    const time = now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: true, hour: "2-digit", minute: "2-digit" });
    const who = info.user?.name || email || "Unknown";

    values.push([
      date, time, info.noteName || "", info.broker || "", who,
      info.importId || "", info.portfolioCode || "", info.rows != null ? String(info.rows) : "", "",
    ]);

    await (gapi.client as any).sheets.spreadsheets.values.append({
      spreadsheetId: LOGIN_LOG_SPREADSHEET_ID,
      range: `${IMPORT_TAB}!A:I`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      resource: { values },
    });
  } catch (e) {
    console.warn("Import log failed (non-fatal):", e);
  }
}

/** Mark one Import Log row as reversed (writes "Reversed" into its Status cell).
 *  `sheetRow` is 1-based; `statusColIndex` is the 0-based Status column index. */
export async function markImportReversed(sheetRow: number, statusColIndex: number): Promise<void> {
  const token = (gapi?.client as any)?.getToken?.();
  if (!token?.access_token) throw new Error("Not connected to Google Sheets.");
  const cell = `${IMPORT_TAB}!${colLetter(statusColIndex)}${sheetRow}`;
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId: LOGIN_LOG_SPREADSHEET_ID,
    range: cell,
    valueInputOption: "RAW",
    resource: { values: [["Reversed"]] },
  });
}
