import { Summary, Trade, ReconciliationStatus } from '../../types';
import * as pdfjs from 'pdfjs-dist';

// Configure pdfjs worker
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

export const parseNumber = (str: string | null): number => {
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

export const cleanText = (str: string | null): string => 
  (str?.toLowerCase().replace(/\s+/g, ' ').trim()) || "";

export const isFootnoteOrDisclaimer = (text: string | null): boolean => {
  if (!text) return false;
  const l = text.toLowerCase();
  if (l.includes("pure agent") || 
      l.includes("collecting") || 
      l.includes("is levied") || 
      l.includes("is payable") ||
      l.includes("not considered") ||
      l.includes("provisions of the") ||
      l.includes("rules, bye-laws") ||
      l.includes("authorized signatory") ||
      l.includes("complaints@") ||
      l.includes("compliance officer") ||
      l.includes("proprietary trading") ||
      l.includes("disclosure:") ||
      l.includes("disclaimer:") ||
      l.includes("with the rules") ||
      l.includes("under section") ||
      l.includes("subject to the rules")
  ) {
    return true;
  }
  if (l.length > 100 && (l.includes("the") || l.includes("and") || l.includes("for") || l.includes("with"))) {
    return true;
  }
  return false;
};

export const getTradeDate = (doc: Document | string): string => {
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

export const getUCC = (doc: Document | string): string => {
  const textContent = typeof doc === 'string' 
    ? doc 
    : (doc.body?.textContent || doc.documentElement?.textContent || "");

  if (!textContent) return "";

  // 1. Normalize all spaces, tabs, newlines, and non-breaking spaces (\u00a0) to clean single spaces
  const normalized = textContent
    .replace(/[\u00a0\s\t\n\r]+/g, ' ')
    .trim();

  const blacklist = [
    "no", "na", "trade", "date", "contract", "client", "code", "pan", "number", "name", 
    "limited", "pvt", "india", "broker", "member", "sebi", "bse", "nse", "invoice", 
    "tax", "note", "summary", "page", "for", "the", "and", "with", "from", "oblig", 
    "charges", "stt", "gst", "total", "sgst", "cgst", "igst", "isin", "symbol", 
    "qty", "quantity", "price", "net", "gross", "buy", "sell", "segment", "fno", 
    "derivatives", "sh", "co", "address", "tel", "fax", "email"
  ];

  // 2. Global search for UCC/Client Code/Client ID using regex capture groups
  // This matches terms like "Client Code (UCC)", "Client Code(UCC)", "Client Code", "Client ID", "UCC"
  // followed optional special chars like colons, hyphens, pipes, or spaces, and grabs the alphanumeric token.
  const regex = /(?:client\s*code\s*\(?\s*ucc\s*\)?|client\s*code|client\s*id|ucc)\s*[:\-\u2014|]*\s*([A-Za-z0-9]{3,15})/gi;

  let match;
  while ((match = regex.exec(normalized)) !== null) {
    const val = match[1].trim().toUpperCase();
    if (val && !blacklist.some(b => val.toLowerCase() === b || val.toLowerCase().includes(b))) {
      return val;
    }
  }

  // Sibling lookup fallback for DOM Document if regex on raw text didn't match
  if (typeof doc !== 'string') {
    const elements = Array.from(doc.querySelectorAll("td, th, p, span, div, font, b, strong"));
    for (const el of elements) {
      const txt = (el.textContent || "").toLowerCase();
      if (txt.includes("client code") || txt.includes("ucc")) {
        // First check inside the element itself if it contains a value
        const elText = el.textContent || "";
        const inlineMatch = elText.match(/(?:client\s*code\s*\(?\s*ucc\s*\)?|client\s*code|client\s*id|ucc)\s*[:\-\u2014|]*\s*([A-Za-z0-9]{3,15})/i);
        if (inlineMatch && inlineMatch[1]) {
          const val = inlineMatch[1].trim().toUpperCase();
          if (val && !blacklist.some(b => val.toLowerCase() === b || val.toLowerCase().includes(b))) {
            return val;
          }
        }

        // Try checking sibling components
        let next = el.nextElementSibling;
        let count = 0;
        while (next && count < 4) {
          const nextTxt = next.textContent || "";
          if (nextTxt.trim().length > 0) {
            const cleanToken = nextTxt.trim().split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, '');
            if (cleanToken && cleanToken.length >= 3 && cleanToken.length <= 15 && !blacklist.some(b => cleanToken.toLowerCase() === b || cleanToken.toLowerCase().includes(b))) {
              return cleanToken.toUpperCase();
            }
            count++;
          }
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
        if (Math.abs(yDiff) > 5) return yDiff; // Use a threshold of 5 points for same line
        return a.transform[4] - b.transform[4]; // X coordinate
      });

      let pageText = "";
      let lastY = items[0].transform[5];
      
      for (const item of items) {
        if (Math.abs(item.transform[5] - lastY) > 5) {
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

export const calculateReconciliation = (summary: Summary, trades: Trade[]): ReconciliationStatus => {
  const totalBuys = trades.filter(t => t.transactionType === "Buy").reduce((sum, t) => sum + t.turnover, 0);
  const totalSells = trades.filter(t => t.transactionType === "Sell").reduce((sum, t) => sum + t.turnover, 0);
  
  const calculatedObligation = totalSells - totalBuys;
  const totalCharges = 
    summary.taxableValue + // brokerage
    summary.stt + 
    summary.etc + 
    summary.sebiFees + 
    summary.clearingCharges + 
    summary.stampDuty + 
    summary.ipf + 
    summary.gst;

  const calculatedNet = calculatedObligation - totalCharges;
  const extractedNet = summary.netSettlement;
  const difference = Math.abs(calculatedNet - extractedNet);
  const totalTurnover = totalBuys + totalSells;
  const isSuspiciousStt = summary.stt < 10 && totalTurnover > 100000;
  
  const sumGeneratedStt = trades.reduce((sum, t) => sum + t.stt, 0);
  const isSttMismatch = Math.abs(sumGeneratedStt - summary.stt) > 0.10;
  const isValid = difference <= 0.10 && !isSuspiciousStt && !isSttMismatch;

  return {
    isValid,
    totalBuys: Math.round(totalBuys * 100) / 100,
    totalSells: Math.round(totalSells * 100) / 100,
    calculatedObligation: Math.round(calculatedObligation * 100) / 100,
    extractedObligation: summary.payinObligation,
    totalCharges: Math.round(totalCharges * 100) / 100,
    calculatedNet: Math.round(calculatedNet * 100) / 100,
    extractedNet,
    difference: Math.round(difference * 100) / 100,
    statusText: isSuspiciousStt ? 'Suspicious STT' : (isValid ? 'PASSED' : 'Parser uncertain'),
    isSuspiciousStt,
    isSttMismatch
  };
};
