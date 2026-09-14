// Bundles the per-stock opening-trades import test with esbuild, stubbing the browser-only
// imports stockOpeningImport pulls in through holdingsCalc (`gapi-script`, `pdfjs-dist`, and
// its `?url` worker asset) so the pure reader + FIFO merge can run under plain node.
// Same shape as tmp-transfer-run.mjs / tmp-pe-run.mjs.
import { pathToFileURL } from 'node:url';

const ROOT = 'c:/Users/Priti/Desktop/remix_-contract-note-analyzer';
const esbuild = await import(pathToFileURL(`${ROOT}/node_modules/esbuild/lib/main.js`).href);

const stubPlugin = {
  name: 'stub-browser-only',
  setup(build) {
    // gapi-script assigns to `window` at module scope; nothing under test touches it.
    build.onResolve({ filter: /^gapi-script$/ }, (a) => ({ path: a.path, namespace: 'stub-gapi' }));
    build.onLoad({ filter: /.*/, namespace: 'stub-gapi' }, () => ({
      contents: 'export const gapi = { client: {} };', loader: 'js',
    }));
    build.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path, namespace: 'stub-url' }));
    build.onLoad({ filter: /.*/, namespace: 'stub-url' }, () => ({
      contents: 'export default "stub://worker";', loader: 'js',
    }));
    build.onResolve({ filter: /^pdfjs-dist$/ }, (a) => ({ path: a.path, namespace: 'stub-pdfjs' }));
    build.onLoad({ filter: /.*/, namespace: 'stub-pdfjs' }, () => ({
      contents: `
        export const GlobalWorkerOptions = { workerSrc: '' };
        export const getDocument = () => { throw new Error('pdfjs stubbed in test'); };
      `, loader: 'js',
    }));
  },
};

// Emitted INSIDE the project (node_modules is already gitignored) rather than in TEMP: the
// externals below are resolved by node at runtime, and from TEMP the walk up never reaches
// this project's node_modules.
const out = `${ROOT}/node_modules/.cache/opening-import-bundle.mjs`;
await esbuild.build({
  entryPoints: [`${ROOT}/tmp-opening-import.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  plugins: [stubPlugin],
  // Resolved from node_modules at runtime rather than bundled: both are large, node-native,
  // and the round-trip fixture needs the REAL ones anyway.
  external: ['exceljs', 'xlsx'],
  logLevel: 'warning',
});

await import(pathToFileURL(out).href);
