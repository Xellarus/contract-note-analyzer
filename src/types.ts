export type TransactionType = 'Buy' | 'Sell';
export type TradeType = 'Delivery' | 'Intraday';

export interface Trade {
  id: string;
  tradeDate: string;
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
  etc: number;
  sebiFees: number;
  clearingCharges: number;
  stampDuty: number;
  ipf: number;
  netSettlement: number;
}

export interface ContractNoteResult {
  summary: Summary;
  trades: Trade[];
}
