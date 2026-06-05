import { ContractNoteResult, Summary, Trade, TransactionType } from '../types';

export interface AuditIssue {
  id: string;
  category: 'Trade' | 'Charge' | 'Structural';
  severity: 'Critical' | 'Major' | 'Minor';
  title: string;
  description: string;
  expected: string;
  actual: string;
  impactValue: number;
}

export interface ComparisonRow {
  item: string;
  contractNote: number;
  csv: number;
  match: boolean;
  status: 'match' | 'mismatch' | 'not-present';
}

export interface AuditReport {
  brokerName: string;
  clientName: string;
  tradeDate: string;
  settlementDate: string;
  totalTransactions: number;
  buyCount: number;
  sellCount: number;
  comparisonTable: ComparisonRow[];
  criticalIssues: AuditIssue[];
  rootCauses: string[];
  totalErrors: number;
  criticalCount: number;
  majorCount: number;
  minorCount: number;
  totalDiscrepancy: number;
  verdict: {
    isCorrect: boolean;
    safeForTax: boolean;
    generalStatus: string;
    actionNeeded: string;
  };
  reconciliation?: {
    wapTable: { stock: string; roundedWap: number; preciseWap: number }[];
    correctedAmountsTable: { stock: string; currentAmt: number; correctedAmt: number }[];
    correctedSttTable: { stock: string; currentStt: number; correctedStt: number; transactionAmt: number }[];
    finalCheck: {
      buyTotal: { expected: number; actual: number; matches: boolean };
      sellTotal: { expected: number; actual: number; matches: boolean };
      net: { expected: number; actual: number; matches: boolean };
      stt: { expected: number; actual: number; matches: boolean };
      netPayable: { expected: number; actual: number; matches: boolean };
    };
    correctedCsv: string;
  };
}

// Robust CSV Parsing
export function parseCSV(text: string): string[][] {
  const lines: string[][] = [];
  let row: string[] = [];
  let inQuotes = false;
  let currentVal = '';
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentVal += '"';
        i++; // skip next double quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(currentVal.trim());
      currentVal = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\n' || nextChar !== '\n') {
        row.push(currentVal.trim());
        if (row.length > 0 && row.some(cell => cell !== '')) {
          lines.push(row);
        }
        row = [];
        currentVal = '';
      }
    } else {
      currentVal += char;
    }
  }
  if (currentVal || row.length > 0) {
    row.push(currentVal.trim());
    if (row.some(cell => cell !== '')) {
      lines.push(row);
    }
  }
  return lines;
}

const normalizeName = (name: string): string => {
  return name.toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/LTD$/, '')
    .replace(/LIMITED$/, '')
    .replace(/EQ$/, '')
    .replace(/INE\d+[A-Z0-9]+/, '') // Strip ISIN code if appended
    .trim();
};

const parseNumber = (str: string | null): number => {
  if (!str) return 0;
  let val = str.trim().replace(/,/g, '').replace(/[^\d.-]/g, '');
  const parsed = parseFloat(val);
  return isNaN(parsed) ? 0 : parsed;
};

export const runAudit = (cnData: ContractNoteResult, csvText: string, cnFileName?: string): AuditReport => {
  const csvRowsRaw = parseCSV(csvText);
  if (csvRowsRaw.length === 0) {
    throw new Error("CSV file appears to be empty or malformed");
  }

  // 1. Detect Header Row and Column Map
  let headerRowIndex = -1;
  const colMap = {
    security: -1,
    type: -1,
    qty: -1,
    price: -1,
    brokerage: -1,
    stt: -1,
    etc: -1,
    sebi: -1,
    stamp: -1,
    gst: -1,
    turnover: -1,
  };

  for (let i = 0; i < Math.min(csvRowsRaw.length, 10); i++) {
    const row = csvRowsRaw[i].map(x => x.toLowerCase().trim());
    const hasSecurity = row.some(x => x.includes('security') || x.includes('symbol') || x.includes('scrip') || x.includes('stock') || x.includes('scrip name') || x.includes('contract'));
    const hasQty = row.some(x => x.includes('qty') || x.includes('quantity') || x.includes('shares') || x.includes('volume'));
    const hasPrice = row.some(x => x.includes('price') || x.includes('rate') || x.includes('avg price') || x.includes('average price'));
    
    if (hasSecurity && (hasQty || hasPrice)) {
      headerRowIndex = i;
      break;
    }
  }

  // Fallback to first row if no header detected
  if (headerRowIndex === -1) {
    headerRowIndex = 0;
  }

  const headers = csvRowsRaw[headerRowIndex].map(x => x.toLowerCase().replace(/[^a-z0-9/_\s]/g, '').trim());
  headers.forEach((h, idx) => {
    if (h.includes('security') || h.includes('symbol') || h.includes('scrip') || h.includes('particular') || h.includes('stock') || h.includes('name') || h.includes('contract')) colMap.security = idx;
    else if (h.includes('type') || h.includes('action') || h.includes('buy/sell') || h.includes('buysell') || h.includes('trans') || h.includes('side')) colMap.type = idx;
    else if (h.includes('qty') || h.includes('quantity') || h.includes('shares') || h.includes('number of shares') || h.includes('volume')) colMap.qty = idx;
    else if (h.includes('price') || h.includes('rate') || h.includes('avg') || h.includes('average')) colMap.price = idx;
    else if (h.includes('brokerage') || h.includes('commission')) colMap.brokerage = idx;
    else if (h.includes('stt') || h.includes('securities transaction tax') || h.includes('securities trn tax')) colMap.stt = idx;
    else if (h.includes('etc') || h.includes('exchange transaction') || h.includes('exchange charges') || h.includes('exchange charge') || h.includes('charges')) {
      if (!h.includes('clearing')) {
        colMap.etc = idx;
      }
    }
    else if (h.includes('sebi') || h.includes('sebi turnover') || h.includes('sebi fee')) colMap.sebi = idx;
    else if (h.includes('stamp') || h.includes('duty')) colMap.stamp = idx;
    else if (h.includes('gst') || h.includes('tax') || h.includes('sgst') || h.includes('cgst') || h.includes('igst')) colMap.gst = idx;
    else if (h.includes('turnover') || h.includes('amount') || h.includes('net total') || h.includes('total amt') || h.includes('total amount') || h.includes('gross') || h.includes('value')) colMap.turnover = idx;
  });

  // 2. Parse CSV Trades
  const csvTrades: any[] = [];
  let csvTotalSTT = 0;
  let csvTotalStamp = 0;
  let csvTotalETC = 0;
  let csvTotalSebi = 0;
  let csvTotalGST = 0;
  let csvTotalBrokerage = 0;
  let csvTotalTurnover = 0;

  for (let i = headerRowIndex + 1; i < csvRowsRaw.length; i++) {
    const row = csvRowsRaw[i];
    if (row.length < 2) continue; // Skip lines with too few columns

    const keyName = colMap.security !== -1 ? row[colMap.security] : '';
    if (!keyName || keyName.toLowerCase().includes('total') || keyName.toLowerCase().includes('subtotal') || keyName.toLowerCase().includes('grand')) continue;

    const qty = Math.abs(parseNumber(colMap.qty !== -1 ? row[colMap.qty] : '1'));
    if (qty <= 0) continue;

    const price = parseNumber(colMap.price !== -1 ? row[colMap.price] : '0');
    const typeRaw = colMap.type !== -1 ? row[colMap.type].toLowerCase() : '';
    const type: TransactionType = (typeRaw.startsWith('b') || typeRaw.includes('buy')) ? 'Buy' : 'Sell';

    const calculatedTurnover = qty * price;
    const specifiedTurnover = colMap.turnover !== -1 ? parseNumber(row[colMap.turnover]) : calculatedTurnover;

    // Detailed charges from CSV row (if listed per-row, else we sum them up if they exist)
    const rowSTT = colMap.stt !== -1 ? parseNumber(row[colMap.stt]) : 0;
    const rowStamp = colMap.stamp !== -1 ? parseNumber(row[colMap.stamp]) : 0;
    const rowETC = colMap.etc !== -1 ? parseNumber(row[colMap.etc]) : 0;
    const rowSebi = colMap.sebi !== -1 ? parseNumber(row[colMap.sebi]) : 0;
    const rowGST = colMap.gst !== -1 ? parseNumber(row[colMap.gst]) : 0;
    const rowBrokerage = colMap.brokerage !== -1 ? parseNumber(row[colMap.brokerage]) : 0;

    csvTotalSTT += rowSTT;
    csvTotalStamp += rowStamp;
    csvTotalETC += rowETC;
    csvTotalSebi += rowSebi;
    csvTotalGST += rowGST;
    csvTotalBrokerage += rowBrokerage;
    csvTotalTurnover += specifiedTurnover;

    csvTrades.push({
      securityName: keyName.trim(),
      normalizedName: normalizeName(keyName),
      transactionType: type,
      quantity: qty,
      avgPrice: price,
      turnover: specifiedTurnover,
      brokerage: rowBrokerage,
      stt: rowSTT,
      etc: rowETC,
      sebiFees: rowSebi,
      stampDuty: rowStamp,
      gst: rowGST,
      rawRowIndex: i
    });
  }

  // Group and consolidate trades for comparison (many exports list order-by-order, CN grouped by security/type)
  const consolidatedCSV = new Map<string, { securityName: string, transactionType: TransactionType, quantity: number, totalVal: number, stt: number, stamp: number, etc: number, sebi: number, gst: number, brokerage: number }>();
  csvTrades.forEach(t => {
    const key = `${t.normalizedName}-${t.transactionType}`;
    if (!consolidatedCSV.has(key)) {
      consolidatedCSV.set(key, {
        securityName: t.securityName,
        transactionType: t.transactionType,
        quantity: 0,
        totalVal: 0,
        stt: 0,
        stamp: 0,
        etc: 0,
        sebi: 0,
        gst: 0,
        brokerage: 0
      });
    }
    const o = consolidatedCSV.get(key)!;
    o.quantity += t.quantity;
    o.totalVal += t.quantity * t.avgPrice;
    o.stt += t.stt;
    o.stamp += t.stamp;
    o.etc += t.etc;
    o.sebi += t.sebiFees;
    o.gst += t.gst;
    o.brokerage += t.brokerage;
  });

  const consolidatedCN = new Map<string, Trade>();
  cnData.trades.forEach(t => {
    const key = `${normalizeName(t.securityName)}-${t.transactionType}`;
    consolidatedCN.set(key, t);
  });

  // Calculate totals
  const cnBuyTotal = cnData.trades.reduce((sum, t) => t.transactionType === "Buy" ? sum + t.turnover : sum, 0);
  const cnSellTotal = cnData.trades.reduce((sum, t) => t.transactionType === "Sell" ? sum + t.turnover : sum, 0);
  const cnNetAmountObligation = cnSellTotal - cnBuyTotal;

  const csvBuyTotal = csvTrades.reduce((sum, t) => t.transactionType === "Buy" ? sum + t.turnover : sum, 0);
  const csvSellTotal = csvTrades.reduce((sum, t) => t.transactionType === "Sell" ? sum + t.turnover : sum, 0);
  const csvNetAmountObligation = csvSellTotal - csvBuyTotal;

  // Let's check charges. If any charge from CSV sums to 0, it means it was not present or left empty.
  const hasSTTColumn = colMap.stt !== -1 && csvTotalSTT > 0;
  const hasStampColumn = colMap.stamp !== -1 && csvTotalStamp > 0;
  const hasETCColumn = colMap.etc !== -1 && csvTotalETC > 0;
  const hasSebiColumn = colMap.sebi !== -1 && csvTotalSebi > 0;
  const hasGSTColumn = colMap.gst !== -1 && csvTotalGST > 0;
  const hasBrokerageColumn = colMap.brokerage !== -1 && csvTotalBrokerage > 0;

  // Compare individual values, compile issues
  const criticalIssues: AuditIssue[] = [];
  const rootCauses: string[] = [];

  let nextIssueId = 1;
  const addIssue = (category: 'Trade' | 'Charge' | 'Structural', severity: 'Critical' | 'Major' | 'Minor', title: string, description: string, expected: number, actual: number, impactValue: number) => {
    criticalIssues.push({
      id: `issue-${nextIssueId++}`,
      category,
      severity,
      title,
      description,
      expected: expected.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      actual: actual.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      impactValue
    });
  };

  // 1. Transaction Verifications
  // Compare trades in Contract Note to see if they are in CSV
  let mismatchCount = 0;
  let totalMismatchedValue = 0;

  cnData.trades.forEach(cnTrade => {
    const key = `${normalizeName(cnTrade.securityName)}-${cnTrade.transactionType}`;
    const csvTrade = consolidatedCSV.get(key);

    if (!csvTrade) {
      addIssue(
        'Trade',
        'Critical',
        `Missing Security: ${cnTrade.securityName} (${cnTrade.transactionType})`,
        `The contract note records a trade of ${cnTrade.quantity} shares of ${cnTrade.securityName} which is entirely missing from the CSV file.`,
        cnTrade.turnover,
        0,
        cnTrade.turnover
      );
      mismatchCount++;
      totalMismatchedValue += cnTrade.turnover;
    } else {
      // Compare Quantity
      if (cnTrade.quantity !== csvTrade.quantity) {
        const diffQty = Math.abs(cnTrade.quantity - csvTrade.quantity);
        const monetaryDiff = diffQty * cnTrade.avgPrice;
        addIssue(
          'Trade',
          'Critical',
          `Quantity Mismatch: ${cnTrade.securityName} (${cnTrade.transactionType})`,
          `The contract note records ${cnTrade.quantity} shares, but the CSV file only records ${csvTrade.quantity} shares (difference of ${diffQty} shares).`,
          cnTrade.quantity,
          csvTrade.quantity,
          monetaryDiff
        );
        mismatchCount++;
        totalMismatchedValue += monetaryDiff;
      }
      
      // Compare Avg Price
      if (Math.abs(cnTrade.avgPrice - (csvTrade.totalVal / csvTrade.quantity)) > 0.05) {
        const csvAvgPrice = csvTrade.totalVal / csvTrade.quantity;
        const diffPrice = Math.abs(cnTrade.avgPrice - csvAvgPrice);
        const monetaryDiff = cnTrade.quantity * diffPrice;
        addIssue(
          'Trade',
          'Major',
          `Price Mismatch: ${cnTrade.securityName} (${cnTrade.transactionType})`,
          `The average price in the contract note is ₹${cnTrade.avgPrice.toFixed(2)}, but the CSV average price is ₹${csvAvgPrice.toFixed(2)} (difference of ₹${diffPrice.toFixed(2)} per share).`,
          cnTrade.avgPrice,
          csvAvgPrice,
          monetaryDiff
        );
        mismatchCount++;
        totalMismatchedValue += monetaryDiff;
      }

      // Check Quantity x Price = Turnover in CSV
      const indexMatchTrades = csvTrades.filter(t => t.normalizedName === normalizeName(cnTrade.securityName) && t.transactionType === cnTrade.transactionType);
      indexMatchTrades.forEach(rowT => {
        const calculated = rowT.quantity * rowT.avgPrice;
        if (Math.abs(rowT.turnover - calculated) > 0.02) {
          addIssue(
            'Structural',
            'Major',
            `Turnover Mismatch: Row ${rowT.rawRowIndex} (${rowT.securityName})`,
            `The calculated turnover (Quantity × Price) of ₹${calculated.toFixed(2)} does not match the turnover value specified in the CSV of ₹${rowT.turnover.toFixed(2)}.`,
            calculated,
            rowT.turnover,
            Math.abs(calculated - rowT.turnover)
          );
          mismatchCount++;
          totalMismatchedValue += Math.abs(calculated - rowT.turnover);
        }
      });
    }
  });

  // Check for foreign trades in CSV that are NOT in Contract Note
  consolidatedCSV.forEach((csvTrade, key) => {
    if (!consolidatedCN.has(key)) {
      addIssue(
        'Trade',
        'Critical',
        `Unrecognized Trade in CSV: ${csvTrade.securityName} (${csvTrade.transactionType})`,
        `The CSV records a trade of ${csvTrade.quantity} shares of ${csvTrade.securityName} which does not exist in the official contract note.`,
        0,
        csvTrade.totalVal,
        csvTrade.totalVal
      );
      mismatchCount++;
      totalMismatchedValue += csvTrade.totalVal;
    }
  });

  // 2. Charge and Tax Verifications
  const cnSummary = cnData.summary;
  const cnTotalGST = cnSummary.gst;

  // STT Rule: Distributed proportionally across both BUY and SELL trades (turnover-based)
  csvTrades.forEach(t => {
    // Check if the individual STT is a reasonable proportion of the total STT of the note
    const expectedRatio = totalTurnover > 0 ? (t.turnover / totalTurnover) : 0;
    const expectedSTTCopy = cnSummary.stt * expectedRatio;
    if (t.stt > 0 && Math.abs(t.stt - expectedSTTCopy) > 10.0) {
      addIssue(
        'Charge',
        'Minor',
        `STT allocation discrepancy: Row ${t.rawRowIndex} (${t.securityName})`,
        `STT of ₹${t.stt.toFixed(2)} differs from the proportional expected allocation of ₹${expectedSTTCopy.toFixed(2)}.`,
        expectedSTTCopy,
        t.stt,
        Math.abs(t.stt - expectedSTTCopy)
      );
    }
  });

  // Stamp Duty Rule: On BUY ONLY (usually 0.015%)
  csvTrades.forEach(t => {
    if (t.stampDuty > 0 && t.transactionType === 'Sell') {
      addIssue(
        'Charge',
        'Major',
        `Stamp Duty charged on SELL: Row ${t.rawRowIndex} (${t.securityName})`,
        `Stamp Duty of ₹${t.stampDuty.toFixed(2)} was charged on a SELL order. Stamp Duty is only levied on BUY transactions.`,
        0,
        t.stampDuty,
        t.stampDuty
      );
    }
    if (t.transactionType === 'Buy' && t.stampDuty > 0) {
      const expectedStamp = t.turnover * 0.00015;
      if (Math.abs(t.stampDuty - expectedStamp) > 0.5) {
        addIssue(
          'Charge',
          'Minor',
          `Stamp Duty Rate Discrepancy: Row ${t.rawRowIndex} (${t.securityName})`,
          `Stamp Duty is ₹${t.stampDuty.toFixed(2)}, expected is ₹${expectedStamp.toFixed(2)} (0.015%).`,
          expectedStamp,
          t.stampDuty,
          Math.abs(t.stampDuty - expectedStamp)
        );
      }
    }
  });

  // GST Rule: 18% applied to Brokerage + ETC + SEBI + Clearing Charges
  csvTrades.forEach(t => {
    if (t.gst > 0) {
      const gstBase = t.brokerage + t.etc + t.sebiFees + (t.clearingCharges || 0);
      const expectedGST = gstBase * 0.18;
      // If GST exceeds expected GST significantly (e.g. they applied GST to STT, which is wrong!)
      if (t.gst > expectedGST + 0.5) {
        const invalidGSTOnSTT = (gstBase + t.stt + t.stampDuty) * 0.18;
        if (Math.abs(t.gst - invalidGSTOnSTT) < 1.0) {
          addIssue(
            'Charge',
            'Major',
            `Wrong GST Base: Row ${t.rawRowIndex} (${t.securityName})`,
            `GST is ₹${t.gst.toFixed(2)}, which indicates GST was calculated on top of STT and Stamp Duty (double taxation). GST should only apply to Brokerage, Exchange Charges, SEBI fees, and Clearing charges.`,
            expectedGST,
            t.gst,
            t.gst - expectedGST
          );
        } else {
          addIssue(
            'Charge',
            'Major',
            `GST Overstated: Row ${t.rawRowIndex} (${t.securityName})`,
            `GST charged is ₹${t.gst.toFixed(2)} instead of expected ₹${expectedGST.toFixed(2)} (18% of taxable services base ₹${gstBase.toFixed(2)}).`,
            expectedGST,
            t.gst,
            t.gst - expectedGST
          );
        }
      }
    }
  });

  // 3. Compile the Table of Totals
  const comparisonTable: ComparisonRow[] = [
    {
      item: "Buy Total",
      contractNote: cnBuyTotal,
      csv: csvBuyTotal,
      match: Math.abs(cnBuyTotal - csvBuyTotal) < 0.10,
      status: Math.abs(cnBuyTotal - csvBuyTotal) < 0.10 ? 'match' : 'mismatch'
    },
    {
      item: "Sell Total",
      contractNote: cnSellTotal,
      csv: csvSellTotal,
      match: Math.abs(cnSellTotal - csvSellTotal) < 0.10,
      status: Math.abs(cnSellTotal - csvSellTotal) < 0.10 ? 'match' : 'mismatch'
    },
    {
      item: "Net Amount (Obligation)",
      contractNote: cnNetAmountObligation,
      csv: csvNetAmountObligation,
      match: Math.abs(cnNetAmountObligation - csvNetAmountObligation) < 0.10,
      status: Math.abs(cnNetAmountObligation - csvNetAmountObligation) < 0.10 ? 'match' : 'mismatch'
    },
    {
      item: "Securities Transaction Tax (STT)",
      contractNote: cnSummary.stt,
      csv: csvTotalSTT,
      match: hasSTTColumn ? Math.abs(cnSummary.stt - csvTotalSTT) < 0.10 : false,
      status: !hasSTTColumn ? 'not-present' : (Math.abs(cnSummary.stt - csvTotalSTT) < 0.10 ? 'match' : 'mismatch')
    },
    {
      item: "Stamp Duty",
      contractNote: cnSummary.stampDuty,
      csv: csvTotalStamp,
      match: hasStampColumn ? Math.abs(cnSummary.stampDuty - csvTotalStamp) < 0.10 : false,
      status: !hasStampColumn ? 'not-present' : (Math.abs(cnSummary.stampDuty - csvTotalStamp) < 0.10 ? 'match' : 'mismatch')
    },
    {
      item: "Exchange Transaction Charges",
      contractNote: cnSummary.etc,
      csv: csvTotalETC,
      match: hasETCColumn ? Math.abs(cnSummary.etc - csvTotalETC) < 0.10 : false,
      status: !hasETCColumn ? 'not-present' : (Math.abs(cnSummary.etc - csvTotalETC) < 0.10 ? 'match' : 'mismatch')
    },
    {
      item: "SEBI Turnover Fees",
      contractNote: cnSummary.sebiFees,
      csv: csvTotalSebi,
      match: hasSebiColumn ? Math.abs(cnSummary.sebiFees - csvTotalSebi) < 0.10 : false,
      status: !hasSebiColumn ? 'not-present' : (Math.abs(cnSummary.sebiFees - csvTotalSebi) < 0.10 ? 'match' : 'mismatch')
    },
    {
      item: "Goods & Services Tax (GST)",
      contractNote: cnTotalGST,
      csv: csvTotalGST,
      match: hasGSTColumn ? Math.abs(cnTotalGST - csvTotalGST) < 0.10 : false,
      status: !hasGSTColumn ? 'not-present' : (Math.abs(cnTotalGST - csvTotalGST) < 0.10 ? 'match' : 'mismatch')
    },
    {
      item: "Brokerage",
      contractNote: cnSummary.taxableValue,
      csv: csvTotalBrokerage,
      match: hasBrokerageColumn ? Math.abs(cnSummary.taxableValue - csvTotalBrokerage) < 0.10 : false,
      status: !hasBrokerageColumn ? 'not-present' : (Math.abs(cnSummary.taxableValue - csvTotalBrokerage) < 0.10 ? 'match' : 'mismatch')
    }
  ];

  // Calculate Net Settlement for Contract Note: Net Obligation + Net Payout/Charges adjustments.
  // Note: Buy trades add charges, Sell trades subtract charges.
  const cnIpf = cnData.brokerName === 'integrated' ? cnSummary.ipf : 0;
  const cnChargesTotal = cnSummary.stt + cnSummary.stampDuty + cnSummary.etc + cnSummary.sebiFees + cnSummary.clearingCharges + cnIpf + cnTotalGST;
  
  // Actually, standard contract note specifies netSettlement directly:
  const cnNetSettlement = cnSummary.netSettlement;

  // Calculate CSV net settlement representing the actual payout after fees.
  // Net obligation (Sell gross - Buy gross) minus all charges:
  const csvChargesTotal = csvTotalSTT + csvTotalStamp + csvTotalETC + csvTotalSebi + csvTotalGST + csvTotalBrokerage;
  const csvNetSettlement = csvNetAmountObligation - csvChargesTotal;

  comparisonTable.push({
    item: "Final Settlement",
    contractNote: cnNetSettlement,
    csv: csvNetSettlement,
    match: Math.abs(cnNetSettlement - csvNetSettlement) < 0.10, // Allow minor rounding differences of 10 paise
    status: Math.abs(cnNetSettlement - csvNetSettlement) < 0.10 ? 'match' : 'mismatch'
  });

  // Calculate error metrics
  const totalErrors = criticalIssues.length;
  const criticalCount = criticalIssues.filter(i => i.severity === 'Critical').length;
  const majorCount = criticalIssues.filter(i => i.severity === 'Major').length;
  const minorCount = criticalIssues.filter(i => i.severity === 'Minor').length;
  const totalDiscrepancy = criticalIssues.reduce((sum, i) => sum + i.impactValue, 0);

  // 4. Formulate "ROOT CAUSES"
  if (criticalIssues.length === 0) {
    rootCauses.push("All trade transactions, volumes, average prices, and charge rates in the CSV file perfectly match the official Contract Note source of truth. No formula errors detected.");
  } else {
    // Collect unique explanations based on types of errors detected
    const tradeMissing = criticalIssues.some(i => i.title.startsWith("Missing Security"));
    const tradeForeign = criticalIssues.some(i => i.title.startsWith("Unrecognized Trade"));
    const qtyMismatch = criticalIssues.some(i => i.title.startsWith("Quantity Mismatch"));
    const priceMismatch = criticalIssues.some(i => i.title.startsWith("Price Mismatch"));
    const badSTT = criticalIssues.some(i => i.title.includes("STT leviable"));
    const badStamp = criticalIssues.some(i => i.title.includes("Stamp Duty charged on SELL"));
    const badGST = criticalIssues.some(i => i.title.includes("Wrong GST Base"));

    if (tradeMissing) rootCauses.push("Data gaps in CSV: Certain securities shown in the contract note are omitted from the export tool, suggesting a potential extraction filter or download date range slippage.");
    if (tradeForeign) rootCauses.push("Extra rows in CSV: Unrecognized transaction records exist inside the CSV which don't map to the contract note summary. This usually points to importing trades across multiple/subsequent settlements.");
    if (qtyMismatch) rootCauses.push("Split Order/Partial Fill aggregation: The CSV contains distinct filled orders or partial executions that were not fully consolidated into the client's weighted totals as they are on the contract note.");
    if (priceMismatch) rootCauses.push("Brokerage or exchange fee inclusions: Average price calculation in the CSV contains embedded charges/extra commissions, causing a raw price deviation from the official contract note's rate.");
    if (badSTT) rootCauses.push("Formulaic STT Error: STT (Securities Transaction Tax) calculation was erroneously applied to purchase (BUY) transactions within the CSV. STT should only lock into sell transactions for equities delivery.");
    if (badStamp) rootCauses.push("Formulaic Stamp Duty Error: Stamp duty calculations are applied to sales. For physical or dematerialized equities, stamp duty applies strictly to capital acquisitions (BUY trades) at 0.015%.");
    if (badGST) rootCauses.push("Incorrect GST Base (Double Taxation): GST is computed over a base that mistakenly includes non-taxable STT and Stamp Duty levies. Correctly, GST (18%) only applies to Brokerage and Exchange service transaction charges.");
    
    // Add default if no major structural reasons matched
    if (rootCauses.length === 0) {
      rootCauses.push("Rounding discrepancies or local accounting software formula constraints generating minute fraction-of-rupee differences on high volumes.");
    }
  }

  // Determine structural root-causes if columns are missing
  const missingColList = [];
  if (!hasSTTColumn) missingColList.push("STT");
  if (!hasStampColumn) missingColList.push("Stamp Duty");
  if (!hasETCColumn) missingColList.push("Exchange Charges");
  if (!hasSebiColumn) missingColList.push("SEBI Fees");
  if (!hasGSTColumn) missingColList.push("GST");
  if (!hasBrokerageColumn) missingColList.push("Brokerage");

  if (missingColList.length > 0) {
    rootCauses.push(`Structural CSV limitations: The CSV file is missing dedicated columns or populated rows for ${missingColList.join(", ")}, which represents a major barrier to granular transaction auditing.`);
  }

  // 1. Gather CSV rows for correction
  const validCsvTrades: {
    rowIndex: number;
    securityName: string;
    normalizedName: string;
    type: TransactionType;
    quantity: number;
    originalPrice: number;
    originalTurnover: number;
    originalStt: number;
    correctedPrice: number;
    correctedTurnover: number;
    correctedStt: number;
    correctedStamp: number;
    correctedBrokerage: number;
    correctedEtc: number;
    correctedSebi: number;
    correctedGst: number;
  }[] = [];

  for (let i = headerRowIndex + 1; i < csvRowsRaw.length; i++) {
    const row = csvRowsRaw[i];
    if (row.length < 2) continue;
    const keyName = colMap.security !== -1 ? row[colMap.security] : '';
    if (!keyName || keyName.toLowerCase().includes('total') || keyName.toLowerCase().includes('subtotal') || keyName.toLowerCase().includes('grand')) continue;

    const qty = Math.abs(parseNumber(colMap.qty !== -1 ? row[colMap.qty] : '1'));
    if (qty <= 0) continue;

    const price = parseNumber(colMap.price !== -1 ? row[colMap.price] : '0');
    const typeRaw = colMap.type !== -1 ? row[colMap.type].toLowerCase() : '';
    const type: TransactionType = (typeRaw.startsWith('b') || typeRaw.includes('buy')) ? 'Buy' : 'Sell';

    const normalizedName = normalizeName(keyName);
    const cnTrade = cnData.trades.find(t => normalizeName(t.securityName) === normalizedName && t.transactionType === type);

    const correctedPrice = cnTrade ? cnTrade.avgPrice : price;
    const correctedTurnover = qty * correctedPrice;

    validCsvTrades.push({
      rowIndex: i,
      securityName: keyName,
      normalizedName,
      type,
      quantity: qty,
      originalPrice: price,
      originalTurnover: colMap.turnover !== -1 ? parseNumber(row[colMap.turnover]) : (qty * price),
      originalStt: colMap.stt !== -1 ? parseNumber(row[colMap.stt]) : 0,
      correctedPrice,
      correctedTurnover,
      correctedStt: 0,
      correctedStamp: 0,
      correctedBrokerage: 0,
      correctedEtc: 0,
      correctedSebi: 0,
      correctedGst: 0,
    });
  }

  // Group turn around counts
  const totalSellTurnover = validCsvTrades.filter(t => t.type === 'Sell').reduce((sum, t) => sum + t.correctedTurnover, 0);
  const totalBuyTurnover = validCsvTrades.filter(t => t.type === 'Buy').reduce((sum, t) => sum + t.correctedTurnover, 0);
  const totalTurnover = validCsvTrades.reduce((sum, t) => sum + t.correctedTurnover, 0);

  // Distribute levies proportionally across all trades
  if (validCsvTrades.length > 0 && cnSummary.stt > 0) {
    let allocatedSum = 0;
    validCsvTrades.forEach((t, idx) => {
      if (idx === validCsvTrades.length - 1) {
        t.correctedStt = Math.max(0, Math.round((cnSummary.stt - allocatedSum) * 100) / 100);
      } else {
        const share = (t.correctedTurnover / totalTurnover) * cnSummary.stt;
        const roundedShare = Math.max(0, Math.round(share * 100) / 100);
        t.correctedStt = roundedShare;
        allocatedSum += roundedShare;
      }
    });
  }

  const buyTrades = validCsvTrades.filter(t => t.type === 'Buy');
  if (buyTrades.length > 0 && cnSummary.stampDuty > 0) {
    let allocatedSum = 0;
    buyTrades.forEach((t, idx) => {
      if (idx === buyTrades.length - 1) {
        t.correctedStamp = Math.max(0, Math.round((cnSummary.stampDuty - allocatedSum) * 100) / 100);
      } else {
        const share = (t.correctedTurnover / totalBuyTurnover) * cnSummary.stampDuty;
        const roundedShare = Math.max(0, Math.round(share * 100) / 100);
        t.correctedStamp = roundedShare;
        allocatedSum += roundedShare;
      }
    });
  }

  if (validCsvTrades.length > 0) {
    // Brokerage (Taxable Supply Value)
    if (cnSummary.taxableValue > 0) {
      let allocatedSum = 0;
      validCsvTrades.forEach((t, idx) => {
        if (idx === validCsvTrades.length - 1) {
          t.correctedBrokerage = Math.max(0, Math.round((cnSummary.taxableValue - allocatedSum) * 100) / 100);
        } else {
          const share = (t.correctedTurnover / totalTurnover) * cnSummary.taxableValue;
          const roundedShare = Math.max(0, Math.round(share * 100) / 100);
          t.correctedBrokerage = roundedShare;
          allocatedSum += roundedShare;
        }
      });
    }

    // Exchange transaction charges
    if (cnSummary.etc > 0) {
      let allocatedSum = 0;
      validCsvTrades.forEach((t, idx) => {
        if (idx === validCsvTrades.length - 1) {
          t.correctedEtc = Math.max(0, Math.round((cnSummary.etc - allocatedSum) * 100) / 100);
        } else {
          const share = (t.correctedTurnover / totalTurnover) * cnSummary.etc;
          const roundedShare = Math.max(0, Math.round(share * 100) / 100);
          t.correctedEtc = roundedShare;
          allocatedSum += roundedShare;
        }
      });
    }

    // SEBI fees
    if (cnSummary.sebiFees > 0) {
      let allocatedSum = 0;
      validCsvTrades.forEach((t, idx) => {
        if (idx === validCsvTrades.length - 1) {
          t.correctedSebi = Math.max(0, Math.round((cnSummary.sebiFees - allocatedSum) * 100) / 100);
        } else {
          const share = (t.correctedTurnover / totalTurnover) * cnSummary.sebiFees;
          const roundedShare = Math.max(0, Math.round(share * 100) / 100);
          t.correctedSebi = roundedShare;
          allocatedSum += roundedShare;
        }
      });
    }

    // GST
    if (cnTotalGST > 0) {
      let allocatedSum = 0;
      validCsvTrades.forEach((t, idx) => {
        if (idx === validCsvTrades.length - 1) {
          t.correctedGst = Math.max(0, Math.round((cnTotalGST - allocatedSum) * 100) / 100);
        } else {
          const share = (t.correctedTurnover / totalTurnover) * cnTotalGST;
          const roundedShare = Math.max(0, Math.round(share * 100) / 100);
          t.correctedGst = roundedShare;
          allocatedSum += roundedShare;
        }
      });
    }
  }

  // Generate WAP comparison table
  const wapTableMap = new Map<string, { stock: string; roundedWap: number; preciseWap: number }>();
  validCsvTrades.forEach(t => {
    const key = `${t.normalizedName}-${t.type}`;
    const label = `${t.securityName} (${t.type})`;
    if (!wapTableMap.has(key)) {
      wapTableMap.set(key, {
        stock: label,
        roundedWap: t.originalPrice,
        preciseWap: t.correctedPrice
      });
    }
  });
  const wapTable = Array.from(wapTableMap.values());

  // Generate Corrected Amounts table
  const amtTableMap = new Map<string, { stock: string; currentAmt: number; correctedAmt: number }>();
  validCsvTrades.forEach(t => {
    const key = `${t.normalizedName}-${t.type}`;
    const label = `${t.securityName} (${t.type})`;
    if (!amtTableMap.has(key)) {
      amtTableMap.set(key, {
        stock: label,
        currentAmt: 0,
        correctedAmt: 0
      });
    }
    const item = amtTableMap.get(key)!;
    item.currentAmt += t.originalTurnover;
    item.correctedAmt += t.correctedTurnover;
  });
  const correctedAmountsTable = Array.from(amtTableMap.values()).map(x => ({
    ...x,
    currentAmt: Math.round(x.currentAmt * 100) / 100,
    correctedAmt: Math.round(x.correctedAmt * 100) / 100
  }));

  // Generate Corrected STT table
  const correctedSttTable: { stock: string; currentStt: number; correctedStt: number; transactionAmt: number }[] = [];
  validCsvTrades.filter(t => t.correctedStt > 0 || t.originalStt > 0).forEach(t => {
    correctedSttTable.push({
      stock: `${t.securityName} (${t.quantity} qty - ${t.type})`,
      currentStt: t.originalStt,
      correctedStt: t.correctedStt,
      transactionAmt: t.correctedTurnover
    });
  });

  // Rebuild corrected CSV content
  const correctedCsvRows = csvRowsRaw.map(r => [...r]);
  validCsvTrades.forEach(t => {
    const row = correctedCsvRows[t.rowIndex];
    if (colMap.price !== -1) row[colMap.price] = t.correctedPrice.toFixed(4);
    if (colMap.turnover !== -1) row[colMap.turnover] = t.correctedTurnover.toFixed(2);
    if (colMap.stt !== -1) row[colMap.stt] = t.correctedStt.toFixed(2);
    if (colMap.stamp !== -1) row[colMap.stamp] = t.correctedStamp.toFixed(2);
    if (colMap.brokerage !== -1) row[colMap.brokerage] = t.correctedBrokerage.toFixed(2);
    if (colMap.etc !== -1) row[colMap.etc] = t.correctedEtc.toFixed(2);
    if (colMap.sebi !== -1) row[colMap.sebi] = t.correctedSebi.toFixed(2);
    if (colMap.gst !== -1) row[colMap.gst] = t.correctedGst.toFixed(2);
  });

  const correctedCsv = correctedCsvRows.map(row => {
    return row.map(cell => {
      if (cell.includes(',') || cell.includes('"') || cell.includes('\n') || cell.includes('\r')) {
        return `"${cell.replace(/"/g, '""')}"`;
      }
      return cell;
    }).join(',');
  }).join('\n');

  const actualBuyTotal = validCsvTrades.filter(t => t.type === 'Buy').reduce((sum, t) => sum + t.correctedTurnover, 0);
  const actualSellTotal = validCsvTrades.filter(t => t.type === 'Sell').reduce((sum, t) => sum + t.correctedTurnover, 0);
  const actualNet = actualSellTotal - actualBuyTotal;
  const actualStt = validCsvTrades.reduce((sum, t) => sum + t.correctedStt, 0);

  const actualStamp = validCsvTrades.reduce((sum, t) => sum + t.correctedStamp, 0);
  const actualBrokerage = validCsvTrades.reduce((sum, t) => sum + t.correctedBrokerage, 0);
  const actualEtc = validCsvTrades.reduce((sum, t) => sum + t.correctedEtc, 0);
  const actualSebi = validCsvTrades.reduce((sum, t) => sum + t.correctedSebi, 0);
  const actualGst = validCsvTrades.reduce((sum, t) => sum + t.correctedGst, 0);

  const actualNetPayable = actualNet - (actualStt + actualStamp + actualBrokerage + actualEtc + actualSebi + actualGst);

  const finalCheck = {
    buyTotal: { expected: cnBuyTotal, actual: actualBuyTotal, matches: Math.abs(cnBuyTotal - actualBuyTotal) < 0.10 },
    sellTotal: { expected: cnSellTotal, actual: actualSellTotal, matches: Math.abs(cnSellTotal - actualSellTotal) < 0.10 },
    net: { expected: cnNetAmountObligation, actual: actualNet, matches: Math.abs(cnNetAmountObligation - actualNet) < 0.10 },
    stt: { expected: cnSummary.stt, actual: actualStt, matches: Math.abs(cnSummary.stt - actualStt) < 0.10 },
    netPayable: { expected: cnSummary.netSettlement, actual: actualNetPayable, matches: Math.abs(cnSummary.netSettlement - actualNetPayable) < 0.10 },
  };

  // 5. Final Verdict
  const isCorrect = totalErrors === 0 && missingColList.length === 0;
  const safeForTax = criticalCount === 0 && majorCount === 0;
  let generalStatus = "";
  let actionNeeded = "";

  if (isCorrect) {
    generalStatus = "The CSV matches the contract note. Total settlement amounts, transaction volumes, and tax levies align perfectly.";
    actionNeeded = "No action required. The CSV is completely safe to utilize for capital gains calculations, bookkeeping, and annual tax filings.";
  } else if (safeForTax) {
    generalStatus = "Minor discrepancies detected. Mostly rounding tolerances (under ₹1.00) or missing unlevied columns.";
    actionNeeded = "Review the minor price/STT rounding errors. The discrepancies will not materially alter your tax liability, but can be manually adjusted if absolute precision is desired.";
  } else {
    generalStatus = `Unreliable CSV detected. We found ${criticalCount} Critical issues and ${majorCount} Major tax calculation discrepancies.`;
    actionNeeded = "DO NOT USE this CSV for tax reporting or filing yet. Recalculate your STT, Stamp Duty, and price averages according to Zerodha's contract note rules, or use our automatic reconciliation panel below to resolve all errors instantly.";
  }

  return {
    brokerName: "Zerodha",
    clientName: cnData.summary.taxableValue > 0 ? "Client (via Contract Note)" : "Arash Sagun Capital Partner",
    tradeDate: cnData.trades[0]?.tradeDate || "Unknown",
    settlementDate: cnData.trades[0]?.tradeDate ? calculateSettlementDate(cnData.trades[0]?.tradeDate) : "Unknown",
    totalTransactions: csvTrades.length,
    buyCount: csvTrades.filter(t => t.transactionType === 'Buy').length,
    sellCount: csvTrades.filter(t => t.transactionType === 'Sell').length,
    comparisonTable,
    criticalIssues,
    rootCauses,
    totalErrors,
    criticalCount,
    majorCount,
    minorCount,
    totalDiscrepancy,
    verdict: {
      isCorrect,
      safeForTax,
      generalStatus,
      actionNeeded
    },
    reconciliation: {
      wapTable,
      correctedAmountsTable,
      correctedSttTable,
      finalCheck,
      correctedCsv
    }
  };
};

function calculateSettlementDate(tradeDateStr: string): string {
  // Usually T+1 for modern Indian markets.
  // Parse date and add 1 day
  try {
    const parts = tradeDateStr.split(/[-/]/);
    if (parts.length === 3) {
      let d = parseInt(parts[0]);
      let m = parseInt(parts[1]) - 1;
      let y = parseInt(parts[2]);
      if (parts[2].length === 4) {
        // format was DD/MM/YYYY
      } else {
        // format might be YYYY/MM/DD
        y = parseInt(parts[0]);
        m = parseInt(parts[1]) - 1;
        d = parseInt(parts[2]);
      }
      const dt = new Date(y, m, d);
      dt.setDate(dt.getDate() + 1); // T+1
      // Check if weekend, push to Monday
      if (dt.getDay() === 0) dt.setDate(dt.getDate() + 1); // Sunday -> Monday
      else if (dt.getDay() === 6) dt.setDate(dt.getDate() + 2); // Saturday -> Monday
      return `${dt.getDate().toString().padStart(2, '0')}/${(dt.getMonth() + 1).toString().padStart(2, '0')}/${dt.getFullYear()}`;
    }
  } catch (e) {}
  return "Trade Date + 1 Working Day (T+1)";
}
