import { gapi } from "gapi-script";
import { loadScripMaster, lookupScrip, normName, SCRIP_MASTER_SPREADSHEET_ID } from "./scripMaster";
import { loadScripPrices, makePriceResolver } from "./scripPrices";

/**
 * Every open position across EVERY portfolio, folded into one row per security.
 *
 * `computeAum` walks the same Holding tabs but only ever returns per-portfolio totals, and
 * `computeHoldingsAsOf` is per-scrip but single-portfolio and a full FIFO replay. Neither
 * answers "what do we hold in total, and who holds it" — hence this.
 *
 * Securities are folded on the SCRIP-MASTER KEY, not the raw name, so the same company
 * spelled differently in two sheets ("GOODLUCK" vs "Goodluck India Ltd") lands on one row.
 * Same identity the replay engines group by.
 */

export interface CrossHoldingLot {
  portfolioId: string;
  code: string;
  label: string;
  qty: number;
  avgCost: number;
  invested: number;
  current: number;
}

export interface CrossHolding {
  key: string;          // scrip-master key (or ISIN / normalised name when unresolved)
  name: string;         // canonical name where the master knows it
  isin: string;
  qty: number;          // Σ across portfolios — CAN BE NEGATIVE, see below
  avgCost: number;      // Σ invested / Σ qty
  invested: number;
  cmp?: number;         // undefined ⇒ no imported price; `current` then falls back to cost
  current: number;
  priced: boolean;
  discrepancy: boolean; // a non-positive total quantity — a ledger error worth surfacing
  lots: CrossHoldingLot[];
}

export interface CrossHoldingsResult {
  rows: CrossHolding[];
  totalInvested: number;
  totalCurrent: number;
  priced: number;
  unpriced: number;
  failed: string[];     // portfolio labels whose Holding tab couldn't be read
}

export interface CrossHoldingsPortfolio { id: string; code: string; label: string; sheetId: string; }

const toN = (v: any): number => {
  const n = parseFloat((v ?? "").toString().replace(/,/g, "").trim());
  return isNaN(n) ? NaN : n;
};

/**
 * Read every portfolio's "Holding" tab (A=Name B=ISIN C=Qty D=Avg E=Invested, written by
 * `rebuildHoldingTab`) and aggregate.
 *
 * Two deliberate differences from `computeAum`:
 *   • NEGATIVE quantities are KEPT and flagged, not dropped. An oversold position is a data
 *     error the user needs to see — silently filtering it is how a broken ledger stays broken
 *     (see the DCM Shriram case). They contribute 0 invested so totals stay honest.
 *   • Sheets are read in PARALLEL rather than one after another; ten sequential round-trips
 *     is the slowest part of the dashboard. A portfolio that fails is reported in `failed`
 *     rather than silently contributing nothing.
 */
export async function computeCrossHoldings(portfolios: CrossHoldingsPortfolio[]): Promise<CrossHoldingsResult> {
  const master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID).catch(() => null);
  const prices = await loadScripPrices(SCRIP_MASTER_SPREADSHEET_ID).catch(() => []);
  const cmpOf = makePriceResolver(master, prices);

  // Same fold key `computeIndustryAllocation` uses: master key when resolvable, else ISIN,
  // else the normalised name.
  const foldKey = (isin: string, name: string): string => {
    if (master) { const e = lookupScrip(master, isin, name).entry; if (e) return e.key; }
    return (isin || "").trim().toUpperCase() || normName(name);
  };

  const reads = await Promise.all(portfolios.map(async (p) => {
    try {
      const res = await (gapi.client as any).sheets.spreadsheets.values.get({
        spreadsheetId: p.sheetId, range: "Holding!A:E",
      });
      return { p, rows: (res?.result?.values || []) as any[][], ok: true };
    } catch {
      return { p, rows: [] as any[][], ok: false };
    }
  }));

  const byKey = new Map<string, CrossHolding>();
  const failed: string[] = [];

  for (const { p, rows, ok } of reads) {
    if (!ok) { failed.push(p.label); continue; }
    for (let i = 1; i < rows.length; i++) {           // row 0 is the header
      const r = rows[i]; if (!r) continue;
      const name = (r[0] || "").toString().trim();
      if (!name || /^total/i.test(name)) continue;    // blank row, or the trailing Total row
      const isin = (r[1] || "").toString().trim();
      const qty = toN(r[2]);
      const avg = toN(r[3]);
      const investedCell = toN(r[4]);
      if (isNaN(qty) || qty === 0 || isNaN(avg)) continue;

      // A negative position has no meaningful cost — treat it as 0 so it can't drag the
      // totals, exactly as rebuildHoldingTab already writes it.
      const invested = qty > 0 ? (isNaN(investedCell) ? qty * avg : investedCell) : 0;
      const key = foldKey(isin, name);
      const e = master ? lookupScrip(master, isin, name).entry : null;

      let h = byKey.get(key);
      if (!h) {
        h = {
          key,
          name: e?.canonicalName || name,
          isin: isin || e?.isin || "",
          qty: 0, avgCost: 0, invested: 0, current: 0,
          priced: false, discrepancy: false, lots: [],
        };
        byKey.set(key, h);
      }
      if (!h.isin && isin) h.isin = isin;

      h.qty += qty;
      h.invested += invested;
      h.lots.push({
        portfolioId: p.id, code: p.code, label: p.label,
        qty, avgCost: qty > 0 ? invested / qty : 0, invested, current: 0,
      });
    }
  }

  let totalInvested = 0, totalCurrent = 0, priced = 0, unpriced = 0;
  const rows: CrossHolding[] = [];

  for (const h of byKey.values()) {
    const cmp = cmpOf(h.isin, h.name);
    h.cmp = cmp;
    h.priced = cmp !== undefined;
    h.discrepancy = h.qty <= 0;
    h.avgCost = h.qty > 0 ? h.invested / h.qty : 0;
    // Unpriced → hold at cost, matching what the AUM hero reports. A negative position is
    // worth nothing here; its quantity is the signal, not its valuation.
    const unit = cmp !== undefined ? cmp : h.avgCost;
    h.current = h.qty > 0 ? h.qty * unit : 0;
    for (const l of h.lots) l.current = l.qty > 0 ? l.qty * unit : 0;
    // Biggest holding within the security first, so the expansion reads top-down.
    h.lots.sort((a, b) => b.invested - a.invested || a.code.localeCompare(b.code));

    if (h.priced) priced++; else unpriced++;
    totalInvested += h.invested;
    totalCurrent += h.current;
    rows.push(h);
  }

  // Default order is alphabetical — the table's own default sort, and what makes the CSV
  // useful without any further work. `numeric` so "3M India" sorts naturally.
  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  return {
    rows,
    totalInvested: Math.round(totalInvested * 100) / 100,
    totalCurrent: Math.round(totalCurrent * 100) / 100,
    priced, unpriced, failed,
  };
}
