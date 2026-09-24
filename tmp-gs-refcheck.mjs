/**
 * Does every helper the .gs calls actually EXIST in the .gs?
 *
 * `node --check` validates SYNTAX only, so a patch that deletes a declaration while leaving its
 * callers in place passes it cleanly and then throws `ReferenceError` on the live sheet — where
 * the only symptom is a probe that returns nothing. That happened on 24-Sep-2026: rewriting
 * `probeBse_` took the `BSE_HEADERS_` declaration out with it, and the syntax check was happy.
 *
 * Apps Script has no module system and no linter here, so this is the only thing between an edit
 * and a runtime failure that costs a paste-deploy-run round trip to discover.
 *
 *   node tmp-gs-refcheck.mjs
 */
import { readFileSync } from 'fs';

const FILE = 'apps-script/YahooPriceUpdate.gs';
const src = readFileSync(FILE, 'utf8');

// Comments only. An earlier version also stripped string literals to avoid counting a name
// mentioned in prose — but one apostrophe inside a double-quoted string desynchronised the whole
// pass and swallowed real declarations, which is the same class of fault as the comment stripper
// that ate code in tmp-price-asof.ts. A name that appears only in a string is a harmless extra
// check; a scan that deletes code is not.
const code = src
  .replace(/(^|[^*])\/\*[\s\S]*?\*\//g, '$1')
  .replace(/^[ \t]*\/\/.*$/gm, '');

// TOP-LEVEL declarations only, and that is the correct semantic rather than a shortcut: Apps
// Script's globals are exactly the things declared at column 0. A `var` nested inside a function
// is not visible to another function, so counting it as a declaration would hide a real break.
const declared = new Set();
for (const m of code.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)) declared.add(m[1]);
// A top-level `var` can declare SEVERAL names on one line — `var NAME_ALIAS_ = 0, NAME_CANON_ = 1;`
// — so take every `ident =` on the line, not just the first. Capturing only the first reported
// NAME_CANON_ as missing when it is declared right there.
for (const line of code.split(/\r?\n/)) {
  if (!/^var\s/.test(line)) continue;
  for (const m of line.matchAll(/([A-Za-z0-9_$]+)\s*=/g)) declared.add(m[1]);
}

// References that look like this file's own: the trailing underscore is the house convention for
// a private helper, plus the SCREAMING_CASE constants.
const used = new Map();
const note = (id) => used.set(id, (used.get(id) || 0) + 1);
for (const m of code.matchAll(/\b([A-Za-z][A-Za-z0-9_$]*_)\s*\(/g)) note(m[1]);
for (const m of code.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_)\b/g)) note(m[1]);

// Locals shadow nothing here, but a helper may legitimately be a parameter name; ignore anything
// that never appears at top level AND is never called, to keep the signal clean.
const missing = [...used.keys()].filter((id) => !declared.has(id)).sort();

console.log(`${FILE}: ${declared.size} top-level declarations, ${used.size} helper references`);
if (missing.length) {
  console.log('\nMISSING — referenced but never declared at top level:');
  for (const id of missing) {
    console.log(`  ${id}  (${used.get(id)} reference${used.get(id) === 1 ? '' : 's'})`);
  }
  process.exit(1);
}
console.log('every referenced helper is declared');
