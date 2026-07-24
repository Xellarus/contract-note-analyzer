import { useMemo, useState } from 'react';
import { X, CheckCircle2, Loader2, Link2, Search, RotateCcw } from 'lucide-react';
import { ScripMaster, ScripEntry, normName, linkAliasToEntry, saveScripMaster } from '../lib/scripMaster';
import { ModalShell } from './ui/overlay';

interface Props {
  open: boolean;
  spreadsheetId: string;          // shared Scrip Master spreadsheet id
  master: ScripMaster;
  names: string[];                // unmatched statement names to map
  onClose: () => void;
  onApplied: () => void;          // parent reloads the master + re-resolves after this
}

// Searchable picker over the whole scrip master. Seeded with the unmatched name so the
// likely entry surfaces first; the user can retype to search (handles spelling diffs like
// "fertilizers" vs "fertilisers"). Token-overlap scored, top 25 shown.
function EntryPicker({ master, seed, value, onPick }: {
  master: ScripMaster; seed: string; value: ScripEntry | null; onPick: (e: ScripEntry | null) => void;
}) {
  const [q, setQ] = useState(seed);
  const [openList, setOpenList] = useState(false);

  const results = useMemo(() => {
    const terms = normName(q).split(' ').filter(Boolean);
    if (terms.length === 0) return [] as ScripEntry[];
    const scored: { e: ScripEntry; score: number }[] = [];
    for (const e of master.entries) {
      const hay = (e.canonicalName + ' ' + [...e.aliasNorms].join(' ') + ' ' + (e.isin || '')).toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score++;
      if (score > 0) scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score || a.e.canonicalName.localeCompare(b.e.canonicalName));
    return scored.slice(0, 25).map(s => s.e);
  }, [q, master]);

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5">
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
        <span className="text-[12px] font-bold text-emerald-800 truncate flex-1">{value.canonicalName}</span>
        {value.isin && <span className="text-[10px] font-mono text-emerald-600 shrink-0">{value.isin}</span>}
        <button onClick={() => { onPick(null); setOpenList(true); }} className="text-[11px] font-bold text-emerald-700 hover:underline cursor-pointer shrink-0">change</button>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2">
        <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <input
          value={q}
          onChange={e => { setQ(e.target.value); setOpenList(true); }}
          onFocus={() => setOpenList(true)}
          placeholder="Search the scrip master…"
          className="flex-1 py-1.5 text-[12px] font-medium bg-transparent focus:outline-none"
        />
      </div>
      {openList && (
        <ul className="absolute z-20 mt-1 w-full max-h-52 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg text-[12px]">
          {results.length === 0 && <li className="px-3 py-2 text-slate-400 italic">No matches — retype to search.</li>}
          {results.map((e, i) => (
            <li key={i}>
              <button
                onClick={() => { onPick(e); setOpenList(false); }}
                className="w-full text-left px-3 py-1.5 hover:bg-indigo-50 cursor-pointer flex items-center gap-2">
                <span className="font-medium text-slate-800 truncate flex-1">{e.canonicalName}</span>
                {e.isin && <span className="text-[10px] font-mono text-slate-400 shrink-0">{e.isin}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function OpeningScripMapModal({ open, spreadsheetId, master, names, onClose, onApplied }: Props) {
  const [choice, setChoice] = useState<Record<string, ScripEntry | null>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosenCount = Object.values(choice).filter(Boolean).length;

  const apply = async () => {
    setSaving(true); setError(null);
    try {
      let linked = 0;
      for (const name of names) {
        const entry = choice[name];
        if (!entry) continue;
        // Alias this statement name onto the chosen entry (persists to the shared master),
        // so it — and every future import of the same name — resolves to that scrip.
        if (!entry.aliasNorms.has(normName(name))) linkAliasToEntry(master, entry, '', name);
        linked++;
      }
      if (linked > 0 && master.dirty) await saveScripMaster(spreadsheetId, master);
      onApplied();
    } catch (e: any) {
      setError(e?.result?.error?.message || e?.message || 'Failed to save the mappings.');
      setSaving(false);
    }
  };

  return (
    <ModalShell open={open} variant="center" busy={saving} onClose={onClose} labelledBy="map-scrips-title">
      <div className="relative z-10 w-full max-w-2xl max-h-[85vh] flex flex-col bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-150 bg-slate-50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-100 text-indigo-700 rounded-lg"><Link2 className="w-4 h-4" /></div>
            <div>
              <h3 id="map-scrips-title" className="text-sm font-black text-slate-800 uppercase tracking-tight">Map securities to the scrip master</h3>
              <p className="text-[11px] text-slate-500 font-medium">Pick the correct stock for each name below. It's saved as an alias so it (and future imports) resolve to that scrip.</p>
            </div>
          </div>
          <button onClick={onClose} disabled={saving} aria-label="Close" className="p-1.5 hover:bg-slate-200 rounded-lg text-slate-500 cursor-pointer disabled:opacity-50"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {names.length === 0 && <p className="text-xs text-slate-500 italic text-center py-6">Nothing to map.</p>}
          {names.map((name, i) => (
            <div key={i} className="border border-slate-200 rounded-xl p-3">
              <div className="text-[13px] font-bold text-slate-800 mb-2 truncate">{name}</div>
              <EntryPicker master={master} seed={name} value={choice[name] ?? null} onPick={e => setChoice(prev => ({ ...prev, [name]: e }))} />
            </div>
          ))}
        </div>

        <div className="px-6 py-4 border-t border-slate-150 bg-slate-50 flex items-center justify-between gap-3">
          {error
            ? <span className="text-[11px] font-bold text-rose-600">{error}</span>
            : <span className="text-[11px] text-slate-500">{chosenCount} of {names.length} mapped. Unmapped names import under their own name.</span>}
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onClose} disabled={saving} className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 rounded-lg cursor-pointer disabled:opacity-50">Cancel</button>
            <button onClick={apply} disabled={saving || chosenCount === 0} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
              {saving ? 'Saving & re-resolving…' : `Map ${chosenCount || ''} & re-resolve`}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
