/**
 * PDF renderer for a ReportDoc — the "brass letterhead" statement layout.
 *
 * Why pdfmake rather than jsPDF: the standard PDF fonts are WinAnsi-encoded and U+20B9 (₹)
 * is NOT in WinAnsi, so jsPDF renders a rupee sign as garbage unless you hand-embed a font.
 * pdfmake ships Roboto embedded, and Roboto carries ₹ (verified: glyph id 442 in all four
 * weights it bundles). It is also declarative, and repeats table header rows across page
 * breaks for free — which a multi-page ledger needs.
 *
 * Roboto does NOT carry box-drawing characters or U+2713 (✓), so every rule and band in this
 * layout is drawn with pdfmake's canvas/table fills, never with characters.
 *
 * `buildPdfDocDefinition` is deliberately pure: it takes a ReportDoc and returns a plain
 * document definition, so the layout can be exercised in Node against real pdfmake without a
 * browser.
 */
import type { ReportDoc, ReportCol } from './reportDoc';
import { formatCell, isNumericType, toNum, downloadBlob } from './reportDoc';
import { formatDMYTime } from './dates';

const BRASS = '#8a6a1e';
const BRASS_DEEP = '#6d5417';
const INK = '#2f2a1f';
const MUTED = '#6b6252';
const HAIRLINE = '#e0d7bf';
const ZEBRA = '#faf7ef';
const TOTAL_BG = '#f3eddd';
const NEGATIVE = '#a3341f';

/** A4 in points, less the horizontal margins. */
const PAGE_W = { portrait: 595.28, landscape: 841.89 };
const MARGIN_X = 28;

/** Smaller type as the table gets wider, so a broad ledger still fits the page. */
const fontSizeFor = (ncols: number) => (ncols >= 18 ? 6 : ncols >= 14 ? 6.5 : ncols >= 10 ? 7 : 8);

/**
 * Horizontal cell padding, per side. Declared once because the width maths below MUST subtract
 * it: pdfmake's `widths` are CONTENT widths and padding is added outside them, so distributing
 * the full content width across the columns overflows the page by exactly the total padding —
 * and pdfmake clips the rightmost column rather than complaining. That silently ate the P&L
 * column (header and all) until this was accounted for.
 */
const CELL_PAD_X = 4;

/**
 * Proportional column widths in points, weighted by the widest content in each column and
 * normalised to the available width. Fixed 'auto' widths would silently overflow the page on
 * the wider tabs (the transaction ledger runs to ~20 columns).
 */
function columnWidths(doc: ReportDoc, contentWidth: number): number[] {
  // What's left for cell CONTENT once every column's padding is reserved.
  const available = Math.max(40, contentWidth - doc.cols.length * CELL_PAD_X * 2);
  const measures = doc.cols.map(col => {
    let widest = col.label.length;
    for (const row of doc.rows) {
      const len = formatCell(col, row.cells[col.key]).length;
      if (len > widest) widest = len;
    }
    // Text columns get a little slack to wrap into; numbers never wrap.
    return Math.min(widest, isNumericType(col.type) ? 16 : 30) + 2;
  });
  const total = measures.reduce((s, m) => s + m, 0) || 1;
  const MIN = Math.min(22, available / doc.cols.length);
  let widths = measures.map(m => Math.max(MIN, (available * m) / total));
  // Re-normalise after the minimum clamp so the row still spans exactly the available width.
  const sum = widths.reduce((s, w) => s + w, 0);
  if (sum > available) widths = widths.map(w => (w * available) / sum);
  return widths;
}

export interface PdfOptions {
  /** Injected so the generated stamp is deterministic in tests. */
  now?: Date;
}

export function buildPdfDocDefinition(doc: ReportDoc, opts: PdfOptions = {}): any {
  const now = opts.now ?? new Date();
  const orientation = doc.landscape ? 'landscape' : 'portrait';
  const contentWidth = PAGE_W[orientation] - MARGIN_X * 2;
  const fontSize = fontSizeFor(doc.cols.length);
  const widths = columnWidths(doc, contentWidth);

  const stamp = formatDMYTime(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ` +
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
  );

  // ── table body ───────────────────────────────────────────────────────────────
  const headerCells = doc.cols.map(col => ({
    text: col.label.toUpperCase(),
    bold: true,
    color: '#ffffff',
    fontSize: fontSize - 0.5,
    alignment: isNumericType(col.type) ? 'right' : 'left',
  }));

  const totalRowIdx = new Set<number>();
  const bodyCells = doc.rows.map((row, j) => {
    if (row.total) totalRowIdx.add(j + 1);                // +1: table row 0 is the header
    return doc.cols.map((col: ReportCol) => {
      const text = formatCell(col, row.cells[col.key]);
      const n = isNumericType(col.type) ? toNum(row.cells[col.key]) : null;
      return {
        text,
        fontSize,
        bold: !!row.total,
        // A negative amount is already bracketed; the colour is the second, faster signal.
        color: n !== null && n < 0 ? NEGATIVE : INK,
        alignment: isNumericType(col.type) ? 'right' : (col.type === 'date' ? 'center' : 'left'),
      };
    });
  });

  // Banding runs over DATA rows only, so an interleaved total row doesn't shift the stripes.
  const zebraRows = new Set<number>();
  {
    let dataSeen = 0;
    for (let i = 1; i <= doc.rows.length; i++) {
      if (totalRowIdx.has(i)) continue;
      if (++dataSeen % 2 === 0) zebraRows.add(i);
    }
  }

  const table = {
    table: {
      headerRows: 1,
      widths,
      body: [headerCells, ...bodyCells],
    },
    layout: {
      // No vertical rules at all — the single strongest cue that this is a statement and
      // not a spreadsheet screenshot.
      vLineWidth: () => 0,
      hLineWidth: (i: number, node: any) => {
        if (i === 0) return 0;
        if (i === 1) return 0.9;                          // under the header band
        if (i === node.table.body.length) return 0.9;     // table foot
        return totalRowIdx.has(i) ? 0.9 : 0.35;           // above a total row, else hairline
      },
      hLineColor: (i: number, node: any) =>
        (i === 1 || i === node.table.body.length || totalRowIdx.has(i) ? BRASS : HAIRLINE),
      // Precomputed, NOT counted per cell: pdfmake calls fillColor once per cell, so counting
      // preceding rows here would be O(rows² × cols) — minutes of work on a long ledger.
      fillColor: (rowIndex: number) =>
        rowIndex === 0 ? BRASS
          : totalRowIdx.has(rowIndex) ? TOTAL_BG
          : zebraRows.has(rowIndex) ? ZEBRA
          : null,
      paddingLeft: () => CELL_PAD_X,
      paddingRight: () => CELL_PAD_X,
      paddingTop: () => 3,
      paddingBottom: () => 3,
    },
  };

  // ── page-1 letterhead ────────────────────────────────────────────────────────
  // A narrowed report must identify itself on EVERY page, not only on the letterhead: a
  // capital-gains statement is printed, split, and filed page by page, and pages 2+ carry
  // nothing but the running header. Without this, an equity-only statement is indistinguishable
  // from a consolidated one from page 2 onward.
  const titled = doc.titleTag ? `${doc.title} — ${doc.titleTag}` : doc.title;

  const letterhead: any[] = [
    { canvas: [{ type: 'rect', x: 0, y: 0, w: contentWidth, h: 7, color: BRASS }] },
    { text: doc.holder, color: BRASS_DEEP, bold: true, fontSize: 16, margin: [0, 10, 0, 0] },
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 120, y2: 0, lineWidth: 1.6, lineColor: BRASS }], margin: [0, 3, 0, 0] },
    { text: titled, color: INK, bold: true, fontSize: 11.5, margin: [0, 7, 0, 0] },
  ];

  if (doc.params.length) {
    letterhead.push({
      margin: [0, 9, 0, 0],
      table: {
        widths: ['auto', '*'],
        body: doc.params.map(([label, value]) => [
          { text: label.toUpperCase(), color: MUTED, bold: true, fontSize: 7.5, margin: [0, 0, 10, 0] },
          { text: value, color: INK, fontSize: 8.5 },
        ]),
      },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 1.5,
        paddingBottom: () => 1.5,
      },
    });
  }

  const content: any[] = [...letterhead, { text: '', margin: [0, 0, 0, 10] }, table];

  if (doc.footnotes?.length) {
    content.push({
      margin: [0, 10, 0, 0],
      stack: doc.footnotes.map(n => ({ text: n, fontSize: 7, italics: true, color: MUTED, margin: [0, 1, 0, 0] })),
    });
  }

  return {
    pageSize: 'A4',
    pageOrientation: orientation,
    // Top margin leaves room for the running header that pages 2+ carry.
    pageMargins: [MARGIN_X, 34, MARGIN_X, 34],
    defaultStyle: { font: 'Roboto', fontSize, color: INK, lineHeight: 1.12 },
    // What a document manager indexes, and what survives the file being renamed.
    info: { title: `${titled} — ${doc.holder}`, author: doc.holder, subject: titled },
    content,

    // Page 1 carries the full letterhead in its content, so the running header starts at 2.
    header: (currentPage: number) =>
      currentPage === 1
        ? null
        : {
            margin: [MARGIN_X, 14, MARGIN_X, 0],
            columns: [
              { text: doc.holder, bold: true, fontSize: 8, color: BRASS_DEEP },
              { text: titled, fontSize: 8, color: MUTED, alignment: 'right' },
            ],
          },

    footer: (currentPage: number, pageCount: number) => ({
      margin: [MARGIN_X, 8, MARGIN_X, 0],
      columns: [
        { text: `Generated ${stamp}`, fontSize: 7, color: MUTED },
        { text: `Page ${currentPage} of ${pageCount}`, fontSize: 7, color: MUTED, alignment: 'right' },
      ],
    }),
  };
}

export async function downloadPdf(doc: ReportDoc): Promise<void> {
  // Loaded on demand — pdfmake plus its embedded fonts is ~1.5 MB.
  const [pdfMod, vfsMod] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ]);
  const pdfMake: any = (pdfMod as any)?.default ?? pdfMod;
  const vfsRaw: any = (vfsMod as any)?.default ?? vfsMod;

  // pdfmake 0.3 prefers addVirtualFileSystem(); older shapes assigned .vfs directly.
  const vfs = vfsRaw?.vfs ?? vfsRaw;
  if (typeof pdfMake.addVirtualFileSystem === 'function') pdfMake.addVirtualFileSystem(vfs);
  else pdfMake.vfs = vfs;

  // pdfmake 0.3 returns a Promise from getBlob() — the 0.2 callback form never fires.
  const blob: Blob = await pdfMake.createPdf(buildPdfDocDefinition(doc)).getBlob();
  downloadBlob(blob, `${doc.filenameBase}.pdf`);
}
