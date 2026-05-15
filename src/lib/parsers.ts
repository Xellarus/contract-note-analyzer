import { ContractNoteResult, Summary, Trade, TransactionType, TradeType } from '../types';
import * as pdfjs from 'pdfjs-dist';

// Configure pdfjs worker
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const parseNumber = (str: string | null): number => {
  if (!str) return 0;
  let val = str.trim();
  // Handle parens for negative numbers
  if (val.includes('(') && val.includes(')')) {
    val = '-' + val.replace(/[()]/g, '');
  }
  // Replace fancy minus sign with hyphen
  val = val.replace(/\u2212/g, '-');
  const cleanVal = val.replace(/,/g, '').replace(/[^\d.-]/g, '');
  const parsed = parseFloat(cleanVal);
  return isNaN(parsed) ? 0 : parsed;
};

const cleanText = (str: string | null): string => 
  (str?.toLowerCase().replace(/\s+/g, ' ').trim()) || "";

const getTradeDate = (doc: Document | string): string => {
  const dateRegex = /(\d{2}[-/]\d{2}[-/]\d{4})|(\d{4}[-/]\d{2}[-/]\d{2})/;
  
  if (typeof doc === 'string') {
    const lines = doc.split('\n');
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.includes("trade date")) {
        const match = line.match(dateRegex);
        if (match) return match[0];
      }
    }
  } else {
    const elements = Array.from(doc.querySelectorAll("td, th, p, span, div, font, b, strong"));
    for (const el of elements) {
      if (cleanText(el.textContent).includes("trade date")) {
        const match = el.textContent?.match(dateRegex);
        if (match) return match[0];
        let next = el.nextElementSibling;
        let count = 0;
        while (next && count < 3) {
          const text = next.textContent || "";
          const m = text.match(dateRegex);
          if (m) return m[0];
          if (text.trim().length > 0) count++;
          next = next.nextElementSibling;
        }
      }
    }
  }
  return "";
};

export const extractTextFromPDF = async (file: File, password?: string): Promise<string> => {
  const arrayBuffer = await file.arrayBuffer();
  try {
    const loadingTask = pdfjs.getDocument({ 
      data: arrayBuffer,
      password: password
    });
    const pdf = await loadingTask.promise;
    let text = "";
    
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      
      // Group items by their vertical position (Y-coordinate)
      // items.transform[5] is the Y-coordinate
      const items = content.items as any[];
      if (items.length === 0) continue;

      // Sort by Y coordinate descending (top to bottom), then by X coordinate (left to right)
      items.sort((a, b) => {
        const yDiff = b.transform[5] - a.transform[5];
        if (Math.abs(yDiff) > 15) return yDiff; // Use a threshold for same line
        return a.transform[4] - b.transform[4]; // X coordinate
      });

      let pageText = "";
      let lastY = items[0].transform[5];
      
      for (const item of items) {
        if (Math.abs(item.transform[5] - lastY) > 15) {
          pageText += "\n";
          lastY = item.transform[5];
        }
        pageText += item.str + " ";
      }
      text += pageText + "\n";
    }
    return text;
  } catch (error: any) {
    if (error.name === 'PasswordException') {
      throw new Error("PDF_PASSWORD_REQUIRED");
    }
    throw error;
  }
};

const extractSummaryFromText = (text: string): Summary => {
  const s: Summary = { payinObligation: 0, stt: 0, taxableValue: 0, cgst: 0, sgst: 0, etc: 0, sebiFees: 0, clearingCharges: 0, stampDuty: 0, ipf: 0, netSettlement: 0 };
  const lines = text.split('\n');

  for (const line of lines) {
    const l = cleanText(line);
    // Ignore percentages in labels
    const textWithoutPercentages = line.replace(/\d+%\s*/g, ' ');
    const matches = textWithoutPercentages.match(/\(?\d{1,3}(?:,\d{3,})*(?:\.\d+)?\)?|\d+(?:\.\d+)?/g);
    if (!matches) continue;
    
    // In brokerage summaries, values almost always have decimals or are in parens.
    // Footnote markers are typically single integers without decimals.
    let candidates = matches.filter(m => m.includes('.') || m.includes('(') || m.includes(')'));
    
    if (candidates.length === 0) continue; 

    // We take the last candidate as it matches the right-most column (Net Total) in the CN summary table
    const lastMatch = candidates[candidates.length - 1];
    const val = parseNumber(lastMatch);
    const absVal = Math.abs(val);

    // If it's 0 and not the net settlement line, skip to avoid empty label matching
    if (absVal === 0 && !l.includes("net amount")) continue;

    // Check for tax types first
    if (l.includes("igst") || l.includes("cgst") || l.includes("sgst")) {
      if (l.includes("igst") || l.includes("cgst")) s.cgst += absVal;
      else if (l.includes("sgst")) s.sgst += absVal;
    } 
    else if (l.includes("pay in/pay out obligation") || l.includes("pay in / pay out obligation")) s.payinObligation = absVal;
    else if (l.includes("securities transaction tax") || l.includes("stt")) s.stt = absVal;
    else if (l.includes("taxable value of supply") || l.includes("taxable value")) s.taxableValue = absVal;
    else if (l.includes("exchange transaction charges") || (l.includes("exchange") && l.includes("transaction") && l.includes("charge"))) s.etc = absVal;
    else if (l.includes("clearing charges")) s.clearingCharges = absVal;
    else if (l.includes("sebi turnover fees") || l.includes("sebi turnover fee") || l.includes("sebi turnover")) s.sebiFees = absVal;
    else if (l.includes("stamp duty")) s.stampDuty = absVal;
    else if (l.includes("net amount receivable") || l.includes("net amount payable") || l.includes("net amount receivable/(payable)")) s.netSettlement = val;
  }
  return s;
};

const parseZerodhaPDF = async (text: string): Promise<ContractNoteResult | null> => {
  const summary = extractSummaryFromText(text);
  const tradeDate = getTradeDate(text);
  const aggregateTrades: any[] = [];
  const annexureTrades: any[] = [];
  
  const lines = text.split('\n');
  let inAnnexure = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.toLowerCase().includes("annexure a")) {
      inAnnexure = true;
      continue;
    }

    const tokens = line.split(/\s+/);
    
    // Row detection logic
    const isinMatch = tokens.findIndex(t => t.match(/INE[A-Z0-9]{9}\d/));
    
    if (inAnnexure && tokens.length >= 8) {
      // Look for the B/S indicator
      const sideIdx = tokens.findIndex((t, idx) => idx >= 1 && (t === 'B' || t === 'S'));
      const exchangeIdx = sideIdx + 1;
      if (sideIdx !== -1 && exchangeIdx < tokens.length && (tokens[exchangeIdx] === 'NSE' || tokens[exchangeIdx] === 'BSE')) {
          const side = tokens[sideIdx] === 'B' ? 'Buy' : 'Sell';
          // Find security name before sideIdx, omitting IDs (7+ digits) and times
          const nameTokens = tokens.slice(0, sideIdx).filter(t => !t.match(/^\d{7,}$/) && !t.match(/^\d{2}:\d{2}:\d{2}$/));
          const security = nameTokens.join(" ");
          
          let qtyTokens = tokens.slice(sideIdx + 2);
          // Zerodha Annexure: Qty is 2 tokens away from B/S, Brokerage 3, Price 4
          const qty = Math.abs(parseNumber(tokens[sideIdx + 2]));
          const brok = parseNumber(tokens[sideIdx + 3]);
          const price = parseNumber(tokens[sideIdx + 4]);
          
          if (qty > 0 && price > 0) {
            annexureTrades.push({ securityName: security, quantity: qty, price, brokeragePerShare: brok, type: side });
          }
          continue;
      }
    }

    // Try Aggregate Table logic if not matched in Annexure or not in Annexure section
    if (isinMatch !== -1) {
      const isin = tokens[isinMatch].match(/INE[A-Z0-9]{9}\d/)?.[0];
      let numStartIdx = isinMatch + 1;
      // Skip name tokens to find first number
      while (numStartIdx < tokens.length && !tokens[numStartIdx].match(/^\(?[0-9,.-−]+\)?$/)) {
        numStartIdx++;
      }
      
      if (numStartIdx < tokens.length) {
        // Main table row detection
        const buyQty = Math.abs(parseNumber(tokens[numStartIdx]));
        const sellQty = numStartIdx + 5 < tokens.length ? Math.abs(parseNumber(tokens[numStartIdx + 5])) : 0;
        
        if (buyQty > 0 || sellQty > 0) {
          const name = tokens.slice(isinMatch + (tokens[isinMatch] === isin ? 1 : 0), numStartIdx).join(" ");
          if (buyQty > 0) {
            const price = numStartIdx + 1 < tokens.length ? parseNumber(tokens[numStartIdx + 1]) : 0;
            const brok = numStartIdx + 2 < tokens.length ? parseNumber(tokens[numStartIdx + 2]) : 0;
            if (price > 0) aggregateTrades.push({ securityName: name, quantity: buyQty, price, brokeragePerShare: brok, type: 'Buy' });
          }
          if (sellQty > 0) {
            const price = numStartIdx + 6 < tokens.length ? parseNumber(tokens[numStartIdx + 6]) : 0;
            const brok = numStartIdx + 7 < tokens.length ? parseNumber(tokens[numStartIdx + 7]) : 0;
            if (price > 0) aggregateTrades.push({ securityName: name, quantity: sellQty, price, brokeragePerShare: brok, type: 'Sell' });
          }
        }
      }
    }
  }

  // Use Annexure trades if available as they are more granular, otherwise use aggregate
  const rawTrades = annexureTrades.length > 0 ? annexureTrades : aggregateTrades;

  if (rawTrades.length === 0) return null;

  const merged: any[] = [];
  rawTrades.forEach(t => {
    const last = merged[merged.length - 1];
    if (last && last.securityName === t.securityName && last.type === t.type && Math.abs(last.price - t.price) < 0.001) {
        last.quantity += t.quantity;
    } else {
        merged.push({ ...t });
    }
  });

  return finalizeContractNote(summary, merged, tradeDate, "zp");
};

const extractSummary = (doc: Document): Summary => {
  const s: Summary = { payinObligation: 0, stt: 0, taxableValue: 0, cgst: 0, sgst: 0, etc: 0, sebiFees: 0, clearingCharges: 0, stampDuty: 0, ipf: 0, netSettlement: 0 };
  const tables = Array.from(doc.querySelectorAll("table"));
  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll("tr"));
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const text = cleanText(row.textContent);
      if (text.includes("security name") || text.includes("isin") || text.includes("symbol")) continue;
      if (text.match(/payin|payout|stt|securities transaction|taxable value|stamp duty|sebi|cgst|sgst|transaction charge|net amount/)) {
        const cells = Array.from(row.querySelectorAll("td, th"));
        if (text.includes("exchange") && (text.includes("clg") || text.includes("corp"))) {
          const colMap: any = {};
          cells.forEach((c, idx) => {
            const t = cleanText(c.textContent);
            if (t.includes("payin") || t.includes("payout")) colMap.payin = idx;
            else if (t.includes("securities transaction") || t.includes("stt")) colMap.stt = idx;
            else if (t.includes("taxable value")) colMap.taxable = idx;
            else if (t.includes("cgst")) colMap.cgst = idx;
            else if (t.includes("sgst") || t.includes("utgst")) colMap.sgst = idx;
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
            const t = cleanText(r.textContent);
            if (!(t.includes("total") || t.match(/fo\/|fo |-fo/)) && t.match(/cm\/|cm |-cm|capital market|nse-cm|bse-cm/)) {
              const cRaw = Array.from(r.querySelectorAll("td"));
              if (colMap.payin !== undefined && cRaw[colMap.payin]) s.payinObligation = parseNumber(cRaw[colMap.payin].textContent);
              if (colMap.stt !== undefined && cRaw[colMap.stt]) s.stt = parseNumber(cRaw[colMap.stt].textContent);
              if (colMap.taxable !== undefined && cRaw[colMap.taxable]) s.taxableValue = parseNumber(cRaw[colMap.taxable].textContent);
              if (colMap.cgst !== undefined && cRaw[colMap.cgst]) s.cgst = parseNumber(cRaw[colMap.cgst].textContent);
              if (colMap.sgst !== undefined && cRaw[colMap.sgst]) s.sgst = parseNumber(cRaw[colMap.sgst].textContent);
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
          const nextRow = rows[i+1];
          if (!nextRow) continue;
          const nextCells = Array.from(nextRow.querySelectorAll("td"));
          cells.forEach((c, idx) => {
            const t = cleanText(c.textContent);
            const val = nextCells[idx] ? parseNumber(nextCells[idx].textContent) : 0;
            if (val !== 0) {
              if (t.includes("payin") || t.includes("payout")) s.payinObligation = val;
              else if (t.includes("securities transaction") || t.includes("stt") || (t.includes("trans") && t.includes("tax") && !t.includes("exchange"))) s.stt = val;
              else if (t.includes("taxable value")) s.taxableValue = val;
              else if (t.includes("cgst")) s.cgst = val;
              else if (t.includes("sgst") || t.includes("utgst")) s.sgst = val;
              else if (t.includes("exchange transaction") || t.includes("transaction charge")) s.etc = val;
              else if (t.includes("sebi turnover") || t.includes("sebi fee")) s.sebiFees = val;
              else if (t.includes("exchange clearing") || t.includes("clearing chrg")) s.clearingCharges += val;
              else if (t.includes("stamp duty")) s.stampDuty = val;
              else if (t.includes("ipf") || t.includes("investor protection")) s.ipf = val;
              else if (t.includes("net amount") || (t.includes("net") && t.includes("receivable"))) s.netSettlement = val;
            }
          });
        }
      }
    }
  }
  return s;
};

const extractStandardTrades = (doc: Document): any[] => {
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
            if (q > 0) trades.push({ securityName: name, quantity: q, price: buyPriceIdx !== -1 ? parseNumber(cells[buyPriceIdx].textContent) : 0, brokeragePerShare: buyBrokIdx !== -1 ? parseNumber(cells[buyBrokIdx].textContent) : 0, type: "Buy" });
          }
          if (cells[sellIdx]) {
            const q = parseNumber(cells[sellIdx].textContent);
            if (q > 0) trades.push({ securityName: name, quantity: q, price: sellPriceIdx !== -1 ? parseNumber(cells[sellPriceIdx].textContent) : 0, brokeragePerShare: sellBrokIdx !== -1 ? parseNumber(cells[sellBrokIdx].textContent) : 0, type: "Sell" });
          }
        }
        if (trades.length > 0) return trades;
      }
    }
  }
  return trades;
};

export const parseStandardContractNote = async (html: string): Promise<ContractNoteResult | null> => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const summary = extractSummary(doc);
  const rawTrades = extractStandardTrades(doc);
  const tradeDate = getTradeDate(doc);
  
  if (rawTrades.length === 0) return null;

  return finalizeContractNote(summary, rawTrades, tradeDate, "s");
};

export const parseIntegratedContractNote = async (html: string): Promise<ContractNoteResult | null> => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const summary = extractSummary(doc);
  const rawTrades: any[] = [];
  const tables = Array.from(doc.querySelectorAll("table"));
  const segments = ["capital market segment of national clearing ltd. (exchange : nse)", "capital market segment of national clearing ltd. (exchange : bse)"];
  
  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll("tr"));
    let curSeg = "";
    let colMap: any = { security: -1, type: -1, qty: -1, price: -1, brokerage: -1, net: -1, netIsRate: true };
    let inTable = false;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const cells = Array.from(row.querySelectorAll("td, th"));
        const text = cleanText(row.textContent);
        if (text.includes("segment name")) { curSeg = text.replace("segment name", "").trim(); continue; }
        if (text.includes("security/contract") && text.includes("quantity")) {
            cells.forEach((c, idx) => {
                const t = cleanText(c.textContent);
                if (t.includes("security") || t.includes("contract")) colMap.security = idx;
                else if (t.includes("buy") && t.includes("sell")) colMap.type = idx;
                else if (t.includes("quantity")) colMap.qty = idx;
                else if (t.includes("gross rate") || t.includes("trade price")) { if (colMap.price === -1) colMap.price = idx; }
                else if (t.includes("brokerage")) colMap.brokerage = idx;
                else if (t.match(/net rate|net value|net amount|net total/)) { colMap.net = idx; colMap.netIsRate = t.includes("rate") || t.includes("price"); }
            });
            if (colMap.security !== -1 && colMap.qty !== -1) inTable = true;
            continue;
        }
        if (inTable && segments.some(s => curSeg.includes(s))) {
            if (cells.length < 5) continue;
            const name = cells[colMap.security]?.textContent?.trim();
            if (!name || cleanText(name).includes("total")) continue;
            const typeStr = cleanText(cells[colMap.type]?.textContent);
            const side = typeStr.includes("buy") ? "Buy" : typeStr.includes("sell") ? "Sell" : null;
            const qty = Math.abs(parseNumber(cells[colMap.qty]?.textContent));
            if (side && qty > 0) {
                const brok = colMap.brokerage !== -1 ? parseNumber(cells[colMap.brokerage]?.textContent) : 0;
                let price = 0;
                if (colMap.net !== -1) {
                    let netVal = Math.abs(parseNumber(cells[colMap.net]?.textContent));
                    if (colMap.netIsRate) netVal = netVal * qty;
                    const totalBrok = brok * qty;
                    price = (side === "Buy" ? netVal - totalBrok : netVal + totalBrok) / qty;
                } else { price = parseNumber(cells[colMap.price]?.textContent); }
                rawTrades.push({ securityName: name, quantity: qty, price, brokeragePerShare: brok, type: side });
            }
        }
    }
  }
  if (rawTrades.length === 0) return null;
  const tradeDate = getTradeDate(doc);
  const stats = new Map();
  rawTrades.forEach(t => {
    const k = `${cleanText(t.securityName)}|${t.type}`;
    if (stats.has(k)) {
        const o = stats.get(k);
        const q = o.quantity + t.quantity;
        o.price = (o.quantity * o.price + t.quantity * t.price) / q;
        o.brokeragePerShare = (o.quantity * o.brokeragePerShare + t.quantity * t.brokeragePerShare) / q;
        o.quantity = q;
    } else stats.set(k, { ...t });
  });
  return finalizeContractNote(summary, Array.from(stats.values()), tradeDate, "i");
};

const finalizeContractNote = (summary: Summary, rawTrades: any[], tradeDate: string, prefix: string): ContractNoteResult => {
  const securityStats = new Map();
  rawTrades.forEach(t => {
    if (!securityStats.has(t.securityName)) securityStats.set(t.securityName, { buyQty: 0, sellQty: 0, types: new Set() });
    const s = securityStats.get(t.securityName);
    s.types.add(t.type);
    if (t.type === "Buy") s.buyQty += t.quantity; else s.sellQty += t.quantity;
  });

  const rt = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

  const totalTurnover = rawTrades.reduce((sum, t) => sum + (t.quantity * t.price), 0);
  const totalBuyTurnover = rawTrades.reduce((sum, t) => t.type === "Buy" ? sum + (t.quantity * t.price) : sum, 0);

  const trades: Trade[] = rawTrades.map((t, idx) => {
    const s = securityStats.get(t.securityName);
    const isIntraday = s.types.has("Buy") && s.types.has("Sell");
    const grossTotal = rt(t.quantity * t.price);
    
    // Proportional distribution of summary charges
    const ratio = totalTurnover > 0 ? grossTotal / totalTurnover : 0;
    const buyRatio = totalBuyTurnover > 0 && t.type === "Buy" ? grossTotal / totalBuyTurnover : 0;

    const brokerage = rt(summary.taxableValue * ratio);
    const stt = rt(summary.stt * ratio);
    const etc = rt(summary.etc * ratio);
    const sebiFees = rt(summary.sebiFees * ratio);
    const clearingCharges = rt(summary.clearingCharges * ratio);
    const stampDuty = rt(summary.stampDuty * buyRatio);
    const ipf = rt(summary.ipf * ratio);
    const gst = rt((summary.cgst + summary.sgst) * ratio);

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
        gst,
        totalExpensesInclSTT: rt(totalInclSTT),
        totalExpensesExclSTT: rt(totalExclSTT)
    };
  });

  return { summary, trades };
};

export const detectFormat = (html: string): "integrated" | "standard" | "zerodha" => {
  const t = html.toLowerCase();
  if (t.includes("zerodha")) return "zerodha";
  if (t.includes("segment name") || t.includes("capital market segment of national clearing") || (t.includes("security/contract") && t.includes("buy/sell"))) return "integrated";
  return "standard";
};

export const processFile = async (file: File, password?: string): Promise<ContractNoteResult | null> => {
  try {
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      const text = await extractTextFromPDF(file, password);
      const isZerodha = text.toLowerCase().includes("zerodha");
      if (isZerodha) return await parseZerodhaPDF(text);
      return null;
    }

    const html = await file.text();
    const format = detectFormat(html);
    let res: ContractNoteResult | null = null;
    if (format === "zerodha") res = await parseZerodhaContractNote(html);
    else if (format === "integrated") res = await parseIntegratedContractNote(html);
    else res = await parseStandardContractNote(html);
    if (!res || res.trades.length === 0) {
        res = await parseZerodhaContractNote(html);
        if (!res || res.trades.length === 0) res = await parseStandardContractNote(html);
        if (!res || res.trades.length === 0) res = await parseIntegratedContractNote(html);
    }
    return (res && res.trades.length > 0) ? res : null;
  } catch (e: any) { 
    if (e.message === "PDF_PASSWORD_REQUIRED") {
      throw e;
    }
    console.error("Error processing file:", e);
    return null; 
  }
};


export const mergeResults = (results: ContractNoteResult[]): ContractNoteResult => {
  const summary: Summary = { payinObligation: 0, stt: 0, taxableValue: 0, cgst: 0, sgst: 0, etc: 0, sebiFees: 0, clearingCharges: 0, stampDuty: 0, ipf: 0, netSettlement: 0 };
  const trades: Trade[] = [];
  let id = 0;
  results.forEach(r => {
    summary.payinObligation += r.summary.payinObligation; summary.stt += r.summary.stt; summary.taxableValue += r.summary.taxableValue;
    summary.cgst += r.summary.cgst; summary.sgst += r.summary.sgst; summary.etc += r.summary.etc;
    summary.sebiFees += r.summary.sebiFees; summary.clearingCharges += r.summary.clearingCharges; summary.stampDuty += r.summary.stampDuty; summary.ipf += r.summary.ipf;
    summary.netSettlement += r.summary.netSettlement;
    r.trades.forEach(t => trades.push({ ...t, id: `tx-merged-${id++}` }));
  });
  trades.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  return { summary, trades };
};

export const parseZerodhaContractNote = async (html: string): Promise<ContractNoteResult | null> => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const summary: Summary = { payinObligation: 0, stt: 0, taxableValue: 0, cgst: 0, sgst: 0, etc: 0, sebiFees: 0, clearingCharges: 0, stampDuty: 0, ipf: 0, netSettlement: 0 };
  const tradeDate = getTradeDate(doc);
  
  const tables = Array.from(doc.querySelectorAll('table'));
  
  // 1. Extract Summary
  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll('tr'));
    for (const row of rows) {
      const text = cleanText(row.textContent);
      const valToken = row.querySelector('td:last-child')?.textContent || "";
      const val = parseNumber(valToken);
      if (Math.abs(val) === 0) continue;
      const absVal = Math.abs(val);

      if (text.includes("pay in/pay out obligation") || text.includes("pay in / pay out obligation")) summary.payinObligation = absVal;
      else if (text.includes("securities transaction tax") || text.includes("stt")) summary.stt = absVal;
      else if (text.includes("taxable value")) summary.taxableValue = absVal;
      else if (text.includes("exchange transaction charges") || (text.includes("exchange") && text.includes("transaction") && text.includes("charge"))) summary.etc = absVal;
      else if (text.includes("clearing charges")) summary.clearingCharges = absVal;
      else if (text.includes("sebi turnover fees") || text.includes("sebi turnover fee")) summary.sebiFees = absVal;
      else if (text.includes("stamp duty")) summary.stampDuty = absVal;
      else if (text.includes("net amount receivable") || text.includes("net amount payable")) summary.netSettlement = val;
      else if (text.includes("igst") || text.includes("cgst") || text.includes("sgst")) {
        if (text.includes("igst") || text.includes("cgst")) summary.cgst += absVal;
        else if (text.includes("sgst")) summary.sgst += absVal;
      }
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
          
          const name = cells[colMap.security]?.textContent?.trim();
          if (!name || cleanText(name).includes("total") || cleanText(name).includes("sub-total")) continue;

          const typeStr = cleanText(cells[colMap.type]?.textContent);
          const side = typeStr.includes('b') ? 'Buy' : typeStr.includes('s') ? 'Sell' : null;
          const qty = Math.abs(parseNumber(cells[colMap.qty]?.textContent));
          
          if (side && qty > 0) {
            const price = parseNumber(cells[colMap.price]?.textContent);
            const brok = colMap.brokerage !== -1 ? parseNumber(cells[colMap.brokerage]?.textContent) : 0;
            rawTrades.push({ securityName: name, quantity: qty, price, brokeragePerShare: brok, type: side });
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
    } else {
        merged.push({ ...t });
    }
  });

  return finalizeContractNote(summary, merged, tradeDate, "z");
};

