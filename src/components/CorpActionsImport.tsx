import { useState, useEffect } from 'react';
import { UploadCloud, Loader2, CheckCircle2, AlertCircle, Sparkles, X } from 'lucide-react';
import { gapi } from 'gapi-script';
import {
  parseTransactionStatement, collectPendingActions, PendingAction, TxnStatementRow,
} from '../lib/openingBasis';
import { appendManualTrades, ManualTradeLine, ManualAction } from '../lib/manualTrades';
import { loadScripMaster, lookupScrip, normName, ScripMaster, SCRIP_MASTER_SPREADSHEET_ID } from '../lib/scripMaster';
import { PORTFOLIOS, sheetIdForId } from '../lib/portfolios';
import { hasValidGoogleToken } from '../lib/googleAuth';
import { formatDMY } from '../lib/dates';
import { toast } from './ui/overlay';

// A Sheets serial (or ISO string) → yyyy-mm-dd, for reading back existing True Entry dates.
const SHEET_EPOCH = Date.UTC(1899, 11, 30);
const toIso = (v: any): string => {
  if (typeof v === 'number' && isFinite(v)) {
    const d = new Date(SHEET_EPOCH + Math.round(v * 86400000));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  const s = (v ?? '').toString().trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  const t = Date.parse(s);
  if (!isNaN(t)) { const d = new Date(t); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
  return s;
};

const kindLabel = (k: string) => k === 'BONUS' ? 'Bonus' : k === 'SPLIT' ? 'Split' : k === 'RIGHT' ? 'Rights' : k;
const actionOf = (k: string): ManualAction => (k === 'BONUS' ? 'Bonus' : k === 'SPLIT' ? 'Split' : 'Rights');

type Draft = { num: string; den: string; price: string; held: string };

export default function CorpActionsImport() {
  const [portfolioId, setPortfolioId] = useState(PORTFOLIOS[0]?.id || '');
  const [master, setMaster] = useState<ScripMaster | null>(null);
  const [fileName, setFileName] = useState('');
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<PendingAction[]>([]);
  const [skipped, setSkipped] = useState<PendingAction[]>([]);   // already recorded in True Entry
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<{ added: number; dates: number } | null>(null);

  useEffect(() => { loadScripMaster(SCRIP_MASTER_SPREADSHEET_ID).then(setMaster).catch(() => setMaster(null)); }, []);

  const scripKeyOf = (name: string, isin = ''): string => {
    const e = master ? lookupScrip(master, isin, name).entry : null;
    return e ? e.key : ((isin || '').trim() || normName(name));
  };

  // Read the FY26 True Entry rows already carrying a Bonus/Split/Rights, so a re-upload
  // of the same statement doesn't add a corporate action twice. Key = scrip|kind|date.
  const loadExistingCorpKeys = async (spreadsheetId: string): Promise<Set<string>> => {
    const set = new Set<string>();
    try {
      const res: any = await (gapi.client as any).sheets.spreadsheets.values.get({
        spreadsheetId, range: 'True Entry!A:T',
        valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER',
      });
      const rows: any[][] = res?.result?.values || [];
      if (rows.length < 2) return set;
      const hdr = rows[0].map((h: any) => (h || '').toString().trim());
      const di = hdr.indexOf('Trade Date'), ni = hdr.indexOf('Stock Name'), ti = hdr.indexOf('Transaction Type'), ii = hdr.indexOf('ISIN');
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i]; if (!r) continue;
        const type = (r[ti !== -1 ? ti : 3] || '').toString().toLowerCase();
        const kind = /bonus/.test(type) ? 'BONUS' : /split/.test(type) ? 'SPLIT' : /right/.test(type) ? 'RIGHT' : '';
        if (!kind) continue;
        const key = scripKeyOf((r[ni !== -1 ? ni : 2] || '').toString(), (r[ii !== -1 ? ii : -1] || '').toString());
        set.add(`${key}|${kind}|${toIso(r[di !== -1 ? di : 0])}`);
      }
    } catch { /* no True Entry yet → nothing to dedup against */ }
    return set;
  };

  const onFile = async (file: File | null) => {
    setError(null); setResult(null); setDetected([]); setSkipped([]); setDraft({});
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) { setError('Please upload the CSV export of the transaction statement (not PDF/Excel).'); return; }
    if (!master) { setError('Scrip master still loading — try again in a moment.'); return; }
    const spreadsheetId = sheetIdForId(portfolioId);
    if (!spreadsheetId) { setError('No spreadsheet for this portfolio.'); return; }
    setParsing(true); setFileName(file.name);
    try {
      const text = await file.text();
      const rows = parseTransactionStatement(text);
      if (!rows.length) { setError('Could not read any transactions from that CSV.'); return; }
      // Group by resolved scrip, then detect Bonus/Split/Rights (Buy/Sell are ignored).
      const byName = new Map<string, TxnStatementRow[]>();
      for (const r of rows) {
        const k = scripKeyOf(r.name);
        (byName.get(k) || byName.set(k, []).get(k)!).push(r);
      }
      const pending = collectPendingActions(byName);
      if (!pending.length) { setError('No Bonus / Split / Rights found in that statement — nothing to add (Buy/Sell rows are ignored).'); return; }
      // Dedup against what's already in the ledger.
      const existing = await loadExistingCorpKeys(spreadsheetId);
      const isKnown = (p: PendingAction) => existing.has(`${scripKeyOf(p.name)}|${p.type}|${p.iso}`);
      const fresh = pending.filter(p => !isKnown(p));
      const dup = pending.filter(isKnown);
      const d: Record<string, Draft> = {};
      for (const p of fresh) d[p.key] = { num: String(p.suggestNum || 1), den: String(p.suggestDen || 1), price: p.suggestPrice ? String(p.suggestPrice) : '', held: p.heldBefore ? String(p.heldBefore) : '' };
      setDetected(fresh); setSkipped(dup); setDraft(d);
    } catch (e: any) {
      setError(e?.message || 'Could not parse that statement.');
    } finally {
      setParsing(false);
    }
  };

  const setF = (key: string, patch: Partial<Draft>) => setDraft(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  // Free/subscribed shares implied by the ratio + shares held (mirrors AddTradeModal):
  //   BONUS/RIGHTS  N:M → held × N/M     SPLIT new:old → held × (new/old − 1)
  const addedShares = (p: PendingAction): number => {
    const d = draft[p.key]; if (!d) return 0;
    const n = parseFloat(d.num), m = parseFloat(d.den), held = parseFloat(d.held);
    if (!(n > 0) || !(m > 0) || !(held > 0)) return 0;
    const raw = p.type === 'SPLIT' ? held * (n / m - 1) : held * (n / m);
    return Math.round(raw);
  };

  const apply = async () => {
    if (!hasValidGoogleToken()) { setError('Google Sheets isn’t connected. Open Holdings and sync first.'); return; }
    const spreadsheetId = sheetIdForId(portfolioId);
    if (!spreadsheetId) { setError('No spreadsheet for this portfolio.'); return; }
    // Group the resolved actions by trade date — appendManualTrades takes one date per call.
    const byDate = new Map<string, ManualTradeLine[]>();
    for (const p of detected) {
      const qty = addedShares(p);
      if (qty <= 0) continue;
      const d = draft[p.key];
      const price = p.type === 'RIGHT' ? (parseFloat(d.price) || 0) : 0;
      const line: ManualTradeLine = {
        isin: '', securityName: p.name, action: actionOf(p.type), quantity: qty, price,
        tradeClass: 'Delivery', brokerage: 0, stt: 0, exchangeCharges: 0, sebiFees: 0, stampDuty: 0, gst: 0, ipf: 0,
      };
      (byDate.get(p.iso) || byDate.set(p.iso, []).get(p.iso)!).push(line);
    }
    if (!byDate.size) { setError('Nothing to apply — enter a ratio and shares-held for at least one action.'); return; }
    setApplying(true); setError(null);
    try {
      let added = 0;
      for (const [iso, lines] of byDate) { await appendManualTrades(spreadsheetId, lines, iso); added += lines.length; }
      setResult({ added, dates: byDate.size });
      setDetected([]); setDraft({});
      toast.success(`Added ${added} corporate action${added === 1 ? '' : 's'} and rebuilt holdings + capital gains.`);
    } catch (e: any) {
      setError(e?.result?.error?.message || e?.message || 'Could not apply the corporate actions.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto mt-4 space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-5">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-xl bg-violet-50 border border-violet-200"><Sparkles className="w-5 h-5 text-violet-600" /></div>
          <div className="flex-1">
            <h3 className="text-sm font-black text-slate-800">Corporate actions from a transaction statement (FY25‑26)</h3>
            <p className="text-[12px] text-slate-500 mt-1 leading-relaxed">
              Upload your FY25‑26 transaction statement and the app scans it for <b>Bonus / Split / Rights only</b> —
              every Buy/Sell is <b>ignored</b> (your contract notes already cover trades, so nothing is duplicated).
              Each detected action shows below with a ratio pre‑filled from the balance jump; confirm the numbers, then
              Apply — they’re written to the ledger (dated at the ex‑date) and holdings + capital gains rebuild.
              Re‑uploading is safe: anything already recorded is skipped.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="text-[11px] font-black uppercase tracking-wider text-slate-500">Portfolio</label>
          <select
            value={portfolioId}
            onChange={(e) => { setPortfolioId(e.target.value); setDetected([]); setSkipped([]); setResult(null); setError(null); setFileName(''); }}
            className="px-3 py-2 text-xs font-bold text-slate-700 bg-white border border-slate-200 rounded-xl outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
          >
            {PORTFOLIOS.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.label}</option>)}
          </select>
        </div>

        <label className={`mt-4 relative flex flex-col items-center justify-center h-40 border-2 border-dashed rounded-2xl transition-all cursor-pointer ${parsing ? 'border-indigo-300 bg-indigo-50/40' : 'border-slate-300/70 hover:border-indigo-400'}`}>
          <input type="file" accept=".csv" className="hidden" disabled={parsing || applying}
            onChange={(e) => { const f = e.target.files?.[0] || null; e.currentTarget.value = ''; onFile(f); }} />
          {parsing ? <Loader2 className="w-7 h-7 text-indigo-400 animate-spin" /> : <UploadCloud className="w-7 h-7 text-slate-300" />}
          <p className="mt-2 text-[13px] font-bold text-slate-700">{parsing ? 'Scanning…' : 'Upload transaction statement (.csv)'}</p>
          {fileName && !parsing && <p className="text-[10px] text-slate-400 mt-0.5">{fileName}</p>}
          <p className="text-[10px] text-slate-400 mt-0.5">Bonus / Split / Rights are detected — Buy/Sell ignored</p>
        </label>

        {error && (
          <div className="mt-3 flex items-start gap-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
          </div>
        )}
        {result && (
          <div className="mt-3 flex items-start gap-2 text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> <span>Added {result.added} corporate action{result.added === 1 ? '' : 's'} across {result.dates} date{result.dates === 1 ? '' : 's'}. Holdings + capital gains rebuilt.</span>
          </div>
        )}
      </div>

      {detected.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-5">
          <p className="text-[12px] font-black text-slate-700 mb-3">{detected.length} corporate action{detected.length === 1 ? '' : 's'} to review{skipped.length > 0 ? ` · ${skipped.length} already recorded (skipped)` : ''}</p>
          <div className="space-y-2">
            {detected.map((p) => {
              const d = draft[p.key]; const qty = addedShares(p);
              return (
                <div key={p.key} className="grid grid-cols-12 gap-2 items-center rounded-xl border border-slate-150 bg-slate-50/50 px-3 py-2">
                  <div className="col-span-4 min-w-0">
                    <p className="text-[12px] font-bold text-slate-800 truncate" title={p.name}>{p.name}</p>
                    <p className="text-[10px] text-slate-400">{kindLabel(p.type)} · {formatDMY(p.dateStr)}</p>
                  </div>
                  <div className="col-span-2">
                    <label className="text-[9px] font-bold uppercase text-slate-400 block">{p.type === 'SPLIT' ? 'New : Old' : 'Ratio N : M'}</label>
                    <div className="flex items-center gap-1">
                      <input type="number" min="0" step="any" value={d?.num ?? ''} onChange={(e) => setF(p.key, { num: e.target.value })} className="w-12 px-1.5 py-1 text-[12px] font-bold text-slate-700 border border-slate-200 rounded-md outline-none focus:ring-1 focus:ring-indigo-500" />
                      <span className="text-slate-400 text-xs">:</span>
                      <input type="number" min="0" step="any" value={d?.den ?? ''} onChange={(e) => setF(p.key, { den: e.target.value })} className="w-12 px-1.5 py-1 text-[12px] font-bold text-slate-700 border border-slate-200 rounded-md outline-none focus:ring-1 focus:ring-indigo-500" />
                    </div>
                  </div>
                  <div className="col-span-2">
                    <label className="text-[9px] font-bold uppercase text-slate-400 block">Shares held</label>
                    <input type="number" min="0" step="any" value={d?.held ?? ''} onChange={(e) => setF(p.key, { held: e.target.value })} className="w-full px-1.5 py-1 text-[12px] font-bold text-slate-700 border border-slate-200 rounded-md outline-none focus:ring-1 focus:ring-indigo-500" />
                  </div>
                  <div className="col-span-2">
                    {p.type === 'RIGHT' ? (
                      <>
                        <label className="text-[9px] font-bold uppercase text-slate-400 block">Rights price</label>
                        <input type="number" min="0" step="any" value={d?.price ?? ''} onChange={(e) => setF(p.key, { price: e.target.value })} className="w-full px-1.5 py-1 text-[12px] font-bold text-slate-700 border border-slate-200 rounded-md outline-none focus:ring-1 focus:ring-indigo-500" />
                      </>
                    ) : <span className="text-[9px] text-slate-300">—</span>}
                  </div>
                  <div className="col-span-2 text-right">
                    <label className="text-[9px] font-bold uppercase text-slate-400 block">{p.type === 'RIGHT' ? 'Subscribed' : 'Free shares'}</label>
                    <p className={`text-[13px] font-black ${qty > 0 ? 'text-slate-800' : 'text-slate-300'}`}>{qty > 0 ? qty.toLocaleString('en-IN') : '—'}</p>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex justify-end">
            <button onClick={apply} disabled={applying} className="btn-press px-5 py-2.5 bg-violet-600 hover:bg-violet-500 text-white font-black text-xs rounded-xl flex items-center gap-2 cursor-pointer shadow-sm disabled:opacity-60 disabled:cursor-not-allowed">
              {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {applying ? 'Applying…' : `Apply ${detected.length} action${detected.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      {detected.length === 0 && skipped.length > 0 && !result && (
        <div className="max-w-3xl mx-auto flex items-start gap-2 text-[12px] text-slate-600 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
          <X className="w-4 h-4 mt-0.5 shrink-0 text-slate-400" /> <span>All {skipped.length} corporate action{skipped.length === 1 ? '' : 's'} in this statement are already recorded — nothing new to add.</span>
        </div>
      )}
    </div>
  );
}
