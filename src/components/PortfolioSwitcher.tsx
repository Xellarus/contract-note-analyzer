// Quick-switcher for the twelve accounts: press K, type, Enter.
//
// A palette rather than number keys, and the reason is specific: the Portfolios page now sorts
// cards by current value, so "the third card" is not a stable target — it moves as prices do.
// Numbering would also have left three of twelve accounts unreachable. Typing a name is immune
// to both.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { ModalShell } from './ui/overlay';
import { PORTFOLIOS, brokerLabel, Portfolio } from '../lib/portfolios';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The portfolio currently being looked at, shown as the resting selection. */
  activeId: string;
  onPick: (id: string) => void;
}

export default function PortfolioSwitcher({ open, onClose, activeId, onPick }: Props) {
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // A fresh query every time it opens. Reopening onto the last search would mean the first
  // keystroke lands in a filtered list, and Enter would open the wrong book.
  useEffect(() => { if (open) { setQ(''); setHi(0); } }, [open]);

  const matches = useMemo(() => {
    const term = q.trim().toLowerCase();
    // Matched on NAME, CODE and BROKER together, because three accounts are "Saket Agarwal" and
    // the broker is the only thing that separates them — typing "saket axis" has to work.
    const hay = (p: Portfolio) => `${p.label} ${p.code} ${brokerLabel(p.broker)}`.toLowerCase();
    const words = term.split(/\s+/).filter(Boolean);
    const list = words.length
      ? PORTFOLIOS.filter((p) => { const h = hay(p); return words.every((w) => h.includes(w)); })
      : PORTFOLIOS;
    // Registry order, NOT the value order the cards use: this list must not reshuffle between
    // openings, or muscle memory built on "K, Enter" opens a different book after a price move.
    return list;
  }, [q]);

  // Clamp when the query narrows the list under the cursor.
  useEffect(() => { setHi((h) => Math.min(h, Math.max(0, matches.length - 1))); }, [matches.length]);

  // Keep the highlighted row in view when arrowing past the visible window.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${hi}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const commit = (p: Portfolio | undefined) => { if (!p) return; onPick(p.id); onClose(); };

  return (
    <ModalShell open={open} onClose={onClose} labelledBy="switcher-title">
      <div className="relative z-10 bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-lg overflow-hidden">
        <h2 id="switcher-title" className="sr-only">Switch portfolio</h2>
        <div className="relative border-b border-slate-200">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            data-autofocus
            value={q}
            onChange={(e) => { setQ(e.target.value); setHi(0); }}
            placeholder="Portfolio name, client code or broker…"
            className="w-full pl-10 pr-4 py-3.5 text-sm font-bold text-slate-800 outline-none bg-transparent"
            onKeyDown={(e) => {
              // Arrow/Enter are handled here rather than globally: while this input has focus the
              // global handler is suppressed anyway (it ignores typing targets), which is exactly
              // what lets you type "p" into the box without navigating to Portfolios.
              if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); commit(matches[hi]); }
              // Esc is ModalShell's — not re-handled here, so one press closes one thing.
            }}
          />
        </div>

        <div ref={listRef} className="max-h-80 overflow-y-auto py-1.5">
          {matches.length === 0 && (
            <p className="px-4 py-6 text-center text-xs font-bold text-slate-400">
              Nothing matches “{q.trim()}”.
            </p>
          )}
          {matches.map((p, i) => (
            <button
              key={p.id}
              data-idx={i}
              onMouseEnter={() => setHi(i)}
              onClick={() => commit(p)}
              className={`w-full text-left px-4 py-2.5 flex items-center gap-3 cursor-pointer ${
                i === hi ? 'bg-indigo-50' : 'hover:bg-slate-50'
              }`}
            >
              <span className="px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 text-[10px] font-black font-mono tracking-wider shrink-0 whitespace-nowrap">
                {brokerLabel(p.broker)}
              </span>
              <span className="text-xs font-bold text-slate-800 truncate flex-1">{p.label}</span>
              {/* The client code earns its place here even though the card badge dropped it:
                  this list is how you pick between three accounts with the same name. */}
              <span className="text-[10px] font-bold text-slate-400 font-mono shrink-0">{p.code}</span>
              {p.id === activeId && (
                <span className="text-[9px] font-black uppercase tracking-wider text-indigo-600 shrink-0">open</span>
              )}
            </button>
          ))}
        </div>

        <div className="px-4 py-2.5 border-t border-slate-200 bg-slate-50 flex items-center gap-3">
          <span className="text-[10px] font-bold text-slate-400">↑↓ move · ↵ open · Esc close</span>
        </div>
      </div>
    </ModalShell>
  );
}
