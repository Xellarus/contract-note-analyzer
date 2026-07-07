// Generates `scrip-master.csv` (ISIN, Security Name, Aliases) from the bundled
// NSE/BSE seed, for one-time import into the shared Scrip Master Google Sheet.
// Run: node scripts/genScripCsv.mjs
import fs from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const seedPath = path.join(root, 'src', 'data', 'scripSeed.json');
const outPath = path.join(root, 'scrip-master.csv');

const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

const esc = (v) => {
  const s = (v ?? '').toString();
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const lines = ['ISIN,Security Name,Aliases'];
for (const r of seed) {
  const aliases = (r.a || []).join(' | ');
  lines.push([esc(r.i), esc(r.n), esc(aliases)].join(','));
}

fs.writeFileSync(outPath, lines.join('\r\n') + '\r\n', 'utf8');
console.log(`Wrote ${outPath} with ${seed.length} rows`);
