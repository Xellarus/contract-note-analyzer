// Checks the "Private Equities" tab reader against the shapes the sheet can actually hold:
// header order, the Valuation-vs-Valuation-Date collision, serial dates, and the URL guard.
import { parsePrivateEquityVals } from './src/lib/privateEquities';

let pass = 0, fail = 0;
const eq = (label: string, got: any, want: any) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// 1. The minimum shape the user was told to create.
{
  const r = parsePrivateEquityVals([
    ['Company', 'Drive Link'],
    ['Acme Foods Private Limited', 'https://drive.google.com/drive/folders/abc'],
    ['Beta Ventures Pvt Ltd', ''],
  ]);
  eq('minimum: rows', r.length, 2);
  eq('minimum: name', r[0].company, 'Acme Foods Private Limited');
  eq('minimum: link', r[0].driveLink, 'https://drive.google.com/drive/folders/abc');
  eq('minimum: no link', r[1].driveLink, '');
  eq('minimum: no valuation', r[0].valuation, 0);
}

// 2. "Valuation Date" must NOT be read as the valuation. This is the trap the scrip
//    master's "Tally Name" column hit: two headers sharing a keyword.
{
  const r = parsePrivateEquityVals([
    ['Company', 'Valuation', 'Valuation Date', 'Drive Link'],
    ['Acme', 145.5, '2026-03-31', 'https://drive.google.com/x'],
  ]);
  eq('collision: valuation', r[0].valuation, 145.5);
  eq('collision: date', r[0].valuationDate, '2026-03-31');
  eq('collision: link', r[0].driveLink, 'https://drive.google.com/x');
}

// 3. Columns in a different order, with extras the app doesn't know.
{
  const r = parsePrivateEquityVals([
    ['ISIN', 'Notes', 'Company', 'Sector', 'Drive Folder', 'Fair Value'],
    ['INE123A01011', 'Series B', 'Gamma Labs', 'SaaS', 'https://drive.google.com/g', 88],
  ]);
  eq('reorder: company', r[0].company, 'Gamma Labs');
  eq('reorder: isin', r[0].isin, 'INE123A01011');
  eq('reorder: notes', r[0].notes, 'Series B');
  eq('reorder: link', r[0].driveLink, 'https://drive.google.com/g');
  eq('reorder: valuation', r[0].valuation, 88);
}

// 4. UNFORMATTED reads hand back a Sheets serial for a date cell — 2026-03-31 is 46112.
{
  const r = parsePrivateEquityVals([['Company', 'Valuation Date'], ['Acme', 46112]]);
  eq('serial date', r[0].valuationDate, '2026-03-31');
}

// 5. Only http(s) becomes a link — a note, a bare folder id or a javascript: URL must not.
{
  const r = parsePrivateEquityVals([
    ['Company', 'Drive Link'],
    ['A', 'javascript:alert(1)'],
    ['B', '1a2b3c-folder-id'],
    ['C', 'ask Rohit for the folder'],
    ['D', 'http://drive.google.com/ok'],
  ]);
  eq('url guard: javascript:', r[0].driveLink, '');
  eq('url guard: bare id', r[1].driveLink, '');
  eq('url guard: prose', r[2].driveLink, '');
  eq('url guard: http ok', r[3].driveLink, 'http://drive.google.com/ok');
}

// 6. A blank company is not an identity — skip it. Duplicates: first row wins.
{
  const r = parsePrivateEquityVals([
    ['Company', 'Drive Link'],
    ['', 'https://drive.google.com/x'],
    ['Acme', 'https://drive.google.com/first'],
    ['acme', 'https://drive.google.com/second'],
  ]);
  eq('skip blank + dedup: rows', r.length, 1);
  eq('first row wins', r[0].driveLink, 'https://drive.google.com/first');
}

// 7. No header at all → fall back to A=Company, B=Drive Link.
{
  const r = parsePrivateEquityVals([['Acme', 'https://drive.google.com/x']]);
  eq('headerless: company', r[0].company, 'Acme');
  eq('headerless: link', r[0].driveLink, 'https://drive.google.com/x');
}

// 8. A currency-formatted valuation (if the sheet is read FORMATTED by anything else).
{
  const r = parsePrivateEquityVals([['Company', 'Valuation'], ['Acme', '₹1,45,000.50']]);
  eq('formatted valuation', r[0].valuation, 145000.5);
}

// 9. A negative valuation is nonsense — clamp rather than let it invert a position's value.
{
  const r = parsePrivateEquityVals([['Company', 'Valuation'], ['Acme', -20]]);
  eq('negative valuation clamped', r[0].valuation, 0);
}

// 10. An unparseable date yields "" rather than a wrong date.
{
  const r = parsePrivateEquityVals([['Company', 'Valuation Date'], ['Acme', 'last quarter']]);
  eq('bad date → empty', r[0].valuationDate, '');
}

// 11. Empty tab.
eq('empty', parsePrivateEquityVals([]).length, 0);
eq('header only', parsePrivateEquityVals([['Company', 'Drive Link']]).length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
