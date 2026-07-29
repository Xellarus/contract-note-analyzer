/**
 * Central browser/mouse BACK-button handler for the app, which has NO router.
 *
 * Each drilled-in view registers a "back step" with a DEPTH. A SINGLE popstate listener runs
 * the DEEPEST currently-active step (stock detail > holdings list > top-level view), so Back
 * walks the app's own hierarchy toward the home (Dashboard) view instead of unloading the SPA.
 *
 * We keep exactly ONE trap history entry armed and re-arm it on every Back (pushState clears the
 * forward stack and does NOT itself fire popstate, so there is no loop and history never grows).
 * A Back at the home view runs no step and simply re-arms — a harmless no-op — so Back never
 * jumps the user out of the app unexpectedly (the reported bug: "mouse previous goes to a new tab").
 *
 * Predicates must read CURRENT state (pass a ref-backed getter), not a value captured at
 * registration time. See [[spa-navigation-back-button]].
 */
type BackStep = { depth: number; active: () => boolean; step: () => void };

const steps: BackStep[] = [];
let armed = false;

function runDeepestStep(): void {
  let best: BackStep | null = null;
  for (const s of steps) {
    try { if (s.active() && (!best || s.depth > best.depth)) best = s; } catch { /* ignore a bad predicate */ }
  }
  if (best) { try { best.step(); } catch { /* ignore */ } }
}

function ensureArmed(): void {
  if (armed || typeof window === "undefined") return;
  armed = true;
  window.history.pushState({ appBack: true }, "");
  window.addEventListener("popstate", () => {
    runDeepestStep();                                 // step back one level (no-op at the home view)
    window.history.pushState({ appBack: true }, "");  // always re-arm → Back never unloads the app
  });
}

/**
 * Register a back step. `active` returns whether this level is currently open; `step` reverts it
 * (e.g. `setSelectedStock(null)`). Higher `depth` = deeper level (runs first). Returns an
 * unregister fn to call on unmount.
 */
export function registerBackStep(depth: number, active: () => boolean, step: () => void): () => void {
  ensureArmed();
  const entry: BackStep = { depth, active, step };
  steps.push(entry);
  return () => { const i = steps.indexOf(entry); if (i >= 0) steps.splice(i, 1); };
}
