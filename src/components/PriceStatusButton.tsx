import { useEffect, useState } from 'react';
import { AlertTriangle, X, Loader2 } from 'lucide-react';
import { ModalShell } from './ui/overlay';
import { loadPriceMisses, PriceMiss } from '../lib/scripPrices';
import { SCRIP_MASTER_SPREADSHEET_ID } from '../lib/scripMaster';

/**
 * Small toolbar button that surfaces the stocks the Yahoo price updater couldn't fetch a
 * CMP for (read from the shared "Price Status" tab, written by YahooPriceUpdate.gs). Renders
 * nothing once we know the list is empty, so it only appears when there's something to see.
 * Dropped into both the Dashboard and the Holdings summary. `refreshKey` — bump it (e.g. after
 * a "Refresh Prices" click) to re-read the tab.
 */
export default function PriceStatusButton({ refreshKey = 0 }: { refreshKey?: number }) {
  const [misses, setMisses] = useState<PriceMiss[] | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    loadPriceMisses(SCRIP_MASTER_SPREADSHEET_ID)
      .then(setMisses).catch(() => setMisses([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [refreshKey]);

  const count = misses?.length ?? 0;
  if (misses !== null && count === 0) return null;   // all priced (or tab absent) → stay hidden

  return (
    <>
      <button
        onClick={() => { setOpen(true); load(); }}
        title="Stocks Yahoo couldn't fetch a market price for"
        className="btn-press px-3.5 py-2.5 bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 font-black text-xs rounded-xl flex items-center gap-1.5 cursor-pointer shadow-sm shrink-0"
      >
        <AlertTriangle className="w-4 h-4" />
        {count > 0 ? `${count} unpriced` : 'Price status'}
      </button>

      <ModalShell open={open} onClose={() => setOpen(false)} labelledBy="price-status-title">
        <div className="relative z-10 w-full max-w-md max-h-[80vh] flex flex-col bg-white rounded-2xl shadow-2xl animate-fadeIn">
          <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
            <div>
              <h3 id="price-status-title" className="text-sm font-black text-slate-800 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600" /> Prices Yahoo couldn't fetch
              </h3>
              <p className="text-[11px] text-slate-500 mt-0.5">These keep their last known price, or fall back to average cost if never priced.</p>
            </div>
            <button onClick={() => setOpen(false)} className="p-1.5 hover:bg-slate-100 rounded-lg cursor-pointer"><X className="w-4 h-4 text-slate-500" /></button>
          </div>
          <div className="overflow-y-auto px-5 py-4">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /></div>
            ) : count === 0 ? (
              <p className="text-[12px] text-slate-500 py-6 text-center">Every held stock has a fetched price.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {misses!.map((m, i) => (
                  <li key={i} className="py-2.5">
                    <div className="text-[12px] font-bold text-slate-700">{m.name || m.isin}</div>
                    <div className="text-[11px] text-slate-500">{m.reason}{m.checked ? ` · checked ${m.checked}` : ''}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </ModalShell>
    </>
  );
}
