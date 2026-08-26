// Bundles the Private Equities fold-in test, stubbing `gapi-script` with a fake Sheets API
// driven by globals the test sets (__ranges / __failRange / __missingRange / __appended).
// Same shape as tmp-nuvama-run.mjs.
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
  '        values: {',
  '          get: async ({ range }) => {',
  '            if (g.__failRange && range === g.__failRange) throw err(500, "Internal error");',
  '            if (g.__missingRange && range === g.__missingRange) throw err(400, "Unable to parse range: " + range);',
  '            const vals = (g.__ranges || {})[range];',
  '            if (vals === undefined) throw err(400, "Unable to parse range: " + range);',
  '            return { result: { values: vals } };',
  '          },',
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

const out = `${process.env.TEMP || ROOT}/.pe-fold-bundle.mjs`;
await esbuild.build({
  entryPoints: [`${ROOT}/tmp-pe-fold.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  plugins: [stubPlugin],
  logLevel: 'warning',
});

await import(pathToFileURL(out).href);
