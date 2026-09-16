/**
 * Coverage for valuing an UNLISTED holding at the price it last transacted at.
 *
 * Two halves, both load-bearing:
 *   1. `rebuildHoldingTab` capturing the last MARKET transaction per scrip into columns F/G
 *      of the Holding tab (the only tab the list view, computeAum, computeIndustryAllocation
 *      and the Dashboard actually read).
 *   2. `makePriceResolver` precedence — imported price > hand-entered valuation > last trade >
 *      nothing. This is the valuation rule, and it moves AUM and NAV.
 *
 * Run: node tmp-holding-lastpx-run.mjs
 */
import { rebuildHoldingTab } from './src/lib/holdingsCalc';
import { makePriceResolver, makeExceptionResolver } from './src/lib/scripPrices';
import { loadScripMaster, invalidateScripCache, SCRIP_MASTER_SPREADSHEET_ID } from './src/lib/scripMaster';
import { invalidatePrivateEquityCache } from './src/lib/privateEquities';
import { formatDMY } from './src/lib/dates';

const g: any = globalThis;
let pass = 0, fail = 0;
const ok = (name: string, cond: any, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const eq = (name: string, got: any, want: any) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  ok(name, a === b, `got ${a}, want ${b}`);
};

const PORTFOLIO = 'PORT-1';
const MASTER_TAB = 'Scrip Master';
const serial = (y: number, m: number, d: number) =>
  Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);

const TE_HEADER = [
  'Trade Date', 'Stock Name', 'ISIN', 'Transaction Type', 'Number of Shares', 'Avg Price',
  'Total Amount (Turnover)', 'Total Amount with Expense (Incl STT)', 'Trade Class', 'Notes',
  'Total Brokerage', 'STT', 'IGST', 'Exchange Turnover Charges', 'Stamp Duty',
  'SEBI Turnover Fees', 'IPF Charges', 'Demat Charges',
];

/** One True Entry row. `brok` is baked into the incl-STT total so cost != raw price. */
const te = (
  d: [number, number, number], name: string, isin: string,
  type: string, qty: number, price: number, brok = 500,
) => [
  serial(...d), name, isin, type, qty, price,
  qty * price, /SELL|SALE/i.test(type) ? qty * price - brok : qty * price + brok,
  'Delivery', '', brok, 0, 0, 0, 0, 0, 0, 0,
];

const SCRIP_ROWS = [
  ['ISIN', 'Security Name', 'BSE', 'NSE', 'Alias name'],
  ['INE001A01011', 'ALPHA INDUSTRIES LIMITED', '500001', 'ALPHA', ''],
  // The owner's real pair (16-Sep-2026): a LISTED company whose unlisted twin is on the PE tab.
  // Deliberately given NO ISIN here — a hand-maintained master row with just a name and a
  // ticker is ordinary, and it is the shape under which the two collide hardest.
  ['', 'KUSUMGAR LIMITED', 'KUSUMGAR | 500900', 'KUSUMGAR', ''],
];
/** ACME is unlisted with NO valuation; ZENITH is unlisted WITH one. */
const PE_ROWS = [
  ['Company', 'Drive Link', 'ISIN', 'Valuation', 'Valuation Date', 'Notes'],
  ['ACME VENTURES PRIVATE LIMITED', '', '', '', '', ''],
  ['ZENITH CAPITAL LLP', '', '', 250, serial(2025, 6, 30), ''],
  // Normalises to "kusumgar", exactly as the listed row above does.
  ['Kusumgar Pvt Ltd', '', '', '', '', ''],
];

function install(trueEntry: any[][]) {
  g.__ranges = {
    [`${PORTFOLIO}::True Entry!A:T`]: trueEntry,
    [`${SCRIP_MASTER_SPREADSHEET_ID}::'${MASTER_TAB}'!A1:Z50000`]: SCRIP_ROWS,
    [`${SCRIP_MASTER_SPREADSHEET_ID}::Private Equities!A1:J5000`]: PE_ROWS,
  };
  g.__firstTab = { [PORTFOLIO]: 'True Entry', [SCRIP_MASTER_SPREADSHEET_ID]: MASTER_TAB };
  g.__sheetTabs = { [PORTFOLIO]: ['True Entry', 'Holding'] };
  g.__updated = []; g.__batched = []; g.__cleared = []; g.__failRange = {};
  invalidateScripCache();
  invalidatePrivateEquityCache();
}

const holdingRows = (): any[][] => {
  const hit = (g.__updated || []).filter((u: any) => (u.range || '').startsWith('Holding!'));
  return hit.length ? hit[hit.length - 1].resource.values : [];
};
const rowFor = (name: string): any[] | undefined =>
  holdingRows().find((r) => String(r[0] ?? '').toUpperCase().includes(name.toUpperCase()));

async function main() {
  console.log('\n── makePriceResolver precedence ' + '─'.repeat(29));
  {
    install([TE_HEADER, te([2025, 5, 1], 'ACME VENTURES PRIVATE LIMITED', '', 'Buy', 100, 300)]);
    const master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID);

    // An imported market price for the unlisted name (a company that has since listed).
    const withFeed = makePriceResolver(master, [{ isin: '', name: 'ACME VENTURES PRIVATE LIMITED', price: 999 } as any]);
    eq('an imported market price beats everything', withFeed('', 'ACME VENTURES PRIVATE LIMITED', 400), 999);

    const noFeed = makePriceResolver(master, []);
    // ZENITH carries a hand-entered 250. A last trade of 400 must NOT override it: entering a
    // valuation is a deliberate act and outranks anything derived.
    eq('a hand-entered valuation beats the last trade', noFeed('', 'ZENITH CAPITAL LLP', 400), 250);
    eq('the last trade is used when no valuation exists', noFeed('', 'ACME VENTURES PRIVATE LIMITED', 400), 400);
    eq('no valuation and no last trade → undefined (caller holds at cost)',
      noFeed('', 'ACME VENTURES PRIVATE LIMITED'), undefined);
    eq('a zero last trade is not a price', noFeed('', 'ACME VENTURES PRIVATE LIMITED', 0), undefined);
    eq('a NaN last trade is not a price', noFeed('', 'ACME VENTURES PRIVATE LIMITED', NaN), undefined);

    // THE guard: a LISTED security must never be valued at a stale trade. Its price is the
    // feed's job, and substituting one would hide a broken import behind a plausible number.
    eq('a LISTED security ignores the last trade entirely',
      noFeed('INE001A01011', 'ALPHA INDUSTRIES LIMITED', 400), undefined);

    // ── The listed/unlisted twin must not inherit the other's quote ─────────────────
    //
    // Reported 16-Sep-2026: the unlisted "Kusumgar Pvt Ltd" detail page carried a PE badge and
    // a "₹549.20 · YAHOO" valuation at the same time — a combination that should not exist.
    // Both maps in `makePriceResolver` fall back to `normName`, which strips private/pvt, so
    // the private company read the LISTED one's feed price straight off the shared string.
    //
    // This is money: it moves the holding's value, the portfolio's AUM and the NAV timeline,
    // and it looks entirely plausible while doing it.
    const yahoo = makePriceResolver(master, [{ isin: '', name: 'KUSUMGAR LIMITED', price: 549.2 } as any]);
    eq('the listed company takes its own feed price', yahoo('', 'KUSUMGAR LIMITED', 0), 549.2);
    eq('the UNLISTED twin does NOT inherit it', yahoo('', 'Kusumgar Pvt Ltd', 0), undefined);
    // ...and still reaches its own fallbacks, which is the point of skipping rather than failing.
    eq('...and falls through to its own last traded price', yahoo('', 'Kusumgar Pvt Ltd', 383.25), 383.25);

    // The reverse direction: a price row filed under the PRIVATE name reaches the private
    // company (by its canonical key) and must not become the listed company's quote.
    const pePrice = makePriceResolver(master, [{ isin: '', name: 'Kusumgar Pvt Ltd', price: 383.25 } as any]);
    eq('a price filed under the PRIVATE name reaches the private company',
      pePrice('', 'Kusumgar Pvt Ltd', 0), 383.25);
    eq('...and does NOT become the listed company\'s quote',
      pePrice('', 'KUSUMGAR LIMITED', 0), undefined);

    // ── The SAME crossover in the price-exception flag ───────────────────────────
    //
    // `makeExceptionResolver` had NO coverage at all before this (16-Sep-2026) — found because
    // the probe that removes its guard changed nothing. It keys the same way and crosses the
    // same way, and it decides whether a scrip's price is left alone: flag the unlisted twin and
    // the LISTED company stops taking its feed price, which reads as a broken price import.
    const exFlagOnPrivate = makeExceptionResolver(master, [{ isin: '', name: 'Kusumgar Pvt Ltd', price: 0, except: true } as any]);
    ok('an exception flagged on the PRIVATE company applies to it', exFlagOnPrivate('', 'Kusumgar Pvt Ltd'));
    ok('...and NOT to its listed namesake', !exFlagOnPrivate('', 'KUSUMGAR LIMITED'));

    const exFlagOnListed = makeExceptionResolver(master, [{ isin: '', name: 'KUSUMGAR LIMITED', price: 0, except: true } as any]);
    ok('an exception flagged on the LISTED company applies to it', exFlagOnListed('', 'KUSUMGAR LIMITED'));
    ok('...and NOT to its unlisted twin', !exFlagOnListed('', 'Kusumgar Pvt Ltd'));

    // Inert where there is no collision — the ordinary case must be untouched.
    const exPlain = makeExceptionResolver(master, [{ isin: '', name: 'ACME VENTURES PRIVATE LIMITED', price: 0, except: true } as any]);
    ok('a scrip with no twin is still flagged by name', exPlain('', 'ACME VENTURES PRIVATE LIMITED'));
    ok('...and an unflagged one is not', !exPlain('', 'ZENITH CAPITAL LLP'));

    // An ordinary scrip must take exactly the path it always did — the guard is phrased over the
    // master ("is this name a DIFFERENT entry?"), so it is inert wherever there is no collision.
    const plain = makePriceResolver(master, [{ isin: '', name: 'ACME VENTURES PRIVATE LIMITED', price: 111 } as any]);
    eq('an unlisted company with no twin still matches by name', plain('', 'ACME VENTURES PRIVATE LIMITED', 0), 111);
    const alpha = makePriceResolver(master, [{ isin: '', name: 'ALPHA INDUSTRIES LIMITED', price: 222 } as any]);
    eq('a listed company with no twin still matches by name', alpha('', 'ALPHA INDUSTRIES LIMITED', 0), 222);
  }

  console.log('\n── rebuildHoldingTab: capturing the last trade ' + '─'.repeat(14));

  // ── the two columns exist, at the END ───────────────────────────────────────
  {
    install([TE_HEADER, te([2025, 5, 1], 'ACME VENTURES PRIVATE LIMITED', '', 'Buy', 100, 300)]);
    await rebuildHoldingTab(PORTFOLIO);
    const rows = holdingRows();
    eq('header carries the two new columns at F and G',
      [rows[0]?.[5], rows[0]?.[6]], ['Last Trade Price', 'Last Trade Date']);
    eq('the first five columns are untouched', rows[0]?.slice(0, 5),
      ['Company Name', 'ISIN', 'Quantity', 'Avg Buy Price', 'Invested Value']);
    // Every existing reader of this tab is positional and pinned to A:E. Appending is the only
    // safe edit; an inserted column would silently shift a cost basis.
    eq('the Total row is padded to the full width', holdingRows().at(-1)?.length, 7);
  }

  // ── the RAW price, not the incl-STT cost ───────────────────────────────────
  {
    install([TE_HEADER, te([2025, 5, 1], 'ACME VENTURES PRIVATE LIMITED', '', 'Buy', 100, 300, 500)]);
    await rebuildHoldingTab(PORTFOLIO);
    const r = rowFor('ACME');
    ok('the row was written', !!r);
    // Avg cost is 305 (30,000 + 500 brokerage over 100 shares). The last TRADED price is 300.
    eq('avg buy price is the all-in cost', r?.[3], 305);
    eq('last trade price is the RAW transaction price, not the cost', r?.[5], 300);
    eq('and its date round-trips through formatDMY', formatDMY(r?.[6]), '01/05/2025');
  }

  // ── the most recent transaction wins, buy or sell ──────────────────────────
  {
    install([TE_HEADER,
      te([2025, 5, 1], 'ACME VENTURES PRIVATE LIMITED', '', 'Buy', 100, 300),
      te([2025, 9, 20], 'ACME VENTURES PRIVATE LIMITED', '', 'Sell', 40, 450),
    ]);
    await rebuildHoldingTab(PORTFOLIO);
    eq('a later SELL supersedes an earlier buy', rowFor('ACME')?.[5], 450);
    eq('with the sell\'s date', formatDMY(rowFor('ACME')?.[6]), '20/09/2025');
  }
  {
    install([TE_HEADER,
      te([2025, 9, 20], 'ACME VENTURES PRIVATE LIMITED', '', 'Sell', 40, 450),
      te([2025, 5, 1], 'ACME VENTURES PRIVATE LIMITED', '', 'Buy', 100, 300),
    ]);
    await rebuildHoldingTab(PORTFOLIO);
    eq('sheet order does not decide it — the DATE does', rowFor('ACME')?.[5], 450);
  }

  // ── same date → later sheet row, matching the FIFO replay's own tie-break ──
  {
    install([TE_HEADER,
      te([2025, 5, 1], 'ACME VENTURES PRIVATE LIMITED', '', 'Buy', 100, 300),
      te([2025, 5, 1], 'ACME VENTURES PRIVATE LIMITED', '', 'Buy', 50, 320),
    ]);
    await rebuildHoldingTab(PORTFOLIO);
    eq('a same-day tie takes the later sheet row', rowFor('ACME')?.[5], 320);
  }

  // ── three kinds of row that are NOT prices ─────────────────────────────────
  {
    // A BONUS allotment is free. 0 means "no consideration", never "worth nothing".
    install([TE_HEADER,
      te([2025, 5, 1], 'ACME VENTURES PRIVATE LIMITED', '', 'Buy', 100, 300),
      te([2025, 8, 1], 'ACME VENTURES PRIVATE LIMITED', '', 'Bonus', 100, 0, 0),
    ]);
    await rebuildHoldingTab(PORTFOLIO);
    eq('a Bonus at 0 does not become the last price', rowFor('ACME')?.[5], 300);
    eq('and the date stays the real trade\'s', formatDMY(rowFor('ACME')?.[6]), '01/05/2025');
  }
  {
    // A SPLIT rescales lots. Its "price" is not a price at all.
    install([TE_HEADER,
      te([2025, 5, 1], 'ACME VENTURES PRIVATE LIMITED', '', 'Buy', 100, 300),
      te([2025, 8, 1], 'ACME VENTURES PRIVATE LIMITED', '', 'Split', 100, 150, 0),
    ]);
    await rebuildHoldingTab(PORTFOLIO);
    eq('a Split is not a transaction price', rowFor('ACME')?.[5], 300);
  }
  {
    // A cross-portfolio TRANSFER is the same owner moving shares. No market, no price.
    install([TE_HEADER,
      te([2025, 5, 1], 'ACME VENTURES PRIVATE LIMITED', '', 'Buy', 200, 300),
      te([2025, 8, 1], 'ACME VENTURES PRIVATE LIMITED', '', 'Transfer Out', 50, 700, 0),
    ]);
    await rebuildHoldingTab(PORTFOLIO);
    eq('a Transfer Out is not a market trade', rowFor('ACME')?.[5], 300);
    eq('though it still moved the shares', rowFor('ACME')?.[2], 150);
  }

  // ── a listed scrip gets the columns too; they are simply ignored on read ───
  {
    install([TE_HEADER, te([2025, 5, 1], 'ALPHA INDUSTRIES LIMITED', 'INE001A01011', 'Buy', 10, 50)]);
    await rebuildHoldingTab(PORTFOLIO);
    eq('a listed scrip records its last trade as well', rowFor('ALPHA')?.[5], 50);
    // Written, but makePriceResolver refuses to use it for a listed name (asserted above).
    // Recorded rather than suppressed so the column means one thing for every row.
  }

  console.log('\n' + '='.repeat(60));
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
