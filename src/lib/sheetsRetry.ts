import { gapi } from "gapi-script";

/**
 * Auto-retry-with-backoff for the Google Sheets API.
 *
 * Sheets enforces a per-user-per-minute read quota (default 60/min). When the app
 * fires several reads in a burst (opening a portfolio, a rebuild, the opening-basis
 * batch flow) it can trip a 429 "Quota exceeded for … Read requests per minute per
 * user". That's transient — the counter resets each minute — so instead of surfacing
 * an error we wait and retry.
 *
 * `installSheetsRetry()` wraps every `gapi.client.sheets.spreadsheets(.values).*`
 * method ONCE (after the discovery doc has loaded), so all existing call sites inherit
 * the behaviour without any change. Retries on quota (429 / RESOURCE_EXHAUSTED) and on
 * transient server errors (500 / 503); anything else (permissions, bad range, auth)
 * throws immediately as before.
 */

let installed = false;

// A gapi error surfaces the HTTP code in a few shapes depending on the failure path.
function isRetryable(e: any): boolean {
  const code = e?.status ?? e?.result?.error?.code ?? e?.code;
  const gStatus = (e?.result?.error?.status || "").toString().toUpperCase();
  const msg = (e?.result?.error?.message || e?.message || "").toString();
  if (code === 429 || code === 500 || code === 503) return true;
  if (gStatus === "RESOURCE_EXHAUSTED" || gStatus === "UNAVAILABLE") return true;
  return /quota exceeded|rate limit|try again later|backend error|temporarily unavailable/i.test(msg);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const MAX_RETRIES = 5;   // ~1.5s,3s,6s,12s,24s (+jitter) → up to ~45s, past a 1-min quota window

function wrap(obj: any, method: string): void {
  const original = obj?.[method];
  if (typeof original !== "function" || (original as any).__retryWrapped) return;
  const wrapped = async function (...args: any[]) {
    let attempt = 0;
    for (;;) {
      try {
        return await original.apply(obj, args);
      } catch (e) {
        if (attempt >= MAX_RETRIES || !isRetryable(e)) throw e;
        const delay = Math.min(24000, 1500 * Math.pow(2, attempt)) + Math.random() * 400;
        if (isRetryable(e)) console.warn(`[sheets] ${method} rate-limited/transient — retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms`);
        await sleep(delay);
        attempt++;
      }
    }
  };
  (wrapped as any).__retryWrapped = true;
  obj[method] = wrapped;
}

/** Install the retry wrappers. Safe to call more than once (idempotent); no-ops until
 *  the Sheets discovery doc has loaded (call it from gapi.client.init().then). */
export function installSheetsRetry(): void {
  if (installed) return;
  const spreadsheets = (gapi as any)?.client?.sheets?.spreadsheets;
  if (!spreadsheets) return;   // discovery not loaded yet
  const values = spreadsheets.values;
  if (values) ["get", "batchGet", "update", "append", "clear", "batchClear", "batchUpdate"].forEach(m => wrap(values, m));
  ["get", "batchUpdate", "create"].forEach(m => wrap(spreadsheets, m));
  installed = true;
}
