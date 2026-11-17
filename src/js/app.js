// ═══════════════════════════════════════
// APP — with fetch() replaced by clientCalculate()
// ═══════════════════════════════════════
'use strict';
let currentConn=null, lastCalcData=null;   // no topology chosen until the user picks one

window.addEventListener('DOMContentLoaded',()=>{
  const saved = localStorage.getItem('cbank-theme')||'light';
  document.documentElement.setAttribute('data-theme', saved);
  goToStep(1);                       // pre-initialise the wizard (hidden under landing; no topology preselected)
  ['capRatedUF','capTolMinus','capTolPlus','capRatedKV'].forEach(id => {
    const el = document.getElementById(id); if (el) el.addEventListener('input', updateCapBand);
  });
  updateCapBand();
  document.body.classList.add('show-landing');
  // Esc closes the info modal
  document.addEventListener('keydown', e => { if(e.key==='Escape') closeInfo(); });
});

// ── Landing / home navigation ──
function enterApp(){
  document.body.classList.remove('show-landing');
  goToStep(1);
}
function goHome(){
  closeInfo();
  document.body.classList.add('show-landing');
  window.scrollTo({top:0,behavior:'smooth'});
}

// ── Info modal (วิธีใช้ / ทฤษฎีที่เกี่ยวข้อง) ──
const INFO = {
  howto: {
    title: '<i class="fas fa-book-open"></i> วิธีใช้งาน',
    html: `
      <p class="info-lead">โปรแกรมช่วยหาว่าต้องสับเปลี่ยน/เปลี่ยนตัวเก็บประจุ (Capacitor) อย่างไร
        ให้กระแส unbalance ที่จุด neutral (I<sub>no</sub>) ต่ำกว่าเกณฑ์รีเลย์ โดยใช้จำนวนครั้งน้อยที่สุด</p>
      <div class="info-steps">
        <div class="info-step"><div class="n">1</div><div class="t"><b>เลือกรูปแบบการต่อ</b> — Y-Y Ungrounded (ป้องกันด้วยรีเลย์แรงดัน 59N/ΔV) หรือ H-Bridge (ป้องกันด้วย Bridge CT 60P)</div></div>
        <div class="info-step"><div class="n">2</div><div class="t"><b>ตั้งค่าและกรอกข้อมูล</b> — ใส่แรงดันระบบ V<sub>S</sub> (kV), เลือกค่า unbalance สูงสุดที่ยอมรับ (mA), แล้วกรอกค่าความจุ C ของแต่ละเฟส/ขา (µF)</div></div>
        <div class="info-step"><div class="n">3</div><div class="t">ช่องที่เป็น <b>คู่ขนาน</b> ให้ติ๊ก “ต่อขนาน” (ล็อกเป็น Tier 2) — ถ้าวัดแยกทีละตัวให้กดปุ่ม <b>กรรไกร ✂</b> แล้วกรอก 2 ค่า ระบบจะใช้ผลรวม</div></div>
        <div class="info-step"><div class="n">4</div><div class="t">กด <b>“วิเคราะห์”</b> เพื่อคำนวณ</div></div>
        <div class="info-step"><div class="n">5</div><div class="t">ดูผลได้ 3 มุมมอง: <b>ค่าวิศวกรรม</b> (I<sub>no</sub>, V<sub>no</sub>, Q), <b>สูตรการคำนวณ</b>, และ <b>ผลการสับเปลี่ยน</b> (Quick Mode / Full Optimal)</div></div>
        <div class="info-step"><div class="n">6</div><div class="t">กด <b>“Export Excel”</b> เพื่อออกรายงานตามฟอร์มของ กฟผ. (ก่อนสับ 3 ชีต + หลังสับ 3 ชีต)</div></div>
      </div>`
  },
  theory: {
    title: '<i class="fas fa-square-root-variable"></i> ทฤษฎีที่เกี่ยวข้อง',
    html: `
      <div class="info-h">Capacitor Bank แบบ Double-Wye Ungrounded</div>
      <ul class="info-list">
        <li>ต่อเป็น 2 สตริง (<b>Y1, Y2</b>) ต่อเฟส โดยจุด neutral <b>ลอย</b> (ไม่ต่อลงดิน)</li>
        <li>ป้องกันด้วยรีเลย์วัด <b>แรงดันที่จุด neutral</b> (Neutral Voltage Relay · 59N / ΔV)</li>
      </ul>
      <div class="info-h">กระแส Unbalance ที่ neutral (I<sub>no</sub>)</div>
      <ul class="info-list">
        <li>เมื่อความจุแต่ละเฟส<b>ไม่สมดุล</b> จะเกิดแรงดัน neutral displacement (V<sub>no</sub>) และกระแส unbalance ไหลผ่าน CT ที่ neutral</li>
        <li>คำนวณด้วยวิธี <b>เชิงเวกเตอร์ (complex-phasor)</b> มุมเฟส A=0°, B=−120°, C=+120° — ไม่ใช่ผลรวมขนาดสูงสุด</li>
        <li>ความจุต่อเฟสเป็นการต่อ <b>อนุกรม</b>: C<sub>phase</sub> = 1 / Σ(1/Cᵢ)</li>
      </ul>
      <div class="info-h">สมการหลัก (ตรงกับ Excel ของ กฟผ.)</div>
      <div class="info-formula">V<sub>ph</sub> = V<sub>S</sub> / √3&nbsp;&nbsp;•&nbsp;&nbsp;S<sub>k</sub> = 2πf·C<sub>k</sub><br>I<sub>no</sub> = √(I<sub>nx</sub>² + I<sub>ny</sub>²)</div>
      <div class="info-h">เป้าหมายการสับเปลี่ยน</div>
      <ul class="info-list">
        <li>ปรับให้ <b>A = B = C</b> ในแต่ละ wye (บาลานซ์เฟส) เพื่อให้ I<sub>no</sub> ต่ำกว่าเกณฑ์รีเลย์</li>
        <li>ใช้การสับเปลี่ยน/เปลี่ยนตัวเก็บประจุ <b>น้อยครั้งที่สุด</b> โดยเรียงตามระยะในแร็ค (ใกล้→ไกล) และใช้ spare ท้ายสุด เพื่อลดเวลาหน้างาน</li>
      </ul>`
  }
};
function openInfo(kind){
  const data = INFO[kind]; if(!data) return;
  document.getElementById('infoTitle').innerHTML = data.title;
  document.getElementById('infoContent').innerHTML = data.html;
  const m = document.getElementById('infoModal');
  m.classList.add('open');
  m.querySelector('.modal-body').scrollTop = 0;
}
function closeInfo(){
  const m = document.getElementById('infoModal');
  if(m) m.classList.remove('open');
}

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

// v9.5 — capacitor unit rating (Step 2). Failed = outside [rated·(1−m%), rated·(1+p%)];
// defaults follow IEC 60871-1 §7.2 (−5 % / +10 %). Rated kV is optional (110 % check).
function readCapRating(){
  const num = id => { const el = document.getElementById(id); const v = el ? parseFloat(el.value) : NaN; return isFinite(v) ? v : undefined; };
  return { uf: num('capRatedUF'), minusPct: num('capTolMinus'), plusPct: num('capTolPlus'), ratedKV: num('capRatedKV') };
}
function updateCapBand(){
  if (typeof updatePhaseSums === 'function' && document.getElementById('inputArea')) updatePhaseSums();   // re-flag inputs
  const el = document.getElementById('capBand'); if (!el || typeof capSpecOf !== 'function') return;
  const c = capSpecOf(readCapRating());
  el.innerHTML = `ตัวดี = <b>${c.lo.toFixed(2)} – ${c.hi.toFixed(2)} µF</b> · ต่ำหรือสูงกว่านี้นับเป็นตัวเสีย` +
    (c.ratedKV ? ` · แรงดันต่อตัวต้องไม่เกิน <b>${(c.ratedKV * UNIT_OV_LIMIT).toFixed(2)} kV</b> (110% ของ ${c.ratedKV} kV)` : '');
}
// Results → "ใช้ค่านี้": switch the I_no ref bubble and re-run with the same inputs.
function useInoRef(r){
  const btn = document.querySelector('.bubble[data-val="' + r + '"]');
  if (btn) selectAlarm(btn);
  handleCalculate(r);          // v10.1: that row's plan becomes the recommendation
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
  if(!currentConn) return;   // must pick a topology first (button stays disabled anyway)
  const labelTh={'yy-unground':'Y-Y ไม่ต่อลงดิน','h-bridge':'H-Bridge (4 Legs)'};
  var ct = document.getElementById('confirmedType');
  if (ct) ct.textContent=labelTh[currentConn]||currentConn;
  buildInputArea();
  goToStep(2);
}

function restartWizard(){
  lastCalcData=null;
  currentConn=null;
  document.querySelectorAll('.conn-opt').forEach(o=>o.classList.remove('active'));
  const wrap=document.getElementById('diagramWrap');
  if(wrap){ wrap.classList.add('is-collapsed'); wrap.classList.remove('reveal'); }
  const hint=document.getElementById('diagramHint'); if(hint) hint.classList.remove('is-hidden');
  const next=document.getElementById('btnNext1'); if(next) next.disabled=true;
  goToStep(1);
}

function highlightConn(el){
  document.querySelectorAll('.conn-opt').forEach(o=>o.classList.remove('active'));
  el.classList.add('active');
  currentConn=el.dataset.conn;
  const labels={'yy-unground':'Y-Y Ungrounded','h-bridge':'H-Bridge'};
  document.getElementById('diagramLabel').textContent=labels[currentConn]||'';
  renderDiagram(currentConn,'diagramContainer');
  // reveal the circuit on demand (hidden until a topology is chosen)
  const hint=document.getElementById('diagramHint'); if(hint) hint.classList.add('is-hidden');
  const wrap=document.getElementById('diagramWrap');
  if(wrap){
    wrap.classList.remove('is-collapsed');
    wrap.classList.remove('reveal'); void wrap.offsetWidth; wrap.classList.add('reveal'); // restart the entrance
  }
  const next=document.getElementById('btnNext1'); if(next) next.disabled=false;
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
    if (area.dataset.built !== currentConn) {   // rebuild when the topology changes
      area.dataset.built = currentConn;
      area.innerHTML = `
        <div class="input-cols" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;">
          <div class="inp-panel la">
            <div class="panel-hd">ขา A <small>บนซ้าย</small><span class="ph-sum" id="sumA"></span></div>
            <div class="panel-ctrl"><label for="cntA">จำนวนช่อง</label><input type="number" id="cntA" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('A')"><label class="par-toggle"><input type="checkbox" id="parA"><span>ต่อขนาน 2 ลูก</span></label></div>
            <div id="panelA"></div>
          </div>
          <div class="inp-panel lb">
            <div class="panel-hd">ขา B <small>บนขวา</small><span class="ph-sum" id="sumB"></span></div>
            <div class="panel-ctrl"><label for="cntB">จำนวนช่อง</label><input type="number" id="cntB" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('B')"><label class="par-toggle"><input type="checkbox" id="parB"><span>ต่อขนาน 2 ลูก</span></label></div>
            <div id="panelB"></div>
          </div>
          <div class="inp-panel lc">
            <div class="panel-hd">ขา C <small>ล่างซ้าย</small><span class="ph-sum" id="sumC"></span></div>
            <div class="panel-ctrl"><label for="cntC">จำนวนช่อง</label><input type="number" id="cntC" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('C')"><label class="par-toggle"><input type="checkbox" id="parC"><span>ต่อขนาน 2 ลูก</span></label></div>
            <div id="panelC"></div>
          </div>
          <div class="inp-panel ld">
            <div class="panel-hd">ขา D <small>ล่างขวา</small><span class="ph-sum" id="sumD"></span></div>
            <div class="panel-ctrl"><label for="cntD">จำนวนช่อง</label><input type="number" id="cntD" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('D')"><label class="par-toggle"><input type="checkbox" id="parD"><span>ต่อขนาน 2 ลูก</span></label></div>
            <div id="panelD"></div>
          </div>
          <div class="inp-panel spare" style="grid-column:1/-1;">
            <div class="panel-hd"><i class="fas fa-box-open"></i> อะไหล่ (spare) <small>ลูกเดี่ยว</small></div>
            <div class="panel-ctrl"><label for="cntS">จำนวนลูก</label><input type="number" id="cntS" value="5" min="0" max="40" class="cnt-input" onchange="rebuildPanel('S')"></div>
            <div id="panelS"></div>
          </div>
        </div>`;
    }
    ['A','B','C','D'].forEach(p => rebuildPanel(p));
    // H-Bridge: attach scissors visibility listeners
    [['parA','a'],['parB','b'],['parC','c'],['parD','d']].forEach(([cbId, cls]) => {
      const cb = document.getElementById(cbId);
      if (cb) {
        cb.onchange = () => { updateScissorsVisibility(cbId, cls); updatePhaseSums(); };
        updateScissorsVisibility(cbId, cls); // init
      }
    });
    rebuildPanel('S');
  } else {
    // Y-Y: 6 phases (A,B,C,A',B',C') + spare
    if (area.dataset.built !== currentConn) {   // rebuild when the topology changes
      area.dataset.built = currentConn;
      area.innerHTML = `
        <div class="yy-section">
          <div class="yy-section-title yy-side1"><i class="fas fa-arrow-circle-right"></i> ฝั่งที่ 1 (Y1)
            <label class="par-toggle" style="margin-left:auto;"><input type="checkbox" id="parY1"><span>ต่อขนาน 2 ลูก</span></label>
          </div>
          <div class="phase-tabs" data-side="y1" role="tablist"><button type="button" role="tab" class="phase-tab on" data-key="A" onclick="setActivePhase('y1','A')">A<small id="tabA">—</small></button><button type="button" role="tab" class="phase-tab" data-key="B" onclick="setActivePhase('y1','B')">B<small id="tabB">—</small></button><button type="button" role="tab" class="phase-tab" data-key="C" onclick="setActivePhase('y1','C')">C<small id="tabC">—</small></button></div>
          <div class="yy-phase-row" data-side="y1">
            <div class="inp-panel y1 is-active" data-key="A" id="wrapA"><div class="panel-hd">เฟส A<span class="ph-sum" id="sumA"></span></div>
              <div class="panel-ctrl"><label for="cntA">จำนวนช่อง</label><input type="number" id="cntA" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('A')"></div>
              <div id="panelA"></div>
              <button type="button" class="phase-next" onclick="nextPhase('A')">ถัดไป: เฟส B</button></div>
            <div class="inp-panel y1" data-key="B" id="wrapB"><div class="panel-hd">เฟส B<span class="ph-sum" id="sumB"></span></div>
              <div class="panel-ctrl"><label for="cntB">จำนวนช่อง</label><input type="number" id="cntB" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('B')"></div>
              <div id="panelB"></div>
              <button type="button" class="phase-next" onclick="nextPhase('B')">ถัดไป: เฟส C</button></div>
            <div class="inp-panel y1" data-key="C" id="wrapC"><div class="panel-hd">เฟส C<span class="ph-sum" id="sumC"></span></div>
              <div class="panel-ctrl"><label for="cntC">จำนวนช่อง</label><input type="number" id="cntC" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('C')"></div>
              <div id="panelC"></div>
              <button type="button" class="phase-next" onclick="nextPhase('C')">ถัดไป: เฟส A'</button></div>
          </div>
        </div>
        <div class="yy-section">
          <div class="yy-section-title yy-side2"><i class="fas fa-arrow-circle-right"></i> ฝั่งที่ 2 (Y2)
            <label class="par-toggle" style="margin-left:auto;"><input type="checkbox" id="parY2"><span>ต่อขนาน 2 ลูก</span></label>
          </div>
          <div class="phase-tabs" data-side="y2" role="tablist"><button type="button" role="tab" class="phase-tab on" data-key="Ap" onclick="setActivePhase('y2','Ap')">A'<small id="tabAp">—</small></button><button type="button" role="tab" class="phase-tab" data-key="Bp" onclick="setActivePhase('y2','Bp')">B'<small id="tabBp">—</small></button><button type="button" role="tab" class="phase-tab" data-key="Cp" onclick="setActivePhase('y2','Cp')">C'<small id="tabCp">—</small></button></div>
          <div class="yy-phase-row" data-side="y2">
            <div class="inp-panel y2 is-active" data-key="Ap" id="wrapAp"><div class="panel-hd">เฟส A'<span class="ph-sum" id="sumAp"></span></div>
              <div class="panel-ctrl"><label for="cntAp">จำนวนช่อง</label><input type="number" id="cntAp" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('Ap')"></div>
              <div id="panelAp"></div>
              <button type="button" class="phase-next" onclick="nextPhase('Ap')">ถัดไป: เฟส B'</button></div>
            <div class="inp-panel y2" data-key="Bp" id="wrapBp"><div class="panel-hd">เฟส B'<span class="ph-sum" id="sumBp"></span></div>
              <div class="panel-ctrl"><label for="cntBp">จำนวนช่อง</label><input type="number" id="cntBp" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('Bp')"></div>
              <div id="panelBp"></div>
              <button type="button" class="phase-next" onclick="nextPhase('Bp')">ถัดไป: เฟส C'</button></div>
            <div class="inp-panel y2" data-key="Cp" id="wrapCp"><div class="panel-hd">เฟส C'<span class="ph-sum" id="sumCp"></span></div>
              <div class="panel-ctrl"><label for="cntCp">จำนวนช่อง</label><input type="number" id="cntCp" value="10" min="1" max="60" class="cnt-input" onchange="rebuildPanel('Cp')"></div>
              <div id="panelCp"></div>
              <button type="button" class="phase-next" onclick="nextPhase('Cp')">ถัดไป: เฟส อะไหล่</button></div>
          </div>
        </div>
        <div class="yy-section">
          <div class="yy-section-title yy-spare" id="spareTitle"><i class="fas fa-box-open"></i> อะไหล่ (spare) <small>ลูกเดี่ยว</small></div>
          <div class="panel-ctrl"><label for="cntS">จำนวนลูก</label><input type="number" id="cntS" value="5" min="0" max="40" class="cnt-input" onchange="rebuildPanel('S')"></div>
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
          updatePhaseSums();
        };
        // Initialize visibility on load
        const cls = cbId === 'parY1' ? ['a','b','c'] : ['ap','bp','cp'];
        cls.forEach(c => updateScissorsVisibility(cbId, c));
      }
    });
    rebuildPanel('S');
  }
  if (!area.dataset.live) {          // one delegated listener for live ΣC / flags
    area.addEventListener('input', () => updatePhaseSums());
    area.dataset.live = '1';
  }
  updatePhaseSums();
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
  container.querySelectorAll('.split-btn.on').forEach(btn => { savedSplit[btn.dataset.idx] = true; });
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
      const inId = `in-${cls}-${i}`;
      h += `<div class="cr-slot split-slot-${cls}${isSplit ? ' is-split' : ''}" data-slot="${slotId}">
        <div class="cr cr-main-row">
          <label for="${inId}">${pfx}-${i}</label>
          <input type="number" step="0.001" min="0" id="${inId}"
                 class="val-${cls} val-main"
                 data-pfx="${pfx}" data-idx="${i}"
                 value="${saved[String(i)]||''}" placeholder="0.000" inputmode="decimal"
                 ${isSplit ? 'disabled' : ''}>
          <span class="pair-sum" aria-live="polite"></span>
          <span class="unit">µF</span>
          <span class="flag" hidden>นอกพิกัด</span>
          <button type="button" class="split-btn split-btn-${cls} ${isSplit?'on':''}"
                  data-slot="${slotId}" data-idx="${i}" data-cls="${cls}" data-pfx="${pfx}"
                  aria-pressed="${isSplit}" title="วัดแยกทีละลูก (a และ b)"
                  onclick="toggleSplit('${cls}', ${i})"
                  style="display:none;">
            <i class="fas fa-cut" aria-hidden="true"></i><span class="split-lbl">วัดแยก</span>
          </button>
        </div>
        <div class="cr-split-pair" id="splitpair-${cls}-${i}" style="display:${isSplit?'flex':'none'};">
          <div class="cr cr-sub">
            <label for="${inId}a">ลูก a</label>
            <input type="number" step="0.001" min="0" id="${inId}a"
                   class="val-${cls}-a val-sub split-a"
                   data-pfx="${pfx}" data-idx="${i}" data-sub="a"
                   value="${savedA[String(i)]||''}" placeholder="0.000" inputmode="decimal">
            <span class="unit">µF</span>
            <span class="flag" hidden>นอกพิกัด</span>
          </div>
          <div class="cr cr-sub">
            <label for="${inId}b">ลูก b</label>
            <input type="number" step="0.001" min="0" id="${inId}b"
                   class="val-${cls}-b val-sub split-b"
                   data-pfx="${pfx}" data-idx="${i}" data-sub="b"
                   value="${savedB[String(i)]||''}" placeholder="0.000" inputmode="decimal">
            <span class="unit">µF</span>
            <span class="flag" hidden>นอกพิกัด</span>
          </div>
        </div>
      </div>`;
    }
  }
  container.innerHTML = h;
  // bug fix: after a rebuild the scissors buttons came back hidden even when the side is
  // marked parallel — re-apply the side's parallel state to this panel.
  if (key !== 'S') {
    const cb = currentConn === 'h-bridge' ? 'par' + key : (['A', 'B', 'C'].includes(key) ? 'parY1' : 'parY2');
    const box = document.getElementById(cb);
    container.querySelectorAll('.split-btn').forEach(btn => { btn.style.display = (box && box.checked) ? 'inline-flex' : 'none'; });
  }
  updatePhaseSums();
}

// ── Step 2 live feedback: ΣC per phase (field-sheet number), parallel-pair totals and
// out-of-tolerance flags while typing. Grouped parallel slots ("ต่อขนาน" without
// วัดแยก) hold n units, so they are judged per unit (value / n), same as the calculator.
function updatePhaseSums() {
  const spec = (typeof capSpecOf === 'function') ? capSpecOf(readCapRating()) : null;
  const bad = v => spec && v > 0 && (v < spec.lo - 1e-9 || v > spec.hi + 1e-9);
  const fmt = v => v.toFixed(1);
  const keys = currentConn === 'h-bridge' ? ['A', 'B', 'C', 'D'] : ['A', 'B', 'C', 'Ap', 'Bp', 'Cp'];
  keys.forEach(key => {
    const panel = document.getElementById('panel' + key); if (!panel) return;
    const parId = currentConn === 'h-bridge' ? 'par' + key : (['A', 'B', 'C'].includes(key) ? 'parY1' : 'parY2');
    const grouped = !!(document.getElementById(parId) || {}).checked;
    let sum = 0, filled = 0, total = 0, nBad = 0;
    panel.querySelectorAll('.cr-slot').forEach(slot => {
      total++;
      const main = slot.querySelector('.val-main');
      const isSplit = slot.classList.contains('is-split');
      const flagRow = (row, on) => { const f = row && row.querySelector('.flag'); if (f) f.hidden = !on;
        const inp = row && row.querySelector('input'); if (inp) inp.classList.toggle('is-bad', !!on); };
      if (isSplit) {
        const a = parseFloat((slot.querySelector('.split-a') || {}).value), b = parseFloat((slot.querySelector('.split-b') || {}).value);
        const subs = slot.querySelectorAll('.cr-sub');
        flagRow(subs[0], bad(a)); flagRow(subs[1], bad(b)); flagRow(slot.querySelector('.cr-main-row'), false);
        const ps = slot.querySelector('.pair-sum');
        if (a > 0 && b > 0) { sum += a + b; filled++; if (bad(a) || bad(b)) nBad++; if (ps) ps.textContent = (a + b).toFixed(2); }
        else if (ps) ps.textContent = '—';
      } else {
        const v = parseFloat(main && main.value);
        const n = grouped && spec ? Math.max(1, Math.round(v / spec.uf)) : 1;
        const isBad = v > 0 && bad(v / n);
        flagRow(slot.querySelector('.cr-main-row'), isBad);
        if (v > 0) { sum += v; filled++; if (isBad) nBad++; }
      }
    });
    const txt = filled ? 'ΣC ' + fmt(sum) + ' µF' + (filled < total ? ' (' + filled + '/' + total + ')' : '') : '';
    const hd = document.getElementById('sum' + key); if (hd) hd.textContent = txt;
    const tab = document.getElementById('tab' + key);
    if (tab) { tab.textContent = filled ? fmt(sum) : 'ยังไม่กรอก'; tab.parentElement.classList.toggle('has-bad', nBad > 0); }
  });
}
// Mobile: one phase visible per side; the tabs show each phase's ΣC.
function setActivePhase(side, key) {
  const row = document.querySelector('.yy-phase-row[data-side="' + side + '"]');
  const tabs = document.querySelector('.phase-tabs[data-side="' + side + '"]');
  if (!row || !tabs) return;
  row.querySelectorAll('.inp-panel').forEach(p => p.classList.toggle('is-active', p.dataset.key === key));
  tabs.querySelectorAll('.phase-tab').forEach(t => { const on = t.dataset.key === key; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); });
}
function nextPhase(key) {
  const order = ['A', 'B', 'C', 'Ap', 'Bp', 'Cp'];
  const i = order.indexOf(key), nk = order[i + 1];
  let target;
  if (nk) { setActivePhase(['A', 'B', 'C'].includes(nk) ? 'y1' : 'y2', nk); target = document.querySelector('.phase-tabs[data-side="' + (['A', 'B', 'C'].includes(nk) ? 'y1' : 'y2') + '"]'); }
  else target = document.getElementById('spareTitle');
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const first = nk && document.querySelector('#panel' + nk + ' input:not([disabled])');
  if (first) setTimeout(() => first.focus({ preventScroll: true }), 350);
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

  const slot = mainInput.closest('.cr-slot');
  const isNowOpen = splitPair.style.display === 'flex';
  if (isNowOpen) {
    // Close split
    splitPair.style.display = 'none';
    mainInput.disabled = false;
    btn.classList.remove('on');
  } else {
    // Open split — NO auto-fill, NO ÷2. The technician types the two real
    // measured values; the slot then uses va+vb (parallel sum) directly.
    splitPair.style.display = 'flex';
    mainInput.disabled = true;
    btn.classList.add('on');
  }
  if (slot) slot.classList.toggle('is-split', !isNowOpen);
  btn.setAttribute('aria-pressed', String(!isNowOpen));
  updatePhaseSums();
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
  // v10.4 (fix 3): never fall back to 69 kV silently — a blank field on a 115 kV bank
  // would scale I_no down ~40 % and flip fail → pass.
  const systemKV=parseFloat(document.getElementById('systemKV').value);
  if(!(systemKV>0)){ alert('กรุณากรอกแรงดันระบบ V_S (kV) ให้ถูกต้อง'); return null; }
  // ค่า unbalance สูงสุด (เกณฑ์ I_no, mA) ที่หน้างานกรอกใน Step 2 — ใช้แทนค่า default
  // ALARM_MA ในการตัดสินผ่าน/ไม่ผ่าน และเป็นเป้าของการคำนวณการสับเปลี่ยน
  const alarmEl=document.getElementById('alarmMA');
  const alarmMA=(alarmEl && parseFloat(alarmEl.value)>0) ? parseFloat(alarmEl.value)
                : ((typeof window!=='undefined' && window.ALARM_MA) || 50);
  const capRating = readCapRating();
  // v10.0 — balance target (ΣC per rack, µF) + spare priority
  const balEl = document.getElementById('balSumUF'), spEl = document.getElementById('sparePriority');
  const balSumUF = (balEl && parseFloat(balEl.value) > 0) ? parseFloat(balEl.value) : 0.1;
  const sparePriority = (spEl && spEl.value) || 'balance';

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
    return { topology:'h-bridge', y1:[...legs.a,...legs.c], y2:[...legs.b,...legs.d], spare, legs, systemKV, alarmMA, capRating };
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
    return { topology:'yy-unground', y1, y2, spare, systemKV, phases, alarmMA, capRating, balSumUF, sparePriority };
  }
}

// ═══════════════════════════════════════════════════════
// CALCULATE — target: Ino < ค่า unbalance ที่กรอก (default ALARM_MA) with minimum swaps
// ═══════════════════════════════════════════════════════
function showCalcOverlay(){
  const o=document.getElementById('calcOverlay');
  if(o){ o.classList.add('open'); o.setAttribute('aria-hidden','false'); }
}
function hideCalcOverlay(){
  const o=document.getElementById('calcOverlay');
  if(o){ o.classList.remove('open'); o.setAttribute('aria-hidden','true'); }
}

async function handleCalculate(pickRef){
  const vals=getInputValues();
  if(!vals) return;
  if (typeof pickRef === 'number') vals.pickRef = pickRef;   // v10.1 picked from the ref table
  const btn=document.getElementById('btnCalc');
  btn.disabled=true;
  btn.innerHTML='<i class="fas fa-spinner fa-spin"></i>&nbsp;กำลังคำนวณ…';
  showCalcOverlay();
  // let the overlay paint before the (synchronous, blocking) optimizer runs
  await new Promise(r=>setTimeout(r,30));
  const started=Date.now();
  try{
    const result = await clientCalculate(vals);
    // keep the overlay up for a moment so it reads as "working" even on fast banks
    const MIN_MS=950, elapsed=Date.now()-started;
    if(elapsed<MIN_MS) await new Promise(r=>setTimeout(r, MIN_MS-elapsed));
    renderResults(vals, result);
    lastCalcData={connType:currentConn,vals,timestamp:new Date().toLocaleString('th-TH'),...result};
    document.getElementById('exportRow').style.display='block';
    goToStep(3);
  }catch(e){
    alert('เกิดข้อผิดพลาด: '+e.message);
  }finally{
    hideCalcOverlay();
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
