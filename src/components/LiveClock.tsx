import { useEffect, useState } from 'react';
import { googleTokenMsRemaining } from '../lib/googleAuth';
import { formatRemaining, sessionTone, toneStyle } from '../lib/sessionClock';

/**
 * Live IST time, pinned to the bottom-right corner — and the app's session gauge.
 *
 * Holds its own state so the per-second tick re-renders only this component, never the rest of
 * the app. Read straight from `Asia/Kolkata` (same zone as the price stamps), so it is correct
 * regardless of the viewer's machine timezone.
 *
 * ── It doubles as the Sheets-session warning ──
 * Google's access token lapses roughly hourly, and the old behaviour was binary: everything
 * looked fine until a full-screen "Session expired" modal landed on top of whatever you were
 * doing. The clock is already on screen and already counting, so it carries the warning: the
 * ink drifts from the theme's ordinary colour toward gold from 15 minutes out, and is solid gold
 * under 2. Clicking it re-authorises, so the fix is where the warning is.
 *
 * This makes the clock INTERACTIVE, which it deliberately was not before ("pointer-events-none
 * so it never blocks clicks on content beneath it"). It stays a 1.5rem-tall chip in the corner
 * and only becomes a button when `onReauth` is supplied — the pointer-events note is preserved
 * for the non-interactive case.
 */
const fmtTime = (d: Date): string =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  }).format(d);

interface Props {
  theme: 'light' | 'dark';
  /** Re-run the Google authorisation. Omit and the clock stays a plain, non-interactive clock. */
  onReauth?: () => void;
}

export default function LiveClock({ theme, onReauth }: Props) {
  const [time, setTime] = useState<string>(() => fmtTime(new Date()));
  const [msLeft, setMsLeft] = useState<number | null>(() => googleTokenMsRemaining());

  useEffect(() => {
    // One timer for both. The token deadline is re-read every tick rather than cached: a
    // successful re-login rewrites localStorage from OUTSIDE this component, and a cached
    // deadline would leave the clock gold for the next hour after the problem was fixed.
    const id = window.setInterval(() => {
      setTime(fmtTime(new Date()));
      setMsLeft(googleTokenMsRemaining());
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const tone = sessionTone(msLeft);
  const style = toneStyle(theme, tone);
  const warning = tone.tone === 'warming' || tone.tone === 'urgent' || tone.tone === 'expired';

  const title = msLeft === null
    ? 'Google Sheets is not connected — click to sign in'
    : msLeft <= 0
      ? 'Sheets access has expired — click to sign in again'
      : warning
        ? `Sheets access expires in ${formatRemaining(msLeft)} — click to sign in again`
        : `Current time (IST). Sheets access is good for another ${formatRemaining(msLeft)}.`;

  /**
   * The warning pair is the amber-200 border with the 50/60 fill, deliberately: BOTH have dark
   * remaps (index.css:337 and :445). The first version of this chip used the 50/80 fill and an
   * amber-300 border, neither of which is remapped - a near-white chip with a bright orange ring
   * in a dark UI. Do not "tidy" those values without checking index.css first.
   *
   * Class names are left unquoted in this comment on purpose: theme-check now scans string and
   * template literals, and a backticked class name in a comment reads to it as real markup.
   *
   * The chip's edge carries the warning as well as the ink - 11px of text in the far corner of a
   * wide screen is easy to miss, and the border is what peripheral vision catches.
   */
  const shell = `fixed bottom-4 right-4 z-40 px-3 py-1.5 rounded-xl border backdrop-blur shadow-sm text-[11px] font-bold tabular-nums select-none transition-colors ${
    warning ? 'border-amber-200 bg-amber-50/60' : 'border-slate-200 bg-white/80'
  } ${onReauth ? 'cursor-pointer hover:shadow-md' : 'pointer-events-none'}`;

  // `style` carries the gradient, so the time itself gets no colour class - a `text-*` utility
  // would win over `color: transparent` and the gradient would never show.
  const body = (
    <>
      <span style={style}>{time}</span>{' '}
      <span className={warning ? 'text-amber-700 font-semibold' : 'text-slate-400 font-semibold'}>IST</span>
    </>
  );

  if (!onReauth) {
    return <div aria-label={`Current time ${time} IST`} className={`${shell}`}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onReauth}
      title={title}
      // The label says what the CONTROL does, not what it reads; the time is decoration to a
      // screen reader here and `title` carries the deadline for everyone else.
      aria-label={title}
      className={shell}
    >
      {body}
    </button>
  );
}
