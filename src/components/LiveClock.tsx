import { useEffect, useState } from 'react';

/**
 * Live IST time, pinned to the bottom-right corner of the screen. Holds its own
 * state so the per-second tick re-renders only this component, never the rest of
 * the app. Read straight from `Asia/Kolkata` (same zone as the price stamps), so
 * it's correct regardless of the viewer's machine timezone. Non-interactive
 * (pointer-events-none) so it never blocks clicks on content beneath it.
 */
const fmtTime = (d: Date): string =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  }).format(d);

export default function LiveClock() {
  const [time, setTime] = useState<string>(() => fmtTime(new Date()));
  useEffect(() => {
    const id = window.setInterval(() => setTime(fmtTime(new Date())), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      aria-label={`Current time ${time} IST`}
      className="fixed bottom-4 right-4 z-40 px-3 py-1.5 rounded-xl border border-slate-200 bg-white/80 backdrop-blur shadow-sm text-slate-600 text-[11px] font-bold tabular-nums select-none pointer-events-none"
    >
      {time} <span className="text-slate-400 font-semibold">IST</span>
    </div>
  );
}
