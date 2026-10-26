/**
 * The FORMULA VIEW's grid builder — PURE, and that is deliberate.
 *
 * No `gapi`, no imports at all, so the part that decides what a cell says is testable without a
 * browser and without stubbing a Sheets client. Same split `itrUnlistedSchedule.ts` already
 * follows, and the reason `tmp-formula-view.ts` can be a plain `tsx` run rather than another
 * esbuild bundle that stubs `gapi-script`.
 *
 * The narrative for WHY each cell is or is not a formula lives in `trxFormulaView.ts`, beside
 * the writer that puts it on a sheet.
 */

/**
 * One capital-gains tab, handed over so it can be rebuilt with its arithmetic exposed.
 *
 * `values` is the finished grid, exactly as the filed tab received it. `derive` says which cells
 * were computed and from what, because that is knowable only inside the emitter: a sale's matched
 * purchase cost is `turnover - pnl` and appears nowhere on the page (FIFO consumes lots spread
 * across the purchase rows above, so the purchase row BESIDE a sale is not the one it ate).
 */
export interface CgFormulaSource {
  tab: string;
  values: any[][];
  closingRanges: { start: number; end: number }[];
  derive: {
    saleRows: {
      r: number; plCol: number; sAmtCol: number; sQtyCol: number; turnover: number; pnl: number;
      /**
       * The acquisition RATE cells of this sale's OWN block — each opening date-line and each
       * purchase line, in the order FIFO would consume them.
       *
       * Candidates, not an answer: `ACQUISITION COST = sale qty x rate` holds only where the
       * whole sale came from ONE of them, and which one is not knowable by position. The
       * builder tries each and keeps the first that reproduces the engine's own figure.
       */
      acqCands: { r: number; rateCol: number; ts?: number }[];
      /**
       * The FIFO match for this bucket — the lots that actually paid for it, each with the
       * shares taken from it and the rate they cost.
       *
       * This is the ONLY route to a formula for a sale that drew on more than one acquisition
       * line, because those per-lot quantities appear nowhere on the page and cannot be
       * recovered from it. Absent on an intra-day round trip; EMPTY on an uncovered quantity
       * (sold more than held), which is why the sum is refused unless the quantities add back
       * up to the sale.
       */
      matched?: { qty: number; rate: number; buyTs: number }[];
    }[];
    rateCells: { r: number; qtyCol: number; rateCol: number; amtCol: number }[];
    /**
     * PURCHASE rows — the other kind of row carrying a charge block — with the column their
     * turnover sits in. Recorded by the emitter because position cannot tell a purchase from an
     * opening date-line: `restateCols` puts splits and corp-action restatements in that same
     * column family, so four unrelated row kinds share it.
     */
    purchaseRows: { r: number; amtCol: number }[];
    grandTotalRow: number;
    plColsUsed: number[];
    chargeColsUsed: number[];
    /** The charge columns BY NAME, because a statutory rate belongs to a charge, not a position. */
    chargeCols: { brok: number; stt: number; gst: number; et: number; stamp: number; sebi: number; ipf: number; dmat: number };
    /** The expense footer: the breakdown row, the row carrying their sum, and the column it sits under. */
    expenseRows: { breakdown: number; total: number; totalCol: number };
    /** STT and stamp duty are both levied differently on a squared-off trade. */
    isIntraday: boolean;
    firstDataRow: number;
    paint: {
      sno: number; name: number; oDate: number; pDate: number; sDate: number;
      oQty: number; oRate: number; oAmt: number;
      pQty: number; pRate: number; pAmt: number;
      sQty: number; sRate: number; sAmt: number;
      brok: number; ipf: number; firstPl: number; lastPl: number; width: number;
    };
  };
  /** Row spans the filed tab shades for the P/L band and the expense footer. */
  plBandEnd: number;
  expStart: number;
  expEnd: number;
}

/** Rows the twin prepends above the original grid. Every recorded index shifts by this. */
export const BANNER_ROWS = 3;

export const FORMULA_TAB_SUFFIX = " (Formula)";

/** 0-based column index -> A1 letters. Handles past Z, because these tabs are 24-25 wide. */
export function colA1(i: number): string {
  let s = "", n = i;
  for (;;) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; if (n < 0) break; }
  return s;
}

const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/** The column the twin appends, and the heading it carries. */
export const ACQ_COST_HEADER = "ACQUISITION COST";

/**
 * ACQUISITION COST as `=ROUND(G10*D4, 2)` — the quantity sold times the rate it was acquired at —
 * or `null` to leave the engine's exact value in place.
 *
 * `cands` are the acquisition RATE cells of this sale's own block, in the order FIFO consumes
 * them: each opening date-line, then each in-year purchase. Which one applies is NOT knowable by
 * position, so every candidate is TRIED and the first that reproduces the engine wins.
 *
 * THE RETURN IS VERIFIED BEFORE IT IS OFFERED, and that is the whole safety argument. `qty x rate`
 * is only the acquisition cost when the entire sale came from ONE acquisition line. It does not
 * hold when the sale spans two opening dates at different rates, when it reaches past the opening
 * into an in-year purchase, or when the opening line is itself a weighted average of same-day lots
 * (`consolidateByDate` keys on the timestamp). On those rows this returns `null`, because P/L
 * reads `=SALE AMT - ACQUISITION COST` and a formula that is even a paise out moves a figure on a
 * tax worksheet whose entire job is to reconcile with the filed tab.
 *
 * `ROUND(..., 2)` is what makes a passing check EXACT rather than merely display-identical — the
 * cell then holds the same number the filed tab holds, not one that prints the same.
 */
/**
 * The candidates worth multiplying, in FIFO order, with the rate each one will evaluate to.
 *
 * ONE definition of what counts as usable, shared by the formula writer and the diagnostic that
 * measures how far off it was. Two copies drifting is how a probe anchor stopped being unique
 * and three guards went untested under a green suite.
 *
 * A blank or textual rate cell multiplies to 0 in Sheets, which would state a NIL cost and book
 * the whole proceeds as gain — so an unusable cell is dropped rather than pointed at. A sale with
 * no positive quantity has nothing to multiply at all.
 */
function usableCands(
  saleQty: any,
  cands: { r: number; rateCol: number; ts?: number }[],
  rateAt: (r: number, c: number) => any,
): { c: { r: number; rateCol: number; ts?: number }; rate: number }[] {
  if (typeof saleQty !== "number" || !isFinite(saleQty) || saleQty <= 0) return [];
  if (!cands || !cands.length) return [];
  const out: { c: { r: number; rateCol: number; ts?: number }; rate: number }[] = [];
  for (const c of cands) {
    const rate = rateAt(c.r, c.rateCol);
    // `typeof` is what guards the blank cell, NOT the sign: `blankRow()` fills with "", so an
    // empty rate cell is a STRING and is refused here. A rate of exactly 0 is a real fact — a
    // gift, a transmission, a written-off holding, an allotment against an earlier advance; a
    // zero price is saveable by owner directive — and refusing it kept those sales from ever
    // deriving, for a danger (blank x qty = 0) that the type check already covers.
    if (typeof rate !== "number" || !isFinite(rate) || rate < 0) continue;
    out.push({ c, rate });
  }
  return out;
}

export function acquisitionCostFormula(
  saleQty: any,
  cands: { r: number; rateCol: number; ts?: number }[],
  rateAt: (r: number, c: number) => any,
  qtyRef: string,
  cellRef: (r: number, c: number) => string,
  engineCost: number,
): string | null {
  for (const u of usableCands(saleQty, cands, rateAt)) {
    if (r2(saleQty * u.rate) === engineCost) return `=ROUND(${qtyRef}*${cellRef(u.c.r, u.c.rateCol)},2)`;
  }
  return null;
}

/** A share count as it will be TYPED INTO the formula — and therefore as it must be verified. */
const q6 = (n: number): number => Math.round((Number(n) || 0) * 1e6) / 1e6;

/**
 * ACQUISITION COST for a sale that drew on MORE THAN ONE acquisition line, written as the sum
 * it actually is: `=ROUND(3600*E69+4400*E70, 2)`.
 *
 * A sale of 8,000 that found only 3,600 left of the August lot takes the other 4,400 from the
 * September one, at a different rate. No `sale qty x rate` can express that, which is why those
 * rows kept a bare value — but the sum CAN, and the engine knows the split exactly: it is the
 * FIFO consumption loop's own `m` and `l.purPrice`, carried over on `matched`.
 *
 * The QUANTITIES are literals and the RATES are references, and that asymmetry is forced rather
 * than chosen: 3,600 and 4,400 are stated nowhere on the tab — the sale row carries 8,000 and
 * the acquisition rows carry 40,000 and 20,000 — while every rate IS a cell. So the formula
 * points at what exists and spells out what does not.
 *
 * Three independent guards, because this writes into the column P/L subtracts:
 *   • each lot is resolved to a cell on ITS OWN DATE first, falling back to rate alone only
 *     when the block has no row for that date — a row that merely shares a rate multiplies out
 *     identically but states a false provenance;
 *   • the quantities must add back up to the SALE quantity, so a partial match (an uncovered
 *     sale, a lot with no cell) can never produce a formula that silently understates the cost;
 *   • the total is checked against the engine's own `turnover - pnl` to the paise, exactly as
 *     the single-rate form is. A mis-mapping fails here and the value stands.
 *
 * Two shapes are tried, because the engine rounds PER LOT (`r2(m * purPrice)` inside the gain)
 * while reporting a bucket total that was rounded once. Whichever reproduces the filed figure
 * exactly is the one written; neither is assumed.
 */
export function acquisitionSumFormula(
  saleQty: any,
  matched: { qty: number; rate: number; buyTs: number }[] | undefined,
  cands: { r: number; rateCol: number; ts?: number }[],
  rateAt: (r: number, c: number) => any,
  cellRef: (r: number, c: number) => string,
  engineCost: number,
): string | null {
  if (!matched || !matched.length) return null;
  const usable = usableCands(saleQty, cands, rateAt);
  if (!usable.length) return null;

  const terms: { qty: number; ref: string; rate: number }[] = [];
  for (const m of matched) {
    if (!m || typeof m.qty !== "number" || !isFinite(m.qty) || m.qty <= 0) return null;
    if (typeof m.rate !== "number" || !isFinite(m.rate)) return null;
    // The lot's OWN date wins. Only when the block prints no row for that date does rate alone
    // decide — which is the post-split and merged-same-day-lot case, and there the tolerance
    // below refuses rather than guessing.
    const sameDay = usable.filter(u => u.c.ts !== undefined && u.c.ts === m.buyTs);
    const pool = sameDay.length ? sameDay : usable;
    let best: { c: { r: number; rateCol: number; ts?: number }; rate: number } | null = null;
    let bestMiss = Infinity;
    for (const u of pool) {
      const miss = Math.abs(u.rate - m.rate);
      if (miss < bestMiss) { bestMiss = miss; best = u; }
    }
    // A paise of slack, because an opening line's AMOUNT is written at r2 while the lot carries
    // the unrounded rate — `0.005 / qty` of divergence by construction. Wider than that is a
    // DIFFERENT rate (a post-split lot, a consolidated row averaging two same-day fills at
    // different prices, a reversed-column lot priced on `inclPrice`), and those have no cell on
    // this page to point at. Refusing is the answer: the value below is already correct.
    if (!best || bestMiss > Math.max(0.01, Math.abs(m.rate) * 1e-5)) return null;
    const ref = cellRef(best.c.r, best.c.rateCol);
    const last = terms[terms.length - 1];
    // Consecutive lots off the same line are ONE term. Several same-day fills consolidate to a
    // single printed row, so without this a sale could read `=ROUND(100*D7+250*D7+40*D7,2)`.
    if (last && last.ref === ref) last.qty += m.qty;
    else terms.push({ qty: m.qty, ref, rate: best.rate });
  }
  for (const t of terms) t.qty = q6(t.qty);
  // Verified on the ROUNDED quantities — the ones that will be typed into the cell. Checking
  // the raw ones would validate a formula the sheet is never given.
  if (q6(terms.reduce((s, t) => s + t.qty, 0)) !== q6(saleQty)) return null;

  const sumA = r2(terms.reduce((s, t) => s + t.qty * t.rate, 0));
  if (sumA === engineCost) return `=ROUND(${terms.map(t => `${t.qty}*${t.ref}`).join("+")},2)`;
  const sumB = r2(terms.reduce((s, t) => s + r2(t.qty * t.rate), 0));
  if (sumB === engineCost) return `=ROUND(${terms.map(t => `ROUND(${t.qty}*${t.ref},2)`).join("+")},2)`;
  return null;
}

/**
 * How far the CLOSEST single rate was from the engine, in rupees — or `null` when there was no
 * usable rate to try at all.
 *
 * Diagnostic only: nothing is written from this. It exists because "N cells kept the value" is
 * an undifferentiated number, and the three reasons behind it have completely different answers.
 * A miss of a few paise is arithmetic; a miss of thousands means the sale drew on more than one
 * acquisition line and NO single rate can ever express it, so there is nothing to fix. Without
 * this the only way to tell them apart is to guess — which is how two rounds were spent here.
 */
export function acquisitionMiss(
  saleQty: any,
  cands: { r: number; rateCol: number; ts?: number }[],
  rateAt: (r: number, c: number) => any,
  engineCost: number,
): number | null {
  let best: number | null = null;
  for (const u of usableCands(saleQty, cands, rateAt)) {
    const miss = Math.abs(r2(saleQty * u.rate) - engineCost);
    // The CLOSEST, not the first — otherwise a block whose first line happens to be far off
    // reports "multi-lot" for a sale that is really a paise of rounding, and the breakdown
    // sends the next reader down the wrong branch.
    if (best === null || miss < best) best = miss;
  }
  return best;
}

/** The two columns the twin appends beside ACQUISITION COST, and the headings they carry. */
export const EXPENSES_HEADER = "EXPENSES";
export const EXPENSES_EX_STT_HEADER = "EXPENSES EX-STT";

/** One cell the expense pass wants written, in SOURCE row coordinates (pre-banner). */
export interface CellWrite { r: number; c: number; f: string }

/**
 * Contiguous runs collapse to ranges: columns [7,8,9,11] on one row read `H8:J8,L8`.
 *
 * The eight charge columns are NOT contiguous — `COL.exchClg` sits between SEBI and IPF and is
 * never written — so a naive `first:last` range would sum a headed column that carries nothing,
 * and a future layout change could silently pull a non-charge column into the total.
 */
function a1Runs(cols: number[], r: number, ref: (r: number, c: number) => string): string {
  const s = [...new Set(cols)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i ? `${ref(r, s[i])}:${ref(r, s[j])}` : ref(r, s[i]));
    i = j + 1;
  }
  return parts.join(",");
}

/**
 * THE EXPENSE SIDE'S OWN WORKING — pure aggregation of cells already printed on the tab.
 *
 * Nothing here computes a charge. Charges are PARSED from contract notes and this function never
 * second-guesses one: every cell it writes is a `=SUM()` or a difference of figures the filed tab
 * already carries, so it is exact by construction and cannot state a number the tab does not.
 *
 * Four things it adds, each because the tab today leaves the reader to do it by eye:
 *
 *   • a per-row EXPENSES total. Eight charge columns, non-contiguous, on every purchase and
 *     every sale row, and nowhere on the tab are they added up per row.
 *   • a per-row EXPENSES EX-STT. Under s.48 STT is NOT a deductible expense, so the total a tax
 *     reader needs is not the total the tab foots to. Both are printed rather than leaving the
 *     subtraction to be done in someone's head against the wrong column.
 *   • the footer `Total`, which today is `chargeSum(grand)` — a bare number with no stated
 *     relationship to the eight figures directly above it — becomes `=SUM()` of exactly those.
 *   • a CROSS-FOOT stating, on the sheet, whether the two independent routes to total expenses
 *     agree.
 *
 * THE BREAKDOWN ROW IS DELIBERATELY LEFT AS VALUES, and that is what makes the cross-foot mean
 * anything. Those figures come from `grand`, which `chargeCells` accumulates as it walks the
 * rows — a second, independent pass over the same charges. Point the breakdown at the GRAND
 * TOTAL row instead and both sides of the check reduce to one set of cells, `Σcols Σrows` versus
 * `Σrows Σcols`, which are equal by arithmetic and would make the check DECORATIVE: it would
 * read "ties" forever, including on the day it should not. Left as the engine's own statement, a
 * row written outside `chargeCells`, or one accumulated but not printed, shows up as a figure.
 */
export function expenseFormulas(
  src: CgFormulaSource,
  expCol: number,
  dedCol: number,
  ref: (r: number, c: number) => string,
): { writes: CellWrite[]; rowsTotalled: number } {
  const writes: CellWrite[] = [];
  const d = src.derive;
  const cols = d.chargeColsUsed || [];
  const stt = d.chargeCols ? d.chargeCols.stt : -1;
  if (!cols.length) return { writes, rowsTotalled: 0 };

  // Every row carrying a charge block — purchases and sales alike, in sheet order so the
  // formulas read down the page the way the rows do.
  const charged = [
    ...(d.purchaseRows || []).map(p => p.r),
    ...(d.saleRows || []).map(s => s.r),
  ].sort((a, b) => a - b);

  let rowsTotalled = 0;
  for (const r of charged) {
    if (!src.values[r]) continue;
    writes.push({ r, c: expCol, f: `=SUM(${a1Runs(cols, r, ref)})` });
    // Subtracted from the cell beside it, not re-summed from seven columns: the two figures must
    // differ by EXACTLY the STT cell, and re-deriving invites them to differ by anything else.
    if (stt >= 0) writes.push({ r, c: dedCol, f: `=${ref(r, expCol)}-${ref(r, stt)}` });
    rowsTotalled++;
  }

  const ex = d.expenseRows;
  const gt = d.grandTotalRow;
  if (ex && src.values[ex.total]) {
    const totalRef = ref(ex.total, ex.totalCol);
    writes.push({ r: ex.total, c: ex.totalCol, f: `=SUM(${a1Runs(cols, ex.breakdown, ref)})` });
    if (stt >= 0) writes.push({ r: ex.total, c: dedCol, f: `=${totalRef}-${ref(ex.breakdown, stt)}` });
    // THE CROSS-FOOT, stated on the sheet rather than left for a reader to check by hand: the
    // engine's own accumulated total against Sheets' sum of the per-row totals. It names the
    // difference instead of just failing, because "these two numbers disagree" is useless
    // without knowing by how much.
    if (gt >= 0 && src.values[gt]) {
      const diff = `ROUND(${totalRef}-${ref(gt, expCol)},2)`;
      writes.push({
        r: ex.total, c: expCol,
        f: `=IF(${diff}=0,"ties to the rows above","DIFFERS by "&TEXT(${diff},"0.00"))`,
      });
    }
  }
  return { writes, rowsTotalled };
}

/**
 * A statutory rate, as a CANDIDATE — never an assertion.
 *
 * `dp` is where the charge is rounded. STT is rounded to the NEAREST RUPEE by law (Rule 4,
 * Securities Transaction Tax Rules 2004 — "50 paise or more goes up to one rupee, less is
 * ignored"), which is the documented 20-paise Share India residual seen from the other side. So
 * both `0` and `2` are offered and whichever reproduces the broker's own figure wins.
 */
export interface RateCandidate {
  rate: number;
  side: "BUY" | "SELL" | "BOTH";
  segment: "DELIVERY" | "INTRADAY" | "BOTH";
  dp: 0 | 2;
  why: string;
}

/**
 * THE RATE TABLE — read once, correctable in one place, and never trusted.
 *
 * Every entry is TRIED and kept only where `rate x turnover` reproduces the charge the broker
 * actually printed, to the paise. So a rate that is wrong, stale, or simply not the one that
 * applied costs a FALLBACK and never a wrong number — which is what makes it safe to list rates
 * that changed inside the window, and to list several for one charge.
 *
 * Ordered most-likely-first, because the first candidate that reproduces the figure is the one
 * written and ties should resolve to the ordinary case.
 *
 * NOT listed, deliberately: BROKERAGE (plan-specific, no identity), DMAT (flat per scrip per day)
 * and the ninth `exchClg` column (no field behind it).
 */
export const CHARGE_RATES: Record<string, RateCandidate[]> = {
  // Cash equity STT did NOT change in FY2024-25..FY2026-27 — the 2024 and 2026 Finance Act
  // revisions moved only F&O rates, and the exchange notices reprint the cash rows marked
  // "(No Change)". One rate per side covers all three years.
  stt: [
    { rate: 0.001, side: "SELL", segment: "DELIVERY", dp: 2, why: "delivery sell 0.1%" },
    { rate: 0.001, side: "SELL", segment: "DELIVERY", dp: 0, why: "delivery sell 0.1%, settled to the rupee" },
    { rate: 0.001, side: "BUY", segment: "DELIVERY", dp: 2, why: "delivery buy 0.1%" },
    { rate: 0.001, side: "BUY", segment: "DELIVERY", dp: 0, why: "delivery buy 0.1%, settled to the rupee" },
    { rate: 0.00025, side: "SELL", segment: "INTRADAY", dp: 2, why: "intraday sell 0.025%" },
    { rate: 0.00025, side: "SELL", segment: "INTRADAY", dp: 0, why: "intraday sell 0.025%, settled to the rupee" },
    // An equity-oriented FUND unit (an ETF) sells at 0.001%, a hundredth of the share rate —
    // listed so an ETF row is not matched against 0.1% and missed by a factor of 100.
    { rate: 0.00001, side: "SELL", segment: "DELIVERY", dp: 2, why: "ETF unit sell 0.001%" },
    { rate: 0.00001, side: "SELL", segment: "DELIVERY", dp: 0, why: "ETF unit sell 0.001%, settled to the rupee" },
  ],
  // Collected FROM THE BUYER under s.9A(1)(a) of the Indian Stamp Act — there is no sell-side
  // duty on an exchange trade at all, so a sale row never derives one and that is correct.
  stamp: [
    { rate: 0.00015, side: "BUY", segment: "DELIVERY", dp: 2, why: "delivery buy 0.015%" },
    { rate: 0.00015, side: "BUY", segment: "DELIVERY", dp: 0, why: "delivery buy 0.015%, to the rupee" },
    { rate: 0.00003, side: "BUY", segment: "INTRADAY", dp: 2, why: "intraday buy 0.003%" },
    { rate: 0.00003, side: "BUY", segment: "INTRADAY", dp: 0, why: "intraday buy 0.003%, to the rupee" },
  ],
  // Rs 10 per crore, each side, unchanged since 2019.
  sebi: [{ rate: 0.000001, side: "BOTH", segment: "BOTH", dp: 2, why: "SEBI turnover fee Rs 10/crore" }],
  // SIX live rates and the row does not record WHICH EXCHANGE it traded on, which is exactly the
  // shape the verification exists for: all of them are offered and the figure decides.
  et: [
    { rate: 0.0000307, side: "BOTH", segment: "BOTH", dp: 2, why: "NSE Rs 307/crore (from 01-Oct-2024, incl. IPFT)" },
    { rate: 0.0000375, side: "BOTH", segment: "BOTH", dp: 2, why: "BSE groups A/B Rs 375/crore" },
    { rate: 0.0000325, side: "BOTH", segment: "BOTH", dp: 2, why: "NSE Rs 325/crore (before 01-Oct-2024)" },
    { rate: 0.000030699, side: "BOTH", segment: "BOTH", dp: 2, why: "NSE Rs 306.99/crore (from 01-Mar-2026)" },
    { rate: 0.0000275, side: "BOTH", segment: "BOTH", dp: 2, why: "BSE groups M/MT/MS Rs 275/crore" },
  ],
  // NSE's IPFT was a separate line until it was folded into the Rs 307 combined rate, then cut
  // to Rs 0.01/crore in Mar-2026. BSE levies none as a contract-note line.
  ipf: [
    { rate: 0.000001, side: "BOTH", segment: "BOTH", dp: 2, why: "NSE IPFT Rs 10/crore (from 01-Apr-2023)" },
    { rate: 0.000000001, side: "BOTH", segment: "BOTH", dp: 2, why: "NSE IPFT Rs 0.01/crore (from 01-Mar-2026)" },
  ],
};

/** GST is 18% of a CHARGE BASE, never of turnover. STT and stamp duty sit OUTSIDE it. */
export const GST_RATE = 0.18;
/**
 * Which charges form that base, most-likely composition first.
 *
 * This is the app's own identity, not a guess: `finalizeContractNote` already derives GST as 18%
 * of brokerage + exchange transaction charges + SEBI turnover fee + clearing, and normalises
 * Share India's `Taxable Value of Supply` on exactly that reading.
 */
export const GST_BASES: string[][] = [
  ["brok", "et", "sebi"],
  ["brok", "et", "sebi", "ipf"],
  ["brok", "et"],
  ["brok"],
];

/** A decimal that Sheets will read. `String(1e-9)` is "1e-9", which it will not. */
function plainDecimal(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

const roundTo = (n: number, dp: 0 | 2): number =>
  dp === 0 ? Math.round(n) : Math.round(n * 100) / 100;

/**
 * THE STATUTORY IDENTITIES, each one CHECKED against the figure the broker actually printed.
 *
 * Charges are PARSED from contract notes; this function does not compute one. It asks whether a
 * known rate reproduces the parsed figure EXACTLY, and writes the arithmetic only where it does.
 * A rate that is wrong, stale, or simply not the one that applied therefore costs a fallback and
 * never a wrong number — which is the only reason it is safe to offer six exchange-charge rates
 * against a row that does not record its exchange.
 *
 * Three things it will not do:
 *   • touch a BLANK charge cell. `chargeCells` writes `c.brok || ""`, so an uncharged line is a
 *     STRING — turning it into `0.00` would assert the broker levied nothing where the truth is
 *     that nothing was recorded.
 *   • attempt BROKERAGE or DMAT. A brokerage plan has no statutory identity and a demat charge is
 *     flat per scrip per day; a formula there would be numerology that happened to foot.
 *   • reproduce a per-trade STT that was ALLOCATED rather than computed. `allocateStt` anchors on
 *     the note's printed total and pro-rates, and the exchange itself rounds a day-aggregate per
 *     client, per scrip, per side — so on a scrip with several fills in one day the SUM ties and
 *     the individual rows do not. Those simply keep their value, which is correct.
 */
export function chargeIdentityFormulas(
  src: CgFormulaSource,
  ref: (r: number, c: number) => string,
): { writes: CellWrite[]; derived: Record<string, number>; attempted: number } {
  const writes: CellWrite[] = [];
  const derived: Record<string, number> = {};
  const d = src.derive;
  const cc = d.chargeCols;
  if (!cc) return { writes, derived, attempted: 0 };
  const segment = d.isIntraday ? "INTRADAY" : "DELIVERY";
  const rows: { r: number; amtCol: number; side: "BUY" | "SELL" }[] = [
    ...(d.purchaseRows || []).map(p => ({ r: p.r, amtCol: p.amtCol, side: "BUY" as const })),
    ...(d.saleRows || []).map(s => ({ r: s.r, amtCol: s.sAmtCol, side: "SELL" as const })),
  ].sort((a, b) => a.r - b.r);

  let attempted = 0;
  for (const row of rows) {
    const vals = src.values[row.r];
    if (!vals) continue;
    const turnover = vals[row.amtCol];
    if (typeof turnover !== "number" || !isFinite(turnover) || turnover <= 0) continue;

    for (const key of Object.keys(CHARGE_RATES)) {
      const col = (cc as any)[key];
      if (typeof col !== "number" || col < 0) continue;
      const parsed = vals[col];
      // `typeof` guards the blank, exactly as the acquisition path does — an empty charge cell
      // is a STRING, and a charge of genuinely 0 is a fact worth deriving.
      if (typeof parsed !== "number" || !isFinite(parsed)) continue;
      attempted++;
      for (const cand of CHARGE_RATES[key]) {
        if (cand.side !== "BOTH" && cand.side !== row.side) continue;
        if (cand.segment !== "BOTH" && cand.segment !== segment) continue;
        if (roundTo(cand.rate * turnover, cand.dp) !== r2(parsed)) continue;
        writes.push({
          r: row.r, c: col,
          f: `=ROUND(${plainDecimal(cand.rate)}*${ref(row.r, row.amtCol)},${cand.dp})`,
        });
        derived[key] = (derived[key] || 0) + 1;
        break;
      }
    }

    // GST last, because its base names the other charge cells — several of which may have just
    // become formulas themselves. Sheets resolves the chain; there is no cycle, since GST is
    // never inside its own base.
    const gstCol = cc.gst;
    const gstVal = typeof gstCol === "number" && gstCol >= 0 ? vals[gstCol] : undefined;
    if (typeof gstVal === "number" && isFinite(gstVal)) {
      attempted++;
      for (const base of GST_BASES) {
        const colsOf = base.map(k => (cc as any)[k]).filter(c => typeof c === "number" && c >= 0);
        if (colsOf.length !== base.length) continue;
        const sum = colsOf.reduce((s, c) => s + (typeof vals[c] === "number" ? vals[c] : 0), 0);
        if (r2(GST_RATE * sum) !== r2(gstVal)) continue;
        writes.push({
          r: row.r, c: gstCol,
          f: `=ROUND(${GST_RATE}*(${colsOf.map(c => ref(row.r, c)).join("+")}),2)`,
        });
        derived.gst = (derived.gst || 0) + 1;
        break;
      }
    }
  }
  return { writes, derived, attempted };
}

/**
 * Build the twin grid for one capital-gains tab.
 *
 * Pure: no `gapi`, so the part that decides what a cell says is testable without a browser.
 */
export function buildFormulaGrid(src: CgFormulaSource): { rows: any[][]; formulaCells: number; acqDerived: number; acqSummed: number; acqAsValue: number; acqSpanned: number; acqRounding: number; acqNoRate: number; expenseRowsTotalled: number; chargeDerived: number; chargeAttempted: number; chargeDerivedBy: Record<string, number> } {
  const width = Math.max(0, ...src.values.map(r => r.length));
  // APPENDED, never inserted. Every index in `derive` was recorded against the filed layout, and
  // those indices are the only thing tying a formula to the right cell — inserting a column
  // mid-grid would shift them all and silently re-point every formula one column over.
  const mcCol = width;
  // Appended AFTER ACQUISITION COST, never between it and the filed layout. Same reason that one
  // is appended: every index in `derive` was recorded against the filed grid, and an insertion
  // re-points every formula one column over onto a grid that still looks right.
  const expCol = width + 1;
  const dedCol = width + 2;

  // THE one definition, shared with the paint. Two copies would drift and the bands would
  // sit a row off the values they describe - which looks like a rendering quirk, not a bug.
  const BANNER = BANNER_ROWS;
  const a1 = (c: number, r0: number) => `${colA1(c)}${r0 + BANNER + 1}`;   // r0 is 0-based in src

  const rows: any[][] = [
    [`DERIVED VIEW of "${src.tab}" — formulas show the arithmetic this app performed.`],
    ["The authoritative figures are on the tab this twins. Charges are PARSED from contract notes and are NOT deducted from any gain (s.48) — the EXPENSES columns total them, nothing subtracts them from a P/L. The expense breakdown row is left as the engine's own figure so the cross-foot beneath it is a real check."],
    [],
  ];
  for (const r of src.values) rows.push([...r]);

  // Header for the added column, on the original's own header row (index 2 in src).
  const hdrRow = rows[2 + BANNER];
  if (hdrRow) {
    hdrRow[mcCol] = ACQ_COST_HEADER;
    hdrRow[expCol] = EXPENSES_HEADER;
    hdrRow[dedCol] = EXPENSES_EX_STT_HEADER;
  }

  let formulaCells = 0;
  let acqDerived = 0, acqSummed = 0, acqAsValue = 0;
  // Why each fallback fell back. Diagnostic only; nothing is written from these.
  let acqSpanned = 0, acqRounding = 0, acqNoRate = 0;

  /**
   * What a RATE cell will actually EVALUATE to once this twin is on a sheet.
   *
   * Every opening and purchase rate cell becomes `=AMOUNT/QTY` further down, so a formula that
   * points at one is multiplied by the full-precision quotient — NOT by the r6 figure the filed
   * tab prints in that cell. Verifying ACQUISITION COST against the printed value would check a
   * number the sheet never computes, and it fails in the direction that costs the most: an r6
   * rate is up to 5e-7 off per share, so a position of 10,000 shares is already more than half a
   * paise out and an exact check rejects rows that are in fact exact. On this book, which holds
   * lakhs of shares of low-priced scrips, that was the common case rather than the rare one.
   *
   * ONE definition, consulted by BOTH the verifier and the loop that writes those formulas, so
   * the two cannot drift — the drift was the bug.
   */
  const liveRate = new Map<string, number>();
  for (const rc of src.derive.rateCells) {
    const q = (src.values[rc.r] || [])[rc.qtyCol];
    const a = (src.values[rc.r] || [])[rc.amtCol];
    // Belt and braces behind the emitter's own filtering: a formula is written only where BOTH
    // cells really are numbers and the quantity is positive. The emitter already excludes the
    // contra line and the `CLOSING NIL` row; this catches anything it stops excluding later.
    if (typeof q !== "number" || !(q > 0) || typeof a !== "number") continue;
    liveRate.set(`${rc.r}:${rc.rateCol}`, a / q);
  }
  /** The rate a formula pointing at this cell will be multiplied by. */
  const effectiveRate = (r: number, c: number): any => {
    const k = `${r}:${c}`;
    return liveRate.has(k) ? liveRate.get(k)! : (src.values[r] || [])[c];
  };

  // ── per-sale P/L, and ACQUISITION COST as qty x the rate it was acquired at ────────────────
  for (const s of src.derive.saleRows) {
    const row = rows[s.r + BANNER];
    if (!row) continue;
    // The engine's own answer, and the yardstick every formula below is checked against.
    // `turnover - pnl` is its identity, not a re-derivation: `gain = sale turnover - purchase
    // turnover`, so this IS the purchase side.
    const engineCost = r2(s.turnover - s.pnl);
    const saleQty = (src.values[s.r] || [])[s.sQtyCol];
    const f = acquisitionCostFormula(
      saleQty, s.acqCands, effectiveRate, a1(s.sQtyCol, s.r), (r, c) => a1(c, r), engineCost,
    );
    // The SUM is the second attempt, never the first. Where one line paid for the whole sale,
    // `=ROUND(G75*E69,2)` references the sale-quantity CELL and is the better statement of the
    // same fact; the sum has to spell its quantities out because the FIFO split is on no row.
    const sum = f ? null : acquisitionSumFormula(
      saleQty, s.matched, s.acqCands, effectiveRate, (r, c) => a1(c, r), engineCost,
    );
    if (f) { row[mcCol] = f; formulaCells++; acqDerived++; }
    else if (sum) { row[mcCol] = sum; formulaCells++; acqSummed++; }
    else {
      row[mcCol] = engineCost; acqAsValue++;
      // SAY WHICH KIND OF FALLBACK IT IS. "N kept the value" is an undifferentiated number and
      // the three reasons behind it have completely different answers: nothing to point at, a
      // few paise of arithmetic, or a sale drawing on lots whose rates are not on this page at
      // all. Guessing between them cost two rounds.
      const miss = acquisitionMiss(saleQty, s.acqCands, effectiveRate, engineCost);
      if (miss === null) acqNoRate++;
      else if (miss <= 0.01) acqRounding++;
      else acqSpanned++;
    }
    // The filed tab leaves this blank when the P/L is 0 (an uncovered quantity with no matching
    // lot). The twin writes the formula anyway and it evaluates to 0 — on a worksheet whose job
    // is to show the arithmetic, a blank reads as "not checked" rather than "checked, nil".
    row[s.plCol] = `=${a1(s.sAmtCol, s.r)}-${a1(mcCol, s.r)}`;
    formulaCells++;
  }

  // ── RATE = AMOUNT / QTY ───────────────────────────────────────────────────────────────────
  //
  // The direction is the codebase's own: AMOUNT is authoritative and RATE is derived from it.
  // On a consolidated row the amount is the TRUE SUM of lot amounts and the rate is a weighted
  // average, and `aggSubtotal` literally computes `r6(amt / q)` - so this reproduces the code
  // rather than approximating it. Going the other way (`=QTY*RATE`) would re-introduce exactly
  // the drift consolidation exists to prevent.
  for (const rc of src.derive.rateCells) {
    const row = rows[rc.r + BANNER];
    if (!row) continue;
    // `liveRate` IS the guard — it holds exactly the cells that may take this formula, and it is
    // the same map the ACQUISITION COST verifier multiplied by. Re-testing the cells here would
    // be a second copy of the rule, free to drift from what was verified.
    if (!liveRate.has(`${rc.r}:${rc.rateCol}`)) continue;
    row[rc.rateCol] = `=${a1(rc.amtCol, rc.r)}/${a1(rc.qtyCol, rc.r)}`;
    formulaCells++;
  }

  // ── THE EXPENSE SIDE ──────────────────────────────────────────────────────────────────────
  //
  // Its own function, and it touches nothing the parser or the register computes: every cell is
  // a sum or a difference of figures already printed on this tab.
  const exp = expenseFormulas(src, expCol, dedCol, (r, c) => a1(c, r));
  for (const w of exp.writes) {
    const row = rows[w.r + BANNER];
    if (!row) continue;
    row[w.c] = w.f;
    formulaCells++;
  }
  const expenseRowsTotalled = exp.rowsTotalled;

  // ── THE STATUTORY IDENTITIES ──────────────────────────────────────────────────────────────
  //
  // Reads `src.values` (the PARSED figures) and writes into `rows`, so nothing it does can feed
  // back into its own check. A charge cell becomes a formula only where a known rate reproduces
  // the broker's own figure exactly; everywhere else the parsed value stands.
  const ident = chargeIdentityFormulas(src, (r, c) => a1(c, r));
  for (const w of ident.writes) {
    const row = rows[w.r + BANNER];
    if (!row) continue;
    row[w.c] = w.f;
    formulaCells++;
  }
  const chargeDerived = ident.writes.length;
  const chargeAttempted = ident.attempted;
  const chargeDerivedBy = ident.derived;

  // ── GRAND TOTAL ───────────────────────────────────────────────────────────────────────────
  const gt = src.derive.grandTotalRow;
  if (gt >= 0 && rows[gt + BANNER]) {
    const from = src.derive.firstDataRow;
    const to = gt - 1;
    if (to >= from) {
      const sum = (c: number) => `=SUM(${a1(c, from)}:${a1(c, to)})`;
      for (const c of src.derive.plColsUsed) { rows[gt + BANNER][c] = sum(c); formulaCells++; }
      for (const c of src.derive.chargeColsUsed) { rows[gt + BANNER][c] = sum(c); formulaCells++; }
      rows[gt + BANNER][mcCol] = sum(mcCol); formulaCells++;
      // The EXPENSES grand total is one HALF of the cross-foot in the footer below — it sums the
      // per-row totals, where the footer's own `Total` sums the per-charge ones.
      rows[gt + BANNER][expCol] = sum(expCol); formulaCells++;
      rows[gt + BANNER][dedCol] = sum(dedCol); formulaCells++;
    }
  }

  // DELIBERATELY NOT DONE: the per-scrip CLOSING subtotals. `closingRanges` is a PAINT range —
  // it exists so those rows shade green — and it does not say which row carries the subtotal or
  // which column it sits in. A `=SUM()` over a guessed range is worse than the correct value
  // that is already there, so these stay as values until the emitter records the subtotal cell
  // itself. Same rule as the ninth charge column: do not formula-ise what you cannot locate.

  return { rows, formulaCells, acqDerived, acqSummed, acqAsValue, acqSpanned, acqRounding, acqNoRate,
           expenseRowsTotalled, chargeDerived, chargeAttempted, chargeDerivedBy };
}

/**
 * The twin's paint, mirroring `writeAndPaint`'s on the filed tab.
 *
 * Two shifts and nothing else is allowed to differ, or the bands stop meaning what they mean on
 * the tab this twins:
 *   • every ROW index moves by BANNER_ROWS, because the twin prepends an explanatory header
 *   • the added ACQUISITION COST column sits at `width`, so the header band is widened by one
 * Column indices are otherwise untouched - ACQUISITION COST is APPENDED, never inserted.
 *
 * The RESET must be first and must stay unbounded. `values.clear()` wipes cell values but NOT
 * formatting, so without it a previous run's bands sit over this run's rows - and on the twin
 * that is worse than on the filed tab, because a re-run whose row count changed leaves those
 * bands offset from the values beneath them.
 */
export function buildPaintRequests(sheetId: number, src: CgFormulaSource): any[] {
  const B = BANNER_ROWS;
  const P = src.derive.paint;
  const WHITE = { red: 1, green: 1, blue: 1 };
  const rgb = (r: number, g: number, b: number) => ({ red: r, green: g, blue: b });
  // Lifted verbatim from writeAndPaint - a twin in different colours is not a twin.
  const GREEN = rgb(0.298, 0.686, 0.314), ORANGE = rgb(0.93, 0.60, 0.25),
    SALMON = rgb(0.96, 0.60, 0.51), LIME = rgb(0.61, 0.80, 0.40);
  const INR = "#,##,##0.00", INT = "#,##,##0";
  // 2-6 dp: a rate is carried at full precision and must not be truncated to paise on screen -
  // and on this tab the rate cells are FORMULAS, which makes the displayed precision the only
  // thing standing between the reader and a figure that looks rounded.
  const RATE = "#,##,##0.00####";

  const numFmt = (c0: number, c1: number, pattern: string) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: 3 + B, startColumnIndex: c0, endColumnIndex: c1 },
      cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern } } },
      fields: "userEnteredFormat.numberFormat",
    },
  });
  const fill = (r0: number, r1: number, c0: number, c1: number, color: any) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 },
      cell: { userEnteredFormat: { backgroundColor: color } },
      fields: "userEnteredFormat.backgroundColor",
    },
  });
  const bold = (r0: number, r1: number, c0?: number, c1?: number) => ({
    repeatCell: {
      range: c0 === undefined
        ? { sheetId, startRowIndex: r0, endRowIndex: r1 }
        : { sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: "userEnteredFormat.textFormat.bold",
    },
  });

  const reqs: any[] = [
    {
      repeatCell: {
        range: { sheetId },
        cell: { userEnteredFormat: { backgroundColor: WHITE, textFormat: { bold: false } } },
        fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold",
      },
    },
    numFmt(P.oQty, P.oQty + 1, INT),
    numFmt(P.oRate, P.oRate + 1, RATE),
    numFmt(P.oAmt, P.oAmt + 1, INR),
    numFmt(P.pQty, P.pQty + 1, INT),
    numFmt(P.pRate, P.pRate + 1, RATE),
    numFmt(P.pAmt, P.pAmt + 1, INR),
    numFmt(P.sQty, P.sQty + 1, INT),
    numFmt(P.sRate, P.sRate + 1, RATE),
    numFmt(P.sAmt, P.ipf + 1, INR),
    // ACQUISITION COST, EXPENSES and EXPENSES EX-STT. The cross-foot cell in the EXPENSES column
    // holds TEXT, which a money format leaves alone — Sheets renders a string as a string.
    numFmt(P.width, P.width + 3, INR),
    bold(0, 2),                                  // the twin's own explanatory banner
    bold(0 + B, 3 + B),                          // title + group header + column header
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 3 + B } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    fill(1 + B, 3 + B, P.sno, P.oDate, GREEN),
    fill(1 + B, 3 + B, P.oDate, P.pDate, ORANGE),
    fill(1 + B, 3 + B, P.pDate, P.sDate, GREEN),
    fill(1 + B, 3 + B, P.sDate, P.firstPl, SALMON),
    fill(1 + B, 3 + B, P.firstPl, P.brok, GREEN),
    fill(1 + B, 3 + B, P.brok, P.width, GREEN),
    fill(1 + B, 3 + B, P.width, P.width + 3, GREEN),   // the three added columns' headers
    fill(3 + B, src.plBandEnd + B, P.firstPl, P.brok, LIME),
  ];
  for (const cr of src.closingRanges) reqs.push(fill(cr.start + B, cr.end + B, P.name, P.pDate, LIME));
  reqs.push(
    fill(src.expStart + B, src.expEnd + B, P.lastPl, P.lastPl + 1, LIME),
    bold(src.expStart + B, src.expEnd + B, P.lastPl, P.lastPl + 1),
  );
  return reqs;
}
