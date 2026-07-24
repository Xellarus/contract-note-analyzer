import { ContractNoteResult, Summary, Trade, TransactionType, TradeType } from '../../types';
import { BrokerStrategy } from './types';
import { allocateStt } from './stt';
import {
  parseNumber,
  cleanText,
  isFootnoteOrDisclaimer,
  getTradeDate,
  calculateReconciliation,
  extractIsin
} from './utils';

export class StandardBrokerStrategy implements BrokerStrategy {
  id = 'standard';
  name = 'Standard';
  displayName = 'Standard Contract Note';

  detect(content: string, isPdf: boolean): boolean {
    // Falls back as the default strategy if others don't match
    return true;
  }

  async parseHtml(html: string): Promise<ContractNoteResult | null> {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const summary = this.extractSummary(doc);
    const rawTrades = this.extractStandardTrades(doc);
    const tradeDate = getTradeDate(doc);
    
    if (rawTrades.length === 0) return null;

    return this.finalizeContractNote(summary, rawTrades, tradeDate, "s");
  }

  async parsePdfText(text: string): Promise<ContractNoteResult | null> {
    const summary = this.extractSummaryFromText(text);
    const tradeDate = getTradeDate(text);
    const aggregateTrades: any[] = [];
    
    const lines = text.split('\n');
    let inAnnexure = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const lDown = line.toLowerCase();
      const tokens = line.split(/\s+/);
      const isinMatch = tokens.findIndex(t => extractIsin(t) !== "");   // check-digit ISIN token
      
      const cleanL = lDown.replace(/[^a-z]/g, '');
      if (cleanL.includes("annexurea") || lDown.includes("annexure-a") || lDown.includes("annexure a")) {
        inAnnexure = true;
        continue;
      }

      // Standard trade row parsing
      if (!inAnnexure && tokens.length >= 5) {
        const lowerLine = line.toLowerCase();
        const isSummaryLine = lowerLine.includes("total") || lowerLine.includes("subtotal") || lowerLine.includes("net") || 
                              lowerLine.includes("tax") || lowerLine.includes("charge") || lowerLine.includes("duty") || 
                              lowerLine.includes("fee") || lowerLine.includes("gst") || lowerLine.includes("stt") || 
                              lowerLine.includes("brokerage") || lowerLine.includes("securities transaction");
                              
        if (!isSummaryLine) {
          const sideIdx = tokens.findIndex(t => {
            const lT = t.toLowerCase();
            return lT === "buy" || lT === "sell" || lT === "b" || lT === "s" || lT.includes("-buy") || lT.includes("-sell") || lT === "b/s";
          });
          
          if (sideIdx !== -1) {
            const numTokens = tokens.filter(t => t.match(/^\(?[0-9,.-−]+\)?$/));
            if (numTokens.length >= 2) {
              const sideLower = tokens[sideIdx].toLowerCase();
              const side = (sideLower.includes("buy") || sideLower === "b") ? "Buy" : "Sell";
              
              const nameTokens = tokens.slice(0, sideIdx).filter(t => {
                return !t.match(/^\d{7,}$/) && 
                       !t.match(/^\d{2}:\d{2}:\d{2}$/) && 
                       !t.match(/IN[a-zA-Z0-9]{10}/) && 
                       !t.match(/^\d+$/);
              });
              const security = nameTokens.join(" ").trim();
              
              if (security.length > 3) {
                const numbersAfterSide: number[] = [];
                for (let j = sideIdx + 1; j < tokens.length; j++) {
                  if (tokens[j].match(/^\(?[0-9,.-−]+\)?$/)) {
                    numbersAfterSide.push(Math.abs(parseNumber(tokens[j])));
                  }
                }
                
                if (numbersAfterSide.length >= 2) {
                  const qty = numbersAfterSide[0];
                  const price = numbersAfterSide[1];
                  const brok = numbersAfterSide.length >= 3 ? numbersAfterSide[2] : 0;
                  
                  if (qty > 0 && price > 0) {
                    const alreadyExists = aggregateTrades.some(t => t.securityName === security && t.quantity === qty && Math.abs(t.price - price) < 0.01 && t.type === side);
                    if (!alreadyExists) {
                      aggregateTrades.push({ securityName: security, quantity: qty, price, brokeragePerShare: brok, type: side, contextText: line });
                    }
                  }
                }
              }
            }
          }
        }
      }

      // ISIN / Aggregate Table fallback
      if (isinMatch !== -1) {
        const isin = extractIsin(tokens[isinMatch]);
        let numStartIdx = isinMatch + 1;
        while (numStartIdx < tokens.length && !tokens[numStartIdx].match(/^\(?[0-9,.-−]+\)?$/)) {
          numStartIdx++;
        }
        
        if (numStartIdx < tokens.length) {
          const buyQty = Math.abs(parseNumber(tokens[numStartIdx]));
          const sellQty = numStartIdx + 5 < tokens.length ? Math.abs(parseNumber(tokens[numStartIdx + 5])) : 0;
          
          if (buyQty > 0 || sellQty > 0) {
            const name = tokens.slice(isinMatch + (tokens[isinMatch].toUpperCase() === isin ? 1 : 0), numStartIdx).join(" ");
            if (buyQty > 0) {
              const price = numStartIdx + 1 < tokens.length ? parseNumber(tokens[numStartIdx + 1]) : 0;
              const brok = numStartIdx + 2 < tokens.length ? parseNumber(tokens[numStartIdx + 2]) : 0;
              if (price > 0) aggregateTrades.push({ securityName: name, quantity: buyQty, price, brokeragePerShare: brok, type: 'Buy', contextText: line });
            }
            if (sellQty > 0) {
              const price = numStartIdx + 6 < tokens.length ? parseNumber(tokens[numStartIdx + 6]) : 0;
              const brok = numStartIdx + 7 < tokens.length ? parseNumber(tokens[numStartIdx + 7]) : 0;
              if (price > 0) aggregateTrades.push({ securityName: name, quantity: sellQty, price, brokeragePerShare: brok, type: 'Sell', contextText: line });
            }
          }
        }
      }
    }

    if (aggregateTrades.length === 0) return null;

    const merged: any[] = [];
    aggregateTrades.forEach(t => {
      const last = merged[merged.length - 1];
      if (last && last.securityName === t.securityName && last.type === t.type && Math.abs(last.price - t.price) < 0.001) {
          last.quantity += t.quantity;
          last.contextText = (last.contextText || "") + " " + (t.contextText || "");
      } else {
          merged.push({ ...t });
      }
    });

    return this.finalizeContractNote(summary, merged, tradeDate, "p");
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

  private extractStandardTrades(doc: Document): any[] {
    const trades: any[] = [];
    const tables = Array.from(doc.querySelectorAll("table"));
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tr"));
      const headerIdx = rows.findIndex(r => {
        const t = cleanText(r.textContent);
        return (t.includes("security name") || t.includes("security description") || t.includes("symbol")) && (t.includes("quantity") || t.includes("qty"));
      });
      if (headerIdx !== -1) {
        const cells = Array.from(rows[headerIdx].querySelectorAll("td, th"));
        let nameIdx = -1, buyIdx = -1, sellIdx = -1;
        const qtIdx: number[] = [], priceIdx: number[] = [], brokIdx: number[] = [];
        cells.forEach((c, idx) => {
          const t = cleanText(c.textContent);
          if (t.startsWith("net") || t.includes("net ") || t.includes("obligation")) return;
          if (t.includes("security name") || t.includes("symbol") || t.includes("security description")) nameIdx = idx;
          if (t.includes("quantity") || t.includes("qty")) {
            if (t.includes("buy")) buyIdx = idx; else if (t.includes("sell")) sellIdx = idx; else qtIdx.push(idx);
          }
          if (t.includes("wap") || ((t.includes("rate") || t.includes("price")) && !t.includes("total value"))) priceIdx.push(idx);
          if (t.includes("brokerage") && t.includes("share")) brokIdx.push(idx);
        });
        if (buyIdx === -1 && sellIdx === -1 && qtIdx.length >= 2) { buyIdx = qtIdx[0]; sellIdx = qtIdx[1]; }
        if (buyIdx !== -1 && sellIdx !== -1 && nameIdx !== -1) {
          const findNext = (base: number, targets: number[]) => {
            const valid = targets.filter(i => i > base).sort((a, b) => a - b);
            return valid.length > 0 ? valid[0] : -1;
          };
          const buyPriceIdx = findNext(buyIdx, priceIdx), buyBrokIdx = findNext(buyIdx, brokIdx);
          const sellPriceIdx = findNext(sellIdx, priceIdx), sellBrokIdx = findNext(sellIdx, brokIdx);
          for (let j = headerIdx + 1; j < rows.length; j++) {
            const cells = Array.from(rows[j].querySelectorAll("td"));
            const name = cells[nameIdx]?.textContent?.trim();
            if (!name || cleanText(name).startsWith("total") || cleanText(name).startsWith("net")) continue;
            if (cells[buyIdx]) {
              const q = parseNumber(cells[buyIdx].textContent);
              if (q > 0) trades.push({ securityName: name, quantity: q, price: buyPriceIdx !== -1 ? parseNumber(cells[buyPriceIdx].textContent) : 0, brokeragePerShare: buyBrokIdx !== -1 ? parseNumber(cells[buyBrokIdx].textContent) : 0, type: "Buy", contextText: rows[j].textContent });
            }
            if (cells[sellIdx]) {
              const q = parseNumber(cells[sellIdx].textContent);
              if (q > 0) trades.push({ securityName: name, quantity: q, price: sellPriceIdx !== -1 ? parseNumber(cells[sellPriceIdx].textContent) : 0, brokeragePerShare: sellBrokIdx !== -1 ? parseNumber(cells[sellBrokIdx].textContent) : 0, type: "Sell", contextText: rows[j].textContent });
            }
          }
          if (trades.length > 0) return trades;
        }
      }
    }
    return trades;
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
    } else if (l.includes("clearing charges") || l.includes("clearing charge")) {
      key = "clearingCharges";
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
    } else if (l.includes("igst")) {
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

  private finalizeContractNote(summary: Summary, rawTrades: any[], tradeDate: string, prefix: string): ContractNoteResult {
    const rt = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

    const gstBase = summary.taxableValue + summary.etc + summary.sebiFees + summary.clearingCharges;
    const calculatedGST = rt(gstBase * 0.18);
    
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
    const totalSellTurnover = tradesToProcess.reduce((sum, t) => t.type === "Sell" ? sum + (t.quantity * t.price) : sum, 0);

    const classifyInstrument = (symbol: string): "EQUITY" | "ETF" => {
      const s = symbol.toUpperCase();
      if (
        s.includes("LIQUID") ||
        s.includes("CASE") ||
        s.includes("ETF")
      ) return "ETF";
      return "EQUITY";
    };

    // STT: allocate the note's printed total across the trades (delivery at the
    // exact 0.1%; the leftover intraday pool pro-rata by squared-off turnover,
    // split 50/50 buy/sell). Shared with every broker — see ./stt.
    const sttArr = allocateStt(
      tradesToProcess.map(t => ({
        securityName: t.securityName,
        type: t.type as "Buy" | "Sell",
        quantity: t.quantity,
        price: t.price,
        exempt: classifyInstrument(t.securityName) !== "EQUITY",
      })),
      summary.stt || 0
    );

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
      
      const ratio = totalTurnover > 0 ? grossTotal / totalTurnover : 0;
      const buyRatio = totalBuyTurnover > 0 && t.type === "Buy" ? grossTotal / totalBuyTurnover : 0;
      const sellRatio = totalSellTurnover > 0 && t.type === "Sell" ? grossTotal / totalSellTurnover : 0;

      const brokerage = rt(summary.taxableValue * ratio);
      
      const tradeType = isIntraday ? "Intraday" : "Delivery";
      // STT pre-allocated across all trades from the note's printed total (see ./stt).
      const stt = sttArr[idx];

      const etc = rt(summary.etc * ratio);
      const sebiFees = rt(summary.sebiFees * ratio);
      const clearingCharges = rt(summary.clearingCharges * ratio);
      const stampDuty = rt(summary.stampDuty * buyRatio);
      const ipf = rt(summary.ipf * ratio);
      const cgst = rt(summary.cgst * ratio);
      const sgst = rt(summary.sgst * ratio);
      const igst = rt(summary.igst * ratio);
      const gst = rt(summary.gst * ratio);

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

    const brokerName = "standard";
    const reconciliation = calculateReconciliation(summary, trades);
    return { summary, trades, brokerName, tradeDate, reconciliation };
  }
}
