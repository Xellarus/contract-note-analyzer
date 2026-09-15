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
| `node tmp-pe-fold-run.mjs` | PE fold-in to the scrip master, stubbed Sheets API — plus the **request count** of a master load, the tab-list-is-not-an-authority rule, the batch-failure fallback, the `PVT.LTD.` name shape, the listed-as-PE/resolves-as-PE invariant, and a SOURCE check that Add Trade's save path refreshes the page's scrip master (49) |
| `node tmp-pe-write-run.mjs` | Non-listed tab WRITES — registering a company on any class tab, and the CMP write-back with its overwrite guard (85). Round-trips the header the writer CREATES back through the reader, so the two can never disagree |
| `node tmp-trx-run.mjs` | Capital Gains register: per-class tabs, transaction statements, demerger restatement, asset-class refusal, the "STT Removed" flag, and that the sheet-WRITING engines force a fresh master read while the read-only hot paths do not, fixture H's REAL no-ISIN ledger header, and fixture J's merger/demerger holding-period carry-over plus `carryLots` head-on, and fixture K's bonus re-derivation with `parseRatio`/`freeSharesFor`, and fixtures L/L2/L3 — the **three-way holding split**, an empty class still writing its tab, the legacy holding tab being RENAMED rather than orphaned, and PAN / Face Value / Type Of Company reaching the PE statement from the scrip master, and fixture M — the ITR schedule end to end: which blocks reach it, an exited company, a same-day round trip, the canonical-name rule and the RAW write (270; 271 with `TRX_BASELINE` set). `STT_DEBUG=1` dumps the cell-by-cell diff fixture G asserts on |
| `node tmp-holding-lastpx-run.mjs` | Valuing an unlisted holding at its last traded price — capture + resolver precedence (24) |
| `node tmp-nuvama-run.mjs` | Nuvama parser (159) |
| `node tmp-yahoo-symbols.mjs` | Price-script symbol resolution — runs the REAL `YahooPriceUpdate.gs` functions in a `vm` sandbox with Apps Script stubbed: ISIN / name / alias / **ticker** matching, the truncated-prefix rule and its ambiguity refusal, canonical-beats-alias in either row order, the override table, NSE-primary-BSE-fallback, and that the `?sym=` probe reports the rule that actually fired (34). Several cases run with `SYMBOL_OVERRIDES` **emptied**, so they prove the general path rather than a hand-listed entry |
| `node tmp-holdings-sort.mjs` | Sort order: the holdings grid (default biggest-first, click direction, tiebreaks) **and** the Portfolios page cards, incl. a guard that `PORTFOLIOS` is never sorted in place (19). Reads the comparators OUT of `Holdings.tsx`, so it fails if the source drifts — and needs no `ROOT` edit |
| `node tmp-transfer-run.mjs` | Cross-portfolio transfer: FIFO, cost carryover, no gain realised (83) |
| `node tmp-opening-import-run.mjs` | Per-stock opening-trades import: header detection (incl. the template's own Instructions tab NOT matching, and a bare `Amount` never adopted as turnover), Excel date serials, the foreign-security rejection, the duplicate guard, the FIFO-order warning, and the **additive merge** — plus fixture H, which BUILDS the shipped .xlsx template and reads it straight back through the shipped reader (71) |
| `node tmp-axis-run.mjs` | Axis Securities parser (68) |
| `npx tsx tmp-session-clock.ts` | Session clock: the urgency ramp (monotonic, clamped, boundaries), the countdown text, the gradient stops, and that the countdown uses the same 60s safety margin `hasValidGoogleToken` does (36) |
| `npx tsx tmp-shortcuts.ts` | Keyboard shortcuts: registry invariants, the typing/modifier guards driven through the real handler, and source checks that the App `run` switch and the `?` overlay match the registry, plus that `q` calls `goBack()` and never `history.back()` (44) |
| `npx tsx tmp-rownav.ts` | Row/list navigation: the key mapping and its clamping, the keys it must NOT claim (**Tab above all** — claiming it would trap the user in the table), and per-consumer wiring checks incl. the one-hook-one-`containerRef` invariant (51) |
| `npx tsx tmp-itr.ts` | The ITR **unlisted equity shares** schedule builder — layout, the row rule, blank-vs-zero in all four places, the per-row footing identity, acquisition grouping, the TOTAL row's column set, and the diagnostics. Most fixtures are REAL companies and REAL figures out of the owner's own filed FY2024-25 return, so it checks against a filed page rather than against its own idea of the answer (117) |
| `npx tsx tmp-date-input.ts` | Controlled `<input type="date">`: the lifecycle of `dateInputValue` (above all, that a HALF-TYPED date renders empty), plus a source sweep asserting no date input anywhere falls back to a non-empty `value` — and that the Add Trade line date keeps its touched flag and its onBlur (13) |
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
  upload are kept — two identical fills on one day are real.
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

Known gap, unchanged: bonus / split / rights rows are not handled by this importer (they need a
ratio), and `openingBasis.ts`'s corp-action resolution is not wired to it.

**A controlled `<input type="date">` must never fall back to a non-empty `value`.** A native
date input reports `value === ""` for every INTERMEDIATE state while it is typed into — it only
yields a date once day, month and year are all filled. So `value={stored || fallback}` recomputes
the fallback on the first keystroke; that differs from the `""` the DOM currently holds, React
writes it back, and the segment just typed is WIPED. To the user the field snaps to the default
date on every keypress (reported 14-Sep-2026 on the Add Trade line date, which was the only date
input in the app carrying a fallback — every other one is `value={state}` and works precisely
because an empty string matches the DOM and React leaves the node alone).

`dateInputValue(stored, fallback, touched)` in `src/lib/dates.ts` is the one spelling. The caller
owns `touched`: set it in `onChange`, and clear it in `onBlur` **when the field is empty** — that
blur is the ONLY route back to showing the default, and without it an emptied line renders blank
while `buildLines`' own `l.date || tradeDate` still files it under the drawer's date, so the
screen and the sheet disagree. `?? ''` is harmless (the empty string matches the DOM); only a
non-empty fallback bites. `tmp-date-input.ts` pins both the behaviour and a source sweep, because
neither `tsc` nor the build can see any of it and there is no browser in the loop.

Adding a field to `AddTradeModal`'s `LineDraft` needs one more edit than it looks: `ChargeKey` is
`keyof Omit<LineDraft, …>` over a hand-listed set, so a new field that is not added to that Omit
list silently becomes a CHARGE field.

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
