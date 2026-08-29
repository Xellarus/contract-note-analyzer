import { ContractNoteResult, Summary, Trade } from '../../types';
import { BrokerStrategy } from './types';
import { calculateReconciliation, extractIsin } from './utils';
import { allocateStt, SttTradeInput } from './stt';

/**
 * AXIS SECURITIES contract notes (PDF only).
 *
 * Axis delivers a "compiled" PDF: SEVERAL contract notes concatenated into one file,
 * each with its own Contract Note No, trade date and page numbering restarting at 1.
 * `parsePdfText` is handed the whole thing as a single string and must return ONE
 * `ContractNoteResult`, so the split happens HERE — every other broker is one note
 * per file. Each sub-note is parsed and RECONCILED INDEPENDENTLY against its own
 * printed totals; only then are they merged, with every Trade keeping its own
 * `tradeDate`. That matters because the Sheets writer groups by
 * `${t.tradeDate}_${securityName}_${transactionType}`, so per-trade dates are what
 * actually lands in the ledger — the note-level date is metadata only.
 *
 * ── The page as pdf.js hands it to us ──────────────────────────────────────────
 * Trade rows (one per line, columns separated by 2+ spaces):
 *
 *   1200000022581864   11:02:04   40400453   11:02:04   ORIENT ELECTRIC LIMITED-Cash- INE142Z01019   B   12   292.85   0.2342   293.08   3517.01
 *   └ order no          order tm   trade no    trade tm  └ security description        side qty gross  brok/unit net rate  net total
 *
 * NOTE the security description: the RENDERED pdf shows "…LIMITED-CashINE142Z01019"
 * with the ISIN glued on, but what the parser actually receives is "-Cash- INE…"
 * — hyphen, space, ISIN — because the cell wraps and the line-grouper rejoins it.
 * Fixtures must come from `tmp-extract.mjs` for exactly this reason.
 *
 * The Scrip Wise Summary prints the same description in TWO different shapes in the
 * same file: glued ("ADANI WILMAR LIMITED-Cash-INE699H01024  10000  0 …") and wrapped
 * (name alone on one line, the bare ISIN starting the next). Both are handled.
 *
 * ── Reconciliation anchor ──────────────────────────────────────────────────────
 * Σ(net total) ties EXACTLY to the printed "Sub Total BUY/SELL" on every note, and
 * Σ(qty × gross rate) ties exactly to the Scrip Wise Summary's gross. Brokerage is
 * ADDED on a buy and SUBTRACTED on a sell:
 *      buy:  netTotal = qty × (grossRate + brokeragePerUnit)
 *      sell: netTotal = qty × (grossRate − brokeragePerUnit)
 * That identity holds on 270 of 271 rows in the reference file; the one exception is
 * a 3-paise rounding error in Axis's OWN printout, which the Sub Total absorbs. So
 * the printed Sub Total is the anchor, never a recomputed sum.
 */

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

/**
 * "31-JUL-24" → "31/07/2024".
 *
 * The 4-DIGIT YEAR IS LOAD-BEARING. The ledger writer runs every date through
 * `toIsoDate` (tradeRowSchema.ts), whose `d-MON-yyyy` branch requires four digits —
 * a 2-digit year matches none of its branches and is returned UNCHANGED, which would
 * write the literal string "31-JUL-24" into the ledger's date column instead of an
 * ISO date. Dates are read back as serials, so that corrupts FIFO and capital gains
 * silently. The shared `getTradeDate` helper can't read this format at all (its regex
 * demands a numeric month), which is why Axis parses its own dates.
 */
const axisDate = (raw: string): string => {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})\s*$/.exec(raw || '');
  if (!m) return '';
  const mo = MONTHS[m[2].toUpperCase()];
  if (!mo) return '';
  const yy = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${m[1].padStart(2, '0')}/${mo}/${yy}`;
};

/**
 * Numeric cells on a levies row, in column order
 * (NCL-EQUITY | NCL NSE F&O | NCL BSE F&O | NCL CDX | Total (Net)).
 * A cell in PARENTHESES is negative — the note's own convention: "Positive Values
 * indicate Receivable by client. Negative Values indicate Payable by client."
 *
 * Deliberately NOT `parseNumber` from utils.ts. That helper prefixes "-" to the WHOLE
 * string the moment it sees a paren anywhere, and every Axis levies label contains
 * parens. Verified against the real implementation:
 *
 *   parseNumber('Taxable Value of Supply (Brokerage (`))- A (2343.98)')  →  0   (!!)
 *   parseNumber('NCL-EQUITY (5,432.10)')                                 →  0   (!!)
 *   parseNumber('Securities Transaction Tax(`) (2930.00) 0.00 0.00 …')   →  -2930 (truncated)
 *   parseNumber('Total (Net) 1,234.56')                                  →  -1234.56 (sign flipped by the LABEL)
 *
 * Tokenising first and parsing each cell alone avoids all of it — parseNumber handles
 * a bare '(2930.00)' correctly, it is only whole labelled lines that break it.
 * Requiring two decimals also keeps settlement numbers and quantities out.
 */
const CELL_RE = /\(\s*[\d,]+\.\d{2}\s*\)|[\d,]+\.\d{2}/g;
const cellValue = (tok: string): number => {
  const neg = tok.trim().startsWith('(');
  const n = parseFloat(tok.replace(/[(),\s]/g, ''));
  if (isNaN(n)) return 0;
  return neg ? -n : n;
};
const cells = (line: string): number[] => (line.match(CELL_RE) || []).map(cellValue);

/** The "Total (Net)" column — the last cell on a levies row. 0 when the row has none. */
const totalCell = (line: string): number => {
  const c = cells(line);
  return c.length ? c[c.length - 1] : 0;
};

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Split `total` across rows in proportion to `ratios`, tying out EXACTLY so the parts
 * sum to the printed total to the paise. Same contract as allocateStt: the note's own
 * printed figure is the anchor and the row data only decides the split.
 */
const allocate = (total: number, ratios: number[]): number[] => {
  const out = new Array<number>(ratios.length).fill(0);
  const sum = ratios.reduce((a, b) => a + b, 0);
  if (!total || sum <= 0) return out;
  let assigned = 0;
  let lastIdx = -1;
  ratios.forEach((r, i) => { if (r > 0) lastIdx = i; });
  for (let i = 0; i < ratios.length; i++) {
    if (ratios[i] <= 0 || i === lastIdx) continue;
    out[i] = r2(total * (ratios[i] / sum));
    assigned = r2(assigned + out[i]);
  }
  if (lastIdx >= 0) out[lastIdx] = r2(total - assigned);
  return out;
};

/** A single trade line off the grid. */
interface AxisRow {
  desc: string;
  isin: string;
  securityName: string;
  side: 'Buy' | 'Sell';
  quantity: number;
  grossRate: number;
  brokeragePerUnit: number;
  netTotal: number;
}

/** One scrip's line in the Scrip Wise Summary — used as an independent CHECK. */
interface ScripSummaryRow {
  isin: string;
  qtyBought: number;
  qtySold: number;
  grossTotal: number;
  brokerage: number;
  gst: number;
  stt: number;
  otherStatutory: number;
}

interface AxisNote {
  contractNoteNo: string;
  tradeDate: string;          // dd/mm/yyyy
  ucc: string;
  rows: AxisRow[];
  summary: Summary;
  subTotals: { side: 'Buy' | 'Sell'; quantity: number; amount: number }[];
  scripSummary: ScripSummaryRow[];
}

// Columns are joined with a SINGLE space by the line-grouper (`row.map(str).join(' ')`);
// the wider gaps in the raw page come from spaces inside the text items themselves. So
// separators are \s+, not \s{2,} — with the ISIN pulled onto its own line, the gap
// between the description and the side column is exactly one space.
const TRADE_RE =
  /^\s*(\d{10,})\s+(\d\d:\d\d:\d\d)\s+(\d+)\s+(\d\d:\d\d:\d\d)\s+(.+?)\s+([BS])\s+([\d,]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.,]+)\s*$/;

/** A line holding NOTHING but an ISIN — how the wrapped description's tail arrives.
 *  Anchored at both ends so the letterhead's "… NCDEX - INZ000161633" can never match. */
const BARE_ISIN_RE = /^\s*(IN[A-Z0-9]{9}[0-9])\s*$/;

const SUBTOTAL_RE = /^\s*Sub Total\s+(BUY|SELL)\s+([\d,]+)\s+([\d.,]+)\s*$/i;

/**
 * A Scrip Wise Summary detail row: a description followed by NINE numeric columns
 * (qty bought, qty sold, gross, avg rate, brokerage, GST, STT, other statutory, net).
 * Like the trade grid, the ISIN wraps onto the next line, so it is not matched here.
 */
const SUM_ROW_RE =
  /^\s*(\S.*?)\s+([\d,]+)\s+([\d,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+\(?([\d.,]+)\)?\s*$/;

const num = (s: string): number => {
  const n = parseFloat((s || '').replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
};

/**
 * "ORIENT ELECTRIC LIMITED-Cash- INE142Z01019" → "ORIENT ELECTRIC LIMITED".
 * Cuts at the "-Cash" marker Axis appends to every cash-segment description, then
 * trims the trailing hyphen/space the wrap leaves behind.
 */
const cleanName = (desc: string): string =>
  (desc || '')
    .replace(/-\s*Cash\s*-?.*$/i, '')
    .replace(/\s*-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Split the file into one block of lines per contract note. */
const splitNotes = (lines: string[]): string[][] => {
  const starts: number[] = [];
  lines.forEach((l, i) => { if (/Contract Note No\s+\S/.test(l)) starts.push(i); });
  if (starts.length === 0) return [];
  const blocks: string[][] = [];
  for (let i = 0; i < starts.length; i++) {
    blocks.push(lines.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : lines.length));
  }
  return blocks;
};

/** Read the per-segment levies table into a Summary. */
const parseLevies = (blk: string[]): Summary => {
  const s: Summary = {
    payinObligation: 0, stt: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, gst: 0,
    etc: 0, sebiFees: 0, clearingCharges: 0, stampDuty: 0, ipf: 0, netSettlement: 0,
  };

  /** Value on the row carrying `label`; if that row has no cells the label wrapped,
   *  so fall through to the next line ("Exchange Transaction Charges" does this). */
  const rowValue = (label: RegExp): number => {
    for (let i = 0; i < blk.length; i++) {
      if (!label.test(blk[i])) continue;
      const here = cells(blk[i]);
      if (here.length) return here[here.length - 1];
      for (let j = i + 1; j < Math.min(i + 3, blk.length); j++) {
        const nxt = cells(blk[j]);
        if (nxt.length) return nxt[nxt.length - 1];
      }
      return 0;
    }
    return 0;
  };

  /**
   * GST rows are three lines: a "Rate%**" row, then the tax's name ALONE on its own
   * line, then an "Amount(`)" row. Anchor on the bare label line and take the next
   * Amount row — reading the label's own line would pick up the RATE (9.00), not the
   * amount, which is a silent 9-rupee GST on every note.
   */
  const gstAmount = (name: string): number => {
    for (let i = 0; i < blk.length; i++) {
      if (blk[i].trim().replace(/\*/g, '') !== name) continue;
      for (let j = i + 1; j < Math.min(i + 4, blk.length); j++) {
        if (/^\s*Amount/.test(blk[j])) return totalCell(blk[j]);
      }
    }
    return 0;
  };

  // Charges are printed as negatives (payable); the ledger wants positive costs.
  s.payinObligation = Math.abs(rowValue(/Pay In\s*\/\s*Pay Out Obligation/i));
  s.taxableValue = Math.abs(rowValue(/Taxable Value of Supply\s*\(Brokerage/i));
  s.etc = Math.abs(rowValue(/Exchange Transaction Charges/i));
  s.sebiFees = Math.abs(rowValue(/SEBI Turnover Fees/i));
  s.stt = Math.abs(rowValue(/Securities Transaction Tax/i));
  s.stampDuty = Math.abs(rowValue(/^\s*Stamp Duty/i));
  s.cgst = Math.abs(gstAmount('CGST'));
  s.sgst = Math.abs(gstAmount('SGST'));
  s.igst = Math.abs(gstAmount('IGST'));
  // gst is either IGST or CGST+SGST — never all three summed. calculateReconciliation
  // counts only `gst`; the components ride along for the export columns.
  s.gst = r2(s.igst > 0 ? s.igst : s.cgst + s.sgst);
  // netSettlement keeps its SIGN: calculatedNet = (sells − buys) − charges is signed,
  // and the audit compares the two directly.
  s.netSettlement = rowValue(/Net Amount Receivable by Client/i);
  return s;
};

/** Scrip Wise Summary detail rows — an independent cross-check on the grid. */
const parseScripSummary = (blk: string[]): ScripSummaryRow[] => {
  const out: ScripSummaryRow[] = [];
  for (let i = 0; i < blk.length; i++) {
    const line = blk[i];
    // "Sub Total" and "TOTAL" carry the same column count as a detail row.
    if (/Sub Total|^\s*TOTAL\b/i.test(line)) continue;
    const m = SUM_ROW_RE.exec(line);
    if (!m) continue;
    let isin = extractIsin(m[1]);
    if (!isin) {
      const nxt = blk[i + 1];
      const bm = nxt ? BARE_ISIN_RE.exec(nxt) : null;
      if (bm) isin = bm[1].toUpperCase();
    }
    if (!isin) continue;          // without an identity the row cannot be cross-checked
    out.push({
      isin: isin.toUpperCase(),
      qtyBought: num(m[2]),
      qtySold: num(m[3]),
      grossTotal: num(m[4]),
      brokerage: num(m[6]),
      gst: num(m[7]),
      stt: num(m[8]),
      otherStatutory: num(m[9]),
    });
  }
  return out;
};

const parseOneNote = (blk: string[]): AxisNote | null => {
  const cnMatch = /Contract Note No\s+(\S+)/.exec(blk[0] || '');
  const contractNoteNo = cnMatch ? cnMatch[1] : '';

  let tradeDate = '';
  let ucc = '';
  for (const l of blk.slice(0, 40)) {
    if (!tradeDate) {
      const m = /Trade Date\s+(\d{1,2}-[A-Za-z]{3}-\d{2,4})/.exec(l);
      if (m) tradeDate = axisDate(m[1]);
    }
    if (!ucc) {
      const m = /Unique Client Code\s+(\S+)/.exec(l);
      if (m) ucc = m[1].trim();
    }
  }

  const rows: AxisRow[] = [];
  const subTotals: AxisNote['subTotals'] = [];
  for (let i = 0; i < blk.length; i++) {
    const l = blk[i];
    const m = TRADE_RE.exec(l);
    if (m) {
      const desc = m[5].trim();
      // extractIsin is applied to the DESCRIPTION CELL ONLY, never a whole line: the
      // Axis letterhead prints "SEBI Reg. No.: NSE,BSE,MCX,NCDEX - INZ000161633" on
      // every note, and INZ000161633 satisfies the ISIN pattern. A line-level scan
      // would harvest the broker's own registration number as a scrip.
      // The description WRAPS. The app's line-grouper clusters by Y and then sorts by
      // X, so the name stays on the trade row and the bare ISIN lands on the NEXT line
      // — 271 of 271 rows in the reference file. Fall back to the row itself in case a
      // short description ever fits on one line.
      let isin = extractIsin(desc);
      if (!isin) {
        const bm = BARE_ISIN_RE.exec(blk[i + 1] || '');
        if (bm) isin = bm[1].toUpperCase();
      }
      rows.push({
        desc,
        isin,
        securityName: cleanName(desc),
        side: m[6].toUpperCase() === 'B' ? 'Buy' : 'Sell',
        quantity: num(m[7]),
        grossRate: num(m[8]),
        brokeragePerUnit: num(m[9]),
        netTotal: num(m[11]),
      });
      continue;
    }
    const st = SUBTOTAL_RE.exec(l);
    if (st) {
      subTotals.push({
        side: st[1].toUpperCase() === 'BUY' ? 'Buy' : 'Sell',
        quantity: num(st[2]),
        amount: num(st[3]),
      });
    }
  }

  if (rows.length === 0) return null;

  return {
    contractNoteNo,
    tradeDate,
    ucc,
    rows,
    summary: parseLevies(blk),
    subTotals,
    scripSummary: parseScripSummary(blk),
  };
};

/** Build the Trade[] for ONE sub-note: one row per scrip+side, charges allocated. */
const buildTrades = (note: AxisNote, noteIdx: number): Trade[] => {
  const groups = new Map<string, AxisRow[]>();
  for (const r of note.rows) {
    if (!r.securityName || r.quantity <= 0 || r.grossRate <= 0) continue;
    const key = `${r.isin || r.securityName}||${r.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const merged = Array.from(groups.values()).map((items) => {
    const quantity = items.reduce((n, x) => n + x.quantity, 0);
    const turnover = items.reduce((n, x) => n + x.quantity * x.grossRate, 0);
    return {
      isin: items[0].isin,
      securityName: items[0].securityName,
      side: items[0].side,
      quantity,
      // Full precision. Rounding avgPrice to 2dp breaks the amount↔price round-trip.
      avgPrice: quantity > 0 ? turnover / quantity : 0,
      turnover,
      // Row-level brokerage drives only the SPLIT; the printed total is the anchor.
      brokerageRatio: items.reduce((n, x) => n + x.quantity * x.brokeragePerUnit, 0),
    };
  });
  if (merged.length === 0) return [];

  const turnoverRatios = merged.map((t) => t.turnover);
  const buyRatios = merged.map((t) => (t.side === 'Buy' ? t.turnover : 0));
  const brokRatios = merged.map((t) => t.brokerageRatio);

  const s = note.summary;
  const brokerageArr = allocate(s.taxableValue, brokRatios.some((v) => v > 0) ? brokRatios : turnoverRatios);
  const etcArr = allocate(s.etc, turnoverRatios);
  const sebiArr = allocate(s.sebiFees, turnoverRatios);
  const clearingArr = allocate(s.clearingCharges, turnoverRatios);
  const ipfArr = allocate(s.ipf, turnoverRatios);
  // Stamp duty is a BUYER-side levy — the note prints 0.00 on a sell-only note.
  const stampArr = allocate(s.stampDuty, buyRatios);
  const cgstArr = allocate(s.cgst, turnoverRatios);
  const sgstArr = allocate(s.sgst, turnoverRatios);
  const igstArr = allocate(s.igst, turnoverRatios);

  // Per-scrip buy/sell tallies decide Delivery vs Intraday, matching allocateStt's
  // model: the matched quantity within a scrip is the squared-off (intraday) part.
  const tally = new Map<string, { buy: number; sell: number }>();
  for (const t of merged) {
    const k = t.isin || t.securityName;
    const e = tally.get(k) || { buy: 0, sell: 0 };
    if (t.side === 'Buy') e.buy += t.quantity; else e.sell += t.quantity;
    tally.set(k, e);
  }

  const sttInput: SttTradeInput[] = merged.map((t) => ({
    securityName: t.isin || t.securityName,
    type: t.side,
    quantity: t.quantity,
    price: t.avgPrice,
  }));
  const sttArr = allocateStt(sttInput, s.stt);

  return merged.map((t, idx) => {
    const turnover = r2(t.turnover);
    const cgst = cgstArr[idx];
    const sgst = sgstArr[idx];
    const igst = igstArr[idx];
    const gst = r2(igst > 0 ? igst : cgst + sgst);
    const tl = tally.get(t.isin || t.securityName)!;
    const isIntraday = tl.buy > 0 && tl.sell > 0;

    const totalExclSTT = r2(
      brokerageArr[idx] + etcArr[idx] + sebiArr[idx] + clearingArr[idx] +
      stampArr[idx] + ipfArr[idx] + gst,
    );

    return {
      id: `tx-axis${noteIdx}-${idx}`,
      tradeDate: note.tradeDate,
      isin: t.isin,
      securityName: t.securityName,
      transactionType: t.side,
      quantity: t.quantity,
      avgPrice: t.avgPrice,
      turnover,
      tradeType: isIntraday ? 'Intraday' : 'Delivery',
      // The ONLY signed field: sell = cash in, buy = cash out.
      netTotalBeforeLevies: t.side === 'Sell' ? turnover : -turnover,
      brokerage: brokerageArr[idx],
      stt: sttArr[idx],
      etc: etcArr[idx],
      sebiFees: sebiArr[idx],
      clearingCharges: clearingArr[idx],
      stampDuty: stampArr[idx],
      ipf: ipfArr[idx],
      cgst,
      sgst,
      igst,
      gst,
      totalExpensesInclSTT: r2(totalExclSTT + sttArr[idx]),
      totalExpensesExclSTT: totalExclSTT,
    } as Trade;
  });
};

export class AxisBrokerStrategy implements BrokerStrategy {
  id = 'axis';
  name = 'axis';
  displayName = 'Axis Securities';

  /**
   * Signature must be the LETTERHEAD, never a bare "axis" — clients hold Axis Bank
   * shares and bank with Axis, so "axis" alone appears in other brokers' notes.
   */
  detect(content: string, _isPdf: boolean): boolean {
    const t = (content || '').toLowerCase();
    return (
      t.includes('axisdirect') ||
      t.includes('axis securities limited') ||
      t.includes('inz000161633')
    );
  }

  async parseHtml(_html: string): Promise<ContractNoteResult | null> {
    return null;   // Axis issues PDF notes only.
  }

  async parsePdfText(text: string): Promise<ContractNoteResult | null> {
    if (!text) return null;
    const lines = text.split('\n');
    const blocks = splitNotes(lines);
    if (blocks.length === 0) return null;

    const notes: AxisNote[] = [];
    for (const blk of blocks) {
      const n = parseOneNote(blk);
      if (n) notes.push(n);
    }
    if (notes.length === 0) {
      // A note whose only rows are derivatives parses to nothing here. Say so rather
      // than returning null, which the UI reports as an unreadable file.
      // Ask the note's OWN numbers, not its vocabulary: "NCL NSE F&O" is a column
      // header on every Axis note, so a text match here fired on a perfectly ordinary
      // equity note and reported a bogus F&O rejection instead of the real parse
      // failure. Columns 1 and 2 of the obligation row are the two F&O segments.
      const fno = blocks.some((blk) => {
        const row = blk.find((l) => /Pay In\s*\/\s*Pay Out Obligation/i.test(l));
        if (!row) return false;
        const c = cells(row);
        return (Math.abs(c[1] || 0) > 0.005) || (Math.abs(c[2] || 0) > 0.005);
      });
      if (fno) {
        throw new Error('This Axis contract note has no cash-segment trades (F&O is not supported).');
      }
      return null;
    }

    const summary: Summary = {
      payinObligation: 0, stt: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, gst: 0,
      etc: 0, sebiFees: 0, clearingCharges: 0, stampDuty: 0, ipf: 0, netSettlement: 0,
    };
    const trades: Trade[] = [];
    const failed: string[] = [];

    notes.forEach((n, i) => {
      const t = buildTrades(n, i);
      if (t.length === 0) return;

      // RECONCILE PER SUB-NOTE. A merged summary cannot be audited: payinObligation is
      // stored unsigned and accumulates additively, so five notes of mixed direction
      // give Σ|printed| ≫ |Σ signed| and the obligation check fails a CORRECT parse.
      const rec = calculateReconciliation(n.summary, t);
      const label = n.contractNoteNo || n.tradeDate || `#${i + 1}`;
      if (!rec.isValid) failed.push(label);

      // CROSS-CHECK against the Scrip Wise Summary, which Axis prints in a DIFFERENT
      // region of the page from the trade grid. Reconciling the grid against its own
      // Sub Total cannot catch a misparse that is internally self-consistent - the
      // failure mode CLAUDE.md warns about, and the one that turned a Nuvama V3 buy of
      // 10,000 @ 292.61 into a sell of 292.91 @ 1.00 with its own arithmetic agreeing.
      // Two independently printed regions agreeing is a real check.
      if (n.scripSummary.length === 0) {
        // Every Axis note in the reference corpus prints one. Its absence means the
        // section moved or the row shape changed - refuse rather than pass vacuously.
        failed.push(`${label} (no Scrip Wise Summary to cross-check)`);
      } else {
        for (const sc of n.scripSummary) {
          const mine = t
            .filter((x) => (x.isin || '').toUpperCase() === sc.isin)
            .reduce((a, x) => a + x.turnover, 0);
          if (sc.grossTotal > 0 && Math.abs(mine - sc.grossTotal) > 0.05) {
            failed.push(`${label} ${sc.isin} (grid ${mine.toFixed(2)} vs summary ${sc.grossTotal.toFixed(2)})`);
          }
        }
      }

      trades.push(...t);
      summary.payinObligation += n.summary.payinObligation;
      summary.stt += n.summary.stt;
      summary.taxableValue += n.summary.taxableValue;
      summary.cgst += n.summary.cgst;
      summary.sgst += n.summary.sgst;
      summary.igst += n.summary.igst;
      summary.gst += n.summary.gst;
      summary.etc += n.summary.etc;
      summary.sebiFees += n.summary.sebiFees;
      summary.clearingCharges += n.summary.clearingCharges;
      summary.stampDuty += n.summary.stampDuty;
      summary.ipf += n.summary.ipf;
      summary.netSettlement += n.summary.netSettlement;
    });

    if (trades.length === 0) return null;

    (Object.keys(summary) as (keyof Summary)[]).forEach((k) => {
      const v = summary[k];
      if (typeof v === 'number') (summary as any)[k] = r2(v);
    });

    const dated = notes.map((n) => n.tradeDate).filter(Boolean);
    const iso = (d: string) => d.split('/').reverse().join('-');
    const sorted = [...dated].sort((a, b) => iso(a).localeCompare(iso(b)));

    const result: ContractNoteResult = {
      summary,
      trades,
      brokerName: 'axis',
      // The LATEST note's date. Every Trade carries its own date and the ledger groups
      // by that, so this is metadata only — but it must stay a single parseable date
      // because the export filename and the header card both format it.
      tradeDate: sorted.length ? sorted[sorted.length - 1] : '',
      ucc: notes.find((n) => n.ucc)?.ucc || '',
      rawText: text,
      noteCount: notes.length,
      dateRange: sorted.length ? { from: sorted[0], to: sorted[sorted.length - 1] } : undefined,
      reconciliation: calculateReconciliation(summary, trades),
    };

    // A merged audit is not meaningful (see above), so replace its verdict with the
    // fold of the per-note verdicts, which ARE meaningful, and name the note that
    // failed. Without this a single bad sub-note disappears into a total that still
    // adds up.
    if (result.reconciliation) {
      result.reconciliation = {
        ...result.reconciliation,
        isValid: failed.length === 0,
        statusText: failed.length === 0 ? 'PASSED' : 'Parser uncertain',
        notes: failed.length
          ? `${failed.length} of ${notes.length} contract note(s) failed their own audit: ${failed.join(', ')}`
          : `${notes.length} contract note(s) each reconciled against their own printed totals.`,
      };
    }

    return result;
  }
}
