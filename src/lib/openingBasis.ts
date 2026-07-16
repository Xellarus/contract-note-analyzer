/**
 * Opening-basis reconstruction (transaction-history model).
 *
 * The app computes FY26 capital gains by FIFO-replaying True Entry (FY26 trades).
 * For that to be correct, the FIFO queues must be seeded with the lots carried
 * INTO FY26 — with real acquisition dates (for LTCG/STCG) and real cost.
 *
 * We rebuild those lots by **replaying the full transaction history from inception
 * up to 31-Mar-2025**, so every surviving lot keeps its ACTUAL buy date and ACTUAL
 * cost — no weighted-average blending or backing-out:
 *
 *   • BUY / IPO       → new lot (cost = the row's all-in Amount, date = trade date)
 *   • SELL / BUYBACK  → consume the OLDEST lots first (FIFO)
 *   • BONUS           → needs a ratio (user popup): adds held × N/M shares at ₹0
 *   • SPLIT           → needs a ratio (user popup): rescales every lot (qty ×f, cost/share ÷f)
 *   • RIGHTS          → needs ratio + price (user popup): adds held × N/M shares at that price
 *
 * Bonus/Split/Rights carry no reliable ratio in a plain statement, so they surface
 * as `pendingActions` for the user to fill in; once resolved they replay deterministically.
 *
 * The **31-Mar-2025 holding statement demotes to a checksum**: after the replay we
 * compare the surviving quantity (and value) per scrip against it and flag any
 * mismatch. It also still supplies SECTOR classifications for the Industries tab.
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
    costOverrides: number;   // long-term lots whose cost was overridden by the holding-period report
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
    if (!name || isNaN(qty) || qty <= 0) continue;
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
    if (!name || !type) continue;
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
    if (!name || isNaN(qty) || qty <= 0) continue;
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

/**
 * Reconstruct dated opening lots as of 1-Apr-2025.
 *
 * Two sources, per scrip:
 *   • If the **holding-period report** (`hpLots`) covers the scrip, its lots are taken
 *     VERBATIM (real acq date + qty + cost) — it's the broker's authoritative surviving
 *     position, already net of every rights/bonus/split/intraday event, so no replay is
 *     needed (and no corp-action prompts).
 *   • Otherwise the full transaction history is **replayed** (BUY/IPO/SELL/BUYBACK auto;
 *     BONUS/SPLIT/RIGHTS from `resolutions`), and whatever survives all the sells is kept.
 *
 * The 31-Mar holding statement is used only to reconcile the result. See the module header.
 * If any corp action for a *replayed* scrip is unresolved, `pendingActions` lists them and
 * `lots` is empty (a partial replay past an unknown split/bonus would be wrong).
 */
export function reconstructOpeningLots(
  holdings: HoldingStatementRow[],
  txns: TxnStatementRow[],
  resolutions: Record<string, ActionResolution> = {},
  hpLots: HoldingPeriodLot[] = [],
): ReconstructResult {
  const byName = new Map<string, TxnStatementRow[]>();
  for (const t of txns) {
    const k = obKey(t.name);
    (byName.get(k) || byName.set(k, []).get(k)!).push(t);
  }

  // Holding-period report → the broker's AUTHORITATIVE lot-wise surviving position as of
  // 31-Mar-2025 (real acq date + qty + cost, already net of rights/bonus/splits/intraday).
  // User directive 2026-07-13: for any scrip the report covers, take the opening lots
  // DIRECTLY from it and SKIP the fragile transaction replay — the replay can't reproduce
  // rights-entitlement sales or same-day churn (e.g. Skipper replayed 435 sh vs the true
  // 390). The replay is used only for scrips the report doesn't cover.
  const hpByScrip = new Map<string, HoldingPeriodLot[]>();
  for (const hp of hpLots) {
    if (!(hp.qty > 0)) continue;
    const k = obKey(hp.name);
    (hpByScrip.get(k) || hpByScrip.set(k, []).get(k)!).push(hp);
  }

  const sectors: { name: string; sector: string }[] = [];
  for (const h of holdings) if (h.sector) sectors.push({ name: h.name, sector: h.sector });

  // Corp actions only need resolving for scrips we actually REPLAY. A report-covered
  // scrip's lots already reflect its corp actions, so don't prompt for them.
  const pendingActions = collectPendingActions(byName).filter(a => !hpByScrip.has(obKey(a.name)));
  const unresolved = pendingActions.filter(a => !resolutions[a.key]);

  const lots: OpeningLot[] = [];
  const issues: ReconIssue[] = [];
  let shortLots = 0, longLots = 0, zeroCost = 0, buys = 0, sells = 0;
  let reconciled = 0, mismatched = 0, noTxn = 0, costOverrides = 0;   // costOverrides = lots sourced from the report

  // Don't replay until every (replayed-scrip) corp action has a ratio — a missed
  // split/bonus corrupts everything after it. Surface the pending list to prompt for them.
  if (unresolved.length > 0) {
    for (const h of holdings) { const k = obKey(h.name); if (!byName.has(k) && !hpByScrip.has(k)) noTxn++; }
    return {
      lots, issues, sectors, pendingActions,
      summary: { holdings: holdings.length, lots: 0, shortLots, longLots, zeroCost, buys, sells, corpActions: pendingActions.length, reconciled, mismatched, noTxn, costOverrides },
    };
  }

  // Emit replayed FIFO lots (for scrips NOT in the report). Returns the invested written.
  const emit = (displayName: string, fifo: FifoLot[]): number => {
    let emittedInv = 0;
    for (const l of fifo) {
      const ts = l.ts > 0 ? l.ts : 0;
      const iso = ts > 0 ? l.iso : PRE_FY_DATE;
      const longTerm = ts > 0 ? ts < LT_CUTOFF_TS : true;
      const cps = r6(l.cps);
      if (cps === 0) zeroCost++;
      longTerm ? longLots++ : shortLots++;
      const inv = r2(l.qty * cps);
      emittedInv += inv;
      lots.push({ name: displayName, isin: "", acqDate: iso, qty: r6(l.qty), costPerShare: cps, invested: inv, longTerm, note: l.note });
    }
    return emittedInv;
  };

  // Emit the report's lots verbatim (for scrips the report covers). Its DATE is the real
  // acquisition date — the CG engine re-derives the holding period from it at sale time.
  const emitReport = (displayName: string, repLots: HoldingPeriodLot[]): { qty: number; inv: number } => {
    let qty = 0, inv = 0;
    for (const rl of repLots) {
      if (!(rl.qty > 0)) continue;
      const ts = rl.ts > 0 ? rl.ts : 0;
      const iso = ts > 0 ? rl.iso : PRE_FY_DATE;
      const longTerm = ts > 0 ? ts < LT_CUTOFF_TS : true;
      const cps = r6(rl.costPerShare);
      if (cps === 0) zeroCost++;
      longTerm ? longLots++ : shortLots++;
      const lotInv = r2(rl.qty * cps);
      qty += rl.qty; inv += lotInv; costOverrides++;
      lots.push({ name: displayName, isin: "", acqDate: iso, qty: r6(rl.qty), costPerShare: cps, invested: lotInv, longTerm, note: "cost & lot from holding-period report" });
    }
    return { qty, inv };
  };

  const emitted = new Set<string>();

  // Scrips in the 31-Mar holding statement: report-authoritative if covered, else replay.
  for (const h of holdings) {
    const key = obKey(h.name);
    emitted.add(key);
    const repLots = hpByScrip.get(key);
    if (repLots && repLots.length) {
      const { qty: survQty, inv: survInv } = emitReport(h.name, repLots);
      if (Math.abs(survQty - h.qty) > 0.001) {
        mismatched++;
        issues.push({ name: h.name, message: `holding-period report shows ${fmt(survQty)} sh but the 31-Mar holding statement says ${fmt(h.qty)} (Δ ${fmt(survQty - h.qty)}). Using the report's lots — confirm the report is as-of 31-Mar-2025 and lists every lot.` });
      } else {
        reconciled++;
        if (h.invested > 0 && Math.abs(survInv - h.invested) > Math.max(1, 0.005 * h.invested)) {
          issues.push({ name: h.name, message: `qty ties out; report value ₹${fmt(r2(survInv))} vs holding ₹${fmt(h.invested)} — small charges/convention gap.` });
        }
      }
      continue;
    }
    const rows = byName.get(key);
    if (!rows) { noTxn++; issues.push({ name: h.name, message: `no transactions in the statement and not in the holding-period report — no opening lot created; add its history or include it in the report.` }); continue; }
    const rep = replayScrip(key, rows, resolutions);
    buys += rep.buys; sells += rep.sells;
    const survInv = emit(h.name, rep.lots);
    if (rep.oversold > 1e-6) issues.push({ name: h.name, message: `statement sells exceed buys by ${round0(rep.oversold)} sh — check for a missing opening/buy row.` });
    if (rep.unknown.length) issues.push({ name: h.name, message: `unrecognised transaction type(s): ${rep.unknown.join(", ")} — ignored.` });

    // Reconcile the replayed quantity + value against the 31-Mar holding statement.
    const survQty = rep.lots.reduce((s, l) => s + l.qty, 0);
    if (Math.abs(survQty - h.qty) > 0.001) {
      mismatched++;
      issues.push({ name: h.name, message: `qty mismatch — replayed ${fmt(survQty)} vs holding ${fmt(h.qty)} (Δ ${fmt(survQty - h.qty)}). Add this scrip to the Holding Period Report for an exact opening position, or check bonus/split/rights ratios.` });
    } else {
      reconciled++;
      if (h.invested > 0 && Math.abs(survInv - h.invested) > Math.max(1, 0.005 * h.invested)) {
        issues.push({ name: h.name, message: `qty ties out; value differs — opening ₹${fmt(r2(survInv))} vs holding ₹${fmt(h.invested)} (add the Holding Period Report for exact cost, or brokerage/charges convention).` });
      }
    }
  }

  // Scrips in the transactions but NOT in the holding statement — keep any replayed
  // survivors (txns are truth) but flag them; skip any already emitted or report-covered.
  for (const [key, rows] of byName) {
    if (emitted.has(key) || hpByScrip.has(key)) continue;
    const rep = replayScrip(key, rows, resolutions);
    buys += rep.buys; sells += rep.sells;
    const survQty = rep.lots.reduce((s, l) => s + l.qty, 0);
    if (survQty > 0.001) {
      emit(rows[0].name, rep.lots);
      issues.push({ name: rows[0].name, message: `replayed ${fmt(survQty)} sh held, but this scrip isn't in the 31-Mar holding statement — verify.` });
    }
  }

  // Scrips in the holding-period report but NOT in the holding statement (rare) — emit
  // the report's lots (authoritative) and flag for review.
  for (const [key, repLots] of hpByScrip) {
    if (emitted.has(key)) continue;
    emitted.add(key);
    const { qty: survQty } = emitReport(repLots[0].name, repLots);
    issues.push({ name: repLots[0].name, message: `in the holding-period report (${fmt(survQty)} sh) but not the 31-Mar holding statement — using the report's lots; verify.` });
  }

  return {
    lots, issues, sectors, pendingActions,
    summary: {
      holdings: holdings.length, lots: lots.length, shortLots, longLots, zeroCost,
      buys, sells, corpActions: pendingActions.length, reconciled, mismatched, noTxn, costOverrides,
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
 * BATCH accumulate from a **Holding Period Report** delivered in slices. Unlike the
 * transaction replay, HPR lots are the broker's AUTHORITATIVE surviving lots as of
 * 31-Mar-2025 (real date + qty + cost, already net of every rights/bonus/split/intraday
 * event) — so there's no FIFO, no seam, and no corp actions. Each slice simply APPENDS
 * its lots to the running position (`prevLots` = current Opening Holdings) and the whole
 * union is re-emitted to overwrite the tab.
 *
 * Deduped by an exact lot signature (scrip · date · qty · cost) so re-uploading a slice
 * is idempotent and an accidental cross-slice overlap can't double-count. (Trade-off: two
 * genuinely identical lots collapse to one — rare, and the final-slice reconciliation
 * against the 31-Mar holding statement flags it as a qty shortfall.)
 *
 * Names in `prevLots` and `hprLots` must already be canonicalized by the caller (scrip
 * master) so dedup + per-scrip reconciliation line up. `holdings` is supplied only on the
 * FINAL slice to reconcile the finished position + capture sectors. Pure (no gapi).
 */
export function accumulateReportLots(
  prevLots: SeedLot[],
  hprLots: HoldingPeriodLot[],
  holdings: HoldingStatementRow[] = [],
): ReconstructResult {
  const sectors: { name: string; sector: string }[] = [];
  for (const h of holdings) if (h.sector) sectors.push({ name: h.name, sector: h.sector });

  const lots: OpeningLot[] = [];
  const issues: ReconIssue[] = [];
  let shortLots = 0, longLots = 0, zeroCost = 0, mismatched = 0, reconciled = 0, noTxn = 0;
  const seen = new Set<string>();
  const survByScrip = new Map<string, { qty: number; inv: number }>();

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
    const k = obKey(name); const cur = survByScrip.get(k) || { qty: 0, inv: 0 };
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

  // Final-slice reconciliation against the 31-Mar-2025 holding statement (optional).
  if (holdings.length) {
    for (const h of holdings) {
      const k = obKey(h.name); const surv = survByScrip.get(k);
      if (!surv || surv.qty <= 0.001) { noTxn++; issues.push({ name: h.name, message: `not in any Holding Period Report slice yet — no opening lot created. Include it in a slice.` }); continue; }
      if (Math.abs(surv.qty - h.qty) > 0.001) {
        mismatched++;
        issues.push({ name: h.name, message: `qty mismatch — report lots ${fmt(surv.qty)} vs holding ${fmt(h.qty)} (Δ ${fmt(surv.qty - h.qty)}). A slice is missing lots, or a lot was duplicated/collapsed.` });
      } else {
        reconciled++;
        if (h.invested > 0 && Math.abs(surv.inv - h.invested) > Math.max(1, 0.005 * h.invested)) {
          issues.push({ name: h.name, message: `qty ties out; report value ₹${fmt(r2(surv.inv))} vs holding ₹${fmt(h.invested)} — brokerage/charges convention.` });
        }
      }
    }
  }

  return {
    lots, issues, sectors, pendingActions: [],
    summary: {
      holdings: holdings.length, lots: lots.length, shortLots, longLots, zeroCost,
      buys: 0, sells: 0, corpActions: 0, reconciled, mismatched, noTxn, costOverrides: lots.length,
    },
  };
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString("en-IN");
const round0 = (n: number) => Math.round(n).toLocaleString("en-IN");
