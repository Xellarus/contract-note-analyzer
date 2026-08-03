/**
 * YahooPriceUpdate.gs — auto-refresh the app's market prices from Yahoo Finance.
 *
 * WHY A SCRIPT (not the app): Yahoo's quote endpoints are not CORS-enabled, so the
 * browser app can't call them directly. Apps Script's UrlFetchApp runs server-side
 * (no CORS) and writes straight into the same "Prices" tab the app already reads
 * (src/lib/scripPrices.ts) — so nothing downstream changes; prices just get fresher.
 *
 * WHAT IT DOES:
 *   1. Collects the scrips actually HELD across every portfolio (each sheet's "Holding" tab).
 *   2. Maps each to a Yahoo ticker via the Scrip Master's NSE / BSE columns
 *      (NSE symbol → "<SYM>.NS", else BSE code → "<CODE>.BO").
 *   3. Fetches the last price from Yahoo's v8 chart endpoint (the reliable one; the v7
 *      quote batch endpoint now needs an auth crumb).
 *   4. Merges {ISIN, Name, Current Price, Updated, Previous Price} into the "Prices" tab
 *      of the Scrip Master spreadsheet — identical schema + daily "Previous Price" roll to
 *      saveScripPrices() in the app.
 *
 * TWO ENTRY POINTS:
 *   • scheduledUpdate()  — set as a time trigger (installPriceTrigger). Skips outside
 *                          NSE hours to save quota.
 *   • doGet(e)           — deploy as a Web App ("Execute as: me", "Who has access: Anyone").
 *                          The app's "Refresh Prices" button GETs the /exec URL to force a
 *                          fresh pull on demand. Returns JSON {ok, updated, total}.
 *
 * CAVEAT: Yahoo has no official API — unofficial, ~15-min delayed, occasionally rate-limited
 * or format-changed. Scrips with no NSE/BSE symbol (or that Yahoo doesn't list) are skipped;
 * their last price simply stays. SpreadsheetApp is used (no advanced service to enable).
 */

var CONFIG = {
  SCRIP_MASTER_ID: '1gLDfmeQe0wzfHWfaBReVk-6KsAvy1ZamfQAMrIVWsHg',   // holds the "Prices" tab
  PRICES_TAB: 'Prices',
  STATUS_TAB: 'Price Status',   // scrips this run couldn't price → read by the app's "unpriced" button
  HOLDING_TAB: 'Holding',
  BATCH: 40,                 // symbols per UrlFetchApp.fetchAll call
  MARKET_OPEN_MIN: 9 * 60,   // 09:00 IST
  MARKET_CLOSE_MIN: 16 * 60, // 16:00 IST (a little past close, to catch the settle)
};

// Portfolio sheets to read holdings from (mirrors src/lib/portfolios.ts / the auto-import .gs).
var PORTFOLIOS = [
  { code: 'T059',   sheetId: '1ZIW1LeWtHeePcg5C4T-cANz0Xww1ttqlCfxOsb3jgAw' },
  { code: 'S713',   sheetId: '1Ns1QS91goIg7s4XyY_aO1D1RXRqysoMqGK8H9ybrYSM' },
  { code: 'C087',   sheetId: '1JGrCbQf2tgqRsZ6EQHDxkoxQtK1i8ytBznjAz1TGhBg' },
  { code: 'S1404',  sheetId: '1THFbOTkuhaM7fZz17adNFq2uhCLGEpGP_YF7AiKKyFY' },
  { code: 'G058',   sheetId: '1oNy7HbQHu9NnCNql2hmkkkd2tiJcAiQ-eyFN9Xz9H6Y' },
  { code: 'OAEM94', sheetId: '1GpjgUDDF5f8qdGwnjtnTxvj-hWGH4w2By7rZGw32fxE' },
  { code: 'OADR97', sheetId: '15tpza8l4JtqZQQvrgSv6brEr1iAAQKdp5LPQGyu0lEw' },
  { code: 'CS1106', sheetId: '1qZL9Mhpwvm7jVuqmBQppRZ-9BW1V86haY3q0keOjDYY' },
  { code: 'OAEU09', sheetId: '1snmLk3-Y8VoopYSRjVWAMqkINf34daW_ZwA6-Gs9UZM' },
  { code: 'NJW724', sheetId: '1QoW51xsJfLtjkSGnEnaqsClgFd4AHJdbnVQKMLHhmYY' },
];

// ════════════════════════════════════════════════════════════════════════════
// ENTRY POINTS
// ════════════════════════════════════════════════════════════════════════════

// Time-trigger entry — skip outside market hours so we don't burn UrlFetch quota overnight.
function scheduledUpdate() {
  if (!isMarketHours_()) { Logger.log('Outside NSE hours — skipped.'); return; }
  var r = updatePrices();
  Logger.log('Scheduled price update: ' + r.updated + '/' + r.total + ' priced.');
}

// Web-app entry — the app's "Refresh Prices" button GETs this. Always fetches (manual intent).
function doGet(e) {
  var out;
  try { var r = updatePrices(); out = { ok: true, updated: r.updated, total: r.total, missed: r.missed, at: r.at }; }
  catch (err) { out = { ok: false, error: (err && err.message) ? err.message : String(err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════════════════════
// CORE
// ════════════════════════════════════════════════════════════════════════════

function updatePrices() {
  var master = loadMasterSymbols_();
  var held = collectHeldScrips_();          // [{ isin, name }] union across portfolios
  var targets = [];                          // [{ isin, name, primary, fallback }]
  var misses = [];                           // [{ isin, name, reason }]
  var seen = {};
  for (var i = 0; i < held.length; i++) {
    var h = held[i];
    var key = (h.isin || h.name).toUpperCase();
    if (seen[key]) continue; seen[key] = true;
    var syms = symbolsFor_(master, h.isin, h.name);
    if (!syms.primary) { misses.push({ isin: h.isin, name: h.name, reason: 'No NSE/BSE symbol in scrip master' }); continue; }
    targets.push({ isin: h.isin, name: h.name, primary: syms.primary, fallback: syms.fallback });
  }

  var priced = {};   // key → { isin, name, price }
  // Pass 1 — primary exchange (NSE if present, else BSE).
  var p1 = fetchBatch_(targets, function (t) { return t.primary; });
  for (var a = 0; a < p1.ok.length; a++) { var r = p1.ok[a]; priced[(r.isin || r.name).toUpperCase()] = r; }
  // Pass 2 — retry the failures that HAVE a fallback exchange (NSE↔BSE).
  var retry = p1.failed.filter(function (t) { return t.fallback; });
  var p2 = fetchBatch_(retry, function (t) { return t.fallback; });
  for (var b = 0; b < p2.ok.length; b++) { var r2 = p2.ok[b]; priced[(r2.isin || r2.name).toUpperCase()] = r2; }
  // Anything still unfetched → a recorded miss.
  var stillFailed = p1.failed.filter(function (t) { return !t.fallback; }).concat(p2.failed);
  for (var c = 0; c < stillFailed.length; c++) {
    var f = stillFailed[c];
    misses.push({ isin: f.isin, name: f.name, reason: 'Yahoo had no price (' + f.primary + (f.fallback ? ' / ' + f.fallback : '') + ')' });
  }

  var pricedList = [];
  for (var k in priced) pricedList.push(priced[k]);
  var wr = writePrices_(pricedList);
  writeMisses_(misses);
  return { updated: wr.updated, total: wr.total, missed: misses.length, at: nowStamp_() };
}

// Union of currently-held scrips (qty > 0) across every portfolio's "Holding" tab.
function collectHeldScrips_() {
  var out = [], seen = {};
  for (var p = 0; p < PORTFOLIOS.length; p++) {
    try {
      var ss = SpreadsheetApp.openById(PORTFOLIOS[p].sheetId);
      var sh = ss.getSheetByName(CONFIG.HOLDING_TAB);
      if (!sh) continue;
      var vals = sh.getDataRange().getValues();
      if (vals.length < 2) continue;
      var hdr = vals[0].map(function (c) { return String(c == null ? '' : c).trim().toLowerCase(); });
      var nameIdx = indexOfAny_(hdr, ['company name', 'stock name', 'name']);
      var isinIdx = indexOfAny_(hdr, ['isin']);
      var qtyIdx = indexOfAny_(hdr, ['quantity', 'qty', 'number of shares']);
      if (nameIdx < 0) nameIdx = 0;
      for (var r = 1; r < vals.length; r++) {
        var row = vals[r];
        var name = String(row[nameIdx] == null ? '' : row[nameIdx]).trim();
        if (!name || name.toLowerCase() === 'total') continue;
        var qty = qtyIdx >= 0 ? parseFloat(String(row[qtyIdx]).replace(/,/g, '')) : 1;
        if (isNaN(qty) || qty <= 0) continue;   // skip sold-out / discrepancy negatives
        var isin = isinIdx >= 0 ? String(row[isinIdx] == null ? '' : row[isinIdx]).trim().toUpperCase() : '';
        var key = (isin || name).toUpperCase();
        if (seen[key]) continue; seen[key] = true;
        out.push({ isin: isin, name: name });
      }
    } catch (e) { Logger.log('Holding read failed for ' + PORTFOLIOS[p].code + ': ' + e); }
  }
  return out;
}

// Scrip Master → { byIsin: {ISIN: {nse,bse,name}}, byName: {normName: {...}} }.
function loadMasterSymbols_() {
  var m = { byIsin: {}, byName: {} };
  var sh = SpreadsheetApp.openById(CONFIG.SCRIP_MASTER_ID).getSheets()[0];
  var vals = sh.getDataRange().getValues();
  if (vals.length < 1) return m;
  var hdr = vals[0].map(function (c) { return String(c == null ? '' : c).trim().toLowerCase(); });
  var ci = { isin: 0, name: 1, bse: 2, nse: 3 };
  var nameSet = false;
  for (var j = 0; j < hdr.length; j++) {
    var h = hdr[j];
    if (/isin/.test(h)) ci.isin = j;
    else if (/bse/.test(h)) ci.bse = j;
    else if (/nse/.test(h)) ci.nse = j;
    else if (/tally|alias/.test(h)) { /* skip */ }
    else if (!nameSet && /name|security|company|scrip/.test(h)) { ci.name = j; nameSet = true; }
  }
  var hasHeader = hdr.some(function (h) { return /isin|name|security|company|bse|nse|scrip/.test(h); });
  for (var i = hasHeader ? 1 : 0; i < vals.length; i++) {
    var r = vals[i]; if (!r) continue;
    var isin = String(r[ci.isin] == null ? '' : r[ci.isin]).trim().toUpperCase();
    var name = String(r[ci.name] == null ? '' : r[ci.name]).trim();
    // Take the FIRST symbol token if a cell holds several (pipe / comma separated).
    var nse = firstToken_(r[ci.nse]);
    var bse = firstToken_(r[ci.bse]);
    if (!isin && !name) continue;
    var entry = { nse: nse, bse: bse, name: name };
    if (isin && !m.byIsin[isin]) m.byIsin[isin] = entry;
    var nk = normName_(name);
    if (nk && !m.byName[nk]) m.byName[nk] = entry;
  }
  return m;
}

// Held scrip → Yahoo tickers. NSE preferred ("<SYM>.NS"); BSE ("<CODE>.BO") is the fallback
// exchange (or the primary if there's no NSE symbol). { primary, fallback } — either may be ''.
function symbolsFor_(master, isin, name) {
  var e = (isin && master.byIsin[isin]) || master.byName[normName_(name)] || null;
  if (!e) return { primary: '', fallback: '' };
  var nse = e.nse ? e.nse.toUpperCase().replace(/\s+/g, '') + '.NS' : '';
  var bse = e.bse ? String(e.bse).replace(/\s+/g, '') + '.BO' : '';
  if (nse) return { primary: nse, fallback: bse };
  if (bse) return { primary: bse, fallback: '' };
  return { primary: '', fallback: '' };
}

// Fetch last prices from Yahoo's v8 chart endpoint in batches (fetchAll), using pick(t) to
// choose each target's symbol. Returns { ok:[{isin,name,price}], failed:[target,…] }.
function fetchBatch_(targets, pick) {
  var ok = [], failed = [];
  for (var start = 0; start < targets.length; start += CONFIG.BATCH) {
    var chunk = targets.slice(start, start + CONFIG.BATCH);
    var requests = chunk.map(function (t) {
      return {
        url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(pick(t)) + '?interval=1d&range=1d',
        muteHttpExceptions: true,
        followRedirects: true,
        headers: { 'User-Agent': 'Mozilla/5.0' },   // Yahoo 403s a blank UA
      };
    });
    var responses;
    try { responses = UrlFetchApp.fetchAll(requests); }
    catch (e) { Logger.log('fetchAll failed: ' + e); for (var z = 0; z < chunk.length; z++) failed.push(chunk[z]); continue; }
    for (var k = 0; k < responses.length; k++) {
      var price = parseChartPrice_(responses[k]);
      if (price > 0) ok.push({ isin: chunk[k].isin, name: chunk[k].name, price: price });
      else failed.push(chunk[k]);
    }
  }
  return { ok: ok, failed: failed };
}

function parseChartPrice_(resp) {
  try {
    if (resp.getResponseCode() !== 200) return 0;
    var j = JSON.parse(resp.getContentText());
    var meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
    if (!meta) return 0;
    var p = meta.regularMarketPrice;
    return (typeof p === 'number' && isFinite(p) && p > 0) ? p : 0;
  } catch (e) { return 0; }
}

// Merge into the "Prices" tab — latest wins per ISIN, others preserved, daily "Previous
// Price" roll. Byte-for-byte the same schema as the app's saveScripPrices().
function writePrices_(incoming) {
  var ss = SpreadsheetApp.openById(CONFIG.SCRIP_MASTER_ID);
  var sh = ss.getSheetByName(CONFIG.PRICES_TAB) || ss.insertSheet(CONFIG.PRICES_TAB);
  var existing = sh.getDataRange().getValues();
  var map = {};   // ISIN → {isin,name,price,updated,previousPrice}
  var startRow = (existing.length > 0 && /isin|name|price|updated/i.test(existing[0].join(','))) ? 1 : 0;
  for (var i = startRow; i < existing.length; i++) {
    var r = existing[i]; if (!r) continue;
    var isin = String(r[0] == null ? '' : r[0]).trim().toUpperCase();
    if (!isin) continue;
    map[isin] = {
      isin: isin, name: String(r[1] == null ? '' : r[1]).trim(),
      price: toNum_(r[2]), updated: String(r[3] == null ? '' : r[3]).trim(), previousPrice: toNum_(r[4]),
      source: String(r[5] == null ? '' : r[5]).trim().toLowerCase(),
    };
  }
  var stamp = nowStamp_();
  var today = stamp.split(',')[0].trim();
  var updated = 0;
  for (var n = 0; n < incoming.length; n++) {
    var s = incoming[n];
    var code = (s.isin || '').trim().toUpperCase();
    if (!code || !(s.price > 0)) continue;
    var prev = map[code];
    var previousPrice = prev ? prev.previousPrice : 0;
    // First refresh on a NEW calendar day rolls the last price into "Previous Price".
    if (prev && prev.price > 0 && prev.updated && prev.updated.split(',')[0].trim() !== today) previousPrice = prev.price;
    map[code] = { isin: code, name: s.name || (prev && prev.name) || '', price: s.price, updated: stamp, previousPrice: previousPrice, source: 'yahoo' };
    updated++;
  }
  var rows = [['ISIN', 'Name', 'Current Price', 'Updated', 'Previous Price', 'Source']];
  var keys = Object.keys(map).sort(function (a, b) { return (map[a].name || '').localeCompare(map[b].name || ''); });
  for (var q = 0; q < keys.length; q++) {
    var p = map[keys[q]];
    rows.push([p.isin, p.name, p.price, p.updated, p.previousPrice || '', p.source || '']);
  }
  sh.clearContents();
  sh.getRange(1, 1, rows.length, 6).setValues(rows);
  return { updated: updated, total: keys.length };
}

// Rewrite the "Price Status" tab with the scrips this run couldn't price (+ why). The app's
// "unpriced" button reads it. Cleared each run so it always reflects the latest attempt.
function writeMisses_(misses) {
  var ss = SpreadsheetApp.openById(CONFIG.SCRIP_MASTER_ID);
  var sh = ss.getSheetByName(CONFIG.STATUS_TAB) || ss.insertSheet(CONFIG.STATUS_TAB);
  var stamp = nowStamp_();
  var list = (misses || []).slice().sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
  var rows = [['ISIN', 'Name', 'Reason', 'Checked']];
  for (var i = 0; i < list.length; i++) rows.push([list[i].isin || '', list[i].name || '', list[i].reason || '', stamp]);
  sh.clearContents();
  sh.getRange(1, 1, rows.length, 4).setValues(rows);
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function isMarketHours_() {
  var tz = 'Asia/Kolkata';
  var day = parseInt(Utilities.formatDate(new Date(), tz, 'u'), 10);   // 1=Mon … 7=Sun
  if (day >= 6) return false;                                          // weekend
  var mins = parseInt(Utilities.formatDate(new Date(), tz, 'H'), 10) * 60 +
             parseInt(Utilities.formatDate(new Date(), tz, 'm'), 10);
  return mins >= CONFIG.MARKET_OPEN_MIN && mins <= CONFIG.MARKET_CLOSE_MIN;
}

function nowStamp_() {
  var tz = 'Asia/Kolkata';
  // Matches scripPrices.ts istStamp(): "17 Jul 2026, 01:31 pm".
  return Utilities.formatDate(new Date(), tz, 'dd MMM yyyy') + ', ' +
         Utilities.formatDate(new Date(), tz, 'hh:mm a').toLowerCase();
}

function firstToken_(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  return s.split(/[|,]/)[0].trim();
}

function normName_(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[-.,()'"]/g, ' ')
    .replace(/\b(limited|ltd|private|pvt|the|co)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function indexOfAny_(hdr, names) {
  for (var n = 0; n < names.length; n++) { var i = hdr.indexOf(names[n]); if (i >= 0) return i; }
  return -1;
}

function toNum_(v) { var n = parseFloat(String(v == null ? '' : v).replace(/,/g, '').trim()); return isNaN(n) ? 0 : n; }

// ════════════════════════════════════════════════════════════════════════════
// SETUP — run once from the editor.
// ════════════════════════════════════════════════════════════════════════════
function installPriceTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'scheduledUpdate') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('scheduledUpdate').timeBased().everyMinutes(30).create();
}
function removePriceTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'scheduledUpdate') ScriptApp.deleteTrigger(t); });
}
