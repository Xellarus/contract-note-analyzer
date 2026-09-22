import { useMemo, useState } from 'react';
import { ScripMaster, classOfEntryAsOf } from '../lib/scripMaster';
import { ASSET_CLASSES } from '../lib/privateEquities';

interface Props {
  value: string;
  onChange: (name: string) => void;
  master: ScripMaster | null;
  placeholder?: string;
  className?: string;
  /**
   * Offer ONLY unlisted companies (the "Private Equities" tab). Set when the drawer was
   * opened with the Private Equity segment active, so the ~5,000 listed securities don't
   * bury the handful of unlisted ones the user actually means.
   */
  peOnly?: boolean;
}

/**
 * Lightweight typeahead over the scrip master. Filters by canonical name / NSE symbol /
 * BSE ticker as you type and renders only the top matches in a small dropdown.
 *
 * Replaces a native <datalist>, which becomes unreliable once the master grows to
 * ~5,000 entries — the browser silently stops rendering the suggestion popup, so NO
 * company autocompletes (the bug that hid both "stride" and "jeena"). A controlled
 * list we filter ourselves is reliable at any size and lets the user match on ticker too.
 * Free-typing an unmatched name still works (the app supports unmatched scrips).
 */
export default function ScripCombobox({ value, onChange, master, placeholder, className, peOnly }: Props) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);

  const { matches, total } = useMemo(() => {
    const term = (value || '').trim().toLowerCase();
    // Normally the list stays shut until you type — 5,000 entries are useless unfiltered. The
    // unlisted list is a handful, so in PE scope an empty box shows all of them: "which of my
    // private companies is this" is answerable from the list itself.
    if (!master || (term.length < 1 && !peOnly)) return { matches: [] as { name: string; tag: string }[], total: 0 };
    const out: { name: string; tag: string }[] = [];
    const seen = new Set<string>();
    for (const e of master.entries) {
      // The class AS IT IS NOW, not as it ever was. A company that has listed keeps its
      // unlisted history on the master (that is what reproduces a filed year), but it must
      // not still be offered in the unlisted-only picker or badged "PE" beside its own
      // exchange ticker — on this screen the question really is "what is it today".
      const cls = classOfEntryAsOf(e, Date.now());
      if (peOnly && !cls) continue;
      const name = (e.canonicalName || '').trim();
      if (!name || seen.has(name)) continue;
      // An UNLISTED company has no ticker to be searched by; matching it on one would only ever
      // be a contradictory leftover on its master entry. It gets its ISIN instead, which is what
      // the Private Equities tab now keys on and the only identifier it really has.
      const hay = (cls
        ? `${name} ${e.isin || ''}`
        : `${name} ${e.nse || ''} ${e.bse || ''}`).toLowerCase();
      // An unlisted company has no ticker to show, so it is tagged as what it is.
      // The tag names the CLASS for a non-listed entry ("PE" / "AIF" / "MF" / "BOND") rather than
      // a generic "unlisted": with four tabs in the same dropdown, which one a company came
      // from is the thing the user needs to see.
      if (hay.includes(term)) {
        seen.add(name);
        out.push({ name, tag: cls ? ASSET_CLASSES[cls].badge : (e.nse || e.bse || '') });
      }
      // The scan cap exists for the LISTED universe — 5,000 entries, where stopping early is
      // the difference between a typeahead and a stall. It must NOT apply to the non-listed
      // one: that is bounded by four hand-maintained tabs, and breaking out of the loop there
      // drops companies BY SHEET ORDER. With an empty box in PE scope every entry matches, so
      // the scan stopped at the 60th row of the tab and nothing below it could ever be found
      // — including a company added at the bottom, which is where a newly added one goes.
      if (!peOnly && out.length >= 60) break;
    }
    // Rank prefix matches first, then alphabetical.
    out.sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(term) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(term) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    });
    // The unlisted list is the whole point of PE scope — "which of my private companies is
    // this" is answerable from the list itself — so show all of it. The listed one stays
    // capped, and SAYS it is capped: a silent slice at 30 is indistinguishable from a company
    // that is not registered at all, which is exactly how this was reported.
    const shown = peOnly ? out : out.slice(0, 30);
    return { matches: shown, total: out.length };
  }, [value, master, peOnly]);

  const pick = (name: string) => { onChange(name); setOpen(false); };

  return (
    <div className="relative">
      <input
        type="text" placeholder={placeholder} value={value} autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => { if (peOnly || (value || '').trim()) setOpen(true); }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(matches[Math.min(hi, matches.length - 1)].name); }
          else if (e.key === 'Escape') { setOpen(false); }
        }}
        className={className}
      />
      {open && matches.length > 0 && (
        <ul className="absolute z-30 mt-1 w-full max-h-56 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg text-xs">
          {/* Never truncate in silence. A list cut at 30 with no marker reads as "that company
              is not registered", which sends the user off to add a duplicate row for one that
              already exists. */}
          {total > matches.length && (
            <li className="px-3 py-1.5 text-[10px] text-slate-500 bg-slate-50 border-b border-slate-200 sticky top-0">
              Showing {matches.length} of {total} — keep typing to narrow.
            </li>
          )}
          {matches.map((m, i) => (
            <li
              key={m.name}
              onMouseDown={(e) => { e.preventDefault(); pick(m.name); }}
              onMouseEnter={() => setHi(i)}
              className={`px-3 py-1.5 cursor-pointer flex items-center justify-between gap-2 ${i === hi ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
            >
              <span className="text-slate-800 truncate">{m.name}</span>
              {m.tag && <span className="text-[10px] font-mono text-slate-400 shrink-0">{m.tag}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
