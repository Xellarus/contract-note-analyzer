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
 *   3b. FALLBACK: for scrips Yahoo can't price (stale/mislabelled ".BO", no symbol, etc.),
 *      queries TradingView's scanner API (one batch POST, precise, reachable from Apps Script
 *      — screener is IP-blocked from Google's servers). Stage A tries the code-based ticker;
 *      stage B resolves the rest by company NAME (symbol_search, exact-name gated) — that's how
 *      BSE-only scrips keyed by a numeric code get their real "BSE:SYM". Rows tagged source
 *      "tradingview"; a real previous close is derived from the day's absolute change.
 *   4. Merges {ISIN, Name, Current Price, Updated, Previous Price} into the "Prices" tab
 *      of the Scrip Master spreadsheet — same schema as saveScripPrices(). Both the price and
 *      the previous close come from the CANDLE SERIES, not the meta block — see parseChart_
 *      for why (Yahoo serves a stale meta on this endpoint; it had a quarter of all Yahoo-priced
 *      scrips wrong, some by 10x). A daily roll is kept only as a fallback.
 *
 * TWO ENTRY POINTS:
 *   • scheduledUpdate()  — set as a time trigger (installPriceTrigger). Skips outside
 *                          NSE hours to save quota.
 *   • doGet(e)           — deploy as a Web App ("Execute as: me", "Who has access: Anyone").
 *                          The app's "Refresh Prices" button GETs the /exec URL to force a
 *                          fresh pull on demand. Returns JSON {ok, updated, total}.
 *
 * CAVEAT: Neither Yahoo nor TradingView has an official API — both are unofficial, ~15-min
 * delayed, and can rate-limit or change format. When the TradingView fallback fails, those
 * scrips just stay on their last price and are recorded as misses. Scrips with NO NSE/BSE
 * symbol can't be looked up and are skipped. SpreadsheetApp is used (no advanced service).
 */

var CONFIG = {
  SCRIP_MASTER_ID: '1gLDfmeQe0wzfHWfaBReVk-6KsAvy1ZamfQAMrIVWsHg',   // holds the "Prices" tab
  PRICES_TAB: 'Prices',
  STATUS_TAB: 'Price Status',   // scrips this run couldn't price → read by the app's "unpriced" button
  HOLDING_TAB: 'Holding',
  BATCH: 40,                 // symbols per UrlFetchApp.fetchAll call
  MARKET_OPEN_MIN: 9 * 60,   // 09:00 IST
  MARKET_CLOSE_MIN: 16 * 60, // 16:00 IST (a little past close, to catch the settle)
  // Trigger cadence. Apps Script accepts ONLY 1, 5, 10, 15 or 30 here — anything else throws
  // when installPriceTrigger() calls everyMinutes(). Changing this does nothing until you re-run
  // installPriceTrigger(); the interval is baked into the trigger, not read at fire time.
  TRIGGER_MINUTES: 10,
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

// Scrips to skip entirely — ETFs / liquid funds that don't trade like equity and shouldn't be
// chased for a CMP. Matched by ISIN or by normalized name (normName_), so punctuation/suffix
// differences don't matter. Ignored scrips are neither fetched nor listed as "unpriced".
var IGNORE = [
  'GOLDBEES',
  'Nippon India ETF Nifty 1D Rate Liquid BeES - DAILY - IDCW - Payout',
];

// Scrips whose scrip-master symbol resolves on NEITHER feed. Two causes, same cure:
//   • BSE-only listings the master keys by numeric code — Yahoo maps "<code>.BO" to an
//     unrelated mutual fund, and TradingView has no "BSE:<code>" ticker at all.
//   • Companies renamed since the master was written — the feeds list the new name, so
//     tvResolveByName_'s exact-match guard (correctly) refuses to match the old one.
// `match` lists the ISIN and every name spelling the scrip is known by — each compared to the
// held scrip's ISIN or its normalized name (same rule as IGNORE). A hit on ANY of them applies
// the override, so an ISIN re-issue or a "(India)"/"& Allied"/apostrophe difference between the
// sheet and the exchange can't silently disable it. These beat the scrip master in symbolsFor_;
// the master is left alone so the app's screener.in links (which need the numeric BSE code) keep
// working. Anything still unresolved shows up by name in the Price Status miss list — add that
// exact spelling here.
var SYMBOL_OVERRIDES = [
  { bse: 'MANBRO',   nse: '', match: ['INE348N01042', 'Manbro Industries', 'KD Green Industries'] },
  { bse: 'JOSTS',    nse: '', match: ['INE636D01041', 'Josts Engineering', "Jost's Engineering",
                                      'Josts Engineering Company', "Jost's Engineering Company"] },
  { bse: 'SHRIGANG', nse: '', match: ['INE241V01018', 'Shri Gang Industries',
                                      'Shri Gang Industries and Allied Products',
                                      'Shri Gang Industries & Allied Products'] },
  { bse: 'HIGHENE',  nse: '', match: ['INE783E01023', 'High Energy Batteries',
                                      'High Energy Batteries (India)'] },
];

// ════════════════════════════════════════════════════════════════════════════
// ENTRY POINTS
// ════════════════════════════════════════════════════════════════════════════

// Time-trigger entry — skip outside market hours so we don't burn UrlFetch quota overnight.
function scheduledUpdate() {
  if (!isMarketHours_()) { Logger.log('Outside NSE hours — skipped.'); return; }
  var r = updatePrices();
  if (r.busy) { Logger.log('Scheduled price update: skipped, previous run still going.'); return; }
  Logger.log('Scheduled price update: ' + r.updated + '/' + r.total + ' priced' +
             (r.deferred ? ', ' + r.deferred + ' deferred' : '') + '.');
}

// Web-app entry — the app's "Refresh Prices" button GETs this. Always fetches (manual intent).
function doGet(e) {
  // Diagnostic route: /exec?probe=tv → run ONLY the TradingView reachability check (no full
  // update), so it can be tested straight from the URL. Remove once TradingView is decided.
  if (e && e.parameter && e.parameter.probe === 'tv') {
    return ContentService.createTextOutput(JSON.stringify(probeTradingView_())).setMimeType(ContentService.MimeType.JSON);
  }
  var out;
  // `session` + `staleYahoo` are the staleness gate's diagnostics: which trading session these
  // prices belong to, and how many scrips Yahoo served a PREVIOUS session for (those get
  // rerouted to TradingView). Both are the quickest way to confirm a deploy took effect.
  // `deferred`/`truncated` distinguish "asked, no price" from "never asked" so a budgeted or
  // rate-limited run doesn't read as a regression. `busy` means another run holds the lock.
  try {
    var r = updatePrices();
    out = r.busy
      ? { ok: true, busy: true, at: r.at }
      : { ok: true, updated: r.updated, total: r.total, missed: r.missed, deferred: r.deferred,
          truncated: r.truncated, session: r.session, staleYahoo: r.staleYahoo, at: r.at };
  }
  catch (err) { out = { ok: false, error: (err && err.message) ? err.message : String(err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════════════════════
// CORE
// ════════════════════════════════════════════════════════════════════════════

// Wall-clock budget for one run. Apps Script kills at 6 min (consumer) / 30 min (Workspace);
// stopping at 4.5 guarantees we always reach writePrices_ and persist what we have, because a
// limit kill discards the ENTIRE run — every price fetched, gone.
var RUN_BUDGET_MS = 4.5 * 60 * 1000;

// Serialised entry point. writePrices_ is a read-modify-write over the whole Prices tab, so two
// overlapping runs make the later writer clobber the earlier one wholesale. That is not
// hypothetical: the 30-minute trigger can fire mid-run, and a user whose browser appears stuck
// is very likely to hit "Refresh Prices" again while the first run is still executing.
function updatePrices() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('Another run holds the lock — skipped.');
    return { busy: true, updated: 0, total: 0, missed: 0, deferred: 0, session: '', staleYahoo: 0, at: nowStamp_() };
  }
  try { return updatePricesLocked_(); }
  finally { lock.releaseLock(); }
}

function updatePricesLocked_() {
  var deadline = Date.now() + RUN_BUDGET_MS;
  var master = loadMasterSymbols_();
  var held = collectHeldScrips_();          // [{ isin, name }] union across portfolios
  var targets = [];                          // [{ isin, name, primary, fallback }] — primary may be ''
  var misses = [];                           // [{ isin, name, reason }]
  var seen = {};
  for (var i = 0; i < held.length; i++) {
    var h = held[i];
    var key = (h.isin || h.name).toUpperCase();
    if (seen[key]) continue; seen[key] = true;
    if (isIgnored_(h.isin, h.name)) continue;   // ETFs/liquid funds — skip (no fetch, no miss)
    var syms = symbolsFor_(master, h.isin, h.name);
    // Keep even no-symbol scrips: TradingView's name-search can still find them.
    targets.push({ isin: h.isin, name: h.name, primary: syms.primary, fallback: syms.fallback });
  }

  var priced = {};   // key → { isin, name, price }
  // Yahoo runs only over scrips that HAVE an exchange symbol.
  var yahooTargets = targets.filter(function (t) { return t.primary; });
  // Pass 1 — primary exchange (NSE if present, else BSE).
  var p1 = fetchBatch_(yahooTargets, function (t) { return t.primary; }, '');
  for (var a = 0; a < p1.ok.length; a++) { var r = p1.ok[a]; priced[(r.isin || r.name).toUpperCase()] = r; }
  // Pass 2 — retry the failures that HAVE a fallback exchange (NSE↔BSE). Pass 1's session date
  // carries over: this batch is small and could be entirely stale, which would otherwise let it
  // calibrate "current" to a previous session and wave everything through.
  var retry = p1.failed.filter(function (t) { return t.fallback; });
  var p2 = fetchBatch_(retry, function (t) { return t.fallback; }, p1.session);
  for (var b = 0; b < p2.ok.length; b++) { var r2 = p2.ok[b]; priced[(r2.isin || r2.name).toUpperCase()] = r2; }
  // TradingView fallback over everything Yahoo couldn't price + the no-symbol scrips. Reachable
  // from Apps Script (screener isn't), precise, one batch POST for the code-based tickers, then
  // a NAME lookup (symbol_search, exact-name gated) for whatever's left — that's how BSE-only
  // scrips (keyed by a numeric code Yahoo/TradingView don't index) get resolved to their real
  // BSE symbol. prevClose is derived from the day's absolute change.
  var yahooFailed = p1.failed.filter(function (t) { return !t.fallback; }).concat(p2.failed);
  var noSymbol = targets.filter(function (t) { return !t.primary; });
  var tv = fetchTradingViewBatch_(yahooFailed.concat(noSymbol), deadline);
  for (var d = 0; d < tv.ok.length; d++) { var r3 = tv.ok[d]; priced[(r3.isin || r3.name).toUpperCase()] = r3; }
  // Whatever TradingView also couldn't price → a recorded miss (reason notes what we had).
  for (var c = 0; c < tv.failed.length; c++) {
    var f = tv.failed[c];
    var reason = f.primary
      ? 'Yahoo & TradingView had no price (' + f.primary + (f.fallback ? ' / ' + f.fallback : '') + ')'
      : 'No exchange symbol; TradingView name-search found no exact match';
    misses.push({ isin: f.isin, name: f.name, reason: reason });
  }
  // Not-asked is NOT the same as no-price. These keep their last published price and retry next
  // run; the reason must say so, because the two reasons above are instructions to a human to go
  // add a SYMBOL_OVERRIDES entry — and doing that for a scrip nobody looked up is worse than
  // leaving it alone.
  var deferredList = tv.deferred || [];
  for (var g = 0; g < deferredList.length; g++) {
    var q = deferredList[g];
    misses.push({ isin: q.isin, name: q.name, reason: 'Not attempted — TradingView refused the request or the run budget ran out; retrying next run' });
  }

  var pricedList = [];
  for (var k in priced) pricedList.push(priced[k]);
  var wr = writePrices_(pricedList, p1.session);
  writeMisses_(misses);
  return {
    updated: wr.updated, total: wr.total, missed: misses.length,
    // Split out so a budgeted run doesn't read as a regression: `missed` counts both, `deferred`
    // is the part that is expected to resolve itself on the next run.
    deferred: deferredList.length,
    truncated: deferredList.length > 0,
    session: p1.session,                       // the trading session these prices belong to
    staleYahoo: (p1.stale || 0) + (p2.stale || 0),   // Yahoo served a previous session → sent to TradingView
    at: nowStamp_(),
  };
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
  var e = symbolOverrideFor_(isin, name) ||
          (isin && master.byIsin[isin]) || master.byName[normName_(name)] || null;
  if (!e) return { primary: '', fallback: '' };
  var nse = e.nse ? e.nse.toUpperCase().replace(/\s+/g, '') + '.NS' : '';
  var bse = e.bse ? String(e.bse).replace(/\s+/g, '') + '.BO' : '';
  if (nse) return { primary: nse, fallback: bse };
  if (bse) return { primary: bse, fallback: '' };
  return { primary: '', fallback: '' };
}

// Fetch last prices from Yahoo's v8 chart endpoint in batches (fetchAll), using pick(t) to
// choose each target's symbol. Returns { ok:[{isin,name,price,prevClose}], failed:[target,…] }.
// `refSession` (optional) seeds the "newest session" reference so a later, smaller pass can't
// mistake its own all-stale batch for current. Returns { ok, failed, session, stale }.
function fetchBatch_(targets, pick, refSession) {
  var parsed = [], failed = [];
  for (var start = 0; start < targets.length; start += CONFIG.BATCH) {
    var chunk = targets.slice(start, start + CONFIG.BATCH);
    var requests = chunk.map(function (t) {
      return {
        // range=5d (not 1d): parseChart_ reads the CANDLE series because meta is stale, and it
        // needs >= 2 daily closes (latest + previous). 5 calendar days always spans >= 2 sessions.
        url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(pick(t)) + '?interval=1d&range=5d',
        muteHttpExceptions: true,
        followRedirects: true,
        headers: { 'User-Agent': 'Mozilla/5.0' },   // Yahoo 403s a blank UA
      };
    });
    var responses;
    try { responses = UrlFetchApp.fetchAll(requests); }
    catch (e) { Logger.log('fetchAll failed: ' + e); for (var z = 0; z < chunk.length; z++) failed.push(chunk[z]); continue; }
    for (var k = 0; k < responses.length; k++) {
      var pc = parseChart_(responses[k]);
      if (pc.price > 0) parsed.push({ t: chunk[k], pc: pc });
      else failed.push(chunk[k]);
    }
  }

  // ── Staleness gate ────────────────────────────────────────────────────────
  // The newest session date seen anywhere in this run IS the current session: liquid names
  // always carry today's bar, so the batch calibrates itself. No trading-holiday calendar and
  // no "is it past 15:30 yet" guesswork — on a holiday every symbol shares the same last
  // session and nothing is rejected. A response with NO date (meta-only fallback) is left
  // alone: we can't judge it, and dropping it would lose a price we do have.
  var session = refSession || '';
  for (var s1 = 0; s1 < parsed.length; s1++) {
    if (parsed[s1].pc.priceDate > session) session = parsed[s1].pc.priceDate;
  }
  var ok = [], stale = 0;
  for (var s2 = 0; s2 < parsed.length; s2++) {
    var p = parsed[s2];
    if (session && p.pc.priceDate && p.pc.priceDate < session) {
      // Yahoo has no bar for this scrip this session — hand it to TradingView instead of
      // publishing the previous close as if it were current.
      failed.push(p.t); stale++;
      continue;
    }
    ok.push({ isin: p.t.isin, name: p.t.name, price: p.pc.price, prevClose: p.pc.prevClose, priceDate: p.pc.priceDate });
  }
  if (stale) Logger.log('Yahoo returned a stale session for ' + stale + ' scrip(s); routed to TradingView.');
  return { ok: ok, failed: failed, session: session, stale: stale };
}

// Extract the last price AND the previous close from the v8 chart response.
//
// ⚠️ READ THE CANDLES, NOT THE META. On this (unauthenticated, crumb-less) endpoint Yahoo
// serves a STALE `meta` block while the candle series stays current: every symbol comes back
// with meta.regularMarketTime frozen at the same instant (23-Jul-2024) and a matching
// meta.regularMarketPrice / previousClose from that date. Measured 2026-08-06 over all 348
// priced scrips: 203 of 321 usable responses had meta.regularMarketPrice disagreeing with the
// latest real close by >1% — Accent Microcell meta ₹286.90 vs actual ₹511.50, ASM Technologies
// ₹1,494 vs ₹4,946, Suditi ₹13.11 vs ₹78.98. Spot-checked against an independent market
// database: the CANDLE close matched reality in 30/30 cases, meta in none of the mismatches.
// So price = last non-null close, prevClose = the one before it. Falls back to meta only when
// the series is too short (better than nothing, flagged by the comment above).
// Needs range >= 5d so there are at least two candles to work with.
// ⚠️ ALSO RETURNS THE CANDLE'S OWN SESSION DATE. Dropping nulls and taking the last surviving
// close silently yields a PREVIOUS session's price whenever Yahoo has no bar for today — and
// because that price is > 0, fetchBatch_ counted it as a success, so the TradingView fallback
// (which has the right number) never ran. Measured 2026-08-07 over the 180 Yahoo-priced held
// scrips: 22 were wrong by >2% and 19 of those were EXACTLY the previous close — Accent
// Microcell ₹514.45 (6-Aug close) while it actually traded to ₹543.90, +5.7%, that day.
// `priceDate` lets fetchBatch_ reject those so they fall through to TradingView.
// Returns { price, prevClose, priceDate } (0 / '' when absent or invalid).
function parseChart_(resp) {
  var none = { price: 0, prevClose: 0, priceDate: '' };
  try {
    if (resp.getResponseCode() !== 200) return none;
    var j = JSON.parse(resp.getContentText());
    var res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res) return none;

    // Compact the close series, dropping nulls (holidays / not-yet-traded sessions), keeping
    // each surviving close's timestamp alongside it.
    var raw = (res.indicators && res.indicators.quote && res.indicators.quote[0] &&
               res.indicators.quote[0].close) || [];
    var ts = res.timestamp || [];
    var closes = [], stamps = [];
    for (var i = 0; i < raw.length; i++) {
      var v = raw[i];
      if (typeof v === 'number' && isFinite(v) && v > 0) { closes.push(v); stamps.push(ts[i] || 0); }
    }

    var price = closes.length ? closes[closes.length - 1] : 0;
    var prevClose = closes.length > 1 ? closes[closes.length - 2] : 0;
    var priceDate = closes.length ? ymdIST_(stamps[stamps.length - 1]) : '';

    var meta = res.meta || {};
    if (!(price > 0)) price = num_(meta.regularMarketPrice);           // last resort
    if (!(prevClose > 0)) {                                            // last resort
      prevClose = num_(meta.previousClose);
      if (!(prevClose > 0)) prevClose = num_(meta.chartPreviousClose);
    }
    return { price: price > 0 ? price : 0, prevClose: prevClose > 0 ? prevClose : 0, priceDate: priceDate };
  } catch (e) { return none; }
}

// Epoch seconds → "yyyy-MM-dd" of the IST trading session. Yahoo stamps a daily bar at the
// session open (03:45 UTC = 09:15 IST), so the IST date IS the session date.
function ymdIST_(epochSec) {
  if (!(epochSec > 0)) return '';
  return Utilities.formatDate(new Date(epochSec * 1000), 'Asia/Kolkata', 'yyyy-MM-dd');
}

function num_(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

// ── TradingView scanner fallback ─────────────────────────────────────────────
// Runs over everything Yahoo can't price (+ no-symbol scrips). TradingView's scanner is a batch
// JSON endpoint reachable from Apps Script (screener is not), precise, and returns the day's
// absolute change so we derive a real previous close. Two stages:
//   A. code-based tickers — "NSE:SYM" (works) / "BSE:code" (usually doesn't; harmless to try).
//   B. NAME lookup for stage-A failures — symbol_search by company name, gated to an EXACT
//      normalized-name match, resolves BSE-only scrips to their real symbol (e.g. numeric
//      544458 → BSE:SHREEREF). The exact-name gate prevents pricing the WRONG company.

// "SURYAROSNI.NS" → "NSE:SURYAROSNI", "500325.BO" → "BSE:500325", else ''.
function tvTicker_(yahooSym) {
  var s = String(yahooSym == null ? '' : yahooSym).trim();
  if (/\.NS$/i.test(s)) return 'NSE:' + s.replace(/\.NS$/i, '');
  if (/\.BO$/i.test(s)) return 'BSE:' + s.replace(/\.BO$/i, '');
  return '';
}

function stripTags_(s) { return String(s == null ? '' : s).replace(/<[^>]+>/g, ''); }

// Resolve a company name to a TradingView ticker ("BSE:SHREEREF") via symbol_search. Matches
// ONLY on an exact normalized name (normName_) — never a fuzzy guess, so we can't stamp a
// similarly-named company's price onto a holding.
//
// Returns { ticker, blocked }. `blocked` means the LOOKUP itself failed (429 past retries,
// transport error, unparseable body) as opposed to "searched fine, no exact match". The caller
// needs that distinction: a blocked lookup means every subsequent one this run will very likely
// be blocked too, so it should stop rather than pay 1.5s of backoff per remaining scrip.
function tvResolveByName_(name) {
  var none = { ticker: '', blocked: false };
  var want = normName_(name);
  if (!want) return none;
  var url = 'https://symbol-search.tradingview.com/symbol_search/v3/?text=' + encodeURIComponent(name) +
            '&hl=1&exchange=&lang=en&search_type=stocks&domain=production&sort_by_country=IN';
  var resp = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) Utilities.sleep(1500);   // one backoff on 429
    try {
      resp = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true, followRedirects: true,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json',
                   'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
      });
    } catch (e) { Logger.log('TV symbol-search failed: ' + e); return { ticker: '', blocked: true }; }
    var code = resp.getResponseCode();
    if (code === 200) break;
    if (code === 429 && attempt === 0) continue;
    Logger.log('TV symbol-search HTTP ' + code); return { ticker: '', blocked: true };
  }
  if (resp.getResponseCode() !== 200) return { ticker: '', blocked: true };   // 429 on both attempts
  var j; try { j = JSON.parse(resp.getContentText()); } catch (e2) { return { ticker: '', blocked: true }; }
  var syms = j && j.symbols; if (!syms) return { ticker: '', blocked: true };
  for (var i = 0; i < syms.length; i++) {
    if (normName_(stripTags_(syms[i].description)) === want) {
      var sym = stripTags_(syms[i].symbol), exch = syms[i].exchange || syms[i].prefix || '';
      if (sym && exch) return { ticker: exch + ':' + sym, blocked: false };
    }
  }
  return none;   // searched fine, no exact-name match → a genuine, permanent miss
}

// Price the given targets via TradingView. Returns
// { ok:[{isin,name,price,prevClose,source:'tradingview'}], failed:[target,…], deferred:[target,…] }.
//
// `failed` means asked and answered: TradingView has nothing for this scrip, so it's a real miss
// worth acting on. `deferred` means NOT ASKED — the request was refused, or the run ran out of
// budget. The two must stay apart: the Price Status tab tells a human to hand-add a
// SYMBOL_OVERRIDES entry, and doing that for a scrip nobody actually looked up manufactures
// overrides for symbols that resolve perfectly well.
//
// `deadline` is an epoch-ms wall-clock budget (0/undefined = unlimited). Stage B is the only
// place in this file whose cost scales 1:1 with scrip count, so it's where the budget bites.
function fetchTradingViewBatch_(targets, deadline) {
  var ok = [], failed = [], deferred = [];
  if (!targets.length) return { ok: ok, failed: failed, deferred: deferred };

  // Stage A — code-based tickers (NSE:sym / BSE:code) in one batch.
  var candsByTarget = [], allTickers = [], seen = {};
  for (var i = 0; i < targets.length; i++) {
    var cands = [];
    var a = tvTicker_(targets[i].primary); if (a) cands.push(a);
    var b = tvTicker_(targets[i].fallback); if (b) cands.push(b);
    candsByTarget.push(cands);
    for (var c = 0; c < cands.length; c++) { if (!seen[cands[c]]) { seen[cands[c]] = true; allTickers.push(cands[c]); } }
  }
  var scanA = allTickers.length ? tvScan_(allTickers) : { map: {}, hardFail: {} };

  var stageB = [];   // stage-A failures (incl. no-symbol scrips) → resolve by name
  for (var j = 0; j < targets.length; j++) {
    var hit = null, unknown = false;
    for (var k = 0; k < candsByTarget[j].length; k++) {
      var cd = candsByTarget[j][k], h = scanA.map[cd];
      if (h && h.price > 0) { hit = h; break; }
      if (scanA.hardFail[cd]) unknown = true;
    }
    if (hit) { ok.push({ isin: targets[j].isin, name: targets[j].name, price: hit.price, prevClose: hit.prevClose, source: 'tradingview' }); continue; }
    // The scan never answered for this ticker — defer rather than spend a serial name lookup to
    // rediscover that TradingView is rate-limiting us. THIS is the line that keeps a single
    // refused POST from turning the whole held set into one-blocking-fetch-per-scrip.
    if (unknown) deferred.push(targets[j]);
    else stageB.push(targets[j]);
  }
  if (!stageB.length) return { ok: ok, failed: failed, deferred: deferred };

  // Stage B — resolve each remaining scrip to a ticker by NAME, then price them in one batch.
  var CAP = 50;              // new name resolutions per run; the rest roll to the next run
  var attempted = [];        // [{ t, ticker }] — actually looked up
  var rTickers = [], rSeen = {}, blocked = 0, stopped = -1;
  for (var m = 0; m < stageB.length; m++) {
    if (blocked >= 2 || attempted.length >= CAP || (deadline && Date.now() > deadline)) { stopped = m; break; }
    var r = tvResolveByName_(stageB[m].name);
    // Two consecutive refusals mean the rate limit won't clear inside this run; continuing costs
    // 1.5s of backoff per remaining scrip and resolves nothing.
    if (r.blocked) { blocked++; deferred.push(stageB[m]); continue; }
    blocked = 0;
    attempted.push({ t: stageB[m], ticker: r.ticker });
    if (r.ticker && !rSeen[r.ticker]) { rSeen[r.ticker] = true; rTickers.push(r.ticker); }
  }
  if (stopped >= 0) {
    Logger.log('Stage B stopped at ' + stopped + '/' + stageB.length + ' (cap/deadline/rate-limit)');
    for (var d = stopped; d < stageB.length; d++) deferred.push(stageB[d]);
  }

  var scanB = rTickers.length ? tvScan_(rTickers) : { map: {}, hardFail: {} };
  for (var n = 0; n < attempted.length; n++) {
    var tk = attempted[n].ticker, hit2 = tk ? scanB.map[tk] : null;
    if (hit2 && hit2.price > 0) ok.push({ isin: attempted[n].t.isin, name: attempted[n].t.name, price: hit2.price, prevClose: hit2.prevClose, source: 'tradingview' });
    else if (tk && scanB.hardFail[tk]) deferred.push(attempted[n].t);   // resolved, but pricing it was refused
    else failed.push(attempted[n].t);
  }
  return { ok: ok, failed: failed, deferred: deferred };
}

// POST tickers to TradingView's scanner (columns: last close + day's absolute change).
// Returns { map: {ticker: {price, prevClose}}, hardFail: {ticker: true} }.
//
// The hardFail set is the important half. A chunk whose REQUEST died (transport error, or
// rate-limited past tvFetch_'s retries) tells us nothing about its tickers — but an absent
// entry in `map` is indistinguishable from "TradingView has no data for this symbol". Callers
// that conflate the two promote the whole chunk into the serial name-resolution path, which is
// how one rate-limited POST turns a 40-second run into a 10-minute one. Keeping them separate
// lets the caller say "we don't know" and defer, instead of paying N blocking fetches to
// re-learn that TradingView is currently refusing us.
function tvScan_(tickers) {
  var out = {}, hardFail = {};
  var CH = 200;   // keep each POST modest
  for (var start = 0; start < tickers.length; start += CH) {
    var chunk = tickers.slice(start, start + CH);
    var payload = JSON.stringify({ symbols: { tickers: chunk, query: { types: [] } }, columns: ['close', 'change_abs'] });
    var resp = tvFetch_(payload);
    var j = null, bad = !resp;
    if (!bad) { try { j = JSON.parse(resp.getContentText()); } catch (e2) { bad = true; } }
    if (!bad && !(j && j.data)) bad = true;
    if (bad) {
      for (var b = 0; b < chunk.length; b++) hardFail[chunk[b]] = true;
      continue;
    }
    var data = j.data;
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      if (!row || !row.s || !row.d) continue;
      var close = num_(row.d[0]);
      if (!(close > 0)) continue;
      // Derive prevClose = close − change_abs, but ONLY when change_abs is genuinely present
      // (a missing value must NOT be treated as 0 → that would fake a 0% day).
      var prevClose = 0;
      if (typeof row.d[1] === 'number' && isFinite(row.d[1])) {
        var pc = close - row.d[1];
        if (pc > 0) prevClose = pc;
      }
      out[row.s] = { price: close, prevClose: prevClose };
    }
  }
  return { map: out, hardFail: hardFail };
}

// POST to TradingView's scanner with browser-like headers + a short backoff on HTTP 429
// (Apps Script shares Google IPs, so the endpoint occasionally rate-limits). Returns the
// 200 response, or null on a hard error / after exhausting the 429 retries.
function tvFetch_(payload) {
  var waits = [0, 1500, 4000];   // ms before each attempt (immediate, then back off on 429)
  for (var attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt] > 0) Utilities.sleep(waits[attempt]);
    var resp;
    try {
      resp = UrlFetchApp.fetch('https://scanner.tradingview.com/india/scan', {
        method: 'post', contentType: 'application/json', payload: payload,
        muteHttpExceptions: true, followRedirects: true,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json',
          'Origin': 'https://www.tradingview.com',
          'Referer': 'https://www.tradingview.com/',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch (e) { Logger.log('TradingView fetch failed: ' + e); return null; }
    var code = resp.getResponseCode();
    if (code === 200) return resp;
    if (code === 429) { Logger.log('TradingView HTTP 429 (attempt ' + (attempt + 1) + '/' + waits.length + ')'); continue; }
    Logger.log('TradingView HTTP ' + code); return null;   // other errors: don't hammer
  }
  return null;   // still 429 after all retries → those scrips stay misses this run
}

// Merge into the "Prices" tab — latest wins per ISIN, others preserved. "Previous Price" is
// Yahoo's official previous-day close (falls back to the daily roll if Yahoo omits it).
// Same schema as the app's saveScripPrices().
// `session` = the trading session this run's prices belong to ("yyyy-MM-dd"); used for any
// source that doesn't carry its own date (TradingView is live, so its close IS this session).
function writePrices_(incoming, session) {
  var ss = SpreadsheetApp.openById(CONFIG.SCRIP_MASTER_ID);
  var sh = ss.getSheetByName(CONFIG.PRICES_TAB) || ss.insertSheet(CONFIG.PRICES_TAB);
  var existing = sh.getDataRange().getValues();
  var map = {};   // ISIN → {isin,name,price,updated,previousPrice,source,priceDate}
  var startRow = (existing.length > 0 && /isin|name|price|updated/i.test(existing[0].join(','))) ? 1 : 0;
  for (var i = startRow; i < existing.length; i++) {
    var r = existing[i]; if (!r) continue;
    var isin = String(r[0] == null ? '' : r[0]).trim().toUpperCase();
    if (!isin) continue;
    map[isin] = {
      isin: isin, name: String(r[1] == null ? '' : r[1]).trim(),
      price: toNum_(r[2]), updated: String(r[3] == null ? '' : r[3]).trim(), previousPrice: toNum_(r[4]),
      source: String(r[5] == null ? '' : r[5]).trim().toLowerCase(),
      priceDate: String(r[6] == null ? '' : r[6]).trim(),
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
    // Prefer Yahoo's OFFICIAL previous-day close (authoritative + self-advancing → correct
    // daily % change from day one). Only if Yahoo didn't return one do we fall back to the
    // legacy roll: the first refresh on a NEW calendar day moves the last price into "Previous Price".
    if (s.prevClose > 0) previousPrice = s.prevClose;
    else if (prev && prev.price > 0 && prev.updated && prev.updated.split(',')[0].trim() !== today) previousPrice = prev.price;
    // The session the PRICE belongs to, which is not the same thing as when we fetched it —
    // that distinction is the whole point of this column. Yahoo carries its candle's own date;
    // TradingView is a live quote, so it belongs to this run's session.
    var priceDate = s.priceDate || session || '';
    map[code] = { isin: code, name: s.name || (prev && prev.name) || '', price: s.price, updated: stamp, previousPrice: previousPrice, source: s.source || 'yahoo', priceDate: priceDate };
    updated++;
  }
  var rows = [['ISIN', 'Name', 'Current Price', 'Updated', 'Previous Price', 'Source', 'Price Date']];
  var keys = Object.keys(map).sort(function (a, b) { return (map[a].name || '').localeCompare(map[b].name || ''); });
  for (var q = 0; q < keys.length; q++) {
    var p = map[keys[q]];
    rows.push([p.isin, p.name, p.price, p.updated, p.previousPrice || '', p.source || '', p.priceDate || '']);
  }
  // Write the new block FIRST, then clear only the surplus rows beneath it. clearContents()
  // before setValues leaves a window in which the tab is EMPTY — a throw or an execution-limit
  // kill landing there destroys all ~350 rows, including scrips this run never touched. flush()
  // pushes the values out before we start deleting anything.
  sh.getRange(1, 1, rows.length, 7).setValues(rows);
  SpreadsheetApp.flush();
  var lastRow = sh.getLastRow(), lastCol = Math.max(7, sh.getLastColumn());
  if (lastRow > rows.length) sh.getRange(rows.length + 1, 1, lastRow - rows.length, lastCol).clearContent();
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
  sh.getRange(1, 1, rows.length, 4).setValues(rows);   // write-then-trim, as in writePrices_
  SpreadsheetApp.flush();
  var lastRow = sh.getLastRow(), lastCol = Math.max(4, sh.getLastColumn());
  if (lastRow > rows.length) sh.getRange(rows.length + 1, 1, lastRow - rows.length, lastCol).clearContent();
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

// True if a held scrip is on the IGNORE list (ETFs/liquid funds), matched by ISIN or by
// normalized name so punctuation/suffixes don't matter.
function isIgnored_(isin, name) {
  var wantIsin = String(isin == null ? '' : isin).trim().toUpperCase();
  var wantName = normName_(name);
  for (var i = 0; i < IGNORE.length; i++) {
    var g = String(IGNORE[i] == null ? '' : IGNORE[i]).trim();
    if (!g) continue;
    if (wantIsin && g.toUpperCase() === wantIsin) return true;
    if (wantName && normName_(g) === wantName) return true;
  }
  return false;
}

// SYMBOL_OVERRIDES entry for a held scrip — any one of the entry's `match` values hitting the
// scrip's ISIN or its normalized name wins (same rule as isIgnored_). Returns a scrip-master-
// shaped { nse, bse } so symbolsFor_ can use it interchangeably with a real master entry.
// null when nothing is overridden.
function symbolOverrideFor_(isin, name) {
  var wantIsin = String(isin == null ? '' : isin).trim().toUpperCase();
  var wantName = normName_(name);
  for (var i = 0; i < SYMBOL_OVERRIDES.length; i++) {
    var o = SYMBOL_OVERRIDES[i];
    var keys = (o && o.match) || [];
    if (typeof keys === 'string') keys = [keys];
    for (var k = 0; k < keys.length; k++) {
      var g = String(keys[k] == null ? '' : keys[k]).trim();
      if (!g) continue;
      if ((wantIsin && g.toUpperCase() === wantIsin) || (wantName && normName_(g) === wantName)) {
        return { nse: o.nse || '', bse: o.bse || '', name: name };
      }
    }
  }
  return null;
}

function indexOfAny_(hdr, names) {
  for (var n = 0; n < names.length; n++) { var i = hdr.indexOf(names[n]); if (i >= 0) return i; }
  return -1;
}

function toNum_(v) { var n = parseFloat(String(v == null ? '' : v).replace(/,/g, '').trim()); return isNaN(n) ? 0 : n; }

// ════════════════════════════════════════════════════════════════════════════
// SETUP — run once from the editor.
// ════════════════════════════════════════════════════════════════════════════
// Re-run this after changing CONFIG.TRIGGER_MINUTES — it deletes the existing trigger and
// recreates it, which is the only way the new interval takes effect.
//
// Quota arithmetic at 10-minute cadence: the trigger fires 144×/day, but isMarketHours_ returns
// immediately outside 09:00–16:00 IST and at weekends, so only ~42 runs do real work. Each does
// roughly 180–190 UrlFetch calls (fetchAll bills every request in the batch individually), so
// ~7,800/day against a 20,000 consumer / 100,000 Workspace daily limit — comfortable.
// The binding constraint is TOTAL TRIGGER RUNTIME, not fetches: 42 runs × ~40s ≈ 28 min/day,
// against 90 min/day on a consumer account (6 h on Workspace). That headroom depends on runs
// staying fast — if they degraded to the full RUN_BUDGET_MS, 42 × 4.5 min would blow a consumer
// quota. Overlapping runs can't pile up: updatePrices takes a script lock and a late run that
// finds one held returns busy without doing any work.
function installPriceTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'scheduledUpdate') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('scheduledUpdate').timeBased().everyMinutes(CONFIG.TRIGGER_MINUTES).create();
}
function removePriceTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'scheduledUpdate') ScriptApp.deleteTrigger(t); });
}

// ── DIAGNOSTIC: is TradingView reachable from Apps Script's IPs? ──────────────
// Screener is blocked from Google's servers ("Address unavailable"); this checks whether
// TradingView's scanner API is too, BEFORE we build a fallback on it. Callable two ways:
//   • Editor: Run testTradingView_ and read the Execution log.
//   • URL:    open  …/exec?probe=tv  (returns the same result as JSON).
// Reads as { status: 200, sample: "{...json...}" } if reachable, or { error: "…Address
// unavailable…" } if blocked. Remove this + the doGet probe route once TradingView is decided.
function probeTradingView_() {
  var body = JSON.stringify({
    symbols: { tickers: ['NSE:SURYAROSNI', 'NSE:RELIANCE'], query: { types: [] } },
    columns: ['close', 'change'],
  });
  try {
    var resp = UrlFetchApp.fetch('https://scanner.tradingview.com/india/scan', {
      method: 'post',
      contentType: 'application/json',
      payload: body,
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return { status: resp.getResponseCode(), sample: resp.getContentText().substring(0, 400) };
  } catch (e) {
    return { error: String(e) };
  }
}

function testTradingView_() { Logger.log(JSON.stringify(probeTradingView_())); }
