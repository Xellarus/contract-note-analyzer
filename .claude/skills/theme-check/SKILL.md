---
name: theme-check
description: "Validate a styling change against this app's two-layer light/dark theme. Use after editing any className, colour class, or src/index.css — the build cannot catch these failures. Covers dead shades, zero-delta hovers, arbitrary variants, and opacity-suffixed backgrounds."
---

# Theme check

Both themes — **Brass on Paper** (light) and **Brass Terminal** (dark) — work by repainting
**literal** Tailwind class names in two unlayered blocks in `src/index.css`:

```css
.dark .bg-slate-100            { background-color: #242019; }
html:not(.dark) .bg-slate-100  { background-color: #e9e1cd; }
```

Everything that goes wrong follows from that one sentence: **a class the remap layer cannot name
is a class the theme cannot repaint.** `tsc` and `vite build` validate none of it, and a broken
class usually looks completely correct in the source.

## Run it

```bash
python .claude/skills/theme-check/theme_check.py
```

From the repo root. Exit code 1 if there is a blocking finding.

## What it checks

| | Level | Failure |
|---|---|---|
| **A** | FAIL | **Shade Tailwind never generates.** `text-slate-655`, `bg-indigo-650` — only 50/100/200…900/950 exist. Anything else emits **no CSS at all**, so the element silently inherits its parent's colour and no remap can ever reach it. 92 of these were found in one sweep; one left a primary button invisible. `border-slate-150`, `divide-slate-150` and `border-slate-205` are hand-pinned in `index.css` and are recognised as legitimate. |
| **E** | FAIL | **Zero-delta hover.** The rest state and the hover state resolve to the *same* colour in a theme, so the control has no hover at all. Has shipped twice: `bg-slate-100` + `hover:bg-slate-50` both map to `#242019` in dark. Writing the same class on both sides (`bg-slate-400 hover:bg-slate-400`) is the deliberate "disabled, no hover" idiom and is not flagged. |
| **C** | WARN | **Opacity-suffixed light background with no dark entry.** `bg-emerald-50/70` falls back to near-white and washes out ivory text. Applies at ≥40%. |
| **B** | WARN | **Arbitrary variant.** `[&_th]:bg-slate-50` can never be named by the remap layer, so it keeps Tailwind's cool default and clashes. |
| **D** | INFO | **Hover variant with no entry of its own** while the base class has one. Not always wrong — informational, because the pairing determines whether it matters, and check E already catches the pairings that do. |

## Fixing a finding

- **A** — replace with a real shade. Truncate to the base hundred the author nudged from
  (`655 → 600`, `250 → 200`, `55 → 50`), *except* where that breaks contrast: `text-slate-450 →
  400` gives 2.90:1 on parchment and fails AA, so it goes to 500 (4.29:1).
- **E** — pick a hover shade that is remapped to a genuinely different colour, or add the entry.
- **C / B** — either add the entry to both blocks, or switch to a class that already has one.

Whatever you add, **add it to both blocks**. A remap in `.dark` only is how the light theme
drifts.

## Rules the checker cannot enforce

- **Indigo is load-bearing.** It is the brass accent before remapping. Never "modernise" the
  indigo away — it detaches the component from the theme and dark mode silently stops working.
- `.dark .bg-indigo-600` also sets `color`, which beats `text-white`. Check both properties when
  changing an indigo button.
- Keyboard focus is a token, not a remap: `--focus-ring` on `:root` / `.dark`, driving one
  `@layer base` rule. That rule is layered **on purpose** so Tailwind utilities still outrank it
  and anything with its own `focus:ring-*` does not draw two indicators.
- Native controls follow the CSS `color-scheme` property on `:root` / `.dark`, never a
  `<meta name="color-scheme">` tag — the meta tag tracks the OS, not the app's own toggle.
- Anything visual still needs a real browser. Use the `run` skill; a passing check is not a
  substitute for looking at both themes.

## Reference

`System/Theme System.md` in the Backoffice vault holds the full palette and the running list of
rules. Update it when a new failure mode is found.
