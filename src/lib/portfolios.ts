/**
 * Single source of truth for the portfolios the app manages. Add a portfolio by
 * appending one entry here — the Dashboard, Holdings page, importer, Reports and
 * the Add Trade drawer all read from this list.
 *
 *   id      internal key (lowercase, stable — usually the UCC lowercased)
 *   code    UCC / client code shown as a badge
 *   label   display name — the plain person/entity name. NOT disambiguated: three accounts
 *           are 'Saket Agarwal'. Use `portfolioDisplayLabel` anywhere the label appears
 *           WITHOUT a badge or client code beside it.
 *   broker  'integrated' | 'shareindia' | 'zerodha' | 'nuvama' | 'axis' (which broker the
 *           account is with). Nothing BRANCHES on it, but it is now DISPLAYED — the
 *           portfolio card's badge shows `brokerLabel(broker)`, so a new value here needs an
 *           entry in BROKER_LABELS below or the badge falls back to the raw key.
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
  { id: 's713',   code: 'S713',   label: 'Saket Agarwal',               broker: 'integrated', sheetId: '1Ns1QS91goIg7s4XyY_aO1D1RXRqysoMqGK8H9ybrYSM', ucc: ['S713'] },
  { id: 'c087',   code: 'C087',   label: 'Chaitanya Agarwal',           broker: 'integrated', sheetId: '1JGrCbQf2tgqRsZ6EQHDxkoxQtK1i8ytBznjAz1TGhBg', ucc: ['C087'] },
  { id: 's1404',  code: 'S1404',  label: 'Sagun Capital',               broker: 'integrated', sheetId: '1THFbOTkuhaM7fZz17adNFq2uhCLGEpGP_YF7AiKKyFY', ucc: ['S1404'] },
  { id: 'g058',   code: 'G058',   label: 'Gunjan Agarwal',              broker: 'integrated', sheetId: '1oNy7HbQHu9NnCNql2hmkkkd2tiJcAiQ-eyFN9Xz9H6Y', ucc: ['G058'] },
  { id: 'oaem94', code: 'OAEM94', label: 'Gunjan Agarwal',              broker: 'shareindia', sheetId: '1GpjgUDDF5f8qdGwnjtnTxvj-hWGH4w2By7rZGw32fxE', ucc: ['OAEM94'] },
  { id: 'oadr97', code: 'OADR97', label: 'Saket Agarwal',               broker: 'shareindia', sheetId: '15tpza8l4JtqZQQvrgSv6brEr1iAAQKdp5LPQGyu0lEw', ucc: ['OADR97'] },
  { id: 'cs1106', code: 'CS1106', label: 'Shree Balaji Investments',    broker: 'shareindia', sheetId: '1qZL9Mhpwvm7jVuqmBQppRZ-9BW1V86haY3q0keOjDYY', ucc: ['CS1106'] },
  { id: 'oaeu09', code: 'OAEU09', label: 'Aditya Agarwal',              broker: 'shareindia', sheetId: '1snmLk3-Y8VoopYSRjVWAMqkINf34daW_ZwA6-Gs9UZM', ucc: ['OAEU09'] },
  { id: 'njw724', code: 'NJW724', label: 'Aditya Agarwal',              broker: 'zerodha',    sheetId: '1QoW51xsJfLtjkSGnEnaqsClgFd4AHJdbnVQKMLHhmYY', ucc: ['NJW724'] },
  // Nuvama UCCs are numeric ("Trading/ Back Office Code" on the note), not letter+digits
  // like the other brokers — so the code badge reads as a number here.
  { id: '60072941', code: '60072941', label: 'Uma Agarawal', broker: 'nuvama', sheetId: '1LSfd2WVg0-Q_95lgsCZNI93ULZKqBi9PPdvT5Jo4qGs', ucc: ['60072941'] },
  // Axis prints "Unique Client Code 6150725" - numeric, like Nuvama. The ucc[] entry is
  // what routes an imported note here (portfolioByUcc); get it wrong and the note lands
  // silently in whichever portfolio the picker happened to have selected.
  { id: '6150725', code: '6150725', label: 'Saket Agarwal', broker: 'axis', sheetId: '1dTbR5th50YQRzONe_4ybAlX4okKAqfTXhrpQKgg8U_s', ucc: ['6150725'] },
];

/**
 * How each broker is NAMED on screen — the portfolio card's badge.
 *
 * The badge used to carry the UCC / client code (`T059`), which the user already knows for the
 * account they are looking at; which FIRM holds it is the more useful thing at a glance. The
 * code is not lost: it stays in the badge's tooltip, in the detail header's subtext, in every
 * portfolio dropdown, and in the Import Log — which matters because the code, not the broker,
 * is what a contract note prints and what routes an import (`portfolioByUcc`).
 *
 * Keyed on `Portfolio.broker`, so five Integrated accounts all read IMSPL and are told apart by
 * their label. Where the LABEL also repeats (three "Saket Agarwal"), the badge is what
 * separates them on the card — and `portfolioDisplayLabel` does it everywhere the badge is
 * absent.
 */
export const BROKER_LABELS: Record<string, string> = {
  integrated: 'IMSPL',        // Integrated Master Securities Pvt Ltd
  shareindia: 'Share India',
  zerodha: 'Zerodha',
  nuvama: 'Nuvama',
  axis: 'Axis',
};

/**
 * Display name for a broker key. Falls back to the RAW KEY uppercased rather than to the
 * client code: a missing BROKER_LABELS entry should look wrong so it gets fixed, not quietly
 * resemble the old behaviour.
 */
export const brokerLabel = (broker: string): string => {
  const b = (broker || '').trim();
  if (!b) return '';
  return BROKER_LABELS[b] || b.toUpperCase();
};

// A portfolio whose broker has no label still renders, but says so in the console rather than
// waiting to be noticed on screen. Warned, not thrown: an unnamed broker is a cosmetic gap and
// blanking the whole app over it would be wildly out of proportion.
{
  const missing = [...new Set(PORTFOLIOS.map((p) => p.broker).filter((b) => b && !BROKER_LABELS[b]))];
  if (missing.length) {
    console.warn(`portfolios.ts: no BROKER_LABELS entry for ${missing.join(', ')} — `
      + `the portfolio badge will show the raw key. Add one.`);
  }
}

/**
 * The label, plus the broker ONLY when that label is shared with another portfolio.
 *
 * `label` is the plain name now that the card badge carries the broker - so three accounts read
 * "Saket Agarwal". That is correct beside a badge or a client code, and ambiguous without one:
 * a returns table listing "Saket Agarwal" three times with three different XIRRs is unreadable.
 *
 * DERIVED from the registry, not hand-typed. The suffixes this replaces were hand-maintained and
 * went stale the moment the badge changed; a computed one cannot, and it stays silent for names
 * that do not actually repeat.
 */
export const portfolioDisplayLabel = (p: Portfolio | undefined): string => {
  if (!p) return '';
  const shared = PORTFOLIOS.some((o) => o.id !== p.id && o.label === p.label);
  return shared ? `${p.label} (${brokerLabel(p.broker)})` : p.label;
};

/** Where blank/unknown routing falls back to. */
export const DEFAULT_PORTFOLIO_ID = 't059';

/** A portfolio id, or the in-memory demo portfolio. */
export type PortfolioId = string;

export const portfolioById = (id: string): Portfolio | undefined => PORTFOLIOS.find((p) => p.id === id);

/**
 * `portfolioDisplayLabel` by id — for the engines that carry a NARROWED portfolio shape
 * (`corpActionAlerts`, `crossHoldings` take `{id, label, sheetId}`, with no `broker` to
 * disambiguate on). They hold the id, so the registry answers it.
 */
export const displayLabelForId = (id: string): string => portfolioDisplayLabel(portfolioById(id));

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
