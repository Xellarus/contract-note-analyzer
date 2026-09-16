/**
 * Integration check of the Private Equities fold-in: loadScripMaster reads BOTH the main
 * scrip tab and the PE tab and folds them into one identity space. Exercised through the
 * real loader against a stubbed Sheets API (see tmp-pe-fold-run.mjs), so the column
 * detection, the alias index and the listed-company guard are all live.
 */
import { loadScripMaster, invalidateScripCache, isPeScrip, peEntry, ltDaysFor, lookupScrip, resolveScrip, saveScripMaster } from './src/lib/scripMaster';
import { makePriceResolver } from './src/lib/scripPrices';

let pass = 0, fail = 0;
const eq = (label: string, got: any, want: any) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

const g: any = globalThis;

// The main scrip tab: one plainly listed company, one listed company whose name will
// COLLIDE with a PE row after normName strips "Private Limited".
const MAIN = [
  ['ISIN', 'Security Name', 'BSE', 'NSE', 'Alias name'],
  ['INE001A01036', 'Goodluck India Limited', 'GOODLUCK | 530655', 'GOODLUCK', ''],
  ['INE777X01011', 'Acme Foods Ltd', 'ACMEF | 500123', 'ACMEFOODS', ''],
  // The owner's real second collision (16-Sep-2026): a listed company whose PE-tab twin is
  // named with NOTHING to tell the two apart. Unlike Acme there is no Pvt/Private token, so
  // no discriminating key exists and the row must be REFUSED and reported, not guessed at.
  ['INE888X01019', 'Cranex Ltd.', '522001', '', ''],
  // A listed row with a TICKER and NO ISIN. Ordinary in a hand-maintained master, and the
  // case that every other fixture here accidentally excluded: with no ISIN, this entry's key
  // falls back to normName(), which is the very key its unlisted twin also falls back to.
  ['', 'Zenmark Industries Limited', 'ZENMARK | 500999', 'ZENMARK', ''],
];

const PE = [
  ['Company', 'Drive Link', 'Valuation', 'Valuation Date', 'ISIN'],
  ['Stellar Robotics Private Limited', 'https://drive.google.com/drive/folders/stellar', 250, '2026-03-31'],
  ['Quiet Harbour Ventures Pvt Ltd', 'https://drive.google.com/drive/folders/quiet', '', ''],
  // Normalises to "acme foods" — the SAME key as the listed "Acme Foods Ltd" above.
  ['Acme Foods Private Limited', 'https://drive.google.com/drive/folders/acme', 900, '2026-03-31'],
  // The owner's own spelling, reported 14-Sep-2026: no space before LTD, and two full stops.
  // It has to collapse to "keshwana ispat", because True Entry stores no ISIN and that
  // normalised name is the ONLY thing a saved trade is looked up by. A SHAPE guard, not a
  // mechanism one: swapping normName's punctuation and pvt/ltd steps does not break it
  // (\b treats the full stop as a word boundary either way), and nor does disabling
  // claimAlias's overwrite rule. Both were tried. It is here because the shape came off a
  // real sheet and the cost of it silently failing is a 365-day holding period on a
  // 730-day asset.
  ['KESHWANA ISPAT PVT.LTD.', '', '', ''],
  // The twin of the ISIN-less listed row above.
  ['Zenmark Industries Pvt Ltd', '', '', ''],
  // Collides with the listed 'Cranex Ltd.' and carries no token that distinguishes it.
  ['Cranex', '', '', ''],
  // Carries its OWN ISIN and collides by name with the listed 'Goodluck India Limited'.
  // An ISIN row takes the `!entry` path and CREATES an entry, whose `indexEntry` would claim
  // the shared name slot. True Entry has no ISIN column, so every listed trade is looked up by
  // name — losing that slot files them all against the private company at 730 days.
  ['Goodluck India Pvt Ltd', '', '', '', 'INE999Z01010'],
];

const MAIN_RANGE = "'Scrip Master'!A1:Z50000";
const PE_RANGE = 'Private Equities!A1:J5000';

g.__sheetTabs = ['Scrip Master'];
g.__ranges = { [MAIN_RANGE]: MAIN, [PE_RANGE]: PE };
g.__appended = [];

const master = await loadScripMaster('SHEET');

// ── The unlisted companies resolve, and carry their PE facts ──
eq('stellar is PE', isPeScrip(master, '', 'Stellar Robotics Private Limited'), true);
eq('stellar drive link', peEntry(master, '', 'Stellar Robotics Private Limited')?.driveLink, 'https://drive.google.com/drive/folders/stellar');
eq('stellar valuation', peEntry(master, '', 'Stellar Robotics Private Limited')?.peValuation, 250);
eq('stellar valuation date', peEntry(master, '', 'Stellar Robotics Private Limited')?.peValuationDate, '2026-03-31');
eq('stellar never priced', !!lookupScrip(master, '', 'Stellar Robotics Private Limited').entry?.priceExcept, true);
eq('stellar industry slice', lookupScrip(master, '', 'Stellar Robotics Private Limited').entry?.industry, 'Private Equity');

// Resolvable under a shortened spelling too — normName strips Private/Ltd, so this is the
// same identity a manually-typed trade will produce.
eq('stellar short name resolves', isPeScrip(master, '', 'Stellar Robotics'), true);

// No valuation → no peValuation, so the position stays at cost.
eq('quiet has no valuation', peEntry(master, '', 'Quiet Harbour Ventures Pvt Ltd')?.peValuation, undefined);

// ── Holding periods ──
eq('unlisted LT is 730d', ltDaysFor(master, '', 'Stellar Robotics Private Limited'), 730);
eq('listed LT is 365d', ltDaysFor(master, 'INE001A01036', 'Goodluck India Limited'), 365);

// ── The listed-company guard ──
// "Acme Foods Private Limited" collides with the LISTED "Acme Foods Ltd". It must NOT turn
// that entry unlisted: doing so would stop its price ever being fetched and swap its LTCG
// period, on a live holding.
eq('collision: listed stays listed', isPeScrip(master, 'INE777X01011', 'Acme Foods Ltd'), false);
eq('collision: still priced', !!lookupScrip(master, 'INE777X01011', 'Acme Foods Ltd').entry?.priceExcept, false);
eq('collision: LT stays 365d', ltDaysFor(master, 'INE777X01011', 'Acme Foods Ltd'), 365);
// The LISTED company must still answer to its own name — this is the assertion that stops the
// twin from stealing the shared slot, which `claimAlias` would happily have let it do.
eq('collision: the listed twin still answers to its own name', isPeScrip(master, '', 'Acme Foods Ltd'), false);
eq('collision: ...at 365 days, by name alone', ltDaysFor(master, '', 'Acme Foods Ltd'), 365);

// CHANGED 16-Sep-2026. The owner holds BOTH a listed "Kusumgar Limited" and an unlisted
// "Kusumgar Pvt Ltd", and before this they could not: the two collapse to one key and one name
// slot. A name that CARRIES the Pvt/Private token now gets its own entry under the
// discriminating key (`normNamePrivate`), so each resolves to itself.
eq('twin: the Pvt spelling resolves to the PRIVATE company', isPeScrip(master, '', 'Acme Foods Private Limited'), true);
eq('twin: ...at 730 days, not the listed 365', ltDaysFor(master, '', 'Acme Foods Private Limited'), 730);
eq('twin: ...and "Pvt Ltd" is the same company as "Private Limited"', isPeScrip(master, '', 'Acme Foods Pvt Ltd'), true);
eq('twin: the two are DIFFERENT entries',
  lookupScrip(master, '', 'Acme Foods Private Limited').entry !== lookupScrip(master, '', 'Acme Foods Ltd').entry, true);
eq('twin: the listed one keeps its ticker', lookupScrip(master, '', 'Acme Foods Ltd').entry?.nse, 'ACMEFOODS');
eq('twin: the private one has none', lookupScrip(master, '', 'Acme Foods Private Limited').entry?.nse, undefined);
eq('twin: ...and is never priced', !!lookupScrip(master, '', 'Acme Foods Private Limited').entry?.priceExcept, true);
// The Drive link is still lent to it — a document link computes nothing.
eq('collision: drive link attached', lookupScrip(master, '', 'Acme Foods Ltd').entry?.driveLink, 'https://drive.google.com/drive/folders/acme');
// And no phantom valuation is applied to a listed company.
eq('collision: no valuation applied', lookupScrip(master, '', 'Acme Foods Ltd').entry?.peValuation, undefined);

// ── The price resolver serves the valuation, and only as a last resort ──
{
  const cmp = makePriceResolver(master, []);
  eq('valuation used when no price', cmp('', 'Stellar Robotics Private Limited'), 250);
  eq('no valuation → undefined', cmp('', 'Quiet Harbour Ventures Pvt Ltd'), undefined);
}
{
  // A real fetched price always beats a stated valuation (a company that has since listed).
  const cmp = makePriceResolver(master, [
    { isin: '', name: 'Stellar Robotics Private Limited', price: 311, updated: '', previousPrice: 0, source: 'yahoo' as const },
  ]);
  eq('market price beats valuation', cmp('', 'Stellar Robotics Private Limited'), 311);
}

// ── A PE entry must never be appended to the main scrip tab ──
// Appending it would create a SECOND entry for the same company: the name then resolves to
// only one of them and the position silently splits between the two.
{
  const e = lookupScrip(master, '', 'Stellar Robotics Private Limited').entry!;
  e.pendingPersist = true;          // simulate anything that flips the flag (upsert/link popup)
  master.dirty = true;
  await saveScripMaster('SHEET', master);
  eq('PE never appended', g.__appended.length, 0);
  eq('PE pending flag cleared', e.pendingPersist, false);
  eq('master no longer dirty', master.dirty, false);
}

// ── A failed PE read is recorded, not swallowed as "no private equity" ──
{
  invalidateScripCache();
  g.__failRange = PE_RANGE;
  const m2 = await loadScripMaster('SHEET');
  eq('peFailed set', m2.peFailed, true);
  eq('equity master still loaded', !!lookupScrip(m2, 'INE001A01036', 'Goodluck India Limited').entry, true);
  eq('no PE flags without the tab', isPeScrip(m2, '', 'Stellar Robotics Private Limited'), false);
  g.__failRange = null;
}

// ── An absent PE tab is a normal, quiet state (not a failure) ──
{
  invalidateScripCache();
  g.__missingRange = PE_RANGE;
  const m3 = await loadScripMaster('SHEET');
  eq('absent tab is not a failure', m3.peFailed, false);
  eq('absent tab → no PE', isPeScrip(m3, '', 'Stellar Robotics Private Limited'), false);
  g.__missingRange = null;
}

// -- REQUEST COUNT: the point of the batching, and what nothing measured before ------------
// The regression that started this was invisible because no test counted requests. Adding an
// asset class used to add a REQUEST to every master load - PE alone was 1, then AIF, Mutual
// Fund and Bonds took it to 4, serially, from 29 call sites, against 60 reads per minute.
{
  invalidateScripCache();
  g.__sheetTabs = ['Scrip Master', 'Private Equities', 'AIF', 'Mutual Fund', 'Bonds'];
  g.__ranges = {
    [MAIN_RANGE]: MAIN,
    [PE_RANGE]: PE,
    'AIF!A1:J5000': [],
    'Mutual Fund!A1:J5000': [],
    'Bonds!A1:J5000': [],
  };
  g.__reads = { get: 0, batchGet: 0, meta: 0, ranges: [], batched: [] };

  const m = await loadScripMaster('SHEET');
  eq('every class tab is read in ONE batchGet', g.__reads.batchGet, 1);
  eq('...carrying all four ranges at once', g.__reads.batched[0]?.length, 4);
  eq('the master itself is the only single-range read', g.__reads.get, 1);
  eq('so a master load costs 2 value reads, not 5', g.__reads.get + g.__reads.batchGet, 2);
  eq('and the PE rows still fold in', isPeScrip(m, '', 'Stellar Robotics Private Limited'), true);
}

// A tab the list does not mention must STILL be read. The tab list is an optimisation, never an
// authority: concluding "absent, so empty" without asking would file PE gains as LISTED with no
// peFailed flag to warn anyone - silent, and wrong in the direction that costs money.
{
  invalidateScripCache();
  g.__sheetTabs = ['Scrip Master'];        // the class tabs exist, but the list omits them
  g.__reads = { get: 0, batchGet: 0, meta: 0, ranges: [], batched: [] };

  const m = await loadScripMaster('SHEET');
  eq('an unlisted tab is still read, not assumed empty',
    isPeScrip(m, '', 'Stellar Robotics Private Limited'), true);
  eq('...with no batch attempted', g.__reads.batchGet, 0);
  eq('...and nothing marked failed', m.peFailed, false);
}

// One batchGet means one failure loses every class in it. The rule is explicit: an AIF tab that
// 500s must not stop Private Equities folding in. So a failed batch retries per class.
{
  invalidateScripCache();
  g.__sheetTabs = ['Scrip Master', 'Private Equities', 'AIF', 'Mutual Fund', 'Bonds'];
  g.__reads = { get: 0, batchGet: 0, meta: 0, ranges: [], batched: [] };
  g.__failBatch = true;

  const m = await loadScripMaster('SHEET');
  // >= 1, not == 1: sheetsBackoff retries a 5xx five times before giving up, so a hard batch
  // failure costs those retries AND the per-class fallback. Rare, and the retries are right for
  // a 429 (where waiting is the cure), but worth knowing the failure path is the expensive one.
  eq('the batch was attempted', g.__reads.batchGet >= 1, true);
  eq('...and its failure falls back to per-class reads', g.__reads.get >= 5, true);
  eq('...so PE still folds in despite the batch failing',
    isPeScrip(m, '', 'Stellar Robotics Private Limited'), true);
  eq('...and no class is wrongly marked failed', m.peFailed, false);
  g.__failBatch = false;
}


// ── The punctuation shape the owner actually types ───────────────────────────────
// True Entry has NO ISIN column, so a saved unlisted trade is looked up BY NAME alone. That is
// the only path production uses, and it is the path these assert.
eq('pvt.ltd.: resolves as PE by name alone', isPeScrip(master, '', 'KESHWANA ISPAT PVT.LTD.'), true);
eq('pvt.ltd.: long-term at 730 days, not 365', ltDaysFor(master, '', 'KESHWANA ISPAT PVT.LTD.'), 730);
eq('pvt.ltd.: and under a shortened spelling', isPeScrip(master, '', 'Keshwana Ispat'), true);

// ── THE INVARIANT: what the dropdown LISTS as PE must also RESOLVE as PE ──────────────
// Reported 14-Sep-2026: the Add Trade dropdown showed a company as PE while its detail-page
// badge read EQ. Those two ask DIFFERENT questions — the dropdown iterates `master.entries` and
// reads `e.assetClass`, the badge calls `assetClassOf(name)` — so an identity split across two
// entries answers them differently, and the holding is then taxed as listed equity at 365 days
// instead of 730 with nothing on screen disagreeing.
//
// (That report turned out to be a STALE master held in the page, not a split identity. But the
// two are indistinguishable from outside the app, which is exactly why the invariant is worth
// pinning: next time, this says which one it is.)
for (const e of master.entries.filter((x: any) => x.assetClass)) {
  eq(`invariant: "${e.canonicalName}" is listed as ${e.assetClass} and resolves as ${e.assetClass}`,
    lookupScrip(master, '', e.canonicalName).entry?.assetClass, e.assetClass);
}


// ── The page must not keep a STALE master after registering a company ───────────────
// This is what the 14-Sep-2026 report actually was. `Holdings.tsx` loads the scrip master ONCE
// on mount, unforced, into React state; the Add Trade drawer force-reloads its OWN master when
// you press "Just added a company? Recheck". Register an unlisted company, trade it, and the
// drawer's dropdown says PE while the page's badge, its Listed/Unlisted segment and every
// class-derived figure keep saying EQ — for the whole session, until a browser reload.
//
// Source-checked rather than behaviour-checked because it is React state wiring: there is no
// browser in the loop, and a green suite proved nothing about it for as long as it was broken.
{
  const fs = await import('node:fs');
  const src = fs.readFileSync('src/components/Holdings.tsx', 'utf8');
  const handlers = [...src.matchAll(/onSaved=\{([\s\S]{0,400}?)\}\}/g)].map(m => m[1]);
  const addTrade = handlers.filter(h => /fetchSheetHoldings/.test(h));
  eq('every Add Trade onSaved handler was found', addTrade.length >= 2, true);
  eq('...and every one of them refreshes the scrip master',
    addTrade.every(h => /refreshScripAfterSave/.test(h)), true);
  eq('the refresh prefers the drawer-supplied master over a fresh read',
    /refreshScripAfterSave = \(fromDrawer[\s\S]{0,200}?if \(fromDrawer\) \{ setScrip\(fromDrawer\)/.test(src), true);
  eq('...and forces the read when there is none, or it would re-read the same stale cache',
    /refreshScripAfterSave[\s\S]{0,400}?loadScripMaster\(SCRIP_MASTER_SPREADSHEET_ID, \{ force: true \}\)/.test(src), true);
}


// ── A class dropped by a ticker collision is RECORDED, not swallowed ────────────────────────
//
// Reported 16-Sep-2026: "I added Kusumgar Pvt Ltd in private equities sheet, in the unlisted add
// trade page it is not showing on dropdown."
//
// `Acme Foods Private Limited` is on the PE tab and normalises to the same key as the LISTED
// `Acme Foods Ltd`, which carries a ticker. `foldAssetClass` therefore skips it — correctly,
// because marking a live listed holding unlisted would swap its LTCG period to 24 months and
// stop the price feed ever fetching it. What was WRONG is that it happened in silence.
//
// The Add Trade dropdown filters on `assetClass` (`ScripCombobox`, `peOnly && !e.assetClass`),
// so a skipped row is on the sheet and invisible in the app, with nothing anywhere saying why.
eq('collision: the skipped row is recorded', master.classSkippedByTicker.length, 1);
eq('collision: ...by the name as TYPED on the tab', master.classSkippedByTicker[0].name, 'Cranex');
eq('collision: ...with the key the two share', master.classSkippedByTicker[0].normalised, 'cranex');
eq('collision: ...naming what it collided with', master.classSkippedByTicker[0].collidedWith, 'Cranex Ltd.');
eq('collision: ...and the ticker that vetoed it', master.classSkippedByTicker[0].ticker, '522001');
// Acme is NOT in this list any more: it carries the Pvt token, so it got its own identity
// instead of being refused. Only a name with nothing to distinguish it is refused.
eq('collision: a name WITH a distinguishing token is not refused',
  master.classSkippedByTicker.some((x: any) => /Acme/i.test(x.name)), false);

// The mechanism itself, asserted where the dropdown reads it: no assetClass, so `peOnly` skips
// it. This is the line that turns "not in the dropdown" from a mystery into a stated fact.
eq('collision: the refused entry carries NO assetClass, which is what hides it',
  lookupScrip(master, '', 'Cranex').entry?.assetClass, undefined);
eq('collision: ...and it is therefore not PE either', isPeScrip(master, '', 'Cranex'), false);

// Only the colliding row. A list that fills up with healthy companies is a list nobody reads.
eq('collision: a clean PE row is NOT reported',
  master.classSkippedByTicker.some((x: any) => /Stellar|Quiet|KESHWANA/i.test(x.name)), false);

// The discriminating key is a TIE-BREAKER, not a new lookup rule: it is consulted only when it
// differs from the plain key, which is only for a name carrying the token. Everything else must
// take exactly the path it always did.
eq('twin: an ordinary name is unaffected', isPeScrip(master, '', 'Stellar Robotics Private Limited'), true);
eq('twin: ...including one with no Pvt token at all', isPeScrip(master, '', 'Quiet Harbour Ventures Pvt Ltd'), true);
eq('twin: a listed company with no unlisted twin still resolves', lookupScrip(master, '', 'Goodluck India Limited').entry?.nse, 'GOODLUCK');

// ── The KEY, not just the entry ─────────────────────────────────────────
// Resolving to two different ENTRIES is only half of being two companies. Every engine buckets
// holdings, FIFO lots and gains by `entry.key` — `byKey.get(key)` in holdingsCalc's `resolve`,
// and the same in the register — so two entries sharing a key are ONE position on screen and on
// every filed tab, under whichever name got there first.
//
// `makeEntry` sets `key: isin || normName(canonicalName)`. On the ISIN-less listed row above,
// BOTH sides fall back to normName and both keys are "zenmark industries". Reported by the owner
// (16-Sep-2026) as "kusumgar ltd and pvt ltd showing transaction in same PE" — one detail page,
// both companies' trades, PE badge, and a YAHOO price on an unlisted company.
//
// Invisible to every assertion above, all of which compare entries.
const zListed = resolveScrip(master, '', 'Zenmark Industries Limited');
const zTwin = resolveScrip(master, '', 'Zenmark Industries Pvt Ltd');
eq('key: the ISIN-less listed company resolves', zListed.status, 'resolved');
eq('key: ...and so does its unlisted twin', zTwin.status, 'resolved');
eq('key: they are different entries',
  (zListed as any).entry !== (zTwin as any).entry, true);
eq('key: ...and they DO NOT SHARE A BUCKET, which is what puts both on one page',
  (zListed as any).key !== (zTwin as any).key, true);
eq('key: the listed side keeps its ticker', (zListed as any).entry?.nse, 'ZENMARK');
eq('key: the unlisted side is PE', isPeScrip(master, '', 'Zenmark Industries Pvt Ltd'), true);
eq('key: ...at 730 days', ltDaysFor(master, '', 'Zenmark Industries Pvt Ltd'), 730);
eq('key: while the listed side stays at 365', ltDaysFor(master, '', 'Zenmark Industries Limited'), 365);

// The twin must ANSWER to its discriminating name, not merely be filed under it.
eq('key: the twin carries the discriminating name as its own alias',
  (zTwin as any).entry?.aliasNorms?.has('zenmark industries pvt'), true);

// And it KEEPS the plain key in that set, which reads backwards and is the point. `aliasNorms`
// is `enrich`'s gate: `enrich` fires only for a name NOT already in it, and then calls
// `claimAlias`, whose rule hands the shared slot to the unlisted row. Strip the plain key and
// the first trade resolved against the twin re-opens the original disaster from behind.
eq('key: ...and KEEPS the plain one, which is what keeps `enrich` from claiming the shared slot',
  (zTwin as any).entry?.aliasNorms?.has('zenmark industries'), true);

// The invariant that actually matters, stated head-on and AFTER both resolves above have had
// their chance to mutate the master: the shared name slot still points at the LISTED company.
eq('key: the shared name slot still belongs to the listed company',
  (master.byAliasNorm.get('zenmark industries') as any)?.canonicalName, 'Zenmark Industries Limited');
// ...and it survives the ISIN-carrying path through `enrich` too — a broker row naming the
// private company WITH an ISIN is the one call that reaches `enrich` on the twin.
resolveScrip(master, 'INE555Z01015', 'Zenmark Industries Pvt Ltd');
eq('key: ...even after an ISIN-bearing trade enriches the twin',
  (master.byAliasNorm.get('zenmark industries') as any)?.canonicalName, 'Zenmark Industries Limited');
eq('key: ...and the two keys are still distinct afterwards',
  (resolveScrip(master, '', 'Zenmark Industries Limited') as any).key !== (resolveScrip(master, '', 'Zenmark Industries Pvt Ltd') as any).key, true);

// `resolveScrip` is a SECOND, parallel implementation of the same resolution — and it is the one
// the register uses (`keyOf`), so it decides the KEY a saved trade is filed under and therefore
// which tax rules reach it. Patching only `lookupScrip` would leave the drawer showing the right
// company while the register filed its trades against the listed one. Asserted separately
// because the probe that disables resolveScrip's branch did NOT fail without this.
{
  const pvt = resolveScrip(master, '', 'Acme Foods Private Limited');
  const listed = resolveScrip(master, '', 'Acme Foods Ltd');
  eq('twin/resolve: the Pvt spelling resolves to the private company', pvt.status === 'resolved' && isPeScrip(master, '', pvt.entry!.canonicalName), true);
  eq('twin/resolve: ...to a DIFFERENT key than the listed one', pvt.status === 'resolved' && listed.status === 'resolved' && pvt.key !== listed.key, true);
  eq('twin/resolve: ...and the listed one still keeps its ticker', listed.status === 'resolved' ? listed.entry.nse : '', 'ACMEFOODS');
}

// The same protection where the PE row creates a BRAND NEW entry rather than matching one.
// "Give the tab row its ISIN" was the advice the app itself printed, and without this it is
// advice to break the LISTED company: the new entry's `indexEntry` claims the shared name slot
// and every "Goodluck India Limited" trade then files against the private one at 730 days.
eq('isin-row: the listed company keeps its own name', isPeScrip(master, '', 'Goodluck India Limited'), false);
eq('isin-row: ...at 365 days', ltDaysFor(master, '', 'Goodluck India Limited'), 365);
eq('isin-row: ...and its ticker', lookupScrip(master, '', 'Goodluck India Limited').entry?.nse, 'GOODLUCK');
eq('isin-row: while the Pvt spelling reaches the private company', isPeScrip(master, '', 'Goodluck India Pvt Ltd'), true);
eq('isin-row: ...at 730 days', ltDaysFor(master, '', 'Goodluck India Pvt Ltd'), 730);

// ── The drawer must not show a master older than the sheet ──────────────────────────────────
//
// `activeMaster` is `recheckedMaster || master || selfMaster`, and it preferred the STALEST of
// the three: the `master` PROP, which Holdings loads once on mount and keeps for the life of
// the page. The drawer is the screen the owner opens straight after editing a non-listed tab,
// so it is the one that must re-read. Source-checked: React state wiring, no browser in the loop.
{
  const fs = await import('node:fs');
  const src = fs.readFileSync('src/components/AddTradeModal.tsx', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  eq('drawer: opening it FORCES a fresh master read',
    /useEffect\(\(\) => \{[\s\S]{0,400}?loadScripMaster\(SCRIP_MASTER_SPREADSHEET_ID, \{ force: true \}\)/.test(code), true);
  eq('drawer: ...into recheckedMaster, so it beats the parent\u2019s stale prop',
    /force: true \}\)[\s\S]{0,200}?setRecheckedMaster/.test(code), true);
  eq('drawer: ...and a failed force still falls back rather than emptying the dropdown',
    /\.catch\(\(\) => \{[\s\S]{0,300}?loadScripMaster\(SCRIP_MASTER_SPREADSHEET_ID\)/.test(code), true);

  // The refusal message. Telling someone to "add it to one of the tabs" when it is ALREADY on
  // one talks them into a duplicate row — the split-identity failure, self-inflicted.
  eq('drawer: the refusal consults the collision list before blaming the user',
    /classSkippedByTicker[\s\S]{0,300}?normName\(l\.company\.trim\(\)\)/.test(code), true);
  eq('drawer: ...and tells them NOT to add it again',
    /Do NOT add it again/.test(code), true);
}

// ── A finished parse must clear a stale error ───────────────────────────────────────────────
// The Add button stays clickable while a file is read, on purpose, so a click during the read
// gives feedback instead of nothing. That feedback was then left standing once the read
// finished — "Still reading the file" in red above a preview that had rendered perfectly.
{
  const fs = await import('node:fs');
  const src = fs.readFileSync('src/components/StockOpeningImportModal.tsx', 'utf8');
  eq('import modal: a successful parse clears the error it may have set',
    /setParsed\(p\); setPreview\(pv\); setError\(''\);/.test(src), true);
}


// ── The unlisted dropdown must not truncate the list it exists to show ──────────────────────
//
// Reported 16-Sep-2026, twice: a company added to the Private Equities tab was not in the Add
// Trade dropdown. Two causes were fixed first (a stale master, and a class dropped by a ticker
// collision) and it was STILL missing. This is the third and it is the one that hid a company
// whose master entry was perfectly fine.
//
// `ScripCombobox` scanned `master.entries` and did `if (out.length >= 60) break` — in SHEET
// ORDER, not alphabetical. In PE scope an empty box matches every entry, so the scan stopped at
// the 60th row of the tab and nothing below it could ever be reached. A newly added company
// goes at the BOTTOM. It then sliced to 30 for display, with no marker, so a list cut short was
// indistinguishable from "that company is not registered" — which sends the owner off to add a
// duplicate row for one that already exists.
{
  const fs = await import('node:fs');
  const src = fs.readFileSync('src/components/ScripCombobox.tsx', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  eq('combobox: the scan cap applies to the LISTED universe only',
    /if \(!peOnly && out\.length >= 60\) break;/.test(code), true);
  eq('combobox: ...and there is no unguarded cap left',
    /if \(out\.length >= \d+\) break;/.test(code), false);
  eq('combobox: PE scope is shown in full, never sliced',
    /const shown = peOnly \? out : out\.slice\(0, 30\);/.test(code), true);
  eq('combobox: the total is carried out of the memo so truncation can be stated',
    /return \{ matches: shown, total: out\.length \};/.test(code), true);
  eq('combobox: ...and IS stated when the list is cut short',
    /total > matches\.length &&/.test(code), true);
  eq('combobox: peOnly is in the memo deps, or the list would not refresh with scope',
    /\}, \[value, master, peOnly\]\);/.test(code), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
