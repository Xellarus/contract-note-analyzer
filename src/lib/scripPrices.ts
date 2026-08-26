import { gapi } from "gapi-script";
import { invalidateDashboard } from "./dashboardCache";
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

export interface ScripPrice {
  isin: string; name: string; price: number;
  /** When we FETCHED (IST stamp). NOT the date the price belongs to — see `priceDate`. */
  updated: string;
  previousPrice?: number; source?: PriceSource; except?: boolean;
  /**
   * The trading session this PRICE belongs to ("yyyy-MM-dd"), written by YahooPriceUpdate.gs.
   * Distinct from `updated`: a scrip Yahoo has gone blind on gets fetched every 30 minutes
   * (fresh `updated`) while still carrying a previous session's close. Only `priceDate` can
   * tell the two apart, so it — not the fetch stamp — decides whether a price is current.
   * Empty on sheets written before that column existed.
   */
  priceDate?: string;
}

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

// "Price Date" (column G) — written by YahooPriceUpdate.gs alongside the price. Detected on
// read and re-emitted on rewrite, so the app's own writers can't blank a column the .gs owns.
const DEFAULT_PRICE_DATE_COL = 6;
let _priceDateCol = DEFAULT_PRICE_DATE_COL;
let _priceDateColSeen = false;

/** Truthy marker in an exception cell: x / yes / y / true / 1 / a check mark. */
const isExceptCell = (v: any): boolean => /^(x|yes|y|true|1|✓|✔)$/i.test((v ?? "").toString().trim());

/**
 * Normalise a "Price Date" cell to ISO `yyyy-mm-dd`, or `""` when it can't be read.
 *
 * This column is written with `USER_ENTERED`, so Sheets is free to reinterpret `2026-08-10` as a
 * real date cell and hand it back in a locale format — `Mon Aug 10 2026 …`, `Aug 10, 2026`,
 * `10-08-2026`, or a serial. Consumers compare these values to find the newest session, and a raw
 * string comparison makes a letter-initial rendering sort ABOVE every ISO date ('M' > '2'): one
 * such cell then becomes the "current session", every real date compares as older, and the whole
 * app reads as stale (which also blocks the settled-close indicator, since that needs an exact
 * match). Normalising here keeps a single odd cell inert instead of contagious.
 *
 * Ambiguous d-m vs m-d is resolved as INDIAN (dd-mm-yyyy), matching formatDMY [[date-display-format]].
 */
const SHEET_EPOCH_MS = Date.UTC(1899, 11, 30);
const iso = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export function normalisePriceDate(v: any): string {
  if (v == null || v === "") return "";
  // Sheet serial (UNFORMATTED_VALUE) — days since 1899-12-30.
  if (typeof v === "number" && isFinite(v) && v > 0) {
    const dt = new Date(SHEET_EPOCH_MS + Math.round(v * 86400000));
    return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const s = v.toString().trim();
  if (!s) return "";
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);                      // already ISO
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);                  // dd-mm-yyyy (or mm-dd)
  if (m) {
    let d = +m[1], mo = +m[2];
    if (d <= 12 && mo > 12) { const t = d; d = mo; mo = t; }           // clearly US → swap
    return iso(+m[3], mo, d);
  }
  // "Mon Aug 10 2026 00:00:00 GMT+0530", "Aug 10, 2026", "10 Aug 2026" — let Date parse it, but
  // only trust a result that yields a sane year, so junk text can't become a date.
  const t = Date.parse(s);
  if (!isNaN(t)) {
    const dt = new Date(t);
    const y = dt.getFullYear();
    if (y >= 1990 && y <= 2200) return iso(y, dt.getMonth() + 1, dt.getDate());
  }
  return "";
}

/** A scrip the Yahoo updater could not fetch a price for (no symbol, or Yahoo had none). */
export interface PriceMiss { isin: string; name: string; reason: string; checked: string; }

let _priceCache: { id: string; rows: ScripPrice[]; ts: number } | null = null;
// Short cooldown after a failed read. Caching the FAILURE as an empty price list was the
// bug (the whole book got valued at cost); but that bad cache was also the only thing
// throttling retries. Without a cooldown, every consumer - the Dashboard alone fires five
// computes - re-attempts twice with a sleep each time, which turns one failing read into a
// burst and invites the rate limiting that caused it. This throttles without lying.
let _failUntil = 0;
const FAIL_COOLDOWN_MS = 10_000;
const PRICE_TTL_MS = 60_000;

export function invalidatePriceCache(): void {
  _priceCache = null;
  _failUntil = 0;   // an explicit refresh should retry immediately, not sit out the cooldown
  // Prices changing changes every market-value figure the Dashboard shows, so its
  // cached view has to go with them.
  invalidateDashboard();
}

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

/** Today in IST as "yyyy-MM-dd" — the session format the .gs writes to "Price Date". */
const isoToday = (): string => {
  const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function parsePriceVals(vals: any[][]): ScripPrice[] {
  const rows: ScripPrice[] = [];
  const header = vals[0] || [];
  const start = vals.length > 0 && /isin|name|price|updated/i.test(header.join(",")) ? 1 : 0;
  // Locate the "Price Exception" column from the header; fall back to its current home (H).
  if (start === 1) {
    const idx = header.findIndex((h: any) => /exception|exclud/i.test((h ?? "").toString()));
    _exceptColSeen = idx >= 0;
    _exceptCol = idx >= 0 ? idx : DEFAULT_EXCEPT_COL;
    // "Price Date" (G). Matched on the header rather than a fixed index so the column can move.
    const pd = header.findIndex((h: any) => /price date|session/i.test((h ?? "").toString()));
    _priceDateColSeen = pd >= 0;
    _priceDateCol = pd >= 0 ? pd : DEFAULT_PRICE_DATE_COL;
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
    // Normalised, NOT raw: downstream code orders these to find the current session, so a
    // locale-formatted cell must not leak through. See normalisePriceDate.
    const priceDate = normalisePriceDate(r[_priceDateCol]);
    // An excepted scrip is kept even without a parseable price — the flag is the point.
    if ((!isin && !name) || (isNaN(price) && !except)) continue;
    const src: PriceSource = source === "yahoo" || source === "screener" || source === "tradingview" ? source : "";
    rows.push({ isin, name, price: isNaN(price) ? 0 : price, updated, previousPrice: isNaN(previousPrice) ? 0 : previousPrice, source: src, except, priceDate });
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
  // Inside the post-failure cooldown, don't hit the network again: serve stale rows if we
  // have them, otherwise fail fast so the caller can report it.
  if (!opts?.force && Date.now() < _failUntil) {
    if (_priceCache && _priceCache.id === spreadsheetId) return _priceCache.rows;
    throw new Error('Prices unavailable — the last read failed; retrying shortly.');
  }

  // One retry on a transient failure (token refresh window, a 5xx, a rate limit). This is
  // a single request against one spreadsheet, so retrying is cheap - and the cost of not
  // retrying is the whole book being valued at cost.
  let lastErr: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rows = await fetchPriceRows(spreadsheetId);
      _priceCache = { id: spreadsheetId, rows, ts: now };
      _failUntil = 0;
      return rows;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
    }
  }

  // NEVER cache a failure, and never report one as an empty price list.
  //
  // This used to be `catch { rows = []; }` followed by an unconditional cache write, so a
  // single failed read poisoned the cache for the full 60s TTL and every consumer saw
  // "there are no prices" rather than "the price read failed". Since each consumer falls
  // back to average cost per position, the Dashboard then presented the book's COST as its
  // AUM - roughly 200 crore of invested capital shown as market value, with no warning and
  // no way to tell it apart from a real number. A quick refresh could not clear it either,
  // because the poisoned cache answered the retry.
  //
  // Stale prices beat invented ones, so serve the last good read if we have one.
  _failUntil = Date.now() + FAIL_COOLDOWN_MS;
  if (_priceCache && _priceCache.id === spreadsheetId) return _priceCache.rows;
  throw lastErr;
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
    // A manual screener import is a scrape taken now, so its session is today. (If the user
    // pastes a days-old export it will claim today — same assumption `updated` already makes.)
    map.set(isin, { isin, name: s.name || prev?.name || "", price: s.price, updated: stamp, previousPrice, source: "screener", except: prev?.except, priceDate: isoToday() });
    updated++;
  }

  // Preserve a "Price Exception" column ONLY if the sheet already has one (never invent it):
  // pad each row out to its index so this full-tab rewrite doesn't clear or shift the marks.
  const head: any[] = ["ISIN", "Name", "Current Price", "Updated", "Previous Price", "Source"];
  // "Price Date" belongs to YahooPriceUpdate.gs; re-emit it (same preserve-never-invent rule as
  // the exception column) so this full-tab rewrite can't blank the .gs's staleness signal.
  if (_priceDateColSeen) { while (head.length <= _priceDateCol) head.push(""); head[_priceDateCol] = "Price Date"; }
  if (_exceptColSeen) { while (head.length <= _exceptCol) head.push(""); head[_exceptCol] = "Price Exception"; }
  const rows: any[][] = [head];
  for (const p of [...map.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const row: any[] = [p.isin, p.name, p.price, p.updated, p.previousPrice || "", p.source || ""];
    if (_priceDateColSeen) { while (row.length <= _priceDateCol) row.push(""); row[_priceDateCol] = p.priceDate || ""; }
    if (_exceptColSeen) { while (row.length <= _exceptCol) row.push(""); row[_exceptCol] = p.except ? "x" : ""; }
    rows.push(row);
  }

  await ensureSheetTabs(spreadsheetId, [PRICES_TAB]);
  await (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${PRICES_TAB}!A:Z` });
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId, range: `${PRICES_TAB}!A1`, valueInputOption: "USER_ENTERED", resource: { values: rows },
  });
  // Force the "Price Date" column back to plain text. Under USER_ENTERED, Sheets is free to parse
  // an ISO date into a real date cell, after which it reads back in whatever locale format the
  // cell carries — which is how one row came back as "Mon Aug 10 2026 …" and, before
  // normalisePriceDate existed, made every scrip in the app look stale. Text format keeps what we
  // wrote. Best-effort: a failure here costs formatting, not data, and the reader normalises anyway.
  if (_priceDateColSeen) {
    try {
      const meta = await (gapi.client as any).sheets.spreadsheets.get({ spreadsheetId });
      const sheet = (meta?.result?.sheets || []).find(
        (s: any) => (s.properties?.title || "").trim().toLowerCase() === PRICES_TAB.toLowerCase());
      const sheetId = sheet?.properties?.sheetId;
      if (sheetId != null) {
        await (gapi.client as any).sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          resource: {
            requests: [{
              repeatCell: {
                range: { sheetId, startRowIndex: 1, startColumnIndex: _priceDateCol, endColumnIndex: _priceDateCol + 1 },
                cell: { userEnteredFormat: { numberFormat: { type: "TEXT" } } },
                fields: "userEnteredFormat.numberFormat",
              },
            }],
          },
        });
      }
    } catch (e) {
      console.warn("Could not pin the Price Date column to text format (harmless):", e);
    }
  }
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
    const e = master ? lookupScrip(master, isin, name).entry : null;
    if (e) { const v = m.get('key:' + e.key); if (v !== undefined) return v; }
    if (isin) { const v = m.get('isin:' + isin.toUpperCase()); if (v !== undefined) return v; }
    const byName = m.get('name:' + normName(name));
    if (byName !== undefined) return byName;
    // No fetched price — but an UNLISTED company can carry a hand-entered per-share fair
    // value in the "Private Equities" tab. Checked LAST so a real market price always wins
    // (a company that has since listed legitimately has both), and only when it's > 0, so a
    // blank valuation still means "hold this at cost" rather than "worth nothing".
    if (e && e.isPe && (e.peValuation ?? 0) > 0) return e.peValuation;
    return undefined;
  };
}
