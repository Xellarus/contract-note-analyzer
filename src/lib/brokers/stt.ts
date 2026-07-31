// ── Securities Transaction Tax (STT) allocation ─────────────────────────────
// Shared by every contract-note parser (Integrated, Zerodha, Share India,
// Standard) so STT is booked identically across brokers.
//
// MODEL (2026-07 redesign — the note's PRINTED total STT is the anchor):
//   • Within each security the MATCHED quantity min(buyQty, sellQty) is treated
//     as INTRADAY (squared off same day); the excess |buyQty − sellQty| is
//     DELIVERY. So one security can be part-intraday and part-delivery.
//   • DELIVERY legs get the exact statutory 0.1% (both buy and sell sides).
//   • The INTRADAY POOL = note total − Σ(all delivery STT). It is apportioned
//     across the intraday securities PRO-RATA BY THEIR SQUARED-OFF TURNOVER, and
//     within each security split 50/50 between the buy leg and the sell leg.
//     (Real SEBI intraday STT is sell-side-only 0.025%; this deliberately books
//     half on each leg per the client's accounting convention.)
//   • Result: Σ(per-trade STT) === the note's printed total, to the paise — so a
//     note always reconciles and never trips the STT-mismatch warning.
//
// ETF / mutual-fund / liquid-bees rows are STT-exempt: they stay 0 and are
// excluded from both the delivery and the intraday pools.

export interface SttTradeInput {
  securityName: string;
  type: 'Buy' | 'Sell';
  quantity: number;
  price: number;
  exempt?: boolean;   // ETF / MF / liquid-bees → no STT, out of every pool
}

const DELIVERY_RATE = 0.001;      // 0.1% each side
const INTRADAY_SELL_RATE = 0.00025; // 0.025% (fallback only — when the note prints no STT total)
const paise = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Allocate the note's total STT across its trades.
 * @param trades  the note's trades, in the SAME order the caller will map over.
 * @param noteTotalStt  the STT total printed on the note (summary.stt); ≤0 ⇒ rate fallback.
 * @returns an STT amount per trade, aligned by index, summing to noteTotalStt.
 */
export function allocateStt(trades: SttTradeInput[], noteTotalStt: number): number[] {
  const n = trades.length;
  const out = new Array<number>(n).fill(0);
  if (n === 0) return out;

  const rowTo = (i: number) => Math.max(0, trades[i].quantity) * Math.max(0, trades[i].price);

  // Spread `amount` across the given trade indices, pro-rata by each row's turnover.
  const spread = (idxs: number[], amount: number) => {
    if (amount === 0 || idxs.length === 0) return;
    const tot = idxs.reduce((a, i) => a + rowTo(i), 0);
    if (tot <= 0) return;
    for (const i of idxs) out[i] += amount * (rowTo(i) / tot);
  };

  // Force Σ(rounded) === target by nudging the largest STT row by the drift.
  const tieOut = (target: number): number[] => {
    const r = out.map(paise);
    const drift = paise(target - r.reduce((a, b) => a + b, 0));
    if (Math.abs(drift) >= 0.01) {
      let mi = -1, mv = -Infinity;
      r.forEach((v, i) => { if (v > mv) { mv = v; mi = i; } });
      if (mi >= 0) r[mi] = paise(r[mi] + drift);
    }
    return r;
  };

  // ── Per-security tallies (equity only; exempt rows never carry STT) ──
  interface Sec { buyQty: number; sellQty: number; buyTo: number; sellTo: number; buyIdx: number[]; sellIdx: number[]; }
  const secs = new Map<string, Sec>();
  trades.forEach((t, i) => {
    if (t.exempt) return;   // out[i] stays 0
    const g = rowTo(i);
    let s = secs.get(t.securityName);
    if (!s) { s = { buyQty: 0, sellQty: 0, buyTo: 0, sellTo: 0, buyIdx: [], sellIdx: [] }; secs.set(t.securityName, s); }
    if (t.type === 'Buy') { s.buyQty += t.quantity; s.buyTo += g; s.buyIdx.push(i); }
    else { s.sellQty += t.quantity; s.sellTo += g; s.sellIdx.push(i); }
  });

  // Split each security into matched (intraday) / excess (delivery) turnover.
  interface Split { s: Sec; matchBuyTo: number; matchSellTo: number; delBuyTo: number; delSellTo: number; }
  const splits: Split[] = [];
  let totalDeliveryTo = 0, totalIntradayTo = 0;
  for (const s of secs.values()) {
    const matched = Math.min(s.buyQty, s.sellQty);
    const fB = s.buyQty > 0 ? matched / s.buyQty : 0;
    const fS = s.sellQty > 0 ? matched / s.sellQty : 0;
    const matchBuyTo = s.buyTo * fB;
    const matchSellTo = s.sellTo * fS;
    const delBuyTo = s.buyTo - matchBuyTo;
    const delSellTo = s.sellTo - matchSellTo;
    splits.push({ s, matchBuyTo, matchSellTo, delBuyTo, delSellTo });
    totalDeliveryTo += delBuyTo + delSellTo;
    totalIntradayTo += matchBuyTo + matchSellTo;
  }

  // Delivery equity STT is statutorily 0.1% per side, so a genuine note's printed total can
  // never be LESS than the delivery minimum. If the total reads implausibly low (a mis-parsed
  // or missing STT total on the note), DON'T anchor on it — that would scale the delivery legs
  // down to a bogus figure. Fall through to statutory rates instead (delivery at the exact
  // 0.1%). Seen on S713 Integrated notes where the printed STT total parsed as a few rupees,
  // making an ₹8 cr delivery sale show ₹83 STT instead of ₹81,023. The parser reading the total
  // correctly is the real fix; this just refuses to trust a total that's physically impossible.
  const statutoryDeliveryStt = totalDeliveryTo * DELIVERY_RATE;
  const hasTotal = noteTotalStt > 0.005 && noteTotalStt >= statutoryDeliveryStt * 0.5;
  const hasIntraday = totalIntradayTo > 0;
  const hasDelivery = totalDeliveryTo > 0;

  if (!hasIntraday && !hasDelivery) return out.map(paise);   // all-exempt / empty → zeros

  // ── Fallback: the note printed no STT total → statutory rates ──
  if (!hasTotal) {
    for (const sp of splits) {
      spread(sp.s.buyIdx, sp.delBuyTo * DELIVERY_RATE);
      spread(sp.s.sellIdx, sp.delSellTo * DELIVERY_RATE);
      const intra = sp.matchSellTo * INTRADAY_SELL_RATE;   // real intraday STT is sell-side only
      spread(sp.s.buyIdx, intra / 2);                      // …but booked half on each leg
      spread(sp.s.sellIdx, intra / 2);
    }
    return out.map(paise);
  }

  // ── Anchored on the note's printed total ──

  // Pure-delivery note → the entire total is delivery, spread by delivery turnover.
  if (!hasIntraday) {
    for (const sp of splits) {
      spread(sp.s.buyIdx, noteTotalStt * (sp.delBuyTo / totalDeliveryTo));
      spread(sp.s.sellIdx, noteTotalStt * (sp.delSellTo / totalDeliveryTo));
    }
    return tieOut(noteTotalStt);
  }

  const deliveryStt = hasDelivery ? totalDeliveryTo * DELIVERY_RATE : 0;
  const pool = noteTotalStt - deliveryStt;

  // Delivery alone exceeds the printed total (shouldn't happen with a real note):
  // scale delivery down to the total, book no intraday STT.
  if (pool < 0) {
    const scale = deliveryStt > 0 ? noteTotalStt / deliveryStt : 0;
    for (const sp of splits) {
      spread(sp.s.buyIdx, sp.delBuyTo * DELIVERY_RATE * scale);
      spread(sp.s.sellIdx, sp.delSellTo * DELIVERY_RATE * scale);
    }
    return tieOut(noteTotalStt);
  }

  // Delivery at the exact rate …
  for (const sp of splits) {
    spread(sp.s.buyIdx, sp.delBuyTo * DELIVERY_RATE);
    spread(sp.s.sellIdx, sp.delSellTo * DELIVERY_RATE);
  }
  // … then the leftover pool across intraday securities (pro-rata by squared-off
  // turnover), split 50/50 between each security's buy and sell legs.
  for (const sp of splits) {
    const w = sp.matchBuyTo + sp.matchSellTo;
    if (w <= 0) continue;
    const share = pool * (w / totalIntradayTo);
    spread(sp.s.buyIdx, share / 2);
    spread(sp.s.sellIdx, share / 2);
  }
  return tieOut(noteTotalStt);
}
