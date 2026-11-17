// ═══════════════════════════════════════
// UI
// ═══════════════════════════════════════
'use strict';
const F2={uF:v=>isNaN(v)?'—':Number(v).toFixed(4),mA:v=>isNaN(v)?'—':Number(v).toFixed(4),S:v=>isNaN(v)?'—':(Number(v)*1e6).toFixed(3),V:v=>isNaN(v)?'—':Number(v).toFixed(2),Mvar:v=>isNaN(v)?'—':Number(v).toFixed(3),Ohm:v=>isNaN(v)?'—':Number(v).toFixed(2)};
// Relay-alarm threshold (mA). Default from calculator.js; refreshed per-render in
// renderResults() from the user-entered value carried on engBefore.thresholdMA.
let ALARM = (typeof window!=='undefined' && window.ALARM_MA) || 50;
// Capacitor rating (v9.5): a unit OUTSIDE the tolerance band of rated C (either side)
// is "failed" (เสีย). Refreshed per render from engBefore.capSpec (Step 2 inputs).
let CAPSPEC = (typeof capSpecOf === 'function') ? capSpecOf() : null;
// Max spread (µF) of the per-phase SERIES C WITHIN each wye — balance goal is
// A=B=C on Y1 AND A'=B'=C' on Y2 (YY only). The optimizer's primary objective.
let SPREADTOL = (typeof window!=='undefined' && window.PHASE_SPREAD_UF) || 0.005;   // series µF; refreshed per render (v10.0)
let BALSUM = 0.1;                                                                    // ΣC per rack (µF), field-sheet units
function unitBelowNameplate(c){   // name kept; now = outside the tolerance band
  return (typeof unitOutOfTolerance === 'function') ? unitOutOfTolerance(c, CAPSPEC) : false;
}

function buildEngPanelFull(title,m,topology){
  let items=[];
  if(topology==='h-bridge'){
    const c=m.In_mA>10?'bad':m.In_mA>1?'warn':'good';
    items=[
      {l:'Σ C Left (A+C)',v:F2.uF(m.CA_top_uF+m.CA_bot_uF),u:'µF',c:'hi-blue',vc:'hi'},
      {l:'Σ C Right (B+D)',v:F2.uF(m.CB_top_uF+m.CB_bot_uF),u:'µF',c:'hi-amber',vc:'warn'},
      {l:'V จุดกลาง ซ้าย (A/C)',v:F2.V(m.VxL),u:'V',c:'hi-blue',vc:''},
      {l:'V จุดกลาง ขวา (B/D)',v:F2.V(m.VxR),u:'V',c:'hi-amber',vc:''},
      {l:'I_bridge (60P)',v:F2.mA(m.In_mA),u:'mA',c:'hi-red',vc:c},
      {l:'Q รวม',v:F2.Mvar(m.Qt),u:'Mvar',c:'hi-green',vc:'good'},
    ];
  } else {
    const c=m.Ino_mA>=ALARM?'bad':m.Ino_mA>=ALARM*0.2?'warn':'good';
    // Series C compared WITHIN each side: Y1 shows A/B/C together, Y2 shows A'/B'/C'
    // together — no cross-side pairing (balance goal = A=B=C on Y1, A'=B'=C' on Y2).
    items=[
      {l:'อนุกรม Y1 · A/B/C',v:[m.perPhase.A.C1,m.perPhase.B.C1,m.perPhase.C.C1].map(x=>x.toFixed(3)).join(' / '),u:'µF',c:'hi-blue',vc:''},
      {l:'อนุกรม Y2 · A\'/B\'/C\'',v:[m.perPhase.A.C2,m.perPhase.B.C2,m.perPhase.C.C2].map(x=>x.toFixed(3)).join(' / '),u:'µF',c:'hi-blue',vc:''},
    ];
    // Per-phase PARALLEL SUM comparison (A vs B vs C, each side) — display only.
    // Lets the engineer eyeball the direct-sum balance alongside the series values;
    // it does NOT drive the pass/fail (that uses the series ΔC below).
    if (m.perPhase && m.perPhase.A.sum1 != null) {
      const spr = a => Math.max.apply(null,a) - Math.min.apply(null,a);
      const y1s = [m.perPhase.A.sum1, m.perPhase.B.sum1, m.perPhase.C.sum1];
      const y2s = [m.perPhase.A.sum2, m.perPhase.B.sum2, m.perPhase.C.sum2];
      items.push({l:'ผลรวม Y1 · A/B/C', v:y1s.map(x=>x.toFixed(3)).join(' / '), u:'µF', c:'hi-teal', vc:''});
      items.push({l:'ผลรวม Y2 · A\'/B\'/C\'', v:y2s.map(x=>x.toFixed(3)).join(' / '), u:'µF', c:'hi-teal', vc:''});
      items.push({l:'ΔC ผลรวมในฝั่ง (Y1 / Y2)', v:spr(y1s).toFixed(3)+' / '+spr(y2s).toFixed(3), u:'µF', c:'hi-teal', vc:''});
    }
    // Susceptance per phase (siemens) — wye-1 vs wye-2
    if (m.perPhase && m.S) {
      const Spairs = [['A','S1','S4'],['B','S2','S5'],['C','S3','S6']];
      Spairs.forEach(([ph,k1,k2]) => {
        items.push({l:'S '+ph+' (Y1/Y2)',v:(m.S[k1]*1000).toFixed(3)+' / '+(m.S[k2]*1000).toFixed(3),u:'mS',c:'hi-amber',vc:''});
      });
    }
    items.push({l:'V_no (เฟสเซอร์)',v:F2.V(m.Vno),u:'V',c:'hi-amber',vc:'warn'});
    items.push({l:'I_no (CT, เฟสเซอร์)',v:F2.mA(m.Ino_mA),u:'mA',c:'hi-red',vc:c});
    if (m.spread && isFinite(m.spread.max)) {
      items.push({l:'ΔΣC ต่อเฟสในฝั่ง (A=B=C / A\'=B\'=C\')',
        v:m.spread.max.toFixed(2)+' (Y1 '+m.spread.y1.toFixed(2)+' / Y2 '+m.spread.y2.toFixed(2)+')',
        u:'µF',c:'hi-amber',vc:m.spread.ok?'good':'bad'});
    }
    items.push({l:'Q รวม',v:F2.Mvar(m.Qt),u:'Mvar',c:'hi-green',vc:'good'});
  }
  return `<div class="eng-panel-full">
    <div class="eng-panel-title"><i class="fas fa-calculator"></i> ${title}</div>
    <div class="eng-grid-sym">${items.map(it=>`
      <div class="eng-item ${it.c}">
        <div class="ei-lbl">${it.l}</div>
        <div class="ei-val ${it.vc}">${it.v}<span class="ei-unit">${it.u}</span></div>
      </div>`).join('')}
    </div>
  </div>`;
}

function buildSolEng(m,topology){
  if(!m) return '';
  let items=[];
  if(topology==='h-bridge'){
    const c=m.In_mA>10?'bad':m.In_mA>1?'warn':'good';
    items=[
      {l:'ΔV จุดกลาง ซ้าย−ขวา',v:F2.V(Math.abs((m.VxL||0)-(m.VxR||0))),u:'V',c:'hi-blue',vc:''},
      {l:'I_bridge (60P)',v:F2.mA(m.In_mA),u:'mA',c:'hi-amber',vc:c},
      {l:'Q รวม',v:F2.Mvar(m.Qt),u:'Mvar',c:'hi-green',vc:'good'},
    ];
  } else {
    const c=m.Ino_mA>=ALARM?'bad':m.Ino_mA>=ALARM*0.2?'warn':'good';
    items=[
      {l:'I_no CT (N1-N2)',v:F2.mA(m.Ino_mA),u:'mA',c:'hi-amber',vc:c},
      {l:'V_no (neutral เลื่อน)',v:F2.V(m.Vno),u:'V',c:'hi-blue',vc:''},
      {l:'Q รวม',v:F2.Mvar(m.Qt),u:'Mvar',c:'hi-green',vc:'good'},
    ];
    // v9.6 — the quantities that actually matter (replaces Σ C Y1 / Σ C Y2):
    //   ΔC within each wye (true balance) and per-phase total ratio (IEC ≤ 1.08).
    if (m.perPhase && m.perPhase.A && m.perPhase.A.C1 != null) {
      const pp = m.perPhase, ph = ['A','B','C'];
      const sp = a => Math.max.apply(null,a) - Math.min.apply(null,a);
      const d1 = sp(ph.map(p=>pp[p].sum1)), d2 = sp(ph.map(p=>pp[p].sum2));   // v10.3: ΣC per phase
      const tot = ph.map(p=>pp[p].C1+pp[p].C2), ratio = Math.max.apply(null,tot)/Math.min.apply(null,tot);
      items.unshift({l:'ΔΣC ต่อเฟสในฝั่ง Y1 · Y2',v:d1.toFixed(2)+' · '+d2.toFixed(2),u:'µF',c:'hi-teal',
                     vc:(Math.max(d1,d2) <= BALSUM + 1e-9) ? 'good' : 'warn'});
      items.push({l:'C ต่อเฟส max/min',v:ratio.toFixed(4),u:'(≤1.08)',c:'hi-teal',vc: ratio <= 1.08 ? 'good' : 'bad'});
    }
    // Per-phase PARALLEL SUM after the swap, compared WITHIN each side (display only).
    if (m.perPhase && m.perPhase.A.sum1 != null) {
      const y1s=[m.perPhase.A.sum1,m.perPhase.B.sum1,m.perPhase.C.sum1];
      const y2s=[m.perPhase.A.sum2,m.perPhase.B.sum2,m.perPhase.C.sum2];
      items.push({l:'ผลรวม Y1 · A/B/C',v:y1s.map(x=>x.toFixed(3)).join(' / '),u:'µF',c:'hi-teal',vc:''});
      items.push({l:'ผลรวม Y2 · A\'/B\'/C\'',v:y2s.map(x=>x.toFixed(3)).join(' / '),u:'µF',c:'hi-teal',vc:''});
    }
  }
  return `<div class="sol-eng">${items.map(it=>`
    <div class="sol-eng-item ${it.c}">
      <div class="sei-lbl">${it.l}</div>
      <div class="sei-val ${it.vc}">${it.v}<span class="sei-unit">${it.u}</span></div>
    </div>`).join('')}
  </div>`;
}

function renderResults(vals,result){
  const {quickResult,fullResult,engBefore}=result;
  const topology=vals.topology;
  // Refresh the alarm threshold from the user-entered value (Step 2), carried on
  // engBefore.thresholdMA. Falls back to the default ALARM_MA if absent.
  ALARM = (engBefore && engBefore.thresholdMA > 0) ? engBefore.thresholdMA
        : ((typeof window!=='undefined' && window.ALARM_MA) || 50);
  if (engBefore && engBefore.capSpec) CAPSPEC = engBefore.capSpec;
  if (engBefore && engBefore.phaseSpreadTol > 0) SPREADTOL = engBefore.phaseSpreadTol;   // v10.0 user-set
  if (engBefore && engBefore.balSumUF > 0) BALSUM = engBefore.balSumUF;
  const sumY1=vals.y1.reduce((a,c)=>a+c.val,0);
  const sumY2=vals.y2.reduce((a,c)=>a+c.val,0);
  const baseDiff=Math.abs(sumY1-sumY2);

  const lblBase = document.getElementById('lblBase'), vnoRow = document.getElementById('rowVnoBefore');
  if (topology==='h-bridge' || !engBefore || !engBefore.perPhase) {
    document.getElementById('lblSide1').textContent=topology==='h-bridge'?'Σ C Left (A+C)':'Σ C (Y1)';
    document.getElementById('lblSide2').textContent=topology==='h-bridge'?'Σ C Right (B+D)':'Σ C (Y2)';
    if (lblBase) lblBase.textContent='ΔC';
    document.getElementById('totalY1').textContent=sumY1.toFixed(4)+' µF';
    document.getElementById('totalY2').textContent=sumY2.toFixed(4)+' µF';
    document.getElementById('totalBase').textContent=baseDiff.toFixed(4)+' µF';
    if (vnoRow) vnoRow.hidden = true;
  } else {
    // v9.6 — Σ Y1 vs Σ Y2 does not drive I_no (two balanced wyes can differ). Show the
    // quantities that matter: ΔC WITHIN each wye, per-phase total ratio, and Vno.
    const pp = engBefore.perPhase, ph = ['A','B','C'];
    const sp = a => Math.max.apply(null,a) - Math.min.apply(null,a);
    const d1 = sp(ph.map(p=>pp[p].sum1)), d2 = sp(ph.map(p=>pp[p].sum2));   // v10.3: ΣC per phase
    const tot = ph.map(p=>pp[p].C1+pp[p].C2), ratio = Math.max.apply(null,tot)/Math.min.apply(null,tot);
    const flag = (el, bad) => { el.className = 'tc-val ' + (bad ? 'tc-danger' : 'tc-safe'); };
    document.getElementById('lblSide1').textContent='ΔΣC ต่อเฟส Y1 (A/B/C)';
    document.getElementById('lblSide2').textContent="ΔΣC ต่อเฟส Y2 (A'/B'/C')";
    if (lblBase) lblBase.textContent='C ต่อเฟส max/min (≤1.08)';
    const e1=document.getElementById('totalY1'), e2=document.getElementById('totalY2'), e3=document.getElementById('totalBase');
    e1.textContent=d1.toFixed(2)+' µF'; flag(e1, d1 > BALSUM + 1e-9);
    e2.textContent=d2.toFixed(2)+' µF'; flag(e2, d2 > BALSUM + 1e-9);
    e3.textContent=ratio.toFixed(4);    flag(e3, ratio > 1.08);
    const ev=document.getElementById('vnoBefore');
    if (ev) ev.textContent=(engBefore.Vno!=null?engBefore.Vno.toFixed(2):'—')+' V';
    if (vnoRow) vnoRow.hidden = false;
  }

  // Show Ino before in the totals area
  const inoBeforeEl = document.getElementById('inoBefore');
  if (inoBeforeEl && engBefore) {
    const ib = engBefore.Ino_mA_before || 0;
    inoBeforeEl.textContent = ib.toFixed(2) + ' mA';
    inoBeforeEl.className = 'tc-val ' + (ib >= ALARM ? 'tc-danger' : 'tc-safe');
  }
  document.getElementById('topoLabel').textContent=topology==='h-bridge'?'H-Bridge (4 Legs)':'Y-Y Ungrounded';
  document.getElementById('vsLabel').textContent=vals.systemKV+' kV';
  document.getElementById('vphLabel').textContent=(vals.systemKV*1000/Math.sqrt(3)/1000).toFixed(2)+' kV';

  // Engineering metrics
  document.getElementById('engMetricsSection').innerHTML=
    buildEngPanelFull('ค่าทางไฟฟ้าก่อนสับ',engBefore,topology);

  // Formulas with real values
  const fSec=document.getElementById('formulaSection');
  if(typeof buildYYFormulas==='function'&&typeof buildHBridgeFormulas==='function'){
    fSec.innerHTML=topology==='h-bridge'
      ?buildHBridgeFormulas(vals,engBefore)
      :buildYYFormulas(vals,engBefore);
  }

  const lockedBanner = quickResult.lockedNote
    ? `<div class="locked-note"><i class="fas fa-lock"></i> ${quickResult.lockedNote}</div>`
    : '';

  // ── AUTO recommendation = FEWEST swaps that is "good enough" (saves field time) ──
  // Priority: fewest swaps that FULLY passes (relay + balance) → fewest that passes
  // the relay → else the "knee": fewest swaps that already captures ≥ KNEE_KEEP of
  // the best achievable I_no reduction (more swaps beyond it barely help). We do NOT
  // chase the absolute lowest I_no when a smaller swap count is already acceptable.
  const KNEE_KEEP = 0.85;
  const inoOfSw = sw => sw.Ino_mA != null ? sw.Ino_mA
    : (sw.engAfter ? (topology==='h-bridge'?sw.engAfter.In_mA:sw.engAfter.Ino_mA) : Infinity);
  const beforeIno = (engBefore && engBefore.Ino_mA_before) || Infinity;
  const allOpts = quickResult.swaps.map((sw,i)=>({
    i, ns: sw.actualSwaps != null ? sw.actualSwaps : (sw.swapCount != null ? sw.swapCount : [2,4,6][i]), ino: inoOfSw(sw),
    pass: !!sw.underThreshold, full: !!(sw.underThreshold && sw.spreadOK),
    fail: sw._fail || 0, ov: !!sw.overV
  }));
  // F3 (v9.6): never recommend a plan that leaves MORE failed units in (or overvoltages
  // a unit) when another option avoids it — even if its I_no looks lower (a failed
  // unit can be masking another imbalance).
  const minFail = Math.min.apply(null, allOpts.map(o=>o.fail));
  let opts = allOpts.filter(o=>o.fail===minFail && !o.ov);
  if (!opts.length) opts = allOpts.filter(o=>o.fail===minFail);
  const bestIno = Math.min.apply(null, opts.map(o=>o.ino));
  const totalGain = Math.max(0, beforeIno - bestIno);
  // fewest swaps first; among equal swap-counts prefer the balanced one, then lower I_no.
  const fewest = arr => arr.slice().sort((a,b)=> a.ns - b.ns || (b.full?1:0)-(a.full?1:0) || a.ino - b.ino)[0];
  // Clearing the RELAY is the field requirement → recommend the FEWEST swaps that
  // does it (that's the minimum work that makes the bank safe). If nothing clears
  // the relay, use the "knee" (fewest swaps that already captured ≥ KNEE_KEEP of the
  // gain). Full phase-balance / lower I_no is offered via the 2/4/6 cards + note.
  const rec =
    fewest(opts.filter(o=>o.pass)) ||
    fewest(opts.filter(o=> totalGain<=1e-9 ? true : (beforeIno - o.ino) >= KNEE_KEEP*totalGain)) ||
    opts.reduce((a,b)=> b.ino<a.ino?b:a);
  // F3: if the comparison table has a plan for the SELECTED ref, recommend that one —
  // it is the least work (fewest swaps, then spares) that gets below the ref with the
  // failed units out. Otherwise fall back to the budget cards (logic above).
  // v10.1: "ใช้ค่านี้" in the comparison table → THAT row's plan is the recommendation;
  // otherwise the balance-first plan for the selected ref (refBest).
  const picked = !!(vals && vals.pickRef === ALARM);
  const refRow = (topology!=='h-bridge')
    ? ((picked && quickResult.refTable) ? quickResult.refTable.find(r => r.ref === ALARM && r.plan)
       : (quickResult.refBest || quickResult.refTable || []).find(r => r.ref === ALARM && r.plan)) || null
    : null;
  let autoSw, recFromRef = false;
  // v9.9: spare shortage → TEMPORARY plan (failed units may move to balance each side)
  const tempPlan = (topology!=='h-bridge') ? (quickResult.tempPlan || null) : null;
  const sparesOnly = (topology!=='h-bridge' && !tempPlan) ? quickResult.sparesOnly : null;   // v9.8 #4
  const shortMode = !!(tempPlan || sparesOnly);
  if (tempPlan) {
    autoSw = tempPlan;
  } else if (sparesOnly) {
    autoSw = sparesOnly;                     // can't pass with the spares on hand → only the useful work
  } else if (refRow) {
    autoSw = refRow.plan; recFromRef = true;
    rec.ns = autoSw.actualSwaps; rec.pass = true; rec.full = !!(autoSw.underThreshold && autoSw.spreadOK);
  } else {
    autoSw = quickResult.swaps[rec.i];
    quickResult.swaps[rec.i].isRecommended = true;
  }
  quickResult.recommended = autoSw;          // Excel export uses this (same plan as the card)
  const extraGain = autoSw.actualSwaps>0 ? (inoOfSw(autoSw) - bestIno) : 0; // more swaps could still remove this much
  // is there a heavier option that ALSO reaches full balance, when rec isn't balanced?
  const fullerOpt = !rec.full ? fewest(opts.filter(o=>o.full && o.ns>rec.ns)) : null;
  // ⭐ best-value row of the ref comparison (if it costs more swaps than the recommendation)
  const bestRow = (topology!=='h-bridge' && quickResult.refTable)
    ? quickResult.refTable.find(r => r.bestValue && r.plan && r.gainPerSwap != null) : null;
  const maxD = quickResult.maxDepth || 6;
  const autoWhy = recFromRef ? (picked ? `เลือกจากตาราง: สับน้อยที่สุดที่ทำให้ I<sub>no</sub> ต่ำกว่า ${ALARM} mA`
                                      : `สับน้อยที่สุดที่ I<sub>no</sub> ต่ำกว่า ${ALARM} mA และผลรวมต่อเฟสต่างกันไม่เกิน ${BALSUM} µF`)
                : rec.full ? 'สับน้อยที่สุดที่ผ่านทั้งรีเลย์และบาลานซ์'
                : rec.pass ? 'สับน้อยที่สุดที่รีเลย์ผ่าน'
                : `ยังไม่ผ่าน นี่คือผลที่ดีที่สุดภายใน ${maxD} ครั้ง`;
  const autoTitle = tempPlan
    ? `แผนแนะนำ (ชั่วคราว เพราะ spare ไม่พอ): สับ ${tempPlan.actualSwaps} ครั้ง เปลี่ยนลูกที่เสียหนักสุด ${tempPlan.sparesUsed} ลูก แล้วกระจายลูกเสียที่เหลือให้แต่ละเฟสเท่ากัน`
    : sparesOnly
    ? `แผนแนะนำ: เปลี่ยนลูกที่เสียหนักสุด ${sparesOnly.actualSwaps} ลูกด้วย spare ที่มี (ยังไม่ผ่าน ต้องหา spare ดีเพิ่มอีก ${quickResult.sparesShort} ลูก)`
    : `แผนแนะนำ: สับ ${autoSw.actualSwaps} ครั้ง (${autoWhy})`;
  const autoCard = buildSolCard('s1', autoTitle, Object.assign({}, autoSw, {isRecommended:true}), true, topology);

  // ── Big before → after summary banner (field-worker friendly) ──
  const inoBeforeVal = (engBefore && engBefore.Ino_mA_before) || 0;
  const inoAfterVal = autoSw.Ino_mA != null ? autoSw.Ino_mA : inoBeforeVal;
  const afterPass = inoAfterVal < ALARM;
  const summaryBanner = `
    <div class="result-summary ${afterPass?'rs-pass':'rs-fail'}">
      <div class="rs-verdict">
        <i class="fas fa-${afterPass?'circle-check':'triangle-exclamation'}"></i>
        ${afterPass?'ผ่าน':'ยังไม่ผ่าน'}
      </div>
      <div class="rs-flow">
        <div class="rs-cell">
          <div class="rs-cap">ก่อนสับ</div>
          <div class="rs-num ${inoBeforeVal>=ALARM?'rs-danger':'rs-safe'}">${inoBeforeVal.toFixed(2)}<span>mA</span></div>
        </div>
        <i class="fas fa-arrow-right rs-arrow"></i>
        <div class="rs-cell">
          <div class="rs-cap">หลังสับ ${autoSw.actualSwaps} ครั้ง</div>
          <div class="rs-num ${afterPass?'rs-safe':'rs-danger'}">${inoAfterVal.toFixed(2)}<span>mA</span></div>
        </div>
      </div>
      <div class="rs-note">เกณฑ์รีเลย์: I<sub>no</sub> ต้องต่ำกว่า ${ALARM} mA</div>
      ${tempPlan
        ? `<div class="rs-note rs-warn">ลูกเสียมี ${quickResult.failedTotal} ลูก แต่มี spare ดีแค่ ${tempPlan.sparesUsed} ลูก แผนนี้จึงเป็นการจัดชั่วคราว: เปลี่ยนลูกที่เสียหนักสุดก่อน แล้วย้ายลูกเสียที่เหลือ${tempPlan.movedFailed ? ` (${tempPlan.movedFailed} ครั้ง)` : ''} ไปกระจายให้แต่ละเฟสเท่ากัน เพื่อให้ใช้งานแบงค์ต่อได้ทันที</div>` +
          `<div class="rs-note rs-warn">ลูกเสียที่ยังค้างอยู่จะรับแรงดันสูงกว่าปกติ (สูงสุด ${tempPlan.unitV && isFinite(tempPlan.unitV.maxPctShare) ? tempPlan.unitV.maxPctShare.toFixed(1) + '% ของค่าเฉลี่ย' : '-'}) และเสื่อมเร็วขึ้น ควรหา spare ดีเพิ่มอีก <b>${quickResult.sparesShort} ลูก</b> แล้วคำนวณใหม่เพื่อถอดออกให้หมด</div>`
        : sparesOnly
        ? `<div class="rs-note rs-warn">ลูกเสียมี ${quickResult.failedTotal} ลูก แต่มี spare ดีแค่ ${sparesOnly.sparesUsed} ลูก ตอนนี้จัดแบบไหนก็ยังไม่ผ่าน</div>` +
          `<div class="rs-note">ทำได้ตอนนี้: เปลี่ยนลูกที่เสียหนักสุด ${sparesOnly.sparesUsed} ลูกก่อน แล้วหา spare ดีเพิ่มอีก <b>${quickResult.sparesShort} ลูก</b> ค่อยคำนวณใหม่เพื่อจัดบาลานซ์ (ยังไม่ต้องสลับใน rack ตอนนี้ เพราะต้องจัดใหม่อีกรอบเมื่อได้ spare)</div>`
        : (!autoSw.underThreshold && topology!=='h-bridge')
        ? `<div class="rs-note">สับครบ ${maxD} ครั้งแล้วยังไม่ผ่าน ต้องเพิ่ม spare ดี หรือทวนค่าที่วัดอีกครั้ง${(autoSw._fail||0)>0 ? ` (ยังเหลือลูกเสีย ${autoSw._fail} ลูก)` : ''}</div>`
        : ''}
      ${(topology!=='h-bridge' && autoSw.spread && isFinite(autoSw.spread.max))
        ? `<div class="rs-note">ผลรวม C ต่อเฟสต่างกัน: Y1 <b>${autoSw.spread.y1.toFixed(2)}</b> · Y2 <b>${autoSw.spread.y2.toFixed(2)}</b> µF ${autoSw.spread.ok?'ผ่าน':'ยังไม่ผ่าน'} (เกณฑ์ไม่เกิน ${BALSUM} µF)</div>` +
          `<div class="rs-note">เทียบกับเกณฑ์: I<sub>no</sub> ใช้ไป ${Math.round(autoSw.Ino_mA/ALARM*100)}% · ผลรวมต่อเฟสใช้ไป ${Math.round(autoSw.spread.max/BALSUM*100)}% (ต้องไม่เกิน 100% ทั้งคู่)</div>` +
          // G2 (v9.7): I_no passes only because the two wyes are off in the SAME way
          ((autoSw.underThreshold && !autoSw.spread.ok)
            ? `<div class="rs-note rs-warn">I<sub>no</sub> ผ่านเพราะความเพี้ยนของสองฝั่ง<b>หักล้างกัน</b> แต่ละฝั่งยังไม่บาลานซ์ (Y1 ${autoSw.spread.y1.toFixed(2)} · Y2 ${autoSw.spread.y2.toFixed(2)} µF) ถ้าลูกใดลูกหนึ่งค่าเปลี่ยน I<sub>no</sub> จะขึ้นได้ง่าย</div>`
            : '') +
          (((autoSw._fail || 0) > 0 && !shortMode)          // spares-only mode already says this
            ? `<div class="rs-note rs-warn">ยังเหลือลูกเสีย ${autoSw._fail} ลูก (เหลือไว้เฉพาะลูกที่เสียน้อยสุด) ต้องหา spare ดีเพิ่มอีก <b>${autoSw._fail} ลูก</b> จึงจะถอดออกได้ครบ</div>`
            : '')
        : ''}
      ${shortMode ? '' : `<div class="rs-note">${
        // v9.6: the hint follows the ref table's ⭐ rule (≥ INO_WORTH_MA_PER_SWAP saved
        // per extra swap) so the banner and the table never contradict each other.
        // (v9.8: no hint in spares-only mode — nothing passes, so "swap more" is moot.)
        (bestRow && bestRow.plan.actualSwaps > autoSw.actualSwaps)
          ? `ถ้าสับเพิ่มอีก ${bestRow.plan.actualSwaps - autoSw.actualSwaps} ครั้ง (รวม ${bestRow.plan.actualSwaps}) I<sub>no</sub> จะลดเหลือ ${bestRow.plan.Ino_mA.toFixed(1)} mA <button type="button" class="ans-up" onclick="useInoRef(${bestRow.ref})">ใช้แผนนี้</button>`
          : fullerOpt
          ? `สับ ${autoSw.actualSwaps} ครั้งก็พอให้รีเลย์ผ่าน ถ้าต้องการบาลานซ์ครบด้วย ใช้ ${fullerOpt.ns} ครั้ง (ดูตัวเลือกด้านล่าง)`
          : extraGain > 0.5
          ? `สับ ${autoSw.actualSwaps} ครั้งนี้พอแล้ว สับเพิ่มจะลด I<sub>no</sub> ได้อีกราว ${extraGain.toFixed(1)} mA เท่านั้น`
          : `สับ ${autoSw.actualSwaps} ครั้งนี้ดีที่สุดแล้ว สับเพิ่มไม่ทำให้ I<sub>no</sub> ลดลง`
      }</div>`}
    </div>`;

  const nBud = quickResult.swaps.length;
  const fixedCards = quickResult.swaps.map((sw,i)=>{
    const target=(sw.swapCount!=null)?sw.swapCount:[2,4,6][i];
    const isExt = quickResult.extended && i === nBud-1;      // F2: deeper search budget
    const cls = isExt ? 's3' : (['s2','s2','s3'][i] || 's2');
    const name = isExt ? `สูงสุด ${target} ครั้ง (ค้นหาเพิ่ม)` : `${target} ครั้ง`;
    const actual=(sw.actualSwaps!=null)?sw.actualSwaps:target;
    let label;
    if (actual===0) label = `ตัวเลือก ${name}: ไม่มีการสับที่ช่วยลด I<sub>no</sub>`;
    else if (actual<target) label = `ตัวเลือก ${name} (ใช้จริง ${actual} ครั้ง)`;
    else label = `ตัวเลือก ${name}`;
    return buildSolCard(cls, label, sw, true, topology);
  }).join('');

  const budgetList = quickResult.swaps.map(s=>s.swapCount).filter(n=>n!=null).join(' / ');
  const quickIntro = `<div class="locked-note" style="background:var(--green-soft,#e8f5e9);border-color:var(--green,#4caf50);">
    <i class="fas fa-bolt"></i> แผนแนะนำด้านล่างคือแผนที่สับน้อยที่สุด (ถอดลูกเสียก่อน และใช้ spare เท่าที่จำเป็น)
    ต่อจากนั้นเป็นตัวเลือกแบบกำหนดจำนวนครั้ง ${budgetList||'2 / 4 / 6'} ครั้ง ให้เลือกตามเวลาที่มีหน้างาน</div>`;

  // v10.6 — the answer comes first: verdict + plan summary + steps + rack map (+ checklist)
  document.getElementById('answerSection').innerHTML = buildAnswer(summaryBanner, autoSw, quickResult, topology);
  const cl = document.getElementById('checklistSection'); cl.hidden = true; cl.innerHTML = '';
  document.getElementById('answerSection').hidden = false;
  document.getElementById('tabQuick').innerHTML = lockedBanner + buildRefTable(quickResult, topology) + quickIntro + autoCard +
    `<div style="margin:18px 0 8px;font-weight:700;color:var(--txt2,#555);font-size:0.95rem;">
      <i class="fas fa-hand-pointer"></i> ตัวเลือกแบบกำหนดจำนวนครั้ง</div>` +
    fixedCards;

  // Full tab = same auto-best (kept for compatibility / Excel export)
  const fullSteps = (fullResult.steps && fullResult.steps.length)
    ? fullResult.steps
    : [`จัดใหม่ ${fullResult.swapCount||fullResult.actualSwaps||0} ครั้ง`];
  const fullSw={diff:fullResult.diff,y1:fullResult.y1,y2:fullResult.y2,y1Full:fullResult.y1Full,y2Full:fullResult.y2Full,engAfter:fullResult.engAfter,underThreshold:fullResult.underThreshold,spread:fullResult.spread,acts:fullResult.acts,actualSwaps:fullResult.actualSwaps,steps:fullSteps};
  const fullTitle = `แผนจากการค้นหาลึกสุด: สับ ${fullResult.actualSwaps!=null?fullResult.actualSwaps:(fullResult.swapCount||0)} ครั้ง`;
  document.getElementById('tabFull').innerHTML = lockedBanner + buildSolCard('full',fullTitle,fullSw,true,topology);

  switchCalcView('results');
  switchTab('quick');
}

function buildSolCard(cls,title,sw,showSteps,topology){
  // Use full arrays (swapped + locked items) for totals and capList display
  const y1Disp = sw.y1Full || sw.y1;
  const y2Disp = sw.y2Full || sw.y2;
  const s1=y1Disp.reduce((a,c)=>a+c.val,0);
  const s2=y2Disp.reduce((a,c)=>a+c.val,0);
  const steps=showSteps
    ?`<div class="steps-box"><div class="steps-title"><i class="fas fa-list-ol"></i> ขั้นตอนหน้างาน</div>
       ${sw.steps.map((s,i)=>`<div class="step-item"><span class="step-num">${i+1}</span><span>${s}</span></div>`).join('')}</div>`
    :`<div class="steps-box"><div class="steps-title"><i class="fas fa-info-circle"></i> สรุปการดำเนินการ</div>
       <div class="step-item"><span class="step-num">✓</span><span>${sw.steps[0]}</span></div></div>`;
  // Ino badge — PRIMARY indicator
  const inoVal = sw.engAfter ? (topology==='h-bridge' ? sw.engAfter.In_mA : sw.engAfter.Ino_mA) : null;
  const pass = inoVal !== null && inoVal < ALARM;
  const inoClass = inoVal !== null ? (pass ? 'pass' : 'fail') : '';
  const inoBadge = inoVal !== null
    ? `<span class="ino-badge ${inoClass}">
         <i class="fas fa-${pass?'check-circle':'exclamation-triangle'}"></i>
         ${pass?'ผ่าน':'ไม่ผ่าน'} · I<sub>no</sub> = ${inoVal.toFixed(2)} mA
         <small>${pass?`(< ${ALARM} mA)`:`(เกิน ${ALARM} mA)`}</small>
       </span>`
    : '';
  // Phase-balance badge — ΔC across ALL SIX series-C values (YY only)
  let spreadBadge = '';
  if (topology!=='h-bridge' && sw.spread && isFinite(sw.spread.max)) {
    const sok = (sw.spread.ok != null) ? sw.spread.ok : (sw.spread.max <= BALSUM + 1e-9);
    spreadBadge = `<span class="ino-badge ${sok?'pass':'fail'}"
         title="ผลรวม C ต่อเฟสในฝั่ง (A=B=C บน Y1, A'=B'=C' บน Y2) — ΔΣC Y1 ${sw.spread.y1.toFixed(2)} / Y2 ${sw.spread.y2.toFixed(2)} µF">
         <i class="fas fa-${sok?'check-circle':'exclamation-triangle'}"></i>
         ΔΣC เฟส = ${sw.spread.max.toFixed(2)} µF <small>(${sok?'≤':'>'} ${BALSUM} µF)</small>
       </span>`;
  }
  // Unit-voltage badge (v9.5): worst unit vs 110 % of rated (if rated kV entered),
  // otherwise vs its balanced share — the "hidden failure" check I_no can't see.
  let voltBadge = '';
  if (topology!=='h-bridge' && sw.unitV && sw.unitV.maxKV > 0) {
    const u = sw.unitV;
    voltBadge = u.maxPctRated != null
      ? `<span class="ino-badge ${u.ovCount ? 'fail' : 'pass'}" title="ตัวที่รับแรงดันสูงสุด: ${u.worstId} = ${u.maxKV.toFixed(3)} kV">
           <i class="fas fa-${u.ovCount ? 'exclamation-triangle' : 'bolt'}"></i>
           V ตัวสูงสุด = ${u.maxPctRated.toFixed(1)}% <small>(${u.ovCount ? 'เกิน' : '≤'} 110% พิกัด)</small></span>`
      : `<span class="ino-badge ${u.maxPctShare > 105 ? 'fail' : 'pass'}" title="ตัวที่รับแรงดันสูงสุด: ${u.worstId} = ${u.maxKV.toFixed(3)} kV (ไม่ได้กรอกแรงดันพิกัด — เทียบกับค่าเฉลี่ยในสตริง)">
           <i class="fas fa-bolt"></i> V ตัวสูงสุด = ${u.maxPctShare.toFixed(1)}% <small>ของค่าเฉลี่ย</small></span>`;
  }
  const fullyPass = sw.underThreshold && sw.spread && (sw.spread.ok != null ? sw.spread.ok : (sw.spread.max <= BALSUM + 1e-9));
  const recommended = sw.underThreshold && sw.isRecommended
    ? `<div class="recommended-badge"><i class="fas fa-star"></i> แนะนำ — ${
         (topology!=='h-bridge' && sw.spread)
           ? (fullyPass ? `ผ่านทั้ง I<sub>no</sub> < ${ALARM} mA และ ΔΣC เฟส ≤ ${BALSUM} µF` : `สับน้อยที่สุดที่ I<sub>no</sub> < ${ALARM} mA (ΔΣC เฟสยังเกิน ${BALSUM} µF)`)
           : `สับน้อยที่สุดที่ I<sub>no</sub> < ${ALARM} mA`
       }</div>`
    : '';
  return `<div class="sol-card ${cls} ${sw.underThreshold?'sol-pass':'sol-fail'}">
    <div class="sol-top">
      <div class="sol-name">${title}</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        ${inoBadge}
        ${spreadBadge}
        ${voltBadge}
      </div>
    </div>
    ${recommended}
    <div class="sol-body">
      ${steps}
      ${buildSolEng(sw.engAfter,topology)}
      ${(sw.acts && sw.acts.length) ? `<div class="cap-legend">
        <span><span class="lg-sw">1</span> เลขเดียวกัน = สับคู่กัน (ตัวไหนไปไว้ไหน)</span>
        <span><span class="lg-box lg-spare"></span> ใส่จากอะไหล่</span>
        <span><span class="lg-box lg-moved"></span> ย้ายมาจากเฟส/ฝั่งอื่น</span>
        <span><span class="lg-box lg-stay"></span> อยู่เดิม</span>
      </div>` : ''}
      <div class="cap-cols">
        <div class="cap-box">
          <h4>${topology==='h-bridge'?'กิ่งซ้าย (A+C)':'ฝั่ง Y1'} หลังสับ <small>รวม ${s1.toFixed(1)} µF</small></h4>
          ${capList(y1Disp,topology==='h-bridge'?'left':'Y1',sw.acts)}
        </div>
        <div class="cap-box">
          <h4>${topology==='h-bridge'?'กิ่งขวา (B+D)':'ฝั่ง Y2'} หลังสับ <small>รวม ${s2.toFixed(1)} µF</small></h4>
          ${capList(y2Disp,topology==='h-bridge'?'right':'Y2',sw.acts)}
        </div>
      </div>
    </div>
  </div>`;
}

// A unit's ORIGINAL home is encoded in its id ("A-3" → A, "B'-2" → B', "S-1" → S).
// The optimizer re-tags `origin` to the unit's CURRENT position (it must, so
// calcYYMetrics reduces the right per-phase series C), so `origin` alone can NEVER
// tell you whether a unit moved — compare it against the id-derived home instead.
function homeOfUnit(c){
  const id = c.id || '';
  const i = id.lastIndexOf('-');
  return i > 0 ? id.slice(0, i) : (c.origin || '');
}
// unitId → 1-based swap number, so the after-list can show which units took part in
// which swap (an exchange's two units share the same number = they traded places).
function swapIndexMap(acts){
  const m = {};
  (acts || []).forEach((a, i) => {
    const n = i + 1;
    [a.from, a.to, a.u1, a.u2].forEach(u => { if (u && u.id && m[u.id] == null) m[u.id] = n; });
  });
  return m;
}
function seriesCof(arr){
  let inv = 0; arr.forEach(c => { if (c.val > 0) inv += 1 / c.val; });
  return inv > 0 ? 1 / inv : 0;
}

function capRow(c, swapNo){
  const home = homeOfUnit(c);
  const inPool = c.origin === 'Spare';           // an unused spare still in the box
  const fromSpare = !inPool && home === 'S';     // a spare that was swapped IN
  const moved = !inPool && !fromSpare && home !== c.origin;
  let tag, cls = '';
  if (inPool) {
    tag = '<span class="pill p-spare">อะไหล่ (คงเหลือ)</span>';
  } else if (c.pulledPiece) {
    tag = `<span class="pill p-spare"><i class="fas fa-box-open"></i> ลูกที่ถอดจาก ${c.id}</span>`;
    cls = 'is-spare';
  } else if (fromSpare) {
    tag = `<span class="pill p-spare"><i class="fas fa-box-open"></i> ใส่จากอะไหล่</span>`;
    cls = 'is-spare';
  } else if (moved) {
    tag = `<span class="pill p-move"><i class="fas fa-right-left"></i> ย้ายมาจาก ${home}</span>`;
    cls = 'is-moved';
  } else {
    tag = '<span class="pill p-stay">อยู่เดิม</span>';
  }
  const n = swapNo[c.id];
  const badge = n ? `<span class="swap-badge sb-${((n-1)%6)+1}" title="การสับเปลี่ยนครั้งที่ ${n}">${n}</span>` : '';
  const splitNote = c.subKey
    ? `<span style="font-size:0.65rem;color:var(--txt3);margin-left:4px;">[ตัว ${c.subKey.toUpperCase()}]</span>`
    : (c.measuredA != null && c.measuredB != null
        ? `<span style="font-size:0.65rem;color:var(--txt3);margin-left:4px;">[วัดแยก ${c.measuredA.toFixed(2)}+${c.measuredB.toFixed(2)}]</span>`
        : '');
  const outlierTag = c.isOutlier
    ? `<span class="pill p-outlier" title="ห่างจาก mode ${(c.deviation*100).toFixed(1)}%${c.modeRef?` (mode≈${c.modeRef.toFixed(2)}µF)`:''}"><i class="fas fa-bullseye"></i> ห่างจากกลุ่ม</span>`
    : '';
  const failed = !inPool && unitBelowNameplate(c);
  const failTag = failed
    ? `<span class="pill p-fail" title="นอกพิกัด ${CAPSPEC ? CAPSPEC.lo.toFixed(2)+'–'+CAPSPEC.hi.toFixed(2) : ''} µF"><i class="fas fa-triangle-exclamation"></i> นอกพิกัด</span>`
    : '';
  return `<div class="ci ${cls} ${c.isOutlier?'is-outlier':''} ${failed?'is-failed':''}">
    <span class="ci-left">${badge}<span class="cv">${c.val.toFixed(2)}</span><span class="cid"> (${c.id})</span>${splitNote}</span>
    <span class="ci-tags">${failTag}${outlierTag}${tag}</span></div>`;
}

// Grouped by PHASE so the field worker can see the phases apart, with each phase's
// series C (the balance metric) in its header. `acts` (raw swap actions) numbers the
// units that traded places.
// v10.0 — where each scissored PIECE came from. Move-once guarantees each piece position
// changes at most once, so one pass over the actions is exact.
function pieceHistory(acts){
  const h = {};
  (acts || []).forEach((a, i) => {
    const n = i + 1;
    if (a.type === 'piece-replace') {
      h[a.from.id + '.' + a.piece] = { n, src: ((a.to.pulledPiece || !/^S-/.test(a.to.id || '')) ? 'ลูกที่ถอดจาก ' : 'spare ') + a.to.id, old: a.oldVal };
    } else if (a.type === 'piece-swap') {
      h[a.u1.id + '.' + a.p1] = { n, src: 'ลูกจาก ' + a.u2.id + '.' + a.p2, old: a.v1 };
      h[a.u2.id + '.' + a.p2] = { n, src: 'ลูกจาก ' + a.u1.id + '.' + a.p1, old: a.v2 };
    }
  });
  return h;
}
function pairRow(c, ph){
  const pcs = [['a', c.measuredA], ['b', c.measuredB]];
  let changed = 0;
  const lines = pcs.map(([p, v]) => {
    const hh = ph[c.id + '.' + p];
    const bad = CAPSPEC && typeof capValOutOfTol === 'function' && capValOutOfTol(v, CAPSPEC);
    if (hh) changed++;
    const badge = hh ? `<span class="swap-badge sb-${((hh.n-1)%6)+1}" title="การสับเปลี่ยนครั้งที่ ${hh.n}">${hh.n}</span>` : '';
    const src = hh ? `<span class="pc-src">← ${hh.src} <small>(เดิม ${hh.old.toFixed(2)})</small></span>` : '<span class="pill p-stay">อยู่เดิม</span>';
    const failTag = bad ? '<span class="pill p-fail"><i class="fas fa-triangle-exclamation"></i> นอกพิกัด</span>' : '';
    return `<div class="ci-piece ${hh ? 'pc-changed' : ''} ${bad ? 'pc-failed' : ''}">
      <span>${badge}<span class="pc-name">ลูก ${p}</span><span class="pc-val">${v.toFixed(2)}</span> µF</span>
      <span class="ci-tags">${failTag}${src}</span></div>`;
  }).join('');
  const head = `<div class="ci-head"><span class="ci-left"><span class="cv">${c.val.toFixed(2)}</span><span class="cid"> (${c.id})</span><span class="cp-tag">คู่ขนาน วัดแยก</span></span>
    <span class="ci-tags">${changed ? `<span class="pill p-move"><i class="fas fa-screwdriver-wrench"></i> เปลี่ยน ${changed} ลูก</span>` : '<span class="pill p-stay">อยู่เดิม</span>'}</span></div>`;
  return `<div class="ci ci-pair ${changed ? 'is-spare' : ''}">${head}${lines}</div>`;
}
// grouped parallel slots (side "ต่อขนาน 2 ลูก", not measured separately): say it once per phase
function parNote(items){
  if (!CAPSPEC || typeof parallelCountOf !== 'function') return '';
  const n = Math.max(1, ...items.filter(c => c.isLocked).map(c => parallelCountOf(c, CAPSPEC)));
  return n > 1 ? `ช่องละ ${n} ลูกขนาน · ` : '';
}
function capList(arr, tgt, acts){
  const swapNo = swapIndexMap(acts);
  const ph = pieceHistory(acts), slot = slotOrder(acts);
  const isPair = c => c.measuredA != null && c.measuredB != null;
  const rowOf = c => isPair(c) ? pairRow(c, ph) : capRow(c, swapNo);
  const posOf = c => (slot[c.id] != null ? slot[c.id] : (c.pos != null ? c.pos : 999));
  const order = tgt==='Y1'    ? ['A','B','C']
              : tgt==='Y2'    ? ["A'","B'","C'"]
              : tgt==='left'  ? ['A','C']
              : tgt==='right' ? ['B','D'] : null;
  if (!order) return arr.slice().sort((a,b)=>b.val-a.val).map(c=>capRow(c,swapNo)).join('');
  const groups = order.map(ph => ({ ph, items: arr.filter(c => c.origin === ph) }));
  const rest = arr.filter(c => order.indexOf(c.origin) < 0);
  if (rest.length) groups.push({ ph: null, items: rest });   // leftover spares etc.
  const isYY = (tgt==='Y1' || tgt==='Y2');
  return groups.filter(g => g.items.length).map(g => {
    const rows = g.items.slice().sort((a,b)=>posOf(a)-posOf(b)).map(rowOf).join('');   // v10.0: rack order
    const head = g.ph
      ? `<div class="cap-phase-hd"><span class="cph-name">เฟส ${g.ph}</span>` +
        (isYY ? `<span class="cph-c">${parNote(g.items)}ΣC ${g.items.reduce((t, c) => t + (c.val > 0 ? c.val : 0), 0).toFixed(1)} µF · อนุกรม ${seriesCof(g.items).toFixed(3)} µF</span>` : '') +
        `</div>`
      : `<div class="cap-phase-hd"><span class="cph-name">อะไหล่คงเหลือ</span></div>`;
    return `<div class="cap-phase ph-${(g.ph||'spare').replace("'",'p')}">${head}${rows}</div>`;
  }).join('');
}

function switchTab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${name}"]`).classList.add('active');
  document.getElementById('tab'+name.charAt(0).toUpperCase()+name.slice(1)).classList.add('active');
}


// ── I_no reference comparison (v9.5) ────────────────────────────────────────
// One row per I_no ref: the least-effort plan (fewest swaps, then spares) that gets
// below it with the failed units out and no unit overvoltaged. "คุ้มสุด" = the
// tightest ref that costs no more work than the cheapest reachable ref.
function buildRefTable(quickResult, topology) {
  const rows = quickResult && quickResult.refTable;
  if (topology === 'h-bridge' || !rows || !rows.length) return '';
  const cur = ALARM;
  const fmtV = p => !p.unitV ? '—' : (p.unitV.maxPctRated != null
    ? `<span class="${p.unitV.ovCount ? 'rt-bad' : ''}">${p.unitV.maxPctRated.toFixed(1)}% พิกัด</span>`
    : `${p.unitV.maxPctShare.toFixed(1)}% เฉลี่ย`);
  // v10.1 — extra row: the balance-first plan for the selected ref (A=B=C on each side),
  // so the field can compare it with the least-work rows above.
  const bRow = (quickResult.refBest || []).find(r => r.ref === cur && r.plan);
  const balRow = (() => {
    if (!bRow) return '';
    const curRow = rows.find(r => r.ref === cur);
    if (curRow && curRow.plan && curRow.plan.actualSwaps === bRow.plan.actualSwaps && Math.abs(curRow.plan.Ino_mA - bRow.plan.Ino_mA) < 1e-6) return '';   // same plan as the selected row
    const p = bRow.plan, isRec = p === quickResult.recommended;
    return `<tr class="rt-balrow ${isRec ? 'rt-cur' : ''}">
      <td><b>บาลานซ์ครบ</b> <small>(&lt; ${cur} mA)</small> ${isRec ? '<span class="rt-tag rt-tag-cur">แผนที่แนะนำ</span>' : ''}</td>
      <td><b>${p.actualSwaps}</b></td><td>${p.sparesUsed || 0}</td><td>${p.Ino_mA.toFixed(2)}</td>
      <td class="${(p._fail || 0) ? 'rt-bad' : ''}">${p._fail || 0}</td>
      <td class="${p.spread && p.spread.ok ? '' : 'rt-bad'}">${p.spread ? (p.spread.ok ? '✓ ' : '') + p.spread.y1.toFixed(2) + ' / ' + p.spread.y2.toFixed(2) : '—'}</td>
      <td>—</td><td>${fmtV(p)}</td>
      <td>${isRec ? '' : '<button class="rt-use" onclick="handleCalculate()">ใช้แผนนี้</button>'}</td></tr>`;
  })();
  const body = rows.map(row => {
    const p = row.plan, isCur = row.ref === cur;
    if (!p) return `<tr class="${isCur ? 'rt-cur' : ''}"><td><b>&lt; ${row.ref}</b> mA</td>
      <td colspan="7" class="rt-na">ทำไม่ได้ภายใน ${quickResult.maxDepth || 6} ครั้ง (ด้วย spare ที่มี)</td><td></td></tr>`;
    const extra = row.extraSwaps > 0 ? ` <span class="rt-extra">+${row.extraSwaps}</span>` : '';
    const rate = row.gainPerSwap != null ? row.gainPerSwap.toFixed(1) : '—';
    const R0 = quickResult.recommended;
    const isRec = p === R0 || !!(R0 && isCur && R0.actualSwaps === p.actualSwaps && Math.abs(R0.Ino_mA - p.Ino_mA) < 1e-6);
    const tags = (row.bestValue ? '<span class="rt-tag">คุ้มสุด</span>' : '') +
                 (row.leastWork ? '<span class="rt-tag rt-tag-work">สับน้อยสุด</span>' : '') +
                 (isCur ? '<span class="rt-tag rt-tag-cur">ค่าที่เลือก</span>' : '') +
                 (row.fallback ? '<span class="rt-tag rt-tag-warn">ยังไม่ผ่าน (ใกล้สุด)</span>' : '') +
                 (isRec ? '<span class="rt-tag rt-tag-cur">แผนที่แนะนำ</span>' : '');
    const failLeft = p._fail || 0;
    return `<tr class="${row.bestValue ? 'rt-best' : ''} ${isCur ? 'rt-cur' : ''}">
      <td><b>&lt; ${row.ref}</b> mA ${tags}</td>
      <td><b>${p.actualSwaps}</b>${extra}</td>
      <td>${p.sparesUsed || 0}</td>
      <td>${p.Ino_mA.toFixed(2)}</td>
      <td class="${failLeft ? 'rt-bad' : ''}">${failLeft}</td>
      <td class="${p.spread && p.spread.ok ? '' : 'rt-bad'}">${p.spread ? (p.spread.ok ? '✓ ' : '') + p.spread.y1.toFixed(2) + ' / ' + p.spread.y2.toFixed(2) : '—'}</td>
      <td>${rate}</td>
      <td>${fmtV(p)}</td>
      <td>${isRec ? '' : `<button class="rt-use" onclick="useInoRef(${row.ref})">ใช้ค่านี้</button>`}</td></tr>`;
  }).join('') + balRow;
  return `<div class="ref-compare">
    <div class="ref-title"><i class="fas fa-scale-balanced"></i> ต้องสับกี่ครั้ง I<sub>no</sub> จึงจะต่ำกว่าแต่ละค่า</div>
    <div class="ref-sub">แต่ละแถวคือแผนที่สับน้อยที่สุดที่ทำให้ I<sub>no</sub> ต่ำกว่าค่านั้น และผลรวม C ต่อเฟสในแต่ละฝั่งต่างกันไม่เกิน ${BALSUM} µF
      ถ้าสับเท่ากันจะเลือกแผนที่ I<sub>no</sub> ใกล้ค่านั้นที่สุด ทุกแผนถอดลูกเสียออกเท่าที่ spare ดีมี และไม่มีลูกไหนรับแรงดันเกิน
      กด <b>ใช้ค่านี้</b> เพื่อใช้แผนของแถวนั้น (ไฟล์ Excel จะใช้แผนเดียวกัน) · <b>สับน้อยสุด</b> คือแผนที่ทำงานน้อยที่สุด ตัวเลข +n คือจำนวนครั้งที่ต้องสับเพิ่ม ·
      <b>คุ้มสุด</b> คือแผนที่ลด I<sub>no</sub> ได้มากที่สุดต่อการสับเพิ่ม 1 ครั้ง (ต้องลดได้อย่างน้อย ${(typeof INO_WORTH_MA_PER_SWAP!=='undefined'?INO_WORTH_MA_PER_SWAP:5)} mA ต่อครั้ง)</div>
    <div class="ref-scroll"><table class="ref-table">
      <thead><tr><th>I<sub>no</sub> ต่ำกว่า</th><th>สับ (ครั้ง)</th><th>ใช้ spare</th><th>I<sub>no</sub> ที่ได้ (mA)</th><th>ลูกเสียที่เหลือ</th><th>ΔΣC ต่อเฟส<br>Y1 / Y2 (µF)</th><th>ลดได้ต่อการสับเพิ่ม<br>(mA/ครั้ง)</th><th>แรงดันลูกที่สูงสุด</th><th></th></tr></thead>
      <tbody>${body}</tbody></table></div>
  </div>`;
}


// ═══════════════════════════════════════════════════════════════════════════
// v10.6 — Step 3 answer card, checklist mode and rack map
// ═══════════════════════════════════════════════════════════════════════════
const RACK_PH = { Y1: ['A', 'B', 'C'], Y2: ["A'", "B'", "C'"] };
const escH = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const isRealSpareU = u => !!u && !u.pulledPiece && /^S-/.test(u.id || '');
const srcLabel = u => isRealSpareU(u) ? 'spare ' + u.id : 'ลูกที่ถอดจาก ' + u.id;

// What one action changes, position by position (used by the checklist and the rack map).
function actChanges(a) {
  if (a.type === 'exchange') return [
    { pos: a.from.id, before: a.from.val, after: a.to.val, src: 'ลูกจาก ' + a.to.id, key: a.from.origin + '|' + a.from.pos, kind: 'ch' },
    { pos: a.to.id, before: a.to.val, after: a.from.val, src: 'ลูกจาก ' + a.from.id, key: a.to.origin + '|' + a.to.pos, kind: 'ch' }];
  if (a.type === 'replace-y1' || a.type === 'replace-y2') return [
    { pos: a.from.id, before: a.from.val, after: a.to.val, src: srcLabel(a.to), key: a.from.origin + '|' + a.from.pos, kind: isRealSpareU(a.to) ? 'sp' : 'ch' }];
  if (a.type === 'piece-replace') return [
    { pos: a.from.id + ' ลูก ' + a.piece, before: a.oldVal, after: a.to.val, src: srcLabel(a.to), key: a.from.origin + '|' + a.from.pos, kind: isRealSpareU(a.to) ? 'sp' : 'ch' }];
  if (a.type === 'piece-swap') return [
    { pos: a.u1.id + ' ลูก ' + a.p1, before: a.v1, after: a.v2, src: 'ลูกจาก ' + a.u2.id + '.' + a.p2, key: a.u1.origin + '|' + a.u1.pos, kind: 'ch' },
    { pos: a.u2.id + ' ลูก ' + a.p2, before: a.v2, after: a.v1, src: 'ลูกจาก ' + a.u1.id + '.' + a.p1, key: a.u2.origin + '|' + a.u2.pos, kind: 'ch' }];
  return [];
}

function buildAnswer(banner, sw, qr, topology) {
  const acts = sw.acts || [], steps = sw.steps || [];
  const chips = [];
  chips.push(`สับ <b>${sw.actualSwaps || 0}</b> ครั้ง`);
  chips.push(`spare <b>${sw.sparesUsed || 0}</b> ลูก`);
  if (topology !== 'h-bridge') {
    const nFail = sw._fail || 0;
    chips.push(nFail ? `ลูกเสียค้าง <b>${nFail}</b> ลูก` : 'ลูกเสียออกครบ');
    if (sw.unitV && isFinite(sw.unitV.maxPctShare))
      chips.push(sw.unitV.maxPctRated != null ? `แรงดันลูกสูงสุด <b>${sw.unitV.maxPctRated.toFixed(0)}%</b> พิกัด` : `แรงดันลูกสูงสุด <b>${sw.unitV.maxPctShare.toFixed(0)}%</b> ของเฉลี่ย`);
  }
  const list = acts.length
    ? `<ol class="ans-steps">${steps.map((t, i) => `<li><span class="n">${i + 1}</span><span>${t}</span></li>`).join('')}</ol>`
    : `<p class="ans-none">${escH(steps[0] || 'ไม่ต้องสับ')}</p>`;
  window.__plan = { acts, steps, ino: sw.Ino_mA, key: 'cbank-cl:' + steps.join('|').length + ':' + steps.join('|').slice(0, 120) };
  return `<div class="answer-card">
    ${banner}
    <div class="ans-chips">${chips.map(c => `<span class="ans-chip">${c}</span>`).join('')}</div>
    <div class="ans-head"><h2>ทำตามลำดับ</h2>${acts.length ? '<button type="button" class="btn btn-primary ans-start" onclick="openChecklist()"><i class="fas fa-list-check"></i>&nbsp;เริ่มทำตามแผน</button>' : ''}</div>
    ${list}
  </div>` + (topology !== 'h-bridge' && acts.length ? buildRackMap(sw) : '');
}

// Rack map: slots × phases per side, in rack order; changed slots carry their step numbers.
function buildRackMap(sw) {
  const marks = {};
  (sw.acts || []).forEach((a, i) => actChanges(a).forEach(c => { (marks[c.key] = marks[c.key] || []).push({ n: i + 1, kind: c.kind }); }));
  const slot = (typeof slotOrder === 'function') ? slotOrder(sw.acts) : {};
  const info = {};
  const side = (name, units) => {
    const phs = RACK_PH[name];
    const cols = phs.map(ph => {
      const m = {};
      units.filter(u => u.origin === ph).forEach(u => { const p = slot[u.id] != null ? slot[u.id] : u.pos; m[p] = u; });
      return m;
    });
    const maxRow = Math.max(-1, ...cols.flatMap(c => Object.keys(c).map(Number)));
    const sums = cols.map(c => Object.values(c).reduce((t, u) => t + (u.val > 0 ? u.val : 0), 0));
    let cells = '';
    for (let r = 0; r <= maxRow; r++) {
      cells += `<span class="rk-rn">${r + 1}</span>`;
      phs.forEach((ph, j) => {
        const u = cols[j][r]; if (!u) { cells += '<span class="rk-cell rk-empty"></span>'; return; }
        const k = ph + '|' + r, mk = marks[k] || [];
        const cls = mk.some(x => x.kind === 'sp') ? 'rk-sp' : (mk.length ? 'rk-ch' : (unitBelowNameplate(u) ? 'rk-bad' : ''));
        if (mk.length) info[k] = { slot: ph + '-' + (r + 1), steps: mk.map(x => x.n) };
        const nums = mk.length ? [...new Set(mk.map(x => x.n))].map(n => `<span class="rk-n">${n}</span>`).join('') : '';
        cells += mk.length
          ? `<button type="button" class="rk-cell ${cls}" onclick="rackTap('${k}')" aria-label="ช่อง ${ph}-${r + 1} ขั้นที่ ${mk.map(x => x.n).join(' ')}">${u.val.toFixed(1)}${nums}</button>`
          : `<span class="rk-cell ${cls}">${u.val.toFixed(1)}</span>`;
      });
    }
    return `<div class="rk-side"><h3>ฝั่ง ${name} <span>ΣC ${sums.map(v => v.toFixed(1)).join(' · ')} µF</span></h3>
      <div class="rk-grid"><span></span>${phs.map(p => `<span class="rk-hd">${p}</span>`).join('')}${cells}</div></div>`;
  };
  window.__rackInfo = info;
  return `<div class="rack-map">
    <div class="rk-top"><h2>ผัง rack หลังสับ</h2>
      <div class="rk-legend"><span><i class="rk-ch"></i>ย้าย/สลับ</span><span><i class="rk-sp"></i>ใส่ spare</span><span><i class="rk-bad"></i>ลูกเสียที่ยังค้าง</span></div></div>
    <div class="rk-sides">${side('Y1', sw.y1Full || sw.y1 || [])}${side('Y2', sw.y2Full || sw.y2 || [])}</div>
    <div class="rk-detail" id="rackDetail">แตะช่องที่มีเลขกำกับ เพื่อดูว่าต้องทำอะไร</div>
  </div>`;
}
function rackTap(k) {
  const el = document.getElementById('rackDetail'), it = window.__rackInfo && window.__rackInfo[k], p = window.__plan;
  if (!el || !it || !p) return;
  el.innerHTML = `<b>ช่อง ${escH(it.slot)}</b>` + it.steps.map(n => `<div class="rk-step"><span class="n">${n}</span><span>${p.steps[n - 1]}</span></div>`).join('');
}

// ── checklist mode ──
function clLoad() { try { return JSON.parse(localStorage.getItem(window.__plan.key) || '[]'); } catch (e) { return []; } }
function clSave(done) { try { localStorage.setItem(window.__plan.key, JSON.stringify(done)); } catch (e) { /* private mode: progress not kept */ } }
function openChecklist() {
  document.getElementById('answerSection').hidden = true;
  const box = document.getElementById('checklistSection'); box.hidden = false;
  renderChecklist();
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closeChecklist() {
  document.getElementById('checklistSection').hidden = true;
  const a = document.getElementById('answerSection'); a.hidden = false;
  a.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function toggleTask(i) {
  const done = clLoad(); const at = done.indexOf(i);
  if (at >= 0) done.splice(at, 1); else done.push(i);
  clSave(done); renderChecklist();
}
function resetChecklist() { clSave([]); renderChecklist(); }
function renderChecklist() {
  const p = window.__plan; if (!p) return;
  const done = clLoad(), n = p.acts.length, nDone = done.filter(i => i < n).length;
  const cur = [...Array(n).keys()].find(i => !done.includes(i));
  const tasks = p.acts.map((a, i) => {
    const isDone = done.includes(i), isNow = i === cur;
    const ch = isNow ? `<div class="cl-swaps">${actChanges(a).map(c => `
        <div class="cl-swap"><div class="cl-pos">${escH(c.pos)}</div>
          <div class="cl-vals"><span class="cl-out">ถอด ${c.before.toFixed(2)}</span><i class="fas fa-arrow-right" aria-hidden="true"></i><span class="cl-in">ใส่ ${c.after.toFixed(2)}</span></div>
          <div class="cl-src">${escH(c.src)}</div></div>`).join('')}</div>
        <button type="button" class="btn btn-primary cl-done" onclick="toggleTask(${i})">ทำขั้นนี้เสร็จแล้ว</button>` : '';
    return `<div class="cl-task${isDone ? ' is-done' : ''}${isNow ? ' is-now' : ''}">
      <label class="cl-head"><input type="checkbox" ${isDone ? 'checked' : ''} onchange="toggleTask(${i})"><span class="cl-n">${i + 1}</span><span class="cl-t">${p.steps[i]}</span></label>${ch}</div>`;
  }).join('');
  document.getElementById('checklistSection').innerHTML = `<div class="checklist">
    <div class="cl-top"><button type="button" class="btn btn-back" onclick="closeChecklist()"><i class="fas fa-arrow-left"></i>&nbsp;กลับไปดูภาพรวม</button>
      <button type="button" class="btn btn-outline" onclick="resetChecklist()">เริ่มนับใหม่</button></div>
    <h2>ทำตามแผน: สับ ${n} ครั้ง</h2>
    <div class="cl-prog"><div class="cl-track"><div class="cl-fill" style="width:${n ? Math.round(nDone / n * 100) : 0}%"></div></div><span>เสร็จ ${nDone} / ${n}</span></div>
    ${tasks}
    <div class="cl-after${nDone === n ? ' is-ready' : ''}">${nDone === n ? 'ทำครบทุกขั้นแล้ว ' : 'เมื่อทำครบทุกขั้นแล้ว '}วัด I<sub>no</sub> ซ้ำ ควรได้ราว <b>${(p.ino || 0).toFixed(1)} mA</b> ถ้าต่างจากนี้มาก ให้ทวนค่าที่วัดอีกครั้ง</div>
  </div>`;
}
