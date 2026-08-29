/**
 * Single source of truth for the portfolios the app manages. Add a portfolio by
 * appending one entry here — the Dashboard, Holdings page, importer, Reports and
 * the Add Trade drawer all read from this list.
 *
 *   id      internal key (lowercase, stable — usually the UCC lowercased)
 *   code    UCC / client code shown as a badge
 *   label   display name (disambiguated with the broker where a name repeats)
 *   broker  'integrated' | 'shareindia' | 'zerodha' | 'nuvama' | 'axis' (which broker the
 *           account is with — documentation only; nothing branches on it)
 *   sheetId Google Sheet ID backing this portfolio
 *   ucc     UCC code(s) that route an imported contract note to this sheet
 *           (usually just [code]; leave [] for manual-entry-only portfolios)
 */
export interface Portfolio {
  id: string;
  code: string;
  label: string;
  broker: string;
  sheetId: string;
  ucc: string[];
}

export const PORTFOLIOS: Portfolio[] = [
  { id: 't059',   code: 'T059',   label: 'Taparia Holdings',            broker: 'integrated', sheetId: '1ZIW1LeWtHeePcg5C4T-cANz0Xww1ttqlCfxOsb3jgAw', ucc: ['T059'] },
  { id: 's713',   code: 'S713',   label: 'Saket Agarwal (Integrated)',  broker: 'integrated', sheetId: '1Ns1QS91goIg7s4XyY_aO1D1RXRqysoMqGK8H9ybrYSM', ucc: ['S713'] },
  { id: 'c087',   code: 'C087',   label: 'Chaitanya Agarwal',           broker: 'integrated', sheetId: '1JGrCbQf2tgqRsZ6EQHDxkoxQtK1i8ytBznjAz1TGhBg', ucc: ['C087'] },
  { id: 's1404',  code: 'S1404',  label: 'Sagun Capital',               broker: 'integrated', sheetId: '1THFbOTkuhaM7fZz17adNFq2uhCLGEpGP_YF7AiKKyFY', ucc: ['S1404'] },
  { id: 'g058',   code: 'G058',   label: 'Gunjan Agarwal (Integrated)', broker: 'integrated', sheetId: '1oNy7HbQHu9NnCNql2hmkkkd2tiJcAiQ-eyFN9Xz9H6Y', ucc: ['G058'] },
  { id: 'oaem94', code: 'OAEM94', label: 'Gunjan Agarwal (ShareIndia)', broker: 'shareindia', sheetId: '1GpjgUDDF5f8qdGwnjtnTxvj-hWGH4w2By7rZGw32fxE', ucc: ['OAEM94'] },
  { id: 'oadr97', code: 'OADR97', label: 'Saket Agarwal (ShareIndia)',  broker: 'shareindia', sheetId: '15tpza8l4JtqZQQvrgSv6brEr1iAAQKdp5LPQGyu0lEw', ucc: ['OADR97'] },
  { id: 'cs1106', code: 'CS1106', label: 'Shree Balaji Investments',    broker: 'shareindia', sheetId: '1qZL9Mhpwvm7jVuqmBQppRZ-9BW1V86haY3q0keOjDYY', ucc: ['CS1106'] },
  { id: 'oaeu09', code: 'OAEU09', label: 'Aditya Agarwal (ShareIndia)', broker: 'shareindia', sheetId: '1snmLk3-Y8VoopYSRjVWAMqkINf34daW_ZwA6-Gs9UZM', ucc: ['OAEU09'] },
  { id: 'njw724', code: 'NJW724', label: 'Aditya Agarwal (Zerodha)',    broker: 'zerodha',    sheetId: '1QoW51xsJfLtjkSGnEnaqsClgFd4AHJdbnVQKMLHhmYY', ucc: ['NJW724'] },
  // Nuvama UCCs are numeric ("Trading/ Back Office Code" on the note), not letter+digits
  // like the other brokers — so the code badge reads as a number here.
  { id: '60072941', code: '60072941', label: 'Uma Agarawal', broker: 'nuvama', sheetId: '1LSfd2WVg0-Q_95lgsCZNI93ULZKqBi9PPdvT5Jo4qGs', ucc: ['60072941'] },
  // Axis prints "Unique Client Code 6150725" - numeric, like Nuvama. The ucc[] entry is
  // what routes an imported note here (portfolioByUcc); get it wrong and the note lands
  // silently in whichever portfolio the picker happened to have selected.
  { id: '6150725', code: '6150725', label: 'Saket Agarwal (Axis)', broker: 'axis', sheetId: '1dTbR5th50YQRzONe_4ybAlX4okKAqfTXhrpQKgg8U_s', ucc: ['6150725'] },
];

/** Where blank/unknown routing falls back to. */
export const DEFAULT_PORTFOLIO_ID = 't059';

/** A portfolio id, or the in-memory demo portfolio. */
export type PortfolioId = string;

export const portfolioById = (id: string): Portfolio | undefined => PORTFOLIOS.find((p) => p.id === id);

/** Match a contract-note UCC to its portfolio (case-insensitive). */
export const portfolioByUcc = (ucc: string): Portfolio | undefined => {
  const u = (ucc || '').trim().toUpperCase();
  return u ? PORTFOLIOS.find((p) => p.ucc.some((c) => c.toUpperCase() === u)) : undefined;
};

/** Match a portfolio by its client code (case-insensitive) — used to resolve the
 *  backing sheet from a code stored in the Import Log (e.g. when rewinding). */
export const portfolioByCode = (code: string): Portfolio | undefined => {
  const c = (code || '').trim().toUpperCase();
  return c ? PORTFOLIOS.find((p) => p.code.toUpperCase() === c) : undefined;
};

export const sheetIdForId = (id: string): string => portfolioById(id)?.sheetId ?? '';

export const portfolioSheetUrl = (id: string): string => {
  const s = sheetIdForId(id);
  return s ? `https://docs.google.com/spreadsheets/d/${s}/edit` : '';
};
