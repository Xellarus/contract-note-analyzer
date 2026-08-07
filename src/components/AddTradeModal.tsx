import { useEffect, useId, useMemo, useState } from 'react';
import { X, Plus, Trash2, Loader2, ChevronDown, AlertCircle, CheckCircle, Sliders, Lock } from 'lucide-react';
import { ModalShell } from './ui/overlay';
import { ManualAction, ManualTradeLine, appendManualTrades, appendCorporateAction, AppendManualResult } from '../lib/manualTrades';
import { solveQtyPriceAmount } from '../lib/tradeRowSchema';
import { CorpActionType } from '../lib/corporateActions';
import { ScripMaster, loadScripMaster, lookupScrip, SCRIP_MASTER_SPREADSHEET_ID } from '../lib/scripMaster';
import { gapi } from 'gapi-script';
import ScripCombobox from './ScripCombobox';
import { hasValidGoogleToken } from '../lib/googleAuth';
import { PORTFOLIOS, portfolioById, sheetIdForId } from '../lib/portfolios';

interface AddTradeModalProps {
  open: boolean;
  onClose: () => void;
  defaultPortfolio: string;
  master: ScripMaster | null;
  onSaved: (pid: string) => void;
  // Holdings of the portfolio the PARENT page has open, used to prefill "shares held" for
  // Bonus/Split. The drawer's own portfolio dropdown can point somewhere else, in which case
  // it fetches that portfolio's Holding tab itself — see `heldRows` below.
  holdings?: { name: string; isin: string; qty: number }[];
  prefill?: { company: string; isin: string };                // pre-select a security (opened from a stock's detail page)
}

const portfolioLabel = (id: string) => { const p = portfolioById(id); return p ? `${p.label} · ${p.code}` : id; };

const ACTIONS: { value: ManualAction; label: string; hint: string }[] = [
  { value: 'Buy', label: 'Buy', hint: 'Adds shares at the price paid.' },
  { value: 'Sell', label: 'Sell', hint: 'Reduces shares; realises gains.' },
  { value: 'IPO', label: 'IPO Allotment', hint: 'Recorded as a buy at the issue price.' },
  { value: 'Bonus', label: 'Bonus', hint: 'Free shares at ₹0 — average cost dilutes.' },
  { value: 'Split', label: 'Split', hint: 'Extra shares at ₹0 — total cost unchanged.' },
  { value: 'Rights', label: 'Rights', hint: 'Rights subscription — a buy at the issue price.' },
];

const CHARGE_FIELDS: { key: keyof Omit<LineDraft, 'id' | 'company' | 'isin' | 'date' | 'amount' | 'action' | 'qty' | 'price' | 'tradeClass' | 'showCharges' | 'ratioNum' | 'ratioDen' | 'held' | 'notes'>; label: string }[] = [
  { key: 'brokerage', label: 'Brokerage' },
  { key: 'stt', label: 'STT' },
  { key: 'exchangeCharges', label: 'Exchange Turnover' },
  { key: 'sebiFees', label: 'SEBI Fees' },
  { key: 'stampDuty', label: 'Stamp Duty' },
  { key: 'gst', label: 'GST / IGST' },
  { key: 'ipf', label: 'IPF' },
];

interface LineDraft {
  id: number;
  company: string;
  isin: string;          // resolved behind the scenes (no input) — still used for scrip matching
  date: string;          // per-line trade date; blank = use the drawer's default date
  amount: string;        // turnover; any TWO of qty/price/amount fill in the third
  action: ManualAction;
  qty: string;
  price: string;
  tradeClass: 'Delivery' | 'Intraday';
  brokerage: string;
  stt: string;
  exchangeCharges: string;
  sebiFees: string;
  stampDuty: string;
  gst: string;
  ipf: string;
  showCharges: boolean;
  // Bonus/Split ratio helper (drives `qty`; Bonus = N:M free per held, Split = new:old).
  ratioNum: string;
  ratioDen: string;
  held: string;
  notes: string;   // optional free-text note, stored in the ledger's Notes column
}

const num = (s: string): number => { const v = parseFloat((s || '').toString().replace(/,/g, '').trim()); return isNaN(v) ? 0 : v; };
const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let _seq = 1;
const blankLine = (): LineDraft => ({
  id: _seq++, company: '', isin: '', date: '', amount: '', action: 'Buy', qty: '', price: '', tradeClass: 'Delivery',
  brokerage: '', stt: '', exchangeCharges: '', sebiFees: '', stampDuty: '', gst: '', ipf: '', showCharges: false,
  ratioNum: '', ratioDen: '', held: '', notes: '',
});

// Bonus/Split: turn the ratio + shares-held into a free-share quantity (written to `qty`,
// which stays the source of truth on save so the calc engine is unchanged).
//   • Bonus  N : M      → held × N/M   free shares (e.g. 1:1 doubles the holding)
//   • Split  new : old  → held × (new/old − 1) free shares (each `old` becomes `new`)
const freeSharesFromRatio = (l: LineDraft): number => {
  const held = num(l.held), n = num(l.ratioNum), d = num(l.ratioDen);
  if (!(held > 0) || !(n > 0) || !(d > 0)) return 0;
  const free = l.action === 'Split' ? held * (n / d - 1) : held * (n / d);
  return free > 0 ? Math.round(free * 1e6) / 1e6 : 0;
};
const applyRatio = (l: LineDraft): LineDraft =>
  isFreeShares(l.action) ? { ...l, qty: (() => { const f = freeSharesFromRatio(l); return f > 0 ? String(f) : ''; })() } : l;

const todayISO = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const isFreeShares = (a: ManualAction) => a === 'Bonus' || a === 'Split';
const isDeliveryLocked = (a: ManualAction) => isFreeShares(a) || a === 'IPO' || a === 'Rights';

export default function AddTradeModal({ open, onClose, defaultPortfolio, master, onSaved, holdings, prefill }: AddTradeModalProps) {
  const titleId = useId();
  const [portfolio, setPortfolio] = useState<string>(defaultPortfolio);
  const [tradeDate, setTradeDate] = useState<string>(todayISO());
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AppendManualResult | null>(null);
  // The company autocomplete needs the scrip master. Normally it's passed in from
  // Holdings, but load it here too if that prop is null (modal opened before Holdings
  // finished loading, or that load failed) so the dropdown is never empty.
  const [selfMaster, setSelfMaster] = useState<ScripMaster | null>(null);
  const activeMaster = master || selfMaster;
  useEffect(() => {
    if (open && !master && !selfMaster && hasValidGoogleToken()) {
      loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID).then(setSelfMaster).catch(() => {});
    }
  }, [open, master, selfMaster]);

  // Corporate-action mode (merger / demerger → dedicated tab).
  const [mode, setMode] = useState<'trades' | 'corpaction'>('trades');
  const [caType, setCaType] = useState<CorpActionType>('Merger');
  const [caDate, setCaDate] = useState<string>(todayISO());
  const [caFrom, setCaFrom] = useState('');
  const [caTo, setCaTo] = useState('');
  const [caSharesIn, setCaSharesIn] = useState('');
  const [caCost, setCaCost] = useState('');
  const [caNotes, setCaNotes] = useState('');
  const [caSaving, setCaSaving] = useState(false);
  const [caError, setCaError] = useState<string | null>(null);
  const [caResult, setCaResult] = useState<{ holdingWarning?: string; capGainsWarning?: string } | null>(null);

  // Reset to a fresh form each time the drawer opens.
  useEffect(() => {
    if (!open) return;
    setPortfolio(defaultPortfolio);
    setTradeDate(todayISO());
    // Opened from a stock's detail page → seed the first line with that security.
    setLines([prefill?.company ? { ...blankLine(), company: prefill.company, isin: prefill.isin || '' } : blankLine()]);
    setSaving(false); setError(null); setResult(null);
    setMode('trades'); setCaType('Merger'); setCaDate(todayISO());
    setCaFrom(''); setCaTo(''); setCaSharesIn(''); setCaCost(''); setCaNotes('');
    setCaSaving(false); setCaError(null); setCaResult(null);
  }, [open, defaultPortfolio, prefill?.company, prefill?.isin]);

  // ── "Shares held" source ─────────────────────────────────────────────────────
  // The `holdings` prop is whatever portfolio the Holdings page has OPEN — but this drawer
  // has its own portfolio dropdown, so the two drift apart the moment the user switches it
  // (open on Taparia, switch the drawer to Saket → we were searching Taparia's holdings for
  // a Saket stock and finding nothing, so Bonus/Split never auto-filled). When the drawer's
  // portfolio isn't the parent's, read that portfolio's Holding tab directly.
  const [heldRows, setHeldRows] = useState<{ name: string; isin: string; qty: number }[]>([]);
  const holdingsLen = holdings?.length || 0;
  const usePropHoldings = portfolio === defaultPortfolio && holdingsLen > 0;
  useEffect(() => {
    if (!open || usePropHoldings) { setHeldRows([]); return; }
    const sid = sheetIdForId(portfolio);
    if (!sid || !hasValidGoogleToken()) { setHeldRows([]); return; }
    let cancelled = false;
    (gapi.client as any).sheets.spreadsheets.values
      .get({ spreadsheetId: sid, range: 'Holding!A:E' })   // A name | B isin | C qty | D avg | E invested
      .then((res: any) => {
        if (cancelled) return;
        const rows: any[][] = res?.result?.values || [];
        setHeldRows(rows.slice(1).map((r) => ({
          name: (r?.[0] ?? '').toString().trim(),
          isin: (r?.[1] ?? '').toString().trim(),
          qty: parseFloat((r?.[2] ?? '0').toString().replace(/,/g, '')) || 0,
        })).filter((h) => h.name || h.isin));
      })
      .catch(() => { if (!cancelled) setHeldRows([]); });
    return () => { cancelled = true; };
  }, [open, portfolio, usePropHoldings]);
  const activeHoldings = usePropHoldings ? holdings! : heldRows;

  // Opened from a stock's detail page → the whole drawer is about THAT security. Show it once
  // at the top and drop the per-line company picker: re-choosing it on every added line was
  // just a chance to book a trade against the wrong stock.
  const lockedScrip = prefill?.company ? { company: prefill.company, isin: prefill.isin || '' } : null;

  // Re-sync "shares held" on any line already carrying a company when the holdings behind it
  // change — the drawer's portfolio was switched, or the parent's holdings finished loading
  // after the drawer opened. Without this, `held` only ever filled at the moment the company
  // was picked, so a company chosen before the data arrived stayed blank forever.
  // Fill-only: never blanks a figure the user typed for a back-dated action.
  useEffect(() => {
    if (!open) return;
    setLines((prev) => {
      let changed = false;
      const next = prev.map((l) => {
        if (!isFreeShares(l.action) || !l.company.trim()) return l;
        const h = heldFor(l.company, l.isin);
        if (h == null || String(h) === l.held) return l;
        changed = true;
        return applyRatio({ ...l, held: String(h) });
      });
      return changed ? next : prev;
    });
  }, [open, portfolio, heldRows, holdingsLen]);

  // Company autocomplete is handled by <ScripCombobox> (a filtered typeahead), not a
  // native <datalist> — the latter silently stops rendering suggestions once the master
  // reaches ~5,000 entries, which broke the dropdown for every scrip.

  if (!open) return null;

  const setLine = (id: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  // Quantity / Price / Amount are linked: type any TWO and the third fills itself in.
  const setLineQPA = (id: number, field: 'qty' | 'price' | 'amount', value: string) =>
    setLines((prev) => prev.map((l) => {
      if (l.id !== id) return l;
      const next = { ...l, [field]: value } as LineDraft;
      const s = solveQtyPriceAmount(field, next.qty, next.price, next.amount);
      return { ...next, qty: s.qty, price: s.price, amount: s.amount };
    }));
  // Apply a patch and, for Bonus/Split, recompute the free-share qty from the ratio.
  const setLineRatio = (id: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l) => (l.id === id ? applyRatio({ ...l, ...patch }) : l)));
  // Current holding of a company (in the portfolio SELECTED IN THIS DRAWER) — auto-fills
  // "shares held" for Bonus/Split.
  const heldFor = (company: string, isin: string): number | null => {
    const rows = activeHoldings;
    if (!rows.length) return null;
    const c = company.trim().toLowerCase(), i = isin.trim().toUpperCase();
    let h = rows.find((x) => (i && (x.isin || '').toUpperCase() === i) || (c && x.name.trim().toLowerCase() === c));
    // The company box is a NAME-only typeahead (ScripCombobox reports no ISIN), so `i` is
    // normally blank and this came down to exact string equality against whatever spelling
    // the Holding tab happens to carry. Fall back to the shared scrip-master key — the same
    // identity every replay engine groups by — so an alias or short code still resolves.
    if (!h && activeMaster && (c || i)) {
      const e = lookupScrip(activeMaster, isin.trim(), company.trim()).entry;
      if (e) h = rows.find((x) => lookupScrip(activeMaster, x.isin, x.name).entry?.key === e.key);
    }
    return h && h.qty > 0 ? h.qty : null;
  };
  // Company/ISIN edits: for a Bonus/Split line, resync `held` to the chosen stock's current
  // holding so the free-share count + "held → total" summary recompute automatically (no manual
  // "shares held" entry). For any other action this is just a normal field set.
  const setLineIdentity = (l: LineDraft, patch: Partial<LineDraft>) => {
    if (isFreeShares(l.action)) {
      const next = { ...l, ...patch };
      const h = heldFor(next.company, next.isin);
      patch = { ...patch, held: h != null ? String(h) : '' };
    }
    setLineRatio(l.id, patch);
  };
  const removeLine = (id: number) => setLines((prev) => (prev.length === 1 ? prev : prev.filter((l) => l.id !== id)));
  // A new line starts from the previous one rather than from scratch: same security when the
  // drawer is locked to one (opened from a stock's detail page), and the same Type/Class,
  // since a second line is nearly always more of the same trade. Everything stays editable.
  const addLine = () => setLines((prev) => {
    const last = prev[prev.length - 1];
    const next = blankLine();
    if (lockedScrip) { next.company = lockedScrip.company; next.isin = lockedScrip.isin; }
    if (last) {
      next.action = last.action;
      next.tradeClass = isDeliveryLocked(last.action) ? 'Delivery' : last.tradeClass;
      // Carried a Bonus/Split forward → re-derive shares held for the (known) security.
      if (isFreeShares(next.action) && next.company) {
        const h = heldFor(next.company, next.isin);
        if (h != null) next.held = String(h);
      }
    }
    return [...prev, next];
  });

  const linePreview = (l: LineDraft) => {
    const free = isFreeShares(l.action);
    const qty = num(l.qty);
    const price = free ? 0 : num(l.price);
    // Prefer the typed Amount (it's the money actually transacted); fall back to qty × price.
    const turnover = free ? 0 : (num(l.amount) > 0 ? num(l.amount) : qty * price);
    const charges = free ? 0 : (num(l.brokerage) + num(l.stt) + num(l.exchangeCharges) + num(l.sebiFees) + num(l.stampDuty) + num(l.gst) + num(l.ipf));
    const buySide = l.action !== 'Sell';
    const net = buySide ? turnover + charges : turnover - charges;
    return { turnover, charges, net, buySide };
  };

  const lineError = (l: LineDraft): string | null => {
    if (!l.company.trim()) return 'Company is required';
    if (isFreeShares(l.action)) return num(l.qty) > 0 ? null : 'Enter a ratio and shares held';
    if (num(l.qty) <= 0) return 'Quantity must be greater than 0';
    if (num(l.price) <= 0) return 'Price must be greater than 0';
    return null;
  };

  // A wholly-empty line (e.g. a trailing "Add another line") is ignored, not an error.
  const isBlank = (l: LineDraft) => !l.company.trim() && !l.qty.trim() && !l.price.trim() && !l.amount.trim();
  const filledLines = lines.filter((l) => !isBlank(l));
  const validLines = filledLines.filter((l) => lineError(l) === null);
  const totals = validLines.reduce(
    (acc, l) => { const p = linePreview(l); acc.charges += p.charges; acc.turnover += p.turnover; return acc; },
    { charges: 0, turnover: 0 },
  );

  const canSave = !saving && hasValidGoogleToken() && !!tradeDate && filledLines.length > 0 && filledLines.every((l) => lineError(l) === null);

  const handleSave = async () => {
    setError(null);
    if (!hasValidGoogleToken()) { setError('Google Sheets isn’t connected. Open the Holdings tab and click “Sync Google Sheet” first.'); return; }
    if (filledLines.length === 0) { setError('Add at least one trade line.'); return; }
    const firstBad = filledLines.map((l) => lineError(l)).find((e) => e !== null);
    if (firstBad) { setError(firstBad); return; }

    const toPayload = (l: LineDraft): ManualTradeLine => ({
      isin: l.isin.trim(),
      securityName: l.company.trim(),
      action: l.action,
      quantity: num(l.qty),
      price: num(l.price),
      tradeClass: l.tradeClass,
      brokerage: num(l.brokerage),
      stt: num(l.stt),
      exchangeCharges: num(l.exchangeCharges),
      sebiFees: num(l.sebiFees),
      stampDuty: num(l.stampDuty),
      gst: num(l.gst),
      ipf: num(l.ipf),
      notes: l.notes.trim(),
    });

    // Lines can each carry their own date (blank = the drawer's default), so group by the
    // effective date — appendManualTrades stamps ONE date across the batch it's given.
    const byDate = new Map<string, ManualTradeLine[]>();
    for (const l of filledLines) {
      const d = (l.date || tradeDate).trim();
      const g = byDate.get(d);
      if (g) g.push(toPayload(l)); else byDate.set(d, [toPayload(l)]);
    }

    setSaving(true);
    try {
      const sheetId = sheetIdForId(portfolio);
      let added = 0;
      const warnings: AppendManualResult = { added: 0 };
      for (const [d, group] of byDate) {
        const res = await appendManualTrades(sheetId, group, d);
        added += res.added;
        if (res.holdingWarning) warnings.holdingWarning = res.holdingWarning;
        if (res.capGainsWarning) warnings.capGainsWarning = res.capGainsWarning;
      }
      setResult({ ...warnings, added });
      onSaved(portfolio);
    } catch (e: any) {
      setError(e?.result?.error?.message || e?.message || 'Could not save the trade(s).');
    } finally {
      setSaving(false);
    }
  };

  // Contextual labels per corporate-action type.
  const caLabels = caType === 'Merger'
    ? { from: 'Target company (merging away)', to: 'Acquirer (shares received)', cost: 'Total cost carried to acquirer', hint: 'Target is removed; the acquirer gains the shares received, carrying the cost you enter. Capital-gains holding period for the new shares starts on this date.' }
    : { from: 'Parent company', to: 'New company (shares received)', cost: 'Cost moved to new company (reduces parent)', hint: 'Parent’s cost drops by the amount entered (quantity unchanged); the new company is created with that cost. Holding period for the new shares starts on this date.' };

  const caValid = !!caDate && !!caFrom.trim() && !!caTo.trim() && num(caSharesIn) > 0 && num(caCost) > 0;
  const handleSaveCa = async () => {
    setCaError(null);
    if (!hasValidGoogleToken()) { setCaError('Google Sheets isn’t connected. Open the Holdings tab and click “Sync Google Sheet” first.'); return; }
    if (!caFrom.trim() || !caTo.trim()) { setCaError('Both the “from” and “to” companies are required.'); return; }
    if (num(caSharesIn) <= 0) { setCaError('Shares received must be greater than 0.'); return; }
    if (num(caCost) <= 0) { setCaError('Cost must be greater than 0.'); return; }
    setCaSaving(true);
    try {
      const res = await appendCorporateAction(sheetIdForId(portfolio), {
        dateStr: caDate, type: caType, from: caFrom.trim(), to: caTo.trim(),
        sharesIn: num(caSharesIn), cost: num(caCost), notes: caNotes.trim(),
      });
      setCaResult(res);
      onSaved(portfolio);
    } catch (e: any) {
      setCaError(e?.result?.error?.message || e?.message || 'Could not record the corporate action.');
    } finally {
      setCaSaving(false);
    }
  };

  const busy = saving || caSaving;

  return (
    <ModalShell open={open} variant="drawer" busy={busy} onClose={onClose} labelledBy={titleId} zClass="z-50">
      <div className="relative z-10 h-full w-full max-w-3xl bg-white shadow-2xl flex flex-col animate-slideIn overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0">
          <div>
            <h3 id={titleId} className="text-base font-black text-slate-800 tracking-tight">Add Trade</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">Manually record trades & corporate actions into the portfolio ledger.</p>
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Close" title="Close" className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 disabled:opacity-40 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode toggle */}
        {!result && !caResult && (
          <div className="px-6 pt-4">
            <div className="inline-flex rounded-xl border border-slate-200 p-0.5 bg-slate-50 text-xs font-bold">
              {(['trades', 'corpaction'] as const).map((m) => (
                <button
                  key={m} onClick={() => setMode(m)} disabled={busy}
                  className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer disabled:opacity-50 ${mode === m ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'}`}
                >
                  {m === 'trades' ? 'Trades' : 'Corporate Action'}
                </button>
              ))}
            </div>
          </div>
        )}

        {caResult ? (
          /* ── Corporate action success ── */
          <div className="flex-1 overflow-y-auto p-8 flex flex-col items-center justify-center text-center">
            <div className="w-14 h-14 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center mb-4">
              <CheckCircle className="w-7 h-7 text-emerald-600" />
            </div>
            <h4 className="text-lg font-black text-slate-800">{caType} recorded</h4>
            <p className="text-xs text-slate-500 mt-1"><strong>{caFrom}</strong> → <strong>{caTo}</strong> written to {portfolioLabel(portfolio)} — the Holding tab and capital gains were recalculated.</p>
            {(caResult.holdingWarning || caResult.capGainsWarning) && (
              <div className="mt-4 w-full max-w-md text-left space-y-2">
                {caResult.holdingWarning && (
                  <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[11px] text-amber-800">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>Recorded, but the Holding tab could not be rebuilt: {caResult.holdingWarning}</span>
                  </div>
                )}
                {caResult.capGainsWarning && (
                  <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[11px] text-amber-800">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>Recorded, but capital gains could not be synced: {caResult.capGainsWarning}</span>
                  </div>
                )}
              </div>
            )}
            <button onClick={onClose} className="btn-press px-5 py-2 mt-6 text-xs font-black text-white bg-slate-900 hover:bg-slate-800 rounded-xl cursor-pointer">Done</button>
          </div>
        ) : mode === 'corpaction' ? (
          /* ── Corporate action form ── */
          <>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Portfolio</label>
                  <select value={portfolio} onChange={(e) => setPortfolio(e.target.value)} className="w-full px-3 py-2 text-xs font-semibold text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white cursor-pointer">
                    {PORTFOLIOS.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.code}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Action</label>
                  <select value={caType} onChange={(e) => setCaType(e.target.value as CorpActionType)} className="w-full px-3 py-2 text-xs font-semibold text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white cursor-pointer">
                    <option value="Merger">Merger</option>
                    <option value="Demerger">Demerger</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Date <span className="text-rose-500">*</span></label>
                  <input type="date" value={caDate} onChange={(e) => setCaDate(e.target.value)} className="w-full px-3 py-2 text-xs text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{caLabels.from}</label>
                  <ScripCombobox value={caFrom} onChange={setCaFrom} master={activeMaster} placeholder="Company name…" className="w-full px-3 py-2 text-xs text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white" />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{caLabels.to}</label>
                  <ScripCombobox value={caTo} onChange={setCaTo} master={activeMaster} placeholder="Company name…" className="w-full px-3 py-2 text-xs text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Shares received <span className="text-rose-500">*</span></label>
                  <input type="number" min="0" step="any" placeholder="0" value={caSharesIn} onChange={(e) => setCaSharesIn(e.target.value)} className="w-full px-3 py-2 text-xs text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white font-mono" />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{caLabels.cost} (₹) <span className="text-rose-500">*</span></label>
                  <input type="number" min="0" step="any" placeholder="0" value={caCost} onChange={(e) => setCaCost(e.target.value)} className="w-full px-3 py-2 text-xs text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white font-mono" />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Notes <span className="font-normal normal-case text-slate-400">(optional)</span></label>
                <input type="text" placeholder="e.g. ratio, record date…" value={caNotes} onChange={(e) => setCaNotes(e.target.value)} className="w-full px-3 py-2 text-xs text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white" />
              </div>

              <p className="text-[11px] text-slate-400 leading-relaxed">{caLabels.hint}</p>

              {!hasValidGoogleToken() && (
                <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[11px] text-amber-800">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>Google Sheets isn’t connected. Click “Sync Google Sheet” on the Holdings tab, then return here.</span>
                </div>
              )}
              {caError && (
                <div className="flex items-start gap-2 p-3 rounded-xl border border-rose-200 bg-rose-50 text-[11px] text-rose-700">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{caError}</span>
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 px-6 py-4 shrink-0 flex items-center justify-end gap-3">
              <button onClick={onClose} disabled={caSaving} className="btn-press px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl disabled:opacity-40 cursor-pointer">Cancel</button>
              <button onClick={handleSaveCa} disabled={caSaving || !caValid || !hasValidGoogleToken()} className="btn-press px-5 py-2 text-xs font-black text-white bg-slate-900 hover:bg-slate-800 rounded-xl flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                {caSaving ? <><Loader2 className="w-4 h-4 animate-spin" /> Recording…</> : <>Record {caType}</>}
              </button>
            </div>
          </>
        ) : result ? (
          /* ── Success ── */
          <div className="flex-1 overflow-y-auto p-8 flex flex-col items-center justify-center text-center">
            <div className="w-14 h-14 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center mb-4">
              <CheckCircle className="w-7 h-7 text-emerald-600" />
            </div>
            <h4 className="text-lg font-black text-slate-800">{result.added} trade{result.added === 1 ? '' : 's'} recorded</h4>
            <p className="text-xs text-slate-500 mt-1">Written to <strong>{portfolioLabel(portfolio)}</strong> — the Holding tab and capital gains were recalculated.</p>
            {(result.holdingWarning || result.capGainsWarning) && (
              <div className="mt-4 w-full max-w-md text-left space-y-2">
                {result.holdingWarning && (
                  <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[11px] text-amber-800">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>Rows saved, but the Holding tab could not be rebuilt: {result.holdingWarning}</span>
                  </div>
                )}
                {result.capGainsWarning && (
                  <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[11px] text-amber-800">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>Rows saved, but capital gains could not be synced: {result.capGainsWarning}</span>
                  </div>
                )}
              </div>
            )}
            <div className="flex gap-3 mt-6">
              {/* Keep the locked security across "Add more" — otherwise the fresh line would have
                  no company and no picker to set one. */}
              <button onClick={() => { setResult(null); setLines([lockedScrip ? { ...blankLine(), company: lockedScrip.company, isin: lockedScrip.isin } : blankLine()]); }} className="btn-press px-4 py-2 text-xs font-bold text-indigo-600 border border-indigo-200 hover:bg-indigo-50 rounded-xl cursor-pointer">Add more</button>
              <button onClick={onClose} className="btn-press px-5 py-2 text-xs font-black text-white bg-slate-900 hover:bg-slate-800 rounded-xl cursor-pointer">Done</button>
            </div>
          </div>
        ) : (
          <>
            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              {/* Top: portfolio + date */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Portfolio</label>
                  <select
                    value={portfolio} onChange={(e) => setPortfolio(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-semibold text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white cursor-pointer"
                  >
                    {PORTFOLIOS.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.code}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Default Trade Date <span className="text-rose-500">*</span></label>
                  <input
                    type="date" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)}
                    title="Applies to every line that doesn't set its own date."
                    className="w-full px-3 py-2 text-xs text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
                  />
                </div>
              </div>

              {/* Locked to one security (opened from its detail page) — stated once, so no line
                  needs its own company picker. */}
              {lockedScrip && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-indigo-50 border border-indigo-200">
                  <Lock className="w-3.5 h-3.5 text-indigo-600 mt-0.5 shrink-0" />
                  <p className="text-[11px] text-indigo-800 leading-relaxed">
                    Every line books against <b className="font-bold">{lockedScrip.company}</b>.
                    {' '}To record a different company, use <b className="font-bold">Add Trade</b> from the holdings list.
                  </p>
                </div>
              )}

              {/* Line items */}
              <div className="space-y-3">
                {lines.map((l, idx) => {
                  const free = isFreeShares(l.action);
                  const deliveryLocked = isDeliveryLocked(l.action);
                  const prev = linePreview(l);
                  const err = lineError(l);
                  const actionHint = ACTIONS.find((a) => a.value === l.action)?.hint;
                  // Bonus/Split: shares held come straight from the current holding (auto); the
                  // manual box only appears when we can't determine it (holdings not loaded / not held).
                  const autoHeld = free ? heldFor(l.company, l.isin) : null;
                  const heldKnown = autoHeld != null;
                  const heldNum = num(l.held);   // the (auto-filled but editable) field is the source of truth
                  const freeNum = num(l.qty);                 // computed by applyRatio from held + ratio
                  const totalNum = heldNum + freeNum;
                  const ratioReady = num(l.ratioNum) > 0 && num(l.ratioDen) > 0;
                  return (
                    <div key={l.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Line {idx + 1}</span>
                        <button
                          onClick={() => removeLine(l.id)} disabled={lines.length === 1}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer"
                          aria-label="Remove line" title="Remove line"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      {/* Company + this line's own date (ISIN is resolved from the scrip master — no input needed).
                          Locked to one security → the picker is gone and Date takes the row. */}
                      <div className={`grid grid-cols-1 gap-3 ${lockedScrip ? '' : 'sm:grid-cols-3'}`}>
                        {!lockedScrip && (
                          <div className="sm:col-span-2 space-y-1">
                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Company</label>
                            <ScripCombobox
                              value={l.company} onChange={(v) => setLineIdentity(l, { company: v })}
                              master={activeMaster} placeholder="Start typing a company name…"
                              className="w-full px-3 py-2 text-xs text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
                            />
                          </div>
                        )}
                        <div className="space-y-1">
                          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                            Date {!l.date && <span className="font-normal normal-case text-slate-400">(default)</span>}
                          </label>
                          <input
                            type="date" value={l.date || tradeDate}
                            onChange={(e) => setLine(l.id, { date: e.target.value })}
                            title="This line's trade date — defaults to the date at the top of the drawer."
                            className={`w-full px-3 py-2 text-xs rounded-lg border outline-none focus:ring-1 focus:ring-indigo-500 ${l.date ? 'border-indigo-200 bg-white text-slate-800' : 'border-slate-200 bg-white text-slate-500'}`}
                          />
                        </div>
                      </div>

                      {/* Type + (Qty · Price · Amount · Class) for trades — or (Ratio · Held) for Bonus/Split */}
                      <div className={`grid grid-cols-2 gap-3 ${free ? 'sm:grid-cols-4' : 'sm:grid-cols-5'}`}>
                        <div className="space-y-1">
                          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Type</label>
                          <select
                            value={l.action}
                            onChange={(e) => {
                              const action = e.target.value as ManualAction;
                              const patch: Partial<LineDraft> = { action, tradeClass: isDeliveryLocked(action) ? 'Delivery' : l.tradeClass };
                              // Switching to Bonus/Split: pull shares-held from the current holding so the
                              // conversion computes automatically (keep any prior manual value if unknown).
                              if (isFreeShares(action)) { const h = heldFor(l.company, l.isin); patch.held = h != null ? String(h) : l.held; }
                              setLineRatio(l.id, patch);
                            }}
                            className="w-full px-2.5 py-2 text-xs font-semibold text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white cursor-pointer"
                          >
                            {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                          </select>
                        </div>

                        {free ? (
                          <>
                            <div className="space-y-1">
                              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{l.action === 'Split' ? 'Ratio (new : old)' : 'Ratio (bonus : held)'}</label>
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number" min="0" step="any" placeholder={l.action === 'Split' ? 'new' : 'N'}
                                  value={l.ratioNum} onChange={(e) => setLineRatio(l.id, { ratioNum: e.target.value })}
                                  className="w-full min-w-0 px-2 py-2 text-xs text-center text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white font-mono"
                                />
                                <span className="text-slate-400 font-bold shrink-0">:</span>
                                <input
                                  type="number" min="0" step="any" placeholder={l.action === 'Split' ? 'old' : 'M'}
                                  value={l.ratioDen} onChange={(e) => setLineRatio(l.id, { ratioDen: e.target.value })}
                                  className="w-full min-w-0 px-2 py-2 text-xs text-center text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white font-mono"
                                />
                              </div>
                            </div>
                            <div className="space-y-1 col-span-2">
                              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                Shares held {heldKnown && <span className="font-normal normal-case text-emerald-600">· auto</span>}
                              </label>
                              {/* Auto-filled from the current holding, but still editable: a BACK-DATED bonus/split
                                  acted on the position as it was THEN, which can differ from today's. */}
                              <input
                                type="number" min="0" step="any" placeholder="shares held before this action"
                                value={l.held} onChange={(e) => setLineRatio(l.id, { held: e.target.value })}
                                title={heldKnown ? 'Auto-filled from your current holding — edit it for a back-dated action.' : undefined}
                                className={`w-full px-3 py-2 text-xs rounded-lg border outline-none focus:ring-1 focus:ring-indigo-500 font-mono text-slate-800 ${heldKnown ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-white'}`}
                              />
                            </div>
                          </>
                        ) : (
                          <>
                            {/* Quantity · Price · Amount — enter any TWO, the third computes itself. */}
                            <div className="space-y-1">
                              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Quantity</label>
                              <input
                                type="number" min="0" step="any" placeholder="0"
                                value={l.qty} onChange={(e) => setLineQPA(l.id, 'qty', e.target.value)}
                                className="w-full px-3 py-2 text-xs text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white font-mono"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">{l.action === 'IPO' ? 'Issue Price' : l.action === 'Rights' ? 'Rights Price' : 'Price'}</label>
                              <input
                                type="number" min="0" step="any" placeholder="0"
                                value={l.price} onChange={(e) => setLineQPA(l.id, 'price', e.target.value)}
                                className="w-full px-3 py-2 text-xs text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white font-mono"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Amount</label>
                              <input
                                type="number" min="0" step="any" placeholder="0"
                                value={l.amount} onChange={(e) => setLineQPA(l.id, 'amount', e.target.value)}
                                title="Turnover. Fill any two of Quantity / Price / Amount and the third is worked out."
                                className="w-full px-3 py-2 text-xs text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white font-mono"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Class</label>
                              <select
                                value={l.tradeClass} disabled={deliveryLocked}
                                onChange={(e) => setLine(l.id, { tradeClass: e.target.value as 'Delivery' | 'Intraday' })}
                                className="w-full px-2.5 py-2 text-xs font-semibold text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white cursor-pointer disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed"
                              >
                                <option value="Delivery">Delivery</option>
                                <option value="Intraday">Intraday</option>
                              </select>
                            </div>
                          </>
                        )}
                      </div>

                      {free ? (
                        <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 text-[11px] text-slate-600">
                          {heldNum > 0 && ratioReady && freeNum > 0 ? (
                            <span>
                              You hold <b className="font-mono text-slate-800">{heldNum.toLocaleString('en-IN')}</b> → this {l.action.toLowerCase()} of{' '}
                              <b className="font-mono">{num(l.ratioNum)} : {num(l.ratioDen)}</b> adds{' '}
                              <b className="font-mono text-indigo-700">+{freeNum.toLocaleString('en-IN')}</b> free share{freeNum === 1 ? '' : 's'} at ₹0 → new total{' '}
                              <b className="font-mono text-slate-900">{totalNum.toLocaleString('en-IN')}</b>.
                            </span>
                          ) : (
                            <span className="text-slate-400">
                              {heldKnown
                                ? 'Enter the ratio — the free-share count and new total fill in automatically.'
                                : 'Pick the company (must be a held stock) and enter the ratio; shares held and the new total then compute automatically.'}
                            </span>
                          )}
                        </div>
                      ) : actionHint ? <p className="text-[10px] text-slate-400">{actionHint}</p> : null}

                      {/* Charges */}
                      {!free && (
                        <div>
                          <button
                            onClick={() => setLine(l.id, { showCharges: !l.showCharges })}
                            className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-600 hover:text-indigo-700 cursor-pointer"
                          >
                            <Sliders className="w-3.5 h-3.5" />
                            Charges & taxes {prev.charges > 0 ? `· ${inr(prev.charges)}` : ''}
                            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${l.showCharges ? 'rotate-180' : ''}`} />
                          </button>
                          {l.showCharges && (
                            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 rounded-xl border border-slate-200 bg-white">
                              {CHARGE_FIELDS.map((f) => (
                                <div key={f.key} className="space-y-1">
                                  <label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider block">{f.label}</label>
                                  <input
                                    type="number" min="0" step="any" placeholder="0"
                                    value={l[f.key] as string} onChange={(e) => setLine(l.id, { [f.key]: e.target.value } as Partial<LineDraft>)}
                                    className="w-full px-2.5 py-1.5 text-xs text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white font-mono"
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Note (optional) — stored in the ledger's Notes column, shown in the Trade Book entry popup */}
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Note <span className="font-normal normal-case text-slate-400">(optional)</span></label>
                        <input
                          type="text" placeholder="e.g. reason, corporate-action ref, source…"
                          value={l.notes} onChange={(e) => setLine(l.id, { notes: e.target.value })}
                          className="w-full px-3 py-2 text-xs text-slate-800 rounded-lg border border-slate-200 outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
                        />
                      </div>

                      {/* Per-line preview */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] pt-1 border-t border-slate-200">
                        <span className="text-slate-500">Turnover <strong className="font-mono text-slate-700">{inr(prev.turnover)}</strong></span>
                        {!free && <span className="text-slate-500">Charges <strong className="font-mono text-slate-700">{inr(prev.charges)}</strong></span>}
                        <span className="text-slate-500">{prev.buySide ? 'Net outflow' : 'Net inflow'} <strong className="font-mono text-slate-900">{inr(prev.net)}</strong></span>
                        {err && l.company.trim() !== '' && <span className="text-rose-500 font-semibold ml-auto">{err}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                onClick={addLine}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-slate-600 border border-dashed border-slate-300 hover:border-indigo-300 hover:text-indigo-600 rounded-xl w-full justify-center cursor-pointer"
              >
                <Plus className="w-4 h-4" /> Add another line
              </button>

              {!hasValidGoogleToken() && (
                <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[11px] text-amber-800">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>Google Sheets isn’t connected. Click “Sync Google Sheet” on the Holdings tab, then return here.</span>
                </div>
              )}
              {error && (
                <div className="flex items-start gap-2 p-3 rounded-xl border border-rose-200 bg-rose-50 text-[11px] text-rose-700">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{error}</span>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-slate-200 px-6 py-4 shrink-0 flex items-center justify-between gap-4">
              <div className="text-[11px] text-slate-500">
                <span className="font-bold text-slate-700">{validLines.length}</span> line{validLines.length === 1 ? '' : 's'} ready ·
                turnover <span className="font-mono text-slate-700">{inr(totals.turnover)}</span> ·
                charges <span className="font-mono text-slate-700">{inr(totals.charges)}</span>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={onClose} disabled={saving} className="btn-press px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl disabled:opacity-40 cursor-pointer">Cancel</button>
                <button
                  onClick={handleSave} disabled={!canSave}
                  className="btn-press px-5 py-2 text-xs font-black text-white bg-slate-900 hover:bg-slate-800 rounded-xl flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : <>Save {validLines.length > 0 ? validLines.length : ''} trade{validLines.length === 1 ? '' : 's'}</>}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </ModalShell>
  );
}
