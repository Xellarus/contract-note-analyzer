import { useState, useMemo, useEffect } from 'react';
import {
  UploadCloud, FileSpreadsheet, Loader2, CheckCircle2, AlertCircle, AlertTriangle, X, Layers, CalendarClock, Link2Off, Wand2, Pencil,
} from 'lucide-react';
import {
  parseHoldingStatement, parseTransactionStatement, parseHoldingPeriodReport, reconstructOpeningLots,
  ReconstructResult, OpeningLot, ActionResolution,
} from '../lib/openingBasis';
import { saveOpeningHoldings } from '../lib/openingHoldings';
import { loadOpeningCorpActions, saveOpeningCorpActions } from '../lib/openingCorpActions';
import { saveScripIndustries } from '../lib/scripIndustries';
import { rebuildHoldingTab, syncCapitalGains } from '../lib/holdingsCalc';
import { PORTFOLIOS, portfolioById } from '../lib/portfolios';
import { loadScripMaster, lookupScrip, ScripMaster, SCRIP_MASTER_SPREADSHEET_ID } from '../lib/scripMaster';
import { hasValidGoogleToken } from '../lib/googleAuth';
import { toast, ModalShell } from './ui/overlay';

// Standardize a lot's security to the scrip master's canonical name + ISIN, so
// opening lots FIFO-match the same stock in FY26 contract notes.
const resolveLots = (m: ScripMaster | null, lots: OpeningLot[]): OpeningLot[] =>
  lots.map(l => { const e = m ? lookupScrip(m, '', l.name).entry : null; return e ? { ...l, name: e.canonicalName, isin: e.isin || '' } : l; });

const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

interface WriteResult { lots: number; holdingErr?: string; cgErr?: string; }
type DraftRow = { num: string; den: string; price: string };

export default function OpeningBasisImport() {
  const [portfolioId, setPortfolioId] = useState(PORTFOLIOS[0]?.id || '');
  const [holdingText, setHoldingText] = useState<string | null>(null);
  const [txnText, setTxnText] = useState<string | null>(null);
  const [hpText, setHpText] = useState<string | null>(null);   // holding-period report (accurate LT cost)
  const [holdingName, setHoldingName] = useState('');
  const [txnName, setTxnName] = useState('');
  const [hpName, setHpName] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [writeResult, setWriteResult] = useState<WriteResult | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [master, setMaster] = useState<ScripMaster | null>(null);

  // Resolved Bonus/Split/Rights ratios, keyed by PendingAction.key.
  const [resolutions, setResolutions] = useState<Record<string, ActionResolution>>({});
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, DraftRow>>({});

  // Reconstruct whenever the holding statement is present. The transaction statement
  // (inception → 31-Mar-2025) is what actually builds the lots; without it every
  // holding is flagged as having no history.
  const result: ReconstructResult | null = useMemo(() => {
    if (!holdingText) return null;
    try {
      const holdings = parseHoldingStatement(holdingText);
      if (holdings.length === 0) return null;
      const txns = txnText ? parseTransactionStatement(txnText) : [];
      const hpLots = hpText ? parseHoldingPeriodReport(hpText) : [];
      return reconstructOpeningLots(holdings, txns, resolutions, hpLots);
    } catch { return null; }
  }, [holdingText, txnText, hpText, resolutions]);

  // Pull previously-saved corp-action resolutions for this portfolio, so a re-import
  // of the same statement doesn't re-ask. Re-runs when the portfolio or txn file changes.
  useEffect(() => {
    let cancelled = false;
    const port = portfolioById(portfolioId);
    if (!port || !hasValidGoogleToken()) { setResolutions({}); return; }
    loadOpeningCorpActions(port.sheetId).then(saved => { if (!cancelled) setResolutions(saved); }).catch(() => {});
    return () => { cancelled = true; };
  }, [portfolioId, txnText]);

  // Load the scrip master (once) so names can be resolved to canonical + ISIN.
  useEffect(() => {
    let cancelled = false;
    if (result && !master && hasValidGoogleToken()) {
      loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID).then(m => { if (!cancelled) setMaster(m); }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [result, master]);

  // Lots resolved against the scrip master (canonical name + ISIN) for preview,
  // plus the list of securities the master doesn't recognise.
  const resolvedLots = useMemo(() => result ? resolveLots(master, result.lots) : [], [result, master]);
  const unmatched = useMemo(() => {
    if (!result || !master) return [] as string[];
    const s = new Set<string>();
    for (const l of result.lots) if (!lookupScrip(master, '', l.name).entry) s.add(l.name);
    return [...s];
  }, [result, master]);

  const pending = result?.pendingActions ?? [];
  const unresolvedCount = pending.filter(a => !resolutions[a.key]).length;

  const readFile = async (file: File | null, kind: 'holding' | 'txn' | 'hp') => {
    setParseError(null); setWriteResult(null); setWriteError(null);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) { setParseError('Please upload the CSV export (not PDF/Excel).'); return; }
    const text = await file.text();
    if (kind === 'holding') { setHoldingText(text); setHoldingName(file.name); }
    else if (kind === 'hp') { setHpText(text); setHpName(file.name); }
    else { setTxnText(text); setTxnName(file.name); }
  };

  const reset = () => {
    setHoldingText(null); setTxnText(null); setHpText(null);
    setHoldingName(''); setTxnName(''); setHpName('');
    setParseError(null); setWriteResult(null); setWriteError(null);
  };

  // ── Corp-action modal ───────────────────────────────────────────────────────
  const openModal = () => {
    const d: Record<string, DraftRow> = {};
    for (const a of pending) {
      const r = resolutions[a.key];
      d[a.key] = r
        ? { num: String(r.num), den: String(r.den), price: r.price ? String(r.price) : '' }
        : { num: String(a.suggestNum), den: String(a.suggestDen), price: a.suggestPrice ? String(a.suggestPrice) : '' };
    }
    setDraft(d); setModalOpen(true);
  };
  const setDraftField = (key: string, field: keyof DraftRow, value: string) =>
    setDraft(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  const applyDraft = () => {
    const next: Record<string, ActionResolution> = { ...resolutions };
    for (const a of pending) {
      const d = draft[a.key]; if (!d) continue;
      const num = parseFloat(d.num), den = parseFloat(d.den), price = parseFloat(d.price);
      if (isFinite(num) && num > 0 && isFinite(den) && den > 0) next[a.key] = { num, den, price: isFinite(price) ? price : 0 };
      else delete next[a.key];
    }
    setResolutions(next); setModalOpen(false);
  };

  const runWrite = async () => {
    if (!result) return;
    if (!hasValidGoogleToken()) { setWriteError('Connect Google Sheets first (open the Holdings tab and authorize).'); return; }
    const port = portfolioById(portfolioId);
    if (!port) { setWriteError('Pick a portfolio.'); return; }
    if (unresolvedCount > 0) { setWriteError(`Resolve ${unresolvedCount} corporate action(s) first.`); return; }
    setWriting(true); setWriteError(null); setWriteResult(null);
    try {
      // Resolve names to canonical + ISIN (load the master now if the preview
      // hadn't yet), so opening lots line up with FY26 contract notes.
      const m = master || await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID).catch(() => null);
      if (m && !master) setMaster(m);
      const lots = resolveLots(m, result.lots);
      await saveOpeningHoldings(port.sheetId, lots);
      // Persist the resolved corp actions (dedicated tab, NOT True Entry) so re-imports skip them.
      if (pending.length) {
        await saveOpeningCorpActions(port.sheetId, pending.filter(a => resolutions[a.key]).map(a => {
          const r = resolutions[a.key];
          return { key: a.key, name: a.name, type: a.type, date: a.dateStr, num: r.num, den: r.den, price: r.price || 0 };
        }));
      }
      // Sector classifications → feeds the Dashboard pie (keyed by ISIN when resolved, else name).
      if (result.sectors.length) {
        await saveScripIndustries(SCRIP_MASTER_SPREADSHEET_ID, result.sectors.map(s => {
          const e = m ? lookupScrip(m, '', s.name).entry : null;
          return { isin: e?.isin || '', name: e?.canonicalName || s.name, industry: s.sector };
        }));
      }
      // Rebuild Holding + capital gains now that the opening basis is in place.
      let holdingErr: string | undefined, cgErr: string | undefined;
      try { await rebuildHoldingTab(port.sheetId); } catch (e: any) { holdingErr = e?.result?.error?.message || e?.message || 'Unknown error'; }
      try { await syncCapitalGains(port.sheetId); } catch (e: any) { cgErr = e?.result?.error?.message || e?.message || 'Unknown error'; }
      setWriteResult({ lots: result.lots.length, holdingErr, cgErr });
      if (holdingErr || cgErr) toast.error(`Opening basis written, but a recompute failed — see below.`);
      else toast.success(`Opening basis set for ${port.label}: ${result.lots.length} lots, Holding + capital gains rebuilt.`);
    } catch (e: any) {
      setWriteError(e?.result?.error?.message || e?.message || 'Write failed.');
    } finally {
      setWriting(false);
    }
  };

  const port = portfolioById(portfolioId);
  const s = result?.summary;

  return (
    <div className="max-w-4xl mx-auto animate-fadeIn space-y-5">
      <div>
        <h2 className="text-lg font-black text-slate-800 tracking-tight">Opening Basis (FY26 cost basis)</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Rebuild dated opening tax-lots as of <strong className="text-slate-700">1-Apr-2025</strong> by replaying the broker's
          full transaction history (inception → 31-Mar-2025). Every surviving lot keeps its <strong className="text-slate-700">real buy date + real cost</strong>.
          Bonus / Split / Rights rows can't be read from a plain statement, so you fill in their ratios in a popup. The
          31-Mar-2025 holding statement is used to <strong className="text-slate-700">reconcile</strong> the result (and supply sectors).
          Optionally add a <strong className="text-slate-700">Holding Period Report</strong> — for the scrips it lists, its lot-wise
          rows become the opening position directly (accurate date + qty + cost, already net of rights/bonus/splits), so the replay
          (and its corp-action popups) is skipped for those scrips. The replay is used only for scrips the report doesn't cover.
        </p>
      </div>

      {!writeResult && (
        <>
          {/* Portfolio picker */}
          <div className="flex items-center gap-3">
            <label className="text-xs font-bold text-slate-600">Portfolio</label>
            <select
              value={portfolioId}
              onChange={(e) => { setPortfolioId(e.target.value); setWriteResult(null); }}
              className="flex-1 max-w-sm px-3 py-2 text-sm font-medium border border-slate-200 rounded-lg bg-white cursor-pointer"
            >
              {PORTFOLIOS.map(p => <option key={p.id} value={p.id}>{p.code} — {p.label}</option>)}
            </select>
          </div>

          {/* Upload zones */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {([
              { kind: 'txn' as const, title: 'Transaction Statement', sub: 'Inception → 31-Mar-2025 · IPO / Buy / Sell / Buyback / Bonus / Split / Rights', name: txnName, req: true },
              { kind: 'holding' as const, title: '31-Mar-2025 Holding Statement', sub: 'Name · Qty · Amount Invested (· Sector) — reconciles the replay', name: holdingName, req: true },
              { kind: 'hp' as const, title: 'Holding Period Report', sub: 'Lot-wise Company · Date · Qty · Purchase Amount — authoritative opening lots (optional)', name: hpName, req: false },
            ]).map(z => (
              <label key={z.kind}
                className="rounded-2xl border-2 border-dashed border-slate-200 bg-white hover:border-indigo-300 p-6 text-center cursor-pointer transition-all block">
                <input type="file" accept=".csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0] || null; e.currentTarget.value = ''; readFile(f, z.kind); }} />
                <UploadCloud className="w-7 h-7 mx-auto text-slate-300" />
                <p className="mt-2 text-[13px] font-bold text-slate-700">{z.title} {z.req && <span className="text-rose-500">*</span>}</p>
                <p className="text-[10px] text-slate-400 mt-0.5">{z.sub}</p>
                {z.name && <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg"><FileSpreadsheet className="w-3.5 h-3.5" /> {z.name}</p>}
              </label>
            ))}
          </div>

          {parseError && (
            <div className="flex items-start gap-2 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[12px] text-amber-800">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{parseError}</span>
            </div>
          )}

          {/* Preview */}
          {result && s && (
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-slate-150 bg-slate-50">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs font-bold text-slate-700">
                  <span className="inline-flex items-center gap-1.5"><Layers className="w-4 h-4 text-indigo-600" /> {s.holdings} holdings → {s.lots} lots</span>
                  <span className="inline-flex items-center gap-1.5"><CalendarClock className="w-4 h-4 text-emerald-600" /> {s.shortLots} short-term · {s.longLots} long-term</span>
                  {s.reconciled > 0 && <span className="inline-flex items-center gap-1.5 text-emerald-700"><CheckCircle2 className="w-4 h-4" /> {s.reconciled} reconciled</span>}
                  {s.mismatched > 0 && <span className="inline-flex items-center gap-1.5 text-amber-700"><AlertTriangle className="w-4 h-4" /> {s.mismatched} qty mismatch</span>}
                  {s.costOverrides > 0 && <span className="inline-flex items-center gap-1.5 text-indigo-700"><CheckCircle2 className="w-4 h-4" /> {s.costOverrides} lots from report</span>}
                  {s.noTxn > 0 && <span className="text-slate-500">{s.noTxn} no-history</span>}
                  {s.zeroCost > 0 && <span className="text-slate-500">{s.zeroCost} zero-cost</span>}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={reset} className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-100 rounded-lg cursor-pointer"><X className="w-3.5 h-3.5" /> Clear</button>
                  <button onClick={runWrite} disabled={writing || unresolvedCount > 0 || resolvedLots.length === 0}
                    className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg transition-colors cursor-pointer disabled:opacity-50">
                    {writing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
                    {writing ? 'Writing & rebuilding…' : `Set opening basis for ${port?.code}`}
                  </button>
                </div>
              </div>

              {/* Corp actions needing a ratio */}
              {pending.length > 0 && (
                unresolvedCount > 0 ? (
                  <div className="m-4 p-3 rounded-xl border border-indigo-200 bg-indigo-50 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-[12px] font-bold text-indigo-800">
                      <Wand2 className="w-4 h-4" /> {unresolvedCount} corporate action(s) need a ratio before the basis can be built.
                    </div>
                    <button onClick={openModal} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg cursor-pointer">Resolve now</button>
                  </div>
                ) : (
                  <div className="m-4 p-2.5 rounded-xl border border-emerald-200 bg-emerald-50 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-[12px] font-bold text-emerald-800">
                      <CheckCircle2 className="w-4 h-4" /> {pending.length} corporate action(s) applied (bonus / split / rights).
                    </div>
                    <button onClick={openModal} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-emerald-700 hover:bg-emerald-100 rounded-lg cursor-pointer"><Pencil className="w-3.5 h-3.5" /> Edit</button>
                  </div>
                )
              )}

              {/* Unmatched scrips (not in the scrip master) */}
              {unmatched.length > 0 && (
                <div className="m-4 p-3 rounded-xl border border-rose-200 bg-rose-50">
                  <div className="flex items-center gap-1.5 text-[12px] font-bold text-rose-700 mb-1.5"><Link2Off className="w-4 h-4" /> {unmatched.length} scrip(s) not in the scrip master</div>
                  <p className="text-[11px] text-rose-700/90 mb-1.5">They'll still import (under the statement name), but add them to the scrip master so they line up with your FY26 contract notes.</p>
                  <p className="text-[11px] text-rose-800 break-words">{unmatched.slice(0, 40).join(', ')}{unmatched.length > 40 ? ` +${unmatched.length - 40} more` : ''}</p>
                </div>
              )}

              {/* Reconciliation issues */}
              {result.issues.length > 0 && (
                <div className="m-4 p-3 rounded-xl border border-amber-200 bg-amber-50">
                  <div className="flex items-center gap-1.5 text-[12px] font-bold text-amber-800 mb-1.5"><AlertTriangle className="w-4 h-4" /> {result.issues.length} item(s) to review</div>
                  <ul className="space-y-1 max-h-40 overflow-y-auto">
                    {result.issues.slice(0, 80).map((it, i) => (
                      <li key={i} className="text-[11px] text-amber-800"><strong>{it.name}:</strong> {it.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[#f8fafc] border-b border-slate-200 text-[11px] font-bold text-slate-600 uppercase tracking-wider sticky top-0">
                    <tr>
                      <th className="px-5 py-2.5">Security</th>
                      <th className="px-5 py-2.5">Acq. Date</th>
                      <th className="px-5 py-2.5 text-right">Qty</th>
                      <th className="px-5 py-2.5 text-right">Cost/Share</th>
                      <th className="px-5 py-2.5 text-right">Invested</th>
                      <th className="px-5 py-2.5">Term</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {resolvedLots.slice(0, 500).map((l, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-5 py-2 font-medium text-slate-800">{l.name}{!l.isin && master && <span className="ml-1 text-[9px] font-bold text-rose-500 uppercase">unmatched</span>}</td>
                        <td className="px-5 py-2 text-slate-600 font-mono text-[12px]">{l.acqDate}</td>
                        <td className="px-5 py-2 text-right font-mono text-slate-700">{l.qty.toLocaleString('en-IN')}</td>
                        <td className="px-5 py-2 text-right font-mono text-slate-700">{l.costPerShare > 0 ? inr(l.costPerShare) : '₹0'}</td>
                        <td className="px-5 py-2 text-right font-mono text-slate-700">{inr(l.invested)}</td>
                        <td className="px-5 py-2">
                          <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${l.longTerm ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{l.longTerm ? 'Long' : 'Short'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {writeError && (
        <div className="flex items-start gap-2 p-3 rounded-xl border border-rose-200 bg-rose-50 text-[12px] text-rose-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{writeError}</span>
        </div>
      )}

      {/* Result */}
      {writeResult && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="w-5 h-5" /><h3 className="text-sm font-black">Opening basis set for {port?.label}</h3>
          </div>
          <p className="text-[13px] text-slate-600">
            Wrote <strong>{writeResult.lots}</strong> opening lots to the <strong>Opening Holdings</strong> tab, then rebuilt the Holding tab and re-synced capital gains.
          </p>
          {(writeResult.holdingErr || writeResult.cgErr) && (
            <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 text-[12px] text-amber-800 space-y-1">
              {writeResult.holdingErr && <p>Holding rebuild failed: {writeResult.holdingErr}</p>}
              {writeResult.cgErr && <p>Capital-gains sync failed: {writeResult.cgErr}</p>}
              <p>Open the Holdings tab for {port?.code} and retry Rebuild / Sync.</p>
            </div>
          )}
          <p className="text-[11px] text-slate-400">
            FY26 contract notes you import into this portfolio now compute LTCG/STCG against these lots. Re-run this to replace the opening basis.
          </p>
          <button onClick={reset} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl cursor-pointer">Set another portfolio</button>
        </div>
      )}

      {/* ── Corp-action resolution modal ─────────────────────────────────────── */}
      <ModalShell open={modalOpen} onClose={() => setModalOpen(false)} labelledBy="corp-actions-title">
        <div className="relative z-10 w-full max-w-2xl max-h-[85vh] flex flex-col bg-white rounded-2xl shadow-2xl animate-fadeIn">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-150">
            <div>
              <h3 id="corp-actions-title" className="text-sm font-black text-slate-800 flex items-center gap-2"><Wand2 className="w-4 h-4 text-indigo-600" /> Corporate actions</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">Fill in the ratio for each Bonus / Split / Rights. Prefills are guessed from the balance change — check them.</p>
            </div>
            <button onClick={() => setModalOpen(false)} className="p-1.5 hover:bg-slate-100 rounded-lg cursor-pointer"><X className="w-4 h-4 text-slate-500" /></button>
          </div>

          <div className="overflow-y-auto px-5 py-4 space-y-3">
            {pending.map(a => {
              const d = draft[a.key] || { num: '', den: '', price: '' };
              const label = a.type === 'BONUS' ? 'Bonus' : a.type === 'SPLIT' ? 'Split' : 'Rights';
              const badge = a.type === 'BONUS' ? 'bg-violet-50 text-violet-700' : a.type === 'SPLIT' ? 'bg-sky-50 text-sky-700' : 'bg-amber-50 text-amber-700';
              const help = a.type === 'BONUS'
                ? `${d.num || '?'} bonus share(s) per ${d.den || '?'} held → adds ${a.heldBefore > 0 && d.num && d.den ? Math.round(a.heldBefore * (+d.num / +d.den)).toLocaleString('en-IN') : '?'} sh at ₹0`
                : a.type === 'SPLIT'
                  ? `${d.den || '?'} share → ${d.num || '?'} (qty ×${d.num && d.den ? (+d.num / +d.den) : '?'}, cost ÷ same)`
                  : `${d.num || '?'} rights per ${d.den || '?'} held @ ₹${d.price || '?'} → adds ${a.heldBefore > 0 && d.num && d.den ? Math.round(a.heldBefore * (+d.num / +d.den)).toLocaleString('en-IN') : '?'} sh`;
              return (
                <div key={a.key} className="p-3 rounded-xl border border-slate-200 bg-slate-50/60">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${badge}`}>{label}</span>
                      <span className="text-[13px] font-bold text-slate-800 truncate">{a.name}</span>
                      <span className="text-[11px] text-slate-400 font-mono">{a.dateStr}</span>
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono">held {a.heldBefore.toLocaleString('en-IN')}{a.balAfter ? ` → ${a.balAfter.toLocaleString('en-IN')}` : ''}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input type="number" min="0" step="any" value={d.num} onChange={e => setDraftField(a.key, 'num', e.target.value)}
                      className="w-16 px-2 py-1.5 text-sm text-center font-mono border border-slate-200 rounded-lg bg-white" placeholder={a.type === 'SPLIT' ? 'new' : 'N'} />
                    <span className="text-slate-400 font-bold">:</span>
                    <input type="number" min="0" step="any" value={d.den} onChange={e => setDraftField(a.key, 'den', e.target.value)}
                      className="w-16 px-2 py-1.5 text-sm text-center font-mono border border-slate-200 rounded-lg bg-white" placeholder={a.type === 'SPLIT' ? 'old' : 'M'} />
                    {a.type === 'RIGHT' && (
                      <span className="inline-flex items-center gap-1 ml-1">
                        <span className="text-[11px] font-bold text-slate-500">@ ₹</span>
                        <input type="number" min="0" step="any" value={d.price} onChange={e => setDraftField(a.key, 'price', e.target.value)}
                          className="w-24 px-2 py-1.5 text-sm text-right font-mono border border-slate-200 rounded-lg bg-white" placeholder="price" />
                      </span>
                    )}
                    <span className="text-[11px] text-slate-500 flex-1 min-w-[180px]">{help}</span>
                  </div>
                </div>
              );
            })}
            {pending.length === 0 && <p className="text-[12px] text-slate-500 text-center py-6">No corporate actions in this statement.</p>}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-150">
            <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-xs font-bold text-slate-500 hover:bg-slate-100 rounded-lg cursor-pointer">Cancel</button>
            <button onClick={applyDraft} data-autofocus className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg cursor-pointer">Apply ratios</button>
          </div>
        </div>
      </ModalShell>
    </div>
  );
}
