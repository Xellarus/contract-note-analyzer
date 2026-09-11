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
| `node tmp-pe-fold-run.mjs` | PE fold-in to the scrip master, stubbed Sheets API — plus the **request count** of a master load, the tab-list-is-not-an-authority rule, and the batch-failure fallback (39) |
| `node tmp-pe-write-run.mjs` | Non-listed tab WRITES — registering a company on any class tab, and the CMP write-back with its overwrite guard (84) |
| `node tmp-trx-run.mjs` | Capital Gains register: per-class tabs, transaction statements, demerger restatement, asset-class refusal, the "STT Removed" flag, and that the sheet-WRITING engines force a fresh master read while the read-only hot paths do not, and fixture H's REAL no-ISIN ledger header (146; 147 with `TRX_BASELINE` set). `STT_DEBUG=1` dumps the cell-by-cell diff fixture G asserts on |
| `node tmp-holding-lastpx-run.mjs` | Valuing an unlisted holding at its last traded price — capture + resolver precedence (24) |
| `node tmp-nuvama-run.mjs` | Nuvama parser (159) |
| `node tmp-yahoo-symbols.mjs` | Price-script symbol resolution — runs the REAL `YahooPriceUpdate.gs` functions in a `vm` sandbox with Apps Script stubbed: ISIN / name / alias / **ticker** matching, the truncated-prefix rule and its ambiguity refusal, canonical-beats-alias in either row order, the override table, NSE-primary-BSE-fallback, and that the `?sym=` probe reports the rule that actually fired (34). Several cases run with `SYMBOL_OVERRIDES` **emptied**, so they prove the general path rather than a hand-listed entry |
| `node tmp-holdings-sort.mjs` | Sort order: the holdings grid (default biggest-first, click direction, tiebreaks) **and** the Portfolios page cards, incl. a guard that `PORTFOLIOS` is never sorted in place (19). Reads the comparators OUT of `Holdings.tsx`, so it fails if the source drifts — and needs no `ROOT` edit |
| `node tmp-transfer-run.mjs` | Cross-portfolio transfer: FIFO, cost carryover, no gain realised (83) |
| `node tmp-axis-run.mjs` | Axis Securities parser (68) |
| `npx tsx tmp-session-clock.ts` | Session clock: the urgency ramp (monotonic, clamped, boundaries), the countdown text, the gradient stops, and that the countdown uses the same 60s safety margin `hasValidGoogleToken` does (36) |
| `npx tsx tmp-shortcuts.ts` | Keyboard shortcuts: registry invariants, the typing/modifier guards driven through the real handler, and source checks that the App `run` switch and the `?` overlay match the registry, plus that `q` calls `goBack()` and never `history.back()` (44) |
| `npx tsx tmp-rownav.ts` | Row/list navigation: the key mapping and its clamping, the keys it must NOT claim (**Tab above all** — claiming it would trap the user in the table), and per-consumer wiring checks incl. the one-hook-one-`containerRef` invariant (51) |
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

- `src/lib/` — engines: `holdingsCalc`, `trxRegister`, `openingBasis`, `scripMaster`,
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
