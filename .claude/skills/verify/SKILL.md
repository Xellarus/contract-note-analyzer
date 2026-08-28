---
name: verify
description: "Run this project's full verification ritual: typecheck, production build, and the five tmp-* test suites. Use after any code change, before reporting work as done, and whenever asked to check, test, verify or validate the app."
---

# Verify

This repo has no test runner and no `test` script. Verification is a fixed sequence that cannot
be discovered from `package.json`. Run it in order and stop at the first hard failure.

## 1. Typecheck and build

```bash
npx tsc --noEmit
npx vite build
```

Both must be clean. `npm run lint` is an alias for the first.

**Passing these two proves less than it looks like.** `tsconfig` has no `strict`, no
`noUnusedLocals` and no `strictFunctionTypes`, so all of the following compile and build fine:

- a `useMemo` / `useEffect` body calling a `const` declared **below** it — a temporal-dead-zone
  `ReferenceError` that blanks the page at runtime (this nearly shipped)
- a stale prop type after a rename
- unused values left behind by a partial edit

So after the build passes, **read the hook bodies you touched in declaration order** and confirm
nothing is referenced before it exists.

## 2. Test suites

Run whichever are relevant; run all of them before calling a change finished.

```bash
node tmp-pe-run.mjs        # Private Equities tab reader          — expect 27 passed
node tmp-pe-fold-run.mjs   # PE fold-in, stubbed Sheets API       — expect 27 passed
node tmp-nuvama-run.mjs    # Nuvama parser                        — expect 159 passed
npx tsx tmp-verify.ts      # report renderers                     — expect ALL CHECKS PASSED
node tmp-xverify.mjs       # cross-broker PDF extraction diff     — reports changed files
```

`tmp-xverify.mjs` compares extraction output across brokers and prints e.g.
`8 file(s) compared, 2 changed`. Changes there are **not** automatically failures — some are
intended extraction fixes. Read what changed before deciding.

### Why the runners look strange

The `.mjs` files bundle their `.ts` counterpart with esbuild and stub browser-only imports —
`gapi-script`, `pdfjs-dist`, and `?url` worker assets — because none of them import under plain
node ESM. Do not "simplify" a runner into a direct import; it will fail.

Five runners hardcode `const ROOT = 'c:/Users/Priti/Desktop/remix_-contract-note-analyzer'`.
On any other machine that line must be edited first.

## 3. Styling changes

`tsc` and the build validate **nothing** about CSS, and a Tailwind class naming a shade that does
not exist compiles to nothing at all while looking perfectly correct in the source. If the change
touched `className` strings or `src/index.css`, run the **`theme-check`** skill as well.

## 4. Anything visual

There is no browser in this loop. Focus rings, hover states, dark-mode rendering, native control
theming and layout width can only be confirmed by launching the app — use the `run` skill. Do not
report a visual change as verified on the strength of a clean build.

## Reporting

State what actually ran and what it returned. If a suite was skipped, say which and why. Never
describe a change as verified when only `tsc` and `vite build` were run — name those two
explicitly instead.
