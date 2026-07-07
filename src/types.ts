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
  dmat?: number;            // Demat/DP charge (Integrated obligation detail); optional — other brokers omit it
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
  dmat?: number;            // Demat/DP charge (Integrated obligation detail); optional — other brokers omit it
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
  ucc?: string;
  reconciliation?: ReconciliationStatus;
  rawText?: string;
}

export interface PortfolioHolding {
  id: string;
  symbol: string;
  name: string;
  isin: string;
  quantity: number;
  avgCost: number;
  currentPrice: number;
  sector: string;
}

export interface PortfolioUser {
  email: string;
  name: string;
  picture?: string;
  given_name?: string;
  family_name?: string;
}

