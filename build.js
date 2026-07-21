#!/usr/bin/env node
/**
 * build.js — bundles the modular source back into a single deployable HTML file.
 *
 * Why single-file output?
 *  - GitHub Pages + iOS Safari "Add to Home Screen" work most reliably with one
 *    self-contained .html (no module fetch / CORS / cache-split issues).
 *  - The field tool must open offline from a phone's Files app.
 *
 * Usage:  node build.js
 * Output: dist/egat-cbank.html   (and a copy as dist/index.html for Pages)
 *
 * Source layout (edit these, then rebuild):
 *   src/_head.html          <head> markup up to (not including) <style>
 *   src/_body_markup.html    <body> markup WITHOUT any <script> blocks
 *   src/styles/main.css      all CSS
 *   src/js/*.js              JS modules, concatenated in JS_ORDER below
 *
 * The JS blocks are plain (non-module) scripts that share globals — keep that
 * model unless you refactor every cross-file reference. Order matters.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

// JS concatenation order. theme-init runs first (in <head>); the rest run after
// the body markup. calculator defines core math used by everyone else, so it
// leads; app.js wires up event handlers last.
const HEAD_JS = ['theme-init'];
const BODY_JS = ['calculator', 'diagrams', 'formulas', 'ui', 'template-xlsx', 'exporter', 'app'];

function read(p) { return fs.readFileSync(p, 'utf8'); }

function wrapScript(name) {
  const code = read(path.join(SRC, 'js', `${name}.js`));
  return `  <!-- ==== ${name}.js ==== -->\n  <script>\n${code}\n  </script>`;
}

function build() {
  const head = read(path.join(SRC, '_head.html'));
  const css = read(path.join(SRC, 'styles', 'main.css'));
  const bodyMarkup = read(path.join(SRC, '_body_markup.html'));

  // Head theme-init scripts (must run before paint to avoid theme flash)
  const headScripts = HEAD_JS.map(wrapScript).join('\n');

  // Body application scripts
  const bodyScripts = BODY_JS.map(wrapScript).join('\n\n');

  // bodyMarkup already ends with </body></html>; inject scripts before </body>
  const bodyWithScripts = bodyMarkup.replace(
    /<\/body>/,
    `\n${bodyScripts}\n</body>`
  );

  const out =
    head +
    headScripts + '\n' +
    '  <style>\n' + css + '\n  </style>\n' +
    '</head>\n' +
    bodyWithScripts;

  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const outFile = path.join(DIST, 'egat-cbank.html');
  fs.writeFileSync(outFile, out);
  // GitHub Pages entry point
  fs.writeFileSync(path.join(DIST, 'index.html'), out);

  const kb = (out.length / 1024).toFixed(1);
  console.log(`✓ Built dist/egat-cbank.html  (${kb} KB)`);
  console.log(`✓ Built dist/index.html       (copy for GitHub Pages)`);
}

build();
