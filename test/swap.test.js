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

const ctx = { window: {}, console, Math, Object, Array, Set, JSON, isFinite, parseFloat, alert() {}, Promise };
vm.createContext(ctx);
// findPhaseAwareYYSwaps is a top-level function (not on window) — export it explicitly.
vm.runInContext(src + '\n;window.__opt = findPhaseAwareYYSwaps; window.__spread = phaseSpreadOf;', ctx);
const optimize = ctx.window.__opt;
const calcYY   = ctx.window._calcYYMetrics;
const spreadOf = ctx.window.__spread;
const unitVoltageStats = ctx.window.unitVoltageStats;
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
function realSpareActions(sw) { return sw.acts.filter(a => SPARE.has(a.type) && /^S-/.test(a.to.id) && !a.to.pulledPiece).length; }

console.log('EGAT C-Bank — swap optimizer regression tests\n');

// --- Invariant across all cases: every returned plan is internally consistent ---
function assertConsistent(tag, res) {
  res.swaps.forEach(sw => {
    check(`${tag} b${sw.swapCount}: reported Ino matches recomputed`, Math.abs(sw.Ino_mA - reIno(sw)) < 1e-6);
    check(`${tag} b${sw.swapCount}: sparesUsed == real spare actions`, sw.sparesUsed === realSpareActions(sw));
  });
}

// Case 1 — sparesUsed must NOT count piece-swap (bug 1). Scissored bank, no spare:
// the only repair is a piece-swap (สับชิ้นกันเอง) which consumes NO spare. The off
// pieces are INSIDE the IEC band (v9.7: a failed piece is never moved, only replaced).
console.log('Case 1 — scissored bank, piece-swap only (sparesUsed must be 0)');
{
  const mk = (origins) => { const a = []; for (const o of origins) for (let i = 0; i < 5; i++)
    a.push({ id: `${o}-${i + 1}`, origin: o, pos: i, measuredA: 27.2, measuredB: 27.2, val: 54.4, isSplit: true }); return a; };
  const y1 = mk(['A', 'B', 'C']), y2 = mk(["A'", "B'", "C'"]);
  const setPiece = (id, pc, v) => { const t = y1.find(x => x.id === id) || y2.find(x => x.id === id);
    if (pc === 'a') t.measuredA = v; else t.measuredB = v; t.val = t.measuredA + t.measuredB; };
  setPiece('A-2', 'a', 26.2); setPiece("A'-3", 'b', 28.2);   // symmetric in-tolerance off pieces → one piece-swap fixes
  const res = optimize(y1, y2, [], null, KV, [], [], 27.0, null, THR);
  const b6 = res.swaps[res.swaps.length - 1];
  check('reaches relay pass with a piece-swap', b6.Ino_mA < THR);
  check('sparesUsed === 0 (piece-swap uses no spare)', b6.sparesUsed === 0);
  assertConsistent('scissors', res);
}

// Case 2 — exchange rules on a messy bank: budgets are 2/4/6 (default depth); since
// v9.8 any two positions may be exchanged (A↔A', A↔B, A↔B'), but each physical unit
// is moved at most ONCE per plan (no detours), and failed units are taken out first
// (a bigger budget never leaves MORE failed units).
console.log('\nCase 2 — exchange rules (each unit moved once) + failed units out first');
{
  const b = bank(10, 27.2, [['A-1', 27.45], ['A-2', 27.45], ["A'-1", 26.95], ["A'-2", 26.95],
                            ["B'-1", 24.0],
                            ['C-1', 27.5], ['C-2', 27.5], ["C'-1", 26.9], ["C'-2", 26.9]]);
  const res = run(b, spares([27.2, 27.2]));
  const base = s => (s.origin || '').replace("'", '');
  const failedLeft = sw => [...sw.y1, ...sw.y2].filter(u => u.val < 25.65 || u.val > 29.7).length;   // IEC band 27 µF −5%/+10%
  check('budgets are 2 / 4 / 6', res.swaps.map(s => s.swapCount).join('/') === '2/4/6');
  check('no physical unit is moved more than once in any plan', res.swaps.every(sw => {
    const ids = sw.acts.filter(a => a.type === 'exchange').flatMap(a => [a.from.id, a.to.id]);
    return new Set(ids).size === ids.length;
  }));
  void base;
  check('failed units left never grow with budget', res.swaps.every((sw, i) =>
    i === 0 || failedLeft(sw) <= failedLeft(res.swaps[i - 1])));
  check("budget-2 already removes the failed unit (B'-1 = 24.0 is outside -5%)", failedLeft(res.swaps[0]) === 0);
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

// ── v9.5 cases ──────────────────────────────────────────────────────────────
const outTol = v => v < 25.65 || v > 29.7;   // 27 µF, IEC 60871-1 −5 % … +10 %

// Case 9 — failed is TWO-SIDED: a unit reading too HIGH (shorted elements) is failed
// too, and is taken out with a good spare.
console.log('\nCase 9 — two-sided tolerance: a HIGH unit (30.2 > 29.7 µF) is failed');
{
  const res = run(bank(8, 27.3, [['C-3', 30.2]]), spares([27.3, 27.3]));
  res.swaps.forEach(sw => {
    check(`budget ${sw.swapCount}: high unit removed`, ![...sw.y1, ...sw.y2].some(u => outTol(u.val)));
    check(`budget ${sw.swapCount}: passes`, sw.Ino_mA < THR);
  });
  assertConsistent('highfail', res);
}

// Case 10 — a failed unit is NEVER put back in service: 2 failed units, but only one
// GOOD spare (the other spare is itself out of tolerance). One failed unit must stay
// (flagged), the bad spare must never be installed, and no removed unit is reused.
console.log('\nCase 10 — failed spares / removed units are never reinstalled');
{
  const res = run(bank(8, 27.3, [['A-2', 24.0], ["B'-5", 24.5]]), spares([27.3, 24.8]));
  res.swaps.forEach(sw => {
    const installedBad = sw.acts.filter(a => SPARE.has(a.type) && a.to && outTol(a.to.val));
    check(`budget ${sw.swapCount}: no failed unit installed`, installedBad.length === 0);
    check(`budget ${sw.swapCount}: exactly 1 failed left (only 1 good spare)`,
      [...sw.y1, ...sw.y2].filter(u => outTol(u.val)).length === 1);
  });
  check('minBelow reported = 1', res.minBelow === 1);
  assertConsistent('noreuse', res);
}

// Case 11 — I_no reference plans: each reaches I_no < ref with the fewest failed
// left; a TIGHTER ref never needs FEWER swaps than a looser one.
console.log('\nCase 11 — reference plans: below ref, failed-out, tighter ref ≥ swaps');
{
  const res = run(bank(10, 27.2, [['A-1', 27.45], ['A-2', 27.45], ["A'-1", 26.95], ["A'-2", 26.95],
                                  ["B'-1", 24.0], ['C-1', 27.5], ["C'-1", 26.9]]),
                  spares([27.2, 27.2, 27.2]));
  const refs = [5, 10, 20, 30, 40, 50];
  const plans = refs.map(r => res.refPlans[r]);
  check('ref 50 is reachable', !!res.refPlans[50]);
  plans.forEach((p, i) => { if (p) {
    check(`ref ${refs[i]}: I_no ${p.Ino_mA.toFixed(2)} < ${refs[i]}`, p.Ino_mA < refs[i]);
    check(`ref ${refs[i]}: failed units out`, ![...p.y1, ...p.y2].some(u => outTol(u.val)));
    check(`ref ${refs[i]}: sparesUsed consistent`, p.sparesUsed === realSpareActions(p));
  }});
  for (let i = 0; i + 1 < refs.length; i++) {
    const a = plans[i], b = plans[i + 1];          // a = tighter, b = looser
    if (a && b) check(`ref ${refs[i]} needs ≥ swaps than ref ${refs[i + 1]}`, a.actualSwaps >= b.actualSwaps);
    if (a) check(`ref ${refs[i]} reachable ⇒ ref ${refs[i + 1]} reachable`, !!b);
  }
}

// Case 12 — a HIDDEN (equalizing / mirrored) weak pair. A1 and A'1 both at 26.0 µF
// (still inside −5 %): the two wyes cancel, so I_no = 0. v9.7 balance-first sees that
// each wye is unbalanced (A low on both sides) and fixes it even WITHOUT a rated
// voltage; with rated 6.2 kV the 110 % gate (6.91 kV = 111.5 %) also demands it.
console.log('\nCase 12 — mirrored weak pair: balance-first + 110 % gate both catch it');
{
  const vs = unitVoltageStats(bank(10, 27.2, [['A-1', 25.0]]).y1, [], KV, null);
  check('voltage share of a 25.0 µF unit among 27.2 µF = 107.85 %', Math.abs(vs.maxPctShare - 107.85) < 0.01);
  const b = () => bank(10, 27.2, [['A-1', 26.0], ["A'-1", 26.0]]);
  check('before: I_no ≈ 0 (mirrored) but each wye unbalanced',
    calcYY(b().y1, b().y2, KV).Ino_mA < 1e-6 && spreadOf(calcYY(b().y1, b().y2, KV)).max > 0.005);
  const noRated = optimize(b().y1, b().y2, spares([27.2, 27.2]), null, KV, [], [], 27.0, null, THR);
  const nr = noRated.swaps[0], nrSp = spreadOf(calcYY(nr.y1, nr.y2, KV));
  check(`without rated voltage: budget 2 balances each wye (ΔC ${nrSp.max.toFixed(4)} ≤ 0.005)`, nrSp.max <= 0.005);
  const rated = optimize(b().y1, b().y2, spares([27.2, 27.2]), null, KV, [], [],
                         { uf: 27.0, ratedKV: 6.2 }, null, THR);
  rated.swaps.forEach(sw => {
    const st = unitVoltageStats(sw.y1, sw.y2, KV, 6.2);
    check(`with rated 6.2 kV, budget ${sw.swapCount}: no unit > 110 % (max ${st.maxPctRated.toFixed(1)} %)`, st.ovCount === 0);
  });
  check('with rated 6.2 kV: the weak pair is replaced (2 spares)', rated.swaps[0].sparesUsed === 2);
}

// Case 13 — F5 (v9.6): an imbalance BETWEEN PHASES OF ONE WYE (A' high, B' low, Y1
// perfect). In-phase swaps can only MIRROR it (A↔A' + B↔B': I_no = 0 but BOTH wyes
// end up unbalanced, ΔC 0.031 µF each, 2 swaps). A same-side swap A'↔B' truly balances
// Y2 in ONE swap with no spare (I_no ≈ 12 mA). The least-work plan for ref 50 must be
// that 1-swap same-side plan. (Budget cards still rank lowest I_no → they may show
// the mirror — documented trade-off.)
console.log('\nCase 13 — same-side cross-phase swap balances a wye without a spare');
{
  const res = run(bank(8, 27.0, [["A'-1", 28.0], ["A'-2", 28.0], ["B'-1", 26.0], ["B'-2", 26.0]]), []);
  const side = u => (u.origin || '').includes("'") ? 2 : 1;
  const base = u => (u.origin || '').replace("'", '');
  const lw = res.refBest[50];
  check('budget-2 passes the relay with no spares', res.swaps[0].Ino_mA < THR && res.swaps[0].sparesUsed === 0);
  check('least-work plan for ref 50: 1 swap, 0 spares', !!lw && lw.actualSwaps === 1 && lw.sparesUsed === 0);
  check("…and it is a same-side cross-phase exchange (A'↔B')",
    !!lw && lw.acts.some(a => a.type === 'exchange' && side(a.from) === side(a.to) && base(a.from) !== base(a.to)));
  const sp = spreadOf(calcYY(lw.y1, lw.y2, KV));
  check(`…which really balances Y2 (ΔC ${sp.y2.toFixed(4)} ≤ 0.005 µF)`, sp.y2 <= 0.005 && sp.y1 <= 0.005);
  assertConsistent('sameside', res);
}

// Case 14 — the field bank that exposed F1/F2 (69 kV): 5 failed units in B (21–25 µF)
// + an over-capacitive A' (29,28,26,29,28), 10 good spares. It needs ~8 swaps:
//  • F2: 6 swaps can't pass → the search must extend (quickResult.extended).
//  • F1: when nothing passes, the lower-I_no plan must win over the "lower level"
//        one (v9.5 picked L0 at 306.9 mA over L1 at ~188 mA for budget 6).
//  • the deepest budget passes with every failed unit out.
async function case14() {
  console.log('\nCase 14 — field bank: adaptive depth (F2) + no-pass ranking (F1)');
  const cc = vm.runInContext('clientCalculate', ctx);
  const mk = (o, arr) => arr.map((v, i) => ({ id: `${o}-${i + 1}`, val: v, origin: o, pos: i }));
  const n27 = () => Array(10).fill(27);
  const r = await cc({ topology: 'yy-unground', systemKV: 69, alarmMA: 50,
    y1: [...mk('A', n27()), ...mk('B', [27, 27, 24, 23, 22, 21, 25, 26, 28, 27.5]), ...mk('C', n27())],
    y2: [...mk("A'", [27, 29, 28, 26, 27, 29, 28, 27, 27, 27]), ...mk("B'", n27()), ...mk("C'", n27())],
    spare: spares(Array(10).fill(27)) });
  const q = r.quickResult, sw = q.swaps, last = sw[sw.length - 1];
  check('search extended beyond 6 swaps', q.extended === true && q.maxDepth > 6);
  check('budget 6 picks the lower-I_no plan (< 306.9 mA)', sw[2].Ino_mA < 306);
  check(`deepest budget passes (I_no ${last.Ino_mA.toFixed(2)} < 50)`, last.underThreshold);
  check('deepest budget has every failed unit out', ![...last.y1Full, ...last.y2Full].some(u => u.origin !== 'Spare' && outTol(u.val)));
  check('ref < 50 mA is reachable in the comparison table', !!q.refTable.find(x => x.ref === 50 && x.plan));
}

// Cases 15–16 — field bank #2 (69 kV): phase C on BOTH wyes damaged
//   C  = 23,24,25,26,28,29,27,25,26,27   C' = 22,21,19,17,26,27,28,29,27,27
// 8 failed units (outside 25.65–29.70). v9.6 with 5 spares left C'-2 = 21 µF in
// (125.8 % voltage share) and passed only by MIRRORING (ΔC 0.06 per wye).
async function case1516() {
  const cc = vm.runInContext('clientCalculate', ctx);
  const mk = (o, arr) => arr.map((v, i) => ({ id: `${o}-${i + 1}`, val: v, origin: o, pos: i }));
  const n27 = () => Array(10).fill(27);
  const run2 = nSp => cc({ topology: 'yy-unground', systemKV: 69, alarmMA: 50,
    y1: [...mk('A', n27()), ...mk('B', n27()), ...mk('C', [23, 24, 25, 26, 28, 29, 27, 25, 26, 27])],
    y2: [...mk("A'", n27()), ...mk("B'", n27()), ...mk("C'", [22, 21, 19, 17, 26, 27, 28, 29, 27, 27])],
    spare: spares(Array(nSp).fill(27)) });
  const failedVals = p => [...p.y1Full, ...p.y2Full].filter(u => u.origin !== 'Spare' && outTol(u.val)).map(u => u.val).sort((a, b) => a - b);
  const movedFailed = p => p.acts.some(a => (a.type === 'exchange' && (outTol(a.from.val) || outTol(a.to.val))) ||
                                            (a.type === 'piece-swap' && (outTol(a.v1) || outTol(a.v2))));

  console.log('\nCase 15 — too few spares (5 for 8 failed): replace the WORST, never move a failed unit (G1)');
  {
    const q = (await run2(5)).quickResult;
    // v10.3: I_no AND ΣC must both pass for a "real" row; with 3 failed units pinned the
    // ΣC target can't be met, so the ref-50 row is the closest (fallback) plan.
    const row50 = q.refTable.find(x => x.ref === 50 && x.plan), rec = row50.plan;
    check('ref-50 row is flagged as not meeting ΣC (fallback)', row50.fallback === true);
    check(`only the least-severe failed units stay (got ${failedVals(rec).join(', ')})`, failedVals(rec).join(',') === '24,25,25');
    check('no failed unit is moved by an exchange (any budget / ref plan)',
      ![...q.swaps, ...q.refTable.filter(x => x.plan).map(x => x.plan)].some(movedFailed));
    check(`worst unit voltage share < 115 % (got ${rec.unitV.maxPctShare.toFixed(1)} %)`, rec.unitV.maxPctShare < 115);
    check('passes I_no ref 50', rec.Ino_mA < 50);
  }

  console.log('\nCase 16 — enough spares (8): balance-first gives A=B=C on each wye, all failed out');
  {
    const q = (await run2(8)).quickResult;
    const rec = q.refBest.find(x => x.ref === 50 && x.plan).plan;
    check('every failed unit replaced', failedVals(rec).length === 0);
    check(`each wye balanced (ΔC series Y1 ${rec.serSpread.y1.toFixed(4)} / Y2 ${rec.serSpread.y2.toFixed(4)} ≤ 0.005)`, rec.serSpread.max <= 0.005);
    check(`ΣC per phase within 0.5 µF on each side (got ${rec.spread.y1.toFixed(2)} / ${rec.spread.y2.toFixed(2)})`, rec.spread.max <= 0.5 + 1e-9);
    check('passes I_no ref 50', rec.Ino_mA < 50);
  }
}

// Cases 17–19 (v9.8)
async function case171819() {
  const cc = vm.runInContext('clientCalculate', ctx);
  const mk = (o, arr) => arr.map((v, i) => ({ id: `${o}-${i + 1}`, val: v, origin: o, pos: i }));
  const n27 = () => Array(10).fill(27);
  const bank3 = nSp => cc({ topology: 'yy-unground', systemKV: 69, alarmMA: 50,
    y1: [...mk('A', n27()), ...mk('B', n27()), ...mk('C', [29, 28, 27, 22, 21, 19, 25, 26, 24, 25])],
    y2: [...mk("A'", n27()), ...mk("B'", [26, 22, 21, 27, 25, 29, 28, 26, 25, 24]), ...mk("C'", n27())],
    spare: spares(Array(nSp).fill(27)) });
  const onceOnly = p => { const ids = p.acts.filter(a => a.type === 'exchange').flatMap(a => [a.from.id, a.to.id]); return new Set(ids).size === ids.length; };

  // Case 17 — field bank #3: 11 failed units, only 4 good spares → nothing can pass.
  // The recommendation must be ONLY "replace the 4 worst" + "need 7 more spares";
  // in-rack shuffling now would be wasted (the bank is re-arranged when spares come).
  console.log('\nCase 17 — too few spares to pass: recommend only the worst replacements (#4)');
  {
    const q = (await bank3(4)).quickResult, so = q.sparesOnly;
    check('a spares-only plan is produced', !!so);
    check('it is 4 spare replacements and nothing else', so && so.actualSwaps === 4 && so.acts.every(a => a.type !== 'exchange'));
    const out = so ? so.acts.map(a => a.from.val).sort((a, b) => a - b).join(',') : '';
    check(`it removes the WORST failed units (got ${out})`, out === '19,21,21,22');
    check('reports 7 more good spares needed', q.sparesShort === 7);
  }

  // Case 18 — move-once: no plan ever moves the same physical unit twice (the v9.7
  // plan for bank #3 moved C-2 three times and B-1 twice through A/A').
  console.log('\nCase 18 — move-once: no unit moved twice (bank #3 and the other field banks)');
  {
    const q4 = (await bank3(4)).quickResult, q11 = (await bank3(11)).quickResult;
    const plans = [...q4.swaps, ...q11.swaps, ...[q4, q11].flatMap(q => q.refTable.filter(x => x.plan).map(x => x.plan))];
    check(`every plan moves each unit at most once (${plans.length} plans)`, plans.every(onceOnly));
    const p11 = q11.refTable.find(x => x.ref === 50 && x.plan);
    check('with 11 spares the bank passes ref 50 and every failed unit is out', !!p11 && p11.plan._fail === 0);
  }

  // Case 19 — direct cross-side cross-phase swap (v9.8): C (Y1) has one 28, B' (Y2)
  // has one 26. ONE swap C-28 ↔ B'-27 balances both wyes (C all 27; B' gets 28+26).
  // Without cross-side moves it takes 2 (C↔C', then C'↔B').
  console.log("\nCase 19 — a direct C↔B' swap when that's the real fix");
  {
    const res = run(bank(10, 27.0, [['C-1', 28.0], ["B'-1", 26.0]]), []);
    const lw = res.refBest[50];
    const side = u => (u.origin || '').includes("'") ? 2 : 1, base = u => (u.origin || '').replace("'", '');
    check('least-work plan for ref 50 is ONE swap', !!lw && lw.actualSwaps === 1);
    check("…a cross-side cross-phase exchange (C↔B')", !!lw && lw.acts.some(a => a.type === 'exchange' && side(a.from) !== side(a.to) && base(a.from) !== base(a.to)));
    const sp = lw ? spreadOf(calcYY(lw.y1, lw.y2, KV)) : { max: 1 };
    check(`…that balances both wyes (ΔC ${sp.max.toFixed(4)} ≤ 0.005)`, sp.max <= 0.005);
  }
}

// Case 20 (v9.9) — spare SHORTAGE → temporary plan. Field bank #4 (115 kV): C has 9
// failed units (19–25 µF), B' has 5 (16–21 µF); only 4 good spares. With failed units
// pinned, C can never reach A/B (ΔC 0.27 µF, I_no > 2 A). Temp mode replaces the 4 WORST
// and moves the remaining failed units (each once) so A=B=C on each side.
async function case20() {
  console.log('\nCase 20 — spare shortage: temporary plan moves failed units to balance each side');
  const cc = vm.runInContext('clientCalculate', ctx);
  const mk = (o, arr) => arr.map((v, i) => ({ id: `${o}-${i + 1}`, val: v, origin: o, pos: i }));
  const n27 = () => Array(10).fill(27);
  const run4 = nSp => cc({ topology: 'yy-unground', systemKV: 115, alarmMA: 50,
    y1: [...mk('A', n27()), ...mk('B', n27()), ...mk('C', [22, 19, 21, 23, 25, 26, 25, 24, 25, 25])],
    y2: [...mk("A'", n27()), ...mk("B'", [21, 19, 18, 16, 17, 28, 27, 29, 29, 28]), ...mk("C'", n27())],
    spare: spares(Array(nSp).fill(27)) });
  const q = (await run4(4)).quickResult, tp = q.tempPlan;
  check('a temporary plan is produced', !!tp && tp.tempMove === true);
  check(`it passes I_no 50 (got ${tp ? tp.Ino_mA.toFixed(2) : '-'} mA)`, !!tp && tp.Ino_mA < 50);
  check(`each side nearly balanced (ΣC ${tp ? tp.spread.y1.toFixed(2) + '/' + tp.spread.y2.toFixed(2) : '-'} ≤ 1.0 µF; series ${tp ? tp.serSpread.max.toFixed(4) : '-'} ≤ 0.012)`, !!tp && tp.spread.max <= 1.0 + 1e-9 && tp.serSpread.max <= 0.012);
  const out = tp ? tp.acts.filter(a => SPARE.has(a.type)).map(a => a.from.val).sort((a, b) => a - b) : [];
  check(`all 4 spares replace the worst units (got ${out.join(', ')})`, out.length === 4 && out.slice(0, 3).join(',') === '16,17,18');
  const ids = tp ? tp.acts.filter(a => a.type === 'exchange').flatMap(a => [a.from.id, a.to.id]) : [];
  check('each unit moved at most once', new Set(ids).size === ids.length);
  check('reports 10 more good spares needed', q.sparesShort === 10);
  const q14 = (await run4(14)).quickResult;
  check('with enough spares (14) there is NO temporary plan', !q14.tempPlan);
}

// Case 21 (v10.0) — real field bank SNO-CAY5 (115 kV, 11/phase): Y1 single units, Y2
// parallel pairs (A' all measured separately, B'-10/C'-10 scissored, rest grouped
// ~54 µF), 3 spares. Guards bug A (grouped 54 µF slots are NOT failed), bug B (each
// scissored piece position changes at most once) and the balance-first spare mode.
async function case21() {
  console.log('\nCase 21 — field bank SNO-CAY5: grouped slots, piece move-once, balance-first');
  const cc = vm.runInContext('clientCalculate', ctx);
  const spec = ctx.window.capSpecOf(27);
  const oot = ctx.window.unitOutOfTolerance;
  check('grouped 2×27 slot reading 54.9 µF is NOT failed (bug A)', !oot({ val: 54.9, isLocked: true }, spec));
  check('grouped slot reading 49.0 µF (24.5 per unit) IS failed', oot({ val: 49.0, isLocked: true }, spec));
  const Y1 = { A: [27.5, 26.7, 27.6, 26.7, 27.5, 26.1, 27.4, 24.1, 27.5, 27.5, 27.4], B: [26.7, 27.5, 26.8, 27.6, 27.4, 27.7, 27.5, 27.1, 27.7, 27.4, 27.5], C: [27.2, 26.7, 27.6, 27.5, 27.4, 27.2, 27.5, 27.5, 27.1, 27.1, 27.7] };
  const Ap = [[27.6, 24.5], [26.7, 23.6], [24.3, 27.5], [26.7, 22.4], [24.3, 27.3], [26.6, 27.4], [23.4, 27.4], [25, 24.3], [27.5, 24.5], [27.4, 21.2], [27.1, 27.5]];
  const Bp = [55.1, 54.3, 54.2, 55.1, 54.8, 54.9, 54.9, 54.9, 54.4, [26.5, 27.5], 54.5], Cp = [55.2, 55, 55, 54.9, 54, 54.9, 54.9, 53.4, 54.3, [27.3, 27.4], 54.9];
  const y1 = []; for (const p of 'ABC') Y1[p].forEach((v, i) => y1.push({ id: `${p}-${i + 1}`, val: v, origin: p, pos: i }));
  const y2 = []; const add = (o, arr) => arr.forEach((v, i) => y2.push(Array.isArray(v)
    ? { id: `${o}-${i + 1}`, val: v[0] + v[1], origin: o, pos: i, isLocked: false, isSplit: true, measuredA: v[0], measuredB: v[1] }
    : { id: `${o}-${i + 1}`, val: v, origin: o, pos: i, isLocked: true }));
  add("A'", Ap); add("B'", Bp); add("C'", Cp);
  const q = (await cc({ topology: 'yy-unground', systemKV: 115, alarmMA: 50, y1, y2, balSumUF: 0.1, sparePriority: 'balance',
    spare: spares([27.3, 27.4, 27.5]) })).quickResult;
  check(`failed count = 10 slots, not 30 (got ${q.failedTotal})`, q.failedTotal === 10);
  const plans = [q.tempPlan, ...q.swaps, ...q.refTable.filter(x => x.plan).map(x => x.plan)].filter(Boolean);
  const pieceOnce = p => { const k = []; p.acts.forEach(a => {
    if (a.type === 'piece-swap') k.push(a.u1.id + '.' + a.p1, a.u2.id + '.' + a.p2);
    if (a.type === 'piece-replace') k.push(a.from.id + '.' + a.piece); }); return new Set(k).size === k.length; };
  check(`every plan changes each piece position at most once (${plans.length} plans, bug B)`, plans.every(pieceOnce));
  const tp = q.tempPlan;
  check(`balance-first temp plan passes I_no 50 (got ${tp ? tp.Ino_mA.toFixed(1) : '-'} mA)`, !!tp && tp.Ino_mA < 50);
  check(`…ΣC per phase within each side (${tp ? tp.spread.y1.toFixed(2) + '/' + tp.spread.y2.toFixed(2) : '-'} µF) — series ${tp ? tp.serSpread.y1.toFixed(4) + '/' + tp.serSpread.y2.toFixed(4) : '-'}`,
    !!tp && tp.spread.max <= 1.0 + 1e-9);
  check(`…in ≤ 12 swaps (got ${tp ? tp.actualSwaps : '-'})`, !!tp && tp.actualSwaps <= 12);
}

// Case 22 (v10.3) — field bank SNO-CAY3 (115 kV, 11/phase, 3 spares, B-5 = 25.2 failed):
// I_no and the per-phase ΣC balance (≤ 0.1 µF, field sheet) carry EQUAL weight via
// score = max(I_no/ref, ΔΣC/0.1). The field did 4 moves → 8.9 mA but ΣC 0.2/0.6.
async function case22() {
  console.log('\nCase 22 — SNO-CAY3: equal weight I_no / ΣC per phase (score = max(I_no/ref, ΔΣC/tol))');
  const cc = vm.runInContext('clientCalculate', ctx);
  const Y1 = { A: [26.2,27.5,26.5,27.7,27,27.5,27.6,27.1,27.6,27.5,27.6], B: [27.6,27.4,26.8,27.7,25.2,26.6,27.6,27.6,27.5,26.7,27.4], C: [27.6,27.1,26.7,27.7,27.8,26.7,27.5,27.0,27.6,26.8,26.9] };
  const Ap = [54.3,55.4,55.5,54.8,54.1,[26.2,26.7],55.2,55.2,53.8,53.4,[27.7,27.1]];
  const Bp = [54.3,53.7,54.4,55.2,54.3,53.7,55.3,55.1,54.0,54.4,[27.5,26.1]];
  const Cp = [55.2,54.3,55.5,55.6,53.6,55.3,53.8,54.4,54.2,54.7,[26.3,26.7]];
  const y1 = []; for (const p of 'ABC') Y1[p].forEach((v, i) => y1.push({ id: `${p}-${i + 1}`, val: v, origin: p, pos: i }));
  const y2 = []; const add = (o, arr) => arr.forEach((v, i) => y2.push(Array.isArray(v)
    ? { id: `${o}-${i + 1}`, val: v[0] + v[1], origin: o, pos: i, isLocked: false, isSplit: true, measuredA: v[0], measuredB: v[1] }
    : { id: `${o}-${i + 1}`, val: v, origin: o, pos: i, isLocked: true }));
  add("A'", Ap); add("B'", Bp); add("C'", Cp);
  const q = (await cc({ topology: 'yy-unground', systemKV: 115, alarmMA: 50, y1, y2, balSumUF: 0.1, sparePriority: 'failed',
    spare: spares([27.1, 26.4, 27.1]) })).quickResult;
  const rec = (q.refBest.find(x => x.ref === 50) || {}).plan;
  check(`default plan passes BOTH (I_no ${rec ? rec.Ino_mA.toFixed(1) : '-'} < 50, ΔΣC ${rec ? rec.spread.y1.toFixed(2) + '/' + rec.spread.y2.toFixed(2) : '-'} ≤ 0.1)`,
    !!rec && rec.Ino_mA < 50 && rec.spread.max <= 0.1 + 1e-9);
  check(`…with the failed B-5 out (failed left ${rec ? rec._fail : '-'}) in ≤ 7 swaps (got ${rec ? rec.actualSwaps : '-'})`, !!rec && rec._fail === 0 && rec.actualSwaps <= 7);
  const rows = q.refTable.filter(r => r.plan);
  check('every comparison-table row meets BOTH targets (no fallback)', rows.length === 6 && rows.every(r => !r.fallback));
  check('rows are a real gradient: tighter ref ⇒ I_no below it and swaps ≥ the looser row',
    rows.every(r => r.plan.Ino_mA < r.ref) && rows.every((r, i) => i === 0 || r.plan.actualSwaps <= rows[i - 1].plan.actualSwaps));
  // v10.4 (fix 4): only entered spares (S-n) count — re-installing a pulled-out good part is a move
  const plans = [...q.swaps, ...rows.map(r => r.plan)];
  check(`no plan claims more spares than the 3 entered (max ${Math.max(...plans.map(p => p.sparesUsed || 0))})`,
    plans.every(p => (p.sparesUsed || 0) <= 3));
}

// Case 23 (v10.4, fix 8) — the optimizer scores candidates with fastEval(), a fast copy of
// the calcYYMetrics formula. In the app, level L0 always LOCKS the good units, so check the
// locked-unit path too: every plan's I_no must equal calcYYMetrics on the full arrangement.
function case23() {
  console.log('\nCase 23 — fastEval == calcYYMetrics with LOCKED units on both wyes');
  const b = bank(10, 27.0, [['A-1', 25.0], ['B-2', 28.5], ["C'-3", 25.4], ["A'-4", 28.9], ['C-5', 26.1]]);
  const isLock = u => /-(6|7|8|9|10)$/.test(u.id);            // half of every phase locked
  const s1 = b.y1.filter(u => !isLock(u)), l1 = b.y1.filter(isLock);
  const s2 = b.y2.filter(u => !isLock(u)), l2 = b.y2.filter(isLock);
  l1[0].val = 26.3; l2[2].val = 27.9;                           // locked units off-nominal too
  const res = optimize(s1, s2, spares([27.0, 27.4]), null, KV, l1, l2, 27.0, null, THR);
  const plans = [...res.swaps, ...Object.values(res.refPlans).filter(Boolean)];
  const worst = Math.max(...plans.map(sw => Math.abs(sw.Ino_mA - calcYY([...sw.y1, ...l1], [...sw.y2, ...l2], KV).Ino_mA)));
  check(`every plan's I_no matches calcYYMetrics incl. locked units (max diff ${worst.toExponential(1)} mA)`, worst < 1e-6);
}

// Case 24 (v10.4, fixes 1–2) — H-bridge. The CT on the H-link reads
// ω·Vph·|C_A·C_D − C_B·C_C| / ΣC: zero only when C_A/C_C = C_B/C_D. Swap plans must keep
// every unit in the bank (before v10.4 an exchanged unit vanished on reassembly).
async function case24() {
  console.log('\nCase 24 — H-bridge: bridge-current formula + plans keep every unit');
  const hb = ctx.window._calcHBridgeMetrics, u = v => [{ val: v }];
  const bal = hb(u(30), u(30), u(27), u(27), 115).In_mA;      // A/C = B/D → balanced
  const unb = hb(u(30), u(27), u(27), u(30), 115).In_mA;      // same branch totals, crossed
  const want = 2 * Math.PI * 50 * (115000 / Math.sqrt(3)) * Math.abs(30 * 30 - 27 * 27) * 1e-6 / 114 * 1000;
  check(`balanced bridge (A/C = B/D) reads 0 mA (got ${bal.toFixed(3)})`, bal < 1e-9);
  check(`crossed bridge A30 B27 C27 D30 reads ${want.toFixed(0)} mA, not 0 (got ${unb.toFixed(0)})`, Math.abs(unb - want) < 1e-6);

  const cc = vm.runInContext('clientCalculate', ctx);
  const mk = (o, arr) => arr.map((v, i) => ({ id: `${o}-${i + 1}`, val: v, origin: o, pos: i }));
  const legs = { a: mk('A', [30, 30, 30]), b: mk('B', [27, 27, 27]), c: mk('C', [27, 27, 27]), d: mk('D', [27, 27, 27]) };
  const r = await cc({ topology: 'h-bridge', systemKV: 115, alarmMA: 50, legs, y1: [...legs.a, ...legs.c], y2: [...legs.b, ...legs.d],
    spare: spares([27]) });
  const plans = [...r.quickResult.swaps, r.fullResult];
  const count = (p, L) => [...p.y1Full, ...p.y2Full].filter(x => (x.origin || '')[0] === L).length;
  check('every plan still has 3 units in each leg A/B/C/D', plans.every(p => ['A', 'B', 'C', 'D'].every(L => count(p, L) === 3)));
  const best = r.quickResult.swaps[2];
  const re = hb(...['A', 'B', 'C', 'D'].map(L => [...best.y1Full, ...best.y2Full].filter(x => x.origin[0] === L)), 115).In_mA;
  check(`reported I_bridge matches the reassembled legs (${best.Ino_mA.toFixed(2)} vs ${re.toFixed(2)} mA)`, Math.abs(best.Ino_mA - re) < 1e-6);
  check(`with 1 spare the bridge is brought below 50 mA (got ${best.Ino_mA.toFixed(2)})`, best.Ino_mA < 50);
}

(async () => {
  case23();
  await case24();
  await case14();
  await case1516();
  await case171819();
  await case20();
  await case21();
  await case22();
  console.log('');
  if (failures) {
    console.error(`✗ ${failures} assertion(s) FAILED — swap optimizer has regressed.`);
    process.exit(1);
  }
  console.log('✓ All swap optimizer tests passed.');
})();

