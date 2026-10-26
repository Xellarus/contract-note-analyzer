import { gapi } from "gapi-script";
import { ensureSheetTabs } from "./sheetTabs";
import { generateTrxRegister } from "./trxRegister";
import { CgFormulaSource, FORMULA_TAB_SUFFIX, buildFormulaGrid, BANNER_ROWS, buildPaintRequests } from "./trxFormulaGrid";

export { FORMULA_TAB_SUFFIX, buildFormulaGrid, colA1, buildPaintRequests, BANNER_ROWS } from "./trxFormulaGrid";
export type { CgFormulaSource } from "./trxFormulaGrid";

/**
 * THE FORMULA VIEW — a derivation worksheet beside each capital-gains tab.
 *
 * Asked for as *"dont integrate this in our main capital gain sheet rather for now add an option
 * where we click on the button and then it makes another tab where the sheet is formula derived
 * where possible"* (15-Oct-2026).
 *
 * It writes `<tab> (Formula)` and NEVER touches the tab it twins. Two reasons, and the second is
 * the one that would have bitten:
 *
 *  1. The filed tabs go to a return. Their figures must keep coming from one engine.
 *  2. `tmp-trx-run.mjs` round-trips those tabs. A formula with no cached result reads back as
 *     `undefined` through a workbook reader, so twinning IN PLACE would have blinded the suite
 *     on exactly the cells most worth checking — a broken total row would pass as an empty one.
 *     A separate tab nothing reads back costs the suite nothing.
 *
 * WHAT IS A FORMULA HERE, AND WHAT DELIBERATELY IS NOT
 *
 * The per-sale P/L is the number a reader most wants to click, and on the filed layout it cannot
 * be one: a sale is matched FIFO against lots spread over the purchase rows above it (often
 * several, sometimes the opening stock), so the purchase row BESIDE a sale is not the lot it
 * consumed. `=saleAmt - purchaseAmt` across adjacent rows would look like a derivation and be
 * wrong. So this view adds the one column the filed tab cannot carry — `ACQUISITION COST`, which
 * is exactly `turnover - pnl`, the engine's own identity (`gain = sale turnover - purchase
 * turnover`) — and the P/L cell then has both its inputs on its own row.
 *
 * `ACQUISITION COST` shows its own working too — `=ROUND(G10*D4, 2)`, the quantity sold times the
 * rate it was acquired at, both of them cells on this tab.
 *
 * WHICH rate cell is NOT knowable by position, so it is not guessed at. The emitter hands over
 * every acquisition rate cell in that sale's own block — each opening date-line, then each in-year
 * purchase, in the order FIFO consumes them — and the builder TRIES each one, keeping the first
 * that reproduces the engine's own figure. `qty x rate` is the acquisition cost only when the
 * whole sale came from ONE acquisition line; it does not hold when the sale spans two opening
 * dates at different rates, reaches past the opening into a purchase, or draws on an opening line
 * that is itself a weighted average of same-day lots.
 *
 * A SALE SPANNING LOTS IS STILL A FORMULA — it is a SUM. Sell 8,000 with 3,600 left of the
 * August lot and 4,400 taken from September's, and the cost is `=ROUND(3600*E69+4400*E70,2)`:
 * one term per lot, quantities spelled out because the FIFO split is stated on no row, rates by
 * reference because every one of them IS a cell. The split is not re-derived from the page —
 * walking the printed rows is wrong three ways and silent in all of them (a sale row is a tax
 * BUCKET per date, `catOrder` prints ST above LT while FIFO eats the older LT lots first, and a
 * SPLIT row restates rather than adds). It comes from the consumption loop itself, on `matched`.
 * `FormulaViewResult.acqSummed` counts those.
 *
 * What still keeps the exact VALUE is a lot whose rate is on no cell at all — a post-split lot
 * carrying a rescaled `purPrice`, a consolidated opening line averaging two same-day fills at
 * different prices, an intra-day round trip with no match recorded. `acqAsValue` counts them.
 *
 * The candidates are SCOPED TO THE BLOCK. A rate borrowed from the scrip above would multiply out
 * to an entirely plausible figure belonging to a different company.
 *
 * Left as VALUES, each for its own reason:
 *   • the nine per-row charge cells — PARSED from contract notes, no arithmetic behind them
 *   • `AMOUNT` on consolidated opening/closing rows — the true sum of lot amounts, deliberately
 *     NOT `qty x rate`, so a `=C*D` there would re-introduce the drift consolidation prevents
 *
 * AND NOTHING NETS EXPENSES AGAINST A GAIN. Every gain here is computed on charge-free turnover
 * and under s.48 STT is not a deductible expense. A charge block beside a P/L column already
 * invites that misreading; a formula would turn it into an assertion on a filed-adjacent page.
 */

async function withBackoff<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e: any) {
      last = e;
      const code = e?.result?.error?.code ?? e?.status;
      if (code !== 429 && code !== 503) throw e;
      await new Promise(res => setTimeout(res, 1200 * (i + 1)));
    }
  }
  throw last;
}

export interface FormulaViewResult {
  /** The tabs written, in the order written. */
  tabs: string[];
  /** Per tab: how many cells became formulas. 0 on a tab with no sales is correct, not a failure. */
  formulaCells: number;
  fyLabel: string;
  /** Sales whose P/L cell could be derived. Equals the sale rows across every twinned tab. */
  salesDerived: number;
  /** Sales whose ACQUISITION COST reads `qty x rate` off ONE rate cell on the tab. */
  acqDerived: number;
  /**
   * Sales whose ACQUISITION COST reads as a SUM — one `qty x rate` term per lot FIFO consumed.
   *
   * The second attempt, never the first: where a single line paid for the whole sale,
   * `=ROUND(G75*E69,2)` references the sale-quantity CELL and states the same fact better.
   */
  acqSummed: number;
  /**
   * Sales whose ACQUISITION COST stayed the engine's VALUE.
   *
   * EXPECTED, not a failure, but now RARE: the sum covers a sale spanning lots, so what is left
   * is a lot whose rate is on no cell of this page — a post-split lot carrying a rescaled
   * `purPrice`, a consolidated opening line averaging two same-day fills at different prices, an
   * uncovered quantity with no matching lot at all. Every candidate and every sum is checked
   * against `turnover - pnl` before a formula is written; a row where nothing reproduces it
   * keeps the exact figure.
   *
   * Reported rather than inferred from the difference, because a partly-derived worksheet that
   * reads as fully derived is the one thing this count exists to prevent.
   */
  acqAsValue: number;
  /**
   * The breakdown of `acqAsValue`, because the three reasons have completely different answers.
   *
   * `acqSpanned` - the closest single rate was more than a paise out AND the lot-by-lot sum
   * could not be formed or did not reconcile; the rates it needs are not on this page.
   * `acqRounding` - within a paise; arithmetic, not structure.
   * `acqNoRate` - the block offered no usable rate cell at all.
   */
  acqSpanned: number;
  acqRounding: number;
  acqNoRate: number;
  /**
   * Rows that gained an EXPENSES total (and its EX-STT companion) — every purchase and every
   * sale row across the twinned tabs.
   *
   * Pure aggregation of charge cells already on the page: no charge is computed or second-guessed
   * here, so unlike the acquisition counts there is no "as values" half to report. 0 on a tab with
   * no trades is correct, not a failure.
   */
  expenseRowsTotalled: number;
  /**
   * Charge cells that became `=ROUND(rate x turnover, dp)` because a known statutory rate
   * reproduced the broker's own parsed figure EXACTLY, and how many were attempted.
   *
   * Nothing is computed here: a rate that does not reproduce the figure is discarded and the
   * parsed value stands, so `chargeDerived` well below `chargeAttempted` is the EXPECTED result
   * — STT in particular is rounded to the nearest rupee by Rule 4 and is ALLOCATED per trade off
   * a day-aggregate, so most STT cells can never reproduce. `chargeDerivedBy` says which charge
   * each derivation came from, because "41 of 300" is useless without knowing which kind.
   */
  chargeDerived: number;
  chargeAttempted: number;
  chargeDerivedBy: Record<string, number>;
  /** Did the colour bands land? Values are written either way. */
  painted: boolean;
}

/**
 * Compute the register in COLLECT mode and write only the `(Formula)` twins.
 *
 * The filed capital-gains tabs are never opened. Collect mode still runs the
 * charge-conservation guard, so a register this app would refuse to write cannot be rendered
 * here either — a derived view of figures that failed their own guard is the worst of both.
 */
export async function generateFormulaView(
  spreadsheetId: string,
  fyStartYear: number,
  title?: string,
): Promise<FormulaViewResult> {
  const collected: CgFormulaSource[] = [];
  const res = await generateTrxRegister(spreadsheetId, fyStartYear, title, collected);
  if (!res.collectedOnly) {
    // Unreachable while the sink is passed, and asserted rather than assumed: a future edit that
    // drops the early return would silently REWRITE every filed tab from a button whose whole
    // contract is that it does not.
    throw new Error("Formula view: the register ran in WRITE mode. Refusing — this button must never rewrite a filed tab.");
  }

  const tabs: string[] = [];
  let formulaCells = 0, salesDerived = 0, acqDerived = 0, acqSummed = 0, acqAsValue = 0, expenseRowsTotalled = 0;
  let chargeDerived = 0, chargeAttempted = 0;
  const chargeDerivedBy: Record<string, number> = {};
  let acqSpanned = 0, acqRounding = 0, acqNoRate = 0;

  const titles = collected.map(c => c.tab + FORMULA_TAB_SUFFIX);
  if (titles.length) await withBackoff(() => ensureSheetTabs(spreadsheetId, titles));

  // ONE metadata read for every twin, not one per tab. A `batchUpdate` request carries its own
  // `sheetId`, so N paints never need N `spreadsheets.get` calls - and this runs inside the
  // app's heaviest operation against a 60-read-per-minute quota that nothing counts.
  const idByTitle = new Map<string, number>();
  try {
    const meta: any = await withBackoff(() => (gapi.client as any).sheets.spreadsheets.get({
      spreadsheetId, fields: "sheets.properties(sheetId,title)",
    }));
    for (const sh of (meta?.result?.sheets || [])) {
      const t = (sh.properties?.title || "").toString().trim().toLowerCase();
      if (t) idByTitle.set(t, sh.properties.sheetId);
    }
  } catch (e) {
    console.warn("Formula view: could not read sheet ids - values will be written unpainted.", e);
  }
  const paintRequests: any[] = [];

  for (const src of collected) {
    const tab = src.tab + FORMULA_TAB_SUFFIX;
    const { rows, formulaCells: n, acqDerived: ad, acqSummed: asu, acqAsValue: av,
            acqSpanned: asp, acqRounding: aro, acqNoRate: anr,
            expenseRowsTotalled: ert, chargeDerived: cd, chargeAttempted: ca,
            chargeDerivedBy: cdb } = buildFormulaGrid(src);
    // A:Z is narrower than the twin (the added column can land at Z+1), so clear by the grid's
    // own width rather than a constant - a stale column from a previous, wider run would
    // otherwise sit beside live figures.
    await withBackoff(() => (gapi.client as any).sheets.spreadsheets.values.clear({
      spreadsheetId, range: `${tab}!A:AZ`,
    }));
    await withBackoff(() => (gapi.client as any).sheets.spreadsheets.values.update({
      // USER_ENTERED is REQUIRED for a formula to evaluate, and safe here only because
      // `fmtDate` writes dd.mm.yyyy with DOTS. Slashed dd/mm/yyyy would be reparsed as US
      // mm-dd for every day <= 12 - which is why the ITR schedule is written RAW and is
      // deliberately not twinned by this view.
      spreadsheetId, range: `${tab}!A1`, valueInputOption: "USER_ENTERED", resource: { values: rows },
    }));
    tabs.push(tab);
    formulaCells += n;
    salesDerived += src.derive.saleRows.length;
    acqDerived += ad; acqSummed += asu; acqAsValue += av; expenseRowsTotalled += ert;
    chargeDerived += cd; chargeAttempted += ca;
    for (const k of Object.keys(cdb)) chargeDerivedBy[k] = (chargeDerivedBy[k] || 0) + cdb[k];
    acqSpanned += asp; acqRounding += aro; acqNoRate += anr;

    const sheetId = idByTitle.get(tab.trim().toLowerCase());
    if (sheetId !== undefined) paintRequests.push(...buildPaintRequests(sheetId, src));
    else console.warn(`Formula view: no sheetId for "${tab}" - written unpainted.`);
  }

  // ONE batchUpdate for every twin. Cosmetic, so it must never fail the run - the figures are
  // already on the sheet and a paint can be regenerated by pressing the button again.
  let painted = false;
  if (paintRequests.length) {
    try {
      await withBackoff(() => (gapi.client as any).sheets.spreadsheets.batchUpdate({
        spreadsheetId, resource: { requests: paintRequests },
      }));
      painted = true;
    } catch (e) {
      console.warn("Formula view: formatting failed - values are correct, bands are not.", e);
    }
  }

  return { tabs, formulaCells, fyLabel: res.fyLabel, salesDerived, acqDerived, acqSummed,
           acqAsValue, acqSpanned, acqRounding, acqNoRate, expenseRowsTotalled,
           chargeDerived, chargeAttempted, chargeDerivedBy, painted };
}
