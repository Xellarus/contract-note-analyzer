import { ContractNoteResult } from '../../types';

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
}
