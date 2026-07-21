// ═══════════════════════════════════════
// DIAGRAMS
// ═══════════════════════════════════════
/**
 * public/js/diagrams.js v4 — Realistic Capacitor Bank Diagrams
 * Photo-realistic style: 3D capacitors, metal frames, insulators, busbars
 */
'use strict';

const PAL = {
  blue:'#1a5fb4', blueLight:'#4a90d9', blueDark:'#103e7a',
  amber:'#c97d00', amberLight:'#e89930', amberDark:'#8a5500',
  metal:'#a8b2bf', metalDark:'#5a6371', metalLight:'#d4dae3',
  insulator:'#a89060', insulatorLight:'#c9b58a', insulatorDark:'#7a6740',
  capBody:'#e8e4d8', capBodyDark:'#b8b4a8', capBodyShade:'#9a9486',
  capCan:'#d8d0bc',
  groundLine:'#3a4654', txt:'#1a2332', txt2:'#4a5568', txt3:'#718096',
  bgGrid:'#f0f4f8', red:'#c0392b', green:'#1a7a3c'
};

/* ── SVG primitives ─────────────────────────────────────── */

/** Realistic capacitor unit — porcelain insulator + metal can with bushings */
function realisticCap(x, y, w, h, color) {
  // x,y = top-left, w,h = overall dimensions
  color = color || PAL.capBody;
  const cx = x + w/2;
  // Top bushing (porcelain insulator)
  const bushW = w * 0.25;
  const bushH = h * 0.18;
  const bushX = cx - bushW/2;
  // Body (metal can)
  const bodyY = y + bushH + 2;
  const bodyH = h - bushH * 2 - 4;
  // Bottom bushing
  const bbY = bodyY + bodyH + 2;

  return `
    <!-- top porcelain insulator -->
    <rect x="${bushX}" y="${y}" width="${bushW}" height="${bushH}" fill="${PAL.insulator}" stroke="${PAL.insulatorDark}" stroke-width="0.5" rx="1"/>
    <rect x="${bushX-1}" y="${y+bushH*0.3}" width="${bushW+2}" height="2" fill="${PAL.insulatorDark}" opacity="0.5"/>
    <rect x="${bushX-1}" y="${y+bushH*0.6}" width="${bushW+2}" height="2" fill="${PAL.insulatorDark}" opacity="0.5"/>
    <!-- terminal cap -->
    <rect x="${bushX-2}" y="${y-2}" width="${bushW+4}" height="3" fill="${PAL.metalDark}" rx="0.5"/>
    <!-- main body (metal can) -->
    <rect x="${x}" y="${bodyY}" width="${w}" height="${bodyH}" fill="${color}" stroke="${PAL.capBodyShade}" stroke-width="0.6" rx="2"/>
    <!-- body shading (left highlight, right shadow) -->
    <rect x="${x+1}" y="${bodyY+1}" width="${w*0.18}" height="${bodyH-2}" fill="#ffffff" opacity="0.35" rx="1"/>
    <rect x="${x+w-w*0.18-1}" y="${bodyY+1}" width="${w*0.18}" height="${bodyH-2}" fill="#000000" opacity="0.10" rx="1"/>
    <!-- horizontal ribs (typical of oil-filled caps) -->
    <line x1="${x+1}" y1="${bodyY+bodyH*0.3}" x2="${x+w-1}" y2="${bodyY+bodyH*0.3}" stroke="${PAL.capBodyShade}" stroke-width="0.4" opacity="0.6"/>
    <line x1="${x+1}" y1="${bodyY+bodyH*0.6}" x2="${x+w-1}" y2="${bodyY+bodyH*0.6}" stroke="${PAL.capBodyShade}" stroke-width="0.4" opacity="0.6"/>
    <!-- bottom porcelain insulator -->
    <rect x="${bushX}" y="${bbY}" width="${bushW}" height="${bushH}" fill="${PAL.insulator}" stroke="${PAL.insulatorDark}" stroke-width="0.5" rx="1"/>
    <rect x="${bushX-1}" y="${bbY+bushH*0.3}" width="${bushW+2}" height="2" fill="${PAL.insulatorDark}" opacity="0.5"/>
    <rect x="${bushX-1}" y="${bbY+bushH*0.6}" width="${bushW+2}" height="2" fill="${PAL.insulatorDark}" opacity="0.5"/>
    <!-- bottom terminal -->
    <rect x="${bushX-2}" y="${bbY+bushH-1}" width="${bushW+4}" height="3" fill="${PAL.metalDark}" rx="0.5"/>
  `;
}

/** Vertical wire with terminals at each end */
function wire(x1, y1, x2, y2, color, w) {
  color = color || PAL.metalDark;
  w = w || 2.2;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
}

/** Steel structural frame (rack) */
function frame(x, y, w, h) {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${PAL.metalDark}" stroke-width="1.4" rx="3"/>
    <rect x="${x+1}" y="${y+1}" width="${w-2}" height="${h-2}" fill="none" stroke="${PAL.metal}" stroke-width="0.5" rx="2"/>
    <line x1="${x}" y1="${y+h*0.5}" x2="${x+w}" y2="${y+h*0.5}" stroke="${PAL.metalDark}" stroke-width="0.8" opacity="0.5"/>
  `;
}

/** Connection terminal (bolted) */
function terminal(x, y, r) {
  r = r || 3;
  return `
    <circle cx="${x}" cy="${y}" r="${r}" fill="${PAL.metal}" stroke="${PAL.metalDark}" stroke-width="0.6"/>
    <circle cx="${x}" cy="${y}" r="${r*0.45}" fill="${PAL.metalDark}"/>
  `;
}

/** Busbar (horizontal) — thick metal strip */
function busbar(x1, y, x2, label, color) {
  color = color || PAL.metal;
  const len = x2 - x1;
  return `
    <rect x="${x1}" y="${y-4}" width="${len}" height="8" fill="${color}" stroke="${PAL.metalDark}" stroke-width="0.8" rx="2"/>
    <rect x="${x1+1}" y="${y-3}" width="${len-2}" height="2" fill="#ffffff" opacity="0.4" rx="1"/>
    ${label ? `<text x="${x1 + len/2}" y="${y-9}" fill="${PAL.txt2}" font-size="9" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="600">${label}</text>` : ''}
  `;
}

/** Phase indicator circle on bus */
function phaseDot(x, y, color, label) {
  return `
    <circle cx="${x}" cy="${y}" r="5" fill="${color}" stroke="${PAL.metalDark}" stroke-width="0.8"/>
    <circle cx="${x-1}" cy="${y-1}" r="1.5" fill="#ffffff" opacity="0.5"/>
    <text x="${x}" y="${y-10}" fill="${color}" font-size="10" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="700">${label}</text>
  `;
}

/** Ground symbol */
function ground(x, y) {
  return `
    <line x1="${x}" y1="${y}" x2="${x}" y2="${y+5}" stroke="${PAL.txt2}" stroke-width="1.5"/>
    <line x1="${x-9}" y1="${y+5}" x2="${x+9}" y2="${y+5}" stroke="${PAL.txt2}" stroke-width="2"/>
    <line x1="${x-6}" y1="${y+8}" x2="${x+6}" y2="${y+8}" stroke="${PAL.txt2}" stroke-width="1.5"/>
    <line x1="${x-3}" y1="${y+11}" x2="${x+3}" y2="${y+11}" stroke="${PAL.txt2}" stroke-width="1.2"/>
  `;
}

/** CT (current transformer) — toroid with label */
function ctReal(x, y) {
  return `
    <ellipse cx="${x}" cy="${y}" rx="14" ry="10" fill="none" stroke="${PAL.amber}" stroke-width="2"/>
    <ellipse cx="${x}" cy="${y}" rx="11" ry="7" fill="none" stroke="${PAL.amber}" stroke-width="0.8" opacity="0.6"/>
    <rect x="${x-7}" y="${y-4}" width="14" height="8" fill="${PAL.bgGrid}" stroke="${PAL.amber}" stroke-width="0.8" rx="1"/>
    <text x="${x}" y="${y+3}" fill="${PAL.amber}" font-size="8" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="700">CT</text>
  `;
}

/** Relay box */
function relayBox(x, y, label, sub) {
  return `
    <rect x="${x}" y="${y}" width="60" height="26" fill="${PAL.bgGrid}" stroke="${PAL.blue}" stroke-width="1.5" rx="3"/>
    <rect x="${x+1}" y="${y+1}" width="58" height="6" fill="${PAL.blue}" rx="1.5"/>
    <text x="${x+30}" y="${y+5.5}" fill="#fff" font-size="6.5" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="700">RELAY</text>
    <text x="${x+30}" y="${y+16}" fill="${PAL.blue}" font-size="9" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="700">${label}</text>
    <text x="${x+30}" y="${y+24}" fill="${PAL.txt3}" font-size="6" text-anchor="middle" font-family="'Space Mono',monospace">${sub}</text>
  `;
}

/* ═══════════════════════════════════════════════════════════
   Y-Y UNGROUNDED — REALISTIC RENDER
   ═══════════════════════════════════════════════════════════ */
function buildYYUngroundReal() {
  const W = 820, H = 540;
  const phases = [
    { x: 180, label: 'A', color: '#c0392b' },
    { x: 410, label: 'B', color: '#1a7a3c' },
    { x: 640, label: 'C', color: '#1a5fb4' }
  ];
  const nCap = 3;
  const capW = 28, capH = 50;
  const busY = 75;

  let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="background:#fafbfc;">`;

  // Background grid
  s += `<defs>
    <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e8edf3" stroke-width="0.5"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>`;

  // Title
  s += `<text x="${W/2}" y="28" fill="${PAL.blue}" font-size="16" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="700">Y-Y UNGROUNDED CAPACITOR BANK</text>`;
  s += `<text x="${W/2}" y="44" fill="${PAL.txt3}" font-size="10" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif">Star-Star ไม่ต่อลงดิน · ป้องกันด้วย Neutral Voltage Relay (ΔV / 59N)</text>`;

  // HV busbar
  s += busbar(60, busY, 760, 'H.V. BUS  ·  69 kV', PAL.metal);

  phases.forEach(p => {
    // Phase identifier
    s += phaseDot(p.x, busY, p.color, p.label);

    // Wire down from bus
    s += wire(p.x, busY+4, p.x, busY+25);

    // ── Y1 string frame (upper) ──────────────────
    const y1FrameY = busY + 25;
    const y1FrameH = nCap * (capH + 14) + 10;
    s += frame(p.x - 50, y1FrameY, 100, y1FrameH);
    s += `<text x="${p.x}" y="${y1FrameY - 4}" fill="${PAL.amber}" font-size="11" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="700">STRING Y1</text>`;

    // Y1 caps
    let cy = y1FrameY + 8;
    for (let i = 0; i < nCap; i++) {
      // Wire above cap
      s += wire(p.x, cy, p.x, cy + 4);
      // Capacitor (offset to center)
      s += realisticCap(p.x - capW/2, cy + 4, capW, capH, PAL.capBody);
      cy += capH + 14;
    }
    // Final wire to N1
    s += wire(p.x, cy - 10, p.x, cy + 4);
    const n1Y = cy + 4;
    s += terminal(p.x, n1Y, 4);
    s += `<text x="${p.x + 12}" y="${n1Y + 3}" fill="${PAL.amberDark}" font-size="9" font-family="'Space Mono',monospace" font-weight="700">N1</text>`;

    // Gap (insulation) between N1 and N2
    s += `<line x1="${p.x}" y1="${n1Y}" x2="${p.x}" y2="${n1Y + 22}" stroke="${PAL.txt3}" stroke-width="1.2" stroke-dasharray="3 3"/>`;

    const n2Y = n1Y + 22;
    s += terminal(p.x, n2Y, 4);
    s += `<text x="${p.x + 12}" y="${n2Y + 3}" fill="${PAL.blueDark}" font-size="9" font-family="'Space Mono',monospace" font-weight="700">N2</text>`;

    // ── Y2 string frame (lower) ──────────────────
    const y2FrameY = n2Y + 8;
    const y2FrameH = nCap * (capH + 14) + 10;
    s += frame(p.x - 50, y2FrameY, 100, y2FrameH);
    s += `<text x="${p.x}" y="${y2FrameY + y2FrameH + 14}" fill="${PAL.blue}" font-size="11" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="700">STRING Y2</text>`;

    cy = y2FrameY + 8;
    for (let i = 0; i < nCap; i++) {
      s += wire(p.x, cy, p.x, cy + 4);
      s += realisticCap(p.x - capW/2, cy + 4, capW, capH, PAL.capBody);
      cy += capH + 14;
    }
  });

  // ── Neutral connection bus N1 (left side) ──
  const n1BusY = busY + 25 + (nCap * (capH + 14)) + 14;
  s += `<line x1="${phases[0].x}" y1="${n1BusY}" x2="${phases[2].x}" y2="${n1BusY}" stroke="${PAL.amber}" stroke-width="1.8" stroke-dasharray="4 2"/>`;
  s += `<text x="${phases[0].x - 60}" y="${n1BusY + 4}" fill="${PAL.amberDark}" font-size="10" font-family="'Rajdhani',sans-serif" font-weight="700">N1 BUS</text>`;

  // ── Neutral connection bus N2 ──
  const n2BusY = n1BusY + 22;
  s += `<line x1="${phases[0].x}" y1="${n2BusY}" x2="${phases[2].x}" y2="${n2BusY}" stroke="${PAL.blue}" stroke-width="1.8" stroke-dasharray="4 2"/>`;
  s += `<text x="${phases[0].x - 60}" y="${n2BusY + 4}" fill="${PAL.blueDark}" font-size="10" font-family="'Rajdhani',sans-serif" font-weight="700">N2 BUS</text>`;

  // ── ΔV Relay between N1 and N2 ──
  const relayX = phases[2].x + 60;
  s += `<line x1="${phases[2].x}" y1="${n1BusY}" x2="${relayX + 30}" y2="${n1BusY}" stroke="${PAL.amber}" stroke-width="1.5"/>`;
  s += `<line x1="${phases[2].x}" y1="${n2BusY}" x2="${relayX + 30}" y2="${n2BusY}" stroke="${PAL.blue}" stroke-width="1.5"/>`;
  s += relayBox(relayX, (n1BusY + n2BusY)/2 - 13, 'ΔV', '59N');

  return s + '</svg>';
}

/* ═══════════════════════════════════════════════════════════
   H-BRIDGE — REALISTIC RENDER
   ═══════════════════════════════════════════════════════════ */
function buildHBridgeReal() {
  const W = 820, H = 540;
  const nCap = 2;
  const capW = 28, capH = 50;
  const busY = 75;
  // Single phase shown — 4 legs A B C D in H formation
  const cx = W/2;
  const leftX = cx - 130, rightX = cx + 130;
  const bridgeY = busY + 25 + nCap * (capH + 14) + 28;

  let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="background:#fafbfc;">`;

  s += `<defs>
    <pattern id="grid2" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e8edf3" stroke-width="0.5"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#grid2)"/>`;

  // Title
  s += `<text x="${W/2}" y="28" fill="${PAL.blue}" font-size="16" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="700">H-BRIDGE CAPACITOR BANK</text>`;
  s += `<text x="${W/2}" y="44" fill="${PAL.txt3}" font-size="10" text-anchor="middle" font-family="'Noto Sans Thai',sans-serif">4 Legs ต่อ Phase (A·B·C·D) · ป้องกันด้วย Bridge Differential CT (60P / 46B)</text>`;

  // HV bus
  s += busbar(80, busY, 740, 'PHASE BUSBAR  ·  230 kV', PAL.metal);
  s += phaseDot(cx, busY, '#c0392b', 'Phase');

  // Wire down to bus split point
  const splitY = busY + 22;
  s += wire(cx, busY+4, cx, splitY);

  // Top horizontal split to left and right legs
  s += wire(leftX, splitY, rightX, splitY, PAL.metalDark, 2.5);
  s += terminal(cx, splitY, 4);

  // ── LEG A (top-left) ──
  s += frame(leftX - 50, splitY + 5, 100, nCap * (capH + 14) + 12);
  s += `<text x="${leftX}" y="${splitY + 1}" fill="${PAL.blue}" font-size="11" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="700">LEG A</text>`;
  let lay = splitY + 12;
  for (let i = 0; i < nCap; i++) {
    s += wire(leftX, lay, leftX, lay + 4);
    s += realisticCap(leftX - capW/2, lay + 4, capW, capH, PAL.capBody);
    lay += capH + 14;
  }
  s += wire(leftX, lay - 10, leftX, bridgeY);

  // ── LEG B (top-right) ──
  s += frame(rightX - 50, splitY + 5, 100, nCap * (capH + 14) + 12);
  s += `<text x="${rightX}" y="${splitY + 1}" fill="${PAL.amber}" font-size="11" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="700">LEG B</text>`;
  let rby = splitY + 12;
  for (let i = 0; i < nCap; i++) {
    s += wire(rightX, rby, rightX, rby + 4);
    s += realisticCap(rightX - capW/2, rby + 4, capW, capH, PAL.capBody);
    rby += capH + 14;
  }
  s += wire(rightX, rby - 10, rightX, bridgeY);

  // ── BRIDGE LINE (horizontal H-link with CT) ──
  s += `<rect x="${leftX - 4}" y="${bridgeY - 6}" width="${rightX - leftX + 8}" height="12" fill="${PAL.metalLight}" stroke="${PAL.metalDark}" stroke-width="0.8" rx="2"/>`;
  s += `<rect x="${leftX - 3}" y="${bridgeY - 5}" width="${rightX - leftX + 6}" height="3" fill="#ffffff" opacity="0.4" rx="1"/>`;
  s += `<text x="${cx}" y="${bridgeY - 12}" fill="${PAL.amber}" font-size="10" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="700">H-LINK BRIDGE</text>`;
  s += terminal(leftX, bridgeY, 4);
  s += terminal(rightX, bridgeY, 4);

  // CT on bridge
  s += ctReal(cx, bridgeY);

  // ── LEG C (bot-left) ──
  s += frame(leftX - 50, bridgeY + 12, 100, nCap * (capH + 14) + 12);
  s += `<text x="${leftX}" y="${bridgeY + 8}" fill="${PAL.blueDark}" font-size="11" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="700">LEG C</text>`;
  let lcy = bridgeY + 18;
  for (let i = 0; i < nCap; i++) {
    s += wire(leftX, lcy, leftX, lcy + 4);
    s += realisticCap(leftX - capW/2, lcy + 4, capW, capH, PAL.capBody);
    lcy += capH + 14;
  }
  const bottomY = lcy - 10;

  // ── LEG D (bot-right) ──
  s += frame(rightX - 50, bridgeY + 12, 100, nCap * (capH + 14) + 12);
  s += `<text x="${rightX}" y="${bridgeY + 8}" fill="${PAL.amberDark}" font-size="11" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="700">LEG D</text>`;
  let rdy = bridgeY + 18;
  for (let i = 0; i < nCap; i++) {
    s += wire(rightX, rdy, rightX, rdy + 4);
    s += realisticCap(rightX - capW/2, rdy + 4, capW, capH, PAL.capBody);
    rdy += capH + 14;
  }

  // Bottom bus / neutral
  const neutralY = bottomY + 18;
  s += wire(leftX, bottomY, leftX, neutralY);
  s += wire(rightX, bottomY, rightX, neutralY);
  s += `<line x1="${leftX - 30}" y1="${neutralY}" x2="${rightX + 30}" y2="${neutralY}" stroke="${PAL.txt2}" stroke-width="1.5" stroke-dasharray="4 2"/>`;
  s += `<text x="${rightX + 60}" y="${neutralY + 3}" fill="${PAL.txt2}" font-size="9" font-family="'Rajdhani',sans-serif" font-weight="700">NEUTRAL</text>`;

  // CT line out to relay
  const relayX = rightX + 80;
  s += `<line x1="${cx + 14}" y1="${bridgeY}" x2="${relayX}" y2="${bridgeY}" stroke="${PAL.amber}" stroke-width="1.5"/>`;
  s += relayBox(relayX, bridgeY - 13, '60P', 'CT-Bridge');

  return s + '</svg>';
}

/* ── Public API ──────────────────────────────────────────── */
function renderDiagram(type, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = type === 'h-bridge' ? buildHBridgeReal() : buildYYUngroundReal();
}

window.renderDiagram = renderDiagram;
