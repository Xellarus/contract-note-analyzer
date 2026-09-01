import { useMemo, useState } from 'react';
import { ArrowRightLeft, AlertTriangle } from 'lucide-react';
import { ModalShell, toast } from './ui/overlay';
import { PORTFOLIOS, portfolioById } from '../lib/portfolios';
import {
  planTransfer, executeTransfer, type TransferSourceLot,
} from '../lib/transferHolding';
import { formatDMY } from '../lib/dates';

/**
 * Move a holding from one portfolio's book to another.
 *
 * The transfer is NOT a sale by default: no capital gain is realised, the FIFO cost basis
 * carries across, and each lot keeps its ORIGINAL acquisition date so a later sale in the
 * destination is still judged long- or short-term correctly. That is why the preview shows
 * one line per lot — 1,000 shares taken FIFO may come from three different purchase dates,
 * and they arrive as three separate rows.
 *
 * The "this is a sale" toggle switches to an ordinary disposal at a price you enter: capital
 * gains fire normally in the source and the destination's holding period restarts.
 */
export interface TransferHoldingModalProps {
  open: boolean;
  onClose: () => void;
  fromPortfolioId: string;
  securityName: string;
  isin: string;
  /** The source book's FIFO lots, OLDEST FIRST. */
  lots: TransferSourceLot[];
  /** Called after a successful write so the caller can refresh its view. */
  onDone: () => void;
}

const money = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function TransferHoldingModal({
  open, onClose, fromPortfolioId, securityName, isin, lots, onDone,
}: TransferHoldingModalProps) {
  const [toId, setToId] = useState('');
  const [qtyStr, setQtyStr] = useState('');
  const [asSale, setAsSale] = useState(false);
  const [priceStr, setPriceStr] = useState('');
  const [busy, setBusy] = useState(false);

  const held = useMemo(() => lots.reduce((s, l) => s + Math.max(0, l.remaining), 0), [lots]);
  const qty = Number(qtyStr) || 0;
  const plan = useMemo(() => planTransfer(lots, qty), [lots, qty]);

  const from = portfolioById(fromPortfolioId);
  const destinations = PORTFOLIOS.filter((p) => p.id !== fromPortfolioId);
  const to = toId ? portfolioById(toId) : undefined;

  const problem =
    !toId ? 'Choose a destination account.'
      : qty <= 0 ? 'Enter a quantity.'
        : plan.shortfall > 1e-9 ? `Only ${held} share(s) held — ${plan.shortfall} short.`
          : asSale && !(Number(priceStr) > 0) ? 'Enter the sale price per share.'
            : '';

  const run = async () => {
    if (problem || !from || !to) return;
    setBusy(true);
    try {
      // The ref makes a re-run idempotent, and identifies both legs of a half-finished
      // transfer. Stamped from the wall clock so two transfers of the same lot differ.
      const transferRef = `XFER-${from.code}-${to.code}-${Date.now().toString(36).toUpperCase()}`;
      const res = await executeTransfer({
        plan, securityName, isin,
        transferDMY: formatDMY(new Date().toISOString().slice(0, 10)),
        fromLabel: from.label, toLabel: to.label,
        transferRef,
        fromSheetId: from.sheetId, toSheetId: to.sheetId,
        asSale, salePrice: Number(priceStr) || 0,
      });

      if (res.halfDone) {
        // Written to the destination but not the source: the shares are in BOTH books now.
        // Say so plainly and keep the dialog open — this needs a decision, not a dismissal.
        toast.error(res.halfDone);
        return;
      }
      if (res.skipped) { toast.info(res.skipped); onClose(); return; }
      if (!res.ok) { toast.error(res.error || 'Transfer failed.'); return; }

      toast.success(
        `${plan.qty} ${securityName} moved to ${to.label} across ${plan.lots.length} lot(s).`
        + (asSale ? ' Booked as a sale — capital gains will appear in the source account.' : ''));
      if (res.holdingWarning) toast.info(res.holdingWarning);
      onDone();
      onClose();
    } catch (e: any) {
      toast.error(e?.message || 'Transfer failed.');
    } finally {
      setBusy(false);
    }
  };

  const inCls = 'w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-white outline-none focus:ring-1 focus:ring-indigo-500';

  return (
    <ModalShell open={open} onClose={onClose} busy={busy} labelledBy="transfer-title">
      <div className="relative z-10 w-[min(94vw,620px)] max-h-[88vh] flex flex-col bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden animate-scaleIn">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-2.5">
          <div className="p-2 bg-indigo-50 text-indigo-700 rounded-lg"><ArrowRightLeft className="w-4 h-4" /></div>
          <div className="min-w-0">
            <h3 id="transfer-title" className="text-sm font-black text-slate-900 truncate">Transfer {securityName}</h3>
            <p className="text-[11px] text-slate-500">
              {held.toLocaleString('en-IN')} held in {from?.label || fromPortfolioId}
            </p>
          </div>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">To Account</span>
              <select data-autofocus value={toId} onChange={(e) => setToId(e.target.value)} className={`mt-1 ${inCls}`}>
                <option value="">Select…</option>
                {destinations.map((p) => <option key={p.id} value={p.id}>{p.label} ({p.code})</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Quantity</span>
              <input type="number" min="0" step="any" value={qtyStr} onChange={(e) => setQtyStr(e.target.value)}
                placeholder={`max ${held}`} className={`mt-1 ${inCls} font-mono`} />
            </label>
          </div>

          <label className="flex items-start gap-2.5 p-3 bg-slate-50 rounded-lg border border-slate-200 cursor-pointer">
            <input type="checkbox" checked={asSale} onChange={(e) => setAsSale(e.target.checked)} className="mt-0.5" />
            <span className="text-[11px] leading-relaxed text-slate-600">
              <strong className="text-slate-800">This is a sale, not a transfer.</strong> Capital gains will be
              realised in {from?.label || 'the source'} at the price below, and the destination's holding period
              restarts today. Leave unticked to carry the cost basis and the original purchase dates across
              with no gain.
            </span>
          </label>

          {asSale && (
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Sale Price Per Share</span>
              <input type="number" min="0" step="any" value={priceStr} onChange={(e) => setPriceStr(e.target.value)}
                className={`mt-1 ${inCls} font-mono`} />
            </label>
          )}

          {/* The lot preview is the point of the dialog: it shows that a transfer is k rows,
              each keeping its own acquisition date, rather than one averaged row. */}
          {plan.lots.length > 0 && !asSale && (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 text-[10px] font-black uppercase tracking-wider text-slate-500">
                {plan.lots.length} lot(s) will move, each keeping its purchase date
              </div>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-200">
                    <th className="px-3 py-1.5 text-left font-bold">Acquired</th>
                    <th className="px-3 py-1.5 text-right font-bold">Qty</th>
                    <th className="px-3 py-1.5 text-right font-bold">Cost/Share</th>
                    <th className="px-3 py-1.5 text-right font-bold">All-in Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.lots.map((l, i) => (
                    <tr key={i} className="border-b border-slate-100 last:border-b-0">
                      <td className="px-3 py-1.5 font-mono text-slate-700">{l.acquiredDMY}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{l.qty.toLocaleString('en-IN')}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{money(l.purPrice)}</td>
                      <td className="px-3 py-1.5 text-right font-mono font-bold text-slate-800">{money(l.qty * l.inclPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* The accepted limitation, stated where the decision is made rather than buried. */}
          {!asSale && plan.lots.length > 0 && (
            <p className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3 leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                Because each lot keeps its original purchase date, {to?.label || 'the destination'}'s
                NAV and AUM history will show these shares from that date onwards — the same period
                {' '}{from?.label || 'the source'} also held them. Tax treatment is correct; historical
                performance for those years counts them in both accounts.
              </span>
            </p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-between gap-3">
          <span className="text-[11px] text-rose-600 font-semibold">{problem}</span>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onClose} disabled={busy}
              className="px-3 py-1.5 text-[11px] font-black uppercase tracking-wider rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-slate-300 disabled:opacity-40 cursor-pointer">
              Cancel
            </button>
            <button onClick={run} disabled={busy || !!problem}
              className="btn-press inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[11px] font-black uppercase tracking-wider rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-40 cursor-pointer">
              <ArrowRightLeft className="w-3.5 h-3.5" />
              {busy ? 'Transferring…' : asSale ? 'Record Sale' : 'Transfer'}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
