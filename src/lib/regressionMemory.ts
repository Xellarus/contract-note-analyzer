import { ContractNoteResult, Summary } from '../types';
import { parsePdfContractNote } from './parsers';

export interface RegressionTestCase {
  id: string;
  name: string;
  description: string;
  broker: 'zerodha' | 'integrated' | 'standard';
  rawText: string;
  expected: {
    tradesCount: number;
    payinObligation: number;
    stt: number;
    brokerage: number; // taxable value
    gst: number;       // cgst + sgst
    netSettlement: number;
    isValid: boolean;
  };
}

export interface TestResult {
  caseId: string;
  name: string;
  passed: boolean;
  actual?: {
    tradesCount: number;
    payinObligation: number;
    stt: number;
    brokerage: number;
    gst: number;
    netSettlement: number;
    isValid: boolean;
    difference: number;
  };
  error?: string;
}

export const seedRegressionCases: RegressionTestCase[] = [
  {
    id: "case-1",
    name: "CN1: Standard Zerodha HTML/PDF Note",
    description: "Verifies standard Zerodha single-screen buy and sell trade matching and exact charge reconciliation.",
    broker: "zerodha",
    rawText: `
ZERODHA BROKING LTD.
Trade Date: 2026-05-20
------------------------------------------------------------------------------------------------------------------------
CONTRACT NOTE NO: 123456
------------------------------------------------------------------------------------------------------------------------
Annexure A
TRADE NO  ORDER NO  SECURITY/CONTRACT  BUY/SELL  QUANTITY  PRICE  NET RATE  BROKERAGE
987654    554433    INFY               B         100       1450.00 1450.00   0.00
987655    554434    RELIANCE           S         50        2400.00 2400.00   0.00

------------------------------------------------------------------------------------------------------------------------
PAY IN/PAY OUT OBLIGATION          25000.00
SECURITIES TRANSACTION TAX (STT)    120.00
TAXABLE VALUE OF SERVICES            50.00
CGST 9%                              4.50
SGST 9%                              4.50
EXCHANGE TRANSACTION CHARGES         3.50
SEBI TURNOVER FEES                   0.15
CLEARING CHARGES                     0.00
STAMP DUTY                          10.00
IPF                                  0.05
NET AMOUNT PAYABLE                 (25192.70)
------------------------------------------------------------------------------------------------------------------------
    `.trim(),
    expected: {
      tradesCount: 2,
      payinObligation: 25000.00,
      stt: 120.00,
      brokerage: 50.00,
      gst: 9.00,
      netSettlement: -25192.70,
      isValid: true,
    }
  },
  {
    id: "case-2",
    name: "CN2: Zerodha Note - Multi-Asset High STT",
    description: "Verifies a large portfolio note with higher STT levy and multiple asset transactions with GST and stamps.",
    broker: "zerodha",
    rawText: `
ZERODHA BROKING LTD.
Trade Date: 2026-05-21
------------------------------------------------------------------------------------------------------------------------
CONTRACT NOTE NO: 998811
------------------------------------------------------------------------------------------------------------------------
Annexure A
TRADE NO  ORDER NO  SECURITY/CONTRACT  BUY/SELL  QUANTITY  PRICE  NET RATE  BROKERAGE
811100    990011    TCS                S         200       3200.00 3200.00   0.00
811101    990012    HDFC BANK          B         500       1500.00 1500.00   0.00

------------------------------------------------------------------------------------------------------------------------
PAY IN/PAY OUT OBLIGATION         110000.00
SECURITIES TRANSACTION TAX (STT)    640.00
TAXABLE VALUE OF SERVICES           150.00
CGST 9%                             13.50
SGST 9%                             13.50
EXCHANGE TRANSACTION CHARGES        20.00
SEBI TURNOVER FEES                   0.75
CLEARING CHARGES                     0.00
STAMP DUTY                          75.00
IPF                                  0.25
NET AMOUNT PAYABLE                 109087.00
------------------------------------------------------------------------------------------------------------------------
    `.trim(),
    expected: {
      tradesCount: 2,
      payinObligation: 110000.00,
      stt: 640.00,
      brokerage: 150.00,
      gst: 27.00,
      netSettlement: 109087.00,
      isValid: true,
    }
  },
  {
    id: "case-3",
    name: "BrokenCN: Footer STT Disclaimer Intruder",
    description: "A note that historically broke parses because of the word 'STT' inside the footnote. Our confidence scoring ignores this.",
    broker: "zerodha",
    rawText: `
ZERODHA BROKING LTD.
Trade Date: 2026-05-22
------------------------------------------------------------------------------------------------------------------------
CONTRACT NOTE NO: 778822
------------------------------------------------------------------------------------------------------------------------
Annexure A
TRADE NO  ORDER NO  SECURITY/CONTRACT  BUY/SELL  QUANTITY  PRICE  NET RATE  BROKERAGE
701010    334411    SBIN               S         1000      600.00  600.00   0.00
701011    334412    ITC                B         1000      400.00  400.00   0.00

------------------------------------------------------------------------------------------------------------------------
PAY IN/PAY OUT OBLIGATION         200000.00
SECURITIES TRANSACTION TAX (STT)    600.00
TAXABLE VALUE OF SERVICES           200.00
CGST 9%                             18.00
SGST 9%                             18.00
EXCHANGE TRANSACTION CHARGES        40.00
SEBI TURNOVER FEES                   1.00
CLEARING CHARGES                     0.00
STAMP DUTY                          60.00
IPF                                  0.50
NET AMOUNT PAYABLE                 199062.50
------------------------------------------------------------------------------------------------------------------------
Footnotes and disclaimers:
1. Please note that Securities Transaction Tax (STT) is levied at 0.1% on delivery sell trades under Chapter VII of Finance (No. 2) Act, 2004.
2. Under section 119 of the Act, stamp duty is payable on purchase contract note values.
3. Registered Office: Bangalore, India. SEBI registration: INZ000031633.
    `.trim(),
    expected: {
      tradesCount: 2,
      payinObligation: 200000.00,
      stt: 600.00,
      brokerage: 200.00,
      gst: 36.00,
      netSettlement: 199062.50,
      isValid: true,
    }
  },
  {
    id: "case-4",
    name: "BrokenCN: User Discrepancy (Parser Uncertain Fallback)",
    description: "Test note that purposefully mismatching arithmetic sums to verify 'Parser uncertain' triggers correctly.",
    broker: "zerodha",
    rawText: `
ZERODHA BROKING LTD.
Trade Date: 2026-05-23
------------------------------------------------------------------------------------------------------------------------
Annexure A
TRADE NO  SECURITY/CONTRACT  BUY/SELL  QUANTITY  PRICE  NET RATE
501010    TATAMOTORS         B         100       500.00  500.00

------------------------------------------------------------------------------------------------------------------------
PAY IN/PAY OUT OBLIGATION          50000.00
SECURITIES TRANSACTION TAX (STT)    0.00
TAXABLE VALUE OF SERVICES           25.00
CGST 9%                              2.25
SGST 9%                              2.25
EXCHANGE TRANSACTION CHARGES        10.00
SEBI TURNOVER FEES                   0.10
CLEARING CHARGES                     0.00
STAMP DUTY                          7.50
IPF                                  0.02
NET AMOUNT PAYABLE                 (45000.00)
------------------------------------------------------------------------------------------------------------------------
    `.trim(),
    expected: {
      tradesCount: 1,
      payinObligation: 50000.00,
      stt: 0.00,
      brokerage: 25.00,
      gst: 4.50,
      netSettlement: -45000.00, // Here obligation is -50k, charges are 47.12. Expected Net should be -50047.12. Extracted is -45000, which mismatches significantly!
      isValid: false, // Must trigger "Parser uncertain"
    }
  }
];

export const runRegressionTests = async (customCases: RegressionTestCase[] = []): Promise<TestResult[]> => {
  const allCases = [...seedRegressionCases, ...customCases];
  const results: TestResult[] = [];

  for (const tc of allCases) {
    try {
      const parsed = await parsePdfContractNote(tc.rawText);
      if (!parsed) {
        results.push({
          caseId: tc.id,
          name: tc.name,
          passed: false,
          error: "Parser returned null; file not parsed."
        });
        continue;
      }

      const summary = parsed.summary;
      const tradesCount = parsed.trades.length;
      const gst = summary.cgst + summary.sgst;

      const recon = parsed.reconciliation;
      const isValid = recon ? recon.isValid : false;
      const difference = recon ? recon.difference : 10000;

      // Check if actual values align within tolerance for successful pass
      const tradesCountMatch = tradesCount === tc.expected.tradesCount;
      const payinObligationMatch = Math.abs(summary.payinObligation - tc.expected.payinObligation) < 1.0;
      const sttMatch = Math.abs(summary.stt - tc.expected.stt) < 1.0;
      const brokerageMatch = Math.abs(summary.taxableValue - tc.expected.brokerage) < 1.0;
      const gstMatch = Math.abs(gst - tc.expected.gst) < 1.0;
      const netSettlementMatch = Math.abs(summary.netSettlement - tc.expected.netSettlement) < 1.0;
      const isValidMatch = isValid === tc.expected.isValid;

      const passed = tradesCountMatch && 
                     payinObligationMatch && 
                     sttMatch && 
                     brokerageMatch && 
                     gstMatch && 
                     netSettlementMatch && 
                     isValidMatch;

      results.push({
        caseId: tc.id,
        name: tc.name,
        passed,
        actual: {
          tradesCount,
          payinObligation: summary.payinObligation,
          stt: summary.stt,
          brokerage: summary.taxableValue,
          gst,
          netSettlement: summary.netSettlement,
          isValid,
          difference
        }
      });
    } catch (e: any) {
      results.push({
        caseId: tc.id,
        name: tc.name,
        passed: false,
        error: e.message || "Execution failed with error"
      });
    }
  }

  return results;
};
