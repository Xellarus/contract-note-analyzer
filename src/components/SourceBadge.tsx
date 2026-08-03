import { PriceSource } from '../lib/scripPrices';

/**
 * Tiny badge marking which feed a displayed CMP came from — Yahoo or Screener. Renders
 * nothing for an unknown source (e.g. an average-cost fallback with no live price). These
 * are clean labeled pills, NOT the brand logos (trademarked images we don't bundle) — swap
 * in real logo SVGs here if you want them.
 */
export default function SourceBadge({ source, className = '' }: { source?: PriceSource; className?: string }) {
  if (source !== 'yahoo' && source !== 'screener') return null;
  const isYahoo = source === 'yahoo';
  const label = isYahoo ? 'Yahoo' : 'Screener';
  const cls = isYahoo
    ? 'bg-violet-50 text-violet-700 border-violet-200'
    : 'bg-teal-50 text-teal-700 border-teal-200';
  return (
    <span
      title={`Current price from ${label}`}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[9px] font-black uppercase tracking-wider select-none ${cls} ${className}`}
    >
      <svg viewBox="0 0 8 8" className="w-1.5 h-1.5" aria-hidden="true"><circle cx="4" cy="4" r="4" fill="currentColor" /></svg>
      {label}
    </span>
  );
}
