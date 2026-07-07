import { ContractNoteResult, Summary, Trade, TransactionType, TradeType } from '../../types';
import { BrokerStrategy } from './types';
import {
  parseNumber,
  cleanText,
  isFootnoteOrDisclaimer,
  getTradeDate,
  getUCC,
  calculateReconciliation
} from './utils';

export class ZerodhaBrokerStrategy implements BrokerStrategy {
  id = 'zerodha';
  name = 'Zerodha';
  displayName = "Zerodha's Contract Note";

  detect(content: string, isPdf: boolean): boolean {
    const text = content.toLowerCase();
    return text.includes("zerodha");
  }

  async parseHtml(html: string): Promise<ContractNoteResult | null> {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const summary: Summary = { payinObligation: 0, stt: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, gst: 0, etc: 0, sebiFees: 0, clearingCharges: 0, stampDuty: 0, ipf: 0, netSettlement: 0 };
    const tradeDate = getTradeDate(doc);
    const ucc = getUCC(doc);

    const isinMap = new Map<string, string>();
    const tables = Array.from(doc.querySelectorAll('table'));
    
    // Extract ISIN mapping
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll('tr'));
      const headerIndex = rows.findIndex(r => cleanText(r.textContent).includes("isin") && (cleanText(r.textContent).includes("security") || cleanText(r.textContent).includes("symbol")));
      
      if (headerIndex !== -1) {
        const headerCells = Array.from(rows[headerIndex].querySelectorAll('td, th'));
        let isinIdx = -1, symIdx = -1;
        headerCells.forEach((c, idx) => {
          const t = cleanText(c.textContent);
          if (t === "isin") isinIdx = idx;
          else if (t.includes("security") || t.includes("symbol")) symIdx = idx;
        });
        
        if (isinIdx !== -1 && symIdx !== -1) {
          for (let j = headerIndex + 1; j < rows.length; j++) {
            const cells = Array.from(rows[j].querySelectorAll('td'));
            if (cells.length > Math.max(isinIdx, symIdx)) {
              let isinVal = cells[isinIdx].textContent?.trim() || "";
              let symVal = cells[symIdx].textContent?.trim() || "";
              
              if (symVal.includes("-")) symVal = symVal.split("-")[0].trim();
              
              if (isinVal.startsWith("IN") && symVal) {
                isinMap.set(symVal.toUpperCase(), isinVal.toUpperCase());
              }
            }
          }
        }
      }
    }
    
    // 1. Extract Summary
    for (const table of tables) {
      const tableText = cleanText(table.textContent);
      if (tableText.includes("pay in/pay out obligation") || tableText.includes("pay in / pay out obligation")) {
        const rows = Array.from(table.querySelectorAll('tr'));
        for (const row of rows) {
          if (isFootnoteOrDisclaimer(row.textContent)) continue;
          const text = cleanText(row.textContent);
          const valToken = row.querySelector('td:last-child')?.textContent || "";
          const val = parseNumber(valToken);
          if (Math.abs(val) === 0) continue;
          const absVal = Math.abs(val);
   
          if (text.includes("pay in/pay out obligation") || text.includes("pay in / pay out obligation")) summary.payinObligation = absVal;
          else if (text.includes("securities transaction tax") || text.includes("stt")) summary.stt = absVal;
          else if (text.includes("taxable value")) summary.taxableValue = absVal;
          else if (text.includes("exchange transaction charges") || (text.includes("exchange") && text.includes("transaction") && text.includes("charge"))) summary.etc = absVal;
          else if (text.includes("sebi turnover fees") || text.includes("sebi turnover fee")) summary.sebiFees = absVal;
          else if (text.includes("stamp duty")) summary.stampDuty = absVal;
          else if (text.includes("net amount receivable") || text.includes("net amount payable")) summary.netSettlement = val;
          else if (text.includes("igst")) {
            summary.igst += absVal;
          } else if (text.includes("cgst")) {
            summary.cgst += absVal;
          } else if (text.includes("sgst") || text.includes("utgst")) {
            summary.sgst += absVal;
          }
        }
        break; // Stop parsing other tables once the charges table is analyzed
      }
    }

    // 2. Extract Trades (Annexure A)
    const rawTrades: any[] = [];
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll('tr'));
      const headerIndex = rows.findIndex(r => {
        const t = cleanText(r.textContent);
        return (t.includes("trade no") || t.includes("order no")) && t.includes("security") && t.includes("quantity");
      });

      if (headerIndex !== -1) {
        const headerCells = Array.from(rows[headerIndex].querySelectorAll('td, th'));
        const colMap: any = { security: -1, type: -1, qty: -1, price: -1, brokerage: -1 };
        headerCells.forEach((c, idx) => {
          const t = cleanText(c.textContent);
          if (t.includes("security") || t.includes("contract")) colMap.security = idx;
          else if (t.includes("buy") && t.includes("sell")) colMap.type = idx;
          else if (t.includes("quantity") || t.includes("qty")) colMap.qty = idx;
          else if (t.includes("net rate") || t.includes("price")) colMap.price = idx;
          else if (t.includes("brokerage")) colMap.brokerage = idx;
        });

        if (colMap.security !== -1 && colMap.qty !== -1) {
          for (let j = headerIndex + 1; j < rows.length; j++) {
            const cells = Array.from(rows[j].querySelectorAll('td'));
            if (cells.length < 5) continue;
            
            const originalName = cells[colMap.security]?.textContent?.trim() || "";
            if (!originalName || cleanText(originalName).includes("total") || cleanText(originalName).includes("sub-total")) continue;

            const rowText = cells.map(c => c.textContent).join(" ");
            
            let isin = "";
            const isinMatch = rowText.match(/(IN[A-Z0-9]{10})/i);
            if (isinMatch) {
              isin = isinMatch[1].toUpperCase();
            }

            let name = originalName;
            if (name.includes("-")) {
              name = name.split("-")[0].trim();
            }
            
            if (!isin && name) {
               isin = isinMap.get(name.toUpperCase()) || "";
            }

            const typeStr = cleanText(cells[colMap.type]?.textContent);
            const side = typeStr.includes('b') ? 'Buy' : typeStr.includes('s') ? 'Sell' : null;
            const qty = Math.abs(parseNumber(cells[colMap.qty]?.textContent));
            
            if (side && qty > 0) {
              const price = parseNumber(cells[colMap.price]?.textContent);
              const brok = colMap.brokerage !== -1 ? parseNumber(cells[colMap.brokerage]?.textContent) : 0;
              rawTrades.push({ securityName: name, isin: isin, quantity: qty, price, brokeragePerShare: brok, type: side, contextText: cells.map(c => c.textContent).join(" ") });
            }
          }
        }
      }
    }

    if (rawTrades.length === 0) return null;

    // 3. Merge identical consecutive trades for consistency
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

    return this.finalizeContractNote(summary, merged, tradeDate, "z", ucc);
  }

  async parsePdfText(text: string): Promise<ContractNoteResult | null> {
    const summary = this.extractSummaryFromText(text);
    const tradeDate = getTradeDate(text);
    const ucc = getUCC(text);
    const rawTrades: any[] = [];
    
    // Extract ISIN mapping from the entire text
    const isinMap = new Map<string, string>();
    const isinRegex = /(IN[A-Z0-9]{10})\s+([A-Z0-9\-]+)/gi;
    let match;
    while ((match = isinRegex.exec(text)) !== null) {
      let sym = match[2];
      if (sym.includes("-")) sym = sym.split("-")[0].trim();
      if (sym) isinMap.set(sym.toUpperCase(), match[1].toUpperCase());
    }
    
    const lines = text.split('\n');
    let inAnnexure = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const lDown = line.toLowerCase();
      const cleanL = lDown.replace(/[^a-z]/g, '');
      if (cleanL.includes("annexurea") || lDown.includes("annexure-a") || lDown.includes("annexure a")) {
        inAnnexure = true;
        continue;
      }

      const tokens = line.split(/\s+/);
      
      // Annexure A Parser based on Zerodha columns
      if (inAnnexure && tokens.length >= 8) {
        const sideIdx = tokens.findIndex((t, idx) => {
          if (idx < 1 || idx + 1 >= tokens.length) return false;
          const isBOrS = t === 'B' || t === 'S' || t === 'BUY' || t === 'SELL';
          if (!isBOrS) return false;
          const nextTk = tokens[idx + 1].toLowerCase();
          return nextTk === 'nse' || nextTk === 'bse' || nextTk === 'mcx' || nextTk === 'ncdex';
        });

        const exchangeIdx = sideIdx + 1;
        if (sideIdx !== -1 && exchangeIdx < tokens.length) {
          const side = (tokens[sideIdx] === 'B' || tokens[sideIdx] === 'BUY') ? 'Buy' : 'Sell';
          
          let security = "";
          const timeIndices = tokens.slice(0, sideIdx).reduce((acc: number[], t, idx) => {
            if (t.match(/^\d{2}:\d{2}/)) acc.push(idx);
            return acc;
          }, []);
          
          if (timeIndices.length > 0) {
            const lastTimeIdx = timeIndices[timeIndices.length - 1];
            security = tokens.slice(lastTimeIdx + 1, sideIdx).join(" ").trim();
          } else {
            const nameTokens = tokens.slice(0, sideIdx).filter(t => !t.match(/^\d{7,}$/) && !t.match(/^\d{2}:\d{2}/));
            security = nameTokens.join(" ").trim();
          }
          
          let isin = "";
          const isinMatch = line.match(/(IN[A-Z0-9]{10})/i);
          if (isinMatch) {
            isin = isinMatch[1].toUpperCase();
          }

          if (security.includes("-")) {
            security = security.split("-")[0].trim();
          }
          
          if (!isin && security) {
             isin = isinMap.get(security.toUpperCase()) || "";
          }
          
          const qty = Math.abs(parseNumber(tokens[sideIdx + 2]));
          const brok = parseNumber(tokens[sideIdx + 3]);
          const price = parseNumber(tokens[sideIdx + 4]);
          
          if (qty > 0 && price > 0) {
            rawTrades.push({ securityName: security, isin: isin, quantity: qty, price, brokeragePerShare: brok, type: side, contextText: line });
          }
          continue;
        }
      }
    }

    if (rawTrades.length === 0) return null;

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

    return this.finalizeContractNote(summary, merged, tradeDate, "z", ucc);
  }

  private getConfidenceAndKey(lText: string, insideBlock: boolean): { key: keyof Summary | null, confidence: number } {
    const l = lText.toLowerCase();
    
    const isFootnote = isFootnoteOrDisclaimer(lText) 
      || l.includes("is payable") 
      || l.includes("levied") 
      || l.includes("under section") 
      || l.includes("per nse") 
      || l.includes("registered office")
      || l.includes("compliance")
      || l.includes("sebi registration")
      || l.includes("circular");
    
    let key: keyof Summary | null = null;
    
    if (l.includes("pay in/pay out obligation") || l.includes("pay in / pay out obligation") || l.includes("pay-in/pay-out obligation") || l.includes("net obligation")) {
      key = "payinObligation";
    } else if (l.includes("securities transaction tax") || l.includes("stt")) {
      if (insideBlock) {
        key = "stt";
      }
    } else if (l.includes("taxable value of supply") || l.includes("taxable value") || l.includes("taxable value of services")) {
      key = "taxableValue";
    } else if (l.includes("exchange transaction charges") || (l.includes("exchange") && l.includes("transaction") && l.includes("charge"))) {
      key = "etc";
    } else if (l.includes("sebi turnover fees") || l.includes("sebi turnover fee") || l.includes("sebi turnover") || l.includes("sebi fees")) {
      key = "sebiFees";
    } else if (l.includes("stamp duty")) {
      key = "stampDuty";
    } else if (l.includes("ipf") || l.includes("investor protection fund") || l.includes("investor protection")) {
      key = "ipf";
    } else if (l.includes("net amount receivable") || l.includes("net amount payable") || l.includes("net amount receivable/(payable)")) {
      key = "netSettlement";
    } else if (l.includes("sgst") || l.includes("utgst")) {
      key = "sgst";
    } else if (l.includes("igst") || l.includes("integrated tax") || l.includes("integrated gst")) {
      key = "igst";
    } else if (l.includes("cgst") || (l.includes("gst") && !l.includes("gstin"))) {
      key = "cgst";
    }
    
    if (!key) return { key: null, confidence: 0 };
    
    let confidence = 1;
    if (insideBlock) {
      confidence = 3;
    } else if (l.includes("obligation") || l.includes("receivable") || l.includes("payable")) {
      confidence = 2;
    }
    
    if (isFootnote) {
      confidence = 0;
    }
    
    return { key, confidence };
  }

  private extractSummaryFromText(text: string): Summary {
    const candidateMap: Record<keyof Summary, { value: number; confidence: number; lineText: string }[]> = {
      payinObligation: [],
      stt: [],
      taxableValue: [],
      cgst: [],
      sgst: [],
      igst: [],
      gst: [],
      etc: [],
      sebiFees: [],
      clearingCharges: [],
      stampDuty: [],
      ipf: [],
      dmat: [],
      netSettlement: []
    };

    const lines = text.split('\n');
    let insideChargesBlock = false;

    for (const line of lines) {
      const l = cleanText(line);

      if (
        l.includes("pay in/pay out obligation") || 
        l.includes("pay in / pay out obligation") || 
        l.includes("pay-in/pay-out obligation") ||
        l.includes("exchange transaction charges") ||
        l.includes("exchange transaction charge") ||
        l.includes("taxable value") ||
        l.includes("net amount receivable") ||
        l.includes("net amount payable") ||
        l.includes("net amount receivable/(payable)")
      ) {
        insideChargesBlock = true;
      }

      if (
        l.includes("annexure") ||
        l.includes("disclaimer") ||
        l.includes("authorized signatory") ||
        l.includes("compliance officer")
      ) {
        insideChargesBlock = false;
      }

      const { key, confidence } = this.getConfidenceAndKey(line, insideChargesBlock);
      if (!key || confidence === 0) {
        if (
          l.includes("net amount receivable") || 
          l.includes("net amount payable") || 
          l.includes("net amount receivable/(payable)")
        ) {
          insideChargesBlock = false;
        }
        continue;
      }

      const textWithoutPercentages = line.replace(/\d+%\s*/g, ' ');
      const cleanedLine = textWithoutPercentages
        .replace(/^\s*\d+\.\s+/, ' ')
        .replace(/\s+\d+\.\s+/g, ' ')
        .replace(/^\s*[a-zA-Z0-9]\)\s+/, ' ')
        .replace(/\s+[a-zA-Z0-9]\)\s+/g, ' ')
        .replace(/\[\d+\]/g, ' ')
        .trim();

      const matches = cleanedLine.match(/\(?\d{1,3}(?:,\d{3,})*(?:\.\d+)?\)?|\d+(?:\.\d+)?/g);
      if (!matches) continue;

      const candidates = matches.map(m => m.trim()).filter(m => {
        if (m.length === 1 && m.match(/^\d$/)) return false;
        if (m.endsWith('.') && !m.match(/\d\.\d+/)) return false;
        if (m.endsWith(')') && !m.startsWith('(')) return false;
        return true;
      });

      if (candidates.length === 0) continue;

      const lastMatch = candidates[candidates.length - 1];
      const val = parseNumber(lastMatch);
      const absVal = Math.abs(val);

      if (absVal === 0 && key !== "netSettlement" && key !== "payinObligation") continue;

      candidateMap[key].push({ value: val, confidence, lineText: line });

      if (key === "netSettlement") {
        insideChargesBlock = false;
      }
    }

    const selectBestValue = (key: keyof Summary): number => {
      const list = candidateMap[key];
      if (list.length === 0) return 0;
      
      list.sort((a, b) => b.confidence - a.confidence);
      const bestConfidence = list[0].confidence;
      const bestCandidates = list.filter(c => c.confidence === bestConfidence);
      
      if (bestCandidates.length > 1) {
        bestCandidates.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
      }
      return bestCandidates[0].value;
    };

    const s: Summary = {
      payinObligation: Math.abs(selectBestValue("payinObligation")),
      stt: Math.abs(selectBestValue("stt")),
      taxableValue: Math.abs(selectBestValue("taxableValue")),
      cgst: Math.abs(selectBestValue("cgst")),
      sgst: Math.abs(selectBestValue("sgst")),
      igst: Math.abs(selectBestValue("igst")),
      gst: 0,
      etc: Math.abs(selectBestValue("etc")),
      sebiFees: Math.abs(selectBestValue("sebiFees")),
      clearingCharges: Math.abs(selectBestValue("clearingCharges")),
      stampDuty: Math.abs(selectBestValue("stampDuty")),
      ipf: Math.abs(selectBestValue("ipf")),
      netSettlement: selectBestValue("netSettlement")
    };

    return s;
  }

  private finalizeContractNote(summary: Summary, rawTrades: any[], tradeDate: string, prefix: string, ucc?: string): ContractNoteResult {
    const rt = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

    // Zero out IPF for Zerodha broker
    summary.ipf = 0;

    // Hardcode nominal brokerage for Zerodha if evaluating to 0
    if (summary.taxableValue === 0) {
      summary.taxableValue = 0.01;
    }

    // Step 1: Compute taxable service base
    const gstBase = summary.taxableValue + summary.etc + summary.sebiFees;
    // Step 2: Calculate GST
    const calculatedGST = rt(gstBase * 0.18);
    
    // Step 3: Handle tax type
    let providedGst = summary.igst || rt(summary.cgst + summary.sgst);
    if (providedGst === 0) {
      providedGst = calculatedGST;
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

    const totalTurnover = tradesToProcess.reduce((sum, t) => sum + (t.quantity * t.price), 0);
    const totalBuyTurnover = tradesToProcess.reduce((sum, t) => t.type === "Buy" ? sum + (t.quantity * t.price) : sum, 0);
    const totalSellTurnover = tradesToProcess.reduce((sum, t) => t.type === "Sell" ? sum + (t.quantity * t.price) : sum, 0);

    const INSTRUMENT_RULES = {
      EQUITY: {
        delivery: {
          buy: 0.001,
          sell: 0.001
        },
        intraday: {
          buy: 0,
          sell: 0.00025
        }
      },
      ETF: {
        delivery: {
          buy: 0,
          sell: 0
        },
        intraday: {
          buy: 0,
          sell: 0
        }
      }
    };

    const classifyInstrument = (symbol: string): "EQUITY" | "ETF" => {
      const s = symbol.toUpperCase();
      if (
        s.includes("LIQUID") ||
        s.includes("CASE") ||
        s.includes("ETF")
      ) return "ETF";
      return "EQUITY";
    };

    let remainingAmount = {
      brokerage: summary.taxableValue,
      etc: summary.etc,
      sebiFees: summary.sebiFees,
      clearingCharges: summary.clearingCharges,
      stampDuty: summary.stampDuty,
      ipf: summary.ipf,
      cgst: summary.cgst,
      sgst: summary.sgst,
      igst: summary.igst,
      gst: summary.gst
    };

    const numTrades = tradesToProcess.length;

    const trades: Trade[] = tradesToProcess.map((t, idx) => {
      const isLast = idx === numTrades - 1;
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
      
      const ratio = totalTurnover > 0 ? grossTotal / totalTurnover : 0;
      const buyRatio = totalBuyTurnover > 0 && t.type === "Buy" ? grossTotal / totalBuyTurnover : 0;
      const sellRatio = totalSellTurnover > 0 && t.type === "Sell" ? grossTotal / totalSellTurnover : 0;

      const allocateExpense = (totalVal: number, key: keyof typeof remainingAmount, r: number) => {
        if (isLast) return rt(remainingAmount[key]);
        const val = rt(totalVal * r);
        remainingAmount[key] -= val;
        return val;
      };

      const brokerage = allocateExpense(summary.taxableValue, 'brokerage', ratio);
      
      const tradeType = isIntraday ? "Intraday" : "Delivery";
      const instrumentType = classifyInstrument(t.securityName);
      const tradeTypeKey = isIntraday ? "intraday" : "delivery";
      const sideKey = t.type === "Buy" ? "buy" : "sell";
      const rate = INSTRUMENT_RULES[instrumentType][tradeTypeKey][sideKey];
      const stt = Math.round(grossTotal * rate);

      const etc = allocateExpense(summary.etc, 'etc', ratio);
      const sebiFees = allocateExpense(summary.sebiFees, 'sebiFees', ratio);
      const clearingCharges = allocateExpense(summary.clearingCharges, 'clearingCharges', ratio);
      const stampDuty = allocateExpense(summary.stampDuty, 'stampDuty', buyRatio);
      const ipf = allocateExpense(summary.ipf, 'ipf', ratio);
      const cgst = allocateExpense(summary.cgst, 'cgst', ratio);
      const sgst = allocateExpense(summary.sgst, 'sgst', ratio);
      const igst = allocateExpense(summary.igst, 'igst', ratio);
      const gst = allocateExpense(summary.gst, 'gst', ratio);

      const totalExclSTT = brokerage + etc + sebiFees + clearingCharges + stampDuty + ipf + gst;
      const totalInclSTT = totalExclSTT + stt;

      return { 
          id: `tx-${prefix}-${idx}`, 
          tradeDate, 
          isin: t.isin || "",
          securityName: t.securityName, 
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

    const brokerName = "zerodha";
    const reconciliation = calculateReconciliation(summary, trades);
    return { summary, trades, brokerName, tradeDate, ucc, reconciliation };
  }
}
