// Bundles the Capital Gains register test, stubbing `gapi-script` with a fake Sheets API.
// Same shape as tmp-pe-fold-run.mjs, with two additions the register needs:
//   • reads are keyed by `${spreadsheetId}::${range}` — TWO spreadsheets are in play (the
//     portfolio and the shared scrip master), and `firstSheetTitle` asks each for its own
//     tab list, so keying by range alone hands the master the portfolio's tabs.
//   • `spreadsheets.batchUpdate` exists — the register's formatting pass calls it, and the
//     original stub has none, so every run would die in the paint step.
import { pathToFileURL } from 'node:url';

const ROOT = 'c:/Users/Priti/Desktop/remix_-contract-note-analyzer';
const esbuild = await import(pathToFileURL(`${ROOT}/node_modules/esbuild/lib/main.js`).href);

const GAPI_STUB = [
  'const g = globalThis;',
  'const err = (code, message) => { const e = new Error(message); e.result = { error: { code, message } }; e.status = code; return e; };',
  'export const gapi = {',
  '  client: {',
  '    sheets: {',
  '      spreadsheets: {',
  '        get: async ({ spreadsheetId }) => {',
  '          const first = (g.__firstTab || {})[spreadsheetId];',
  '          const tabs = (g.__sheetTabs || {})[spreadsheetId] || (first ? [first] : ["Sheet1"]);',
  '          return { result: { sheets: tabs.map((t, i) => ({ properties: { title: t, sheetId: i } })) } };',
  '        },',
  '        batchUpdate: async (req) => {',
  '          (g.__batched = g.__batched || []).push(req);',
  '          // Honour addSheet/rename so the follow-up metadata read FINDS the tab and a',
  '          '+String.fromCharCode(47,47)+' real sheetId flows into the formatting pass. Without this the whole',
  '          '+String.fromCharCode(47,47)+' paint path - every colour band and number format - is never exercised.',
  '          const reqs = ((req.resource || {}).requests) || [];',
  '          for (const r of reqs) {',
  '            const list = (g.__sheetTabs = g.__sheetTabs || {});',
  '            const arr = (list[req.spreadsheetId] = list[req.spreadsheetId] || []);',
  '            if (r.addSheet) arr.push(r.addSheet.properties.title);',
  '            if (r.updateSheetProperties && r.updateSheetProperties.properties.title) {',
  '              const pr = r.updateSheetProperties.properties;',
  '              if (arr[pr.sheetId] !== undefined) arr[pr.sheetId] = pr.title;',
  '            }',
  '          }',
  '          return { result: { replies: [] } };',
  '        },',
  '        values: {',
  '          get: async ({ spreadsheetId, range }) => {',
  '            const k = spreadsheetId + "::" + range;',
  '            // A 500 is NOT the same as an absent tab: an absent tab is a cacheable',
  '            // answer, a 500 is what sets master.peFailed and blocks the write.',
  '            if ((g.__failRange || {})[k]) throw err(500, "Internal error");',
  '            const vals = (g.__ranges || {})[k];',
  '            if (vals === undefined) throw err(400, "Unable to parse range: " + range);',
  '            return { result: { values: vals } };',
  '          },',
  '          append: async (req) => { (g.__appended = g.__appended || []).push(req); return { result: {} }; },',
  '          update: async (req) => { (g.__updated = g.__updated || []).push(req); return { result: {} }; },',
  '          clear: async (req) => { (g.__cleared = g.__cleared || []).push(req); return { result: {} }; },',
  '        },',
  '      },',
  '    },',
  '  },',
  '};',
].join('\n');

const stubPlugin = {
  name: 'stub-gapi',
  setup(build) {
    build.onResolve({ filter: /^gapi-script$/ }, (a) => ({ path: a.path, namespace: 'stub-gapi' }));
    build.onLoad({ filter: /.*/, namespace: 'stub-gapi' }, () => ({ contents: GAPI_STUB, loader: 'js' }));
  },
};

const out = `${process.env.TEMP || ROOT}/.trx-bundle.mjs`;
await esbuild.build({
  entryPoints: [`${ROOT}/tmp-trx.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  plugins: [stubPlugin],
  logLevel: 'warning',
});

await import(pathToFileURL(out).href);
