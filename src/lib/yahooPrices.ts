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
