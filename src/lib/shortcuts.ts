/**
 * Global keyboard shortcuts — the single registry, and the one listener that runs them.
 *
 * `SHORTCUTS` is the source of truth for BOTH the key handler and the `?` help overlay, so the
 * two cannot drift: a shortcut that works but is undocumented, or documented but dead, is not
 * expressible. Same reason `ASSET_CLASSES` is a registry rather than a set of branches.
 *
 * Scheme: SINGLE LETTERS, chosen deliberately over Ctrl/Cmd combos. The browser owns Ctrl+T, W,
 * N, P, F, D and L — every one of which is a view in this app — so a modifier scheme would have
 * forced second-choice keys on the four most-used destinations.
 *
 * What is deliberately NOT bound: Rebuild Holding, Sync Capital Gains, Generate Capital Gains
 * register, and Transfer. All four WRITE TO GOOGLE SHEETS, and a stray keypress must never start
 * a sheet write. They stay click-only. Nothing in this file can mutate a book.
 */

/** Everything a shortcut can ask the app to do. Adding one is a compile error until it is
 *  handled — the `run` switch in App.tsx is typed on this union. */
export type ShortcutAction =
  | "goDashboard"
  | "goPortfolios"
  | "goImports"
  | "goReports"
  | "goSettings"
  | "openSwitcher"
  | "focusSearch"
  | "addTrade"
  | "toggleTheme"
  | "toggleDrawer"
  | "showHelp";

export interface Shortcut {
  /** The key as `KeyboardEvent.key`, lower-cased for letters. First entry is the one shown. */
  keys: string[];
  action: ShortcutAction;
  /** Shown in the help overlay. */
  label: string;
  /** One line of "what actually happens", including the awkward cases. */
  hint: string;
  group: "Go to" | "Find" | "Do" | "App";
}

export const SHORTCUTS: Shortcut[] = [
  { keys: ["d"], action: "goDashboard", group: "Go to", label: "Dashboard", hint: "The executive dashboard." },
  { keys: ["p"], action: "goPortfolios", group: "Go to", label: "Portfolios", hint: "The portfolio cards, biggest book first." },
  { keys: ["i"], action: "goImports", group: "Go to", label: "Imports", hint: "Broker note imports and the import log." },
  { keys: ["r"], action: "goReports", group: "Go to", label: "Reports", hint: "Reports, unscoped — clears any stock focus." },
  { keys: ["s"], action: "goSettings", group: "Go to", label: "Settings", hint: "Appearance and account." },

  {
    keys: ["k"], action: "openSwitcher", group: "Find", label: "Switch portfolio",
    hint: "Type a name, code or broker; Enter opens it. Twelve accounts, so this beats numbering them.",
  },
  {
    keys: ["/"], action: "focusSearch", group: "Find", label: "Search holdings",
    hint: "Jumps into the holdings filter. That box lives INSIDE a portfolio, so this opens the current one first if you are not already in it.",
  },

  {
    keys: ["a"], action: "addTrade", group: "Do", label: "Add trade",
    hint: "Opens the Add Trade drawer, which carries its own portfolio picker — so it works from anywhere.",
  },
  { keys: ["t"], action: "toggleTheme", group: "Do", label: "Light / dark", hint: "The theme toggle now lives in Settings; this reaches it from any view." },

  { keys: ["m"], action: "toggleDrawer", group: "App", label: "Navigation drawer", hint: "Same drawer as the hamburger button." },
  { keys: ["?"], action: "showHelp", group: "App", label: "This help", hint: "Esc closes it, and closes whatever else is topmost." },
];

/** Registry order, grouped — what the help overlay renders. */
export const SHORTCUT_GROUPS: Shortcut["group"][] = ["Go to", "Find", "Do", "App"];

/** Display form of a key: `/` and `?` stay literal, letters are upper-cased. */
export const keyLabel = (k: string): string => (k.length === 1 && /[a-z]/.test(k) ? k.toUpperCase() : k);

/**
 * Is the user typing? A shortcut must never steal a keystroke from a field.
 *
 * Checked on the EVENT TARGET rather than `document.activeElement` so it is right even when
 * focus moved during the same tick. `isContentEditable` covers the rich-text case; `select` is
 * included because a native dropdown uses letter keys to jump between options, and `P` silently
 * navigating away mid-selection would be the worst of the bunch.
 */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || !!el.isContentEditable;
}

/**
 * Install the global listener. Returns an unsubscribe, for React's cleanup.
 *
 * `run` gets the action; every bit of state a shortcut touches is owned by App, so this file
 * stays free of app state and can be tested on its own.
 *
 * Escape is NOT handled here. Four components already own an Escape each (the Nuvama menu,
 * ExportMenu, the Holdings actions menu and the inline CMP edit) and they listen on `document`
 * too — a fifth global handler would fire alongside them and close two things with one press.
 * Escape stays with whoever opened the thing.
 */
export function installShortcuts(run: (action: ShortcutAction) => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    // A modifier means the user is asking the BROWSER or the OS for something (Ctrl+R, Cmd+D,
    // Alt+Left). Never shadow that. Shift is allowed through only because "?" needs it.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.defaultPrevented) return;
    if (isTypingTarget(e.target)) return;

    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const hit = SHORTCUTS.find((s) => s.keys.includes(k) || s.keys.includes(e.key));
    if (!hit) return;

    // Only now — so a key we do not own keeps its default behaviour, and browser find ("/") in
    // Firefox still works everywhere except where we deliberately take it.
    e.preventDefault();
    run(hit.action);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/**
 * A shortcut whose state lives in `Holdings` rather than `App` — the holdings filter and the Add
 * Trade drawer. A one-line DOM event beats lifting that state into App: the alternative was
 * hoisting `showAddTrade`, `searchTerm`, `isDetailView` and the active portfolio up a level and
 * threading them back down, which is a refactor of the largest component in the app for two
 * keystrokes.
 */
export const SHORTCUT_EVENT = "backoffice:shortcut";
export function emitShortcut(action: ShortcutAction): void {
  window.dispatchEvent(new CustomEvent(SHORTCUT_EVENT, { detail: action }));
}
/** Subscribe to the actions App forwards. Returns an unsubscribe. */
export function onShortcut(fn: (action: ShortcutAction) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent).detail as ShortcutAction);
  window.addEventListener(SHORTCUT_EVENT, h);
  return () => window.removeEventListener(SHORTCUT_EVENT, h);
}

/** The id the holdings filter input carries, so `/` can focus it without a ref through App. */
export const HOLDINGS_SEARCH_ID = "holdings-search";
