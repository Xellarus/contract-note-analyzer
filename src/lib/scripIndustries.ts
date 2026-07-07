import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import { lookupScrip, normName, ScripMaster } from "./scripMaster";

/**
 * Per-security Industry / Sector classification, sourced from a screener.in
 * import. Like prices, it's per-security (not per-portfolio), so it lives in its
 * own "Industries" tab inside the shared scrip-master spreadsheet — one import
 * classifies securities for every portfolio. Each row is
 * ISIN | Name | Industry | Updated (IST). Upserted by ISIN on each import
 * (existing securities are re-classified, new ones added) — mirrors scripPrices.
 */
const INDUSTRIES_TAB = "Industries";

export interface ScripIndustry { isin: string; name: string; industry: string; updated: string; }

let _cache: { id: string; rows: ScripIndustry[]; ts: number } | null = null;
const TTL_MS = 60_000;

export function invalidateIndustryCache(): void { _cache = null; }

const istStamp = (): string =>
  new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });

function parseRows(vals: any[][]): ScripIndustry[] {
  const rows: ScripIndustry[] = [];
  const start = vals.length > 0 && /isin|name|industry|sector|updated/i.test((vals[0] || []).join(",")) ? 1 : 0;
  for (let i = start; i < vals.length; i++) {
    const r = vals[i]; if (!r) continue;
    const isin = (r[0] || "").toString().trim().toUpperCase();
    const name = (r[1] || "").toString().trim();
    const industry = (r[2] || "").toString().trim();
    const updated = (r[3] || "").toString().trim();
    if ((!isin && !name) || !industry) continue;
    rows.push({ isin, name, industry, updated });
  }
  return rows;
}

async function fetchRows(spreadsheetId: string): Promise<ScripIndustry[]> {
  let res: any;
  try {
    res = await (gapi.client as any).sheets.spreadsheets.values.get({ spreadsheetId, range: `${INDUSTRIES_TAB}!A1:D50000` });
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || "";
    if (/unable to parse range/i.test(msg)) return [];   // tab not created yet
    throw e;
  }
  return parseRows(res?.result?.values || []);
}

/** Read the Industries tab (empty list if it doesn't exist yet). Cached briefly;
 *  any read failure yields an empty list (callers fall back to "Unclassified"). */
export async function loadScripIndustries(spreadsheetId: string, opts?: { force?: boolean }): Promise<ScripIndustry[]> {
  const now = Date.now();
  if (!opts?.force && _cache && _cache.id === spreadsheetId && now - _cache.ts < TTL_MS) return _cache.rows;
  let rows: ScripIndustry[] = [];
  try { rows = await fetchRows(spreadsheetId); } catch { rows = []; }
  _cache = { id: spreadsheetId, rows, ts: now };
  return rows;
}

/**
 * Merge incoming industry classifications into the Industries tab (latest import
 * wins per ISIN; securities not in this import are preserved). Rewrites the whole
 * tab with a header + an IST "Updated" stamp on rows we touched.
 */
export async function saveScripIndustries(
  spreadsheetId: string,
  incoming: { isin: string; name: string; industry: string }[],
): Promise<{ updated: number; total: number }> {
  const existing = await fetchRows(spreadsheetId);  // strict: a real read error aborts (no clobber)
  const map = new Map<string, ScripIndustry>();
  for (const p of existing) if (p.isin) map.set(p.isin, p);

  const stamp = istStamp();
  let updated = 0;
  for (const s of incoming) {
    const isin = (s.isin || "").trim().toUpperCase();
    const industry = (s.industry || "").trim();
    if (!isin || !industry) continue;
    map.set(isin, { isin, name: s.name || map.get(isin)?.name || "", industry, updated: stamp });
    updated++;
  }

  const rows: any[][] = [["ISIN", "Name", "Industry", "Updated"]];
  for (const p of [...map.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    rows.push([p.isin, p.name, p.industry, p.updated]);
  }

  await ensureSheetTabs(spreadsheetId, [INDUSTRIES_TAB]);
  await (gapi.client as any).sheets.spreadsheets.values.clear({ spreadsheetId, range: `${INDUSTRIES_TAB}!A:Z` });
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId, range: `${INDUSTRIES_TAB}!A1`, valueInputOption: "USER_ENTERED", resource: { values: rows },
  });
  invalidateIndustryCache();
  return { updated, total: map.size };
}

/**
 * Build a (isin, name) → industry resolver from the Industries snapshot. Matches
 * via the scrip-master canonical key first (so a holding with a blank ISIN still
 * matches by name), then raw ISIN, then normalized name. Falls back to any
 * industry hand-entered on the scrip-master entry itself. Returns undefined when
 * the security has no known industry.
 */
export function makeIndustryResolver(master: ScripMaster | null, industries: ScripIndustry[]): (isin: string, name: string) => string | undefined {
  const byKey = new Map<string, string>();
  const byIsin = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const p of industries) {
    if (!p.industry) continue;
    if (p.isin) byIsin.set(p.isin.toUpperCase(), p.industry);
    if (p.name) byName.set(normName(p.name), p.industry);
    if (master) { const e = lookupScrip(master, p.isin, p.name).entry; if (e) byKey.set(e.key, p.industry); }
  }
  return (isin: string, name: string) => {
    if (master) {
      const e = lookupScrip(master, isin, name).entry;
      if (e) {
        const v = byKey.get(e.key); if (v !== undefined) return v;
        if (e.industry && e.industry.trim()) return e.industry.trim();  // hand-entered fallback
      }
    }
    if (isin) { const v = byIsin.get(isin.toUpperCase()); if (v !== undefined) return v; }
    return byName.get(normName(name));
  };
}
