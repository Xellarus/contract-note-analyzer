import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import { lookupScrip, normName, ScripMaster } from "./scripMaster";

/**
 * Current-price snapshot store. Prices are per-security (not per-portfolio), so
 * they live in their own "Prices" tab inside the shared scrip-master spreadsheet
 * — one screener.in import refreshes prices for every portfolio. Each row is
 * ISIN | Name | Current Price | Updated (IST). Values are a snapshot from the
 * last import, not live.
 */
const PRICES_TAB = "Prices";
// Scrips the Yahoo updater couldn't price on its last run — written by YahooPriceUpdate.gs,
// surfaced in the app's "unpriced" button. Lives in the same shared scrip-master sheet.
const PRICE_STATUS_TAB = "Price Status";

/** Which feed last set a scrip's price. Drives the source badge on the stock page. */
export type PriceSource = "yahoo" | "screener" | "tradingview" | "";

export interface ScripPrice { isin: string; name: string; price: number; updated: string; previousPrice?: number; source?: PriceSource; except?: boolean; }

// Optional "Price Exception" column in the Prices tab. NOTE: the Prices tab is a POOR home for
// this flag — YahooPriceUpdate.gs `writePrices_` does clearContents() + writes 6 columns every
// run (~30 min in market hours), so a mark here is wiped; and a never-priced scrip has no row
// here at all. The authoritative home is the SCRIP MASTER tab (ScripEntry.priceExcept). This
// reader stays as a courtesy for marks made between .gs runs.
// Detected from the header on read and reused on rewrite so we never shift/clobber the column;
// `_exceptColSeen` keeps us from inventing the column on sheets that don't have it.
const DEFAULT_EXCEPT_COL = 7;
let _exceptCol = DEFAULT_EXCEPT_COL;
let _exceptColSeen = false;

/** Truthy marker in an exception cell: x / yes / y / true / 1 / a check mark. */
const isExceptCell = (v: any): boolean => /^(x|yes|y|true|1|✓|✔)$/i.test((v ?? "").toString().trim());

/** A scrip the Yahoo updater could not fetch a price for (no symbol, or Yahoo had none). */
export interface PriceMiss { isin: string; name: string; reason: string; checked: string; }

let _priceCache: { id: string; rows: ScripPrice[]; ts: number } | null = null;
const PRICE_TTL_MS = 60_000;

export function invalidatePriceCache(): void { _priceCache = null; }

const toNum = (s: any): number => { const v = parseFloat((s ?? "").toString().replace(/,/g, "").trim()); return isNaN(v) ? NaN : v; };

const istStamp = (): string =>
  new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });

// The date portion of an "Updated" stamp ("17 Jul 2026, 01:31 pm" → "17 Jul 2026").
// Used to decide when to roll the day's "Previous Price" baseline. Derived from the
// SAME formatter as the stamp so today's key and a stored stamp's date compare exactly.
const stampDate = (s: string): string => (s || "").split(",")[0].trim();

function parsePriceVals(vals: any[][]): ScripPrice[] {
  const rows: ScripPrice[] = [];
  const header = vals[0] || [];
  const start = vals.length > 0 && /isin|name|price|updated/i.test(header.join(",")) ? 1 : 0;
  // Locate the "Price Exception" column from the header; fall back to its current home (H).
  if (start === 1) {
    const idx = header.findIndex((h: any) => /exception|exclud/i.test((h ?? "").toString()));
    _exceptColSeen = idx >= 0;
    _exceptCol = idx >= 0 ? idx : DEFAULT_EXCEPT_COL;
  }
  for (let i = start; i < vals.length; i++) {
    const r = vals[i]; if (!r) continue;
    const isin = (r[0] || "").toString().trim().toUpperCase();
    const name = (r[1] || "").toString().trim();
    const price = toNum(r[2]);
    const updated = (r[3] || "").toString().trim();
    const previousPrice = toNum(r[4]);
    const source = (r[5] || "").toString().trim().toLowerCase() as PriceSource;
    const except = isExceptCell(r[_exceptCol]);
    // An excepted scrip is kept even without a parseable price — the flag is the point.
    if ((!isin && !name) || (isNaN(price) && !except)) continue;
    const src: PriceSource = source === "yahoo" || source === "screener" || source === "tradingview" ? source : "";
    rows.push({ isin, name, price: isNaN(price) ? 0 : price, updated, previousPrice: isNaN(previousPrice) ? 0 : previousPrice, source: src, except });
  }
  return rows;
}

/**
 * Read the Prices tab. Returns [] only when the tab is genuinely absent;
 * rethrows real API errors so callers that rewrite the tab don't clobber it
 * with an empty merge base on a transient failure.
 */
async function fetchPriceRows(spreadsheetId: string): Promise<ScripPrice[]> {
  let res: any;
  try {
    res = await (gapi.client as any).sheets.spreadsheets.values.get({ spreadsheetId, range: `${PRICES_TAB}!A1:J50000` });   // wide enough for the Price Exception column (H)
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || "";
    if (/unable to parse range/i.test(msg)) return [];   // tab not created yet
    throw e;
  }
  return parsePriceVals(res?.result?.values || []);
}

/** Read the Prices tab (empty list if it doesn't exist yet). Cached for a short
 *  TTL. Tolerant: any read failure yields an empty list (display falls back). */
export async function loadScripPrices(spreadsheetId: string, opts?: { force?: boolean }): Promise<ScripPrice[]> {
  const now = Date.now();
  if (!opts?.force && _priceCache && _priceCache.id === spreadsheetId && now - _priceCache.ts < PRICE_TTL_MS) {
    return _priceCache.rows;
  }
  let rows: ScripPrice[] = [];
  try { rows = await fetchPriceRows(spreadsheetId); } catch { rows = []; }
  _priceCache = { id: spreadsheetId, rows, ts: now };
  return rows;
}

/**
 * Read the "Price Status" tab — the scrips the Yahoo updater couldn't price on its last
 * run (ISIN | Name | Reason | Checked). Empty list if the tab doesn't exist yet or on any
 * read error (the feature is informational — never blocks). Not cached (small + on demand).
 */
export async function loadPriceMisses(spreadsheetId: string): Promise<PriceMiss[]> {
  let res: any;
  try {
    res = await (gapi.client as any).sheets.spreadsheets.values.get({ spreadsheetId, range: `${PRICE_STATUS_TAB}!A1:D50000` });
  } catch { return []; }
  const vals: any[][] = res?.result?.values || [];
  const out: PriceMiss[] = [];
  const start = vals.length > 0 && /isin|name|reason|checked/i.test((vals[0] || []).join(",")) ? 1 : 0;
  for (let i = start; i < vals.length; i++) {
    const r = vals[i]; if (!r) continue;
    const isin = (r[0] || "").toString().trim().toUpperCase();
    const name = (r[1] || "").toString().trim();
    if (!isin && !name) continue;
    out.push({ isin, name, reason: (r[2] || "").toString().trim(), checked: (r[3] || "").toString().trim() });
  }
  return out;
}

/**
 * Merge an incoming price snapshot into the Prices tab (latest import wins per
 * ISIN; prices for securities not in this import are preserved). Rewrites the
 * whole tab with a header + an IST "Updated" stamp on the rows we touched.
 */
export async function saveScripPrices(
  spreadsheetId: string,
  incoming: { isin: string; name: string; price: number }[],
): Promise<{ updated: number; total: number }> {
  const existing = await fetchPriceRows(spreadsheetId);  // strict: a real read error aborts the save (no clobber)
  const map = new Map<string, ScripPrice>();
  for (const p of existing) if (p.isin) map.set(p.isin, p);

  const stamp = istStamp();
  const today = stampDate(stamp);
  let updated = 0;
  for (const s of incoming) {
    const isin = (s.isin || "").trim().toUpperCase();
    if (!isin || !(s.price > 0)) continue;
    const prev = map.get(isin);
    // Roll the day's baseline: the FIRST import on a new calendar day moves the
    // last-known price into "Previous Price"; same-day re-imports keep the baseline
    // (so re-importing intraday doesn't reset "today's" change to zero).
    let previousPrice = prev?.previousPrice ?? 0;
    if (prev && prev.price > 0 && stampDate(prev.updated) && stampDate(prev.updated) !== today) {
      previousPrice = prev.price;
    }
    // A manual screener import stamps source 'screener'; rows it doesn't touch (e.g. Yahoo-fed)
    // keep their existing source.
    map.set(isin, { isin, name: s.name || prev?.name || "", price: s.price, updated: stamp, previousPrice, source: "screener", except: prev?.except });
    updated++;
  }

  // Preserve a "Price Exception" column ONLY if the sheet already has one (never invent it):
  // pad each row out to its index so this full-tab rewrite doesn't clear or shift the marks.
  const head: any[] = ["ISIN", "Name", "Current Price", "Updated", "Previous Price", "Source"];
  if (_exceptColSeen) { while (head.length <= _exceptCol) head.push(""); head[_exceptCol] = "Price Exception"; }
  const rows: any[][] = [head];
  for (const p of [...map.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const row: any[] = [p.isin, p.name, p.price, p.updated, p.previousPrice || "", p.source || ""];
    if (_exceptColSeen) { while (row.length <= _exceptCol) row.push(""); row[_exceptCol] = p.except ? "x" : ""; }
    rows.push(row);
  }

  await ensureSheetTabs(spreadsheetId, [PRICES_TAB]);
  await (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${PRICES_TAB}!A:Z` });
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId, range: `${PRICES_TAB}!A1`, valueInputOption: "USER_ENTERED", resource: { values: rows },
  });
  invalidatePriceCache();
  return { updated, total: map.size };
}

/**
 * Build a (isin, name) → "is this scrip a price exception?" test from the Prices tab's
 * user-maintained exception column. Matched by ISIN first, then normalized name, then the
 * scrip-master canonical key, so a flag set on either identity is honoured.
 */
export function makeExceptionResolver(master: ScripMaster | null, prices: ScripPrice[]): (isin: string, name: string) => boolean {
  const keys = new Set<string>();
  for (const p of prices) {
    if (!p.except) continue;
    if (p.isin) keys.add('isin:' + p.isin.toUpperCase());
    if (p.name) keys.add('name:' + normName(p.name));
    if (master) { const e = lookupScrip(master, p.isin, p.name).entry; if (e) keys.add('key:' + e.key); }
  }
  return (isin: string, name: string) => {
    if (isin && keys.has('isin:' + isin.toUpperCase())) return true;
    if (name && keys.has('name:' + normName(name))) return true;
    if (master) { const e = lookupScrip(master, isin, name).entry; if (e && keys.has('key:' + e.key)) return true; }
    return false;
  };
}

/**
 * Build a (isin, name) → current price resolver from an imported price snapshot.
 * Matches via the scrip-master canonical key first (so a holding with a blank
 * ISIN still matches by name), then raw ISIN, then normalized name. Returns
 * undefined when there's no imported price for that security.
 */
export function makePriceResolver(master: ScripMaster | null, prices: ScripPrice[]): (isin: string, name: string) => number | undefined {
  const m = new Map<string, number>();
  for (const p of prices) {
    if (!(p.price > 0)) continue;
    if (p.isin) m.set('isin:' + p.isin.toUpperCase(), p.price);
    if (p.name) m.set('name:' + normName(p.name), p.price);
    if (master) { const e = lookupScrip(master, p.isin, p.name).entry; if (e) m.set('key:' + e.key, p.price); }
  }
  return (isin: string, name: string) => {
    if (master) { const e = lookupScrip(master, isin, name).entry; if (e) { const v = m.get('key:' + e.key); if (v !== undefined) return v; } }
    if (isin) { const v = m.get('isin:' + isin.toUpperCase()); if (v !== undefined) return v; }
    return m.get('name:' + normName(name));
  };
}
