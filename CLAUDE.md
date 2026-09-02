# CLAUDE.md

Indian stock-market **contract-note analyser and portfolio backoffice**. Parses broker contract
notes (PDF/HTML), rebuilds FIFO holdings, computes capital gains, and writes everything to
Google Sheets. React 19 + TypeScript + Vite SPA; Sheets is the database.

## Verify

```bash
npx tsc --noEmit      # also `npm run lint` — same thing
npx vite build
```

**A green build proves very little here.** `tsconfig` has **no `strict`**, no `noUnusedLocals`,
no `strictFunctionTypes`. Temporal-dead-zone faults, unused values and parameter-variance
mismatches all pass both commands. A `useMemo` calling a `const` declared below it typechecks,
builds, and then blanks the page at runtime. Read hook bodies for evaluation order by hand.

There is no CSS test of any kind, and no browser in the loop — anything visual needs `/run`.

## Test suites

28 `tmp-*` files at the repo root are the de-facto test suite. No npm script runs them.

| Command | Covers |
|---|---|
| `node tmp-pe-run.mjs` | Private Equities tab reader (27 assertions) |
| `node tmp-pe-fold-run.mjs` | PE fold-in to the scrip master, stubbed Sheets API (27) |
| `node tmp-pe-write-run.mjs` | Non-listed tab WRITES — registering a company on any class tab, and the CMP write-back with its overwrite guard (78) |
| `node tmp-trx-run.mjs` | Capital Gains register: both tabs, demerger restatement, asset-class refusal (61; 62 with `TRX_BASELINE` set) |
| `node tmp-holding-lastpx-run.mjs` | Valuing an unlisted holding at its last traded price — capture + resolver precedence (24) |
| `node tmp-nuvama-run.mjs` | Nuvama parser (159) |
| `npx tsx tmp-verify.ts` | Report renderers — writes a real PDF + XLSX and reads them back |
| `node tmp-xverify.mjs` | Cross-broker PDF extraction comparison |

The `.mjs` runners bundle with esbuild and **stub browser-only imports** (`gapi-script`,
`pdfjs-dist`, `?url` worker assets) because they cannot be imported under plain node ESM.
Five of them hardcode `const ROOT = 'c:/Users/Priti/Desktop/remix_-contract-note-analyzer'`;
that path must be edited on any other machine.

## Hard rules

- **Contract notes never leave the machine.** They carry PAN, address, holdings and full trade
  history. No PDF-unlock SaaS, no upload to any external service. `*.extracted.txt` is
  gitignored for the same reason. PDF passwords stay command-line arguments — never written to
  a file or echoed into output.
- **Update the Obsidian vault after shipping any change** — `C:\Users\Priti\Desktop\Backoffice`,
  `Changes/` and `Problems/` must stay accurate. It is internal-only and never goes in this repo.
- **Do not commit unless asked.**
- Explain the diagnosis and approach before writing code.

## Danger zones

**Theme.** `src/index.css` repaints **literal** Tailwind class names in two unlayered blocks
(`.dark` and `html:not(.dark)`). Consequences that have each bitten more than once:
an arbitrary variant like `[&_th]:bg-slate-50` is never repainted; a hover variant needs its own
entry or a control vanishes on hover; an opacity-suffixed light background (`bg-*-50/NN` at ≥40%)
must be remapped in dark or it washes out ivory text; and a shade outside 50/100…900/950 (e.g.
`text-slate-655`) generates **no CSS at all**, so it silently inherits and no remap can reach it.
Keep authoring indigo/slate classes — indigo *is* the brass accent before remapping; never
"modernise" it away. Run the `theme-check` skill after any styling change.

**Sheets writes.** Writers are header-aware — locate columns by header name, never by position.
Read dates as **serial numbers**, not display strings (mixed/US formats misparse). True Entry has
no ISIN column, so an unlisted holding's identity is its name. When a classification cannot be
made (e.g. the Private Equities tab failed to load), **refuse to write rather than guess** — an
unlisted sale held 12–24 months would otherwise land in the tax ledger as long-term, and nothing
downstream can detect it. Roughly 40 Sheets read sites still swallow their errors.

**Asset classes.** Three hand-maintained tabs of the shared scrip master name the non-listed
holdings — `Private Equities`, `AIF`, `Mutual Fund` — and `ASSET_CLASSES` in
`src/lib/privateEquities.ts` is the single registry of what each one means. PE and AIF are
off-market and long-term at 730 days; **Mutual Fund has `ltDays: null` on purpose**, because
equity-oriented is 12 months with STT, post-Apr-2023 debt is always short-term at slab, and
other/specified is 24. `ltDaysFor` therefore returns `number | null` and **with no
`strictNullChecks` a `days >= null` comparison compiles and coerces to `>= 0`, filing every such
sale as LONG TERM under a green build** — every caller needs an explicit null branch. The
capital-gains engines refuse those sales and report them in `unclassified`; the register's
charge-conservation guard must exclude their charges too, or it fires and no register writes at
all.

**Scrip resolution.** `extractIsin` (`src/lib/brokers/utils.ts`) is shared by every parser and its
regex **must** keep the trailing check digit (`IN[A-Z0-9]{9}[0-9]`) — without it, "INfrastructu"
inside a company name matches first. `normName` strips `limited|ltd|private|pvt|the|co`, so two
different companies can normalise identically. `lookupScrip` is read-only; `resolveScrip` mutates
the shared 90-second-cached master.

**Parsers.** Fixtures must come from `tmp-extract.mjs`, never hand-typed — reconciliation cannot
catch a self-consistent misparse. STT allocation goes through the shared `allocateStt`
(`src/lib/brokers/stt.ts`); the note's printed total is the anchor.

## Conventions

- Every date **shown** is `dd/mm/yyyy` via `formatDMY` (`src/lib/dates.ts`). Display only —
  inputs and exports are untouched.
- Cost basis is **FIFO**, shared through `replayFifoHoldings`.
- Keep cost-per-share and rates at full precision (r6); only money amounts round to paise.
- All portfolios live in `src/lib/portfolios.ts` — adding one is a single entry.
- UI primitives: `toast` / `confirmDialog` / `ModalShell` (never `alert` or `window.confirm`),
  and `useVirtualRows` for large tables.
- Holdings shows **real sheet data only** — ₹0 until synced, never placeholder numbers.

## Layout

- `src/lib/` — engines: `holdingsCalc`, `trxRegister`, `openingBasis`, `scripMaster`,
  `scripPrices`, `navTimeline`, `reportDoc` / `reportPdf` / `reportXlsx`, `brokers/`
- `src/components/` — `Holdings.tsx` is the largest (portfolio list + stock detail + trade book)
- `apps-script/` — Gmail-triggered auto-import (`.gs`); leave alone unless asked
- No router: `currentView` is plain state; browser Back is wired via `src/lib/appBack.ts`
