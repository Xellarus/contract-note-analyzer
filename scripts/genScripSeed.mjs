// Regenerates src/data/scripSeed.json — the bundled NSE + BSE scrip master
// (symbol + full name + ISIN, merged by ISIN) used by src/lib/scripMaster.ts.
//
// Usage (download fresh lists first):
//   NSE equity list:  https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv
//   BSE scrip list:   https://www.bseindia.com/corporates/List_Scrips.aspx (export CSV)
//
//   node scripts/genScripSeed.mjs <path-to-EQUITY_L.csv> <path-to-bse-list.csv>
//
// Both args optional; defaults point at the user's Downloads folder.
import fs from "fs";

const NSE = process.argv[2] || "C:/Users/Priti/Downloads/EQUITY_L.csv";
const BSE = process.argv[3] || "C:/Users/Priti/Downloads/ListOfScrips6_17_2026.csv";
const OUT = "src/data/scripSeed.json";

// CSV line parser handling double-quoted fields containing commas
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
const byIsin = new Map();

function add(isin, name, symbol, preferName) {
  isin = (isin || "").trim().toUpperCase();
  if (!validIsin(isin)) return;
  name = (name || "").trim();
  symbol = (symbol || "").trim();
  let e = byIsin.get(isin);
  if (!e) { e = { name: name || symbol, aliases: new Set() }; byIsin.set(isin, e); }
  else if (preferName && name) { e.aliases.add(e.name); e.name = name; }
  if (symbol) e.aliases.add(symbol);
  if (name) e.aliases.add(name);
}

// NSE first so its company names win as canonical; cols: 0 SYMBOL, 1 NAME, 6 ISIN
for (const line of fs.readFileSync(NSE, "utf8").split(/\r?\n/).slice(1)) {
  if (!line.trim()) continue;
  const f = parseLine(line);
  add(f[6], f[1], f[0], true);
}
// BSE adds alias symbols/names; cols: 1 Scrip ID, 2 Scrip Name, 6 ISIN No
for (const line of fs.readFileSync(BSE, "utf8").split(/\r?\n/).slice(1)) {
  if (!line.trim()) continue;
  const f = parseLine(line);
  add(f[6], f[2], f[1], false);
}

const out = [];
for (const [isin, e] of byIsin) {
  const seen = new Set([normName(e.name)]);
  const aliases = [];
  for (const a of e.aliases) {
    const n = normName(a);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    aliases.push(a);
  }
  const rec = { i: isin, n: e.name };
  if (aliases.length) rec.a = aliases;
  out.push(rec);
}
out.sort((x, y) => x.n.localeCompare(y.n));
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`Wrote ${out.length} scrips to ${OUT} (${fs.statSync(OUT).size} bytes)`);
