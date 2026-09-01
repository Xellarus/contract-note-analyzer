// Bundles the FIFO lot-ordering test with esbuild, stubbing the browser-only imports
// holdingsCalc pulls in (`gapi-script`, `pdfjs-dist`, and its `?url` worker asset) so the
// pure replay logic can run under plain node. Same shape as tmp-pe-run.mjs / tmp-axis-run.mjs.
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

const out = `${process.env.TEMP || ROOT}/.transfer-bundle.mjs`;
await esbuild.build({
  entryPoints: [`${ROOT}/tmp-transfer.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  plugins: [stubPlugin],
  logLevel: 'warning',
});

await import(pathToFileURL(out).href);
