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
// v10.0 — the field engineer sets the balance target in Step 2 the way the field sheet
// does it: the per-phase (rack) SUM ΣC within a wye may differ by at most X µF (field
// practice 0.1 µF = the Step-2 default). For n units in series per phase,
// ΔC_series ≈ ΔΣC / n² (first order), so clientCalculate converts it to the series
// tolerance BAL_TOL_UF used everywhere. If no value is passed (tests / legacy callers)
// BAL_SUM_DEFAULT 0.5 µF ≈ the pre-v10 0.005 µF series at 10 units/phase.
const BAL_SUM_DEFAULT = 0.5;
let BAL_TOL_UF = PHASE_SPREAD_UF;            // set per calculation by clientCalculate
let BAL_FIRST = false;                        // v10.0 spare priority "balance first" (per calc)
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

// PHYSICAL RACK LAYOUT (left → right): A A' B B' C C'. Used only to describe a swap
// to the technician (how far apart the two caps sit) — the v9.4 optimizer swaps
// WITHIN a phase only (A↔A', B↔B', C↔C'), which are always neighbours (distance 1).
const RACK_ORDER = { A: 0, "A'": 1, B: 2, "B'": 3, C: 4, "C'": 5 };
function rackDist(originP, originQ) {
  const a = RACK_ORDER[originP], b = RACK_ORDER[originQ];
  return (a == null || b == null) ? 0 : Math.abs(a - b);
}
// Action types that actually CONSUME a spare (used for sparesUsed accounting).
// `exchange` (in-phase) and `piece-swap` (scissored piece↔piece) use no spare.
const SPARE_ACTION_TYPES = new Set(['replace-y1', 'replace-y2', 'piece-replace']);

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
  window.unitDevOf = unitDevOf; window.parallelCountOf = parallelCountOf;
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
function phaseSpreadOf(metrics, tol) {
  const t = (typeof tol === 'number' && tol > 0) ? tol : BAL_TOL_UF;
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
  const srcTxt = to && to.pulledPiece ? `ชิ้นที่ถอดจาก [${to.id}]` : `[${to && to.id}]`;
  if (type === 'replace-y1') return `ถอด [${from.id}] (${from.val.toFixed(3)} µF) จาก Y1 → แทนด้วย ${srcTxt} (${to.val.toFixed(3)} µF)`;
  if (type === 'replace-y2') return `ถอด [${from.id}] (${from.val.toFixed(3)} µF) จาก Y2 → แทนด้วย ${srcTxt} (${to.val.toFixed(3)} µF)`;
  // v10.0: say which PAIR, which piece, where the new piece comes from, and the new pair totals
  if (type === 'piece-replace') return `คู่ขนาน [${from.id}] เปลี่ยนชิ้น ${action.piece} (${action.oldVal.toFixed(2)} µF) → ใส่ ${to.pulledPiece ? 'ชิ้นที่ถอดจาก' : 'อะไหล่'} [${to.id}] (${to.val.toFixed(2)} µF) · คู่ ${from.id} = ${action.newPairVal.toFixed(2)} µF`;
  if (type === 'piece-swap') {
    const n1 = action.u1.val - action.v1 + action.v2, n2 = action.u2.val - action.v2 + action.v1;
    return `สลับชิ้นระหว่างคู่ขนาน: [${action.u1.id}] ชิ้น ${action.p1} (${action.v1.toFixed(2)}) ↔ [${action.u2.id}] ชิ้น ${action.p2} (${action.v2.toFixed(2)} µF) · คู่ ${action.u1.id} = ${n1.toFixed(2)}, คู่ ${action.u2.id} = ${n2.toFixed(2)} µF`;
  }
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
  const TOL = BAL_TOL_UF;                       // v10.0 user-set within-side balance tolerance
  const BALF = BAL_FIRST;                       // v10.0 spare priority: balance first (field way)
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
  function isBelow(u) {             // name kept from v6.5 — now means "out of tolerance"
    if (!SPEC || !u || u.origin === 'Spare') return false;
    return unitOutOfTolerance(u, SPEC);
  }
  const goodSpare = s => !SPEC || !capValOutOfTol(s.val, SPEC);
  // relative deviation of a failed unit (scissored → its worse piece)
  const devOf = u => unitDevOf(u, SPEC);

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

  function inoOf(cY1, cY2) {
    const fullY1 = [...cY1.A, ...cY1.B, ...cY1.C, ...lockY1];
    const fullY2 = [...cY2.A, ...cY2.B, ...cY2.C, ...lockY2];
    return calcYYMetrics(fullY1, fullY2, kv).Ino_mA;
  }
  const baseIno = inoOf(y1ByPhase, y2ByPhase);

  // Every visited state (from either track) is pushed here as a candidate.
  const candidates = [];
  function record(y1obj, y2obj, spareArr, actions, ino) {
    // Count ONLY actions that actually consume a spare (v8.0 fix kept): `exchange`
    // and `piece-swap` use no spare and must not inflate sparesUsed.
    const spUsed = actions.reduce((n, a) => n + (SPARE_ACTION_TYPES.has(a.type) ? 1 : 0), 0);
    const y1 = [...y1obj.A, ...y1obj.B, ...y1obj.C];
    const y2 = [...y2obj.A, ...y2obj.B, ...y2obj.C];
    const below = NP ? (y1.filter(isBelow).length + y2.filter(isBelow).length) : 0;
    // v9.7 (G1): severity of what is LEFT — the worst relative deviation from rated C
    // among failed units still installed. With too few spares, replace the WORST first.
    const sev = NP ? [...y1, ...y2].filter(isBelow).reduce((m, u) => Math.max(m, devOf(u)), 0) : 0;
    // v9.7: within-side balance (A=B=C per wye, series C) — the balance objective.
    const spObj = phaseSpreadOf(calcYYMetrics([...y1, ...lockY1], [...y2, ...lockY2], kv));
    const spread = spObj.max, spreadMin = Math.min(spObj.y1, spObj.y2);   // v10.0: the better side too
    const ov = RATED ? unitVoltageStats([...y1, ...lockY1], [...y2, ...lockY2], kv, RATED).ovCount : 0;
    const cand = {
      ino, swaps: actions.length, sp: spUsed, below, ov, sev, spread, spreadMin,
      y1, y2, spare: spareArr.slice(),
      acts: actions.slice(),   // raw actions — UI pairs each swap to its units
      steps: actions.length ? actions.map(describeSwap) : ['ไม่มีการสับเปลี่ยนที่ลด Ino ได้']
    };
    candidates.push(cand);
    return cand;
  }
  record(y1ByPhase, y2ByPhase, sparePool, [], baseIno);

  function sig(st) {
    const f = a => a.map(u => u.val.toFixed(4)).sort().join(',');   // multiset: order is irrelevant
    return f(st.y1.A) + '|' + f(st.y1.B) + '|' + f(st.y1.C) + '#' +
           f(st.y2.A) + '|' + f(st.y2.B) + '|' + f(st.y2.C) + '@' +
           st.spare.map(u => u.val.toFixed(4)).sort().join(',');
  }
  function clone(st) {
    return {
      y1: { A: st.y1.A.slice(), B: st.y1.B.slice(), C: st.y1.C.slice() },
      y2: { A: st.y2.A.slice(), B: st.y2.B.slice(), C: st.y2.C.slice() },
      spare: st.spare.slice(), actions: st.actions.slice(), ino: st.ino
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
          c.ino = inoOf(c.y1, c.y2);
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
          c.ino = inoOf(c.y1, c.y2);
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
          c.ino = inoOf(c.y1, c.y2);
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
            c.ino = inoOf(c.y1, c.y2);
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
        c.ino = inoOf(c.y1, c.y2);
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
          c.ino = inoOf(c.y1, c.y2);
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
          c.ino = inoOf(c.y1, c.y2);
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
      if (!seen.has(s)) { seen.add(s); uniq.push(k); const cd = record(k.y1, k.y2, k.spare, k.actions, k.ino); k.below = cd.below; k.ov = cd.ov; k.sev = cd.sev; k.spread = cd.spread; k.spreadMin = cd.spreadMin; }
    }
    // v9.6 (F4): keep BOTH the states that get failed units out (even if I_no rises
    // for now — removing a failure can unmask another) AND the lowest-I_no states.
    const cap = d === 1 ? KEEP1 : BEAM;
    // v9.7: thirds — failed-out (count, severity, overvoltage), within-side balance,
    // and lowest I_no — so balancing paths survive even while I_no is still high.
    const byFail = uniq.slice().sort((a, b) => (a.below - b.below) || (a.sev - b.sev) || (a.ov - b.ov) || (a.ino - b.ino));
    const bySpr  = uniq.slice().sort((a, b) => BALF ? ((a.spread - b.spread) || (a.spreadMin - b.spreadMin) || (a.ino - b.ino))
                                                   : ((a.below - b.below) || (a.sev - b.sev) || (a.spread - b.spread) || (a.ino - b.ino)));
    const byIno  = uniq.slice().sort((a, b) => a.ino - b.ino);
    const third = Math.ceil(cap / 3), pickSet = new Set();
    beam = [];
    for (const L of [byFail, bySpr, byIno]) {
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
  function better(c, best) {
    const cp = c.ino < THR, bp = best.ino < THR;
    if (BALF) {   // v10.0 balance first (field way): balance → pass → failed left → sev → ov → effort
      const cb = c.spread <= TOL + 1e-9, bb = best.spread <= TOL + 1e-9;
      if (cb !== bb) return cb;
      if (!cb && Math.abs(c.spread - best.spread) > SPREAD_TIE_UF) return c.spread < best.spread;
      if (cp !== bp) return cp;
      if (NP && c.below !== best.below) return c.below < best.below;
      if (Math.abs(c.sev - best.sev) > 1e-9) return c.sev < best.sev;
      if (c.ov !== best.ov) return c.ov < best.ov;
      if (!cp && Math.abs(c.ino - best.ino) > 1e-9) return c.ino < best.ino;
      // the better-balanced side only as a tie-break: balancing one side while the other
      // stays off can RAISE I_no (the two imbalances were partly cancelling)
      if (cp && !cb && Math.abs(c.spreadMin - best.spreadMin) > SPREAD_TIE_UF) return c.spreadMin < best.spreadMin;
      if (c.sp !== best.sp) return c.sp < best.sp;
      if (c.swaps !== best.swaps) return c.swaps < best.swaps;
      return c.ino < best.ino;
    }
    if (NP && c.below !== best.below) return c.below < best.below;
    if (Math.abs(c.sev - best.sev) > 1e-9) return c.sev < best.sev;
    if (!MOVE_FAILED && c.ov !== best.ov) return c.ov < best.ov;
    if (cp !== bp) return cp;
    if (MOVE_FAILED) {     // v9.9 temp mode: balance → I_no → overvoltage → spares → swaps
      const cb = c.spread <= TOL + 1e-9, bb = best.spread <= TOL + 1e-9;
      if (cb !== bb) return cb;
      if (Math.abs(c.spread - best.spread) > SPREAD_TIE_UF) return c.spread < best.spread;
      if (!cp && Math.abs(c.ino - best.ino) > 1e-9) return c.ino < best.ino;
      if (c.ov !== best.ov) return c.ov < best.ov;
      if (c.sp !== best.sp) return c.sp < best.sp;
      if (c.swaps !== best.swaps) return c.swaps < best.swaps;
      return c.ino < best.ino;
    }
    if (cp) {
      const cb = c.spread <= TOL + 1e-9, bb = best.spread <= TOL + 1e-9;
      if (cb !== bb) return cb;
      if (!cb && Math.abs(c.spread - best.spread) > SPREAD_TIE_UF) return c.spread < best.spread;
      if (c.sp !== best.sp) return c.sp < best.sp;
      if (c.swaps !== best.swaps) return c.swaps < best.swaps;
      return c.ino < best.ino;
    }
    if (Math.abs(c.ino - best.ino) > 1e-9) return c.ino < best.ino;
    if (c.sp !== best.sp) return c.sp < best.sp;
    return c.swaps < best.swaps;
  }
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
    steps: b.steps
  });
  const results = targets.map(target => fmt(pick(target), target));

  // ── I_no reference comparison (v9.5) ──
  // For each reference r: the LEAST-EFFORT plan that gets I_no below r — with the
  // failed units out as far as the good spares allow (= the fewest failed left of any
  // candidate) and no unit overvoltaged. Least effort = fewest swaps, then fewest
  // spares, then lowest I_no. null = not reachable within MAXDEPTH swaps.
  const minBelow = candidates.reduce((m, c) => Math.min(m, c.below), Infinity);
  const minSev = candidates.filter(c => c.below === minBelow).reduce((m, c) => Math.min(m, c.sev), Infinity);
  const refPlans = {};
  INO_REF_LIST.forEach(r => {
    const elig = candidates.filter(c => (BALF || (c.below === minBelow && c.sev <= minSev + 1e-9)) && (MOVE_FAILED || c.ov === 0) && c.ino < r);
    if (!elig.length) { refPlans[r] = null; return; }
    // balance first (v9.7): balanced plans if any; else the tightest spread (± tie band)
    const bal = elig.filter(c => c.spread <= TOL + 1e-9);
    const minSpr = elig.reduce((m, c) => Math.min(m, c.spread), Infinity);
    const pool = bal.length ? bal : elig.filter(c => c.spread <= minSpr + SPREAD_TIE_UF);
    let b = null;   // then (balance-first: fewest failed left → sev) → least work: swaps → spares → I_no
    const lessWork = (c, b) => c.swaps < b.swaps || (c.swaps === b.swaps && (c.sp < b.sp || (c.sp === b.sp && c.ino < b.ino)));
    for (const c of pool) if (!b || (BALF
        ? (c.below < b.below || (c.below === b.below && (c.sev < b.sev - 1e-9 || (Math.abs(c.sev - b.sev) <= 1e-9 && lessWork(c, b)))))
        : lessWork(c, b))) b = c;
    refPlans[r] = fmt(b, b.swaps);
  });
  return { baseDiff: baseIno, baseIno, swaps: results, refPlans, minBelow, maxDepth: MAXDEPTH };
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
  const {topology, y1, y2, spare, legs, systemKV, alarmMA, capRating, balSumUF, sparePriority} = payload;
  // v10.0 — balance target (ΣC difference per rack, field-sheet style) → series tolerance;
  // spare priority 'balance' (field way, default) or 'failed' (worst failed out first).
  const BAL_SUM_UF = (parseFloat(balSumUF) > 0) ? parseFloat(balSumUF) : BAL_SUM_DEFAULT;
  {
    const cnt = {}; [...(y1 || []), ...(y2 || [])].forEach(u => { cnt[u.origin] = (cnt[u.origin] || 0) + 1; });
    const ns = Object.values(cnt), n = ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 10;
    BAL_TOL_UF = BAL_SUM_UF / (n * n);
    BAL_FIRST = sparePriority ? sparePriority === 'balance' : false;
  }
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
    engBefore.spread = phaseSpreadOf(engBefore);   // within-side A/B/C series spread (display only)

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
                                        { maxDepth: depth, moveFailed: !!moveFailed }, THRESHOLD_MA);
      function decorate(sw) {
        if (!sw) return sw;
        const fullY1 = [...sw.y1, ...lockY1];
        const fullY2 = [...sw.y2, ...lockY2];
        sw.engAfter = calcYYMetrics(fullY1, fullY2, kv);
        sw.Ino_mA = sw.engAfter.Ino_mA;
        sw.underThreshold = sw.Ino_mA < THRESHOLD_MA;
        sw.spread = phaseSpreadOf(sw.engAfter);        // display only (not a goal since v9.4)
        sw.spreadOK = sw.spread.ok;
        sw.fullyPass = sw.underThreshold && sw.spreadOK;
        sw.unitV = unitVoltageStats(fullY1, fullY2, kv, CAP.ratedKV);   // v9.5
        sw.overV = sw.unitV.ovCount > 0;
        sw.y1Full = fullY1; sw.y2Full = fullY2;
        sw.level = level;
        sw.tier = level >= 2 ? 2 : 1;
        return sw;
      }
      res.swaps.forEach(decorate);
      Object.values(res.refPlans || {}).forEach(decorate);
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
    const balOf = sw => sprOf(sw) <= BAL_TOL_UF + 1e-9;
    // Per budget, in priority order matching the field procedure:
    //   1. get the FAILED (out-of-tolerance) units OUT — fewest left installed
    //   2. no unit above 110 % of rated voltage (v9.5)
    //   3. meet the (field-selected) threshold — "ผ่านแล้วหยุด"
    //   4a. if it passes: least disruptive (lower level) → fewest spares → swaps → I_no
    //   4b. if NOTHING passes (v9.6, F1): LOWEST I_no first (closest to safe) → spares
    //       → swaps → level. (v6.5 ranked the lower level first even then, so a failed-
    //       only L0 plan at 307 mA beat an L1 plan at 188 mA.)
    function chooseBudget(i) {
      const cands = levels.map(p => p.swaps[i]).filter(Boolean);
      cands.forEach(c => { c._fail = failRemain(c); c._sev = failSev(c); });
      cands.sort((a, b) => {
        if (BAL_FIRST) {    // v10.0: balance → spread → pass → failed → sev → ov → effort
          const bl = (balOf(b) ? 1 : 0) - (balOf(a) ? 1 : 0); if (bl) return bl;
          if (!balOf(a) && Math.abs(sprOf(a) - sprOf(b)) > SPREAD_TIE_UF) return sprOf(a) - sprOf(b);
          const pp = (b.underThreshold ? 1 : 0) - (a.underThreshold ? 1 : 0); if (pp) return pp;
          const df = a._fail - b._fail; if (df) return df;
          if (Math.abs(a._sev - b._sev) > 1e-9) return a._sev - b._sev;
          const oo = (a.overV ? 1 : 0) - (b.overV ? 1 : 0); if (oo) return oo;
          return a.underThreshold
            ? (a.level - b.level || (a.sparesUsed || 0) - (b.sparesUsed || 0) || a.actualSwaps - b.actualSwaps || a.Ino_mA - b.Ino_mA)
            : (a.Ino_mA - b.Ino_mA || (a.sparesUsed || 0) - (b.sparesUsed || 0) || a.actualSwaps - b.actualSwaps || a.level - b.level);
        }
        const d = a._fail - b._fail; if (d) return d;
        if (Math.abs(a._sev - b._sev) > 1e-9) return a._sev - b._sev;                 // G1
        const o = (a.overV ? 1 : 0) - (b.overV ? 1 : 0); if (o) return o;
        const p = (b.underThreshold ? 1 : 0) - (a.underThreshold ? 1 : 0); if (p) return p;
        if (a.underThreshold) {
          const bl = (balOf(b) ? 1 : 0) - (balOf(a) ? 1 : 0); if (bl) return bl;       // balance first
          if (!balOf(a) && Math.abs(sprOf(a) - sprOf(b)) > SPREAD_TIE_UF) return sprOf(a) - sprOf(b);
          return a.level - b.level || (a.sparesUsed || 0) - (b.sparesUsed || 0)
              || a.actualSwaps - b.actualSwaps || a.Ino_mA - b.Ino_mA;
        }
        return (a.Ino_mA - b.Ino_mA) || (a.sparesUsed || 0) - (b.sparesUsed || 0)
            || a.actualSwaps - b.actualSwaps || a.level - b.level;
      });
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
                       !balOf(best);                                  // v9.7: balance not reached yet
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
    quickResult.refTable = INO_REF_LIST.map(r => {
      const cands = levels.map(p => p.refPlans && p.refPlans[r]).filter(Boolean);
      cands.forEach(c => { c._fail = failRemain(c); c._sev = failSev(c); });
      cands.sort((a, b) => BAL_FIRST
        ? (((balOf(b) ? 1 : 0) - (balOf(a) ? 1 : 0))
          || (!balOf(a) && Math.abs(sprOf(a) - sprOf(b)) > SPREAD_TIE_UF ? sprOf(a) - sprOf(b) : 0)
          || a._fail - b._fail || (a._sev - b._sev) || ((a.overV ? 1 : 0) - (b.overV ? 1 : 0))
          || a.actualSwaps - b.actualSwaps || (a.sparesUsed || 0) - (b.sparesUsed || 0) || a.level - b.level || a.Ino_mA - b.Ino_mA)
        : a._fail - b._fail || (a._sev - b._sev) || ((a.overV ? 1 : 0) - (b.overV ? 1 : 0))
        || ((balOf(b) ? 1 : 0) - (balOf(a) ? 1 : 0))
        || (!balOf(a) && Math.abs(sprOf(a) - sprOf(b)) > SPREAD_TIE_UF ? sprOf(a) - sprOf(b) : 0)
        || a.actualSwaps - b.actualSwaps || (a.sparesUsed || 0) - (b.sparesUsed || 0)
        || a.level - b.level || a.Ino_mA - b.Ino_mA);
      return { ref: r, plan: cands[0] || null };
    });
    {
      const ok = quickResult.refTable.filter(row => row.plan);
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
      const anyPass = budgetPicks.some(sw => sw.underThreshold) || quickResult.refTable.some(r => r.plan);
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
          spread: phaseSpreadOf(m), unitV: unitVoltageStats(y1F, y2F, kv, CAP.ratedKV), level: 0, tier: 1 };
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
        const key = c => BAL_FIRST ? [balOf(c) ? 0 : 1, sprOf(c), c.underThreshold ? 0 : 1, c.Ino_mA]
                                   : [c.underThreshold ? 0 : 1, balOf(c) ? 0 : 1, sprOf(c), c.Ino_mA];
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
      ? `Tier 1 (วัดแยก): ${tier1Count} ตัว · Tier 2 (กรุ๊ป): ${tier2Count} ตัว · Spare ${sCount} ตัว (ดี ${goodSpare})` +
        ' · สลับได้: เฟสเดียวกันข้ามฝั่ง (A↔A\') และข้ามเฟสในฝั่งเดียวกัน (A↔B↔C, A\'↔B\'↔C\')' +
        (nFail > 0 ? ` · 🔧 พบ ${nFail} ตัวนอกพิกัด ${tolTxt} (เสีย) ถอดออกก่อน` : '') +
        (quickResult.tempPlan
          ? ` · ⛔ ตัวเสีย ${quickResult.failedTotal} ตัว แต่ spare ดีมี ${goodSpare} ตัว → แผนจัดชั่วคราว: เปลี่ยนตัวเสียหนักสุดก่อน แล้วกระจายตัวเสียที่เหลือให้แต่ละเฟสเท่ากัน · หา spare ดีเพิ่มอีก ${quickResult.sparesShort} ตัว แล้วจัดใหม่`
          : quickResult.sparesOnly
          ? ` · ⛔ ตัวเสีย ${quickResult.failedTotal} ตัว แต่ spare ดีมี ${goodSpare} ตัว — สับให้ผ่านไม่ได้ตอนนี้ แนะนำเปลี่ยนตัวเสียหนักสุดก่อน แล้วหา spare ดีเพิ่มอีก ${quickResult.sparesShort} ตัว`
          : (failLeft > 0 ? ` · ⛔ spare ดีไม่พอ (มี ${goodSpare} ตัว) → ยังเหลือตัวเสีย ${failLeft} ตัว (เหลือไว้เฉพาะตัวที่เสียน้อยสุด) — ต้องหา spare ดีเพิ่มอีก ${failLeft} ตัว` : '')) +
        (quickResult.usedGood && !quickResult.fallbackUsed ? ' · ⚠ ตัวเสียอย่างเดียวไม่พอ ต้องสับตัวดีด้วย' : '') +
        (CAP.ratedKV ? ` · ⚡ ตรวจแรงดันรายตัว ≤ ${Math.round(UNIT_OV_LIMIT*100)}% ของ ${CAP.ratedKV} kV` : '') +
        (quickResult.extended ? ` · 🔎 สับ ${BASE_DEPTH} ครั้งไม่พอ → ค้นหาเพิ่มถึง ${quickResult.maxDepth} ครั้ง` : '') +
        (quickResult.fallbackUsed ? ' · ⚠ ต้องใช้ fallback (สลับตัวกรุ๊ป Tier 2 ด้วย)' : '') +
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
  engBefore.capSpec = CAP;                                   // v9.5 — UI reads tolerance/rating from here
  if (topology !== 'h-bridge') engBefore.unitV = unitVoltageStats(expandPairs(y1), expandPairs(y2), kv, CAP.ratedKV);
  engBefore.phaseSpreadTol = BAL_TOL_UF;
  engBefore.balSumUF = BAL_SUM_UF;
  engBefore.balanceFirst = BAL_FIRST;
  const beforeMA = topology==='h-bridge' ? engBefore.In_mA : engBefore.Ino_mA;
  engBefore.overThreshold = beforeMA >= THRESHOLD_MA;
  engBefore.Ino_mA_before = beforeMA;

  return { quickResult, fullResult, engBefore };
}
