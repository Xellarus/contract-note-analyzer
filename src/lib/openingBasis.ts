/**
 * Opening-basis reconstruction.
 *
 * The app computes FY26 capital gains by FIFO-replaying True Entry (FY26 trades). For
 * that to be correct, the FIFO queues must be seeded with the lots carried INTO FY26 —
 * with real acquisition dates (for LTCG/STCG) and real cost.
 *
 * ── Replace / one-shot (`reconstructOpeningLots`) — Holding-Period-Report model
 *    (user redesign 2026-07-21):
 *   • The **Holding Period Report** is the SOLE source of the written lots — each
 *     surviving lot's real date + qty + cost taken VERBATIM (already net of every
 *     rights/bonus/split/intraday event). No FIFO replay.
 *   • The **transaction statement** only (1) surfaces Bonus/Split/Rights rows, and
 *     (2) yields a net position (buy − sell) that CROSS-CHECKS the report's quantity.
 *   • A net position present in the txns but absent from the report → no lot + a flag.
 *   • Securities named "…Right Issue…" are dropped everywhere (`isRightIssueName`).
 *   • The 31-Mar holding statement is no longer used here.
 *
 * ── Batch / Add-batch (`accumulateOpeningLots` / `accumulateReportLots`) — UNCHANGED:
 *   for a history too large to import in one pass, feed it in chronological slices.
 *   Transaction slices still FIFO-replay (BUY adds a lot, SELL consumes oldest-first,
 *   BONUS/SPLIT/RIGHTS from `resolutions`); Holding-Period-Report slices append verbatim.
 *
 * This module is pure (no gapi) so it can be unit-tested in Node.
 */

// A lot acquired on/before this date is long-term as of 1-Apr-2025 (held ≥ 12 months).
// Used only for the display `longTerm` hint — the CG engine re-derives holding period
// from the real acqDate at sale time.
export const PRE_FY_DATE = "2024-03-31";
const LT_CUTOFF_TS = new Date(2024, 3, 1).getTime();   // 1-Apr-2024

export interface HoldingStatementRow {
  name: string;
  sector: string;
  qty: number;
  invested: number;   // AMOUNT INVESTED — total cost basis (0 ⇒ genuinely zero-cost holding)
}

export interface TxnStatementRow {
  dateStr: string;    // original dd-mm-yyyy
  iso: string;        // yyyy-mm-dd
  ts: number;         // epoch ms (0 if unparseable)
  type: string;       // BUY | SELL | BONUS | SPLIT | …
  name: string;
  qty: number;        // QTY column (may be 0 for bonus)
  price: number;
  amount: number;     // all-in amount (qty×price + brokerage)
  balQty: number;     // running per-scrip balance after this row
}

export interface OpeningLot {
  name: string;
  isin: string;         // filled when the name resolves against the scrip master ("" otherwise)
  acqDate: string;      // ISO yyyy-mm-dd
  qty: number;
  costPerShare: number;
  invested: number;     // qty × costPerShare
  longTerm: boolean;    // the pre-Apr-2024 block
  note: string;         // how this lot was derived (auditable)
}

/** One lot from a broker "holding period" report — lot-wise, with an ACCURATE all-in
 *  purchase amount (unlike the transaction statement, whose per-lot cost has an expenses
 *  gap). Used to OVERRIDE the replayed cost of long-term opening lots, matched by scrip + date. */
export interface HoldingPeriodLot { name: string; iso: string; ts: number; qty: number; costPerShare: number; invested: number; }

export interface ReconIssue { name: string; message: string; }

export type CorpActionKind = "BONUS" | "SPLIT" | "RIGHT";

/** A Bonus/Split/Rights row that needs the user to supply a ratio (and price for
 *  rights) before it can be replayed. `key` is stable across re-parses of the same
 *  upload, so a resolution keyed by it survives edits and re-imports. */
export interface PendingAction {
  key: string;
  name: string;        // display name (as it appears in the statement)
  type: CorpActionKind;
  dateStr: string;     // dd-mm-yyyy for display
  iso: string;
  heldBefore: number;  // qty held just before this row (from the running balance)
  balAfter: number;    // balance the statement shows after this row (0 if absent)
  suggestNum: number;  // prefilled ratio numerator (derived from the balance jump)
  suggestDen: number;  // prefilled ratio denominator
  suggestPrice: number; // prefilled price for rights (from the row's Price col, else 0)
}

/** User-supplied resolution for a pending action, keyed by PendingAction.key.
 *  num/den mean: BONUS/RIGHT → new shares = held × num/den; SPLIT → factor = num/den
 *  (num = post-split units, den = pre-split units). price only for RIGHT. */
export interface ActionResolution { num: number; den: number; price?: number; }

export interface ReconstructResult {
  lots: OpeningLot[];
  issues: ReconIssue[];
  sectors: { name: string; sector: string }[];
  pendingActions: PendingAction[];   // unresolved corp actions (empty ⇒ ready to write)
  summary: {
    holdings: number; lots: number;
    shortLots: number; longLots: number; zeroCost: number;
    buys: number; sells: number; corpActions: number;
    reconciled: number; mismatched: number; noTxn: number;
    costOverrides: number;   // lots sourced from the holding-period report
    missingFromReport?: number;   // scrips with a surviving net in the txns but absent from the HPR (no lot written)
  };
}

// ── CSV helpers ─────────────────────────────────────────────────────────────
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const hkey = (s: string) => (s || "").toUpperCase().replace(/[^A-Z]/g, "");
const parseNum = (s: any): number => {
  const t = (s ?? "").toString().replace(/,/g, "").trim();
  if (!t || /inf/i.test(t)) return NaN;
  const v = parseFloat(t);
  return isNaN(v) ? NaN : v;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
// Cost/share carries many decimals (e.g. ₹1075.574895); r6 only trims float noise,
// it does NOT round to paise — the basis stays full-precision for the FIFO seed.
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** dd-mm-yyyy (also dd/mm/yyyy) → { iso, ts }. */
function parseDmy(s: string): { iso: string; ts: number } {
  const c = (s || "").trim();
  const m = c.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    const d = m[1].padStart(2, "0"), mo = m[2].padStart(2, "0"), y = m[3];
    return { iso: `${y}-${mo}-${d}`, ts: new Date(parseInt(y), parseInt(mo) - 1, parseInt(d)).getTime() };
  }
  const iso = c.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return { iso: c, ts: new Date(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3])).getTime() };
  return { iso: c, ts: 0 };
}

// Match a name across the two statements (same broker → near-identical strings).
export const obKey = (name: string): string =>
  (name || "").toLowerCase().replace(/[.,()'"]/g, " ").replace(/\b(ltd|limited|the)\b/g, " ").replace(/\s+/g, " ").trim();

// Broker rights-entitlement placeholders — a temporary security named like "XYZ Right
// Issue Ltd" (or "Rights Issue") — are NOT real holdings. Skip them in every upload
// (user directive 2026-07-21). Matches "right issue" / "rights issue", any spacing/case.
export const isRightIssueName = (name: string): boolean => /rights?\s*issue/i.test(name || "");

// ── Parsers ──────────────────────────────────────────────────────────────────
/** Parse a 31-Mar holding / historical-valuation CSV. Header-driven (tolerant of
 *  a leading blank column and column order). */
export function parseHoldingStatement(text: string): HoldingStatementRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  let hi = -1, ci: { name: number; sector: number; qty: number; invested: number } | null = null;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const cells = splitCsvLine(lines[i]).map(hkey);
    const find = (...k: string[]) => cells.findIndex(c => k.some(x => c === x));
    const name = find("NAME", "SECURITY", "SCRIP", "STOCK", "COMPANY", "ASSETNAME");
    const invested = cells.findIndex(c => c.startsWith("AMOUNTINVESTED") || c === "INVESTED" || c === "INVESTEDVALUE" || c === "INVESTEDAMOUNT" || c === "COST");
    const qty = find("QTY", "QUANTITY", "SHARES", "BALQTY");
    if (name >= 0 && qty >= 0 && invested >= 0) {
      hi = i;
      ci = { name, sector: find("SECTOR", "INDUSTRY"), qty, invested };
      break;
    }
  }
  if (!ci || hi < 0) return [];
  const out: HoldingStatementRow[] = [];
  for (let i = hi + 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const name = (f[ci.name] || "").trim();
    const qty = parseNum(f[ci.qty]);
    if (!name || isRightIssueName(name) || isNaN(qty) || qty <= 0) continue;
    const inv = parseNum(f[ci.invested]);
    out.push({
      name,
      sector: ci.sector >= 0 ? (f[ci.sector] || "").trim() : "",
      qty,
      invested: isNaN(inv) ? 0 : inv,   // blank / "inf" ⇒ zero-cost holding
    });
  }
  return out;
}

/** Parse a FY transaction statement CSV. Header-driven. */
export function parseTransactionStatement(text: string): TxnStatementRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  let hi = -1, ci: { date: number; type: number; name: number; qty: number; price: number; amount: number; bal: number } | null = null;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const cells = splitCsvLine(lines[i]).map(hkey);
    const find = (...k: string[]) => cells.findIndex(c => k.some(x => c === x));
    const date = find("DATE", "TRADEDATE", "TRANSDATE");
    const type = find("TRANSTYPE", "TYPE", "TRANSACTIONTYPE", "TXNTYPE");
    const name = find("ASSETNAME", "NAME", "SECURITY", "SCRIP", "STOCK");
    if (date >= 0 && type >= 0 && name >= 0) {
      hi = i;
      ci = {
        date, type, name,
        qty: find("QTY", "QUANTITY", "SHARES"),
        price: find("PRICE", "RATE"),
        amount: find("AMOUNT", "VALUE", "NETAMOUNT"),
        bal: find("BALQTY", "BALANCE", "BALANCEQTY", "CLOSINGQTY"),
      };
      break;
    }
  }
  if (!ci || hi < 0) return [];
  const out: TxnStatementRow[] = [];
  for (let i = hi + 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const name = (f[ci.name] || "").trim();
    const type = (f[ci.type] || "").trim();
    if (!name || !type || isRightIssueName(name)) continue;
    const { iso, ts } = parseDmy(f[ci.date] || "");
    out.push({
      dateStr: (f[ci.date] || "").trim(), iso, ts, type, name,
      qty: ci.qty >= 0 ? (parseNum(f[ci.qty]) || 0) : 0,
      price: ci.price >= 0 ? (parseNum(f[ci.price]) || 0) : 0,
      amount: ci.amount >= 0 ? (parseNum(f[ci.amount]) || 0) : 0,
      balQty: ci.bal >= 0 ? (parseNum(f[ci.bal]) || 0) : 0,
    });
  }
  return out;
}

/** Parse a broker "holding period" report CSV — lot-wise: Company · Date · Qty ·
 *  Purchase Price · Purchase Amount (plus current-value columns we ignore). Header-driven,
 *  tolerant of a leading blank/index column. The all-in **Purchase Amount** is the accurate
 *  cost (incl. expenses); we prefer it over Purchase Price × qty. A ₹0 lot is a bonus lot. */
export function parseHoldingPeriodReport(text: string): HoldingPeriodLot[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  let hi = -1, ci: { name: number; date: number; qty: number; price: number; amt: number } | null = null;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const cells = splitCsvLine(lines[i]).map(hkey);
    const idxOf = (...keys: string[]) => cells.findIndex(c => keys.includes(c));
    const name = idxOf("COMPANYNAME", "COMPANY", "SECURITY", "SCRIP", "STOCK", "SCRIPNAME", "ASSETNAME");
    const date = idxOf("DATE", "PURCHASEDATE", "BUYDATE", "ACQDATE", "ACQUISITIONDATE");
    const qty = idxOf("QTY", "QUANTITY", "SHARES");
    const price = idxOf("PURCHASEPRICE", "BUYPRICE", "RATE", "AVGPRICE");
    const amt = idxOf("PURCHASEAMOUNT", "PURCHASEVALUE", "BUYAMOUNT", "COST", "COSTBASIS", "INVESTEDVALUE");
    if (name >= 0 && date >= 0 && qty >= 0 && (price >= 0 || amt >= 0)) { hi = i; ci = { name, date, qty, price, amt }; break; }
  }
  if (!ci || hi < 0) return [];
  const out: HoldingPeriodLot[] = [];
  for (let i = hi + 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const name = (f[ci.name] || "").trim();
    const qty = parseNum(f[ci.qty]);
    if (!name || isRightIssueName(name) || isNaN(qty) || qty <= 0) continue;
    const { iso, ts } = parseDmy(f[ci.date] || "");
    const amt = ci.amt >= 0 ? parseNum(f[ci.amt]) : NaN;
    const price = ci.price >= 0 ? parseNum(f[ci.price]) : NaN;
    // Prefer the all-in Purchase Amount (accurate); else Purchase Price × qty. ₹0 ⇒ bonus lot.
    let invested: number, costPerShare: number;
    if (!isNaN(amt)) { invested = amt; costPerShare = qty > 0 ? amt / qty : 0; }
    else if (!isNaN(price)) { costPerShare = price; invested = price * qty; }
    else continue;
    out.push({ name, iso, ts, qty, costPerShare, invested });
  }
  return out;
}

// ── Reconstruction ────────────────────────────────────────────────────────────
interface FifoLot { ts: number; iso: string; qty: number; cps: number; note: string; }

/** Bucket a raw transaction TYPE string into what the replay does with it. Order
 *  matters: BUYBACK contains "BUY", so the sell-like test must run before buy-like. */
export function classifyTxn(type: string): "BUY" | "SELL" | "BONUS" | "SPLIT" | "RIGHT" | "OTHER" {
  const t = (type || "").toUpperCase();
  if (/RIGHT/.test(t)) return "RIGHT";
  if (/BONUS/.test(t)) return "BONUS";
  if (/SPLIT|SUB-?DIV|SUBDIV|FACE\s*VALUE|CONSOLIDAT|STOCK\s*SPLIT/.test(t)) return "SPLIT";
  if (/SELL|SALE|BUY\s*-?\s*BACK|BUYBACK|REDEM|REDEEM|SOLD/.test(t)) return "SELL";
  if (/BUY|IPO|PURCHASE|ALLOT|SUBSCRIB|BOUGHT|CREDIT/.test(t)) return "BUY";
  return "OTHER";
}

// Corp-action resolution key. DATE-BASED (scrip#kind#iso) so it's stable and unique
// regardless of how the transaction history is sliced across batch imports. An
// occurrence-index key (scrip#kind#N) collides across date-sliced batches — a scrip's
// 2nd-ever bonus is "occurrence 0" within its own slice — and would silently inherit
// the wrong ratio. Real corp actions are never same-scrip · same-kind · same-day.
export const corpActionKey = (scripKey: string, kind: string, iso: string): string => `${scripKey}#${kind}#${iso}`;

// gcd on rounded ints, for turning a balance jump into a tidy prefill ratio.
const gcd = (a: number, b: number): number => { a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b)); while (b) { [a, b] = [b, a % b]; } return a || 1; };
function reduceRatio(n: number, d: number, fallbackNum = 1, fallbackDen = 1): { num: number; den: number } {
  if (!isFinite(n) || !isFinite(d) || d <= 0 || n <= 0) return { num: fallbackNum, den: fallbackDen };
  const ni = Math.round(n), di = Math.round(d);
  if (Math.abs(n - ni) < 1e-6 && Math.abs(d - di) < 1e-6) { const g = gcd(ni, di); return { num: ni / g, den: di / g }; }
  return { num: n, den: d };
}

/** Walk every scrip's rows and surface each Bonus/Split/Rights row as a PendingAction
 *  with a prefilled ratio derived from the running-balance jump (best-effort). */
function collectPendingActions(byName: Map<string, TxnStatementRow[]>): PendingAction[] {
  const out: PendingAction[] = [];
  for (const [scripKey, rowsRaw] of byName) {
    const rows = rowsRaw.slice().sort((a, b) => a.ts - b.ts);
    const hasBal = rows.some(r => r.balQty !== 0);
    let runQty = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const kind = classifyTxn(row.type);
      const heldBefore = hasBal ? (i > 0 ? rows[i - 1].balQty : 0) : runQty;
      if (kind === "BONUS" || kind === "SPLIT" || kind === "RIGHT") {
        const balAfter = hasBal ? row.balQty : 0;
        let suggest: { num: number; den: number };
        if (kind === "SPLIT") {
          suggest = (heldBefore > 0 && balAfter > heldBefore) ? reduceRatio(balAfter, heldBefore, 2, 1) : { num: 1, den: 1 };
        } else {
          const added = balAfter - heldBefore;
          suggest = (added > 0 && heldBefore > 0) ? reduceRatio(added, heldBefore) : { num: 1, den: 1 };
        }
        out.push({
          key: corpActionKey(scripKey, kind, row.iso), name: row.name, type: kind,
          dateStr: row.dateStr, iso: row.iso, heldBefore, balAfter,
          suggestNum: suggest.num, suggestDen: suggest.den, suggestPrice: row.price > 0 ? row.price : 0,
        });
      }
      if (kind === "BUY") runQty += row.qty;
      else if (kind === "SELL") runQty -= row.qty;
    }
  }
  return out;
}

/** Replay one scrip's full history into surviving FIFO lots. Assumes every corp
 *  action for this scrip has a resolution (caller guarantees it). */
function replayScrip(
  scripKey: string, rowsRaw: TxnStatementRow[], resolutions: Record<string, ActionResolution>,
  seed: FifoLot[] = [],
): { lots: FifoLot[]; buys: number; sells: number; oversold: number; unknown: string[] } {
  const rows = rowsRaw.slice().sort((a, b) => a.ts - b.ts);
  // Carried-in lots (batch accumulate) seed the queue oldest-first, so a SELL in this
  // slice consumes them before any BUY made in the slice — FIFO continues across the seam.
  const lots: FifoLot[] = seed.slice().sort((a, b) => a.ts - b.ts).map(l => ({ ...l }));
  const unknown = new Set<string>();
  let buys = 0, sells = 0, oversold = 0;

  const heldNow = () => lots.reduce((s, l) => s + l.qty, 0);

  for (const row of rows) {
    const kind = classifyTxn(row.type);
    if (kind === "BUY") {
      if (row.qty > 0) {
        const cps = row.amount > 0 ? row.amount / row.qty : row.price;   // all-in Amount preferred
        lots.push({ ts: row.ts, iso: row.iso, qty: row.qty, cps, note: `Buy (${row.iso})` });
        buys++;
      }
    } else if (kind === "SELL") {
      let need = Math.abs(row.qty); sells++;
      while (need > 1e-9 && lots.length) {
        const take = Math.min(lots[0].qty, need);
        lots[0].qty -= take; need -= take;
        if (lots[0].qty <= 1e-9) lots.shift();
      }
      if (need > 1e-9) oversold += need;
    } else if (kind === "BONUS" || kind === "RIGHT") {
      const res = resolutions[corpActionKey(scripKey, kind, row.iso)];
      if (res && res.den > 0) {
        const add = heldNow() * (res.num / res.den);
        if (add > 1e-9) {
          const cps = kind === "RIGHT" ? (res.price || 0) : 0;
          lots.push({ ts: row.ts, iso: row.iso, qty: add, cps, note: kind === "RIGHT" ? `Rights ${res.num}:${res.den} @ ₹${res.price || 0} (${row.iso})` : `Bonus ${res.num}:${res.den} (${row.iso})` });
        }
      }
    } else if (kind === "SPLIT") {
      const res = resolutions[corpActionKey(scripKey, kind, row.iso)];
      if (res && res.den > 0 && res.num > 0) {
        const f = res.num / res.den;
        for (const l of lots) { l.qty *= f; l.cps /= f; l.note += ` ·split ${res.num}:${res.den}`; }
      }
    } else {
      unknown.add(row.type);
    }
  }
  return { lots: lots.filter(l => l.qty > 1e-9), buys, sells, oversold, unknown: [...unknown] };
}

/** Net surviving quantity for one scrip from the transaction statement. Prefers the
 *  broker's running BAL QTY (already net of every buy/sell/bonus/rights/split); falls
 *  back to Σbuy − Σsell with resolved bonus/rights/split ratios applied when there's no
 *  balance column. Used purely to CROSS-CHECK the Holding Period Report — it never
 *  produces lots, so an unresolved corp action here only softens the check, it can't
 *  corrupt the written basis. */
export function netQtyFromTxns(
  rowsRaw: TxnStatementRow[], resolutions: Record<string, ActionResolution>, scripKey: string,
): number {
  const rows = rowsRaw.slice().sort((a, b) => a.ts - b.ts);
  const hasBal = rows.some(r => r.balQty !== 0);
  if (hasBal) return rows[rows.length - 1].balQty;   // broker's closing balance = net position
  let q = 0;
  for (const row of rows) {
    const kind = classifyTxn(row.type);
    if (kind === "BUY") q += row.qty;
    else if (kind === "SELL") q -= Math.abs(row.qty);
    else if (kind === "BONUS" || kind === "RIGHT") {
      const res = resolutions[corpActionKey(scripKey, kind, row.iso)];
      if (res && res.den > 0) q += q * (res.num / res.den);
    } else if (kind === "SPLIT") {
      const res = resolutions[corpActionKey(scripKey, kind, row.iso)];
      if (res && res.den > 0 && res.num > 0) q *= (res.num / res.den);
    }
  }
  return q;
}

/** One scrip's running position as reconstructed from the transaction statement, for the
 *  batch-wise verification display: `qty` is OUR additive computation (Σbuy − Σsell with each
 *  resolved bonus/rights/split applied in date order — this is what surfaces a missed corp
 *  action), and `brokerBal` is the broker's own running balance from the statement, if it has
 *  one, shown alongside as a reference. This is a CHECK aid only — it is not written into the
 *  FY26 lots (those come from the Holding Period Report). */
export interface TxnNetEntry { name: string; qty: number; brokerBal: number | null; }

/**
 * Advance the accumulated transaction position by ONE chronological slice. `prev` is the
 * running position carried in from earlier slices (its own persisted tab); this slice's rows
 * are applied ON TOP, per scrip, in date order. Scrips absent from this slice carry forward
 * unchanged. Slices must be chronological + non-overlapping (a SPLIT must only rescale shares
 * already held before it) — the caller warns on an out-of-order slice. Additive by design:
 * the broker's BAL QTY is captured as `brokerBal` for reference but NOT used as the computed
 * qty, so an unresolved bonus/split shows up as a computed-vs-broker gap the user can fix.
 * Pure (no gapi).
 */
export function advanceTxnNet(
  prev: Record<string, TxnNetEntry>,
  txns: TxnStatementRow[],
  resolutions: Record<string, ActionResolution> = {},
): Record<string, TxnNetEntry> {
  const out: Record<string, TxnNetEntry> = {};
  for (const k in prev) out[k] = { ...prev[k] };

  const byName = new Map<string, TxnStatementRow[]>();
  for (const t of txns) { const k = obKey(t.name); (byName.get(k) || byName.set(k, []).get(k)!).push(t); }

  for (const [k, rowsRaw] of byName) {
    const rows = rowsRaw.slice().sort((a, b) => a.ts - b.ts);
    let q = out[k]?.qty ?? 0;
    const name = out[k]?.name || rows[0].name;
    let brokerBal = out[k]?.brokerBal ?? null;
    for (const row of rows) {
      const kind = classifyTxn(row.type);
      if (kind === "BUY") q += row.qty;
      else if (kind === "SELL") q -= Math.abs(row.qty);
      else if (kind === "BONUS" || kind === "RIGHT") {
        const res = resolutions[corpActionKey(k, kind, row.iso)];
        if (res && res.den > 0) q += q * (res.num / res.den);
      } else if (kind === "SPLIT") {
        const res = resolutions[corpActionKey(k, kind, row.iso)];
        if (res && res.den > 0 && res.num > 0) q *= (res.num / res.den);
      }
    }
    // Broker's own running balance (latest chronological value in this slice), if present.
    if (rows.some(r => r.balQty !== 0)) brokerBal = rows[rows.length - 1].balQty;
    out[k] = { name, qty: r6(q), brokerBal };
  }
  return out;
}

/** One scrip's surviving position from the opening-basis transaction history, replayed to
 *  an as-of date (weighted-average cost). Used to SEED the Historical Holding Report so a
 *  pre-FY26 date shows what was actually held then (True Entry is FY26-only). */
export interface OpeningPosAsOf { name: string; qty: number; avgCost: number; }

/**
 * Replay the batch opening-basis transactions to a past date → each scrip's surviving
 * quantity + weighted-average cost as of `asOfTs`.
 *
 * QUANTITY comes from the broker's own running **BAL QTY** when the statement carries it
 * (the last balance on/before the date) — it's exact, always whole, and already reflects the
 * ACTUAL rights subscribed / bonus / split, so it's immune to a wrong or fractional corp-action
 * ratio (e.g. a 1:15 rights on 500 held wrongly computing 533.33). Only when there's no balance
 * column does it fall back to the reconstructed net (buy − sell + resolved corp actions).
 *
 * COST/SHARE is the weighted average from replaying the rows: per scrip, per day, same-day
 * buys/sells net (intraday round-trip drops out — mirrors the FY26 engine's `squareOffIntraday`);
 * BONUS/RIGHT add held×ratio (₹0 / rights price), SPLIT rescales (qty ×f, cost ÷f), all from
 * `resolutions`. Rows dated after `asOfTs` are excluded; undated rows (ts ≤ 0) are always-held.
 * Keyed by `obKey(name)`; the caller maps that to the scrip-master key when seeding. Pure (no gapi).
 */
export function replayOpeningTxnsAsOf(
  txns: TxnStatementRow[],
  resolutions: Record<string, ActionResolution>,
  asOfTs: number,
): Record<string, OpeningPosAsOf> {
  const byName = new Map<string, TxnStatementRow[]>();
  for (const t of txns) {
    if (t.ts > asOfTs && t.ts > 0) continue;   // future row (undated ts≤0 is kept)
    const k = obKey(t.name);
    (byName.get(k) || byName.set(k, []).get(k)!).push(t);
  }

  const out: Record<string, OpeningPosAsOf> = {};
  for (const [k, rows] of byName) {
    const displayName = rows[0].name;
    // Net same-day buys/sells per day (intraday square-off); keep corp actions separate.
    interface Ev { ts: number; ord: number; kind: string; qty: number; price: number; iso: string; }
    const dayMap = new Map<number, { buyQ: number; buyV: number; sellQ: number }>();
    const corp: Ev[] = [];
    for (const t of rows) {
      const kind = classifyTxn(t.type);
      if (kind === "BUY") {
        const d = dayMap.get(t.ts) || { buyQ: 0, buyV: 0, sellQ: 0 };
        d.buyQ += t.qty; d.buyV += t.amount > 0 ? t.amount : t.qty * t.price; dayMap.set(t.ts, d);
      } else if (kind === "SELL") {
        const d = dayMap.get(t.ts) || { buyQ: 0, buyV: 0, sellQ: 0 };
        d.sellQ += Math.abs(t.qty); dayMap.set(t.ts, d);
      } else if (kind === "BONUS" || kind === "RIGHT" || kind === "SPLIT") {
        corp.push({ ts: t.ts, ord: 1, kind, qty: 0, price: 0, iso: t.iso });
      }
    }
    const evs: Ev[] = [...corp];
    for (const [ts, d] of dayMap) {
      const net = d.buyQ - d.sellQ;
      if (net > 1e-9) evs.push({ ts, ord: 0, kind: "BUY", qty: net, price: d.buyQ > 0 ? d.buyV / d.buyQ : 0, iso: "" });
      else if (net < -1e-9) evs.push({ ts, ord: 2, kind: "SELL", qty: -net, price: 0, iso: "" });
      // net 0 → fully squared off intraday
    }
    // Same-day order: buy → corp action → sell.
    evs.sort((a, b) => (a.ts - b.ts) || (a.ord - b.ord));

    let qty = 0, avg = 0;
    for (const e of evs) {
      if (e.kind === "BUY") { const nq = qty + e.qty; avg = nq > 0 ? (qty < 0 ? e.price : (qty * avg + e.qty * e.price) / nq) : 0; qty = nq; }
      else if (e.kind === "SELL") { qty -= e.qty; if (qty <= 1e-9) avg = 0; }
      else if (e.kind === "SPLIT") { const r = resolutions[corpActionKey(k, "SPLIT", e.iso)]; if (r && r.den > 0 && r.num > 0 && qty > 1e-9) { const c = qty * avg; qty *= r.num / r.den; avg = qty > 0 ? c / qty : 0; } }
      else if (e.kind === "BONUS") { const r = resolutions[corpActionKey(k, "BONUS", e.iso)]; if (r && r.den > 0) { const add = qty * (r.num / r.den); if (add > 1e-9) { const c = qty * avg; qty += add; avg = qty > 0 ? c / qty : 0; } } }
      else if (e.kind === "RIGHT") { const r = resolutions[corpActionKey(k, "RIGHT", e.iso)]; if (r && r.den > 0) { const add = qty * (r.num / r.den); if (add > 1e-9) { const nq = qty + add; avg = nq > 0 ? (qty * avg + add * (r.price || 0)) / nq : 0; qty = nq; } } }
    }
    // Prefer the broker's running balance for QUANTITY (authoritative, whole, immune to a bad
    // corp-action ratio); keep the replay's weighted-average cost/share. Rows are already ≤ asOfTs.
    let finalQty = qty;
    const sorted = rows.slice().sort((a, b) => a.ts - b.ts);
    if (sorted.some(r => r.balQty !== 0)) finalQty = sorted[sorted.length - 1].balQty;
    if (finalQty > 1e-9) out[k] = { name: displayName, qty: r6(finalQty), avgCost: r6(avg) };
  }
  return out;
}

/**
 * Reconstruct dated opening lots as of 1-Apr-2025 — **Holding-Period-Report model**
 * (user redesign 2026-07-21).
 *
 *   • The **Holding Period Report** (`hpLots`) is the SOLE source of the written lots:
 *     each surviving lot's real acq date + qty + cost/share is taken VERBATIM. It's the
 *     broker's authoritative position, already net of every rights/bonus/split/intraday
 *     event, so there is no FIFO replay.
 *   • The **transaction statement** (`txns`) does two things, "from one arrow":
 *       1. surfaces Bonus / Split / Rights rows (so the user can see them, and so the net
 *          cross-check is exact when the statement has no running-balance column), and
 *       2. gives an independent net position (buy − sell, incl. those corp actions) that
 *          is CROSS-CHECKED against the HPR quantity — e.g. buy 12,000 − sell 7,000 = 5,000
 *          must equal the report's 5,000. A mismatch is flagged; the report still wins.
 *   • A scrip with a surviving net in the transactions but **absent from the HPR** has no
 *     cost source, so no lot is written and it's flagged (value comes only from the HPR).
 *   • Securities whose name contains "Right Issue" are dropped upstream (see `isRightIssueName`).
 *
 * The 31-Mar holding statement is no longer part of this flow. Corp actions never block the
 * write here (the lots come from the HPR regardless); resolving them only sharpens the check.
 */
export function reconstructOpeningLots(
  txns: TxnStatementRow[],
  hpLots: HoldingPeriodLot[],
  resolutions: Record<string, ActionResolution> = {},
): ReconstructResult {
  // Transactions grouped per scrip — for corp-action detection + the net cross-check.
  const byName = new Map<string, TxnStatementRow[]>();
  for (const t of txns) {
    const k = obKey(t.name);
    (byName.get(k) || byName.set(k, []).get(k)!).push(t);
  }

  // Holding-period report → the broker's AUTHORITATIVE lot-wise surviving position
  // (real acq date + qty + cost). The ONLY source of the written opening lots.
  const hpByScrip = new Map<string, HoldingPeriodLot[]>();
  for (const hp of hpLots) {
    if (!(hp.qty > 0)) continue;
    const k = obKey(hp.name);
    (hpByScrip.get(k) || hpByScrip.set(k, []).get(k)!).push(hp);
  }

  // Surface corp actions for display + to make the net cross-check exact on balance-less
  // statements. They do NOT drive the lots, so they never block the write.
  const pendingActions = collectPendingActions(byName);

  const lots: OpeningLot[] = [];
  const issues: ReconIssue[] = [];
  let shortLots = 0, longLots = 0, zeroCost = 0;
  let reconciled = 0, mismatched = 0, noTxn = 0, costOverrides = 0, missingFromReport = 0;

  // Emit the report's lots verbatim. Its DATE is the real acquisition date — the CG engine
  // re-derives the holding period from it at sale time.
  const emitReport = (displayName: string, repLots: HoldingPeriodLot[]): number => {
    let qty = 0;
    for (const rl of repLots) {
      if (!(rl.qty > 0)) continue;
      const ts = rl.ts > 0 ? rl.ts : 0;
      const iso = ts > 0 ? rl.iso : PRE_FY_DATE;
      const longTerm = ts > 0 ? ts < LT_CUTOFF_TS : true;
      const cps = r6(rl.costPerShare);
      if (cps === 0) zeroCost++;
      longTerm ? longLots++ : shortLots++;
      const lotInv = r2(rl.qty * cps);
      qty += rl.qty; costOverrides++;
      lots.push({ name: displayName, isin: "", acqDate: iso, qty: r6(rl.qty), costPerShare: cps, invested: lotInv, longTerm, note: "cost & lot from holding-period report" });
    }
    return qty;
  };

  // 1. Every scrip the HPR covers → emit its lots, then cross-check qty against the txn net.
  for (const [key, repLots] of hpByScrip) {
    const displayName = repLots[0].name;
    const survQty = emitReport(displayName, repLots);
    const rows = byName.get(key);
    if (rows && rows.length) {
      const net = netQtyFromTxns(rows, resolutions, key);
      if (Math.abs(net - survQty) > 0.001) {
        mismatched++;
        issues.push({ name: displayName, message: `transaction net (buy − sell) is ${fmt(net)} sh but the Holding Period Report shows ${fmt(survQty)} (Δ ${fmt(net - survQty)}). Using the report's lots — check the transactions or a bonus/split/rights entry.` });
      } else {
        reconciled++;
      }
    } else {
      noTxn++;
      issues.push({ name: displayName, message: `in the Holding Period Report (${fmt(survQty)} sh) but no transactions found to cross-check — using the report's lots as-is.` });
    }
  }

  // 2. Scrips with a surviving net in the transactions but NOT in the HPR → no cost
  //    source, so skip + flag (value only ever comes from the report).
  for (const [key, rows] of byName) {
    if (hpByScrip.has(key)) continue;
    const net = netQtyFromTxns(rows, resolutions, key);
    if (net > 0.001) {
      missingFromReport++;
      issues.push({ name: rows[0].name, message: `net ${fmt(net)} sh in the transaction statement but not in the Holding Period Report — no opening lot written. Add it to the report.` });
    }
  }

  return {
    lots, issues, sectors: [], pendingActions,
    summary: {
      holdings: hpByScrip.size, lots: lots.length, shortLots, longLots, zeroCost,
      buys: 0, sells: 0, corpActions: pendingActions.length, reconciled, mismatched, noTxn, costOverrides, missingFromReport,
    },
  };
}

/** A carried-in opening lot (the current Opening Holdings row) used to seed a batch. */
export interface SeedLot { name: string; isin: string; acqDate: string; qty: number; costPerShare: number; note?: string; }

/**
 * BATCH (date-sliced) accumulate. For an account whose inception→31-Mar-2025 history
 * is too large to import in one pass, the history is fed in chronological, non-overlapping
 * slices. Each call:
 *   1. seeds every scrip's FIFO from the running position (`prevLots` = current Opening
 *      Holdings — the exact surviving lots left by the previous slice),
 *   2. replays ONLY this slice's transactions on top (BUY adds, SELL consumes oldest-first
 *      — i.e. the carried-in lots first; BONUS/SPLIT/RIGHT from `resolutions`), and
 *   3. re-emits the WHOLE position (touched + untouched scrips) so the result can safely
 *      OVERWRITE the tab — untouched scrips pass through unchanged; a scrip fully sold in
 *      this slice drops out.
 *
 * A split/bonus in a later slice correctly rescales lots bought in an earlier slice,
 * because those lots are seeded back in first. Slices MUST be chronological and
 * non-overlapping (the caller enforces this with the processed-through guard).
 *
 * Names in `prevLots` and `txns` must already be resolved to the SAME canonical form
 * (the caller maps both through the scrip master) so a scrip's FIFO continues across the
 * seam instead of forking into a new entry. `holdings` is optional — supply the 31-Mar
 * statement only on the FINAL slice to reconcile the finished position + capture sectors.
 * Pure (no gapi).
 */
export function accumulateOpeningLots(
  prevLots: SeedLot[],
  txns: TxnStatementRow[],
  resolutions: Record<string, ActionResolution> = {},
  holdings: HoldingStatementRow[] = [],
): ReconstructResult {
  const byName = new Map<string, TxnStatementRow[]>();
  for (const t of txns) { const k = obKey(t.name); (byName.get(k) || byName.set(k, []).get(k)!).push(t); }

  // Carried-in running position → FIFO seed lots per scrip.
  const seedByScrip = new Map<string, FifoLot[]>();
  const seedName = new Map<string, string>();
  for (const l of prevLots) {
    if (!(l.qty > 0)) continue;
    const k = obKey(l.name);
    const { iso, ts } = parseDmy(l.acqDate);
    (seedByScrip.get(k) || seedByScrip.set(k, []).get(k)!).push({ ts, iso: iso || l.acqDate, qty: l.qty, cps: l.costPerShare, note: l.note || `Opening (${iso || l.acqDate})` });
    if (!seedName.has(k)) seedName.set(k, l.name);
  }

  const sectors: { name: string; sector: string }[] = [];
  for (const h of holdings) if (h.sector) sectors.push({ name: h.name, sector: h.sector });

  const pendingActions = collectPendingActions(byName);
  const unresolved = pendingActions.filter(a => !resolutions[a.key]);

  const lots: OpeningLot[] = [];
  const issues: ReconIssue[] = [];
  let shortLots = 0, longLots = 0, zeroCost = 0, buys = 0, sells = 0;
  let reconciled = 0, mismatched = 0, noTxn = 0;

  // Don't emit anything until every corp action in this slice has a ratio (a missed
  // split/bonus corrupts everything after it). The write is blocked meanwhile, so the
  // existing Opening Holdings on the sheet is left untouched.
  if (unresolved.length > 0) {
    return {
      lots, issues, sectors, pendingActions,
      summary: { holdings: holdings.length, lots: 0, shortLots, longLots, zeroCost, buys, sells, corpActions: pendingActions.length, reconciled, mismatched, noTxn, costOverrides: 0 },
    };
  }

  const survByScrip = new Map<string, { qty: number; inv: number }>();
  const emit = (key: string, displayName: string, fifo: FifoLot[]): void => {
    let q = 0, inv = 0;
    for (const l of fifo) {
      const ts = l.ts > 0 ? l.ts : 0;
      const iso = ts > 0 ? l.iso : PRE_FY_DATE;
      const longTerm = ts > 0 ? ts < LT_CUTOFF_TS : true;
      const cps = r6(l.cps);
      if (cps === 0) zeroCost++;
      longTerm ? longLots++ : shortLots++;
      const lotInv = r2(l.qty * cps);
      q += l.qty; inv += lotInv;
      lots.push({ name: displayName, isin: "", acqDate: iso, qty: r6(l.qty), costPerShare: cps, invested: lotInv, longTerm, note: l.note });
    }
    survByScrip.set(key, { qty: q, inv });
  };

  // Every scrip that has a carried-in position OR new activity this slice.
  const keys = new Set<string>([...seedByScrip.keys(), ...byName.keys()]);
  for (const key of keys) {
    const seed = seedByScrip.get(key) || [];
    const rows = byName.get(key);
    const name = (rows && rows[0].name) || seedName.get(key) || key;
    if (rows && rows.length) {
      const rep = replayScrip(key, rows, resolutions, seed);
      buys += rep.buys; sells += rep.sells;
      emit(key, name, rep.lots);
      if (rep.oversold > 1e-6) issues.push({ name, message: `sells exceed the carried-in + bought quantity by ${round0(rep.oversold)} sh — check the previous slice ended exactly where this one begins.` });
      if (rep.unknown.length) issues.push({ name, message: `unrecognised transaction type(s): ${rep.unknown.join(", ")} — ignored.` });
    } else {
      emit(key, name, seed);   // no activity this slice → carry the position forward unchanged
    }
  }

  // Final-slice reconciliation against the 31-Mar-2025 holding statement (optional).
  if (holdings.length) {
    for (const h of holdings) {
      const key = obKey(h.name);
      const surv = survByScrip.get(key);
      if (!surv || surv.qty <= 0.001) { noTxn++; issues.push({ name: h.name, message: `nothing carried in and no transactions across the slices — no opening lot created. Include its history in one of the slices.` }); continue; }
      if (Math.abs(surv.qty - h.qty) > 0.001) {
        mismatched++;
        issues.push({ name: h.name, message: `qty mismatch — running position ${fmt(surv.qty)} vs holding ${fmt(h.qty)} (Δ ${fmt(surv.qty - h.qty)}). Check a slice boundary or a bonus/split/rights ratio.` });
      } else {
        reconciled++;
        if (h.invested > 0 && Math.abs(surv.inv - h.invested) > Math.max(1, 0.005 * h.invested)) {
          issues.push({ name: h.name, message: `qty ties out; value ₹${fmt(r2(surv.inv))} vs holding ₹${fmt(h.invested)} — brokerage/charges convention.` });
        }
      }
    }
  }

  return {
    lots, issues, sectors, pendingActions,
    summary: {
      holdings: holdings.length, lots: lots.length, shortLots, longLots, zeroCost,
      buys, sells, corpActions: pendingActions.length, reconciled, mismatched, noTxn, costOverrides: 0,
    },
  };
}

/**
 * BATCH accumulate from a **Holding Period Report** delivered in slices — the ONLY batch
 * lot source since the 2026-07-21 redesign (the transaction-FIFO batch path was retired
 * from the UI). HPR lots are the broker's AUTHORITATIVE surviving lots (real date + qty +
 * cost, already net of every rights/bonus/split/intraday event) — no FIFO, no seam, no
 * corp actions driving lots. Each slice APPENDS its lots to the running position
 * (`prevLots` = current Opening Holdings) and the whole union is re-emitted to overwrite
 * the tab.
 *
 * Deduped by an exact lot signature (scrip · date · qty · cost) so re-uploading a slice is
 * idempotent and an accidental cross-slice overlap can't double-count. (Trade-off: two
 * genuinely identical lots collapse to one — rare, and the final-slice txn cross-check
 * flags it as a qty shortfall.)
 *
 * `txns` is fed in the SAME batch-wise streak as the HPR — a transaction slice per HPR
 * slice. On EVERY slice it is scanned for Bonus / Split / Rights, which surface as
 * `pendingActions` (the resolve-ratio popup); resolutions persist + merge across slices so
 * a later slice never re-asks an earlier one's action. The buy−sell **net cross-check**
 * (each accumulated scrip's HPR qty vs its transaction net, plus a net-in-txns-but-not-in-
 * any-HPR-slice flag), however, only runs when `crossCheck` is true — the caller's "this is
 * my COMPLETE transaction statement" flag (typically ticked on the last slice). A PARTIAL
 * transaction slice would otherwise show false shortfalls against the full HPR total, so the
 * check waits for the whole statement. Names in `prevLots`/`hprLots`/`txns` must already be
 * canonicalized by the caller (scrip master). Pure (no gapi).
 */
export function accumulateReportLots(
  prevLots: SeedLot[],
  hprLots: HoldingPeriodLot[],
  txns: TxnStatementRow[] = [],
  resolutions: Record<string, ActionResolution> = {},
  crossCheck: boolean = false,
): ReconstructResult {
  const lots: OpeningLot[] = [];
  const issues: ReconIssue[] = [];
  let shortLots = 0, longLots = 0, zeroCost = 0, mismatched = 0, reconciled = 0, noTxn = 0, missingFromReport = 0;
  const seen = new Set<string>();
  const survByScrip = new Map<string, { qty: number; inv: number }>();
  const survName = new Map<string, string>();

  const add = (name: string, isin: string, iso: string, qty: number, cps: number, note: string): boolean => {
    if (!(qty > 0)) return false;
    const c = r6(cps);
    const s = `${obKey(name)}|${iso}|${r6(qty)}|${c}`;
    if (seen.has(s)) return false;
    seen.add(s);
    const ts = parseDmy(iso).ts;
    const longTerm = ts > 0 ? ts < LT_CUTOFF_TS : true;
    if (c === 0) zeroCost++;
    longTerm ? longLots++ : shortLots++;
    const inv = r2(qty * c);
    lots.push({ name, isin: isin || "", acqDate: iso, qty: r6(qty), costPerShare: c, invested: inv, longTerm, note });
    const k = obKey(name);
    if (!survName.has(k)) survName.set(k, name);
    const cur = survByScrip.get(k) || { qty: 0, inv: 0 };
    cur.qty += qty; cur.inv += inv; survByScrip.set(k, cur);
    return true;
  };

  // Carried-in running position first, so this slice's rows dedup against it.
  for (const l of prevLots) add(l.name, l.isin, l.acqDate, l.qty, l.costPerShare, l.note || "cost & lot from holding-period report");

  // This slice's HPR lots (verbatim; already net of corp actions).
  let dup = 0;
  for (const hp of hprLots) {
    const iso = hp.ts > 0 ? hp.iso : PRE_FY_DATE;
    if (!add(hp.name, "", iso, hp.qty, hp.costPerShare, "cost & lot from holding-period report")) dup++;
  }
  if (dup > 0) issues.push({ name: "—", message: `${dup} lot(s) in this slice were already in the running position — skipped (re-uploading a slice is safe).` });

  // Transactions → corp-action detection (EVERY slice) + the net cross-check (only when the
  // caller flags this as the COMPLETE statement — a partial slice can't be checked against
  // the full HPR total without false shortfalls).
  const byName = new Map<string, TxnStatementRow[]>();
  for (const t of txns) { const k = obKey(t.name); (byName.get(k) || byName.set(k, []).get(k)!).push(t); }
  const pendingActions = collectPendingActions(byName);

  if (txns.length && crossCheck) {
    // 1. Each accumulated HPR scrip vs its transaction net (buy − sell).
    for (const [k, surv] of survByScrip) {
      const displayName = survName.get(k) || k;
      const rows = byName.get(k);
      if (rows && rows.length) {
        const net = netQtyFromTxns(rows, resolutions, k);
        if (Math.abs(net - surv.qty) > 0.001) {
          mismatched++;
          issues.push({ name: displayName, message: `transaction net (buy − sell) is ${fmt(net)} sh but the Holding Period Report slices total ${fmt(surv.qty)} (Δ ${fmt(net - surv.qty)}). Using the report's lots — check a slice or a bonus/split/rights entry.` });
        } else {
          reconciled++;
        }
      } else {
        noTxn++;
        issues.push({ name: displayName, message: `in the Holding Period Report (${fmt(surv.qty)} sh) but no transactions found to cross-check.` });
      }
    }
    // 2. Net position in the txns but absent from every HPR slice → skip + flag.
    for (const [k, rows] of byName) {
      if (survByScrip.has(k)) continue;
      const net = netQtyFromTxns(rows, resolutions, k);
      if (net > 0.001) {
        missingFromReport++;
        issues.push({ name: rows[0].name, message: `net ${fmt(net)} sh in the transaction statement but not in any Holding Period Report slice — no opening lot. Add it to a slice.` });
      }
    }
  }

  return {
    lots, issues, sectors: [], pendingActions,
    summary: {
      holdings: survByScrip.size, lots: lots.length, shortLots, longLots, zeroCost,
      buys: 0, sells: 0, corpActions: pendingActions.length, reconciled, mismatched, noTxn, costOverrides: lots.length, missingFromReport,
    },
  };
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString("en-IN");
const round0 = (n: number) => Math.round(n).toLocaleString("en-IN");
