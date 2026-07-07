/**
 * Table-preserving row virtualization.
 *
 * react-window's FixedSizeList renders <div> rows, which would break these
 * multi-column financial tables (auto-sized columns, sticky sortable headers,
 * per-column colours/alignment). This hook gives the same "only render the
 * visible rows" behaviour while keeping a real <table>: the body renders a
 * top spacer <tr>, the visible slice, then a bottom spacer <tr>, all inside an
 * overflow-y scroll container.
 *
 * Usage:
 *   const v = useVirtualRows(rows.length, { estimatedRowHeight: 56 });
 *   <div ref={v.scrollRef} onScroll={v.onScroll} className="max-h-[70vh] overflow-auto">
 *     <table>
 *       <thead className="sticky top-0">…</thead>
 *       <tbody>
 *         {v.padTop > 0 && <tr aria-hidden><td colSpan={99} style={{height: v.padTop, padding:0, border:0}}/></tr>}
 *         {rows.slice(v.start, v.end).map((r, i) => (
 *           <tr key={…} ref={i === 0 ? v.measureRow : undefined}>…</tr>
 *         ))}
 *         {v.padBottom > 0 && <tr aria-hidden><td colSpan={99} style={{height: v.padBottom, padding:0, border:0}}/></tr>}
 *       </tbody>
 *     </table>
 *   </div>
 *
 * Pass count = 0 to disable (e.g. below a virtualization threshold) — start/end
 * then cover nothing and padTop/padBottom are 0, so callers can branch on a flag.
 */
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface VirtualRowsOptions {
  estimatedRowHeight?: number;
  overscan?: number;
  /** Fallback viewport height (px) before the container is measured. */
  viewportFallback?: number;
}

export interface VirtualRows {
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** Callback ref to attach to the first rendered data row — self-corrects rowHeight. */
  measureRow: (node: HTMLTableRowElement | null) => void;
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  rowHeight: number;
}

export function useVirtualRows(count: number, opts: VirtualRowsOptions = {}): VirtualRows {
  const { estimatedRowHeight = 48, overscan = 12, viewportFallback = 640 } = opts;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [rowHeight, setRowHeight] = useState(estimatedRowHeight);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(viewportFallback);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewport(el.clientHeight || viewportFallback);
  }, [viewportFallback]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) setViewport(el.clientHeight || viewportFallback);
  }, [count, viewportFallback]);

  // Measure the real height of a rendered row and self-correct the estimate so
  // the spacer math stays accurate regardless of styling.
  const measureRow = useCallback((node: HTMLTableRowElement | null) => {
    if (!node) return;
    const h = node.getBoundingClientRect().height;
    if (h > 0 && Math.abs(h - rowHeight) > 1) setRowHeight(h);
  }, [rowHeight]);

  if (count <= 0) {
    return { scrollRef, onScroll, measureRow, start: 0, end: 0, padTop: 0, padBottom: 0, rowHeight };
  }

  const visibleCount = Math.max(1, Math.ceil(viewport / rowHeight));
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, start + visibleCount + overscan * 2);
  const padTop = start * rowHeight;
  const padBottom = Math.max(0, (count - end) * rowHeight);

  return { scrollRef, onScroll, measureRow, start, end, padTop, padBottom, rowHeight };
}
