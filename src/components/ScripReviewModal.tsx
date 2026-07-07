import React, { useId, useState } from 'react';
import { X, Link2, PlusCircle, AlertTriangle, Loader2 } from 'lucide-react';
import {
  ScripMaster, ScripEntry, saveScripMaster, linkAliasToEntry, createCanonical,
} from '../lib/scripMaster';
import { UnresolvedScrip } from '../lib/holdingsCalc';
import { ModalShell } from './ui/overlay';

interface Props {
  spreadsheetId: string;        // the shared Scrip Master spreadsheet id
  master: ScripMaster;
  unresolved: UnresolvedScrip[];
  onClose: () => void;
  onSaved: () => void;          // re-run the calc after persisting links
}

// Per-item choice: a candidate entry's canonical name (link to it) or "__new__" (create new)
type Choice = { mode: 'link'; entry: ScripEntry } | { mode: 'new'; canonicalName: string };

export default function ScripReviewModal({ spreadsheetId, master, unresolved, onClose, onSaved }: Props) {
  const titleId = useId();
  const [choices, setChoices] = useState<Record<number, Choice>>(() => {
    // Default each row to its strongest candidate, else "create new" with its own name
    const init: Record<number, Choice> = {};
    unresolved.forEach((u, i) => {
      init[i] = u.candidates.length > 0
        ? { mode: 'link', entry: u.candidates[0] }
        : { mode: 'new', canonicalName: u.name };
    });
    return init;
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setChoice = (i: number, c: Choice) => setChoices(prev => ({ ...prev, [i]: c }));

  const save = async () => {
    setIsSaving(true);
    setError(null);
    try {
      unresolved.forEach((u, i) => {
        const c = choices[i];
        if (!c) return;
        if (c.mode === 'link') {
          linkAliasToEntry(master, c.entry, u.isin, u.name);
        } else {
          const canonical = (c.canonicalName || u.name).trim() || u.name;
          createCanonical(master, canonical, u.isin, u.name);
        }
      });
      await saveScripMaster(spreadsheetId, master);
      onSaved();
    } catch (e: any) {
      setError(e?.result?.error?.message || e?.message || 'Failed to save scrip links.');
      setIsSaving(false);
    }
  };

  return (
    <ModalShell open variant="center" busy={isSaving} onClose={onClose} labelledBy={titleId}>
      <div className="relative z-10 w-full max-w-2xl max-h-[85vh] flex flex-col bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-150 bg-slate-50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-orange-100 text-orange-700 rounded-lg">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div>
              <h3 id={titleId} className="text-sm font-black text-slate-800 uppercase tracking-tight">Link Unmatched Scrips</h3>
              <p className="text-[11px] text-slate-500 font-medium">
                These names couldn't be auto-matched to a canonical security. Link each to the right one (or create new), then re-run.
              </p>
            </div>
          </div>
          <button onClick={onClose} disabled={isSaving} aria-label="Close" title="Close" className="p-1.5 hover:bg-slate-200 rounded-lg text-slate-500 transition-colors cursor-pointer disabled:opacity-50">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {unresolved.map((u, i) => {
            const c = choices[i];
            return (
              <div key={i} className="border border-slate-200 rounded-xl p-4 bg-white">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-sm font-black text-slate-800">{u.name || '(blank name)'}</span>
                  {u.isin && <span className="text-[10px] font-mono font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">{u.isin}</span>}
                  <span className="text-[10px] font-bold text-orange-600 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded ml-auto">
                    {u.candidates.length > 0 ? `${u.candidates.length} possible match${u.candidates.length > 1 ? 'es' : ''}` : 'no match found'}
                  </span>
                </div>

                <div className="space-y-1.5">
                  {u.candidates.map((cand, ci) => (
                    <label key={ci} className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs ${c?.mode === 'link' && c.entry === cand ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                      <input
                        type="radio"
                        name={`scrip-${i}`}
                        checked={c?.mode === 'link' && c.entry === cand}
                        onChange={() => setChoice(i, { mode: 'link', entry: cand })}
                        className="accent-indigo-600"
                      />
                      <Link2 className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                      <span className="font-bold text-slate-700">{cand.canonicalName}</span>
                      {cand.isin && <span className="text-[10px] font-mono text-slate-400">{cand.isin}</span>}
                    </label>
                  ))}

                  {/* Create-new option */}
                  <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs ${c?.mode === 'new' ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                    <input
                      type="radio"
                      name={`scrip-${i}`}
                      checked={c?.mode === 'new'}
                      onChange={() => setChoice(i, { mode: 'new', canonicalName: u.name })}
                      className="accent-emerald-600"
                    />
                    <PlusCircle className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    <span className="font-bold text-slate-700 shrink-0">New security:</span>
                    <input
                      type="text"
                      value={c?.mode === 'new' ? c.canonicalName : u.name}
                      onChange={(e) => setChoice(i, { mode: 'new', canonicalName: e.target.value })}
                      onFocus={() => { if (c?.mode !== 'new') setChoice(i, { mode: 'new', canonicalName: u.name }); }}
                      className="flex-1 px-2 py-1 border border-slate-200 rounded text-xs font-medium focus:outline-none focus:border-emerald-400"
                      placeholder="Canonical name"
                    />
                  </label>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-150 bg-slate-50 flex items-center justify-between gap-3">
          {error
            ? <span className="text-[11px] font-bold text-rose-600">{error}</span>
            : <span className="text-[11px] text-slate-500">Links are saved to the shared Scrip Master and reused across all accounts.</span>}
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onClose} disabled={isSaving} className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer disabled:opacity-50">
              Cancel
            </button>
            <button onClick={save} disabled={isSaving} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
              {isSaving ? 'Saving…' : 'Save & Re-run'}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
