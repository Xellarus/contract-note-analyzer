/**
 * Holds the Dashboard's computed result across tab switches.
 *
 * App renders `currentView === 'dashboard' ? <Dashboard/> : ...`, so switching tabs
 * UNMOUNTS the Dashboard and its mount effect re-runs the entire sweep on return:
 * AUM, the invested timeline, cross-holdings, pending corp actions and the NAV
 * timeline, each walking all eleven portfolios. That is dozens of Sheets reads for
 * data that has not changed, and it is why coming back to the tab always stalled.
 *
 * Deliberately a module-level cache with an explicit dirty flag rather than a TTL
 * alone, mirroring `_priceCache` / `invalidatePriceCache` in `scripPrices.ts`. A
 * write to Sheets calls `invalidateDashboard()`; anything else is served from memory.
 * The TTL is only a backstop for prices moving during the day.
 *
 * Opaque payload on purpose: the Dashboard owns the shape, so adding a panel there
 * needs no change here.
 */
const DASHBOARD_TTL_MS = 10 * 60_000;

let _snapshot: { data: unknown; ts: number } | null = null;
let _dirty = false;

/** The cached result, or null when absent, invalidated, or past the backstop TTL. */
export function readDashboardSnapshot<T>(maxAgeMs: number = DASHBOARD_TTL_MS): T | null {
  if (!_snapshot || _dirty) return null;
  if (Date.now() - _snapshot.ts > maxAgeMs) return null;
  return _snapshot.data as T;
}

export function writeDashboardSnapshot(data: unknown): void {
  _snapshot = { data, ts: Date.now() };
  _dirty = false;
}

/** When the snapshot was taken, for an "as of" label. Null if there isn't one. */
export function dashboardSnapshotAge(): number | null {
  return _snapshot && !_dirty ? _snapshot.ts : null;
}

/**
 * Mark the Dashboard stale. Call after ANY write that changes what it shows — an
 * import, a trade edit, a holdings rebuild, a capital-gains sync, a price refresh.
 * Cheap and idempotent: the recompute happens next time the tab is opened, not now.
 */
export function invalidateDashboard(): void {
  _dirty = true;
}
