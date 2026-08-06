import { gapi } from "gapi-script";

// The single shared scrip master lives in ONE Google Sheet that the user owns
// and curates directly (NSE/BSE ISIN ↔ name, plus any additions). The app reads
// it live (cached per session); there is NO bundled list. To add a security the
// user appends a row in the sheet — the app re-fetches and resolves it.
// Repoint here to use a different sheet.
export const SCRIP_MASTER_SPREADSHEET_ID = "1gLDfmeQe0wzfHWfaBReVk-6KsAvy1ZamfQAMrIVWsHg";

// "GOODLUCK INDIA LIMITED" / "Goodluck India Ltd." → "goodluck india".
export const normName = (s: string): string =>
  (s || "")
    .toLowerCase()
    .replace(/[-.,()'"]/g, " ")
    .replace(/\b(limited|ltd|private|pvt|the|co)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Distinctive tokens for subset matching — drops 1-char noise and pure numbers.
export const tokenSet = (s: string): Set<string> =>
  new Set(normName(s).split(" ").filter(t => t.length > 1 && !/^\d+$/.test(t)));

const isSubset = (a: Set<string>, b: Set<string>): boolean => {
  if (a.size === 0) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
};

// Truncation-aware match: broker notes cut names mid-word at a fixed width
// ("KISAN MOULDINGS" → "KISAN MOULDIN"), which defeats both exact and
// whole-token matching. Treat one normalized name being a PREFIX of the other
// as a candidate hit (both directions: the note may be cut before OR after a
// token boundary). Guarded by a minimum length so short junk can't link, and
// used only inside the candidate pass — a multi-hit still surfaces as
// ambiguous for the review popup rather than auto-linking.
const PREFIX_MIN = 6;
const prefixHit = (aliasNorms: Set<string>, nk: string): boolean => {
  if (nk.length < PREFIX_MIN) return false;
  for (const a of aliasNorms) {
    if (a.length < PREFIX_MIN) continue;
    if (a.startsWith(nk) || nk.startsWith(a)) return true;
  }
  return false;
};

export interface ScripEntry {
  key: string;              // canonical grouping key: isin || normName(canonicalName)
  canonicalName: string;
  isin: string;
  aliasNorms: Set<string>;  // normName() of canonical name + every alias
  tokenSets: Array<Set<string>>;
  rawAliases: string[];     // original alias strings, preserved for the sheet
  status: "auto" | "confirmed";
  pendingPersist: boolean;  // a user action created/changed this entry → append it on save
  nse?: string;             // NSE symbol (from the NSE column), for display
  bse?: string;             // BSE scrip code (from the BSE column), for display
  industry?: string;        // Industry / Sector (from a screener import), for the allocation chart
  priceExcept?: boolean;    // "Price Exception" column truthy → never fetched/priced; hidden from the "unpriced" UI (ETFs/liquid funds)
}

export interface ScripMaster {
  byIsin: Map<string, ScripEntry>;
  byAliasNorm: Map<string, ScripEntry>;
  entries: ScripEntry[];
  dirty: boolean;
  // Tokens that appear in many entries ("corporation", "securities", "industries", …). A
  // SINGLE such token is too weak to carry a fuzzy (token-subset) match on its own — e.g.
  // "S & T Corporation" collapses to {corporation} and would otherwise grab any name
  // containing "corporation". Computed at load; see resolveScrip step 3.
  genericTokens: Set<string>;
}

export type ResolveResult =
  | { status: "resolved"; key: string; entry: ScripEntry }
  | { status: "ambiguous"; candidates: ScripEntry[] }
  | { status: "unresolved" };

const emptyMaster = (): ScripMaster => ({
  byIsin: new Map(),
  byAliasNorm: new Map(),
  entries: [],
  dirty: false,
  genericTokens: new Set(),
});

// A token appearing in at least this many DISTINCT entries is "generic" (a common company
// word, not a distinctive name). Only used to veto a SINGLE-token fuzzy match.
const GENERIC_MIN_ENTRIES = 6;

/** Recompute which tokens are generic (shared across many entries). Call after entries change. */
export function computeGenericTokens(master: ScripMaster): void {
  const freq = new Map<string, number>();
  for (const e of master.entries) {
    const seen = new Set<string>();
    for (const ts of e.tokenSets) for (const t of ts) seen.add(t);
    for (const t of seen) freq.set(t, (freq.get(t) || 0) + 1);
  }
  master.genericTokens = new Set([...freq].filter(([, c]) => c >= GENERIC_MIN_ENTRIES).map(([t]) => t));
}

/** A token-subset hit that isn't carried solely by one generic word. `sub ⊆ sup`, but a
 *  size-1 subset whose only token is generic ("corporation"/"securities"/…) doesn't count —
 *  that's the over-match that sent "Deepak Fertilizers … Corporation" to "S & T Corporation". */
const distinctiveSubset = (sub: Set<string>, sup: Set<string>, generic: Set<string>): boolean => {
  if (!isSubset(sub, sup)) return false;
  if (sub.size === 1 && generic.has([...sub][0])) return false;
  return true;
};

/** Claim an alias-norm slot for an entry. A name another entry carries as its
 *  CANONICAL name can't be displaced by a mere alias — e.g. the "-RE" rights
 *  rows list the parent company's full name in their Alias column, and loading
 *  after the parent they used to steal its exact-name slot (last-writer-wins),
 *  sending name-only lookups to the RE instrument instead of the equity. */
function claimAlias(master: ScripMaster, a: string, e: ScripEntry) {
  const cur = master.byAliasNorm.get(a);
  if (cur && cur !== e && normName(cur.canonicalName) === a && normName(e.canonicalName) !== a) return;
  master.byAliasNorm.set(a, e);
}

function indexEntry(master: ScripMaster, e: ScripEntry) {
  master.entries.push(e);
  if (e.isin) master.byIsin.set(e.isin, e);
  for (const a of e.aliasNorms) claimAlias(master, a, e);
}

function makeEntry(canonicalName: string, isin: string, aliases: string[], status: "auto" | "confirmed", pendingPersist = false): ScripEntry {
  const rawAliases = Array.from(new Set([canonicalName, ...aliases].map(a => (a || "").trim()).filter(Boolean)));
  const aliasNorms = new Set(rawAliases.map(normName).filter(Boolean));
  return {
    key: isin || normName(canonicalName),
    canonicalName,
    isin,
    aliasNorms,
    tokenSets: rawAliases.map(tokenSet),
    rawAliases,
    status,
    pendingPersist,
  };
}

// ── Live fetch from the shared scrip sheet, cached per session ──────────────
let _cache: { id: string; master: ScripMaster; ts: number } | null = null;
const _titleCache: Record<string, string> = {};
const CACHE_TTL_MS = 90_000;

/** Drop the cached scrip list so the next load re-fetches the sheet (used after
 *  the user adds a row in the sheet and wants to re-resolve). */
export function invalidateScripCache(): void {
  _cache = null;
}

/** The title of the sheet's first tab (gid=0), so we read the right range
 *  regardless of how the tab was named when the CSV was imported. */
async function firstSheetTitle(spreadsheetId: string): Promise<string> {
  if (_titleCache[spreadsheetId]) return _titleCache[spreadsheetId];
  const meta: any = await sheetsBackoff(() => (gapi.client as any).sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(title,sheetId)",
  }));
  const arr: any[] = meta?.result?.sheets || [];
  const s0 = arr.find((s: any) => s?.properties?.sheetId === 0) || arr[0];
  const title = s0?.properties?.title || "Sheet1";
  _titleCache[spreadsheetId] = title;
  return title;
}

// A1-notation-safe sheet reference: always single-quoted (handles spaces).
const quoteTab = (title: string): string => `'${title.replace(/'/g, "''")}'`;

// Sheets reads transiently 429/5xx during heavy batches (rebuild + CG + ledger back to
// back). The scrip master is load-CRITICAL: a swallowed failure used to return — and cache
// for 90s — an EMPTY master, so every security (even ones present in the sheet) showed
// "no match found", and a "create new" on that list would append duplicate rows. So retry
// the read, and let a genuine failure propagate rather than silently emptying the master.
async function sheetsBackoff<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e: any) {
      last = e;
      const code = Number(e?.result?.error?.code ?? e?.status ?? 0);
      if (code !== 429 && code !== 500 && code !== 503) throw e;
      await new Promise(r => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw last;
}

/**
 * Read the shared scrip master from its Google Sheet. Columns are detected from
 * the header (ISIN / Security Name / Aliases) in any order; falls back to A/B/C.
 * Rows are merged by ISIN (or normalized name) so duplicate/append rows fold in.
 * Cached for a short TTL; pass { force: true } to bypass the cache.
 */
export async function loadScripMaster(spreadsheetId: string, opts?: { force?: boolean }): Promise<ScripMaster> {
  const now = Date.now();
  if (!opts?.force && _cache && _cache.id === spreadsheetId && now - _cache.ts < CACHE_TTL_MS) {
    return _cache.master;
  }

  const master = emptyMaster();
  let rows: any[][];
  try {
    const tab = await firstSheetTitle(spreadsheetId);
    const res: any = await sheetsBackoff(() => (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteTab(tab)}!A1:Z50000`,  // wide enough for BSE Code / Tally Name / Industry / Price Exception extras
    }));
    rows = res?.result?.values || [];
  } catch (e: any) {
    // DON'T cache or return an empty master on a read failure — that would make every
    // security show "no match found" for 90s. Surface it so the caller fails loudly and
    // the user can retry once the rate limit clears (the master is untouched).
    const msg = e?.result?.error?.message || e?.message || "read failed";
    throw new Error(`Couldn't load the shared Scrip Master sheet (${msg}). If this is a Google Sheets rate limit, wait ~30s and retry — nothing was changed.`);
  }

  {
    if (rows.length > 0) {
      const header = (rows[0] || []).map((h: any) => (h || "").toString().toLowerCase());
      const hasHeader = header.some((h: string) => /isin|name|security|company|alias|scrip|bse|nse|code/.test(h));
      // Columns: ISIN | Security Name | BSE | NSE | Alias name. The BSE cell may
      // hold the ticker and the numeric scrip code together ("TICKER | CODE").
      // A legacy separate "BSE Code" column is still tolerated (bsecode, -1 = absent).
      // BSE parts, BSE Code, NSE and Alias are all indexed as match aliases.
      // Detection order matters — "Alias name"/"Security Name" both contain "name"
      // and "BSE Code" contains "bse", so test alias/code/bse/nse before name.
      // The FIRST name-like column wins: user-added extras like "Tally Name" must
      // not steal ci.name (a hijacked, mostly-blank name column made every entry's
      // canonical name fall back to its ISIN). Any unrecognised column is ignored.
      const ci = { isin: 0, name: 1, bse: 2, nse: 3, alias: 4, bsecode: -1, industry: -1, except: -1 };
      if (hasHeader) {
        let nameSet = false;
        header.forEach((h: string, idx: number) => {
          if (/exception|exclud/.test(h)) ci.except = idx;   // "Price Exception" — must beat the name test (no name token anyway)
          else if (/isin/.test(h)) ci.isin = idx;
          else if (/alias/.test(h)) ci.alias = idx;
          else if (/industry|sector/.test(h)) ci.industry = idx;
          else if (/code/.test(h)) ci.bsecode = idx;
          else if (/bse/.test(h)) ci.bse = idx;
          else if (/nse/.test(h)) ci.nse = idx;
          else if (/tally/.test(h)) { /* user's Tally ledger-name column — not a match column */ }
          else if (!nameSet && /name|security|company|scrip/.test(h)) { ci.name = idx; nameSet = true; }
        });
      }
      const start = hasHeader ? 1 : 0;
      for (let i = start; i < rows.length; i++) {
        const r = rows[i];
        if (!r) continue;
        const isin = (r[ci.isin] || "").toString().trim().toUpperCase();
        const name = (r[ci.name] || "").toString().trim();
        // The BSE cell can carry both the ticker and the numeric code, "|"-separated.
        const bseParts = (r[ci.bse] || "").toString().split("|").map((a: string) => a.trim()).filter(Boolean);
        const bsecode = ci.bsecode >= 0 ? (r[ci.bsecode] || "").toString().trim() : "";
        const nse = (r[ci.nse] || "").toString().trim();
        if (!isin && !name && bseParts.length === 0 && !bsecode && !nse) continue;
        const aliasCol = (r[ci.alias] || "").toString().split("|").map((a: string) => a.trim()).filter(Boolean);
        // A ≤2-char exchange symbol (e.g. NSE "LT" for Larsen & Toubro) is too short to
        // fuzzy-match on: indexed as an alias it token-subset-matches ANY name containing
        // "lt" — including the ubiquitous "Limited" abbreviation ("Genus Power
        // Infrastructures Lt") — silently mis-resolving that scrip to L&T. Keep such
        // symbols for DISPLAY (entry.nse/bse are set separately below) but drop them from
        // the match-alias index. Multi-char symbols/codes and alias names are unaffected,
        // and any scrip is still matched by its full name or ISIN.
        const aliases = [...bseParts, bsecode, nse, ...aliasCol]
          .filter(Boolean)
          .filter((a: string) => a.replace(/[^a-z0-9]/gi, "").length > 2);

        // Fold append/duplicate rows into one entry, by ISIN then normalized name.
        const existing = (isin && master.byIsin.get(isin)) || (name && master.byAliasNorm.get(normName(name))) || null;
        let entry: ScripEntry;
        if (existing) {
          enrich(master, existing, isin, name);
          for (const a of aliases) enrich(master, existing, "", a);
          entry = existing;
        } else {
          entry = makeEntry(name || isin, isin, aliases, "confirmed");
          indexEntry(master, entry);
        }
        // Keep NSE symbol / BSE code for display (separate from the alias index).
        if (nse && !entry.nse) entry.nse = nse;
        if (bseParts.length > 0 && !entry.bse) entry.bse = bseParts.join(", ");
        // Industry / sector (from a screener import) — for the allocation chart.
        const industry = ci.industry >= 0 ? (r[ci.industry] || "").toString().trim() : "";
        if (industry && !entry.industry) entry.industry = industry;
        // "Price Exception" — a truthy cell (x / yes / y / true / 1 / ✓) marks a scrip we
        // never price (ETFs / liquid funds). Folded so any row marking it wins.
        if (ci.except >= 0) {
          const ex = (r[ci.except] || "").toString().trim().toLowerCase();
          if (/^(x|yes|y|true|1|✓|✔)$/.test(ex)) entry.priceExcept = true;
        }
      }
    }
  }

  computeGenericTokens(master);   // which single tokens are too common to carry a fuzzy match
  master.dirty = false;
  _cache = { id: spreadsheetId, master, ts: now };   // cache only after a SUCCESSFUL read
  return master;
}

/**
 * Resolve a (isin, name) pair to a canonical entry.
 * Precedence: exact ISIN → exact normalized name/alias → unique token-subset → unresolved.
 * On a resolve that supplies new info, the entry is enriched in place (in memory only).
 */
export function resolveScrip(master: ScripMaster, isin: string, name: string): ResolveResult {
  isin = (isin || "").trim();
  const nk = normName(name);

  // 1. Exact ISIN — definitive
  if (isin && master.byIsin.has(isin)) {
    const entry = master.byIsin.get(isin)!;
    if (nk && !entry.aliasNorms.has(nk)) enrich(master, entry, isin, name);
    return { status: "resolved", key: entry.key, entry };
  }

  // 2. Exact normalized name / alias
  if (nk && master.byAliasNorm.has(nk)) {
    const entry = master.byAliasNorm.get(nk)!;
    if (isin && !entry.isin) enrich(master, entry, isin, name);
    return { status: "resolved", key: entry.key, entry };
  }

  // 3. Unique token-subset OR truncated-prefix candidate (either direction)
  const toks = tokenSet(name);
  if (toks.size > 0) {
    const candidates: ScripEntry[] = [];
    for (const entry of master.entries) {
      const hit = entry.tokenSets.some(a => distinctiveSubset(a, toks, master.genericTokens) || distinctiveSubset(toks, a, master.genericTokens))
        || prefixHit(entry.aliasNorms, nk);
      if (hit) candidates.push(entry);
    }
    if (candidates.length === 1) {
      enrich(master, candidates[0], isin, name);
      return { status: "resolved", key: candidates[0].key, entry: candidates[0] };
    }
    if (candidates.length > 1) {
      return { status: "ambiguous", candidates };
    }
  }

  return { status: "unresolved" };
}

export interface ScripLookup {
  entry: ScripEntry | null;
  foundBy: "isin" | "name" | "none";
}

/**
 * Read-only resolve for display/confirmation — like resolveScrip but never
 * mutates the master. Precedence: exact ISIN → exact normalized name/alias →
 * unique token-subset → none.
 */
export function lookupScrip(master: ScripMaster, isin: string, name: string): ScripLookup {
  isin = (isin || "").trim();
  if (isin && master.byIsin.has(isin)) return { entry: master.byIsin.get(isin)!, foundBy: "isin" };
  const nk = normName(name);
  if (nk && master.byAliasNorm.has(nk)) return { entry: master.byAliasNorm.get(nk)!, foundBy: "name" };
  const toks = tokenSet(name);
  if (toks.size > 0) {
    const cands: ScripEntry[] = [];
    for (const e of master.entries) {
      if (e.tokenSets.some(a => distinctiveSubset(a, toks, master.genericTokens) || distinctiveSubset(toks, a, master.genericTokens)) || prefixHit(e.aliasNorms, nk)) cands.push(e);
    }
    if (cands.length === 1) return { entry: cands[0], foundBy: "name" };
  }
  return { entry: null, foundBy: "none" };
}

/** True if this scrip is flagged in the "Price Exception" column of the scrip master —
 *  an ETF / liquid fund we deliberately never price. The app uses this to drop such
 *  scrips from the "prices we couldn't fetch" UI (no Apps Script change needed). */
export function isPriceExcepted(master: ScripMaster, isin: string, name: string): boolean {
  const e = lookupScrip(master, isin, name).entry;
  return !!(e && e.priceExcept);
}

/** A normalized name string that maps to MORE THAN ONE distinct master entry — so a
 *  name-only lookup for it is ambiguous: only ONE entry wins the slot (`claimAlias`
 *  precedence / last-writer), and trades under that name won't reliably merge with the
 *  intended scrip. The classic cause is a botched rename: adding a NEW entry (new
 *  canonical name + old name as an alias) while the OLD entry (old name as its canonical)
 *  still exists — the old name keeps resolving to the old entry, splitting the position.
 *  `entries` lists every canonical name claiming the string (2+); `key` is its normName. */
export interface NameCollision { key: string; name: string; entries: string[]; }
export function findNameCollisions(master: ScripMaster): NameCollision[] {
  const byNorm = new Map<string, { raw: string; entries: Set<ScripEntry> }>();
  for (const e of master.entries) {
    for (const raw of e.rawAliases) {
      const a = normName(raw);
      if (!a) continue;
      let rec = byNorm.get(a);
      if (!rec) { rec = { raw, entries: new Set() }; byNorm.set(a, rec); }
      rec.entries.add(e);
    }
  }
  const out: NameCollision[] = [];
  for (const [key, rec] of byNorm) {
    if (rec.entries.size >= 2) out.push({ key, name: rec.raw, entries: [...rec.entries].map(e => e.canonicalName) });
  }
  return out;
}

/** Add an alias / fill an ISIN on an existing entry and re-index it (in memory). */
function enrich(master: ScripMaster, entry: ScripEntry, isin: string, name: string) {
  let changed = false;
  if (isin && !entry.isin) {
    entry.isin = isin;
    master.byIsin.set(isin, entry);
    changed = true;
  }
  const raw = (name || "").trim();
  const nk = normName(raw);
  if (nk && !entry.aliasNorms.has(nk)) {
    entry.aliasNorms.add(nk);
    entry.tokenSets.push(tokenSet(raw));
    entry.rawAliases.push(raw);
    claimAlias(master, nk, entry);
    changed = true;
  }
  if (changed) master.dirty = true;
}

/** Create or merge a canonical entry (used by auto-seed and the review modal). */
export function upsertScrip(
  master: ScripMaster,
  isin: string,
  name: string,
  status: "auto" | "confirmed" = "auto",
): ScripEntry {
  const r = resolveScrip(master, isin, name);
  if (r.status === "resolved") {
    if (status === "confirmed") { r.entry.status = "confirmed"; r.entry.pendingPersist = true; master.dirty = true; }
    return r.entry;
  }
  const entry = makeEntry(name, (isin || "").trim(), [], status, true);
  indexEntry(master, entry);
  master.dirty = true;
  return entry;
}

/** Force-link a raw name to a specific chosen entry (used by the review popup
 *  for ambiguous cases the resolver refuses to auto-link). */
export function linkAliasToEntry(master: ScripMaster, entry: ScripEntry, isin: string, name: string): void {
  entry.status = "confirmed";
  entry.pendingPersist = true;
  enrich(master, entry, isin, name);
  master.dirty = true;
}

/** Create a confirmed canonical entry (used by "create new" in the popups).
 *  Dedups against an existing entry by EXACT ISIN or EXACT normalized name —
 *  the token-subset fallback is deliberately skipped so we never silently merge
 *  two distinct securities the user is explicitly naming. */
export function createCanonical(master: ScripMaster, canonicalName: string, isin: string, aliasName: string): ScripEntry {
  isin = (isin || "").trim();
  const existing =
    (isin ? master.byIsin.get(isin) : undefined) ||
    master.byAliasNorm.get(normName(canonicalName)) ||
    (aliasName ? master.byAliasNorm.get(normName(aliasName)) : undefined);
  if (existing) {
    existing.status = "confirmed";
    existing.pendingPersist = true;
    enrich(master, existing, isin, canonicalName);
    if (aliasName) enrich(master, existing, "", aliasName);
    master.dirty = true;
    return existing;
  }
  const extraAlias = aliasName && normName(aliasName) !== normName(canonicalName) ? [aliasName] : [];
  const entry = makeEntry(canonicalName, isin, extraAlias, "confirmed", true);
  indexEntry(master, entry);
  master.dirty = true;
  return entry;
}

/** Auto-seed the master from ISIN-bearing rows (contract notes). */
export function seedFromRows(master: ScripMaster, rows: { isin: string; name: string }[]): void {
  for (const r of rows) {
    if (!r.isin || !r.name) continue;
    upsertScrip(master, r.isin, r.name, "auto");
  }
}

/**
 * Persist new/changed entries by APPENDING their rows to the sheet (the bulk
 * base list is never rewritten). On the next load, append rows fold back into
 * their canonical entry by ISIN/name. Clears each entry's pendingPersist flag.
 */
export async function saveScripMaster(spreadsheetId: string, master: ScripMaster): Promise<void> {
  const toAppend = master.entries.filter(e => e.pendingPersist);
  if (toAppend.length === 0) { master.dirty = false; return; }

  const tab = await firstSheetTitle(spreadsheetId);
  const values = toAppend.map(e => {
    // Popup-created entries carry no exchange tickers/codes — leave BSE / NSE blank
    // and put any extra names in the Alias column (reload folds them back by ISIN).
    // Column order: ISIN | Security Name | BSE | NSE | Alias name.
    const aliases = e.rawAliases.filter(a => a.trim() && normName(a) !== normName(e.canonicalName));
    return [e.isin, e.canonicalName, "", "", aliases.join(" | ")];
  });

  await (gapi.client as any).sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${quoteTab(tab)}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values },
  });

  toAppend.forEach(e => { e.pendingPersist = false; });
  master.dirty = false;
}

/**
 * Append securities from a screener.in export to the scrip-master sheet — only
 * those NOT already known (by ISIN, or by an exact normalized-name match), so we
 * don't create duplicate identities. New rows carry the numeric BSE code and NSE
 * symbol in their own columns (ISIN | Security Name | BSE | NSE | Alias name).
 * Also indexes the new entries into the in-memory master so the rest of this
 * session resolves them immediately, and invalidates the cache for the next load.
 */
export async function appendScreenerSecurities(
  spreadsheetId: string,
  master: ScripMaster,
  securities: { isin: string; name: string; bse: string; nse: string; industry?: string }[],
): Promise<{ added: number; skipped: number; addedNames: string[] }> {
  const toAdd: { isin: string; name: string; bse: string; nse: string; industry: string }[] = [];
  const seen = new Set<string>();
  const seenNames = new Set<string>();
  for (const s of securities) {
    const isin = (s.isin || "").trim().toUpperCase();
    if (!isin || seen.has(isin)) continue;
    if (master.byIsin.has(isin)) continue;                                  // already known by ISIN
    const nn = s.name ? normName(s.name) : "";
    // Skip names already in the master OR already queued in this batch — else two
    // new rows that normalize to the same name fold into one entry on reload.
    if (nn && (master.byAliasNorm.has(nn) || seenNames.has(nn))) continue;
    seen.add(isin);
    if (nn) seenNames.add(nn);
    toAdd.push({ isin, name: s.name, bse: s.bse, nse: s.nse, industry: (s.industry || "").trim() });
  }
  if (toAdd.length === 0) return { added: 0, skipped: securities.length, addedNames: [] };

  // Append new securities as ISIN | Security Name | BSE | NSE | Alias name (A–E).
  // Industry is NOT stored here — the scrip master is append-only, so it can't
  // refresh the industry of the (many) securities already present. Industry lives
  // in its own upsert-by-ISIN "Industries" tab instead (see scripIndustries.ts).
  const tab = await firstSheetTitle(spreadsheetId);
  const values = toAdd.map(s => [s.isin, s.name, s.bse || "", s.nse || "", ""]);
  await (gapi.client as any).sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${quoteTab(tab)}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values },
  });

  // Reflect the new rows in the loaded master + drop the cache for next load.
  for (const s of toAdd) {
    const entry = makeEntry(s.name || s.isin, s.isin, [s.bse, s.nse].filter(Boolean), "confirmed");
    if (s.nse) entry.nse = s.nse;
    if (s.bse) entry.bse = s.bse;
    if (s.industry) entry.industry = s.industry;
    indexEntry(master, entry);
  }
  invalidateScripCache();

  return { added: toAdd.length, skipped: securities.length - toAdd.length, addedNames: toAdd.map(s => s.name || s.isin) };
}

/** Convenience resolver→key used by the calc paths (stable fallback when unresolved). */
export function resolveKey(master: ScripMaster, isin: string, name: string): { key: string; unresolved?: { name: string; isin: string; candidates: ScripEntry[] } } {
  const r = resolveScrip(master, isin, name);
  if (r.status === "resolved") return { key: r.key };
  const fallback = (isin || "").trim() || normName(name);
  if (r.status === "ambiguous") return { key: fallback, unresolved: { name, isin, candidates: r.candidates } };
  return { key: fallback, unresolved: { name, isin, candidates: [] } };
}
