/**
 * The session clock's urgency ramp and its colour output.
 *
 * `src/lib/sessionClock.ts` imports nothing, which is the whole reason it exists as a module:
 * the arithmetic deciding a visual warning about a tax app's data access is testable as plain
 * numbers rather than through a mounted component with a stubbed OAuth client.
 *
 * Run: npx tsx tmp-session-clock.ts
 */
import io from 'node:fs';
import {
  sessionTone, formatRemaining, toneStyle, TONE_COLORS, WARN_MS, URGENT_MS,
} from './src/lib/sessionClock';

let pass = 0;
const fails: string[] = [];
const ok = (label: string, cond: any, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fails.push(label + (detail ? '\n       ' + detail : '')); console.log('  FAIL ' + label); }
};
const eq = (label: string, got: any, want: any) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want),
    `got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

const MIN = 60_000;

// ── the ramp ────────────────────────────────────────────────────────────────────────────────
console.log('\n── tone ' + '─'.repeat(50));
{
  // "No token" is NOT "expired". A signed-out app must show a plain clock, not a gold one.
  eq('no token → unknown, and NOT gold', sessionTone(null), { tone: 'unknown', mix: 0 });
  eq('a corrupt deadline → unknown, not a gradient stop outside 0-100%',
    sessionTone(NaN), { tone: 'unknown', mix: 0 });
  eq('Infinity → unknown', sessionTone(Infinity), { tone: 'unknown', mix: 0 });

  eq('an hour out → calm', sessionTone(60 * MIN), { tone: 'calm', mix: 0 });
  // The boundary belongs to calm: gold must START at 15 minutes, not already be underway.
  eq('exactly 15 min → calm, mix still 0', sessionTone(WARN_MS), { tone: 'calm', mix: 0 });
  ok('just inside 15 min → warming, barely', (() => {
    const t = sessionTone(WARN_MS - 1000);
    return t.tone === 'warming' && t.mix > 0 && t.mix < 0.02;
  })(), JSON.stringify(sessionTone(WARN_MS - 1000)));

  // Halfway between the thresholds must be halfway gold, or "slowly turns" is a lie.
  const mid = (WARN_MS + URGENT_MS) / 2;
  ok('halfway between the thresholds → mix ≈ 0.5', (() => {
    const t = sessionTone(mid);
    return t.tone === 'warming' && Math.abs(t.mix - 0.5) < 0.001;
  })(), JSON.stringify(sessionTone(mid)));

  eq('exactly 2 min → urgent, fully gold', sessionTone(URGENT_MS), { tone: 'urgent', mix: 1 });
  eq('30 s → urgent', sessionTone(30_000), { tone: 'urgent', mix: 1 });
  eq('0 → expired', sessionTone(0), { tone: 'expired', mix: 1 });
  eq('past the deadline → expired, not negative mix', sessionTone(-5 * MIN), { tone: 'expired', mix: 1 });

  // The ramp must be MONOTONIC: every second closer is at least as gold as the last. A
  // non-monotonic ramp would read as the warning receding.
  let prev = -1, monotonic = true;
  for (let ms = WARN_MS; ms >= 0; ms -= 5000) {
    const m = sessionTone(ms).mix;
    if (m < prev - 1e-9) { monotonic = false; break; }
    prev = m;
  }
  ok('mix never decreases as the deadline approaches', monotonic);
  ok('mix stays within 0..1 across the whole window', (() => {
    for (let ms = -MIN; ms <= 70 * MIN; ms += 7331) {
      const m = sessionTone(ms).mix;
      if (!(m >= 0 && m <= 1)) return false;
    }
    return true;
  })());
}

// ── the countdown text ──────────────────────────────────────────────────────────────────────
console.log('\n── formatRemaining ' + '─'.repeat(39));
{
  eq('null → 0s', formatRemaining(null), '0s');
  eq('negative → 0s, never "-3m"', formatRemaining(-1000), '0s');
  eq('45 s', formatRemaining(45_000), '45s');
  eq('4m 12s', formatRemaining(4 * MIN + 12_000), '4m 12s');
  eq('an hour reads in h+m, not 63m', formatRemaining(63 * MIN), '1h 3m');
}

// ── the colours ─────────────────────────────────────────────────────────────────────────────
console.log('\n── toneStyle ' + '─'.repeat(45));
{
  // At the ends, a FLAT colour - a "gradient" from a colour to itself would be a pointless
  // compositing layer on an element that repaints every second.
  eq('calm dark → flat base ink, no gradient',
    toneStyle('dark', { tone: 'calm', mix: 0 }), { color: TONE_COLORS.dark.base });
  eq('urgent dark → flat gold',
    toneStyle('dark', { tone: 'urgent', mix: 1 }), { color: TONE_COLORS.dark.gold });
  eq('calm light uses the LIGHT base, not the dark one',
    toneStyle('light', { tone: 'calm', mix: 0 }), { color: TONE_COLORS.light.base });
  eq('urgent light → brass', toneStyle('light', { tone: 'urgent', mix: 1 }), { color: TONE_COLORS.light.gold });

  const mid = toneStyle('dark', { tone: 'warming', mix: 0.5 });
  ok('mid-ramp goes transparent so the gradient can show', mid.color === 'transparent');
  ok('and clips the gradient to the text, with the -webkit- prefix Safari needs',
    mid.backgroundClip === 'text' && mid.WebkitBackgroundClip === 'text');
  ok('the gradient names both ends', !!mid.backgroundImage
    && mid.backgroundImage.includes(TONE_COLORS.dark.base)
    && mid.backgroundImage.includes(TONE_COLORS.dark.gold));

  // Every stop must land inside 0-100%: a stop outside it paints one flat colour, so the
  // "gradient" stage would silently not exist.
  ok('every stop across the ramp stays within 0-100%', (() => {
    for (let i = 1; i < 100; i++) {
      const st = toneStyle('dark', { tone: 'warming', mix: i / 100 }).backgroundImage || '';
      for (const m of st.matchAll(/(-?\d+)%/g)) {
        const v = parseInt(m[1], 10);
        if (v < 0 || v > 100) return false;
      }
    }
    return true;
  })());
  // The gold stop sweeps toward 0% as urgency rises - that is what makes it read as progress
  // rather than as a colour that merely got warmer.
  const stopAt = (mix: number) => {
    const st = toneStyle('dark', { tone: 'warming', mix }).backgroundImage || '';
    const all = [...st.matchAll(/(-?\d+)%/g)].map((m) => parseInt(m[1], 10));
    return all[all.length - 1];
  };
  ok('the gold stop moves left as the deadline nears', stopAt(0.2) > stopAt(0.8),
    `mix .2 → ${stopAt(0.2)}%, mix .8 → ${stopAt(0.8)}%`);
}

// ── the honesty of the countdown, and the classes the chip uses ─────────────────────────────
console.log('\n── wiring ' + '─'.repeat(48));
{
  const auth = io.readFileSync(new URL('./src/lib/googleAuth.ts', import.meta.url), 'utf8');
  // A countdown that ran to zero while the app had already stopped trusting the token would be
  // a clock that lies at the one moment it matters. Same constant, one definition.
  ok('the countdown subtracts the SAME safety margin the validity check uses',
    /return \(tok\.expires_at - TOKEN_SAFETY_MS\) - Date\.now\(\)/.test(auth));
  ok('and that margin is one exported constant, not three literals',
    /export const TOKEN_SAFETY_MS = 60_000;/.test(auth)
    && (auth.match(/TOKEN_SAFETY_MS/g) || []).length >= 4
    && !/expires_at - 60_000/.test(auth));
  ok('no token reads as null (signed out), never as 0 (expired)',
    /if \(!saved\) return null;/.test(auth));

  const clock = io.readFileSync(new URL('./src/components/LiveClock.tsx', import.meta.url), 'utf8');
  ok('the chip is a real button when re-auth is available', /<button\s/.test(clock));
  ok('and keeps pointer-events-none when it is not', /pointer-events-none/.test(clock));
  // These two shipped unremapped in dark and theme-check could not see them, because they live
  // in a const rather than a className attribute. Pinned here as well as in the widened checker.
  ok('the warning chip uses the REMAPPED amber pair', /border-amber-200 bg-amber-50\/60/.test(clock));
  ok('not the unremapped bg-amber-50/80', !/bg-amber-50\/80/.test(clock));
  ok('not the unremapped border-amber-300', !/border-amber-300/.test(clock));
  // The deadline must be re-read each tick: a re-login rewrites localStorage from outside this
  // component, and a cached deadline would leave the clock gold for an hour after the fix.
  ok('the deadline is re-read every tick, not cached at mount',
    /setMsLeft\(googleTokenMsRemaining\(\)\);/.test(clock));
}

console.log('\n' + '='.repeat(58));
for (const f of fails) console.log('  FAIL ' + f);
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) process.exitCode = 1;
