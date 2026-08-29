// Bundles the Axis parser test with esbuild, stubbing the two Vite-only imports that
// utils.ts pulls in (pdfjs-dist and its `?url` worker asset) so the pure parsing logic
// can run under plain node. Same shape as tmp-nuvama-run.mjs.
import { pathToFileURL } from 'node:url';

const ROOT = 'c:/Users/Priti/Desktop/remix_-contract-note-analyzer';
const esbuild = await import(pathToFileURL(`${ROOT}/node_modules/esbuild/lib/main.js`).href);

const stubPlugin = {
  name: 'stub-vite-only',
  setup(build) {
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

const out = `${process.env.TEMP || ROOT}/.axis-bundle.mjs`;
await esbuild.build({
  entryPoints: [`${ROOT}/tmp-axis.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  plugins: [stubPlugin],
  logLevel: 'warning',
});

await import(pathToFileURL(out).href);
