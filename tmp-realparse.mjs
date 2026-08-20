// Extracts REAL text from the notes with the app's own algorithm, then bundles and runs
// tmp-realparse.ts against it.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = 'c:/Users/Priti/Desktop/remix_-contract-note-analyzer';
const require = createRequire(import.meta.url);
const esbuild = await import(pathToFileURL(`${ROOT}/node_modules/esbuild/lib/main.js`).href);
const pdfjs = await import(new URL(`file://${require.resolve('pdfjs-dist/legacy/build/pdf.mjs')}`).href);

// The OLD algorithm, kept only so the regression test can prove the guards reject it.
async function extractOld(file) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const items = [...(await (await pdf.getPage(i)).getTextContent()).items];
    if (!items.length) continue;
    items.sort((a, b) => {
      const yDiff = b.transform[5] - a.transform[5];
      if (Math.abs(yDiff) > 5) return yDiff;
      return a.transform[4] - b.transform[4];
    });
    let pageText = '', lastY = items[0].transform[5];
    for (const it of items) {
      if (Math.abs(it.transform[5] - lastY) > 5) { pageText += '\n'; lastY = it.transform[5]; }
      pageText += it.str + ' ';
    }
    text += pageText + '\n';
  }
  return text;
}

// Mirrors extractTextFromPDF in src/lib/brokers/utils.ts.
async function extract(file) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const items = (await (await pdf.getPage(i)).getTextContent()).items;
    if (!items.length) continue;
    const LINE_TOL = 5;
    const byY = [...items].sort((a, b) => b.transform[5] - a.transform[5]);
    const rows = []; let cur = [], anchorY = byY[0].transform[5];
    for (const it of byY) {
      if (cur.length > 0 && Math.abs(it.transform[5] - anchorY) > LINE_TOL) { rows.push(cur); cur = []; anchorY = it.transform[5]; }
      cur.push(it);
    }
    if (cur.length) rows.push(cur);
    for (const r of rows) r.sort((a, b) => a.transform[4] - b.transform[4]);
    text += rows.map((r) => r.map((i2) => i2.str).join(' ') + ' ').join('\n') + '\n';
  }
  return text;
}

const FILES = {
  buy: 'C:/Users/Priti/Downloads/CNB_11_EQ_BSE_16Apr2026_60072941.pdf',
  sell: 'C:/Users/Priti/Downloads/New Contract.pdf',
};
const texts = {};
for (const [k, f] of Object.entries(FILES)) {
  if (fs.existsSync(f)) texts[k] = await extract(f);
  else console.log(`missing: ${f}`);
}
if (fs.existsSync(FILES.buy)) texts.scrambled = await extractOld(FILES.buy);

const stub = {
  name: 'stub-vite-only',
  setup(b) {
    b.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path, namespace: 'su' }));
    b.onLoad({ filter: /.*/, namespace: 'su' }, () => ({ contents: 'export default "stub://w";', loader: 'js' }));
    b.onResolve({ filter: /^pdfjs-dist$/ }, (a) => ({ path: a.path, namespace: 'sp' }));
    b.onLoad({ filter: /.*/, namespace: 'sp' }, () => ({
      contents: `export const GlobalWorkerOptions={workerSrc:''};export const getDocument=()=>{throw new Error('stub')};`, loader: 'js' }));
  },
};
const out = `${process.env.TEMP || ROOT}/.realparse.mjs`;
await esbuild.build({
  entryPoints: [`${ROOT}/tmp-realparse.ts`],
  bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: out,
  plugins: [stub], logLevel: 'warning',
  define: { __TEXTS__: JSON.stringify(texts) },
});
await import(pathToFileURL(out).href);
