// ── Nuvama Wealth (formerly Edelweiss Broking) contract notes ────────────────
//
// Nuvama has issued this client three visibly different templates, so the broker
// is registered THREE times — 'nuvama-v1' / 'nuvama-v2' / 'nuvama-v3' — and the
// picker offers them in a dropdown. One class serves all three; the layout branch
// lives in parsePdfText, mirroring how integrated.ts dispatches on classifyFormat.
//
//   V1  2021, "EDELWEISS BROKING LTD." letterhead
//   V2  2023, "Nuvama Wealth and Investment Limited (Formerly - Edelweiss …)"
//   V3  2026, wholly new template — a WAP-per-ISIN grid instead of trade rows
//
// V1 and V2 are the same template FAMILY: identical 14-column trade table, the
// same "*Net Delivery*" / "CAPITAL MARKET … TOTAL (NET)" marker rows, and the same
// obligation-block labels down to the unspaced "ExchangeTransaction Charges". They
// share parseLegacyNote. They are kept as separate ids anyway so V2 can diverge
// later without disturbing V1.
//
// WHY THE ROW PARSER NEVER USES FIXED TOKEN POSITIONS: V1 prints a single-token
// exchange symbol in Contract Description ("INE335A01012 - SURYAROSNI") while V2
// prints a company name clipped to a 15-char field ("INE0DGC01025 - SWASTIK PIPE
// LI"). That moves the Buy/Sell keyword from token index 7 to index 9. Rows are
// therefore anchored on the ISIN plus the side keyword, and the numbers are read
// relative to the side.
//
// ── Verified arithmetic (all three notes tie to the printed settlement exactly)
//
//   V1  gross 9,68,010.00 − brokerage 968.00      = 9,67,042.00 obligation
//       − STT 968.00 − ETC 26.62 − SEBI 0.97 − GST 179.20 = 9,65,867.21
//   V2  gross 94,800.00 + brokerage 120.00        =   94,920.00 obligation
//       + STT 95 + stamp 14 + ETC 2.61 + SEBI 0.09 + GST 22.08 =  95,053.78
//   V3  gross 8,06,470.00 + brokerage 0.00        = 8,06,470.00 obligation
//       − ETC 24.76 − SEBI 0.81 − GST 4.60                    = 8,06,439.83
//   V3  (CN 893207 — two scrips, real brokerage AND STT)
//       gross 99,40,342.76 = 47,088 × 174.1348 + 4,561 × 381.6451
//       − brokerage 9,938.50 − STT 9,940 − ETC 305.16 − SEBI 9.94
//       − IPFT 0.01 − GST 1,845.66                          = 99,18,303.49
//   V3  (CN 113911 — a BUY)
//       gross 29,26,125.00 = 10,000 × 292.6125
//       + brokerage 2,926 + STT 2,926 + stamp 439 + ETC 89.83
//       + SEBI 2.93 + GST 543.38                            = 29,33,052.14
//
// GST base is the same rule in all three generations: brokerage + exchange
// transaction charges + SEBI turnover fees + IPFT. STT and stamp duty are excluded
// (V1 proves that — including STT would print CGST 176.72, not the actual 89.60).
// V3 is the only one that prints the base outright, as "Taxable Value of Supply":
// CN 893207 gives 9,938.50 + 305.16 + 9.94 + 0.01 = 10,253.61 and CN 113911 gives
// 2,926 + 89.83 + 2.93 = 3,018.76, both exact.
//
// THREE V3 FACTS THAT ARE EASY TO GET BACKWARDS:
//   • "Trade Amt" is qty × WAP **Trade** Rate, never the Mkt Rate — and Trade Rate
//     is Mkt Rate MINUS brokerage on a sell (174.1348 − 0.1741 = 173.9607) and PLUS
//     brokerage on a buy (292.6125 + 0.2926 = 292.9051). Turnover must therefore use
//     WAP **Mkt** Rate. Never read Trade Amt.
//   • "Pay In/Pay Out Obligation" on V3 is the GROSS turnover on BOTH sides, and
//     matches Σ(qty × Mkt Rate) to the paise. On V1 the same line is NET of
//     brokerage (9,68,010 − 968 = 9,67,042). Display-only either way —
//     reconciliation compares net settlement — but they are not one field.
//   • The label set VARIES between V3 notes: CN 893207 carries IPFT and no stamp
//     duty (all sells), CN 113911 carries stamp duty and no IPFT (a buy). The
//     obligation block is therefore zipped against whatever labels are present, and
//     an absent line must never be read as an implicit zero in a fixed position.
//     Stamp duty is buy-side only, at 0.015% of gross (439.00 on 29,26,125).

import { ContractNoteResult, Summary, Trade, TransactionType } from '../../types';
import { BrokerStrategy } from './types';
import { allocateStt } from './stt';
import {
  parseNumber,
  cleanText,
  isFootnoteOrDisclaimer,
  calculateReconciliation,
  extractIsin,
  isIsin,
} from './utils';

export type NuvamaVariant = 'v1' | 'v2' | 'v3';

/** Money sits at paise. Same helper, same EPSILON nudge, as every other parser. */
const rt = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const isDash = (t: string) => t === '-' || t === '–' || t === '—';

// A numeric cell. The trailing [-−]? is not a typo: pdf.js wraps V3's Net Trade
// Amt mid-number and emits "-8,06,470-" on one line and ".00" on the next.
const NUM_TOK = /^\(?[-−]?[\d,]+(?:\.\d+)?\)?[-−]?$/;
const isNumTok = (t: string) => !isDash(t) && NUM_TOK.test(t);

const SIDE_WORD = /^(buy|sell)$/i;
const SIDE_LETTER = /^(b|s)$/i;

/**
 * Rejoin a number that pdf.js hyphenated across a line break: the V3 grid's amount
 * columns are narrow, so "29,29,051.00" comes out as "29,29,05-" then "1.00".
 *
 * This has to happen before cells are indexed, not after. On a BUY note the wrap
 * falls inside the buy block, so leaving the fragment in place shifts every later
 * cell one slot right — the sell block's five dashes land at cells[6..10] and the
 * fragment itself lands in the sell-QTY slot. A single-sided row survives that by
 * accident (the sell rate beside it is a dash, so the row is rejected), but a row
 * with BOTH sides populated would read the fragment as a quantity and the sell
 * quantity as a price.
 *
 * A trailing "-" is unambiguous: negatives in this table carry a LEADING minus
 * ("-47,088") and an empty cell is exactly "-", so a digit followed by "-" at the
 * end of a token is always a hyphenation artifact.
 */
const mergeWrappedNumbers = (toks: string[]): string[] => {
  const out: string[] = [];
  for (let k = 0; k < toks.length; k++) {
    const next = toks[k + 1];
    if (/^[-−]?[\d,]+[-−]$/.test(toks[k]) && next && /^[\d.,]+$/.test(next)) {
      out.push(toks[k].slice(0, -1) + next);
      k++;
      continue;
    }
    out.push(toks[k]);
  }
  return out;
};

/**
 * STT-exempt instruments. An INF-series ISIN is a mutual-fund / ETF unit and is the
 * most reliable signal available — far better than the name, which is why it is
 * tested first. Deliberately NOT matching a bare "CASE" substring the way the old
 * generic parser did: it fires on any company name containing "case", and
 * LIQUIDCASE is already caught by "LIQUID".
 */
const isSttExempt = (securityName: string, isin: string): boolean => {
  if (/^INF/i.test(isin)) return true;
  const s = (securityName || '').toUpperCase();
  return s.includes('LIQUID') || s.includes('ETF') ||
         s.includes('MUTUAL FUND') || s.includes('MUTUALFUND');
};

/** A trade row as read off the note, before aggregation. */
interface RawRow {
  isin: string;
  securityName: string;
  type: TransactionType;
  quantity: number;
  /** GROSS rate — the market rate, before brokerage. */
  price: number;
  /** Brokerage in RUPEES for this row. Read from the amount column, never derived
   *  from the printed per-unit rate (see readLegacyRow). */
  brokerageAmount: number;
  contextText: string;
}

const EXCHANGE_WORDS = new Set(['NSE', 'BSE', 'MSEI', 'MCX', 'NCDEX']);

// ── shared summary-line helper ───────────────────────────────────────────────

/**
 * The last number on a charge line, with any "@ 9 %" rate qualifier removed first.
 * Without that strip, "CGST @ 9 % 89.60 89.60" is fine (last number wins) but a
 * line whose value column is blank would yield the rate 9 as the charge.
 */
const lineValue = (line: string): number | null => {
  const cleaned = line
    .replace(/@\s*\d+(?:\.\d+)?\s*%/g, ' ')
    .replace(/\d+(?:\.\d+)?\s*%/g, ' ');
  const nums = cleaned.match(/\(?[-−]?[\d,]+(?:\.\d+)?\)?/g);
  if (!nums || nums.length === 0) return null;
  const v = parseNumber(nums[nums.length - 1]);
  return isNaN(v) ? null : v;
};

/**
 * Nuvama's settlement sign is the INVERSE of this app's.
 *
 * The note footer states "(-) Credit Amount / (+) Debit Amount" — negative means
 * money moving TO the client. calculateReconciliation computes
 * `calculatedNet = sells − buys − charges`, which is POSITIVE when money comes to
 * the client. So the printed figure is negated on the way in, and all three notes
 * then tie to the paise.
 *
 * Do not "fix" this by reading the label instead: V2 says "Net amount payable BY
 * Client" (client pays, a debit) while V3 says "Net Amount Payable TO Client"
 * (broker pays, a credit). The two wordings mean opposite things, so the printed
 * sign is the only trustworthy source. If it is ever wrong the reconciliation
 * fails by twice the settlement — loudly, not silently.
 */
const toAppSettlementSign = (printed: number) => -printed;

// ── V1 / V2 — the legacy 14-column trade table ───────────────────────────────

/**
 * Read one legacy trade row. Anchored on the ISIN and the Buy/Sell keyword, never
 * on token positions (V1's symbol vs V2's truncated name shift everything after
 * the description).
 *
 * Numbers after the side keyword, in order:
 *   qty | gross rate | brokerage rate/unit | brokerage total | net rate | [STT] | net total
 *
 * On both sample notes the per-row STT column is EMPTY, giving six numbers. It is
 * read positionally from the front and the net total is taken from the BACK, so a
 * note that does populate STT (seven numbers) still parses correctly.
 *
 * BROKERAGE IS READ FROM THE AMOUNT COLUMN, NOT THE RATE COLUMN. V1 row 12 prints
 * rate 0.4841 for 200 shares while the actual brokerage is 96.81 (implied rate
 * 0.484050); 200 × 0.4841 = 96.82 and the note stops tying out by a paisa. The
 * printed per-unit rate is a rounded display of amount/qty, not an input.
 */
const readLegacyRow = (line: string): RawRow | null => {
  const isin = extractIsin(line);
  if (!isin) return null;

  const tokens = line.trim().split(/\s+/);
  const isinIdx = tokens.findIndex((t) => extractIsin(t) === isin && isin !== '');
  if (isinIdx === -1) return null;

  // Full words first, single letters only as a fallback. The Buy(B)/Sell(S) column
  // may print either, but a scrip name like "S CHAND" contributes a bare "S" token
  // that would otherwise be read as the side and truncate the name.
  let sideIdx = tokens.findIndex((t, i) => i > isinIdx && SIDE_WORD.test(t));
  if (sideIdx === -1) sideIdx = tokens.findIndex((t, i) => i > isinIdx && SIDE_LETTER.test(t));
  if (sideIdx === -1) return null;

  const nameTokens = tokens
    .slice(isinIdx + 1, sideIdx)
    .filter((t) => !isDash(t) && t.length > 0);
  const securityName = nameTokens.join(' ').trim();
  if (!securityName || EXCHANGE_WORDS.has(securityName.toUpperCase())) return null;

  const nums = tokens.slice(sideIdx + 1).filter(isNumTok).map((t) => parseNumber(t));
  if (nums.length < 6) return null;

  const quantity = Math.abs(nums[0]);
  const price = Math.abs(nums[1]);
  const brokerageAmount = Math.abs(nums[3]);
  if (!(quantity > 0) || !(price > 0)) return null;

  const sideLower = tokens[sideIdx].toLowerCase();
  const type: TransactionType =
    sideLower === 'buy' || sideLower === 'b' ? 'Buy' : 'Sell';

  return { isin, securityName, type, quantity, price, brokerageAmount, contextText: line };
};

const extractLegacySummary = (text: string): Summary => {
  const s: Summary = {
    payinObligation: 0, stt: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, gst: 0,
    etc: 0, sebiFees: 0, clearingCharges: 0, stampDuty: 0, ipf: 0, netSettlement: 0,
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // A trade row carries an ISIN; charge lines never do. Skipping them stops a
    // row's trailing numbers being mistaken for a charge value.
    if (extractIsin(line)) continue;
    if (isFootnoteOrDisclaimer(line)) continue;
    // An obligation row is a short label plus its value. The GST legend
    // ("* CGST:-Central GST; SGST: - State GST; IGST:-Integrated GST; …") slips past
    // isFootnoteOrDisclaimer — it is over 100 chars but contains none of
    // the/and/for/with — and matches "igst". It only fails to corrupt the summary
    // because it happens to carry no digits, which is too thin a margin to rely on.
    if (line.length > MAX_LABEL_LINE) continue;

    const l = cleanText(line);
    const v = lineValue(line);
    if (v === null) continue;

    if (l.includes('payin/payout obligation') || l.includes('pay in/pay out obligation') ||
        l.includes('payin / payout obligation')) {
      s.payinObligation = v;
    } else if (l.includes('security transaction tax') || l.includes('securities transaction tax')) {
      s.stt = Math.abs(v);
    } else if (l.includes('stamp duty')) {
      // "Consolidated Stamp Duty will be paid" is a template notice, not a charge.
      if (!l.includes('will be paid') && !l.includes('to be stamped')) s.stampDuty = Math.abs(v);
    } else if (l.includes('exchangetransaction charges') || l.includes('exchange transaction charges')) {
      s.etc = Math.abs(v);
    } else if (l.includes('sebi turnover fees') || l.includes('sebi turnover fee')) {
      s.sebiFees = Math.abs(v);
    } else if (l.includes('clearing charges') || l.includes('clearing charge')) {
      s.clearingCharges = Math.abs(v);
    } else if (l.includes('igst')) {
      s.igst = Math.abs(v);
    } else if (l.includes('sgst') || l.includes('utgst')) {
      s.sgst = Math.abs(v);
    } else if (l.includes('cgst')) {
      s.cgst = Math.abs(v);
    } else if (l.includes('net amount receivable') || l.includes('net amount payable') ||
               l.includes('net amount receivable by client') || l.includes('net amount payable by client')) {
      s.netSettlement = toAppSettlementSign(v);
    }
  }
  return s;
};

const parseLegacyNote = (text: string): { rows: RawRow[]; summary: Summary } => {
  const rows: RawRow[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const l = cleanText(t);
    // "*Net Delivery*" is a subtotal row and carries no ISIN, so it is already
    // excluded — but be explicit, because its middle figure is the STT total and
    // on V1 that happens to equal the brokerage total (both 968.00), which is
    // exactly the kind of coincidence a parser gets calibrated on by accident.
    if (l.includes('net delivery') || l.includes('capital market')) continue;
    const row = readLegacyRow(t);
    if (row) rows.push(row);
  }
  return { rows, summary: extractLegacySummary(text) };
};

// ── V3 — the WAP-per-ISIN grid ───────────────────────────────────────────────

/**
 * V3 replaces per-trade rows with one row per ISIN carrying weighted-average rates
 * for each side. The header is two stacked rows, so a data row's cells are:
 *
 *   ISIN | Scrip Name | <buy: qty, mktRate, brokRate, tradeRate, amt>
 *                     | <sell: qty, mktRate, brokRate, tradeRate, amt>
 *                     | netQty | netAmt
 *
 * Empty cells print as "-". Net Qty / Net Trade Amt are IGNORED — they are
 * derivable, and Net Trade Amt is the cell pdf.js wraps mid-number.
 *
 * turnover uses WAP **Mkt** Rate (the gross market rate), not WAP Trade Rate (which
 * is net of brokerage) — matching the app's convention that turnover is gross and
 * brokerage is a separate charge. On the sample the two are equal because brokerage
 * is zero, so 7,000 × 115.2100 = 8,06,470.00 confirms the reading either way.
 */
/**
 * The V3 obligation block's row labels, as a lookup. 'SKIP' means "this label
 * occupies a row but its value is discarded" — which matters enormously for the
 * column-zip below, where dropping a label would shift every value after it.
 *
 * 'taxable value of supply' is SKIPped on purpose. On V3 it is the GST BASE, not
 * the brokerage — measured on a two-scrip note as exactly
 * `brokerage 9,938.50 + ETC 305.16 + SEBI 9.94 + IPFT 0.01 = 10,253.61`. This app's
 * Summary.taxableValue means the brokerage line — calculateReconciliation sums it
 * as `summary.taxableValue + // brokerage` alongside etc/sebiFees — so storing the
 * base there would double-count every one of those.
 *
 * 'ipf' is matched loosely because the label is printed "IPFT Charges", not "IPF".
 * An anchored /\bipf\b/ misses it, the label then goes uncounted, and the whole
 * column zip fails on a count mismatch — taking every charge on the note with it.
 */
type WapKey = keyof Summary | 'SKIP';

const mapWapLabel = (l: string): WapKey | null => {
  if (l.includes('pay in/pay out obligation') || l.includes('payin/payout obligation')) return 'payinObligation';
  if (l.includes('taxable value')) return 'SKIP';
  if (l === 'brokerage' || l.startsWith('brokerage ')) return 'taxableValue';
  if (l.includes('securities transaction tax') || l.includes('security transaction tax') ||
      /(^|\s)stt(\s|$)/.test(l)) return 'stt';
  if (l.includes('stamp duty')) return 'stampDuty';
  if (l.includes('exchangetransaction charges') || l.includes('exchange transaction charges')) return 'etc';
  if (l.includes('sebi turnover fee')) return 'sebiFees';
  if (l.includes('clearing charge')) return 'clearingCharges';
  if (l.includes('investor protection') || l.includes('ipf')) return 'ipf';
  if (l.includes('igst')) return 'igst';
  if (l.includes('sgst') || l.includes('utgst')) return 'sgst';
  if (l.includes('cgst')) return 'cgst';
  if (l.includes('net amount payable') || l.includes('net amount receivable')) return 'netSettlement';
  return null;
};

/**
 * The obligation label on `line`, or null if the line is not an obligation row.
 *
 * The shape guards are not decoration. The document footer
 * `*CGST :- Central GST | SGST :- State GST | IGST :- Integrated GST | UTT :- …`
 * is 95 characters — just under `isFootnoteOrDisclaimer`'s 100-char threshold — and
 * contains "igst", so without them it registers as a charge label sitting AFTER the
 * real block. That drags the label run past the values and the entire column zip
 * fails on a count mismatch, silently zeroing every charge on the note.
 *
 * A genuine obligation row is a short label with no pipes; the legend is long and
 * pipe-delimited.
 */
const MAX_LABEL_LINE = 80;

const labelOf = (line: string): WapKey | null => {
  if (line.includes('|') || line.length > MAX_LABEL_LINE) return null;
  if (extractIsin(line) || isFootnoteOrDisclaimer(line)) return null;
  return mapWapLabel(cleanText(line));
};

const setWapField = (s: Summary, key: WapKey, v: number) => {
  if (key === 'SKIP') return;
  if (key === 'netSettlement') s.netSettlement = toAppSettlementSign(v);
  else if (key === 'payinObligation') s.payinObligation = v;
  else (s as any)[key] = Math.abs(v);
};

/** A line that is nothing but one number. */
const NUM_LINE = /^\(?[-−]?[\d,]+(?:\.\d+)?\)?$/;

/**
 * V3's Obligation Details is a two-column table, and pdf.js extracts it COLUMN by
 * column: every row label first, then the value-column header ("EQ BSE"), then
 * every value. So no label ever shares a line with its number, and the paired pass
 * finds nothing. This zips the two runs back together positionally.
 *
 * Only V3 gets this treatment. V1/V2's obligation block extracts paired and prints
 * most values TWICE ("Security Transaction Tax 968.00 968.00") while the obligation
 * row prints once — not a clean grid, so a speculative zip there could silently
 * double a charge. If a legacy note ever extracts column-split, reconciliation
 * fails loudly and it can be fixed against a real sample.
 */
const zipWapColumns = (text: string, s: Summary): boolean => {
  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);

  // Collect the label run and STOP at netSettlement — it is always the last row of
  // the obligation block, so breaking there keeps every downstream footnote out of
  // the run regardless of what it happens to contain.
  const labels: { key: WapKey; at: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (NUM_LINE.test(lines[i])) continue;
    const key = labelOf(lines[i]);
    if (!key) continue;
    labels.push({ key, at: i });
    if (key === 'netSettlement') break;
  }
  if (labels.length === 0) return false;

  const lastLabelAt = labels[labels.length - 1].at;
  const values: number[] = [];
  for (let i = lastLabelAt + 1; i < lines.length; i++) {
    if (NUM_LINE.test(lines[i])) values.push(parseNumber(lines[i]));
    else if (values.length > 0) break;   // the run of values has ended
  }
  if (values.length === 0) return false;

  if (values.length === labels.length) {
    labels.forEach((L, i) => setWapField(s, L.key, values[i]));
    return true;
  }

  // More values than labels means more than one value column (e.g. EQ NSE and
  // EQ BSE side by side), extracted column-major. Summing each label across its
  // columns is the natural reading, but it is UNTESTED — no multi-exchange V3 note
  // has been seen. A wrong guess here fails reconciliation rather than passing
  // quietly, which is the outcome to want.
  if (values.length > labels.length && values.length % labels.length === 0) {
    const cols = values.length / labels.length;
    labels.forEach((L, i) => {
      let total = 0;
      for (let c = 0; c < cols; c++) total += values[c * labels.length + i];
      setWapField(s, L.key, total);
    });
    return true;
  }
  return false;
};

const extractWapSummary = (text: string): Summary => {
  const s: Summary = {
    payinObligation: 0, stt: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, gst: 0,
    etc: 0, sebiFees: 0, clearingCharges: 0, stampDuty: 0, ipf: 0, netSettlement: 0,
  };

  // Pass 1 — label and value on the same line.
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const key = labelOf(line);
    if (!key) continue;
    const v = lineValue(line);
    if (v === null) continue;
    setWapField(s, key, v);
  }

  // Pass 2 — the column-split form. netSettlement is the field reconciliation
  // cannot work without, so its absence is the signal that pass 1 found nothing.
  if (s.netSettlement === 0) zipWapColumns(text, s);

  return s;
};

/**
 * Read one row of the V3 grid. See the block comment above `parseWapNote` for the
 * column layout.
 *
 * turnover uses WAP **Mkt** Rate, the gross market rate. It is NOT `Trade Amt`, and
 * that distinction is measurable: on a two-scrip note `47,088 × 174.1348 (Mkt) =
 * 81,99,659.46` while the printed Trade Amt is `81,91,461.44 = 47,088 × 173.9607
 * (Trade)`. Trade Amt is net of brokerage. The app's convention is that turnover is
 * gross with brokerage as a separate charge, and Σ(qty × Mkt Rate) across the note
 * reproduces the printed "Pay In/Pay Out Obligation" to the paise.
 */
const readWapRow = (lines: string[], idx: number): RawRow[] => {
  const tokens = lines[idx].trim().split(/\s+/);
  if (tokens.length < 2) return [];

  // The ISIN must be the row's FIRST cell, and be nothing but an ISIN.
  //
  // This is what keeps the page-2 Annexure out, and it is not paranoia: those rows
  // have no ISIN column, but `extractIsin` also retries with whitespace removed, so
  // "INDUSTOWER 1100000082135790" collapses to a string whose first twelve
  // characters — "INDUSTOWER11" — satisfy IN + 9 alphanumerics + a check digit.
  // Matching loosely would mint a garbage ISIN off an Annexure line and invent a
  // duplicate trade. See the same class of bug in [[scrip-resolution-gotchas]].
  if (!isIsin(tokens[0])) return [];
  const isin = tokens[0].toUpperCase();

  // Name runs until the first cell token (a number or a "-" placeholder).
  let i = 1;
  const nameTokens: string[] = [];
  while (i < tokens.length && !isNumTok(tokens[i]) && !isDash(tokens[i])) {
    nameTokens.push(tokens[i]);
    i++;
  }
  const securityName = nameTokens.join(' ').trim();
  if (!securityName || EXCHANGE_WORDS.has(securityName.toUpperCase())) return [];

  // pdf.js wraps a long amount mid-number and pushes the tail onto the next line —
  // "81,91,46-" then "1.44". Pull continuation lines in until the row has its full
  // twelve cells, stopping at anything that begins a new row or the charges block.
  // Without this a wrap inside the BUY block would shove the entire sell block onto
  // the next line and the sell would vanish silently.
  let cellToks = mergeWrappedNumbers(tokens.slice(i));
  let j = idx + 1;
  while (cellToks.length < 12 && j < lines.length) {
    const next = lines[j].trim().split(/\s+/);
    if (next.length === 0 || isIsin(next[0])) break;
    if (mapWapLabel(cleanText(lines[j]))) break;
    const usable = next.filter((t) => isNumTok(t) || isDash(t) || /^[\d.,]+$/.test(t));
    if (usable.length === 0) break;
    // Merge after appending — the hyphenated pair straddles the line boundary, so it
    // can only be rejoined once both halves are in the same list.
    cellToks = mergeWrappedNumbers([...cellToks, ...usable]);
    j++;
  }

  const cells = cellToks.slice(0, 12).map((t) => (isNumTok(t) ? parseNumber(t) : null));

  const out: RawRow[] = [];
  const side = (
    qtyCell: number | null,
    rateCell: number | null,
    brokRateCell: number | null,
    type: TransactionType,
  ) => {
    const quantity = Math.abs(qtyCell ?? 0);
    const price = Math.abs(rateCell ?? 0);
    if (!(quantity > 0) || !(price > 0)) return;
    out.push({
      isin, securityName, type, quantity, price,
      // The per-scrip WAP Brok Rate is a 4dp rounded display, so this is a starting
      // point only — finalizeNote sweeps the residue so Σ ties to the note's printed
      // Brokerage total exactly. On the measured note the two already agree:
      // 47,088 × 0.1741 + 4,561 × 0.3816 = 9,938.50, the printed total.
      brokerageAmount: Math.abs(brokRateCell ?? 0) * quantity,
      contextText: lines[idx],
    });
  };
  side(cells[0], cells[1], cells[2], 'Buy');    // buy  qty | WAP Mkt Rate | WAP Brok Rate
  side(cells[5], cells[6], cells[7], 'Sell');   // sell qty | WAP Mkt Rate | WAP Brok Rate
  return out;
};

const parseWapNote = (text: string): { rows: RawRow[]; summary: Summary } => {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows: RawRow[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const l = cleanText(lines[idx]);
    // The "EQUITY - 60072941 | Normal+1 | Contract No - 893207" band inside the
    // table body, and the Annexure header, carry no usable cells.
    if (l.startsWith('equity -') || l.startsWith('equity-')) continue;
    if (l.includes('detail trade annexure')) continue;
    rows.push(...readWapRow(lines, idx));
  }
  return { rows, summary: extractWapSummary(text) };
};

// ── date / UCC ───────────────────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Nuvama's trade date, normalised to a form `toIsoDate` understands.
 *
 * The shared `getTradeDate` cannot be used for V3: its regex is
 * /(\d{2}[-/]\d{2}[-/]\d{4})|(\d{4}[-/]\d{2}[-/]\d{2})/ and V3 prints
 * "29/Jul/2026" — an alpha month — so it returns "". V1/V2 print "26/05/2021" and
 * would work, but one extractor for all three variants is less to get wrong.
 */
const nuvamaTradeDate = (text: string): string => {
  const lines = text.split('\n');
  for (const raw of lines) {
    const l = cleanText(raw);
    if (!l.includes('trade date') && !l.includes('trxdate')) continue;

    const alpha = raw.match(/(\d{1,2})[\/\-\s]([A-Za-z]{3})[a-zA-Z]*[\/\-\s](\d{4})/);
    if (alpha) {
      const mon = MONTHS.indexOf(alpha[2].toLowerCase());
      if (mon >= 0) {
        const dd = alpha[1].padStart(2, '0');
        const mm = String(mon + 1).padStart(2, '0');
        return `${dd}/${mm}/${alpha[3]}`;
      }
    }
    const numeric = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (numeric) {
      return `${numeric[1].padStart(2, '0')}/${numeric[2].padStart(2, '0')}/${numeric[3]}`;
    }
  }
  return '';
};

/**
 * The client code. The shared `getUCC` misses every Nuvama label: it only accepts
 * "client code" / "client id" / "ucc" followed by a [:\-—|] separator, whereas V1/V2
 * print "Trading/ Back Office Code : 60072941" and V3 prints "UCC/Backoffice Code
 * 60072941" — in both cases the "/" breaks the separator class.
 *
 * Note the code is ALL DIGITS, so `uccFromFilename` in parsers.ts cannot back it up
 * either (its capture group requires a leading letter).
 */
const nuvamaUcc = (text: string): string => {
  const patterns = [
    /trading\s*\/?\s*back\s*office\s*code\s*[:\-—|]?\s*([A-Za-z0-9]{3,15})/i,
    /ucc\s*\/?\s*back\s*?office\s*code\s*[:\-—|]?\s*([A-Za-z0-9]{3,15})/i,
    /back\s*?office\s*code\s*[:\-—|]?\s*([A-Za-z0-9]{3,15})/i,
    /acoount\s*code\s*[:\-]?\s*([A-Za-z0-9]{3,15})/i,   // sic — V3's Annexure typo
    /account\s*code\s*[:\-]?\s*([A-Za-z0-9]{3,15})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].toUpperCase();
  }
  return '';
};

// ── finalize ─────────────────────────────────────────────────────────────────

/**
 * Spread a printed total across trades pro-rata by `ratioOf`, giving the LAST
 * contributing row the untouched remainder so the per-trade figures sum back to the
 * note exactly. Same remainder-sweep idea Zerodha and Integrated use — without it
 * paise drift makes the reconciliation audit fail on a correct parse.
 */
const allocate = (total: number, ratios: number[]): number[] => {
  const out = new Array<number>(ratios.length).fill(0);
  if (!(Math.abs(total) > 0)) return out;
  let lastIdx = -1;
  for (let i = 0; i < ratios.length; i++) if (ratios[i] > 0) lastIdx = i;
  if (lastIdx === -1) return out;
  let assigned = 0;
  for (let i = 0; i < ratios.length; i++) {
    if (ratios[i] <= 0 || i === lastIdx) continue;
    out[i] = rt(total * ratios[i]);
    assigned = rt(assigned + out[i]);
  }
  out[lastIdx] = rt(total - assigned);
  return out;
};

const finalizeNote = (
  rows: RawRow[],
  summary: Summary,
  tradeDate: string,
  variant: NuvamaVariant,
): ContractNoteResult | null => {
  const valid = rows.filter(
    (r) => r.securityName.trim().length > 0 && r.quantity > 0 && r.price > 0,
  );
  if (valid.length === 0) return null;

  // One Trade per scrip+side. avgPrice is turnover-weighted; brokerage is SUMMED
  // from the row amounts, never rebuilt from a per-unit rate.
  const groups = new Map<string, RawRow[]>();
  for (const r of valid) {
    const key = `${r.securityName.trim()}||${r.type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const merged = Array.from(groups.values()).map((items) => {
    const quantity = items.reduce((n, x) => n + x.quantity, 0);
    const turnover = items.reduce((n, x) => n + x.quantity * x.price, 0);
    return {
      isin: items[0].isin,
      securityName: items[0].securityName.trim(),
      type: items[0].type,
      quantity,
      // Full precision — a rate keeps 6dp, money sits at paise. Rounding avgPrice
      // to 2dp here breaks the amount↔price round-trip (₹9,68,010/2000 = 484.005).
      avgPrice: quantity > 0 ? turnover / quantity : 0,
      turnover,
      brokerageAmount: items.reduce((n, x) => n + x.brokerageAmount, 0),
      contextText: items.map((x) => x.contextText).join(' '),
    };
  });

  const totalTurnover = merged.reduce((n, t) => n + t.turnover, 0);
  const totalBuyTurnover = merged.reduce((n, t) => (t.type === 'Buy' ? n + t.turnover : n), 0);

  // Per-security tally for the Delivery/Intraday call.
  const stats = new Map<string, { buyQty: number; sellQty: number }>();
  for (const t of merged) {
    if (!stats.has(t.securityName)) stats.set(t.securityName, { buyQty: 0, sellQty: 0 });
    const s = stats.get(t.securityName)!;
    if (t.type === 'Buy') s.buyQty += t.quantity; else s.sellQty += t.quantity;
  }

  // STT: the note's printed total is the anchor. Shared allocator — see ./stt.
  // Rows on an INF-series ISIN (MF/ETF units) are exempt and stay 0.
  const sttArr = allocateStt(
    merged.map((t) => ({
      securityName: t.securityName,
      type: t.type as 'Buy' | 'Sell',
      quantity: t.quantity,
      price: t.avgPrice,
      exempt: isSttExempt(t.securityName, t.isin),
    })),
    summary.stt || 0,
  );

  const ratios = merged.map((t) => (totalTurnover > 0 ? t.turnover / totalTurnover : 0));
  const buyRatios = merged.map((t) =>
    t.type === 'Buy' && totalBuyTurnover > 0 ? t.turnover / totalBuyTurnover : 0,
  );

  // Brokerage comes from the rows when the note carries it per row (V1/V2 amounts,
  // V3's WAP rate × qty) and from the printed total otherwise. Either way it must sum
  // to the note's own figure, so when both exist the residue is swept onto the
  // largest row — V3's per-scrip WAP rate is rounded to 4dp and cannot be trusted to
  // tie on its own, even though it happens to on the measured note.
  const rowBrokerageTotal = merged.reduce((n, t) => n + t.brokerageAmount, 0);
  let brokerageArr: number[];
  if (rowBrokerageTotal > 0) {
    brokerageArr = merged.map((t) => rt(t.brokerageAmount));
    if (summary.taxableValue > 0) {
      const drift = rt(summary.taxableValue - brokerageArr.reduce((n, x) => n + x, 0));
      if (Math.abs(drift) >= 0.01) {
        let big = 0;
        for (let k = 1; k < brokerageArr.length; k++) if (brokerageArr[k] > brokerageArr[big]) big = k;
        brokerageArr[big] = rt(brokerageArr[big] + drift);
      }
    }
  } else {
    brokerageArr = allocate(summary.taxableValue, ratios);
  }

  const etcArr = allocate(summary.etc, ratios);
  const sebiArr = allocate(summary.sebiFees, ratios);
  const clearingArr = allocate(summary.clearingCharges, ratios);
  const ipfArr = allocate(summary.ipf, ratios);
  // Stamp duty is a BUYER-side levy: sells get nothing.
  const stampArr = allocate(summary.stampDuty, buyRatios);
  const cgstArr = allocate(summary.cgst, ratios);
  const sgstArr = allocate(summary.sgst, ratios);
  const igstArr = allocate(summary.igst, ratios);

  const trades: Trade[] = merged.map((t, idx) => {
    const s = stats.get(t.securityName)!;
    const text = `${t.contextText} ${t.securityName}`.toLowerCase();
    const intradayHit = /intraday|intra-day|day trade|day-trade|\bmis\b/.test(text);
    const deliveryHit = /delivery|delv|\bcnc\b|carry forward|carry-forward/.test(text);
    let isIntraday: boolean;
    if (intradayHit && !deliveryHit) isIntraday = true;
    else if (deliveryHit && !intradayHit) isIntraday = false;
    else isIntraday = s.buyQty === s.sellQty && s.buyQty > 0;

    const turnover = rt(t.turnover);
    const cgst = cgstArr[idx];
    const sgst = sgstArr[idx];
    const igst = igstArr[idx];
    // gst is either IGST or CGST+SGST — never their sum. calculateReconciliation
    // counts only `gst`; cgst/sgst/igst ride along for the export columns.
    const gst = rt(igst > 0 ? igst : cgst + sgst);

    const totalExclSTT = rt(
      brokerageArr[idx] + etcArr[idx] + sebiArr[idx] + clearingArr[idx] +
      stampArr[idx] + ipfArr[idx] + gst,
    );

    return {
      id: `tx-nv${variant}-${idx}`,
      tradeDate,
      isin: t.isin,
      securityName: t.securityName,
      transactionType: t.type,
      quantity: t.quantity,
      avgPrice: t.avgPrice,
      turnover,
      tradeType: isIntraday ? 'Intraday' : 'Delivery',
      // The ONLY signed field: sell = cash in, buy = cash out.
      netTotalBeforeLevies: t.type === 'Sell' ? turnover : -turnover,
      brokerage: brokerageArr[idx],
      stt: sttArr[idx],
      etc: etcArr[idx],
      sebiFees: sebiArr[idx],
      clearingCharges: clearingArr[idx],
      stampDuty: stampArr[idx],
      ipf: ipfArr[idx],
      cgst, sgst, igst, gst,
      totalExpensesInclSTT: rt(totalExclSTT + sttArr[idx]),
      totalExpensesExclSTT: totalExclSTT,
    };
  });

  // Make the summary agree with the rows it produced, the way Integrated does:
  // taxableValue IS the brokerage line as far as reconciliation is concerned.
  const sumBrokerage = rt(trades.reduce((n, t) => n + t.brokerage, 0));
  if (summary.taxableValue === 0 || Math.abs(summary.taxableValue - sumBrokerage) > 1.0) {
    summary.taxableValue = sumBrokerage;
  }
  summary.gst = rt(summary.igst > 0 ? summary.igst : summary.cgst + summary.sgst);

  const reconciliation = calculateReconciliation(summary, trades);
  return { summary, trades, brokerName: 'nuvama', tradeDate, reconciliation };
};

// ── the strategy ─────────────────────────────────────────────────────────────

const VARIANT_LABEL: Record<NuvamaVariant, string> = {
  v1: 'Nuvama V1 (2021 · Edelweiss letterhead)',
  v2: 'Nuvama V2 (2023 · Nuvama, formerly Edelweiss)',
  v3: 'Nuvama V3 (2026 · current template)',
};

export class NuvamaBrokerStrategy implements BrokerStrategy {
  readonly variant: NuvamaVariant;
  id: string;
  name = 'Nuvama';
  displayName: string;

  constructor(variant: NuvamaVariant) {
    this.variant = variant;
    this.id = `nuvama-${variant}`;
    this.displayName = VARIANT_LABEL[variant];
  }

  /**
   * All three generations share SEBI regn INZ000005231, which is the family anchor.
   * The variant is then separated by template, NOT by firm name — V2's letterhead
   * reads "Nuvama Wealth and Investment Limited (Formerly - Edelweiss Broking
   * Limited)" and therefore contains "edelweiss broking", so a V1 detector keyed on
   * the old name alone would swallow V2 notes.
   *
   * In practice the picker sets the variant explicitly and detect() is only reached
   * by registry auto-detection.
   */
  detect(content: string, _isPdf: boolean): boolean {
    const t = content.toLowerCase();
    const family =
      t.includes('inz000005231') ||
      t.includes('nuvama wealth') ||
      t.includes('edelweiss broking');
    if (!family) return false;

    // V3's grid header is unique to the new template.
    const isV3 =
      t.includes('wap mkt rate') ||
      t.includes('net obligation for') ||
      (t.includes('contract note cum bill') && t.includes('ucc/backoffice code'));
    if (this.variant === 'v3') return isV3;
    if (isV3) return false;

    const isEdelweissBranded = t.includes('edelweiss broking ltd');
    const isNuvamaBranded = t.includes('nuvama wealth and investment');
    if (this.variant === 'v2') return isNuvamaBranded;
    return isEdelweissBranded && !isNuvamaBranded;
  }

  /** PDF-only broker; every observed Nuvama note is a PDF. */
  async parseHtml(_html: string): Promise<ContractNoteResult | null> {
    return null;
  }

  async parsePdfText(text: string): Promise<ContractNoteResult | null> {
    if (!text || !text.trim()) return null;

    const { rows, summary } =
      this.variant === 'v3' ? parseWapNote(text) : parseLegacyNote(text);
    if (rows.length === 0) return null;

    const result = finalizeNote(rows, summary, nuvamaTradeDate(text), this.variant);
    if (!result) return null;

    const ucc = nuvamaUcc(text);
    if (ucc) result.ucc = ucc;
    return result;
  }
}
