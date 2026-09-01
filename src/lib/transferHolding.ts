import { gapi } from "gapi-script";
import { XFER_IN_TYPE, XFER_OUT_TYPE, toIsoDate } from "./tradeRowSchema";
import { ensureSheetTabs } from "./sheetTabs";
import { appendRecordsToTab } from "./manualTrades";
import { rebuildHoldingTab } from "./holdingsCalc";

/**
 * CROSS-PORTFOLIO HOLDING TRANSFER — move shares from one portfolio's book to another.
 *
 * A transfer is NOT a sale. No capital gain is realised, the FIFO cost basis carries
 * across, and the ORIGINAL ACQUISITION DATE travels with each lot so a later sale in the
 * receiving account is still judged long- or short-term against the real purchase date.
 * That is why a transfer is k rows, not one: 1,000 shares taken FIFO may come from three
 * lots bought on three dates, and averaging them into a single row would destroy both the
 * holding period and the lot structure.
 *
 * ── The two cost columns, and why they differ ────────────────────────────────────────
 * Two engines read cost from two different columns, and they want different things:
 *
 *   Total Amount (Turnover)                  → syncCapitalGains / trxRegister basis
 *                                              (they divide by qty and treat it as
 *                                               CHARGE-FREE)
 *   Total Amount with Expense (Incl STT)     → the Holding tab's "invested" (ALL-IN)
 *
 * So the OUT/IN rows carry `turnover = qty × purPrice` (the exact basis the source book
 * used for that lot, cleanly inherited) and `totalWithExpInclSTT = qty × inclPrice` (so the
 * destination's Holding tab shows the same invested value the source showed). Every charge
 * column is ZERO: a transfer incurs no new brokerage or STT, and writing the source's
 * charges here would count the same brokerage as a cost in two portfolios' registers.
 *
 * The rows are therefore deliberately NOT self-consistent in the usual
 * `withExpense = turnover + expenses` sense. That is the only way to hand each engine the
 * figure it actually needs, and it is why `Holdings.tsx`'s Edit-Entry popup refuses to
 * rewrite a transfer row (it recomputes that column from turnover ± expenses and would
 * silently flatten the carried all-in cost).
 *
 * ── What is NOT solved here ──────────────────────────────────────────────────────────
 * The receiving rows are dated with the ORIGINAL acquisition date (a deliberate choice).
 * Tax is therefore correct, but BOTH portfolios show these shares for the whole
 * pre-transfer period in NAV, AUM and the consolidated view — the source legitimately held
 * them, and the destination's back-dated rows claim it did too. `crossHoldings` sums the
 * derived Holding tabs and cannot detect the overlap. Separating "acquired on" from
 * "arrived on" needs a second date column; see the vault note.
 */

/** One lot available to transfer, as the source book's FIFO queue holds it. */
export interface TransferSourceLot {
  /** Original acquisition date. `DD/MM/YYYY` — what lands in the destination's Trade Date. */
  acquiredDMY: string;
  /** Shares still held in this lot. */
  remaining: number;
  /** Charge-free cost per share (the capital-gains basis). Full precision, never rounded. */
  purPrice: number;
  /** All-in cost per share including capitalised charges. Falls back to purPrice. */
  inclPrice?: number;
}

/** A lot, or part of one, selected for transfer. */
export interface TransferLot {
  acquiredDMY: string;
  qty: number;
  purPrice: number;
  inclPrice: number;
}

export interface TransferPlan {
  lots: TransferLot[];
  /** Σ lot qty — equals the requested quantity when the plan is satisfiable. */
  qty: number;
  /** Requested minus available; > 0 means the source does not hold enough. */
  shortfall: number;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r6 = (n: number) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;

/**
 * FIFO-select `qty` shares from `available` (which MUST already be oldest-first).
 *
 * Pure and total: it never throws and never partially mutates. A request larger than the
 * holding returns every lot plus a `shortfall`, so the caller can refuse rather than
 * transfer a silently smaller quantity than the user asked for.
 */
export function planTransfer(available: TransferSourceLot[], qty: number): TransferPlan {
  const lots: TransferLot[] = [];
  let left = Math.max(0, qty);
  for (const l of available) {
    if (left <= 1e-9) break;
    const rem = Math.max(0, l.remaining);
    if (rem <= 1e-9) continue;
    const take = Math.min(rem, left);
    lots.push({
      acquiredDMY: l.acquiredDMY,
      qty: take,
      purPrice: r6(l.purPrice),
      // A lot with no recorded all-in cost falls back to its charge-free cost rather than
      // to zero — losing the basis entirely is far worse than under-stating the expenses.
      inclPrice: r6(l.inclPrice != null && l.inclPrice > 0 ? l.inclPrice : l.purPrice),
    });
    left -= take;
  }
  const taken = lots.reduce((s, l) => s + l.qty, 0);
  return { lots, qty: taken, shortfall: r6(Math.max(0, qty - taken)) };
}

/** Sheet-row records for one leg. Keys match `headerKey`, so writers stay header-aware. */
export type TransferRecord = Record<string, any>;

export interface BuildTransferArgs {
  plan: TransferPlan;
  securityName: string;
  isin: string;
  /** When the shares actually moved, `DD/MM/YYYY`. Used for the OUT leg's Trade Date. */
  transferDMY: string;
  /** Display label of the counterparty account, e.g. "Sagun Capital". */
  fromLabel: string;
  toLabel: string;
  /** Stamped on every row of both legs so a half-finished transfer is identifiable. */
  transferRef: string;
}

const ZERO_CHARGES = {
  brokeragePerShare: 0, brokerage: 0, stt: 0, exchangeCharges: 0, sebiFees: 0,
  ipf: 0, gst: 0, stampDuty: 0, totalExpInclSTT: 0, totalExpExclSTT: 0,
};

/**
 * Build both legs. Returns them separately because they are written to DIFFERENT
 * spreadsheets and the destination is written FIRST (see `transferWriteOrder`).
 */
export function buildTransferRecords(args: BuildTransferArgs): {
  outRecords: TransferRecord[];
  inRecords: TransferRecord[];
} {
  const { plan, securityName, isin, transferDMY, fromLabel, toLabel, transferRef } = args;

  const row = (
    txType: string, tradeDMY: string, lot: TransferLot, notes: string,
  ): TransferRecord => ({
    date: toIsoDate(tradeDMY),
    isin: "",                       // True Entry has no ISIN column; identity is the name
    name: securityName,
    txType,
    qty: lot.qty,
    price: lot.purPrice,
    // CHARGE-FREE basis — what the capital-gains engines divide by qty.
    turnover: r2(lot.qty * lot.purPrice),
    ...ZERO_CHARGES,
    // ALL-IN carried cost — what the Holding tab reports as invested. Deliberately not
    // turnover + expenses; see the header comment.
    totalWithExpInclSTT: r2(lot.qty * lot.inclPrice),
    totalWithExpExclSTT: r2(lot.qty * lot.inclPrice),
    // Never "Intraday": an intraday tag would route the row into the speculative bucket.
    tradeClass: "Delivery",
    notes,
    importId: transferRef,
  });

  return {
    // OUT leg: dated when the shares actually left.
    outRecords: plan.lots.map((l) =>
      row(XFER_OUT_TYPE, transferDMY, l, `Transferred to ${toLabel} (acquired ${l.acquiredDMY})`)),
    // IN leg: dated with the ORIGINAL acquisition date, so the holding period survives.
    inRecords: plan.lots.map((l) =>
      row(XFER_IN_TYPE, l.acquiredDMY, l, `Transferred from ${fromLabel}`)),
  };
}

/**
 * Write the DESTINATION first, then the source.
 *
 * There is no transaction across two Google Sheets. If the first write lands and the second
 * fails, the shares exist in both books — visibly wrong, reconcilable, and recoverable by
 * re-running (the rows carry a transfer ref). The other order would delete them from the
 * source and never create them anywhere: silent, and unrecoverable without the ref. Given a
 * forced choice between duplicating and destroying financial records, duplicate.
 */
export const transferWriteOrder = ["destination", "source"] as const;

/** A taxable transfer is an ordinary disposal: it uses Sell/Buy, not the transfer types. */
export function buildSaleRecords(args: BuildTransferArgs & { salePrice: number }): {
  outRecords: TransferRecord[];
  inRecords: TransferRecord[];
} {
  const { plan, securityName, transferDMY, fromLabel, toLabel, transferRef, salePrice } = args;
  const px = r6(salePrice);
  const qty = plan.qty;
  const turnover = r2(qty * px);
  const base = {
    isin: "", name: securityName, qty, price: px, turnover, ...ZERO_CHARGES,
    totalWithExpInclSTT: turnover, totalWithExpExclSTT: turnover,
    tradeClass: "Delivery", importId: transferRef,
  };
  return {
    // A real disposal: ONE row at the agreed price, dated the transfer date, and capital
    // gains fire normally against the source's FIFO lots. No date is carried, because the
    // holding period genuinely restarts on a purchase.
    outRecords: [{ ...base, date: toIsoDate(transferDMY), txType: "Sell", notes: `Sold to ${toLabel}` }],
    inRecords: [{ ...base, date: toIsoDate(transferDMY), txType: "Buy", notes: `Bought from ${fromLabel}` }],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Execution — the only part that touches Google Sheets
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Make sure `tab` has a column headed `title`, appending it to row 1 if not.
 *
 * The transfer ref lives in the Import ID column and is what makes a re-run idempotent, so
 * it is not optional: a sheet created before that column existed would otherwise swallow
 * the ref and a repeated transfer would silently double the shares.
 */
async function ensureColumn(spreadsheetId: string, tab: string, title: string): Promise<void> {
  const res: any = await (gapi.client as any).sheets.spreadsheets.values.get({
    spreadsheetId, range: `${tab}!A1:Z1`,
  });
  const header: string[] = ((res?.result?.values?.[0] as any[]) || []).map((h) => (h ?? "").toString());
  if (header.some((h) => h.trim().toLowerCase() === title.toLowerCase())) return;
  const idx = header.filter((h) => h.trim() !== "").length;
  let n = idx + 1, col = "";
  while (n > 0) { const m = (n - 1) % 26; col = String.fromCharCode(65 + m) + col; n = Math.floor((n - 1) / 26); }
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId, range: `${tab}!${col}1`, valueInputOption: "USER_ENTERED",
    resource: { values: [[title]] },
  });
}

/** True when `ref` already appears anywhere in the tab — i.e. this transfer already ran. */
async function refAlreadyPresent(spreadsheetId: string, tab: string, ref: string): Promise<boolean> {
  try {
    const res: any = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId, range: `${tab}!A:Z`,
    });
    const rows: any[][] = res?.result?.values || [];
    return rows.some((r) => (r || []).some((c) => (c ?? "").toString().trim() === ref));
  } catch {
    // A read failure must NOT be read as "not present" - that would re-write the leg and
    // double the shares. Claim presence so the caller stops and the operator investigates.
    return true;
  }
}

export interface ExecuteTransferArgs extends BuildTransferArgs {
  fromSheetId: string;
  toSheetId: string;
  /** True for the taxable variant: a real disposal at `salePrice`, gains fire normally. */
  asSale?: boolean;
  salePrice?: number;
}

export interface ExecuteTransferResult {
  ok: boolean;
  wrote: { destination: boolean; source: boolean };
  skipped?: string;
  /** Set when the destination was written but the source was not - shares now DUPLICATED. */
  halfDone?: string;
  error?: string;
  holdingWarning?: string;
}

/**
 * Write both legs. DESTINATION FIRST, deliberately.
 *
 * There is no transaction across two Google Sheets. Writing the destination first means a
 * failure between the two leaves the shares in BOTH books: wrong, but visible, reconcilable,
 * and safe to fix by re-running (the ref makes the completed leg a no-op). The other order
 * would remove them from the source and create them nowhere - silent and unrecoverable.
 * Given a forced choice between duplicating and destroying financial records, duplicate.
 */
export async function executeTransfer(args: ExecuteTransferArgs): Promise<ExecuteTransferResult> {
  const { fromSheetId, toSheetId, transferRef, asSale, salePrice } = args;
  const wrote = { destination: false, source: false };

  if (fromSheetId === toSheetId) {
    return { ok: false, wrote, error: "Source and destination are the same account." };
  }
  if (args.plan.shortfall > 1e-9) {
    return {
      ok: false, wrote,
      error: `Only ${args.plan.qty} shares are held; ${args.plan.shortfall} short of the requested quantity.`,
    };
  }
  if (args.plan.lots.length === 0) {
    return { ok: false, wrote, error: "Nothing to transfer." };
  }
  if (asSale && !(Number(salePrice) > 0)) {
    return { ok: false, wrote, error: "A sale needs a price greater than zero." };
  }

  const built = asSale
    ? buildSaleRecords({ ...args, salePrice: Number(salePrice) })
    : buildTransferRecords(args);

  try {
    for (const [sheetId, tab] of [[toSheetId, "Raw Entry"], [toSheetId, "True Entry"],
                                  [fromSheetId, "Raw Entry"], [fromSheetId, "True Entry"]] as const) {
      await ensureSheetTabs(sheetId, ["Raw Entry", "True Entry", "Holding"]);
      await ensureColumn(sheetId, tab, "Import ID");
    }

    // Idempotency: if either leg is already on the sheet, this transfer has run before.
    if (await refAlreadyPresent(toSheetId, "True Entry", transferRef)) {
      return { ok: false, wrote, skipped: "This transfer has already been written to the destination account." };
    }

    for (const tab of ["Raw Entry", "True Entry"]) {
      await appendRecordsToTab(toSheetId, tab, built.inRecords);
    }
    wrote.destination = true;

    for (const tab of ["Raw Entry", "True Entry"]) {
      await appendRecordsToTab(fromSheetId, tab, built.outRecords);
    }
    wrote.source = true;
  } catch (e: any) {
    const msg = e?.result?.error?.message || e?.message || String(e);
    if (wrote.destination && !wrote.source) {
      return {
        ok: false, wrote, error: msg,
        halfDone: "The destination account was written but the source was NOT, so these shares "
          + "now appear in BOTH accounts. Re-run the same transfer to finish it - the completed "
          + "leg is skipped automatically.",
      };
    }
    return { ok: false, wrote, error: msg };
  }

  // Holding tabs are derived; refresh both. A failure here is cosmetic and recoverable via
  // the Rebuild button, so it is reported rather than treated as a failed transfer.
  let holdingWarning: string | undefined;
  for (const id of [toSheetId, fromSheetId]) {
    try { await rebuildHoldingTab(id); } catch (e: any) {
      holdingWarning = `Rows written, but a Holding tab could not be rebuilt: ${e?.message || e}. Use Rebuild on that portfolio.`;
    }
  }
  return { ok: true, wrote, holdingWarning };
}
