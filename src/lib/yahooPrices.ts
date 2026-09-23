/**
 * On-demand price refresh via the YahooPriceUpdate.gs web app.
 *
 * Yahoo's quote endpoints aren't CORS-enabled, so the browser can't call them directly —
 * the fetch runs server-side in Apps Script, which writes the "Prices" tab (the same tab
 * the app reads via scripPrices.ts). This module just pokes that web app and lets the
 * caller re-read the tab.
 *
 * SETUP: deploy YahooPriceUpdate.gs as a Web App (Deploy → New deployment → Web app;
 * "Execute as: Me", "Who has access: Anyone"), then paste the resulting /exec URL below.
 * While this is blank, the "Refresh Prices" button falls back to simply re-reading the
 * Prices tab (which the scheduled trigger keeps fresh on its own).
 */
export const YAHOO_PRICE_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbzbujUJK9i8zo4wT6M83gLeixFl3GTDcVRncjse3orIPqSAuOgJs1HceHkliOyHzNGN/exec";

/**
 * `missed` counts every scrip without a fresh price; `deferred` is the subset that was never
 * actually looked up (the price feed refused the request, or the run's time budget ran out) and
 * is expected to resolve itself on the next run — so it must NOT be reported as "unpriced".
 * `busy` means another run already holds the script lock and this call did nothing.
 */
export interface YahooRefreshResult {
  ok: boolean; updated?: number; total?: number; missed?: number;
  deferred?: number; truncated?: boolean; busy?: boolean; error?: string;
}

/** True when a web-app URL has been configured (so the button can offer a LIVE refresh). */
export const hasYahooWebApp = (): boolean => YAHOO_PRICE_WEBAPP_URL.trim().length > 0;

/**
 * Trigger a server-side Yahoo pull and return its summary. GET with no custom headers is a
 * "simple" CORS request (no preflight) — which an Apps Script /exec Web App answers with
 * `Access-Control-Allow-Origin: *`. Throws if the URL is unset or the call fails, so the
 * caller can fall back to re-reading the last-saved prices.
 */
export async function refreshYahooPrices(): Promise<YahooRefreshResult> {
  if (!hasYahooWebApp()) throw new Error("Yahoo price web-app URL not configured");
  const res = await fetch(YAHOO_PRICE_WEBAPP_URL, { method: "GET", redirect: "follow" });
  if (!res.ok) throw new Error(`Price service returned HTTP ${res.status}`);
  const json = await res.json().catch(() => null) as YahooRefreshResult | null;
  if (!json || !json.ok) throw new Error((json && json.error) || "Price update failed");
  return json;
}

/**
 * Result of a gap-filling price-history backfill (`?hist=missing`).
 *
 * `noSymbolNames` is the part that matters and the part nothing else can produce: scrips whose
 * scrip-master row carries no NSE or BSE code. The history writer skips them outright
 * (`if (!syms.primary) continue`), so they never get a column and NO number of re-runs will ever
 * give them one — either the company has not listed, or the master row is missing its code.
 * `remaining` is what the per-run cap held back; call again to continue.
 */
export interface HistoryGapResult {
  ok: boolean;
  mode?: string;
  /** Deploy marker — proves a paste into the Apps Script editor actually took effect. */
  version?: string;
  universe?: number;
  /** Scrips with a ticker but NO column on the tab at all. */
  absent?: number;
  absentNames?: string[];
  /** Columns that exist but begin later than the grid does (only fetched with `deep`). */
  late?: number;
  lateNames?: string[];
  noSymbol?: number;
  noSymbolNames?: string[];
  gridFirst?: string;
  targets?: number;
  filled?: number;
  remaining?: number;
  /** Had a symbol, and the feed still returned nothing. */
  stillMissing?: string[];
  dates?: number;
  cols?: number;
  busy?: boolean;
  error?: string;
}

/**
 * Fetch the full range for the scrips that have NO price history yet, and MERGE it into the tab.
 *
 * Deliberately not `?hist=full`: that one REBUILDS the tab, discarding anything older than the
 * two-year fetch window, and refetches the whole universe — which does not finish inside Apps
 * Script's 6-minute limit. This is bounded and re-runnable.
 *
 * Runs server-side and can take minutes, so the caller must show it as pending rather than
 * assuming a quick reply.
 */
export async function backfillMissingPriceHistory(deep = false): Promise<HistoryGapResult> {
  if (!hasYahooWebApp()) throw new Error("Yahoo price web-app URL not configured");
  const url = `${YAHOO_PRICE_WEBAPP_URL}?hist=missing${deep ? "&deep=1" : ""}`;
  const res = await fetch(url, { method: "GET", redirect: "follow" });
  if (!res.ok) throw new Error(`Price service returned HTTP ${res.status}`);
  const json = await res.json().catch(() => null) as HistoryGapResult | null;
  if (!json || !json.ok) throw new Error((json && json.error) || "Price-history backfill failed");
  return json;
}
