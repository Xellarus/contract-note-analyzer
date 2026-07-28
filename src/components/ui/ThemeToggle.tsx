// Day/night theme toggle — a pure CSS/state control (NO SMIL, no rAF, no external SVG).
// The user's supplied animated-SVG loop could not be reliably frozen in this app's
// webview (pauseAnimations() ignored; owning the playhead via setCurrentTime also
// failed), so this rebuild renders the two states directly from the `theme` prop:
// a sliding sun↔moon knob over a day/night sky. It is perfectly stateful (can't drift
// or loop), transitions smoothly, and respects prefers-reduced-motion.
import { useEffect, useState } from 'react';

// Geometry (px). Kept small per user request ("make the button smaller").
const W = 42;
const H = 21;
const PAD = 2.5;
const KNOB = H - PAD * 2;            // 20
const TRAVEL = W - KNOB - PAD * 2;   // 26

export default function ThemeToggle({ theme, onToggle }: { theme: 'light' | 'dark'; onToggle: () => void }) {
  const isDark = theme === 'dark';

  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const on = () => setReduce(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  const ease = 'cubic-bezier(0.16,1,0.3,1)';
  const t = (props: string, ms = 480) => (reduce ? 'none' : props.split(',').map((p) => `${p.trim()} ${ms}ms ${ease}`).join(','));

  return (
    <button
      onClick={onToggle}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label="Toggle dark mode"
      aria-pressed={isDark}
      className="btn-press shrink-0 relative rounded-full overflow-hidden cursor-pointer block leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
      style={{
        width: W,
        height: H,
        background: isDark
          ? 'linear-gradient(160deg,#1b2547 0%,#33456f 100%)'
          : 'linear-gradient(160deg,#49a4ff 0%,#a4d6ff 100%)',
        boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.35)',
        transition: t('background'),
      }}
    >
      {/* Stars — night only */}
      <span aria-hidden className="absolute inset-0" style={{ opacity: isDark ? 1 : 0, transition: t('opacity', 380) }}>
        {[
          { x: 6, y: 5, s: 1.75 },
          { x: 12, y: 11, s: 1.75 },
          { x: 6, y: 14, s: 1.25 },
          { x: 15, y: 6, s: 1.25 },
        ].map((st, i) => (
          <span
            key={i}
            className="absolute rounded-full bg-white"
            style={{ left: st.x, top: st.y, width: st.s, height: st.s, boxShadow: '0 0 2px rgba(255,255,255,0.8)' }}
          />
        ))}
      </span>

      {/* Knob — sun (day) ↔ moon (night) */}
      <span
        aria-hidden
        className="absolute rounded-full"
        style={{
          top: PAD,
          left: PAD,
          width: KNOB,
          height: KNOB,
          transform: isDark ? `translateX(${TRAVEL}px)` : 'translateX(0)',
          background: isDark ? '#e7e6dc' : '#ffd24a',
          boxShadow: isDark
            ? '0 0 5px rgba(231,230,220,0.55), inset -1px -1px 2px rgba(0,0,0,0.12)'
            : '0 0 9px rgba(255,208,74,0.85), 0 1px 2px rgba(0,0,0,0.25)',
          transition: t('transform, background, box-shadow'),
        }}
      >
        {/* Moon craters — fade in with the moon */}
        {[
          { x: 3, y: 3, s: 4 },
          { x: 9, y: 8, s: 3 },
          { x: 5, y: 11, s: 2.5 },
        ].map((c, i) => (
          <span
            key={i}
            className="absolute rounded-full"
            style={{ left: c.x, top: c.y, width: c.s, height: c.s, background: '#cdccc2', opacity: isDark ? 1 : 0, transition: t('opacity', 380) }}
          />
        ))}
      </span>
    </button>
  );
}
