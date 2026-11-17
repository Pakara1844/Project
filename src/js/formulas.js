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
const PI2F_F = 2 * Math.PI * 50;   // ω = 2πf, self-contained (no cross-block dep)

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
  html += fStep(3,
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
  html += fStep(4,
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
  html += fStep(5,
    'กระแสไม่สมดุลที่ CT (เฟสเซอร์เชิงซ้อน)',
    'Ino = √(Inx² + Iny²)',
    'กระแสนิวทรัลของกิ่ง Y1 (S₁+S₂+S₃) คือกระแสฉีดเข้าลบด้วยกระแสที่เกิดจากแรงดันเลื่อน Vno — คิดเป็นเวกเตอร์จริง/จินตภาพ แล้วหาขนาด',
    sym('I<sub>nx</sub> = V<sub>ph</sub>·[S₁cos0 + S₂cos(−120°) + S₃cos(120°)] − (S₁+S₂+S₃)·V<sub>nx</sub>'),
    sym('I<sub>ny</sub> = V<sub>ph</sub>·[S₁sin0 + S₂sin(−120°) + S₃sin(120°)] − (S₁+S₂+S₃)·V<sub>ny</sub>'),
    eq('I<sub>nx</sub> = ' + n(Inx.toExponential(4)) + ', &nbsp; I<sub>ny</sub> = ' + n(Iny.toExponential(4))),
    sym('I<sub>no</sub> = √(I<sub>nx</sub>² + I<sub>ny</sub>²) · 10⁶'),
    final('I<sub>no</sub> = ' + r(F.mA(m.Ino_mA)) + ' mA' + (function(){var A=(m.thresholdMA||window.ALARM_MA||50);return m.Ino_mA < A ? ' ✓ (< '+A+' mA)' : ' ⚠ (≥ '+A+' mA)';})())
  );

  // Step 6: Q — from the SAME series susceptances S₁…S₆ that give I_no (v10.4, fix 7:
  // the old line multiplied by B₁+B₂ = susceptance of the PARALLEL sum of every unit,
  // ~100× too big, so the substituted numbers never produced the shown Q).
  const sumSAll = ['S1','S2','S3','S4','S5','S6'].reduce((t, k) => t + ((m.S && m.S[k]) || 0), 0);
  html += fStep(6,
    'พลังงานรีแอคทีฟรวม (Q)',
    'Q = V²·ΣS',
    'กำลังที่แบงค์ผลิตได้ในระบบ — ใช้ susceptance ต่อเฟส (C อนุกรม) ชุดเดียวกับที่ใช้หา I<sub>no</sub>',
    sym('Q = V<sub>ph</sub>² · (S₁ + S₂ + S₃ + S₄ + S₅ + S₆)'),
    eq('Q = ' + n(F.V(Vph)) + '² ' + op('×') + ' ' + n((sumSAll*1e3).toFixed(4)) + ' mS'),
    eq('Q = ' + n((Vph*Vph).toExponential(4)) + ' ' + op('×') + ' ' + n(sumSAll.toExponential(4)) + ' = ' + n((Vph*Vph*sumSAll).toExponential(4)) + ' var'),
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

  // Step 3: mid-point voltages (open H-link) — v10.4 bridge model
  const sAll = sumA + sumB + sumC_ + sumD;
  html += fStep(3,
    'แรงดันที่จุดกลางของแต่ละ branch',
    'Voltage divider',
    'กิ่งซ้าย A (บน) ต่อ C (ล่าง), กิ่งขวา B (บน) ต่อ D (ล่าง) — CT วัดความต่างของจุดกลางสองกิ่ง',
    sym('V<sub>x,L</sub> = V<sub>ph</sub> · C<sub>A</sub> / (C<sub>A</sub> + C<sub>C</sub>), &nbsp; V<sub>x,R</sub> = V<sub>ph</sub> · C<sub>B</sub> / (C<sub>B</sub> + C<sub>D</sub>)'),
    eq('V<sub>x,L</sub> = ' + r(F.V(m.VxL)) + ' V, &nbsp; V<sub>x,R</sub> = ' + r(F.V(m.VxR)) + ' V')
  );
  // Step 4: bridge current
  const InoCls = m.In_mA > 10 ? 'bad' : m.In_mA > 1 ? 'warn' : 'good';
  html += fStep(4,
    'กระแส Bridge ไม่สมดุล (CT บน H-link)',
    '60P',
    'CT ต่อจุดกลางสองกิ่งเข้าหากัน กระแสจะเป็นศูนย์เมื่อ C<sub>A</sub>/C<sub>C</sub> = C<sub>B</sub>/C<sub>D</sub> (สะพานสมดุล)',
    sym('I<sub>n</sub> = ω · V<sub>ph</sub> · |C<sub>A</sub>·C<sub>D</sub> − C<sub>B</sub>·C<sub>C</sub>| / (C<sub>A</sub> + C<sub>B</sub> + C<sub>C</sub> + C<sub>D</sub>)'),
    eq('I<sub>n</sub> = ' + n(PI2F_F.toFixed(4)) + ' ' + op('×') + ' ' + n(F.V(Vph)) + ' ' + op('×') + ' |' +
       n(F.uF(sumA)) + '·' + n(F.uF(sumD)) + ' − ' + n(F.uF(sumB)) + '·' + n(F.uF(sumC_)) + '| ×10⁻⁶ / ' + n(F.uF(sAll))),
    final('I<sub>n</sub> = ' + r(F.mA(m.In_mA)) + ' mA')
  );
  // Step 5: Q
  html += fStep(5,
    'พลังงานรีแอคทีฟรวม (Q)',
    'Q = V²·ωC_eq',
    'เมื่อ CT ต่อจุดกลางเข้าหากัน วงจรเท่ากับ (A∥B) อนุกรมกับ (C∥D)',
    sym('C<sub>eq</sub> = (C<sub>A</sub>+C<sub>B</sub>)(C<sub>C</sub>+C<sub>D</sub>) / ΣC, &nbsp; Q = V<sub>ph</sub>² · ω · C<sub>eq</sub>'),
    eq('C<sub>eq</sub> = ' + n(F.uF(m.Ceq_uF)) + ' µF'),
    final('Q = ' + r(F.Mvar(m.Qt)) + ' Mvar')
  );

  html += '</div>';
  return html;
}

window.buildYYFormulas = buildYYFormulas;
window.buildHBridgeFormulas = buildHBridgeFormulas;
