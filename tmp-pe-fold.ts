/**
 * Integration check of the Private Equities fold-in: loadScripMaster reads BOTH the main
 * scrip tab and the PE tab and folds them into one identity space. Exercised through the
 * real loader against a stubbed Sheets API (see tmp-pe-fold-run.mjs), so the column
 * detection, the alias index and the listed-company guard are all live.
 */
import { loadScripMaster, invalidateScripCache, isPeScrip, peEntry, ltDaysFor, lookupScrip, saveScripMaster } from './src/lib/scripMaster';
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
];

const PE = [
  ['Company', 'Drive Link', 'Valuation', 'Valuation Date'],
  ['Stellar Robotics Private Limited', 'https://drive.google.com/drive/folders/stellar', 250, '2026-03-31'],
  ['Quiet Harbour Ventures Pvt Ltd', 'https://drive.google.com/drive/folders/quiet', '', ''],
  // Normalises to "acme foods" — the SAME key as the listed "Acme Foods Ltd" above.
  ['Acme Foods Private Limited', 'https://drive.google.com/drive/folders/acme', 900, '2026-03-31'],
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
eq('collision: LT stays 365d (typed as Pvt)', ltDaysFor(master, '', 'Acme Foods Private Limited'), 365);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
