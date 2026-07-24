import { useState, useMemo, useEffect } from 'react';
import {
  UploadCloud, FileSpreadsheet, Loader2, CheckCircle2, AlertCircle, AlertTriangle, X, Layers, CalendarClock, Link2Off, Link2, Wand2, Pencil, Layers3, RotateCcw, History,
} from 'lucide-react';
import {
  parseTransactionStatement, parseHoldingPeriodReport, reconstructOpeningLots, accumulateReportLots, advanceTxnNet,
  ReconstructResult, OpeningLot, ActionResolution, TxnNetEntry, TxnStatementRow,
} from '../lib/openingBasis';
import { saveOpeningHoldings, loadOpeningHoldings, OpeningSeedLot } from '../lib/openingHoldings';
import { loadOpeningTxns, saveOpeningTxns, resetOpeningTxns, mergeOpeningTxnsSlice } from '../lib/openingTxns';
import { loadOpeningCorpActions, loadOpeningCorpActionRows, saveOpeningCorpActions, SavedCorpAction } from '../lib/openingCorpActions';
import { loadOpeningBasisState, saveOpeningBasisState, resetOpeningBasisState, OpeningBasisState } from '../lib/openingBasisState';
import { rebuildHoldingTab, syncCapitalGains } from '../lib/holdingsCalc';
import { PORTFOLIOS, portfolioById } from '../lib/portfolios';
import { loadScripMaster, lookupScrip, invalidateScripCache, ScripMaster, SCRIP_MASTER_SPREADSHEET_ID } from '../lib/scripMaster';
import { hasValidGoogleToken } from '../lib/googleAuth';
import { toast, ModalShell } from './ui/overlay';
import OpeningScripMapModal from './OpeningScripMapModal';

// Standardize a lot's security to the scrip master's canonical name + ISIN, so
// opening lots FIFO-match the same stock in FY26 contract notes.
const resolveLots = (m: ScripMaster | null, lots: OpeningLot[]): OpeningLot[] =>
  lots.map(l => { const e = m ? lookupScrip(m, '', l.name).entry : null; return e ? { ...l, name: e.canonicalName, isin: e.isin || '' } : l; });

const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });


interface WriteResult { lots: number; holdingErr?: string; cgErr?: string; }
type DraftRow = { num: string; den: string; price: string };
type Mode = 'replace' | 'accumulate';

export default function OpeningBasisImport() {
  const [portfolioId, setPortfolioId] = useState(PORTFOLIOS[0]?.id || '');
  const [mode, setMode] = useState<Mode>('replace');
  const [txnText, setTxnText] = useState<string | null>(null);
  const [hpText, setHpText] = useState<string | null>(null);   // holding-period report — the lot source
  const [txnName, setTxnName] = useState('');
  const [hpName, setHpName] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [writeResult, setWriteResult] = useState<WriteResult | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [master, setMaster] = useState<ScripMaster | null>(null);

  // Batch (accumulate) mode: the running position + progress carried in from prior slices.
  const [prevLots, setPrevLots] = useState<OpeningSeedLot[]>([]);
  const [openingTxnRows, setOpeningTxnRows] = useState<TxnStatementRow[]>([]);   // accumulated raw txn history
  const [obState, setObState] = useState<OpeningBasisState>({ processedThrough: '', batches: 0 });
  const [loadingPrev, setLoadingPrev] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [lastBatch, setLastBatch] = useState<{ n: number; through: string; lots: number } | null>(null);

  // Resolved Bonus/Split/Rights ratios, keyed by PendingAction.key.
  const [resolutions, setResolutions] = useState<Record<string, ActionResolution>>({});
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, DraftRow>>({});
  const [mapOpen, setMapOpen] = useState(false);   // "map unmatched scrips to the master" popup

  // ── Reconstruct the preview ──────────────────────────────────────────────────
  // Replace mode: replay the full statement (needs the 31-Mar holding statement).
  // Accumulate mode: seed from the running position and replay only this slice's txns
  // (needs the scrip master loaded to canonicalize names across the seam).
  const result: ReconstructResult | null = useMemo(() => {
    try {
      if (mode === 'accumulate') {
        if (!master) return null;
        const canon = (n: string) => { const e = lookupScrip(master, '', n).entry; return e ? e.canonicalName : n; };
        const prevC = prevLots.map(l => ({ name: canon(l.name), isin: l.isin, acqDate: l.acqDate, qty: l.qty, costPerShare: l.costPerShare, note: l.note }));
        // Batch = Holding Period Report slices (appended verbatim → the lots). A transaction
        // slice per HPR slice surfaces Bonus/Split/Rights (the popup) and feeds the running
        // transaction POSITION (see mergedNet below) that you eyeball against your dated
        // holding report — so no per-slice HPR cross-check here (crossCheck = false).
        const hpr = hpText ? parseHoldingPeriodReport(hpText) : [];
        const txns = txnText ? parseTransactionStatement(txnText).map(t => ({ ...t, name: canon(t.name) })) : [];
        if (hpr.length === 0 && txns.length === 0) return null;
        const hprC = hpr.map(l => ({ ...l, name: canon(l.name) }));
        return accumulateReportLots(prevC, hprC, txns, resolutions, false);
      }
      // Replace mode: the Holding Period Report IS the lots; the transaction statement
      // supplies corp-action detection + the net (buy−sell) cross-check.
      if (!txnText || !hpText) return null;
      const hpLots = parseHoldingPeriodReport(hpText);
      if (hpLots.length === 0) return null;
      const txns = parseTransactionStatement(txnText);
      return reconstructOpeningLots(txns, hpLots, resolutions);
    } catch { return null; }
  }, [mode, txnText, hpText, resolutions, master, prevLots]);

  // Batch mode: this slice's transactions, canonicalized + parsed once (reused for the
  // running-position accumulation and the chronology/overlap check).
  const sliceTxns = useMemo(() => {
    if (mode !== 'accumulate' || !master || !txnText) return [];
    try {
      const canon = (n: string) => { const e = lookupScrip(master, '', n).entry; return e ? e.canonicalName : n; };
      return parseTransactionStatement(txnText).map(t => ({ ...t, name: canon(t.name) }));
    } catch { return []; }
  }, [mode, master, txnText]);

  // The merged raw transaction history = persisted rows + this slice (re-uploading a slice
  // replaces its date range). This is what "Add batch" persists AND what the position table
  // derives from — a single source of truth (also feeds the Historical Holding Report).
  const previewTxns = useMemo<TxnStatementRow[]>(
    () => (mode === 'accumulate' ? mergeOpeningTxnsSlice(openingTxnRows, sliceTxns) : []),
    [mode, openingTxnRows, sliceTxns],
  );
  // The accumulated transaction POSITION derived from that history — the "position from
  // transactions" the user compares to the dated broker holding report each batch.
  const mergedNet = useMemo<Record<string, TxnNetEntry>>(
    () => (mode === 'accumulate' ? advanceTxnNet({}, previewTxns, resolutions) : {}),
    [mode, previewTxns, resolutions],
  );
  const netRows = useMemo<TxnNetEntry[]>(
    () => Object.keys(mergedNet).map(k => mergedNet[k])
      .filter(e => Math.abs(e.qty) > 1e-6 || (e.brokerBal ?? 0) !== 0)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [mergedNet],
  );

  // Chronology guard: transaction slices must go oldest→newest (a SPLIT rescales only shares
  // held before it). Warn if this slice reaches on/before what's already been processed.
  const sliceDates = useMemo(() => {
    const iso = sliceTxns.map(t => t.iso).filter(Boolean).sort();
    return { min: iso[0] || '', max: iso[iso.length - 1] || '' };
  }, [sliceTxns]);
  const overlapsProcessed = !!(sliceDates.min && obState.processedThrough && sliceDates.min <= obState.processedThrough);
  const throughIso = [obState.processedThrough, sliceDates.max].filter(Boolean).sort().pop() || '';

  // Pull previously-saved corp-action resolutions for this portfolio, so a re-import
  // (or the next slice) doesn't re-ask. Re-runs when the portfolio or txn file changes.
  useEffect(() => {
    let cancelled = false;
    const port = portfolioById(portfolioId);
    if (!port || !hasValidGoogleToken()) { setResolutions({}); return; }
    loadOpeningCorpActions(port.sheetId).then(saved => { if (!cancelled) setResolutions(saved); }).catch(() => {});
    return () => { cancelled = true; };
  }, [portfolioId, txnText]);

  // Load the scrip master. Eager in accumulate mode (needed to canonicalize the seam
  // before the preview can be built); lazy otherwise (only for name resolution at write).
  useEffect(() => {
    let cancelled = false;
    if ((mode === 'accumulate' || result) && !master && hasValidGoogleToken()) {
      loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID).then(m => { if (!cancelled) setMaster(m); }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [mode, result, master]);

  // Accumulate mode: load the running position + progress for the selected portfolio.
  useEffect(() => {
    let cancelled = false;
    const port = portfolioById(portfolioId);
    if (mode !== 'accumulate' || !port || !hasValidGoogleToken()) { setPrevLots([]); setOpeningTxnRows([]); setObState({ processedThrough: '', batches: 0 }); return; }
    setLoadingPrev(true);
    Promise.all([
      loadOpeningHoldings(port.sheetId).catch(() => [] as OpeningSeedLot[]),
      loadOpeningBasisState(port.sheetId).catch(() => ({ processedThrough: '', batches: 0 } as OpeningBasisState)),
      loadOpeningTxns(port.sheetId).catch(() => [] as TxnStatementRow[]),
    ]).then(([lots, st, txnrows]) => { if (!cancelled) { setPrevLots(lots); setObState(st); setOpeningTxnRows(txnrows); } })
      .finally(() => { if (!cancelled) setLoadingPrev(false); });
    return () => { cancelled = true; };
  }, [mode, portfolioId, reloadTick]);

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

  const readFile = async (file: File | null, kind: 'txn' | 'hp') => {
    setParseError(null); setWriteResult(null); setWriteError(null); setLastBatch(null);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) { setParseError('Please upload the CSV export (not PDF/Excel).'); return; }
    const text = await file.text();
    if (kind === 'hp') { setHpText(text); setHpName(file.name); }
    else { setTxnText(text); setTxnName(file.name); }
  };

  const reset = () => {
    setTxnText(null); setHpText(null);
    setTxnName(''); setHpName('');
    setParseError(null); setWriteResult(null); setWriteError(null);
  };

  const switchMode = (m: Mode) => { if (m === mode) return; setMode(m); reset(); setLastBatch(null); };

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

  // Persist the resolved corp actions for this write. In accumulate mode MERGE with what
  // earlier slices already saved (so a later slice's write doesn't wipe them).
  const persistCorpActions = async (sheetId: string) => {
    const thisBatch: SavedCorpAction[] = pending.filter(a => resolutions[a.key]).map(a => {
      const r = resolutions[a.key];
      return { key: a.key, name: a.name, type: a.type, date: a.dateStr, num: r.num, den: r.den, price: r.price || 0 };
    });
    if (mode === 'accumulate') {
      const existing = await loadOpeningCorpActionRows(sheetId).catch(() => [] as SavedCorpAction[]);
      const byKey = new Map<string, SavedCorpAction>();
      for (const e of existing) byKey.set(e.key, e);
      for (const t of thisBatch) byKey.set(t.key, t);   // this slice overrides on key collision
      await saveOpeningCorpActions(sheetId, [...byKey.values()]);
    } else if (thisBatch.length) {
      await saveOpeningCorpActions(sheetId, thisBatch);
    }
  };

  // ── Write ─────────────────────────────────────────────────────────────────────
  const runWrite = async () => {
    if (!result) return;
    if (!hasValidGoogleToken()) { setWriteError('Connect Google Sheets first (open the Holdings tab and authorize).'); return; }
    const port = portfolioById(portfolioId);
    if (!port) { setWriteError('Pick a portfolio.'); return; }
    // Both modes now take lots from the Holding Period Report — corp actions only refine
    // the buy−sell cross-check, so they never block the write (either mode).
    setWriting(true); setWriteError(null); setWriteResult(null);
    try {
      // Resolve names to canonical + ISIN (load the master now if the preview hadn't yet).
      const m = master || await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID).catch(() => null);
      if (m && !master) setMaster(m);
      const lots = resolveLots(m, result.lots);
      const canonName = (n: string) => { const e = m ? lookupScrip(m, '', n).entry : null; return e ? e.canonicalName : n; };
      await saveOpeningHoldings(port.sheetId, lots);
      await persistCorpActions(port.sheetId);   // save + merge resolved bonus/split/rights (both modes, per slice)

      if (mode === 'accumulate') {
        // A batch that persists NO transaction rows leaves the Historical Holding Report with
        // nothing to replay (it seeds pre-FY26 positions from these). Block it and say so,
        // rather than silently writing an empty history.
        if (previewTxns.length === 0) {
          setWriting(false);
          setWriteError("Add this batch's Transaction Statement slice — the Historical Holding Report replays these to show past positions. The Holding Period Report alone writes lots but no dated transaction history.");
          return;
        }
        // Append this HPR slice + fold this slice's transactions into the running position;
        // DON'T rebuild yet (that's the Finish step) — the position is partial until the last
        // slice, so FY26 numbers aren't meaningful.
        const added = Math.max(0, lots.length - prevLots.length);
        const nextBatch = (obState.batches || 0) + 1;
        await saveOpeningTxns(port.sheetId, previewTxns);   // persist the merged raw transaction history
        await saveOpeningBasisState(port.sheetId, { processedThrough: throughIso || obState.processedThrough, batches: nextBatch });
        setLastBatch({ n: nextBatch, through: throughIso || obState.processedThrough, lots: lots.length });
        toast.success(`Slice ${nextBatch} added — ${added.toLocaleString('en-IN')} new lot(s); running position now ${lots.length} lots${throughIso ? `, txns through ${throughIso}` : ''}.`);
        setHpText(null); setHpName('');      // ready for the next HPR slice
        setTxnText(null); setTxnName('');    // and the next transaction slice
        setReloadTick(t => t + 1);           // refresh the running position (+ reloads saved corp actions & txn net)
      } else {
        await resetOpeningBasisState(port.sheetId).catch(() => {});   // a fresh one-shot supersedes any batches
        // Persist the (complete) transaction statement so the Historical Holding Report can
        // replay it to any past date — Replace supplies the whole history at once. (Previously
        // this wiped the tab, leaving the report with nothing to replay.)
        const replaceTxns = txnText ? parseTransactionStatement(txnText).map(t => ({ ...t, name: canonName(t.name) })) : [];
        if (replaceTxns.length) await saveOpeningTxns(port.sheetId, replaceTxns);
        else await resetOpeningTxns(port.sheetId).catch(() => {});
        let holdingErr: string | undefined, cgErr: string | undefined;
        try { await rebuildHoldingTab(port.sheetId); } catch (e: any) { holdingErr = e?.result?.error?.message || e?.message || 'Unknown error'; }
        try { await syncCapitalGains(port.sheetId); } catch (e: any) { cgErr = e?.result?.error?.message || e?.message || 'Unknown error'; }
        setWriteResult({ lots: result.lots.length, holdingErr, cgErr });
        if (holdingErr || cgErr) toast.error(`Opening basis written, but a recompute failed — see below.`);
        else toast.success(`Opening basis set for ${port.label}: ${result.lots.length} lots, Holding + capital gains rebuilt.`);
      }
    } catch (e: any) {
      setWriteError(e?.result?.error?.message || e?.message || 'Write failed.');
    } finally {
      setWriting(false);
    }
  };

  // Accumulate mode: run the (expensive) Holding + capital-gains rebuild once, when done.
  const runFinish = async () => {
    if (!hasValidGoogleToken()) { setWriteError('Connect Google Sheets first (open the Holdings tab and authorize).'); return; }
    const port = portfolioById(portfolioId);
    if (!port) { setWriteError('Pick a portfolio.'); return; }
    setFinishing(true); setWriteError(null);
    try {
      let holdingErr: string | undefined, cgErr: string | undefined;
      try { await rebuildHoldingTab(port.sheetId); } catch (e: any) { holdingErr = e?.result?.error?.message || e?.message || 'Unknown error'; }
      try { await syncCapitalGains(port.sheetId); } catch (e: any) { cgErr = e?.result?.error?.message || e?.message || 'Unknown error'; }
      if (holdingErr || cgErr) { setWriteError(`Rebuild issue — Holding: ${holdingErr || 'ok'} · Capital gains: ${cgErr || 'ok'}. Open the Holdings tab for ${port.code} and retry.`); toast.error('Rebuild hit an error — see below.'); }
      else toast.success(`Done — Holding + capital gains rebuilt for ${port.label} from ${prevLots.length} opening lots.`);
    } finally {
      setFinishing(false);
    }
  };

  const port = portfolioById(portfolioId);
  const s = result?.summary;
  const prevQty = useMemo(() => prevLots.reduce((a, l) => a + l.qty, 0), [prevLots]);
  const prevScrips = useMemo(() => new Set(prevLots.map(l => l.name)).size, [prevLots]);
  const showUploads = !writeResult;   // replace-mode success replaces the whole panel; accumulate keeps it

  return (
    <div className="max-w-4xl mx-auto animate-fadeIn space-y-5">
      <div>
        <h2 className="text-lg font-black text-slate-800 tracking-tight">Opening Basis (FY26 cost basis)</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Build dated opening tax-lots as of <strong className="text-slate-700">1-Apr-2025</strong>. The <strong className="text-slate-700">Holding
          Period Report</strong> supplies the lots — each with its <strong className="text-slate-700">real buy date + real cost</strong>. The
          <strong className="text-slate-700"> transaction statement</strong> is used only to spot Bonus / Split / Rights and to cross-check the net
          position (buy − sell) against the report — e.g. buy 12,000 − sell 7,000 = 5,000 must match the report's 5,000; a gap is flagged.
          A scrip that has a net position in the transactions but isn't in the report gets no lot (and a flag). Securities named
          "…Right Issue…" are ignored. For a very large history, switch to <strong className="text-slate-700">Add batch</strong> and feed it in slices.
        </p>
      </div>

      {showUploads && (
        <>
          {/* Portfolio picker + mode toggle */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs font-bold text-slate-600">Portfolio</label>
            <select
              value={portfolioId}
              onChange={(e) => { setPortfolioId(e.target.value); setWriteResult(null); setLastBatch(null); }}
              className="flex-1 max-w-xs px-3 py-2 text-sm font-medium border border-slate-200 rounded-lg bg-white cursor-pointer"
            >
              {PORTFOLIOS.map(p => <option key={p.id} value={p.id}>{p.code} — {p.label}</option>)}
            </select>
            <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs font-bold">
              <button onClick={() => switchMode('replace')}
                className={`px-3 py-1.5 rounded-md cursor-pointer transition-colors ${mode === 'replace' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                Replace (one-shot)
              </button>
              <button onClick={() => switchMode('accumulate')}
                className={`px-3 py-1.5 rounded-md cursor-pointer transition-colors inline-flex items-center gap-1.5 ${mode === 'accumulate' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                <Layers3 className="w-3.5 h-3.5" /> Add batch
              </button>
            </div>
          </div>

          {/* Running-position banner (accumulate mode) — Holding Period Report slices only */}
          {mode === 'accumulate' && (
            <div className="rounded-2xl border border-indigo-200 bg-indigo-50/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <History className="w-5 h-5 text-indigo-600 mt-0.5 shrink-0" />
                  <div className="text-[12px] text-indigo-900">
                    {loadingPrev ? (
                      <span className="inline-flex items-center gap-1.5 font-bold"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading running position…</span>
                    ) : (obState.batches > 0 || prevLots.length > 0) ? (
                      <>
                        <p className="font-bold">Continuing {port?.code}: {prevLots.length.toLocaleString('en-IN')} lots across {prevScrips.toLocaleString('en-IN')} scrips ({Math.round(prevQty).toLocaleString('en-IN')} sh){obState.batches > 0 ? ` · ${obState.batches} slice(s)` : ''}{obState.processedThrough ? ` · txns through ${obState.processedThrough}` : ''}.</p>
                        <p className="mt-0.5">Upload the next <strong>Holding Period Report</strong> slice (lots — appended & de-duplicated, any order) plus its <strong>Transaction Statement</strong> slice. The transactions build the <strong>running position below</strong> — check it against your dated broker holding report and fix any Bonus / Split / Rights (it pops up) before the next slice. Feed transaction slices <strong>oldest → newest</strong>.</p>
                      </>
                    ) : (
                      <>
                        <p className="font-bold">No running position yet for {port?.code}.</p>
                        <p className="mt-0.5">Upload your first <strong>Holding Period Report</strong> slice (lots — taken <strong>verbatim</strong>: real date + qty + cost) plus its <strong>Transaction Statement</strong> slice. The transactions build the <strong>running position below</strong>, which you compare to your dated broker holding report each batch. Feed transaction slices <strong>oldest → newest</strong> and resolve any Bonus / Split / Rights as it pops up.</p>
                      </>
                    )}
                  </div>
                </div>
                {(prevLots.length > 0 || obState.batches > 0) && (
                  <button onClick={runFinish} disabled={finishing || writing}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg cursor-pointer disabled:opacity-50">
                    {finishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                    {finishing ? 'Rebuilding…' : 'Finish & rebuild'}
                  </button>
                )}
              </div>
              {lastBatch && (
                <div className="mt-3 flex items-center gap-2 text-[12px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  <CheckCircle2 className="w-4 h-4" />
                  Slice {lastBatch.n} added — running position {lastBatch.lots.toLocaleString('en-IN')} lots. Upload the next slice, or Finish &amp; rebuild.
                </div>
              )}
            </div>
          )}

          {/* Upload zones */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {([
              { kind: 'hp' as const, title: mode === 'accumulate' ? 'Holding Period Report Slice' : 'Holding Period Report', sub: mode === 'accumulate' ? "This slice's lot-wise rows · Company · Date · Qty · Purchase Amount — taken verbatim & appended" : 'Lot-wise Company · Date · Qty · Purchase Amount — the authoritative opening lots (cost + real dates)', name: hpName, req: true, show: true },
              { kind: 'txn' as const, title: mode === 'accumulate' ? 'Transaction Statement Slice' : 'Transaction Statement', sub: mode === 'accumulate' ? "This slice's Buy / Sell (oldest→newest) — builds the running position below; Bonus / Split / Rights pop up to resolve (saved across slices)." : 'Inception → 31-Mar-2025 · Buy / Sell (+ Bonus / Split / Rights) — for the net cross-check & corp actions', name: txnName, req: mode === 'replace', show: true },
            ]).filter(z => z.show).map(z => (
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

          {/* Chronology guard — transaction slices must go oldest→newest so a SPLIT rescales
              only shares held before it. */}
          {mode === 'accumulate' && overlapsProcessed && (
            <div className="flex items-start gap-2 -mt-1 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[12px] text-amber-800">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>This slice starts <strong>{sliceDates.min}</strong>, on/before what's already processed (<strong>{obState.processedThrough}</strong>). Feed slices oldest→newest and non-overlapping, or the running position may double-count.</span>
            </div>
          )}

          {/* Batch mode needs a transaction slice: a CSV that parsed to nothing, or an
              HPR-only batch on a fresh portfolio — either way the report would have no history. */}
          {mode === 'accumulate' && !!master && txnText && sliceTxns.length === 0 && (
            <div className="flex items-start gap-2 -mt-1 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[12px] text-amber-800">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>Couldn't read any transactions from that CSV — check it's the transaction-statement export (needs Date · Transaction Type · Name · Qty columns).</span>
            </div>
          )}
          {mode === 'accumulate' && !txnText && !!hpText && previewTxns.length === 0 && (
            <div className="flex items-start gap-2 -mt-1 p-3 rounded-xl border border-indigo-200 bg-indigo-50 text-[12px] text-indigo-800">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>Add this batch's <strong>Transaction Statement</strong> slice too — the Historical Holding Report replays these to show past positions (the Holding Period Report alone writes lots but no dated transaction history).</span>
            </div>
          )}

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
                  <span className="inline-flex items-center gap-1.5"><Layers className="w-4 h-4 text-indigo-600" /> {mode === 'accumulate' ? `running position → ${s.lots} lots` : `${s.holdings} scrips → ${s.lots} lots`}</span>
                  <span className="inline-flex items-center gap-1.5"><CalendarClock className="w-4 h-4 text-emerald-600" /> {s.shortLots} short-term · {s.longLots} long-term</span>
                  {s.reconciled > 0 && <span className="inline-flex items-center gap-1.5 text-emerald-700"><CheckCircle2 className="w-4 h-4" /> {s.reconciled} reconciled</span>}
                  {s.mismatched > 0 && <span className="inline-flex items-center gap-1.5 text-amber-700"><AlertTriangle className="w-4 h-4" /> {s.mismatched} qty mismatch</span>}
                  {(s.missingFromReport ?? 0) > 0 && <span className="inline-flex items-center gap-1.5 text-amber-700"><AlertTriangle className="w-4 h-4" /> {s.missingFromReport} missing from report</span>}
                  {s.costOverrides > 0 && <span className="inline-flex items-center gap-1.5 text-indigo-700"><CheckCircle2 className="w-4 h-4" /> {s.costOverrides} lots from report</span>}
                  {s.noTxn > 0 && <span className="text-slate-500">{s.noTxn} no cross-check</span>}
                  {s.zeroCost > 0 && <span className="text-slate-500">{s.zeroCost} zero-cost</span>}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={reset} className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-100 rounded-lg cursor-pointer"><X className="w-3.5 h-3.5" /> Clear</button>
                  <button onClick={runWrite} disabled={writing || resolvedLots.length === 0 || (mode === 'accumulate' && previewTxns.length === 0)}
                    className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg transition-colors cursor-pointer disabled:opacity-50">
                    {writing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : mode === 'accumulate' ? <Layers3 className="w-3.5 h-3.5" /> : <UploadCloud className="w-3.5 h-3.5" />}
                    {writing ? (mode === 'accumulate' ? 'Adding batch…' : 'Writing & rebuilding…') : mode === 'accumulate' ? `Add batch to ${port?.code}` : `Set opening basis for ${port?.code}`}
                  </button>
                </div>
              </div>

              {/* Corp actions needing a ratio */}
              {pending.length > 0 && (
                unresolvedCount > 0 ? (
                  <div className="m-4 p-3 rounded-xl border border-indigo-200 bg-indigo-50 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-[12px] font-bold text-indigo-800">
                      <Wand2 className="w-4 h-4" /> {unresolvedCount} corporate action(s) detected — resolve them so the {mode === 'accumulate' ? 'running position matches your broker report' : 'buy−sell cross-check is exact'} (lots come from the report either way).
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
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-1.5 text-[12px] font-bold text-rose-700"><Link2Off className="w-4 h-4" /> {unmatched.length} scrip(s) not in the scrip master</div>
                    <button onClick={() => setMapOpen(true)} disabled={!master}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold rounded-lg cursor-pointer disabled:opacity-50">
                      <Link2 className="w-3.5 h-3.5" /> Map to a stock
                    </button>
                  </div>
                  <p className="text-[11px] text-rose-700/90 mb-1.5">Pick the right stock for each (Map to a stock) so they line up with your FY26 contract notes — or leave them to import under the statement name.</p>
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

          {/* Running position from the transactions (batch mode) — the check the user makes
              against the dated broker holding report each batch. Verification only; NOT written
              into the FY26 lots (those come from the HPR). */}
          {mode === 'accumulate' && netRows.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-b border-slate-150 bg-slate-50">
                <div className="text-xs font-bold text-slate-700">
                  <span className="inline-flex items-center gap-1.5"><CalendarClock className="w-4 h-4 text-indigo-600" /> Position from transactions{throughIso ? ` through ${throughIso}` : ''} — {netRows.length} scrip(s)</span>
                </div>
                {(() => {
                  const gaps = netRows.filter(e => e.brokerBal != null && Math.abs(e.qty - (e.brokerBal ?? 0)) > 1e-6).length;
                  return gaps > 0
                    ? <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-amber-700"><AlertTriangle className="w-4 h-4" /> {gaps} differ from broker balance</span>
                    : <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-emerald-700"><CheckCircle2 className="w-4 h-4" /> matches broker balance</span>;
                })()}
              </div>
              <p className="px-5 pt-3 text-[11px] text-slate-500">Compare this against your broker holding report for this date. A gap is usually an unresolved Bonus / Split / Rights — resolve it above, then re-check before adding the next slice.</p>
              <div className="overflow-x-auto max-h-[360px] overflow-y-auto mt-2">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[#f8fafc] border-b border-slate-200 text-[11px] font-bold text-slate-600 uppercase tracking-wider sticky top-0">
                    <tr>
                      <th className="px-5 py-2.5">Security</th>
                      <th className="px-5 py-2.5 text-right">Computed Qty</th>
                      <th className="px-5 py-2.5 text-right">Broker Bal</th>
                      <th className="px-5 py-2.5 text-right">Δ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {netRows.slice(0, 800).map((e, i) => {
                      const diff = e.brokerBal == null ? null : e.qty - e.brokerBal;
                      const off = diff != null && Math.abs(diff) > 1e-6;
                      const fmtQ = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 4 });
                      return (
                        <tr key={i} className={`hover:bg-slate-50 ${off ? 'bg-amber-50/40' : ''}`}>
                          <td className="px-5 py-2 font-medium text-slate-800">{e.name}</td>
                          <td className="px-5 py-2 text-right font-mono text-slate-700">{fmtQ(e.qty)}</td>
                          <td className="px-5 py-2 text-right font-mono text-slate-500">{e.brokerBal == null ? '—' : fmtQ(e.brokerBal)}</td>
                          <td className={`px-5 py-2 text-right font-mono font-bold ${off ? 'text-amber-700' : 'text-slate-300'}`}>{diff == null ? '' : off ? (diff > 0 ? '+' : '') + fmtQ(diff) : '0'}</td>
                        </tr>
                      );
                    })}
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

      {/* Result (replace mode only — accumulate keeps the panel open for the next slice) */}
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

      {/* Map unmatched statement names to existing scrip-master entries (user picks the stock). */}
      {master && (
        <OpeningScripMapModal
          open={mapOpen}
          spreadsheetId={SCRIP_MASTER_SPREADSHEET_ID}
          master={master}
          names={unmatched}
          onClose={() => setMapOpen(false)}
          onApplied={async () => {
            setMapOpen(false);
            invalidateScripCache();
            const m = await loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID, { force: true }).catch(() => null);
            if (m) setMaster(m);
            setReloadTick(t => t + 1);   // re-resolve the preview + running position against the new aliases
            toast.success('Scrip mappings saved — re-resolving.');
          }}
        />
      )}
    </div>
  );
}
