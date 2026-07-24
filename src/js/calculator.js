// ═══════════════════════════════════════
// CALCULATOR (server-side logic, now client-side)
// ═══════════════════════════════════════
/**
 * lib/calculator.js v4 — EGAT C-Bank Optimizer
 * Engineering formulas: C → B → Xc → I_no / I_bridge → Q
 */
'use strict';

const PI2F = 2 * Math.PI * 50; // ω = 2πf, f=50Hz

// CT relay-alarm threshold (mA). Single source of truth — UI, formulas and the
// swap optimizer all read this so the "pass/fail" line is consistent everywhere.
const ALARM_MA = 50.0;
if (typeof window !== 'undefined') window.ALARM_MA = ALARM_MA;

// Capacitor nameplate (µF). A unit reading BELOW this is treated as FAILED in the
// field and is swapped FIRST; units at/above nameplate are "good" and kept in
// place (only swapped if the failed units alone can't bring I_no under ALARM_MA).
// Display-only + swap-priority — it NEVER changes the I_no calculation.
const NAMEPLATE_UF = 27.00;
if (typeof window !== 'undefined') window.NAMEPLATE_UF = NAMEPLATE_UF;

// Max allowed spread (µF) of the per-phase PARALLEL SUM capacitance (Σ Cᵢ per phase)
// WITHIN one wye side (A vs B vs C on Y1, A' vs B' vs C' on Y2). The BALANCE GOAL is
// A=B=C on Y1 AND A'=B'=C' on Y2 — each wye internally balanced (the two wyes need NOT
// match each other; that is not required for I_no=0). `phaseSpreadOf().max` = the worse
// of the two within-wye spreads and must be ≤ this tolerance. An ADDITIONAL acceptance
// goal beyond the I_no alarm; display + swap-priority only — it NEVER changes the I_no
// calculation. (YY topology only.)
// SCALE NOTE: this compares the DIRECT SUM of each phase's caps (the number the field
// engineer reads), so its magnitude grows with the caps/phase count — a 10-cap phase
// sums to ≈ 272 µF. The engineer set the goal as "phases within 0.1 µF of each other"
// (total per-phase µF), so this is a FIXED absolute tolerance on the sum, independent
// of the old series-scale 0.005 value. It does NOT track the user's alarmMA.
const PHASE_SPREAD_UF = 0.1;
if (typeof window !== 'undefined') window.PHASE_SPREAD_UF = PHASE_SPREAD_UF;

// PHYSICAL RACK LAYOUT (left → right): A A' B B' C C'. The technician's effort to
// swap two caps grows with how far apart they sit — so the optimizer prefers the
// NEAREST swap first (e.g. a failed A' is fixed from A or B before C'), and uses a
// SPARE only as the last resort. `rackDist` = |position difference| between two
// phase origins; a spare costs SWAP_SPARE_COST (>> the max rack distance of 5).
const RACK_ORDER = { A: 0, "A'": 1, B: 2, "B'": 3, C: 4, "C'": 5 };
const SWAP_SPARE_COST = 100;
function rackDist(originP, originQ) {
  const a = RACK_ORDER[originP], b = RACK_ORDER[originQ];
  return (a == null || b == null) ? 0 : Math.abs(a - b);
}
// Action types that actually CONSUME a spare (used for sparesUsed accounting +
// cost). `exchange` (in-rack) and `piece-swap` (scissored piece↔piece) use no spare.
const SPARE_ACTION_TYPES = new Set(['replace-y1', 'replace-y2', 'piece-replace']);

// Effort cost of one swap action: rack distance for an in-rack exchange, or the
// heavy SWAP_SPARE_COST for anything that consumes a spare (spare = last resort).
function swapActionCost(a) {
  if (a.type === 'exchange') return a.dist != null ? a.dist : rackDist(a.from && a.from.origin, a.to && a.to.origin);
  if (a.type === 'piece-swap') return rackDist(a.u1 && a.u1.origin, a.u2 && a.u2.origin);
  return SWAP_SPARE_COST;   // replace-y1 / replace-y2 / piece-replace all use a spare
}

function sumC(arr) { return arr.reduce((t, c) => t + c.val, 0); }

// Phase spread from a calcYYMetrics() result: the max−min of the per-phase PARALLEL
// SUM capacitances (perPhase.X.sum1 = Y1, .sum2 = Y2 — Σ Cᵢ of the phase, the direct
// sum the field engineer reads, NOT the series value). The BALANCE GOAL is WITHIN each
// wye — A=B=C on Y1 AND A'=B'=C' on Y2 — NOT that all six phases match across wyes. So
// `.max` = max(y1 spread, y2 spread) (the worse-balanced side) and `.ok` = that ≤ tol.
// This matches the physics: I_no = 0 needs only within-wye balance (the two wyes may
// differ). `.y1`/`.y2` are the per-side spreads; `.all` (spread across all six phases)
// is kept for display only and does NOT gate anything. NOTE: this SUM scale is used for
// the balance comparison ONLY — I_no still uses the series phaseC (never sum).
function phaseSpreadOf(metrics, tol) {
  const t = (typeof tol === 'number' && tol > 0) ? tol : PHASE_SPREAD_UF;
  const p = metrics && metrics.perPhase;
  if (!p) return { y1: NaN, y2: NaN, all: NaN, max: NaN, ok: false, tol: t };
  const sp = a => Math.max.apply(null, a) - Math.min.apply(null, a);
  const s1  = sp([p.A.sum1, p.B.sum1, p.C.sum1]);                              // within Y1: A=B=C
  const s2  = sp([p.A.sum2, p.B.sum2, p.C.sum2]);                              // within Y2: A'=B'=C'
  const all = sp([p.A.sum1, p.B.sum1, p.C.sum1, p.A.sum2, p.B.sum2, p.C.sum2]); // all six (display only)
  const within = Math.max(s1, s2);                                            // balance = worse-balanced wye
  return { y1: s1, y2: s2, all: all, max: within, ok: within <= t + 1e-9, tol: t };
}

/** Engineering metrics for YY topology — per-phase unbalance, CT between N1-N2 */
function calcYYMetrics(y1, y2, systemKV) {
  // ═══════════════════════════════════════════════════════════════
  // EXACT method from EGAT Excel (Double_wye_unground RS-CAY21):
  // Complex-phasor neutral-current calculation, NOT per-phase magnitude.
  //
  //  Susceptance per phase (siemens), wye-1 = S1,S2,S3 ; wye-2 = S4,S5,S6
  //    S = 2π·f·C(µF)/1e6
  //  Phase angles: A=0°, B=−120°, C=+120°
  //  Vs in kV, so Vph = Vs/√3 (kV).
  //
  //  Neutral displacement voltage (complex), shared floating neutral:
  //    Vnx = (1/ΣS)·Vph·[cos(0)(S1+S4)+cos(−120)(S2+S5)+cos(120)(S3+S6)]
  //    Vny = (1/ΣS)·Vph·[sin(0)(S1+S4)+sin(−120)(S2+S5)+sin(120)(S3+S6)]
  //    Vno = √(Vnx²+Vny²)·1000   [V]
  //
  //  CT neutral current = current of wye-1 (S1+S2+S3) minus displacement:
  //    Inx = Vph·[S1cos0 + S2cos(−120) + S3cos120] − (S1+S2+S3)·Vnx
  //    Iny = Vph·[S1sin0 + S2sin(−120) + S3sin120] − (S1+S2+S3)·Vny
  //    Ino = √(Inx²+Iny²)·1e6    [mA]
  //
  //  Reactive power: Qa=(Vph)²(S1+S4), Qb=…(S2+S5), Qc=…(S3+S6); Qt=Qa+Qb+Qc
  // ═══════════════════════════════════════════════════════════════
  const Vs_kV = systemKV;                       // kV
  const Vph   = Vs_kV / Math.sqrt(3);           // kV (matches Excel BA16/√3)
  const VphV  = (systemKV * 1000) / Math.sqrt(3); // V — for any legacy display use

  // Capacitance per phase per wye (µF). origin A/B/C = wye-1, A'/B'/C' = wye-2.
  // PHYSICAL MODEL: within each phase the capacitor units are in SERIES, so the
  // effective phase capacitance = 1 / Σ(1/Cᵢ)  — matching the EGAT Excel
  // "C-Bank Arrangement" sheet (Cphase = 1/(ΣBC)). This is NOT a parallel sum.
  function phaseC(arr, origins) {
    let invSum = 0, n = 0;
    arr.forEach(item => {
      const o = (item.origin || '').replace("'", '');
      if (origins.some(org => org.replace("'", '') === o || item.origin === org)) {
        if (item.val > 0) { invSum += 1 / item.val; n++; }
      }
    });
    return invSum > 0 ? 1 / invSum : 0;   // series combination
  }
  const CA1 = phaseC(y1, ['A']),  CB1 = phaseC(y1, ['B']),  CC1 = phaseC(y1, ['C']);
  const CA2 = phaseC(y2, ["A'"]), CB2 = phaseC(y2, ["B'"]), CC2 = phaseC(y2, ["C'"]);

  // Per-phase PARALLEL SUM (µF) = Σ Cᵢ of that phase's units — used ONLY by the
  // phase-BALANCE comparison (phaseSpreadOf), which the field engineer wants on the
  // direct-sum scale, not the series scale. This is display + swap-priority only and
  // NEVER feeds the I_no calculation (I_no uses the series phaseC above — do NOT mix).
  function phaseSum(arr, origins) {
    let s = 0;
    arr.forEach(item => {
      const o = (item.origin || '').replace("'", '');
      if (origins.some(org => org.replace("'", '') === o || item.origin === org)) {
        if (item.val > 0) s += item.val;
      }
    });
    return s;
  }
  const PA1 = phaseSum(y1, ['A']),  PB1 = phaseSum(y1, ['B']),  PC1 = phaseSum(y1, ['C']);
  const PA2 = phaseSum(y2, ["A'"]), PB2 = phaseSum(y2, ["B'"]), PC2 = phaseSum(y2, ["C'"]);

  // Susceptances (siemens). PI2F = 2π·f is declared in this same script block.
  const toS = c => PI2F * c / 1e6;
  const S1 = toS(CA1), S2 = toS(CB1), S3 = toS(CC1);   // wye-1 A,B,C
  const S4 = toS(CA2), S5 = toS(CB2), S6 = toS(CC2);   // wye-2 A,B,C
  const sumS = S1 + S2 + S3 + S4 + S5 + S6;

  const c0 = Math.cos(0), cm = Math.cos(-2*Math.PI/3), cp = Math.cos(2*Math.PI/3);
  const s0 = Math.sin(0), sm = Math.sin(-2*Math.PI/3), sp = Math.sin(2*Math.PI/3);

  // Neutral displacement voltage (complex), kV
  let Vnx = 0, Vny = 0;
  if (sumS > 0) {
    Vnx = (1/sumS) * Vph * (c0*(S1+S4) + cm*(S2+S5) + cp*(S3+S6));
    Vny = (1/sumS) * Vph * (s0*(S1+S4) + sm*(S2+S5) + sp*(S3+S6));
  }
  const Vno = Math.sqrt(Vnx*Vnx + Vny*Vny) * 1000;     // V

  // CT neutral current of wye-1 (complex), then magnitude → mA
  const sumS123 = S1 + S2 + S3;
  const Inx = Vph*((S1*c0)+(S2*cm)+(S3*cp)) - sumS123*Vnx;
  const Iny = Vph*((S1*s0)+(S2*sm)+(S3*sp)) - sumS123*Vny;
  const Ino_mA = Math.sqrt(Inx*Inx + Iny*Iny) * 1e6;   // mA

  // Reactive power (Mvar)
  const Qa = Math.pow(Vph, 2) * (S1 + S4);
  const Qb = Math.pow(Vph, 2) * (S2 + S5);
  const Qc = Math.pow(Vph, 2) * (S3 + S6);
  const Qt = Qa + Qb + Qc;

  // Totals for display
  const C1_uF = sumC(y1), C2_uF = sumC(y2);
  const B1 = toS(C1_uF), B2 = toS(C2_uF);

  // Per-phase detail. C1/C2 = SERIES capacitance (drives I_no, display "อนุกรม").
  // sum1/sum2 = PARALLEL SUM per phase (drives the phase-BALANCE comparison only).
  const perPhase = {
    A: { S1: S1, S2: S4, C1: CA1, C2: CA2, sum1: PA1, sum2: PA2 },
    B: { S1: S2, S2: S5, C1: CB1, C2: CB2, sum1: PB1, sum2: PB2 },
    C: { S1: S3, S2: S6, C1: CC1, C2: CC2, sum1: PC1, sum2: PC2 },
  };

  return {
    C1_uF, C2_uF, B1, B2, Vph: VphV, Vno, Ino_mA, Qt,
    Vnx, Vny, Inx, Iny, sumS, S: { S1,S2,S3,S4,S5,S6 }, perPhase
  };
}

/** Engineering metrics for H-Bridge topology */
function calcHBridgeMetrics(legA, legB, legC, legD, systemKV) {
  const Vph  = (systemKV * 1000) / Math.sqrt(3);
  // Left branch = A (top) + C (bottom), Right = B + D
  const CA_top = sumC(legA) * 1e-6;
  const CA_bot = sumC(legC) * 1e-6;
  const CB_top = sumC(legB) * 1e-6;
  const CB_bot = sumC(legD) * 1e-6;
  const Xc_left_top  = CA_top > 0 ? 1 / (PI2F * CA_top) : 1e9;
  const Xc_left_bot  = CA_bot > 0 ? 1 / (PI2F * CA_bot) : 1e9;
  const Xc_right_top = CB_top > 0 ? 1 / (PI2F * CB_top) : 1e9;
  const Xc_right_bot = CB_bot > 0 ? 1 / (PI2F * CB_bot) : 1e9;
  const xa1 = Xc_left_top  + Xc_left_bot;
  const xa2 = Xc_right_top + Xc_right_bot;
  const Iup   = xa1 > 0 ? Vph / xa1 : 0;
  const Idown = xa2 > 0 ? Vph / xa2 : 0;
  const Iun   = Iup - Idown;
  const In_mA = Math.abs(Iun) * 1000;
  // Vx = voltage at bridge midpoint (left branch)
  const Vx = xa1 > 0 ? Vph * (Xc_left_bot / xa1) : 0;
  const Bt = PI2F * (CA_top + CA_bot + CB_top + CB_bot);
  const Qt = (Vph * Vph * Bt) / 1e6;
  const S_total = Bt;
  return { CA_top_uF: sumC(legA), CA_bot_uF: sumC(legC), CB_top_uF: sumC(legB), CB_bot_uF: sumC(legD), xa1, xa2, Iup, Idown, Iun, In_mA, Vx, Qt, S_total };
}

function describeSwap(action) {
  const { type, from, to } = action;
  if (type === 'exchange') {
    const d = action.dist != null ? action.dist : rackDist(from.origin, to.origin);
    const near = d <= 1 ? ' — ใกล้' : (d >= 4 ? ' — ไกล' : '');
    return `สลับ [${from.origin}] ↔ [${to.origin}] (ระยะ ${d}${near}): [${from.id}] ${from.val.toFixed(3)} ↔ [${to.id}] ${to.val.toFixed(3)} µF`;
  }
  if (type === 'replace-y1') return `ถอด [${from.id}] (${from.val.toFixed(3)} µF) จาก Y1 → แทนด้วย [${to.id}] (${to.val.toFixed(3)} µF)`;
  if (type === 'replace-y2') return `ถอด [${from.id}] (${from.val.toFixed(3)} µF) จาก Y2 → แทนด้วย [${to.id}] (${to.val.toFixed(3)} µF)`;
  if (type === 'piece-replace') return `แทนชิ้น [${from.id}.${action.piece}] (${action.oldVal.toFixed(3)} µF) ด้วยอะไหล่ (${to.val.toFixed(3)} µF) → คู่เป็น ${action.newPairVal.toFixed(3)} µF`;
  if (type === 'piece-swap')    return `สลับชิ้น [${action.u1.id}.${action.p1}] (${action.v1.toFixed(3)}) ↔ [${action.u2.id}.${action.p2}] (${action.v2.toFixed(3)} µF)`;
  return '';
}

function applySwaps(y1, y2, spare, ops) {
  let cY1 = y1.slice(), cY2 = y2.slice(), cS = spare.slice();
  for (const op of ops) {
    if (op.type === 'exchange')   { const t = cY1[op.i]; cY1[op.i] = cY2[op.j]; cY2[op.j] = t; }
    else if (op.type === 'replace-y1') { const t = cY1[op.i]; cY1[op.i] = cS[op.k]; cS[op.k] = t; }
    else if (op.type === 'replace-y2') { const t = cY2[op.j]; cY2[op.j] = cS[op.k]; cS[op.k] = t; }
  }
  return { y1: cY1, y2: cY2, spare: cS };
}

function allSingleSwaps(y1, y2, spare, baseline) {
  // baseline = { y1: sum of locked items in Y1, y2: sum of locked items in Y2 }
  //          AND optional: { y1ByPhase: {A:.., B:.., C:..}, y2ByPhase: {...} }
  //          for per-phase Ino-aware diff
  const off1 = (baseline && baseline.y1) || 0;
  const off2 = (baseline && baseline.y2) || 0;
  const y1Ph = (baseline && baseline.y1ByPhase) || null;
  const y2Ph = (baseline && baseline.y2ByPhase) || null;

  // If per-phase baseline exists, use Ino-aware scoring
  // Otherwise fall back to simple |sum1 - sum2|
  function scoreState(curY1, curY2) {
    if (!y1Ph || !y2Ph) {
      return Math.abs((sumC(curY1) + off1) - (sumC(curY2) + off2));
    }
    // Sum each phase's swappable contribution + baseline
    const phases = ['A','B','C'];
    let totalIno = 0;
    for (const ph of phases) {
      const phPrime = ph + "'";
      let s1 = (y1Ph[ph]||0), s2 = (y2Ph[ph]||0);
      curY1.forEach(x => { if (x.origin === ph) s1 += x.val; });
      curY2.forEach(x => { if (x.origin === phPrime) s2 += x.val; });
      totalIno += Math.abs(s1 - s2);
    }
    return totalIno;
  }

  const n = y1.length, results = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < y2.length; j++) {
      // Simulate exchange
      const t1 = y1[i], t2 = y2[j];
      const nY1 = y1.slice(); nY1[i] = t2;
      const nY2 = y2.slice(); nY2[j] = t1;
      const d = scoreState(nY1, nY2);
      const touchesOutlier = !!(t1.isOutlier || t2.isOutlier);
      results.push({ diff: d, touchesOutlier, ops: [{ type:'exchange', i, j }], action: { type:'exchange', from:t1, to:t2 } });
    }
    for (let k = 0; k < spare.length; k++) {
      const t1 = y1[i], ts = spare[k];
      const nY1 = y1.slice(); nY1[i] = ts;
      const d = scoreState(nY1, y2);
      results.push({ diff: d, touchesOutlier: !!t1.isOutlier, ops:[{type:'replace-y1',i,k}], action:{type:'replace-y1',from:t1,to:ts} });
    }
  }
  for (let j = 0; j < y2.length; j++) {
    for (let k = 0; k < spare.length; k++) {
      const t2 = y2[j], ts = spare[k];
      const nY2 = y2.slice(); nY2[j] = ts;
      const d = scoreState(y1, nY2);
      results.push({ diff: d, touchesOutlier: !!t2.isOutlier, ops:[{type:'replace-y2',j,k}], action:{type:'replace-y2',from:t2,to:ts} });
    }
  }
  // Sort: primary = lowest resulting imbalance; tiebreaker = prefer swaps that
  // move a flagged outlier (Rule 2 prioritization). Tolerance avoids reordering
  // genuinely better swaps just because they don't touch an outlier.
  results.sort((a, b) => {
    if (Math.abs(a.diff - b.diff) > 1e-6) return a.diff - b.diff;
    if (a.touchesOutlier !== b.touchesOutlier) return a.touchesOutlier ? -1 : 1;
    return 0;
  });
  return results;
}

// ═══════════════════════════════════════════════════════
// PHASE-AWARE YY SWAP (fixes Ino mismatch + "Ino unchanged" bugs)
// Unbalance is corrected WITHIN each phase: A(Y1)↔A'(Y2), B↔B', C↔C'.
// A capacitor never leaves its phase, so its origin tag stays valid and
// calcYYMetrics computes per-phase Ino correctly. The optimizer minimizes
// each phase's |B_y1 - B_y2| (i.e. that phase's Ino), summed across phases.
// ═══════════════════════════════════════════════════════
function phaseOf(item, isY2) {
  // Normalize origin to plain phase letter (strip prime). Spare has no phase.
  if (!item || item.origin === 'Spare') return null;
  return (item.origin || '').replace("'", '');
}

function findPhaseAwareYYSwaps(y1Swap, y2Swap, spare, lockedBaseline, systemKV, lockedY1Arr, lockedY2Arr, nameplate, swapMode, thresholdMA) {
  // expand() generates EVERY in-rack exchange (any of the 6 phases ↔ any other) plus
  // spare replacements. The swap-priority order is NOT gated here — it is expressed
  // as a `cost` per candidate (rack distance for exchanges, SWAP_SPARE_COST for a
  // spare), so the optimizer naturally prefers the NEAREST rack swap and leaves the
  // spare for last. The 6 rack slots, left → right, with their origin tag + position:
  const RACK_SLOTS = [
    { side: 1, ph: 'A', tag: 'A',  pos: 0 },
    { side: 2, ph: 'A', tag: "A'", pos: 1 },
    { side: 1, ph: 'B', tag: 'B',  pos: 2 },
    { side: 2, ph: 'B', tag: "B'", pos: 3 },
    { side: 1, ph: 'C', tag: 'C',  pos: 4 },
    { side: 2, ph: 'C', tag: "C'", pos: 5 },
  ];
  // Relay threshold (mA). PRIMARY objective = minimize the WITHIN-wye parallel-SUM
  // spread (A=B=C on Y1, A'=B'=C' on Y2), but a relay-PASSING arrangement (I_no < THR)
  // always beats a failing one — "balance เป็นหลัก + I_no ต้องผ่านรีเลย์ด้วย". Infinity = no gate.
  const THR = (typeof thresholdMA === 'number' && thresholdMA > 0) ? thresholdMA : Infinity;
  // Two complementary searches, scored by the ACTUAL phasor Ino (calcYYMetrics):
  //
  //  TRACK 1 — BEAM SEARCH: keeps the best `BEAM` partial solutions at every depth,
  //  so it can move *through* a temporarily-worse state. Finds the exact 2-swap
  //  optimum for small banks and good incremental (exchange/spare) improvements.
  //
  //  TRACK 2 — OUTLIER-FIX: some banks need a COORDINATED set of spare swaps where
  //  EVERY intermediate step makes Ino *worse* before it collapses to ~0 (e.g. 3
  //  phases each with one off unit — fixing one at a time raises Ino, only fixing
  //  all three balances the bank). Beam prunes those rising paths, so this track
  //  greedily replaces the worst per-phase outlier with the closest spare,
  //  ACCEPTING temporary Ino rises, recording the state after each swap.
  //
  //  All visited states from BOTH tracks become candidates; for each budget
  //  (2/4/6 swaps) we pick the lowest real Ino, fewest swaps, then most spares
  //  used (so spares are preferred when they reach the same Ino — the field tech
  //  wants the spare pool deployed). lockedY1Arr/lockedY2Arr are always included
  //  in every Ino evaluation but never moved; swaps stay WITHIN a phase or pull
  //  from Spare, so a capacitor never leaves its phase.
  const PHASES = ['A', 'B', 'C'];
  const targets = [2, 4, 6];
  const kv = systemKV || 69;
  const lockY1 = lockedY1Arr || [];
  const lockY2 = lockedY2Arr || [];
  const MAXDEPTH = 6;
  // Nameplate-failure awareness (optional). When set, the search treats units
  // reading below `nameplate` as FAILED and prioritizes getting them OUT.
  const NP = (typeof nameplate === 'number' && nameplate > 0) ? nameplate : null;
  function isBelow(u) {
    if (!NP || !u || u.origin === 'Spare') return false;
    if (u.measuredA != null && u.measuredB != null) return u.measuredA < NP || u.measuredB < NP;
    return u.val < NP;
  }

  function bucket(arr) {
    const m = { A: [], B: [], C: [] };
    arr.forEach(x => { const p = phaseOf(x); if (m[p]) m[p].push(x); });
    return m;
  }
  const y1ByPhase = bucket(y1Swap);
  const y2ByPhase = bucket(y2Swap);
  const sparePool = (spare || []).slice();

  // Adaptive search width. When the candidate space is small we keep ALL depth-1
  // states so the 2-swap optimum is found EXACTLY (the budget the field worker
  // uses most); otherwise we cap to keep one calculation well under a second.
  // Exchanges now span ALL SIX phases (any rack slot ↔ any other), so the single-
  // swap count is ~ every unit-pair + spare replacements.
  const totY1 = y1ByPhase.A.length + y1ByPhase.B.length + y1ByPhase.C.length;
  const totY2 = y2ByPhase.A.length + y2ByPhase.B.length + y2ByPhase.C.length;
  const totAll = totY1 + totY2;
  const nSingles = totAll * (totAll - 1) / 2 + totAll * sparePool.length;
  const small = nSingles <= 200;
  // Cap search width on very large banks (e.g. 14 caps/phase) so a single run stays
  // snappy on a phone. Equal-valued swaps are pruned in expand(), so real banks
  // (mostly identical caps + a few outliers) explore far fewer than nSingles.
  const huge = nSingles > 1200;
  const KEEP1 = small ? Math.max(nSingles, 1) : (huge ? 30 : 60);
  const BEAM  = small ? 40 : (huge ? 12 : 24);

  // One calcYYMetrics call yields BOTH the phasor I_no (relay metric) and the
  // WITHIN-wye PARALLEL-SUM spread (the primary balance metric = max of the Y1 A/B/C
  // sum spread and the Y2 A'/B'/C' sum spread). PRIMARY objective = minimize that
  // within-wye spread (balance A=B=C on Y1 and A'=B'=C' on Y2); I_no is the relay
  // constraint. Same cost as computing I_no alone — spread is derived from the same
  // result. (Balance uses parallel sum; I_no uses the series phaseC — never mixed.)
  function metricsOf(cY1, cY2) {
    const fullY1 = [...cY1.A, ...cY1.B, ...cY1.C, ...lockY1];
    const fullY2 = [...cY2.A, ...cY2.B, ...cY2.C, ...lockY2];
    const m = calcYYMetrics(fullY1, fullY2, kv);
    return { ino: m.Ino_mA, spread: phaseSpreadOf(m).max };
  }
  const baseM = metricsOf(y1ByPhase, y2ByPhase);
  const baseIno = baseM.ino;

  // Every visited state (from either track) is pushed here as a candidate.
  const candidates = [];
  function record(y1obj, y2obj, spareArr, actions, ino, spread) {
    // Count ONLY actions that actually consume a spare. `piece-swap` (สับชิ้นกันเอง
    // between two scissored slots) and `exchange` (in-rack) use NO spare, so they
    // must not inflate sparesUsed (which drives the "🔁 ใช้ spare" note + tiebreaker).
    const spUsed = actions.reduce((n, a) => n + (SPARE_ACTION_TYPES.has(a.type) ? 1 : 0), 0);
    // Effort cost: near rack swaps are cheap, far ones dearer, a spare is last resort.
    const cost = actions.reduce((s, a) => s + swapActionCost(a), 0);
    const y1 = [...y1obj.A, ...y1obj.B, ...y1obj.C];
    const y2 = [...y2obj.A, ...y2obj.B, ...y2obj.C];
    const below = NP ? (y1.filter(isBelow).length + y2.filter(isBelow).length) : 0;
    candidates.push({
      ino, spread, cost, swaps: actions.length, sp: spUsed, below,
      y1, y2, spare: spareArr.slice(),
      acts: actions.slice(),   // raw actions — UI pairs each swap to its units
      steps: actions.length ? actions.map(describeSwap) : ['ไม่มีการสับเปลี่ยนที่ปรับสมดุลเฟสได้']
    });
  }
  record(y1ByPhase, y2ByPhase, sparePool, [], baseM.ino, baseM.spread);

  function sig(st) {
    const f = a => a.map(u => u.val.toFixed(4)).join(',');
    return f(st.y1.A) + '|' + f(st.y1.B) + '|' + f(st.y1.C) + '#' +
           f(st.y2.A) + '|' + f(st.y2.B) + '|' + f(st.y2.C) + '@' +
           st.spare.map(u => u.val.toFixed(4)).sort().join(',');
  }
  function clone(st) {
    return {
      y1: { A: st.y1.A.slice(), B: st.y1.B.slice(), C: st.y1.C.slice() },
      y2: { A: st.y2.A.slice(), B: st.y2.B.slice(), C: st.y2.C.slice() },
      spare: st.spare.slice(), actions: st.actions.slice(), ino: st.ino, spread: st.spread
    };
  }
  // A scissored slot is a measured-separately parallel PAIR (2 cap pieces).
  const isScis = u => u && u.measuredA != null && u.measuredB != null;
  const pieceUnit = (u, na, nb) => Object.assign({}, u, { measuredA: na, measuredB: nb, val: na + nb });

  // Children of a state. NON-scissored swappable units move as WHOLE units
  // (in-phase exchange + spare replacement). Scissored slots (parallel pairs) are
  // never swapped whole — instead their individual cap PIECES are rearranged:
  // a piece can be exchanged with another scissored slot's piece ("สับกันเอง"),
  // or replaced by a spare cap ("สลับจาก spare"). Grouped/locked units never move.
  function expand(st) {
    const kids = [];
    // ── In-rack EXCHANGES: ANY of the 6 phases ↔ any other (same-side OR cross-side) ──
    // Each pair carries its rack distance so nearer swaps are preferred (via cost).
    // A moved unit takes the phase tag of its new rack position.
    for (let s1 = 0; s1 < RACK_SLOTS.length; s1++) {
      const S1 = RACK_SLOTS[s1];
      const a1 = (S1.side === 1 ? st.y1 : st.y2)[S1.ph];
      for (let i = 0; i < a1.length; i++) {
        if (isScis(a1[i])) continue;
        for (let s2 = s1 + 1; s2 < RACK_SLOTS.length; s2++) {
          const S2 = RACK_SLOTS[s2];
          const dist = S2.pos - S1.pos;
          const a2 = (S2.side === 1 ? st.y1 : st.y2)[S2.ph];
          for (let j = 0; j < a2.length; j++) {
            if (isScis(a2[j])) continue;
            const u1 = a1[i], u2 = a2[j];
            if (u1.val === u2.val) continue;   // equal values → swap is a no-op, skip
            const c = clone(st);
            (S1.side === 1 ? c.y1 : c.y2)[S1.ph][i] = Object.assign({}, u2, { origin: S1.tag });
            (S2.side === 1 ? c.y1 : c.y2)[S2.ph][j] = Object.assign({}, u1, { origin: S2.tag });
            const _m = metricsOf(c.y1, c.y2); c.ino = _m.ino; c.spread = _m.spread;
            c.actions.push({ type: 'exchange', from: u1, to: u2, dist: dist });
            kids.push(c);
          }
        }
      }
    }
    // ── SPARE replacements (unit stays in its own position/phase) — last resort ──
    for (const ph of PHASES) {
      const a1 = st.y1[ph], a2 = st.y2[ph], tag1 = ph, tag2 = ph + "'";
      for (let i = 0; i < a1.length; i++) {
        if (isScis(a1[i])) continue;
        for (let k = 0; k < st.spare.length; k++) {
          const removed = a1[i], sp = st.spare[k];
          if (sp.val === removed.val) continue;   // equal values → no-op, skip
          const c = clone(st);
          c.y1[ph][i] = Object.assign({}, sp, { origin: tag1 });
          c.spare = st.spare.slice();
          c.spare[k] = Object.assign({}, removed, { origin: 'Spare' });
          const _m = metricsOf(c.y1, c.y2); c.ino = _m.ino; c.spread = _m.spread;
          c.actions.push({ type: 'replace-y1', from: removed, to: sp });
          kids.push(c);
        }
      }
      for (let j = 0; j < a2.length; j++) {
        if (isScis(a2[j])) continue;
        for (let k = 0; k < st.spare.length; k++) {
          const removed = a2[j], sp = st.spare[k];
          if (sp.val === removed.val) continue;   // equal values → no-op, skip
          const c = clone(st);
          c.y2[ph][j] = Object.assign({}, sp, { origin: tag2 });
          c.spare = st.spare.slice();
          c.spare[k] = Object.assign({}, removed, { origin: 'Spare' });
          const _m = metricsOf(c.y1, c.y2); c.ino = _m.ino; c.spread = _m.spread;
          c.actions.push({ type: 'replace-y2', from: removed, to: sp });
          kids.push(c);
        }
      }
    }

    // ── PIECE-LEVEL moves for scissored slots (parallel pairs) ──
    const scis = [];
    for (const ph of PHASES) {
      st.y1[ph].forEach((u, i) => { if (isScis(u)) scis.push({ side: 1, ph, i }); });
      st.y2[ph].forEach((u, i) => { if (isScis(u)) scis.push({ side: 2, ph, i }); });
    }
    const arrOf = (state, loc) => (loc.side === 1 ? state.y1 : state.y2)[loc.ph];
    // (a) replace one piece of a scissored slot with a spare cap
    for (const loc of scis) {
      const u = arrOf(st, loc)[loc.i];
      for (const pc of ['a', 'b']) {
        const oldVal = pc === 'a' ? u.measuredA : u.measuredB;
        for (let k = 0; k < st.spare.length; k++) {
          const sp = st.spare[k];
          if (sp.val === oldVal) continue;
          const c = clone(st);
          const nu = pc === 'a' ? pieceUnit(u, sp.val, u.measuredB) : pieceUnit(u, u.measuredA, sp.val);
          (loc.side === 1 ? c.y1 : c.y2)[loc.ph] = arrOf(st, loc).slice();
          arrOf(c, loc)[loc.i] = nu;
          c.spare = st.spare.slice();
          c.spare[k] = Object.assign({}, sp, { val: oldVal, origin: 'Spare' });
          const _m = metricsOf(c.y1, c.y2); c.ino = _m.ino; c.spread = _m.spread;
          c.actions.push({ type: 'piece-replace', from: u, piece: pc, oldVal, to: sp, newPairVal: nu.val });
          kids.push(c);
        }
      }
    }
    // (b) swap a piece between two scissored slots ("สับกันเอง")
    for (let m = 0; m < scis.length; m++) {
      for (let n = m + 1; n < scis.length; n++) {
        const A = scis[m], B = scis[n];
        const uA = arrOf(st, A)[A.i], uB = arrOf(st, B)[B.i];
        for (const pa of ['a', 'b']) for (const pb of ['a', 'b']) {
          const va = pa === 'a' ? uA.measuredA : uA.measuredB;
          const vb = pb === 'a' ? uB.measuredA : uB.measuredB;
          if (va === vb) continue;
          const c = clone(st);
          (A.side === 1 ? c.y1 : c.y2)[A.ph] = arrOf(st, A).slice();
          (B.side === 1 ? c.y1 : c.y2)[B.ph] = arrOf(st, B).slice();
          arrOf(c, A)[A.i] = pa === 'a' ? pieceUnit(uA, vb, uA.measuredB) : pieceUnit(uA, uA.measuredA, vb);
          arrOf(c, B)[B.i] = pb === 'a' ? pieceUnit(uB, va, uB.measuredB) : pieceUnit(uB, uB.measuredA, va);
          const _m = metricsOf(c.y1, c.y2); c.ino = _m.ino; c.spread = _m.spread;
          c.actions.push({ type: 'piece-swap', u1: uA, p1: pa, v1: va, u2: uB, p2: pb, v2: vb });
          kids.push(c);
        }
      }
    }
    return kids;
  }

  // ── TRACK 1: beam search ──
  const init = {
    y1: { A: y1ByPhase.A.slice(), B: y1ByPhase.B.slice(), C: y1ByPhase.C.slice() },
    y2: { A: y2ByPhase.A.slice(), B: y2ByPhase.B.slice(), C: y2ByPhase.C.slice() },
    spare: sparePool.slice(), actions: [], ino: baseIno, spread: baseM.spread
  };
  let beam = [init];
  const seen = new Set([sig(init)]);
  for (let d = 1; d <= MAXDEPTH; d++) {
    let kids = [];
    for (const st of beam) kids = kids.concat(expand(st));
    const uniq = [];
    for (const k of kids) {
      const s = sig(k);
      if (!seen.has(s)) { seen.add(s); uniq.push(k); record(k.y1, k.y2, k.spare, k.actions, k.ino, k.spread); }
    }
    // MULTI-OBJECTIVE frontier: keep the tightest-SPREAD states (primary balance
    // objective) AND the lowest-I_no states (so a relay-passing arrangement is
    // never pruned while chasing balance). The union is expanded next depth.
    const capN = d === 1 ? KEEP1 : BEAM;
    uniq.sort((a, b) => (a.spread - b.spread) || (a.ino - b.ino));
    const frontier = uniq.slice(0, capN);
    const inF = new Set(frontier);
    // Supplement with the lowest-I_no states (~half) so the relay-reducing
    // trajectory (e.g. spare replacements) is never dropped while chasing balance.
    const extra = Math.ceil(capN / 2);
    uniq.sort((a, b) => (a.ino - b.ino) || (a.spread - b.spread));
    let added = 0;
    for (const k of uniq) {
      if (added >= extra) break;
      if (!inF.has(k)) { frontier.push(k); inF.add(k); added++; }
    }
    beam = frontier;
    if (!beam.length) break;
  }

  // ── TRACK 2: outlier-fix (accept temporary Ino rises) ──
  function modeRefByPhase(swapList, lockArr) {
    const m = {};
    PHASES.forEach(p => {
      const vals = [];
      swapList.forEach(u => { if ((u.origin || '').replace("'", '') === p) vals.push(u.val); });
      lockArr.forEach(u => { if ((u.origin || '').replace("'", '') === p) vals.push(u.val); });
      m[p] = vals.length >= 2 ? findModeReference(vals) : null;
    });
    return m;
  }
  (function runOutlierFix() {
    const cy1 = { A: y1ByPhase.A.slice(), B: y1ByPhase.B.slice(), C: y1ByPhase.C.slice() };
    const cy2 = { A: y2ByPhase.A.slice(), B: y2ByPhase.B.slice(), C: y2ByPhase.C.slice() };
    let sp = sparePool.slice();
    const actions = [];
    for (let step = 0; step < MAXDEPTH; step++) {
      if (!sp.length) break;
      const mode1 = modeRefByPhase([...cy1.A, ...cy1.B, ...cy1.C], lockY1);
      const mode2 = modeRefByPhase([...cy2.A, ...cy2.B, ...cy2.C], lockY2);
      // Prefer BELOW-nameplate (failed) units first, then largest mode-deviation.
      let best = null; // { bad, dev, side, ph, idx, mode }
      function consider(side, p, u, idx, mode) {
        if (!mode || isScis(u)) return;   // scissored pairs are fixed at piece level (beam track)
        const dev = Math.abs(u.val - mode) / mode;
        const bad = isBelow(u) ? 1 : 0;
        if (dev < 0.02 && !bad) return;            // ignore good units already at mode
        if (!best || bad > best.bad || (bad === best.bad && dev > best.dev))
          best = { bad, dev, side, ph: p, idx, mode };
      }
      PHASES.forEach(p => {
        cy1[p].forEach((u, idx) => consider(1, p, u, idx, mode1[p]));
        cy2[p].forEach((u, idx) => consider(2, p, u, idx, mode2[p]));
      });
      if (!best) break;
      // pick the spare closest to that phase's mode
      let bk = -1, bd = Infinity;
      sp.forEach((s, k) => { const dd = Math.abs(s.val - best.mode); if (dd < bd) { bd = dd; bk = k; } });
      if (bk < 0) break;
      const arr = best.side === 1 ? cy1[best.ph] : cy2[best.ph];
      const removed = arr[best.idx], spUnit = sp[bk], tag = removed.origin;
      arr[best.idx] = Object.assign({}, spUnit, { origin: tag });
      sp = sp.slice(); sp[bk] = Object.assign({}, removed, { origin: 'Spare' });
      actions.push({ type: best.side === 1 ? 'replace-y1' : 'replace-y2', from: removed, to: spUnit });
      const om = metricsOf(cy1, cy2); record(cy1, cy2, sp, actions, om.ino, om.spread);
    }
  })();

  // ── merge: best candidate per budget ──
  // relay-pass GATE (I_no < THR beats a failing one) → PHASE BALANCE gate (spread ≤
  // tol, boolean) → LOWEST I_no (even if it needs a spare — product decision 2026-07)
  // → LEAST EFFORT (`cost` = near rack swaps first, spare last) → fewest swaps / fewest
  // spares. If nothing passes the relay, lowest I_no (closest to safe) → least effort.
  // (Nameplate failed-count no longer gates.)
  function better(c, best) {
    const cp = c.ino < THR, bp = best.ino < THR;
    if (cp !== bp) return cp;                                             // 1. relay-pass gate
    if (cp) {                                                            // both pass relay
      // 2. balance = BOOLEAN gate (spread ≤ tol), NOT a continuous compare. The old
      //    continuous spread-first made a spare (spread→0) always beat a cheaper
      //    in-rack plan, then the cost tiebreaker flipped back — the picker oscillated
      //    between all-spare and all-rack. Boolean gate keeps it monotone.
      const cok = c.spread <= PHASE_SPREAD_UF + 1e-9;
      const bok = best.spread <= PHASE_SPREAD_UF + 1e-9;
      if (cok !== bok) return cok;
      if (!cok && Math.abs(c.spread - best.spread) > 1e-9) return c.spread < best.spread; // both unbalanced → tighter
      // 3. LOWEST I_no — even if it needs a spare (product decision 2026-07: I_no
      //    quality beats spare-conservation; spare-last is only the next tiebreaker).
      if (Math.abs(c.ino - best.ino) > 1e-9) return c.ino < best.ino;
      if (c.cost !== best.cost) return c.cost < best.cost;               // 4. least effort (near→far→spare-last)
    } else {                                                             // neither passes → closest to safe
      if (Math.abs(c.ino - best.ino) > 1e-9) return c.ino < best.ino;
      if (c.cost !== best.cost) return c.cost < best.cost;
      if (Math.abs(c.spread - best.spread) > 1e-9) return c.spread < best.spread;
    }
    if (c.swaps !== best.swaps) return c.swaps < best.swaps;             // 5. fewer swaps
    return c.sp < best.sp;                                               // 6. fewer spares used
  }
  function pick(maxSwaps) {
    let best = candidates[0];
    for (const c of candidates) {
      if (c.swaps > maxSwaps) continue;
      if (better(c, best)) best = c;
    }
    return best;
  }
  const results = targets.map(target => {
    const b = pick(target);
    return {
      swapCount: target,
      actualSwaps: b.swaps,
      diff: b.ino,            // = Ino in mA
      Ino_mA: b.ino,
      spreadInner: b.spread,  // 6-phase series-C spread the search minimized (µF)
      sparesUsed: b.sp,
      swapCost: b.cost,       // total effort = rack distance + spare penalty
      y1: b.y1, y2: b.y2, spare: b.spare,
      acts: b.acts,           // raw actions — UI pairs each swap to its units
      steps: b.steps
    };
  });
  return { baseDiff: baseIno, baseIno, swaps: results };
}

function findBest1to3Swaps(origY1, origY2, origS, baseline) {
  // เปลี่ยนเป็น 2 / 4 / 6 swap levels — iterative greedy
  // baseline = { y1, y2 } sums of locked items (not swappable)
  const off1 = (baseline && baseline.y1) || 0;
  const off2 = (baseline && baseline.y2) || 0;
  const baseDiff = Math.abs((sumC(origY1)+off1) - (sumC(origY2)+off2));
  const targets = [2, 4, 6];
  const results = [];

  for (const target of targets) {
    let curY1 = origY1.slice(), curY2 = origY2.slice(), curS = origS.slice();
    let curDiff = baseDiff;
    const actions = [];

    for (let step = 0; step < target; step++) {
      const candidates = allSingleSwaps(curY1, curY2, curS, baseline);
      if (candidates.length === 0) break;
      const best = candidates[0];
      // Stop if no improvement
      if (best.diff >= curDiff - 1e-9) break;
      const { y1: nY1, y2: nY2, spare: nS } = applySwaps(curY1, curY2, curS, best.ops);
      curY1 = nY1; curY2 = nY2; curS = nS;
      curDiff = best.diff;
      actions.push(best.action);
    }

    if (actions.length > 0) {
      results.push({
        swapCount: target,
        actualSwaps: actions.length,
        diff: curDiff,
        y1: curY1,
        y2: curY2,
        steps: actions.map(describeSwap)
      });
    } else {
      results.push({
        swapCount: target,
        actualSwaps: 0,
        diff: baseDiff,
        y1: origY1,
        y2: origY2,
        steps: ['ไม่มีการสับเปลี่ยนที่ลดความไม่สมดุลได้']
      });
    }
  }

  return { baseDiff, swaps: results };
}

function findBestFullSwap(origY1, origY2, origS, baseline, iterations=600) {
  // Backward-compat: if 4th arg is a number, it's iterations (old signature)
  if (typeof baseline === 'number') { iterations = baseline; baseline = null; }
  const off1 = (baseline && baseline.y1) || 0;
  const off2 = (baseline && baseline.y2) || 0;
  const n=origY1.length, baseDiff=Math.abs((sumC(origY1)+off1)-(sumC(origY2)+off2));
  let bestG={ diff:baseDiff, y1:origY1.slice(), y2:origY2.slice() };
  const pool=origY1.concat(origY2,origS);
  for (let it=0;it<iterations;it++) {
    const sh=pool.slice().sort(()=>Math.random()-0.5);
    let cY1=sh.slice(0,n), cY2=sh.slice(n,n*2), cS=sh.slice(n*2);
    let imp=true;
    while (imp) {
      imp=false; let cd=Math.abs((sumC(cY1)+off1)-(sumC(cY2)+off2));
      for (let i=0;i<n;i++) {
        for (let j=0;j<n;j++) {
          const d=Math.abs((sumC(cY1)+off1-cY1[i].val+cY2[j].val)-(sumC(cY2)+off2-cY2[j].val+cY1[i].val));
          if (d<cd){const t=cY1[i];cY1[i]=cY2[j];cY2[j]=t;cd=d;imp=true;}
        }
        for (let k=0;k<cS.length;k++) {
          const d1=Math.abs((sumC(cY1)+off1-cY1[i].val+cS[k].val)-(sumC(cY2)+off2));
          if (d1<cd){const t=cY1[i];cY1[i]=cS[k];cS[k]=t;cd=d1;imp=true;}
          if (i<cY2.length){const d2=Math.abs((sumC(cY1)+off1)-(sumC(cY2)+off2-cY2[i].val+cS[k].val));if(d2<cd){const t=cY2[i];cY2[i]=cS[k];cS[k]=t;cd=d2;imp=true;}}
        }
      }
    }
    const fd=Math.abs((sumC(cY1)+off1)-(sumC(cY2)+off2));
    if (fd<bestG.diff) bestG={diff:fd,y1:cY1.slice(),y2:cY2.slice()};
  }
  let sc=0;
  bestG.y1.forEach(c=>{if(c.origin!=='Y1')sc++;});
  bestG.y2.forEach(c=>{if(c.origin!=='Y2')sc++;});
  bestG.swapCount=sc;
  return bestG;
}


// Expose calculator functions globally for client-side use
window._calcYYMetrics     = calcYYMetrics;
window._calcHBridgeMetrics= calcHBridgeMetrics;
window._findBest1to3Swaps = findBest1to3Swaps;
window._findBestFullSwap  = findBestFullSwap;


// ═══════════════════════════════════════
// CLIENT-SIDE API SHIM
// replaces fetch('/api/calculate') with direct function calls
// ═══════════════════════════════════════
// ═══════════════════════════════════════
// Helpers for split-pair handling
// ═══════════════════════════════════════
// ═══════════════════════════════════════════════════════
// MODE-BASED OUTLIER DETECTION (Rule 2)
// For non-parallel groups: find the mode (most frequent value) of all C units
// on a side, then flag units deviating ≥ DEV_THRESHOLD from the mode.
// Flagged units are promoted to swappable (Tier 1) and prioritized.
// ═══════════════════════════════════════════════════════
function findModeReference(values, roundTo = 0.1) {
  // values: array of numbers (µF)
  if (!values.length) return null;
  // Bucket by rounded value to find the most frequent reading
  const buckets = {};
  values.forEach(v => {
    const key = (Math.round(v / roundTo) * roundTo).toFixed(3);
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(v);
  });
  // Find the bucket with the most members
  let bestKey = null, bestCount = 0;
  Object.keys(buckets).forEach(k => {
    if (buckets[k].length > bestCount) { bestCount = buckets[k].length; bestKey = k; }
  });
  if (bestCount >= 2) {
    // Genuine mode exists — use average of actual values in that bucket
    const members = buckets[bestKey];
    return members.reduce((s, x) => s + x, 0) / members.length;
  }
  // No repeated value → fall back to median (outlier-resistant)
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Promote high-deviation NON-PARALLEL units to swappable + flag as outlier.
// Operates per-phase (origin). Only acts on items that are plain single units
// (not scissored, not locked-parallel) — i.e. "Non-Parallel Groups".
function markModeOutliers(flatArr, devThreshold = 0.05) {
  // Group plain single units by origin (phase)
  const groups = {};
  flatArr.forEach(x => {
    // Plain non-parallel single unit: not split-derived, not locked
    const isPlainSingle = !x.isLocked && !x.subKey && x.swapGranularity !== 'pair';
    if (!isPlainSingle) return;
    (groups[x.origin] = groups[x.origin] || []).push(x);
  });
  const outliers = [];
  Object.keys(groups).forEach(origin => {
    const grp = groups[origin];
    if (grp.length < 2) return;
    const mode = findModeReference(grp.map(x => x.val));
    if (!mode) return;
    grp.forEach(x => {
      const dev = Math.abs(x.val - mode) / mode;
      if (dev >= devThreshold) {
        x.isOutlier = true;
        x.deviation = dev;
        x.modeRef = mode;
        x.priorityScore = dev;   // higher deviation → higher priority
        outliers.push(x);
      }
    });
  });
  return outliers;
}

function expandPairs(arr) {
  // NO ÷2, NO splitting. Every slot is ONE unit whose value = the slot's combined
  // (parallel) capacitance — scissors slot = va+vb, plain/parallel slot = entered
  // value as-is. This makes a parallel pair contribute as a single series element
  // in calcYYMetrics (physically correct) and keeps scissors / locked / plain slots
  // all on the same scale. `isLocked` still routes parallel-but-not-scissored slots
  // to Tier 2 (swapped only as a fallback); scissors + plain stay Tier 1.
  return arr.map(p => Object.assign({}, p, {
    parentId: p.id,
    swapGranularity: 'individual'
  }));
}

// Helper: group pair-granularity items before passing to swap algorithm
function prepareTier2Array(arr) {
  // Tier 2 fallback: locked items are swapped INDIVIDUALLY (ทีละตัว),
  // not as pairs. Each sub-unit is its own swappable item.
  // Pass through unchanged so the algorithm treats each as a single unit.
  return arr.slice();
}

// Helper: pass-through (no pair packing to unpack)
function unpackTier2Result(arr) {
  return arr.slice();
}

async function clientCalculate(payload) {
  const {topology, y1, y2, spare, legs, systemKV, alarmMA} = payload;
  const kv = parseFloat(systemKV) || 69;
  // CT alarm threshold (mA). The field engineer sets this per-substation in Step 2;
  // ALARM_MA (top of file) is now only the DEFAULT fallback. It drives underThreshold
  // (pass/fail) + budget selection, and is stored on engBefore.thresholdMA so UI +
  // formulas read it back and stay consistent. Does NOT change the I_no calculation.
  const userAlarm = parseFloat(alarmMA);
  const THRESHOLD_MA = (isFinite(userAlarm) && userAlarm > 0) ? userAlarm : ALARM_MA;
  let quickResult, fullResult, engBefore;

  if (topology === 'h-bridge') {
    const {a, b, c, d} = legs;
    const aF=expandPairs(a), bF=expandPairs(b), cF=expandPairs(c), dF=expandPairs(d);
    engBefore = calcHBridgeMetrics(aF, bF, cF, dF, kv);

    // Rule 2: mode-based outlier detection per leg (non-parallel groups)
    markModeOutliers(aF); markModeOutliers(bF); markModeOutliers(cF); markModeOutliers(dF);

    // Tier 1 = !isLocked (ติ๊กวัดแยก), Tier 2 = isLocked (กรุ๊ป)
    const aT1=aF.filter(x=>!x.isLocked), aT2=aF.filter(x=>x.isLocked);
    const bT1=bF.filter(x=>!x.isLocked), bT2=bF.filter(x=>x.isLocked);
    const cT1=cF.filter(x=>!x.isLocked), cT2=cF.filter(x=>x.isLocked);
    const dT1=dF.filter(x=>!x.isLocked), dT2=dF.filter(x=>x.isLocked);

    function reassembleLegs(swappedLeft, swappedRight, useTier2) {
      // After algo runs, items have original origin tags
      const nA = swappedLeft.filter(x => (x.origin||'').startsWith('A'));
      const nC = swappedLeft.filter(x => (x.origin||'').startsWith('C'));
      const nB = swappedRight.filter(x => (x.origin||'').startsWith('B'));
      const nD = swappedRight.filter(x => (x.origin||'').startsWith('D'));
      const spareA = swappedLeft.filter(x => x.origin==='Spare').slice();
      const spareB = swappedRight.filter(x => x.origin==='Spare').slice();
      // If using Tier 2 (locked items participated), don't re-add locked back
      const lA = useTier2 ? [] : aT2;
      const lB = useTier2 ? [] : bT2;
      const lC = useTier2 ? [] : cT2;
      const lD = useTier2 ? [] : dT2;
      return {
        finalA: [...nA, ...lA],
        finalC: [...nC, ...lC, ...spareA],
        finalB: [...nB, ...lB],
        finalD: [...nD, ...lD, ...spareB]
      };
    }

    // Tier 1: focus on "วัดแยก" items
    const leftT1  = [...aT1, ...cT1];
    const rightT1 = [...bT1, ...dT1];
    quickResult = findBest1to3Swaps(leftT1, rightT1, spare || []);
    fullResult  = findBestFullSwap(leftT1, rightT1, spare || []);

    quickResult.swaps = quickResult.swaps.map(sw => {
      const f = reassembleLegs(sw.y1, sw.y2, false);
      sw.engAfter = calcHBridgeMetrics(f.finalA, f.finalB, f.finalC, f.finalD, kv);
      sw.Ino_mA = sw.engAfter.In_mA;
      sw.underThreshold = sw.Ino_mA < THRESHOLD_MA;
      sw.y1Full = [...f.finalA, ...f.finalC];
      sw.y2Full = [...f.finalB, ...f.finalD];
      sw.tier = 1;
      return sw;
    });
    {
      const f = reassembleLegs(fullResult.y1, fullResult.y2, false);
      fullResult.engAfter = calcHBridgeMetrics(f.finalA, f.finalB, f.finalC, f.finalD, kv);
      fullResult.Ino_mA = fullResult.engAfter.In_mA;
      fullResult.underThreshold = fullResult.Ino_mA < THRESHOLD_MA;
      fullResult.y1Full = [...f.finalA, ...f.finalC];
      fullResult.y2Full = [...f.finalB, ...f.finalD];
      fullResult.tier = 1;
    }

    // Tier 2 fallback if needed — but NOT when "วัดแยก" (scissors) is in use:
    // grouped units are then off-limits, swap only measured-separately + spares.
    const hasScissors = [aF, bF, cF, dF].some(arr => arr.some(x => x.isSplit));
    const t1Best = quickResult.swaps[quickResult.swaps.length-1];
    const totalT2 = aT2.length + bT2.length + cT2.length + dT2.length;
    if (!t1Best.underThreshold && totalT2 > 0 && !hasScissors) {
      // Prepare Tier 2 — swap locked items individually (ทีละตัว)
      const aT2P = prepareTier2Array(aT2), bT2P = prepareTier2Array(bT2);
      const cT2P = prepareTier2Array(cT2), dT2P = prepareTier2Array(dT2);
      const leftAll  = [...aT1, ...cT1, ...aT2P, ...cT2P];
      const rightAll = [...bT1, ...dT1, ...bT2P, ...dT2P];
      const t2Quick = findBest1to3Swaps(leftAll, rightAll, spare || []);
      const t2Full  = findBestFullSwap(leftAll, rightAll, spare || []);

      // Unpack pairs before reassembly
      t2Quick.swaps.forEach(sw => {
        sw.y1 = unpackTier2Result(sw.y1);
        sw.y2 = unpackTier2Result(sw.y2);
        const f = reassembleLegs(sw.y1, sw.y2, true);
        sw.engAfter = calcHBridgeMetrics(f.finalA, f.finalB, f.finalC, f.finalD, kv);
        sw.Ino_mA = sw.engAfter.In_mA;
        sw.underThreshold = sw.Ino_mA < THRESHOLD_MA;
        sw.y1Full = [...f.finalA, ...f.finalC];
        sw.y2Full = [...f.finalB, ...f.finalD];
        sw.tier = 2;
      });
      {
        t2Full.y1 = unpackTier2Result(t2Full.y1);
        t2Full.y2 = unpackTier2Result(t2Full.y2);
        const f = reassembleLegs(t2Full.y1, t2Full.y2, true);
        t2Full.engAfter = calcHBridgeMetrics(f.finalA, f.finalB, f.finalC, f.finalD, kv);
        t2Full.Ino_mA = t2Full.engAfter.In_mA;
        t2Full.underThreshold = t2Full.Ino_mA < THRESHOLD_MA;
        t2Full.y1Full = [...f.finalA, ...f.finalC];
        t2Full.y2Full = [...f.finalB, ...f.finalD];
        t2Full.tier = 2;
      }

      quickResult.swaps = quickResult.swaps.map((sw, i) => {
        const t2 = t2Quick.swaps[i];
        return (t2.Ino_mA < sw.Ino_mA) ? t2 : sw;
      });
      if (t2Full.Ino_mA < fullResult.Ino_mA) Object.assign(fullResult, t2Full);
      quickResult.fallbackUsed = true;
    }

    // Info note
    const t1Count = aT1.length + bT1.length + cT1.length + dT1.length;
    const t2Count = aT2.length + bT2.length + cT2.length + dT2.length;
    quickResult.lockedNote = (t1Count + t2Count) > 0
      ? `Tier 1 (ติ๊ก "วัดแยก"): ${t1Count} ตัว · Tier 2 (กรุ๊ป): ${t2Count} ตัว · Spare ${(spare||[]).length} ตัว` +
        (quickResult.fallbackUsed ? ' · ⚠ Tier 1 ไม่พอ ใช้ fallback (สลับ Tier 2 ด้วย)' : '') +
        (hasScissors && t2Count > 0 ? ' · 🔒 มีวัดแยก → สับเฉพาะตัววัดแยก + Spare (ไม่แตะตัวกรุ๊ป)' : '')
      : null;
  } else {
    const y1Flat = expandPairs(y1);
    const y2Flat = expandPairs(y2);
    engBefore   = calcYYMetrics(y1Flat, y2Flat, kv);
    engBefore.spread = phaseSpreadOf(engBefore);   // within-side A/B/C series spread (before)

    // ── Rule 2: mode-based outlier detection for non-parallel groups ──
    // Flag units deviating ≥5% from the per-phase mode; these are prioritized.
    const y1ModeOutliers = markModeOutliers(y1Flat);
    const y2ModeOutliers = markModeOutliers(y2Flat);

    // ── 2-tier swap strategy ──
    // Tier 1: ตัวที่ติ๊ก "วัดแยกตัว" → focus swap ตรงนี้ก่อน
    // Tier 2: ถ้า Ino ยังเกิน threshold → ขยายให้สลับตัวอื่น (locked group) ด้วย
    const y1Tier1 = y1Flat.filter(x => !x.isLocked);
    const y1Tier2 = y1Flat.filter(x =>  x.isLocked);
    const y2Tier1 = y2Flat.filter(x => !x.isLocked);
    const y2Tier2 = y2Flat.filter(x =>  x.isLocked);

    // ── Swap-priority = PHYSICAL RACK DISTANCE (near → far), spare LAST ──
    // expand() emits every in-rack exchange (any of the 6 phases ↔ any other) plus
    // spare replacements; each candidate carries a `cost` (rack distance for an
    // exchange, SWAP_SPARE_COST for a spare). So the optimizer rearranges the rack
    // with the NEAREST swaps first and only fetches a SPARE when rack rearrangement
    // can't reach the goal. A failed (<nameplate) unit is moved in-rack first too;
    // nameplate is display-only now. Two levels: L0 = Tier-1 units (rack + spare);
    // L1 = + grouped Tier-2 as a fallback (skipped when scissors used).
    const hasScissors = y1Flat.some(x => x.isSplit) || y2Flat.some(x => x.isSplit);
    function isFailedUnit(x) {
      if (x.measuredA != null && x.measuredB != null) return x.measuredA < NAMEPLATE_UF || x.measuredB < NAMEPLATE_UF;
      return x.val < NAMEPLATE_UF;
    }
    function sumByPhase(arr) {
      const m = { A: 0, B: 0, C: 0 };
      arr.forEach(x => { const p = (x.origin||'').replace("'",''); if (m[p] !== undefined) m[p] += x.val; });
      return m;
    }
    function runPass(swapY1, swapY2, lockY1, lockY2, level) {
      const baseline = { y1ByPhase: sumByPhase(lockY1), y2ByPhase: sumByPhase(lockY2) };
      const res = findPhaseAwareYYSwaps(swapY1, swapY2, spare || [], baseline, kv, lockY1, lockY2, NAMEPLATE_UF, null, THRESHOLD_MA);
      res.swaps.forEach(sw => {
        const fullY1 = [...sw.y1, ...lockY1];
        const fullY2 = [...sw.y2, ...lockY2];
        sw.engAfter = calcYYMetrics(fullY1, fullY2, kv);
        sw.Ino_mA = sw.engAfter.Ino_mA;
        sw.underThreshold = sw.Ino_mA < THRESHOLD_MA;
        sw.spread = phaseSpreadOf(sw.engAfter);
        sw.spreadOK = sw.spread.ok;
        sw.fullyPass = sw.underThreshold && sw.spreadOK;
        sw.cost = sw.swapCost != null ? sw.swapCost : 0;   // rack distance + spare penalty
        sw.y1Full = fullY1; sw.y2Full = fullY2;
        sw.level = level;
        sw.tier = level >= 1 ? 2 : 1;
      });
      return res;
    }

    const levels = [];
    // L0 — Tier-1 units, rack swaps + spare (grouped LOCKED). Cost orders near→far→spare.
    levels.push(runPass(y1Tier1, y2Tier1, y1Tier2, y2Tier2, 0));
    // L1 — + grouped Tier-2 as a fallback (skip when scissors used).
    if (!hasScissors && (y1Tier2.length + y2Tier2.length) > 0) {
      levels.push(runPass([...y1Tier1, ...y1Tier2], [...y2Tier1, ...y2Tier2], [], [], 1));
    }

    // Count failed (<nameplate) units still installed — for the display note only.
    function failRemain(sw) {
      let n = 0;
      [...(sw.y1Full || []), ...(sw.y2Full || [])].forEach(u => { if (u.origin !== 'Spare' && isFailedUnit(u)) n++; });
      return n;
    }
    // Per budget: relay-pass GATE → phase balance gate → LOWEST I_no (even if it
    // needs a spare) → LEAST EFFORT (rack distance + spare-last, via `cost`) → fewest
    // swaps → fewest grouped touched. (Kept consistent with better() above.)
    function chooseBudget(i) {
      const cands = levels.map(p => p.swaps[i]).filter(Boolean);
      cands.forEach(c => { c._fail = failRemain(c); });
      cands.sort((a, b) => {
        const ut = (b.underThreshold ? 1 : 0) - (a.underThreshold ? 1 : 0); if (ut) return ut; // relay-pass GATE
        if (a.underThreshold) {
          const so = (b.spreadOK ? 1 : 0) - (a.spreadOK ? 1 : 0); if (so) return so;             // balanced ≤ tol
          if (!a.spreadOK && Math.abs(a.spread.max - b.spread.max) > 1e-9) return a.spread.max - b.spread.max;
          if (Math.abs(a.Ino_mA - b.Ino_mA) > 1e-6) return a.Ino_mA - b.Ino_mA;                  // lowest I_no
          if (a.cost !== b.cost) return a.cost - b.cost;                                          // then nearest swaps / spare-last
          return a.actualSwaps - b.actualSwaps || a.level - b.level;
        }
        // Neither passes → closest to safe (lowest I_no), then least effort.
        if (Math.abs(a.Ino_mA - b.Ino_mA) > 1e-6) return a.Ino_mA - b.Ino_mA;
        if (a.cost !== b.cost) return a.cost - b.cost;
        if (Math.abs(a.spread.max - b.spread.max) > 1e-9) return a.spread.max - b.spread.max;
        return a.actualSwaps - b.actualSwaps || a.level - b.level;
      });
      return cands[0];
    }
    quickResult = { baseDiff: levels[0].baseIno, baseIno: levels[0].baseIno, swaps: [0, 1, 2].map(chooseBudget) };
    quickResult.usedGood     = true;                                          // rack swaps may touch any good unit
    quickResult.usedSpare    = quickResult.swaps.some(sw => sw.sparesUsed > 0);
    quickResult.fallbackUsed = quickResult.swaps.some(sw => sw.level >= 1);   // grouped Tier-2 fallback

    fullResult = Object.assign({}, quickResult.swaps[quickResult.swaps.length - 1]);
    fullResult.swapCount = fullResult.actualSwaps;

    // Info note
    const tier1Count = y1Tier1.length + y2Tier1.length;
    const tier2Count = y1Tier2.length + y2Tier2.length;
    const sCount = (spare||[]).length;
    const nFail = y1Tier1.filter(isFailedUnit).length + y2Tier1.filter(isFailedUnit).length;
    const goodSpare = (spare || []).filter(s => s.val >= NAMEPLATE_UF).length;
    quickResult.lockedNote = (tier1Count + tier2Count) > 0
      ? `Tier 1 (วัดแยก): ${tier1Count} ตัว · Tier 2 (กรุ๊ป): ${tier2Count} ตัว · Spare ${sCount} ตัว (ดี ${goodSpare})` +
        ' · ลำดับสับ: สลับในแร็คตามระยะ ใกล้→ไกล (A A\' B B\' C C\') ก่อน → spare ท้ายสุด' +
        (nFail > 0 ? ` · 🔧 พบ ${nFail} ตัว < ${NAMEPLATE_UF} µF (เสีย) → ย้ายในแร็คก่อน ไม่พอค่อยใช้ spare` : '') +
        (quickResult.usedSpare ? ' · 🔁 ใช้ spare (สลับในแร็คไม่พอ)' : '') +
        (quickResult.fallbackUsed ? ' · ⚠ ใช้ fallback (สลับตัวกรุ๊ป Tier 2 ด้วย)' : '') +
        (hasScissors && tier2Count > 0 ? ' · 🔒 มีวัดแยก → ไม่แตะตัวกรุ๊ป' : '')
      : null;
  }

  // Mark which quick swap is the BEST: fewest swaps that meets the alarm; and
  // (YY) fewest swaps that FULLY pass (alarm AND within-side phase spread).
  quickResult.bestUnderThreshold = null;
  quickResult.bestFullyPass = null;
  for (let i = 0; i < quickResult.swaps.length; i++) {
    if (quickResult.bestUnderThreshold === null && quickResult.swaps[i].underThreshold)
      quickResult.bestUnderThreshold = i;
    if (quickResult.bestFullyPass === null && quickResult.swaps[i].underThreshold && quickResult.swaps[i].spreadOK)
      quickResult.bestFullyPass = i;
  }

  // Add threshold info
  engBefore.thresholdMA = THRESHOLD_MA;
  engBefore.phaseSpreadTol = PHASE_SPREAD_UF;
  const beforeMA = topology==='h-bridge' ? engBefore.In_mA : engBefore.Ino_mA;
  engBefore.overThreshold = beforeMA >= THRESHOLD_MA;
  engBefore.Ino_mA_before = beforeMA;

  return { quickResult, fullResult, engBefore };
}
