/**
 * Shared overlay primitives — the behavioural layer every dialog should sit on,
 * plus a styled replacement for the blocking `window.confirm()` / `alert()` calls.
 *
 *   <ModalShell>      backdrop + focus trap + Esc-to-close + return-focus + aria
 *   useConfirm()      promise-based confirm:  if (await confirm({...})) { … }
 *   confirmDialog()   module-level singleton form (drop-in for window.confirm)
 *   useToast()        toast.success/error/info inside components
 *   toast             module-level singleton (drop-in for alert)
 *   <OverlayProvider> mounts the confirm dialog + toast stack; add once at root
 *
 * The singletons let non-hook code (module-scope helpers, event handlers that
 * don't already pull a hook) raise a toast or confirm without threading a hook
 * through — they dispatch to the provider mounted at the root.
 */
import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle, CheckCircle2, AlertCircle, Info } from 'lucide-react';

/* ──────────────────────────────────────────────────────────────────────────
   ModalShell — backdrop, focus trap, Esc, scroll-lock, restore-focus, aria.
   Children supply the visible panel (a direct flex child so its own sizing /
   max-height classes are preserved). Mark a default-focus control with the
   `data-autofocus` attribute.
   ────────────────────────────────────────────────────────────────────────── */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

function trapTab(e: KeyboardEvent, container: HTMLElement | null) {
  if (!container) return;
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (nodes.length === 0) { e.preventDefault(); container.focus(); return; }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || !container.contains(active)) { e.preventDefault(); last.focus(); }
  } else {
    if (active === last || !container.contains(active)) { e.preventDefault(); first.focus(); }
  }
}

export interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  variant?: 'center' | 'drawer';
  /** When busy, Esc and overlay-click are ignored (e.g. mid-save). */
  busy?: boolean;
  closeOnOverlay?: boolean;
  /** id of the element labelling this dialog (for aria-labelledby). */
  labelledBy?: string;
  zClass?: string;
  children: ReactNode;
}

export function ModalShell({
  open, onClose, variant = 'center', busy = false, closeOnOverlay = true,
  labelledBy, zClass = 'z-[100]', children,
}: ModalShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Focus management + body scroll-lock for the lifetime of the open dialog.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = (document.activeElement as HTMLElement) ?? null;
    const t = window.setTimeout(() => {
      const c = containerRef.current;
      if (!c) return;
      const target =
        c.querySelector<HTMLElement>('[data-autofocus]') ?? c.querySelector<HTMLElement>(FOCUSABLE);
      (target ?? c).focus();
    }, 0);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.clearTimeout(t);
      document.body.style.overflow = prevOverflow;
      const r = restoreRef.current;
      if (r && typeof r.focus === 'function') r.focus();
    };
  }, [open]);

  // Esc to close, Tab to cycle focus within the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!busy) { e.preventDefault(); onClose(); }
      } else if (e.key === 'Tab') {
        trapTab(e, containerRef.current);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, busy, onClose]);

  if (!open) return null;

  const positioning = variant === 'drawer' ? 'justify-end' : 'items-center justify-center p-4';
  const blur = variant === 'drawer' ? 'backdrop-blur-sm' : 'backdrop-blur-md';

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      className={`fixed inset-0 ${zClass} flex ${positioning} outline-none`}
    >
      <div
        className={`absolute inset-0 bg-slate-900/50 ${blur} animate-fadeIn`}
        onClick={!busy && closeOnOverlay ? onClose : undefined}
        aria-hidden="true"
      />
      {children}
    </div>,
    document.body,
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Confirm dialog
   ────────────────────────────────────────────────────────────────────────── */
export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red, destructive styling + the Cancel button takes default focus. */
  danger?: boolean;
}
export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmCtx = createContext<ConfirmFn | null>(null);

/** Hook form. Falls back to window.confirm if no provider is mounted. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmCtx);
  return ctx ?? ((opts) => Promise.resolve(window.confirm(opts.title)));
}

// Singleton form so non-hook code can `await confirmDialog({...})`.
let _confirmHandler: ConfirmFn | null = null;
export const confirmDialog: ConfirmFn = (opts) =>
  _confirmHandler ? _confirmHandler(opts) : Promise.resolve(window.confirm(opts.title));

interface ConfirmState extends ConfirmOptions {
  resolve: (v: boolean) => void;
}

/* ──────────────────────────────────────────────────────────────────────────
   Toasts
   ────────────────────────────────────────────────────────────────────────── */
export type ToastKind = 'success' | 'error' | 'info';
interface ToastItem { id: number; kind: ToastKind; message: ReactNode; }

interface ToastApi {
  success: (message: ReactNode) => void;
  error: (message: ReactNode) => void;
  info: (message: ReactNode) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

let _toastHandler: ((kind: ToastKind, message: ReactNode) => void) | null = null;
const fallbackToast = (kind: ToastKind, message: ReactNode) => {
  if (typeof message === 'string') {
    // eslint-disable-next-line no-alert
    if (kind === 'error') alert(message); else console.log(`[${kind}]`, message);
  }
};
/** Singleton toast API — drop-in for alert(). */
export const toast: ToastApi = {
  success: (m) => (_toastHandler ?? fallbackToast)('success', m),
  error: (m) => (_toastHandler ?? fallbackToast)('error', m),
  info: (m) => (_toastHandler ?? fallbackToast)('info', m),
};

export function useToast(): ToastApi {
  return useContext(ToastCtx) ?? toast;
}

const TOAST_STYLE: Record<ToastKind, { wrap: string; icon: ReactNode }> = {
  success: {
    wrap: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    icon: <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />,
  },
  error: {
    wrap: 'border-rose-200 bg-rose-50 text-rose-700',
    icon: <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />,
  },
  info: {
    wrap: 'border-indigo-200 bg-indigo-50 text-indigo-800',
    icon: <Info className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />,
  },
};

/* ──────────────────────────────────────────────────────────────────────────
   Provider — mounts the confirm dialog + toast stack. Add once near the root.
   ────────────────────────────────────────────────────────────────────────── */
export function OverlayProvider({ children }: { children: ReactNode }) {
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(1);
  const titleId = useId();

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve }));
  }, []);

  const closeConfirm = useCallback((value: boolean) => {
    setConfirmState((cur) => { cur?.resolve(value); return null; });
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback((kind: ToastKind, message: ReactNode) => {
    const id = seq.current++;
    setToasts((cur) => [...cur, { id, kind, message }]);
    window.setTimeout(() => dismissToast(id), kind === 'error' ? 7000 : 4000);
  }, [dismissToast]);

  const toastApi: ToastApi = {
    success: (m) => pushToast('success', m),
    error: (m) => pushToast('error', m),
    info: (m) => pushToast('info', m),
  };

  // Register the singletons against this (root) provider.
  useEffect(() => {
    _confirmHandler = confirm;
    _toastHandler = pushToast;
    return () => { _confirmHandler = null; _toastHandler = null; };
  }, [confirm, pushToast]);

  return (
    <ConfirmCtx.Provider value={confirm}>
      <ToastCtx.Provider value={toastApi}>
        {children}

        {confirmState && (
          <ModalShell
            open
            variant="center"
            zClass="z-[200]"
            labelledBy={titleId}
            onClose={() => closeConfirm(false)}
          >
            <div className="relative z-10 w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
              <div className="px-6 pt-6 pb-4">
                <div className="flex items-start gap-3">
                  <div className={`p-2 rounded-lg shrink-0 ${confirmState.danger ? 'bg-rose-100 text-rose-600' : 'bg-indigo-100 text-indigo-700'}`}>
                    <AlertTriangle className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <h3 id={titleId} className="text-sm font-black text-slate-800 tracking-tight">{confirmState.title}</h3>
                    {confirmState.body && (
                      <div className="text-[12px] text-slate-500 mt-1 leading-relaxed">{confirmState.body}</div>
                    )}
                  </div>
                </div>
              </div>
              <div className="px-6 py-4 bg-slate-50 border-t border-slate-150 flex items-center justify-end gap-2">
                <button
                  data-autofocus={confirmState.danger ? '' : undefined}
                  onClick={() => closeConfirm(false)}
                  className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                >
                  {confirmState.cancelLabel ?? 'Cancel'}
                </button>
                <button
                  data-autofocus={confirmState.danger ? undefined : ''}
                  onClick={() => closeConfirm(true)}
                  className={`px-4 py-2 text-xs font-black text-white rounded-lg transition-colors cursor-pointer ${confirmState.danger ? 'bg-rose-600 hover:bg-rose-500' : 'bg-slate-900 hover:bg-slate-800'}`}
                >
                  {confirmState.confirmLabel ?? 'Confirm'}
                </button>
              </div>
            </div>
          </ModalShell>
        )}

        {/* Toast stack */}
        {toasts.length > 0 && createPortal(
          <div className="fixed top-4 right-4 z-[300] flex flex-col gap-2 w-[min(92vw,22rem)] pointer-events-none">
            {toasts.map((t) => {
              const s = TOAST_STYLE[t.kind];
              return (
                <div
                  key={t.id}
                  role="alert"
                  aria-live={t.kind === 'error' ? 'assertive' : 'polite'}
                  className={`pointer-events-auto flex items-start gap-2 rounded-xl border shadow-lg px-4 py-3 text-[12px] font-medium animate-slideIn ${s.wrap}`}
                >
                  {s.icon}
                  <div className="flex-1 min-w-0 break-words">{t.message}</div>
                  <button
                    onClick={() => dismissToast(t.id)}
                    aria-label="Dismiss notification"
                    title="Dismiss"
                    className="shrink-0 -mr-1 -mt-0.5 p-1 rounded hover:bg-black/5 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
      </ToastCtx.Provider>
    </ConfirmCtx.Provider>
  );
}
