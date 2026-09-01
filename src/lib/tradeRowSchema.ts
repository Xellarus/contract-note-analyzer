/**
 * Shared column routing for the trade ledger (`True Entry` / `Raw Entry`),
 * used by BOTH the contract-note import and manual entry so each writes rows
 * aligned to whatever header a sheet currently has — and silently omits any
 * column the sheet no longer carries (e.g. ISIN once it's been removed).
 *
 * A "record" is a plain object keyed by the canonical names below; `headerKey`
 * maps a sheet header cell to one of those keys, and `mapRecordsToHeader` lays
 * records out in the sheet's column order.
 */

/**
 * Map a ledger "Transaction Type" to the holding SIDE the replay engines use.
 * The ledger stores the real action ("Buy" / "Sell" / "IPO" / "Bonus" / "Split" /
 * "Rights") for display, but every engine only adds (buy) or removes (sell) shares:
 *   • SELL  — Sell / Sale / Buyback / Redeem  → removes shares
 *   • BUY   — Buy / IPO / Bonus / Split / Rights / Purchase / Allot / Paid → adds shares
 *             (Bonus & Split carry ₹0, so their sheet row already has 0 turnover/cost)
 *   • ""    — anything else (Dividend, blank) → skipped by the replay
 * Buyback is tested before Buy (it contains "buy"). Existing rows are only ever
 * "Buy"/"Sell", so this maps them identically — no change to historical data.
 */
/**
 * The EXACT Transaction Type strings a cross-portfolio transfer writes. The UI writes these
 * and the engines classify them, so they are a data contract - renaming one is a migration
 * of every historical row, not a cosmetic change.
 */
export const XFER_OUT_TYPE = "Transfer Out";
export const XFER_IN_TYPE = "Transfer In";

/**
 * Transfer labels, matched BEFORE the buy/sell keyword tests below. Order is load-bearing:
 * "Transfer In (Rights)" would otherwise be dragged buy-side by RIGHT, and "Transfer Sale"
 * sell-side by SALE, both of which would book a capital gain on a movement that realises
 * none. Anchored on word boundaries so "TRANSFER INTO" cannot satisfy the IN form.
 */
const XFER_OUT_RE = /\bTRANSFER\s*(?:OUT|DEBIT)\b|\bXFER\s*OUT\b/;
const XFER_IN_RE = /\bTRANSFER\s*(?:IN|CREDIT)\b|\bXFER\s*IN\b/;

export function ledgerSide(type: string): "BUY" | "SELL" | "" {
  const t = (type || "").toUpperCase();
  // A transfer MOVES shares between portfolios but realises no gain. It is given a normal
  // SIDE here so every holdings / NAV / AUM consumer shifts the quantity without needing to
  // know the concept; the capital-gains engines additionally consult isTransferType() and
  // emit no gain record. Before this, "Transfer Out" matched neither test, returned "", and
  // all eleven consumers silently skipped the row - the shares stayed in the source account
  // AND arrived in the destination, with nothing raised anywhere.
  if (XFER_OUT_RE.test(t)) return "SELL";
  if (XFER_IN_RE.test(t)) return "BUY";
  if (/SELL|SALE|BUY\s*-?\s*BACK|BUYBACK|REDEEM|REDEM/.test(t)) return "SELL";
  if (/BUY|BONUS|SPLIT|IPO|RIGHT|PURCHASE|ALLOT|SUBSCRIB|PAID/.test(t)) return "BUY";
  return "";
}

/**
 * True for EXACTLY the labels `ledgerSide` recognised as a transfer - deliberately not a
 * loose /transfer/i test. An ambiguous "Transfer Sale" stays a plain taxable sale rather
 * than silently escaping capital gains, and the two functions can never disagree about
 * which rows are transfers.
 */
export const isTransferType = (type: string | null | undefined): boolean => {
  const t = (type || "").toUpperCase();
  return XFER_OUT_RE.test(t) || XFER_IN_RE.test(t);
};

/** True for the OUT leg specifically (shares leaving this portfolio). */
export const isTransferOut = (type: string | null | undefined): boolean =>
  XFER_OUT_RE.test((type || "").toUpperCase());

/** True for the ₹0 free-share corporate actions (bonus / split). */
export const isFreeShareType = (type: string): boolean => /BONUS|SPLIT/i.test(type || "");

/** True for a Split specifically — the engines RESCALE held lots for it (keeping their
 *  acquisition dates), rather than adding ₹0 shares like a Bonus. */
export const isSplitType = (type: string): boolean => /SPLIT/i.test(type || "");

/** Map a sheet header cell to a canonical record key (""/none if unrecognised).
 *  Composite "Total …" columns are matched before the single-charge columns
 *  they contain ("incl STT" literally contains "stt"), so totals never land in
 *  the plain STT column. */
export function headerKey(header: string): string {
  const s = (header || "").toLowerCase().trim();
  if (/import id|import batch|batch id/.test(s)) return "importId";
  if (/trade date|^date$/.test(s)) return "date";
  if (/isin/.test(s)) return "isin";
  if (/stock name|security name|company|scrip name/.test(s)) return "name";
  if (/transaction type/.test(s)) return "txType";
  if (/number of shares|no\.? of shares|^shares$|quantity|qty/.test(s)) return "qty";
  if (/brokerage per share|brokerage\s*\/\s*sh/.test(s)) return "brokeragePerShare";
  if (/total brokerage|^brokerage$/.test(s)) return "brokerage";
  if (/avg\.? price|average price|^price$/.test(s)) return "price";
  if (/with expense.*incl/.test(s)) return "totalWithExpInclSTT";
  if (/with expense.*excl/.test(s)) return "totalWithExpExclSTT";
  if (/total expenses.*incl/.test(s)) return "totalExpInclSTT";
  if (/total expenses.*excl/.test(s)) return "totalExpExclSTT";
  if (/total amount.*turnover|^turnover$/.test(s)) return "turnover";
  if (/exchange turnover|exchange charges|turnover charges/.test(s)) return "exchangeCharges";
  if (/sebi/.test(s)) return "sebiFees";
  if (/ipf/.test(s)) return "ipf";
  if (/demat|dmat|dp charge/.test(s)) return "dmat";
  if (/igst|total gst|\bgst\b/.test(s)) return "gst";
  if (/stamp/.test(s)) return "stampDuty";
  if (/\bstt\b/.test(s)) return "stt";
  if (/trade class|trade type/.test(s)) return "tradeClass";
  if (/note|remark/.test(s)) return "notes";
  return "";
}

/**
 * Quantity / Price / Amount are three views of two facts — given any TWO, the third is
 * determined. `edited` is the field the user just typed; we keep the other populated field
 * and recompute the remaining one. Values are strings (straight from inputs) so this can be
 * wired directly to an onChange; untouched fields are returned unchanged.
 *
 * Precision follows the house rule: a RATE (price) keeps 6dp, MONEY (amount) sits at paise.
 */
export function solveQtyPriceAmount(
  edited: "qty" | "price" | "amount",
  qtyStr: string, priceStr: string, amountStr: string,
): { qty: string; price: string; amount: string } {
  const n = (s: string): number => { const v = parseFloat((s ?? "").toString().replace(/,/g, "").trim()); return isNaN(v) ? 0 : v; };
  const r = (v: number, d: number): string => String(Math.round(v * Math.pow(10, d)) / Math.pow(10, d));
  const q = n(qtyStr), p = n(priceStr), a = n(amountStr);
  const out = { qty: qtyStr, price: priceStr, amount: amountStr };
  if (edited === "qty" && q > 0) {
    if (p > 0) out.amount = r(q * p, 2);          // qty × price → amount
    else if (a > 0) out.price = r(a / q, 6);      // amount ÷ qty → price
  } else if (edited === "price" && p > 0) {
    if (q > 0) out.amount = r(q * p, 2);
    else if (a > 0) out.qty = r(a / p, 6);
  } else if (edited === "amount" && a > 0) {
    if (q > 0) out.price = r(a / q, 6);           // the user's case: amount + shares → price
    else if (p > 0) out.qty = r(a / p, 6);
  }
  return out;
}

/** Lay each record out as a row in the given header's column order. */
export function mapRecordsToHeader(header: string[], records: Record<string, any>[]): any[][] {
  return records.map((rec) => header.map((h) => { const k = headerKey(h); return k ? (rec[k] ?? "") : ""; }));
}

/**
 * Normalise a trade date to ISO `YYYY-MM-DD`, which Google Sheets parses as a
 * real date in every locale (so pivots can group by it). Accepts DD-MM-YYYY,
 * DD/MM/YYYY, DD-MMM-YYYY, or already-ISO input; returns the input unchanged if
 * it can't be parsed.
 */
export function toIsoDate(s: string): string {
  const c = (s || "").trim();
  if (!c) return c;
  let m = c.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = c.match(/^(\d{1,2})[\/\-]([A-Za-z]+)[\/\-](\d{4})$/);
  if (m) {
    const mo = new Date(Date.parse(`${m[2]} 1, 2000`)).getMonth();
    if (!isNaN(mo)) return `${m[3]}-${String(mo + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = c.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return c;
}
