import { ContractNoteResult, Summary, Trade } from '../types';
import { extractTextFromPDF, calculateReconciliation } from './brokers/utils';
import { getBroker, detectBroker } from './brokers/registry';

export { calculateReconciliation };

/**
 * Parses raw PDF text by detecting the broker contents automatically.
 * Supports the diagnostic regression tests by mapping directly to strategies.
 */
export const parsePdfContractNote = async (text: string): Promise<ContractNoteResult | null> => {
  const broker = detectBroker(text, true);
  // Default to Zerodha if auto-detection fails to parse, for backward compatibility with older test runners
  let result = await broker.parsePdfText(text);
  if (!result && broker.id !== 'zerodha') {
    result = await getBroker('zerodha').parsePdfText(text);
  }
  return result;
};

/**
 * Orchestrates file processing (PDF extraction and format detection) and
 * delegates HTML/PDF parsing to the chosen or detected Broker strategy.
 */
export const processFile = async (
  file: File,
  password?: string,
  brokerId?: 'auto' | 'zerodha' | 'shareindia' | 'integrated' | 'standard'
): Promise<ContractNoteResult | null> => {
  try {
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    
    if (isPdf) {
      const text = await extractTextFromPDF(file, password);
      const broker = (!brokerId || brokerId === 'auto') 
        ? detectBroker(text, true) 
        : getBroker(brokerId);
      
      const res = await broker.parsePdfText(text);
      if (res) res.rawText = text;
      return res;
    }

    const html = await file.text();
    const broker = (!brokerId || brokerId === 'auto') 
      ? detectBroker(html, false) 
      : getBroker(brokerId);
    
    let res = await broker.parseHtml(html);
    if (res && res.trades.length > 0) {
      res.rawText = res.rawText || html;
      return res;
    }
    
    return null;
  } catch (e: any) {
    if (e.message === "PDF_PASSWORD_REQUIRED" || (e.message && (e.message.startsWith("Invalid Contract Note") || e.message.includes("FnO")))) {
      throw e;
    }
    console.error("Error processing file:", e);
    return null;
  }
};

/**
 * Aggregates a multi-file collection score and trades trace into a consolidated result.
 */
export const mergeResults = (results: ContractNoteResult[]): ContractNoteResult => {
  const summary: Summary = { 
    payinObligation: 0, 
    stt: 0, 
    taxableValue: 0, 
    cgst: 0, 
    sgst: 0, 
    igst: 0, 
    gst: 0, 
    etc: 0, 
    sebiFees: 0, 
    clearingCharges: 0, 
    stampDuty: 0, 
    ipf: 0, 
    netSettlement: 0 
  };
  const trades: Trade[] = [];
  let id = 0;
  let mergedBrokerName = "";
  let mergedTradeDate = "";
  let mergedUcc = "";
  
  results.forEach(r => {
    summary.payinObligation += r.summary.payinObligation; 
    summary.stt += r.summary.stt; 
    summary.taxableValue += r.summary.taxableValue;
    summary.cgst += r.summary.cgst; 
    summary.sgst += r.summary.sgst; 
    summary.igst += r.summary.igst; 
    summary.gst += r.summary.gst; 
    summary.etc += r.summary.etc;
    summary.sebiFees += r.summary.sebiFees; 
    summary.clearingCharges += r.summary.clearingCharges; 
    summary.stampDuty += r.summary.stampDuty; 
    summary.ipf += r.summary.ipf;
    summary.netSettlement += r.summary.netSettlement;
    
    r.trades.forEach(t => trades.push({ ...t, id: `tx-merged-${id++}` }));
    if (r.brokerName) mergedBrokerName = r.brokerName;
    if (r.tradeDate) mergedTradeDate = r.tradeDate;
    if (r.ucc) mergedUcc = r.ucc;
  });
  
  const mergedRawText = results.map(r => r.rawText).filter(Boolean).join("\n\n=== NEXT FILE ===\n\n");
  
  trades.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  return { summary, trades, brokerName: mergedBrokerName, tradeDate: mergedTradeDate, ucc: mergedUcc, rawText: mergedRawText };
};
export const detectFormat = (html: string): "integrated" | "standard" | "zerodha" => {
  const broker = detectBroker(html, false);
  return broker.id as "integrated" | "standard" | "zerodha";
};
