/**
 * Recovering when a lazily-imported chunk has been deployed out from under an open tab.
 *
 * Vite names every chunk with a content hash, and Vercel's production alias serves only the
 * CURRENT deployment's files. The moment a new build goes live, every hashed chunk from the
 * previous build 404s. A tab that was already open keeps running perfectly — its code is in
 * memory — right up until it reaches an `await import(...)` for a file that no longer exists.
 * That is exactly what "Failed to fetch dynamically imported module .../factsheet-JwZhU-DQ.js"
 * was: the deployed build was fine, the open tab was one deploy behind.
 *
 * Two things follow. Retrying cannot help — the file is genuinely gone, so the only recovery is
 * a reload, which fetches the new index.html and with it the new chunk names. And the caller's
 * usual "Could not build the factsheet" toast is actively misleading here: it reads as bad
 * DATA, and sends you hunting through holdings for a fault that does not exist.
 *
 * Called from the export handlers' existing `catch` rather than wrapped around each `import()`.
 * That way it also covers the nested vendor imports (pdfmake, ExcelJS) inside the report and
 * factsheet renderers, which are separately hashed chunks and fail the same way.
 *
 * Deliberately NOT a global `vite:preloadError` listener: that fires app-wide and could reload
 * out from under a half-filled Add Trade modal. On these paths nothing is unsaved, so a reload
 * costs the user nothing.
 */
import { toast } from './overlay';

/** Chrome, Firefox and Safari each word this failure differently; all three mean the same thing. */
const STALE_CHUNK =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

const RELOAD_FLAG = 'staleChunk:reloaded';

/**
 * A reload loop re-fires within seconds, so the guard is a TIMESTAMP rather than a boolean: hit
 * the same error a minute later and it is a second deploy, not a loop, and deserves its own
 * reload. A plain flag would strand a long-lived tab on the manual-reload message forever.
 *
 * sessionStorage throws outright in some privacy configurations, and a recovery aid must never
 * be the thing that breaks the download it is trying to rescue.
 */
const LOOP_WINDOW_MS = 60_000;
const justReloaded = () => {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_FLAG));
    return at > 0 && Date.now() - at < LOOP_WINDOW_MS;
  } catch { return false; }
};

export const isStaleChunkError = (e: unknown): boolean =>
  STALE_CHUNK.test(String((e as any)?.message ?? e ?? ''));

/**
 * If `e` is a missing-chunk failure, tell the user why and reload — returning true so the caller
 * skips its own error toast. Returns false for every other error, leaving the caller's handling
 * untouched.
 */
export function handleStaleChunk(e: unknown): boolean {
  if (!isStaleChunkError(e)) return false;

  // If we reloaded moments ago and landed right back here, the fault is real. It must surface as
  // an error rather than put the tab in a refresh loop.
  if (justReloaded()) {
    toast.error('A new version was deployed but this page could not load it. Please reload (Ctrl+Shift+R).');
    return true;
  }
  try { sessionStorage.setItem(RELOAD_FLAG, String(Date.now())); } catch { /* guard is best-effort */ }

  toast.info('A new version was deployed — reloading…');
  setTimeout(() => window.location.reload(), 1200);
  return true;
}
