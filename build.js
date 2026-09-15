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
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

// Compile Tailwind (v4) from src/styles/tailwind.css into a CSS string that gets
// inlined ahead of main.css. Runs the standalone CLI via node so it works cross-
// platform (no reliance on the .cmd shim) and needs no network — everything is
// resolved from the local install, keeping the single-file / offline build intact.
function buildTailwind() {
  const cli = path.join(ROOT, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs');
  const input = path.join(SRC, 'styles', 'tailwind.css');
  const outFile = path.join(os.tmpdir(), `egat-tw-${process.pid}.css`);
  try {
    execFileSync(process.execPath, [cli, '-i', input, '-o', outFile, '--minify'], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    });
    const css = fs.readFileSync(outFile, 'utf8');
    fs.unlinkSync(outFile);
    return css;
  } catch (err) {
    console.error('✗ Tailwind compile failed:', err.message);
    console.error('  Run `npm install` (dev deps: tailwindcss, @tailwindcss/cli).');
    process.exit(1);
  }
}

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
  const tailwindCss = buildTailwind();
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
    '  <!-- ==== Tailwind (compiled, utilities only — no Preflight) ==== -->\n' +
    '  <style id="tw">\n' + tailwindCss + '\n  </style>\n' +
    '  <!-- ==== app styles (authoritative design system) ==== -->\n' +
    '  <style id="app">\n' + css + '\n  </style>\n' +
    '</head>\n' +
    bodyWithScripts;

  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const outFile = path.join(DIST, 'egat-cbank.html');
  fs.writeFileSync(outFile, out);
  fs.writeFileSync(path.join(DIST, 'index.html'), out);
  // Repo-root index.html = the file GitHub Pages serves. Written on every build so
  // a deploy is just: npm run build → git commit → git push (no manual copy).
  fs.writeFileSync(path.join(ROOT, 'index.html'), out);

  const kb = (out.length / 1024).toFixed(1);
  console.log(`✓ Built dist/egat-cbank.html  (${kb} KB)`);
  console.log(`✓ Built dist/index.html       (copy)`);
  console.log(`✓ Built index.html            (repo root — GitHub Pages entry point)`);
}

build();
