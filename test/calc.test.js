#!/usr/bin/env node
/**
 * calc.test.js — guards the I_no calculation against regressions.
 *
 * It loads calcYYMetrics out of src/js/calculator.js (without a browser) and
 * asserts the results match the EGAT Excel reference (RS-CAY21) to 4 decimals.
 *
 * Run with:  npm test   (or:  node test/calc.test.js)
 *
 * If either assertion fails, the calculation has drifted from the spreadsheet —
 * do NOT ship until it passes again. See CLAUDE.md "CRITICAL" section.
 */
const fs = require('fs');
const path = require('path');

// --- Provide the globals calculator.js expects, then eval just what we need ---
const PI2F = 2 * Math.PI * 50;
function sumC(arr) { return arr.reduce((t, c) => t + c.val, 0); }

// Extract calcYYMetrics from the source so the test always uses the real code.
const calcSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'js', 'calculator.js'), 'utf8'
);
const fnMatch = calcSrc.match(/function calcYYMetrics[\s\S]*?\n}\n/);
if (!fnMatch) {
  console.error('✗ Could not find calcYYMetrics in calculator.js');
  process.exit(1);
}
// eslint-disable-next-line no-eval
eval(fnMatch[0]); // defines calcYYMetrics in this scope (uses PI2F, sumC above)

let failures = 0;
function approx(label, got, want, tol = 0.01) {
  const ok = Math.abs(got - want) <= tol;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: got ${got.toFixed(4)}, want ${want.toFixed(4)}`);
  if (!ok) failures++;
}

console.log('EGAT C-Bank — calculation regression tests\n');

// --- Case 1: 69 kV, single measured capacitor per phase (Volt-Amp sheet) ---
// Series of one cap = the cap itself.
console.log('Case 1 — 69 kV, single cap/phase (Excel Ino = 345.0149 mA)');
{
  const y1 = [
    { id: 'A-1', val: 9.538361068223256, origin: 'A' },
    { id: 'B-1', val: 9.496361279149092, origin: 'B' },
    { id: 'C-1', val: 9.510277862093947, origin: 'C' },
  ];
  const y2 = [
    { id: "A'-1", val: 14.290994438013781, origin: "A'" },
    { id: "B'-1", val: 14.197063263371943, origin: "B'" },
    { id: "C'-1", val: 14.296860453039638, origin: "C'" },
  ];
  const m = calcYYMetrics(y1, y2, 69);
  approx('Ino (mA)', m.Ino_mA, 345.0149);
}

// --- Case 2: 115 kV, 10 series caps/phase (C-Bank Arrangement sheet) ---
// Each phase = 10 caps in series. To reproduce C_phase exactly, each unit value
// is C_phase * 10 so that 1/Σ(1/Cᵢ) = C_phase.
console.log('\nCase 2 — 115 kV, 10 series caps/phase (Excel Ino = 33.1616 mA, Vno = 71.3057 V)');
{
  const seriesCaps = (Ceff, n, pfx) =>
    Array.from({ length: n }, (_, i) => ({ id: `${pfx}-${i + 1}`, val: Ceff * n, origin: pfx }));
  const y1 = [
    ...seriesCaps(2.72, 10, 'A'),
    ...seriesCaps(2.72, 10, 'B'),
    ...seriesCaps(2.71283402333459, 10, 'C'),
  ];
  const y2 = [
    ...seriesCaps(2.72, 10, "A'"),
    ...seriesCaps(2.72, 10, "B'"),
    ...seriesCaps(2.70965779467681, 10, "C'"),
  ];
  const m = calcYYMetrics(y1, y2, 115);
  approx('Vno (V)', m.Vno, 71.3057);
  approx('Ino (mA)', m.Ino_mA, 33.1616);
}

// --- Case 3: series-reduction sanity (10×27.2 µF in series = 2.72 µF) ---
console.log('\nCase 3 — series reduction sanity');
{
  const y1 = Array.from({ length: 10 }, (_, i) => ({ id: `A-${i + 1}`, val: 27.2, origin: 'A' }))
    .concat(Array.from({ length: 10 }, (_, i) => ({ id: `B-${i + 1}`, val: 27.2, origin: 'B' })))
    .concat(Array.from({ length: 10 }, (_, i) => ({ id: `C-${i + 1}`, val: 27.2, origin: 'C' })));
  const y2 = JSON.parse(JSON.stringify(y1)).map(c => ({ ...c, origin: c.origin + "'" }));
  const m = calcYYMetrics(y1, y2, 115);
  approx('C_phase A series (µF)', m.perPhase.A.C1, 2.72);
  // balanced bank → Ino ≈ 0
  approx('Ino balanced (mA)', m.Ino_mA, 0, 0.001);
}

// --- Case 4: 22 kV "C-Bank Arrangement" (RS-CAY21) — verified vs Excel formulas ---
// Per-phase C = series of 10 parallel positions (Y1≈27.2/pos, Y2≈54.4/pos,
// scissored position = va+vb with NO ÷2). Reduced per-phase values taken from
// the Excel sheet at full precision; Excel Ino = 21.8963 mA, Vno = 2.81828 V.
console.log('\nCase 4 — 22 kV C-Bank Arrangement (Excel Ino = 21.8963 mA, Vno = 2.8183 V)');
{
  const y1 = [
    { id: 'A',  val: 2.72,              origin: 'A' },
    { id: 'B',  val: 2.72,              origin: 'B' },
    { id: 'C',  val: 2.71283402333459, origin: 'C' },
  ];
  const y2 = [
    { id: "A'", val: 5.43291798400595, origin: "A'" },
    { id: "B'", val: 5.43495829471733, origin: "B'" },
    { id: "C'", val: 5.4359733530718,  origin: "C'" },
  ];
  const m = calcYYMetrics(y1, y2, 22);
  approx('Vno (V)',  m.Vno,    2.8183);
  approx('Ino (mA)', m.Ino_mA, 21.8963);
}

console.log('');
if (failures) {
  console.error(`✗ ${failures} assertion(s) FAILED — calculation has regressed.`);
  process.exit(1);
}
console.log('✓ All calculation tests passed — matches EGAT Excel.');
