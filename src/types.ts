export type TransactionType = 'Buy' | 'Sell';
export type TradeType = 'Delivery' | 'Intraday';

export interface Trade {
  id: string;
  tradeDate: string;
  isin?: string;
  securityName: string;
  transactionType: TransactionType;
  quantity: number;
  avgPrice: number;
  turnover: number;
  tradeType: TradeType;
  netTotalBeforeLevies: number;
  // Detailed charges for export
  brokerage: number;
  stt: number;
  etc: number;
  sebiFees: number;
  clearingCharges: number;
  stampDuty: number;
  ipf: number;
  cgst: number;
  sgst: number;
  igst: number;
  gst: number;
  totalExpensesInclSTT: number;
  totalExpensesExclSTT: number;
}

export interface Summary {
  payinObligation: number;
  stt: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  gst: number;
  etc: number;
  sebiFees: number;
  clearingCharges: number;
  stampDuty: number;
  ipf: number;
  netSettlement: number;
}

export interface ReconciliationStatus {
  isValid: boolean;
  totalBuys: number;
  totalSells: number;
  calculatedObligation: number; // Sells - Buys
  extractedObligation: number;  // summary.payinObligation
  totalCharges: number;
  calculatedNet: number;        // Sells - Buys - Charges
  extractedNet: number;         // summary.netSettlement
  difference: number;
  statusText: 'PASSED' | 'Parser uncertain' | 'Suspicious STT';
  isSuspiciousStt?: boolean;
  isSttMismatch?: boolean;
}

export interface ContractNoteResult {
  summary: Summary;
  trades: Trade[];
  brokerName?: string;
  tradeDate?: string;
  reconciliation?: ReconciliationStatus;
  rawText?: string;
}
