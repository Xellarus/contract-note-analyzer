// The `?` overlay. Rendered ENTIRELY from the SHORTCUTS registry — there is no hand-written
// list here, so a shortcut can never work while going undocumented, or be documented after it
// stops working. Adding a key to the registry adds a row here for free.
import { ModalShell } from './overlay';
import { SHORTCUTS, SHORTCUT_GROUPS, keyLabel } from '../../lib/shortcuts';

export default function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <ModalShell open={open} onClose={onClose} labelledBy="shortcut-help-title">
      <div className="relative z-10 bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <h2 id="shortcut-help-title" className="text-sm font-black text-slate-800 uppercase tracking-wider">
            Keyboard shortcuts
          </h2>
          <button
            onClick={onClose}
            data-autofocus
            className="text-[10px] font-black text-slate-500 hover:text-slate-900 border border-slate-200 rounded-lg px-2 py-1 cursor-pointer"
          >
            Esc
          </button>
        </div>

        <div className="p-5 space-y-5">
          {SHORTCUT_GROUPS.map((g) => {
            const items = SHORTCUTS.filter((s) => s.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-2">{g}</p>
                <div className="space-y-1.5">
                  {items.map((s) => (
                    <div key={s.action} className="flex items-start gap-3">
                      <kbd className="shrink-0 min-w-[26px] text-center px-1.5 py-0.5 rounded-md bg-slate-100 border border-slate-200 text-slate-700 text-[11px] font-black font-mono">
                        {keyLabel(s.keys[0])}
                      </kbd>
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-slate-800 leading-tight">{s.label}</p>
                        <p className="text-[11px] text-slate-500 leading-snug">{s.hint}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {/* States the boundary, rather than leaving the absence to be discovered. Someone WILL
              look for a Rebuild shortcut; better they read why there isn't one. */}
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3">
            <p className="text-[11px] font-bold text-amber-900">Not on the keyboard, on purpose</p>
            <p className="text-[11px] text-amber-800 leading-snug mt-0.5">
              Rebuild Holding, Sync Capital Gains, the Capital Gains register and Transfer all
              write to Google Sheets. A stray keypress must never start a sheet write, so those
              stay click-only.
            </p>
          </div>

          <p className="text-[11px] text-slate-400 leading-snug">
            Shortcuts are ignored while you are typing in a field, and a key held with
            Ctrl, Cmd or Alt always belongs to the browser.
          </p>
        </div>
      </div>
    </ModalShell>
  );
}
