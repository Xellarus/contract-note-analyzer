import { PriceSource } from '../lib/scripPrices';

/**
 * Tiny badge marking which feed a displayed CMP came from — Yahoo, Screener or TradingView.
 * Renders nothing for an unknown source (e.g. an average-cost fallback with no live price).
 * These are clean labeled pills, NOT the brand logos (trademarked images we don't bundle) —
 * swap in real logo SVGs here if you want them.
 */
const SOURCES: Record<string, { label: string; cls: string }> = {
  yahoo: { label: 'Yahoo', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  screener: { label: 'Screener', cls: 'bg-teal-50 text-teal-700 border-teal-200' },
  tradingview: { label: 'TradingView', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
};

export default function SourceBadge({ source, className = '' }: { source?: PriceSource; className?: string }) {
  const cfg = source ? SOURCES[source] : undefined;
  if (!cfg) return null;
  const { label, cls } = cfg;
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
