import { BrokerStrategy } from './types';
import { ZerodhaBrokerStrategy } from './zerodha';
import { ShareIndiaBrokerStrategy } from './shareindia';
import { IntegratedBrokerStrategy } from './integrated';
import { TransactionReportBrokerStrategy } from './transactionReport';
import { NuvamaBrokerStrategy } from './nuvama';

// Instances of all available brokers. ORDER IS LOAD-BEARING for auto-detection,
// which is first-match-wins:
//
//   • TransactionReport before Zerodha — its asset names can mention "Zerodha …
//     ETF", which would falsely satisfy Zerodha's bare text.includes("zerodha").
//   • Nuvama v3 before v2 before v1 — V2's letterhead reads "Nuvama Wealth and
//     Investment Limited (Formerly - Edelweiss Broking Limited)", so it contains
//     BOTH brand names; and V3 is Nuvama-branded too. Each variant's detect()
//     excludes the others explicitly, but the ordering keeps the most specific
//     template first regardless.
//
// Nuvama is registered three times because it has issued three different note
// templates to the same client (2021 Edelweiss, 2023 Nuvama, 2026 rewrite). One
// class serves all three — see nuvama.ts. This is the same idea as
// IntegratedBrokerStrategy's internal classifyFormat() branch, except the variant
// is chosen explicitly from the picker's dropdown rather than sniffed.
//
// There is no generic catch-all strategy. One used to exist ('standard', a
// layout-agnostic parser whose detect() returned true unconditionally) but the
// picker only ever offers real note sources, so nothing could reach it. A new
// broker means a new strategy file.
const brokersList: BrokerStrategy[] = [
  new TransactionReportBrokerStrategy(),
  new ZerodhaBrokerStrategy(),
  new ShareIndiaBrokerStrategy(),
  new IntegratedBrokerStrategy(),
  new NuvamaBrokerStrategy('v3'),
  new NuvamaBrokerStrategy('v2'),
  new NuvamaBrokerStrategy('v1'),
];

export const getBrokersList = (): BrokerStrategy[] => brokersList;

const DEFAULT_BROKER_ID = 'zerodha';

/**
 * Gets a specific broker strategy by its unique ID.
 * Falls back to Zerodha for an unknown id — it is also the picker's initial
 * selection, so an unrecognised id behaves like no choice having been made.
 */
export const getBroker = (id: string): BrokerStrategy => {
  const found = brokersList.find(b => b.id === id);
  if (found) return found;
  return brokersList.find(b => b.id === DEFAULT_BROKER_ID) || brokersList[0];
};

/**
 * Automatically detects the appropriate broker strategy
 * based on document signatures inside HTML or raw text contents.
 *
 * Every strategy now has a real signature to match, so an unrecognised note
 * matches nothing and lands on Zerodha — which is what parsePdfContractNote
 * already did explicitly when detection produced no usable parse.
 */
export const detectBroker = (contents: string, isPdf: boolean): BrokerStrategy => {
  for (const broker of brokersList) {
    if (broker.detect(contents, isPdf)) {
      return broker;
    }
  }
  return getBroker(DEFAULT_BROKER_ID);
};
