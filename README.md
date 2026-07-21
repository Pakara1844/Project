# EGAT C-Bank Optimizer

เครื่องมือช่วยปรับสมดุล Capacitor Bank แบบ Ungrounded Double-Wye ของ กฟผ.
คำนวณกระแสไม่สมดุลที่นิวทรัล (I_no) ด้วยวิธีเฟสเซอร์เชิงซ้อน และแนะนำการสับเปลี่ยน
ตัวเก็บประจุที่ใช้จำนวนครั้งน้อยที่สุดเพื่อให้ I_no ต่ำกว่าเกณฑ์ alarm 5 mA

A client-side web tool for rebalancing EGAT's ungrounded double-wye capacitor
banks. Runs entirely in the browser — works offline and from GitHub Pages.

> **Working on the code with Claude Code? Read [`CLAUDE.md`](./CLAUDE.md) first.**
> It documents the calculation model, the module layout, and the regressions to
> avoid. The math must stay matched to the EGAT reference spreadsheet.

## Quick start

```bash
npm install      # installs dev tooling only (the app has no runtime deps)
npm test         # verify the I_no calculation matches the EGAT Excel
npm run build    # bundle src/ into dist/egat-cbank.html (+ dist/index.html)
npm run serve    # build, then serve dist/ at http://localhost:8080
```

Then open `dist/egat-cbank.html` in a browser, or visit the served URL.

## How it works

1. **Topology** — choose Y-Y Ungrounded (or H-Bridge).
2. **Setup** — enter system voltage Vs (kV) and the measured capacitance of each
   unit per phase, per wye. Mark parallel sides and split-measured units.
3. **Results** — see I_no before/after, the step-by-step phasor calculation, and
   swap plans (auto / 2 / 4 / 6 swaps) that minimize I_no.

The core calculation is the complex-phasor method, verified against the EGAT
spreadsheet `Double_wye_unground_CAP (RS-CAY21)`:

- `Vs = 115 kV`, C ≈ 2.72 µF/phase → **I_no = 33.1616 mA**, Vno = 71.3057 V
- `Vs = 69 kV`, single 9.5/14.3 µF caps → **I_no = 345.0149 mA**

Per-phase capacitance is a **series** combination `C = 1/Σ(1/Cᵢ)` (the units in a
phase are wired in series), not a parallel sum. See `CLAUDE.md` for the full
formula chain.

## Project layout

```
src/        editable source — CSS, JS modules, HTML markup
build.js    bundles src/ → dist/ single-file HTML
test/       calculation regression tests
dist/       built output (index.html is the GitHub Pages entry point)
docs/       formula write-up & Excel verification
```

The JS files are plain scripts sharing globals (no bundler / ES modules). Edit
files under `src/`, then `npm run build`. Order is defined in `build.js`.

## Deploy to GitHub Pages

1. `npm run build`
2. Copy `dist/index.html` to the root of your Pages repo (or push `dist/`).
3. In repo Settings → Pages, serve from that branch/folder.
4. After deploy, hard-refresh (Ctrl+Shift+R). Confirm the version badge
   (top-right) shows the build you expect — Pages caches aggressively.

On a phone: open the Pages URL in Safari → Share → Add to Home Screen for an
offline-capable app icon.

## Notes

- No backend, no network calls except CDN fonts/icons and the XLSX library
  (used for the Excel export). It still loads and calculates offline.
- Tested on iOS Safari and Android Chrome.
