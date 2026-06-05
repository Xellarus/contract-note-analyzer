import { ContractNoteResult, Summary, Trade, TransactionType, TradeType } from '../../types';
import { BrokerStrategy } from './types';
import {
  parseNumber,
  cleanText,
  isFootnoteOrDisclaimer,
  getTradeDate,
  calculateReconciliation
} from './utils';

export class ShareIndiaBrokerStrategy implements BrokerStrategy {
  id = 'shareindia';
  name = 'Share India';
  displayName = "Share India's Contract Note";

  detect(content: string, isPdf: boolean): boolean {
    const text = content.toLowerCase();
    return text.includes("share india") || text.includes("shareindia") || text.includes("share_india");
  }

  // parseHtml handles extracting summary and trades from a DOM Document if available
  async parseHtml(html: string): Promise<ContractNoteResult | null> {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const summary = this.extractSummary(doc);
    const tradeDate = getTradeDate(doc);
    const rawTrades = this.extractTrades(doc);

    if (rawTrades.length === 0) return null;

    // Merge identical consecutive trades for consistency
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

    return this.finalizeContractNote(summary, merged, tradeDate ?? "26-05-2026", "s");
  }

  // parsePdfText handles extracting summary and trades from plain text
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

    return this.finalizeContractNote(summary, merged, tradeDate ?? "26-05-2026", "s");
  }

  private extractSummary(doc: Document): Summary {
    const s: Summary = { payinObligation: 0, stt: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, gst: 0, etc: 0, sebiFees: 0, clearingCharges: 0, stampDuty: 0, ipf: 0, netSettlement: 0 };

    const tables = Array.from(doc.querySelectorAll("table"));
    for (const table of tables) {
      const text = cleanText(table.textContent).toLowerCase();
      // Look for Share India's Obligation Details table
      if (text.includes("obligation details") || text.includes("pay in/ pay out obligation") || text.includes("ncl cm")) {
         const rows = Array.from(table.querySelectorAll("tr"));
         
         // Dynamically find and map headers
         let headerRow: HTMLTableRowElement | null = null;
         for (const row of rows) {
           const rowText = cleanText(row.textContent).toLowerCase();
           if (rowText.includes("securities transaction") || rowText.includes("taxable value") || rowText.includes("igst")) {
             headerRow = row;
             break;
           }
         }

         if (headerRow) {
           const headers = Array.from(headerRow.querySelectorAll("td, th")).map(c => cleanText(c.textContent).toLowerCase());
           for (const row of rows) {
             const rowText = cleanText(row.textContent).toLowerCase();
             if (rowText.includes("total(net)") || rowText.includes("total (net)") || rowText.includes("ncl cm")) {
               const cells = Array.from(row.querySelectorAll("td, th"));
               
               headers.forEach((header, idx) => {
                 if (idx >= cells.length) return;
                 const cellVal = parseNumber(cells[idx].textContent);
                 if (isNaN(cellVal)) return;
                 const absVal = Math.abs(cellVal);

                 if (header.includes("pay in") || header.includes("net obligation") || header.includes("obligation")) {
                   s.payinObligation = absVal;
                 } else if (header.includes("transaction tax") || header.includes("stt")) {
                   s.stt = absVal;
                 } else if (header.includes("taxable value")) {
                   s.taxableValue = absVal;
                 } else if (header.includes("cgst")) {
                   s.cgst = absVal;
                 } else if (header.includes("sgst")) {
                   s.sgst = absVal;
                 } else if (header.includes("igst")) {
                   s.igst = absVal;
                 } else if (header.includes("exchange transaction") || header.includes("etc") || header.includes("exchange charge")) {
                   s.etc = absVal;
                 } else if (header.includes("sebi turnover") || header.includes("sebi fee") || header.includes("sebi turnover fee")) {
                   s.sebiFees = absVal;
                 } else if (header.includes("stamp duty")) {
                   s.stampDuty = absVal;
                 } else if (header.includes("receivable") || header.includes("payable")) {
                   s.netSettlement = cellVal;
                 }
               });
               
               if (s.taxableValue > 0 || s.stt > 0 || Math.abs(s.netSettlement) > 0) {
                 if (s.igst === 0) {
                   const numbers: number[] = [];
                   cells.forEach(c => {
                     const val = parseNumber(c.textContent);
                     if (!isNaN(val)) numbers.push(val);
                   });
                   if (numbers.length >= 12) {
                     const offset = numbers.length - 12;
                     s.igst = Math.abs(numbers[offset + 6]);
                   } else if (numbers.length === 11) {
                     s.igst = Math.abs(numbers[5]);
                   }
                 }
                 return s;
               }
             }
           }
         }

         // Static fallback
         for (const row of rows) {
           const rowText = cleanText(row.textContent).toLowerCase();
           if (rowText.includes("total(net)") || rowText.includes("total (net)") || rowText.includes("ncl cm")) {
             const cells = Array.from(row.querySelectorAll("td, th"));
             const numbers: number[] = [];
             cells.forEach(c => {
               const val = parseNumber(c.textContent);
               if (!isNaN(val)) {
                 numbers.push(val);
               }
             });

             if (numbers.length === 11) {
               s.payinObligation = Math.abs(numbers[0]);
               s.stt = Math.abs(numbers[1]);
               s.taxableValue = Math.abs(numbers[2]);
               s.cgst = Math.abs(numbers[3]);
               s.sgst = Math.abs(numbers[4]);
               s.igst = Math.abs(numbers[5]);
               s.etc = Math.abs(numbers[6]);
               s.sebiFees = Math.abs(numbers[8]);
               s.stampDuty = Math.abs(numbers[9]);
               s.netSettlement = numbers[10];
               return s;
             } else if (numbers.length >= 12) {
               const offset = numbers.length - 12;
               s.payinObligation = Math.abs(numbers[offset + 0]);
               s.stt = Math.abs(numbers[offset + 1]);
               s.taxableValue = Math.abs(numbers[offset + 2]);
               s.cgst = Math.abs(numbers[offset + 3]);
               s.sgst = Math.abs(numbers[offset + 4]);
               // UTT mapping is offset + 5
               s.igst = Math.abs(numbers[offset + 6]);
               s.etc = Math.abs(numbers[offset + 7]);
               // Infra mapping is offset + 8
               s.sebiFees = Math.abs(numbers[offset + 9]);
               s.stampDuty = Math.abs(numbers[offset + 10]);
               s.netSettlement = numbers[offset + 11];
               return s;
             }
           }
         }
      }
    }

    // Fallback standard matching
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tr"));
      for (const row of rows) {
        const text = cleanText(row.textContent).toLowerCase();
        const lastCellText = row.querySelector("td:last-child")?.textContent || "";
        const val = parseNumber(lastCellText);
        if (isNaN(val) || Math.abs(val) === 0) continue;
        const absVal = Math.abs(val);

        if (text.includes("pay in/pay out obligation") || text.includes("pay in / pay out obligation") || text.includes("net obligation")) {
          s.payinObligation = absVal;
        } else if (text.includes("securities transaction tax") || text.includes("stt")) {
          s.stt = absVal;
        } else if (text.includes("taxable value of supply") || text.includes("taxable value")) {
          s.taxableValue = absVal;
        } else if (text.includes("exchange transaction charges") || (text.includes("exchange") && text.includes("charge"))) {
          s.etc = absVal;
        } else if (text.includes("sebi turnover fees") || text.includes("sebi fees")) {
          s.sebiFees = absVal;
        } else if (text.includes("clearing charges")) {
          s.clearingCharges = absVal;
        } else if (text.includes("stamp duty")) {
          s.stampDuty = absVal;
        } else if (text.includes("net amount receivable") || text.includes("receivable by client")) {
          s.netSettlement = val;
        } else if (text.includes("igst")) {
          s.igst = absVal;
        } else if (text.includes("cgst")) {
          s.cgst = absVal;
        } else if (text.includes("sgst") || text.includes("utgst")) {
          s.sgst = absVal;
        }
      }
    }

    return s;
  }

  private extractSummaryFromText(text: string): Summary {
    const s: Summary = { payinObligation: 0, stt: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, gst: 0, etc: 0, sebiFees: 0, clearingCharges: 0, stampDuty: 0, ipf: 0, netSettlement: 0 };
    const lines = text.split('\n');

    for (const line of lines) {
      const cleanLine = cleanText(line);
      const lowerLine = cleanLine.toLowerCase();

      if (lowerLine.startsWith("ncl cm") || lowerLine.startsWith("total (net)") || lowerLine.startsWith("total(net)")) {
        const tokens = line.trim().split(/\s+/);
        const numbers: number[] = [];
        for (const token of tokens) {
          const val = parseNumber(token);
          if (!isNaN(val)) {
            numbers.push(val);
          }
        }

        // Try scanning backwards to find headers line if available
        let headerLine = "";
        const curIdx = lines.indexOf(line);
        if (curIdx !== -1) {
          for (let j = Math.max(0, curIdx - 5); j < curIdx; j++) {
            const l = cleanText(lines[j]).toLowerCase();
            if (l.includes("securities transaction") || l.includes("taxable value") || l.includes("igst")) {
              headerLine = lines[j];
              break;
            }
          }
        }

        if (headerLine) {
          const normalizedHeader = headerLine.replace(/\(@\d+%\)/g, "");
          const headerTokens = normalizedHeader.trim().split(/\s{2,}/);
          const cleanHeaders = (headerTokens.length >= 5 ? headerTokens : normalizedHeader.trim().split(/\s+/)).map(h => h.toLowerCase());
          
          const firstNumIdx = tokens.findIndex((t) => !isNaN(parseFloat(t.replace(/,/g, ''))));
          if (firstNumIdx !== -1) {
            const dataNumbers = tokens.slice(firstNumIdx).map(t => parseNumber(t));
            
            cleanHeaders.forEach((header, idx) => {
              if (idx >= dataNumbers.length) return;
              const val = dataNumbers[idx];
              if (isNaN(val)) return;
              const absVal = Math.abs(val);

              if (header.includes("pay in") || header.includes("net obligation") || header.includes("obligation")) {
                s.payinObligation = absVal;
              } else if (header.includes("transaction tax") || header.includes("stt")) {
                s.stt = absVal;
              } else if (header.includes("taxable value")) {
                s.taxableValue = absVal;
              } else if (header.includes("cgst")) {
                s.cgst = absVal;
              } else if (header.includes("sgst")) {
                s.sgst = absVal;
              } else if (header.includes("igst")) {
                s.igst = absVal;
              } else if (header.includes("exchange transaction") || header.includes("etc")) {
                s.etc = absVal;
              } else if (header.includes("sebi turnover") || header.includes("sebi fee")) {
                s.sebiFees = absVal;
              } else if (header.includes("stamp duty")) {
                s.stampDuty = absVal;
              } else if (header.includes("receivable") || header.includes("payable")) {
                s.netSettlement = val;
              }
            });

            if (s.taxableValue > 0 || s.stt > 0 || Math.abs(s.netSettlement) > 0) {
              if (s.igst === 0) {
                if (numbers.length >= 12) {
                  const offset = numbers.length - 12;
                  s.igst = Math.abs(numbers[offset + 6]);
                } else if (numbers.length === 11) {
                  s.igst = Math.abs(numbers[5]);
                }
              }
              return s;
            }
          }
        }

        // Static fallback
        if (numbers.length === 11) {
          s.payinObligation = Math.abs(numbers[0]);
          s.stt = Math.abs(numbers[1]);
          s.taxableValue = Math.abs(numbers[2]);
          s.cgst = Math.abs(numbers[3]);
          s.sgst = Math.abs(numbers[4]);
          s.igst = Math.abs(numbers[5]);
          s.etc = Math.abs(numbers[6]);
          s.sebiFees = Math.abs(numbers[8]);
          s.stampDuty = Math.abs(numbers[9]);
          s.netSettlement = numbers[10];
          return s;
        } else if (numbers.length >= 12) {
          const offset = numbers.length - 12;
          s.payinObligation = Math.abs(numbers[offset + 0]);
          s.stt = Math.abs(numbers[offset + 1]);
          s.taxableValue = Math.abs(numbers[offset + 2]);
          s.cgst = Math.abs(numbers[offset + 3]);
          s.sgst = Math.abs(numbers[offset + 4]);
          s.igst = Math.abs(numbers[offset + 6]);
          s.etc = Math.abs(numbers[offset + 7]);
          s.sebiFees = Math.abs(numbers[offset + 9]);
          s.stampDuty = Math.abs(numbers[offset + 10]);
          s.netSettlement = numbers[offset + 11];
          return s;
        }
      }
    }

    // Fallback obligations scanner
    let insideObligations = false;
    for (const line of lines) {
      const l = cleanText(line);
      const lowerLine = l.toLowerCase();

      if (lowerLine.includes("obligation details") || lowerLine.includes("pay in/ pay out obligation")) {
        insideObligations = true;
      }
      if (lowerLine.includes("annexure") || lowerLine.includes("disclaimer") || lowerLine.includes("regulatory path")) {
        insideObligations = false;
      }

      const isSummaryKeyword = lowerLine.includes("pay in") || lowerLine.includes("obligation") || lowerLine.includes("stt") || 
                               lowerLine.includes("taxable value") || lowerLine.includes("transaction charges") || 
                               lowerLine.includes("sebi") || lowerLine.includes("stamp") || lowerLine.includes("receivable") || 
                               lowerLine.includes("igst") || lowerLine.includes("cgst") || lowerLine.includes("sgst");

      if (isSummaryKeyword) {
        const tokens = line.trim().split(/\s+/);
        if (tokens.length >= 2) {
          const val = parseNumber(tokens[tokens.length - 1]);
          if (!isNaN(val) && Math.abs(val) !== 0) {
            const absVal = Math.abs(val);
            if (lowerLine.includes("pay in/pay out obligation") || lowerLine.includes("pay in / pay out obligation")) s.payinObligation = absVal;
            else if (lowerLine.includes("securities transaction") || lowerLine.includes("stt")) s.stt = absVal;
            else if (lowerLine.includes("taxable value")) s.taxableValue = absVal;
            else if (lowerLine.includes("exchange transaction")) s.etc = absVal;
            else if (lowerLine.includes("clearing charges")) s.clearingCharges = absVal;
            else if (lowerLine.includes("sebi turnover") || lowerLine.includes("sebi fee")) s.sebiFees = absVal;
            else if (lowerLine.includes("stamp duty")) s.stampDuty = absVal;
            else if (lowerLine.includes("net amount receivable") || lowerLine.includes("receivable by client")) s.netSettlement = val;
            else if (lowerLine.includes("igst")) s.igst = absVal;
            else if (lowerLine.includes("cgst")) s.cgst = absVal;
            else if (lowerLine.includes("sgst") || lowerLine.includes("utgst")) s.sgst = absVal;
          }
        }
      }
    }

    return s;
  }

  private extractTrades(doc: Document): any[] {
    const trades: any[] = [];
    const tables = Array.from(doc.querySelectorAll("table"));
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tr"));
      const hIdx = rows.findIndex(r => {
        const t = cleanText(r.textContent).toLowerCase();
        return (t.includes("order no") || t.includes("trade no")) && t.includes("security") && t.includes("quantity");
      });

      if (hIdx !== -1) {
        const headerCells = Array.from(rows[hIdx].querySelectorAll("td, th"));
        const colMap = { security: -1, type: -1, qty: -1, price: -1, brokerage: -1 };
        headerCells.forEach((c, idx) => {
          const t = cleanText(c.textContent).toLowerCase();
          if (t.includes("security") || t.includes("contract")) colMap.security = idx;
          else if (t.includes("buy(b)") || t.includes("buy/sell") || t.includes("buy (b)")) colMap.type = idx;
          else if (t.includes("quantity") || t.includes("qty")) colMap.qty = idx;
          else if (t.includes("gross rate") || t.includes("trade price")) colMap.price = idx;
          else if (t.includes("brokerage per unit") || (t.includes("brokerage") && !t.includes("value"))) colMap.brokerage = idx;
        });

        if (colMap.security !== -1 && colMap.qty !== -1 && colMap.type !== -1) {
          for (let j = hIdx + 1; j < rows.length; j++) {
            const cells = Array.from(rows[j].querySelectorAll("td"));
            if (cells.length < 5) continue;

            const fullName = cells[colMap.security]?.textContent?.trim() || "";
            if (!fullName || cleanText(fullName).toLowerCase().startsWith("total") || cleanText(fullName).toLowerCase().startsWith("subtotal")) continue;

            let isin = "";
            const isinMatch = fullName.match(/(IN[A-Z0-9]{10})/i);
            if (isinMatch) {
              isin = isinMatch[1].toUpperCase();
            }

            const name = fullName.replace(/\s*-?\s*\(?IN[A-Z0-9]{10}\)?/i, "").trim();

            const typeStr = cleanText(cells[colMap.type]?.textContent).toLowerCase();
            const side = (typeStr.includes("buy") || typeStr === "b") ? "Buy" : (typeStr.includes("sell") || typeStr === "s") ? "Sell" : null;
            const qty = Math.abs(parseNumber(cells[colMap.qty]?.textContent));
            const price = parseNumber(cells[colMap.price]?.textContent);
            const brok = colMap.brokerage !== -1 ? parseNumber(cells[colMap.brokerage]?.textContent) : 0;

            if (side && qty > 0 && price > 0) {
              trades.push({
                securityName: name,
                isin: isin,
                quantity: qty,
                price: price,
                brokeragePerShare: brok,
                type: side,
                contextText: cells.map(c => c.textContent).join(" ")
              });
            }
          }
        }
      }
    }
    return trades;
  }

  private extractTradesFromText(text: string): any[] {
    const trades: any[] = [];
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const tokens = line.split(/\s+/);
      if (tokens.length < 5) continue;

      // Find whole-word BUY or SELL (case-sensitive as per Share India transaction lists)
      const sideIdx = tokens.findIndex((t) => {
        const u = t.toUpperCase();
        return u === 'BUY' || u === 'SELL';
      });

      if (sideIdx === -1) continue;
      if (sideIdx + 3 >= tokens.length) continue;

      // Validate quantities, prices and brokerage
      const qty = Math.abs(parseNumber(tokens[sideIdx + 1]));
      const price = parseNumber(tokens[sideIdx + 2]);
      const brok = parseNumber(tokens[sideIdx + 3]);

      if (isNaN(qty) || qty <= 0 || isNaN(price) || price <= 0 || isNaN(brok)) continue;

      // Reconstruct security name from prefix tokens
      const prefixString = tokens.slice(0, sideIdx).join(" ");
      
      // Look for last time match prefix string e.g. 10:37:16
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

      // Strip leading numbers e.g. trade numbers
      securityPart = securityPart.replace(/^[\d\s\-\,\.\/]+/, "").trim();

      let isin = "";
      const isinMatch = securityPart.match(/(IN[A-Z0-9]{10})/i);
      if (isinMatch) {
         isin = isinMatch[1].toUpperCase();
      }

      // Clean ISIN suffix variations
      const name = securityPart
        .replace(/\s*-?\s*\(?IN[A-Z0-9]{10}\)?/i, "")
        .replace(/\s*-?\s*\(?IN[A-Z0-9]{11}\)?/i, "")
        .replace(/\s*-?\s*\(?IN[A-Z0-9]{13}\)?/i, "")
        .trim();

      const lowerName = name.toLowerCase();

      // Skip common header strings and artifacts
      if (lowerName.length < 2) continue;
      if (lowerName.includes("security") || lowerName.includes("contract") || lowerName.includes("description") || lowerName.includes("order no") || lowerName.includes("trade no")) continue;
      if (lowerName === "total" || lowerName === "subtotal" || lowerName.startsWith("page no")) continue;

      trades.push({
        securityName: name,
        isin: isin,
        quantity: qty,
        price: price,
        brokeragePerShare: brok,
        type: tokens[sideIdx].toUpperCase() === "BUY" ? "Buy" : "Sell",
        contextText: line
      });
    }

    return trades;
  }

  private finalizeContractNote(summary: Summary, rawTrades: any[], tradeDate: string, prefix: string): ContractNoteResult {
    const rt = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

    let providedGst = rt(summary.igst) + rt(summary.cgst) + rt(summary.sgst);
    if (providedGst === 0 && summary.taxableValue > 0) {
      providedGst = rt(summary.taxableValue * 0.18);
    }
    summary.gst = providedGst;

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
        const isin = items[0]?.isin || "";
        
        tradesToProcess.push({
          securityName: name,
          isin: isin,
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

    const classifyInstrument = (symbol: string): "EQUITY" | "ETF" | "MUTUAL_FUND" => {
      const s = symbol.toUpperCase();
      if (s.includes("MUTUAL FUND") || s.includes("MUTUALFUND")) return "MUTUAL_FUND";
      if (
        s.includes("LIQUID") ||
        s.includes("CASE") ||
        s.includes("ETF")
      ) return "ETF";
      return "EQUITY";
    };

    let totalTurnover = 0;
    let totalBuyTurnover = 0;
    let totalSellTurnover = 0;
    
    let equityTurnover = 0;
    let equityBuyTurnover = 0;
    let equitySellTurnover = 0;

    tradesToProcess.forEach(t => {
      const gross = t.quantity * t.price;
      totalTurnover += gross;
      if (t.type === "Buy") totalBuyTurnover += gross;
      if (t.type === "Sell") totalSellTurnover += gross;
      
      const inst = classifyInstrument(t.securityName);
      if (inst !== "MUTUAL_FUND") {
        equityTurnover += gross;
        if (t.type === "Buy") equityBuyTurnover += gross;
        if (t.type === "Sell") equitySellTurnover += gross;
      }
    });

    const INSTRUMENT_RULES = {
      EQUITY: {
        delivery: { buy: 0.001, sell: 0.001 },
        intraday: { buy: 0, sell: 0.00025 }
      },
      ETF: {
        delivery: { buy: 0, sell: 0 },
        intraday: { buy: 0, sell: 0 }
      },
      MUTUAL_FUND: {
        delivery: { buy: 0, sell: 0 },
        intraday: { buy: 0, sell: 0 }
      }
    };

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
        if (s.buyQty === s.sellQty && s.buyQty > 0) {
          isIntraday = true;
        } else {
          isIntraday = false;
        }
      }

      const grossTotal = rt(t.quantity * t.price);
      
      const instrumentType = classifyInstrument(t.securityName);
      const isMutualFund = instrumentType === "MUTUAL_FUND";
      
      const isSingleTrade = validatedTrades.length === 1;
      const ratio = !isMutualFund && equityTurnover > 0 ? grossTotal / equityTurnover : 0;
      const stampDutyRatio = totalBuyTurnover > 0 && t.type === "Buy" ? grossTotal / totalBuyTurnover : 0;
      const buyRatio = !isMutualFund && equityBuyTurnover > 0 && t.type === "Buy" ? grossTotal / equityBuyTurnover : 0;
      const sellRatio = !isMutualFund && equitySellTurnover > 0 && t.type === "Sell" ? grossTotal / equitySellTurnover : 0;

      // KEEP INDEPENDENT: Extract directly from the trade row!
      let brokerage = rt(t.quantity * (t.brokeragePerShare || 0));
      // Fallback only if raw brokerage is totally 0
      if (brokerage === 0 && summary.taxableValue > 0) {
        // Here we use totalTurnover because brokerage still applies across the board, including mutual funds if no per-share is given.
        const totalRatio = totalTurnover > 0 ? grossTotal / totalTurnover : 0;
        brokerage = isSingleTrade ? rt(summary.taxableValue) : rt(summary.taxableValue * totalRatio);
      }
      
      const tradeType = isIntraday ? "Intraday" : "Delivery";
      const tradeTypeKey = isIntraday ? "intraday" : "delivery";
      const sideKey = t.type === "Buy" ? "buy" : "sell";
      const rate = INSTRUMENT_RULES[instrumentType][tradeTypeKey][sideKey];
      const stt = Math.round(grossTotal * rate);

      const etc = isMutualFund ? 0 : isSingleTrade ? rt(summary.etc) : rt(summary.etc * ratio);
      const sebiFees = isMutualFund ? 0 : isSingleTrade ? rt(summary.sebiFees) : rt(summary.sebiFees * ratio);
      const clearingCharges = isMutualFund ? 0 : isSingleTrade ? rt(summary.clearingCharges) : rt(summary.clearingCharges * ratio);
      const stampDuty = isSingleTrade ? rt(summary.stampDuty) : rt(summary.stampDuty * stampDutyRatio);
      const ipf = isMutualFund ? 0 : isSingleTrade ? rt(summary.ipf) : rt(summary.ipf * ratio);
      const cgst = isMutualFund ? 0 : isSingleTrade ? rt(summary.cgst) : rt(summary.cgst * ratio);
      const sgst = isMutualFund ? 0 : isSingleTrade ? rt(summary.sgst) : rt(summary.sgst * ratio);
      const igst = isMutualFund ? 0 : isSingleTrade ? rt(summary.igst) : rt(summary.igst * ratio);
      const gst = isMutualFund ? 0 : isSingleTrade ? rt(summary.gst) : rt(summary.gst * ratio);

      const totalExclSTT = brokerage + etc + sebiFees + clearingCharges + stampDuty + ipf + gst;
      const totalInclSTT = totalExclSTT + stt;

      return { 
          id: `tx-${prefix}-${idx}`, 
          tradeDate, 
          securityName: t.securityName, 
          isin: t.isin || "",
          transactionType: t.type as TransactionType, 
          quantity: t.quantity, 
          avgPrice: t.price, 
          turnover: grossTotal,
          tradeType,
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

    const brokerName = "shareindia";
    const reconciliation = calculateReconciliation(summary, trades);
    return { summary, trades, brokerName, tradeDate, reconciliation };
  }
}
