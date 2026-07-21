// ═══════════════════════════════════════
// FORMULAS
// ═══════════════════════════════════════
/**
 * public/js/formulas.js — Render engineering formulas with REAL input values
 * Shows the actual numbers users entered, plugged into formulas step by step
 */
'use strict';

// Number formatting helpers
const F = {
  uF:  v => Number(v).toFixed(3),
  S:   v => (Number(v)*1e6).toFixed(3) + ' µS',
  Hz:  v => Number(v).toFixed(0),
  V:   v => Number(v).toFixed(2),
  kV:  v => (Number(v)/1000).toFixed(2),
  A:   v => Number(v).toFixed(4),
  mA:  v => Number(v).toFixed(4),
  Ohm: v => Number(v).toFixed(2),
  Mvar:v => Number(v).toFixed(3),
  raw: (v,d) => Number(v).toFixed(d===undefined?4:d)
};

const F_HZ = 50;                 // system frequency (Hz)
const PI2F = 2 * Math.PI * 50;   // ω = 2πf, self-contained (no cross-block dep)

/** Render formula step block */
function fStep(num, title, tag, desc, ...lines) {
  return `<div class="formula-step">
    <div class="fs-head">
      <div class="fs-num">${num}</div>
      <div class="fs-title">${title}</div>
      ${tag ? `<div class="fs-tag">${tag}</div>` : ''}
    </div>
    ${desc ? `<div class="fs-desc">${desc}</div>` : ''}
    <div class="fs-formula">
      ${lines.join('')}
    </div>
  </div>`;
}

const eq    = (text, cls='') => `<span class="fs-eq ${cls}">${text}</span>`;
const sym   = text => `<span class="fs-eq sym">${text}</span>`;
const sub   = text => `<span class="fs-eq sub">${text}</span>`;
const final = text => `<span class="fs-eq final">${text}</span>`;
const v     = text => `<span class="var">${text}</span>`;
const n     = text => `<span class="num">${text}</span>`;
const r     = text => `<span class="res">${text}</span>`;
const op    = text => `<span class="op">${text}</span>`;

/** Build YY formula breakdown */
function buildYYFormulas(vals, m) {
  const Vph = m.Vph;
  const Vs = vals.systemKV * 1000;
  const sumY1 = vals.y1.reduce((a,c)=>a+c.val,0);
  const sumY2 = vals.y2.reduce((a,c)=>a+c.val,0);
  const C1F = sumY1 * 1e-6;
  const C2F = sumY2 * 1e-6;
  const B1 = m.B1, B2 = m.B2;

  // Build "27.948 + 28.024 + ..." string
  const y1Sum = vals.y1.map(c => F.uF(c.val)).join(' + ');
  const y2Sum = vals.y2.map(c => F.uF(c.val)).join(' + ');

  let html = `<div class="formula-section">
    <div class="formula-title"><i class="fas fa-function"></i> การคำนวณ Y-Y Ungrounded — ทีละขั้น</div>
    <div class="formula-sub">
      ใช้ค่า input ที่ผู้ใช้กรอกในหน้าก่อนหน้า แทนค่าลงในสูตรวิศวกรรมจริงของระบบ ${vals.systemKV} kV
      ความถี่ ${F_HZ} Hz
    </div>`;

  // Step 1: Per-phase series capacitance (matches calcYYMetrics)
  const pp0 = m.perPhase || {};
  function seriesRows() {
    let rows = [];
    [['A','C1'],['B','C1'],['C','C1']].forEach(([ph]) => {
      const p = pp0[ph]; if (!p) return;
      // count units per phase per wye
      const n1 = vals.y1.filter(x=>(x.origin||'').replace("'","")===ph).length;
      const n2 = vals.y2.filter(x=>(x.origin||'').replace("'","")===ph).length;
      rows.push(
        eq(`<b>เฟส ${ph}:</b> Y1 มี ${n1} ตัว → C<sub>Y1</sub> = 1/Σ(1/Cᵢ) = ` + n(p.C1.toFixed(4)) + ' µF, &nbsp; ' +
           `Y2 มี ${n2} ตัว → C<sub>Y2</sub> = ` + n(p.C2.toFixed(4)) + ' µF')
      );
    });
    return rows;
  }
  html += fStep(1,
    'ความจุรวมต่อเฟส (ต่ออนุกรม)',
    'Cphase = 1/Σ(1/Cᵢ)',
    'ตัวเก็บประจุในแต่ละเฟสต่อแบบอนุกรม จึงรวมด้วย Cphase = 1/Σ(1/Cᵢ) — ไม่ใช่บวกตรงๆ (ตรงกับ Excel C-Bank Arrangement)',
    sym('C<sub>phase</sub> = 1 / ( 1/C₁ + 1/C₂ + ... + 1/C<sub>n</sub> )'),
    eq(''),
    ...seriesRows()
  );

  // Step 2: Phase voltage
  html += fStep(2,
    'แรงดันเฟส (Phase Voltage)',
    'V_ph',
    'ระบบ 3 เฟสสมดุล แรงดันเฟส = แรงดันสาย ÷ √3',
    sym('V<sub>ph</sub> = V<sub>S</sub> / √3'),
    eq('V<sub>ph</sub> = ' + n(F.raw(Vs,0)) + ' V ' + op('/') + ' √3'),
    final('V<sub>ph</sub> = ' + r(F.V(Vph)) + ' V ≈ ' + r(F.kV(Vph)) + ' kV')
  );
  // (Step 3 parallel-susceptance removed — Step 4 computes per-phase S directly)

  // Step 4: Per-phase susceptance (siemens), wye-1 = S1,S2,S3 / wye-2 = S4,S5,S6
  const S = m.S || {};
  const pp = m.perPhase || {};
  function susRows() {
    let rows = [];
    [['A','S1','S4'],['B','S2','S5'],['C','S3','S6']].forEach(([ph,k1,k2]) => {
      const p = pp[ph]; if (!p) return;
      rows.push(
        eq(`<b>เฟส ${ph}:</b> C<sub>Y1</sub> = ` + n(p.C1.toFixed(3)) + ' µF → S = ' + n((S[k1]*1000).toFixed(4)) + ' mS, &nbsp; ' +
           `C<sub>Y2</sub> = ` + n(p.C2.toFixed(3)) + ' µF → S = ' + n((S[k2]*1000).toFixed(4)) + ' mS')
      );
    });
    return rows;
  }
  html += fStep(4,
    'ความจุรวมต่อเฟส (อนุกรม) → Susceptance',
    'Cphase = 1/Σ(1/Cᵢ),  S = 2πf·Cphase',
    'ตัวเก็บประจุในแต่ละเฟสต่อแบบอนุกรม จึงรวมเป็น Cphase = 1/Σ(1/Cᵢ) (ไม่ใช่บวกตรง) แล้วแปลงเป็น susceptance — ตรงกับ Excel แผ่น C-Bank Arrangement',
    sym('C<sub>phase</sub> = 1 / Σ(1/C<sub>i</sub>)  &nbsp;(อนุกรม)'),
    sym('S = 2π · f · C<sub>phase</sub> / 10⁶'),
    eq(''),
    ...susRows()
  );

  // Step 5: Neutral displacement voltage (complex phasor) — exact Excel method
  const Vnx = m.Vnx, Vny = m.Vny, sumS = m.sumS;
  html += fStep(5,
    'แรงดันเลื่อนที่จุด Neutral (เฟสเซอร์เชิงซ้อน)',
    'Vno = √(Vnx² + Vny²)',
    'นิวทรัลลอย (floating) เลื่อนตามผลรวมเวกเตอร์ของทุกเฟส โดยใช้มุมเฟส A=0°, B=−120°, C=+120° — ไม่ใช่ค่า worst-case',
    sym('V<sub>nx</sub> = (1/ΣS)·V<sub>ph</sub>·[cos0·(S₁+S₄) + cos(−120°)·(S₂+S₅) + cos(120°)·(S₃+S₆)]'),
    sym('V<sub>ny</sub> = (1/ΣS)·V<sub>ph</sub>·[sin0·(S₁+S₄) + sin(−120°)·(S₂+S₅) + sin(120°)·(S₃+S₆)]'),
    eq('V<sub>nx</sub> = ' + n(Vnx.toFixed(6)) + ' kV, &nbsp; V<sub>ny</sub> = ' + n(Vny.toFixed(6)) + ' kV'),
    sym('V<sub>no</sub> = √(V<sub>nx</sub>² + V<sub>ny</sub>²) · 1000'),
    final('V<sub>no</sub> = ' + r(F.V(m.Vno)) + ' V')
  );

  // Step 6: CT neutral current of wye-1 (complex), magnitude → mA
  const Inx = m.Inx, Iny = m.Iny;
  html += fStep(6,
    'กระแสไม่สมดุลที่ CT (เฟสเซอร์เชิงซ้อน)',
    'Ino = √(Inx² + Iny²)',
    'กระแสนิวทรัลของกิ่ง Y1 (S₁+S₂+S₃) คือกระแสฉีดเข้าลบด้วยกระแสที่เกิดจากแรงดันเลื่อน Vno — คิดเป็นเวกเตอร์จริง/จินตภาพ แล้วหาขนาด',
    sym('I<sub>nx</sub> = V<sub>ph</sub>·[S₁cos0 + S₂cos(−120°) + S₃cos(120°)] − (S₁+S₂+S₃)·V<sub>nx</sub>'),
    sym('I<sub>ny</sub> = V<sub>ph</sub>·[S₁sin0 + S₂sin(−120°) + S₃sin(120°)] − (S₁+S₂+S₃)·V<sub>ny</sub>'),
    eq('I<sub>nx</sub> = ' + n(Inx.toExponential(4)) + ', &nbsp; I<sub>ny</sub> = ' + n(Iny.toExponential(4))),
    sym('I<sub>no</sub> = √(I<sub>nx</sub>² + I<sub>ny</sub>²) · 10⁶'),
    final('I<sub>no</sub> = ' + r(F.mA(m.Ino_mA)) + ' mA' + (function(){var A=(m.thresholdMA||window.ALARM_MA||50);return m.Ino_mA < A ? ' ✓ (< '+A+' mA)' : ' ⚠ (≥ '+A+' mA)';})())
  );

  // Step 6: Q
  html += fStep(6,
    'พลังงานรีแอคทีฟรวม (Q)',
    'Q = V²B',
    'กำลังที่แบงค์ผลิตได้ในระบบ — ใช้ตรวจสอบว่ายังอยู่ในพิกัด',
    sym('Q = V<sub>ph</sub>² · (B₁ + B₂)'),
    eq('Q = ' + n(F.V(Vph)) + '² ' + op('×') + ' ' + n(((B1+B2)*1e6).toFixed(3)) + ' µS'),
    eq('Q = ' + n((Vph*Vph).toExponential(4)) + ' ' + op('×') + ' ' + n((B1+B2).toExponential(4))),
    final('Q = ' + r(F.Mvar(m.Qt)) + ' Mvar')
  );

  html += '</div>';
  return html;
}

/** Build H-Bridge formula breakdown */
function buildHBridgeFormulas(vals, m) {
  const Vph = m.Vph;
  const Vs = vals.systemKV * 1000;

  const sumA = vals.legs.a.reduce((a,c)=>a+c.val,0);
  const sumB = vals.legs.b.reduce((a,c)=>a+c.val,0);
  const sumC_ = vals.legs.c.reduce((a,c)=>a+c.val,0);
  const sumD = vals.legs.d.reduce((a,c)=>a+c.val,0);

  const aSum = vals.legs.a.map(c=>F.uF(c.val)).join(' + ');
  const bSum = vals.legs.b.map(c=>F.uF(c.val)).join(' + ');
  const cSum = vals.legs.c.map(c=>F.uF(c.val)).join(' + ');
  const dSum = vals.legs.d.map(c=>F.uF(c.val)).join(' + ');

  // Calc Xc for each
  const xcA = 1 / (PI2F * sumA * 1e-6);
  const xcB = 1 / (PI2F * sumB * 1e-6);
  const xcC = 1 / (PI2F * sumC_ * 1e-6);
  const xcD = 1 / (PI2F * sumD * 1e-6);

  let html = `<div class="formula-section">
    <div class="formula-title"><i class="fas fa-function"></i> การคำนวณ H-Bridge — ทีละขั้น</div>
    <div class="formula-sub">
      H-Bridge แบ่งเฟสเป็น 4 Legs (A·B·C·D) มี CT บน H-link ระหว่าง Leg A-B และ C-D
      ระบบ ${vals.systemKV} kV ความถี่ ${F_HZ} Hz
    </div>`;

  // Step 1: Sum each leg
  html += fStep(1,
    'รวมค่าความจุของแต่ละ Leg',
    'Σ C',
    'แต่ละ Leg ตัวเก็บประจุต่อขนานกัน นำค่ามารวม',
    eq('C<sub>A</sub> = ' + n(aSum) + ' = ' + r(F.uF(sumA)) + ' µF'),
    eq('C<sub>B</sub> = ' + n(bSum) + ' = ' + r(F.uF(sumB)) + ' µF'),
    eq('C<sub>C</sub> = ' + n(cSum) + ' = ' + r(F.uF(sumC_)) + ' µF'),
    eq('C<sub>D</sub> = ' + n(dSum) + ' = ' + r(F.uF(sumD)) + ' µF')
  );

  // Step 2: Phase voltage
  html += fStep(2,
    'แรงดันเฟส',
    'V_ph',
    '',
    sym('V<sub>ph</sub> = V<sub>S</sub> / √3'),
    eq('V<sub>ph</sub> = ' + n(F.raw(Vs,0)) + ' V ' + op('/') + ' √3'),
    final('V<sub>ph</sub> = ' + r(F.V(Vph)) + ' V')
  );

  // Step 3: Reactance Xc per leg
  html += fStep(3,
    'Reactance ของแต่ละ Leg',
    'Xc = 1/ωC',
    'แต่ละ Leg มี Xc ต่างกันตามค่าความจุ',
    sym('X<sub>C</sub> = 1 / (2π · f · C)'),
    eq('X<sub>C,A</sub> = 1 / (' + n(PI2F.toFixed(4)) + ' ' + op('×') + ' ' + n(F.uF(sumA)) + ' ' + op('×') + ' 10⁻⁶) = ' + r(F.Ohm(xcA)) + ' Ω'),
    eq('X<sub>C,B</sub> = 1 / (' + n(PI2F.toFixed(4)) + ' ' + op('×') + ' ' + n(F.uF(sumB)) + ' ' + op('×') + ' 10⁻⁶) = ' + r(F.Ohm(xcB)) + ' Ω'),
    eq('X<sub>C,C</sub> = 1 / (' + n(PI2F.toFixed(4)) + ' ' + op('×') + ' ' + n(F.uF(sumC_)) + ' ' + op('×') + ' 10⁻⁶) = ' + r(F.Ohm(xcC)) + ' Ω'),
    eq('X<sub>C,D</sub> = 1 / (' + n(PI2F.toFixed(4)) + ' ' + op('×') + ' ' + n(F.uF(sumD)) + ' ' + op('×') + ' 10⁻⁶) = ' + r(F.Ohm(xcD)) + ' Ω')
  );

  // Step 4: xa1 and xa2
  html += fStep(4,
    'รวม Reactance ทั้ง branch (ต่ออนุกรม)',
    'X_total',
    'A กับ C ต่ออนุกรม → xa1, B กับ D ต่ออนุกรม → xa2',
    sym('xa1 = X<sub>C,A</sub> + X<sub>C,C</sub>'),
    eq('xa1 = ' + n(F.Ohm(xcA)) + ' + ' + n(F.Ohm(xcC)) + ' = ' + r(F.Ohm(m.xa1)) + ' Ω'),
    eq(''),
    sym('xa2 = X<sub>C,B</sub> + X<sub>C,D</sub>'),
    eq('xa2 = ' + n(F.Ohm(xcB)) + ' + ' + n(F.Ohm(xcD)) + ' = ' + r(F.Ohm(m.xa2)) + ' Ω')
  );

  // Step 5: Iup, Idown
  html += fStep(5,
    'กระแสบนและล่าง',
    'KVL · I=V/X',
    'กระแสที่ไหลผ่านแต่ละ branch (ซ้าย/ขวา)',
    sym('I<sub>up</sub> = V<sub>ph</sub> / xa1'),
    eq('I<sub>up</sub> = ' + n(F.V(Vph)) + ' / ' + n(F.Ohm(m.xa1))),
    final('I<sub>up</sub> = ' + r(F.A(m.Iup)) + ' A'),
    eq(''),
    sym('I<sub>down</sub> = V<sub>ph</sub> / xa2'),
    eq('I<sub>down</sub> = ' + n(F.V(Vph)) + ' / ' + n(F.Ohm(m.xa2))),
    final('I<sub>down</sub> = ' + r(F.A(m.Idown)) + ' A')
  );

  // Step 6: Iun = bridge current
  const InoCls = m.In_mA > 10 ? 'bad' : m.In_mA > 1 ? 'warn' : 'good';
  html += fStep(6,
    'กระแส Bridge ไม่สมดุล (Iun / In)',
    '60P',
    'ผลต่างกระแสบน-ล่าง — รีเลย์ Bridge Differential ตรวจจับค่านี้ตั้ง alarm/trip',
    sym('I<sub>un</sub> = I<sub>up</sub> − I<sub>down</sub>'),
    eq('I<sub>un</sub> = ' + n(F.A(m.Iup)) + ' − ' + n(F.A(m.Idown))),
    eq('I<sub>un</sub> = ' + n(F.A(m.Iun)) + ' A'),
    eq(''),
    final('I<sub>n</sub> = |I<sub>un</sub>| = ' + r(F.mA(m.In_mA)) + ' mA')
  );

  // Step 7: Vx
  html += fStep(7,
    'แรงดันที่จุด Bridge (Vx)',
    'Voltage divider',
    'แรงดันที่ตกคร่อม Leg ล่าง (C) — ใช้ตรวจสอบ over-voltage ของตัวที่ยังเหลือ',
    sym('V<sub>x</sub> = V<sub>ph</sub> · (X<sub>C,C</sub> / xa1)'),
    eq('V<sub>x</sub> = ' + n(F.V(Vph)) + ' ' + op('×') + ' (' + n(F.Ohm(xcC)) + ' / ' + n(F.Ohm(m.xa1)) + ')'),
    final('V<sub>x</sub> = ' + r(F.V(m.Vx)) + ' V')
  );

  // Step 8: Q
  html += fStep(8,
    'พลังงานรีแอคทีฟรวม (Q)',
    'Q = V²B',
    '',
    sym('Q = V<sub>ph</sub>² · B<sub>total</sub>'),
    eq('Q = ' + n(F.V(Vph)) + '² ' + op('×') + ' ' + n((m.S_total*1e6).toFixed(3)) + ' µS'),
    final('Q = ' + r(F.Mvar(m.Qt)) + ' Mvar')
  );

  html += '</div>';
  return html;
}

window.buildYYFormulas = buildYYFormulas;
window.buildHBridgeFormulas = buildHBridgeFormulas;
