// Bundles the Private Equities WRITER test, stubbing `gapi-script` with a fake Sheets API.
//
// Two differences from tmp-pe-fold-run.mjs's stub, both required here:
//  - reads are keyed by `${spreadsheetId}::${range}`, because the master's first tab and the
//    Private Equities tab live in the same spreadsheet and both are read in one flow;
//  - both `spreadsheets.batchUpdate` (create-the-tab) and `values.batchUpdate` (the CMP
//    write-back) exist and record their requests, so neither path is stubbed out; note they
//    are DIFFERENT methods at different nesting levels and both land in `g.__batched`, which
//    is why the CMP assertions filter on `resource.data`.
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
  '        get: async () => ({ result: { sheets: (g.__sheetTabs || ["Sheet1"]).map((t, i) => ({ properties: { title: t, sheetId: i } })) } }),',
  '        batchUpdate: async (req) => { (g.__batched = g.__batched || []).push(req); return { result: {} }; },',
  '        values: {',
  '          get: async ({ spreadsheetId, range }) => {',
  '            const key = spreadsheetId + "::" + range;',
  '            if (g.__failRange && key === g.__failRange) throw err(500, "Internal error");',
  '            if (g.__missingRange && key === g.__missingRange) throw err(400, "Unable to parse range: " + range);',
  '            const vals = (g.__ranges || {})[key];',
  '            if (vals === undefined) throw err(400, "Unable to parse range: " + range);',
  '            return { result: { values: vals } };',
  '          },',
  '          batchUpdate: async (req) => { (g.__batched = g.__batched || []).push(req); return { result: {} }; },',
  '          append: async (req) => { (g.__appended = g.__appended || []).push(req); return { result: {} }; },',
  '          update: async (req) => { (g.__updated = g.__updated || []).push(req); return { result: {} }; },',
  '          clear: async () => ({ result: {} }),',
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

const out = `${process.env.TEMP || ROOT}/.pe-write-bundle.mjs`;
await esbuild.build({
  entryPoints: [`${ROOT}/tmp-pe-write.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  plugins: [stubPlugin],
  logLevel: 'warning',
});

await import(pathToFileURL(out).href);
