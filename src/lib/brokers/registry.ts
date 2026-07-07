import { BrokerStrategy } from './types';
import { ZerodhaBrokerStrategy } from './zerodha';
import { ShareIndiaBrokerStrategy } from './shareindia';
import { IntegratedBrokerStrategy } from './integrated';
import { StandardBrokerStrategy } from './standard';
import { TransactionReportBrokerStrategy } from './transactionReport';

// Instances of all available brokers. TransactionReport is listed before
// Zerodha because its asset names can mention "Zerodha … ETF" which would
// otherwise falsely trigger Zerodha auto-detection; its own detect is strict.
const brokersList: BrokerStrategy[] = [
  new TransactionReportBrokerStrategy(),
  new ZerodhaBrokerStrategy(),
  new ShareIndiaBrokerStrategy(),
  new IntegratedBrokerStrategy(),
  new StandardBrokerStrategy(),
];

export const getBrokersList = (): BrokerStrategy[] => brokersList;

/**
 * Gets a specific broker strategy by its unique ID.
 * Defaults back to standard fallback if not found.
 */
export const getBroker = (id: string): BrokerStrategy => {
  const found = brokersList.find(b => b.id === id);
  if (found) return found;
  // Default fallback is the standard strategy
  return brokersList.find(b => b.id === 'standard') || brokersList[0];
};

/**
 * Automatically detects the appropriate broker strategy
 * based on document signatures inside HTML or raw text contents.
 */
export const detectBroker = (contents: string, isPdf: boolean): BrokerStrategy => {
  // Try to find a matches in order (excluding standard which acts as generic fallback)
  for (const broker of brokersList) {
    if (broker.id !== 'standard' && broker.detect(contents, isPdf)) {
      return broker;
    }
  }
  // Fallback to standard
  return getBroker('standard');
};
