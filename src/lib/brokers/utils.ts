import { Summary, Trade, ReconciliationStatus } from '../../types';
import * as pdfjs from 'pdfjs-dist';
// Bundle the worker locally (Vite emits it as an app-origin asset) so PDF parsing
// has no runtime dependency on unpkg.com — faster and works offline.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Configure pdfjs worker
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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

// ── ISIN extraction (shared by every broker parser) ──────────────────────────
// A valid ISIN is 12 chars: 2 country letters + 9 alphanumeric + a NUMERIC check
// digit ([A-Z]{2}[A-Z0-9]{9}[0-9]). Requiring that trailing digit is essential.
// The naive /IN[A-Z0-9]{10}/ (no check digit) matches the FIRST "IN…" run in a
// string — which, on a name+ISIN cell, is often a NAME word: "INfrastructu" inside
// "Infrastructures", "INTERNATIONA" inside "International" — landing on a bogus
// 12-char code BEFORE the real ISIN. That fake code passes length guards, is absent
// from the Scrip Master, so the ISIN lookup misses and the scrip silently resolves
// by name (how Genus Power → "Larsen & Toubro"). Indian ISINs start "IN".
export const ISIN_RE = /IN[A-Z0-9]{9}[0-9]/i;

/** The first real ISIN in `s` (a trade row, a "Name-(ISIN)" cell, etc.), upper-cased,
 *  or "" if none. Tolerates a stray space pdf.js can inject inside the code. */
export const extractIsin = (s: string | null | undefined): string => {
  const str = (s || "").toString();
  const direct = str.match(ISIN_RE);
  if (direct) return direct[0].toUpperCase();
  const stripped = str.replace(/\s+/g, "").match(ISIN_RE);
  return stripped ? stripped[0].toUpperCase() : "";
};

/** True when `s` (trimmed) is EXACTLY an ISIN — for legend/summary cells whose
 *  whole content is the bare code. */
export const isIsin = (s: string | null | undefined): boolean =>
  new RegExp(`^${ISIN_RE.source}$`, "i").test((s || "").toString().trim());

/** Strip an ISIN (with any surrounding "-", "(", ")" and spaces) out of a security
 *  name: "Genus Power Infrastructures Lt-(INE955D01029)" → "Genus Power
 *  Infrastructures Lt". Returns the name unchanged when it carries no ISIN. */
export const stripIsin = (name: string | null | undefined): string =>
  (name || "").toString()
    .replace(new RegExp(`\\s*-?\\s*\\(?\\s*${ISIN_RE.source}\\s*\\)?`, "i"), " ")
    .replace(/\s+/g, " ")
    .trim();

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
    "tax", "note", "summary", "page", "for", "the", "of", "and", "with", "from", "oblig", 
    "charges", "stt", "gst", "total", "sgst", "cgst", "igst", "isin", "symbol", 
    "qty", "quantity", "price", "net", "gross", "buy", "sell", "segment", "fno", 
    "derivatives", "sh", "co", "address", "tel", "fax", "email", "to"
  ];

  // 2. Global search for UCC/Client Code/Client ID using regex capture groups
  // This matches terms like "UCC of Client", which is more specific, first.
  // Then matches terms like "Client Code (UCC)", "Client Code(UCC)", "Client Code", "Client ID", "UCC"
  // followed optional special chars like colons, hyphens, pipes, or spaces, and grabs the alphanumeric token.
  const regexes = [
    /(?:ucc\s*of\s*client)\s*[:\-\u2014|.\s]*([A-Za-z0-9]{3,15})/gi,
    /(?:client\s*code\s*\(?\s*ucc\s*\)?|client\s*code|client\s*id|ucc)\s*[:\-\u2014|]*\s*([A-Za-z0-9]{3,15})/gi
  ];

  for (const r of regexes) {
    let match;
    while ((match = r.exec(normalized)) !== null) {
      const val = match[1].trim().toUpperCase();
      if (val && !blacklist.some(b => val.toLowerCase() === b || val.toLowerCase().includes(b))) {
        return val;
      }
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
        const inlineMatch = elText.match(/(?:ucc\s*of\s*client)\s*[:\-\u2014|.\s]*([A-Za-z0-9]{3,15})/i) ||
                            elText.match(/(?:client\s*code\s*\(?\s*ucc\s*\)?|client\s*code|client\s*id|ucc)\s*[:\-\u2014|]*\s*([A-Za-z0-9]{3,15})/i);
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
      
      const items = content.items as any[];
      if (items.length === 0) continue;

      // Group items into lines by Y, THEN order each line left-to-right.
      //
      // This used to be a single sort with a threshold comparator:
      //
      //   if (Math.abs(b.y - a.y) > 5) return b.y - a.y; else return a.x - b.x;
      //
      // which is not a valid total order. Given three items at y = 770 / 766 / 762, the
      // first pair compares by X and the second pair compares by X, but the outer pair
      // compares by Y - the comparator is not transitive, so the result was
      // implementation-defined interleaving. And because no ADJACENT pair ever exceeded
      // the 5pt gap, the newline never fired either, so a table row whose cells wrap onto
      // two or three baselines collapsed into ONE scrambled line. Not theoretical: a
      // Nuvama V3 row came out as
      //   "INE024001021 AEROFL- 29,29,05- EX 10,000 292.6125 0.2926 292.9051 1.00 ..."
      // with a Trade Amt fragment sitting between the scrip name's two halves. That
      // shifted every later cell and turned a 10,000-share BUY at 292.6125 into a
      // 292.9051-share SELL at 1.00 - which then reconciled against itself and passed.
      //
      // Clustering first is a valid total order, and produces identical output wherever
      // the old comparator happened to be consistent - i.e. every note whose rows sit on
      // a single baseline. Only the previously-scrambled rows change.
      const LINE_TOL = 5;
      const byY = [...items].sort((a, b) => b.transform[5] - a.transform[5]);
      const rows: any[][] = [];
      let current: any[] = [];
      let anchorY = byY[0].transform[5];
      for (const item of byY) {
        // Compare against the row's ANCHOR, not the previous item, so a column of
        // slightly-drifting baselines cannot creep into one ever-growing line.
        if (current.length > 0 && Math.abs(item.transform[5] - anchorY) > LINE_TOL) {
          rows.push(current);
          current = [];
          anchorY = item.transform[5];
        }
        current.push(item);
      }
      if (current.length > 0) rows.push(current);
      for (const row of rows) row.sort((a, b) => a.transform[4] - b.transform[4]);

      const pageText = rows
        .map((row) => row.map((item) => item.str).join(" ") + " ")
        .join("\n");
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

  // Exchange equity trades in WHOLE shares. A fractional quantity is not a suspicious
  // value, it is an impossible one - so it can only mean the parser read a rate, an
  // amount, or a fragment of one into the quantity column. Cheap, broker-agnostic, and
  // it catches the whole class of column-shift misparses at the door.
  const isFractionalQuantity = trades.some(
    (t) => Math.abs(t.quantity - Math.round(t.quantity)) > 1e-6,
  );

  // The note prints its own Pay In / Pay Out obligation. Compare it to quantity x rate
  // summed over the trades, which is derived from an entirely different part of the page.
  //
  // This is the check that catches a SELF-CONSISTENT misparse. The net-settlement test
  // above cannot: it recomputes from the same misread cells, so when a Nuvama V3 buy of
  // 10,000 at 292.6125 was read as a sell of 292.9051 at 1.00, its own arithmetic agreed
  // to the paise (292.91 - 6,488.14 = -6,195.23) and the audit passed while every figure
  // on screen was wrong. Compared on magnitude, because the printed obligation is
  // unsigned gross while calculatedObligation is signed (sells positive, buys negative).
  // Only asserted when the note actually printed an obligation, and tolerant enough to
  // ignore rounding: a genuine mismatch here is orders of magnitude, not paise.
  // Tolerance is bounded by the note's OWN charges, and that is not arbitrary: brokers
  // disagree on what the obligation line means. Nuvama V3 prints it GROSS (10,000 x
  // 292.6125 = 29,26,125.00 exactly), while V1/V2 print it NET of brokerage
  // (9,68,010.00 - 968.00 = 9,67,042.00). Whichever convention a broker uses, the gap can
  // never exceed what the note actually charged - so charges + 1 rupee accepts every
  // legitimate convention while still catching a column shift, which misses by orders of
  // magnitude rather than by a brokerage. Compared on magnitude because the printed figure
  // is unsigned gross while calculatedObligation is signed (sells +, buys -).
  const hasPrintedObligation = Math.abs(summary.payinObligation) > 0.005;
  const obligationGap = Math.abs(
    Math.abs(calculatedObligation) - Math.abs(summary.payinObligation),
  );
  const isObligationMismatch = hasPrintedObligation && obligationGap > totalCharges + 1.0;

  const isValid =
    difference <= 0.10 &&
    !isSuspiciousStt &&
    !isSttMismatch &&
    !isFractionalQuantity &&
    !isObligationMismatch;

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
    // Most specific cause first - "Parser uncertain" tells you nothing actionable.
    statusText: isFractionalQuantity
      ? 'Fractional quantity'
      : isObligationMismatch
        ? 'Obligation mismatch'
        : isSuspiciousStt
          ? 'Suspicious STT'
          : (isValid ? 'PASSED' : 'Parser uncertain'),
    isSuspiciousStt,
    isSttMismatch,
    isFractionalQuantity,
    isObligationMismatch
  };
};
