#!/usr/bin/env node
/**
 * backup.js — archives the current built single-file app into backups/, named by
 * its version badge. Run after build (`npm run build` chains to it) or on its own
 * (`npm run backup`). Keeps a local copy of every version so nothing is ever lost,
 * even if it was never committed/deployed.
 *
 * backups/ is git-ignored (local machine only) — see .gitignore.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'dist', 'index.html');
const DIR = path.join(ROOT, 'backups');

if (!fs.existsSync(SRC)) {
  console.error('✗ dist/index.html not found — run `npm run build` first.');
  process.exit(1);
}
const html = fs.readFileSync(SRC, 'utf8');
const m = html.match(/ver-badge">\s*(v[0-9.]+)/);
const ver = m ? m[1] : 'unknown';

if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
const out = path.join(DIR, `egat-cbank-${ver}.html`);
fs.writeFileSync(out, html);
console.log(`✓ Backed up ${ver} → backups/egat-cbank-${ver}.html  (${(html.length / 1024).toFixed(1)} KB)`);
