#!/usr/bin/env python3
"""
Static checks for the two-layer Tailwind theme in src/index.css.

The themes work by repainting LITERAL Tailwind class names in two unlayered blocks
(`.dark ...` and `html:not(.dark) ...`). Every failure mode below follows from that:
a class the remap layer cannot name is a class the theme cannot repaint.

Run from the repo root:  python .claude/skills/theme-check/theme_check.py
Exit code 1 if any FAIL-level finding is present.
"""
import glob
import io
import os
import re
import sys
from collections import defaultdict

CSS_PATH = 'src/index.css'
VALID_SHADES = {50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950}
PROPS = ('bg', 'text', 'border', 'divide', 'from', 'to', 'via', 'ring', 'shadow',
         'outline', 'fill', 'stroke', 'accent', 'decoration', 'caret', 'placeholder')
PALETTES = ('slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow',
            'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet',
            'purple', 'fuchsia', 'pink', 'rose')
UTIL_RE = (r'(?:' + '|'.join(PROPS) + r')-(?:' + '|'.join(PALETTES) + r')-\d{2,3}')


# ── index.css ────────────────────────────────────────────────────────────────
def load_css():
    css = io.open(CSS_PATH, encoding='utf-8').read()
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)          # comments never define anything
    layers = {'dark': {}, 'light': {}, 'base': {}}
    for sel_list, body in re.findall(r'([^{}]+)\{([^{}]*)\}', css):
        colour = None
        for prop in ('background-color', 'color', 'border-color', '--tw-gradient-from',
                     '--tw-gradient-to', 'outline-color', '--tw-ring-color'):
            m = re.search(re.escape(prop) + r'\s*:\s*([^;]+)', body)
            if m:
                colour = m.group(1).strip()
                break
        for sel in sel_list.split(','):
            s = sel.strip()
            m = re.search(r'\.((?:[a-z-]+\\?:)*' + UTIL_RE + r'(?:\\/\d+)?)', s)
            if not m:
                continue
            cls = m.group(1).replace('\\', '')
            layer = 'dark' if s.startswith('.dark') else 'light' if s.startswith('html:not(.dark)') else 'base'
            layers[layer][cls] = colour
    return layers


# ── source ───────────────────────────────────────────────────────────────────
CLS_ATTR = re.compile(r'className=(?:"([^"]*)"|\{`((?:[^`\\]|\\.)*)`\}|\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\})', re.S)
SPLIT = re.compile(r'\$\{|\}|`|\'|"|\?')


def source_files():
    out = []
    for ext in ('tsx', 'ts'):
        out += [f for f in glob.glob(f'src/**/*.{ext}', recursive=True)]
    return [f.replace('\\', '/') for f in out]


def scan_source():
    """Yield (file, line, fragment_classes) for every co-occurring group of classes."""
    for f in source_files():
        src = io.open(f, encoding='utf-8', errors='replace').read()
        for m in CLS_ATTR.finditer(src):
            val = next((g for g in m.groups() if g), '')
            line = src[:m.start()].count('\n') + 1
            for frag in SPLIT.split(val):
                classes = frag.split()
                if classes:
                    yield f, line, classes


def main():
    if not os.path.exists(CSS_PATH):
        print(f'run from the repo root - {CSS_PATH} not found')
        return 2

    layers = load_css()
    pinned = set(layers['dark']) | set(layers['light']) | set(layers['base'])
    findings = defaultdict(list)

    util_exact = re.compile(r'^((?:[a-z0-9\[\]&_.\-]+:)*)(' + UTIL_RE + r')(/\d+)?$')

    seen_pairs = set()
    for f, line, classes in scan_source():
        bgs, hovers = {}, {}
        for c in classes:
            m = util_exact.match(c)
            if not m:
                continue
            variants, util, opacity = m.group(1), m.group(2), m.group(3) or ''
            shade = int(util.rsplit('-', 1)[1])
            full = util + opacity

            # A ── a shade Tailwind never generates: no CSS at all, silently inherits
            if shade not in VALID_SHADES and full not in pinned:
                findings['A'].append((f, line, c))

            # B ── arbitrary variants can never be named by the remap layer
            if '[' in variants:
                findings['B'].append((f, line, c))

            # C ── opacity-suffixed light background with no dark entry
            if opacity and util.startswith('bg-') and shade in (50, 100):
                try:
                    pct = int(opacity[1:])
                except ValueError:
                    pct = 0
                if pct >= 40 and full not in layers['dark'] and ('hover:' + full) not in layers['dark']:
                    findings['C'].append((f, line, c))

            # F ── a SOLID light-tint background with no dark entry. Category C covers only the
            # opacity-SUFFIXED form, so a plain `bg-blue-50` was in no category at all - yet it
            # fails identically, keeping Tailwind's near-white base and reading as a bright chip
            # in a dark UI. Six such classes across nine call sites were live when this was
            # added, four of them below 2.3:1 contrast.
            #
            # `hover:`/`group-hover:` variants ARE included, because a hover that flashes stock
            # near-white is the same defect - but the lookup must try the variant-qualified name
            # too: the remap layer names `.dark .hover\:bg-x:hover`, so comparing the bare util
            # would report every correctly-remapped hover as missing. That false positive is
            # exactly what made a first pass at this check unusable.
            # Shade 200 included: a stock `bg-red-200` pill sitting on a themed dark panel
            # reads at 11.7:1 - the same defect as a 50/100 fill and worse, because a 200 is
            # more saturated. Restricting this to (50, 100) let exactly that ship.
            if (not opacity and util.startswith('bg-') and shade in (50, 100, 200)
                    and '[' not in variants):
                # A variant is painted ONLY by its variant-qualified selector; the bare
                # utility's entry cannot reach it. So test the name that would actually have to
                # be there, and nothing else.
                qualified = variants + util
                missing = ((qualified not in layers['dark']) if variants
                           else (util not in layers['dark']))
                if missing:
                    findings['F'].append((f, line, c))

            if variants == '' and util.startswith('bg-'):
                bgs[util] = c
            elif variants == 'hover:' and util.startswith('bg-'):
                hovers[util] = c

        # E ── zero-delta hover: rest and hover resolve to the same colour in a theme
        for bg in bgs:
            for hv in hovers:
                # `bg-slate-400 hover:bg-slate-400` is the deliberate "this button is
                # disabled, kill the hover" idiom, not a zero-delta bug. Only DIFFERENT
                # classes landing on the same colour are worth reporting.
                if bg == hv:
                    continue
                key = (bg, hv)
                for layer in ('dark', 'light'):
                    rest = layers[layer].get(bg, f'stock:{bg}')
                    hover = layers[layer].get('hover:' + hv, f'stock:{hv}')
                    if rest == hover and (key, layer) not in seen_pairs:
                        seen_pairs.add((key, layer))
                        findings['E'].append((f, line, f'{bg} + hover:{hv} -> both {rest} in {layer}'))

    # D ── hover variant used whose base IS remapped but the hover variant is not
    used_variant = set()
    for _f, _l, classes in scan_source():
        for c in classes:
            m = util_exact.match(c)
            # Any single state variant, not just `hover:` - `group-hover:` and `disabled:` are
            # painted by their own selector too, and the file has no entry for either.
            if m and m.group(1) in ('hover:', 'group-hover:', 'disabled:', 'focus:'):
                used_variant.add((m.group(1), m.group(2) + (m.group(3) or '')))
    for pfx, util in sorted(used_variant):
        for layer in ('dark', 'light'):
            if util in layers[layer] and (pfx + util) not in layers[layer]:
                findings['D'].append(('-', 0, f'{pfx}{util} unremapped in {layer} (base {util} is remapped)'))

    TITLES = {
        'A': ('FAIL', 'Shade does not exist in Tailwind - generates NO CSS, silently inherits'),
        'B': ('WARN', 'Arbitrary variant - the remap layer cannot name it, keeps Tailwind default'),
        'C': ('WARN', 'Opacity-suffixed light background with no dark entry - washes out ivory text'),
        'D': ('INFO', 'Hover variant lacks its own entry while the base class has one'),
        'E': ('FAIL', 'Zero-delta hover - rest and hover paint the same colour, hover is invisible'),
        'F': ('WARN', 'SOLID light-tint background with no dark entry - a near-white chip in a dark UI'),
    }

    total_fail = 0
    for key in ('A', 'E', 'C', 'F', 'B', 'D'):
        level, title = TITLES[key]
        rows = findings[key]
        print(f'\n[{level}] {title}  ({len(rows)})')
        if not rows:
            print('  none')
            continue
        if level == 'FAIL':
            total_fail += len(rows)
        shown = rows[:25]
        for f, line, what in shown:
            loc = f'{os.path.basename(f)}:{line}' if f != '-' else ''
            print(f'  {loc:28} {what}')
        if len(rows) > len(shown):
            print(f'  ... and {len(rows) - len(shown)} more')

    print(f'\n{"FAIL" if total_fail else "OK"} - {total_fail} blocking finding(s)')
    print('Reference: System/Theme System.md in the Backoffice vault.')
    return 1 if total_fail else 0


if __name__ == '__main__':
    sys.exit(main())
