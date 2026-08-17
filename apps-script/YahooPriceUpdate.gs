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
  ALERTS_TAB: 'Corp Action Alerts',   // detected splits/bonuses → read by the app's dashboard card
  ALERT_LOOKBACK_DAYS: 550,           // how far back to report an action (~18 months)
  HOLDING_TAB: 'Holding',
  BATCH: 40,                 // symbols per UrlFetchApp.fetchAll call
  MARKET_OPEN_MIN: 9 * 60,   // 09:00 IST
  MARKET_CLOSE_MIN: 16 * 60, // 16:00 IST (a little past close, to catch the settle)
  // Trigger cadence. Apps Script accepts ONLY 1, 5, 10, 15 or 30 here — anything else throws
  // when installPriceTrigger() calls everyMinutes(). Changing this does nothing until you re-run
  // installPriceTrigger(); the interval is baked into the trigger, not read at fire time.
  TRIGGER_MINUTES: 10,

  // ── Price history (for the AUM / Performance charts) ───────────────────────
  HISTORY_TAB: 'Price History',
  HISTORY_RANGE: '2y',        // full backfill depth — verified available even for thin BSE names
  HISTORY_TOPUP_RANGE: '1mo', // the daily pass re-fetches a month so it SELF-HEALS any gap
  HISTORY_BATCH: 15,          // smaller than BATCH: each response is ~500 candles, not 5
};

/**
 * Benchmarks stored alongside the scrips, as columns keyed with a leading '^'.
 * NIFTYSMLCAP250.NS is the real Yahoo symbol for "NIFTY SMLCAP 250" (verified: 500 daily
 * candles over 2y, 1,239 over 5y). Note '^CNXSC' is Smallcap *100* and returns a near-empty
 * series, so it is deliberately not used.
 */
var BENCHMARKS = [
  { key: '^NIFTYSMLCAP250', symbol: 'NIFTYSMLCAP250.NS', label: 'NIFTY Smallcap 250' },
  { key: '^NIFTY50',        symbol: '^NSEI',             label: 'NIFTY 50' },
];

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
  { code: '60072941', sheetId: '1LSfd2WVg0-Q_95lgsCZNI93ULZKqBi9PPdvT5Jo4qGs' },
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
  // /exec?scan=corp → run the split/bonus scan on demand and rewrite the "Corp Action Alerts"
  // tab, without opening the editor. Safe to hit repeatedly: writeCorpActionAlerts_ merges by
  // ISIN+ex-date and preserves the Status column, so dismissals survive.
  if (e && e.parameter && e.parameter.probe === 'nse') {
    return ContentService.createTextOutput(JSON.stringify(probeNse_())).setMimeType(ContentService.MimeType.JSON);
  }
  if (e && e.parameter && e.parameter.scan === 'corp') {
    var s;
    try { s = scanCorpActions(); s.ok = true; }
    catch (e2) { s = { ok: false, error: (e2 && e2.message) ? e2.message : String(e2) }; }
    return ContentService.createTextOutput(JSON.stringify(s)).setMimeType(ContentService.MimeType.JSON);
  }
  // /exec?hist=full  → full 2-year price-history rebuild (run this ONCE to seed the tab)
  // /exec?hist=topup → the daily incremental pass, on demand
  // A full backfill fetches ~500 candles per scrip, so it may exceed the 6-minute limit on a
  // large universe; re-running is safe and picks up where the tab left off for the columns that
  // already landed. Watch `priced` / `missed` / `dates` in the response.
  if (e && e.parameter && e.parameter.hist) {
    var h;
    try {
      h = e.parameter.hist === 'full' ? backfillPriceHistory() : updatePriceHistory();
    } catch (e3) { h = { ok: false, error: (e3 && e3.message) ? e3.message : String(e3) }; }
    return ContentService.createTextOutput(JSON.stringify(h)).setMimeType(ContentService.MimeType.JSON);
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
    // `isin` is carried on the entry so a name-only row (True Entry has no ISIN column) can be
    // canonicalised to its ISIN — the column key the price-history grid and the app agree on.
    var entry = { nse: nse, bse: bse, name: name, isin: isin };
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

// ════════════════════════════════════════════════════════════════════════════
// CORPORATE-ACTION SCAN — splits & bonuses on held scrips
// ════════════════════════════════════════════════════════════════════════════
//
// Yahoo's chart endpoint carries corporate actions under `events` when asked, and it represents
// an Indian BONUS as a split: a 1:1 bonus shows up as "2:1" (RELIANCE 28-Oct-2024), a face-value
// split as its own ratio (IRCTC 5:1, 28-Oct-2021). So one free parameter on an endpoint we
// already call covers both action types we care about.
//
// Two things drive the shape of this:
//   • Events are only returned for the REQUESTED RANGE, and the price passes use range=5d — far
//     too short. But events are independent of the candle interval, so range=2y&interval=1mo
//     gets two years of actions for ~24 candles per scrip instead of ~500.
//   • The feed HAS FALSE POSITIVES. Manbro shows 1:10 (2018) and 10:1 (2026) — an exact inverse
//     pair that looks like Yahoo correcting a bad entry rather than two real events. So this
//     writes ADVISORY rows for a human to confirm, and the Status column is preserved across
//     runs so a dismissal sticks.
//
// Deliberately NOT detected: rights issues, mergers, demergers. They have no price-ratio
// representation, so this feed can't see them; they stay manual.
// ═════════════════════════════════════════════════════════════════════════════
//  PRICE HISTORY — daily closes per scrip, so the app can value PAST positions
// ═════════════════════════════════════════════════════════════════════════════
//
// The app could previously chart only the COST of open positions through time: the Prices tab
// is a single snapshot, so no market-value history existed and the AUM chart's "market" line
// was limited to the handful of days someone had opened the Dashboard.
//
// This writes a wide grid — one row per trading date, one column per scrip (plus benchmark
// columns keyed with a leading '^') — from which the app recomputes NAV as
// Σ shares_held(date) × close(date), using the share counts its own FIFO replay already
// produces. Prices are the SOURCE OF TRUTH here, not the NAV: correcting a trade or recording
// a late split fixes the whole history automatically, with no rebuild.
//
// ⚠️ CLOSES ARE STORED UN-ADJUSTED (what the stock really traded at that day). Yahoo serves a
// SPLIT-ADJUSTED series, while the ledger holds the shares actually held on each date — so
// multiplying Yahoo's number by a historical share count under-reports every pre-split day by
// the split factor. parseHistory_ multiplies each bar by the product of every split factor
// with an ex-date AFTER it. Verified against Manbro 10:1 (25-Mar-2026), Time Technoplast's two
// consecutive 2:1s (15 and 23-Sep-2025, compounding to ×4 before both) and Reliance 2:1.

/** Full 2-year rebuild. Safe to re-run; it rewrites the tab. */
function backfillPriceHistory() { return priceHistoryLocked_(CONFIG.HISTORY_RANGE, true); }

/**
 * Daily top-up. Deliberately re-fetches a MONTH rather than a day, so a missed run, a late
 * correction or a Yahoo outage heals itself on the next pass instead of leaving a permanent
 * hole (the failure mode of the old append-only AUM log).
 */
function updatePriceHistory() { return priceHistoryLocked_(CONFIG.HISTORY_TOPUP_RANGE, false); }

function priceHistoryLocked_(range, full) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return { ok: false, busy: true };
  try {
    var t0 = new Date().getTime();
    var master = loadMasterSymbols_();
    var universe = collectHistoryUniverse_();

    // Resolve each scrip to a Yahoo symbol + a stable column key. The key is the ISIN whenever
    // one is known (directly or via the master), else the normalised name — matching how the
    // app keys its own positions, so the two sides line up without a second lookup table.
    // Dedupe on the FINAL column key, not on the universe key. collectHistoryUniverse_ can't do
    // this: it sees a Holding row keyed by ISIN and a True Entry row for the same security keyed
    // by name (True Entry has no ISIN column), and only the master lookup below collapses them.
    // Deduping late meant fetching ~500 candles twice for the same symbol — measured 551 fetches
    // collapsing into 328 columns on the first real backfill, i.e. 40% of the run wasted.
    var targets = [], noSymbol = 0, dupes = 0, seenKey = {};
    for (var i = 0; i < universe.length; i++) {
      var u = universe[i];
      var syms = symbolsFor_(master, u.isin, u.name);
      if (!syms.primary) { noSymbol++; continue; }
      var e = (u.isin && master.byIsin[u.isin]) || master.byName[normName_(u.name)] || null;
      var key = u.isin || (e && e.isin) || normName_(u.name);
      if (!key) continue;
      if (seenKey[key]) { dupes++; continue; }
      seenKey[key] = true;
      targets.push({ key: key, name: u.name, symbol: syms.primary, fallback: syms.fallback });
    }
    for (var b = 0; b < BENCHMARKS.length; b++) {
      targets.push({ key: BENCHMARKS[b].key, name: BENCHMARKS[b].label, symbol: BENCHMARKS[b].symbol, fallback: '' });
    }

    var res = fetchHistoryBatch_(targets, range);
    // One retry on the other exchange for anything the primary symbol couldn't serve.
    var retry = [];
    for (var f = 0; f < res.failed.length; f++) {
      var t = res.failed[f];
      if (t.fallback) retry.push({ key: t.key, name: t.name, symbol: t.fallback, fallback: '' });
    }
    var res2 = retry.length ? fetchHistoryBatch_(retry, range) : { ok: [], failed: [] };
    var got = res.ok.concat(res2.ok);

    // Pivot to { ymd: { key: close } }.
    var byDate = {}, cols = [], seenCol = {}, splitScrips = 0;
    for (var g = 0; g < got.length; g++) {
      var row = got[g];
      if (!seenCol[row.t.key]) { seenCol[row.t.key] = true; cols.push(row.t.key); }
      if (row.series.splits > 0) splitScrips++;
      for (var d = 0; d < row.series.dates.length; d++) {
        var ymd = row.series.dates[d];
        if (!byDate[ymd]) byDate[ymd] = {};
        byDate[ymd][row.t.key] = row.series.closes[d];
      }
    }

    var written = writePriceHistory_(cols, byDate, full);
    return {
      ok: true, full: !!full, range: range,
      universe: universe.length, targets: targets.length, noSymbol: noSymbol, dupes: dupes,
      priced: got.length, missed: res2.failed.length + (res.failed.length - retry.length),
      splitAdjusted: splitScrips,
      dates: written.dates, cols: written.cols,
      // Scrips we could not price at all, so the app can show WHICH names a NAV is missing
      // rather than quietly under-reporting. Capped so the JSON stays small.
      uncovered: uncoveredNames_(res, res2),
      ms: new Date().getTime() - t0, at: nowStamp_(),
    };
  } finally { lock.releaseLock(); }
}

/**
 * Every scrip the portfolios have EVER held — current holdings plus every name in True Entry
 * and Opening Holdings. collectHeldScrips_ deliberately skips qty <= 0, which is right for
 * pricing today but wrong here: a position sold last year still needs its prices, or the NAV
 * on the days it was held silently understates.
 */
function collectHistoryUniverse_() {
  var out = [], seen = {};
  var add = function (isin, name) {
    name = String(name == null ? '' : name).trim();
    isin = String(isin == null ? '' : isin).trim().toUpperCase();
    if (!name && !isin) return;
    if (name && /^(total|grand total)$/i.test(name)) return;
    var k = (isin || normName_(name));
    if (!k || seen[k]) return;
    seen[k] = true;
    out.push({ isin: isin, name: name });
  };

  for (var p = 0; p < PORTFOLIOS.length; p++) {
    var ss;
    try { ss = SpreadsheetApp.openById(PORTFOLIOS[p].sheetId); }
    catch (e) { Logger.log('history universe: cannot open ' + PORTFOLIOS[p].code + ': ' + e); continue; }

    // Holding tab — includes negative/zero rows here, unlike the pricing pass.
    try {
      var hs = ss.getSheetByName(CONFIG.HOLDING_TAB);
      if (hs) {
        var hv = hs.getDataRange().getValues();
        if (hv.length > 1) {
          var hh = hv[0].map(function (c) { return String(c == null ? '' : c).trim().toLowerCase(); });
          var hn = indexOfAny_(hh, ['company name', 'stock name', 'name']); if (hn < 0) hn = 0;
          var hi = indexOfAny_(hh, ['isin']);
          for (var r = 1; r < hv.length; r++) add(hi >= 0 ? hv[r][hi] : '', hv[r][hn]);
        }
      }
    } catch (e2) { Logger.log('history universe: Holding read failed for ' + PORTFOLIOS[p].code + ': ' + e2); }

    // True Entry — the trade ledger. No ISIN column by design, so names resolve via the master.
    try {
      var ts = ss.getSheetByName('True Entry');
      if (ts) {
        var tv = ts.getDataRange().getValues();
        if (tv.length > 1) {
          var th = tv[0].map(function (c) { return String(c == null ? '' : c).trim().toLowerCase(); });
          var tn = indexOfAny_(th, ['stock name', 'security name', 'name']); if (tn < 0) tn = 2;
          for (var r2 = 1; r2 < tv.length; r2++) add('', tv[r2][tn]);
        }
      }
    } catch (e3) { Logger.log('history universe: True Entry read failed for ' + PORTFOLIOS[p].code + ': ' + e3); }

    // Opening Holdings — the carried-in lots that predate the FY26 ledger.
    try {
      var os = ss.getSheetByName('Opening Holdings');
      if (os) {
        var ov = os.getDataRange().getValues();
        if (ov.length > 1) {
          var oh = ov[0].map(function (c) { return String(c == null ? '' : c).trim().toLowerCase(); });
          var on = indexOfAny_(oh, ['stock name', 'company name', 'name']); if (on < 0) on = 1;
          var oi = indexOfAny_(oh, ['isin']);
          for (var r3 = 1; r3 < ov.length; r3++) add(oi >= 0 ? ov[r3][oi] : '', ov[r3][on]);
        }
      }
    } catch (e4) { Logger.log('history universe: Opening Holdings read failed for ' + PORTFOLIOS[p].code + ': ' + e4); }
  }
  return out;
}

/**
 * Names of the scrips NO symbol could price, so the app can name what a NAV is missing instead
 * of quietly under-reporting it. Capped, to keep the /exec JSON small.
 */
function uncoveredNames_(res, res2) {
  var out = [], seen = {}, CAP = 40;
  var push = function (t) {
    if (!t || !t.name || seen[t.name]) return;
    seen[t.name] = true;
    if (out.length < CAP) out.push(t.name);
  };
  for (var i = 0; i < res.failed.length; i++) if (!res.failed[i].fallback) push(res.failed[i]);
  for (var j = 0; j < res2.failed.length; j++) push(res2.failed[j]);
  return out;
}

/** Batched daily-candle fetch. Smaller chunks than the price pass: ~500 candles per response. */
function fetchHistoryBatch_(targets, range) {
  var ok = [], failed = [];
  for (var start = 0; start < targets.length; start += CONFIG.HISTORY_BATCH) {
    var chunk = targets.slice(start, start + CONFIG.HISTORY_BATCH);
    var requests = chunk.map(function (t) {
      return {
        url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(t.symbol) +
             '?interval=1d&range=' + encodeURIComponent(range) + '&events=split',
        muteHttpExceptions: true,
        followRedirects: true,
        headers: { 'User-Agent': 'Mozilla/5.0' },   // Yahoo 403s a blank UA
      };
    });
    var responses;
    try { responses = UrlFetchApp.fetchAll(requests); }
    catch (e) {
      Logger.log('history fetchAll failed: ' + e);
      for (var z = 0; z < chunk.length; z++) failed.push(chunk[z]);
      continue;
    }
    for (var k = 0; k < responses.length; k++) {
      var h = parseHistory_(responses[k]);
      if (h && h.dates.length) ok.push({ t: chunk[k], series: h });
      else failed.push(chunk[k]);
    }
  }
  return { ok: ok, failed: failed };
}

/**
 * v8 chart response → { dates:[yyyy-MM-dd], closes:[true close], splits:count }.
 * Nulls (holidays, untraded sessions) are dropped rather than zero-filled, so the app can
 * forward-fill knowingly instead of charting a scrip crashing to ₹0.
 */
function parseHistory_(resp) {
  try {
    if (resp.getResponseCode() !== 200) return null;
    var j = JSON.parse(resp.getContentText());
    var res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res) return null;

    // Split events: Yahoo files an Indian BONUS as a split too (1:1 bonus → numerator 2).
    var splits = [];
    var ev = res.events && res.events.splits;
    if (ev) {
      for (var k in ev) {
        if (!ev.hasOwnProperty(k)) continue;
        var s = ev[k];
        var num = parseFloat(s.numerator), den = parseFloat(s.denominator);
        var factor = (num > 0 && den > 0) ? num / den : 1;
        var sec = Number(s.date);
        if (factor !== 1 && sec > 0) splits.push({ ts: sec, factor: factor });
      }
      splits.sort(function (a, b) { return a.ts - b.ts; });
    }

    var ts = res.timestamp || [];
    var raw = (res.indicators && res.indicators.quote && res.indicators.quote[0] &&
               res.indicators.quote[0].close) || [];
    var dates = [], closes = [];
    for (var i = 0; i < raw.length; i++) {
      var v = raw[i];
      if (!(typeof v === 'number' && isFinite(v) && v > 0)) continue;
      var sec2 = ts[i] || 0;
      if (!(sec2 > 0)) continue;
      // Un-adjust for every split whose ex-date is STRICTLY AFTER this bar. A bar dated on the
      // ex-date already reflects the split, so '>' (not '>=') is what keeps it at factor 1.
      var f = 1;
      for (var q = 0; q < splits.length; q++) if (splits[q].ts > sec2) f *= splits[q].factor;
      dates.push(ymdIST_(sec2));
      closes.push(Math.round(v * f * 10000) / 10000);
    }
    return { dates: dates, closes: closes, splits: splits.length };
  } catch (e) { return null; }
}

/**
 * Write the wide grid: Date | <key> | <key> | … Merges into whatever is already there when
 * `full` is false, so a top-up neither loses columns nor reorders them.
 */
function writePriceHistory_(newCols, byDate, full) {
  var ss = SpreadsheetApp.openById(CONFIG.SCRIP_MASTER_ID);
  var sh = ss.getSheetByName(CONFIG.HISTORY_TAB) || ss.insertSheet(CONFIG.HISTORY_TAB);

  var colIndex = {}, cols = [], rowByDate = {};

  if (!full) {
    var vals = sh.getDataRange().getValues();
    if (vals.length > 1) {
      var hdr = vals[0];
      for (var c = 1; c < hdr.length; c++) {
        var key = String(hdr[c] == null ? '' : hdr[c]).trim();
        if (!key || (key in colIndex)) continue;
        colIndex[key] = cols.length; cols.push(key);
      }
      for (var r = 1; r < vals.length; r++) {
        var ymd = ymdCell_(vals[r][0]);
        if (!ymd) continue;
        var arr = [];
        for (var c2 = 0; c2 < cols.length; c2++) {
          var v = vals[r][c2 + 1];
          arr.push((typeof v === 'number' && isFinite(v)) ? v : '');
        }
        rowByDate[ymd] = arr;
      }
    }
  }

  for (var n = 0; n < newCols.length; n++) {
    if (!(newCols[n] in colIndex)) { colIndex[newCols[n]] = cols.length; cols.push(newCols[n]); }
  }

  for (var ymd2 in byDate) {
    if (!byDate.hasOwnProperty(ymd2)) continue;
    var row = rowByDate[ymd2] || (rowByDate[ymd2] = []);
    var m = byDate[ymd2];
    for (var key2 in m) {
      if (!m.hasOwnProperty(key2)) continue;
      var ci = colIndex[key2];
      if (ci == null) continue;
      while (row.length <= ci) row.push('');
      row[ci] = m[key2];
    }
  }

  var dates = Object.keys(rowByDate).sort();
  var out = [['Date'].concat(cols)];
  for (var d2 = 0; d2 < dates.length; d2++) {
    var rw = rowByDate[dates[d2]];
    while (rw.length < cols.length) rw.push('');
    out.push([dates[d2]].concat(rw.slice(0, cols.length)));
  }
  if (out.length < 2) return { dates: 0, cols: cols.length };

  var needR = out.length, needC = out[0].length;
  if (sh.getMaxRows() < needR) sh.insertRowsAfter(sh.getMaxRows(), needR - sh.getMaxRows());
  if (sh.getMaxColumns() < needC) sh.insertColumnsAfter(sh.getMaxColumns(), needC - sh.getMaxColumns());

  // Pin the DATE column to TEXT *before* writing. setValues() coerces an ISO string into a real
  // Date cell, which then reads back locale-formatted and breaks the merge key on the next
  // top-up — the exact trap already hit by the Prices tab and the Corp Action Alerts tab.
  sh.getRange(1, 1, needR, 1).setNumberFormat('@');
  sh.getRange(1, 1, needR, needC).setValues(out);

  // Write-then-trim (never clearContents-then-write): a failure mid-run leaves the old grid
  // intact rather than an empty tab.
  if (sh.getMaxRows() > needR) sh.deleteRows(needR + 1, sh.getMaxRows() - needR);
  if (sh.getMaxColumns() > needC) sh.deleteColumns(needC + 1, sh.getMaxColumns() - needC);
  SpreadsheetApp.flush();
  return { dates: dates.length, cols: cols.length };
}

/** Daily top-up at ~19:30 IST, well after the close and after the price pass has settled. */
function installPriceHistoryTrigger() {
  removePriceHistoryTrigger();
  ScriptApp.newTrigger('updatePriceHistory').timeBased().atHour(19).nearMinute(30).everyDays(1)
    .inTimezone('Asia/Kolkata').create();
  Logger.log('Price history top-up trigger installed (daily ~19:30 IST).');
}
function removePriceHistoryTrigger() {
  var ts = ScriptApp.getProjectTriggers();
  for (var i = 0; i < ts.length; i++) {
    if (ts[i].getHandlerFunction() === 'updatePriceHistory') ScriptApp.deleteTrigger(ts[i]);
  }
}
function testPriceHistoryBackfill() { Logger.log(JSON.stringify(backfillPriceHistory(), null, 2)); }
function testPriceHistoryTopup() { Logger.log(JSON.stringify(updatePriceHistory(), null, 2)); }

function scanCorpActions() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) { Logger.log('Corp-action scan: another run holds the lock — skipped.'); return { busy: true }; }
  try { return scanCorpActionsLocked_(true); }
  finally { lock.releaseLock(); }
}

// DAILY pass — BSE only. BSE states the action type outright but returns ONLY today's ex-dates,
// so it has to be checked every day or a bonus falling on a skipped day is lost from the one
// source that can name it. One instant request, no Yahoo sweep.
function scanCorpActionsBse() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) { Logger.log('BSE corp-action pass: another run holds the lock — skipped.'); return { busy: true }; }
  try { return scanCorpActionsLocked_(false); }
  finally { lock.releaseLock(); }
}

function scanCorpActionsLocked_(includeYahoo) {
  var master = loadMasterSymbols_();
  var held = collectHeldScrips_();
  var targets = [], seen = {};
  for (var i = 0; i < held.length; i++) {
    var h = held[i];
    var key = (h.isin || h.name).toUpperCase();
    if (seen[key]) continue; seen[key] = true;
    if (isIgnored_(h.isin, h.name)) continue;
    var syms = symbolsFor_(master, h.isin, h.name);
    if (!syms.primary) continue;   // no symbol → nothing to ask Yahoo about
    targets.push({ isin: h.isin, name: h.name, sym: syms.primary });
  }

  var cutoff = Date.now() - CONFIG.ALERT_LOOKBACK_DAYS * 86400000;
  var found = [];

  // BSE first: it's one instant call and its `Purpose` is authoritative on bonus-vs-split, which
  // Yahoo can never be. Matched to holdings on scrip code / ticker / name — BSE returns no ISIN.
  var bseHits = 0;
  var bse = bseCorpActions_();
  if (bse) {
    for (var b = 0; b < bse.length; b++) {
      var row = bse[b];
      if (!row.kind || !row.exDate) continue;                 // dividends, AGMs → not ours
      var t = matchBseToTarget_(row, targets, master);
      if (!t) continue;                                        // not a scrip we hold
      found.push({ isin: t.isin, name: t.name, type: row.kind, ratio: '', exDate: row.exDate, source: 'bse' });
      bseHits++;
    }
  } else {
    Logger.log('BSE unreachable this run — Yahoo detection only.');
  }

  if (!includeYahoo) {
    var wrB = writeCorpActionAlerts_(found, false);
    Logger.log('BSE corp-action pass: ' + bseHits + ' held bonus/split today; ' + wrB.added + ' new, ' + wrB.updated + ' relabelled.');
    return { mode: 'bse', scanned: targets.length, found: found.length, added: wrB.added, updated: wrB.updated, at: nowStamp_() };
  }

  for (var start = 0; start < targets.length; start += CONFIG.BATCH) {
    var chunk = targets.slice(start, start + CONFIG.BATCH);
    var requests = chunk.map(function (t) {
      return {
        url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(t.sym) +
             '?interval=1mo&range=2y&events=split',
        muteHttpExceptions: true, followRedirects: true,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      };
    });
    var responses;
    try { responses = UrlFetchApp.fetchAll(requests); }
    catch (e) { Logger.log('Corp-action fetchAll failed: ' + e); continue; }
    for (var k = 0; k < responses.length; k++) {
      var evs = parseSplitEvents_(responses[k]);
      for (var e = 0; e < evs.length; e++) {
        if (evs[e].ts * 1000 < cutoff) continue;
        found.push({ isin: chunk[k].isin, name: chunk[k].name, type: '', ratio: evs[e].ratio, exDate: ymdIST_(evs[e].ts), source: 'yahoo' });
      }
    }
  }
  var wrote = writeCorpActionAlerts_(found, true);
  Logger.log('Corp-action scan: ' + found.length + ' event(s) across ' + targets.length + ' scrips; ' +
             wrote.added + ' new, ' + wrote.kept + ' carried over, ' + wrote.updated + ' relabelled by BSE.');
  return { scanned: targets.length, found: found.length, bseHits: bseHits,
           added: wrote.added, kept: wrote.kept, updated: wrote.updated, at: nowStamp_() };
}

// BSE identifies a company by numeric scrip code + BSE ticker, never ISIN — so map it onto a held
// target via the scrip master's BSE cell (which may hold "TICKER | CODE"), then the ticker, then a
// normalised name. Returns null when we don't hold it.
function matchBseToTarget_(row, targets, master) {
  var code = String(row.code || '').trim();
  var sec = String(row.name || '').trim().toUpperCase();
  var wantName = normName_(row.name);
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    var e = (t.isin && master.byIsin[t.isin]) || master.byName[normName_(t.name)] || null;
    if (e && e.bse) {
      var parts = String(e.bse).toUpperCase().split(/[|,]/);
      for (var q = 0; q < parts.length; q++) {
        var pv = parts[q].trim();
        if (!pv) continue;
        if (code && pv === code) return t;
        if (sec && pv === sec) return t;
      }
    }
    if (wantName && normName_(t.name) === wantName) return t;
  }
  return null;
}

// Pull the split/bonus events out of a chart response → [{ ts, ratio }].
function parseSplitEvents_(resp) {
  var out = [];
  try {
    if (resp.getResponseCode() !== 200) return out;
    var j = JSON.parse(resp.getContentText());
    var res = j && j.chart && j.chart.result && j.chart.result[0];
    var sp = res && res.events && res.events.splits;
    if (!sp) return out;
    for (var k in sp) {
      var s = sp[k]; if (!s) continue;
      var ts = num_(s.date); if (!(ts > 0)) continue;
      // Prefer the numerator/denominator pair; splitRatio is a display string ("2:1").
      var n = num_(s.numerator), d = num_(s.denominator);
      var ratio = (n > 0 && d > 0) ? (n + ':' + d) : String(s.splitRatio || '').trim();
      if (!ratio) continue;
      out.push({ ts: ts, ratio: ratio });
    }
  } catch (e) { /* malformed → no events */ }
  return out;
}

// Merge detected actions into the alerts tab, keyed ISIN+ex-date. Existing Status values are
// PRESERVED: a dismissal must survive every later scan, or a false positive nags forever.
function writeCorpActionAlerts_(found, fullSweep) {
  var ss = SpreadsheetApp.openById(CONFIG.SCRIP_MASTER_ID);
  var sh = ss.getSheetByName(CONFIG.ALERTS_TAB) || ss.insertSheet(CONFIG.ALERTS_TAB);
  var existing = sh.getDataRange().getValues();

  // UPSERT, not replace. The two sources run on different cadences (Yahoo weekly, BSE daily), so a
  // BSE-only pass must never delete the Yahoo rows it didn't look for. Keyed ISIN|ex-date.
  var byKey = {}, order = [];
  var hdr0 = existing.length ? existing[0].join(',') : '';
  var startRow = /isin|ex-date|ratio/i.test(hdr0) ? 1 : 0;
  // Tolerate the ORIGINAL 6-column layout (ISIN|Name|Ratio|Ex-Date|Detected|Status) as well as the
  // current 8-column one, so an existing tab migrates in place instead of being mangled.
  var legacy = startRow === 1 && !/type/i.test(hdr0);
  for (var i = startRow; i < existing.length; i++) {
    var r = existing[i]; if (!r) continue;
    var isin = String(r[0] == null ? '' : r[0]).trim().toUpperCase();
    var ex = ymdCell_(legacy ? r[3] : r[4]);
    if (!isin || !ex) continue;
    var k = isin + '|' + ex;
    if (byKey[k]) continue;
    byKey[k] = legacy
      ? { isin: isin, name: String(r[1] || '').trim(), type: '', ratio: String(r[2] || '').trim(),
          exDate: ex, source: 'yahoo', detected: String(r[4] || '').trim(), status: String(r[5] || '').trim() }
      : { isin: isin, name: String(r[1] || '').trim(), type: String(r[2] || '').trim(), ratio: String(r[3] || '').trim(),
          exDate: ex, source: String(r[5] || '').trim(), detected: String(r[6] || '').trim(), status: String(r[7] || '').trim() };
    order.push(k);
  }

  var stamp = nowStamp_();
  var addedN = 0, keptN = 0, updN = 0;
  for (var f = 0; f < found.length; f++) {
    var it = found[f];
    var key = (it.isin || '').toUpperCase() + '|' + it.exDate;
    var cur = byKey[key];
    if (!cur) {
      byKey[key] = { isin: it.isin, name: it.name, type: it.type || '', ratio: it.ratio || '',
                     exDate: it.exDate, source: it.source, detected: stamp, status: '' };
      order.push(key); addedN++;
      continue;
    }
    keptN++;
    // BSE names the type; Yahoo can only guess it. So a BSE hit RELABELS an existing Yahoo row,
    // but never the reverse — and Detected/Status are always preserved so a dismissal survives.
    if (it.source === 'bse' && it.type && cur.type !== it.type) { cur.type = it.type; cur.source = 'bse'; updN++; }
    else if (!cur.type && it.type) { cur.type = it.type; updN++; }
    if (!cur.ratio && it.ratio) cur.ratio = it.ratio;
    if (!cur.name && it.name) cur.name = it.name;
  }

  // Only a FULL sweep may prune: it alone knows the complete current picture. Drop anything past
  // the lookback window so the tab doesn't grow without bound.
  var cutoffIso = ymdIST_(Math.floor((Date.now() - CONFIG.ALERT_LOOKBACK_DAYS * 86400000) / 1000));
  var keys = [];
  for (var o = 0; o < order.length; o++) {
    var kk = order[o], v = byKey[kk];
    if (!v) continue;
    if (fullSweep && cutoffIso && v.exDate < cutoffIso) continue;
    keys.push(kk);
  }
  keys.sort(function (x, y) { return byKey[x].exDate < byKey[y].exDate ? 1 : byKey[x].exDate > byKey[y].exDate ? -1 : 0; });

  var rows = [['ISIN', 'Name', 'Type', 'Ratio', 'Ex-Date', 'Source', 'Detected', 'Status']];
  for (var z = 0; z < keys.length; z++) {
    var v2 = byKey[keys[z]];
    rows.push([v2.isin, v2.name, v2.type, v2.ratio, v2.exDate, v2.source, v2.detected, v2.status]);
  }
  // Ex-Date + Detected pinned to TEXT before writing: setValues parses a date-looking string just
  // as typing would, which turned "2026-03-25" into a Date cell and broke the merge key.
  sh.getRange(1, 5, Math.max(rows.length, 1), 3).setNumberFormat('@');
  sh.getRange(1, 1, rows.length, 8).setValues(rows);
  SpreadsheetApp.flush();
  var lastRow = sh.getLastRow(), lastCol = Math.max(8, sh.getLastColumn());
  if (lastRow > rows.length) sh.getRange(rows.length + 1, 1, lastRow - rows.length, lastCol).clearContent();
  return { added: addedN, kept: keptN, updated: updN };
}

// ── NSE corporate actions — the AUTHORITATIVE bonus-vs-split source ─────────────────────────
//
// Yahoo files a bonus and a split identically (a 1:1 bonus arrives as "2:1"), so it can never
// answer "which was it?". NSE's own feed states it outright:
//     "Bonus 1:10"
//     "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share"
// and carries the ISIN, so it joins straight onto our holdings.
//
// The catch: NSE rejects unprimed clients. You must GET an html page first, keep its cookies, and
// send them with the API call — and it is known to block datacenter IPs, which may well include
// Google's. So this is written to FAIL SOFT: nseCorpActions_ returns null when it can't get data,
// and the caller falls back to the Yahoo scan. Use /exec?probe=nse to find out which you get.
function nseCorpActions_(fromDDMMYYYY, toDDMMYYYY) {
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  var cookies = '';
  try {
    var prime = UrlFetchApp.fetch('https://www.nseindia.com/companies-listing/corporate-filings-actions', {
      muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    var all = prime.getAllHeaders();
    var sc = all['Set-Cookie'] || all['set-cookie'];
    if (sc) {
      var list = (Object.prototype.toString.call(sc) === '[object Array]') ? sc : [sc];
      var parts = [];
      for (var i = 0; i < list.length; i++) parts.push(String(list[i]).split(';')[0]);
      cookies = parts.join('; ');
    }
  } catch (e) { Logger.log('NSE prime failed: ' + e); return null; }
  if (!cookies) { Logger.log('NSE prime returned no cookies — treating as blocked.'); return null; }

  var url = 'https://www.nseindia.com/api/corporates-corporateActions?index=equities' +
            '&from_date=' + encodeURIComponent(fromDDMMYYYY) + '&to_date=' + encodeURIComponent(toDDMMYYYY);
  var resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true, followRedirects: true,
      headers: {
        'User-Agent': UA, 'Accept': 'application/json',
        'Referer': 'https://www.nseindia.com/companies-listing/corporate-filings-actions',
        'Cookie': cookies,
      },
    });
  } catch (e2) { Logger.log('NSE fetch failed: ' + e2); return null; }
  if (resp.getResponseCode() !== 200) { Logger.log('NSE HTTP ' + resp.getResponseCode()); return null; }
  var j; try { j = JSON.parse(resp.getContentText()); } catch (e3) { Logger.log('NSE body not JSON'); return null; }
  var rows = (Object.prototype.toString.call(j) === '[object Array]') ? j : (j && j.data) || null;
  if (!rows) return null;

  var out = [];
  for (var r = 0; r < rows.length; r++) {
    var it = rows[r] || {};
    var parsed = parseNseSubject_(it.subject);
    if (!parsed) continue;                     // dividends, AGMs, rights… not our two types
    var ex = ymdCell_(it.exDate);              // "02-Jan-2026" → ISO
    if (!ex) continue;
    out.push({
      isin: String(it.isin || '').trim().toUpperCase(),
      name: String(it.comp || it.symbol || '').trim(),
      type: parsed.type, ratio: parsed.ratio, factor: parsed.factor,
      exDate: ex, source: 'nse',
    });
  }
  return out;
}

// "Bonus 1:10" → 1 new share per 10 held (factor 1.1). "Face Value Split ... Rs 10/- ... Rs 2/-"
// → 1 share becomes 5 (factor 5). null for anything that isn't a bonus or a split.
function parseNseSubject_(subject) {
  var s = String(subject == null ? '' : subject).trim();
  if (!s) return null;
  var m = /bonus\s*(?:issue\s*)?[:\-]?\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/i.exec(s);
  if (m) {
    var a = parseFloat(m[1]), b = parseFloat(m[2]);
    if (a > 0 && b > 0) return { type: 'Bonus', ratio: a + ':' + b, factor: 1 + a / b };
    return null;
  }
  if (/split|sub[\s-]*division/i.test(s)) {
    // Pull both money figures: "From Rs 10/- Per Share To Rs 2/- Per Share" (also "Re 1/-").
    var f = /from\s*(?:rs|re)\.?\s*([\d.]+)/i.exec(s), t = /to\s*(?:rs|re)\.?\s*([\d.]+)/i.exec(s);
    if (f && t) {
      var fv = parseFloat(f[1]), tv = parseFloat(t[1]);
      if (fv > 0 && tv > 0 && fv > tv) return { type: 'Split', ratio: '1:' + (fv / tv), factor: fv / tv };
    }
    return null;   // a split we can't quantify is worse than no row
  }
  return null;
}

// /exec?probe=nse — is NSE reachable from Apps Script's IPs at all?
function probeNse_() {
  var to = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd-MM-yyyy');
  var from = Utilities.formatDate(new Date(Date.now() - 120 * 86400000), 'Asia/Kolkata', 'dd-MM-yyyy');
  var rows = nseCorpActions_(from, to);
  if (rows === null) return { ok: false, reachable: false, note: 'NSE blocked or unreachable from Apps Script — the Yahoo fallback stays in use.', from: from, to: to };
  var sample = rows.slice(0, 5).map(function (r) { return r.name + ' — ' + r.type + ' ' + r.ratio + ' (' + r.exDate + ')'; });
  return { ok: true, reachable: true, bonusOrSplitRows: rows.length, from: from, to: to, sample: sample };
}

// A sheet cell that should hold "yyyy-MM-dd" → that ISO string. Accepts a real Date (Sheets
// coerced it), an ISO string, or dd-mm-yyyy; '' when unreadable. Keeps the alert merge key stable
// no matter how the cell was stored.
function ymdCell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Kolkata', 'yyyy-MM-dd');
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  var p2 = function (x) { return x.length < 2 ? '0' + x : x; };
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return m[1] + '-' + p2(m[2]) + '-' + p2(m[3]);
  m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/.exec(s);
  if (m) return m[3] + '-' + p2(m[2]) + '-' + p2(m[1]);
  // "02-Jan-2026" — NSE's exDate format.
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{4})/.exec(s);
  if (m) {
    var MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    var mo = MON[m[2].toLowerCase()];
    if (mo) return m[3] + '-' + p2(String(mo)) + '-' + p2(m[1]);
  }
  var t = new Date(s);
  if (!isNaN(t.getTime()) && t.getFullYear() > 1990) return Utilities.formatDate(t, 'Asia/Kolkata', 'yyyy-MM-dd');
  return '';
}

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
// Weekly corporate-action scan. Separate from the price trigger on purpose: splits and bonuses
// are announced days ahead and the ex-date doesn't move, so checking 6× an hour would be waste.
function installCorpActionTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'scanCorpActions') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('scanCorpActions').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.SATURDAY).atHour(8).create();
}
// BSE pass runs DAILY — its feed only shows today's ex-dates, so a missed day is a lost label.
function installBseCorpActionTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'scanCorpActionsBse') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('scanCorpActionsBse').timeBased().everyDays(1).atHour(19).create();
}
function removeBseCorpActionTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'scanCorpActionsBse') ScriptApp.deleteTrigger(t); });
}
function testBseCorpActionPass() { Logger.log(JSON.stringify(scanCorpActionsBse(), null, 2)); }

function removeCorpActionTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'scanCorpActions') ScriptApp.deleteTrigger(t); });
}
// Run once from the editor to populate the tab immediately, without waiting for Saturday.
function testCorpActionScan() { Logger.log(JSON.stringify(scanCorpActions())); }

// Is NSE's corporate-actions API reachable from Apps Script's IPs? This is the one thing that
// can't be tested from a laptop — NSE blocks many datacenter ranges, and Google's may be among
// them. NOTE the name has no trailing underscore ON PURPOSE: Apps Script hides `name_` functions
// from the Run dropdown, which is why probeNse_ doesn't appear there.
function testNseProbe() {
  var r = probeNse_();
  Logger.log(JSON.stringify(r, null, 2));
  return r;
}

// BSE's corporate-actions feed. Also states the type outright ("Bonus issue", "Stock Split"),
// answers instantly from a laptop, and needs no cookie handshake — so it's the more likely of the
// two to survive Google's IPs. Its limitation is the window: it ignores every date parameter and
// returns only TODAY's ex-dates, so it can't backfill history — but scanned daily it would catch
// every future action WITH the correct type, which is the part Yahoo can't give us.
function bseCorpActions_() {
  var resp;
  try {
    resp = UrlFetchApp.fetch('https://api.bseindia.com/BseIndiaAPI/api/Corpaction/w?scripcode=', {
      muteHttpExceptions: true, followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
        'Origin': 'https://www.bseindia.com',
        'Referer': 'https://www.bseindia.com/',
      },
    });
  } catch (e) { Logger.log('BSE fetch failed: ' + e); return null; }
  if (resp.getResponseCode() !== 200) { Logger.log('BSE HTTP ' + resp.getResponseCode()); return null; }
  var j; try { j = JSON.parse(resp.getContentText()); } catch (e2) { Logger.log('BSE body not JSON'); return null; }
  if (Object.prototype.toString.call(j) !== '[object Array]') return null;
  var out = [];
  for (var i = 0; i < j.length; i++) {
    var it = j[i] || {};
    var p = String(it.Purpose || '');
    var kind = /bonus/i.test(p) ? 'Bonus' : /split|sub[\s-]*division/i.test(p) ? 'Split' : '';
    out.push({ code: String(it.Code || '').trim(), name: String(it.Security || '').trim(),
               purpose: p, kind: kind, exDate: ymdCell_(it.ExDate) });
  }
  return out;
}

function testBseProbe() {
  var rows = bseCorpActions_();
  var r;
  if (rows === null) r = { ok: false, reachable: false, note: 'BSE blocked or unreachable from Apps Script.' };
  else r = {
    ok: true, reachable: true, rowsToday: rows.length,
    bonusOrSplitToday: rows.filter(function (x) { return x.kind; }).length,
    purposes: rows.slice(0, 8).map(function (x) { return x.name + ' — ' + x.purpose + ' (' + x.exDate + ')'; }),
  };
  Logger.log(JSON.stringify(r, null, 2));
  return r;
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
