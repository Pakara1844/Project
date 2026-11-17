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

// Max allowed spread (µF) of the per-phase SERIES capacitance (C_phase = 1/Σ(1/cᵢ))
// WITHIN one wye side (A vs B vs C on Y1, A' vs B' vs C' on Y2). The BALANCE GOAL is
// A=B=C on Y1 AND A'=B'=C' on Y2 — each wye internally balanced (the two wyes need NOT
// match each other; that is not required for I_no=0). `phaseSpreadOf().max` = the worse
// of the two within-wye spreads and must be ≤ this tolerance. v9.4: DISPLAY ONLY (the
// "ΔC เฟส" badge + summary line) — the restored v6.5 optimizer does NOT use it to rank
// plans. It NEVER changes the I_no calculation. (YY topology only.)
// SIZING NOTE (measured, 115 kV / 10 caps-in-series per phase → C_phase ≈ 2.72 µF):
// ΔC within a wye maps to I_no at roughly 0.001 µF ≈ 10.5 mA. 0.005 µF ≈ 52 mA, which
// lines up with the default 50 mA alarm — keep this in the same order as the alarm you
// expect; a looser value makes the balance badge pass while the relay still trips.
const PHASE_SPREAD_UF = 0.005;
if (typeof window !== 'undefined') window.PHASE_SPREAD_UF = PHASE_SPREAD_UF;
// v10.3 — the balance metric IS the field-sheet number: per-phase SUM ΣC (A/B/C on Y1,
// A'/B'/C' on Y2), max − min within each side ≤ the Step-2 tolerance (#balSumUF, UI
// default 0.1 µF). I_no and ΣC balance have EQUAL weight via the score
// max(I_no / ref, ΔΣC / tol)  (≤ 1 = both pass). The tolerance and the spare priority
// travel as OPTIONS (findPhaseAwareYYSwaps opts.balSum / opts.balFirst) — no globals
// (v10.4), so a direct optimizer call never picks up a previous calculation's settings.
// Callers that pass nothing get BAL_SUM_DEFAULT 0.5 µF and 'failed' priority.
const BAL_SUM_DEFAULT = 0.5;
const SCORE_TIE = 0.02;                       // scores within 2 % of target count as equal
// When the worse side dominates the score, the OTHER side still matters (else a search
// never bothers to balance Y1 while Y2 is off): ties on score → the other side's ΔΣC.
const OTHER_TIE_UF = 0.05;
if (typeof window !== 'undefined') window.BAL_SUM_DEFAULT = BAL_SUM_DEFAULT;

// I_no "tie" band (mA). When two candidate plans BOTH pass the relay threshold,
// I_no values within this band count as equal, so the picker prefers the plan that
// uses FEWER spares instead of burning extra spares for a few mA. It never applies
// when either plan fails the relay. See better() in findPhaseAwareYYSwaps. (YY only.)
const INO_TIE_MA = 2.0;
if (typeof window !== 'undefined') window.INO_TIE_MA = INO_TIE_MA;
// v9.7: when NO plan can reach within-side balance (≤ PHASE_SPREAD_UF), spreads that
// differ by less than this are treated as equal so the picker prefers less work
// instead of chasing a sliver of balance with many extra swaps.
const SPREAD_TIE_UF = 0.001;

// Action types that actually CONSUME a spare (used for sparesUsed accounting).
// `exchange` (in-phase) and `piece-swap` (scissored piece↔piece) use no spare.
const SPARE_ACTION_TYPES = new Set(['replace-y1', 'replace-y2', 'piece-replace']);
// v10.4: a replacement only USES A SPARE when the part put in is one of the entered spares
// (id "S-n"). A good unit or piece pulled out earlier and re-installed elsewhere is a move,
// not a spare (SNO-CAY3 used to show "5 spares" with only 3 entered).
const isRealSpare = u => !!u && !u.pulledPiece && /^S-/.test(u.id || '');
function countSparesUsed(actions) {
  return (actions || []).reduce((n, a) => n + (SPARE_ACTION_TYPES.has(a.type) && isRealSpare(a.to) ? 1 : 0), 0);
}
if (typeof window !== 'undefined') window.countSparesUsed = countSparesUsed;

// Capacitance tolerance of a capacitor UNIT vs its rated (nameplate) capacitance —
// IEC 60871-1:2005 §7.2 (identical: IS 13925-1:2012): −5 % … +10 %. A unit measuring
// OUTSIDE this band is treated as FAILED (เสีย) — too LOW = lost elements / blown
// internal fuses, too HIGH = shorted elements. These are only the DEFAULTS; the field
// engineer can change rated C and the band in Step 2 (v9.5).
const TOL_MINUS_PCT = 5;
const TOL_PLUS_PCT  = 10;
// IEEE Std 18: a capacitor must withstand 110 % of its rated rms voltage continuously.
// When the unit rated voltage is entered, no arrangement may load a unit above this.
const UNIT_OV_LIMIT = 1.10;
// I_no reference targets compared side by side in the results (= the Step-2 bubbles).
const INO_REF_LIST = [5, 10, 20, 30, 40, 50];
// "Worth it" bar for extra work in the ref comparison: an extra-effort plan is marked
// ⭐ คุ้มสุด only if it lowers I_no by at least this many mA PER EXTRA SWAP compared
// with the least-work plan. Engineering judgement (10 % of a 50 mA relay per swap),
// NOT a standard value — tune here.
const INO_WORTH_MA_PER_SWAP = 5;
// Search depth (v9.6, F2): every bank is searched to BASE_DEPTH swaps (budgets 2/4/6);
// if that can't pass the I_no ref — or can't get the failed units out while good
// spares remain — the search is re-run to EXT_DEPTH and a "สูงสุด" budget is added.
const BASE_DEPTH = 6;
const EXT_DEPTH  = 12;
const TEMP_DEPTH = 16;   // v9.9 — temp mode (failed units may move): spreading needs more swaps
if (typeof window !== 'undefined') {
  window.TOL_MINUS_PCT = TOL_MINUS_PCT; window.TOL_PLUS_PCT = TOL_PLUS_PCT;
  window.UNIT_OV_LIMIT = UNIT_OV_LIMIT; window.INO_REF_LIST = INO_REF_LIST; window.INO_WORTH_MA_PER_SWAP = INO_WORTH_MA_PER_SWAP;
}

// Normalize the capacitor rating spec. Accepts a plain number (legacy: rated µF) or
// { uf, minusPct, plusPct, ratedKV }. Missing fields fall back to the defaults.
function capSpecOf(spec) {
  const s = (spec && typeof spec === 'object') ? spec : { uf: spec };
  const num = (v, d) => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : d;
  const uf = (typeof s.uf === 'number' && s.uf > 0) ? s.uf : NAMEPLATE_UF;
  return {
    uf,
    minusPct: num(s.minusPct, TOL_MINUS_PCT),
    plusPct:  num(s.plusPct,  TOL_PLUS_PCT),
    ratedKV:  (typeof s.ratedKV === 'number' && s.ratedKV > 0) ? s.ratedKV : null,
    lo: uf * (1 - num(s.minusPct, TOL_MINUS_PCT) / 100),
    hi: uf * (1 + num(s.plusPct,  TOL_PLUS_PCT)  / 100),
  };
}
// One capacitance reading outside the tolerance band?
function capValOutOfTol(v, spec) {
  const s = spec && spec.lo != null ? spec : capSpecOf(spec);
  return v < s.lo - 1e-9 || v > s.hi + 1e-9;
}
// A slot is failed if its reading (or, for a scissored pair, either measured piece)
// is outside the band. A scissored slot's .val is the PAIR sum, so never test that.
function unitOutOfTolerance(u, spec) {
  if (!u) return false;
  if (u.measuredA != null && u.measuredB != null) return capValOutOfTol(u.measuredA, spec) || capValOutOfTol(u.measuredB, spec);
  return capValOutOfTol(u.val / parallelCountOf(u, spec), spec);
}
// v10.0 (bug A): a parallel-GROUP slot (side "ต่อขนาน", not measured separately) holds
// n units in parallel and its reading is their SUM (~54 µF for 2×27). Judge it per unit
// (val / n) — before v10 every 54 µF slot counted as "failed high".
function parallelCountOf(u, spec) {
  if (!u || !u.isLocked) return 1;
  const s = spec && spec.lo != null ? spec : capSpecOf(spec);
  return Math.max(1, Math.round(u.val / s.uf));
}
// Relative deviation of a slot from rated (scissored → its worse piece; group → per unit).
function unitDevOf(u, spec) {
  const s = spec && spec.lo != null ? spec : capSpecOf(spec);
  if (u.measuredA != null && u.measuredB != null)
    return Math.max(Math.abs(u.measuredA / s.uf - 1), Math.abs(u.measuredB / s.uf - 1));
  return Math.abs(u.val / parallelCountOf(u, s) / s.uf - 1);
}
// Voltage across every series element: within one phase string the current is common,
// so V_i = Vph · (1/C_i) / Σ(1/C_j). (The tiny neutral shift is ignored — tens of volts
// vs tens of kV.) Returns the worst unit as % of its balanced share and, if the unit
// rated voltage is known, as % of rated + how many units exceed UNIT_OV_LIMIT.
function unitVoltageStats(y1, y2, systemKV, ratedKV) {
  const vph = (systemKV || 69) / Math.sqrt(3);
  const groups = {};
  [...(y1 || []), ...(y2 || [])].forEach(u => {
    if (!u || u.origin === 'Spare' || !(u.val > 0)) return;
    (groups[u.origin] = groups[u.origin] || []).push(u);
  });
  let maxKV = 0, maxPctShare = 0, worst = null, ovCount = 0;
  Object.values(groups).forEach(str => {
    const inv = str.reduce((s, u) => s + 1 / u.val, 0);
    const share = vph / str.length;
    str.forEach(u => {
      const v = vph * (1 / u.val) / inv;
      if (v > maxKV) { maxKV = v; worst = u; }
      maxPctShare = Math.max(maxPctShare, 100 * v / share);
      if (ratedKV && v > UNIT_OV_LIMIT * ratedKV + 1e-12) ovCount++;
    });
  });
  return {
    maxKV, maxPctShare, ovCount,
    maxPctRated: ratedKV ? 100 * maxKV / ratedKV : null,
    worstId: worst ? worst.id : null,
  };
}
if (typeof window !== 'undefined') {
  window.capSpecOf = capSpecOf; window.unitOutOfTolerance = unitOutOfTolerance;
  window.unitVoltageStats = unitVoltageStats;
  window.unitDevOf = unitDevOf; window.parallelCountOf = parallelCountOf; window.sumSpreadOf = sumSpreadOf;
}

function sumC(arr) { return arr.reduce((t, c) => t + c.val, 0); }

// Phase spread from a calcYYMetrics() result: the max−min of the per-phase SERIES
// capacitances (perPhase.X.C1 = Y1, .C2 = Y2 — C_phase = 1/Σ(1/cᵢ), the same value
// that drives I_no). The BALANCE GOAL is WITHIN each wye — A=B=C on Y1 AND A'=B'=C' on
// Y2 — NOT that all six phases match across wyes. So `.max` = max(y1 spread, y2 spread)
// (the worse-balanced side) and `.ok` = that ≤ tol. This matches the physics: I_no = 0
// needs only within-wye balance (the two wyes may differ). `.y1`/`.y2` are the per-side
// spreads; `.all` (spread across all six phases) is kept for display only and does NOT
// gate anything. Balance compares the SERIES value per phase (engineer's choice — the
// same C_phase shown as "อนุกรม"); the sum1/sum2 fields exist but are NOT used here.
// v10.3 — within-side spread of the per-phase SUM ΣC (field-sheet metric, drives ranking).
function sumSpreadOf(metrics, tol) {
  const t = (typeof tol === 'number' && tol > 0) ? tol : BAL_SUM_DEFAULT;
  const p = metrics && metrics.perPhase;
  if (!p) return { y1: NaN, y2: NaN, max: NaN, min: NaN, ok: false, tol: t };
  const sp = a => Math.max.apply(null, a) - Math.min.apply(null, a);
  const s1 = sp([p.A.sum1, p.B.sum1, p.C.sum1]), s2 = sp([p.A.sum2, p.B.sum2, p.C.sum2]);
  const mx = Math.max(s1, s2);
  return { y1: s1, y2: s2, max: mx, min: Math.min(s1, s2), ok: mx <= t + 1e-9, tol: t, sums: true };
}
function phaseSpreadOf(metrics, tol) {
  const t = (typeof tol === 'number' && tol > 0) ? tol : PHASE_SPREAD_UF;
  const p = metrics && metrics.perPhase;
  if (!p) return { y1: NaN, y2: NaN, all: NaN, max: NaN, ok: false, tol: t };
  const sp = a => Math.max.apply(null, a) - Math.min.apply(null, a);
  const s1  = sp([p.A.C1, p.B.C1, p.C.C1]);                              // within Y1: A=B=C (series)
  const s2  = sp([p.A.C2, p.B.C2, p.C.C2]);                              // within Y2: A'=B'=C' (series)
  const all = sp([p.A.C1, p.B.C1, p.C.C1, p.A.C2, p.B.C2, p.C.C2]);      // all six (display only)
  const within = Math.max(s1, s2);                                       // balance = worse-balanced wye
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

  // Per-phase PARALLEL SUM (µF) = Σ Cᵢ of the phase — DISPLAY ONLY (a comparison panel
  // in the UI). It does NOT drive I_no (series phaseC) nor the balance gate (which uses
  // the series C1/C2 — see phaseSpreadOf). Kept separate on purpose; do NOT mix into I_no.
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

  // Per-phase detail. C1/C2 = SERIES capacitance per phase (drives I_no AND the
  // phase-balance comparison; displayed as "อนุกรม"). sum1/sum2 = PARALLEL SUM per
  // phase — DISPLAY ONLY (a comparison panel), never used by I_no or the balance gate.
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
  // v10.4 (fix 1) — H-bridge per phase: left branch A (top, phase side) + C (bottom,
  // neutral side), right branch B (top) + D (bottom); the CT sits on the H-link between
  // the two mid-points. Each leg's units are in parallel → leg C = ΣC (unchanged).
  // With the near-zero-impedance CT tying the mid-points, the link current is
  //   I_bridge = ω·Vph·(C_A·C_D − C_B·C_C) / (C_A + C_B + C_C + C_D)
  // (Thevenin of the two dividers). Zero exactly when C_A/C_C = C_B/C_D (bridge balanced).
  // The old code used I_left − I_right (branch-current difference), which is 0 whenever
  // both branches have the same series C — e.g. A30/B27/C27/D30 read 0 mA although the
  // mid-points sit ~3.5 kV apart. NOT yet checked against an EGAT H-bridge sheet.
  const Vph = (systemKV * 1000) / Math.sqrt(3);                       // V
  const uA = sumC(legA), uB = sumC(legB), uC = sumC(legC), uD = sumC(legD);   // µF
  const CA = uA * 1e-6, CB = uB * 1e-6, CC = uC * 1e-6, CD = uD * 1e-6;     // F
  const sum = CA + CB + CC + CD;
  const Iun = sum > 0 ? PI2F * Vph * (CA * CD - CB * CC) / sum : 0;   // A (signed)
  const In_mA = Math.abs(Iun) * 1000;
  // open-link mid-point voltages (what the bridge compares) and the tied mid-point
  const VxL = (CA + CC) > 0 ? Vph * CA / (CA + CC) : 0;
  const VxR = (CB + CD) > 0 ? Vph * CB / (CB + CD) : 0;
  const Vx  = sum > 0 ? Vph * (CA + CB) / sum : 0;
  // reactive power with the mid-points tied: (A∥B) in series with (C∥D)
  const Ceq = sum > 0 ? (CA + CB) * (CC + CD) / sum : 0;
  const S_total = PI2F * Ceq;
  const Qt = (Vph * Vph * S_total) / 1e6;                             // Mvar
  return { CA_top_uF: uA, CA_bot_uF: uC, CB_top_uF: uB, CB_bot_uF: uD, Vph, Iun, In_mA, VxL, VxR, Vx, Qt, S_total, Ceq_uF: Ceq * 1e6 };
}

// v10.4 (fix 6): shared by ui.js (plan cards) and exporter.js (Excel "after" sheet).
// Physical slot (rack position) each unit ends up in — exchanged/replacing units take
// the slot of the unit they displaced, so the list follows the rack, not the value.
function slotOrder(acts){
  const slot = {};
  (acts || []).forEach(a => {
    if (a.type === 'exchange') {
      const s1 = slot[a.from.id] != null ? slot[a.from.id] : a.from.pos, s2 = slot[a.to.id] != null ? slot[a.to.id] : a.to.pos;
      slot[a.to.id] = s1; slot[a.from.id] = s2;
    } else if ((a.type === 'replace-y1' || a.type === 'replace-y2') && a.to) {
      slot[a.to.id] = slot[a.from.id] != null ? slot[a.from.id] : a.from.pos;
    }
  });
  return slot;
}

function describeSwap(action) {
  const { type, from, to } = action;
  if (type === 'exchange') {
    if (action.hb)   // H-bridge legs (A–D): no Y-Y phase names
      return `สลับ [${from.id}] ${from.val.toFixed(2)} µF กับ [${to.id}] ${to.val.toFixed(2)} µF`;
    return `สลับ [${from.id}] ${from.val.toFixed(2)} µF (เฟส ${from.origin}) กับ [${to.id}] ${to.val.toFixed(2)} µF (เฟส ${to.origin})`;
  }
  const srcTxt = to && to.pulledPiece ? `ลูกที่ถอดจาก [${to.id}]` : (to && /^S-/.test(to.id || '') ? `spare [${to.id}]` : `ลูกที่ถอดจาก [${to && to.id}]`);
  if (type === 'replace-y1') return `ถอด [${from.id}] (${from.val.toFixed(2)} µF) ออก ใส่ ${srcTxt} (${to.val.toFixed(2)} µF) แทน`;
  if (type === 'replace-y2') return `ถอด [${from.id}] (${from.val.toFixed(2)} µF) ออก ใส่ ${srcTxt} (${to.val.toFixed(2)} µF) แทน`;
  // v10.0: say which PAIR, which piece, where the new piece comes from, and the new pair totals
  if (type === 'piece-replace') return `คู่ขนาน [${from.id}] เปลี่ยนลูก ${action.piece} (${action.oldVal.toFixed(2)} µF) เป็น ${srcTxt} (${to.val.toFixed(2)} µF) · คู่ ${from.id} = ${action.newPairVal.toFixed(2)} µF`;
  if (type === 'piece-swap') {
    const n1 = action.u1.val - action.v1 + action.v2, n2 = action.u2.val - action.v2 + action.v1;
    return `สลับลูก ${action.p1} ของ [${action.u1.id}] (${action.v1.toFixed(2)} µF) กับลูก ${action.p2} ของ [${action.u2.id}] (${action.v2.toFixed(2)} µF) · คู่ ${action.u1.id} = ${n1.toFixed(2)}, คู่ ${action.u2.id} = ${n2.toFixed(2)} µF`;
  }
  return '';
}

// v10.4 (fix 2) — H-bridge swap search. Greedy best-improvement, scored by the REAL
// bridge current (calcHBridgeMetrics), each unit moved at most once. A moved unit takes
// the leg tag of its new position (before v10.4 it kept its old tag, so reassembly
// dropped every exchanged unit and the "after" numbers came from a bank missing units).
// units: swappable units (origin A/B/C/D); locked: fixed units (always counted).
// Returns states after 0..n steps; callers take budgets 2/4/6 and the last (full).
function findHBridgeSwaps(units, locked, spare, kv, maxSteps) {
  const legOf = u => (u.origin || '')[0];
  const ino = arr => {
    const g = { A: [], B: [], C: [], D: [] };
    for (const u of arr) if (g[legOf(u)]) g[legOf(u)].push(u);
    for (const u of locked) if (g[legOf(u)]) g[legOf(u)].push(u);
    return calcHBridgeMetrics(g.A, g.B, g.C, g.D, kv).In_mA;
  };
  let cur = units.slice(), pool = (spare || []).slice(), acts = [];
  const moved = new Set();
  const states = [{ units: cur, acts: [], ino: ino(cur) }];
  for (let step = 0; step < (maxSteps || 12); step++) {
    let best = null;
    const curIno = states[states.length - 1].ino;
    for (let i = 0; i < cur.length; i++) {
      const u = cur[i]; if (moved.has(u.id)) continue;
      for (let j = i + 1; j < cur.length; j++) {
        const w = cur[j]; if (moved.has(w.id) || legOf(u) === legOf(w) || u.val === w.val) continue;
        const t = cur.slice();
        t[i] = Object.assign({}, w, { origin: u.origin }); t[j] = Object.assign({}, u, { origin: w.origin });
        const v = ino(t);
        if (!best || v < best.ino) best = { ino: v, units: t, act: { type: 'exchange', from: u, to: w, hb: true }, ids: [u.id, w.id] };
      }
      for (let k = 0; k < pool.length; k++) {
        const sp = pool[k]; if (sp.val === u.val) continue;
        const t = cur.slice(); t[i] = Object.assign({}, sp, { origin: u.origin });
        const v = ino(t);
        const type = (legOf(u) === 'A' || legOf(u) === 'C') ? 'replace-y1' : 'replace-y2';
        if (!best || v < best.ino) best = { ino: v, units: t, act: { type, from: u, to: sp }, ids: [sp.id], k };
      }
    }
    if (!best || best.ino >= curIno - 1e-9) break;          // nothing improves any more
    cur = best.units; acts = acts.concat([best.act]);
    best.ids.forEach(id => moved.add(id));
    if (best.k != null) pool = pool.filter((_, k) => k !== best.k);   // a spare is used once
    states.push({ units: cur, acts, ino: best.ino });
  }
  const fmt = (st, budget) => {
    const isLeft = u => legOf(u) === 'A' || legOf(u) === 'C';
    return { swapCount: budget, actualSwaps: st.acts.length, sparesUsed: countSparesUsed(st.acts),
      y1: st.units.filter(isLeft), y2: st.units.filter(u => !isLeft(u)), acts: st.acts,
      steps: st.acts.length ? st.acts.map(describeSwap) : ['ไม่มีการสับเปลี่ยนที่ลดกระแส bridge ได้'],
      diff: st.ino, Ino_mA: st.ino };
  };
  const at = n => states[Math.min(n, states.length - 1)];
  return { baseIno: states[0].ino, swaps: [2, 4, 6].map(b => fmt(at(b), b)), full: fmt(states[states.length - 1], states.length - 1) };
}

// ═══════════════════════════════════════════════════════
// PHASE-AWARE YY SWAP (fixes Ino mismatch + "Ino unchanged" bugs)
// Moves: exchanges between any two positions (in-phase A↔A', same-side A↔B, cross-
// side A↔B' — v9.8; each unit moved at most once) and spare replacements. A moved unit takes the
// origin tag of its NEW position, so calcYYMetrics always groups it into the right
// phase string. Every candidate is scored by the real phasor I_no.
// ═══════════════════════════════════════════════════════
function phaseOf(item, isY2) {
  // Normalize origin to plain phase letter (strip prime). Spare has no phase.
  if (!item || item.origin === 'Spare') return null;
  return (item.origin || '').replace("'", '');
}

function findPhaseAwareYYSwaps(y1Swap, y2Swap, spare, lockedBaseline, systemKV, lockedY1Arr, lockedY2Arr, nameplate, swapMode, thresholdMA) {
  // v9.4 — swap logic RESTORED from v6.5 (field decision 2026-11: the v6.5 behaviour
  // tested best in the field), with two deliberate changes:
  //   (1) the relay threshold is the one the field engineer selects (thresholdMA),
  //       not a fixed 50 mA;
  //   (2) SPARE CONSERVATION — v6.5 preferred the plan using the MOST spares at equal
  //       I_no; v9.4 prefers the FEWEST, and (when both plans pass the relay) treats
  //       I_no within INO_TIE_MA as a tie so it doesn't burn spares for a few mA.
  //
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
  //  All visited states from BOTH tracks become candidates. Exchanges may pair any two
  //  positions (in-phase A↔A', same-side A↔B, cross-side A↔B' — v9.8), each physical
  //  unit moved at most once, never a failed unit.
  //  lockedY1Arr/lockedY2Arr are always included in every Ino evaluation but never
  //  moved. `swapMode` now carries options { maxDepth } (v9.6).
  const PHASES = ['A', 'B', 'C'];
  // v9.6 — `swapMode` (legacy, unused) now carries options: { maxDepth }. Default 6
  // (budgets 2/4/6). clientCalculate re-runs with a deeper search (e.g. 12) when 6
  // swaps can't pass or can't get the failed units out; the extra budget is MAXDEPTH.
  const OPTS = (swapMode && typeof swapMode === 'object') ? swapMode : {};
  const MAXDEPTH = Math.max(6, Math.min(16, Math.floor(OPTS.maxDepth) || 6));
  const targets = MAXDEPTH > 6 ? [2, 4, 6, MAXDEPTH] : [2, 4, 6];
  // v9.9 — TEMPORARY mode (field decision): when there are more failed units than good
  // spares, some failed units MUST stay in service. Then they may be MOVED (still at most
  // once each) to spread their deficit evenly so A=B=C on each side — the bank is usable
  // now; it is re-arranged properly when spares arrive. Ranking puts within-side balance
  // ahead of the per-unit overvoltage count in this mode (the stress is reported).
  const MOVE_FAILED = !!OPTS.moveFailed;
  const TOLS = (OPTS.balSum > 0) ? OPTS.balSum : BAL_SUM_DEFAULT;   // ΣC-per-phase tolerance (µF)
  const BALF = !!OPTS.balFirst;                 // v10.0 spare priority: balance first (field way)
  const scoreAt = (c, R) => Math.max(c.ino / R, c.spread / TOLS);
  const passAt  = (c, R) => c.ino < R && c.spread <= TOLS + 1e-9;
  const kv = systemKV || 69;
  const lockY1 = lockedY1Arr || [];
  const lockY2 = lockedY2Arr || [];
  const THR = (typeof thresholdMA === 'number' && thresholdMA > 0) ? thresholdMA : ALARM_MA;
  // Capacitor rating (v9.5). `nameplate` is a number (rated µF, legacy) or the spec
  // object { uf, minusPct, plusPct, ratedKV }. A unit OUTSIDE the tolerance band (either
  // side) is FAILED and is taken OUT first. Failed spares — including units pulled out
  // earlier — are never put back in service. If ratedKV is given, an arrangement that
  // loads any unit above UNIT_OV_LIMIT × rated is ranked behind one that doesn't.
  const HAS_NP = (typeof nameplate === 'number' && nameplate > 0) ||
                 (nameplate && typeof nameplate === 'object');
  const SPEC = HAS_NP ? capSpecOf(nameplate) : null;
  const NP = SPEC ? SPEC.uf : null;
  const RATED = SPEC ? SPEC.ratedKV : null;
  const badMemo = new WeakMap();    // v10.2 speed: tolerance check once per unit object
  function isBelow(u) {             // name kept from v6.5 — now means "out of tolerance"
    if (!SPEC || !u || u.origin === 'Spare') return false;
    let b = badMemo.get(u);
    if (b === undefined) { b = unitOutOfTolerance(u, SPEC); badMemo.set(u, b); }
    return b;
  }
  const goodSpare = s => !SPEC || !capValOutOfTol(s.val, SPEC);
  // relative deviation of a failed unit (scissored → its worse piece)
  const devMemo = new WeakMap();
  const devOf = u => { let d = devMemo.get(u); if (d === undefined) { d = unitDevOf(u, SPEC); devMemo.set(u, d); } return d; };

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
  const sameSidePairs = side => side.A.length * side.B.length + side.A.length * side.C.length + side.B.length * side.C.length;
  const nSingles = PHASES.reduce((t, ph) =>
    t + y1ByPhase[ph].length * y2ByPhase[ph].length +
    (y1ByPhase[ph].length + y2ByPhase[ph].length) * sparePool.length, 0) +
    sameSidePairs(y1ByPhase) + sameSidePairs(y2ByPhase) +
    PHASES.reduce((t, P) => t + PHASES.reduce((u, Q) => u + (P === Q ? 0 : y1ByPhase[P].length * y2ByPhase[Q].length), 0), 0);
  const small = nSingles <= 200;
  const KEEP1 = small ? Math.max(nSingles, 1) : 60;
  const BEAM  = small ? 40 : 24;

  // v10.2 (speed) — the optimizer scores ~10⁵ arrangements, and calcYYMetrics (array
  // filters, perPhase objects, Σ for display) was ~55 % of the run time. fastEval uses
  // the IDENTICAL formula and phase grouping (series C per phase = 1/Σ(1/C), locked
  // units included via precomputed inverse sums), straight from the phase arrays.
  // Every candidate is scored by the same function, so the ranking is unchanged; the
  // plans shown to the user are re-measured with calcYYMetrics in decorate().
  const phOf = u => (u.origin || '').replace("'", '');
  const lockInv1 = { A: 0, B: 0, C: 0 }, lockInv2 = { A: 0, B: 0, C: 0 };
  lockY1.forEach(u => { const p = phOf(u); if (lockInv1[p] !== undefined && u.val > 0) lockInv1[p] += 1 / u.val; });
  lockY2.forEach(u => { const p = phOf(u); if (lockInv2[p] !== undefined && u.val > 0) lockInv2[p] += 1 / u.val; });
  const lockSum1 = { A: 0, B: 0, C: 0 }, lockSum2 = { A: 0, B: 0, C: 0 };   // v10.3 ΣC per phase
  lockY1.forEach(u => { const p = phOf(u); if (lockSum1[p] !== undefined && u.val > 0) lockSum1[p] += u.val; });
  lockY2.forEach(u => { const p = phOf(u); if (lockSum2[p] !== undefined && u.val > 0) lockSum2[p] += u.val; });
  function sumOf(arr, base) { let s = base; for (let i = 0; i < arr.length; i++) { const v = arr[i].val; if (v > 0) s += v; } return s; }
  const VPH = kv / Math.sqrt(3);
  const COS_M = Math.cos(-2 * Math.PI / 3), COS_P = Math.cos(2 * Math.PI / 3);
  const SIN_M = Math.sin(-2 * Math.PI / 3), SIN_P = Math.sin(2 * Math.PI / 3);
  function invOf(arr, base) { let s = base; for (let i = 0; i < arr.length; i++) { const v = arr[i].val; if (v > 0) s += 1 / v; } return s; }
  function fastEval(cY1, cY2) {
    const i1 = invOf(cY1.A, lockInv1.A), i2 = invOf(cY1.B, lockInv1.B), i3 = invOf(cY1.C, lockInv1.C);
    const i4 = invOf(cY2.A, lockInv2.A), i5 = invOf(cY2.B, lockInv2.B), i6 = invOf(cY2.C, lockInv2.C);
    const CA1 = i1 > 0 ? 1 / i1 : 0, CB1 = i2 > 0 ? 1 / i2 : 0, CC1 = i3 > 0 ? 1 / i3 : 0;
    const CA2 = i4 > 0 ? 1 / i4 : 0, CB2 = i5 > 0 ? 1 / i5 : 0, CC2 = i6 > 0 ? 1 / i6 : 0;
    const S1 = PI2F * CA1 / 1e6, S2 = PI2F * CB1 / 1e6, S3 = PI2F * CC1 / 1e6;
    const S4 = PI2F * CA2 / 1e6, S5 = PI2F * CB2 / 1e6, S6 = PI2F * CC2 / 1e6;
    const sumS = S1 + S2 + S3 + S4 + S5 + S6;
    let Vnx = 0, Vny = 0;
    if (sumS > 0) {
      Vnx = (1 / sumS) * VPH * ((S1 + S4) + COS_M * (S2 + S5) + COS_P * (S3 + S6));
      Vny = (1 / sumS) * VPH * (0 * (S1 + S4) + SIN_M * (S2 + S5) + SIN_P * (S3 + S6));
    }
    const s123 = S1 + S2 + S3;
    const Inx = VPH * (S1 + S2 * COS_M + S3 * COS_P) - s123 * Vnx;
    const Iny = VPH * (0 * S1 + S2 * SIN_M + S3 * SIN_P) - s123 * Vny;
    const sp1 = Math.max(CA1, CB1, CC1) - Math.min(CA1, CB1, CC1);
    const sp2 = Math.max(CA2, CB2, CC2) - Math.min(CA2, CB2, CC2);
    // v10.3: balance = ΣC per phase within each side (field-sheet metric)
    const a1 = sumOf(cY1.A, lockSum1.A), b1 = sumOf(cY1.B, lockSum1.B), c1 = sumOf(cY1.C, lockSum1.C);
    const a2 = sumOf(cY2.A, lockSum2.A), b2 = sumOf(cY2.B, lockSum2.B), c2 = sumOf(cY2.C, lockSum2.C);
    const ss1 = Math.max(a1, b1, c1) - Math.min(a1, b1, c1), ss2 = Math.max(a2, b2, c2) - Math.min(a2, b2, c2);
    return { ino: Math.sqrt(Inx * Inx + Iny * Iny) * 1e6, spread: Math.max(ss1, ss2), spreadMin: Math.min(ss1, ss2),
             serSpread: Math.max(sp1, sp2) };
  }
  function inoOf(cY1, cY2) { return fastEval(cY1, cY2).ino; }
  const baseIno = inoOf(y1ByPhase, y2ByPhase);

  // Every visited state (from either track) is pushed here as a candidate.
  const candidates = [];
  function record(y1obj, y2obj, spareArr, actions, ino, fm) {
    // Count ONLY actions that actually consume a spare (v8.0 fix kept): `exchange`
    // and `piece-swap` use no spare and must not inflate sparesUsed.
    const spUsed = countSparesUsed(actions);
    const y1 = [...y1obj.A, ...y1obj.B, ...y1obj.C];
    const y2 = [...y2obj.A, ...y2obj.B, ...y2obj.C];
    // failed units still installed + v9.7 (G1) severity of what is LEFT (worst relative
    // deviation from rated C) — with too few spares, replace the WORST first.
    let below = 0, sev = 0;
    if (NP) {
      for (const arr of [y1, y2]) for (let i = 0; i < arr.length; i++) {
        const u = arr[i]; if (!isBelow(u)) continue;
        below++; const d = devOf(u); if (d > sev) sev = d;
      }
    }
    // v9.7: within-side balance (A=B=C per wye, series C) — the balance objective.
    const F = fm || fastEval(y1obj, y2obj);
    const spread = F.spread, spreadMin = F.spreadMin;   // v10.0: the better side too
    const ov = RATED ? unitVoltageStats([...y1, ...lockY1], [...y2, ...lockY2], kv, RATED).ovCount : 0;
    const cand = {
      ino, swaps: actions.length, sp: spUsed, below, ov, sev, spread, spreadMin,
      y1, y2, spare: spareArr.slice(),
      acts: actions.slice(),   // raw actions — UI pairs each swap to its units
      steps: null              // v10.2: built lazily in fmt() (only for plans shown)
    };
    candidates.push(cand);
    return cand;
  }
  record(y1ByPhase, y2ByPhase, sparePool, [], baseIno);

  function sig(st) {
    // multiset key (order is irrelevant) — v10.2: integer 1e-4 µF steps instead of
    // toFixed strings (same equality, ~4× cheaper; it ran for every generated state)
    const f = a => { const k = new Array(a.length); for (let i = 0; i < a.length; i++) k[i] = Math.round(a[i].val * 1e4);
                     k.sort((x, y) => x - y); return k.join(','); };
    return f(st.y1.A) + '|' + f(st.y1.B) + '|' + f(st.y1.C) + '#' +
           f(st.y2.A) + '|' + f(st.y2.B) + '|' + f(st.y2.C) + '@' + f(st.spare);
  }
  function clone(st) {
    return {
      y1: { A: st.y1.A.slice(), B: st.y1.B.slice(), C: st.y1.C.slice() },
      y2: { A: st.y2.A.slice(), B: st.y2.B.slice(), C: st.y2.C.slice() },
      spare: st.spare.slice(), actions: st.actions.slice(), ino: st.ino, fm: null
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
  // Equal-valued swaps are no-ops and are skipped (pure speed win).
  // Representatives: the first index of each DISTINCT value (non-scissored units).
  // Swapping any of several equal-valued units yields the same arrangement, so only
  // one is evaluated (v9.6 speed-up; the field result is identical).
  // goodOnly (exchanges): skip FAILED units — v9.7 user decision: a failed unit is
  // either replaced by a spare or left where it is; it is never moved to another
  // position to "spread" its deficit (that hides it and keeps it stressed).
  // moved (v9.8): ids already moved by this plan — each physical unit is moved at most
  // ONCE per plan (no detours through other phases; a technician moves a can once).
  function reps(arr, goodOnly, moved) {
    const seenV = new Set(), out = [];
    arr.forEach((u, i) => { if (isScis(u)) return; if (goodOnly && !MOVE_FAILED && isBelow(u)) return; if (moved && moved.has(u.id)) return;
      const k = u.val.toFixed(4); if (!seenV.has(k)) { seenV.add(k); out.push(i); } });
    return out;
  }
  function expand(st) {
    const kids = [];
    const movedIds = new Set();                      // v9.8 move-once
    st.actions.forEach(a => { if (a.type === 'exchange') { movedIds.add(a.from.id); movedIds.add(a.to.id); }
                              else if (a.type === 'piece-replace') movedIds.add(a.from.id + '.' + a.piece);
                              else if (a.type === 'piece-swap') { movedIds.add(a.u1.id + '.' + a.p1); movedIds.add(a.u2.id + '.' + a.p2); }
                              else if (a.to && a.to.id) movedIds.add(a.to.id); });
    const spReps = (() => { const seenV = new Set(), out = [];
      st.spare.forEach((u, k) => { if (!goodSpare(u)) return; const v = u.val.toFixed(4); if (!seenV.has(v)) { seenV.add(v); out.push(k); } });
      return out; })();
    for (const ph of PHASES) {
      const a1 = st.y1[ph], a2 = st.y2[ph], tag1 = ph, tag2 = ph + "'";
      const r1 = reps(a1), r2 = reps(a2), g1 = reps(a1, true, movedIds), g2 = reps(a2, true, movedIds);
      for (const i of g1) {
        for (const j of g2) {
          const u1 = a1[i], u2 = a2[j];
          if (u1.val === u2.val) continue;
          const c = clone(st);
          c.y1[ph] = a1.slice(); c.y2[ph] = a2.slice();
          c.y1[ph][i] = Object.assign({}, u2, { origin: tag1 });
          c.y2[ph][j] = Object.assign({}, u1, { origin: tag2 });
          c.fm = fastEval(c.y1, c.y2); c.ino = c.fm.ino;
          c.actions.push({ type: 'exchange', from: u1, to: u2 });
          kids.push(c);
        }
      }
      for (const i of r1) {
        for (const k of spReps) {
          const removed = a1[i], sp = st.spare[k];
          if (sp.val === removed.val || !goodSpare(sp)) continue;   // never install a failed unit
          const c = clone(st);
          c.y1[ph] = a1.slice();
          c.y1[ph][i] = Object.assign({}, sp, { origin: tag1 });
          c.spare = st.spare.slice();
          c.spare[k] = Object.assign({}, removed, { origin: 'Spare' });
          c.fm = fastEval(c.y1, c.y2); c.ino = c.fm.ino;
          c.actions.push({ type: 'replace-y1', from: removed, to: sp });
          kids.push(c);
        }
      }
      for (const j of r2) {
        for (const k of spReps) {
          const removed = a2[j], sp = st.spare[k];
          if (sp.val === removed.val || !goodSpare(sp)) continue;   // never install a failed unit
          const c = clone(st);
          c.y2[ph] = a2.slice();
          c.y2[ph][j] = Object.assign({}, sp, { origin: tag2 });
          c.spare = st.spare.slice();
          c.spare[k] = Object.assign({}, removed, { origin: 'Spare' });
          c.fm = fastEval(c.y1, c.y2); c.ino = c.fm.ino;
          c.actions.push({ type: 'replace-y2', from: removed, to: sp });
          kids.push(c);
        }
      }
    }

    // ── SAME-SIDE cross-phase exchanges (v9.6, F5) ──
    // In-phase exchanges (A↔A') can only MIRROR an imbalance across the two wyes; they
    // cannot balance a side. Swapping between phases of the SAME side (A↔B↔C on Y1,
    // A'↔B'↔C' on Y2) redistributes capacitance so A=B=C within a wye WITHOUT a spare.
    // (Cross-side cross-phase swaps such as A↔B' are generated separately below, v9.8.)
    // The moved unit takes the phase tag of its new position.
    for (const side of [1, 2]) {
      const S = side === 1 ? st.y1 : st.y2, sfx = side === 1 ? '' : "'";
      for (let p = 0; p < PHASES.length; p++) for (let q = p + 1; q < PHASES.length; q++) {
        const P = PHASES[p], Q = PHASES[q], aP = S[P], aQ = S[Q];
        const rP = reps(aP, true, movedIds), rQ = reps(aQ, true, movedIds);
        for (const i of rP) {
          for (const j of rQ) {
            const u1 = aP[i], u2 = aQ[j];
            if (u1.val === u2.val) continue;
            const c = clone(st), C = side === 1 ? c.y1 : c.y2;
            C[P] = aP.slice(); C[Q] = aQ.slice();
            C[P][i] = Object.assign({}, u2, { origin: P + sfx });
            C[Q][j] = Object.assign({}, u1, { origin: Q + sfx });
            c.fm = fastEval(c.y1, c.y2); c.ino = c.fm.ino;
            c.actions.push({ type: 'exchange', from: u1, to: u2 });
            kids.push(c);
          }
        }
      }
    }

    // ── CROSS-SIDE cross-phase exchanges (v9.8) ──
    // e.g. C (Y1) ↔ B' (Y2). Units share one rating, so this is one physical swap.
    // Before v9.8 the search could only reach this through a 3-step detour via other
    // phases (moving equal 27 µF units around for nothing); with move-once that detour
    // is impossible, so the direct move is generated here instead.
    for (const P of PHASES) for (const Q of PHASES) {
      if (P === Q) continue;                       // same phase = in-phase exchange above
      const aP = st.y1[P], aQ = st.y2[Q];
      const rP = reps(aP, true, movedIds), rQ = reps(aQ, true, movedIds);
      for (const i of rP) for (const j of rQ) {
        const u1 = aP[i], u2 = aQ[j];
        if (u1.val === u2.val) continue;
        const c = clone(st);
        c.y1[P] = aP.slice(); c.y2[Q] = aQ.slice();
        c.y1[P][i] = Object.assign({}, u2, { origin: P });
        c.y2[Q][j] = Object.assign({}, u1, { origin: Q + "'" });
        c.fm = fastEval(c.y1, c.y2); c.ino = c.fm.ino;
        c.actions.push({ type: 'exchange', from: u1, to: u2 });
        kids.push(c);
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
        if (movedIds.has(u.id + '.' + pc)) continue;            // v10.0: each piece position changed once
        const oldVal = pc === 'a' ? u.measuredA : u.measuredB;
        for (let k = 0; k < st.spare.length; k++) {
          const sp = st.spare[k];
          if (sp.val === oldVal || !goodSpare(sp)) continue;
          const c = clone(st);
          const nu = pc === 'a' ? pieceUnit(u, sp.val, u.measuredB) : pieceUnit(u, u.measuredA, sp.val);
          (loc.side === 1 ? c.y1 : c.y2)[loc.ph] = arrOf(st, loc).slice();
          arrOf(c, loc)[loc.i] = nu;
          c.spare = st.spare.slice();
          c.spare[k] = { id: u.id + '.' + pc, val: oldVal, origin: 'Spare', pos: sp.pos, pulledPiece: true };
          c.fm = fastEval(c.y1, c.y2); c.ino = c.fm.ino;
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
          if (movedIds.has(uA.id + '.' + pa) || movedIds.has(uB.id + '.' + pb)) continue;   // v10.0 move-once
          const va = pa === 'a' ? uA.measuredA : uA.measuredB;
          const vb = pb === 'a' ? uB.measuredA : uB.measuredB;
          if (va === vb) continue;
          if (!MOVE_FAILED && SPEC && (capValOutOfTol(va, SPEC) || capValOutOfTol(vb, SPEC))) continue;   // never move a failed piece (except temp mode)
          const c = clone(st);
          (A.side === 1 ? c.y1 : c.y2)[A.ph] = arrOf(st, A).slice();
          (B.side === 1 ? c.y1 : c.y2)[B.ph] = arrOf(st, B).slice();
          arrOf(c, A)[A.i] = pa === 'a' ? pieceUnit(uA, vb, uA.measuredB) : pieceUnit(uA, uA.measuredA, vb);
          arrOf(c, B)[B.i] = pb === 'a' ? pieceUnit(uB, va, uB.measuredB) : pieceUnit(uB, uB.measuredA, va);
          c.fm = fastEval(c.y1, c.y2); c.ino = c.fm.ino;
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
    spare: sparePool.slice(), actions: [], ino: baseIno
  };
  let beam = [init];
  const seen = new Set([sig(init)]);
  for (let d = 1; d <= MAXDEPTH; d++) {
    let kids = [];
    for (const st of beam) kids = kids.concat(expand(st));
    const uniq = [];
    for (const k of kids) {
      const s = sig(k);
      if (!seen.has(s)) { seen.add(s); uniq.push(k); const cd = record(k.y1, k.y2, k.spare, k.actions, k.ino, k.fm); k.below = cd.below; k.ov = cd.ov; k.sev = cd.sev; k.spread = cd.spread; k.spreadMin = cd.spreadMin; }
    }
    // v9.6 (F4): keep BOTH the states that get failed units out (even if I_no rises
    // for now — removing a failure can unmask another) AND the lowest-I_no states.
    const cap = d === 1 ? KEEP1 : BEAM;
    // v9.7: thirds — failed-out (count, severity, overvoltage), within-side balance,
    // and lowest I_no — so balancing paths survive even while I_no is still high.
    const byFail = uniq.slice().sort((a, b) => (a.below - b.below) || (a.sev - b.sev) || (a.ov - b.ov)
                                               || (scoreAt(a, THR) - scoreAt(b, THR)) || (a.spreadMin - b.spreadMin) || (a.ino - b.ino));
    // v10.3: thirds — failed-out, the EQUAL-WEIGHT score max(I_no/ref, ΔΣC/tol), and ΣC balance
    const byScore = uniq.slice().sort((a, b) => (scoreAt(a, THR) - scoreAt(b, THR)) || (a.spreadMin - b.spreadMin) || (a.ino - b.ino));
    const bySpr  = uniq.slice().sort((a, b) => (a.spread - b.spread) || (a.spreadMin - b.spreadMin) || (a.ino - b.ino));
    const third = Math.ceil(cap / 3), pickSet = new Set();
    beam = [];
    for (const L of [byFail, byScore, bySpr]) {
      let n = 0;
      for (const k of L) { if (n >= third || beam.length >= cap) break; if (!pickSet.has(k)) { pickSet.add(k); beam.push(k); n++; } }
    }
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
      sp.forEach((s, k) => { if (!goodSpare(s)) return; const dd = Math.abs(s.val - best.mode); if (dd < bd) { bd = dd; bk = k; } });
      if (bk < 0) break;
      const arr = best.side === 1 ? cy1[best.ph] : cy2[best.ph];
      const removed = arr[best.idx], spUnit = sp[bk], tag = removed.origin;
      arr[best.idx] = Object.assign({}, spUnit, { origin: tag });
      sp = sp.slice(); sp[bk] = Object.assign({}, removed, { origin: 'Spare' });
      actions.push({ type: best.side === 1 ? 'replace-y1' : 'replace-y2', from: removed, to: spUnit });
      record(cy1, cy2, sp, actions, inoOf(cy1, cy2));
    }
  })();

  // ── merge: best candidate per budget (v9.7) ──
  // 1. FEWEST failed units left installed (v6.5)
  // 2. LEAST SEVERE failed units left (G1) — with too few spares, replace the worst
  // 3. no unit above UNIT_OV_LIMIT × rated voltage (v9.5)
  // 4. passes the I_no ref
  // 5. if it passes: WITHIN-SIDE BALANCE FIRST (A=B=C per wye ≤ PHASE_SPREAD_UF;
  //    if neither is balanced, the tighter spread beyond SPREAD_TIE_UF) → then least
  //    work: fewest spares → fewest swaps → lowest I_no            (user decision)
  //    if it doesn't: lowest I_no (closest to safe) → spares → swaps
  // v10.3 — I_no and within-side ΣC balance have EQUAL weight (user decision 2026-11-17):
  //   score(R) = max(I_no / R, ΔΣC / TOLS)   — ≤ 1 (I_no < R AND ΔΣC ≤ TOLS) = both pass.
  // Safety keeps its place per spare-priority mode:
  //   'failed'  : failed left → sev → overvoltage → both pass → score → effort
  //   'balance' : both pass → score → failed left → sev → overvoltage → effort
  //   temp mode (moveFailed): failed → sev → both pass → score → overvoltage → effort
  // Among passing plans: fewest spares → fewest swaps → lower score. Not passing: the
  // lower score (± SCORE_TIE) first — the plan that is closest to BOTH targets.
  function betterAt(c, best, R) {
    const cp = passAt(c, R), bp = passAt(best, R), sc = scoreAt(c, R), sb = scoreAt(best, R);
    const work = () => (c.sp !== best.sp) ? c.sp < best.sp : (c.swaps !== best.swaps ? c.swaps < best.swaps : sc < sb);
    const other = () => (!cp && Math.abs(c.spreadMin - best.spreadMin) > OTHER_TIE_UF) ? (c.spreadMin < best.spreadMin) : null;
    if (BALF) {
      if (cp !== bp) return cp;
      if (!cp && Math.abs(sc - sb) > SCORE_TIE) return sc < sb;
      { const o = other(); if (o !== null) return o; }
      if (NP && c.below !== best.below) return c.below < best.below;
      if (Math.abs(c.sev - best.sev) > 1e-9) return c.sev < best.sev;
      if (c.ov !== best.ov) return c.ov < best.ov;
      return work();
    }
    if (NP && c.below !== best.below) return c.below < best.below;
    if (Math.abs(c.sev - best.sev) > 1e-9) return c.sev < best.sev;
    if (!MOVE_FAILED && c.ov !== best.ov) return c.ov < best.ov;
    if (cp !== bp) return cp;
    if (!cp && Math.abs(sc - sb) > SCORE_TIE) return sc < sb;
    { const o = other(); if (o !== null) return o; }
    if (MOVE_FAILED && c.ov !== best.ov) return c.ov < best.ov;
    return work();
  }
  function better(c, best) { return betterAt(c, best, THR); }
  function pick(maxSwaps) {
    let best = candidates[0];
    for (const c of candidates) {
      if (c.swaps > maxSwaps) continue;
      if (better(c, best)) best = c;
    }
    return best;
  }
  const fmt = (b, swapCount) => ({
    swapCount,
    actualSwaps: b.swaps,
    diff: b.ino,            // = Ino in mA
    Ino_mA: b.ino,
    sparesUsed: b.sp,
    y1: b.y1, y2: b.y2, spare: b.spare,
    acts: b.acts,           // raw actions — UI pairs each swap to its units
    steps: b.steps || (b.acts.length ? b.acts.map(describeSwap) : ['ไม่มีการสับเปลี่ยนที่ลด Ino ได้'])
  });
  const results = targets.map(target => fmt(pick(target), target));

  // ── I_no reference comparison (v9.5) ──
  // For each reference r: the LEAST-EFFORT plan that gets I_no below r — with the
  // failed units out as far as the good spares allow (= the fewest failed left of any
  // candidate) and no unit overvoltaged. Least effort = fewest swaps, then fewest
  // spares, then lowest I_no. null = not reachable within MAXDEPTH swaps.
  const minBelow = candidates.reduce((m, c) => Math.min(m, c.below), Infinity);
  const minSev = candidates.filter(c => c.below === minBelow).reduce((m, c) => Math.min(m, c.sev), Infinity);
  // v10.1 — TWO tables per ref r:
  //  • refBest[r]  (drives the default recommendation): balance-first → least work.
  //  • refPlans[r] (the comparison table the field picks from): the LEAST WORK that
  //    gets I_no < r (fewest swaps → fewest spares), and among equal work the plan
  //    CLOSEST to r (highest I_no still below it) — so each row is a real option
  //    (<50 ≈ 48 mA in 2 swaps … <5 ≈ 4 mA in 7) instead of one plan repeated.
  //    Both keep the safety rules: failed out as far as possible, no overvoltage.
  // v10.3 — both tables need I_no < r AND ΔΣC ≤ TOLS (equal weight, user decision).
  //  • refPlans[r] (comparison table): least work (swaps → spares), then the plan CLOSEST
  //    to r (highest I_no still below it). If no plan meets both, the row falls back to
  //    the plan with the lowest score(r) (closest to both targets), flagged `fallback`.
  //  • refBest[r] (default recommendation): betterAt(…, r) — null if nothing passes both.
  const refBest = {}, refPlans = {};
  INO_REF_LIST.forEach(r => {
    const safe = candidates.filter(c => c.below === minBelow && c.sev <= minSev + 1e-9 && (MOVE_FAILED || c.ov === 0));
    const ok = safe.filter(c => passAt(c, r));
    let fb = null;
    if (ok.length) {
      for (const c of ok) if (!fb || c.swaps < fb.swaps || (c.swaps === fb.swaps && (c.sp < fb.sp || (c.sp === fb.sp && c.ino > fb.ino)))) fb = c;
      refPlans[r] = fmt(fb, fb.swaps);
    } else if (safe.length) {
      for (const c of safe) {
        if (!fb) { fb = c; continue; }
        const d = scoreAt(c, r) - scoreAt(fb, r);
        const dm = c.spreadMin - fb.spreadMin;
        const tie = Math.abs(d) <= SCORE_TIE, otherTie = Math.abs(dm) <= OTHER_TIE_UF;
        const lessWork = c.swaps < fb.swaps || (c.swaps === fb.swaps && (c.sp < fb.sp || (c.sp === fb.sp && d < 0)));
        if (d < -SCORE_TIE || (tie && dm < -OTHER_TIE_UF) || (tie && otherTie && lessWork)) fb = c;
      }
      refPlans[r] = Object.assign(fmt(fb, fb.swaps), { fallback: true });
    } else refPlans[r] = null;

    const elig = candidates.filter(c => (BALF || (c.below === minBelow && c.sev <= minSev + 1e-9)) && (MOVE_FAILED || c.ov === 0));
    let b = null;
    for (const c of elig) if (!b || betterAt(c, b, r)) b = c;
    refBest[r] = (b && passAt(b, r)) ? fmt(b, b.swaps) : null;
  });
  return { baseDiff: baseIno, baseIno, swaps: results, refPlans, refBest, minBelow, maxDepth: MAXDEPTH };
}

window._calcYYMetrics     = calcYYMetrics;
window._calcHBridgeMetrics= calcHBridgeMetrics;


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

async function clientCalculate(payload) {
  const {topology, y1, y2, spare, legs, systemKV, alarmMA, capRating, balSumUF, sparePriority} = payload;
  // v10.0 — balance target (ΣC difference per rack, field-sheet style) → series tolerance;
  // spare priority 'balance' (field way, default) or 'failed' (worst failed out first).
  const BAL_SUM_UF = (parseFloat(balSumUF) > 0) ? parseFloat(balSumUF) : BAL_SUM_DEFAULT;
  const BAL_SUM_TOL = BAL_SUM_UF;                                   // ΣC per phase (ranking)
  const BAL_FIRST = sparePriority ? sparePriority === 'balance' : false;
  // series-C equivalent of the ΣC tolerance (ΔC_series ≈ ΔΣC / n²) — reference only
  const SER_TOL = (() => {
    const cnt = {}; [...(y1 || []), ...(y2 || [])].forEach(u => { cnt[u.origin] = (cnt[u.origin] || 0) + 1; });
    const ns = Object.values(cnt), n = ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 10;
    return BAL_SUM_UF / (n * n);
  })();
  const kv = parseFloat(systemKV) || 69;
  // Capacitor rating from Step 2 (v9.5): rated µF, tolerance band, unit rated kV.
  // Falls back to NAMEPLATE_UF / IEC 60871-1 −5 %…+10 % / no voltage check.
  const CAP = capSpecOf(capRating || NAMEPLATE_UF);
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
    const hb1 = findHBridgeSwaps([...aT1, ...cT1, ...bT1, ...dT1], [...aT2, ...bT2, ...cT2, ...dT2], spare || [], kv, 12);
    quickResult = { baseDiff: hb1.baseIno, baseIno: hb1.baseIno, swaps: hb1.swaps };
    fullResult  = hb1.full;

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
      const hb2 = findHBridgeSwaps([...aF, ...bF, ...cF, ...dF], [], spare || [], kv, 12);
      const t2Quick = { swaps: hb2.swaps }, t2Full = hb2.full;
      t2Quick.swaps.forEach(sw => {
        const f = reassembleLegs(sw.y1, sw.y2, true);
        sw.engAfter = calcHBridgeMetrics(f.finalA, f.finalB, f.finalC, f.finalD, kv);
        sw.Ino_mA = sw.engAfter.In_mA;
        sw.underThreshold = sw.Ino_mA < THRESHOLD_MA;
        sw.y1Full = [...f.finalA, ...f.finalC];
        sw.y2Full = [...f.finalB, ...f.finalD];
        sw.tier = 2;
      });
      {
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
      ? `ช่องที่สลับได้ ${t1Count} ช่อง · ช่องกรุ๊ปขนาน ${t2Count} ช่อง · spare ${(spare||[]).length} ลูก` +
        (quickResult.fallbackUsed ? ' · ต้องสลับช่องกรุ๊ปขนานด้วย' : '') +
        (hasScissors && t2Count > 0 ? ' · มีช่องวัดแยก ระบบจึงสับเฉพาะช่องวัดแยกกับ spare' : '')
      : null;
  } else {
    const y1Flat = expandPairs(y1);
    const y2Flat = expandPairs(y2);
    engBefore   = calcYYMetrics(y1Flat, y2Flat, kv);
    engBefore.spread = sumSpreadOf(engBefore, BAL_SUM_TOL);     // v10.3: within-side ΣC per phase (field-sheet metric)
    engBefore.serSpread = phaseSpreadOf(engBefore, SER_TOL);

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

    // ── Nameplate-failure priority + multi-level swap strategy (v6.5, restored v9.4) ──
    // A unit reading < NAMEPLATE_UF (27.00 µF) is treated as FAILED (field rule) and
    // swapped FIRST; units ≥ nameplate are "good" and kept in place. Order of levels:
    //   L0: failed Tier-1 units only        (good + grouped LOCKED)
    //   L1: all Tier-1 units                 (grouped LOCKED)
    //   L2: + grouped Tier-2 units           (skipped when scissors used)
    // For each budget we pick the LEAST-disruptive level that meets the (field-selected)
    // threshold; if none meets it, the lowest I_no. NEVER changes the I_no calc.
    const hasScissors = y1Flat.some(x => x.isSplit) || y2Flat.some(x => x.isSplit);
    // FAILED = outside the tolerance band of rated C (either side), v9.5.
    function isFailedUnit(x) { return unitOutOfTolerance(x, CAP); }
    function sumByPhase(arr) {
      const m = { A: 0, B: 0, C: 0 };
      arr.forEach(x => { const p = (x.origin||'').replace("'",''); if (m[p] !== undefined) m[p] += x.val; });
      return m;
    }
    function runPass(swapY1, swapY2, lockY1, lockY2, level, depth, moveFailed) {
      const baseline = { y1ByPhase: sumByPhase(lockY1), y2ByPhase: sumByPhase(lockY2) };
      const res = findPhaseAwareYYSwaps(swapY1, swapY2, spare || [], baseline, kv, lockY1, lockY2, CAP,
                                        { maxDepth: depth, moveFailed: !!moveFailed, balSum: BAL_SUM_TOL, balFirst: BAL_FIRST }, THRESHOLD_MA);
      function decorate(sw) {
        if (!sw) return sw;
        const fullY1 = [...sw.y1, ...lockY1];
        const fullY2 = [...sw.y2, ...lockY2];
        sw.engAfter = calcYYMetrics(fullY1, fullY2, kv);
        sw.Ino_mA = sw.engAfter.Ino_mA;
        sw.underThreshold = sw.Ino_mA < THRESHOLD_MA;
        sw.spread = sumSpreadOf(sw.engAfter, BAL_SUM_TOL);   // v10.3: ΣC per phase within each side
        sw.serSpread = phaseSpreadOf(sw.engAfter, SER_TOL);  // series C spread (kept for reference)
        sw.spreadOK = sw.spread.ok;
        sw.fullyPass = sw.underThreshold && sw.spreadOK;
        sw.score = Math.max(sw.Ino_mA / THRESHOLD_MA, sw.spread.max / BAL_SUM_TOL);
        sw.unitV = unitVoltageStats(fullY1, fullY2, kv, CAP.ratedKV);   // v9.5
        sw.overV = sw.unitV.ovCount > 0;
        sw.y1Full = fullY1; sw.y2Full = fullY2;
        sw.level = level;
        sw.tier = level >= 2 ? 2 : 1;
        return sw;
      }
      res.swaps.forEach(decorate);
      Object.values(res.refPlans || {}).forEach(decorate);
      Object.values(res.refBest || {}).forEach(decorate);
      return res;
    }

    const y1Fail = y1Tier1.filter(isFailedUnit), y1Good = y1Tier1.filter(x => !isFailedUnit(x));
    const y2Fail = y2Tier1.filter(isFailedUnit), y2Good = y2Tier1.filter(x => !isFailedUnit(x));

    function buildLevels(depth) {
      const lv = [];
      // L0 — failed Tier-1 only
      lv.push(runPass(y1Fail, y2Fail, [...y1Good, ...y1Tier2], [...y2Good, ...y2Tier2], 0, depth));
      // L1 — all Tier-1 (only if there ARE good units to add; else identical to L0)
      if (y1Good.length + y2Good.length > 0) {
        lv.push(runPass(y1Tier1, y2Tier1, y1Tier2, y2Tier2, 1, depth));
      }
      // L2 — + grouped Tier-2 (skip when scissors used)
      if (!hasScissors && (y1Tier2.length + y2Tier2.length) > 0) {
        lv.push(runPass([...y1Tier1, ...y1Tier2], [...y2Tier1, ...y2Tier2], [], [], 2, depth));
      }
      return lv;
    }
    let levels = buildLevels(BASE_DEPTH);

    // Count failed (below-nameplate) units still installed in an arrangement.
    // Removed units sit in the spare pool (origin 'Spare') and don't count.
    function failRemain(sw) {
      let n = 0;
      [...(sw.y1Full || []), ...(sw.y2Full || [])].forEach(u => { if (u.origin !== 'Spare' && isFailedUnit(u)) n++; });
      return n;
    }
    // G1 (v9.7): how bad are the failed units still installed (worst relative deviation)
    function failSev(sw) {
      const dev = u => unitDevOf(u, CAP);
      return [...(sw.y1Full || []), ...(sw.y2Full || [])]
        .filter(u => u.origin !== 'Spare' && isFailedUnit(u)).reduce((m, u) => Math.max(m, dev(u)), 0);
    }
    const sprOf = sw => (sw.spread && isFinite(sw.spread.max)) ? sw.spread.max : Infinity;
    const balOf = sw => sprOf(sw) <= BAL_SUM_TOL + 1e-9;
    // v10.3 equal-weight score at ref R and "both pass"
    const scoreR = (sw, R) => Math.max(sw.Ino_mA / R, sprOf(sw) / BAL_SUM_TOL);
    const bothR  = (sw, R) => sw.Ino_mA < R && balOf(sw);
    // Per budget, in priority order matching the field procedure:
    //   1. get the FAILED (out-of-tolerance) units OUT — fewest left installed
    //   2. no unit above 110 % of rated voltage (v9.5)
    //   3. meet the (field-selected) threshold — "ผ่านแล้วหยุด"
    //   4a. if it passes: least disruptive (lower level) → fewest spares → swaps → I_no
    //   4b. if NOTHING passes (v9.6, F1): LOWEST I_no first (closest to safe) → spares
    //       → swaps → level. (v6.5 ranked the lower level first even then, so a failed-
    //       only L0 plan at 307 mA beat an L1 plan at 188 mA.)
    // v10.3 — one comparator for budgets and the default-recommendation table (mirrors
    // betterAt() in the optimizer): equal-weight score max(I_no/R, ΔΣC/tol).
    function cmpPlans(a, b, R, useLevel) {
      const pa = bothR(a, R), pb = bothR(b, R), sa = scoreR(a, R), sb = scoreR(b, R);
      const safety = () => (a._fail - b._fail) || ((Math.abs(a._sev - b._sev) > 1e-9) ? a._sev - b._sev : 0)
                        || ((a.overV ? 1 : 0) - (b.overV ? 1 : 0));
      const om = sw => (sw.spread && isFinite(sw.spread.min)) ? sw.spread.min : Infinity;
      const passFirst = () => ((pb ? 1 : 0) - (pa ? 1 : 0)) || (!pa && Math.abs(sa - sb) > SCORE_TIE ? sa - sb : 0)
                           || (!pa && Math.abs(om(a) - om(b)) > OTHER_TIE_UF ? om(a) - om(b) : 0);
      const effort = () => (useLevel && pa ? a.level - b.level : 0) || (a.sparesUsed || 0) - (b.sparesUsed || 0)
                        || a.actualSwaps - b.actualSwaps || (sa - sb) || (useLevel ? a.level - b.level : 0);
      return BAL_FIRST ? (passFirst() || safety() || effort()) : (safety() || passFirst() || effort());
    }
    function chooseBudget(i) {
      const cands = levels.map(p => p.swaps[i]).filter(Boolean);
      cands.forEach(c => { c._fail = failRemain(c); c._sev = failSev(c); });
      cands.sort((a, b) => cmpPlans(a, b, THRESHOLD_MA, true));
      return cands[0];
    }
    const pickBudgets = () => levels[0].swaps.map((_, i) => chooseBudget(i));
    let budgetPicks = pickBudgets();
    // F2 (v9.6) — adaptive depth: if no budget passes, or failed units are still
    // installed while GOOD spares remain, re-run the search deeper (up to EXT_DEPTH).
    // Banks that already pass at 6 pay no extra time.
    {
      const best = budgetPicks[budgetPicks.length - 1];
      const goodSp = (spare || []).filter(sp => !capValOutOfTol(sp.val, CAP)).length;
      const needMore = !budgetPicks.some(sw => sw.underThreshold) ||
                       (best._fail > 0 && goodSp > (best.sparesUsed || 0)) ||
                       !balOf(best) ||                                // v9.7: balance not reached yet
                       // v10.3: a comparison-table row can't meet I_no AND ΣC yet → search deeper
                       INO_REF_LIST.some(r => !levels.some(p => p.refPlans && p.refPlans[r] && !p.refPlans[r].fallback));
      // v9.9: deep enough to replace every failed unit AND still balance (cap 16)
      const nF = [...y1Flat, ...y2Flat].filter(isFailedUnit).length;
      const extD = Math.min(TEMP_DEPTH, Math.max(EXT_DEPTH, Math.min(nF, goodSp) + 4));
      if (needMore) { levels = buildLevels(extD); budgetPicks = pickBudgets(); }
    }
    quickResult = { baseDiff: levels[0].baseIno, baseIno: levels[0].baseIno, swaps: budgetPicks,
                    maxDepth: levels[0].maxDepth, extended: levels[0].maxDepth > BASE_DEPTH };
    // ── I_no reference comparison (v9.5) — least effort to get below each ref ──
    // Merge the per-level plans: fewest failed left → no overvoltage → fewest swaps →
    // fewest spares → lowest level → lowest I_no. "best value" = the TIGHTEST ref that
    // costs no more work (swaps, then spares) than the cheapest reachable ref.
    // v10.1 — comparison table (field options): fewest failed left → sev → no overvoltage
    // → fewest swaps → fewest spares → CLOSEST to the ref (highest I_no below it) → level.
    quickResult.refTable = INO_REF_LIST.map(r => {
      const cands = levels.map(p => p.refPlans && p.refPlans[r]).filter(Boolean);
      cands.forEach(c => { c._fail = failRemain(c); c._sev = failSev(c); });
      cands.sort((a, b) => a._fail - b._fail || (a._sev - b._sev) || ((a.overV ? 1 : 0) - (b.overV ? 1 : 0))
        || ((bothR(b, r) ? 1 : 0) - (bothR(a, r) ? 1 : 0))
        || (bothR(a, r)
            ? (a.actualSwaps - b.actualSwaps || (a.sparesUsed || 0) - (b.sparesUsed || 0) || b.Ino_mA - a.Ino_mA || a.level - b.level)
            : ((Math.abs(scoreR(a, r) - scoreR(b, r)) > SCORE_TIE ? scoreR(a, r) - scoreR(b, r) : 0)
               || (Math.abs(a.spread.min - b.spread.min) > OTHER_TIE_UF ? a.spread.min - b.spread.min : 0)
               || a.actualSwaps - b.actualSwaps || (a.sparesUsed || 0) - (b.sparesUsed || 0) || scoreR(a, r) - scoreR(b, r))));
      const p = cands[0] || null;
      return { ref: r, plan: p, fallback: !!(p && !bothR(p, r)) };   // v10.3: fallback = closest, not passing both
    });
    // Default-recommendation table (balance-first → least work), v9.7 rule.
    quickResult.refBest = INO_REF_LIST.map(r => {
      const cands = levels.map(p => p.refBest && p.refBest[r]).filter(Boolean);
      cands.forEach(c => { c._fail = failRemain(c); c._sev = failSev(c); });
      cands.sort((a, b) => cmpPlans(a, b, r, true));
      return { ref: r, plan: cands[0] || null };
    });
    {
      const ok = quickResult.refTable.filter(row => row.plan && !row.fallback);
      if (ok.length) {
        // 🛠 least work = cheapest plan (fewest swaps, then spares) — its tightest ref row.
        const cost = p => p.actualSwaps * 1000 + (p.sparesUsed || 0);
        const minCost = Math.min(...ok.map(row => cost(row.plan)));
        const least = ok.filter(row => cost(row.plan) === minCost).sort((a, b) => a.ref - b.ref)[0];
        least.leastWork = true;
        const minSw = least.plan.actualSwaps, ino0 = least.plan.Ino_mA;
        // ⭐ best value = the extra-effort plan with the largest I_no reduction PER EXTRA
        //    SWAP vs the least-work plan, if that rate is ≥ INO_WORTH_MA_PER_SWAP;
        //    otherwise the least-work plan itself. Rows sharing a plan → tightest ref.
        let best = least, bestRate = -Infinity;
        ok.forEach(row => {
          row.extraSwaps = row.plan.actualSwaps - minSw;
          row.gainPerSwap = row.extraSwaps > 0 ? (ino0 - row.plan.Ino_mA) / row.extraSwaps : null;
          if (row.gainPerSwap != null && row.gainPerSwap >= INO_WORTH_MA_PER_SWAP &&
              (row.gainPerSwap > bestRate + 1e-9 || (Math.abs(row.gainPerSwap - bestRate) <= 1e-9 && row.ref < best.ref))) {
            best = row; bestRate = row.gainPerSwap;
          }
        });
        best.bestValue = true;
      }
    }
    // ── v9.8 (#4): too few GOOD spares to ever pass → recommend only the useful work ──
    // If nothing passes even after the deep search AND there are more failed units
    // than good spares, extra in-rack shuffling now is wasted labour (the bank must
    // wait for spares and be re-arranged anyway). The plan becomes: replace the WORST
    // failed units with the good spares on hand, and report how many more are needed.
    {
      const anyPass = budgetPicks.some(sw => sw.underThreshold) || quickResult.refTable.some(r => r.plan && !r.fallback) || quickResult.refBest.some(r => r.plan);
      const goodSp = (spare || []).filter(sp => !capValOutOfTol(sp.val, CAP))
        .sort((a, b) => Math.abs(a.val - CAP.uf) - Math.abs(b.val - CAP.uf));
      const nFailedTotal = [...y1Flat, ...y2Flat].filter(isFailedUnit).length;
      if (!anyPass && nFailedTotal > goodSp.length) {
        const isPair = u => u.measuredA != null && u.measuredB != null;
        const pool = (hasScissors ? [...y1Tier1, ...y2Tier1] : [...y1Flat, ...y2Flat])
          .filter(u => isFailedUnit(u) && !isPair(u));     // scissored pairs: piece-level, left to the full plan
        const dev = u => unitDevOf(u, CAP);
        const worst = pool.slice().sort((a, b) => dev(b) - dev(a)).slice(0, goodSp.length);
        const y1F = y1Flat.slice(), y2F = y2Flat.slice(), acts = [];
        worst.forEach((u, k) => {
          const sp = goodSp[k], onY1 = y1F.includes(u), arr = onY1 ? y1F : y2F;
          arr[arr.indexOf(u)] = Object.assign({}, sp, { origin: u.origin });
          acts.push({ type: onY1 ? 'replace-y1' : 'replace-y2', from: u, to: sp });
        });
        const m = calcYYMetrics(y1F, y2F, kv);
        const sw = { swapCount: acts.length, actualSwaps: acts.length, sparesUsed: acts.length,
          y1: y1F, y2: y2F, y1Full: y1F, y2Full: y2F, acts,
          steps: acts.length ? acts.map(describeSwap) : ['ไม่มี spare ที่ดีให้เปลี่ยน'],
          engAfter: m, Ino_mA: m.Ino_mA, diff: m.Ino_mA, underThreshold: m.Ino_mA < THRESHOLD_MA,
          spread: sumSpreadOf(m, BAL_SUM_TOL), serSpread: phaseSpreadOf(m, SER_TOL), unitV: unitVoltageStats(y1F, y2F, kv, CAP.ratedKV), level: 0, tier: 1 };
        sw.spreadOK = sw.spread.ok; sw.fullyPass = sw.underThreshold && sw.spreadOK; sw.overV = sw.unitV.ovCount > 0;
        sw._fail = failRemain(sw); sw._sev = failSev(sw);
        quickResult.sparesOnly = sw;
        quickResult.sparesShort = nFailedTotal - goodSp.length;
        quickResult.failedTotal = nFailedTotal;
      }
    }
    // ── v9.9: TEMPORARY arrangement when good spares can't replace every failed unit ──
    // Field decision: time on site is limited and the bank must go back in service now,
    // so if failed units must stay, MOVE them (each at most once) to spread their deficit
    // so A=B=C on each side and I_no is as low as possible. Spares replace the WORST
    // failed units first (severity ranking). Only used when the normal plan (failed units
    // never moved) is not already passing AND balanced.
    {
      const nGoodSp = (spare || []).filter(sp => !capValOutOfTol(sp.val, CAP)).length;
      const nFailedTotal = [...y1Flat, ...y2Flat].filter(isFailedUnit).length;
      const normBest = budgetPicks[budgetPicks.length - 1];
      const normOK = budgetPicks.some(sw => sw.underThreshold && balOf(sw));
      if (nFailedTotal > nGoodSp && !normOK) {
        const lvT = (!hasScissors && (y1Tier2.length + y2Tier2.length) > 0)
          ? runPass([...y1Tier1, ...y1Tier2], [...y2Tier1, ...y2Tier2], [], [], 2, TEMP_DEPTH, true)
          : runPass(y1Tier1, y2Tier1, y1Tier2, y2Tier2, 1, TEMP_DEPTH, true);
        const ts = lvT.swaps.filter(Boolean);
        ts.forEach(c => { c._fail = failRemain(c); c._sev = failSev(c); });
        // least work that is passing + balanced; else the deepest (best-ranked) plan
        let tp = ts.find(c => c.underThreshold && balOf(c)) || ts[ts.length - 1];
        const key = c => [bothR(c, THRESHOLD_MA) ? 0 : 1, scoreR(c, THRESHOLD_MA), c.Ino_mA];   // v10.3
        const lessThan = (a, b) => { const ka = key(a), kb = key(b);
          for (let i = 0; i < ka.length; i++) { if (Math.abs(ka[i] - kb[i]) > 1e-9) return ka[i] < kb[i]; } return false; };
        if (tp && (!normBest || lessThan(tp, normBest))) {
          tp.tempMove = true;
          tp.movedFailed = (tp.acts || []).filter(a => (a.type === 'exchange' && (isFailedUnit(a.from) || isFailedUnit(a.to))) ||
                                                      (a.type === 'piece-swap' && (capValOutOfTol(a.v1, CAP) || capValOutOfTol(a.v2, CAP)))).length;
          quickResult.tempPlan = tp;
          quickResult.sparesShort = nFailedTotal - nGoodSp;
          quickResult.failedTotal = nFailedTotal;
        }
      }
    }
    quickResult.usedGood     = quickResult.swaps.some(sw => sw.level >= 1);
    quickResult.usedSpare    = quickResult.swaps.some(sw => sw.sparesUsed > 0);
    quickResult.fallbackUsed = quickResult.swaps.some(sw => sw.level >= 2);

    fullResult = Object.assign({}, quickResult.swaps[quickResult.swaps.length - 1]);
    fullResult.swapCount = fullResult.actualSwaps;

    // Info note
    const tier1Count = y1Tier1.length + y2Tier1.length;
    const tier2Count = y1Tier2.length + y2Tier2.length;
    const sCount = (spare||[]).length;
    const nFail = y1Fail.length + y2Fail.length;
    const goodSpare = (spare || []).filter(s => !capValOutOfTol(s.val, CAP)).length;
    const failLeft  = failRemain(quickResult.swaps[quickResult.swaps.length - 1]);
    const tolTxt = `${CAP.lo.toFixed(2)}–${CAP.hi.toFixed(2)} µF (${CAP.uf.toFixed(2)} µF −${CAP.minusPct}%/+${CAP.plusPct}%)`;
    quickResult.lockedNote = (tier1Count + tier2Count) > 0
      ? `ช่องที่สลับได้ ${tier1Count} ช่อง · ช่องกรุ๊ปขนาน ${tier2Count} ช่อง · spare ${sCount} ลูก (ใช้ได้ ${goodSpare})` +
        (nFail > 0 ? ` · พบลูกนอกพิกัด ${nFail} ช่อง (ช่วงปกติ ${CAP.lo.toFixed(2)}–${CAP.hi.toFixed(2)} µF) จะถอดออกก่อน` : '') +
        (quickResult.tempPlan
          ? ` · ลูกเสียมี ${quickResult.failedTotal} ลูก แต่ spare ดีมี ${goodSpare} ลูก จึงจัดแบบชั่วคราว ควรหา spare เพิ่มอีก ${quickResult.sparesShort} ลูก`
          : quickResult.sparesOnly
          ? ` · ลูกเสียมี ${quickResult.failedTotal} ลูก แต่ spare ดีมี ${goodSpare} ลูก ตอนนี้ยังสับให้ผ่านไม่ได้ ควรหา spare เพิ่มอีก ${quickResult.sparesShort} ลูก`
          : (failLeft > 0 ? ` · spare ดีไม่พอ ยังเหลือลูกเสีย ${failLeft} ลูก (เหลือไว้เฉพาะลูกที่เสียน้อยสุด)` : '')) +
        (quickResult.usedGood && !quickResult.fallbackUsed ? ' · ต้องสลับลูกที่ยังดีอยู่ด้วย' : '') +
        (CAP.ratedKV ? ` · ตรวจแรงดันรายลูกไม่ให้เกิน ${Math.round(UNIT_OV_LIMIT*100)}% ของ ${CAP.ratedKV} kV` : '') +
        (quickResult.extended ? ` · ค้นหาเพิ่มถึง ${quickResult.maxDepth} ครั้ง` : '') +
        (quickResult.fallbackUsed ? ' · ต้องสลับช่องกรุ๊ปขนานด้วย' : '') +
        (hasScissors && tier2Count > 0 ? ' · มีช่องวัดแยก ระบบจึงไม่แตะช่องกรุ๊ปขนาน' : '')
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
  engBefore.capSpec = CAP;                                   // v9.5 — UI reads tolerance/rating from here
  if (topology !== 'h-bridge') engBefore.unitV = unitVoltageStats(expandPairs(y1), expandPairs(y2), kv, CAP.ratedKV);
  engBefore.balSumUF = BAL_SUM_UF;
  engBefore.balanceFirst = BAL_FIRST;
  const beforeMA = topology==='h-bridge' ? engBefore.In_mA : engBefore.Ino_mA;
  engBefore.overThreshold = beforeMA >= THRESHOLD_MA;
  engBefore.Ino_mA_before = beforeMA;

  return { quickResult, fullResult, engBefore };
}
