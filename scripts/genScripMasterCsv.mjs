// Generates `scrip-master.csv` with 5 columns — ISIN, Security Name, BSE, NSE,
// Alias name — by merging the official NSE + BSE scrip lists by ISIN. Import the
// result into the shared Scrip Master Google Sheet (File → Import → Replace).
//
//   node scripts/genScripMasterCsv.mjs [path-to-EQUITY_L.csv] [path-to-bse-list.csv]
//
// Defaults read the copies bundled in scripts/sources/.
import fs from "fs";
import path from "path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");
const NSE = process.argv[2] || path.join(root, "scripts", "sources", "EQUITY_L.csv");
// Full BSE equity list fetched from BSE's official API (all groups). A .csv path
// (the older SME export) is also accepted and parsed by column position.
const BSE = process.argv[3] || path.join(root, "scripts", "sources", "bse_api.json");
const OUT = process.argv[4] || path.join(root, "scrip-master.csv");

// CSV line parser handling double-quoted fields containing commas.
function parseLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// MUST mirror normName in src/lib/scripMaster.ts
const normName = (s) => (s || "").toLowerCase()
  .replace(/[-.,()'"]/g, " ")
  .replace(/\b(limited|ltd|private|pvt|the|co)\b/g, " ")
  .replace(/\s+/g, " ").trim();

const validIsin = (s) => /^IN[A-Z0-9]{10}$/.test(s);

// CSV field escaper.
const esc = (v) => {
  const s = (v ?? "").toString();
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const byIsin = new Map();
const get = (isin) => {
  let e = byIsin.get(isin);
  if (!e) { e = { nseName: "", nseSym: "", bseName: "", bseId: "", bseCode: "", extra: new Set() }; byIsin.set(isin, e); }
  return e;
};

// NSE — col0 SYMBOL, col1 NAME OF COMPANY, col6 ISIN NUMBER.
let nseRows = 0;
for (const line of fs.readFileSync(NSE, "utf8").split(/\r?\n/).slice(1)) {
  if (!line.trim()) continue;
  const f = parseLine(line);
  const isin = (f[6] || "").toUpperCase();
  if (!validIsin(isin)) continue;
  const e = get(isin);
  if (!e.nseSym && !e.nseName) { e.nseSym = f[0] || ""; e.nseName = f[1] || ""; }
  else { if (f[0]) e.extra.add(f[0]); if (f[1]) e.extra.add(f[1]); }
  nseRows++;
}

// BSE — take the numeric Scrip Code + name, keyed by ISIN. The Scrip ID
// (alphabetic ticker) is intentionally NOT taken.
const addBse = (isinRaw, code, name) => {
  const isin = (isinRaw || "").trim().toUpperCase();
  if (!validIsin(isin)) return false;
  const e = get(isin);
  code = (code || "").toString().trim();
  name = (name || "").toString().trim();
  if (!e.bseCode && !e.bseName) { e.bseCode = code; e.bseName = name; }
  else { if (code) e.extra.add(code); if (name) e.extra.add(name); }
  return true;
};

let bseRows = 0;
if (BSE.toLowerCase().endsWith(".json")) {
  // BSE API records: SCRIP_CD (numeric code), ISIN_NUMBER, Issuer_Name / Scrip_Name.
  for (const r of JSON.parse(fs.readFileSync(BSE, "utf8"))) {
    if (addBse(r.ISIN_NUMBER, r.SCRIP_CD, r.Issuer_Name || r.Scrip_Name)) bseRows++;
  }
} else {
  // Legacy CSV: col0 Scrip Code (numeric), col2 Scrip Name, col6 ISIN No.
  for (const line of fs.readFileSync(BSE, "utf8").split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const f = parseLine(line);
    if (addBse(f[6], f[0], f[2])) bseRows++;
  }
}

const rows = [["ISIN", "Security Name", "BSE", "NSE", "Alias name"]];
for (const [isin, e] of byIsin) {
  const secName = e.nseName || e.bseName;
  const nse = e.nseSym;
  // BSE column holds the BSE numeric scrip code only (no Scrip ID / ticker).
  const bse = e.bseCode;

  // Alias column: the alternate-exchange name (when it differs from Security
  // Name) + any extras, deduped against the other columns. The BSE code, NSE and
  // Alias are all indexed as match aliases.
  const seen = new Set([secName, nse, e.bseCode].map(normName).filter(Boolean));
  const aliasParts = [];
  for (const cand of [e.bseName, ...e.extra]) {
    const nk = normName(cand);
    if (!nk || seen.has(nk)) continue;
    seen.add(nk);
    aliasParts.push(cand);
  }
  rows.push([isin, secName, bse, nse, aliasParts.join(" | ")]);
}

// Sort by Security Name for readability (header stays first).
const header = rows.shift();
rows.sort((a, b) => (a[1] || "").localeCompare(b[1] || ""));
rows.unshift(header);

const csv = rows.map(r => r.map(esc).join(",")).join("\r\n") + "\r\n";
fs.writeFileSync(OUT, csv, "utf8");
console.log(`Read ${nseRows} NSE rows + ${bseRows} BSE rows → ${byIsin.size} unique ISINs`);
console.log(`Wrote ${OUT} (${rows.length - 1} data rows, ${fs.statSync(OUT).size} bytes)`);
