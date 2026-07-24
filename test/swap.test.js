#!/usr/bin/env node
/**
 * swap.test.js — guards the YY swap OPTIMIZER (findPhaseAwareYYSwaps) against
 * regressions in the selection layer. The core I_no math is covered by
 * calc.test.js; this file covers the picker: sparesUsed accounting and the
 * ranking order (relay gate → balance gate → lowest I_no → least effort).
 *
 * Run with:  npm run test:swap   (or:  node test/swap.test.js)
 *
 * It loads calculator.js in a vm sandbox (no browser) and exports the two
 * functions it needs by appending an assignment to the source.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'js', 'calculator.js'), 'utf8'
).replace(/\r\n/g, '\n');

const ctx = { window: {}, console, Math, Object, Array, Set, JSON, isFinite, parseFloat, alert() {} };
vm.createContext(ctx);
// findPhaseAwareYYSwaps is a top-level function (not on window) — export it explicitly.
vm.runInContext(src + '\n;window.__opt = findPhaseAwareYYSwaps; window.__spread = phaseSpreadOf;', ctx);
const optimize = ctx.window.__opt;
const calcYY   = ctx.window._calcYYMetrics;
const spreadOf = ctx.window.__spread;
const SPARE    = new Set(['replace-y1', 'replace-y2', 'piece-replace']);
const KV = 115, THR = 50;

let failures = 0;
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
}

function bank(perPhase, nominal, tweaks) {
  const y1 = [], y2 = [];
  for (const o of ['A', 'B', 'C'])      for (let i = 0; i < perPhase; i++) y1.push({ id: `${o}-${i + 1}`, val: nominal, origin: o, pos: i });
  for (const o of ["A'", "B'", "C'"])   for (let i = 0; i < perPhase; i++) y2.push({ id: `${o}-${i + 1}`, val: nominal, origin: o, pos: i });
  (tweaks || []).forEach(([id, v]) => { const t = y1.find(x => x.id === id) || y2.find(x => x.id === id); t.val = v; });
  return { y1, y2 };
}
function spares(vals) { return vals.map((v, i) => ({ id: 'S-' + (i + 1), val: v, origin: 'Spare', pos: i })); }
function run(b, sp) { return optimize(b.y1, b.y2, sp, null, KV, [], [], 27.0, null, THR); }
function reIno(sw) { return calcYY(sw.y1, sw.y2, KV).Ino_mA; }
function realSpareActions(sw) { return sw.acts.filter(a => SPARE.has(a.type)).length; }

console.log('EGAT C-Bank — swap optimizer regression tests\n');

// --- Invariant across all cases: every returned plan is internally consistent ---
function assertConsistent(tag, res) {
  res.swaps.forEach(sw => {
    check(`${tag} b${sw.swapCount}: reported Ino matches recomputed`, Math.abs(sw.Ino_mA - reIno(sw)) < 1e-6);
    check(`${tag} b${sw.swapCount}: sparesUsed == real spare actions`, sw.sparesUsed === realSpareActions(sw));
  });
}

// Case 1 — sparesUsed must NOT count piece-swap (bug 1). Scissored bank, no spare:
// the only repair is a piece-swap (สับชิ้นกันเอง) which consumes NO spare.
console.log('Case 1 — scissored bank, piece-swap only (sparesUsed must be 0)');
{
  const mk = (origins) => { const a = []; for (const o of origins) for (let i = 0; i < 5; i++)
    a.push({ id: `${o}-${i + 1}`, origin: o, pos: i, measuredA: 27.2, measuredB: 27.2, val: 54.4, isSplit: true }); return a; };
  const y1 = mk(['A', 'B', 'C']), y2 = mk(["A'", "B'", "C'"]);
  const setPiece = (id, pc, v) => { const t = y1.find(x => x.id === id) || y2.find(x => x.id === id);
    if (pc === 'a') t.measuredA = v; else t.measuredB = v; t.val = t.measuredA + t.measuredB; };
  setPiece('A-2', 'a', 25.0); setPiece("A'-3", 'b', 29.4);   // symmetric off pieces → one piece-swap fixes
  const res = optimize(y1, y2, [], null, KV, [], [], 27.0, null, THR);
  const b6 = res.swaps[res.swaps.length - 1];
  check('reaches relay pass with a piece-swap', b6.Ino_mA < THR);
  check('sparesUsed === 0 (piece-swap uses no spare)', b6.sparesUsed === 0);
  assertConsistent('scissors', res);
}

// Case 2 — ranking prefers LOWEST I_no even when it needs a spare (bug 2 / policy).
// Lone deficit on B' (no matching partner) → only a spare can zero it; matched
// A/A' + C/C' pairs are fixed by near exchanges. The chosen plan is MIXED (rack
// exchange + spare) and the largest budget reaches ~0. NOTE: on this big bank the
// beam narrows, so budget-4 only reaches ~9 mA (passes relay); driving budget-4
// itself to ~0 is a Track 3 (assembly) goal — kept as concept, not yet built.
console.log('\nCase 2 — lone deficit needs a spare → mixed plan chosen (rack + spare)');
{
  const b = bank(10, 27.2, [['A-1', 27.45], ['A-2', 27.45], ["A'-1", 26.95], ["A'-2", 26.95],
                            ["B'-1", 24.0],
                            ['C-1', 27.5], ['C-2', 27.5], ["C'-1", 26.9], ["C'-2", 26.9]]);
  const res = run(b, spares([27.2, 27.2]));
  const b4 = res.swaps[1], b6 = res.swaps[2];
  const hasRack  = b4.acts.some(a => a.type === 'exchange');
  const hasSpare = b4.sparesUsed >= 1;
  check('budget-4 passes relay', b4.Ino_mA < THR);
  check('budget-4 is a MIXED plan (in-rack exchange + spare together)', hasRack && hasSpare);
  check('budget-6 reaches I_no ≈ 0', b6.Ino_mA < 1.0);
  assertConsistent('mixed', res);
}

// Case 3 — big bank must not do WORSE than a small one (beam sanity). A single
// weak cap with a good spare → 1 spare swap zeros it, at every budget.
console.log('\nCase 3 — one weak cap + good spare → passes at all budgets');
{
  const res = run(bank(12, 27.2, [['B-4', 23.5]]), spares([27.2]));
  res.swaps.forEach(sw => check(`budget ${sw.swapCount} passes relay`, sw.Ino_mA < THR));
  assertConsistent('bigbank', res);
}

// Case 4 — a rack-only fix that already passes must NOT be "upgraded" to burn
// spares for an equal (within 1e-9) I_no. Symmetric A/A' pair, spares available.
console.log('\nCase 4 — symmetric pair solvable in-rack; spares not wasted on equal I_no');
{
  const res = run(bank(10, 27.2, [['A-1', 27.45], ["A'-1", 26.95]]), spares([27.2, 27.2]));
  const b2 = res.swaps[0];   // budget 2
  check('budget-2 passes relay', b2.Ino_mA < THR);
  assertConsistent('symmetric', res);
}

// Case 5 — balance metric is WITHIN each wye (A=B=C on Y1, A'=B'=C' on Y2), NOT
// cross-wye. Two wyes each internally balanced but DIFFERENT from each other must
// read as balanced (spread.ok = true) — because I_no = 0 there.
console.log('\nCase 5 — balance is within-wye: wyes may differ, still balanced');
{
  const mk = (o, v, n) => Array.from({ length: n }, (_, i) => ({ id: `${o}-${i + 1}`, val: v, origin: o }));
  const y1 = [...mk('A', 27.2, 10), ...mk('B', 27.2, 10), ...mk('C', 27.2, 10)];
  const y2 = [...mk("A'", 27.0, 10), ...mk("B'", 27.0, 10), ...mk("C'", 27.0, 10)];   // wye offset
  const m = calcYY(y1, y2, KV), s = spreadOf(m);
  check('each wye internally balanced → I_no ≈ 0', m.Ino_mA < 1e-6);
  check('spread.y1 ≈ 0 (A=B=C)', s.y1 < 1e-9);
  check('spread.y2 ≈ 0 (A\'=B\'=C\')', s.y2 < 1e-9);
  check('spread.max = within-wye (≈0), NOT the cross-wye .all', Math.abs(s.max) < 1e-9);
  check('spread.ok = true even though the two wyes differ', s.ok === true);
  check('.all still exposed (cross-wye, display only) and > 0', s.all > 0.01);
}

// Case 6 — the balance metric compares the per-phase SERIES C_phase (1/Σ(1/cᵢ)),
// NOT the parallel sum. One cap in Y1/phase A raised to 30 µF among 10 caps: the
// reported within-wye spread must be the SERIES shift (~0.026 µF), NOT the sum
// difference (30−27.2 = 2.8 µF). Tolerance is 0.005 µF so this still FAILS balance.
console.log('\nCase 6 — balance compares the per-phase SERIES C_phase (not sum)');
{
  const mk = (o, v, n) => Array.from({ length: n }, (_, i) => ({ id: `${o}-${i + 1}`, val: v, origin: o }));
  const y1 = [...mk('A', 27.2, 10), ...mk('B', 27.2, 10), ...mk('C', 27.2, 10)];
  y1[0].val = 30.0;   // one cap on A up to 30 µF
  const y2 = [...mk("A'", 27.2, 10), ...mk("B'", 27.2, 10), ...mk("C'", 27.2, 10)];
  const seriesA = 1 / (9 / 27.2 + 1 / 30.0);            // ≈ 2.7456
  const expected = seriesA - 2.72;                       // ≈ 0.0256 (series shift)
  const s = spreadOf(calcYY(y1, y2, KV));
  check('Y1 spread = the SERIES shift (~0.026), not the sum diff 2.8', Math.abs(s.y1 - expected) < 1e-6);
  check('spread.max is on the series scale (< 0.1, far from 2.8)', s.max < 0.1);
  check('tolerance 0.005 µF → this spread FAILS balance', s.ok === false);
}

// Case 7 — MAX-effort budget uses the full resources (more swaps + spares) on a
// scattered-outlier bank the beam alone gets stuck on. 5 caps/phase, 11 outliers,
// 5 good spares. The largest budget must beat the mid budget AND deploy ≥1 spare.
console.log('\nCase 7 — MAX-effort budget uses spares + more swaps (scattered bank)');
{
  const mk = (o, arr) => arr.map((v, i) => ({ id: `${o}-${i + 1}`, val: v, origin: o }));
  const y1 = [...mk('A', [27, 29, 26, 27, 27]), ...mk('B', [27, 29, 28, 27, 27]), ...mk('C', [27, 27, 27, 21, 27])];
  const y2 = [...mk("A'", [27, 27, 27, 27, 27]), ...mk("B'", [27, 27, 26, 29, 21]), ...mk("C'", [27, 29, 25, 26, 27])];
  const res = optimize(y1, y2, spares([27, 27, 27, 27, 27]), null, KV, [], [], 27.0, null, THR);
  const mid = res.swaps[1], max = res.swaps[res.swaps.length - 1];
  check('MAX budget reaches a much lower I_no than the mid budget', max.Ino_mA < mid.Ino_mA - 20);
  check('MAX budget deploys at least one spare', max.sparesUsed >= 1);
  check('MAX budget passes the relay (< THR)', max.Ino_mA < THR);
  assertConsistent('scattered', res);
}

console.log('');
if (failures) {
  console.error(`✗ ${failures} assertion(s) FAILED — swap optimizer has regressed.`);
  process.exit(1);
}
console.log('✓ All swap optimizer tests passed.');
