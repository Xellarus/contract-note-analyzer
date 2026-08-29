import { ContractNoteResult } from '../../types';

/**
 * Every id the broker picker can select, and the only thing `getBroker` and
 * `processFile` accept. ONE definition on purpose: this used to be hand-duplicated
 * as a literal union in both `processFile`'s signature and App's picker state, so
 * adding a broker to one and not the other broke the build (or, worse, widened one
 * to `string` and lost the check).
 *
 * 'auto' means "let detectBroker decide"; the picker never sets it today.
 *
 * Nuvama appears three times because it has issued three different note templates —
 * see brokers/nuvama.ts. All three set `brokerName: 'nuvama'` on the parse result,
 * so the variant never leaks into the import log, export filenames, or the ~20
 * places that switch on brokerName.
 */
export type BrokerId =
  | 'auto'
  | 'zerodha'
  | 'shareindia'
  | 'integrated'
  | 'transaction-report'
  | 'nuvama-v1'
  | 'nuvama-v2'
  | 'nuvama-v3'
  | 'axis';

export interface BrokerStrategy {
  id: string;
  name: string;
  displayName: string;
  
  /**
   * Automatically detect if the provided content (HTML text or PDF raw text)
   * matches this broker's signature.
   */
  detect(content: string, isPdf: boolean): boolean;

  /**
   * Parse the contract note from an HTML format document.
   */
  parseHtml(html: string): Promise<ContractNoteResult | null>;

  /**
   * Parse the contract note from PDF-extracted text.
   */
  parsePdfText(text: string): Promise<ContractNoteResult | null>;

  /**
   * Optional: parse a CSV export (e.g. a broker transaction report). Only the
   * strategies that accept CSV input implement this.
   */
  parseCsv?(text: string): Promise<ContractNoteResult | null>;
}
