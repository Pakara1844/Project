// ═══════════════════════════════════════
// APP — with fetch() replaced by clientCalculate()
// ═══════════════════════════════════════
'use strict';
let currentConn='yy-unground', lastCalcData=null;

window.addEventListener('DOMContentLoaded',()=>{
  const saved = localStorage.getItem('cbank-theme')||'light';
  document.documentElement.setAttribute('data-theme', saved);
  renderDiagram('yy-unground','diagramContainer');
  goToStep(1);
});

function toggleTheme(){
  const html = document.documentElement;
  const next = html.getAttribute('data-theme')==='dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('cbank-theme', next);
}

// Unbalance-threshold bubble selector (Step 2). Writes the chosen mA into the
// hidden #alarmMA input that getInputValues() reads. Any of 5/10/20/30/40/50 is
// supported by the calculation (THRESHOLD_MA); default 50 (= ALARM_MA).
function selectAlarm(btn){
  const group = btn.closest('.bubble-group');
  if (group) group.querySelectorAll('.bubble').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const hidden = document.getElementById('alarmMA');
  if (hidden) hidden.value = btn.dataset.val;
}

function goToStep(n){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page'+n).classList.add('active');
  document.querySelectorAll('.wiz-step').forEach(el=>{
    const sn=parseInt(el.dataset.step);
    el.classList.remove('active','completed');
    if(sn===n) el.classList.add('active');
    else if(sn<n) el.classList.add('completed');
  });
  document.querySelectorAll('.wiz-line').forEach((el,idx)=>{
    el.classList.toggle('done', idx+1<n);
  });
  window.scrollTo({top:0,behavior:'smooth'});
}

function goToStep2(){
  const labelTh={'yy-unground':'Y-Y ไม่ต่อลงดิน','h-bridge':'H-Bridge (4 Legs)'};
  var ct = document.getElementById('confirmedType');
  if (ct) ct.textContent=labelTh[currentConn]||currentConn;
  buildInputArea();
  goToStep(2);
}

function restartWizard(){
  lastCalcData=null;
  highlightConn(document.querySelector('.conn-opt[data-conn="yy-unground"]'));
  goToStep(1);
}

function highlightConn(el){
  document.querySelectorAll('.conn-opt').forEach(o=>o.classList.remove('active'));
  el.classList.add('active');
  currentConn=el.dataset.conn;
  const labels={'yy-unground':'Y-Y Ungrounded','h-bridge':'H-Bridge'};
  document.getElementById('diagramLabel').textContent=labels[currentConn]||''
  renderDiagram(currentConn,'diagramContainer');
}

// ═══════════════════════════════════════════════════════
// PANEL BUILDER — each panel has its own count, preserves values
// ═══════════════════════════════════════════════════════
function buildInputArea() {
  const area = document.getElementById('inputArea');
  if (!area) return;

  // Helper: create input rows for a panel, preserving existing values
  function makeRows(containerId, pfx, cnt) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const existing = {};
    // Save existing values before rebuilding
    el.querySelectorAll('input[type="number"]').forEach(inp => {
      if (inp.value) existing[inp.dataset.idx] = inp.value;
    });
    let h = '';
    for (let i = 1; i <= cnt; i++) {
      const savedVal = existing[String(i)] || '';
      h += `<div class="cr">
        <label>${pfx}-${i}</label>
        <input type="number" step="0.001" min="0"
               class="val-${pfx.toLowerCase().replace("'",'p')}"
               data-pfx="${pfx}" data-idx="${i}"
               value="${savedVal}" placeholder="0.000" inputmode="decimal">
        <span class="unit">µF</span>
      </div>`;
    }
    el.innerHTML = h;
  }

  // Helper: rebuild spare rows
  function makeSpareRows(containerId, cnt) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const existing = {};
    el.querySelectorAll('input[type="number"]').forEach(inp => {
      if (inp.value) existing[inp.dataset.idx] = inp.value;
    });
    let h = '';
    for (let i = 1; i <= cnt; i++) {
      const savedVal = existing[String(i)] || '';
      h += `<div class="cr">
        <label>S-${i}</label>
        <input type="number" step="0.001" min="0" class="val-s"
               data-idx="${i}" value="${savedVal}" placeholder="0.000" inputmode="decimal">
        <span class="unit">µF</span>
      </div>`;
    }
    el.innerHTML = h;
  }

  if (currentConn === 'h-bridge') {
    // Build H-Bridge layout: 4 legs + spare, each with own count
    if (!document.getElementById('panelA')) {
      area.innerHTML = `
        <div class="input-cols" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;">
          <div class="inp-panel la">
            <div class="panel-hd">Leg A — Top-Left</div>
            <div class="panel-ctrl"><label>จำนวน:</label><input type="number" id="cntA" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('A')"><label class="par-toggle"><input type="checkbox" id="parA"><span>☑ ต่อขนาน (ล็อกเป็น Tier 2)</span></label></div>
            <div id="panelA"></div>
          </div>
          <div class="inp-panel lb">
            <div class="panel-hd">Leg B — Top-Right</div>
            <div class="panel-ctrl"><label>จำนวน:</label><input type="number" id="cntB" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('B')"><label class="par-toggle"><input type="checkbox" id="parB"><span>☑ ต่อขนาน (ล็อกเป็น Tier 2)</span></label></div>
            <div id="panelB"></div>
          </div>
          <div class="inp-panel lc">
            <div class="panel-hd">Leg C — Bot-Left</div>
            <div class="panel-ctrl"><label>จำนวน:</label><input type="number" id="cntC" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('C')"><label class="par-toggle"><input type="checkbox" id="parC"><span>☑ ต่อขนาน (ล็อกเป็น Tier 2)</span></label></div>
            <div id="panelC"></div>
          </div>
          <div class="inp-panel ld">
            <div class="panel-hd">Leg D — Bot-Right</div>
            <div class="panel-ctrl"><label>จำนวน:</label><input type="number" id="cntD" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('D')"><label class="par-toggle"><input type="checkbox" id="parD"><span>☑ ต่อขนาน (ล็อกเป็น Tier 2)</span></label></div>
            <div id="panelD"></div>
          </div>
          <div class="inp-panel spare" style="grid-column:1/-1;">
            <div class="panel-hd"><i class="fas fa-box-open"></i> อะไหล่ (Spare) — ตัวเดี่ยว</div>
            <div class="panel-ctrl"><label>จำนวน:</label><input type="number" id="cntS" value="5" min="0" max="40" class="cnt-input" onchange="rebuildPanel('S')"></div>
            <div id="panelS"></div>
          </div>
        </div>`;
    }
    ['A','B','C','D'].forEach(p => rebuildPanel(p));
    // H-Bridge: attach scissors visibility listeners
    [['parA','a'],['parB','b'],['parC','c'],['parD','d']].forEach(([cbId, cls]) => {
      const cb = document.getElementById(cbId);
      if (cb) {
        cb.onchange = () => updateScissorsVisibility(cbId, cls);
        updateScissorsVisibility(cbId, cls); // init
      }
    });
    rebuildPanel('S');
  } else {
    // Y-Y: 6 phases (A,B,C,A',B',C') + spare
    if (!document.getElementById('panelA')) {
      area.innerHTML = `
        <div class="yy-section">
          <div class="yy-section-title yy-side1"><i class="fas fa-arrow-circle-right"></i> ฝั่งที่ 1 (Y1)
            <label class="par-toggle" style="margin-left:auto;"><input type="checkbox" id="parY1"><span>☑ ต่อขนาน (ล็อกเป็น Tier 2)</span></label>
          </div>
          <div class="yy-phase-row">
            <div class="inp-panel y1"><div class="panel-hd">Phase A</div>
              <div class="panel-ctrl"><label>จำนวน:</label><input type="number" id="cntA" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('A')"></div>
              <div id="panelA"></div></div>
            <div class="inp-panel y1"><div class="panel-hd">Phase B</div>
              <div class="panel-ctrl"><label>จำนวน:</label><input type="number" id="cntB" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('B')"></div>
              <div id="panelB"></div></div>
            <div class="inp-panel y1"><div class="panel-hd">Phase C</div>
              <div class="panel-ctrl"><label>จำนวน:</label><input type="number" id="cntC" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('C')"></div>
              <div id="panelC"></div></div>
          </div>
        </div>
        <div class="yy-section">
          <div class="yy-section-title yy-side2"><i class="fas fa-arrow-circle-right"></i> ฝั่งที่ 2 (Y2)
            <label class="par-toggle" style="margin-left:auto;"><input type="checkbox" id="parY2"><span>☑ ต่อขนาน (ล็อกเป็น Tier 2)</span></label>
          </div>
          <div class="yy-phase-row">
            <div class="inp-panel y2"><div class="panel-hd">Phase A'</div>
              <div class="panel-ctrl"><label>จำนวน:</label><input type="number" id="cntAp" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('Ap')"></div>
              <div id="panelAp"></div></div>
            <div class="inp-panel y2"><div class="panel-hd">Phase B'</div>
              <div class="panel-ctrl"><label>จำนวน:</label><input type="number" id="cntBp" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('Bp')"></div>
              <div id="panelBp"></div></div>
            <div class="inp-panel y2"><div class="panel-hd">Phase C'</div>
              <div class="panel-ctrl"><label>จำนวน:</label><input type="number" id="cntCp" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('Cp')"></div>
              <div id="panelCp"></div></div>
          </div>
        </div>
        <div class="yy-section">
          <div class="yy-section-title yy-spare"><i class="fas fa-box-open"></i> อะไหล่ (Spare) — ตัวเดี่ยว</div>
          <div class="panel-ctrl"><label>จำนวน:</label><input type="number" id="cntS" value="5" min="0" max="40" class="cnt-input" onchange="rebuildPanel('S')"></div>
          <div id="panelS"></div>
        </div>`;
    }
    ['A','B','C','Ap','Bp','Cp'].forEach(p => rebuildPanel(p));
    // Attach listeners to side-level checkboxes for scissors visibility
    ['parY1', 'parY2'].forEach(cbId => {
      const cb = document.getElementById(cbId);
      if (cb) {
        cb.onchange = () => {
          const cls = cbId === 'parY1' ? ['a','b','c'] : ['ap','bp','cp'];
          cls.forEach(c => updateScissorsVisibility(cbId, c));
        };
        // Initialize visibility on load
        const cls = cbId === 'parY1' ? ['a','b','c'] : ['ap','bp','cp'];
        cls.forEach(c => updateScissorsVisibility(cbId, c));
      }
    });
    rebuildPanel('S');
  }
}

function rebuildPanel(key) {
  const labelMap = {A:'A',B:'B',C:'C',D:'D',Ap:"A'",Bp:"B'",Cp:"C'",S:'S'};
  const pfx = labelMap[key] || key;
  const cntEl = document.getElementById('cnt' + key);
  if (!cntEl) return;
  const cnt = Math.max(key==='S'?0:1, parseInt(cntEl.value)||0);
  const container = document.getElementById('panel' + key);
  if (!container) return;

  // Save existing values & split states
  const saved = {};
  const savedSplit = {};
  const savedA = {};
  const savedB = {};
  container.querySelectorAll('input.val-main').forEach(inp => {
    if (inp.value) saved[inp.dataset.idx] = inp.value;
  });
  container.querySelectorAll('input.split-a').forEach(inp => {
    if (inp.value) savedA[inp.dataset.idx] = inp.value;
  });
  container.querySelectorAll('input.split-b').forEach(inp => {
    if (inp.value) savedB[inp.dataset.idx] = inp.value;
  });
  container.querySelectorAll('input.split-toggle-cb').forEach(cb => {
    if (cb.checked) savedSplit[cb.dataset.idx] = true;
  });
  // Plain spare/legacy
  container.querySelectorAll('input.val-s, input.val-' + pfx.toLowerCase().replace("'",'p')).forEach(inp => {
    if (inp.value && !inp.classList.contains('val-main')) saved[inp.dataset.idx] = inp.value;
  });

  const cls = pfx.toLowerCase().replace("'",'p');
  let h = '';
  if (key === 'S') {
    // Spare: plain rows
    for (let i = 1; i <= cnt; i++) {
      h += `<div class="cr"><label>S-${i}</label>
        <input type="number" step="0.001" min="0" class="val-s" data-idx="${i}"
               value="${saved[String(i)]||''}" placeholder="0.000" inputmode="decimal">
        <span class="unit">µF</span></div>`;
    }
  } else {
    // Phase / Leg panels with split-toggle button (visible only when side-parallel checked)
    for (let i = 1; i <= cnt; i++) {
      const isSplit = savedSplit[String(i)] || false;
      const slotId = `slot-${cls}-${i}`;
      h += `<div class="cr-slot split-slot-${cls}" data-slot="${slotId}">
        <div class="cr cr-main-row">
          <label>${pfx}-${i}</label>
          <input type="number" step="0.001" min="0"
                 class="val-${cls} val-main"
                 data-pfx="${pfx}" data-idx="${i}"
                 value="${saved[String(i)]||''}" placeholder="0.000" inputmode="decimal"
                 ${isSplit ? 'disabled style="opacity:0.4"' : ''}>
          <span class="unit">µF</span>
          <button type="button" class="split-btn split-btn-${cls} ${isSplit?'on':''}"
                  data-slot="${slotId}" data-idx="${i}" data-cls="${cls}" data-pfx="${pfx}"
                  title="วัดแยก 2 ตัว"
                  onclick="toggleSplit('${cls}', ${i})"
                  style="display:none;">
            <i class="fas fa-cut"></i>
          </button>
        </div>
        <div class="cr-split-pair" id="splitpair-${cls}-${i}" style="display:${isSplit?'flex':'none'};">
          <div class="cr cr-sub">
            <label>${pfx}-${i}.a</label>
            <input type="number" step="0.001" min="0"
                   class="val-${cls}-a val-sub split-a"
                   data-pfx="${pfx}" data-idx="${i}" data-sub="a"
                   value="${savedA[String(i)]||''}" placeholder="0.000" inputmode="decimal">
            <span class="unit">µF</span>
          </div>
          <div class="cr cr-sub">
            <label>${pfx}-${i}.b</label>
            <input type="number" step="0.001" min="0"
                   class="val-${cls}-b val-sub split-b"
                   data-pfx="${pfx}" data-idx="${i}" data-sub="b"
                   value="${savedB[String(i)]||''}" placeholder="0.000" inputmode="decimal">
            <span class="unit">µF</span>
          </div>
        </div>
      </div>`;
    }
  }
  container.innerHTML = h;
}

// Toggle split mode for a single slot
// Show/hide scissors buttons based on side-level parallel checkbox
function updateScissorsVisibility(checkboxId, targetCls) {
  const cb = document.getElementById(checkboxId);
  const isChecked = cb && cb.checked;
  const btns = document.querySelectorAll('.split-btn-' + targetCls);
  btns.forEach(btn => {
    btn.style.display = isChecked ? 'inline-flex' : 'none';
    // If unchecking side-level, close all scissors in this group
    if (!isChecked && btn.classList.contains('on')) {
      const cls = btn.dataset.cls;
      const idx = btn.dataset.idx;
      toggleSplit(cls, idx); // close it
    }
  });
}

function toggleSplit(cls, idx) {
  const mainInput = document.querySelector(`.val-${cls}.val-main[data-idx="${idx}"]`);
  const splitPair = document.getElementById(`splitpair-${cls}-${idx}`);
  const btn = document.querySelector(`.split-btn[data-cls="${cls}"][data-idx="${idx}"]`);
  if (!mainInput || !splitPair || !btn) return;

  const isNowOpen = splitPair.style.display === 'flex';
  if (isNowOpen) {
    // Close split
    splitPair.style.display = 'none';
    mainInput.disabled = false;
    mainInput.style.opacity = '';
    btn.classList.remove('on');
  } else {
    // Open split — NO auto-fill, NO ÷2. The technician types the two real
    // measured values; the slot then uses va+vb (parallel sum) directly.
    splitPair.style.display = 'flex';
    mainInput.disabled = true;
    mainInput.style.opacity = '0.4';
    btn.classList.add('on');
  }
}

// Legacy alias
function buildInputPanels() { buildInputArea(); }

// ═══════════════════════════════════════════════════════
// READ INPUT VALUES — respects "parallel" checkbox per side
// ═══════════════════════════════════════════════════════
function getInputValues(){
  const spare=[];
  document.querySelectorAll('.val-s').forEach((el,k)=>{
    const vs=parseFloat(el.value);
    if(!isNaN(vs)&&vs>0) spare.push({id:'S-'+(k+1),val:vs,origin:'Spare',pos:k});
  });
  const systemKV=parseFloat(document.getElementById('systemKV').value)||69;
  // ค่า unbalance สูงสุด (เกณฑ์ I_no, mA) ที่หน้างานกรอกใน Step 2 — ใช้แทนค่า default
  // ALARM_MA ในการตัดสินผ่าน/ไม่ผ่าน และเป็นเป้าของการคำนวณการสับเปลี่ยน
  const alarmEl=document.getElementById('alarmMA');
  const alarmMA=(alarmEl && parseFloat(alarmEl.value)>0) ? parseFloat(alarmEl.value)
                : ((typeof window!=='undefined' && window.ALARM_MA) || 50);

  // Returns whether the side-level "ต่อขนาน" checkbox is ticked.
  // ticked  = ช่องในฝั่งนี้เป็นคู่ขนาน → ล็อกเป็น Tier 2 (สลับเป็น fallback) + โชว์กรรไกร
  // unticked = ช่องเดี่ยว → Tier 1 (สลับได้เลย).  ** ไม่มีการ ÷2 ในทั้งสองกรณี **
  function isMeasuredSeparately(checkboxId) {
    const cb = document.getElementById(checkboxId);
    return cb && cb.checked;
  }

  // Read values from a panel — NO ÷2 anywhere; the entered number is the slot's
  // combined (parallel) capacitance = one unit/series element.
  // sideParallel=true  (ติ๊ก "ต่อขนาน")  → slot ถูก lock (Tier 2 สลับเป็น fallback) + โชว์ปุ่มกรรไกร
  // sideParallel=false (ไม่ติ๊ก)          → slot สลับได้ (Tier 1)
  // Per-slot กรรไกร ✂️: วัดแยก 2 ตัว → ใช้ผลรวม va+vb เป็นหน่วยเดียว (Tier 1, swappable)
  function readPanel(cls, originLabel, sideParallel) {
    const out = [];
    // Look at all main rows
    const mainInputs = document.querySelectorAll('.val-' + cls + '.val-main');
    for (let i = 0; i < mainInputs.length; i++) {
      const slotIdx = i + 1;
      // Check if this slot has split toggle ON
      const splitBtn = document.querySelector(`.split-btn[data-cls="${cls}"][data-idx="${slotIdx}"]`);
      const isSplit = splitBtn && splitBtn.classList.contains('on');
      if (isSplit) {
        // วัดแยก (กรรไกร): ช่างวัดค่าจริงของคู่ขนานทั้งสองตัว (.a และ .b)
        // → ค่าความจุของช่องนี้ = ผลรวมแบบขนาน va + vb  (ไม่ ÷2 เพราะเป็นค่าจริงอยู่แล้ว)
        // เป็น "หน่วยเดียว" ที่สับเปลี่ยนได้ (Tier 1) — สับทั้งช่อง ไม่แยก .a/.b
        const aEl = document.querySelector(`.val-${cls}-a[data-idx="${slotIdx}"]`);
        const bEl = document.querySelector(`.val-${cls}-b[data-idx="${slotIdx}"]`);
        const va = parseFloat(aEl ? aEl.value : '');
        const vb = parseFloat(bEl ? bEl.value : '');
        if (isNaN(va)||va<=0||isNaN(vb)||vb<=0) {
          alert('กรุณากรอกค่า ' + originLabel + '-' + slotIdx + '.a และ .b ให้ครบ');
          return null;
        }
        const slotVal = va + vb;   // parallel sum — NO ÷2 (override side-level ÷2)
        out.push({
          id: originLabel+'-'+slotIdx, val: slotVal, origin: originLabel, pos: i,
          inputVal: slotVal, isLocked: false, isSplit: true, parentSlot: slotIdx,
          measuredA: va, measuredB: vb
        });
      } else {
        // Use main input value AS-IS (no ÷2). The entered number is the slot's
        // combined capacitance = one series element. "ต่อขนาน" only marks the slot
        // as locked (Tier 2 / swap as fallback only) and reveals the scissors UI.
        const v = parseFloat(mainInputs[i].value);
        if (isNaN(v) || v <= 0) {
          alert('กรุณากรอกค่า ' + originLabel + '-' + slotIdx + ' ให้ครบ');
          return null;
        }
        out.push({
          id: originLabel+'-'+slotIdx, val: v, origin: originLabel, pos: i,
          inputVal: v, isLocked: sideParallel  // side-level parallel → locked group (Tier 2)
        });
      }
    }
    return out;
  }

  if(currentConn==='h-bridge'){
    const legs = {};
    for (const [key, label] of [['a','A'],['b','B'],['c','C'],['d','D']]) {
      const sep = isMeasuredSeparately('par' + label);
      legs[key] = readPanel(key, label, sep);
      if (legs[key] === null) return null;
    }
    return { topology:'h-bridge', y1:[...legs.a,...legs.c], y2:[...legs.b,...legs.d], spare, legs, systemKV, alarmMA };
  } else {
    const sepY1 = isMeasuredSeparately('parY1');
    const sepY2 = isMeasuredSeparately('parY2');
    const phases = {};
    for (const [key, label, sep] of [
      ['a','A',sepY1],['b','B',sepY1],['c','C',sepY1],
      ['ap',"A'",sepY2],['bp',"B'",sepY2],['cp',"C'",sepY2]
    ]) {
      phases[key] = readPanel(key, label, sep);
      if (phases[key] === null) return null;
    }
    const y1 = [...phases.a, ...phases.b, ...phases.c];
    const y2 = [...phases.ap, ...phases.bp, ...phases.cp];
    return { topology:'yy-unground', y1, y2, spare, systemKV, phases, alarmMA };
  }
}

// ═══════════════════════════════════════════════════════
// CALCULATE — target: Ino < ค่า unbalance ที่กรอก (default ALARM_MA) with minimum swaps
// ═══════════════════════════════════════════════════════
async function handleCalculate(){
  const vals=getInputValues();
  if(!vals) return;
  const btn=document.getElementById('btnCalc');
  btn.disabled=true;
  btn.innerHTML='<i class="fas fa-spinner fa-spin"></i>&nbsp;กำลังคำนวณ…';
  try{
    const result = await clientCalculate(vals);
    renderResults(vals, result);
    lastCalcData={connType:currentConn,vals,timestamp:new Date().toLocaleString('th-TH'),...result};
    document.getElementById('exportRow').style.display='block';
    goToStep(3);
  }catch(e){
    alert('เกิดข้อผิดพลาด: '+e.message);
  }finally{
    btn.disabled=false;
    btn.innerHTML='<i class="fas fa-cogs"></i>&nbsp;วิเคราะห์&nbsp;<i class="fas fa-arrow-right"></i>';
  }
}

function switchCalcView(name){
  document.querySelectorAll('.calc-action-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.calc-view').forEach(v=>v.classList.remove('active'));
  document.querySelector(`.calc-action-btn[data-view="${name}"]`).classList.add('active');
  document.getElementById('view'+name.charAt(0).toUpperCase()+name.slice(1)).classList.add('active');
  if(name==='results') switchTab('quick');
}

async function handleExport(){
  if(!lastCalcData){alert('กรุณาคำนวณก่อน');return;}
  try {
    await exportToExcel(lastCalcData);
  } catch(e) {
    console.error(e);
    alert('Export ไม่สำเร็จ: ' + (e && e.message ? e.message : e));
  }
}
