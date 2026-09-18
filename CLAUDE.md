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
| `node tmp-pe-run.mjs` | Private Equities tab reader, incl. the PAN / Face Value / Type Of Company columns and the two header collisions they create (49 assertions) |
| `node tmp-pe-fold-run.mjs` | PE fold-in to the scrip master, stubbed Sheets API — plus the **request count** of a master load, the tab-list-is-not-an-authority rule, the batch-failure fallback, the `PVT.LTD.` name shape, the listed-as-PE/resolves-as-PE invariant, the **ticker-collision record** that stops a dropped class being silent, and SOURCE checks that Add Trade refreshes the page's master on save, FORCES a fresh one on open, names the collision instead of telling the owner to add the company again, and that the unlisted dropdown neither truncates its list nor truncates it silently, and the LISTED/UNLISTED TWIN rules — including that the twin gets its OWN `key`, which is what stops two companies sharing one holding bucket (105) |
| `node tmp-pe-write-run.mjs` | Non-listed tab WRITES — registering a company on any class tab, and the CMP write-back with its overwrite guard (85). Round-trips the header the writer CREATES back through the reader, so the two can never disagree |
| `node tmp-trx-run.mjs` | Capital Gains register: per-class tabs, transaction statements, demerger restatement, asset-class refusal, the "STT Removed" flag, and that the sheet-WRITING engines force a fresh master read while the read-only hot paths do not, fixture H's REAL no-ISIN ledger header, and fixture J's merger/demerger holding-period carry-over plus `carryLots` head-on, and fixture K's bonus re-derivation with `parseRatio`/`freeSharesFor`, and fixtures L/L2/L3 — the **three-way holding split**, an empty class still writing its tab, the legacy holding tab being RENAMED rather than orphaned, and PAN / Face Value / Type Of Company reaching the PE statement from the scrip master, and fixture M — the ITR schedule end to end: which blocks reach it, an exited company, a same-day round trip, the canonical-name rule and the RAW write (270; 271 with `TRX_BASELINE` set). `STT_DEBUG=1` dumps the cell-by-cell diff fixture G asserts on |
| `node tmp-holding-lastpx-run.mjs` | Valuing an unlisted holding at its last traded price — capture + resolver precedence, plus the listed/unlisted TWIN crossover in BOTH price maps and in both directions, and the first coverage `makeExceptionResolver` has ever had (37) |
| `node tmp-nuvama-run.mjs` | Nuvama parser (159) |
| `node tmp-yahoo-symbols.mjs` | Price-script symbol resolution — runs the REAL `YahooPriceUpdate.gs` functions in a `vm` sandbox with Apps Script stubbed: ISIN / name / alias / **ticker** matching, the truncated-prefix rule and its ambiguity refusal, canonical-beats-alias in either row order, the override table, NSE-primary-BSE-fallback, and that the `?sym=` probe reports the rule that actually fired (34). Several cases run with `SYMBOL_OVERRIDES` **emptied**, so they prove the general path rather than a hand-listed entry |
| `node tmp-holdings-sort.mjs` | Sort order: the holdings grid (default biggest-first, click direction, tiebreaks) **and** the Portfolios page cards, incl. a guard that `PORTFOLIOS` is never sorted in place (19). Reads the comparators OUT of `Holdings.tsx`, so it fails if the source drifts — and needs no `ROOT` edit |
| `node tmp-transfer-run.mjs` | Cross-portfolio transfer: FIFO, cost carryover, no gain realised (83) |
| `node tmp-opening-import-run.mjs` | Per-stock opening-trades import: header detection (incl. the template's own Instructions tab NOT matching, and a bare `Amount` never adopted as turnover), Excel date serials, the foreign-security rejection, the duplicate guard (ONE existing row masks ONE incoming row, not all of them), the FIFO-order warning, the **additive merge**, and the **corp-action credit** — plus fixture H, which BUILDS the shipped .xlsx template and reads it straight back through the shipped reader, and fixture J, the owner's real NSE shape, whose right and wrong answers are DISJOINT (96,000 shares versus 0) and whose same-day variant separates the two COST bases (107) |
| `node tmp-axis-run.mjs` | Axis Securities parser (68) |
| `npx tsx tmp-session-clock.ts` | Session clock: the urgency ramp (monotonic, clamped, boundaries), the countdown text, the gradient stops, and that the countdown uses the same 60s safety margin `hasValidGoogleToken` does (36) |
| `npx tsx tmp-shortcuts.ts` | Keyboard shortcuts: registry invariants, the typing/modifier guards driven through the real handler, and source checks that the App `run` switch and the `?` overlay match the registry, plus that `q` calls `goBack()` and never `history.back()` (44) |
| `npx tsx tmp-rownav.ts` | Row/list navigation: the key mapping and its clamping, the keys it must NOT claim (**Tab above all** — claiming it would trap the user in the table), and per-consumer wiring checks incl. the one-hook-one-`containerRef` invariant (51) |
| `npx tsx tmp-itr.ts` | The ITR **unlisted equity shares** schedule builder — layout, the row rule, blank-vs-zero in all four places, the per-row footing identity, acquisition grouping, the TOTAL row's column set, and the diagnostics. Most fixtures are REAL companies and REAL figures out of the owner's own filed FY2024-25 return, so it checks against a filed page rather than against its own idea of the answer (117) |
| `npx tsx tmp-date-input.ts` | **Native input affordances that alter a figure behind the author's back** — nothing else in the repo can see any of it. Controlled `<input type="date">`: the lifecycle of `dateInputValue` (above all, that a HALF-TYPED date renders empty), the SIX-DIGIT-YEAR guard, and a source sweep over comment-stripped source asserting that no date input falls back to a non-empty `value`, that every one of them carries a `max` and an `isDateInputSane` guard, and that a zero price or amount is saveable but warned about. Section F covers `<input type="number">`: that BOTH halves of the spinner removal are in `index.css` (webkit pseudo-element and Firefox `appearance`), that the rule is UNLAYERED, that no component re-declares it as an arbitrary variant, and the whole wheel guard — passive, blur-not-preventDefault, focused-element-only, and zero `onBlur` on any number input (50) |
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

**theme-check's reach, and what it still cannot see.** It scans `className=` attributes AND any
string/template literal whose tokens look like colour utilities — the second pass exists because
classes assembled in a `const` and passed as `className={shell}` were previously **invisible**,
and two unremapped classes shipped that way under a clean "0 findings". Comments are stripped
first (a backticked class name in prose used to be reported as real markup, which is worse than
silence — it manufactures confidence).

**Prove it sees your file before trusting a 0.** Inject a known-unremapped class (`bg-amber-50/80`
has no dark entry) into the exact expression you care about and confirm the checker names that
line. Twice this session a "0" meant "not scanned".

Remaining gap: there is **no category for an unremapped border colour**. `border-amber-300` has
no dark entry and the checker says nothing — borders were the source of an earlier regression
where fills got dark and hairlines became the loudest thing on screen.

**The register's output tabs.** `generateTrxRegister` writes **one capital-gains tab per asset
class** — `Capital Gains for FY..` is **LISTED ONLY**; PE and AIF each get
`<Label> Capital Gains for FY..`; every non-listed class with FY activity also gets
`<Label> Transactions for FY..`. Mutual Fund and Bond get a transaction statement but **no**
gains tab (no holding-period rule). A sale appears on exactly **one** tab — non-listed classes
MOVED off the main tab rather than being copied, because two tabs carrying one gain is a double
count nothing downstream can detect.

**The FY-end holding statement is THREE tabs per FY** (changed 14-Sep-2026), split the same way
the capital-gains tabs are and for the same reason — PE is off-market, long-term at 730 days and
bears no STT, so a preparer cannot separate it out of a commingled table:

- `Holding Equity+Intraday as on 31st March <y>` — **listed only**. There is no such thing as an
  intraday HOLDING: a same-day round trip is squared off and leaves no closing stock. The tab is
  named for the book both trade kinds live in, not for a second kind of holding.
- `Holding Private Equity Only as on 31st March <y>` — the PE class alone.
- `Holding Combined as on 31st March <y>` — every class. This is what the single tab always was,
  so the old `Holding as on 31st March <y>` is **RENAMED** into it, never left standing: an
  orphaned commingled tab beside the new three is last run's numbers under a heading that still
  looks current. Same legacy-rename mechanism as the Transaction Ledger tab; fixture L3 pins it.

**The PE statement carries three COMPANY columns; the other two carry none** (added
14-Sep-2026): `PAN`, `FACE VALUE` and `TYPE OF COMPANY`. All three come off the
**Private Equities** tab of the shared scrip master — hand-maintained like the rest of it — and
sit immediately after `SCRIPT NAME`, on the company's own identity row, never repeated down its
per-date lot rows. A missing face value prints BLANK, not 0.00: zero is not a fact about a
company, it is the absence of one.

- **Column geometry is a function of the tab, not a constant.** `geom(withCompanyCols)` builds `HC`/`HW`
  and the header row together, and everything downstream — the painting included — is written in
  terms of them, so there is no second set of indices to drift. The three columns shift `AMOUNT`
  from F to I on that tab alone. Anything reading these tabs positionally must read by HEADER;
  the suite's own `holdTotal` had to be changed to do that, and would otherwise have compared
  two different columns and called it a reconciliation.
- **Not on the equity or combined tabs**: blank for every listed scrip is noise in a filed
  document, and they would shift those tabs' columns for nothing.
- **Header-match ORDER is load-bearing, and this one tab has now hit it five times.** `PAN` and
  `Type Of Company` must be tested BEFORE the company test — both contain "company"
  (`Company PAN`, `Type Of Company`) and would otherwise be claimed as the NAME column, making
  every row's identity a PAN or the word "LLP". `Face Value` must be tested BEFORE the valuation
  test: **`Face Value Per Share` contains `value per`**, so the valuation test claims it and
  every unlisted holding is priced at its face value — ₹10 a share, with the column looking
  correctly filled in the whole time. `PAN` is anchored `pan` so `Expansion Plan` cannot
  match. Same shape as `Valuation Date` vs `Valuation` and the scrip master's `Tally Name`,
  which is why each test now carries its reason beside it.
- `PE_HEADER` in `privateEquityWrite.ts` (the header the app writes when it CREATES the tab)
  gained all three too, and `tmp-pe-write-run.mjs` round-trips that row back through
  `detectPeColumns` — a header the reader cannot map fails there rather than on a live sheet.
  Its appended data row is padded to the sheet's own width, so a new column never leaves the
  row short of it.
- PAN is **passed through, not validated** (trimmed and upper-cased only). This is a display
  field on a statement; rejecting an unfamiliar shape would blank a PAN entered correctly.
  `Type Of Company` is trimmed and NOT upper-cased — it is prose and the sheet's capitalisation
  is the owner's. It holds **Domestic / Foreign** (confirmed 14-Sep-2026), not a legal form: it
  IS column C of the ITR schedule below. Nothing validates it, so an unexpected value prints as
  typed rather than being blanked. `Face Value` is a number, 0 ⇒ absent, exactly as `Valuation` already works.

**The ITR unlisted-equity-shares schedule** (added 15-Sep-2026). `Unlisted Equity Shares for
FY<yy-yy>`, written by the same register run, beside the holding tabs. This is **why** PAN,
Face Value and Type Of Company went onto the Private Equities tab: they are columns D, I and C
of the ITR-2/3 schedule *"Details of Unlisted Equity Shares held at any time during the previous
year"*. `src/lib/itrUnlistedSchedule.ts` is a PURE builder (no `gapi`), so the layout is testable
without Sheets; `trxRegister.ts` assembles its inputs and writes the tab.

The layout is copied from the owner's own FILED FY2024-25 return, and several of its conventions
contradict how the rest of this app prints things. **On this tab the filed file wins.**

- **ONE ROW PER ACQUISITION, and CLOSING IS PER ROW.** The filed file proves it: `9M India Ltd`
  occupies two rows carrying closing balances of 18,000 and 12,000, not 30,000 and a blank. The
  company's real position is the SUM of its rows, which is what makes the schedule's own
  `=SUM(N5:N57)` mean anything. Each row foots on its own —
  `closing(row) = opening(row) + acquired(row) - transferred(row)` — with the opening on the
  first row and **the transfer allocated OLDEST-FIRST** (the order FIFO consumes lots in). Pin
  the transfer to row 1 instead and a company that sold more than its opening plus first
  purchase prints a NEGATIVE closing balance on a filed page. The filed file cannot distinguish
  the two schemes: no company in it has both an opening balance and more than one acquisition.
- **Blank versus zero, four ways, and the file is not self-consistent.** BLANK where the fact
  does not exist: E/F for a company first bought during the year (**the commonest case** — an
  empty lot list sums to 0, and a filed 0.00 asserts it was held on 1-Apr at nil cost), G/H with
  no acquisition, L/M with no transfer, N/O at nil — and O alone when the survivors are bonus
  shares. ZERO where the filed file prints zero: I/J/K on a row with no acquisition. That last
  one is the deliberate divergence from the PE holding statement, which blanks a missing face
  value.
- **Source `blocks` DIRECTLY — never `heldAll` / `heldPe`.** Both filter `closing.length > 0`,
  and a company SOLD OUT during the year is exactly what "held at any time" means. Fixture M's
  ORION pins it.
- **Fold in `intraBlocks`, and this one is invisible.** The same-day matcher groups purely on
  `key|ts` with **no asset-class and no intraday-flag test**, then removes the whole day's rows
  for that scrip from the delivery replay. An unlisted company bought and sold on one date — an
  off-market secondary settled same-day — loses its acquisition row AND its transfer row while
  opening and closing stay untouched, so the row still FOOTS with a year's activity missing from
  it. The builder reads both maps; the matcher is left alone because changing it would move
  capital-gains figures. Fixture M's VERTEX pins it.
- **Written RAW, not USER_ENTERED.** Column H is dd/mm/yyyy TEXT, and under USER_ENTERED Sheets
  reparses any such string whose day is 12 or less as US mm-dd and stores a swapped serial —
  `04/10/2024` would file as 10-Apr. Almost every date in the owner's filed copy is one of these.
- **Indian digit grouping**, like every other tab here. The filed .xlsx stores the WESTERN
  built-ins and only RENDERS 25,74,000.00 because that machine's Excel is set to India; copied
  verbatim into Sheets it reads 2,574,000.00.
- **The name is `canonicalName`, never `Block.name`** — that one is the LONGEST ledger/broker
  spelling, which on an unlisted company is whatever the counterparty's paperwork said.
- **TOTAL is written as VALUES, not `=SUM()`.** The register has never written a cell formula,
  and a formula with no cached result reads back as `undefined` through a workbook reader — a
  broken total row would then pass a round-trip test as an empty one.
- **It is a SIBLING of the three holding tabs, not a fourth `variants` entry.** `geom()`
  parameterises columns, but every row index in that paint pass is a shared constant
  (`bold(0,3)`, the fill bands, `numFmt(startRowIndex: 3)`, `frozenRowCount: 3`) and this tab has
  banners on rows 1-2, its header on row 4 and data from row 5. It still shares the single
  `spreadsheets.get` and the single paint `batchUpdate`, which is the part that costs quota.
  `mergeCells` is issued **nowhere else** against the Sheets API in this app — each banner is
  unmerged before it is merged, because the whole paint is ONE request and a rejection would
  strip the formatting off all four tabs at once.

Three things it deliberately does not do, each an owner decision taken with the consequence
stated:

- **Column K is 0 on every row.** Nothing records whether a purchase was a fresh issue or came
  from an existing shareholder — `ledgerSide` collapses RIGHT / IPO / SUBSCRIB / ALLOT into
  "BUY", and a private placement is entered as a plain Buy. The owner's filed return puts every
  acquisition in J and leaves K at 0.00 on all 53 rows, so that is reproduced exactly. Recording
  the distinction needs a ledger column, not a guess.
- **Cost of acquisition is charge-free turnover**, the basis every gain in this app is computed
  on, so the schedule reconciles to the capital-gains tabs. For off-market PE the two bases
  coincide (the owner's filed figures are exact `qty x rate` products), but a PE lot that DOES
  carry a charge is counted and named rather than absorbed.
- **The Private Equities tab is assumed to hold EQUITY SHARES only** (confirmed by the owner,
  14-Sep-2026). An LLP capital contribution, a preference share or an unlisted debenture parked
  there would be filed on this schedule, and nothing in the data model could tell.

Every way this tab can be wrong is silent ON the tab, so `TrxRegisterResult` carries
`itrCompanies`, `itrMissingPan` and `itrUnfooted`, all three on the register badge — same
discipline as the STT pair. `0 companies` against a book that holds unlisted shares means the
Private Equities tab went unread or nothing resolved, NOT that nothing was held.

**AIF / Mutual Fund / Bond holdings are on Combined and NOWHERE ELSE** — the owner's decision
(2026-09-14), taken with the consequence stated. So `Equity + PE` does **not** foot to `Combined`
whenever the book holds one. Combined therefore PRINTS the shortfall under its grand total,
naming the count and the classes; an unexplained difference between two filed statements is the
thing nobody can debug six months later. Fixture L asserts the note fires, names `1 holding(s) in
AIF`, and is absent from the two partial tabs.

Three more rules here, each a way to get it silently wrong:

- **All three are written every run, even empty**, exactly as the intraday tab is. A tab skipped
  because its class is empty keeps LAST year's figures under THIS year's heading. An empty one
  says *"Nothing held under this heading"* rather than showing bare column headers, which reads
  as a failed run. Fixture L2.
- **`gTot` is local to each tab's build.** A shared accumulator would add Combined's total onto
  Equity's — the same trap `emitTab` carries its own `grand` per call to avoid.
- **One metadata read and one formatting `batchUpdate` for all three.** The single-tab version did
  a `spreadsheets.get` per tab; three of those sit inside the app's heaviest operation against a
  60-read-per-minute quota that nothing counts. A `batchUpdate` request carries its own `sheetId`,
  so three paints never need three calls.

These tabs reach **no** charge into `cgGrand`. Like the transaction statements they record what is
HELD, not an expense claim, so splitting them cannot move the conservation guard.

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

**Google's Sheets quota is 60 READ REQUESTS PER MINUTE PER USER, and nothing counts them.**
Crossing it does not merely error: the backoff sleeps 1.2s, 2.4s, 3.6s… so the app gets slower
exactly when it is already struggling, the user reloads, and the reload spends another 60.

The trap is that **adding a feature can add a request to a hot path invisibly**. `loadScripMaster`
looped `ASSET_CLASS_IDS` and `await`ed one `values.get` per class: one request when only Private
Equities existed, **four** once AIF, Mutual Fund and Bonds were added — serially, from 29 call
sites, 11 of which pass `force: true` and skip the 90s cache. That alone produced
"quota exceeded" plus two-minute AUM loads.

- **`values.batchGet` reads many ranges from ONE spreadsheet in ONE request** and counts as one.
  The class tabs now go in a single batch. `tmp-pe-fold-run.mjs` **counts the requests**, because
  a regression here is invisible to every other kind of test.
- **`batchGet` cannot cross spreadsheets.** The 13 portfolios are 13 separate spreadsheets, so
  the 13-way fan-outs (`Holdings.tsx` `fetchPortfolioTotal`, `crossHoldings`, `navTimeline`)
  cannot be batched away — only coalesced or throttled, which is not done yet.
- **ONE bad range rejects an ENTIRE batchGet**, so a tab that may not exist must never enter
  `ranges`. The tab list from `spreadsheets.get` keeps it out.
- **That tab list is an OPTIMISATION, NEVER AN AUTHORITY.** It may move a tab onto the fast path;
  it may not conclude a tab is empty. Treating "not listed" as "no rows" seeds the class empty
  with no request at all — turning PE holdings into ordinary listed equities, filing their gains
  as LISTED, and setting no `peFailed` for anyone to notice. Asking is self-verifying: the answer
  comes from the same request that would have returned the data. Asserted in the suite.
- **A failed batch falls back to per-class reads**, because one batch means one failure loses all
  four, and an AIF tab that 500s must not stop Private Equities folding in.
- `invalidateScripCache()` clears the tab list too — otherwise a newly created tab stays invisible.
- Only **3 of 58** read sites have any backoff at all, and ~40 swallow their errors.

**The 90s master cache is WRONG for a sheet-writing action, and that is not a quota question.**
The master carries **hand-maintained** classification — the asset-class tabs, `Price Exception`,
`STT Removed`, aliases — and the owner's workflow is literally *edit the sheet, then click the
button*. The read-only hot paths keep the cache warm, so an unforced read inside a write action
returns the master **as it was before the edit**, writes the tab from it, and looks exactly like
the feature being broken. It is how the first "STT Removed" run came out with STT still on the
tab, and it is a second, independent reason a scrip-master fix appears to do nothing after
Rebuild Holding. `generateTrxRegister`, `rebuildHoldingTab` and `syncCapitalGains` therefore pass
`{ force: true }`; `computeAum`, `computeIndustryAllocation` and `computeHoldingsAsOf` must NOT —
they fan out over 13 spreadsheets and forcing them is the doom loop again. Both directions are
asserted in `tmp-trx-run.mjs`, and both were probed by injecting the opposite.

**"STT Removed" (scrip master column).** A truthy cell (`x` / `yes` / `1` / ✓) suppresses STT in
the nine-column charge block on the capital-gains tabs — marked for ETFs.

**It changes no gain, and cannot.** Every capital-gains figure in this app is computed on
TURNOVER, which is charge-free: `gain = sale turnover − purchase turnover` in the register
(`trxRegister.ts`, delivery and intraday alike) and `saleAmt − acqCost` in `holdingsCalc`. No
charge of any kind has ever entered a P/L. The flag exists because the charge block *reads* as
"expenses claimed against this gain", and under **s.48 STT is not a deductible expense** — so
listing it there states a claim nobody is making. Fixture G proves the point by running one
fixture twice and diffing: flipping the flag moves the STT column and the expenses total, by the
same amount, and **nothing else**.

**The suite's True Entry header is NOT the app's.** Every fixture but H feeds a ledger whose
header carries `ISIN`; the real one, written by `manualTrades.ts` `DEFAULT_HEADER` and `App.tsx`,
does **not** — it is read as `ci("ISIN", -1)`. So the suite exercised `lookupScrip`'s ISIN-first
branch while production runs the **name-only** one: the classic shape of a suite that stays green
while the app fails. **Fixture H** pins the flag on the real header with the owner's own master
row and figures, plus a control that clears the flag and asserts STT comes BACK — without that
control the fixture would pass just as happily if nothing were emitted at all.

**The flag fails SILENTLY, so the register reports itself.** A tab that still shows STT looks
identical whether the master was never read, the scrip never matched, or the tab on screen is not
one this run wrote. `TrxRegisterResult` therefore carries `sttFlaggedInMaster` (entries carrying
the flag in the master AS THIS RUN LOADED IT) and `sttSuppressed` (the scrips actually blanked),
both surfaced on the register badge and its tooltip in `Holdings.tsx` (authored in violet, which
the theme repaints BRASS — describing it to the owner as "the violet badge" cost a round trip). `0 flagged` means the column
was never read and the lookup is not even in question; `flagged > 0` with nothing suppressed means
it was read and the scrip did not match; no STT line at all means the browser is on an **older
bundle**. Fixture G asserts both numbers in both directions — a diagnostic that lies is worse than
none, because it sends the next session down the wrong branch.

**Confirmed working on the live sheet, 11-Sep-2026** — the badge read `STT off` and STT left the
capital-gains tab. The cause of the three failed attempts was a **stale browser bundle**: the
suppression had been correct in source since the first attempt, and the only behavioural change
between "still showing STT" and "gone" was a hard reload (the diagnostic itself alters nothing).
The lesson is the ordering: **before debugging a feature that tests green, establish that the
running page is the code you edited.** Nothing above was wasted — the forced master read and the
batched class-tab read are real fixes — but all three diagnoses were of a bug that was not there.

Everything on a gains tab goes through `cgCharges(key, c)`, **including the conservation guard's
`expect`** — same discipline as `keyHasLtRule`. Drop a charge from the tabs without dropping it
from what is expected on them and the guard sees drift and writes **no register at all**. The
transaction and holding statements deliberately do NOT go through it: they are a record of what
was transacted, they are not in the guard's sum, and they must still tie to the contract note.

**A merger / demerger CARRIES the parent's holding period** (changed 12-Sep-2026). s.2(42A)
Explanation 1(i)(g) includes the period the demerged company's shares were held in the resulting
company's shares; 1(i)(b) does the same for an amalgamated Indian company under s.47(vii). Both
engines used to stamp the ACTION date, so a long-term parent's spin-off was filed SHORT term —
slab instead of 12.5%. `corporateActions.ts` documented that as intended; it was wrong.

`carryLots` (`holdingsCalc.ts`) is the ONE shared apportionment, called from all four replay
sites: `replayFifoHoldings` (Holding tab / as-of report), `applyMergerFifo` + `applyDemergerFifo`
(`syncCapitalGains` → LTST), and the register's `ev.kind === "ca"` branch. Rules, each of which
is a way to get it silently wrong:

- **Quantity splits by QUANTITY, cost by BASIS SURRENDERED.** Different weights on purpose: a
  parent holding 100 @ 10 and 100 @ 90 gives up ten times more basis from the expensive lot while
  both earn the same shares, so a uniform per-share rate would migrate basis between the
  long- and short-term parcels — the exact split this change exists to fix.
- **Whole shares.** Every qty column is formatted `INT`, so 166.667 PRINTS as 167 and three of
  them foot to 501 under a subtotal of 500. Integer `sharesIn` is allocated by largest remainder;
  the last parcel takes the residual so the totals are exact by construction, not by float luck.
- **Snapshot the weights BEFORE the branch that destroys them.** A merger zeroes `remaining` and
  a demerger rewrites `purPrice` — read after, every weight is 0 and the apportionment is NaN.
- **`insertLotByTs`, NEVER `push`.** The parcels now carry OLD dates. Every queue is consumed in
  ARRAY order, the only sort runs BEFORE the event loop, and `insertLotByTs`'s binary search
  assumes sorted input — so one surviving `push` mis-places every later buy of that security too.
  Fixture J catches exactly this.
- **An empty parent is reachable** — corporate actions key on NAME only (`keyOf("", ca.from)`),
  and the parent may be sold out or never keyed. `carryLots` falls back to ONE parcel at the
  action date; returning nothing would delete the received shares and their basis.
- **Parcels take `ZERO_CHARGES`.** Built field-by-field, never spread from the parent: inheriting
  its charges double-counts brokerage and the conservation guard writes **no register at all**.

Known, deliberate gaps: the **stock detail page** still dates received lots at the action date —
it replays ONE stock, so the parent's history is not in scope without another Sheets read; the
tax tabs are the authority and the divergence is commented there. And **`openingBasis.ts` knows
only BONUS / SPLIT / RIGHT**, so once an action is old enough to be seeded from Opening Holdings
rather than replayed, the NewCo carries whatever date the broker statement shows.

Fixture J is the ONLY thing that can see any of this — fixture C's inherited dates land on the
same side of the 365-day line and it never sells a received security into a pre-existing lot, so
the suite stayed green either way. J is built so old and new behaviour are DISJOINT
(ST 110,000 / LT 0 versus ST 0 / LT 250,000) and was probed in both directions: disabling the
inheritance yields exactly 110,000/0, and swapping `insertLotByTs` back to `push` yields 50,000/60,000.

**A BONUS / SPLIT stores its RATIO, and the share count is derived** (changed 14-Sep-2026).
Until then only the resulting quantity reached the sheet — `AddTradeModal` computed it from the
ratio and whatever was held at the moment of typing, and said so: *"written to `qty`, which stays
the source of truth on save"*. Delete an earlier buy and that number is silently wrong: a 1:2
bonus entered against 579 shares stays 289.5 forever, even after the 123-share buy behind it is
gone. The ratio is the durable fact; the quantity is a consequence of it and of the position on
the day, so every engine now re-derives it at the action's OWN date.

- `parseRatio` / `freeSharesFor` in `tradeRowSchema.ts` are the single definition. **Bonus N:M**
  adds `held × N/M`; **Split new:old** adds `held × (new/old − 1)`. Both return 0 on a
  non-positive holding — a bonus on nothing is nothing.
- Stored in a **`Ratio` column** on True Entry, auto-appended on first write exactly as `Notes`
  already is, so existing sheets gain it without migration.
- **NOT in the Avg Price column**, tempting as that was: `parseFloat("1:2")` is **1**, not NaN, so
  a ratio parked there reads as one rupee per share to every numeric consumer and prices free
  shares. The sheet keeps a numeric 0; the trade book RENDERS the ratio over it.
- **A row with no ratio keeps its stored quantity, unchanged.** Every sheet written before this
  change has none, and re-deriving those retroactively would move already-filed numbers.
- Five replay sites read it and each must derive at the point the position is known:
  `replayFifoHoldings` (both builders — Holding tab and the as-of report), `syncCapitalGains`'s
  FIFO (`applySplitFifo` and the BUY branch), the register's `split` event and BUY branch, and
  the stock detail page. The register writes the derived quantity back onto the `Trade` BEFORE
  anything reads it, because the lot, the printed purchase row and the transaction statement are
  all built from that one field.
- The BUY-branch guard is `continue`, **never `return`** — those loops are plain `for...of` over
  every dated event, so a `return` abandons the whole replay from the first bonus on an empty
  position. It typechecks perfectly.

Fixture K is the ledger from the owner's own report — 456 held, a bonus row still carrying its
stale 289.5, and a 1:2 ratio — and asserts 228. Its control strips the `Ratio` column and asserts
289.5 survives. Probed by making `parseRatio` always return null: K then reports exactly 745.5,
the stale figure, and the control still passes.

**The per-stock opening-trades import ADDS; it does not replace** (changed 14-Sep-2026). The
detail page's Import button now opens on two choices — upload trades, or download a two-tab
.xlsx template — and the upload is additive. It used to delete the stock's `Opening Holdings`
lots and `Opening Txns` rows and write the file's own reconstruction in their place.

- **Adding is NOT appending lots.** `Opening Holdings` is not a row list, it is the surviving
  FIFO reconstruction. Reconstruct the new file on its own and concatenate, and the first SELL
  in it replays against an EMPTY queue and evaporates — the position silently comes out short.
  Adding means SEEDING the FIFO with the lots already on the sheet and replaying only the new
  rows on top: `accumulateOpeningLots(prevLots, txns)`, the same carried-in contract the
  date-sliced batch importer has always used. Fixture F pins it and is DISJOINT from the wrong
  answer (120 sh / ₹3,600 vs 60 sh / ₹3,000), probed by passing `[]` as the seed.
- **Re-uploading the same file must not double the position.** Rows matching an existing
  `Opening Txns` row on date · type · qty · price are skipped and counted. Duplicates WITHIN one
  upload are kept — two identical fills on one day are real — and that needs COUNTING, not a
  `Set`. One row on the sheet must mask exactly ONE incoming row with that key; a Set of
  existing keys masked every one of them, which is the difference between "one of these three
  is already filed" and "none of your three trades will be added" (fixed 16-Sep-2026).
- **`replayScrip` PUSHES new buys after the seed** (`openingBasis.ts:387`), so a batch that both
  buys at dates older than lots already on the sheet AND sells consumes the wrong lots.
  Buy-only batches are safe — every downstream engine re-sorts opening lots by date, so queue
  position does not survive the write. `batchIsOutOfOrder` warns on exactly that pair; it does
  not block, because the fix is "import oldest-first", not "don't".
- **A "sample CSV" cannot have two tabs.** The template is .xlsx (ExcelJS — SheetJS's community
  build drops styles), and the importer therefore accepts .xlsx as well as .csv, or the sample
  could not be fed back without a manual Save-As. The workbook is scanned sheet by sheet and the
  FIRST with a usable header wins, so the Instructions tab is skipped without knowing its name.
- **Only TURNOVER-named amount headers are adopted.** `replayScrip` prefers `amount` over
  `price`, so treating a bare `Amount` (usually all-in on a broker statement) as turnover moves
  brokerage into the cost basis of every lot, silently. The template's charge columns — STT,
  brokerage, fees, IPF, demat — are read and IGNORED: gains here are computed on turnover and
  s.48 does not allow STT anyway. Divergence between a filled turnover cell and qty × price is
  counted and shown, never absorbed.
- **A row naming another security is rejected and counted, never relabelled** — the identity is
  the page context. A valid ISIN decides alone; otherwise `obKey(name)` does; a BSE code or NSE
  symbol in the ISIN column decides nothing (the reference template's column accepts all three).
- **The data tab ships EMPTY.** A pre-filled example row inside the sheet you are about to upload
  is a phantom trade waiting to be imported; the worked example lives on the Instructions tab.
- Fixture H is the one that catches `openingTemplate.ts` drifting away from `findHeader`'s
  keywords — it builds the real workbook and reads it back through the real reader, so renaming
  a template column ships a sample the app rejects **under a green suite** without it. Probed by
  renaming `Trans Type`.

- **It is not CALLED an opening-basis tool anywhere the owner can see** (15-Sep-2026). The
  button hint, the dialog heading and subtitle, the duplicate-file error, the preview explainer,
  the primary button (`Add trades`, was `Add to opening basis`) and the template's Instructions
  tab all now say *trades*. The reason is not cosmetic: the portfolio-wide tool under the
  **Opening Basis** tab REPLACES, and this one ADDS, so sharing its name made a destructive
  operation and an additive one read as the same thing. What did NOT change is the destination —
  the rows still land on `Opening Holdings` / `Opening Txns`, those tabs keep their names, and
  the 31-Mar-2025 cap is still stated on the hint because True Entry is FY26-only and later rows
  are counted as dropped. Internal names (`stockOpeningImport.ts`, `openingTemplate.ts`,
  `StockOpeningImportModal.tsx`) are unchanged: they describe the sheet tabs, which really are
  called that.

**Bonus and Rights rows are CREDITED FROM THEIR QUANTITY; a Split still is not** (changed
16-Sep-2026, and this was the worst bug in the feature). `replayScrip` derives a corp action's
share count from a stored RATIO — `heldNow() * num/den` — and this importer passes `{}` as the
resolutions map, so `if (res && res.den > 0)` failed and **every Bonus / Split / Rights row was
silently worth nothing**. The row was parsed, counted as "for this stock", written to
`Opening Txns`, and contributed no shares; the position came out short, and re-uploading the
same file could never fix it because the row was by then a duplicate of itself. Reported as
*"it is not adding the trades I asked it to via excel"* against an NSE file whose true closing
position was 96,000 shares and which reconstructed to 0.

- A row on THIS template needs no ratio: it carries a QUANTITY the owner typed. Reading that is
  not a derivation. `creditCorpActionRows` turns a Bonus or Rights row into an ordinary BUY at
  its own quantity.
- **The credits are held BACK from `squareOffDaily` and added after it.** That function
  implements the intraday square-off convention — a same-day buy and sell in a trading account
  cancel — and a corporate action is NOT a trade. The owner's NSE file sells on 11-Nov-2024,
  the very day 96,000 bonus shares were allotted; netting the two leaves the QUANTITY right and
  the COST BASIS wrong, because 2,000 priced shares survive in place of 2,000 free ones. Both
  readings hold 118,000 shares, so only the cost tells them apart — which is what fixture J30/J31
  pins, and why entering a bonus as a plain ₹0 BUY is NOT an equivalent workaround.
- **The template offers BONUS and RIGHTS in its Trans Type dropdown.** Leaving them out was the
  other half of the bug: the reader accepted them and the template forbade typing them
  (`showErrorMessage: true`), so an allotment had nowhere to go. A SPLIT is still absent from
  the list on purpose.
- **A bonus is credited at NIL cost even when the row carries a price.** Bonus shares are free
  by definition; a price there is a mistake or a broker's notional figure, and letting it into
  the basis inflates it and under-reports every later gain. Rights ARE costed at their price.
- **A SPLIT is still not applied**, and that is deliberate: its quantity column is ambiguous —
  shares added, or the resulting total? — and guessing doubles or halves a position.
- **Nothing is dropped in silence.** `OpeningReconstruction.corpActions` carries what was
  credited and what was ignored WITH ITS REASON, and the dialog prints both. A row that adds no
  shares now says so and says what to type instead.
- A statement carrying BOTH a Bonus line and a same-day ₹0 share credit describes ONE event;
  the accompanying credit wins and the corp-action row is dropped, the same rule
  `alreadyCreditedCorpActions` applies inside the replay.

Known gap, unchanged: a SPLIT needs a ratio, and `openingBasis.ts`'s corp-action resolution is
still not wired to this importer.

**A controlled `<input type="date">` must never fall back to a non-empty `value`.** A native
date input reports `value === ""` for every INTERMEDIATE state while it is typed into — it only
yields a date once day, month and year are all filled. So `value={stored || fallback}` recomputes
the fallback on the first keystroke; that differs from the `""` the DOM currently holds, React
writes it back, and the segment just typed is WIPED. To the user the field snaps to the default
date on every keypress (reported 14-Sep-2026 on the Add Trade line date, which was the only date
input in the app carrying a fallback — every other one is `value={state}` and works precisely
because an empty string matches the DOM and React leaves the node alone).

**And its year segment is not four digits.** The HTML date range runs to 275760-09-13, so an
unbounded input accepts a SIX-digit year: one keystroke too many turns `21-11-2025` into
`21-11-20251` (reported 16-Sep-2026, again on the Add Trade line date). What comes out is a
well-formed date string, so nothing downstream rejects it — it reaches the sheet, parses as a
year twenty thousand years away, falls outside every FY the register knows, and the row simply
disappears off the tab it belonged on. Two defences, because the first is a browser behaviour
rather than a guarantee:

- **`min` / `max` on every date input.** Chrome sizes the year segment from `max`, so a
  four-digit bound is what stops the fifth keystroke being accepted at all. `DATE_INPUT_MIN` /
  `DATE_INPUT_MAX` in `dates.ts`; a screen with a tighter bound of its own (Reports caps at
  today) keeps it — what matters is that SOME `max` is present. The three Reports inputs
  already had one, which is why the glitch never appeared there and is the evidence the
  mechanism is right.
- **`isDateInputSane(v)` in `onChange`.** REJECT the change, never rewrite it: the controlled
  input's unchanged `value` prop makes React restore the node on the next render. Rewriting a
  clamped value here instead would re-open the wipe above, because any non-empty write differs
  from the `""` a half-typed field reports. The empty string must therefore PASS.

`dateInputValue(stored, fallback, touched)` in `src/lib/dates.ts` is the one spelling. The caller
owns `touched`: set it in `onChange`, and clear it in `onBlur` **when the field is empty** — that
blur is the ONLY route back to showing the default, and without it an emptied line renders blank
while `buildLines`' own `l.date || tradeDate` still files it under the drawer's date, so the
screen and the sheet disagree. `?? ''` is harmless (the empty string matches the DOM); only a
non-empty fallback bites. `tmp-date-input.ts` pins both the behaviour and a source sweep, because
neither `tsc` nor the build can see any of it and there is no browser in the loop. That sweep
**strips comments first**: `Holdings.tsx` carries a doc comment containing a literal
`<input type="date">` as prose, and scanned raw the sweep reports its own documentation as an
unbounded input — worse than silence, because it sends the reader to a line with no code on it.
Same trap `tmp-shortcuts.ts` already strips for; it fired here the moment the bounds check was
added.

**A zero PRICE or AMOUNT is saveable** (owner directive, 16-Sep-2026); only QUANTITY is still
refused. Shares genuinely change hands for nothing — a gift, a transmission, a written-off
unlisted holding, an allotment against an earlier advance — and blocking them forced a
fictitious rupee into the cost basis, which is worse than the zero it avoided. The arithmetic
downstream is already total: turnover 0 gives `purPrice` 0 on a buy (the path a bonus lot
already takes) and `salePrice` 0 on a sell, and `manualTrades` only ever divides by quantity.
It is not free of consequence, so `lineWarning` SAYS it in amber instead of blocking in rose —
a zero-cost buy leaves the lot with no basis at all, so a later sale is taxed on the whole
proceeds; a zero-consideration sell books the entire cost of the shares as a loss. Neither is
visible anywhere on the row once written. Bonus/Split are not warned about: they are free BY
DEFINITION, and warning on them trains the user to ignore the warning.

**A number input has NO stepper — neither the arrows nor the wheel** (owner directive,
16-Sep-2026: *"remove this add/reduce amount from everywhere we have it"*). 32
`<input type="number">` fields hold quantities, prices, turnovers and nine kinds of charge, and
every one of them shipped with the browser's spinner. An arrow that nudges a figure by ±1 is
wrong in all three ways that matter here: the step is meaningless on money (₹149.35 → ₹150.35
corrects nothing), a mis-click is indistinguishable from a typed figure once written, and the
field it edits goes to a filed tax tab.

- **One CSS rule, not 32 edits**, in `src/index.css`, and **UNLAYERED on purpose**. The focus
  ring above it is inside `@layer base` precisely so a component CAN override it; this is the
  opposite case — nothing may re-grow a spinner. Both halves are load-bearing and they cover
  DIFFERENT engines: `::-webkit-*-spin-button` for Chrome/Edge, `appearance: textfield` for
  Firefox, which draws its spinner with no pseudo-element to target. Drop either and the arrows
  stand on one browser, invisibly to whoever dropped it.
- **The mouse wheel is the spinner you cannot see, and removing the arrows makes it WORSE** —
  they were the only clue the field stepped at all. A browser steps a FOCUSED number input on
  every wheel tick over it, and half these forms are taller than the viewport, so the ordinary
  gesture is "type a price, scroll to the next field". The scroll re-prices the field just left,
  and nothing downstream can tell an edited figure from a typed one. Guarded by ONE
  document-level listener in `App.tsx`; the CSS and the guard ship together.
- **BLUR, not `preventDefault()`.** preventDefault on a wheel event needs a NON-passive
  listener, which makes the browser wait on JS before every scroll frame in the app — paid on
  the 300-row holdings grid, to fix a field nobody is using. Blurring drops the focus that made
  the field steppable and leaves scrolling untouched. The two are coupled: switching to
  preventDefault while leaving `passive: true` stops the guard **silently**, so the suite pins
  both.
- **Safe only while no number input has an `onBlur`**, since that is the one thing the guard can
  fire. It currently has none (the app's two `onBlur`s are on a text and a date field, which it
  never touches); one that wrote to Sheets would turn a stray scroll into a stray WRITE.
- **What is deliberately NOT removed**: `min` / `max` / `step="any"` still validate and the
  field still refuses letters — those are why these stay `type="number"` instead of becoming
  text inputs. The keyboard ↑/↓ still steps a focused field: that takes a deliberate focus AND
  a deliberate key, and it is the only way a keyboard-only user can adjust one.

There is **no CSS test of any kind** in this repo and no browser in the loop, so `tmp-date-input.ts`
section F is the only thing between a tidy-up and 32 fields growing their arrows back. All eight
probes fire, including the two that matter most: moving the rule into `@layer base`, and swapping
`blur()` for `preventDefault()`.

Adding a field to `AddTradeModal`'s `LineDraft` needs one more edit than it looks: `ChargeKey` is
`keyof Omit<LineDraft, …>` over a hand-listed set, so a new field that is not added to that Omit
list silently becomes a CHARGE field.

**"I added it to the tab and it isn't in the dropdown" has THREE causes** (16-Sep-2026,
reported three times over). Two were fixed, it was still missing, and the third turned out to
hide a company whose master entry was perfectly correct — so **check the third first**, it is
the cheapest to rule out.

0. **`ScripCombobox` truncated the list.** It scanned `master.entries` and did
   `if (out.length >= 60) break` — in SHEET ORDER, not alphabetical — then sliced to 30 for
   display with no marker. In PE scope an empty box matches EVERY entry, so the scan stopped at
   the 60th row of the tab and nothing below it could be reached. **A newly added company is at
   the bottom of the sheet**, which makes the newest one the likeliest to vanish. The cap is now
   `!peOnly` (it exists for the 5,000-entry listed universe; the non-listed one is bounded by
   four hand-maintained tabs), PE scope shows its whole list, and any truncation SAYS
   "Showing N of M". A silently cut list is indistinguishable from "that company is not
   registered", which sends the owner off to add a duplicate row for one that already exists.

The other two, whose fixes are opposite to each other: The Add Trade dropdown lists only entries carrying an `assetClass`
(`ScripCombobox`, `peOnly && !e.assetClass`), so a non-listed company goes missing when either:

1. **The master is stale.** `activeMaster` is `recheckedMaster || master || selfMaster`, and it
   preferred the STALEST of the three — the `master` PROP, which `Holdings` loads once on mount
   and keeps for the life of the page, so hours old by the time anyone opens the drawer. The
   drawer's own unforced load is at worst 90s behind and was never even reached while the prop
   was non-null. The drawer now **forces a fresh read every time it opens**: one batched read of
   one spreadsheet on an explicit user action, the same trade `rebuildHolding` and the PE CMP
   write already make. The `master` prop still renders while it loads, so the dropdown is never
   empty, and the result lands in `recheckedMaster` so it wins — and rides back through
   `onSaved`, refreshing the page for free.
2. **`foldAssetClass` dropped the class.** A PE row whose normalised name lands on a LISTED entry
   carrying a ticker hits `else if (entry.nse || entry.bse) continue`. That guard is RIGHT —
   marking a live listed holding unlisted swaps its LTCG period to 24 months and stops the price
   feed ever fetching it — but until now it was **silent**, and no amount of Rechecking changes
   it. `ScripMaster.classSkippedByTicker` records each one (the name as typed, the shared
   normalised key, what it collided with, and the vetoing ticker).

**The PE panel now states what the app actually READ** — the count of unlisted companies, and
any ticker collisions by name — not only when that count is zero. Three reports of this symptom
produced three different causes and every diagnosis was guesswork, because nothing on screen said
what the app had read. Add a company, press Recheck: if the number does not go up, the row is not
reaching the app at all (wrong tab, wrong column, a stray space); if it does, the problem is
downstream of the read.

The drawer's refusal message consults that list BEFORE saying *"isn't on any of the ... tabs,
add it to one"* — which, for a company already on a tab, talks the owner into a **duplicate
row**: the split-identity failure, self-inflicted, and the exact trap the `peFailed` message
already sidesteps. It now names the collision and says *do not add it again*. The fix is to give
the tab row its ISIN (an ISIN match is not a guess and overrides the ticker veto) or to rename
one of the two.

**The page holds its OWN scrip master, and it goes stale** (found 14-Sep-2026). `Holdings.tsx`
loads the master ONCE on mount, unforced, into React state, and keeps it for the life of the
page. The Add Trade drawer loads its own, and force-reloads it when you press
*"Just added a company? Recheck"*. So register an unlisted company on the Private Equities tab,
trade it, and **the drawer's dropdown says PE while the page says EQ** — the series badge, the
Listed/Unlisted segment and every class-derived figure — for the rest of the session, until a
browser reload. A PE holding reading as listed equity is a 365-day holding period on a 730-day
asset.

The save path now calls `refreshScripAfterSave`, which **adopts the drawer's forced master when
it has one** (free — the drawer already paid for it) and otherwise spends ONE forced read. That
is a single-spreadsheet batched read on an explicit user action, not the 13-portfolio fan-out the
read-quota rule is about; `rebuildHolding` and the PE CMP write already do the same.

Worth knowing for the next report of this shape: the SHEET was never wrong. `rebuildHoldingTab`
and `syncCapitalGains` force a fresh master, so the tax tabs classified it correctly the whole
time — only the screen lied. And the two candidate causes are indistinguishable from outside the
app: a stale master and a SPLIT IDENTITY (two entries normalising alike, one carrying the PE
flag and the other winning the name lookup) produce the identical symptom. The resolution path
was probed in four shapes and is sound, so `tmp-pe-fold-run.mjs` now pins the invariant — every
entry the dropdown lists as PE must also RESOLVE as PE by name — to tell the two apart next time.

**A LISTED "X Limited" and an UNLISTED "X Pvt Ltd" are two companies, and the book holds both**
(16-Sep-2026 — the owner has exactly this for Kusumgar). `normName` strips
`limited|ltd|private|pvt|the|co`, so the two collapse to ONE key, there is ONE name slot in
`byAliasNorm`, and `claimAlias` hands it to whichever folded last. The listed company is then
taxed on private-equity rules at 730 days, or the private one at 365. Nothing downstream can see
it, and True Entry has no ISIN column so **every trade is looked up by name** — the slot is the
whole identity.

- `normNamePrivate` is `normName` with the private/pvt token KEPT and spelled one way:
  `Kusumgar Pvt Ltd` → `kusumgar pvt`, where `normName` gives `kusumgar`. It is a **tie-breaker,
  not a new rule**: consulted only when it DIFFERS from the plain key, which is only for a name
  actually carrying the token. Every other lookup takes exactly the path it always did.
- `lookupScrip` AND `resolveScrip` both consult it, ahead of the plain key. Patching only the
  first leaves the drawer showing the right company while the REGISTER files its trades against
  the other — `keyOf` uses `resolveScrip`. The probe that disables `resolveScrip`'s branch alone
  found nothing until a test was written through it.
- **The twin is indexed BY HAND, never through `indexEntry`.** That helper calls `claimAlias` on
  every alias including the plain key, and `claimAlias`'s own rule lets the unlisted row WIN it.
  The twin takes the discriminating slot and nothing else. Probed: indexing it normally makes
  the LISTED company resolve as PE at 730 days.
- **Same trap where the PE row carries its own ISIN** and creates a brand-new entry through the
  `!entry` branch. Its `indexEntry` claims the shared name too, so the slot is handed straight
  back to the ticker-carrying holder and the new entry keyed distinctly. This matters because
  *"give the tab row its ISIN"* was the remedy the app itself printed — advice that would have
  broken the listed company.
- **A name with NOTHING to distinguish it is still refused and reported** — the owner's other
  collision is a PE row named just `Cranex` against a listed `Cranex Ltd.`, where no honest
  discriminator exists. The remedy printed for those is now *rename the tab row*, and adding
  "Pvt" is enough to make the app keep them apart by itself.
- **THE TWIN NEEDS ITS OWN `key`, and resolving to a separate entry is only half the job**
  (16-Sep-2026, reported as *"kusumgar ltd and pvt ltd showing transaction in same PE"*). Every
  engine buckets holdings, FIFO lots and gains by `entry.key` — `byKey.get(key)` in
  `holdingsCalc`'s `resolve`, the same in the register — so two entries sharing a key are ONE
  position on screen and on every filed tab, under whichever name got there first.
  `makeEntry` computes `isin || normName(canonicalName)`, so with **no ISIN on the PE row AND
  none on the listed master row** both fall back to `normName` and both keys are `kusumgar`.
  The twin now takes `isin || dk`.
  **It hid behind a green suite because every listed fixture carried an ISIN**, which made the
  keys differ no matter what the twin did; a hand-maintained master row with just a name and a
  ticker is perfectly ordinary. Fixture `Zenmark` is that row.
- **The plain key is deliberately LEFT in the twin's `aliasNorms`**, which reads backwards. That
  set is also `enrich`'s gate (`!entry.aliasNorms.has(nk)`), and `enrich` calls `claimAlias`,
  whose rule hands the shared slot to the unlisted row. Strip it "for tidiness" and the first
  ISIN-bearing trade resolved against the twin claims `kusumgar` and sends every listed trade to
  the private company at 730 days — the original disaster, through a back entrance. Probed: the
  shared slot flips to `Kusumgar Pvt Ltd`.
- **The price maps cross the same way, and a wrong price here is MONEY.** `makePriceResolver`
  and `makeExceptionResolver` both fall back to `normName`, so the unlisted twin read the listed
  company's Yahoo quote straight off the shared string — a PE badge and a
  "₹549.20 · YAHOO" valuation on one header, which is a combination that should not exist. It
  moves the holding's value, the portfolio's AUM and the NAV timeline while looking entirely
  plausible. `plainNameIsAnotherCompany` guards it, phrased over the MASTER ("does this
  normalised name resolve to a different entry than this holding did?") rather than over
  `normNamePrivate`, so it covers any collision of the same shape and is inert for every
  ordinary scrip.
  - **The guard must run on the BUILD side as well as the READ side**, and the first version had
    only the read. Guarding the read alone stops the unlisted holding taking the listed quote
    and leaves the reverse wide open: the PE price row still CLAIMS `name:kusumgar`, so the
    listed company reads the private one's price out of a slot it should never have held. Both
    directions are pinned.
  - A *discriminating name slot* was tried alongside the guard and **removed**: with a master
    present the `key:` lookup always wins first, so those branches were unreachable, and without
    a master there is no way to know the two names are different companies anyway. Two probes
    came back silent, which is what found it. Unreachable code that looks like a safeguard is
    worse than none.
  - `makeExceptionResolver` had **no coverage of any kind** before this, found the same way — by
    a probe that removed its guard and changed nothing.

**None of this repairs rows already written.** `manualTrades`' `buildRecord` stores
`entry.canonicalName`, resolved at SAVE time, so every trade entered while the two companies
shared one entry went to the sheet under ONE name. The resolver fix is forward-looking; the
ledger has to be corrected by hand.

**Keyboard shortcuts.** `SHORTCUTS` in `src/lib/shortcuts.ts` is the single registry: it drives
the key handler **and** the `?` help overlay, so a working-but-undocumented key is not
expressible. Three rules:

- **No Sheets-writing action may ever be bound.** Rebuild Holding, Sync Capital Gains, the
  Capital Gains register and Transfer stay click-only — a stray keypress must not start a sheet
  write. `tmp-shortcuts.ts` asserts it.
- **Escape is NOT in the global handler.** Four components already own an Escape each and listen
  on `document`; a fifth would close two things on one press. Overlays get Escape, the focus trap
  and focus restore from `ModalShell` instead.
- The handler ignores any event whose target is an `input` / `textarea` / `select` /
  contenteditable, and anything held with Ctrl / Cmd / Alt (those belong to the browser). Single
  letters were chosen *because* the browser owns Ctrl+T/W/N/P/F/D/L — every one a view here.

Actions whose state lives in `Holdings` (Add Trade) are forwarded as a DOM event rather than
hoisting that state into `App`; `/` focuses the filter by `HOLDINGS_SEARCH_ID`, and because that
input only exists **inside** a portfolio it navigates there first.

**Lists and tables: `src/lib/rowNav.ts`.** Every control in the app is a real `<button>`, so Tab
already reaches it and the global `:focus-visible` ring in `index.css` shows where it is. What Tab
cannot do is a 300-row grid — one tab stop per row means 300 presses to get past the table — so a
row list gets the **roving-tabindex** treatment: exactly one tab stop (the active row), ↑↓ inside,
Home/End/PageUp/PageDown, Enter to activate. `l` jumps focus to the first row or card on screen.

Rules that have each already cost something:

- **One `useRowNav` call, one `containerRef` attached.** `focusIndex` finds its rows by querying
  *inside* the container, so a list whose rows carry `rowProps` but whose container never got the
  ref is focusable, reachable by Tab, and **silently dead to every arrow key**. Shipped exactly
  that way once during this change (the portfolio cards). `tmp-rownav.ts` asserts the counts match
  per file, and that assertion was probed by deleting a ref and confirming it fails.
- **`rowNavIntent` must never claim Tab.** The handler `preventDefault()`s anything that is not
  `none`, so claiming Tab would trap the user inside the table with no keyboard way out — the
  exact opposite of the feature.
- **Ends clamp, they do not wrap.** One ArrowDown teleporting from the last row to the first is
  indistinguishable from a mis-tracked index.
- **Enter activates everywhere; Space only on the portfolio cards** (card-shaped things read as
  buttons) **and on a trade row while selecting** (Space *is* the checkbox key). Everywhere else
  Space stays page-down, which is what a reader expects of a table.
- **A clickable card must not take `role="button"`** — it contains buttons, and a button role with
  interactive descendants is invalid ARIA, which is worse than no role. `tabIndex` + `aria-label`.
- **A sortable `<th>` must not take `role="button"` either** — that would replace its
  `columnheader` role, and `aria-sort` is only valid on a columnheader. `tabIndex` alone.
- The active index is re-synced from `onFocus`, not only from our own key handling, or Shift+Tab
  from below (and `l`) leaves the tab stop pointing at a row that is not the focused one — after
  which the next ArrowDown jumps.

**The trade book's row gestures.** Outside edit mode the expense/note breakdown opens on
**double-click**, not click — it used to fire while simply reading down the ledger. Edit mode
keeps its SINGLE click (selecting rows and opening the row editor are the point of that mode;
double-clicking a checkbox would be absurd). **Enter still opens the breakdown from the keyboard**
and must stay: there is no keyboard double-click, so binding it to `onDoubleClick` alone makes the
breakdown mouse-only and quietly undoes the keyboard-navigation work above.

**Edit Entry, opening lots: Amount ↔ Cost/Share.** They update each other through Quantity.
`Amount ÷ Qty → cost/share at r6`; `Qty × cost/share → amount at r2` — the asymmetry is the
convention, not an oversight: rounding a RATE to paise drifts the whole FIFO basis and the drift
only surfaces later as a wrong gain. A quantity edit recomputes whichever money field was NOT
typed last, so correcting a qty typo keeps the figure just entered. Two things it must not do:
divide by a blank/zero quantity (that puts `Infinity`/`NaN` in the form and then the sheet), and
re-derive cost/share on open — Amount is seeded for display only, because a 2-dp money figure
divided back does not generally return the r6 rate it came from. The save path is unchanged: only
`qty` and `costPerShare` are written.

The **trade book** deliberately uses plain tab stops instead of the hook: `sortedTxs` is computed
inside `renderStockDetailView`, *below* the `if (selectedStock)` early return, so a hook keyed on
its length cannot be declared without hoisting state out of the largest component in the app. It
is also a bounded per-stock list. Residual, on purpose: Tab walks every trade row.

`q` is Back, and it calls `goBack()` — `runDeepestStep()` — **not `history.back()`**. `appBack.ts`
only arms its trap history entry once a view has registered a step, so a `history.back()` fired
before that walks **out of the SPA**, which is the bug that module exists to prevent. Running the
step directly consumes no history entry, cannot navigate away, and is a no-op at the Dashboard
exactly as a Back press is. It reads like pointless indirection — which is why a tidy-up would
collapse it — so `tmp-shortcuts.ts` asserts it, over comment-stripped source (the rule is stated
in a comment beside the code it guards, and a naive scan reports its own documentation as the
violation).

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

**Two scrip resolvers, and they do NOT agree.** The app's `lookupScrip` and
`apps-script/YahooPriceUpdate.gs`'s `symbolsFor_` both map a held scrip to a scrip-master row,
by different rules — so a broker's truncated name (`ANAWIL WIRE& ENGINEERI`) resolved in the app,
which showed the right NSE symbol on the detail page, while the price fetch reported "No exchange
symbol" and the CMP silently went stale. **The trap is that the app is the thing you look at**:
the sheet looks correctly configured because, for the app, it is.

**The Holding tab LAGS the scrip master, and that is the trap.** It *does* have an ISIN column
(`holdingsCalc.ts:772`), but the cell is filled only for a scrip that **resolved at the last
Rebuild Holding** (`holdingsCalc.ts:648`; the ledger carries no ISIN of its own, `col("ISIN", -1)`),
and the tab is rewritten **only** by an explicit rebuild. So fixing a scrip in the master makes the
app resolve it *instantly* — the detail page reads the master live, and `displayIsin` falls back to
`scripEntry.isin` — while the price script still sees the pre-fix Holding row: **no ISIN, and the
broker's raw truncated name.** Name matching is all that is left, precisely for the scrips somebody
just fixed and is watching for a price on.

**A stale Holding tab is diagnosable without the sheet**: if a `Price Status` miss is reported
under the *broker's* name rather than the master's canonical name, that row predates the master
entry — a rebuild would have written `r.entry.canonicalName`. Three gaps in the name path have been
closed, and the order they were found in is the lesson — each looked like the whole bug:

1. the script **skipped the alias column** — so adding an alias fixed the app and nothing else;
2. it never indexed the **NSE/BSE symbol as a lookup key**, though the app does
   (`scripMaster.ts` builds its alias list as `[...bseParts, bsecode, nse, ...aliasCol]`);
3. it had no **truncated-prefix** rule. `PREFIX_MIN` is 6 on **both** sides deliberately —
   divergence is the disease here, so a "better" threshold on one side re-opens it.

For `ANAWIL WIRE& ENGINEERI` (2) and (3) are **both** load-bearing: exact-matching the ticker key
fails, and prefix-matching the canonical name fails too (`wire&` vs `wire &`). Pinned as string
facts in the suite so the reason survives a refactor of either rule.

An ambiguous prefix **refuses** rather than guessing: the app can guess because it raises the
review popup, but a wrong ticker here writes a wrong *price* — money, silently wrong, with
nothing downstream able to detect it. Still app-only: the **token-subset** fallback, which needs
the generic-token veto to avoid over-matching. `SYMBOL_OVERRIDES` remains the escape hatch.

**Diagnosing it needs the live sheet, so there is a route for that**: `/exec?sym=<held name>`
reports the rule that fired, **which row** it locked onto and the ticker returned — none of which
the suite can prove, because the suite uses a *guessed* master row. Its `version` field is a
deploy marker, so "not fixed" and "not deployed" stop being the same observation. **Editing the
repo copy changes nothing until it is saved in the Apps Script editor** — see
[[Portfolio Registry Triplication]] in the vault.

**Scrip resolution.** `extractIsin` (`src/lib/brokers/utils.ts`) is shared by every parser and its
regex **must** keep the trailing check digit (`IN[A-Z0-9]{9}[0-9]`) — without it, "INfrastructu"
inside a company name matches first. `normName` strips `limited|ltd|private|pvt|the|co`, so two
different companies can normalise identically. `lookupScrip` is read-only; `resolveScrip` mutates
the shared 90-second-cached master.

**Share India: "This contract note only has FnO Transactions" was the answer to EVERY failure**
(17-Sep-2026, reported as *"SHARE INDIA CONTRACT NOTE HAS A BIG PROBLEM THIS IS CONSIDERING A
FEW CONTRACT NOTES AS FNO TRANSACTIONS"*). It was never a classification. Two throw sites said
it and neither had evidence:

- `parsePdfText` / `parseHtml`, on zero raw trades, guarded by a substring scan for
  `derivative` / `future` / `option` / `fno`. **That test can never be false on a Share India
  note**: the clearing-corporation header prints `NCL CAPITAL   NCL DERIVATIVES   NCL CURRENCY`
  whether or not those segments traded, the annexure has a
  *"Closing Rate per Unit (Only for Derivatives)"* column, and page 2's SEBI boilerplate says
  *"shares at any future date"*. `looksLikeDerivativesNote` now asks for an INSTRUMENT instead
  — `FUTIDX`/`OPTIDX`/`FUTSTK`/`OPTSTK`, an `NCL FO`-style segment marker, or a literal
  "Derivatives Segment" heading. Boilerplate carries none of those.
- `finalizeContractNote`, on zero VALIDATED trades, which did not even look at the note. This
  was the one that actually fired.

**The real defect: the description cell wraps FORWARD and only BACKWARD was handled.** pdf.js's
Y-then-X grouping puts the overflow on a neighbouring line, and it can be either side:

```
 ... 11:38:07   Manbro Industries SELL   -1   800   0   800   0   800   D
Limited-(INE348N01034)
```

The row parses perfectly — qty 1, price 800, the negative `-1` handled by `Math.abs` — and
carries NO ISIN, because the recovery only read `lines[i - 1]` (here, `NCL CM`). The two
directions are **not symmetric**: a backward line holds the WHOLE description and replaces the
name; a forward line holds only its TAIL and must be APPENDED, or `Manbro Industries` silently
becomes `Limited`. Both branches require the neighbour to carry an ISIN and no BUY/SELL, so a
following trade cannot donate its identity.

**A trade with no ISIN is now IMPORTED, not discarded** (owner directive). The old
`if (!t.isin || t.isin.length < 12) return false` is how a correctly read sale vanished. True
Entry has no ISIN column at all — the app already identifies holdings BY NAME and the
confirm-company popup is the backstop — so an ISIN is an optimisation here, never the identity.
Dropping a real trade is the worse failure.

**`Taxable Value of Supply` is NOT brokerage on a Share India note — it is the GST BASE**, which
is brokerage PLUS exchange transaction charges, SEBI turnover fees and clearing charges (STT and
stamp duty sit outside it; they are not a supply of services). Everything downstream assumes that
field means BROKERAGE, so leaving the GST base in it counted the exchange charge **twice**. On the
reported note brokerage was genuinely 0, the taxable value 0.80 and the ETC 0.80 — the same 80
paise — and the trade showed ₹2.54 of expenses against the note's ₹1.74.

- **Normalised ONCE, in the parser**, not at each consumer: `finalizeContractNote` reduces
  `summary.taxableValue` to `max(0, taxable − etc − sebi − clearing)`. **It must run AFTER the GST
  fallback**, which derives 18% from the real GST base — that ordering is the whole correctness
  argument.
- **Fixing it in `buildReconciliation` instead would be wrong.** That function is SHARED by every
  broker and its charge total starts `summary.taxableValue + // brokerage` — which is correct
  there: Axis reads the field from a column its note literally labels
  *"Taxable Value of Supply (Brokerage...)"*, and Integrated overwrites it with its own summed
  brokerage. Share India is the odd one out, so Share India is where it gets normalised.
- Patching only the per-trade allocation is what the first attempt did, and it left the
  RECONCILIATION still computing ₹2.54 — the trades were right and the Mismatch Warning stayed
  up. Two definitions of one field, one of them wrong.
- It also gets a zero-brokerage plan right: brokerage 0 with ETC > 0 used to trip the
  "no per-share brokerage printed" fallback on every single note.

**No capital gain moves** — every gain here is computed on charge-free turnover — but the expense
columns of anything imported before this are overstated by the exchange charge, and re-importing
is what corrects them.

**A residual 20 paise is NOT a parser fault: the broker settles STT to the nearest rupee.** The
note prints STT twice and the two disagree on purpose — Annexure II (the STT statement) computes
`0.80`, the Obligation Details table settles `1`. `800 − 1 − 0.80 − 0.14 = 798.06` is the note's
cash figure; `800 − 0.80 − 0.80 − 0.14 = 798.26` is what the app derives from the STT statement,
which is the anchor `allocateStt` already uses. `buildReconciliation` still counts that
difference and raises the Mismatch Warning, so a sub-rupee STT will flag on most Share India
notes until the reconciler learns to name `round(stt) − stt` instead of flagging it. **Open
decision, not an oversight.**

**Share India has NO test suite**, which is why all of this shipped (Nuvama 159, Axis 68, Share
India 0). `tmp-si-probe.ts` + `tmp-si-probe-run.mjs` run the real parser over real
`tmp-extract.mjs` output, print each trade with its charge block, and reconcile those charges
against the note's own printed totals. Its notes are **password-protected** — 115 of the owner's
116 need one — so a sweep needs the password as a command-line argument, never in a file.

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

- `src/lib/` — engines: `holdingsCalc`, `trxRegister`, `openingBasis`, `itrUnlistedSchedule`, `scripMaster`,
  `scripPrices`, `navTimeline`, `reportDoc` / `reportPdf` / `reportXlsx`, `brokers/`
- `src/components/` — `Holdings.tsx` is the largest (portfolio list + stock detail + trade book)
- `apps-script/` — Gmail-triggered auto-import (`.gs`); leave alone unless asked
- No router: `currentView` is plain state; browser Back is wired via `src/lib/appBack.ts`.
  `APP_VIEWS` is a **value**, not just a type — the persisted view name is validated against it,
  so adding a view means one entry there or a reload falls through to Imports
- Session: `src/lib/sessionClock.ts` (pure urgency ramp, imports nothing) drives `LiveClock`,
  which is both the IST clock and the token-expiry gauge — gold from 15 min out, click to re-auth
- Keyboard: `src/lib/shortcuts.ts` (registry + the one listener), `src/lib/rowNav.ts`
  (roving-tabindex list navigation — pure key mapping + the hook over it), `ShortcutHelp`, `Settings`
  (the fifth view — holds the theme toggle and Sign out, both moved out of the header)
