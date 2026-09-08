// The fifth top-level view. Built as a view rather than a modal so it behaves exactly like
// Dashboard / Portfolios / Imports / Reports: it takes the header title, and the existing
// back-step registry already walks it home at depth 1 with no new wiring.
//
// Holds the two controls moved out of the header — appearance and account.
import type { ReactNode } from 'react';
import { Keyboard, LogOut, Moon, ShieldCheck } from 'lucide-react';
import ThemeToggle from './ui/ThemeToggle';
import { SHORTCUTS, keyLabel } from '../lib/shortcuts';

interface Props {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  currentUser: { name: string; given_name?: string; email?: string; picture?: string } | null;
  onSignOut: () => void;
  onShowShortcuts: () => void;
}

function Card({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-200 flex items-center gap-2">
        <span className="text-indigo-600">{icon}</span>
        <h2 className="text-xs font-black text-slate-800 uppercase tracking-wider">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export default function Settings({ theme, onToggleTheme, currentUser, onSignOut, onShowShortcuts }: Props) {
  return (
    <div className="space-y-4 animate-fadeIn max-w-3xl">
      <Card title="Appearance" icon={<Moon className="w-4 h-4" />}>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-bold text-slate-800">Light / dark theme</p>
            <p className="text-[11px] text-slate-500 leading-snug mt-0.5">
              Press <kbd className="px-1 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono text-[10px] font-black text-slate-700">T</kbd>{' '}
              from any view to switch without coming here.
            </p>
          </div>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </Card>

      <Card title="Account" icon={<ShieldCheck className="w-4 h-4" />}>
        {currentUser ? (
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              {currentUser.picture && (
                <img src={currentUser.picture} alt="" className="w-9 h-9 rounded-full shadow-xs shrink-0" referrerPolicy="no-referrer" />
              )}
              <div className="min-w-0">
                <p className="text-xs font-bold text-slate-800 truncate">{currentUser.name}</p>
                {currentUser.email && <p className="text-[11px] text-slate-500 truncate">{currentUser.email}</p>}
              </div>
            </div>
            <button
              onClick={onSignOut}
              className="btn-press shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-black text-rose-700 bg-rose-50 border border-rose-200 hover:bg-rose-100 rounded-lg cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" /> Sign out
            </button>
          </div>
        ) : (
          <p className="text-xs font-bold text-slate-500">Not signed in.</p>
        )}
        {/* Says where the OTHER Google control lives, because it is not here and its absence
            would otherwise read as a gap. Reconnect Sheets is error recovery for an expired
            token, not an account setting - burying it two clicks deep would be worse. */}
        <p className="text-[11px] text-slate-500 leading-snug mt-3 pt-3 border-t border-slate-100">
          Sheets access is granted at sign-in. If the Google token expires mid-session a
          <strong className="text-slate-700"> Reconnect Sheets</strong> button appears in the
          header on the Imports view — that is deliberate, so a broken read is fixed where it
          happens.
        </p>
      </Card>

      <Card title="Keyboard" icon={<Keyboard className="w-4 h-4" />}>
        <div className="flex items-center justify-between gap-4">
          <p className="text-[11px] text-slate-500 leading-snug">
            {SHORTCUTS.length} shortcuts. Press{' '}
            <kbd className="px-1 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono text-[10px] font-black text-slate-700">?</kbd>{' '}
            anywhere for the full list.
          </p>
          <button
            onClick={onShowShortcuts}
            className="btn-press shrink-0 px-3 py-1.5 text-[11px] font-black text-indigo-700 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 rounded-lg cursor-pointer"
          >
            Show shortcuts
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {SHORTCUTS.map((s) => (
            <span key={s.action} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-50 border border-slate-200">
              <kbd className="font-mono text-[10px] font-black text-slate-700">{keyLabel(s.keys[0])}</kbd>
              <span className="text-[10px] font-bold text-slate-500">{s.label}</span>
            </span>
          ))}
        </div>
      </Card>
    </div>
  );
}
