import type { Factsheet, PeriodReturn, FactsheetHoldingRow } from "./factsheet";
import { downloadBlob, fileSafe } from "./reportDoc";

/**
 * The factsheet PDF, in the app's own Brass-on-Paper identity: a parchment ground, antique brass
 * (#8a6a1e) as the single accent, warm ink, and hairline rules — the same palette the light theme
 * uses, rather than a copy of somebody else's green house style.
 *
 * Five sections, each on its own page, because the data supports that much:
 *   1  Overview — headline figures, performance vs benchmark, periodic returns with excess, risk
 *   2  Composition — sector tiles + table, and the deployment chart
 *   3  Structure — concentration (Herfindahl / effective holdings) and the per-account rollup
 *   4  Holdings — the COMPLETE book, every open position with its own P&L; spills with a repeating
 *      header as the book grows, so the page count follows the portfolio
 *   5  Basis — a data-quality register, then methodology
 *
 * NO LETTER-SPACING ANYWHERE. `characterSpacing` looks right for small-caps headings but it wrecks
 * the PDF's text layer: pdf.js extracts "SECTOR ALLOCATION" as "S E CTO R A L LO C AT I O N", so
 * Ctrl+F and copy-paste stop working on a document meant to be searched. Weight, size and colour
 * carry the hierarchy instead.
 *
 * `buildFactsheetDocDefinition` is pure, so the layout can be exercised in Node.
 */

// ── Brass on Paper ───────────────────────────────────────────────────────────
const PAPER = "#fbf6eb";
const PANEL = "#f4ecd8";
const ZEBRA = "#f8f3e6";
const BRASS = "#8a6a1e";
const BRASS_DEEP = "#6d5417";
const INK = "#16130d";
const MUTED = "#756b57";
const RULE = "#ddd2b4";
const HAIR = "#e8dfc6";
const POS = "#0d6b3f";
const NEG = "#9c3a22";

const A4_W = 595.28, A4_H = 841.89;
const MARGIN = 30;
const CONTENT_W = A4_W - MARGIN * 2;

const nf = (n: number, dp = 2) => n.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const int = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

/** ₹ in crore / lakh — the units these figures are actually discussed in. */
function money(v: number): string {
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e7) return `${s}₹${nf(a / 1e7)} Cr`;
  if (a >= 1e5) return `${s}₹${nf(a / 1e5)} L`;
  return `${s}₹${int(a)}`;
}
const pc = (n: number | null, dp = 2) => (n === null || !isFinite(n) ? "—" : `${n < 0 ? "−" : ""}${Math.abs(n).toFixed(dp)}%`);
/** Signed, for a gain/loss where direction matters at a glance. */
const pcSigned = (n: number | null, dp = 2) => (n === null || !isFinite(n) ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(dp)}%`);
const numOr = (n: number | null, dp = 2) => (n === null || !isFinite(n) ? "—" : n.toFixed(dp));
const tone = (n: number | null) => (n === null || !isFinite(n) ? MUTED : n >= 0 ? POS : NEG);

/** Brass tints, darkest first, for the sector tiles. */
function tint(rank: number, total: number): { bg: string; fg: string; sub: string } {
  const t = total <= 1 ? 0 : rank / (total - 1);
  const from = [0x8a, 0x6a, 0x1e], to = [0xe8, 0xdc, 0xbe];
  const c = from.map((f, i) => Math.round(f + (to[i] - f) * t));
  const bg = `#${c.map(v => v.toString(16).padStart(2, "0")).join("")}`;
  const light = t > 0.42;
  return { bg, fg: light ? INK : "#fdfaf2", sub: light ? MUTED : "#efe4c8" };
}

const noBorder = { defaultBorder: false, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 };

/** Section header: small-caps label with a hairline running to the right margin. */
const head = (title: string, right?: string): any => ({
  margin: [0, 15, 0, 7],
  columns: [
    { text: title.toUpperCase(), bold: true, fontSize: 8.5, color: BRASS_DEEP, width: "auto" },
    { canvas: [{ type: "line", x1: 8, y1: 5, x2: 460, y2: 5, lineWidth: 0.6, lineColor: RULE }], width: "*" },
    ...(right ? [{ text: right, fontSize: 6.8, color: MUTED, alignment: "right", width: "auto", margin: [6, 1, 0, 0] }] : []),
  ],
});

function kpi(label: string, value: string, sub: string | null, opts: { dark?: boolean; valueColor?: string } = {}): any {
  const dark = !!opts.dark;
  return {
    table: { widths: ["*"], body: [[{
      stack: [
        { text: label.toUpperCase(), fontSize: 6.2, bold: true, color: dark ? "#d8c48b" : MUTED },
        { text: value, fontSize: 13, bold: true, color: dark ? "#fdfaf2" : (opts.valueColor ?? INK), margin: [0, 4, 0, 0] },
        ...(sub ? [{ text: sub, fontSize: 6.4, color: dark ? "#d8c48b" : MUTED, margin: [0, 3, 0, 0] }] : []),
      ],
      fillColor: dark ? BRASS_DEEP : PANEL, border: [false, false, false, false], margin: [7, 7, 7, 7],
    }]] },
    layout: noBorder,
  };
}

/** A compact label/value stat, for the risk grid. */
const stat = (label: string, value: string, color = INK, sub?: string): any => ({
  stack: [
    { text: label.toUpperCase(), fontSize: 5.9, bold: true, color: MUTED },
    { text: value, fontSize: 10, bold: true, color, margin: [0, 2.5, 0, 0] },
    ...(sub ? [{ text: sub, fontSize: 5.8, color: MUTED, margin: [0, 1.5, 0, 0] }] : []),
  ],
  margin: [0, 0, 0, 0],
});

function bar(pct: number, width: number, color = BRASS): any {
  const w = Math.max(0, Math.min(100, pct)) / 100 * width;
  return {
    canvas: [
      { type: "rect", x: 0, y: 0, w: width, h: 4.5, r: 2.2, color: "#e6dcc2" },
      ...(w > 0.5 ? [{ type: "rect", x: 0, y: 0, w, h: 4.5, r: 2.2, color }] : []),
    ],
    margin: [0, 3, 0, 0],
  };
}

/** Shared table chrome: hairline horizontals only, brass header rule, warm zebra. */
const dataTableLayout = (headerRows = 1) => ({
  hLineWidth: (i: number, node: any) => (i === headerRows ? 0.8 : i === 0 || i === node.table.body.length ? 0 : 0.4),
  hLineColor: (i: number) => (i === headerRows ? BRASS : HAIR),
  vLineWidth: () => 0,
  fillColor: (i: number) => (i < headerRows ? null : (i - headerRows) % 2 === 1 ? ZEBRA : null),
  paddingLeft: () => 3,
  paddingRight: () => 3,
  paddingTop: () => 2.6,
  paddingBottom: () => 2.6,
});

const th = (t: string, align = "left") => ({ text: t.toUpperCase(), fontSize: 5.9, bold: true, color: BRASS_DEEP, alignment: align });
const td = (t: string, align = "left", color = INK, bold = false, size = 7) => ({ text: t, fontSize: size, color, bold, alignment: align });

/** Portfolio / benchmark / excess, one column per period. */
function returnsTable(fs: Factsheet): any {
  if (!fs.returns.length) {
    return { text: "No NAV history yet — run the Price History backfill to populate returns.", fontSize: 7.5, italics: true, color: MUTED };
  }
  const cols = fs.returns.map(r => r.label);
  const row = (label: string, vals: PeriodReturn[], opts: { bold?: boolean; signed?: boolean; color?: boolean } = {}) => [
    { text: label, fontSize: 7, bold: !!opts.bold, color: INK },
    ...vals.map(v => ({
      text: opts.signed ? pcSigned(v.pct) : pc(v.pct),
      fontSize: 7.5, bold: !!opts.bold, alignment: "right",
      color: opts.color ? tone(v.pct) : INK,
    })),
  ];
  return {
    table: {
      headerRows: 1,
      widths: ["*", ...cols.map(() => 58)],
      body: [
        [th(""), ...cols.map(c => th(c, "right"))],
        row("Portfolio (pre-tax NAV)", fs.returns, { bold: true, color: true }),
        row(fs.benchmarkLabel, fs.benchmarkReturns),
        row("Excess", fs.excessReturns, { signed: true, color: true, bold: true }),
      ],
    },
    layout: dataTableLayout(),
  };
}

function holdingsTable(rows: FactsheetHoldingRow[]): any {
  return {
    table: {
      headerRows: 1,
      // Repeat the header on every page the book spills onto.
      widths: [12, "*", 62, 34, 36, 34, 48, 48, 26, 48, 34],
      body: [
        [th("#"), th("Company"), th("Sector"), th("Qty", "right"), th("Avg cost", "right"), th("CMP", "right"),
         th("Invested", "right"), th("Value", "right"), th("Wt", "right"), th("Unreal.", "right"), th("Return", "right")],
        ...rows.map(h => [
          td(String(h.rank), "left", MUTED, false, 6.2),
          {
            stack: [
              { text: h.name + (h.priced ? "" : " †"), fontSize: 6.8, color: INK },
              ...(h.accounts.length ? [{ text: h.accounts.join(" · "), fontSize: 5.4, color: MUTED, margin: [0, 0.8, 0, 0] }] : []),
            ],
          },
          td(h.sector, "left", MUTED, false, 6),
          td(int(h.qty), "right", INK, false, 6.6),
          td(nf(h.avgCost), "right", INK, false, 6.6),
          td(h.cmp === null ? "—" : nf(h.cmp), "right", h.cmp === null ? MUTED : INK, false, 6.6),
          td(money(h.invested), "right", INK, false, 6.6),
          td(money(h.current), "right", INK, true, 6.6),
          td(h.weight.toFixed(1), "right", INK, false, 6.6),
          td(money(h.pnl), "right", tone(h.pnl), false, 6.6),
          td(pcSigned(h.pnlPct, 1), "right", tone(h.pnl), true, 6.6),
        ]),
      ],
    },
    layout: dataTableLayout(),
  };
}

export function buildFactsheetDocDefinition(fs: Factsheet): any {
  const r = fs.risk;

  // ── sector tiles ──────────────────────────────────────────────────────────
  const PER_ROW = 5;
  const tileRows: any[] = [];
  const shown = fs.sectors.slice(0, 15);
  for (let i = 0; i < shown.length; i += PER_ROW) {
    const cells = shown.slice(i, i + PER_ROW).map((s, j) => {
      const t = tint(i + j, shown.length);
      return {
        stack: [
          { text: `${s.weight.toFixed(2)}%`, fontSize: 9, bold: true, color: t.fg },
          { text: s.sector, fontSize: 5.8, color: t.sub, margin: [0, 1.5, 0, 0] },
        ],
        fillColor: t.bg, border: [false, false, false, false], margin: [5, 6, 5, 6],
      };
    });
    while (cells.length < PER_ROW) cells.push({ text: "", border: [false, false, false, false] } as any);
    tileRows.push(cells);
  }

  const content: any[] = [
    // ══ PAGE 1 — OVERVIEW ═════════════════════════════════════════════════
    { canvas: [{ type: "rect", x: 0, y: 0, w: CONTENT_W, h: 5, color: BRASS }] },
    {
      margin: [0, 11, 0, 0],
      columns: [
        {
          width: "*",
          stack: [
            { text: fs.title, fontSize: 17, bold: true, color: BRASS_DEEP },
            { text: `Portfolio Factsheet · as on ${fs.asOf}`, fontSize: 8, color: MUTED, margin: [0, 4, 0, 0] },
          ],
        },
        {
          width: "auto",
          stack: [
            { text: "PRIVATE & CONFIDENTIAL", fontSize: 7, bold: true, color: BRASS, alignment: "right" },
            { text: `${fs.portfolios.length} account${fs.portfolios.length === 1 ? "" : "s"} consolidated`, fontSize: 6.6, color: MUTED, alignment: "right", margin: [0, 4, 0, 0] },
            { text: fs.portfolios.map(p => p.code).join(" · "), fontSize: 6, color: MUTED, alignment: "right", margin: [0, 2, 0, 0] },
          ],
        },
      ],
    },
    { canvas: [{ type: "line", x1: 0, y1: 4, x2: CONTENT_W, y2: 4, lineWidth: 0.7, lineColor: RULE }], margin: [0, 8, 0, 0] },

    {
      margin: [0, 12, 0, 0],
      columns: [
        { width: "*", ...kpi("Assets under management", money(fs.aum), `${fs.companies} companies`) },
        { width: 7, text: "" },
        { width: "*", ...kpi("Invested capital", money(fs.invested), "FIFO, charge-inclusive") },
        { width: 7, text: "" },
        { width: "*", ...kpi("Unrealised gain", money(fs.unrealised), pcSigned(fs.unrealisedPct), { valueColor: tone(fs.unrealised) }) },
        { width: 7, text: "" },
        { width: "*", ...kpi("Pre-tax NAV", fs.navIndex !== null ? nf(fs.navIndex) : "—",
            fs.navReturnPct !== null ? `${pcSigned(fs.navReturnPct)} since ${fs.navBase}` : "no NAV history", { dark: true }) },
      ],
    },

    head("Performance", fs.perfSvg ? `pre-tax NAV vs ${fs.benchmarkLabel}, based at 1000 on ${fs.navBase}` : undefined),
    fs.perfSvg
      ? { svg: fs.perfSvg, width: CONTENT_W }
      : { text: "No NAV history yet — run the Price History backfill to populate this chart.", fontSize: 7.5, italics: true, color: MUTED },

    head("Periodic Returns", "time-weighted, external flows removed"),
    returnsTable(fs),

    head("Risk & Quality", r.sessions ? `${r.sessions} trading sessions` : undefined),
    r.sessions >= 3
      ? {
          table: {
            widths: ["*", "*", "*", "*"],
            body: [
              [
                stat("Annualised volatility", pc(r.annVol, 1)),
                stat("Max drawdown", pc(r.maxDrawdown, 1), tone(r.maxDrawdown), `${r.maxDdPeak} → ${r.maxDdTrough}`),
                stat("Positive sessions", pc(r.positivePct, 0)),
                stat("Currently", r.inDrawdown ? "Below prior peak" : "At/near peak", r.inDrawdown ? NEG : POS),
              ],
              [
                stat("Best session", pcSigned(r.bestSession), POS, r.bestSessionDate),
                stat("Worst session", pcSigned(r.worstSession), NEG, r.worstSessionDate),
                stat("Beta vs benchmark", numOr(r.beta), INK, r.correlation !== null ? `correlation ${numOr(r.correlation)}` : undefined),
                stat("Tracking error", pc(r.trackingError, 1), INK, "annualised"),
              ],
            ],
          },
          layout: {
            hLineWidth: (i: number) => (i === 1 ? 0.4 : 0),
            hLineColor: () => HAIR,
            vLineWidth: () => 0,
            paddingLeft: () => 0, paddingRight: () => 8, paddingTop: () => 6, paddingBottom: () => 6,
          },
        }
      : { text: "Not enough NAV history to compute risk statistics.", fontSize: 7.5, italics: true, color: MUTED },

    // ══ PAGE 2 — COMPOSITION ══════════════════════════════════════════════
    { text: "", pageBreak: "after" },
    head("Sector Allocation", fs.sectors.length ? `${fs.sectors.length} sectors · % of market value` : undefined),
    fs.sectors.length
      ? {
          stack: [
            { table: { widths: Array(PER_ROW).fill("*"), body: tileRows },
              layout: { defaultBorder: false, paddingLeft: () => 1.5, paddingRight: () => 1.5, paddingTop: () => 1.5, paddingBottom: () => 1.5 } },
            {
              margin: [0, 10, 0, 0],
              table: {
                headerRows: 1,
                widths: ["*", 34, 62, 62, 34, 44],
                body: [
                  [th("Sector"), th("Cos", "right"), th("Invested", "right"), th("Market value", "right"), th("Wt", "right"), th("Return", "right")],
                  ...fs.sectors.map(s => [
                    td(s.sector, "left", s.sector === "Unclassified" ? MUTED : INK),
                    td(String(s.companies), "right"),
                    td(money(s.invested), "right"),
                    td(money(s.current), "right", INK, true),
                    td(s.weight.toFixed(2), "right"),
                    td(pcSigned(s.pnlPct, 1), "right", tone(s.pnlPct), true),
                  ]),
                ],
              },
              layout: dataTableLayout(),
            },
          ],
        }
      : { text: "No sector data on file — import a screener CSV to populate industries.", fontSize: 7.5, italics: true, color: MUTED },

    head("Deployment", "invested cost vs market value"),
    fs.aumSvg
      ? { svg: fs.aumSvg, width: CONTENT_W }
      : { text: "No market-value history yet.", fontSize: 7.5, italics: true, color: MUTED },

    { text: "", pageBreak: "after" },
    head("Concentration"),
    {
      columns: [
        {
          width: "*",
          stack: [
            ...[["Top 5", fs.concentration.top5], ["Top 10", fs.concentration.top10],
                ["Top 20", fs.concentration.top20], ["Top 30", fs.concentration.top30]].flatMap(([l, v]) => [
              { margin: [0, 5, 0, 0], columns: [
                { text: l as string, fontSize: 7, color: INK, width: "*" },
                { text: `${(v as number).toFixed(2)}%`, fontSize: 7, bold: true, color: INK, width: "auto" },
              ] },
              bar(v as number, 232),
            ]),
          ],
        },
        { width: 14, text: "" },
        {
          width: "*",
          ...(() => ({
            table: { widths: ["*"], body: [[{
              stack: [
                stat("Herfindahl index", fs.concentration.hhi.toFixed(0), INK, "Σ of squared weights, 0–10,000"),
                { text: "", margin: [0, 7, 0, 0] },
                stat("Effective holdings", fs.concentration.effectiveN.toFixed(1), INK,
                     `behaves like ${fs.concentration.effectiveN.toFixed(0)} equal positions out of ${fs.companies}`),
                { text: "", margin: [0, 7, 0, 0] },
                stat("Market-priced value", pc(fs.pricedPct), INK, fs.unpricedCount ? `${fs.unpricedCount} position(s) at cost` : "every position priced"),
              ],
              fillColor: PANEL, border: [false, false, false, false], margin: [9, 9, 9, 9],
            }]] },
            layout: noBorder,
          }))(),
        },
      ],
    },

    head("By Account", `${fs.portfolioRows.length} account${fs.portfolioRows.length === 1 ? "" : "s"} holding stock`),
    fs.portfolioRows.length
      ? {
          table: {
            headerRows: 1,
            widths: [44, "*", 34, 62, 62, 34, 44],
            body: [
              [th("Code"), th("Account"), th("Cos", "right"), th("Invested", "right"), th("Market value", "right"), th("Wt", "right"), th("Return", "right")],
              ...fs.portfolioRows.map(p => [
                td(p.code, "left", BRASS_DEEP, true),
                td(p.label),
                td(String(p.companies), "right"),
                td(money(p.invested), "right"),
                td(money(p.current), "right", INK, true),
                td(p.weight.toFixed(2), "right"),
                td(pcSigned(p.pnlPct, 1), "right", tone(p.pnlPct), true),
              ]),
            ],
          },
          layout: dataTableLayout(),
        }
      : { text: "No accounts hold stock.", fontSize: 7.5, italics: true, color: MUTED },

    // ══ PAGE 3 — THE BOOK ═════════════════════════════════════════════════
    { text: "", pageBreak: "after" },
    head("Holdings", `all ${fs.holdings.length} open positions, by market value`),
    fs.holdings.length
      ? holdingsTable(fs.holdings)
      : { text: "No open positions.", fontSize: 7.5, italics: true, color: MUTED },
    fs.unpricedCount
      ? { text: `†  valued at cost — no market price on file.`, fontSize: 6, italics: true, color: MUTED, margin: [0, 6, 0, 0] }
      : { text: "" },

    // ══ PAGE 4 — BASIS ════════════════════════════════════════════════════
    { text: "", pageBreak: "after" },
    head("Data Quality Register", "what these figures are missing"),
    {
      table: {
        headerRows: 1,
        widths: [150, 40, "*"],
        body: [
          [th("Check"), th("Count", "right"), th("Detail")],
          [td("Positions valued at cost"), td(String(fs.unpricedCount), "right", tone(fs.unpricedCount ? -1 : 1), true),
           td(fs.unpricedNames.slice(0, 6).join(", ") + (fs.unpricedNames.length > 6 ? ` +${fs.unpricedNames.length - 6} more` : "") || "—", "left", MUTED, false, 6.4)],
          [td("Negative net quantity"), td(String(fs.discrepancies.length), "right", tone(fs.discrepancies.length ? -1 : 1), true),
           td(fs.discrepancies.map(d => `${d.name} (${int(d.qty)})`).join(", ") || "none — every position reconciles", "left", MUTED, false, 6.4)],
          [td("Scrips with no price history"), td(String(fs.noHistoryNames.length), "right", tone(fs.noHistoryNames.length ? -1 : 1), true),
           td(fs.noHistoryNames.slice(0, 6).join(", ") + (fs.noHistoryNames.length > 6 ? ` +${fs.noHistoryNames.length - 6} more` : "") || "none", "left", MUTED, false, 6.4)],
          [td("Companies without a sector"), td(String(fs.unclassifiedCompanies), "right", tone(fs.unclassifiedCompanies ? -1 : 1), true),
           td(fs.unclassifiedCompanies ? "grouped as Unclassified in the sector table" : "every company classified", "left", MUTED, false, 6.4)],
          [td("Sessions under 98% priced"), td(String(fs.lowCoverageSessions), "right", tone(fs.lowCoverageSessions ? -1 : 1), true),
           td(fs.lowCoverageSessions ? "NAV on those sessions is partial" : "full coverage throughout", "left", MUTED, false, 6.4)],
        ],
      },
      layout: dataTableLayout(),
    },

    head("Basis & Methodology"),
    {
      stack: fs.caveats.map(c => ({
        columns: [
          { canvas: [{ type: "rect", x: 0, y: 2.5, w: 2.5, h: 2.5, color: BRASS }], width: 9 },
          { text: c, fontSize: 7, color: MUTED, width: "*", lineHeight: 1.25 },
        ],
        margin: [0, 2.5, 0, 2.5],
      })),
    },

    head("Accounts Included"),
    {
      table: {
        headerRows: 1,
        widths: [60, "*"],
        body: [
          [th("Code"), th("Account")],
          ...fs.portfolios.map(p => [td(p.code, "left", BRASS_DEEP, true), td(p.label)]),
        ],
      },
      layout: dataTableLayout(),
    },
    {
      margin: [0, 16, 0, 0],
      text: "This document is generated from the portfolio's own trade ledgers and is for internal review. It is not an offer, a solicitation, or investment advice, and it has not been audited.",
      fontSize: 6.4, italics: true, color: MUTED,
    },
  ];

  return {
    pageSize: "A4",
    pageOrientation: "portrait",
    pageMargins: [MARGIN, MARGIN, MARGIN, 30],
    defaultStyle: { font: "Roboto", fontSize: 8, color: INK, lineHeight: 1.15 },
    info: { title: `${fs.title} — Portfolio Factsheet ${fs.asOf}`, author: fs.title, subject: "Portfolio Factsheet" },
    // The parchment ground: pdfmake pages are white, so the theme is painted per page.
    background: () => ({ canvas: [{ type: "rect", x: 0, y: 0, w: A4_W, h: A4_H, color: PAPER }] }),
    content,
    footer: (currentPage: number, pageCount: number) => ({
      margin: [MARGIN, 8, MARGIN, 0],
      columns: [
        { text: `${fs.title} · as on ${fs.asOf}`, fontSize: 6, color: MUTED },
        { text: "PRIVATE & CONFIDENTIAL", fontSize: 6, color: MUTED, alignment: "center" },
        { text: `${currentPage} / ${pageCount}`, fontSize: 6, color: MUTED, alignment: "right" },
      ],
    }),
  };
}

export async function downloadFactsheetPdf(fs: Factsheet): Promise<void> {
  const [pdfMod, vfsMod] = await Promise.all([
    import("pdfmake/build/pdfmake"),
    import("pdfmake/build/vfs_fonts"),
  ]);
  const pdfMake: any = (pdfMod as any)?.default ?? pdfMod;
  const vfsRaw: any = (vfsMod as any)?.default ?? vfsMod;
  const vfs = vfsRaw?.vfs ?? vfsRaw;
  if (typeof pdfMake.addVirtualFileSystem === "function") pdfMake.addVirtualFileSystem(vfs);
  else pdfMake.vfs = vfs;

  const blob: Blob = await pdfMake.createPdf(buildFactsheetDocDefinition(fs)).getBlob();
  downloadBlob(blob, `Factsheet_${fileSafe(fs.title)}_${fs.asOf.replace(/-/g, "")}.pdf`);
}
