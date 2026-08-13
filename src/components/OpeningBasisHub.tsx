import { ArrowLeft, ChevronRight, Layers, FileSpreadsheet, Sparkles } from 'lucide-react';
import OpeningBasisImport from './OpeningBasisImport';
import CorpActionsImport from './CorpActionsImport';

/**
 * Which opening-basis tool is open. `menu` is the chooser.
 *
 * `txn` — "Add Trx Statement" — is deliberately NOT a value here: that flow is the broker
 * upload/preview/export pipeline that lives in App.tsx (it was the "Txn Report" entry in the
 * broker strip until this page took it over), so the card calls `onOpenTxnImport` and App
 * swaps in the import page. Coming back from it lands on this chooser again.
 */
export type OpeningSection = 'menu' | 'basis' | 'corp';

interface Props {
  section: OpeningSection;
  onSection: (s: OpeningSection) => void;
  /** Enter the transaction-statement import page (owned by App). */
  onOpenTxnImport: () => void;
}

interface Option {
  title: string;
  sub: string;
  icon: typeof Layers;
  open: () => void;
}

/** A labelled set of option cards. Module scope so it isn't a fresh component type on
 *  every render of the hub. */
const Group = ({ label, hint, options }: { label: string; hint: string; options: Option[] }) => (
  <div className="space-y-2.5">
    <div className="flex items-baseline gap-2 px-1">
      <h4 className="text-[10px] font-black uppercase tracking-wider text-slate-500">{label}</h4>
      <span className="text-[11px] text-slate-400">{hint}</span>
    </div>
    {options.map((o) => (
      <button
        key={o.title}
        onClick={o.open}
        className="group w-full text-left rounded-2xl border border-slate-200 bg-white shadow-sm p-5 flex items-start gap-4 hover:border-indigo-400 hover:bg-slate-50 transition-all cursor-pointer"
      >
        <div className="p-2.5 rounded-xl bg-indigo-50 border border-indigo-100 shrink-0">
          <o.icon className="w-5 h-5 text-indigo-600" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-black text-slate-800 tracking-tight">{o.title}</h3>
          <p className="text-[12px] text-slate-500 mt-1 leading-relaxed">{o.sub}</p>
        </div>
        <ChevronRight className="w-4 h-4 text-slate-300 shrink-0 mt-1 group-hover:text-indigo-600 transition-colors" />
      </button>
    ))}
  </div>
);

/**
 * Landing page for the Opening Basis tab: three tools behind one chooser.
 *
 * Opening Basis rebuilds the FY26 cost basis from a Holding Period Report. The two
 * transaction-statement tools read the SAME broker CSV for different purposes — one seeds
 * historical trades, the other only harvests Bonus / Split / Rights — so they are grouped
 * together and each says plainly what it takes and what it writes. See [[opening-basis]].
 */
export default function OpeningBasisHub({ section, onSection, onOpenTxnImport }: Props) {
  if (section === 'basis' || section === 'corp') {
    return (
      <div className="animate-fadeIn">
        <div className="max-w-4xl mx-auto mb-4">
          <button
            onClick={() => onSection('menu')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold text-slate-600 hover:text-slate-900 bg-white border border-slate-200 rounded-lg shadow-xs hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Opening Basis tools
          </button>
        </div>
        {section === 'basis' ? <OpeningBasisImport /> : <CorpActionsImport />}
      </div>
    );
  }

  const basis: Option[] = [{
    title: 'Opening Basis',
    sub: 'Rebuild the FY26 cost basis as of 1-Apr-2025 from a Holding Period Report — dated tax-lots with their real buy date and real cost. Feed a very large history in slices with Add batch.',
    icon: Layers,
    open: () => onSection('basis'),
  }];

  const txn: Option[] = [
    {
      title: 'Add Trx Statement',
      sub: 'Upload a broker transaction statement (CSV, or PDF) to seed historical trades. Parsed and reconciled like a contract note, then written to Raw Entry and True Entry in the portfolio you pick.',
      icon: FileSpreadsheet,
      open: onOpenTxnImport,
    },
    {
      title: 'Corporate Actions from a Trx Statement',
      sub: 'Scan the same statement for Bonus / Split / Rights only — every Buy and Sell is ignored, so nothing your contract notes already cover gets duplicated. Ratios are pre-filled from the balance jump for you to confirm.',
      icon: Sparkles,
      open: () => onSection('corp'),
    },
  ];

  return (
    <div className="max-w-4xl mx-auto animate-fadeIn space-y-6">
      <div>
        <h2 className="text-lg font-black text-slate-800 tracking-tight">Opening Basis</h2>
        <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
          Everything that seeds the ledger from <strong className="text-slate-700">history</strong> rather than from a
          contract note. Pick a tool — each one names the file it needs and what it writes.
        </p>
      </div>

      <Group label="Opening cost basis" hint="Holding Period Report → dated tax-lots" options={basis} />
      <Group label="Transaction statement" hint="one broker CSV, two jobs" options={txn} />
    </div>
  );
}
