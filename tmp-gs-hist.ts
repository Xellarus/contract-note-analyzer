/**
 * Runs the REAL Apps Script functions (parseHistory_, writePriceHistory_) in a sandbox with
 * stubbed Google services, against LIVE Yahoo responses. Testing a reimplementation would prove
 * nothing — the point is to exercise the code that will actually run.
 */
import * as fs from 'fs';
import * as vm from 'vm';

let fails = 0;
const ok = (c: boolean, label: string, extra = '') => {
  if (!c) { fails++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`); }
  else console.log(`  ok    ${label}${extra ? '  ' + extra : ''}`);
};

// ── sandbox with the Google services the history code touches ────────────────
const logs: string[] = [];
const sandbox: any = {
  Logger: { log: (m: any) => logs.push(String(m)) },
  Utilities: {
    formatDate: (d: Date, tz: string, fmt: string) => {
      if (fmt !== 'yyyy-MM-dd') throw new Error('unexpected fmt ' + fmt);
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    },
  },
  UrlFetchApp: { fetchAll: () => { throw new Error('not used in this test'); } },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  ScriptApp: { getProjectTriggers: () => [] },
  SpreadsheetApp: { flush: () => {}, openById: () => { throw new Error('stubbed per-test'); } },
  ContentService: { createTextOutput: (s: any) => ({ setMimeType: () => s }), MimeType: { JSON: 'json' } },
  console,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('apps-script/YahooPriceUpdate.gs', 'utf8'), sandbox, { filename: 'YahooPriceUpdate.gs' });

const fakeResp = (code: number, body: string) => ({ getResponseCode: () => code, getContentText: () => body });

// parseHistory_ rounds to 4 dp on purpose, to strip Yahoo's float32 noise (51.34000015258789).
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const ymdIST = (t: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(t * 1000));

async function yahoo(sym: string, range = '2y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}&events=split`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  return await r.text();
}

(async () => {
  // ── 1. parseHistory_ on a scrip with NO splits: must equal Yahoo's raw closes ──
  console.log('\n1. parseHistory_ — no-split scrip is passed through untouched');
  {
    const body = await yahoo('IRCTC.NS');
    const out = sandbox.parseHistory_(fakeResp(200, body));
    const j = JSON.parse(body);
    const res = j.chart.result[0];
    const raw: (number | null)[] = res.indicators.quote[0].close;
    const rawGood = raw.filter(v => typeof v === 'number' && isFinite(v as number) && (v as number) > 0) as number[];
    ok(!!out && out.splits === 0, 'no split events reported', `splits=${out?.splits}`);
    ok(out.dates.length === rawGood.length, 'every non-null candle kept', `${out.dates.length} vs ${rawGood.length}`);
    const identical = out.closes.every((c: number, i: number) => c === r4(rawGood[i]));
    ok(identical, 'closes == Yahoo rounded to 4dp (factor 1 throughout, no scaling)');
    ok(out.dates.length === new Set(out.dates).size, 'no duplicate dates');
    ok(out.dates.every((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d)), 'dates are ISO yyyy-MM-dd');
    const sorted = [...out.dates].sort();
    ok(JSON.stringify(sorted) === JSON.stringify(out.dates), 'dates already ascending');
  }

  // ── 2. parseHistory_ on the 10:1 — the case that would break NAV by 10x ──
  console.log('\n2. parseHistory_ — Manbro 10:1 (25-Mar-2026)');
  {
    const body = await yahoo('MANBRO.BO');
    const out = sandbox.parseHistory_(fakeResp(200, body));
    const j = JSON.parse(body);
    const res = j.chart.result[0];
    const rawClose: (number | null)[] = res.indicators.quote[0].close;
    const ts: number[] = res.timestamp;

    ok(out.splits === 1, 'one split event seen', `splits=${out.splits}`);
    const iEx = out.dates.indexOf('2026-03-25');
    ok(iEx > 0, 'ex-date present in the series', `index ${iEx}`);

    // The last close must be UNCHANGED (no split after it).
    const lastRaw = (rawClose.filter(v => typeof v === 'number' && v! > 0) as number[]).pop()!;
    // Tolerance is half a 4-dp step, not 1e-6: parseHistory_ rounds to 4 decimals
    // (Math.round(v * f * 10000) / 10000) and Yahoo hands back float32 values with a
    // ~1e-6 tail, so exact equality fails on whichever bar happens to be last today.
    // 5e-5 still proves the point decisively — a wrongly applied factor would be ~10x off.
    ok(Math.abs(out.closes[out.closes.length - 1] - lastRaw) < 5e-5,
       'latest close untouched (nothing to un-adjust after it)', `${out.closes[out.closes.length - 1]} vs ${lastRaw}`);

    // A pre-split close must be exactly 10x Yahoo's adjusted number.
    const dBefore = out.dates[iEx - 1];
    const iRaw = ts.findIndex(t => ymdIST(t) === dBefore);
    ok(out.closes[iEx - 1] === r4((rawClose[iRaw] as number) * 10),
       'pre-split close is exactly 10x Yahoo', `${out.closes[iEx - 1]} vs ${r4((rawClose[iRaw] as number) * 10)}`);

    // Economic invariant: value must not jump across the split. A ~10x step in the TRUE series
    // is the split; anything near 1x would mean we un-adjusted a series that was already raw.
    const step = out.closes[iEx - 1] / out.closes[iEx];
    ok(step > 8 && step < 12, 'true series steps ~10x at the split (as it must)', `step=${step.toFixed(2)}`);
    // And the ex-date bar itself must NOT be scaled — this is the '>' vs '>=' boundary.
    const iRawEx = ts.findIndex(t => ymdIST(t) === '2026-03-25');
    ok(out.closes[iEx] === r4(rawClose[iRawEx] as number),
       'ex-date bar left at factor 1 (the > vs >= boundary)',
       `${out.closes[iEx]} vs ${r4(rawClose[iRawEx] as number)}`);
  }

  // ── 3. Two consecutive splits must COMPOUND ──
  console.log('\n3. parseHistory_ — Time Technoplast: two 2:1s must compound to x4');
  {
    const body = await yahoo('TIMETECHNO.NS');
    const out = sandbox.parseHistory_(fakeResp(200, body));
    const j = JSON.parse(body);
    const res = j.chart.result[0];
    const rawClose: (number | null)[] = res.indicators.quote[0].close;
    const ts: number[] = res.timestamp;
    const ymd = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t * 1000));

    ok(out.splits === 2, 'both split events seen', `splits=${out.splits}`);
    const before = '2025-09-12';                        // before BOTH splits -> x4
    const between = '2025-09-18';                       // after the first, before the second -> x2
    for (const [d, want] of [[before, 4], [between, 2]] as [string, number][]) {
      const io = out.dates.indexOf(d);
      const ir = ts.findIndex(t => ymd(t) === d);
      if (io < 0 || ir < 0) { ok(false, `sample date ${d} present`); continue; }
      const got = out.closes[io] / (rawClose[ir] as number);
      ok(Math.abs(got - want) < 1e-3, `${d} scaled x${want} (cumulative)`, `got x${got.toFixed(4)}`);
    }
  }

  // ── 4. Robustness ──
  console.log('\n4. parseHistory_ — bad input');
  ok(sandbox.parseHistory_(fakeResp(429, '')) === null, 'HTTP 429 -> null (not a fake series)');
  ok(sandbox.parseHistory_(fakeResp(200, 'not json')) === null, 'garbage body -> null');
  ok(sandbox.parseHistory_(fakeResp(200, '{"chart":{"result":null}}')) === null, 'empty result -> null');
  {
    const nulls = JSON.stringify({ chart: { result: [{ timestamp: [1, 2], indicators: { quote: [{ close: [null, null] }] } }] } });
    const r = sandbox.parseHistory_(fakeResp(200, nulls));
    ok(!!r && r.dates.length === 0, 'all-null closes -> empty series, NOT zeros');
  }

  // ── 5. writePriceHistory_ merge semantics ──
  console.log('\n5. writePriceHistory_ — full write, then a top-up that must not lose anything');
  {
    // A fake sheet that records what was written.
    let grid: any[][] = [];
    let maxR = 1000, maxC = 26;
    // Record the ORDER of operations: pinning the date column to TEXT only helps if it happens
    // BEFORE setValues writes the ISO strings.
    let ops: string[] = [];
    const sheet: any = {
      getDataRange: () => ({ getValues: () => grid.map(r => r.slice()) }),
      getMaxRows: () => maxR,
      getMaxColumns: () => maxC,
      insertRowsAfter: (_a: number, n: number) => { maxR += n; },
      insertColumnsAfter: (_a: number, n: number) => { maxC += n; },
      deleteRows: (start: number, n: number) => { maxR -= n; void start; },
      deleteColumns: (start: number, n: number) => { maxC -= n; void start; },
      getRange: (r: number, c: number, nr: number, nc?: number) => ({
        setNumberFormat: (f: string) => {
          // The pin must cover column 1 only (the Date column), for every written row.
          if (r === 1 && c === 1 && nc === 1 && f === '@') ops.push(`pin:${nr}`);
          else ops.push(`fmt?:${r},${c},${nr},${nc},${f}`);
        },
        setValues: (v: any[][]) => { ops.push(`write:${v.length}x${v[0].length}`); grid = v.map(x => x.slice()); },
      }),
    };
    sandbox.SpreadsheetApp.openById = () => ({
      getSheetByName: () => sheet,
      insertSheet: () => sheet,
    });

    // Full write: 2 scrips, 3 dates.
    const r1 = sandbox.writePriceHistory_(['INE_A', 'INE_B'], {
      '2026-08-10': { INE_A: 10, INE_B: 100 },
      '2026-08-11': { INE_A: 11, INE_B: 101 },
      '2026-08-12': { INE_A: 12, INE_B: 102 },
    }, true);
    ok(r1.dates === 3 && r1.cols === 2, 'full write: 3 dates x 2 cols', JSON.stringify(r1));
    ok(grid[0][0] === 'Date' && grid[0][1] === 'INE_A' && grid[0][2] === 'INE_B', 'header row correct');
    ok(ops.join(' ') === 'pin:4 write:4x3',
       'date column pinned to TEXT *before* setValues (the coercion trap)', ops.join(' '));
    ok(grid[1][0] === '2026-08-10' && grid[3][0] === '2026-08-12', 'dates ascending');
    ok(grid[2][1] === 11 && grid[2][2] === 101, 'values landed in the right cells');

    // Top-up: a NEW scrip, a NEW date, and a CORRECTED old value.
    const r2 = sandbox.writePriceHistory_(['INE_B', 'INE_C'], {
      '2026-08-12': { INE_B: 999, INE_C: 7 },     // correction + new col
      '2026-08-13': { INE_B: 103, INE_C: 8 },     // new date
    }, false);
    ok(r2.dates === 4, 'top-up kept all 3 old dates and added 1', `dates=${r2.dates}`);
    ok(r2.cols === 3, 'top-up kept both old columns and added INE_C', `cols=${r2.cols}`);
    const hdr = grid[0];
    ok(hdr[1] === 'INE_A' && hdr[2] === 'INE_B' && hdr[3] === 'INE_C', 'existing column ORDER preserved', hdr.join('|'));
    const row10 = grid.find(r => r[0] === '2026-08-10')!;
    ok(row10[1] === 10 && row10[2] === 100, 'untouched old row survives intact');
    ok(row10[3] === '', 'new column is blank (not 0) for dates before it existed');
    const row12 = grid.find(r => r[0] === '2026-08-12')!;
    ok(row12[1] === 12, 'un-updated cell in an updated row kept its old value');
    ok(row12[2] === 999, 'corrected value overwrote');
    ok(row12[3] === 7, 'new column value landed');
    const row13 = grid.find(r => r[0] === '2026-08-13')!;
    ok(row13[1] === '', 'scrip absent from the top-up leaves a BLANK, not a zero');

    // A top-up that reads back Date cells Sheets coerced into Date objects must still merge.
    grid = grid.map((r, i) => (i === 0 ? r : [new Date(Date.UTC(+r[0].slice(0, 4), +r[0].slice(5, 7) - 1, +r[0].slice(8, 10))), ...r.slice(1)]));
    const r3 = sandbox.writePriceHistory_(['INE_B'], { '2026-08-13': { INE_B: 104 } }, false);
    ok(r3.dates === 4, 'coerced Date cells still merge by date (ymdCell_ tolerance)', `dates=${r3.dates}`);
    ok(grid.find(r => r[0] === '2026-08-13')![2] === 104, 'value updated after coercion');
  }

  console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('\nTHREW:', e); process.exit(1); });
