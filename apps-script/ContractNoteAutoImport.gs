/**
 * ContractNoteAutoImport.gs — daily auto-import of Integrated (HTML) contract
 * notes forwarded to your Gmail, into the same portfolio sheets the app writes.
 *
 * WHAT IT DOES (once a day, via a time trigger):
 *   1. Scans a Gmail label (CONFIG.LABEL_INBOX) for un-processed messages.
 *   2. Reads each HTML contract-note attachment.
 *   3. Parses it with a faithful port of the app's Integrated parser
 *      (same trade extraction + charge allocation, incl. IPF/Demat).
 *   4. Routes the note to the right portfolio sheet by its UCC.
 *   5. De-dups against `True Entry` and appends new rows to `Raw Entry` + `True Entry`
 *      (header-aware, auto-adding IPF/Demat columns) — EXACTLY like the app.
 *   6. Emails you a run summary (imported / skipped / unmatched names).
 *   7. Labels the thread done so it's never re-imported.
 *
 * SCOPE: Integrated HTML notes only. Zerodha PDFs are NOT parsed (Apps Script has
 * no reliable PDF reader) — keep importing those manually in the app.
 *
 * SAFETY: CONFIG.DRY_RUN = true writes NOTHING. It parses and emails you exactly
 * what it WOULD import so you can reconcile against a manual import first. Flip to
 * false only once the dry-run numbers match. See apps-script/README.md.
 *
 * REQUIRES the "Google Sheets API" advanced service enabled (Services → +),
 * so writes use USER_ENTERED semantics identical to the web app.
 */

// ────────────────────────────────────────────────────────────────────────────
// CONFIG — edit these.
// ────────────────────────────────────────────────────────────────────────────
var CONFIG = {
  DRY_RUN: false,                        // true = parse + email only, write nothing
  LABEL_INBOX: 'Contract Note',          // Gmail label your forwarding filter applies (must match EXACTLY, incl. spaces)
  LABEL_DONE: 'Contract Note - Imported',// applied after a thread is processed
  SCRIP_MASTER_ID: '1gLDfmeQe0wzfHWfaBReVk-6KsAvy1ZamfQAMrIVWsHg',
  SUMMARY_TO: 'arash@saguncapital.com',  // where the run summary email goes
  MAX_THREADS: 50,                       // safety cap per run
  // The app's Import History reads this sheet/tab — logging here makes auto-imports
  // appear in it alongside manual ones (mirrors accessLog.ts).
  LOG_SPREADSHEET_ID: '1gWk96EGFun6tGiMbrt06_T2kCKF67D-Upg1cHfC9YxQ',
  LOG_TAB: 'Import Log',
};

// UCC → portfolio sheet (mirrors src/lib/portfolios.ts). Only Integrated accounts
// auto-import; the others are here so a mis-routed note is reported, not written.
var PORTFOLIOS = [
  { code: 'T059',   label: 'Taparia Holdings',            broker: 'integrated', sheetId: '1ZIW1LeWtHeePcg5C4T-cANz0Xww1ttqlCfxOsb3jgAw', ucc: ['T059'] },
  { code: 'S713',   label: 'Saket Agarwal (Integrated)',  broker: 'integrated', sheetId: '1Ns1QS91goIg7s4XyY_aO1D1RXRqysoMqGK8H9ybrYSM', ucc: ['S713'] },
  { code: 'C087',   label: 'Chaitanya Agarwal',           broker: 'integrated', sheetId: '1JGrCbQf2tgqRsZ6EQHDxkoxQtK1i8ytBznjAz1TGhBg', ucc: ['C087'] },
  { code: 'S1404',  label: 'Sagun Capital',               broker: 'integrated', sheetId: '1THFbOTkuhaM7fZz17adNFq2uhCLGEpGP_YF7AiKKyFY', ucc: ['S1404'] },
  { code: 'G058',   label: 'Gunjan Agarwal (Integrated)', broker: 'integrated', sheetId: '1oNy7HbQHu9NnCNql2hmkkkd2tiJcAiQ-eyFN9Xz9H6Y', ucc: ['G058'] },
  { code: 'OAEM94', label: 'Gunjan Agarwal (ShareIndia)', broker: 'shareindia', sheetId: '1GpjgUDDF5f8qdGwnjtnTxvj-hWGH4w2By7rZGw32fxE', ucc: ['OAEM94'] },
  { code: 'OADR97', label: 'Saket Agarwal (ShareIndia)',  broker: 'shareindia', sheetId: '15tpza8l4JtqZQQvrgSv6brEr1iAAQKdp5LPQGyu0lEw', ucc: ['OADR97'] },
  { code: 'CS1106', label: 'Shree Balaji Investments',    broker: 'shareindia', sheetId: '1qZL9Mhpwvm7jVuqmBQppRZ-9BW1V86haY3q0keOjDYY', ucc: ['CS1106'] },
  { code: 'OAEU09', label: 'Aditya Agarwal (ShareIndia)', broker: 'shareindia', sheetId: '1snmLk3-Y8VoopYSRjVWAMqkINf34daW_ZwA6-Gs9UZM', ucc: ['OAEU09'] },
  { code: 'NJW724', label: 'Aditya Agarwal (Zerodha)',    broker: 'zerodha',    sheetId: '1QoW51xsJfLtjkSGnEnaqsClgFd4AHJdbnVQKMLHhmYY', ucc: ['NJW724'] },
];

// ════════════════════════════════════════════════════════════════════════════
// ENTRY POINT — set this as the daily trigger (see installDailyTrigger).
// ════════════════════════════════════════════════════════════════════════════
function dailyImport() {
  var lines = [];
  var totals = { notes: 0, appended: 0, skipped: 0, unmatched: 0, errors: 0, nonIntegrated: 0 };
  var master = null;
  try { master = loadScripMaster_(); } catch (e) { lines.push('WARNING: could not load Scrip Master — names will stay as parsed. ' + e); }

  var inbox = GmailApp.getUserLabelByName(CONFIG.LABEL_INBOX);
  if (!inbox) {
    var miss = 'No Gmail label named "' + CONFIG.LABEL_INBOX + '" was found. Create it (and a filter that applies it to forwarded notes), or change CONFIG.LABEL_INBOX to match your label exactly — see apps-script/README.md.';
    Logger.log(miss);
    MailApp.sendEmail(CONFIG.SUMMARY_TO, 'Contract-note auto-import: label missing', miss);
    return;
  }
  var doneLabel = GmailApp.getUserLabelByName(CONFIG.LABEL_DONE) || GmailApp.createLabel(CONFIG.LABEL_DONE);

  var threads = inbox.getThreads(0, CONFIG.MAX_THREADS);
  for (var ti = 0; ti < threads.length; ti++) {
    var thread = threads[ti];
    var msgs = thread.getMessages();
    var threadHadNote = false;
    for (var mi = 0; mi < msgs.length; mi++) {
      var atts = msgs[mi].getAttachments();
      for (var ai = 0; ai < atts.length; ai++) {
        var att = atts[ai];
        var nm = (att.getName() || '').toLowerCase();
        var ct = (att.getContentType() || '').toLowerCase();
        var isHtml = ct.indexOf('html') >= 0 || nm.slice(-4) === '.htm' || nm.slice(-5) === '.html';
        if (!isHtml) continue;
        threadHadNote = true;
        totals.notes++;
        var label = att.getName();
        try {
          var html = att.getDataAsString();
          var res = processOneNote_(html, master, label);
          lines.push(res.line);
          totals.appended += res.appended;
          totals.skipped += res.skipped;
          totals.unmatched += res.unmatched.length;
          if (res.nonIntegrated) totals.nonIntegrated++;
          if (res.unmatched.length) lines.push('      unmatched: ' + res.unmatched.join(', '));
        } catch (e) {
          totals.errors++;
          lines.push('  ✗ ' + label + ' — ERROR: ' + (e && e.message ? e.message : e));
        }
      }
    }
    if (threadHadNote && !CONFIG.DRY_RUN) {
      thread.addLabel(doneLabel);
      thread.removeLabel(inbox);
    }
  }

  var header =
    (CONFIG.DRY_RUN ? '*** DRY RUN — nothing was written ***\n\n' : '') +
    'Notes seen: ' + totals.notes +
    '  |  rows appended: ' + totals.appended +
    '  |  duplicates skipped: ' + totals.skipped +
    '  |  unmatched names: ' + totals.unmatched +
    '  |  non-Integrated skipped: ' + totals.nonIntegrated +
    '  |  errors: ' + totals.errors + '\n\n';
  var body = header + (lines.length ? lines.join('\n') : 'No contract-note attachments found under the "' + CONFIG.LABEL_INBOX + '" label.');
  Logger.log(body);   // also shown in the Execution log, so you can see the result without relying on email
  MailApp.sendEmail(CONFIG.SUMMARY_TO,
    (CONFIG.DRY_RUN ? '[DRY RUN] ' : '') + 'Contract-note auto-import — ' + totals.appended + ' rows, ' + totals.notes + ' notes',
    body);
}

// Process a single note's HTML → parse, route, import (or dry-run report).
function processOneNote_(html, master, label) {
  var out = { line: '', appended: 0, skipped: 0, unmatched: [], nonIntegrated: false };
  if (classifyIntegrated_(html) !== 'integrated') {
    out.nonIntegrated = true;
    out.line = '  – ' + label + ' — not an Integrated HTML note (skipped).';
    return out;
  }
  var parsed = parseIntegratedNote_(html);
  if (!parsed || !parsed.trades.length) {
    out.line = '  – ' + label + ' — no trades parsed (skipped).';
    return out;
  }
  var port = portfolioByUcc_(parsed.ucc);
  if (!port) {
    out.line = '  ✗ ' + label + ' — UCC "' + (parsed.ucc || '?') + '" did not match any portfolio (skipped).';
    return out;
  }
  var imp = importTradesToSheet_(port.sheetId, parsed.trades, master);
  out.appended = imp.appended;
  out.skipped = imp.skipped;
  out.unmatched = imp.unmatched;
  out.line = '  ✓ ' + label + ' → ' + port.label + ' [' + port.code + ']  ' +
    parsed.trades.length + ' trade(s), ' + imp.appended + ' new, ' + imp.skipped + ' dupes' +
    (CONFIG.DRY_RUN ? '  (dry run — not written)' : '') +
    '  | date ' + (parsed.tradeDate || '?');
  // Record in the app's Import History (Import Log tab) so auto-imports show there too.
  if (!CONFIG.DRY_RUN) logImport_(label, 'Integrated', imp.importId, port.code, imp.appended);
  return out;
}

// Append one row to the app's Import Log tab: Date | Time | Contract Note Name |
// Broker | User | Import ID | Portfolio | Rows | Status (IST, matching
// accessLog.ts). Migrates an older 5-column header on the fly. Fire-and-forget.
function logImport_(noteName, broker, importId, portfolioCode, rows) {
  try {
    var id = CONFIG.LOG_SPREADSHEET_ID, tab = CONFIG.LOG_TAB, tz = 'Asia/Kolkata';
    var FULL = ['Date', 'Time', 'Contract Note Name', 'Broker', 'User', 'Import ID', 'Portfolio', 'Rows', 'Status'];
    var header = [];
    try {
      var hr = Sheets.Spreadsheets.Values.get(id, tab + "!A1:I1");
      header = (((hr && hr.values) || [])[0] || []).map(function (h) { return String(h == null ? '' : h); });
    } catch (e) { header = []; }
    var values = [];
    if (header.filter(function (h) { return h.trim() !== ''; }).length === 0) {
      values.push(FULL);
    } else {
      var missing = FULL.filter(function (h) {
        return !header.some(function (x) { return x.trim().toLowerCase() === h.toLowerCase(); });
      });
      if (missing.length) {
        Sheets.Spreadsheets.Values.update({ values: [header.concat(missing)] }, id, tab + "!A1", { valueInputOption: 'RAW' });
      }
    }
    var now = new Date();
    values.push([
      Utilities.formatDate(now, tz, 'dd MMM yyyy'),
      Utilities.formatDate(now, tz, 'hh:mm a'),
      noteName || '', broker || '', 'Auto-import (Apps Script)',
      importId || '', portfolioCode || '', (rows != null ? String(rows) : ''), ''
    ]);
    Sheets.Spreadsheets.Values.append({ values: values }, id, tab + "!A:I", { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' });
  } catch (e) { Logger.log('Import Log write failed (non-fatal): ' + e); }
}

// ════════════════════════════════════════════════════════════════════════════
// PARSE CORE — pure string functions (unit-testable in Node). Faithful port of
// src/lib/brokers/integrated.ts (DOM traversal replaced by a tolerant tokenizer).
// ════════════════════════════════════════════════════════════════════════════

// Parse an Integrated note → { ucc, tradeDate, summary, trades } (trades already
// charge-allocated), or null if nothing usable.
function parseIntegratedNote_(html) {
  var rows = extractRows_(html);
  var text = stripToText_(html);
  var summary = extractSummary_(rows);
  var rawTrades = extractTrades_(rows);
  if (!rawTrades.length) return null;
  var tradeDate = extractTradeDate_(text);
  var ucc = getUCC_(text);
  var fin = finalize_(summary, rawTrades, tradeDate);
  return { ucc: ucc, tradeDate: tradeDate, summary: fin.summary, trades: fin.trades };
}

function classifyIntegrated_(html) {
  var g = String(html).toLowerCase();
  return (g.indexOf('segment name') >= 0 ||
          g.indexOf('capital market segment of national clearing') >= 0 ||
          (g.indexOf('security/contract') >= 0 && g.indexOf('buy/sell') >= 0)) ? 'integrated' : 'standard';
}

// Tolerant HTML→rows tokenizer. Splits on <tr>/<thead>/<tbody> opens (broker HTML
// often omits </tr> and even puts header <td>s directly under <thead>), then on
// <td>/<th> opens. Each row is an array of cell texts — the shape the extractors
// used to read off the DOM. Robust to nested layout tables.
function extractRows_(html) {
  var rows = [];
  var chunks = String(html).split(/<tr[^>]*>|<thead[^>]*>|<tbody[^>]*>/i);
  for (var i = 1; i < chunks.length; i++) {
    var chunk = chunks[i];
    var cellParts = chunk.split(/<t[dh][^>]*>/i);
    var cells = [];
    for (var j = 1; j < cellParts.length; j++) {
      var cellHtml = cellParts[j].split(/<\/t[dh]>/i)[0];
      cells.push(cellText_(cellHtml));
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function stripToText_(html) {
  return decodeEntities_(String(html).replace(/<[^>]*>/g, ' ')).replace(/[ \s]+/g, ' ').trim();
}

function cellText_(h) {
  return decodeEntities_(String(h).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities_(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); });
}

function cleanTextLower_(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}

// parens = negative; strip commas + non-numeric (mirrors cleanNumValue).
function cleanNumValue_(s) {
  if (s === null || s === undefined) return 0;
  var str = String(s).trim();
  if (str.indexOf('(') >= 0 && str.indexOf(')') >= 0) str = '-' + str.replace(/[()]/g, '');
  var cleaned = str.replace(/,/g, '').replace(/[^\d.\-]/g, '');
  var v = parseFloat(cleaned);
  return isNaN(v) ? 0 : v;
}

// ── Obligation-detail summary (mirrors TmExtractSummaryIntegrated) ──
function extractSummary_(rows) {
  var g = { payinObligation: 0, stt: 0, taxableValue: 0, cgst: 0, sgst: 0, etc: 0, sebiFees: 0, clearingCharges: 0, stampDuty: 0, ipf: 0, dmat: 0 };
  for (var X = 0; X < rows.length; X++) {
    var cells = rows[X];
    var j = cleanTextLower_(cells.join(' '));
    if (j.indexOf('security name') >= 0 || (j.indexOf('quantity') >= 0 && j.indexOf('price') >= 0)) continue;
    if (j.indexOf('payin') >= 0 || j.indexOf('stt') >= 0 || (j.indexOf('securities') >= 0 && j.indexOf('tax') >= 0) ||
        (j.indexOf('exchange') >= 0 && j.indexOf('charge') >= 0) || j.indexOf('transaction charge') >= 0 ||
        j.indexOf('taxable value') >= 0 || j.indexOf('sebi') >= 0 || j.indexOf('stamp') >= 0 || j.indexOf('cgst') >= 0) {
      var A = rows[X + 1];
      if (!A) continue;
      for (var idx = 0; idx < cells.length; idx++) {
        var N = cleanTextLower_(cells[idx]);
        var O = A[idx] !== undefined ? cleanNumValue_(A[idx]) : 0;
        if (O === 0) continue;
        if (N.indexOf('payin') >= 0 || N.indexOf('payout') >= 0) g.payinObligation = O;
        else if (N.indexOf('securities transaction') >= 0 || N.indexOf('stt') >= 0) g.stt = O;
        else if (N.indexOf('taxable value') >= 0) g.taxableValue = O;
        else if (N.indexOf('cgst') >= 0) g.cgst = O;
        else if (N.indexOf('sgst') >= 0 || N.indexOf('utgst') >= 0) g.sgst = O;
        else if (N.indexOf('sebi') >= 0) g.sebiFees = O;
        else if (N.indexOf('stamp') >= 0) g.stampDuty = O;
        else if (N.indexOf('ipf') >= 0 || N.indexOf('investor') >= 0) g.ipf = O;
        else if (N.indexOf('demat') >= 0) g.dmat = O;
        else if (N.indexOf('clearing') >= 0 || N.indexOf('clg') >= 0) g.clearingCharges += O;
        else if ((N.indexOf('exchange') >= 0 || (N.indexOf('turnover') >= 0 && N.indexOf('charge') >= 0) || (N.indexOf('trans') >= 0 && N.indexOf('charge') >= 0)) &&
                 N.indexOf('clearing') < 0 && N.indexOf('sebi') < 0) g.etc = O;
      }
    }
  }
  return g;
}

// ── Annexure trades (mirrors xmExtractTradesIntegrated), single flattened pass ──
function extractTrades_(rows) {
  var g = [];
  var segments = [
    'capital market segment of national clearing ltd. (exchange : nse)',
    'capital market segment of national clearing ltd. (exchange : bse)'
  ];
  var F = '';
  var N = { security: -1, type: -1, qty: -1, price: -1, brokerage: -1, net: -1, netIsRate: true };
  var O = false;
  var blockStart = 0;
  for (var R = 0; R < rows.length; R++) {
    var cells = rows[R];
    var joined = cells.join(' ');
    var T = cleanTextLower_(joined);
    if (T.indexOf('segment name') >= 0) { F = T.replace('segment name', '').trim(); blockStart = g.length; continue; }
    if (T.indexOf('scrip total') >= 0) {
      var m = joined.match(/\b(IN[A-Z0-9]{10})\b/i);
      if (m) { var code = m[1].toUpperCase(); for (var k = blockStart; k < g.length; k++) if (!g[k].isin) g[k].isin = code; }
      blockStart = g.length;
      continue;
    }
    if (T.indexOf('security/contract') >= 0 && T.indexOf('quantity') >= 0) {
      for (var ci = 0; ci < cells.length; ci++) {
        var q = cleanTextLower_(cells[ci]);
        if (q.indexOf('security') >= 0 || q.indexOf('contract') >= 0) N.security = ci;
        else if (q.indexOf('buy') >= 0 && q.indexOf('sell') >= 0) N.type = ci;
        else if (q.indexOf('quantity') >= 0) N.qty = ci;
        else if (q.indexOf('gross rate') >= 0 || q.indexOf('trade price') >= 0) { if (N.price === -1) N.price = ci; }
        else if (q.indexOf('brokerage') >= 0) N.brokerage = ci;
        else if (q.indexOf('net rate') >= 0 || q.indexOf('net value') >= 0 || q.indexOf('net amount') >= 0 || q.indexOf('net total') >= 0) {
          N.net = ci; N.netIsRate = (q.indexOf('rate') >= 0 || q.indexOf('price') >= 0);
        }
      }
      if (N.security !== -1 && N.qty !== -1) O = true;
      continue;
    }
    var matchedSegment = false;
    for (var si = 0; si < segments.length; si++) if (F.indexOf(segments[si]) >= 0) matchedSegment = true;
    if (O && matchedSegment) {
      if (cells.length < 5) continue;
      var Braw = (cells[N.security] || '').trim();
      if (!Braw || cleanTextLower_(Braw).indexOf('total') >= 0) continue;
      var isinM = Braw.match(/(IN[A-Z0-9]{10})/i);
      var isin = isinM ? isinM[1].toUpperCase() : '';
      var B = Braw.replace(/\s*-?\s*\(?IN[A-Z0-9]{10}\)?/i, '').trim() || Braw;
      var typeStr = (N.type !== -1 && cells[N.type] !== undefined) ? cleanTextLower_(cells[N.type]) : '';
      var q2 = typeStr.indexOf('buy') >= 0 ? 'Buy' : (typeStr.indexOf('sell') >= 0 ? 'Sell' : null);
      var qtyVal = (N.qty !== -1 && cells[N.qty] !== undefined) ? cleanNumValue_(cells[N.qty]) : 0;
      if (q2 && qtyVal > 0) {
        var brokerageVal = (N.brokerage !== -1 && cells[N.brokerage] !== undefined) ? cleanNumValue_(cells[N.brokerage]) : 0;
        var priceVal = 0;
        if (N.net !== -1 && cells[N.net] !== undefined) {
          var Ft = Math.abs(cleanNumValue_(cells[N.net]));
          if (N.netIsRate) Ft = Ft * qtyVal;
          var Qt = brokerageVal * qtyVal;
          var zl = q2 === 'Buy' ? (Ft - Qt) : (Ft + Qt);
          priceVal = zl / qtyVal;
        } else if (N.price !== -1 && cells[N.price] !== undefined) {
          priceVal = cleanNumValue_(cells[N.price]);
        }
        g.push({ securityName: B, isin: isin, quantity: qtyVal, price: priceVal, brokeragePerShare: brokerageVal, type: q2 });
      }
    }
  }
  // Legend backstop: Equity-Segment summary rows are ISIN↔name pairs (cell0 = bare ISIN).
  var legend = {};
  for (var r2 = 0; r2 < rows.length; r2++) {
    var c = rows[r2];
    if (c.length < 2) continue;
    var c0 = (c[0] || '').trim();
    if (!/^IN[A-Z0-9]{10}$/i.test(c0)) continue;
    var nm = (c[1] || '').trim().toUpperCase();
    if (nm) legend[nm] = c0.toUpperCase();
  }
  for (var gi = 0; gi < g.length; gi++) {
    if (!g[gi].isin) { var hit = legend[(g[gi].securityName || '').trim().toUpperCase()]; if (hit) g[gi].isin = hit; }
  }
  return g;
}

function extractTradeDate_(text) {
  // Look for a date near "trade date"; else the first dd-mm-yyyy / yyyy-mm-dd.
  var re = /trade\s*date[^0-9]{0,20}((\d{2})[-\/](\d{2})[-\/](\d{4})|(\d{4})[-\/](\d{2})[-\/](\d{2}))/i;
  var m = String(text).match(re);
  if (m) return m[1];
  var any = String(text).match(/(\d{2}[-\/]\d{2}[-\/]\d{4})|(\d{4}[-\/]\d{2}[-\/]\d{2})/);
  return any ? any[0] : '';
}

// UCC from note text (port of getUCC's string path) + a fallback scan for any
// known portfolio UCC token.
function getUCC_(text) {
  var normalized = String(text).replace(/[ \s\t\n\r]+/g, ' ').trim();
  var blacklist = ['no','na','trade','date','contract','client','code','pan','number','name','limited','pvt','india','broker','member','sebi','bse','nse','invoice','tax','note','summary','page','for','the','of','and','with','from','oblig','charges','stt','gst','total','sgst','cgst','igst','isin','symbol','qty','quantity','price','net','gross','buy','sell','segment','fno','derivatives','sh','co','address','tel','fax','email','to'];
  var regexes = [
    /(?:ucc\s*of\s*client)\s*[:\-—|.\s]*([A-Za-z0-9]{3,15})/gi,
    /(?:client\s*code\s*\(?\s*ucc\s*\)?|client\s*code|client\s*id|ucc)\s*[:\-—|]*\s*([A-Za-z0-9]{3,15})/gi
  ];
  for (var i = 0; i < regexes.length; i++) {
    var mm;
    while ((mm = regexes[i].exec(normalized)) !== null) {
      var val = mm[1].trim().toUpperCase();
      var bad = false;
      for (var b = 0; b < blacklist.length; b++) { if (val.toLowerCase() === blacklist[b] || val.toLowerCase().indexOf(blacklist[b]) >= 0) { bad = true; break; } }
      if (val && !bad) return val;
    }
  }
  // Fallback: scan for any configured UCC as a whole token.
  var up = normalized.toUpperCase();
  for (var p = 0; p < PORTFOLIOS.length; p++) {
    for (var u = 0; u < PORTFOLIOS[p].ucc.length; u++) {
      var code = PORTFOLIOS[p].ucc[u].toUpperCase();
      if (new RegExp('\\b' + code + '\\b').test(up)) return code;
    }
  }
  return '';
}

// ── Charge allocation (verbatim port of finalizeContractNote) → { summary, trades } ──
function finalize_(summary, rawTrades, tradeDate) {
  var rt = function (n) { return Math.round((n + Number.EPSILON) * 100) / 100; };
  var exchangeNames = ['NSE', 'BSE', 'MCX', 'NCDEX'];
  var validated = rawTrades.filter(function (t) {
    if (!t.securityName || t.securityName.trim().length === 0) return false;
    if (exchangeNames.indexOf(t.securityName.trim().toUpperCase()) >= 0) return false;
    if (t.quantity >= 10000000) return false;
    return t.quantity > 0 && t.price > 0;
  });

  var groupMap = {};
  validated.forEach(function (t) {
    var name = t.securityName.trim();
    if (!groupMap[name]) groupMap[name] = {};
    if (!groupMap[name][t.type]) groupMap[name][t.type] = [];
    groupMap[name][t.type].push(t);
  });

  var tradesToProcess = [];
  Object.keys(groupMap).forEach(function (name) {
    Object.keys(groupMap[name]).forEach(function (type) {
      var items = groupMap[name][type];
      var distinctIsins = [];
      items.forEach(function (x) { var v = (x.isin || '').trim(); if (v && distinctIsins.indexOf(v) < 0) distinctIsins.push(v); });
      var buckets = [];
      if (distinctIsins.length <= 1) {
        buckets.push({ isin: distinctIsins[0] || '', rows: items });
      } else {
        distinctIsins.forEach(function (code) { buckets.push({ isin: code, rows: items.filter(function (x) { return (x.isin || '').trim() === code; }) }); });
        var noIsin = items.filter(function (x) { return !(x.isin || '').trim(); });
        if (noIsin.length) buckets.push({ isin: '', rows: noIsin });
      }
      buckets.forEach(function (bucket) {
        var rows = bucket.rows;
        var totalQty = rows.reduce(function (s, x) { return s + x.quantity; }, 0);
        var totalTurnover = rows.reduce(function (s, x) { return s + x.quantity * x.price; }, 0);
        var totalBrokerage = rows.reduce(function (s, x) { return s + x.quantity * (x.brokeragePerShare || 0); }, 0);
        tradesToProcess.push({
          securityName: name, isin: bucket.isin, type: type,
          quantity: totalQty,
          price: totalQty > 0 ? totalTurnover / totalQty : 0,
          brokeragePerShare: totalQty > 0 ? totalBrokerage / totalQty : 0,
          contextText: rows.map(function (x) { return x.contextText || ''; }).join(' ')
        });
      });
    });
  });

  var securityStats = {};
  tradesToProcess.forEach(function (t) {
    if (!securityStats[t.securityName]) securityStats[t.securityName] = { buyQty: 0, sellQty: 0 };
    if (t.type === 'Buy') securityStats[t.securityName].buyQty += t.quantity;
    else securityStats[t.securityName].sellQty += t.quantity;
  });

  var totalTurnover = tradesToProcess.reduce(function (s, t) { return s + t.quantity * t.price; }, 0);
  var totalBuyTurnover = tradesToProcess.reduce(function (s, t) { return t.type === 'Buy' ? s + t.quantity * t.price : s; }, 0);

  var STAMP_DELIVERY = 0.00015, STAMP_INTRADAY = 0.00003;
  var isIntradayOf = function (t) {
    var s = securityStats[t.securityName];
    var txt = ((t.contextText || '') + ' ' + t.securityName).toLowerCase();
    var hasIntra = txt.indexOf('intraday') >= 0 || txt.indexOf('intra-day') >= 0 || txt.indexOf('day trade') >= 0 || txt.indexOf('day-trade') >= 0 || /\bmis\b/i.test(txt);
    var hasDeliv = txt.indexOf('delivery') >= 0 || txt.indexOf('delv') >= 0 || /\bcnc\b/i.test(txt) || txt.indexOf('carry forward') >= 0 || txt.indexOf('carry-forward') >= 0;
    if (hasIntra && !hasDeliv) return true;
    if (hasDeliv && !hasIntra) return false;
    return (s.buyQty > 0 && s.sellQty > 0);
  };

  var deliveryBuyTurnover = tradesToProcess.reduce(function (s, t) { return (!isIntradayOf(t) && t.type === 'Buy') ? s + t.quantity * t.price : s; }, 0);
  var intradayBuyTurnover = tradesToProcess.reduce(function (s, t) { return (isIntradayOf(t) && t.type === 'Buy') ? s + t.quantity * t.price : s; }, 0);
  var theoreticalDelivery = deliveryBuyTurnover * STAMP_DELIVERY;
  var theoreticalIntraday = intradayBuyTurnover * STAMP_INTRADAY;
  var intradayFactor = 1;
  var summaryStampDuty = summary.stampDuty || 0;
  if (summaryStampDuty > 0) {
    var intradayBalance = Math.max(0, summaryStampDuty - theoreticalDelivery);
    if (theoreticalIntraday > 0) intradayFactor = intradayBalance / theoreticalIntraday;
  }
  var noTheoretical = theoreticalDelivery === 0 && theoreticalIntraday === 0 && summaryStampDuty > 0;

  var remainingAmount = { etc: summary.etc, sebiFees: summary.sebiFees, clearingCharges: summary.clearingCharges, ipf: summary.ipf, dmat: summary.dmat || 0 };
  var numTrades = tradesToProcess.length;

  // STT: allocate the note's PRINTED total (summary.stt) across the trades — delivery at the
  // exact statutory 0.1% per side, the leftover intraday pool pro-rata by squared-off turnover
  // and split 50/50 between the buy and sell legs. Faithful port of src/lib/brokers/stt.ts
  // allocateStt (incl. the implausibly-low-total safeguard). Replaces the old per-security
  // rate model so an auto-imported note gets the SAME STT as one imported through the app.
  var sttArr = allocateStt_(
    tradesToProcess.map(function (t) {
      return {
        securityName: t.securityName,
        type: t.type,
        quantity: t.quantity,
        price: t.price,
        exempt: String(t.securityName || '').toLowerCase().indexOf('liquidbees') >= 0
      };
    }),
    summary.stt || 0
  );

  var trades = tradesToProcess.map(function (t, idx) {
    var isLast = idx === numTrades - 1;
    var s = securityStats[t.securityName];
    var isIntraday = isIntradayOf(t);
    var grossTotal = rt(t.quantity * t.price);
    var ratio = totalTurnover > 0 ? grossTotal / totalTurnover : 0;
    var brokerage = rt(t.quantity * (t.brokeragePerShare || 0));

    // STT pre-allocated across all trades from the note's printed total (see allocateStt_).
    var stt = sttArr[idx];

    var allocate = function (totalVal, key, r) {
      if (isLast) return rt(remainingAmount[key]);
      var val = rt(totalVal * r);
      remainingAmount[key] -= val;
      return val;
    };
    var etc = allocate(summary.etc, 'etc', ratio);
    var sebiFees = allocate(summary.sebiFees, 'sebiFees', ratio);
    var clearingCharges = allocate(summary.clearingCharges, 'clearingCharges', ratio);
    var ipf = allocate(summary.ipf, 'ipf', ratio);
    var dmat = allocate(summary.dmat || 0, 'dmat', ratio);

    var stampDuty = 0;
    if (t.type === 'Buy') {
      if (noTheoretical && totalBuyTurnover > 0) stampDuty = rt((grossTotal / totalBuyTurnover) * summaryStampDuty);
      else if (!isIntraday) stampDuty = rt(grossTotal * STAMP_DELIVERY);
      else stampDuty = rt(grossTotal * STAMP_INTRADAY * intradayFactor);
    }

    var gst = rt((brokerage + etc + sebiFees + clearingCharges) * 0.18);
    var totalExclSTT = brokerage + etc + sebiFees + clearingCharges + stampDuty + ipf + dmat + gst;
    var totalInclSTT = totalExclSTT + stt;

    return {
      tradeDate: tradeDate,
      securityName: t.securityName,
      isin: t.isin || '',
      transactionType: t.type,
      quantity: t.quantity,
      avgPrice: t.price,
      turnover: grossTotal,
      tradeType: isIntraday ? 'Intraday' : 'Delivery',
      brokerage: brokerage,
      stt: stt,
      etc: etc,
      sebiFees: sebiFees,
      clearingCharges: clearingCharges,
      stampDuty: stampDuty,
      ipf: ipf,
      dmat: dmat,
      cgst: rt(gst / 2),
      sgst: rt(gst / 2),
      igst: 0,
      gst: gst,
      totalExpensesInclSTT: rt(totalInclSTT),
      totalExpensesExclSTT: rt(totalExclSTT)
    };
  });

  return { summary: summary, trades: trades };
}

// ── STT allocation (verbatim ES5 port of src/lib/brokers/stt.ts allocateStt) ──
// Anchors on the note's PRINTED total STT: matched min(buyQty,sellQty) per security is
// intraday, the excess is delivery. Delivery legs get the exact 0.1% per side; the intraday
// POOL = total − Σ(delivery STT) is spread across intraday securities pro-rata by squared-off
// turnover and split 50/50 buy/sell. Σ(per-trade) === total to the paise. ETF/liquid-bees
// (exempt) stay 0. Fallbacks: no/implausibly-low total → statutory rates; pure-delivery →
// whole total by turnover; delivery > total → scale delivery down. Aligned by input index.
function allocateStt_(trades, noteTotalStt) {
  var n = trades.length;
  var out = [];
  for (var z = 0; z < n; z++) out.push(0);
  if (n === 0) return out;

  var DELIVERY_RATE = 0.001;        // 0.1% each side
  var INTRADAY_SELL_RATE = 0.00025; // fallback only (no printed total)
  var paise = function (x) { return Math.round((x + Number.EPSILON) * 100) / 100; };
  var rowTo = function (i) { return Math.max(0, trades[i].quantity) * Math.max(0, trades[i].price); };

  var spread = function (idxs, amount) {
    if (amount === 0 || idxs.length === 0) return;
    var tot = 0, a;
    for (a = 0; a < idxs.length; a++) tot += rowTo(idxs[a]);
    if (tot <= 0) return;
    for (a = 0; a < idxs.length; a++) out[idxs[a]] += amount * (rowTo(idxs[a]) / tot);
  };

  var tieOut = function (target) {
    var r = out.map(paise), sum = 0, i;
    for (i = 0; i < r.length; i++) sum += r[i];
    var drift = paise(target - sum);
    if (Math.abs(drift) >= 0.01) {
      var mi = -1, mv = -Infinity;
      for (i = 0; i < r.length; i++) { if (r[i] > mv) { mv = r[i]; mi = i; } }
      if (mi >= 0) r[mi] = paise(r[mi] + drift);
    }
    return r;
  };

  // Per-security tallies (equity only; exempt rows never carry STT).
  var secs = {}, order = [];
  for (var i = 0; i < n; i++) {
    var t = trades[i];
    if (t.exempt) continue;
    var name = t.securityName;
    var s = secs[name];
    if (!s) { s = { buyQty: 0, sellQty: 0, buyTo: 0, sellTo: 0, buyIdx: [], sellIdx: [] }; secs[name] = s; order.push(name); }
    var g = rowTo(i);
    if (t.type === 'Buy') { s.buyQty += t.quantity; s.buyTo += g; s.buyIdx.push(i); }
    else { s.sellQty += t.quantity; s.sellTo += g; s.sellIdx.push(i); }
  }

  // Split each security into matched (intraday) / excess (delivery) turnover.
  var splits = [], totalDeliveryTo = 0, totalIntradayTo = 0;
  for (var oi = 0; oi < order.length; oi++) {
    var sec = secs[order[oi]];
    var matched = Math.min(sec.buyQty, sec.sellQty);
    var fB = sec.buyQty > 0 ? matched / sec.buyQty : 0;
    var fS = sec.sellQty > 0 ? matched / sec.sellQty : 0;
    var matchBuyTo = sec.buyTo * fB;
    var matchSellTo = sec.sellTo * fS;
    var delBuyTo = sec.buyTo - matchBuyTo;
    var delSellTo = sec.sellTo - matchSellTo;
    splits.push({ s: sec, matchBuyTo: matchBuyTo, matchSellTo: matchSellTo, delBuyTo: delBuyTo, delSellTo: delSellTo });
    totalDeliveryTo += delBuyTo + delSellTo;
    totalIntradayTo += matchBuyTo + matchSellTo;
  }

  // A genuine note's printed total can't be below the delivery minimum (0.1% per side); an
  // implausibly-low total is a mis-read → don't anchor on it, fall through to statutory rates.
  var statutoryDeliveryStt = totalDeliveryTo * DELIVERY_RATE;
  var hasTotal = noteTotalStt > 0.005 && noteTotalStt >= statutoryDeliveryStt * 0.5;
  var hasIntraday = totalIntradayTo > 0;
  var hasDelivery = totalDeliveryTo > 0;

  if (!hasIntraday && !hasDelivery) return out.map(paise);   // all-exempt / empty

  // Fallback: no usable printed total → statutory rates.
  if (!hasTotal) {
    for (var p = 0; p < splits.length; p++) {
      var sp = splits[p];
      spread(sp.s.buyIdx, sp.delBuyTo * DELIVERY_RATE);
      spread(sp.s.sellIdx, sp.delSellTo * DELIVERY_RATE);
      var intra = sp.matchSellTo * INTRADAY_SELL_RATE;   // real intraday STT is sell-side only…
      spread(sp.s.buyIdx, intra / 2);                    // …but booked half on each leg
      spread(sp.s.sellIdx, intra / 2);
    }
    return out.map(paise);
  }

  // Pure-delivery note → the whole total is delivery, spread by delivery turnover.
  if (!hasIntraday) {
    for (var q = 0; q < splits.length; q++) {
      var sp2 = splits[q];
      spread(sp2.s.buyIdx, noteTotalStt * (sp2.delBuyTo / totalDeliveryTo));
      spread(sp2.s.sellIdx, noteTotalStt * (sp2.delSellTo / totalDeliveryTo));
    }
    return tieOut(noteTotalStt);
  }

  var deliveryStt = hasDelivery ? totalDeliveryTo * DELIVERY_RATE : 0;
  var pool = noteTotalStt - deliveryStt;

  // Delivery alone exceeds the printed total (shouldn't happen) → scale delivery down, no intraday.
  if (pool < 0) {
    var scale = deliveryStt > 0 ? noteTotalStt / deliveryStt : 0;
    for (var r0 = 0; r0 < splits.length; r0++) {
      var sp3 = splits[r0];
      spread(sp3.s.buyIdx, sp3.delBuyTo * DELIVERY_RATE * scale);
      spread(sp3.s.sellIdx, sp3.delSellTo * DELIVERY_RATE * scale);
    }
    return tieOut(noteTotalStt);
  }

  // Delivery at the exact rate …
  for (var d = 0; d < splits.length; d++) {
    var sp4 = splits[d];
    spread(sp4.s.buyIdx, sp4.delBuyTo * DELIVERY_RATE);
    spread(sp4.s.sellIdx, sp4.delSellTo * DELIVERY_RATE);
  }
  // … then the leftover pool across intraday securities (pro-rata by squared-off turnover),
  // split 50/50 between each security's buy and sell legs.
  for (var e = 0; e < splits.length; e++) {
    var sp5 = splits[e];
    var w = sp5.matchBuyTo + sp5.matchSellTo;
    if (w <= 0) continue;
    var share = pool * (w / totalIntradayTo);
    spread(sp5.s.buyIdx, share / 2);
    spread(sp5.s.sellIdx, share / 2);
  }
  return tieOut(noteTotalStt);
}

// ════════════════════════════════════════════════════════════════════════════
// SCRIP MASTER (name resolution) — exact ISIN, then exact normalized name/alias.
// ════════════════════════════════════════════════════════════════════════════
function normName_(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[-.,()'"]/g, ' ')
    .replace(/\b(limited|ltd|private|pvt|the|co)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function loadScripMaster_() {
  var res = Sheets.Spreadsheets.Values.get(CONFIG.SCRIP_MASTER_ID, "A1:F50000");
  var rows = (res && res.values) || [];
  var master = { byIsin: {}, byAliasNorm: {} };
  if (!rows.length) return master;
  var header = rows[0].map(function (h) { return String(h || '').toLowerCase(); });
  var ci = { isin: 0, name: 1, bse: 2, nse: 3, alias: 4 };
  var nameSet = false;
  header.forEach(function (h, idx) {
    if (/isin/.test(h)) ci.isin = idx;
    else if (/alias/.test(h)) ci.alias = idx;
    else if (/bse/.test(h)) ci.bse = idx;
    else if (/nse/.test(h)) ci.nse = idx;
    else if (/tally/.test(h)) { /* ignore user's Tally ledger column */ }
    else if (!nameSet && /name|security|company|scrip/.test(h)) { ci.name = idx; nameSet = true; }
  });
  var hasHeader = header.some(function (h) { return /isin|name|security|company|alias|scrip|bse|nse|code/.test(h); });
  for (var i = hasHeader ? 1 : 0; i < rows.length; i++) {
    var r = rows[i]; if (!r) continue;
    var isin = String(r[ci.isin] || '').trim().toUpperCase();
    var name = String(r[ci.name] || '').trim();
    if (!isin && !name) continue;
    var key = isin || normName_(name);
    var entry = { isin: isin, canonicalName: name || isin, key: key };
    if (isin && !master.byIsin[isin]) master.byIsin[isin] = entry;
    var aliases = [name, String(r[ci.bse] || ''), String(r[ci.nse] || '')]
      .concat(String(r[ci.alias] || '').split('|'));
    aliases.forEach(function (a) {
      var nk = normName_(a);
      // A canonical-name slot can't be displaced by another entry's mere alias.
      if (!nk) return;
      var cur = master.byAliasNorm[nk];
      if (cur && cur !== entry && normName_(cur.canonicalName) === nk && normName_(entry.canonicalName) !== nk) return;
      master.byAliasNorm[nk] = entry;
    });
  }
  return master;
}

function resolveEntry_(master, isin, name) {
  if (!master) return null;
  var code = String(isin || '').trim().toUpperCase();
  if (code && master.byIsin[code]) return master.byIsin[code];
  var nk = normName_(name);
  if (nk && master.byAliasNorm[nk]) return master.byAliasNorm[nk];
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// SHEET WRITE — header-aware append + dedup, mirroring App.tsx importToSheets.
// ════════════════════════════════════════════════════════════════════════════
function importTradesToSheet_(spreadsheetId, trades, master) {
  var isIntegrated = true;
  var fmt = function (v) { return Number(v || 0).toFixed(2); };

  var unmatched = [];
  var displayName = function (isin, name) {
    var e = resolveEntry_(master, isin, name);
    if (e) return e.canonicalName;
    if (unmatched.indexOf(name) < 0) unmatched.push(name);
    return name;
  };
  var dedupKey = function (isin, name) {
    var code = String(isin || '').trim().toUpperCase();
    var e = resolveEntry_(master, code, name);
    return e ? e.key : (code || normName_(name));
  };

  var records = trades.map(function (t) {
    var bps = t.quantity > 0 ? fmt(t.brokerage / t.quantity) : '0.00';
    var withIncl = t.transactionType === 'Buy' ? t.turnover + t.totalExpensesInclSTT : t.turnover - t.totalExpensesInclSTT;
    var withExcl = t.transactionType === 'Buy' ? t.turnover + t.totalExpensesExclSTT : t.turnover - t.totalExpensesExclSTT;
    return {
      date: toIsoDate_(t.tradeDate || ''),
      name: displayName(t.isin || '', t.securityName || ''),
      txType: t.transactionType || '',
      qty: t.quantity,
      price: fmt(t.avgPrice),
      turnover: fmt(t.turnover),
      brokeragePerShare: bps,
      brokerage: fmt(t.brokerage),
      stt: fmt(t.stt),
      exchangeCharges: fmt(t.etc),
      sebiFees: fmt(t.sebiFees),
      ipf: fmt(t.ipf),
      dmat: fmt(t.dmat || 0),
      gst: fmt(t.gst),
      stampDuty: fmt(t.stampDuty),
      totalExpInclSTT: fmt(t.totalExpensesInclSTT),
      totalExpExclSTT: fmt(t.totalExpensesExclSTT),
      totalWithExpInclSTT: fmt(withIncl),
      totalWithExpExclSTT: fmt(withExcl),
      tradeClass: t.tradeType || '',
      _isin: t.isin || ''
    };
  });

  var defaultHeader = [
    'Trade Date', 'Stock Name', 'Transaction Type', 'Number of Shares', 'Avg Price',
    'Total Amount (Turnover)', 'Brokerage Per Share', 'Total Brokerage', 'STT',
    'Exchange Turnover Charges', 'SEBI Turnover Fees', 'IPF Charges', 'Demat Charges', 'Total GST',
    'Stamp Duty', 'Total Expenses (incl STT)', 'Total Expenses (excl STT)',
    'Total Amount with Expense (Incl STT)', 'Total Amount with Expense (Excl STT)', 'Trade Class',
    'Import ID'   // stamped so a note can be rewound (deleted) from Import History
  ];

  // Dedup vs existing True Entry (multiset of stable keys).
  var remaining = {};
  try {
    var ex = Sheets.Spreadsheets.Values.get(spreadsheetId, "True Entry!A:T");
    var exRows = (ex && ex.values) || [];
    if (exRows.length > 1) {
      var eh = exRows[0].map(function (h) { return String(h || '').trim(); });
      var col = function (n, fb) { var i = eh.indexOf(n); return i >= 0 ? i : fb; };
      var di = col('Trade Date', 0), ii = col('ISIN', -1), ni = col('Stock Name', 1),
          tyi = col('Transaction Type', 2), qi = col('Number of Shares', 3), pi = col('Avg Price', 4);
      for (var i = 1; i < exRows.length; i++) {
        var r = exRows[i]; if (!r || !r.length) continue;
        var key = rowKey_(r[di], r[tyi], dedupKey(ii >= 0 ? r[ii] : '', r[ni]), r[qi], r[pi]);
        remaining[key] = (remaining[key] || 0) + 1;
      }
    }
  } catch (e) { /* no dedup if unreadable — better a dup than a miss */ }

  var newRecords = [];
  records.forEach(function (rec) {
    var key = rowKey_(rec.date, rec.txType, dedupKey(rec._isin, rec.name), rec.qty, rec.price);
    if ((remaining[key] || 0) > 0) remaining[key] -= 1;
    else newRecords.push(rec);
  });
  var skipped = records.length - newRecords.length;

  // One id per (written) note, stamped on every row so it can be rewound later.
  var batchId = '';
  if (!CONFIG.DRY_RUN && newRecords.length) {
    batchId = 'IMP-' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMddHHmmss') + '-' + String(Utilities.getUuid()).slice(0, 5);
    newRecords.forEach(function (r) { r.importId = batchId; });
    ['Raw Entry', 'True Entry'].forEach(function (tab) {
      var header = [];
      try {
        var hr = Sheets.Spreadsheets.Values.get(spreadsheetId, tab + "!A1:Z1");
        header = (((hr && hr.values) || [])[0] || []).map(function (h) { return String(h == null ? '' : h); }).filter(function (h) { return h.trim() !== ''; });
      } catch (e) { header = []; }
      var isEmpty = header.length === 0;
      if (isEmpty) {
        header = defaultHeader;
      } else {
        // Append any columns we need that the tab lacks. 'Import ID' always;
        // IPF/Demat because Integrated notes carry them.
        var needed = ['Import ID', 'IPF Charges', 'Demat Charges'];
        var missing = needed.filter(function (n) { return !header.some(function (h) { return headerKey_(h) === headerKey_(n); }); });
        if (missing.length) {
          header = header.concat(missing);
          Sheets.Spreadsheets.Values.update({ values: [header] }, spreadsheetId, tab + "!A1", { valueInputOption: 'RAW' });
        }
      }
      var dataRows = mapRecordsToHeader_(header, newRecords);
      var values = [];
      if (isEmpty) values.push(header);
      for (var d = 0; d < dataRows.length; d++) values.push(dataRows[d]);
      Sheets.Spreadsheets.Values.append({ values: values }, spreadsheetId, tab + "!A:Z", { valueInputOption: 'USER_ENTERED' });
    });
  }

  return { appended: newRecords.length, skipped: skipped, unmatched: unmatched, importId: batchId };
}

// header cell → canonical record key (port of tradeRowSchema.headerKey)
function headerKey_(header) {
  var s = String(header || '').toLowerCase().trim();
  if (/import id|import batch|batch id/.test(s)) return 'importId';
  if (/trade date|^date$/.test(s)) return 'date';
  if (/isin/.test(s)) return 'isin';
  if (/stock name|security name|company|scrip name/.test(s)) return 'name';
  if (/transaction type/.test(s)) return 'txType';
  if (/number of shares|no\.? of shares|^shares$|quantity|qty/.test(s)) return 'qty';
  if (/brokerage per share|brokerage\s*\/\s*sh/.test(s)) return 'brokeragePerShare';
  if (/total brokerage|^brokerage$/.test(s)) return 'brokerage';
  if (/avg\.? price|average price|^price$/.test(s)) return 'price';
  if (/with expense.*incl/.test(s)) return 'totalWithExpInclSTT';
  if (/with expense.*excl/.test(s)) return 'totalWithExpExclSTT';
  if (/total expenses.*incl/.test(s)) return 'totalExpInclSTT';
  if (/total expenses.*excl/.test(s)) return 'totalExpExclSTT';
  if (/total amount.*turnover|^turnover$/.test(s)) return 'turnover';
  if (/exchange turnover|exchange charges|turnover charges/.test(s)) return 'exchangeCharges';
  if (/sebi/.test(s)) return 'sebiFees';
  if (/ipf/.test(s)) return 'ipf';
  if (/demat|dmat|dp charge/.test(s)) return 'dmat';
  if (/igst|total gst|\bgst\b/.test(s)) return 'gst';
  if (/stamp/.test(s)) return 'stampDuty';
  if (/\bstt\b/.test(s)) return 'stt';
  if (/trade class|trade type/.test(s)) return 'tradeClass';
  return '';
}

function mapRecordsToHeader_(header, records) {
  return records.map(function (rec) {
    return header.map(function (h) { var k = headerKey_(h); return k ? (rec[k] != null ? rec[k] : '') : ''; });
  });
}

function toIsoDate_(s) {
  if (s && Object.prototype.toString.call(s) === '[object Date]') {
    return Utilities.formatDate(s, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var c = String(s == null ? '' : s).trim();
  if (!c) return c;
  var m = c.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return m[3] + '-' + pad2_(m[2]) + '-' + pad2_(m[1]);
  m = c.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]);
  return c;
}
function pad2_(x) { x = String(x); return x.length < 2 ? '0' + x : x; }

function numKey_(x) {
  var v = parseFloat(String(x == null ? '' : x).replace(/,/g, '').trim());
  return isNaN(v) ? String(x == null ? '' : x).trim() : String(v);
}
function rowKey_(date, type, id, qty, price) {
  return [toIsoDate_(String(date == null ? '' : date).trim()), String(type == null ? '' : type).trim().toUpperCase(), id, numKey_(qty), numKey_(price)].join('|');
}

function portfolioByUcc_(ucc) {
  var u = String(ucc || '').trim().toUpperCase();
  if (!u) return null;
  for (var i = 0; i < PORTFOLIOS.length; i++) {
    for (var j = 0; j < PORTFOLIOS[i].ucc.length; j++) {
      if (PORTFOLIOS[i].ucc[j].toUpperCase() === u) return PORTFOLIOS[i];
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// SETUP HELPERS — run once from the editor.
// ════════════════════════════════════════════════════════════════════════════
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailyImport') ScriptApp.deleteTrigger(t); });
  // Run twice a day (project timezone): ~12 PM (noon) and ~6 PM. Add/remove hours here.
  [12, 18].forEach(function (h) {
    ScriptApp.newTrigger('dailyImport').timeBased().everyDays(1).atHour(h).create();
  });
}
function removeDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailyImport') ScriptApp.deleteTrigger(t); });
}
