import { gapi } from "gapi-script";
import { loadScripMaster, lookupScrip, normName, SCRIP_MASTER_SPREADSHEET_ID } from "./scripMaster";
import { loadOpeningCorpActions } from "./openingCorpActions";
// Reused rather than re-implemented: the same sheet-date coercion this normalises (an ISO
// string written into a cell becomes a real Date and reads back locale-formatted) hits the
// Ex-Date column exactly as it hit the Prices tab's Price Date column.
import { normalisePriceDate } from "./scripPrices";

/**
 * Splits / bonuses detected on held scrips that are NOT yet recorded in the ledger.
 *
 * The detection half lives in YahooPriceUpdate.gs (`scanCorpActions`, weekly), which writes the
 * "Corp Action Alerts" tab from Yahoo's `events=split` feed — a feed that represents an Indian
 * bonus as a split (a 1:1 bonus reads as "2:1"). This module is the reconciliation half: it
 * decides which of those actions you still have to enter.
 *
 * An alert is shown ONLY when all of these hold, because each one is a real false-positive source:
 *   • the scrip is currently held in that portfolio,
 *   • the position existed BEFORE the ex-date — otherwise buying a stock after its split raises
 *     an alert for an action that never touched you (the most common false positive),
 *   • no Bonus/Split row already sits within ±MATCH_WINDOW_DAYS of the ex-date,
 *   • no pre-FY26 "Opening Corp Actions" entry covers it (those are already baked into the
 *     opening lots and must never be entered again), and
 *   • it hasn't been dismissed.
 *
 * Dismissal matters: Yahoo's feed is not clean. Manbro carries 1:10 (2018) and 10:1 (2026), an
 * exact inverse pair that looks like a corrected entry rather than two real events. So these are
 * advisory prompts, and a wrong one has to be silenceable.
 */
export const ALERTS_TAB = "Corp Action Alerts";

/** Days either side of the ex-date in which an existing Bonus/Split row counts as "recorded".
 *  Brokers book the credit days after the ex-date, and the ledger's date is the credit date. */
const MATCH_WINDOW_DAYS = 21;

export interface CorpActionAlert {
  isin: string;
  name: string;
  /** "Bonus" | "Split" when a source NAMED it (BSE does); "" when only inferable from the ratio. */
  type: string;
  ratio: string;      // "2:1" — numerator:denominator, i.e. 1 share becomes `numerator`
  exDate: string;     // ISO yyyy-mm-dd
  source: string;     // "bse" = authoritative type, "yahoo" = ratio only
  detected: string;
  status: string;     // "" = open, "dismissed" = silenced
  rowIndex: number;   // 1-based sheet row, for the dismiss writer
  /** Sheet column holding Status — 8-col layout = H, legacy 6-col = F. */
  statusCol: string;
}

export type ActionKind = "BONUS" | "SPLIT" | "EITHER";

export interface RatioReading {
  kind: ActionKind;
  /** 1 share becomes this many. Yahoo "5:2" → 2.5 */
  factor: number;
  /** Indian bonus convention — new shares PER HELD share. Yahoo "5:2" → "3:2". */
  bonusRatio: string;
  /** Indian split convention — 1 share becomes N. Yahoo "5:1" → "1:5". */
  splitRatio: string;
  /** Short human label for the badge. */
  label: string;
  note: string;
}

const gcd = (a: number, b: number): number => (b < 1e-9 ? a : gcd(b, a % b));

/**
 * Translate Yahoo's ratio into the Indian convention, and guess bonus vs split.
 *
 * Yahoo represents BOTH as a split — a 1:1 bonus arrives as "2:1" — so the feed genuinely cannot
 * tell us which it was. What it can't hide is the arithmetic, and that narrows it a long way:
 *
 *   • A FRACTIONAL ratio ("5:2", "3:2") is a bonus. Splits subdivide face value, and no Indian
 *     company splits ₹10 into ₹4; 3-for-2 and 1-for-2 bonuses are routine.
 *   • factor ≥ 3 with a whole ratio ("5:1", "10:1") is almost certainly a split — those are the
 *     standard ₹10→₹2 and ₹10→₹1 subdivisions, whereas a 4:1 or 9:1 bonus is very rare.
 *   • factor exactly 2 ("2:1") is genuinely ambiguous: a 1:1 bonus and a ₹10→₹5 split are both
 *     everyday events. We say so rather than guess.
 *
 * Returns null when the ratio can't be parsed, so the caller shows the raw string.
 */
export function readRatio(ratio: string): RatioReading | null {
  const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec((ratio || "").trim());
  if (!m) return null;
  const num = +m[1], den = +m[2];
  if (!(num > 0) || !(den > 0) || num <= den) return null;   // a consolidation isn't a bonus/split
  const factor = num / den;

  // new-per-held = (num − den) / den, reduced to lowest terms.
  let bn = num - den, bd = den;
  const g = gcd(Math.max(bn, bd), Math.min(bn, bd)) || 1;
  bn = Math.round((bn / g) * 1000) / 1000; bd = Math.round((bd / g) * 1000) / 1000;
  const bonusRatio = `${bn}:${bd}`;
  const splitRatio = `1:${Number.isInteger(factor) ? factor : factor.toFixed(2)}`;

  if (den > 1) {
    return { kind: "BONUS", factor, bonusRatio, splitRatio,
      label: `Bonus ${bonusRatio}`,
      note: `${bn} new share${bn === 1 ? "" : "s"} for every ${bd} held. A fractional ratio rules out a face-value split.` };
  }
  if (factor >= 3) {
    return { kind: "SPLIT", factor, bonusRatio, splitRatio,
      label: `Split ${splitRatio}`,
      note: `1 share becomes ${factor}. Could in principle be a ${bonusRatio} bonus, but that ratio is rare — a face-value split is far likelier.` };
  }
  return { kind: "EITHER", factor, bonusRatio, splitRatio,
    label: `Bonus ${bonusRatio} or Split ${splitRatio}`,
    note: `Ambiguous: a ${bonusRatio} bonus and a ${splitRatio} face-value split both double the share count. Check the announcement before recording.` };
}

export interface PendingCorpAction {
  alert: CorpActionAlert;
  portfolioId: string;
  portfolioLabel: string;
  heldQty: number;
  /** Shares the action would add, if the ratio is interpretable and the holding is known. */
  impliedNewShares: number;
  /** Bonus-vs-split reading of the ratio; null when the ratio can't be parsed. */
  reading: RatioReading | null;
}

export interface CorpActionAlertsPortfolio { id: string; label: string; sheetId: string }

const toN = (v: any): number => {
  const n = parseFloat((v ?? "").toString().replace(/,/g, "").trim());
  return isNaN(n) ? 0 : n;
};

const SHEET_EPOCH_MS = Date.UTC(1899, 11, 30);
/** Trade-date cell → epoch ms. Handles sheet serials and the ISO / dd-mm-yyyy strings the
 *  ledger mixes; 0 when unreadable (an undateable row can't match a window, so it won't
 *  silence an alert by accident). */
function dateTs(v: any): number {
  if (typeof v === "number" && isFinite(v) && v > 0) return SHEET_EPOCH_MS + Math.round(v * 86400000);
  const s = (v ?? "").toString().trim();
  if (!s) return 0;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}

/** Read the alerts tab. [] when it doesn't exist yet (the scan hasn't run). */
export async function loadCorpActionAlerts(): Promise<CorpActionAlert[]> {
  let res: any;
  try {
    res = await (gapi.client as any).sheets.spreadsheets.values.get({
      spreadsheetId: SCRIP_MASTER_SPREADSHEET_ID, range: `${ALERTS_TAB}!A:H`,
    });
  } catch { return []; }
  const rows: any[][] = res?.result?.values || [];
  if (!rows.length) return [];
  // The tab gained Type + Source columns; tolerate the original 6-column layout so a sheet written
  // by the earlier scanner still reads (as yahoo-sourced, type unknown) instead of coming back empty.
  const hdr = (rows[0] || []).map((h: any) => (h ?? "").toString().trim().toLowerCase());
  const legacy = !hdr.some(h => h === "type");
  const out: CorpActionAlert[] = [];
  for (let i = 1; i < rows.length; i++) {            // row 0 is the header
    const r = rows[i]; if (!r) continue;
    const isin = (r[0] || "").toString().trim().toUpperCase();
    // NOT a strict ISO test: if Sheets stored the ex-date as a real date the API hands it back
    // locale-formatted, and rejecting those would silently show zero alerts.
    const exDate = normalisePriceDate(legacy ? r[3] : r[4]);
    if (!isin || !exDate) continue;
    out.push({
      isin,
      name: (r[1] || "").toString().trim(),
      type: legacy ? "" : (r[2] || "").toString().trim(),
      ratio: (legacy ? r[2] : r[3] || "").toString().trim(),
      exDate,
      source: legacy ? "yahoo" : (r[5] || "").toString().trim().toLowerCase(),
      detected: (legacy ? r[4] : r[6] || "").toString().trim(),
      status: (legacy ? r[5] : r[7] || "").toString().trim().toLowerCase(),
      rowIndex: i + 1,
      statusCol: legacy ? "F" : "H",
    });
  }
  return out;
}

/** Silence one alert permanently (the weekly scan preserves the Status column). */
export async function dismissCorpActionAlert(rowIndex: number, statusCol = "H"): Promise<void> {
  if (!(rowIndex >= 2)) throw new Error(`Refusing to write row ${rowIndex} — row 1 is the header.`);
  await (gapi.client as any).sheets.spreadsheets.values.update({
    spreadsheetId: SCRIP_MASTER_SPREADSHEET_ID,
    range: `${ALERTS_TAB}!${statusCol}${rowIndex}`,
    valueInputOption: "RAW",
    resource: { values: [["dismissed"]] },
  });
}

/**
 * Cross-portfolio reconciliation → the alerts still needing action, newest ex-date first.
 * Reads each portfolio's Holding + True Entry tabs in parallel; a portfolio that fails to read
 * is skipped rather than silently suppressing its alerts.
 */
export async function computePendingCorpActions(
  portfolios: CorpActionAlertsPortfolio[],
): Promise<PendingCorpAction[]> {
  const alerts = (await loadCorpActionAlerts()).filter(a => a.status !== "dismissed");
  if (!alerts.length) return [];

  const master = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID).catch(() => null);
  const keyOf = (isin: string, name: string): string => {
    if (master) { const e = lookupScrip(master, isin, name).entry; if (e) return e.key; }
    return (isin || "").trim().toUpperCase() || normName(name);
  };
  const alertKey = new Map<string, string>();
  for (const a of alerts) alertKey.set(a.isin, keyOf(a.isin, a.name));

  const reads = await Promise.all(portfolios.map(async (p) => {
    const [hold, te, openActs] = await Promise.all([
      (gapi.client as any).sheets.spreadsheets.values
        .get({ spreadsheetId: p.sheetId, range: "Holding!A:E" })
        .then((r: any) => (r?.result?.values || []) as any[][]).catch(() => null),
      (gapi.client as any).sheets.spreadsheets.values
        .get({ spreadsheetId: p.sheetId, range: "True Entry!A:T", valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" })
        .then((r: any) => (r?.result?.values || []) as any[][]).catch(() => [] as any[][]),
      loadOpeningCorpActions(p.sheetId).catch(() => ({} as Record<string, any>)),
    ]);
    return { p, hold, te, openActs };
  }));

  const out: PendingCorpAction[] = [];

  for (const { p, hold, te, openActs } of reads) {
    if (!hold) continue;   // couldn't read this portfolio — don't claim anything about it

    // Held quantity per scrip key.
    const heldBy = new Map<string, number>();
    for (let i = 1; i < hold.length; i++) {
      const r = hold[i]; if (!r) continue;
      const nm = (r[0] || "").toString().trim();
      if (!nm || /^total/i.test(nm)) continue;
      const q = toN(r[2]);
      if (!(q > 0)) continue;                       // only CURRENT holdings can need an action
      const k = keyOf((r[1] || "").toString().trim(), nm);
      heldBy.set(k, (heldBy.get(k) || 0) + q);
    }
    if (!heldBy.size) continue;

    // True Entry: earliest activity per scrip (did we hold before the ex-date?) and every
    // Bonus/Split row's date (does an entry already cover this action?).
    const firstTs = new Map<string, number>();
    const actionTs = new Map<string, number[]>();
    if (te.length > 1) {
      const hdr = te[0].map((h: any) => (h || "").toString().trim());
      const col = (n: string, fb: number) => { const i = hdr.indexOf(n); return i >= 0 ? i : fb; };
      const dI = col("Trade Date", 0), nI = col("Stock Name", 2), tI = col("Transaction Type", 3);
      for (let i = 1; i < te.length; i++) {
        const r = te[i]; if (!r) continue;
        const nm = (r[nI] || "").toString().trim(); if (!nm) continue;
        const ts = dateTs(r[dI]); if (!ts) continue;
        const k = keyOf("", nm);
        const cur = firstTs.get(k);
        if (cur === undefined || ts < cur) firstTs.set(k, ts);
        if (/bonus|split/i.test((r[tI] || "").toString())) {
          const arr = actionTs.get(k) || []; arr.push(ts); actionTs.set(k, arr);
        }
      }
    }

    // Pre-FY26 actions are keyed "scrip#TYPE#yyyy-mm-dd" — a match there means it's already
    // folded into the opening lots and must NOT be entered again.
    const openingKeys = Object.keys(openActs || {});

    for (const a of alerts) {
      const k = alertKey.get(a.isin)!;
      const held = heldBy.get(k);
      if (!(held && held > 0)) continue;

      const exTs = dateTs(a.exDate);
      if (!exTs) continue;

      // Did the position exist before the ex-date? Opening lots (pre-FY26) always predate FY26
      // actions, so a scrip with no True Entry history but a live holding counts as "held".
      const first = firstTs.get(k);
      if (first !== undefined && first > exTs) continue;   // bought after the action — not ours

      const win = MATCH_WINDOW_DAYS * 86400000;
      const already = (actionTs.get(k) || []).some(ts => Math.abs(ts - exTs) <= win);
      if (already) continue;

      const inOpening = openingKeys.some(ok => {
        const parts = ok.split("#");
        const okDate = parts[parts.length - 1];
        return keyOf("", parts[0]) === k && Math.abs(dateTs(okDate) - exTs) <= win;
      });
      if (inOpening) continue;

      // "2:1" → 1 share becomes 2, so the credit is held × (num/den − 1).
      // A named type from BSE overrides the ratio inference; readRatio still supplies the Indian
      // ratio and the factor, which BSE's Purpose string doesn't carry.
      const inferred = readRatio(a.ratio);
      const confirmed = /^bonus$/i.test(a.type) ? "BONUS" : /^split$/i.test(a.type) ? "SPLIT" : null;
      const reading: RatioReading | null = inferred && confirmed
        ? { ...inferred, kind: confirmed as ActionKind,
            label: confirmed === "BONUS" ? `Bonus ${inferred.bonusRatio}` : `Split ${inferred.splitRatio}`,
            note: `Confirmed as a ${confirmed.toLowerCase()} by the exchange feed.` }
        : (inferred ?? (confirmed
            ? { kind: confirmed as ActionKind, factor: 0, bonusRatio: "", splitRatio: "",
                label: confirmed === "BONUS" ? "Bonus" : "Split",
                note: "Confirmed by the exchange feed; ratio not published in this feed." }
            : null));
      const impliedNewShares = reading ? held * (reading.factor - 1) : 0;

      out.push({ alert: a, portfolioId: p.id, portfolioLabel: p.label, heldQty: held, impliedNewShares, reading });
    }
  }

  out.sort((x, y) => (x.alert.exDate < y.alert.exDate ? 1 : x.alert.exDate > y.alert.exDate ? -1 : 0));
  return out;
}
