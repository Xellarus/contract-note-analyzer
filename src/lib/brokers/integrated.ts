import { ContractNoteResult, Summary, Trade, TransactionType, TradeType } from '../../types';
import { BrokerStrategy } from './types';
import {
  parseNumber,
  cleanText,
  isFootnoteOrDisclaimer,
  getTradeDate,
  calculateReconciliation
} from './utils';

export class IntegratedBrokerStrategy implements BrokerStrategy {
  id = 'integrated';
  name = 'Integrated';
  displayName = 'Integrated Enterprises';

  detect(content: string, isPdf: boolean): boolean {
    const text = content.toLowerCase();
    return text.includes("segment name") || 
           text.includes("capital market segment of national clearing") || 
           (text.includes("security/contract") && text.includes("buy/sell")) ||
           text.includes("integrated enterprises") || 
           text.includes("integrated e-mail");
  }

  async parseHtml(html: string): Promise<ContractNoteResult | null> {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const format = classifyFormat(html);
    
    let summaryData: any;
    let tradesData: any[];
    let tradeDate = "";

    if (format === "integrated") {
      summaryData = TmExtractSummaryIntegrated(doc);
      tradesData = xmExtractTradesIntegrated(doc);
      tradeDate = extractTradeDateFromHtml(doc);
    } else {
      summaryData = pmExtractSummaryStandard(doc);
      tradesData = SmExtractTradesStandard(doc);
      tradeDate = extractTradeDateFromHtml(doc);
    }

    if (tradesData.length === 0) return null;

    const finalSummary: Summary = {
      payinObligation: summaryData.payinObligation || 0,
      stt: summaryData.stt || 0,
      taxableValue: summaryData.taxableValue || 0,
      cgst: summaryData.cgst || 0,
      sgst: summaryData.sgst || 0,
      igst: summaryData.igst || 0,
      gst: summaryData.gst || 0,
      etc: summaryData.etc || 0,
      sebiFees: summaryData.sebiFees || 0,
      clearingCharges: summaryData.clearingCharges || 0,
      stampDuty: summaryData.stampDuty || 0,
      ipf: summaryData.ipf || 0,
      netSettlement: summaryData.netSettlement || 0
    };

    return this.finalizeContractNote(finalSummary, tradesData, tradeDate, "ih");
  }

  async parsePdfText(text: string): Promise<ContractNoteResult | null> {
    const summary = this.extractSummaryFromText(text);
    const tradeDate = getTradeDate(text);
    const rawTrades = this.extractTradesFromText(text);

    if (rawTrades.length === 0) return null;

    // Merge identical consecutive trades
    const merged: any[] = [];
    rawTrades.forEach(t => {
      const last = merged[merged.length - 1];
      if (last && last.securityName === t.securityName && last.type === t.type && Math.abs(last.price - t.price) < 0.001) {
          last.quantity += t.quantity;
          last.contextText = (last.contextText || "") + " " + (t.contextText || "");
      } else {
          merged.push({ ...t });
      }
    });

    return this.finalizeContractNote(summary, merged, tradeDate || "26-05-2026", "i");
  }

  private extractSummaryFromText(text: string): Summary {
    const s: Summary = { payinObligation: 0, stt: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, gst: 0, etc: 0, sebiFees: 0, clearingCharges: 0, stampDuty: 0, ipf: 0, netSettlement: 0 };
    const lines = text.split('\n');

    const getSummaryKeyFromLineText = (l: string): keyof Summary | null => {
      if (l.includes("pay in/pay out obligation") || l.includes("pay in / pay out obligation") || l.includes("pay-in/pay-out obligation") || l.includes("net obligation")) {
        return "payinObligation";
      } else if (l.includes("securities transaction tax") || l.includes("stt")) {
        return "stt";
      } else if (l.includes("taxable value of supply") || l.includes("taxable value") || l.includes("taxable value of services")) {
        return "taxableValue";
      } else if (l.includes("exchange transaction charges") || l.includes("exchange transaction charge") || (l.includes("exchange") && l.includes("charges"))) {
        return "etc";
      } else if (l.includes("clearing charges") || l.includes("clearing charge") || (l.includes("clearing") && l.includes("charge"))) {
        return "clearingCharges";
      } else if (l.includes("sebi turnover fees") || l.includes("sebi turnover fee") || l.includes("sebi turnover") || l.includes("sebi fees") || l.includes("sebi fee")) {
        return "sebiFees";
      } else if (l.includes("stamp duty")) {
        return "stampDuty";
      } else if (l.includes("ipf") || l.includes("investor protection fund") || l.includes("investor protection")) {
        return "ipf";
      } else if (l.includes("net amount receivable") || l.includes("net amount payable") || l.includes("net amount receivable/(payable)") || (l.includes("net amount") && (l.includes("receivable") || l.includes("payable")))) {
        return "netSettlement";
      } else if (l.includes("igst") || l.includes("integrated tax")) {
        return "igst";
      } else if (l.includes("sgst") || l.includes("utgst") || l.includes("state tax")) {
        return "sgst";
      } else if (l.includes("cgst") || l.includes("central tax") || (l.includes("gst") && !l.includes("gstin") && !l.includes("igst") && !l.includes("sgst") && !l.includes("cgst"))) {
        return "cgst";
      }
      return null;
    };

    // First, scan for the CM summary row if there is one
    let headerLineIdx = -1;
    let colMap: any = {};
    for (let i = 0; i < lines.length; i++) {
      const line = cleanText(lines[i]).toLowerCase();
      if (line.includes("exchange") && (line.includes("clg") || line.includes("corp")) && line.includes("contract")) {
        headerLineIdx = i;
        const tokens = lines[i].trim().split(/\s{2,}/);
        const cleanTokens = tokens.length >= 5 ? tokens.map(t => cleanText(t).toLowerCase()) : lines[i].trim().split(/\s+/).map(t => cleanText(t).toLowerCase());
        
        cleanTokens.forEach((t, idx) => {
          if (t.includes("payin") || t.includes("payout")) colMap.payin = idx;
          else if (t.includes("securities transaction") || t.includes("stt")) colMap.stt = idx;
          else if (t.includes("taxable value")) colMap.taxable = idx;
          else if (t.includes("cgst")) colMap.cgst = idx;
          else if (t.includes("sgst") || t.includes("utgst")) colMap.sgst = idx;
          else if (t.includes("igst")) colMap.igst = idx;
          else if (t.includes("exchange transaction") || (t.includes("transaction") && t.includes("charge"))) colMap.etc = idx;
          else if (t.includes("sebi")) colMap.sebi = idx;
          else if (t.includes("clearing") || t.includes("clg")) {
            if (!t.includes("exchange") && !t.includes("corp")) colMap.clearing = idx;
          } else if (t.includes("stamp")) colMap.stampDuty = idx;
          else if (t.includes("ipf") || t.includes("investor")) colMap.ipf = idx;
          else if (t.includes("net amount") || (t.includes("net") && t.includes("receivable"))) colMap.netSettlement = idx;
        });
        break;
      }
    }

    if (headerLineIdx !== -1) {
      for (let k = headerLineIdx + 1; k < Math.min(lines.length, headerLineIdx + 15); k++) {
        const lineText = cleanText(lines[k]).toLowerCase();
        if (!(lineText.includes("total") || lineText.match(/fo\/|fo |-fo/)) && lineText.match(/cm\/|cm |-cm|capital market|nse-cm|bse-cm/)) {
          const tokens = lines[k].trim().split(/\s+/).map(t => parseNumber(t));
          const numTokens = tokens.filter(t => !isNaN(t));
          if (numTokens.length >= 5) {
            const rawTokens = lines[k].trim().split(/\s+/);
            const getVal = (idx: number) => {
              if (idx !== undefined && rawTokens[idx]) {
                const val = parseNumber(rawTokens[idx]);
                return isNaN(val) ? 0 : val;
              }
              return 0;
            };

            if (colMap.payin !== undefined) s.payinObligation = Math.abs(getVal(colMap.payin));
            if (colMap.stt !== undefined) s.stt = Math.abs(getVal(colMap.stt));
            if (colMap.taxable !== undefined) s.taxableValue = Math.abs(getVal(colMap.taxable));
            if (colMap.cgst !== undefined) s.cgst = Math.abs(getVal(colMap.cgst));
            if (colMap.sgst !== undefined) s.sgst = Math.abs(getVal(colMap.sgst));
            if (colMap.igst !== undefined) s.igst = Math.abs(getVal(colMap.igst));
            if (colMap.etc !== undefined) s.etc = Math.abs(getVal(colMap.etc));
            if (colMap.sebi !== undefined) s.sebiFees = Math.abs(getVal(colMap.sebi));
            if (colMap.clearing !== undefined) s.clearingCharges = Math.abs(getVal(colMap.clearing));
            if (colMap.stampDuty !== undefined) s.stampDuty = Math.abs(getVal(colMap.stampDuty));
            if (colMap.ipf !== undefined) s.ipf = Math.abs(getVal(colMap.ipf));
            if (colMap.netSettlement !== undefined) s.netSettlement = getVal(colMap.netSettlement);
            
            return s;
          }
        }
      }
    }

    // Fallback line scanner
    for (const line of lines) {
      if (isFootnoteOrDisclaimer(line)) continue;
      const lowerLine = line.toLowerCase();
      if (lowerLine.includes("security name") || lowerLine.includes("isin") || lowerLine.includes("symbol")) continue;

      const key = getSummaryKeyFromLineText(lowerLine);
      if (key) {
        const tokens = line.trim().split(/\s+/);
        if (tokens.length >= 2) {
          for (let j = tokens.length - 1; j >= 0; j--) {
            const val = parseNumber(tokens[j]);
            if (!isNaN(val) && Math.abs(val) > 0) {
              const absVal = Math.abs(val);
              if (key === "netSettlement") {
                s.netSettlement = tokens[j].trim().startsWith("(") || tokens[j].trim().endsWith(")") ? -absVal : val;
              } else {
                s[key] = absVal;
              }
              break;
            }
          }
        }
      }
    }

    return s;
  }

  private extractTradesFromText(text: string): any[] {
    const trades: any[] = [];
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const lowerLine = line.toLowerCase();
      if (lowerLine.includes("security/contract") || lowerLine.includes("buy/sell") || lowerLine.includes("description") || lowerLine.includes("order no")) {
        continue;
      }
      if (lowerLine.includes("total") || lowerLine.includes("subtotal") || lowerLine.startsWith("page no")) {
        continue;
      }

      const tokens = line.split(/\s+/);
      if (tokens.length < 5) continue;

      const sideIdx = tokens.findIndex((t, idx) => {
        if (idx < 1 || idx + 2 >= tokens.length) return false;
        const u = t.toUpperCase();
        return u === 'BUY' || u === 'SELL' || u === 'B' || u === 'S';
      });

      if (sideIdx === -1) continue;

      const sideToken = tokens[sideIdx].toUpperCase();
      const side = (sideToken === 'BUY' || sideToken === 'B') ? 'Buy' : 'Sell';

      const qtyCandidate = tokens[sideIdx + 1];
      const priceCandidate = tokens[sideIdx + 2];
      const brokCandidate = tokens[sideIdx + 3] || "0";

      const qty = Math.abs(parseNumber(qtyCandidate));
      const price = parseNumber(priceCandidate);
      const brok = parseNumber(brokCandidate);

      if (isNaN(qty) || qty <= 0 || isNaN(price) || price <= 0 || isNaN(brok)) continue;

      let prefixString = tokens.slice(0, sideIdx).join(" ");
      
      const timeRegex = /\b\d{2}:\d{2}:\d{2}\b/g;
      let match;
      let lastTimeIndex = -1;
      while ((match = timeRegex.exec(prefixString)) !== null) {
        lastTimeIndex = match.index + match[0].length;
      }

      let securityPart = prefixString;
      if (lastTimeIndex !== -1) {
        securityPart = prefixString.substring(lastTimeIndex).trim();
      }

      securityPart = securityPart.replace(/^[\d\s\-\,\.\/]+/, "").trim();

      const name = securityPart
        .replace(/\s*-\s*\(?INE[A-Z0-9]{12}\)?/i, "")
        .replace(/\s*-\s*\(?INE[A-Z0-9]{10}\)?/i, "")
        .replace(/\s*\(?INE[A-Z0-9]{10,12}\)?/i, "")
        .trim();

      const lowerName = name.toLowerCase();

      if (lowerName.length < 2) continue;
      if (lowerName.includes("security") || lowerName.includes("contract") || lowerName.includes("description") || lowerName.includes("order no") || lowerName.includes("trade no")) continue;
      if (lowerName === "total" || lowerName === "subtotal" || lowerName.startsWith("page no") || lowerName === "buy" || lowerName === "sell") continue;

      trades.push({
        securityName: name,
        quantity: qty,
        price: price,
        brokeragePerShare: brok,
        type: side,
        contextText: line
      });
    }

    return trades;
  }

  private extractSummary(doc: Document): Summary {
    const s: Summary = { payinObligation: 0, stt: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, gst: 0, etc: 0, sebiFees: 0, clearingCharges: 0, stampDuty: 0, ipf: 0, netSettlement: 0 };

    const getSummaryKeyFromRowText = (l: string): keyof Summary | null => {
      if (l.includes("pay in/pay out obligation") || l.includes("pay in / pay out obligation") || l.includes("pay-in/pay-out obligation") || l.includes("net obligation")) {
        return "payinObligation";
      } else if (l.includes("securities transaction tax") || l.includes("stt")) {
        return "stt";
      } else if (l.includes("taxable value of supply") || l.includes("taxable value") || l.includes("taxable value of services")) {
        return "taxableValue";
      } else if (l.includes("exchange transaction charges") || l.includes("exchange transaction charge") || (l.includes("exchange") && l.includes("charge"))) {
        return "etc";
      } else if (l.includes("clearing charges") || l.includes("clearing charge") || (l.includes("clearing") && l.includes("charge"))) {
        return "clearingCharges";
      } else if (l.includes("sebi turnover fees") || l.includes("sebi turnover fee") || l.includes("sebi turnover") || l.includes("sebi fees") || l.includes("sebi fee")) {
        return "sebiFees";
      } else if (l.includes("stamp duty")) {
        return "stampDuty";
      } else if (l.includes("ipf") || l.includes("investor protection fund") || l.includes("investor protection")) {
        return "ipf";
      } else if (l.includes("net amount receivable") || l.includes("net amount payable") || l.includes("net amount receivable/(payable)") || (l.includes("net amount") && (l.includes("receivable") || l.includes("payable")))) {
        return "netSettlement";
      } else if (l.includes("igst") || l.includes("integrated tax")) {
        return "igst";
      } else if (l.includes("sgst") || l.includes("utgst") || l.includes("state tax")) {
        return "sgst";
      } else if (l.includes("cgst") || l.includes("central tax") || (l.includes("gst") && !l.includes("gstin") && !l.includes("igst") && !l.includes("sgst") && !l.includes("cgst"))) {
        return "cgst";
      }
      return null;
    };

    const getRowValue = (row: Element): number | null => {
      const cells = Array.from(row.querySelectorAll("td, th"));
      if (cells.length === 0) return null;
      for (let i = cells.length - 1; i >= 0; i--) {
        const text = (cells[i].textContent || "").trim();
        if (!text) continue;
        if (text.match(/[0-9]/)) {
          const num = parseNumber(text);
          if (!isNaN(num)) {
            return num;
          }
        }
      }
      return null;
    };

    const tables = Array.from(doc.querySelectorAll("table"));
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tr"));
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (isFootnoteOrDisclaimer(row.textContent)) continue;

        const text = cleanText(row.textContent);
        if (text.includes("security name") || text.includes("isin") || text.includes("symbol")) continue;

        if (text.includes("exchange") && (text.includes("clg") || text.includes("corp")) && text.includes("contract")) {
          const colMap: any = {};
          const cells = Array.from(row.querySelectorAll("td, th"));
          cells.forEach((c, idx) => {
            const t = cleanText(c.textContent);
            if (t.includes("payin") || t.includes("payout")) colMap.payin = idx;
            else if (t.includes("securities transaction") || t.includes("stt")) colMap.stt = idx;
            else if (t.includes("taxable value")) colMap.taxable = idx;
            else if (t.includes("cgst")) colMap.cgst = idx;
            else if (t.includes("sgst") || t.includes("utgst")) colMap.sgst = idx;
            else if (t.includes("igst")) colMap.igst = idx;
            else if (t.includes("exchange transaction") || (t.includes("transaction") && t.includes("charge"))) colMap.etc = idx;
            else if (t.includes("sebi")) colMap.sebi = idx;
            else if (t.includes("clearing") || t.includes("clg")) {
              if (!t.includes("exchange") && !t.includes("corp")) colMap.clearing = idx;
            } else if (t.includes("stamp")) colMap.stampDuty = idx;
            else if (t.includes("ipf") || t.includes("investor")) colMap.ipf = idx;
            else if (t.includes("net amount") || (t.includes("net") && t.includes("receivable"))) colMap.netSettlement = idx;
          });

          for (let k = i + 1; k < rows.length; k++) {
            const r = rows[k];
            const trtext = cleanText(r.textContent);
            if (!(trtext.includes("total") || trtext.match(/fo\/|fo |-fo/)) && trtext.match(/cm\/|cm |-cm|capital market|nse-cm|bse-cm/)) {
              const cRaw = Array.from(r.querySelectorAll("td"));
              if (colMap.payin !== undefined && cRaw[colMap.payin]) s.payinObligation = parseNumber(cRaw[colMap.payin].textContent);
              if (colMap.stt !== undefined && cRaw[colMap.stt]) s.stt = parseNumber(cRaw[colMap.stt].textContent);
              if (colMap.taxable !== undefined && cRaw[colMap.taxable]) s.taxableValue = parseNumber(cRaw[colMap.taxable].textContent);
              if (colMap.cgst !== undefined && cRaw[colMap.cgst]) s.cgst = parseNumber(cRaw[colMap.cgst].textContent);
              if (colMap.sgst !== undefined && cRaw[colMap.sgst]) s.sgst = parseNumber(cRaw[colMap.sgst].textContent);
              if (colMap.igst !== undefined && cRaw[colMap.igst]) s.igst = parseNumber(cRaw[colMap.igst].textContent);
              if (colMap.etc !== undefined && cRaw[colMap.etc]) s.etc = parseNumber(cRaw[colMap.etc].textContent);
              if (colMap.sebi !== undefined && cRaw[colMap.sebi]) s.sebiFees = parseNumber(cRaw[colMap.sebi].textContent);
              if (colMap.clearing !== undefined && cRaw[colMap.clearing]) s.clearingCharges = parseNumber(cRaw[colMap.clearing].textContent);
              if (colMap.stampDuty !== undefined && cRaw[colMap.stampDuty]) s.stampDuty = parseNumber(cRaw[colMap.stampDuty].textContent);
              if (colMap.ipf !== undefined && cRaw[colMap.ipf]) s.ipf = parseNumber(cRaw[colMap.ipf].textContent);
              if (colMap.netSettlement !== undefined && cRaw[colMap.netSettlement]) s.netSettlement = parseNumber(cRaw[colMap.netSettlement].textContent);
              break;
            }
          }
        } else {
          const key = getSummaryKeyFromRowText(text);
          if (key) {
            const val = getRowValue(row);
            if (val !== null && !isNaN(val)) {
              const absVal = Math.abs(val);
              if (key === "netSettlement") {
                s.netSettlement = val;
              } else if (absVal > 0 || s[key] === 0) {
                s[key] = absVal;
              }
            }
          }
        }
      }
    }
    return s;
  }

  private finalizeContractNote(summary: Summary, rawTrades: any[], tradeDate: string, prefix: string): ContractNoteResult {
    const rt = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

    const exchangeNames = ["NSE", "BSE", "MCX", "NCDEX"];
    const validatedTrades = rawTrades.filter(t => {
      if (!t.securityName || t.securityName.trim().length === 0) return false;
      const cleanName = t.securityName.trim().toUpperCase();
      if (exchangeNames.includes(cleanName)) return false;
      if (t.quantity >= 10000000) return false;
      return t.quantity > 0 && t.price > 0;
    });

    let tradesToProcess = validatedTrades;
    const groupMap = new Map<string, Map<string, any[]>>();
    validatedTrades.forEach(t => {
      const name = t.securityName.trim();
      const type = t.type;
      if (!groupMap.has(name)) {
        groupMap.set(name, new Map());
      }
      const typeMap = groupMap.get(name)!;
      if (!typeMap.has(type)) {
        typeMap.set(type, []);
      }
      typeMap.get(type)!.push(t);
    });

    tradesToProcess = [];
    groupMap.forEach((typeMap, name) => {
      typeMap.forEach((items, type) => {
        const totalQty = items.reduce((sum: number, x: any) => sum + x.quantity, 0);
        const totalTurnover = items.reduce((sum: number, x: any) => sum + (x.quantity * x.price), 0);
        const totalBrokerage = items.reduce((sum: number, x: any) => sum + (x.quantity * (x.brokeragePerShare || 0)), 0);
        
        const avgPrice = totalQty > 0 ? (totalTurnover / totalQty) : 0;
        const avgBrokerage = totalQty > 0 ? (totalBrokerage / totalQty) : 0;
        
        const mergedContext = items.map((x: any) => x.contextText || "").join(" ");
        
        tradesToProcess.push({
          securityName: name,
          type: type,
          quantity: totalQty,
          price: avgPrice,
          brokeragePerShare: avgBrokerage,
          contextText: mergedContext
        });
      });
    });

    const securityStats = new Map();
    tradesToProcess.forEach(t => {
      if (!securityStats.has(t.securityName)) securityStats.set(t.securityName, { buyQty: 0, sellQty: 0, types: new Set() });
      const s = securityStats.get(t.securityName);
      s.types.add(t.type);
      if (t.type === "Buy") s.buyQty += t.quantity; else s.sellQty += t.quantity;
    });

    const totalTurnover = tradesToProcess.reduce((sum, t) => sum + (t.quantity * t.price), 0);
    const totalBuyTurnover = tradesToProcess.reduce((sum, t) => t.type === "Buy" ? sum + (t.quantity * t.price) : sum, 0);

    // --- Stamp Duty Pre-calculation ---
    const STAMP_DELIVERY  = 0.00015;    // 0.015%
    const STAMP_INTRADAY  = 0.00003;    // 0.003%

    const deliveryBuyTurnover = tradesToProcess.reduce((sum, t) => {
      const s = securityStats.get(t.securityName);
      let isIntraday = false;
      const textToCheck = ((t.contextText || "") + " " + t.securityName).toLowerCase();
      const hasIntradayKeyword = textToCheck.includes("intraday") || textToCheck.includes("intra-day") || textToCheck.includes("day trade") || textToCheck.includes("day-trade") || /\bmis\b/i.test(textToCheck);
      const hasDeliveryKeyword = textToCheck.includes("delivery") || textToCheck.includes("delv") || /\bcnc\b/i.test(textToCheck) || textToCheck.includes("carry forward") || textToCheck.includes("carry-forward");
      if (hasIntradayKeyword && !hasDeliveryKeyword) isIntraday = true;
      else if (hasDeliveryKeyword && !hasIntradayKeyword) isIntraday = false;
      else isIntraday = (s.buyQty > 0 && s.sellQty > 0);

      return (!isIntraday && t.type === "Buy") ? sum + (t.quantity * t.price) : sum;
    }, 0);

    const intradayBuyTurnover = tradesToProcess.reduce((sum, t) => {
      const s = securityStats.get(t.securityName);
      let isIntraday = false;
      const textToCheck = ((t.contextText || "") + " " + t.securityName).toLowerCase();
      const hasIntradayKeyword = textToCheck.includes("intraday") || textToCheck.includes("intra-day") || textToCheck.includes("day trade") || textToCheck.includes("day-trade") || /\bmis\b/i.test(textToCheck);
      const hasDeliveryKeyword = textToCheck.includes("delivery") || textToCheck.includes("delv") || /\bcnc\b/i.test(textToCheck) || textToCheck.includes("carry forward") || textToCheck.includes("carry-forward");
      if (hasIntradayKeyword && !hasDeliveryKeyword) isIntraday = true;
      else if (hasDeliveryKeyword && !hasIntradayKeyword) isIntraday = false;
      else isIntraday = (s.buyQty > 0 && s.sellQty > 0);

      return (isIntraday && t.type === "Buy") ? sum + (t.quantity * t.price) : sum;
    }, 0);

    const theoreticalDelivery = deliveryBuyTurnover * STAMP_DELIVERY;
    const theoreticalIntraday = intradayBuyTurnover * STAMP_INTRADAY;

    let intradayFactor = 1;
    const summaryStampDuty = summary.stampDuty || 0;

    if (summaryStampDuty > 0) {
      const intradayBalance = Math.max(0, summaryStampDuty - theoreticalDelivery);
      if (theoreticalIntraday > 0) {
        intradayFactor = intradayBalance / theoreticalIntraday;
      }
    }

    const noTheoretical = theoreticalDelivery === 0 && theoreticalIntraday === 0 && summaryStampDuty > 0;

    // --- End Stamp Duty Pre-calculation ---

    const trades: Trade[] = tradesToProcess.map((t, idx) => {
      const s = securityStats.get(t.securityName);
      let isIntraday = false;
      const textToCheck = ((t.contextText || "") + " " + t.securityName).toLowerCase();
      
      const hasIntradayKeyword = textToCheck.includes("intraday") || 
                                 textToCheck.includes("intra-day") || 
                                 textToCheck.includes("day trade") || 
                                 textToCheck.includes("day-trade") ||
                                 /\bmis\b/i.test(textToCheck);
                                 
      const hasDeliveryKeyword = textToCheck.includes("delivery") || 
                                 textToCheck.includes("delv") || 
                                 /\bcnc\b/i.test(textToCheck) || 
                                 textToCheck.includes("carry forward") || 
                                 textToCheck.includes("carry-forward");
      
      if (hasIntradayKeyword && !hasDeliveryKeyword) {
        isIntraday = true;
      } else if (hasDeliveryKeyword && !hasIntradayKeyword) {
        isIntraday = false;
      } else {
        if (s.buyQty > 0 && s.sellQty > 0) {
          isIntraday = true;
        } else {
          isIntraday = false;
        }
      }

      const grossTotal = rt(t.quantity * t.price);
      const ratio = totalTurnover > 0 ? grossTotal / totalTurnover : 0;

      // Brokerage: quantity * brokeragePerShare
      const brokerage = rt(t.quantity * (t.brokeragePerShare || 0));
      
      // STT Delivery: 0.1% on buy and sell transactions
      // STT Intraday: 0.025% on sell side, but 0 if fully matched (buyQty === sellQty)
      const getStt = () => {
        if (t.securityName.toLowerCase().includes("liquidbees")) return 0;
        if (!isIntraday) {
          return Math.round(grossTotal * 0.001);
        } else {
          if (s.buyQty === s.sellQty) return 0;
          return t.type === "Sell" ? Math.round(grossTotal * 0.00025) : 0;
        }
      };
      const stt = getStt();

      const etc = rt(summary.etc * ratio);
      const sebiFees = rt(summary.sebiFees * ratio);
      const clearingCharges = rt(summary.clearingCharges * ratio);
      const ipf = rt(summary.ipf * ratio);

      // Stamp Duty pre-calculated
      let stampDuty = 0;
      if (t.type === "Buy") {
        if (noTheoretical && totalBuyTurnover > 0) {
          stampDuty = rt((grossTotal / totalBuyTurnover) * summaryStampDuty);
        } else if (!isIntraday) {
          stampDuty = rt(grossTotal * STAMP_DELIVERY);
        } else {
          stampDuty = rt(grossTotal * STAMP_INTRADAY * intradayFactor);
        }
      }

      // GST: 18% of (brokerage + etc + sebiFees + clearingCharges)
      const gst = rt((brokerage + etc + sebiFees + clearingCharges) * 0.18);
      
      const cgst = rt(gst / 2);
      const sgst = rt(gst / 2);
      const igst = 0;

      const totalExclSTT = brokerage + etc + sebiFees + clearingCharges + stampDuty + ipf + gst;
      const totalInclSTT = totalExclSTT + stt;

      return { 
          id: `tx-${prefix}-${idx}`, 
          tradeDate, 
          securityName: t.securityName, 
          transactionType: t.type as TransactionType, 
          quantity: t.quantity, 
          avgPrice: t.price, 
          turnover: grossTotal,
          tradeType: isIntraday ? "Intraday" : "Delivery",
          netTotalBeforeLevies: t.type === "Sell" ? grossTotal : -grossTotal,
          brokerage,
          stt,
          etc,
          sebiFees,
          clearingCharges,
          stampDuty,
          ipf,
          cgst,
          sgst,
          igst,
          gst,
          totalExpensesInclSTT: rt(totalInclSTT),
          totalExpensesExclSTT: rt(totalExclSTT)
      };
    });

    const brokerName = "integrated";

    // Re-sum GST/taxes and taxable value in summary to match calculated if needed
    const sumBrokerage = rt(trades.reduce((sum, tr) => sum + tr.brokerage, 0));
    if (summary.taxableValue === 0 || Math.abs(summary.taxableValue - sumBrokerage) > 1.0) {
      summary.taxableValue = sumBrokerage;
    }

    const sumGst = rt(trades.reduce((sum, tr) => sum + tr.gst, 0));
    if (summary.gst === 0 || Math.abs(summary.gst - sumGst) > 1.0) {
      summary.gst = sumGst;
      summary.cgst = rt(sumGst / 2);
      summary.sgst = rt(sumGst / 2);
      summary.igst = 0;
    }

    const reconciliation = calculateReconciliation(summary, trades);
    return { summary, trades, brokerName, tradeDate, reconciliation };
  }
}

// Standalone helper functions for Integrated Enterprises multi-format HTML parsing
function cleanNumValue(s: string | null | undefined): number {
  if (!s) return 0;
  let str = s.trim();
  if (str.includes("(") && str.includes(")")) {
    str = "-" + str.replace(/[()]/g, "");
  }
  const cleaned = str.replace(/,/g, "").replace(/[^\d.-]/g, "");
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : val;
}

function cleanTextLower(s: string | null | undefined): string {
  return (s?.toLowerCase().replace(/\s+/g, " ").trim()) || "";
}

function classifyFormat(html: string): "integrated" | "standard" {
  const g = html.toLowerCase();
  return (g.includes("segment name") || g.includes("capital market segment of national clearing") || (g.includes("security/contract") && g.includes("buy/sell"))) ? "integrated" : "standard";
}

function extractTradeDateFromHtml(doc: Document): string {
  const elements = Array.from(doc.querySelectorAll("td, th, p, span, div, b, strong, font"));
  const regex = /(\d{2}[-/]\d{2}[-/]\d{4})|(\d{4}[-/]\d{2}[-/]\d{2})/;
  for (const el of elements) {
    if (cleanTextLower(el.textContent).includes("trade date")) {
      const match = el.textContent?.match(regex);
      if (match) return match[0];
      let sibling = el.nextElementSibling;
      let count = 0;
      while (sibling && count < 3) {
        const text = sibling.textContent || "";
        const m = text.match(regex);
        if (m) return m[0];
        if (text.trim().length > 0) count++;
        sibling = sibling.nextElementSibling;
      }
    }
  }
  return "";
}

function pmExtractSummaryStandard(doc: Document): any {
  const g = {
    payinObligation: 0,
    stt: 0,
    taxableValue: 0,
    cgst: 0,
    sgst: 0,
    etc: 0,
    sebiFees: 0,
    clearingCharges: 0,
    stampDuty: 0,
    ipf: 0
  };
  const tables = Array.from(doc.querySelectorAll("table"));
  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll("tr"));
    for (let X = 0; X < rows.length; X++) {
      const row = rows[X];
      const j = cleanTextLower(row.textContent);
      if (j.includes("security name") || j.includes("isin") || j.includes("symbol")) continue;
      if (
        j.includes("payin") ||
        j.includes("payout") ||
        j.includes("stt") ||
        j.includes("securities transaction") ||
        j.includes("taxable value") ||
        j.includes("stamp duty") ||
        j.includes("sebi") ||
        j.includes("cgst") ||
        j.includes("sgst") ||
        j.includes("transaction charge")
      ) {
        const p = Array.from(row.querySelectorAll("td, th"));
        if (j.includes("exchange") && (j.includes("clg") || j.includes("corp"))) {
          const colMap: any = {};
          p.forEach((cell, idx) => {
            const N = cleanTextLower(cell.textContent);
            if (N.includes("payin") || N.includes("payout")) colMap.payin = idx;
            else if (N.includes("securities transaction") || N.includes("stt")) colMap.stt = idx;
            else if (N.includes("taxable value")) colMap.taxable = idx;
            else if (N.includes("cgst")) colMap.cgst = idx;
            else if (N.includes("sgst") || N.includes("utgst")) colMap.sgst = idx;
            else if (N.includes("exchange transaction") || (N.includes("transaction") && N.includes("charge"))) colMap.etc = idx;
            else if (N.includes("sebi")) colMap.sebi = idx;
            else if (N.includes("clearing") || N.includes("clg")) {
              if (!N.includes("exchange") && !N.includes("corp")) colMap.clearing = idx;
            } else if (N.includes("stamp")) colMap.stampDuty = idx;
            else if (N.includes("ipf") || N.includes("investor")) colMap.ipf = idx;
          });
          for (let K = X + 1; K < rows.length; K++) {
            const nextRow = rows[K];
            const N = cleanTextLower(nextRow.textContent);
            if (
              !(N.includes("total") || N.includes("fo/") || N.includes("fo ") || N.includes("-fo")) &&
              (N.includes("cm/") || N.includes("cm ") || N.includes("-cm") || N.includes("capital market") || N.includes("nse-cm") || N.includes("bse-cm"))
            ) {
              const O = Array.from(nextRow.querySelectorAll("td"));
              if (colMap.payin !== undefined && O[colMap.payin]) {
                const R = cleanNumValue(O[colMap.payin].textContent);
                if (R !== 0) g.payinObligation = R;
              }
              if (colMap.stt !== undefined && O[colMap.stt]) {
                const R = cleanNumValue(O[colMap.stt].textContent);
                if (R !== 0) g.stt = R;
              }
              if (colMap.taxable !== undefined && O[colMap.taxable]) {
                const R = cleanNumValue(O[colMap.taxable].textContent);
                if (R !== 0) g.taxableValue = R;
              }
              if (colMap.cgst !== undefined && O[colMap.cgst]) {
                const R = cleanNumValue(O[colMap.cgst].textContent);
                if (R !== 0) g.cgst = R;
              }
              if (colMap.sgst !== undefined && O[colMap.sgst]) {
                const R = cleanNumValue(O[colMap.sgst].textContent);
                if (R !== 0) g.sgst = R;
              }
              if (colMap.etc !== undefined && O[colMap.etc]) {
                const R = cleanNumValue(O[colMap.etc].textContent);
                if (R !== 0) g.etc = R;
              }
              if (colMap.sebi !== undefined && O[colMap.sebi]) {
                const R = cleanNumValue(O[colMap.sebi].textContent);
                if (R !== 0) g.sebiFees = R;
              }
              if (colMap.clearing !== undefined && O[colMap.clearing]) {
                const R = cleanNumValue(O[colMap.clearing].textContent);
                if (R !== 0) g.clearingCharges = R;
              }
              if (colMap.stampDuty !== undefined && O[colMap.stampDuty]) {
                const R = cleanNumValue(O[colMap.stampDuty].textContent);
                if (R !== 0) g.stampDuty = R;
              }
              if (colMap.ipf !== undefined && O[colMap.ipf]) {
                const R = cleanNumValue(O[colMap.ipf].textContent);
                if (R !== 0) g.ipf = R;
              }
              break;
            }
          }
        } else {
          const nextRow = rows[X + 1];
          if (!nextRow) continue;
          const K = Array.from(nextRow.querySelectorAll("td"));
          p.forEach((cell, idx) => {
            const O = cleanTextLower(cell.textContent);
            const R = K[idx] ? cleanNumValue(K[idx].textContent) : 0;
            if (R !== 0) {
              if (O.includes("payin") || O.includes("payout")) g.payinObligation = R;
              else if (O.includes("securities transaction") || O.includes("stt") || (O.includes("trans") && O.includes("tax") && !O.includes("exchange"))) g.stt = R;
              else if (O.includes("taxable value")) g.taxableValue = R;
              else if (O.includes("cgst")) g.cgst = R;
              else if (O.includes("sgst") || O.includes("utgst")) g.sgst = R;
              else if (O.includes("exchange transaction") || O.includes("transaction charge")) g.etc = R;
              else if (O.includes("sebi turnover") || O.includes("sebi fee")) g.sebiFees = R;
              else if (O.includes("exchange clearing") || O.includes("clearing chrg")) g.clearingCharges += R;
              else if (O.includes("stamp duty")) g.stampDuty = R;
              else if (O.includes("ipf") || O.includes("investor protection")) g.ipf = R;
            }
          });
        }
      }
    }
  }
  return g;
}

function SmExtractTradesStandard(doc: Document): any[] {
  const g: any[] = [];
  const tables = Array.from(doc.querySelectorAll("table"));
  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll("tr"));
    const W = rows.findIndex(row => {
      const C = cleanTextLower(row.textContent);
      return (C.includes("security name") || C.includes("security description") || C.includes("symbol")) && (C.includes("quantity") || C.includes("qty"));
    });
    if (W !== -1) {
      const j = rows[W];
      const C = Array.from(j.querySelectorAll("td, th"));
      let p = -1, L = -1, A = -1;
      const K: number[] = [], F: number[] = [], N: number[] = [];
      C.forEach((O, R) => {
        const I = cleanTextLower(O.textContent);
        if (!(I.startsWith("net") || I.includes("net ") || I.includes("obligation"))) {
          if (I.includes("security name") || I.includes("symbol") || I.includes("security description")) p = R;
          if (I.includes("quantity") || I.includes("qty")) {
            if (I.includes("buy")) L = R;
            else if (I.includes("sell")) A = R;
            else K.push(R);
          }
          if ((I.includes("wap") || I.includes("rate") || I.includes("price")) && !I.includes("total value")) F.push(R);
          if (I.includes("brokerage") && I.includes("share")) N.push(R);
        }
      });
      if (L === -1 && A === -1 && K.length >= 2) {
        L = K[0];
        A = K[1];
      }
      if (L !== -1 && A !== -1 && p !== -1) {
        const getNearestColumn = (targetCol: number, colList: number[]): number => {
          const valid = colList.filter(q => q > targetCol);
          valid.sort((q, at) => q - at);
          return valid.length > 0 ? valid[0] : -1;
        };
        const R = getNearestColumn(L, F);
        const I = getNearestColumn(L, N);
        const ut = getNearestColumn(A, F);
        const T = getNearestColumn(A, N);
        for (let d = W + 1; d < rows.length; d++) {
          const nextRow = rows[d];
          const Y = Array.from(nextRow.querySelectorAll("td"));
          if (!Y[p]) continue;
          const q = Y[p].textContent?.trim();
          if (q && !cleanTextLower(q).startsWith("total") && !cleanTextLower(q).startsWith("net")) {
            if (Y[L]) {
              const at = cleanNumValue(Y[L].textContent);
              if (at > 0) {
                const Ht = R !== -1 && Y[R] ? cleanNumValue(Y[R].textContent) : 0;
                const kt = I !== -1 && Y[I] ? cleanNumValue(Y[I].textContent) : 0;
                g.push({ securityName: q, quantity: at, price: Ht, brokeragePerShare: kt, type: "Buy" });
              }
            }
            if (Y[A]) {
              const at = cleanNumValue(Y[A].textContent);
              if (at > 0) {
                const Ht = ut !== -1 && Y[ut] ? cleanNumValue(Y[ut].textContent) : 0;
                const kt = T !== -1 && Y[T] ? cleanNumValue(Y[T].textContent) : 0;
                g.push({ securityName: q, quantity: at, price: Ht, brokeragePerShare: kt, type: "Sell" });
              }
            }
          }
        }
      }
      if (g.length > 0) return g;
    }
  }
  return g;
}

function TmExtractSummaryIntegrated(doc: Document): any {
  const g = {
    payinObligation: 0,
    stt: 0,
    taxableValue: 0,
    cgst: 0,
    sgst: 0,
    etc: 0,
    sebiFees: 0,
    clearingCharges: 0,
    stampDuty: 0,
    ipf: 0
  };
  const tables = Array.from(doc.querySelectorAll("table"));
  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll("tr"));
    for (let X = 0; X < rows.length; X++) {
      const row = rows[X];
      const j = cleanTextLower(row.textContent);
      if (j.includes("security name") || (j.includes("quantity") && j.includes("price"))) continue;
      if (
        j.includes("payin") ||
        j.includes("stt") ||
        (j.includes("securities") && j.includes("tax")) ||
        (j.includes("exchange") && j.includes("charge")) ||
        j.includes("transaction charge") ||
        j.includes("taxable value") ||
        j.includes("sebi") ||
        j.includes("stamp") ||
        j.includes("cgst")
      ) {
        const p = Array.from(row.querySelectorAll("td, th"));
        const L = rows[X + 1];
        if (!L) continue;
        const A = Array.from(L.querySelectorAll("td"));
        p.forEach((cell, idx) => {
          const N = cleanTextLower(cell.textContent);
          const O = A[idx] ? cleanNumValue(A[idx].textContent) : 0;
          if (O !== 0) {
            if (N.includes("payin") || N.includes("payout")) g.payinObligation = O;
            else if (N.includes("securities transaction") || N.includes("stt")) g.stt = O;
            else if (N.includes("taxable value")) g.taxableValue = O;
            else if (N.includes("cgst")) g.cgst = O;
            else if (N.includes("sgst") || N.includes("utgst")) g.sgst = O;
            else if (N.includes("sebi")) g.sebiFees = O;
            else if (N.includes("stamp")) g.stampDuty = O;
            else if (N.includes("ipf") || N.includes("investor")) g.ipf = O;
            else if (N.includes("clearing") || N.includes("clg")) g.clearingCharges += O;
            else if (
              (N.includes("exchange") || (N.includes("turnover") && N.includes("charge")) || (N.includes("trans") && N.includes("charge"))) &&
              !N.includes("clearing") && !N.includes("sebi")
            ) {
              g.etc = O;
            }
          }
        });
      }
    }
  }
  return g;
}

function xmExtractTradesIntegrated(doc: Document): any[] {
  const g: any[] = [];
  const tables = Array.from(doc.querySelectorAll("table"));
  const segments = [
    "capital market segment of national clearing ltd. (exchange : nse)",
    "capital market segment of national clearing ltd. (exchange : bse)"
  ];
  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll("tr"));
    let F = "";
    const N = { security: -1, type: -1, qty: -1, price: -1, brokerage: -1, net: -1, netIsRate: true };
    let O = false;
    for (let R = 0; R < rows.length; R++) {
      const row = rows[R];
      const cells = Array.from(row.querySelectorAll("td, th"));
      const T = cleanTextLower(row.textContent);
      if (T.includes("segment name")) {
        F = T.replace("segment name", "").trim();
        continue;
      }
      if (T.includes("security/contract") && T.includes("quantity")) {
        cells.forEach((cell, idx) => {
          const q = cleanTextLower(cell.textContent);
          if (q.includes("security") || q.includes("contract")) N.security = idx;
          else if (q.includes("buy") && q.includes("sell")) N.type = idx;
          else if (q.includes("quantity")) N.qty = idx;
          else if (q.includes("gross rate") || q.includes("trade price")) {
            if (N.price === -1) N.price = idx;
          } else if (q.includes("brokerage")) N.brokerage = idx;
          else if (q.includes("net rate") || q.includes("net value") || q.includes("net amount") || q.includes("net total")) {
            N.net = idx;
            N.netIsRate = q.includes("rate") || q.includes("price");
          }
        });
        if (N.security !== -1 && N.qty !== -1) O = true;
        continue;
      }
      const matchedSegment = segments.some(seg => F.includes(seg));
      if (O && matchedSegment) {
        if (cells.length < 5) continue;
        const securityCell = cells[N.security];
        const B = securityCell?.textContent?.trim();
        if (!B || cleanTextLower(B).includes("total")) continue;
        const typeStr = cells[N.type] ? cleanTextLower(cells[N.type].textContent) : "";
        const q = typeStr.includes("buy") ? "Buy" : typeStr.includes("sell") ? "Sell" : null;
        const qtyVal = cells[N.qty] ? cleanNumValue(cells[N.qty].textContent) : 0;
        if (q && qtyVal > 0) {
          const brokerageVal = N.brokerage !== -1 && cells[N.brokerage] ? cleanNumValue(cells[N.brokerage].textContent) : 0;
          let priceVal = 0;
          if (N.net !== -1 && cells[N.net]) {
            let Ft = Math.abs(cleanNumValue(cells[N.net].textContent));
            if (N.netIsRate) Ft = Ft * qtyVal;
            const Qt = brokerageVal * qtyVal;
            let zl = 0;
            if (q === "Buy") {
              zl = Ft - Qt;
            } else {
              zl = Ft + Qt;
            }
            priceVal = zl / qtyVal;
          } else if (N.price !== -1 && cells[N.price]) {
            priceVal = cleanNumValue(cells[N.price].textContent);
          }
          g.push({ securityName: B, quantity: qtyVal, price: priceVal, brokeragePerShare: brokerageVal, type: q });
        }
      }
    }
  }
  return g;
}
