// Temporary diagnostic. Dumps the REAL pdf.js text of a contract note, using the
// exact same grouping the app uses (extractTextFromPDF in src/lib/brokers/utils.ts)
// so what lands in the file is byte-for-byte what the parser actually receives.
// If that function changes, CHANGE THIS TOO - it drifted once already and produced
// fixtures the app could never generate.
//
//   node tmp-extract.mjs "C:\path\to\note.pdf" [password]
//
// Writes <note>.extracted.txt next to this script and prints the trade-row region.
// The password is a command-line argument: it is never written to the output file.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjs = await import(new URL(`file://${pdfjsPath}`).href);

const [, , filePath, password] = process.argv;
if (!filePath) {
  console.error('usage: node tmp-extract.mjs "<file.pdf>" [password]');
  process.exit(1);
}

const data = new Uint8Array(fs.readFileSync(filePath));
const pdf = await pdfjs.getDocument({ data, password, useSystemFonts: true }).promise;

let text = '';
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  const content = await page.getTextContent();
  const items = content.items;
  if (items.length === 0) continue;

  // MUST mirror extractTextFromPDF (src/lib/brokers/utils.ts) EXACTLY, or the fixture
  // is not what the parser receives and a test can pass on text the app never produces.
  //
  // This file used to carry the app's OLD comparator - a single sort of the form
  //   if (|dy| > 5) return dy; else return dx;
  // which is not a valid total order (not transitive), so rows whose cells wrap onto
  // two baselines came out scrambled. The app replaced it with cluster-by-Y-then-sort-X
  // and this harness was not updated, so it silently drifted out of sync. Keep the two
  // in lockstep.
  const LINE_TOL = 5;
  const byY = [...items].sort((a, b) => b.transform[5] - a.transform[5]);
  const rows = [];
  let current = [];
  let anchorY = byY[0].transform[5];
  for (const item of byY) {
    // Compare against the row's ANCHOR, not the previous item, so a column of
    // slightly-drifting baselines cannot creep into one ever-growing line.
    if (current.length > 0 && Math.abs(item.transform[5] - anchorY) > LINE_TOL) {
      rows.push(current);
      current = [];
      anchorY = item.transform[5];
    }
    current.push(item);
  }
  if (current.length > 0) rows.push(current);
  for (const row of rows) row.sort((a, b) => a.transform[4] - b.transform[4]);

  const pageText = rows
    .map((row) => row.map((item) => item.str).join(' ') + ' ')
    .join('\n');
  text += pageText + '\n';
}

const out = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)),
                      path.basename(filePath).replace(/\.pdf$/i, '') + '.extracted.txt');
fs.writeFileSync(out, text, 'utf8');

const lines = text.split('\n');
console.log(`pages: ${pdf.numPages} | lines: ${lines.length}`);
console.log(`written: ${out}\n`);

// Show the region that matters: any line carrying an ISIN, plus its neighbours.
const hits = [];
lines.forEach((l, i) => { if (/IN[A-Z0-9]{9}[0-9]/.test(l.replace(/\s+/g, ''))) hits.push(i); });
const show = new Set();
hits.forEach((i) => { for (let k = i - 2; k <= i + 4; k++) if (k >= 0 && k < lines.length) show.add(k); });
console.log('--- lines containing an ISIN (±2/+4 context), with exact spacing ---');
[...show].sort((a, b) => a - b).forEach((i) => console.log(String(i).padStart(4) + ' | ' + JSON.stringify(lines[i])));
