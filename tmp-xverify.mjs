import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = 'c:/Users/Priti/Desktop/remix_-contract-note-analyzer';
const require = createRequire(import.meta.url);
const esbuild = await import(pathToFileURL(`${ROOT}/node_modules/esbuild/lib/main.js`).href);
const pdfjs = await import(new URL(`file://${require.resolve('pdfjs-dist/legacy/build/pdf.mjs')}`).href);

function oldGroup(items) {
  const arr = [...items];
  arr.sort((a, b) => {
    const yDiff = b.transform[5] - a.transform[5];
    if (Math.abs(yDiff) > 5) return yDiff;
    return a.transform[4] - b.transform[4];
  });
  let out = '', lastY = arr[0].transform[5];
  for (const it of arr) {
    if (Math.abs(it.transform[5] - lastY) > 5) { out += String.fromCharCode(10); lastY = it.transform[5]; }
    out += it.str + ' ';
  }
  return out;
}
function newGroup(items) {
  const byY = [...items].sort((a, b) => b.transform[5] - a.transform[5]);
  const rows = []; let cur = [], anchor = byY[0].transform[5];
  for (const it of byY) {
    if (cur.length > 0 && Math.abs(it.transform[5] - anchor) > 5) { rows.push(cur); cur = []; anchor = it.transform[5]; }
    cur.push(it);
  }
  if (cur.length) rows.push(cur);
  for (const r of rows) r.sort((a, b) => a.transform[4] - b.transform[4]);
  return rows.map((r) => r.map((i) => i.str).join(' ') + ' ').join(String.fromCharCode(10));
}
async function both(file, maxPages) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true }).promise;
  const n = Math.min(pdf.numPages, maxPages || pdf.numPages);
  let o = '', w = '';
  for (let i = 1; i <= n; i++) {
    const items = (await (await pdf.getPage(i)).getTextContent()).items;
    if (!items.length) continue;
    o += oldGroup(items) + String.fromCharCode(10);
    w += newGroup(items) + String.fromCharCode(10);
  }
  return { old: o, nw: w };
}

const D = 'C:/Users/Priti/Downloads';
const FILES = {
  'zerodha 08-05-2026': [`${D}/08-05-2026-contract-notes_NJW724.pdf`, 0],
  'zerodha 20-05-2026': [`${D}/20-05-2026-contract-notes_NJW724.pdf`, 0],
  'zerodha FY25-26 (first 12p)': [`${D}/CONTRACT NOTE FY25-26.pdf`, 12],
  'shareindia TRNSTMT': [`${D}/00278410_TRNSTMT.pdf`, 0],
  'integrated txn 10143762 (first 12p)': [`${D}/10143762_txn.pdf`, 12],
  'integrated txn S713 (first 12p)': [`${D}/S713_TXN (1).pdf`, 12],
  'nuvama V3 buy': [`${D}/CNB_11_EQ_BSE_16Apr2026_60072941.pdf`, 0],
  'nuvama V3 sell': [`${D}/New Contract.pdf`, 0],
};
const pairs = {};
for (const [k, [f, mp]] of Object.entries(FILES)) {
  if (!fs.existsSync(f)) { console.log(`missing ${f}`); continue; }
  try { pairs[k] = await both(f, mp); } catch (e) { console.log(`skip ${k}: ${e.name}`); }
}

const stub = { name: 's', setup(b) {
  b.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path, namespace: 'u' }));
  b.onLoad({ filter: /.*/, namespace: 'u' }, () => ({ contents: 'export default "s://w";', loader: 'js' }));
  b.onResolve({ filter: /^pdfjs-dist$/ }, (a) => ({ path: a.path, namespace: 'p' }));
  b.onLoad({ filter: /.*/, namespace: 'p' }, () => ({ contents: `export const GlobalWorkerOptions={workerSrc:''};export const getDocument=()=>{throw new Error('stub')};`, loader: 'js' }));
} };
const out = `${process.env.TEMP || ROOT}/.xverify.mjs`;
await esbuild.build({ entryPoints: [`${ROOT}/tmp-xverify.ts`], bundle: true, platform: 'node',
  format: 'esm', target: 'node20', outfile: out, plugins: [stub], logLevel: 'warning',
  define: { __PAIRS__: JSON.stringify(pairs) } });
await import(pathToFileURL(out).href);
