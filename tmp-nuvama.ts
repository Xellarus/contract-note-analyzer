// Feeds the three real Nuvama notes (pdf-extracted text, verbatim) through the
// parser and checks every derived figure against the printed note.
import { NuvamaBrokerStrategy } from './src/lib/brokers/nuvama';

let pass = 0, fail = 0;
const eq = (label: string, got: any, want: any, tol = 0) => {
  const ok = typeof want === 'number' && typeof got === 'number'
    ? Math.abs(got - want) <= tol
    : got === want;
  if (ok) { pass++; }
  else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// ── V1 ── 2021 Edelweiss, 13 sell rows in SURYAROSNI ─────────────────────────
const V1 = `CASH
EDELWEISS BROKING LTD.
MEMBER : NSE/BSE/MSEI
SEBI REGN. NO. INZ000005231
REGD.OFFICE: 2nd Floor, Office No. 201 to 203, Zodiac Plaza,
Xavier College Road, Off C G Road, Ahmedabad, Gujarat - 380009
Customer Care Toll Free : 18001023335
To,
UMA AGARAWAL
L 506 AGARSEN APTT
NEW DELHI-DELHI 201001
GSTIN NO:
Trading/ Back Office Code : 60072941
PAN GIR No. : ACFPA8713P
CONTRACT NOTE NO. : 696014
TRADE DATE : 26/05/2021
UCC/MAPIN ID :
SETTLEMENT NO. : 2122038
SETTLEMENT DATE : 28-05-2021
SETTLEMENT TYPE : Rolling
CMBPID - IN655816
CONTRACT NOTE CUM TAX INVOICE
Sir/ Madam, I/ We have this day done by your order and on your account the following transactions
Consolidated Stamp
Duty will be paid
To be Stamped as per the provisions
applicable under the Relevant Stamp Act.
Order No. Order
Time
Trade
No.
Trade
Time Contract Description Buy(B) Sell(S) Quantity
Gross
Rate/
Price Per
Unit(Rs.)
Brokerage
Rate Per
Unit(Rs.)
Brokerage
(Total)
(Rs.)
Net Rate Per
Unit(Rs.) STT(Rs.)
Net Total
(Before Levies)
(Rs.)
Remarks/$
1300000008354321 11:08:57 77486568 11:08:57 INE335A01012 - SURYAROSNI Sell 100 484.0000 0.4840 48.40 483.5160 -48351.60 NSE
1300000008354321 11:08:57 77486569 11:08:57 INE335A01012 - SURYAROSNI Sell 15 484.0000 0.4840 7.26 483.5160 -7252.74 NSE
1300000008354321 11:08:57 77486570 11:08:57 INE335A01012 - SURYAROSNI Sell 50 484.0000 0.4840 24.20 483.5160 -24175.80 NSE
1300000008354321 11:08:57 77486571 11:08:57 INE335A01012 - SURYAROSNI Sell 8 484.0000 0.4838 3.87 483.5163 -3868.13 NSE
1300000008354321 11:08:57 77486960 11:08:59 INE335A01012 - SURYAROSNI Sell 7 484.0000 0.4843 3.39 483.5157 -3384.61 NSE
1300000008354321 11:08:57 77503534 11:10:15 INE335A01012 - SURYAROSNI Sell 25 484.0000 0.4840 12.10 483.5160 -12087.90 NSE
1300000008354321 11:08:57 77503572 11:10:15 INE335A01012 - SURYAROSNI Sell 98 484.0000 0.4840 47.43 483.5160 -47384.57 NSE
1300000008354321 11:08:57 77508363 11:10:37 INE335A01012 - SURYAROSNI Sell 600 484.0000 0.4840 290.40 483.5160 -290109.60 NSE
1300000008354321 11:08:57 77508364 11:10:37 INE335A01012 - SURYAROSNI Sell 28 484.0000 0.4839 13.55 483.5161 -13538.45 NSE
1300000008354321 11:08:57 77512350 11:10:56 INE335A01012 - SURYAROSNI Sell 473 484.0000 0.4840 228.93 483.5160 -228703.07 NSE
1300000008354321 11:08:57 77512352 11:10:56 INE335A01012 - SURYAROSNI Sell 333 484.0000 0.4840 161.17 483.5160 -161010.83 NSE
1300000008354321 11:08:57 77486566 11:08:57 INE335A01012 - SURYAROSNI Sell 200 484.0500 0.4841 96.81 483.5660 -96713.19 NSE
1300000008354321 11:08:57 77486567 11:08:57 INE335A01012 - SURYAROSNI Sell 63 484.0000 0.4840 30.49 483.5160 -30461.51 NSE
*Net Delivery* -2000 968.00 -967042.00
CAPITAL MARKET 968.00 TOTAL (NET)
Payin/Payout Obligation -967042.00
Security Transaction Tax 968.00 968.00
ExchangeTransaction Charges 26.62 26.62
SEBI Turnover Fees 0.97 0.97
CGST @ 9 % 89.60 89.60
SGST @ 9 % 89.60 89.60
Net amount receivable by Client -965867.21 -965867.21
* CGST:-Central GST; SGST: - State GST; IGST:-Integrated GST; UTT: - Union Territory Tax. Details of trade-wise levies shall be provided on request..
Description of Service: Stock Broker Accounting code of Service: 997152
Name of the Authorised Signatory : Pranav Tanna, Manoj Gandhi,Nilesh Adhyaru,Ruchir Trivedi, Yogesh Suryavanshi
GST No.:07AABCE9421H1ZQ`;

// ── V2 ── 2023 Nuvama, one buy in SWASTIK PIPE LI ────────────────────────────
const V2 = `CASH
Nuvama Wealth and Investment Limited.
(Formerly - Edelweiss Broking Limited)
MEMBER : NSE/BSE/MSEI/MCX/NCDEX
Clearing Name : ICCL
SEBI REGN. NO. INZ000005231
Customer Care Toll Free : 18001023335
To,
UMA AGARAWAL
NEW DELHI-DELHI 201001
GSTIN NO:
Trading/ Back Office Code : 60072941
PAN GIR No. : ACFPA8713P
CONTRACT NOTE NO. : 3717953
TRADE DATE : 31/03/2023
SETTLEMENT NO. : 2324501
SETTLEMENT DATE : 03/04/2023
SETTLEMENT TYPE : Rolling+1
CMBPID - IN655816
CONTRACT NOTE CUM TAX INVOICE
Sir/ Madam, I/ We have this day done by your order and on your account the following transactions
Consolidated Stamp
Duty will be paid
Order No. Order
Time
Trade
No.
Trade
Time Contract Description Buy(B) Sell(S) Quantity
Gross
Rate/
Price Per
Unit(Rs.)
Brokerage
Rate Per
Unit(Rs.)
Brokerage
(Total)
(Rs.)
Net Rate Per
Unit(Rs.) STT(Rs.)
Net Total
(Before Levies)
(Rs.)
Remarks/$
1300000012143301 11:51:02 77692686 12:21:02 INE0DGC01025 - SWASTIK PIPE LI Buy 1200 79.0000 0.1000 120.00 79.1000 94920.00 NSE
*Net Delivery* 1200 95.00 94920.00
CAPITAL MARKET 120.00 TOTAL (NET)
Payin/Payout Obligation 94920.00
Security Transaction Tax 95.00 95.00
Stamp Duty 14.00 14.00
ExchangeTransaction Charges 2.61 2.61
SEBI Turnover Fees 0.09 0.09
CGST @ 9 % 11.04 11.04
SGST @ 9 % 11.04 11.04
Net amount payable by Client 95053.78 95053.78
* CGST:-Central GST; SGST: - State GST; IGST:-Integrated GST. Details of trade-wise levies shall be provided on request..
GST No.:07AABCE9421H1ZQ`;

// ── V3 ── 2026 new template, one LIQUIDCASE sell (ETF, STT-exempt) ───────────
const V3 = `TRADES CHARGES Annexure
NUVAMA WEALTH AND INVESTMENT LIMITED
Regd Office : 801- 804, Wing A, Building No. 3, Inspire BKC, G Block, Bandra Kurla Complex, Bandra(East), Mumbai, Mumbai- 400051, Maharashtra, India.
Member : NSE/BSE/MSEI/MCX/NCDEX | Clearing Corporation Name : ICCL | SEBI REGN. NO. INZ000005231 | Customer Care Toll Free : 18001023335.
ORIGINAL TO RECIPIENT CONTRACT NOTE CUM BILL
To,
UMA AGARAWAL
L 506 AGARSEN APTT
NEW DELHI-DELHI 201001
GSTIN No.:
Contract Details
Contract Note No 1100069
Trade Date 29/Jul/2026
UCC/Backoffice Code 60072941
PAN ACFPA8713P
SETTLEMENT NO. 2627682
SETTLEMENT DATE 30/Jul/2026
SETTLEMENT TYPE Rolling+1
Equity Segment
Security
Description Buy Details Sell Details
Net Obligation for
ISIN (Before Levies)
(Rs) *
ISIN
Scrip
Name
/
Symbol
Qty
WAP
Mkt
Rate
WAP
Brok
Rate
WAP
Trade
Rate
Trade
Amt Qty
WAP
Mkt
Rate
WAP
Brok
Rate
WAP
Trade
Rate
Trade
Amt Net Qty
Net
Trade
Amt
EQUITY - 60072941 | Normal+1 | Contract No - 1100069
INF0R8F01034 LIQUIDCASE - - - - - 7,000 115.2100 - 115.2100 8,06,470.00 -7,000 -8,06,470-
.00
Obligation Details
Description
Pay In/Pay Out Obligation (M)
Brokerage
Taxable Value of Supply
CGST @ 9 %
SGST @ 9 %
ExchangeTransaction Charges
SEBI Turnover Fees
Net Amount Payable to Client
EQ BSE
-8,06,470.00
0.00
25.57
2.30
2.30
24.76
0.81
-8,06,439.83
Note:- (-) Credit Amount / (+) Debit Amount`;

// The V3 obligation block extracts as a column of LABELS then a column of VALUES,
// which is how pdf.js emits that two-column table. Also test the interleaved form
// in case a different pdf.js pass pairs them up.
const V3_PAIRED = V3
  .replace(/Description\nPay In\/Pay Out Obligation \(M\)\nBrokerage\nTaxable Value of Supply\nCGST @ 9 %\nSGST @ 9 %\nExchangeTransaction Charges\nSEBI Turnover Fees\nNet Amount Payable to Client\nEQ BSE\n-8,06,470\.00\n0\.00\n25\.57\n2\.30\n2\.30\n24\.76\n0\.81\n-8,06,439\.83/,
    `Description                          EQ BSE
Pay In/Pay Out Obligation (M)        -8,06,470.00
Brokerage                            0.00
Taxable Value of Supply              25.57
CGST @ 9 %                           2.30
SGST @ 9 %                           2.30
ExchangeTransaction Charges          24.76
SEBI Turnover Fees                   0.81
Net Amount Payable to Client         -8,06,439.83`);

// ── V3B ── 2026, CN 893207: TWO scrips, real brokerage, STT present, IPFT charges,
//          wrapped Trade Amt cells, and ~200 Annexure rows that must NOT be parsed
//          as trades. This is the note that resolved the open V3 questions.
const V3B = `TRADES CHARGES Annexure
NUVAMA WEALTH AND INVESTMENT LIMITED
Member : NSE/BSE/MSEI/MCX/NCDEX | Clearing Corporation Name : ICCL | SEBI REGN. NO. INZ000005231 | Customer Care Toll Free : 18001023335.
ORIGINAL TO RECIPIENT CONTRACT NOTE CUM BILL
To,
UMA AGARAWAL
NEW DELHI-DELHI 201001
Contract Details
Contract Note No 893207
Trade Date 07/Jul/2026
UCC/Backoffice Code 60072941
PAN ACFPA8713P
SETTLEMENT NO. 2627666
SETTLEMENT DATE 08/Jul/2026
SETTLEMENT TYPE Rolling+1
Equity Segment
Security
Description Buy Details Sell Details
Net Obligation for
ISIN (Before Levies)
(Rs) *
ISIN
Scrip
Name
/
Symbol
Qty
WAP
Mkt
Rate
WAP
Brok
Rate
WAP
Trade
Rate
Trade
Amt Qty
WAP
Mkt
Rate
WAP
Brok
Rate
WAP
Trade
Rate
Trade
Amt Net Qty
Net
Trade
Amt
EQUITY - 60072941 | Normal+1 | Contract No - 893207
INE129A01019 GAIL - - - - - 47,088 174.1348 0.1741 173.9607 81,91,46-
1.44 -47,088 -81,91,46-1.44
INE121J01017 INDUSTOWER - - - - - 4,561 381.6451 0.3816 381.2635 17,38,94-
2.82 -4,561 -17,38,94-2.82
Obligation Details
Description
Pay In/Pay Out Obligation (M)
Brokerage
Taxable Value of Supply
CGST @ 9 %
SGST @ 9 %
Security Transaction Tax
ExchangeTransaction Charges
SEBI Turnover Fees
IPFT Charges
Net Amount Payable to Client
EQ BSE
-99,40,342.76
9,938.50
10,253.61
922.83
922.83
9,940.00
305.16
9.94
0.01
-99,18,303.49
Note:- (-) Credit Amount / (+) Debit Amount
Annexure
Detail Trade Annexure For Acoount Code:60072941-UMA AGARAWAL | Trxdate :07-Jul-2026 | Segment : EQ
Security Name Order No Order
Time Trade No TradeTime Buy/Sell Trade Qty Mkt Rate Mkt Amt Exch
EQUITY-2627666 | Normal (T+1) | Contract No -893207
GAIL 1100000082065742 14:53:31 209223297 14:53:48 Sell 64 174.3400 11,157.76 NSE
GAIL 1100000082065742 14:53:31 209224132 14:53:50 Sell 2 174.3400 348.68 NSE
GAIL 1100000082065742 14:54:23 209243526 14:54:23 Sell 355 174.1700 61,830.35 NSE
GAIL 1100000082065742 14:54:23 209243613 14:54:23 Sell 3,212 174.0600 5,59,080.72 NSE
INDUSTOWER 1100000082135790 14:54:35 209248967 14:54:35 Sell 4 381.6500 1,526.60 NSE
INDUSTOWER 1100000082135790 14:54:35 209248958 14:54:35 Sell 1,283 381.7000 4,89,721.10 NSE
INDUSTOWER 1100000082135790 14:54:35 209248963 14:54:35 Sell 1,343 381.6500 5,12,555.95 NSE
*CGST :- Central GST | SGST :- State GST | IGST :- Integrated GST | UTT :- Union Territory Tax.
*STT and stamp duty being statutory in nature are collected as a pure agent of the Client and not liable to GST
Description of Service : Stock Broker * Accounting code of Service : 997152
Place : Mumbai
Date : 07/Jul/2026
PAN : AABCE9421H | GST No : 27AABCE9421H1ZO
CIN : U65100MH2008PLC425999`;

// ── V3C ── 2026, CN 113911: a BUY. Stamp duty present, no IPFT, and the Trade Amt
//          wraps INSIDE the buy block — the case that shifts every later cell.
const V3C = `TRADES CHARGES Annexure
NUVAMA WEALTH AND INVESTMENT LIMITED
Member : NSE/BSE/MSEI/MCX/NCDEX | Clearing Corporation Name : ICCL | SEBI REGN. NO. INZ000005231 | Customer Care Toll Free : 18001023335.
ORIGINAL TO RECIPIENT CONTRACT NOTE CUM BILL
To,
UMA AGARAWAL
NEW DELHI-DELHI 201001
Contract Details
Contract Note No 113911
Trade Date 16/Apr/2026
UCC/Backoffice Code 60072941
PAN ACFPA8713P
SETTLEMENT NO. 2627611
SETTLEMENT DATE 17/Apr/2026
SETTLEMENT TYPE Rolling+1
Equity Segment
Security
Description Buy Details Sell Details
Net Obligation for
ISIN (Before Levies)
(Rs) *
ISIN
Scrip
Name
/
Symbol
Qty
WAP
Mkt
Rate
WAP
Brok
Rate
WAP
Trade
Rate
Trade
Amt Qty
WAP
Mkt
Rate
WAP
Brok
Rate
WAP
Trade
Rate
Trade
Amt Net Qty
Net
Trade
Amt
EQUITY - 60072941 | Normal+1 | Contract No - 113911
INE024001021 AEROFLEX 10,000 292.6125 0.2926 292.9051 29,29,05-
1.00 - - - - - 10,000 29,29,05-1.00
Obligation Details
Description
Pay In/Pay Out Obligation (M)
Brokerage
Taxable Value of Supply
CGST @ 9 %
SGST @ 9 %
Security Transaction Tax
Stamp Duty
ExchangeTransaction Charges
SEBI Turnover Fees
Net Amount Payable by Client
EQ BSE
29,26,125.00
2,926.00
3,018.76
271.69
271.69
2,926.00
439.00
89.83
2.93
29,33,052.14
Note:- (-) Credit Amount / (+) Debit Amount
Annexure
Detail Trade Annexure For Acoount Code:60072941-UMA AGARAWAL | Trxdate :16-Apr-2026 | Segment : EQ
Security Name Order No Order
Time Trade No TradeTime Buy/Sell Trade Qty Mkt Rate Mkt Amt Exch
EQUITY-2627611 | Normal (T+1) | Contract No -113911
AEROFLEX 1000000026701349 10:59:29 2871959 10:59:29 Buy 659 291.9800 1,92,414.82 NSE
AEROFLEX 1000000026701349 10:59:52 2878752 10:59:52 Buy 50 292.4600 14,623.00 NSE
AEROFLEX 1000000026701349 10:59:52 2878754 10:59:52 Buy 1,000 292.5000 2,92,500.00 NSE
AEROFLEX 1000000026701349 10:59:52 2878749 10:59:52 Buy 1,246 292.3500 3,64,268.10 NSE
*CGST :- Central GST | SGST :- State GST | IGST :- Integrated GST | UTT :- Union Territory Tax.
*STT and stamp duty being statutory in nature are collected as a pure agent of the Client and not liable to GST
Description of Service : Stock Broker * Accounting code of Service : 997152
Details of trade-wise levies shall be provided on request.
Place : Mumbai
Date : 16/Apr/2026
PAN : AABCE9421H | GST No : 27AABCE9421H1ZO
CIN : U65100MH2008PLC425999`;

const v1 = new NuvamaBrokerStrategy('v1');
const v2 = new NuvamaBrokerStrategy('v2');
const v3 = new NuvamaBrokerStrategy('v3');

async function main() {
  // ── detect() must pick exactly one variant per note ────────────────────────
  console.log('\n=== detect() ===');
  eq('v1 detects V1', v1.detect(V1, true), true);
  eq('v1 rejects V2', v1.detect(V2, true), false);
  eq('v1 rejects V3', v1.detect(V3, true), false);
  eq('v2 detects V2', v2.detect(V2, true), true);
  eq('v2 rejects V1', v2.detect(V1, true), false);
  eq('v2 rejects V3', v2.detect(V3, true), false);
  eq('v3 detects V3', v3.detect(V3, true), true);
  eq('v3 rejects V1', v3.detect(V1, true), false);
  eq('v3 rejects V2', v3.detect(V2, true), false);

  // ── V1 ─────────────────────────────────────────────────────────────────────
  console.log('\n=== V1 (2021 Edelweiss, 13 sells) ===');
  const r1 = await v1.parsePdfText(V1);
  if (!r1) { fail++; console.log('  FAIL V1 returned null'); }
  else {
    eq('V1 trade count (13 rows aggregate to 1)', r1.trades.length, 1);
    const t = r1.trades[0];
    eq('V1 side', t.transactionType, 'Sell');
    eq('V1 isin', t.isin, 'INE335A01012');
    eq('V1 name', t.securityName, 'SURYAROSNI');
    eq('V1 qty', t.quantity, 2000);
    eq('V1 turnover', t.turnover, 968010, 0.005);
    eq('V1 avgPrice full precision', t.avgPrice, 484.005, 1e-9);
    eq('V1 brokerage (amount col, not rate col)', t.brokerage, 968, 0.005);
    eq('V1 stt', t.stt, 968, 0.005);
    eq('V1 etc', t.etc, 26.62, 0.005);
    eq('V1 sebi', t.sebiFees, 0.97, 0.005);
    eq('V1 stampDuty (sell = none)', t.stampDuty, 0, 0.005);
    eq('V1 gst = cgst+sgst', t.gst, 179.2, 0.005);
    eq('V1 tradeType', t.tradeType, 'Delivery');
    eq('V1 netTotalBeforeLevies signed +ve for sell', t.netTotalBeforeLevies, 968010, 0.005);
    eq('V1 summary.netSettlement negated to app sign', r1.summary.netSettlement, 965867.21, 0.005);
    eq('V1 summary.taxableValue = brokerage', r1.summary.taxableValue, 968, 0.005);
    eq('V1 tradeDate', r1.tradeDate, '26/05/2021');
    eq('V1 ucc', r1.ucc, '60072941');
    eq('V1 brokerName', r1.brokerName, 'nuvama');
    eq('V1 recon difference', r1.reconciliation!.difference, 0, 0.10);
    eq('V1 recon PASSED', r1.reconciliation!.statusText, 'PASSED');
    eq('V1 recon isValid', r1.reconciliation!.isValid, true);
  }

  // ── V2 ─────────────────────────────────────────────────────────────────────
  console.log('\n=== V2 (2023 Nuvama, one buy) ===');
  const r2 = await v2.parsePdfText(V2);
  if (!r2) { fail++; console.log('  FAIL V2 returned null'); }
  else {
    eq('V2 trade count', r2.trades.length, 1);
    const t = r2.trades[0];
    eq('V2 side', t.transactionType, 'Buy');
    eq('V2 isin', t.isin, 'INE0DGC01025');
    eq('V2 truncated name kept verbatim', t.securityName, 'SWASTIK PIPE LI');
    eq('V2 qty', t.quantity, 1200);
    eq('V2 turnover (gross, not net-of-brokerage)', t.turnover, 94800, 0.005);
    eq('V2 avgPrice', t.avgPrice, 79, 1e-9);
    eq('V2 brokerage', t.brokerage, 120, 0.005);
    eq('V2 stt', t.stt, 95, 0.005);
    eq('V2 stampDuty (buy = charged)', t.stampDuty, 14, 0.005);
    eq('V2 etc', t.etc, 2.61, 0.005);
    eq('V2 sebi', t.sebiFees, 0.09, 0.005);
    eq('V2 gst', t.gst, 22.08, 0.005);
    eq('V2 netTotalBeforeLevies signed -ve for buy', t.netTotalBeforeLevies, -94800, 0.005);
    eq('V2 summary.netSettlement negated', r2.summary.netSettlement, -95053.78, 0.005);
    eq('V2 tradeDate', r2.tradeDate, '31/03/2023');
    eq('V2 ucc', r2.ucc, '60072941');
    eq('V2 recon difference', r2.reconciliation!.difference, 0, 0.10);
    eq('V2 recon PASSED', r2.reconciliation!.statusText, 'PASSED');
    eq('V2 recon isValid', r2.reconciliation!.isValid, true);
  }

  // ── V3 ─────────────────────────────────────────────────────────────────────
  for (const [tag, txt] of [['V3 (column-split labels)', V3], ['V3 (paired rows)', V3_PAIRED]] as const) {
    console.log(`\n=== ${tag} ===`);
    const r3 = await v3.parsePdfText(txt);
    if (!r3) { fail++; console.log(`  FAIL ${tag} returned null`); continue; }
    eq(`${tag} trade count (buy cells all "-")`, r3.trades.length, 1);
    const t = r3.trades[0];
    eq(`${tag} side`, t.transactionType, 'Sell');
    eq(`${tag} isin`, t.isin, 'INF0R8F01034');
    eq(`${tag} name`, t.securityName, 'LIQUIDCASE');
    eq(`${tag} qty (comma-grouped 7,000)`, t.quantity, 7000);
    eq(`${tag} turnover = qty x WAP Mkt Rate`, t.turnover, 806470, 0.005);
    eq(`${tag} avgPrice`, t.avgPrice, 115.21, 1e-9);
    eq(`${tag} brokerage from Brokerage line, NOT Taxable Value 25.57`, t.brokerage, 0, 0.005);
    eq(`${tag} stt 0 (INF-series ISIN = exempt)`, t.stt, 0, 0.005);
    eq(`${tag} etc`, t.etc, 24.76, 0.005);
    eq(`${tag} sebi`, t.sebiFees, 0.81, 0.005);
    eq(`${tag} gst`, t.gst, 4.6, 0.005);
    eq(`${tag} summary.taxableValue not polluted by 25.57`, r3.summary.taxableValue, 0, 0.005);
    eq(`${tag} summary.netSettlement negated`, r3.summary.netSettlement, 806439.83, 0.005);
    eq(`${tag} tradeDate (alpha month 29/Jul/2026)`, r3.tradeDate, '29/07/2026');
    eq(`${tag} ucc`, r3.ucc, '60072941');
    eq(`${tag} recon difference ties to the paise`, r3.reconciliation!.difference, 0, 0.10);
    // Accepted behaviour: an STT-exempt note trips the shared suspicion flag.
    eq(`${tag} isSuspiciousStt (known, accepted)`, r3.reconciliation!.isSuspiciousStt, true);
    eq(`${tag} isSttMismatch false (0 == 0)`, r3.reconciliation!.isSttMismatch, false);
  }

  // ── V3B ── the real-world note: 2 scrips, brokerage, STT, IPFT, wrapped cells ──
  console.log('\n=== V3B (CN 893207 — two scrips, real brokerage + STT + IPFT) ===');
  const r4 = await v3.parsePdfText(V3B);
  if (!r4) { fail++; console.log('  FAIL V3B returned null'); }
  else {
    eq('V3B detect', v3.detect(V3B, true), true);
    // ~200 Annexure rows must contribute NOTHING. "INDUSTOWER 1100000082135790"
    // space-strips to a run whose first 12 chars pass the ISIN pattern, so a loose
    // match would mint a phantom scrip here.
    eq('V3B trade count is 2, Annexure rows rejected', r4.trades.length, 2);

    const gail = r4.trades.find((t) => t.securityName === 'GAIL');
    const ind = r4.trades.find((t) => t.securityName === 'INDUSTOWER');
    eq('V3B GAIL present', !!gail, true);
    eq('V3B INDUSTOWER present', !!ind, true);
    if (gail && ind) {
      eq('V3B GAIL isin', gail.isin, 'INE129A01019');
      eq('V3B GAIL qty', gail.quantity, 47088);
      eq('V3B GAIL avgPrice = WAP Mkt Rate', gail.avgPrice, 174.1348, 1e-9);
      // gross, NOT the printed Trade Amt of 81,91,461.44 (which is net of brokerage)
      eq('V3B GAIL turnover = qty x Mkt Rate (gross)', gail.turnover, 8199659.46, 0.005);
      eq('V3B GAIL side', gail.transactionType, 'Sell');
      eq('V3B GAIL tradeType', gail.tradeType, 'Delivery');

      eq('V3B IND isin', ind.isin, 'INE121J01017');
      eq('V3B IND qty', ind.quantity, 4561);
      eq('V3B IND avgPrice', ind.avgPrice, 381.6451, 1e-9);
      eq('V3B IND turnover', ind.turnover, 1740683.30, 0.005);

      const sumBrok = gail.brokerage + ind.brokerage;
      eq('V3B per-trade brokerage sums to the printed total', sumBrok, 9938.50, 0.005);
      eq('V3B GAIL brokerage from WAP Brok Rate', gail.brokerage, 47088 * 0.1741, 0.02);
      const sumStt = gail.stt + ind.stt;
      eq('V3B per-trade STT sums to the printed total', sumStt, 9940.00, 0.005);
      const sumIpf = gail.ipf + ind.ipf;
      eq('V3B IPFT allocated (label is "IPFT", not "IPF")', sumIpf, 0.01, 0.005);
      eq('V3B GST per trade sums to printed', gail.gst + ind.gst, 1845.66, 0.02);
    }

    eq('V3B summary.taxableValue = Brokerage line', r4.summary.taxableValue, 9938.50, 0.005);
    eq('V3B summary.stt is read (V3 DOES print STT)', r4.summary.stt, 9940.00, 0.005);
    eq('V3B summary.etc', r4.summary.etc, 305.16, 0.005);
    eq('V3B summary.sebiFees', r4.summary.sebiFees, 9.94, 0.005);
    eq('V3B summary.ipf from IPFT Charges', r4.summary.ipf, 0.01, 0.005);
    eq('V3B summary.cgst', r4.summary.cgst, 922.83, 0.005);
    eq('V3B summary.sgst', r4.summary.sgst, 922.83, 0.005);
    eq('V3B summary.gst = cgst+sgst', r4.summary.gst, 1845.66, 0.005);
    // Taxable Value of Supply is 10,253.61 = brokerage + ETC + SEBI + IPFT. It is the
    // GST base and must never land in taxableValue, which means brokerage here.
    eq('V3B Taxable Value of Supply NOT read as brokerage', r4.summary.taxableValue !== 10253.61, true);
    eq('V3B summary.stampDuty (sell = none)', r4.summary.stampDuty, 0, 0.005);
    eq('V3B summary.netSettlement negated', r4.summary.netSettlement, 9918303.49, 0.005);
    eq('V3B tradeDate', r4.tradeDate, '07/07/2026');
    eq('V3B ucc', r4.ucc, '60072941');
    eq('V3B recon difference ties to the paise', r4.reconciliation!.difference, 0, 0.10);
    eq('V3B recon PASSED (STT present, so no suspicion flag)', r4.reconciliation!.statusText, 'PASSED');
    eq('V3B recon isValid', r4.reconciliation!.isValid, true);
    eq('V3B isSuspiciousStt false', r4.reconciliation!.isSuspiciousStt, false);
    eq('V3B isSttMismatch false', r4.reconciliation!.isSttMismatch, false);
    // calculatedObligation should reproduce the note's printed obligation exactly.
    eq('V3B calculatedObligation = printed Pay In/Pay Out', r4.reconciliation!.calculatedObligation, 9940342.76, 0.02);
  }

  // ── V3C ── the BUY note: stamp duty, no IPFT, wrap inside the buy block ───────
  console.log('\n=== V3C (CN 113911 — a V3 BUY) ===');
  const r5 = await v3.parsePdfText(V3C);
  if (!r5) { fail++; console.log('  FAIL V3C returned null'); }
  else {
    eq('V3C detect', v3.detect(V3C, true), true);
    // The wrap lands inside the BUY block, leaving only 5 cells on the row's first
    // line. If the hyphenated number is not rejoined, the fragment occupies the
    // sell-QTY slot and a phantom sell can appear.
    eq('V3C exactly one trade, no phantom sell from the wrap', r5.trades.length, 1);
    const t = r5.trades[0];
    eq('V3C side is Buy', t.transactionType, 'Buy');
    eq('V3C isin', t.isin, 'INE024001021');
    eq('V3C name', t.securityName, 'AEROFLEX');
    eq('V3C qty', t.quantity, 10000);
    eq('V3C avgPrice = WAP Mkt Rate (gross)', t.avgPrice, 292.6125, 1e-9);
    // gross, NOT the printed Trade Amt 29,29,051.00 (= qty x Trade Rate, which on a
    // BUY is Mkt Rate PLUS brokerage: 292.6125 + 0.2926 = 292.9051)
    eq('V3C turnover = qty x Mkt Rate', t.turnover, 2926125.00, 0.005);
    eq('V3C netTotalBeforeLevies negative for a buy', t.netTotalBeforeLevies, -2926125.00, 0.005);
    eq('V3C tradeType', t.tradeType, 'Delivery');
    eq('V3C brokerage = WAP Brok Rate x qty', t.brokerage, 2926.00, 0.005);
    eq('V3C stt', t.stt, 2926.00, 0.005);
    eq('V3C stampDuty charged on a BUY', t.stampDuty, 439.00, 0.005);
    eq('V3C etc', t.etc, 89.83, 0.005);
    eq('V3C sebi', t.sebiFees, 2.93, 0.005);
    eq('V3C ipf zero (no IPFT line on this note)', t.ipf, 0, 0.005);
    eq('V3C gst', t.gst, 543.38, 0.005);
    eq('V3C totalExpensesInclSTT', t.totalExpensesInclSTT, 6927.14, 0.005);

    eq('V3C summary.taxableValue = Brokerage, not the 3018.76 GST base', r5.summary.taxableValue, 2926.00, 0.005);
    eq('V3C summary.stampDuty', r5.summary.stampDuty, 439.00, 0.005);
    eq('V3C summary.gst', r5.summary.gst, 543.38, 0.005);
    // "Net Amount Payable BY Client" is a DEBIT and prints positive; negating gives
    // the app's sign, where money leaving the client is negative.
    eq('V3C summary.netSettlement negated to app sign', r5.summary.netSettlement, -2933052.14, 0.005);
    eq('V3C payinObligation is GROSS on V3', r5.summary.payinObligation, 2926125.00, 0.005);
    eq('V3C tradeDate', r5.tradeDate, '16/04/2026');
    eq('V3C ucc', r5.ucc, '60072941');
    eq('V3C recon difference ties to the paise', r5.reconciliation!.difference, 0, 0.10);
    eq('V3C recon PASSED', r5.reconciliation!.statusText, 'PASSED');
    eq('V3C recon isValid', r5.reconciliation!.isValid, true);
    eq('V3C calculatedObligation = -gross for a buy', r5.reconciliation!.calculatedObligation, -2926125.00, 0.02);
  }

  // ── cross-variant guard: the wrong parser must not half-parse a note ───────
  console.log('\n=== wrong-variant guard ===');
  const legacyOnV3 = await v1.parsePdfText(V3);
  eq('V1 parser on a V3 note yields no trades', legacyOnV3 === null || legacyOnV3.trades.length === 0, true);
  const wapOnV1 = await v3.parsePdfText(V1);
  if (wapOnV1 && wapOnV1.trades.length > 0) {
    // If it does produce rows they must at least not reconcile, so the audit bar warns.
    eq('V3 parser on a V1 note does not falsely pass', wapOnV1.reconciliation!.isValid, false);
  } else {
    eq('V3 parser on a V1 note yields no trades', true, true);
  }

  console.log(`\n${'='.repeat(60)}\n${pass} passed, ${fail} failed\n${'='.repeat(60)}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
