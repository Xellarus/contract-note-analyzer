// Bundles the Nuvama parser test with esbuild, stubbing the two Vite-only imports
// that utils.ts pulls in (pdfjs-dist and its `?url` worker asset) so the pure
// parsing logic can run under plain node.
import { pathToFileURL } from 'node:url';

const ROOT = 'c:/Users/Priti/Desktop/remix_-contract-note-analyzer';
// This runner lives outside the project, so esbuild is loaded from the project's
// own node_modules by absolute path rather than by bare specifier.
const esbuild = await import(pathToFileURL(`${ROOT}/node_modules/esbuild/lib/main.js`).href);
const HERE = ROOT;

const stubPlugin = {
  name: 'stub-vite-only',
  setup(build) {
    // `import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'`
    build.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path, namespace: 'stub-url' }));
    build.onLoad({ filter: /.*/, namespace: 'stub-url' }, () => ({
      contents: 'export default "stub://worker";', loader: 'js',
    }));
    // The pdfjs library itself — only extractTextFromPDF touches it, and the test
    // never calls that; it feeds already-extracted text straight to parsePdfText.
    build.onResolve({ filter: /^pdfjs-dist$/ }, (a) => ({ path: a.path, namespace: 'stub-pdfjs' }));
    build.onLoad({ filter: /.*/, namespace: 'stub-pdfjs' }, () => ({
      contents: `
        export const GlobalWorkerOptions = { workerSrc: '' };
        export const getDocument = () => { throw new Error('pdfjs stubbed in test'); };
      `, loader: 'js',
    }));
  },
};

const out = `${process.env.TEMP || HERE}/.nuvama-bundle.mjs`;
await esbuild.build({
  entryPoints: [`${ROOT}/tmp-nuvama.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  plugins: [stubPlugin],
  logLevel: 'warning',
});

await import(pathToFileURL(out).href);
