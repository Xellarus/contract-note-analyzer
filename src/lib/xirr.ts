/**
 * XIRR — the money-weighted annual return of a dated cash-flow series.
 *
 * Same definition as Excel's XIRR so a result can be checked against a spreadsheet: the rate `r`
 * at which the flows discount to zero net present value, with an actual/365 day count measured
 * from the FIRST flow's date.
 *
 *     NPV(r) = Σ  cf_i / (1 + r) ^ ((t_i − t_0) / 365)
 *
 * Sign convention is the investor's: money leaving their pocket is NEGATIVE (a buy), money
 * coming back is POSITIVE (a sell, and the closing market value as a final synthetic inflow).
 *
 * This differs from the time-weighted return the NAV chart uses, and the two SHOULD disagree.
 * TWR strips out when money arrived, to judge stock selection; XIRR deliberately keeps it, to
 * measure what the capital actually earned. Adding money just before a run makes XIRR the
 * higher of the two, and vice versa.
 *
 * Solved by bisection rather than Newton-Raphson: a real portfolio's flows alternate sign many
 * times, and Newton diverges or oscillates on those series. Bisection cannot — given a bracket
 * it converges monotonically, which matters more here than the extra iterations cost.
 */

export interface CashFlow {
  /** Epoch ms. Normalise to a consistent midnight before calling; the day count uses the gap. */
  ts: number;
  /** ₹. Negative = invested (out of pocket), positive = returned (proceeds / closing value). */
  amount: number;
}

const DAY = 86400000;
/** Excel XIRR's day count. Using 365 (not 365.25) keeps results checkable against a sheet. */
export const DAYS_PER_YEAR = 365;

/** Lowest rate the solver will consider. At exactly −1 the discount factor divides by zero. */
const R_MIN = -0.9999999;
/** 100,000%/yr. Nothing real reaches this; it exists so the bracket search terminates. */
const R_MAX = 1000;

/** Net present value of `flows` at rate `r`, in years from the first flow. */
export function npv(flows: CashFlow[], r: number): number {
  if (!flows.length) return 0;
  const t0 = flows[0].ts;
  const base = 1 + r;
  let sum = 0;
  for (const f of flows) {
    const years = (f.ts - t0) / (DAY * DAYS_PER_YEAR);
    sum += years === 0 ? f.amount : f.amount / Math.pow(base, years);
  }
  return sum;
}

export interface XirrResult {
  /** Annualised money-weighted rate as a FRACTION (0.184 = 18.4%), or null when unsolvable. */
  rate: number | null;
  /** Why `rate` is null, or a caveat worth showing beside a solved rate. */
  note?: string;
  /**
   * True when the RUNNING CASH BALANCE crosses zero more than once — capital came fully back out
   * and went in again. Such a series can have several mathematically valid IRRs, so the rate
   * returned is real but not provably unique and the caller should label it. An account that
   * simply trades a lot does NOT set this: hundreds of buys and sells while staying net invested
   * still yield a unique root.
   */
  ambiguous?: boolean;
}

/**
 * Solve for the money-weighted rate. Returns `rate: null` (with a reason) rather than throwing
 * or inventing a number — an unsolvable series is a real answer here, not an error.
 */
export function xirr(flows: CashFlow[]): XirrResult {
  const clean = flows
    .filter((f) => isFinite(f.ts) && isFinite(f.amount) && f.amount !== 0)
    .sort((a, b) => a.ts - b.ts);

  if (clean.length < 2) return { rate: null, note: "needs at least two cash flows" };
  const hasOut = clean.some((f) => f.amount < 0);
  const hasIn = clean.some((f) => f.amount > 0);
  // Every flow the same way round has no break-even rate at all: nothing was returned, or
  // nothing was invested.
  if (!hasOut) return { rate: null, note: "no money invested" };
  if (!hasIn) return { rate: null, note: "nothing returned yet" };
  if (clean[clean.length - 1].ts === clean[0].ts) return { rate: null, note: "all flows on one date" };

  // Is the rate uniquely determined? By NORSTRØM'S CRITERION: if the RUNNING CASH BALANCE starts
  // negative and changes sign exactly once, the IRR is unique.
  //
  // The obvious test — counting sign changes in the flows themselves — is useless on a real
  // trading account. An active portfolio alternates buy, sell, buy, sell hundreds of times a
  // year, so that test fires on essentially every account and the caveat becomes noise the
  // reader learns to ignore. What actually threatens uniqueness is capital coming fully back
  // OUT and going in again; while the account stays net invested, the running balance never
  // crosses zero and the root is provably unique however many trades it took.
  let running = 0;
  let balanceCrossings = 0;
  let prevSign = 0;
  for (const f of clean) {
    running += f.amount;
    const s = Math.sign(running);
    if (s !== 0 && s !== prevSign) {
      if (prevSign !== 0) balanceCrossings++;
      prevSign = s;
    }
  }
  const uniqueRoot = balanceCrossings <= 1;

  // Bracket the root. NPV is continuous on (−1, ∞); at high r only the flows at t0 survive
  // discounting, so it settles at the sign of the earliest flow — normally negative, giving
  // the opposite sign to NPV at R_MIN.
  let lo = R_MIN;
  let hi = 0.1;
  let fLo = npv(clean, lo);
  let fHi = npv(clean, hi);
  if (!isFinite(fLo)) return { rate: null, note: "cash flows too extreme to solve" };

  let expands = 0;
  while (isFinite(fHi) && fLo * fHi > 0 && hi < R_MAX) {
    hi = hi * 2 + 0.1;
    fHi = npv(clean, hi);
    if (++expands > 200) break;
  }
  if (!isFinite(fHi) || fLo * fHi > 0) {
    return { rate: null, note: "no break-even rate exists for these flows" };
  }

  // Bisection to ~1e-10 absolute on the rate. 200 halvings of the initial bracket is far more
  // than enough; the loop also stops early once NPV is flat.
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(clean, mid);
    if (!isFinite(fMid)) return { rate: null, note: "cash flows too extreme to solve" };
    if (fMid === 0 || hi - lo < 1e-10) { lo = hi = mid; break; }
    if (fLo * fMid < 0) { hi = mid; fHi = fMid; } else { lo = mid; fLo = fMid; }
  }

  const rate = (lo + hi) / 2;
  if (!isFinite(rate)) return { rate: null, note: "did not converge" };
  return uniqueRoot ? { rate } : { rate, ambiguous: true };
}

/** Convenience: the rate as a percentage, or null. */
export function xirrPct(flows: CashFlow[]): number | null {
  const r = xirr(flows).rate;
  return r === null ? null : r * 100;
}
