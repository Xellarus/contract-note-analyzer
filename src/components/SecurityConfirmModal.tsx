import React, { useId, useMemo, useState } from 'react';
import { X, CheckCircle2, AlertTriangle, Loader2, ShieldCheck, RefreshCw } from 'lucide-react';
import { ScripMaster, ScripEntry, lookupScrip, createCanonical, linkAliasToEntry, normName, saveScripMaster } from '../lib/scripMaster';
import { ModalShell } from './ui/overlay';

export interface ConfirmSecurity {
  parsedName: string;   // name/symbol as parsed from the contract note
  isin: string;         // ISIN captured from the note (may be empty)
}

interface Props {
  spreadsheetId: string;     // shared Scrip Master spreadsheet id
  master: ScripMaster;
  securities: ConfirmSecurity[];
  onClose: () => void;
  onConfirmed?: () => void;  // called after any new mappings are persisted
  onRefresh?: () => Promise<void>;  // re-fetch the scrip sheet and re-resolve
}

interface Row {
  parsedName: string;
  noteIsin: string;              // ISIN as it appeared on the note (may be empty)
  entryIsin: string;             // matched entry's official ISIN ('' if none)
  officialName: string | null;   // resolved NSE/BSE canonical name
  entry: ScripEntry | null;      // the matched master entry (for alias persistence)
  foundBy: 'isin' | 'name' | 'none';
  isinUnverified: boolean;       // note carried an ISIN that is NOT in the NSE/BSE list
  note: string;                  // explanation when not matched
}

export default function SecurityConfirmModal({ spreadsheetId, master, securities, onClose, onConfirmed, onRefresh }: Props) {
  const titleId = useId();
  const rows: Row[] = useMemo(() => securities.map(s => {
    const noteIsin = (s.isin || '').trim();
    const r = lookupScrip(master, noteIsin, s.parsedName);
    // The note's ISIN is only "verified" when it actually resolved against the
    // official list by ISIN. A name-only match means the note's ISIN was never
    // found in NSE/BSE — don't present it as if it were.
    const isinUnverified = !!noteIsin && r.foundBy !== 'isin';
    let note = '';
    if (!r.entry) {
      note = noteIsin
        ? `ISIN ${noteIsin} not found in the NSE/BSE list`
        : `No ISIN on the note and the name couldn't be matched to the NSE/BSE list`;
    }
    return {
      parsedName: s.parsedName,
      noteIsin,
      entryIsin: r.entry?.isin ?? '',
      officialName: r.entry ? r.entry.canonicalName : null,
      entry: r.entry,
      foundBy: r.foundBy,
      isinUnverified,
      note,
    };
  }), [securities, master]);

  // For unmatched rows, the user can type the correct security name to save
  const [names, setNames] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    rows.forEach((row, i) => { if (!row.officialName) init[i] = row.parsedName; });
    return init;
  });
  const [isSaving, setIsSaving] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRefresh = async () => {
    if (!onRefresh) return;
    setIsRefreshing(true);
    setError(null);
    try {
      await onRefresh();
    } catch (e: any) {
      setError(e?.result?.error?.message || e?.message || 'Failed to refresh the scrip list.');
    } finally {
      setIsRefreshing(false);
    }
  };

  const matched = rows.filter(r => r.officialName);
  const unmatched = rows.filter(r => !r.officialName);

  const confirm = async () => {
    setIsSaving(true);
    setError(null);
    try {
      // Persist user-named entries for securities not in the official list so
      // future imports of the same ISIN/name resolve automatically.
      rows.forEach((row, i) => {
        if (row.officialName) {
          // Matched (by ISIN or name) — teach the master the note's exact
          // (often truncated) spelling as a permanent alias, so name-only
          // paths (rebuild/CG/register, ISIN-less reports) hit it exactly.
          if (row.entry && !row.entry.aliasNorms.has(normName(row.parsedName))) {
            linkAliasToEntry(master, row.entry, row.noteIsin, row.parsedName);
          }
          return;
        }
        const name = (names[i] || row.parsedName).trim();
        if (!name) return;
        createCanonical(master, name, row.noteIsin, row.parsedName);
      });
      if (master.dirty) await saveScripMaster(spreadsheetId, master);
      onConfirmed?.();
      onClose();
    } catch (e: any) {
      setError(e?.result?.error?.message || e?.message || 'Failed to save security mappings.');
      setIsSaving(false);
    }
  };

  return (
    <ModalShell open variant="center" busy={isSaving || isRefreshing} onClose={onClose} labelledBy={titleId}>
      <div className="relative z-10 w-full max-w-2xl max-h-[85vh] flex flex-col bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-150 bg-slate-50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-100 text-indigo-700 rounded-lg">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <h3 id={titleId} className="text-sm font-black text-slate-800 uppercase tracking-tight">Confirm Securities</h3>
              <p className="text-[11px] text-slate-500 font-medium">
                Matched to the official NSE/BSE list by ISIN (or by name as a fallback). Review, then confirm.
              </p>
            </div>
          </div>
          <button onClick={onClose} disabled={isSaving} aria-label="Close" title="Close" className="p-1.5 hover:bg-slate-200 rounded-lg text-slate-500 transition-colors cursor-pointer disabled:opacity-50">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {master.entries.length === 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800">
              The scrip list looks empty. Import <span className="font-mono font-bold">scrip-master.csv</span> into your Scrip Master sheet, then click <b>Re-check</b>.
            </div>
          )}

          {unmatched.length > 0 && onRefresh && (
            <p className="text-[11px] text-slate-500">
              Not in the list? Add a row to your Scrip Master sheet (ISIN · Name), then <b>Re-check</b> — or just type the name below to save it.
            </p>
          )}

          {unmatched.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-black uppercase tracking-wider text-amber-700">
                Not found in NSE/BSE list ({unmatched.length})
              </p>
              {rows.map((row, i) => row.officialName ? null : (
                <div key={i} className="border border-amber-200 bg-amber-50/60 rounded-xl p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                    <span className="text-sm font-bold text-slate-800">{row.parsedName || '(blank name)'}</span>
                    {row.noteIsin && <span className="text-[10px] font-mono font-bold text-slate-500 bg-white border border-slate-200 px-1.5 py-0.5 rounded">{row.noteIsin}</span>}
                  </div>
                  <p className="text-[11px] text-amber-700 mb-2">{row.note}.</p>
                  <label className="flex items-center gap-2 text-[11px] font-semibold text-slate-600">
                    <span className="shrink-0">Save as:</span>
                    <input
                      type="text"
                      value={names[i] ?? row.parsedName}
                      onChange={(e) => setNames(prev => ({ ...prev, [i]: e.target.value }))}
                      className="flex-1 px-2 py-1 border border-slate-200 rounded text-xs font-medium focus:outline-none focus:border-indigo-400"
                      placeholder="Correct security name"
                    />
                  </label>
                </div>
              ))}
            </div>
          )}

          {matched.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-black uppercase tracking-wider text-emerald-700">
                Matched to NSE/BSE ({matched.length})
              </p>
              {rows.map((row, i) => !row.officialName ? null : (
                <div key={i} className="flex items-start gap-3 border border-slate-200 rounded-xl px-3 py-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-slate-800 truncate">{row.officialName}</span>
                      {row.entryIsin && <span className="text-[10px] font-mono text-slate-400 shrink-0">{row.entryIsin}</span>}
                    </div>
                    <span className="text-[11px] text-slate-500">
                      from note as “{row.parsedName}” · matched by {row.foundBy === 'isin' ? 'ISIN' : 'name'}
                    </span>
                    {row.isinUnverified && (
                      <p className="mt-1 flex items-start gap-1 text-[10.5px] text-amber-700">
                        <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
                        <span>Note's ISIN {row.noteIsin} isn't in the NSE/BSE list — matched by name instead.</span>
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {rows.length === 0 && (
            <p className="text-xs text-slate-500 italic text-center py-6">No securities to confirm.</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-150 bg-slate-50 flex items-center justify-between gap-3">
          {error
            ? <span className="text-[11px] font-bold text-rose-600">{error}</span>
            : <span className="text-[11px] text-slate-500">
                {unmatched.length > 0
                  ? 'Names you set here are saved to the shared Scrip Master and reused across accounts.'
                  : 'All securities matched the official NSE/BSE list.'}
              </span>}
          <div className="flex items-center gap-2 shrink-0">
            {onRefresh && (
              <button onClick={handleRefresh} disabled={isSaving || isRefreshing} className="px-3 py-2 text-xs font-bold text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
                {isRefreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                {isRefreshing ? 'Re-checking…' : 'Re-check'}
              </button>
            )}
            <button onClick={onClose} disabled={isSaving || isRefreshing} className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer disabled:opacity-50">
              Close
            </button>
            <button onClick={confirm} disabled={isSaving || isRefreshing} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              {isSaving ? 'Saving…' : (unmatched.length > 0 ? 'Save & Confirm' : 'Confirm')}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
