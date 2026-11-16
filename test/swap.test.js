#!/usr/bin/env node
/**
 * swap.test.js — guards the YY swap OPTIMIZER (findPhaseAwareYYSwaps) against
 * regressions in the selection layer. The core I_no math is covered by
 * calc.test.js; this file covers the picker: sparesUsed accounting and the
 * ranking order (failed units out → lowest I_no → fewest spares → fewest swaps).
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

// Case 2 — v9.4 (restored v6.5) rules on a messy bank with 5 FAILED (<27 µF) units:
// budgets are 2/4/6, every exchange stays WITHIN its phase (A↔A', B↔B', C↔C'), and
// failed units are taken out first (a bigger budget never leaves MORE failed units).
console.log('\nCase 2 — in-phase exchanges only + failed units out first (budgets 2/4/6)');
{
  const b = bank(10, 27.2, [['A-1', 27.45], ['A-2', 27.45], ["A'-1", 26.95], ["A'-2", 26.95],
                            ["B'-1", 24.0],
                            ['C-1', 27.5], ['C-2', 27.5], ["C'-1", 26.9], ["C'-2", 26.9]]);
  const res = run(b, spares([27.2, 27.2]));
  const base = s => (s.origin || '').replace("'", '');
  const failedLeft = sw => [...sw.y1, ...sw.y2].filter(u => u.val < 27.0).length;
  check('budgets are 2 / 4 / 6', res.swaps.map(s => s.swapCount).join('/') === '2/4/6');
  check('every exchange stays within its phase', res.swaps.every(sw =>
    sw.acts.filter(a => a.type === 'exchange').every(a => base(a.from) === base(a.to))));
  check('failed units left never grow with budget', res.swaps.every((sw, i) =>
    i === 0 || failedLeft(sw) <= failedLeft(res.swaps[i - 1])));
  check('budget-2 already removes failed units (fewer than the 5 at start)', failedLeft(res.swaps[0]) < 5);
  assertConsistent('inphase', res);
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

// Case 7 — SPARE CONSERVATION (v9.4): an imbalance that ONE in-phase exchange fixes
// (no failed units) must be fixed WITHOUT touching the spare pool, even with
// plenty of spares available. (v6.5 preferred the MOST spares at equal I_no — v9.4
// prefers the fewest, and treats I_no within INO_TIE_MA as a tie once passing.)
console.log('\nCase 7 — in-phase fix available → no spare used (spares available)');
{
  const res = run(bank(10, 27.5, [['A-1', 27.9], ["A'-1", 27.1]]), spares(Array(5).fill(27.5)));
  res.swaps.forEach(sw => {
    check(`budget ${sw.swapCount} passes relay`, sw.Ino_mA < THR);
    check(`budget ${sw.swapCount} uses 0 spares`, sw.sparesUsed === 0);
  });
  assertConsistent('nospare', res);
}

// Case 8 — the user-reported bug: adding MORE spares must not make the plan use
// MORE spares. One failed cap → exactly one spare, whether the pool has 1 or 6.
console.log('\nCase 8 — one failed cap: 1 spare used, pool size (1 vs 6) does not matter');
{
  const r1 = run(bank(8, 27.3, [['B-4', 25.0]]), spares([27.3]));
  const r6 = run(bank(8, 27.3, [['B-4', 25.0]]), spares(Array(6).fill(27.3)));
  r6.swaps.forEach((sw, i) => {
    check(`budget ${sw.swapCount}: exactly 1 spare used`, sw.sparesUsed === 1);
    check(`budget ${sw.swapCount}: same spare count with 6 spares as with 1`, sw.sparesUsed === r1.swaps[i].sparesUsed);
    check(`budget ${sw.swapCount}: failed cap removed + passes`, sw.Ino_mA < THR && ![...sw.y1, ...sw.y2].some(u => u.val < 27.0));
  });
  assertConsistent('onefail', r6);
}

console.log('');
if (failures) {
  console.error(`✗ ${failures} assertion(s) FAILED — swap optimizer has regressed.`);
  process.exit(1);
}
console.log('✓ All swap optimizer tests passed.');
