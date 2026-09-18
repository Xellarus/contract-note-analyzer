// Bundles tmp-si-probe.ts with esbuild, stubbing the two Vite-only imports utils.ts pulls in
// (pdfjs-dist and its `?url` worker asset) so the pure parsing logic runs under plain node.
// Same shape as tmp-axis-run.mjs / tmp-nuvama-run.mjs.
//
//   node tmp-si-probe-run.mjs <note>.extracted.txt [more...]
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

const out = `${process.env.TEMP || ROOT}/.si-probe-bundle.mjs`;
await esbuild.build({
  entryPoints: [`${ROOT}/tmp-si-probe.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  plugins: [stubPlugin],
  logLevel: 'warning',
});

await import(pathToFileURL(out).href);
