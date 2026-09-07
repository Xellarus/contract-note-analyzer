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
| `node tmp-pe-write-run.mjs` | Non-listed tab WRITES — registering a company on any class tab, and the CMP write-back with its overwrite guard (84) |
| `node tmp-trx-run.mjs` | Capital Gains register: per-class tabs, transaction statements, demerger restatement, asset-class refusal (110; 111 with `TRX_BASELINE` set) |
| `node tmp-holding-lastpx-run.mjs` | Valuing an unlisted holding at its last traded price — capture + resolver precedence (24) |
| `node tmp-nuvama-run.mjs` | Nuvama parser (159) |
| `node tmp-holdings-sort.mjs` | Sort order: the holdings grid (default biggest-first, click direction, tiebreaks) **and** the Portfolios page cards, incl. a guard that `PORTFOLIOS` is never sorted in place (19). Reads the comparators OUT of `Holdings.tsx`, so it fails if the source drifts — and needs no `ROOT` edit |
| `node tmp-transfer-run.mjs` | Cross-portfolio transfer: FIFO, cost carryover, no gain realised (83) |
| `node tmp-axis-run.mjs` | Axis Securities parser (68) |
| `npx tsx tmp-import-tab.ts` | Import Log rows + SPA back-navigation — reads the portfolio registry, so a label change breaks it |
| `npx tsx tmp-factsheet.ts` | Factsheet model + PDF (writes `verify-factsheet.pdf`) |
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

**The register's output tabs.** `generateTrxRegister` writes **one capital-gains tab per asset
class** — `Capital Gains for FY..` is **LISTED ONLY**; PE and AIF each get
`<Label> Capital Gains for FY..`; every non-listed class with FY activity also gets
`<Label> Transactions for FY..`. Mutual Fund and Bond get a transaction statement but **no**
gains tab (no holding-period rule). A sale appears on exactly **one** tab — non-listed classes
MOVED off the main tab rather than being copied, because two tabs carrying one gain is a double
count nothing downstream can detect.

Two rules that follow from that, and both have already broken the whole register once:

- **The charge-conservation guard must span EVERY capital-gains tab** (`cgGrand`). It throws
  rather than writing, so a tab left out of that sum makes its charges look missing and **no
  register writes at all**.
- **The transaction statements must stay OUT of that sum** — they restate the same charges as a
  record of what was transacted, so counting them doubles every figure.
- A no-rule scrip must be kept off the gains tabs **wholly, purchases included**, and excluded
  from `expect` on the **same class test** (`keyHasLtRule`). Keying the exclusion on "did it
  sell" instead meant a fund bought *and* sold inside one FY emitted a purchase row whose
  charges nothing expected — the guard fired and produced no register. Fixture E pins it; a
  fixture that buys pre-FY cannot reach it.

The transaction statement is built from the parsed `trades`, **not** from the capital-gains
blocks: a no-rule sale never reaches `Block.sales`, so a block-derived statement would silently
omit every mutual-fund and bond sale — the rows those tabs exist to surface.

**Sheets writes.** Writers are header-aware — locate columns by header name, never by position.
Read dates as **serial numbers**, not display strings (mixed/US formats misparse). True Entry has
no ISIN column, so an unlisted holding's identity is its name. When a classification cannot be
made (e.g. the Private Equities tab failed to load), **refuse to write rather than guess** — an
unlisted sale held 12–24 months would otherwise land in the tax ledger as long-term, and nothing
downstream can detect it. Roughly 40 Sheets read sites still swallow their errors.

**Asset classes.** Four hand-maintained tabs of the shared scrip master name the non-listed
holdings — `Private Equities`, `AIF`, `Mutual Fund`, `Bonds` — and `ASSET_CLASSES` in
`src/lib/privateEquities.ts` is the single registry of what each one means. Adding a class is
**one entry**: the segment toggle, report scopes, badges, the register-a-company buttons, the
fold-in loop and the writer all derive from `ASSET_CLASS_IDS`. PE and AIF are off-market and
long-term at 730 days; **Mutual Fund and Bond both have `ltDays: null` on purpose** — for MF
because equity-oriented is 12 months with STT, post-Apr-2023 debt is always short-term at slab
and other/specified is 24; for Bond because a listed bond is 12 months but an unlisted bond or
debenture transferred on/after 23-Jul-2024 is **always** short-term at slab under s.50AA, so no
single day count is right. The bond rule is a **deliberately open decision**, not an oversight.
`ltDaysFor` therefore returns `number | null` and **with no `strictNullChecks` a `days >= null`
comparison compiles and coerces to `>= 0`, filing every such sale as LONG TERM under a green
build** — every caller needs an explicit null branch. The capital-gains engines refuse those
sales and report them in `unclassified`; the register's charge-conservation guard must exclude
their charges too, or it fires and no register writes at all.

`offMarket` is **false** for MF and Bond: it only ever *offers* the charge boxes, and forcing it
true would zero real exchange charges out of a cost basis with nothing downstream able to detect
it. Note `updatePrivateEquityCmp` still reads and writes **only** the Private Equities tab, so an
AIF / MF / Bond CMP cannot be saved from inside the app — it fails safe (never the wrong tab) and
Holdings now says which tab to type it into, but the price must go in the sheet by hand.

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
