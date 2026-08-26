// Bundles the Private Equities reader test with esbuild, stubbing `gapi-script` (a
// browser-only module that has no ESM `gapi` export under node) so the pure parsing
// logic can be exercised directly. Same shape as tmp-nuvama-run.mjs.
import { pathToFileURL } from 'node:url';

const ROOT = 'c:/Users/Priti/Desktop/remix_-contract-note-analyzer';
const esbuild = await import(pathToFileURL(`${ROOT}/node_modules/esbuild/lib/main.js`).href);

const stubPlugin = {
  name: 'stub-gapi',
  setup(build) {
    // Only the fetch path touches gapi; the parser under test never does.
    build.onResolve({ filter: /^gapi-script$/ }, (a) => ({ path: a.path, namespace: 'stub-gapi' }));
    build.onLoad({ filter: /.*/, namespace: 'stub-gapi' }, () => ({
      contents: `export const gapi = { client: {} };`, loader: 'js',
    }));
  },
};

const out = `${process.env.TEMP || ROOT}/.pe-bundle.mjs`;
await esbuild.build({
  entryPoints: [`${ROOT}/tmp-pe.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  plugins: [stubPlugin],
  logLevel: 'warning',
});

await import(pathToFileURL(out).href);
