/**
 * ITR schedule: "Details of Unlisted Equity Shares held at any time during the previous year"
 * (ITR-2 / ITR-3). One row group per unlisted company, per financial year.
 *
 * This is a FILING artefact, not a management report. The layout below is copied from the
 * owner's own filed FY2024-25 return (acknowledgement 645654391261125, filed 26-Nov-2025) and
 * every convention in it was read OFF that file rather than chosen here — including the ones
 * that contradict how the rest of this app prints things. Where the two disagree, the filed
 * file wins on this tab and only on this tab; the divergences are called out at each site.
 *
 * The fifteen columns, in four groups:
 *
 *   A  Sl. No.                B  Name of company       C  Type of Company   D  PAN of Company
 *   E  Opening - qty          F  Opening - cost
 *   G  Acquired - qty         H  Acquired - date       I  Acquired - face value per share
 *   J  Acquired - issue price per share (fresh issue)
 *   K  Acquired - purchase price per share (existing shareholder)
 *   L  Transferred - qty      M  Transferred - sale consideration
 *   N  Closing - qty          O  Closing - cost
 *
 * ── The row rule, and why it is what it is ──────────────────────────────────────────────────
 *
 * ONE ROW PER ACQUISITION, not one row per company. The filed file proves it and also proves
 * how the balances distribute: `9M India Ltd` occupies rows 5 and 6 carrying closing balances
 * of 18,000 and 12,000 — so CLOSING IS PER ROW, and the company's real closing position is the
 * SUM of its rows. Same for `Curis Lifescience` and `Pace Digitek`. That is what makes the
 * schedule's own `=SUM(N5:N57)` total meaningful, and it is why the balances are distributed
 * across rows here rather than parked on the first one.
 *
 * Each row therefore foots ON ITS OWN:
 *
 *     closing(row) = opening(row) + acquired(row) - transferred(row)
 *
 * with the opening balance on the company's FIRST row and the transfer allocated OLDEST-FIRST
 * across its rows — FIFO, the same order the lots are actually consumed in. Allocating the
 * transfer (rather than pinning it to row 1) is what keeps the identity true for a company
 * that sold more than its opening plus first purchase; pinned, such a row prints a negative
 * closing balance on a filed page. In the ordinary case the whole transfer lands on row 1 and
 * the two schemes are identical, which is why the filed file cannot distinguish them.
 *
 * `NSE` row 37 exercises the whole rule end to end: opening 24,000 + acquired 96,000 (bonus,
 * issue price 0) - transferred 24,000 = closing 96,000, with closing COST blank because the
 * 96,000 survivors are bonus shares that cost nothing.
 *
 * ── Blank versus zero: the file is not consistent, and copying it is deliberate ─────────────
 *
 * BLANK where the fact does not exist:
 *   - E/F for a company with no opening balance (bought for the first time during the year).
 *     This is the commonest case and the easiest to get wrong: summing an empty lot list
 *     yields 0, and a filed 0.00 asserts the company WAS held on 1-Apr at nil cost.
 *   - G/H on a company's row when it made no acquisition that year.
 *   - L/M when nothing was transferred.
 *   - N/O when the position closed at nil — and O alone when the survivors are bonus shares
 *     (`Curis` r14, `Pace Digitek` r39, `NSE` r37 all print a closing QUANTITY and a blank
 *     closing COST).
 *
 * ZERO, because the filed file prints zero:
 *   - I/J/K on a row with no acquisition (`ARCHIT NUWOOD` r8 prints 0, 0.00, 0.00).
 *   - K on every row, always — see below.
 *   - I where the face value is simply not known (`Smallcase` r46 prints 0 against a real
 *     acquisition).
 * That last group is the one place this file diverges from the PE holding statement, which
 * prints a missing face value BLANK on the reasoning that zero is not a fact about a company.
 * Both are right for their own document: the holding statement is a statement of fact, and
 * this is a form whose "shares acquired" group is nil when nothing was acquired.
 *
 * ── Columns J and K ─────────────────────────────────────────────────────────────────────────
 *
 * J is "issue price (fresh issue)", K is "purchase price (existing shareholder)", and they are
 * mutually exclusive. Nothing in this app records which a purchase was: `ledgerSide` collapses
 * RIGHT / IPO / SUBSCRIB / ALLOT into "BUY" (`tradeRowSchema.ts`), and a private placement is
 * entered as a plain Buy anyway. The owner's filed return puts EVERY acquisition in J and
 * leaves K at 0.00 on all 53 rows, so that is what this reproduces — decided 14-Sep-2026 with
 * the limitation stated. Recording the distinction needs a ledger column, not a guess here.
 *
 * The rate itself is `turnover / qty`, DERIVED — never the ledger's own 2-dp `Avg Price`
 * column, for the reason given in `holdingsCalc.ts`: the stored average is a rounded display
 * figure and the derived one is the number the cost basis is actually built from.
 */

import { formatDMY } from "./dates";

/** One acquisition parcel. `turnover` is charge-free — see the cost-basis note below. */
export interface ItrAcquisitionInput {
  ts: number;
  qty: number;
  /** Charge-free turnover for the parcel. 0 for a bonus, which is what makes J print 0.00. */
  turnover: number;
}

/**
 * One company's year, already reduced to the facts the schedule needs.
 *
 * COST BASIS. `openingCost` / `closingCost` / `turnover` are all charge-free turnover
 * (`qty x min(purPrice, inclPrice)`), the same basis every capital gain in this app is
 * computed on, so this schedule and the capital-gains tabs reconcile to the rupee. For an
 * off-market unlisted holding the two bases coincide anyway — there is normally no brokerage,
 * and the owner's own filed figures are exact `qty x rate` products (`9M India` 18,000 x 143 =
 * 25,74,000; `Hunger Pangs` 14,748 x 2,034 = 2,99,97,432). Where a PE lot DOES carry charges
 * the two would differ, so the builder counts those companies and the caller reports the count
 * rather than letting the divergence pass unseen.
 */
export interface ItrCompanyInput {
  /** The scrip master's canonicalName. NEVER the ledger/broker spelling, which is truncated. */
  name: string;
  pan: string;
  /** Domestic / Foreign, straight off the Private Equities tab. */
  companyType: string;
  faceValue: number;
  openingQty: number;
  openingCost: number;
  acquisitions: ItrAcquisitionInput[];
  transferredQty: number;
  consideration: number;
  /** The FIFO closing position. Authoritative — see `unfooted` below. */
  closingQty: number;
  closingCost: number;
  /** True when any lot reaching this company carried a charge (brokerage, stamp, ...). */
  hasCharges?: boolean;
}

export const ITR_HEADER: string[] = [
  "Sl. No.",
  "Name of company",
  "Type of Company",
  "PAN of Company",
  "Opening Balance - No. of shares",
  "Opening Balance - Cost of acquisition",
  "Shares acquired - No. of shares",
  "Shares acquired - Date of subscription/purchase",
  "Shares acquired - Face value per share",
  "Shares acquired - Issue price per share (fresh issue)",
  "Shares acquired - Purchase price per share (existing shareholder)",
  "Shares transferred - No. of shares",
  "Shares transferred - Sale consideration",
  "Closing balance - No. of shares",
  "Closing balance - Cost of acquisition",
];

/** 0-based column indices, named. The tab is read BY HEADER downstream; these are for writing. */
export const ITR_COL = {
  sno: 0, name: 1, type: 2, pan: 3,
  openQty: 4, openCost: 5,
  acqQty: 6, acqDate: 7, faceValue: 8, issuePrice: 9, purchasePrice: 10,
  xferQty: 11, consideration: 12,
  closeQty: 13, closeCost: 14,
} as const;

export const ITR_WIDTH = ITR_HEADER.length;

/** Column widths, in the filed file's own units. */
export const ITR_COL_WIDTHS = [6, 32, 12, 14, 12, 16, 12, 16, 10, 14, 16, 12, 16, 12, 16];

/** Rows 1-2 are a merged banner, row 3 is blank, row 4 is the header, data starts on row 5. */
export const ITR_BANNER_ROWS = 2;
export const ITR_HEADER_ROW_INDEX = 3;   // 0-based => sheet row 4
export const ITR_FIRST_DATA_ROW_INDEX = 4;

export interface ItrSheet {
  rows: (string | number)[][];
  /** 0-based index of the TOTAL row within `rows`. */
  totalRowIndex: number;
  /** 0-based index of the first and last data rows within `rows`. */
  firstDataRowIndex: number;
  lastDataRowIndex: number;
  /** Companies emitted (not rows). */
  companyCount: number;
  /** Companies whose arithmetic could not be made to foot — named, never absorbed. */
  unfooted: string[];
  /** Companies missing a PAN on the scrip master. A filed blank must be a visible blank. */
  missingPan: string[];
  /** Companies whose cost basis includes a charged lot, so turnover != all-in. */
  charged: string[];
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const EPS = 1e-9;
/** Blank, not zero — the distinction this schedule turns on. */
const blankIfZero = (n: number): number | string => (Math.abs(n) < EPS ? "" : n);

interface EmitRow {
  acq: ItrAcquisitionInput | null;
  openQty: number;
  openCost: number;
  xferQty: number;
  consideration: number;
  closeQty: number;
  closeCost: number;
}

/**
 * Group a company's acquisitions into the rows the schedule shows.
 *
 * By DATE **and rate**, not by date alone. Two fills of one order on one day at one price are
 * a single subscription and belong on one line; a bonus and a cash purchase that happen to
 * share a date are two different events at two different prices, and merging them would force
 * a weighted-average rate into column J — a number that was never paid for anything. The
 * register's own `consolidate` groups on `ts` alone, which is right for a holding statement
 * and wrong here.
 */
const groupAcquisitions = (acqs: ItrAcquisitionInput[]): ItrAcquisitionInput[] => {
  const m = new Map<string, ItrAcquisitionInput>();
  for (const a of acqs) {
    if (a.qty <= EPS) continue;
    const rate = a.qty > 0 ? a.turnover / a.qty : 0;
    const gk = `${a.ts}|${rate.toFixed(6)}`;
    const e = m.get(gk);
    if (e) { e.qty += a.qty; e.turnover += a.turnover; }
    else m.set(gk, { ts: a.ts, qty: a.qty, turnover: a.turnover });
  }
  return [...m.values()].sort((a, b) => a.ts - b.ts);
};

/**
 * Lay one company out over its rows.
 *
 * The transfer is allocated OLDEST-FIRST (the order FIFO actually consumes lots in) so every
 * row foots on its own. The closing COST is then allocated the other way about: each
 * acquisition row after the first takes `its surviving qty x its own rate`, and the FIRST row
 * takes the RESIDUAL of the company's FIFO closing cost. That is exact by construction rather
 * than by rounding luck, and it reproduces the filed file: `9M India` r5/r6 come out at
 * 25,74,000 and 58,80,000, and `Curis` r14 comes out at 0 — blank — because its survivors are
 * bonus shares.
 */
const layOutCompany = (c: ItrCompanyInput, acqs: ItrAcquisitionInput[]): EmitRow[] => {
  const rows: EmitRow[] = acqs.length
    ? acqs.map(a => ({ acq: a, openQty: 0, openCost: 0, xferQty: 0, consideration: 0, closeQty: 0, closeCost: 0 }))
    : [{ acq: null, openQty: 0, openCost: 0, xferQty: 0, consideration: 0, closeQty: 0, closeCost: 0 }];
  rows[0].openQty = c.openingQty;
  rows[0].openCost = c.openingCost;

  // Transfer, oldest-first over (opening + that row's acquisition).
  let left = c.transferredQty;
  for (const row of rows) {
    if (left <= EPS) break;
    const avail = row.openQty + (row.acq ? row.acq.qty : 0);
    const take = Math.min(left, avail);
    row.xferQty = take;
    left -= take;
  }
  // Anything still unallocated means the book sold more than it ever held — the register
  // already emits that as an uncovered ST parcel. Put it on the first row so the quantity is
  // not silently dropped; the company then fails to foot and is NAMED for it.
  if (left > EPS) rows[0].xferQty += left;

  // Consideration follows the quantity pro rata, and the last row carrying any transfer takes
  // the residual so the company's total is exact.
  const totalXfer = rows.reduce((s, r) => s + r.xferQty, 0);
  let consLeft = c.consideration;
  const xferRows = rows.filter(r => r.xferQty > EPS);
  xferRows.forEach((row, i) => {
    if (i === xferRows.length - 1) { row.consideration = r2(consLeft); return; }
    const share = r2(c.consideration * (row.xferQty / totalXfer));
    row.consideration = share;
    consLeft -= share;
  });

  for (const row of rows) row.closeQty = row.openQty + (row.acq ? row.acq.qty : 0) - row.xferQty;

  // Closing cost: later rows at their own rate, first row takes the residual.
  let costLeft = c.closingCost;
  for (let i = rows.length - 1; i >= 1; i--) {
    const row = rows[i];
    const rate = row.acq && row.acq.qty > 0 ? row.acq.turnover / row.acq.qty : 0;
    row.closeCost = r2(Math.max(0, row.closeQty) * rate);
    costLeft -= row.closeCost;
  }
  rows[0].closeCost = r2(Math.max(0, costLeft));
  return rows;
};

/**
 * Build the sheet.
 *
 * `companies` must already be filtered to unlisted EQUITY SHARES — this builder has no way to
 * tell an LLP capital contribution or an unlisted debenture from an equity share, and neither
 * belongs on this schedule.
 */
export function buildItrUnlistedSchedule(
  companies: ItrCompanyInput[],
  opts: { title: string; subtitle: string },
): ItrSheet {
  const width = ITR_WIDTH;
  const blank = (): (string | number)[] => Array.from({ length: width }, () => "");

  const rows: (string | number)[][] = [];
  const banner1 = blank(); banner1[0] = opts.title; rows.push(banner1);
  const banner2 = blank(); banner2[0] = opts.subtitle; rows.push(banner2);
  rows.push(blank());
  rows.push(ITR_HEADER.slice());

  const firstDataRowIndex = rows.length;
  const unfooted: string[] = [];
  const missingPan: string[] = [];
  const charged: string[] = [];

  const sorted = [...companies].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  let sno = 0;
  const tot = { openQty: 0, openCost: 0, acqQty: 0, xferQty: 0, consideration: 0, closeQty: 0, closeCost: 0 };

  for (const c of sorted) {
    const acqs = groupAcquisitions(c.acquisitions);
    const laid = layOutCompany(c, acqs);

    // The FIFO closing is the truth. If the company's own arithmetic cannot reach it, a split,
    // merger/demerger receipt or cross-portfolio transfer moved shares without an acquisition
    // or transfer row of its own. Correct the FIRST row so the filed CLOSING BALANCE is right,
    // and name the company rather than absorbing the difference — an unexplained delta on a
    // filed page is the thing nobody can reconstruct six months later.
    const derivedQty = laid.reduce((s, r) => s + r.closeQty, 0);
    if (Math.abs(derivedQty - c.closingQty) > 1e-6) {
      laid[0].closeQty += c.closingQty - derivedQty;
      unfooted.push(c.name);
    }
    if (!c.pan) missingPan.push(c.name);
    if (c.hasCharges) charged.push(c.name);

    for (const row of laid) {
      const out = blank();
      sno += 1;
      out[ITR_COL.sno] = sno;
      out[ITR_COL.name] = c.name;
      out[ITR_COL.type] = c.companyType;
      out[ITR_COL.pan] = c.pan;
      out[ITR_COL.openQty] = blankIfZero(row.openQty);
      out[ITR_COL.openCost] = blankIfZero(r2(row.openCost));
      if (row.acq) {
        const rate = row.acq.qty > 0 ? row.acq.turnover / row.acq.qty : 0;
        out[ITR_COL.acqQty] = row.acq.qty;
        out[ITR_COL.acqDate] = formatDMY(new Date(row.acq.ts));
        out[ITR_COL.faceValue] = c.faceValue > 0 ? c.faceValue : 0;
        out[ITR_COL.issuePrice] = r2(rate);
      } else {
        // No acquisition: the filed file prints 0 across the whole "shares acquired" group's
        // per-share columns and leaves quantity and date empty.
        out[ITR_COL.faceValue] = 0;
        out[ITR_COL.issuePrice] = 0;
      }
      // K is 0 on every row: the app cannot tell a fresh issue from a secondary purchase, and
      // the owner's filed return puts every acquisition in J.
      out[ITR_COL.purchasePrice] = 0;
      out[ITR_COL.xferQty] = blankIfZero(row.xferQty);
      out[ITR_COL.consideration] = blankIfZero(r2(row.consideration));
      out[ITR_COL.closeQty] = blankIfZero(row.closeQty);
      out[ITR_COL.closeCost] = blankIfZero(r2(row.closeCost));
      rows.push(out);

      tot.openQty += row.openQty;
      tot.openCost += row.openCost;
      tot.acqQty += row.acq ? row.acq.qty : 0;
      tot.xferQty += row.xferQty;
      tot.consideration += row.consideration;
      tot.closeQty += row.closeQty;
      tot.closeCost += row.closeCost;
    }
  }

  const lastDataRowIndex = rows.length - 1;

  if (sno === 0) {
    const none = blank();
    none[ITR_COL.name] = "No unlisted equity shares were held at any time during this year.";
    rows.push(none);
  }

  rows.push(blank());
  const total = blank();
  total[ITR_COL.name] = "TOTAL";
  total[ITR_COL.openQty] = blankIfZero(tot.openQty);
  total[ITR_COL.openCost] = blankIfZero(r2(tot.openCost));
  total[ITR_COL.acqQty] = blankIfZero(tot.acqQty);
  total[ITR_COL.xferQty] = blankIfZero(tot.xferQty);
  total[ITR_COL.consideration] = blankIfZero(r2(tot.consideration));
  total[ITR_COL.closeQty] = blankIfZero(tot.closeQty);
  total[ITR_COL.closeCost] = blankIfZero(r2(tot.closeCost));
  // Written as VALUES, not as =SUM(): the register has never written a cell formula, a formula
  // with no cached result reads back as `undefined` through a workbook reader, and a broken
  // total row would then pass a round-trip test as an empty one.
  const totalRowIndex = rows.length;
  rows.push(total);

  if (unfooted.length) {
    const n = blank();
    n[ITR_COL.name] = `Closing balance for ${unfooted.join(", ")} includes shares that arrived or left `
      + "without an acquisition or transfer row of their own (a split, a merger/demerger receipt or a "
      + "cross-portfolio transfer). The closing figure is the FIFO position and is correct; the row "
      + "arithmetic above will not foot for those companies.";
    rows.push(n);
  }

  return {
    rows, totalRowIndex, firstDataRowIndex,
    lastDataRowIndex: Math.max(lastDataRowIndex, firstDataRowIndex),
    companyCount: sorted.length, unfooted, missingPan, charged,
  };
}
