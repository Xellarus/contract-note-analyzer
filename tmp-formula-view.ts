/**
 * The FORMULA VIEW's grid builder, driven directly.
 *
 * `buildFormulaGrid` is pure, so a SYNTHETIC fixture is sharper than a real tab here — each case
 * isolates one rule and asserts the exact cell, the same reason `tmp-recon-run.mjs` drives its
 * reconciler directly rather than through a PDF. (The fixtures-from-real-output rule governs
 * PARSERS, where a hand-typed sample can hide a self-consistent misparse; there is no parsing
 * here, only layout arithmetic.)
 *
 * Run:  npx tsx tmp-formula-view.ts
 */
import { readFileSync } from "node:fs";
import { buildFormulaGrid, colA1, FORMULA_TAB_SUFFIX, BANNER_ROWS, buildPaintRequests, acquisitionCostFormula, acquisitionMiss, acquisitionSumFormula, expenseFormulas, chargeIdentityFormulas, CHARGE_RATES } from "./src/lib/trxFormulaGrid";
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
};
const eq = (label: string, got: any, want: any) => ok(`${label}  (got ${JSON.stringify(got)})`, got === want);

const strip = (p: string) =>
  readFileSync(p, "utf8").replace(/(^|[^*])\/\*[\s\S]*?\*\//g, "$1").replace(/^\s*\/\/.*$/gm, "");

// ── a minimal capital-gains tab, shaped exactly as emitTab produces one ──────────────────────
// rows 0,1,2 = title / group header / column header; data from row 3.
// Columns: 0 name, 1 sDate, 2 sQty, 3 sRate, 4 sAmt, 5 PL-ST, 6 PL-LT, 7 brok, 8 stt
// Columns: 0 NAME | 1-4 OPENING d/q/r/a | 5-8 SALES d/q/r/a | 9 PL-ST | 10 PL-LT | 11 brok | 12 stt
const WIDTH = 13;
const blank = () => new Array(WIDTH).fill("");
const src = () => {
  const v: any[][] = [];
  const t = blank(); t[0] = "Capital Gains for FY26-27"; v.push(t);
  const g = blank(); g[1] = "OPENING STOCK"; g[5] = "SALES"; g[9] = "SHORT TERM"; g[10] = "LONG TERM"; v.push(g);
  v.push(["NAME", "DATE", "QTY", "RATE", "AMOUNT", "DATE", "QTY", "RATE", "AMOUNT", "SHORT", "LONG", "BROK", "STT"]);

  // r3 head row: name + the FIRST opening date-line. The AMOUNT deliberately does not divide to
  // the printed r6 RATE — 25000000.03 / 100000 is 250.0000003, which prints as 250. That gap is
  // the whole point: on the twin this rate cell becomes `=AMOUNT/QTY`, so a formula pointing at
  // it is multiplied by 250.0000003, and a verifier reading the PRINTED 250 would check a number
  // the sheet never computes. At 20,000 shares the two answers differ by a paise.
  const head = blank(); head[0] = "ACME"; head[1] = "20.08.2024"; head[2] = 100000; head[3] = 250; head[4] = 25000000.03; v.push(head);
  // r4 a second opening date-line whose amount/qty does NOT divide evenly - the real shape
  const op2 = blank(); op2[1] = "07.01.2025"; op2[2] = 93000; op2[3] = 64.291613; op2[4] = 5979120.01; v.push(op2);
  // r5 a CONTRA line: a signed amount with NO qty and NO rate. Must get no formula.
  const contra = blank(); contra[0] = "DEMERGER"; contra[4] = -120000; v.push(contra);
  // r6 sale ST — 100 sh, and its cost is 100 x 250, the rate on the FIRST opening line (r3).
  const s1 = blank(); s1[5] = "10.06.2026"; s1[6] = 20000; s1[7] = 460; s1[8] = 9200000; s1[9] = 4199999.99; s1[11] = 9.1; v.push(s1);
  // r7 sale LT — 50 sh whose cost is 50 x 64.291613, the SECOND opening line (r4). Deliberate:
  // the first candidate must NOT win by default, or a one-candidate test would prove nothing.
  const s2 = blank(); s2[5] = "12.08.2026"; s2[6] = 50; s2[7] = 300; s2[8] = 15000; s2[10] = 11785.42; s2[12] = 1.75; v.push(s2);
  // r8 CLOSING NIL - the amount column carries TEXT. Must get no formula.
  const nil = blank(); nil[0] = "CLOSING"; nil[4] = "NIL"; v.push(nil);
  // r9 GRAND TOTAL
  const gt = blank(); gt[0] = "GRAND TOTAL"; gt[9] = 4199999.99; gt[10] = 11785.42; gt[11] = 20.6; gt[12] = 4; v.push(gt);
  // r10 the expense BREAKDOWN — the engine's own accumulated totals, and they must STAY values.
  // Point them at the GRAND TOTAL row and both sides of the cross-foot below collapse to one set
  // of cells (Σcols Σrows vs Σrows Σcols, equal by arithmetic), so the check would read "ties"
  // forever — including on the day it should not.
  const expB = blank(); expB[10] = "Expenses"; expB[11] = 20.6; expB[12] = 4; v.push(expB);
  // r11 the Total: today a bare number with no stated relationship to the two figures above it.
  const expT = blank(); expT[10] = "Total"; expT[11] = 24.6; v.push(expT);

  return {
    tab: "Capital Gains for FY26-27",
    values: v,
    closingRanges: [{ start: 8, end: 9 }],
    plBandEnd: 9, expStart: 10, expEnd: 12,
    derive: {
      // `acqCands` are the block's acquisition RATE cells in FIFO order — here the two opening
      // date-lines at r3 and r4. BOTH sales get BOTH candidates; which one applies is exactly
      // what the builder has to work out, and it may only do so by reproducing the engine.
      saleRows: [
        // `matched` is present and covers the whole sale off ONE line. The single-rate form
        // must still win: it references the sale-quantity CELL (G10), where the sum would have
        // to spell 20000 out. Both reproduce the engine, so only the ORDER decides.
        { r: 6, plCol: 9, sAmtCol: 8, sQtyCol: 6, turnover: 9200000, pnl: 4199999.99,
          acqCands: [{ r: 3, rateCol: 3, ts: 1000 }, { r: 4, rateCol: 3, ts: 2000 }],
          matched: [{ qty: 20000, rate: 250.0000003, buyTs: 1000 }] },
        { r: 7, plCol: 10, sAmtCol: 8, sQtyCol: 6, turnover: 15000, pnl: 11785.42,
          acqCands: [{ r: 3, rateCol: 3, ts: 1000 }, { r: 4, rateCol: 3, ts: 2000 }] },
      ],
      // The emitter records only genuine triples - note r5 (contra) and r8 (NIL) are ABSENT.
      rateCells: [
        { r: 3, qtyCol: 2, rateCol: 3, amtCol: 4 },
        { r: 4, qtyCol: 2, rateCol: 3, amtCol: 4 },
        { r: 6, qtyCol: 6, rateCol: 7, amtCol: 8 },
        { r: 7, qtyCol: 6, rateCol: 7, amtCol: 8 },
      ],
      grandTotalRow: 9,
      plColsUsed: [9, 10],
      chargeColsUsed: [11, 12],
      // No purchase rows in this block — the position is carried in, so every acquisition is an
      // opening date-line. `srcCharged()` below is the one that exercises them.
      purchaseRows: [],
      chargeCols: { brok: 11, stt: 12, gst: -1, et: -1, stamp: -1, sebi: -1, ipf: -1, dmat: -1 },
      expenseRows: { breakdown: 10, total: 11, totalCol: 11 },
      isIntraday: false,
      firstDataRow: 3,
      paint: {
        sno: 0, name: 0, oDate: 1, pDate: 5, sDate: 5,
        oQty: 2, oRate: 3, oAmt: 4,
        pQty: 2, pRate: 3, pAmt: 4,
        sQty: 6, sRate: 7, sAmt: 8,
        brok: 11, ipf: 12, firstPl: 9, lastPl: 10, width: 13,
      },
    },
  };
};

/**
 * THE REPORTED BLOCK, to the rupee — Anawil Wire And Engineering Ltd, FY26-27, rows 69-77 of the
 * owner's own twin, where Z75 came back a bare value.
 *
 * Two purchases and no opening stock. The sales before this one eat 36,400 of the first lot's
 * 40,000, so the 8,000 sold on 30-Sep draws 3,600 at 380.578 and 4,400 at 462.345 — a cost of
 * 34,04,398.80 that NEITHER rate can produce on its own (8,000 x 380.578 = 30,44,624 and
 * 8,000 x 462.345 = 36,98,760, both lakhs out). That is the whole case for the sum, and the
 * right and wrong answers here are disjoint by construction.
 */
const srcSpan = () => {
  const v: any[][] = [];
  const t = blank(); t[0] = "Capital Gains for FY26-27"; v.push(t);
  const g = blank(); g[1] = "OPENING STOCK"; g[5] = "SALES"; g[9] = "SHORT TERM"; g[10] = "LONG TERM"; v.push(g);
  v.push(["NAME", "DATE", "QTY", "RATE", "AMOUNT", "DATE", "QTY", "RATE", "AMOUNT", "SHORT", "LONG", "BROK", "STT"]);
  const p1 = blank(); p1[0] = "ANAWIL"; p1[1] = "12.08.2026"; p1[2] = 40000; p1[3] = 380.578; p1[4] = 15223120; v.push(p1);
  const p2 = blank(); p2[1] = "11.09.2026"; p2[2] = 20000; p2[3] = 462.345; p2[4] = 9246900; v.push(p2);
  const s = blank(); s[5] = "30.09.2026"; s[6] = 8000; s[7] = 534; s[8] = 4272000; s[9] = 867601.2; v.push(s);
  const gt = blank(); gt[0] = "GRAND TOTAL"; gt[9] = 867601.2; v.push(gt);
  return {
    tab: "Capital Gains for FY26-27",
    values: v,
    closingRanges: [],
    plBandEnd: 6, expStart: 6, expEnd: 7,
    derive: {
      saleRows: [
        { r: 5, plCol: 9, sAmtCol: 8, sQtyCol: 6, turnover: 4272000, pnl: 867601.2,
          acqCands: [{ r: 3, rateCol: 3, ts: 101 }, { r: 4, rateCol: 3, ts: 102 }],
          matched: [{ qty: 3600, rate: 380.578, buyTs: 101 }, { qty: 4400, rate: 462.345, buyTs: 102 }] },
      ],
      rateCells: [
        { r: 3, qtyCol: 2, rateCol: 3, amtCol: 4 },
        { r: 4, qtyCol: 2, rateCol: 3, amtCol: 4 },
        { r: 5, qtyCol: 6, rateCol: 7, amtCol: 8 },
      ],
      grandTotalRow: 6,
      plColsUsed: [9],
      chargeColsUsed: [],
      firstDataRow: 3,
      paint: {
        sno: 0, name: 0, oDate: 1, pDate: 5, sDate: 5,
        oQty: 2, oRate: 3, oAmt: 4,
        pQty: 2, pRate: 3, pAmt: 4,
        sQty: 6, sRate: 7, sAmt: 8,
        brok: 11, ipf: 12, firstPl: 9, lastPl: 10, width: 13,
      },
    },
  };
};

/**
 * A block carrying a real CHARGE BLOCK — one purchase row and one sale row, each with charges,
 * plus the two-row expense footer.
 *
 * Its charge columns are deliberately NON-CONTIGUOUS (14 and 16, with 15 left empty), because
 * the real layout is: `COL.exchClg` sits between SEBI and IPF and is never written, so a naive
 * `first:last` range would sum a headed column carrying nothing and would quietly widen if the
 * layout ever changed.
 */
const W2 = 17;
const blank2 = () => new Array(W2).fill("");
const srcCharged = () => {
  const v: any[][] = [];
  const t = blank2(); t[0] = "Capital Gains for FY26-27"; v.push(t);
  const g = blank2(); g[1] = "OPENING STOCK"; g[5] = "PURCHASE"; g[9] = "SALES"; g[13] = "SHORT TERM"; v.push(g);
  v.push(["NAME", "DATE", "QTY", "RATE", "AMOUNT", "DATE", "QTY", "RATE", "AMOUNT",
          "DATE", "QTY", "RATE", "AMOUNT", "SHORT", "BROK", "EXCH.CLG", "STT"]);
  const head = blank2(); head[0] = "ACME"; head[1] = "01.04.2026"; head[2] = 1000; head[3] = 50; head[4] = 50000; v.push(head);
  // r4 PURCHASE, with charges. EXCH.CLG (15) stays empty exactly as the real layout leaves it.
  const buy = blank2(); buy[5] = "10.05.2026"; buy[6] = 500; buy[7] = 60; buy[8] = 30000; buy[14] = 100; buy[16] = 25; v.push(buy);
  // r5 SALE, with charges.
  const sell = blank2(); sell[9] = "20.06.2026"; sell[10] = 400; sell[11] = 80; sell[12] = 32000; sell[13] = 12000; sell[14] = 50; sell[16] = 12.5; v.push(sell);
  const gt = blank2(); gt[0] = "GRAND TOTAL"; gt[13] = 12000; gt[14] = 150; gt[16] = 37.5; v.push(gt);
  // r7 expense BREAKDOWN — the engine's own figures. Must stay values.
  const expB = blank2(); expB[13] = "Expenses"; expB[14] = 150; expB[16] = 37.5; v.push(expB);
  // r8 Total.
  const expT = blank2(); expT[13] = "Total"; expT[14] = 187.5; v.push(expT);
  return {
    tab: "Capital Gains for FY26-27",
    values: v,
    closingRanges: [],
    plBandEnd: 6, expStart: 7, expEnd: 9,
    derive: {
      saleRows: [{ r: 5, plCol: 13, sAmtCol: 12, sQtyCol: 10, turnover: 32000, pnl: 12000, acqCands: [] }],
      purchaseRows: [{ r: 4, amtCol: 8 }],
      rateCells: [
        { r: 3, qtyCol: 2, rateCol: 3, amtCol: 4 },
        { r: 4, qtyCol: 6, rateCol: 7, amtCol: 8 },
        { r: 5, qtyCol: 10, rateCol: 11, amtCol: 12 },
      ],
      grandTotalRow: 6,
      plColsUsed: [13],
      chargeColsUsed: [14, 16],
      chargeCols: { brok: 14, stt: 16, gst: -1, et: -1, stamp: -1, sebi: -1, ipf: -1, dmat: -1 },
      expenseRows: { breakdown: 7, total: 8, totalCol: 14 },
      isIntraday: false,
      firstDataRow: 3,
      paint: {
        sno: 0, name: 0, oDate: 1, pDate: 5, sDate: 9,
        oQty: 2, oRate: 3, oAmt: 4,
        pQty: 6, pRate: 7, pAmt: 8,
        sQty: 10, sRate: 11, sAmt: 12,
        brok: 14, ipf: 16, firstPl: 13, lastPl: 13, width: W2,
      },
    },
  };
};

/**
 * A block whose charges really do obey the statutory identities, so the verified-rate path can
 * be driven end to end. Figures chosen so the right and wrong answers are disjoint.
 *
 * Columns: 0 NAME | 1-4 OPENING | 5-8 PURCHASE | 9-12 SALES | 13 PL | 14 BROK | 15 STT |
 *          16 GST | 17 ET | 18 STAMP | 19 SEBI | 20 EXCH.CLG (never written) | 21 IPF
 */
const W3 = 22;
const blank3 = () => new Array(W3).fill("");
const srcRates = () => {
  const v: any[][] = [];
  v.push(blank3()); v.push(blank3());
  v.push(["NAME", "DATE", "QTY", "RATE", "AMOUNT", "DATE", "QTY", "RATE", "AMOUNT",
          "DATE", "QTY", "RATE", "AMOUNT", "SHORT", "BROK", "STT", "GST", "ET", "STAMP", "SEBI", "EXCH.CLG", "IPF"]);
  // r3 PURCHASE — turnover 10,00,000 and every statutory charge exactly on its rate.
  //   STT 0.1% = 1000 · stamp 0.015% = 150 · SEBI Rs10/cr = 1 · NSE ETC Rs307/cr = 30.70
  //   GST 18% x (brok 500 + ETC 30.70 + SEBI 1) = 95.71
  const buy = blank3();
  buy[5] = "10.05.2026"; buy[6] = 1000; buy[7] = 1000; buy[8] = 1000000;
  buy[14] = 500; buy[15] = 1000; buy[16] = 95.71; buy[17] = 30.7; buy[18] = 150; buy[19] = 1; buy[21] = 1;
  v.push(buy);
  // r4 SALE — turnover 20,00,000. ETC here is the BSE A/B rate (Rs375/cr = 75), NOT the NSE one
  //   (which would give 61.40), so a LATER candidate has to be reached — the first is never
  //   taken on faith. STAMP is left BLANK: there is no sell-side stamp duty on an exchange trade.
  const sell = blank3();
  sell[9] = "20.06.2026"; sell[10] = 1000; sell[11] = 2000; sell[12] = 2000000; sell[13] = 500000;
  sell[14] = 800; sell[15] = 2000; sell[16] = 157.86; sell[17] = 75; sell[19] = 2;
  v.push(sell);
  const gt = blank3(); gt[0] = "GRAND TOTAL"; gt[13] = 500000; v.push(gt);
  const expB = blank3(); expB[13] = "Expenses"; v.push(expB);
  const expT = blank3(); expT[13] = "Total"; v.push(expT);
  return {
    tab: "Capital Gains for FY26-27",
    values: v, closingRanges: [], plBandEnd: 5, expStart: 6, expEnd: 8,
    derive: {
      saleRows: [{ r: 4, plCol: 13, sAmtCol: 12, sQtyCol: 10, turnover: 2000000, pnl: 500000, acqCands: [] }],
      purchaseRows: [{ r: 3, amtCol: 8 }],
      rateCells: [],
      grandTotalRow: 5,
      plColsUsed: [13],
      chargeColsUsed: [14, 15, 16, 17, 18, 19, 21],
      chargeCols: { brok: 14, stt: 15, gst: 16, et: 17, stamp: 18, sebi: 19, ipf: 21, dmat: -1 },
      expenseRows: { breakdown: 6, total: 7, totalCol: 14 },
      isIntraday: false,
      firstDataRow: 3,
      paint: {
        sno: 0, name: 0, oDate: 1, pDate: 5, sDate: 9,
        oQty: 2, oRate: 3, oAmt: 4, pQty: 6, pRate: 7, pAmt: 8,
        sQty: 10, sRate: 11, sAmt: 12,
        brok: 14, ipf: 21, firstPl: 13, lastPl: 13, width: W3,
      },
    },
  };
};

console.log("\n── A1 helper ────────────────────────────────────────────────");
eq("A1: column 0 is A", colA1(0), "A");
eq("A1: column 8 is I", colA1(8), "I");
// The tabs are 24-25 columns wide and the added column lands past Z, so this is not academic:
// a helper that wrapped to "AA" one short would point every gain formula at the wrong column.
eq("A1: column 25 is Z", colA1(25), "Z");
eq("A1: column 26 is AA", colA1(26), "AA");
eq("A1: column 27 is AB", colA1(27), "AB");
eq("A1: column 51 is AZ", colA1(51), "AZ");

console.log("\n-- the added column -----------------------------------------");
{
  const { rows } = buildFormulaGrid(src() as any);
  // APPENDED, never inserted. Every index in `derive` was recorded against the FILED layout, so
  // inserting mid-grid would shift them all and re-point every formula one column over - a grid
  // that still looks right and reads the wrong cell.
  eq("ACQUISITION COST is appended at the original width", rows[2 + 3][WIDTH], "ACQUISITION COST");
  eq("...so the P/L column is untouched in the header", rows[2 + 3][9], "SHORT");
  eq("...and so is the charge header", rows[2 + 3][11], "BROK");
}

console.log("\n-- the per-sale gain ----------------------------------------");
{
  const { rows, formulaCells } = buildFormulaGrid(src() as any);
  const B = 3;
  // ACQUISITION COST = sale qty x the rate it was acquired at, both of them cells on this tab.
  // G10 is the ST sale's own quantity; D7 is the FIRST opening line's rate.
  eq("acquisition cost is qty x the acquisition rate (ST)", rows[6 + B][WIDTH], "=ROUND(G10*D7,2)");
  // THE ONE THAT MATTERS: this sale's cost comes from the SECOND opening line, so the builder
  // must have tried the first, found it did not reproduce the engine, and moved on.
  eq("...and the SECOND candidate is reached when the first does not fit (LT)",
     rows[7 + B][WIDTH], "=ROUND(G11*D8,2)");
  // THE VERIFIER MUST MULTIPLY BY WHAT THE CELL EVALUATES TO, NOT BY WHAT IT PRINTS. D7 becomes
  // `=F7/D7` further down this same builder, so Sheets multiplies by 250.0000003 — and at 20,000
  // shares that is a PAISE away from the printed 250. These two lines are the fixture proving the
  // distinction is real: the printed rate does NOT reproduce the engine, and the row derived anyway.
  eq("the printed r6 rate would NOT reproduce the engine", Math.round(20000 * 250 * 100) / 100, 5000000);
  eq("...but the rate the cell EVALUATES to does",
     Math.round(20000 * (25000000.03 / 100000) * 100) / 100, Math.round((9200000 - 4199999.99) * 100) / 100);
  eq("...and the LT formula ties too",
     Math.round(50 * (5979120.01 / 93000) * 100) / 100, Math.round((15000 - 11785.42) * 100) / 100);
  // Both inputs on the SAME row. The filed layout cannot express this: FIFO matches a sale
  // against lots spread over the purchase rows above, so the purchase row BESIDE a sale is not
  // the lot it consumed and `=saleAmt - purchaseAmt` across adjacent rows would be wrong.
  eq("the ST gain is a formula over its own row", rows[6 + B][9], "=I10-N10");
  eq("the LT gain is a formula over its own row", rows[7 + B][10], "=I11-N11");
  ok("the row refs account for the banner", /10$/.test(rows[6 + B][9]) && /11$/.test(rows[7 + B][10]));
  // 4 rates + 2 gains + 2 acquisition costs + 2 P/L totals + 2 charge totals + the acquisition
  // column total + 2 expense column totals + 2 rows x (EXPENSES, EX-STT) + the footer Total,
  // its ex-STT companion and the cross-foot
  eq("every derived cell is counted", formulaCells, 22);
}

console.log("\n-- ACQUISITION COST is VERIFIED before it is offered --------");
{
  // Driven directly. `qty x rate` is only the acquisition cost where the WHOLE sale came from
  // ONE acquisition line, and which line that is cannot be known by position — so every
  // candidate is tried and only one that reproduces the engine may be written. P/L reads
  // `=SALE AMT - ACQUISITION COST`, so a formula that is a paise out moves a tax figure.
  const rates = (m: Record<string, any>) => (r: number, c: number) => m[`${r},${c}`];
  const ref = (r: number, c: number) => `${colA1(c)}${r + 4}`;
  const G = { "3,3": 250, "4,3": 64.291613 };

  eq("the first candidate wins when it reproduces the engine",
     acquisitionCostFormula(100, [{ r: 3, rateCol: 3 }, { r: 4, rateCol: 3 }], rates(G), "G10", ref, 25000),
     "=ROUND(G10*D7,2)");
  // THE ONE THAT MATTERS: the first candidate must not be taken on faith.
  eq("a later candidate is reached when the first does not fit",
     acquisitionCostFormula(50, [{ r: 3, rateCol: 3 }, { r: 4, rateCol: 3 }], rates(G), "G11", ref, 3214.58),
     "=ROUND(G11*D8,2)");
  // THE CENTRAL GUARD. A sale spanning two opening dates, or reaching past the opening into an
  // in-year purchase, has NO single rate to point at — and the engine's figure says so.
  eq("a sale no single rate explains is REFUSED",
     acquisitionCostFormula(100, [{ r: 3, rateCol: 3 }, { r: 4, rateCol: 3 }], rates(G), "G10", ref, 18000), null);
  eq("...even by a single paise",
     acquisitionCostFormula(100, [{ r: 3, rateCol: 3 }], rates(G), "G10", ref, 25000.01), null);
  eq("no candidate at all is refused", acquisitionCostFormula(100, [], rates(G), "G10", ref, 25000), null);
  eq("...and a missing list is refused too",
     acquisitionCostFormula(100, undefined as any, rates(G), "G10", ref, 25000), null);
  // A blank or textual rate cell multiplies to 0 in Sheets, which would state a NIL cost and
  // book the whole proceeds as gain. It must never be pointed at.
  eq("a BLANK rate cell is never pointed at",
     acquisitionCostFormula(100, [{ r: 9, rateCol: 3 }], rates(G), "G10", ref, 0), null);
  eq("a TEXTUAL rate cell is never pointed at",
     acquisitionCostFormula(100, [{ r: 8, rateCol: 3 }], rates({ "8,3": "NIL" }), "G10", ref, 0), null);
  // ...but a rate of exactly ZERO is a real fact, not an empty cell: a gift, a transmission, a
  // written-off holding, an allotment against an earlier advance. A zero price is saveable by
  // owner directive, so refusing it would keep those sales from ever deriving — and the blank is
  // already caught by the TYPE check above, which is what actually protects that case.
  eq("a genuine ZERO-cost acquisition line still derives",
     acquisitionCostFormula(100, [{ r: 3, rateCol: 3 }], rates({ "3,3": 0 }), "G10", ref, 0),
     "=ROUND(G10*D7,2)");
  eq("a NEGATIVE rate is still refused",
     acquisitionCostFormula(100, [{ r: 3, rateCol: 3 }], rates({ "3,3": -5 }), "G10", ref, -500), null);
  // A sale row with no quantity has nothing to multiply; the engine's value is the only answer.
  eq("a non-positive sale quantity is refused",
     acquisitionCostFormula(0, [{ r: 3, rateCol: 3 }], rates(G), "G10", ref, 0), null);
  eq("a non-numeric sale quantity is refused",
     acquisitionCostFormula("100" as any, [{ r: 3, rateCol: 3 }], rates(G), "G10", ref, 25000), null);
}

console.log("\n-- a refused derivation keeps the VALUE, and is COUNTED ------");
{
  const S = src() as any;
  // What a sale spanning two acquisition lines looks like: no single rate reproduces it.
  S.derive.saleRows[0].pnl = 18000;        // engine cost 28,000 — neither 250 nor 64.291613 x 100
  S.derive.saleRows[1].acqCands = [];      // and one with nothing to point at
  const { rows, acqDerived, acqAsValue } = buildFormulaGrid(S);
  const B = 3;
  eq("a refused row keeps the engine's exact value (ST)", rows[6 + B][WIDTH], 9182000);
  eq("a row with no candidates keeps it too (LT)", rows[7 + B][WIDTH], 3214.58);
  eq("nothing was derived", acqDerived, 0);
  // Reported, never inferred from a difference: a partly-derived worksheet that looks fully
  // derived is the failure this count exists to prevent.
  eq("...and both fallbacks are counted", acqAsValue, 2);
  // The P/L formula is written either way — it reads the ACQUISITION COST cell, whatever is in it.
  eq("the gain still reads its own row", rows[6 + B][9], "=I10-N10");
}

console.log("\n-- a fallback SAYS WHICH KIND of fallback it is -------------");
{
  // "N kept the value" is an undifferentiated number, and the three reasons behind it have
  // completely different answers: a multi-lot sale can NEVER take a formula and nothing is wrong
  // with it; a paise of rounding is arithmetic; no rate at all is a block with nothing to point
  // at. Reporting only the total is what turned this into two rounds of guessing.
  const G = { "3,3": 250, "4,3": 64.291613 };
  const rates = (m: Record<string, any>) => (r: number, c: number) => m[`${r},${c}`];
  const cands = [{ r: 3, rateCol: 3 }, { r: 4, rateCol: 3 }];

  // A sale of 20,000 whose true cost is 28,00,000 — neither 250 nor 64.29 x 20,000 comes close.
  const far = acquisitionMiss(20000, cands, rates(G), 2800000);
  ok("a multi-lot sale reports a LARGE miss", far !== null && far > 1);
  // Within a paise: arithmetic, not structure.
  const near = acquisitionMiss(20000, cands, rates(G), 5000000.01);
  ok("a rounding fallback reports a miss inside a paise", near !== null && near <= 0.01);
  eq("no candidate at all reports null", acquisitionMiss(20000, [], rates(G), 100), null);
  eq("...and so does a block whose only rate cell is blank",
     acquisitionMiss(20000, [{ r: 9, rateCol: 3 }], rates(G), 100), null);
  // The CLOSEST candidate decides, not the first — otherwise a block whose first line happens to
  // be far off would report "multi-lot" for a sale that is really a paise of rounding.
  const closest = acquisitionMiss(50, cands, rates(G), 3214.58);
  ok("the CLOSEST candidate decides the miss", closest !== null && closest <= 0.01);

  // And the counts come out of a real build, bucketed.
  const S = src() as any;
  S.derive.saleRows[0].pnl = 18000;      // no rate explains it -> multi-lot
  S.derive.saleRows[1].acqCands = [];    // nothing to point at  -> no rate
  const b = buildFormulaGrid(S);
  eq("the build buckets a multi-lot fallback", b.acqSpanned, 1);
  eq("...and a no-rate one", b.acqNoRate, 1);
  eq("...and they sum to the headline count", b.acqSpanned + b.acqRounding + b.acqNoRate, b.acqAsValue);
}

console.log("\n-- the candidates are SCOPED TO THE BLOCK -------------------");
{
  // A rate borrowed from the scrip above multiplies out to an entirely plausible figure that
  // belongs to a different company. The emitter resets its candidate list per block.
  const REG = strip("src/lib/trxRegister.ts");
  ok("the candidate list is reset for each block", /sno\+\+;\s*blockAcq = \[\];/.test(REG));
  // ...and SNAPSHOT, never the live array, or every sale on the tab ends up holding the LAST
  // block's rates once the loop has run to the end.
  ok("each sale takes a COPY of the list", /acqCands: \[\.\.\.blockAcq\]/.test(REG));
  ok("an opening date-line is a candidate", /noteAcq\(out\.length - 1, COL\.oRate, /.test(REG));
  ok("an in-year purchase is one too", /noteAcq\(out\.length - 1, COL\.pRate, /.test(REG));
  // EVERY candidate carries the DATE its row states, and that is what ties a consumed lot back
  // to the row that supplied it. Rate alone multiplies out identically from any row sharing it,
  // so a sum could foot perfectly while naming the wrong date line.
  ok("a candidate records the date its row states",
     /const noteAcq = \(r: number, rateCol: number, ts\?: number\) =>/.test(REG));
  ok("the opening head row passes its own date", /noteAcq\(out\.length - 1, COL\.oRate, openAgg\[0\]\.ts\)/.test(REG));
  ok("a further opening line passes its own", /noteAcq\(out\.length - 1, COL\.oRate, a\.ts\)/.test(REG));
  ok("a purchase passes its own", /noteAcq\(out\.length - 1, COL\.pRate, p\.ts\)/.test(REG));
  // A RESTATEMENT is an acquisition rate. After a split the lots carry the rescaled `purPrice`,
  // so a later sale costs qty x the RESTATED rate and NO original opening rate can reproduce it —
  // leave these out and every post-split sale falls back to a value for no good reason.
  const splitPush = REG.slice(REG.indexOf('row[COL.name] = "SPLIT"'));
  ok("a SPLIT restatement is a candidate",
     /if \(sp\.qty > 0\) \{ noteRate\([^)]*\); noteAcq\(out\.length - 1, rc\.r, sp\.ts\); \}/.test(splitPush.slice(0, 600)));
  // Both corp-action kinds qualify: a "purchase" line IS the acquisition (shares received in a
  // merger/demerger), a "holding" line restates the surviving position's cost.
  const cnPush = REG.slice(REG.indexOf("if (cn.qty !== undefined && cn.rate !== undefined && cn.qty > 0) {"));
  ok("a corporate-action restatement is a candidate",
     /noteAcq\(out\.length - 1, rc\.r, cn\.ts\);/.test(cnPush.slice(0, 400)));
  // ...and the CONTRA line is kept out by that same guard, because it has no rate to point at.
  ok("the CONTRA line is still excluded",
     /cn\.rate !== undefined && cn\.qty > 0/.test(cnPush.slice(0, 120)));
  // ONE definition of what a rate cell will EVALUATE to, consulted by the verifier AND by the
  // loop that writes those formulas. Two copies may drift, and this exact drift is what made the
  // verifier check the printed r6 rate while the sheet multiplied by the full-precision quotient.
  const GRID = strip("src/lib/trxFormulaGrid.ts");
  ok("the live rate is computed once, from AMOUNT / QTY",
     /liveRate\.set\(`\$\{rc\.r\}:\$\{rc\.rateCol\}`, a \/ q\)/.test(GRID));
  ok("the verifier multiplies by that, not by the printed cell",
     /acquisitionCostFormula\(\s*saleQty, s\.acqCands, effectiveRate,/.test(GRID));
  ok("...and the diagnostic miss is measured against the same rate",
     /acquisitionMiss\(saleQty, s\.acqCands, effectiveRate, engineCost\)/.test(GRID));
  // The rate loop must GATE on the same map rather than re-testing the cells, or the set of
  // cells that get a formula can drift from the set the verifier assumed had one.
  ok("the rate loop gates on the same map",
     /if \(!liveRate\.has\(`\$\{rc\.r\}:\$\{rc\.rateCol\}`\)\) continue;/.test(GRID));
}

console.log("\n-- a derived run reports itself ------------------------------");
{
  const { acqDerived, acqSummed, acqAsValue } = buildFormulaGrid(src() as any);
  eq("both sales derived", acqDerived, 2);
  eq("nothing fell back", acqAsValue, 0);
  // saleRows[0] CARRIES a match that would also foot. The single-rate form wins because it is
  // tried first, which is the whole reason the counters are separate.
  eq("neither needed the sum", acqSummed, 0);
}

console.log("\n-- A SALE SPANNING LOTS IS A SUM, NOT A FALLBACK -------------");
{
  const { rows, acqDerived, acqSummed, acqAsValue, acqSpanned } = buildFormulaGrid(srcSpan() as any);
  const B = 3;
  // One term per lot. The QUANTITIES are literals because 3,600 and 4,400 are stated on no row —
  // the sale row says 8,000 and the purchase rows say 40,000 and 20,000 — while every RATE is a
  // cell, so it is referenced. D7 is the 12-Aug line, D8 the 11-Sep one.
  eq("a two-lot sale reads as the sum it is", rows[5 + B][WIDTH], "=ROUND(3600*D7+4400*D8,2)");
  eq("...and it is counted as a sum, not a derivation", acqSummed, 1);
  eq("...so no single rate was credited", acqDerived, 0);
  eq("...and nothing fell back", acqAsValue, 0);
  eq("...so the multi-lot bucket is empty", acqSpanned, 0);
  // The P/L still reads its own row, whatever shape the cost cell took.
  eq("the gain reads the summed cost", rows[5 + B][9], "=I9-N9");

  // THE SUM MUST MULTIPLY BY WHAT THE RATE CELL EVALUATES TO, not by what it prints. Every rate
  // cell on the twin becomes `=AMOUNT/QTY`, so Sheets uses the full-precision quotient — the
  // exact fault that cost a round on the single-rate form, and it reaches this path too. Here
  // 15223120.1 / 40000 is 380.5780025 against a printed 380.578, and over 3,600 shares the two
  // answers are a paise apart.
  const live = srcSpan() as any;
  live.values[3][4] = 15223120.1;
  live.derive.saleRows[0].pnl = 867601.19;
  live.derive.saleRows[0].matched[0].rate = 380.5780025;
  const b3 = buildFormulaGrid(live);
  eq("the sum multiplies by the LIVE rate, not the printed one", b3.rows[5 + B][WIDTH], "=ROUND(3600*D7+4400*D8,2)");
  eq("...and really did derive at the paise the engine reported", b3.acqSummed, 1);

  // WITHOUT the match the very same block has to fall back — which is what proves the sum is
  // doing the work and not some single rate that happened to fit.
  const noMatch = srcSpan() as any;
  delete noMatch.derive.saleRows[0].matched;
  const b2 = buildFormulaGrid(noMatch);
  eq("with no match recorded it keeps the engine's value", b2.rows[5 + B][WIDTH], 3404398.8);
  eq("...counted as a fallback", b2.acqAsValue, 1);
  eq("...bucketed as drawing on lots this page cannot name", b2.acqSpanned, 1);
  eq("...and not as a sum", b2.acqSummed, 0);
}

console.log("\n-- the sum is VERIFIED, and refuses rather than guesses ------");
{
  // Driving the pure function directly: each case isolates one guard, and the grid-level test
  // above cannot reach most of them without a fixture per guard.
  const rate = (m: Record<string, any>) => (r: number, c: number) => m[`${r},${c}`];
  const ref = (r: number, c: number) => `${colA1(c)}${r + 1}`;
  const G = { "3,3": 380.578, "4,3": 462.345 };
  const cands = [{ r: 3, rateCol: 3, ts: 101 }, { r: 4, rateCol: 3, ts: 102 }];
  const M = [{ qty: 3600, rate: 380.578, buyTs: 101 }, { qty: 4400, rate: 462.345, buyTs: 102 }];
  const COST = 3404398.8;

  eq("the happy path", acquisitionSumFormula(8000, M, cands, rate(G), ref, COST), "=ROUND(3600*D4+4400*D5,2)");

  // THE QUANTITIES MUST ADD BACK UP TO THE SALE. A partial match would otherwise write a
  // formula that silently understates the cost — and P/L subtracts this cell.
  eq("a match short of the sale quantity is refused",
     acquisitionSumFormula(9000, M, cands, rate(G), ref, COST), null);
  // ...which is exactly the uncovered-quantity row (sold more than held): an EMPTY match.
  eq("an uncovered sale has no match and no formula",
     acquisitionSumFormula(8000, [], cands, rate(G), ref, COST), null);
  eq("...and an absent one is the intra-day case",
     acquisitionSumFormula(8000, undefined, cands, rate(G), ref, COST), null);

  // THE TOTAL IS CHECKED AGAINST THE ENGINE, to the paise. Everything else is a mapping heuristic
  // and this is what makes a wrong mapping harmless.
  eq("a sum that does not reproduce the engine is refused",
     acquisitionSumFormula(8000, M, cands, rate(G), ref, COST + 0.01), null);

  // A lot whose rate is on NO cell of this page — a post-split lot carrying a rescaled
  // `purPrice`, or an opening line averaging two same-day fills at different prices.
  const rescaled = [{ qty: 3600, rate: 190.289, buyTs: 101 }, { qty: 4400, rate: 462.345, buyTs: 102 }];
  eq("a lot whose rate is on no cell is refused",
     acquisitionSumFormula(8000, rescaled, cands, rate(G), ref, 1719303.4), null);
  // AND THE TOLERANCE IS THE ONLY GUARD LEFT WHEN THE ARITHMETIC AGREES BY COINCIDENCE. Two
  // lots at 100 and 300 against one 200 cell foot to exactly the same total, so the engine
  // check passes — and the cell would then state that 2,000 shares were acquired at 200, which
  // never happened. Without this case the tolerance tests green while doing nothing: a probe
  // that removed it came back SILENT, because every other fixture is caught by the total.
  const avg = { "3,3": 200 };
  const twoSided = [{ qty: 1000, rate: 100, buyTs: 1 }, { qty: 1000, rate: 300, buyTs: 1 }];
  eq("a rate that is not the lot's own is refused even when the total agrees",
     acquisitionSumFormula(2000, twoSided, [{ r: 3, rateCol: 3, ts: 1 }], rate(avg), ref, 400000), null);

  // THE LOT'S OWN DATE DECIDES, not merely a rate that matches. Two rows carrying the same rate
  // multiply out identically, so the arithmetic cannot tell them apart — only the date can, and
  // a formula naming the wrong line teaches the reader something untrue.
  const twin = { "3,3": 380.578, "4,3": 462.345, "5,3": 380.578 };
  const tCands = [{ r: 3, rateCol: 3, ts: 101 }, { r: 4, rateCol: 3, ts: 102 }, { r: 5, rateCol: 3, ts: 103 }];
  eq("a lot takes the row carrying ITS date, not the first with its rate",
     acquisitionSumFormula(8000, [{ qty: 3600, rate: 380.578, buyTs: 103 }, M[1]], tCands, rate(twin), ref, COST),
     "=ROUND(3600*D6+4400*D5,2)");

  // CONSECUTIVE lots off one line are ONE term. Several same-day fills consolidate to a single
  // printed row, so without this a sale reads `=ROUND(100*D4+250*D4+40*D4,2)`.
  const split3 = [{ qty: 1600, rate: 380.578, buyTs: 101 }, { qty: 2000, rate: 380.578, buyTs: 101 }, M[1]];
  eq("lots off the same line merge into one term",
     acquisitionSumFormula(8000, split3, cands, rate(G), ref, COST), "=ROUND(3600*D4+4400*D5,2)");

  // THE ENGINE ROUNDS PER LOT (`r2(m * purPrice)` inside the gain) while reporting a bucket total
  // rounded once, so the two shapes do not always agree. Both are tried; neither is assumed.
  const B = { "3,3": 100.004, "4,3": 200.004 };
  const bc = [{ r: 3, rateCol: 3, ts: 1 }, { r: 4, rateCol: 3, ts: 2 }];
  const bm = [{ qty: 1, rate: 100.004, buyTs: 1 }, { qty: 1, rate: 200.004, buyTs: 2 }];
  // 100.004 + 200.004 = 300.008 -> 300.01 in one go, but 100.00 + 200.00 = 300.00 per lot.
  eq("the one-ROUND shape when that is what the engine produced",
     acquisitionSumFormula(2, bm, bc, rate(B), ref, 300.01), "=ROUND(1*D4+1*D5,2)");
  eq("the per-lot shape when THAT is what it produced",
     acquisitionSumFormula(2, bm, bc, rate(B), ref, 300), "=ROUND(ROUND(1*D4,2)+ROUND(1*D5,2),2)");

  // A blank rate cell multiplies to 0 in Sheets, stating a NIL cost. `usableCands` is the one
  // definition of that guard and the sum goes through it too.
  eq("a block whose only rate cell is blank gives no sum",
     acquisitionSumFormula(8000, M, [{ r: 9, rateCol: 3, ts: 101 }], rate(G), ref, COST), null);
  // A fractional share count (a mutual-fund unit, a 1:2 bonus on an odd holding) still prints.
  const frac = { "3,3": 10 };
  eq("a fractional quantity is written as a decimal, not rounded away",
     acquisitionSumFormula(289.5, [{ qty: 289.5, rate: 10, buyTs: 1 }], [{ r: 3, rateCol: 3, ts: 1 }], rate(frac), ref, 2895),
     "=ROUND(289.5*D4,2)");
  // The quantities are verified AS TYPED. Merging two same-line fills of 0.1 and 0.2 gives
  // 0.30000000000000004 in binary floating point — which is neither the sale quantity nor
  // something that belongs in a filed worksheet.
  eq("float noise from merging is normalised away",
     acquisitionSumFormula(0.3, [{ qty: 0.1, rate: 10, buyTs: 1 }, { qty: 0.2, rate: 10, buyTs: 1 }],
                           [{ r: 3, rateCol: 3, ts: 1 }], rate(frac), ref, 3),
     "=ROUND(0.3*D4,2)");
}

console.log("\n-- THE EXPENSE SIDE SHOWS ITS OWN WORKING --------------------");
{
  const { rows } = buildFormulaGrid(srcCharged() as any);
  const B = 3;
  const EXP = W2 + 1, DED = W2 + 2;   // appended AFTER acquisition cost, never between
  eq("EXPENSES is appended past ACQUISITION COST", rows[2 + B][EXP], "EXPENSES");
  eq("...and the ex-STT companion past that", rows[2 + B][DED], "EXPENSES EX-STT");
  eq("...so ACQUISITION COST keeps its own column", rows[2 + B][W2], "ACQUISITION COST");

  // NON-CONTIGUOUS. The real layout leaves `COL.exchClg` unwritten between SEBI and IPF, so a
  // `first:last` range would total a headed column carrying nothing.
  eq("a PURCHASE row totals its charge cells", rows[4 + B][EXP], "=SUM(O8,Q8)");
  eq("a SALE row totals its charge cells too", rows[5 + B][EXP], "=SUM(O9,Q9)");
  // Subtracted from the cell beside it, so the two can differ by EXACTLY the STT cell and by
  // nothing else. Re-summing seven columns here invites a second definition that could drift.
  eq("ex-STT is the total MINUS the STT cell", rows[5 + B][DED], "=S9-Q9");
  eq("...on the purchase row as well", rows[4 + B][DED], "=S8-Q8");
  // A row with no charge block is left alone — `=SUM()` over blanks prints a confident 0.00
  // under a heading, which reads as "this row cost nothing" rather than "this row has no charges".
  ok("an opening date-line gets no expense total", typeof rows[3 + B][EXP] !== "string");

  // The footer `Total` is today a bare number with no stated relationship to the figures above.
  eq("the footer Total sums the breakdown", rows[8 + B][14], "=SUM(O11,Q11)");
  eq("...and its ex-STT companion", rows[8 + B][DED], "=O12-Q11");

  // THE BREAKDOWN ROW MUST STAY VALUES. This is the whole reason the cross-foot means anything:
  // point it at the GRAND TOTAL row and both sides reduce to one set of cells, so the check
  // would read "ties" forever — a decorative assertion, which this repo has shipped twice.
  eq("the breakdown row keeps the engine's own brokerage", rows[7 + B][14], 150);
  eq("...and its own STT", rows[7 + B][16], 37.5);

  // The cross-foot, stated ON the sheet, naming the difference rather than just failing.
  eq("the cross-foot compares the two routes to one total", rows[8 + B][EXP],
     '=IF(ROUND(O12-S10,2)=0,"ties to the rows above","DIFFERS by "&TEXT(ROUND(O12-S10,2),"0.00"))');

  // Both halves must reach the GRAND TOTAL row or the cross-foot has nothing to read.
  eq("the EXPENSES column is totalled", rows[6 + B][EXP], "=SUM(S7:S9)");
  eq("...and the ex-STT column", rows[6 + B][DED], "=SUM(T7:T9)");

  // NOTHING NETS EXPENSES AGAINST A GAIN. s.48, and gains here are charge-free turnover. The
  // columns sit beside a P/L column, which already invites the misreading; a reference would
  // make it an assertion.
  const expRef = new RegExp(`\\b[${String.fromCharCode(83)}${String.fromCharCode(84)}]\\d+\\b`);
  const plCells = rows.map(r => r && r[13]).filter(c => typeof c === "string" && c.startsWith("="));
  ok("no P/L cell references an EXPENSES column", !plCells.some(c => expRef.test(c)));
  const { expenseRowsTotalled } = buildFormulaGrid(srcCharged() as any);
  eq("both charge-bearing rows are counted", expenseRowsTotalled, 2);
}

console.log("\n-- the expense pass is DRIVEN DIRECTLY -----------------------");
{
  // Pure, so the writes can be asserted as a list rather than fished out of a finished grid.
  const S = srcCharged() as any;
  const ref = (r: number, c: number) => `${colA1(c)}${r + 4}`;
  const { writes, rowsTotalled } = expenseFormulas(S, 18, 19, ref);
  eq("it counts the rows it totalled", rowsTotalled, 2);
  // THE BREAKDOWN ROW IS NEVER WRITTEN. Asserted over the write LIST, because a future tidy-up
  // pointing it at the GRAND TOTAL row would still leave a green suite everywhere else while
  // silently turning the cross-foot into a tautology.
  ok("no write targets the expense breakdown row", !writes.some(w => w.r === 7));
  ok("...and none targets the GRAND TOTAL row either", !writes.some(w => w.r === 6));

  // A tab with no charge columns is not a failure — it writes nothing rather than `=SUM()` of
  // an empty list, which Sheets reads as an error.
  const bare = srcCharged() as any;
  bare.derive.chargeColsUsed = [];
  eq("a tab with no charge columns writes nothing", expenseFormulas(bare, 18, 19, ref).writes.length, 0);

  // No expense footer recorded (an older emitter, or a tab shaped differently) must not throw
  // and must not guess at which row the Total is.
  const noFooter = srcCharged() as any;
  noFooter.derive.expenseRows = { breakdown: 99, total: 99, totalCol: 14 };
  const nf = expenseFormulas(noFooter, 18, 19, ref);
  ok("a footer row that is not on the grid is skipped", !nf.writes.some(w => w.r === 99));
  ok("...while the per-row totals still land", nf.rowsTotalled === 2);

  // THE STT COLUMN COMES FROM THE NAMED MAP, NOT FROM A POSITION. `chargeColsUsed` is a set to
  // be summed and its order means nothing; in production STT happens to sit at index 1, so a
  // positional read would test green in every fixture AND in the real register while being one
  // reorder away from making EX-STT subtract BROKERAGE. This drives a reordered list, where the
  // right and wrong answers are disjoint.
  const reordered = srcCharged() as any;
  reordered.derive.chargeColsUsed = [16, 14];
  const dedWrite = expenseFormulas(reordered, 18, 19, ref).writes.find(w => w.r === 5 && w.c === 19);
  eq("ex-STT follows the NAMED stt column, not list order", dedWrite && dedWrite.f, "=S9-Q9");
}

console.log("\n-- A STATUTORY RATE IS A CANDIDATE, NEVER AN ASSERTION -------");
{
  const { rows, chargeDerived, chargeDerivedBy } = buildFormulaGrid(srcRates() as any);
  const B = 3;
  // Purchase row r3 -> sheet row 7; its turnover is in column I.
  eq("delivery STT on a BUY is 0.1% of turnover", rows[3 + B][15], "=ROUND(0.001*I7,2)");
  eq("stamp duty on a BUY is 0.015%", rows[3 + B][18], "=ROUND(0.00015*I7,2)");
  eq("the SEBI turnover fee is Rs 10 per crore", rows[3 + B][19], "=ROUND(0.000001*I7,2)");
  eq("the NSE exchange charge is Rs 307 per crore", rows[3 + B][17], "=ROUND(0.0000307*I7,2)");
  // GST is 18% of a CHARGE BASE, never of turnover, and STT and stamp duty sit OUTSIDE it.
  eq("GST is 18% of brokerage + ETC + SEBI", rows[3 + B][16], "=ROUND(0.18*(O7+R7+T7),2)");
  // BROKERAGE has no statutory identity — a plan is whatever it is, and a formula there would be
  // numerology that happened to foot.
  eq("brokerage is never attempted", rows[3 + B][14], 500);

  // Sale row r4 -> sheet row 8, turnover in column M.
  eq("delivery STT on a SELL is 0.1% too", rows[4 + B][15], "=ROUND(0.001*M8,2)");
  // THE FIRST CANDIDATE IS NEVER TAKEN ON FAITH. NSE's Rs 307/crore gives 61.40 here; the figure
  // is the BSE A/B rate, so a later candidate has to be reached — and the row does not record
  // which exchange it traded on, which is exactly why every rate is offered and verified.
  eq("a LATER exchange-charge candidate is reached", rows[4 + B][17], "=ROUND(0.0000375*M8,2)");
  // There is no sell-side stamp duty on an exchange trade (collected from the buyer, s.9A(1)(a)),
  // and the cell is BLANK — turning it into 0.00 would assert a levy that does not exist.
  ok("a blank charge cell is never written", !String(rows[4 + B][18]).startsWith("="));
  eq("...and no sell-side stamp duty is invented", rows[4 + B][18], "");

  // 6 on the purchase (STT, stamp, SEBI, ETC, IPF, GST) + 4 on the sale (stamp and IPF are
  // blank there, so they are not attempted at all).
  eq("every derivation is counted", chargeDerived, 10);
  eq("...and attributed to its charge", chargeDerivedBy.stt, 2);
  eq("...including GST", chargeDerivedBy.gst, 2);

  // STT IS ROUNDED TO THE NEAREST RUPEE BY LAW (Rule 4, STT Rules 2004) — this repo has already
  // met it from the other side as the Share India 20-paise residual: the note's STT statement
  // computes 0.80 and the Obligation Details table settles 1. A paise-rounded formula can never
  // reproduce the settled figure, so both are offered.
  const rupee = srcRates() as any;
  rupee.values[4][12] = 804;          // turnover 804 -> 0.1% = 0.804
  rupee.values[4][15] = 1;            // ...settled to the rupee
  rupee.derive.saleRows[0].turnover = 804;
  eq("a rupee-settled STT derives with ROUND(...,0)", buildFormulaGrid(rupee).rows[4 + B][15], "=ROUND(0.001*M8,0)");

  // AND A CHARGE NO RATE REPRODUCES KEEPS ITS VALUE. On a scrip with several fills in one day the
  // per-trade STT is an ALLOCATION off a rounded day-aggregate (which is why `allocateStt` exists),
  // so it cannot foot to a per-row rate — and that is correct, not a failure.
  const odd = srcRates() as any;
  odd.values[4][15] = 1999;
  const ob = buildFormulaGrid(odd);
  eq("an unreproducible charge keeps the parsed value", ob.rows[4 + B][15], 1999);
  eq("...and is not counted as derived", ob.chargeDerived, 9);
}

console.log("\n-- the rate table is DATA, and it is tried in order ----------");
{
  // Driven directly, so the table can be asserted as a table rather than inferred from a grid.
  const ref = (r: number, c: number) => `${colA1(c)}${r + 4}`;
  const { writes, attempted } = chargeIdentityFormulas(srcRates() as any, ref);
  eq("every attempt is counted", attempted, 10);
  eq("...and on this fixture every one derived", writes.length, 10);
  ok("no write lands on a column with no rate table", !writes.some(w => w.c === 14));
  // An attempt that derives NOTHING must still be counted, or `chargeDerived` reads as a share
  // of itself and can never say "most of these cannot be expressed" — which is the expected
  // answer for allocated STT.
  const unmatched = srcRates() as any;
  unmatched.values[4][15] = 1999;
  const um = chargeIdentityFormulas(unmatched, ref);
  ok("an attempt that derives nothing is still counted", um.attempted > um.writes.length);

  // Stamp duty is BUY-side only. Marking the tab intraday must move it to the 0.003% rate, not
  // merely re-check the same one — the two are a factor of five apart.
  const intra = srcRates() as any;
  intra.derive.isIntraday = true;
  intra.values[3][18] = 30;            // 0.003% of 10,00,000
  // 0.025% of turnover — the INTRADAY SELL rate, on a BUY row. Intraday STT is sell-side only,
  // so this must NOT derive. Left BLANK it would be skipped before the side test is ever
  // reached, and the guard would test green while doing nothing.
  intra.values[3][15] = 250;
  const iw = chargeIdentityFormulas(intra, ref).writes;
  const stampW = iw.find(w => w.r === 3 && w.c === 18);
  eq("an intraday BUY takes the 0.003% stamp rate", stampW && stampW.f, "=ROUND(0.00003*I7,2)");
  ok("...and an intraday BUY is never given STT", !iw.some(w => w.r === 3 && w.c === 15));

  // A DELIVERY sale whose STT coincidentally equals 0.025% of turnover — the INTRADAY rate. It
  // must NOT derive: writing the intraday identity on a delivery row states a rule that did not
  // apply, and the figure it reproduces is an allocated one that happens to land there.
  const coincide = srcRates() as any;
  coincide.values[4][15] = 500;        // 0.025% of 20,00,000
  const cw = chargeIdentityFormulas(coincide, ref).writes;
  ok("an intraday rate is never used on a delivery row", !cw.some(w => w.r === 4 && w.c === 15));

  // THE GST BASE IS TRIED IN ORDER AND A LATER COMPOSITION MUST BE REACHED. A zero-brokerage or
  // bundled note can charge GST on brokerage ALONE; with only the first base tried, that row
  // keeps its value forever and the gap looks like a GST problem rather than a base problem.
  const gstOnBrok = srcRates() as any;
  gstOnBrok.values[3][16] = 90;        // 18% of brokerage 500, and of nothing else
  const gw = chargeIdentityFormulas(gstOnBrok, ref).writes.find(w => w.r === 3 && w.c === 16);
  eq("a LATER GST base composition is reached", gw && gw.f, "=ROUND(0.18*(O7),2)");

  // A scientific-notation rate would reach Sheets as "1e-9", which it will not read. The Rs
  // 0.01/crore IPFT rate is small enough to trigger it, so the case has to make that rate FIRE.
  const tiny = Object.keys(CHARGE_RATES).flatMap(k => CHARGE_RATES[k]).filter(c => c.rate < 1e-6);
  ok("the table holds at least one sub-microscopic rate", tiny.length > 0);
  const small = srcRates() as any;
  small.values[3][21] = 0;             // Rs 10/crore gives 1.00; only Rs 0.01/crore rounds to 0
  const sw = chargeIdentityFormulas(small, ref).writes.find(w => w.r === 3 && w.c === 21);
  eq("a sub-microscopic rate is written as a plain decimal", sw && sw.f, "=ROUND(0.000000001*I7,2)");
  ok("no formula reaches the sheet in exponent notation",
     !/\de-\d/i.test(chargeIdentityFormulas(small, ref).writes.map(w => w.f).join(" ")));

  // A row with NO turnover must be skipped outright. `rate * ""` is 0 in JavaScript, so without
  // the guard a zero charge beside a missing turnover reproduces itself and a formula is written
  // that multiplies an empty cell — which reads as a derivation and is arithmetic about nothing.
  const noTurnover = srcRates() as any;
  noTurnover.values[4][12] = "";
  noTurnover.values[4][15] = 0;
  ok("a row with no turnover is skipped entirely",
     !chargeIdentityFormulas(noTurnover, ref).writes.some(w => w.r === 4));
}

console.log("\n-- the EMITTER's half of the match ---------------------------");
{
  // The suite HANDS the builder its `matched`, so the code that fills it is reachable only by
  // reading it — the same reason the `rateCells` exclusions are source-asserted.
  const REG = strip("src/lib/trxRegister.ts");
  // Captured PER BUCKET. One sale can split into a short-term row and a long-term row, and each
  // needs the lots that actually paid for it — a shared list would give both all the lots.
  ok("the FIFO match is captured per bucket",
     /const stLots: MatchedLot\[\] = \[\], ltLots: MatchedLot\[\] = \[\];/.test(REG));
  ok("a long-term lot goes to the long-term bucket", /ltQty \+= m; ltGain \+= gain; ltLots\.push\(hit\)/.test(REG));
  ok("...and a short-term one to the short-term bucket", /stQty \+= m; stGain \+= gain; stLots\.push\(hit\)/.test(REG));
  ok("each printed bucket carries its OWN lots",
     /pushSale\("ST", stQty, stGain, stLots\)/.test(REG) && /pushSale\("LT", ltQty, ltGain, ltLots\)/.test(REG));
  // An UNCOVERED quantity (sold more than held) genuinely matched nothing. An empty list is the
  // honest statement, and the sum's quantity check then refuses to claim a cost it never had.
  ok("an uncovered quantity records an EMPTY match", /pushSale\("ST", left, 0, \[\]\)/.test(REG));
  // The lot keeps the TURNOVER basis, not the charge-inclusive one: the figure it has to
  // reproduce is `turnover - pnl`, and gains here are computed charge-free.
  ok("a matched lot carries purPrice, not inclPrice",
     /const hit: MatchedLot = \{ qty: m, rate: l\.purPrice, buyTs: l\.buyTs \};/.test(REG));
  ok("and it rides out to the view", /acqCands: \[\.\.\.blockAcq\], matched: s\.matched/.test(REG));
  // The expense pass's own emitter half. Recorded at the push site, never inferred: `rateCells`
  // cannot tell a purchase from an opening date-line, and the expense footer is two rows whose
  // position is an implementation detail of `emitTab`, not a fact about the grid.
  ok("a purchase row is recorded for its charge block",
     /dPurchaseRows\.push\(\{ r: out\.length - 1, amtCol: COL\.pAmt \}\)/.test(REG));
  ok("the expense footer rows are recorded, not inferred",
     /expenseRows: \{ breakdown: dExpBreakdownRow, total: dExpTotalRow, totalCol: COL\.brok \}/.test(REG));
  ok("the charge columns are handed over BY NAME", /chargeCols: \{\s*brok: COL\.brok, stt: COL\.stt/.test(REG));
  // The builder must try the single rate FIRST — it references the sale-quantity cell, where the
  // sum has to spell the quantity out.
  const GRID = strip("src/lib/trxFormulaGrid.ts");
  ok("the sum is the SECOND attempt", /const sum = f \? null : acquisitionSumFormula\(/.test(GRID));
}

console.log("\n-- RATE = AMOUNT / QTY --------------------------------------");
{
  const { rows } = buildFormulaGrid(src() as any);
  const B = 3;
  // The direction is the codebase's own: AMOUNT is authoritative, RATE derived from it.
  eq("the head row's opening rate", rows[3 + B][3], "=E7/C7");
  eq("a further opening date-line", rows[4 + B][3], "=E8/C8");
  eq("a sale's rate", rows[6 + B][7], "=I10/G10");
  // THE TWO ROWS THAT MUST NOT GET ONE. A corp-action CONTRA line carries a signed amount with
  // no qty and no rate (writing zeros there would read as "0 shares at 0.00"); the CLOSING NIL
  // row carries the TEXT "NIL" in the amount column. By COLUMN these look identical to the rows
  // above - #DIV/0! on the first, #VALUE! on the second.
  eq("a CONTRA line gets no rate formula", rows[5 + B][3], "");
  eq("...and its amount is left alone", rows[5 + B][4], -120000);
  eq("the CLOSING NIL row gets none either", rows[8 + B][3], "");
  eq("...and still says NIL", rows[8 + B][4], "NIL");
}

console.log("\n-- charges stay values --------------------------------------");
{
  const { rows } = buildFormulaGrid(src() as any);
  const B = 3;
  // PARSED from contract notes - there is no arithmetic behind them to reveal, and inventing one
  // would fabricate a derivation.
  eq("a per-row brokerage is untouched", rows[6 + B][11], 9.1);
  eq("a per-row STT is untouched", rows[7 + B][12], 1.75);
  ok("no per-row charge cell became a formula",
    [3, 4, 5, 6, 7, 8].every(r => [11, 12].every(c =>
      typeof rows[r + B][c] !== "string" || !String(rows[r + B][c]).startsWith("="))));
}

console.log("\n-- the grand total ------------------------------------------");
{
  const { rows } = buildFormulaGrid(src() as any);
  const B = 3;
  eq("ST total sums its own column over the data rows", rows[9 + B][9], "=SUM(J7:J12)");
  eq("LT total sums its own column", rows[9 + B][10], "=SUM(K7:K12)");
  eq("brokerage total sums its own column", rows[9 + B][11], "=SUM(L7:L12)");
  eq("STT total sums its own column", rows[9 + B][12], "=SUM(M7:M12)");
  eq("matched cost totals too", rows[9 + B][WIDTH], "=SUM(N7:N12)");
  const all = rows.flat().filter(c => typeof c === "string" && c.startsWith("="));
  // Phrased over WHERE the formula sits and WHAT it reads, not over the characters in it. The
  // first version asked whether a P/L *reference* appeared beside a charge *reference*, which a
  // gain formula reading `=I10-N10-L10` passes trivially - it sits IN the P/L column and never
  // names one. A probe appending a charge term was caught only by the exact-string assertion
  // above, i.e. by luck. This is the rule itself.
  const chargeRefs = (f: string) => [11, 12].some(c => new RegExp(`\b${colA1(c)}\d`).test(f));
  const plCells = [9, 10].flatMap(c => rows.map(r => r[c])).filter(v => typeof v === "string" && v.startsWith("="));
  ok("no P/L cell reads a charge column - s.48, and gains here are charge-free turnover",
    plCells.length > 0 && plCells.every(f => !chargeRefs(f)));
  // Every range inside a SUM must be ONE column (a column total) or ONE row (a row total). A
  // 2-D block would double-count. This used to demand single-column outright, which was the
  // right rule while every SUM here was a column total — the expense pass adds row totals, so
  // the rule is stated as what it always meant rather than loosened.
  const ranges = all.filter(f => f.startsWith("=SUM")).flatMap(f => f.match(/[A-Z]+\d+:[A-Z]+\d+/g) || []);
  ok("every SUM range is one column or one row", ranges.length > 0 && ranges.every(rg => {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(rg);
    return !!m && (m[1] === m[3] || m[2] === m[4]);
  }));
  // ...and the GRAND TOTAL row's are vertical specifically, or two unrelated buckets foot into one.
  const gtSums = (rows[9 + B] || []).filter((v: any) => typeof v === "string" && v.startsWith("=SUM"));
  ok("the GRAND TOTAL row sums DOWN its own column", gtSums.length > 0 && gtSums.every((f: string) => {
    const m = /=SUM\(([A-Z]+)\d+:([A-Z]+)\d+\)/.exec(f); return !!m && m[1] === m[2];
  }));
}

console.log("\n-- the guard behind the emitter -----------------------------");
{
  // TWO INDEPENDENT DEFENCES, and the suite must be able to see each one alone.
  //
  // The emitter excludes the contra line and the CLOSING NIL row from `rateCells`, so with a
  // faithful fixture the builder's own numeric guard is never reached - a probe that deleted it
  // came back SILENT. This fixture therefore does what a future regression would: it hands the
  // builder rateCells entries pointing AT those two rows, and asserts the guard still refuses.
  const S = src() as any;
  S.derive.rateCells = [
    ...S.derive.rateCells,
    { r: 5, qtyCol: 2, rateCol: 3, amtCol: 4 },   // the CONTRA line: amount, no qty, no rate
    { r: 8, qtyCol: 2, rateCol: 3, amtCol: 4 },   // CLOSING NIL: the amount cell holds TEXT
  ];
  const { rows } = buildFormulaGrid(S);
  const B = BANNER_ROWS;
  eq("a blank qty yields no formula, even if the emitter offers the row", rows[5 + B][3], "");
  eq("...and a TEXT amount yields none either", rows[8 + B][3], "");
  eq("...while the genuine rows are unaffected", rows[3 + B][3], "=E7/C7");
}

console.log("\n-- the emitter's own exclusions -----------------------------");
{
  const REG = strip("src/lib/trxRegister.ts");
  // A corp-action CONTRA line carries a signed amount with NO qty and NO rate - writing zeros
  // there would read as "0 shares at 0.00". The emitter must not offer it as a rate cell.
  ok("the contra line is excluded at the emitter",
    /if \(cn\.qty !== undefined && cn\.rate !== undefined && cn\.qty > 0\) \{/.test(REG));
  // The CLOSING NIL row is pushed with no noteRate call at all.
  const nilPush = REG.slice(REG.indexOf('row[COL.name] = "CLOSING"; row[COL.oAmt] = "NIL"'));
  ok("the CLOSING NIL row is never offered",
    !/noteRate/.test(nilPush.slice(0, nilPush.indexOf("closingRanges.push"))));
  // A split restatement is offered only when it has a positive quantity.
  ok("a zero-qty split restatement is excluded", /if \(sp\.qty > 0\) \{ noteRate\(/.test(REG));
  // And the head row only when it actually carries an opening line.
  ok("the head row is offered only when it has one",
    /if \(openAgg\.length\) \{ noteRate\(out\.length - 1, COL\.oQty/.test(REG));
}


console.log("\n-- the paint -----------------------------------------------");
{
  const S = src() as any;
  const reqs = buildPaintRequests(42, S);
  const B = BANNER_ROWS;

  // The RESET must be FIRST and must stay UNBOUNDED. values.clear() wipes values but not
  // formatting, so without it a previous run's bands sit over this run's rows - and on a twin
  // whose row count changed, offset from the values beneath them.
  const first = reqs[0].repeatCell;
  ok("the reset is first", !!first && first.fields.includes("backgroundColor") && first.fields.includes("bold"));
  ok("...and unbounded", first.range.startRowIndex === undefined && first.range.startColumnIndex === undefined);

  // Every ROW index shifts by the banner; COLUMN indices do not, because ACQUISITION COST is
  // appended past the end rather than inserted.
  const fills = reqs.filter((r: any) => r.repeatCell?.fields === "userEnteredFormat.backgroundColor");
  ok("every band starts at or below the banner",
    fills.every((f: any) => (f.repeatCell.range.startRowIndex ?? 0) >= B));
  const hdr = fills.filter((f: any) => f.repeatCell.range.startRowIndex === 1 + B && f.repeatCell.range.endRowIndex === 3 + B);
  eq("six header bands + the added column's own", hdr.length, 7);

  // Lifted verbatim from writeAndPaint - a twin in different colours is not a twin.
  const colours = fills.map((f: any) => JSON.stringify(f.repeatCell.cell.userEnteredFormat.backgroundColor));
  ok("the SALES band is salmon", colours.includes(JSON.stringify({ red: 0.96, green: 0.6, blue: 0.51 })));
  ok("the OPENING band is orange", colours.includes(JSON.stringify({ red: 0.93, green: 0.6, blue: 0.25 })));
  ok("the P/L data band is lime", colours.includes(JSON.stringify({ red: 0.61, green: 0.8, blue: 0.4 })));

  // The frozen pane must move with the banner or the header scrolls away.
  const frozen = reqs.find((r: any) => r.updateSheetProperties);
  eq("the frozen pane covers the banner too", frozen.updateSheetProperties.properties.gridProperties.frozenRowCount, 3 + B);

  // Number formats start below the header, shifted the same way; the rate pattern must keep
  // 2-6 dp, because on THIS tab the rate cells are FORMULAS and the displayed precision is all
  // that stands between the reader and a figure that looks rounded.
  const fmts = reqs.filter((r: any) => r.repeatCell?.fields === "userEnteredFormat.numberFormat");
  ok("formats start below the shifted header",
    fmts.every((f: any) => f.repeatCell.range.startRowIndex === 3 + B));
  ok("the rate pattern is not truncated to paise",
    fmts.some((f: any) => f.repeatCell.cell.userEnteredFormat.numberFormat.pattern === "#,##,##0.00####"));
  ok("ACQUISITION COST is formatted as money",
    fmts.some((f: any) => f.repeatCell.range.startColumnIndex === S.derive.paint.width));

  // The closing band comes from closingRanges, shifted.
  ok("the closing band is shifted too",
    fills.some((f: any) => f.repeatCell.range.startRowIndex === 8 + B && f.repeatCell.range.endRowIndex === 9 + B));
}

console.log("\n── it never touches the filed tab ───────────────────────────");
{
  const VIEW = strip("src/lib/trxFormulaView.ts");
  // The twin's name is the ONLY tab this module writes.
  ok("every write is suffixed", /range: `\$\{tab\}!/.test(VIEW) && /const tab = src\.tab \+ FORMULA_TAB_SUFFIX/.test(VIEW));
  eq("the suffix is distinct", FORMULA_TAB_SUFFIX, " (Formula)");
  // Collect mode still runs the charge-conservation guard, so a register this app would REFUSE
  // to write cannot be rendered as a derived view either.
  ok("it refuses if the register ran in write mode", /if \(!res\.collectedOnly\)/.test(VIEW) && /throw new Error/.test(VIEW));
  // USER_ENTERED is required for a formula to evaluate and is safe ONLY because fmtDate writes
  // dd.mm.yyyy with dots; slashed dates would be reparsed as US mm-dd for every day <= 12.
  ok("it writes USER_ENTERED", /valueInputOption: "USER_ENTERED"/.test(VIEW));

  const REG = strip("src/lib/trxRegister.ts");
  // The early return must sit AFTER the guard and BEFORE the first filed write.
  const guard = REG.indexOf("do not reconcile");
  const collect = REG.indexOf("if (collect) {");
  const firstWrite = REG.indexOf("await writeAndPaint(dL, tabName");
  ok("collect mode returns after the guard", guard > 0 && collect > guard);
  ok("...and before the first filed write", collect > 0 && firstWrite > collect);
  ok("...carrying a marker so it cannot read as a finished register", /collectedOnly: true,/.test(REG));
}

console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
