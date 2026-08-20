// Temporary diagnostic. Dumps the REAL pdf.js text of a contract note, using the
// exact same grouping the app uses (extractTextFromPDF in src/lib/brokers/utils.ts:201)
// so what lands in the file is byte-for-byte what the parser actually receives.
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

  // Identical to the app: Y descending with a 5pt same-line threshold, then X ascending.
  items.sort((a, b) => {
    const yDiff = b.transform[5] - a.transform[5];
    if (Math.abs(yDiff) > 5) return yDiff;
    return a.transform[4] - b.transform[4];
  });

  let pageText = '';
  let lastY = items[0].transform[5];
  for (const item of items) {
    if (Math.abs(item.transform[5] - lastY) > 5) {
      pageText += '\n';
      lastY = item.transform[5];
    }
    pageText += item.str + ' ';
  }
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
