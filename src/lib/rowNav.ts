/**
 * Keyboard navigation for a list or table of rows — the roving-tabindex pattern.
 *
 * WHY THIS EXISTS: every control in this app is a real `<button>`, so Tab already reaches all of
 * them. What Tab cannot do is a 300-row holdings grid: one tab stop per row means 300 presses to
 * get past the table. So a row list gets exactly ONE tab stop — the active row — and ↑↓ move
 * between rows once you are inside. Tab enters once and leaves once.
 *
 * The KEY MAPPING is pure and lives here (`rowNavIntent`) rather than inside a component, because
 * it is the part with edge cases: clamping at the ends, an empty list, a list that shrank under a
 * filter. `useRowNav` is the thin DOM/React glue over it.
 *
 * Three tables use this (the holdings grid, the all-holdings table, the trade book) plus the
 * portfolio cards. One module rather than four copies, for the reason `SHORTCUTS` is a registry:
 * four copies of a key mapping drift, and the drift is silent.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, MutableRefObject } from "react";

/** Marks a row as navigable. Also how `focusFirstRow` finds rows with no component coupling. */
export const ROW_NAV_ATTR = "data-rownav";

/** PageUp / PageDown jump. Not a screenful — a screenful depends on row height and zoom, and
 *  a fixed, predictable jump is easier to build a habit around than a measured one. */
export const PAGE_ROWS = 10;

export type RowNavIntent =
  | { kind: "move"; to: number }
  | { kind: "activate" }
  | { kind: "none" };

/**
 * Which row should a keypress land on?
 *
 * Ends CLAMP rather than wrap. In a 300-row grid, one ArrowDown teleporting from the last row to
 * the first reads as a bug rather than a feature, and there is no way to tell it apart from a
 * mis-tracked index.
 *
 * `Space` is deliberately NOT activate. On a row it is ambiguous — the trade book uses it to
 * toggle selection — and every browser treats it as page-down, so silently stealing it everywhere
 * is worse than leaving it to the table that has a use for it.
 */
export function rowNavIntent(key: string, current: number, count: number): RowNavIntent {
  if (count <= 0) return { kind: "none" };
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  switch (key) {
    case "ArrowDown": return { kind: "move", to: clamp(current + 1) };
    case "ArrowUp": return { kind: "move", to: clamp(current - 1) };
    case "PageDown": return { kind: "move", to: clamp(current + PAGE_ROWS) };
    case "PageUp": return { kind: "move", to: clamp(current - PAGE_ROWS) };
    case "Home": return { kind: "move", to: 0 };
    case "End": return { kind: "move", to: count - 1 };
    case "Enter": return { kind: "activate" };
    default: return { kind: "none" };
  }
}

/** Props to spread on a row element. */
export interface RowNavProps {
  tabIndex: number;
  onKeyDown: (e: KeyboardEvent) => void;
  onFocus: (e: FocusEvent) => void;
  [ROW_NAV_ATTR]: string;
}

/** Per-row opt-ins. */
export interface RowPropsOptions {
  /** Treat Space like Enter. For a CARD, which has no competing use for it - NOT for a table row,
   *  where Space is page-down by habit and the trade book needs it for selection. */
  activateOnSpace?: boolean;
}

export interface RowNav {
  /** Put this on the element that CONTAINS the rows (`<tbody>`, or the cards' wrapper). */
  containerRef: MutableRefObject<HTMLElement | null>;
  /** Index of the row holding the single tab stop. Use it for an "active row" highlight. */
  active: number;
  rowProps: (index: number, opts?: RowPropsOptions) => RowNavProps;
  /** Move focus to a row and make it the tab stop. */
  focusIndex: (index: number) => void;
}

/**
 * `count` is the number of rows currently rendered; `onActivate` is Enter on a row.
 *
 * The active index is kept honest by `onFocus` rather than only by our own key handling, so
 * Shift+Tabbing in from below, or the `l` shortcut jumping to the first row, cannot leave `active`
 * pointing at a row that is not the focused one — after which the next ArrowDown would jump.
 */
export function useRowNav(count: number, onActivate: (index: number) => void): RowNav {
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLElement | null>(null);

  // A filter or a sort can shrink the list under us. Without this the tab stop can end up on no
  // row at all — `tabIndex === active` never matches — and the table becomes unreachable by Tab.
  useEffect(() => {
    setActive((a) => (count <= 0 ? 0 : Math.min(a, count - 1)));
  }, [count]);

  const rowEls = useCallback(
    (): HTMLElement[] =>
      Array.from(containerRef.current?.querySelectorAll<HTMLElement>(`[${ROW_NAV_ATTR}]`) ?? []),
    []
  );

  const focusIndex = useCallback((index: number) => {
    const rows = rowEls();
    if (rows.length === 0) return;
    // Read the length off the DOM, not off `count`: they disagree for a render in flight, and
    // focusing past the end would throw away the keypress silently.
    const j = Math.max(0, Math.min(rows.length - 1, index));
    setActive(j);
    rows[j].focus();
    // `nearest` so a row already on screen does not scroll, and a sticky header does not get
    // jumped over. Plain .focus() scrolling is what makes keyboard grids feel jittery.
    rows[j].scrollIntoView({ block: "nearest" });
  }, [rowEls]);

  const rowProps = useCallback(
    (index: number, opts?: RowPropsOptions): RowNavProps => ({
      tabIndex: index === active ? 0 : -1,
      [ROW_NAV_ATTR]: "",
      // Keeps `active` truthful however focus arrived — Tab, Shift+Tab, a click, or `l`.
      onFocus: (e) => { if (e.target === e.currentTarget) setActive(index); },
      onKeyDown: (e) => {
        // Only when the ROW itself has focus. React's onKeyDown bubbles, so without this an
        // ArrowUp inside a row's number input or <select> would change the value AND move rows.
        if (e.target !== e.currentTarget) return;
        // A modifier means the browser or OS is being addressed (Cmd+↓ = end of document).
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        if (opts?.activateOnSpace && e.key === ' ') { e.preventDefault(); onActivate(index); return; }
        const intent = rowNavIntent(e.key, index, count);
        if (intent.kind === "none") return;
        e.preventDefault();   // ↑↓ must not also scroll the page
        if (intent.kind === "activate") { onActivate(index); return; }
        focusIndex(intent.to);
      },
    }),
    [active, count, onActivate, focusIndex]
  );

  return { containerRef, active, rowProps, focusIndex };
}

/**
 * Focus the first navigable row anywhere in the document — what the `l` shortcut runs.
 *
 * Deliberately a DOM query rather than a message to whichever table is mounted: only the mounted
 * view has these attributes, so this needs no registry, no event and no coordination between
 * App and the three tables. Each hook's `onFocus` then syncs its own `active`, so the tab stop
 * and the focused row agree afterwards.
 *
 * Returns whether anything was focused, so a caller can fall back (e.g. navigate first).
 */
export function focusFirstRow(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.querySelector<HTMLElement>(`[${ROW_NAV_ATTR}]`);
  if (!el) return false;
  el.focus();
  el.scrollIntoView({ block: "nearest" });
  return true;
}
