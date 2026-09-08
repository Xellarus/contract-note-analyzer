/**
 * How urgent the Sheets session is, as a number the clock can paint with.
 *
 * Deliberately a module of its own: it imports NOTHING — not `gapi`, not React — so the ramp
 * that decides a visual warning about a tax app's data access can be tested as plain arithmetic
 * rather than through a mounted component with a stubbed OAuth client.
 */

/** Gold starts bleeding in here. */
export const WARN_MS = 15 * 60_000;
/** Fully gold from here down — the point at which "sign in again" is the only sensible reading. */
export const URGENT_MS = 2 * 60_000;

export type SessionTone = "unknown" | "calm" | "warming" | "urgent" | "expired";

export interface ClockTone {
  tone: SessionTone;
  /** 0 = the theme's ordinary ink, 1 = solid gold. Everything between is the gradient. */
  mix: number;
}

/**
 * `msRemaining` is milliseconds until the token stops being USABLE, which is not the same as
 * its stated expiry: `hasValidGoogleToken` refuses a token in its last 60 seconds, so the
 * caller subtracts that same margin. A countdown that ran to zero while the app had already
 * stopped trusting the token would be a clock that lies at the one moment it matters.
 *
 * `null` means "no token at all" — not "expired". A signed-out app should show a plain clock,
 * not a screaming gold one.
 */
export function sessionTone(msRemaining: number | null): ClockTone {
  if (msRemaining === null || !Number.isFinite(msRemaining)) return { tone: "unknown", mix: 0 };
  if (msRemaining <= 0) return { tone: "expired", mix: 1 };
  if (msRemaining <= URGENT_MS) return { tone: "urgent", mix: 1 };
  if (msRemaining >= WARN_MS) return { tone: "calm", mix: 0 };
  // Linear across the window between the two thresholds: 0 at 15 min, 1 at 2 min. Clamped
  // rather than trusted, because a clock reading a corrupt `expires_at` must not produce a
  // gradient stop outside 0-100% and paint nothing at all.
  const span = WARN_MS - URGENT_MS;
  const mix = (WARN_MS - msRemaining) / span;
  return { tone: "warming", mix: Math.min(1, Math.max(0, mix)) };
}

/**
 * "4m 12s" / "38s" / "1h 3m". Compact because it sits in a tooltip beside a running clock, and
 * a long string there reads as a sentence rather than a countdown.
 */
export function formatRemaining(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "0s";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * The two ends of the ramp, per theme.
 *
 * Both are taken from values `index.css` already defines, so the clock cannot drift from the
 * theme: dark runs warm off-white -> the gold accent ink; light runs slate ink -> the brass
 * accent. "White to gold" is the dark-theme reading of the request; on parchment the same
 * gesture is ink to brass, because gold on cream would be the LESS urgent of the two.
 */
export const TONE_COLORS = {
  dark: { base: "#c4bcab", gold: "#f0c65a" },
  light: { base: "#5e5745", gold: "#8a6a1e" },
} as const;

/**
 * The `color` / `background-image` pair for a given mix. Returned as a plain object so the
 * component stays declarative and this stays testable.
 *
 * A gradient across TEXT needs `background-clip: text` with a transparent colour, so the two
 * states are genuinely different CSS - not one property interpolating. Below/at the ends we
 * emit a flat colour instead, because a "gradient" from a colour to itself is a needless
 * compositing layer on an element that repaints every second.
 */
export function toneStyle(theme: "light" | "dark", t: ClockTone): {
  color: string;
  backgroundImage?: string;
  backgroundClip?: string;
  WebkitBackgroundClip?: string;
} {
  const { base, gold } = TONE_COLORS[theme];
  if (t.mix <= 0) return { color: base };
  if (t.mix >= 1) return { color: gold };
  // The gold stop sweeps right-to-left as the mix rises: at 0.2 only the tail is gold, at 0.8
  // almost all of it is. That is the "slowly turns" the request asked for, and it reads as
  // progress rather than as a colour that merely got warmer.
  const stop = Math.round((1 - t.mix) * 100);
  return {
    color: "transparent",
    backgroundImage: `linear-gradient(90deg, ${base} ${Math.max(0, stop - 15)}%, ${gold} ${stop}%)`,
    backgroundClip: "text",
    WebkitBackgroundClip: "text",
  };
}
