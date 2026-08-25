/**
 * Tells "you don't have access to this spreadsheet" apart from "this book is empty".
 *
 * Those two states used to be pixel-identical. Every read site swallowed its error —
 * `catch { /* keep any prior value * / }` — so a colleague who had not been shared on a
 * portfolio saw a card reading ₹0, indistinguishable from a client who simply hasn't
 * traded. The app looked broken instead of saying what was wrong.
 *
 * There is deliberately no authorisation logic here. The browser calls Sheets with the
 * signed-in user's own token, so Google's answer IS the authority; this only classifies
 * that answer so the UI can report it honestly.
 */
export type SheetsErrorKind = 'denied' | 'missing' | 'other';

export const classifySheetsError = (e: any): SheetsErrorKind => {
  // gapi reports the HTTP status in several shapes depending on the call path.
  const code = Number(e?.status ?? e?.result?.error?.code ?? e?.code ?? 0);
  const msg = String(e?.result?.error?.message ?? e?.message ?? e?.body ?? '');
  const reason = String(e?.result?.error?.errors?.[0]?.reason ?? '');

  // A quota/rate-limit failure also arrives as 403. Reporting that as "not shared with
  // you" would send someone chasing a permission they already have, so it stays 'other'
  // and keeps the old silent-retry behaviour.
  if (/quota|rate ?limit|userRateLimitExceeded/i.test(msg + ' ' + reason)) return 'other';

  if (code === 403 || /permission|does not have access|insufficient/i.test(msg)) return 'denied';
  if (code === 404 || /not found|requested entity was not found/i.test(msg)) return 'missing';
  return 'other';
};

/** Labels for the two states worth showing a human. */
export const sheetsAccessLabel = (k: SheetsErrorKind): string =>
  k === 'denied' ? 'Not shared with you' : k === 'missing' ? 'Sheet not found' : '';
