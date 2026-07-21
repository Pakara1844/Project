// ═══════════════════════════════════════
// EXPORTER — fills the EGAT reference workbook (RS-CAY21) as a TEMPLATE
// ═══════════════════════════════════════
// The template .xlsx is embedded as base64 (template-xlsx.js). We unzip it with
// JSZip, PATCH only the input-cell <v> values in the raw sheet XML, CLONE the 3
// template sheets for the "after" state, then re-zip. We keep every original
// formula AND its cached value (so cells are never blank) and force a full recalc
// on open via calcId="0" + fullCalcOnLoad="1", so Excel recomputes from the new
// inputs. Editing the XML in place preserves ALL formatting/borders/merges/drawings.
'use strict';

// ── base64 → Uint8Array ──────────────────────────────────────────────────────
function _b64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function _round(x, n) {
  if (x === '' || x == null || isNaN(x)) return x;
  const p = Math.pow(10, n == null ? 4 : n);
  return Math.round(x * p) / p;
}

// Patch ONE numeric cell's value in a worksheet XML string. Matches by exact
// address (open-with-content OR self-closing), keeps its style attr `s`, drops any
// string type `t`. The formula (if any) is preserved — we only touch <v>. All
// cells we target exist in the template.
function _setCell(xml, addr, val) {
  const re = new RegExp('<c r="' + addr + '"([^>]*?)(?:/>|>[\\s\\S]*?</c>)');
  const m = xml.match(re);
  if (!m) { console.warn('template cell not found:', addr); return xml; }
  let s = '';
  const sm = /\ss="(\d+)"/.exec(m[1]);
  if (sm) s = ' s="' + sm[1] + '"';
  const fm = /<f[^>]*>[^<]*<\/f>/.exec(m[0]);   // keep formula if the cell has one
  const f = fm ? fm[0] : '';
  const num = (val === '' || val == null || isNaN(val)) ? null : +val;
  const repl = (num == null && !f)
    ? '<c r="' + addr + '"' + s + '/>'
    : '<c r="' + addr + '"' + s + '>' + f + (num == null ? '' : '<v>' + num + '</v>') + '</c>';
  return xml.replace(re, repl);
}

// group unit values by phase origin (A,B,C / A',B',C')
function _byPhase(arr) {
  const g = { A: [], B: [], C: [], "A'": [], "B'": [], "C'": [] };
  (arr || []).forEach(u => { if (g[u.origin]) g[u.origin].push(u.val); });
  return g;
}

// C-Bank Arrangement grid: 11 series rows × first parallel column per phase.
const _ROWS = [9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29];
const _FIRSTCOL = { A: 'B', B: 'R', C: 'AH', "A'": 'J', "B'": 'Z', "C'": 'AP' };
const _PHASES = ['A', 'B', 'C', "A'", "B'", "C'"];
const _W = 2 * Math.PI * 50;   // ω = 2πf

// ── patch the input cells of each sheet type (formulas untouched) ─────────────
function _patchArrangement(xml, vs, byPhase) {
  xml = _setCell(xml, 'X3', _round(vs, 3));
  let overflow = false;
  for (const ph of _PHASES) {
    const vals = byPhase[ph] || [];
    if (vals.length > _ROWS.length) overflow = true;
    const col = _FIRSTCOL[ph];
    _ROWS.forEach((r, i) => { xml = _setCell(xml, col + r, i < vals.length ? _round(vals[i], 4) : 0); });
  }
  return { xml, overflow };
}
// Farad Measurement: one measured C_phase per phase on row 17.
function _patchFarad(xml, vs, pp) {
  xml = _setCell(xml, 'X4', _round(vs, 3));
  const map = { C17: pp.A.C1, S17: pp.B.C1, AI17: pp.C.C1, K17: pp.A.C2, AA17: pp.B.C2, AQ17: pp.C.C2 };
  for (const a in map) xml = _setCell(xml, a, _round(map[a], 4));
  return xml;
}
// Volt-Amp Measurement: derive consistent V/I from C_phase (row 11 = Volt, 17 = Amp).
function _patchVoltAmp(xml, vs, pp) {
  xml = _setCell(xml, 'X4', _round(vs, 3));
  const V0 = vs * 1000 / Math.sqrt(3);
  const cmap = { C: pp.A.C1, S: pp.B.C1, AI: pp.C.C1, K: pp.A.C2, AA: pp.B.C2, AQ: pp.C.C2 };
  for (const col in cmap) {
    xml = _setCell(xml, col + '11', _round(V0, 2));                          // Volt
    xml = _setCell(xml, col + '17', _round(_W * (cmap[col] || 0) * 1e-6 * V0, 5)); // Amp = ωC·V
  }
  return xml;
}

// Clone template sheet `src` (1..3) → `dst`, cloning its drawing so the after
// sheet is visually identical. Returns nothing; caller patches sheetdst afterwards.
async function _cloneSheet(zip, src, dst) {
  const ws = await zip.file('xl/worksheets/sheet' + src + '.xml').async('string');
  zip.file('xl/worksheets/sheet' + dst + '.xml', ws);
  const rels = await zip.file('xl/worksheets/_rels/sheet' + src + '.xml.rels').async('string');
  zip.file('xl/worksheets/_rels/sheet' + dst + '.xml.rels',
    rels.replace('drawing' + src + '.xml', 'drawing' + dst + '.xml'));
  const dr = await zip.file('xl/drawings/drawing' + src + '.xml').async('string');
  zip.file('xl/drawings/drawing' + dst + '.xml', dr);
}

async function exportToExcel(data) {
  if ((data.connType || data.topology) === 'h-bridge') return exportSimple(data);
  if (typeof JSZip === 'undefined') { alert('ไม่พบ Library JSZip (ต้องต่อเน็ตครั้งแรก)'); return; }
  if (typeof EGAT_TEMPLATE_B64 === 'undefined') { alert('ไม่พบ template'); return; }

  const eb = data.engBefore || {};
  const ppBefore = eb.perPhase || { A: {}, B: {}, C: {} };
  const vs = (data.vals && data.vals.systemKV) || 69;
  const beforeUnits = [...((data.vals && data.vals.y1) || []), ...((data.vals && data.vals.y2) || [])];

  // recommended swap = the "after" state
  const q = data.quickResult || {};
  const swaps = q.swaps || [];
  const idx = q.bestFullyPass != null ? q.bestFullyPass
            : (q.bestUnderThreshold != null ? q.bestUnderThreshold : swaps.length - 1);
  const after = swaps[idx] || {};
  const afterUnits = [...(after.y1Full || after.y1 || []), ...(after.y2Full || after.y2 || [])];
  const ppAfter = (after.engAfter && after.engAfter.perPhase) || ppBefore;

  const zip = await JSZip.loadAsync(_b64ToU8(EGAT_TEMPLATE_B64));

  // clone the 3 template sheets (with drawings) → sheet4/5/6 for the "after" set
  await _cloneSheet(zip, 1, 4);
  await _cloneSheet(zip, 2, 5);
  await _cloneSheet(zip, 3, 6);

  // ── patch inputs — BEFORE (sheets 1-3), AFTER (sheets 4-6) ──
  const b1 = _patchArrangement(await zip.file('xl/worksheets/sheet1.xml').async('string'), vs, _byPhase(beforeUnits));
  zip.file('xl/worksheets/sheet1.xml', b1.xml);
  zip.file('xl/worksheets/sheet2.xml', _patchFarad(await zip.file('xl/worksheets/sheet2.xml').async('string'), vs, ppBefore));
  zip.file('xl/worksheets/sheet3.xml', _patchVoltAmp(await zip.file('xl/worksheets/sheet3.xml').async('string'), vs, ppBefore));

  const a1 = _patchArrangement(await zip.file('xl/worksheets/sheet4.xml').async('string'), vs, _byPhase(afterUnits));
  zip.file('xl/worksheets/sheet4.xml', a1.xml);
  zip.file('xl/worksheets/sheet5.xml', _patchFarad(await zip.file('xl/worksheets/sheet5.xml').async('string'), vs, ppAfter));
  zip.file('xl/worksheets/sheet6.xml', _patchVoltAmp(await zip.file('xl/worksheets/sheet6.xml').async('string'), vs, ppAfter));

  // ── register sheet4/5/6 (+ their drawings) ──
  let ct = await zip.file('[Content_Types].xml').async('string');
  ct = ct.replace('</Types>',
    '<Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet5.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet6.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/drawings/drawing4.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' +
    '<Override PartName="/xl/drawings/drawing5.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' +
    '<Override PartName="/xl/drawings/drawing6.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' +
    '</Types>');
  zip.file('[Content_Types].xml', ct);

  let rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  rels = rels.replace('</Relationships>',
    '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/>' +
    '<Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet5.xml"/>' +
    '<Relationship Id="rId12" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet6.xml"/>' +
    '</Relationships>');
  zip.file('xl/_rels/workbook.xml.rels', rels);

  // keep the original 3 sheet NAMES (Farad/Volt-Amp formulas cross-reference
  // 'C-Bank Arrangement ' by name — renaming would break them), append 3 "หลังสับ".
  let wbx = await zip.file('xl/workbook.xml').async('string');
  wbx = wbx.replace(/<sheets>[\s\S]*?<\/sheets>/,
    '<sheets>' +
    '<sheet name="C-Bank Arrangement " sheetId="6" r:id="rId1"/>' +
    '<sheet name="Farad Measurement" sheetId="7" r:id="rId2"/>' +
    '<sheet name="Volt-Amp Measurement" sheetId="8" r:id="rId3"/>' +
    '<sheet name="C-Bank Arrangement หลังสับ" sheetId="9" r:id="rId10"/>' +
    '<sheet name="Farad Measurement หลังสับ" sheetId="10" r:id="rId11"/>' +
    '<sheet name="Volt-Amp Measurement หลังสับ" sheetId="11" r:id="rId12"/>' +
    '</sheets>');
  // calcId="0" + fullCalcOnLoad="1" → force Excel to fully recompute on open
  wbx = wbx.replace(/<calcPr[^>]*\/>/, '<calcPr calcId="0" fullCalcOnLoad="1"/>');
  zip.file('xl/workbook.xml', wbx);

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const stamp = (data.timestamp || new Date().toLocaleString('th-TH')).replace(/[\/:\s,]/g, '-');
  _download(blob, 'EGAT_CBank_RS-CAY21_' + stamp + '.xlsx');

  if (b1.overflow || a1.overflow) {
    alert('หมายเหตุ: template รองรับสูงสุด ' + _ROWS.length +
          ' ตัวอนุกรม/เฟส — เฟสที่มีมากกว่านี้จะถูกตัดในไฟล์ Excel (การคำนวณในแอปยังครบ)');
  }
}

function _download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
}

// ── H-bridge fallback: simple SheetJS workbook (template is Y-Y only) ──────────
function exportSimple(data) {
  if (typeof XLSX === 'undefined') { alert('ไม่พบ Library XLSX'); return; }
  const wb = XLSX.utils.book_new();
  const rows = [
    ['EGAT C-Bank Optimizer — H-Bridge'], [''],
    ['วันที่/เวลา', data.timestamp || ''],
    ['แรงดันระบบ (kV)', (data.vals && data.vals.systemKV) || ''],
    ['I_bridge ก่อน (mA)', data.engBefore ? (data.engBefore.In_mA || data.engBefore.Ino_mA_before) : ''], [''],
    ['Left (A+C)', '', 'Right (B+D)'], ['ID', 'µF', 'ID', 'µF'],
  ];
  const y1 = (data.vals && data.vals.y1) || [], y2 = (data.vals && data.vals.y2) || [];
  const mx = Math.max(y1.length, y2.length);
  for (let i = 0; i < mx; i++) {
    const a = y1[i], b = y2[i];
    rows.push([a ? a.id : '', a ? a.val : '', b ? b.id : '', b ? b.val : '']);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [14, 12, 14, 12].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'H-Bridge');
  XLSX.writeFile(wb, 'EGAT_CBank_HBridge_' + (data.timestamp || '').replace(/[\/:\s,]/g, '-') + '.xlsx');
}
