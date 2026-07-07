/**
 * Parser for a screener.in CSV export. Such an export carries one row per
 * security with (at least) Name, BSE Code, NSE Code, ISIN Code and Current
 * Price, plus many fundamental columns we ignore. We use it for two things:
 *   1. enriching the shared scrip master (ISIN ↔ name + BSE/NSE codes), and
 *   2. a current-price snapshot to value holdings.
 *
 * Import the CSV, not the PDF — a PDF of this wide table comes out with mashed
 * and blank cells, whereas the CSV is clean and tabular.
 */
export interface ScreenerSecurity {
  isin: string;
  name: string;
  bse: string;      // numeric BSE scrip code
  nse: string;      // NSE symbol
  price: number;    // Current Price (0 if absent/unparseable)
  industry: string; // Industry / Sector classification ("" if the column is absent)
}

// 12-char ISIN: 2-letter country + 9 alphanumerics + 1 check digit.
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

const parseNum = (s: string): number => {
  const v = parseFloat((s ?? "").toString().replace(/,/g, "").trim());
  return isNaN(v) ? NaN : v;
};

/** CSV line splitter that respects double-quoted fields containing commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/**
 * Detects whether `text` looks like a screener.in CSV export (has an ISIN column
 * and a Current Price column). Used to route a dropped file to this importer.
 */
export function isScreenerCsv(text: string): boolean {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "");
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const cells = splitCsvLine(lines[i]).map(norm);
    const has = (...keys: string[]) => cells.some(c => keys.some(k => c === k));
    const hasPrice = has("CURRENTPRICE", "PRICE", "CMP", "LTP", "CMPRS") ||
      cells.some(c => c.startsWith("CMP") || c.startsWith("CURRENTPRICE"));
    if (has("ISINCODE", "ISIN") && hasPrice) return true;
  }
  return false;
}

/**
 * Parse a screener.in CSV into one ScreenerSecurity per ISIN-bearing row.
 * Columns are detected from the header by name (any order, extra columns
 * tolerated); rows without a valid ISIN are skipped, and duplicate ISINs keep
 * the first occurrence.
 */
export function parseScreenerCsv(text: string): ScreenerSecurity[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "");
  let cols: { isin: number; name: number; price: number; bse: number; nse: number; industry: number } | null = null;
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const cells = splitCsvLine(lines[i]).map(norm);
    const find = (...keys: string[]) => cells.findIndex(c => keys.some(k => c === k));
    const isin = find("ISINCODE", "ISIN");
    const name = find("NAME", "COMPANYNAME", "COMPANY", "SECURITY");
    let price = find("CURRENTPRICE", "PRICE", "CMP", "LTP", "CMPRS");
    if (price < 0) price = cells.findIndex(c => c.startsWith("CMP") || c.startsWith("CURRENTPRICE"));
    const bse = find("BSECODE", "BSE");
    const nse = find("NSECODE", "NSE", "NSESYMBOL", "SYMBOL");
    const industry = find("INDUSTRY", "SECTOR", "INDUSTRYNAME", "SECTORNAME");
    if (isin >= 0 && name >= 0 && price >= 0) { headerIdx = i; cols = { isin, name, price, bse, nse, industry }; break; }
  }
  if (!cols || headerIdx < 0) return [];

  const out: ScreenerSecurity[] = [];
  const seen = new Set<string>();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const isin = (f[cols.isin] || "").trim().toUpperCase();
    if (!ISIN_RE.test(isin) || seen.has(isin)) continue;
    seen.add(isin);
    const name = (f[cols.name] || "").trim();
    const bse = cols.bse >= 0 ? (f[cols.bse] || "").trim() : "";
    const nse = cols.nse >= 0 ? (f[cols.nse] || "").trim().toUpperCase() : "";
    const industry = cols.industry >= 0 ? (f[cols.industry] || "").trim() : "";
    const price = parseNum(f[cols.price] || "");
    out.push({ isin, name, bse, nse, price: isNaN(price) ? 0 : price, industry });
  }
  return out;
}
