# Contract-note auto-import (Google Apps Script)

Forward your **Integrated (HTML)** contract-note emails to your Gmail and have them
imported into the portfolio sheets automatically once a day — no browser open, no
manual upload. Free (runs on Google's infrastructure, no server, no card).

**Scope:** Integrated HTML notes only. Zerodha PDFs are **not** parsed here — keep
importing those manually in the web app. See "Limitations" below.

The script (`ContractNoteAutoImport.gs`) reuses the exact parsing + charge logic the
web app uses, so auto-imported rows are identical to manually-imported ones (same
columns, same numbers, same dedup — including the IPF/Demat columns).

---

## One-time setup

### 0. Which Google account
Run the script under the Google account that (a) **receives the forwarded emails**
and (b) **has edit access to all the portfolio sheets and the Scrip Master**. For
you that's `arash@saguncapital.com`.

### 1. Create the Apps Script project
1. Go to **script.google.com** → **New project**.
2. Delete the default `Code.gs` contents and paste in all of
   [`ContractNoteAutoImport.gs`](./ContractNoteAutoImport.gs).
3. Rename the project (e.g. "Contract Note Auto-Import") and save.

### 2. Enable the Sheets advanced service
Left sidebar → **Services** (`+`) → add **Google Sheets API** → Add.
(The script writes with the same `USER_ENTERED` semantics as the web app, which
needs this service.)

### 3. Set up the Gmail label + filter
1. In Gmail, create a label named exactly **`Contract Note`** (matches
   `CONFIG.LABEL_INBOX`).
2. Create a filter that catches your Integrated notes and **applies that label**.
   Match on the broker's sender address (best) or a subject keyword like
   `contract note`. Tip: also tick "Skip the Inbox" so they don't clutter it.
3. Forward (or auto-forward) your Integrated contract-note emails so they land under
   that label with the **`.htm`/`.html` note as an attachment**.

### 4. Dry-run first (writes nothing)
`CONFIG.DRY_RUN` is `true` by default.
1. In the editor, select the `dailyImport` function → **Run**. Approve the
   permission prompts the first time (Gmail read, Sheets, send email).
2. You'll get a **summary email** listing, per note: which portfolio it routed to,
   how many trades it parsed, how many are new vs duplicates, and any unmatched
   names. **Nothing is written to the sheets yet.**
3. Sanity-check: open one of those notes in the web app, import it manually, and
   confirm the trade count / values match what the dry-run email reported.

### 5. Go live
1. Once the dry-run looks right, set `CONFIG.DRY_RUN = false` and save.
2. Run `installDailyTrigger` once (select it → Run). This schedules `dailyImport`
   daily at ~07:00 in the script's timezone. (Change the hour in the function, or
   manage it under the clock icon → **Triggers**.)
3. Done. Each day it imports new notes, emails you a summary, and labels processed
   threads `Contract Note - Imported` so they're never re-imported.

To stop: run `removeDailyTrigger` (or delete the trigger under the clock icon).

---

## What each run does
1. Scans the `Contract Note` label for un-processed threads.
2. For every HTML attachment: parses it, routes by the note's **UCC** to the right
   portfolio sheet, de-dups against `True Entry`, and appends new rows to
   `Raw Entry` + `True Entry` (auto-adding the `IPF Charges` / `Demat Charges` /
   `Import ID` columns if the tab doesn't have them yet).
3. Emails you a summary, labels the thread done, and records each note in the app's
   **Import History** (the `Import Log` tab) — so auto-imports appear there alongside
   manual ones, shown with User = `Auto-import (Apps Script)`. (Only when live, not
   in dry-run. The `Import Log` tab already exists because the app created it.)

## Rewinding an import
Every written row is stamped with an **`Import ID`** (a far-right column), and the
`Import Log` records that id + which portfolio + how many rows. In the app's **Import
History** view, each import (manual or auto) shows a **Rewind** button that deletes
exactly the rows that import added from `Raw Entry` + `True Entry`, then rebuilds the
`Holding` tab and re-syncs capital gains. It only touches rows carrying that one id,
so it never removes an unrelated or legitimately-repeated fill. Rows written before
the `Import ID` column existed have no stamp and aren't rewindable.

## After an import — refresh Holding & Capital Gains
This script imports the **trades** only; it does **not** recompute the `Holding` tab
or capital gains (that logic lives in the web app). So the portfolio summary values
won't move until you open the app and click **Rebuild Holding** and **Sync Capital
Gains** for that account. (A later phase could automate this too.)

## Unmatched securities
If a security's ISIN/name isn't in your Scrip Master, the trade **still imports**
(under its ISIN or the raw parsed name) and the name is **listed in the summary
email**. Add it to the Scrip Master sheet when convenient; future imports then use
the official name.

## Limitations (v1)
- **Integrated HTML only.** No Zerodha PDF (Apps Script can't parse PDF reliably).
- **Name matching is exact** (by ISIN, or exact normalized name/alias) — it doesn't
  do the web app's fuzzy token/prefix matching. Because notes carry ISINs (and the
  parser back-fills them), ISIN matching covers virtually everything; the rare miss
  is listed for you.
- **No Holding/CG recompute** (see above).
- If a note's UCC doesn't match any configured portfolio, it's reported and skipped
  (nothing written).

## Keeping the UCC→sheet list in sync
`PORTFOLIOS` near the top of the `.gs` mirrors `src/lib/portfolios.ts`. If you add or
change a portfolio in the app, update that array too.
