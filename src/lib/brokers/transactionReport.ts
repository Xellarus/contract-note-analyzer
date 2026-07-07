import { ContractNoteResult, Summary, Trade } from '../../types';
import { BrokerStrategy } from './types';
import { parseNumber, calculateReconciliation } from './utils';

/**
 * Parser for a broker "TRANSACTION REPORT" used to seed an account's historical
 * trades. Columns: DATE | TRANS TYPE | ASSET NAME | QTY | PRICE | BROKERAGE |
 * AMOUNT | BAL QTY. No ISIN, no STT/GST/etc — only brokerage.
 *
 * The CSV export is clean and tabular and is the reliable source (parseCsv).
 * The PDF lays the columns out in three separate blocks and mashes zero values,
 * so parsePdfText is best-effort only — prefer the CSV.
 */
export class TransactionReportBrokerStrategy implements BrokerStrategy {
  id = 'transaction-report';
  name = 'transaction-report';
  displayName = 'Broker Transaction Report';

  detect(content: string, _isPdf: boolean): boolean {
    const c = content.toUpperCase().replace(/\s+/g, '');
    // Full PDF/report title, OR just the tabular header (the CSV has no title).
    if (c.includes("TRANSACTIONREPORT") && c.includes("TRANSTYPE") && c.includes("BALQTY")) return true;
    return c.includes("TRANSTYPE") && c.includes("ASSETNAME") && c.includes("BALQTY") && c.includes("BROKERAGE");
  }

  async parseHtml(_html: string): Promise<ContractNoteResult | null> {
    return null;
  }

  /** Clean CSV path: DATE, TRANS TYPE, ASSET NAME, QTY, PRICE, BROKERAGE, AMOUNT, BAL QTY. */
  async parseCsv(text: string): Promise<ContractNoteResult | null> {
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) return null;

    const norm = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "");
    let cols: { date: number; type: number; name: number; qty: number; price: number; brok: number } | null = null;
    let headerIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 15); i++) {
      const cells = splitCsvLine(lines[i]).map(norm);
      const find = (...keys: string[]) => cells.findIndex(c => keys.some(k => c === k));
      const date = find("DATE", "TRADEDATE", "TXNDATE", "TRANSACTIONDATE"), type = find("TRANSTYPE", "TYPE"), name = find("ASSETNAME", "NAME", "SECURITY", "SCRIP");
      const qty = find("QTY", "QUANTITY"), price = find("PRICE", "RATE"), brok = find("BROKERAGE", "BROK");
      if (date >= 0 && type >= 0 && name >= 0 && qty >= 0 && price >= 0) {
        headerIdx = i;
        cols = { date, type, name, qty, price, brok };
        break;
      }
    }
    if (!cols || headerIdx < 0) return null;

    const trades: Trade[] = [];
    let id = 0;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const f = splitCsvLine(lines[i]);
      const date = (f[cols.date] || "").trim();
      const typeRaw = (f[cols.type] || "").trim().toUpperCase();
      const name = (f[cols.name] || "").trim();
      if (!date || !name) continue;
      if (typeRaw !== "BUY" && typeRaw !== "SELL") continue; // skip DIVIDEND / blanks
      const quantity = parseNumber(f[cols.qty] || "");
      if (quantity <= 0) continue;
      const avgPrice = parseNumber(f[cols.price] || "");
      const brokerage = cols.brok >= 0 ? parseNumber(f[cols.brok] || "") : 0;
      trades.push(this.makeTrade(`txr-c-${id++}`, date, typeRaw, name, quantity, avgPrice, brokerage));
    }

    return this.buildResult(trades, "");
  }

  async parsePdfText(text: string): Promise<ContractNoteResult | null> {
    if (!this.detect(text, true)) return null;

    const flat = text.replace(/\s+/g, ' ');

    // Portfolio code from "Portfolio Name / ID: Taparia Holdings / T059"
    let ucc = "";
    const uccMatch = flat.match(/Portfolio Name \/ ID ?:[^/]*\/ ?([A-Za-z0-9]{3,10})\b/i);
    if (uccMatch) ucc = uccMatch[1].trim().toUpperCase();

    // date + type + name(guarded) + qty price brokerage amount balqty, pinned to a row boundary
    const ROW_G = new RegExp(
      "(\\d{2}-\\d{2}-\\d{4}) (BUY|SELL|DIVIDEND) " +
      "((?:(?!\\d{2}-\\d{2}-\\d{4} (?:BUY|SELL|DIVIDEND) )(?!Page \\d+ of ).)+?) " +
      "([\\d,]+) ([\\d,]*\\.?\\d+) ([\\d,]*\\.?\\d+) ([\\d,]*\\.?\\d+) ([\\d,]+)" +
      "(?= \\d{2}-\\d{2}-\\d{4} | [A-Za-z]|$)",
      "g"
    );

    const trades: Trade[] = [];
    let id = 0;
    let m: RegExpExecArray | null;
    while ((m = ROW_G.exec(flat)) !== null) {
      const [, tradeDate, transType, assetName, qtyStr, priceStr, brokerageStr] = m;
      if (transType === "DIVIDEND") continue;
      const quantity = parseNumber(qtyStr);
      if (quantity <= 0) continue;
      trades.push(this.makeTrade(`txr-${id++}`, tradeDate, transType, assetName.trim(), quantity, parseNumber(priceStr), parseNumber(brokerageStr)));
    }

    return this.buildResult(trades, ucc);
  }

  /** One row → a Trade. Only brokerage is known; all statutory levies are 0. */
  private makeTrade(id: string, tradeDate: string, typeRaw: string, securityName: string, quantity: number, avgPrice: number, brokerage: number): Trade {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const turnover = r2(quantity * avgPrice);
    const transactionType = typeRaw === "BUY" ? "Buy" : "Sell";
    return {
      id,
      tradeDate,                       // per-row date (report spans many days), DD-MM-YYYY
      isin: "",                        // no ISIN in a transaction report — resolved by name downstream
      securityName,
      transactionType,
      quantity,
      avgPrice,
      turnover,
      tradeType: 'Delivery',           // no intraday signal in a transaction report
      netTotalBeforeLevies: transactionType === "Sell" ? turnover : -turnover,
      brokerage,
      stt: 0,
      etc: 0,
      sebiFees: 0,
      clearingCharges: 0,
      stampDuty: 0,
      ipf: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      gst: 0,
      totalExpensesInclSTT: brokerage,
      totalExpensesExclSTT: brokerage,
    };
  }

  private buildResult(trades: Trade[], ucc: string): ContractNoteResult | null {
    if (trades.length === 0) return null;
    const r2 = (n: number) => Math.round(n * 100) / 100;

    const totalBuys = trades.filter(t => t.transactionType === "Buy").reduce((s, t) => s + t.turnover, 0);
    const totalSells = trades.filter(t => t.transactionType === "Sell").reduce((s, t) => s + t.turnover, 0);
    const totalBrokerage = trades.reduce((s, t) => s + t.brokerage, 0);

    const summary: Summary = {
      payinObligation: r2(totalSells - totalBuys),
      stt: 0,
      taxableValue: r2(totalBrokerage),
      cgst: 0,
      sgst: 0,
      igst: 0,
      gst: 0,
      etc: 0,
      sebiFees: 0,
      clearingCharges: 0,
      stampDuty: 0,
      ipf: 0,
      netSettlement: r2(totalSells - totalBuys - totalBrokerage),
    };

    return {
      summary,
      trades,
      brokerName: 'transaction-report',
      tradeDate: "",
      ucc,
      reconciliation: calculateReconciliation(summary, trades),
    };
  }
}

/** CSV line splitter that respects double-quoted fields containing commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
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
