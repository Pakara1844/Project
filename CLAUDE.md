# CLAUDE.md — EGAT C-Bank Optimizer

This file gives Claude Code the context it needs to work on this project safely.
Read it fully before making changes.

## What this is

A **single-page web tool** (Thai UI) for EGAT engineers to rebalance unbalanced
capacitor banks (C-Banks) on 69 kV / 115 kV / 230 kV substations. It computes the
neutral unbalance current **I_no** and suggests the fewest capacitor swaps that
bring I_no below the relay-alarm threshold. That threshold is now **set by the
field engineer per-substation** in the Step-2 `#alarmMA` input (default **50 mA**,
which is the named constant `ALARM_MA` at the top of `calculator.js`, exposed as
`window.ALARM_MA`). `getInputValues()` reads `#alarmMA` into the payload;
`clientCalculate` turns it into `THRESHOLD_MA` (falling back to `ALARM_MA` if blank)
and stores it on `engBefore.thresholdMA`. UI (`ui.js`, refreshed in `renderResults`)
and `formulas.js` read the threshold back from `engBefore.thresholdMA` so the
pass/fail line is consistent everywhere — never hard-code the number again, and keep
`ALARM_MA` as the single default. The threshold only drives pass/fail + swap-budget
selection; it NEVER changes the I_no calculation.

It runs **100% client-side** — no backend. It must work offline from a phone
(iOS Safari "Add to Home Screen") and from GitHub Pages.

## CRITICAL: the calculation must match the EGAT Excel exactly

The whole tool is worthless if I_no is wrong. The reference is the EGAT
spreadsheet `Double_wye_unground_CAP (RS-CAY21)`. Two rules that were hard-won
through debugging — **do not regress these**:

1. **Per-phase capacitance is a SERIES combination, not a parallel sum.**
   Within one phase the capacitor units are wired in series, so
   `C_phase = 1 / Σ(1/Cᵢ)`. Summing them (parallel) gives a value ~100× too
   large and makes I_no ~100× too big. See `calculator.js → calcYYMetrics →
   phaseC()`.

2. **I_no uses the complex-phasor method, NOT a worst-case magnitude sum.**
   Phase angles A=0°, B=−120°, C=+120°. The neutral displacement voltage and the
   wye-1 neutral current are computed as real/imaginary components, then the
   magnitude is taken. The exact formula chain (verified against Excel to 4 d.p.):

   ```
   Vph = Vs / √3                       (kV)
   Sk  = 2π·f·C_phase,k / 1e6          (siemens), wye-1 = S1,S2,S3 ; wye-2 = S4,S5,S6
   ΣS  = S1+...+S6
   Vnx = (1/ΣS)·Vph·[cos0·(S1+S4) + cos(−120°)·(S2+S5) + cos(120°)·(S3+S6)]
   Vny = (1/ΣS)·Vph·[sin0·(S1+S4) + sin(−120°)·(S2+S5) + sin(120°)·(S3+S6)]
   Vno = √(Vnx²+Vny²)·1000             (V)
   Inx = Vph·[S1cos0 + S2cos(−120°) + S3cos(120°)] − (S1+S2+S3)·Vnx
   Iny = Vph·[S1sin0 + S2sin(−120°) + S3sin(120°)] − (S1+S2+S3)·Vny
   Ino = √(Inx²+Iny²)·1e6              (mA)
   Qt  = Vph²·(S1+S4) + Vph²·(S2+S5) + Vph²·(S3+S6)   (Mvar)
   ```

   Known-good check at **Vs = 115 kV**, C≈2.72 µF/phase:
   `Vno = 71.3057 V`, `Ino = 33.1616 mA`, matching Excel.
   At **Vs = 69 kV** with single 9.5/14.3 µF caps: `Ino = 345.0149 mA`.

   If you change `calcYYMetrics`, re-run `npm test` (see below) and confirm both
   numbers still match before committing.

## Repo layout

```
project/
  CLAUDE.md            ← you are here
  README.md            human setup / deploy guide
  package.json         npm scripts (build, test, serve)
  build.js             bundles src/ → dist/ single-file HTML
  test/calc.test.js    asserts I_no matches Excel reference values
  src/
    _head.html         <head> markup (fonts, xlsx CDN) up to <style>
    _body_markup.html  <body> markup with NO <script> blocks (build injects them)
    styles/main.css    all CSS (dual light/dark theme)
    js/
      theme-init.js    runs in <head>, sets theme before paint
      calculator.js    ★ core math: calcYYMetrics, calcHBridgeMetrics,
                         findPhaseAwareYYSwaps (the swap optimizer)
      diagrams.js      SVG topology diagrams
      formulas.js      step-by-step formula breakdown shown in the UI
      ui.js            rendering helpers, engineering-value panels, sol cards
      template-xlsx.js base64 of the EGAT reference workbook (RS-CAY21), the
                         Excel export TEMPLATE (loads before exporter.js)
      exporter.js      Excel export — fills the embedded template via JSZip
                         (XML surgery, preserves all formatting; see below)
      app.js           wiring: input reading, event handlers, page nav,
                         clientCalculate() orchestration
  dist/
    egat-cbank.html    built single-file app
    index.html         identical copy, GitHub Pages entry point
  docs/                reference docs (formula write-up, Excel verification)
```

## The JS module model (important)

These are **plain scripts sharing globals**, not ES modules. `build.js`
concatenates them in a fixed order into `<script>` tags. There is no bundler,
no `import`/`export`. If you add a new file, register it in `build.js`
(`BODY_JS` array) in the right order. Cross-file references rely on functions
being hoisted into the shared global scope, so:

- Don't wrap a whole module in an IIFE unless you also expose what others need.
- `calculator.js` must load before `ui.js`, `formulas.js`, `app.js`.
- `app.js` loads last (it attaches event handlers and calls everything).

## Key functions to know

- `calcYYMetrics(y1, y2, systemKV)` — the reference calculation. `y1`/`y2` are
  arrays of `{id, val(µF), origin}` where origin ∈ {A,B,C} for wye-1 and
  {A',B',C'} for wye-2. Returns `{Ino_mA, Vno, Qt, S:{S1..S6}, perPhase, ...}`.
- `findPhaseAwareYYSwaps(y1, y2, spare, _, systemKV, lockedY1, lockedY2, nameplate, _mode, thresholdMA)`
  — the optimizer. `expand()` emits EVERY in-rack exchange — any of the 6 phases ↔
  any other, **same-side OR cross-side** (e.g. A'↔B' as well as A↔A') — plus spare
  replacements. Each candidate carries a **`cost`** = the rack distance of its
  exchanges (`RACK_ORDER` A A' B B' C C' = 0..5) plus `SWAP_SPARE_COST` (100) per
  spare. So the optimizer prefers the NEAREST swap and leaves a SPARE for last (see
  the swap-priority section). `_mode` is legacy/unused. Equal-valued swaps are
  skipped in `expand()` (no-ops → big speed win). Every candidate is scored by the
  *real* `calcYYMetrics` I_no + 6-phase spread. It runs
  **two complementary searches** and merges their visited states:
  1. **Beam search** — keeps the best `BEAM` partial solutions at each depth so it
     can pass *through* a temporarily-worse state. Finds the exact 2-swap optimum
     for small banks (it keeps *all* depth-1 states) plus good exchange/spare
     improvements. (The old single-step greedy got stuck — in ~24% of random banks
     NO single swap improved I_no but a *pair* did.)
  2. **Outlier-fix track** — some banks need a COORDINATED set of spare swaps where
     *every* intermediate step makes I_no worse before it collapses to ~0 (e.g. 3
     phases each with one off unit: fixing one at a time raises I_no, only fixing
     all three balances the bank). Beam prunes those rising paths, so this track
     greedily replaces the worst per-phase outlier (mode deviation) with the
     closest spare, **accepting temporary I_no rises**, recording each state.
  For each budget (2 / 4 / 6) it picks the lowest real I_no, then fewest swaps,
  then **most spares used** (deploy the spare pool when it reaches the same I_no).
  Reports `actualSwaps` and `sparesUsed`. Do NOT revert to beam-only — you will
  reintroduce the "doesn't use spares / collapses to 1 swap" bug.
- `clientCalculate(payload)` in app.js — orchestrates: reads inputs, splits
  swappable vs locked units, runs the optimizer, computes before/after metrics.

## Swap model rules (product decisions, don't silently change)

- **There is NO ÷2 anywhere.** Every slot is ONE unit whose value = the slot's
  combined (parallel) capacitance, and it enters `calcYYMetrics` as a single
  series element. `expandPairs` no longer splits anything into `.a`/`.b`.
  - Scissors (`isSplit`) slot: technician measured the pair separately → value =
    **`va + vb`** (parallel sum). `measuredA`/`measuredB` kept. Tier 1. A scissored
    slot is NEVER swapped as a whole unit — the optimizer rearranges its individual
    cap **pieces**: a piece can be replaced by a spare cap (`piece-replace`) or
    swapped with another scissored slot's piece (`piece-swap`, "สับกันเอง"). This
    is the only physically-valid repair for a parallel pair (you can't swap a whole
    ~54 µF pair for one 27 µF spare). See `expand()` in `findPhaseAwareYYSwaps`.
  - Non-scissors **parallel** slot (`isLocked`): value = the entered number as-is
    (the combined reading). Tier 2 (swapped only as a fallback), one unit.
  - Non-parallel slot: value = entered number. Tier 1.
- The side-level "ต่อขนาน" checkbox no longer does any math — it only (a) marks
  that side's plain slots as locked/Tier-2 and (b) reveals the per-slot "scissors"
  toggle. The "scissors" toggle still only appears when "ต่อขนาน" is on.
- **Tier 1** swap pool = units the technician marked + spares. **Tier 2**
  (fallback) brings in the grouped units, swapped **individually** (not as pairs).
  **EXCEPTION:** if *any* slot uses scissors (`isSplit`), the Tier-2 fallback is
  **disabled** — the optimizer swaps ONLY the measured-separately units + spares
  and never touches the grouped units, even if I_no stays above the threshold.
  (`hasScissors` in `clientCalculate`, both YY and H-bridge paths.)
- **Swap priority = PHYSICAL RACK DISTANCE, spare LAST** (product decision, v7.9).
  The rack is wired left→right **A A' B B' C C'** (`RACK_ORDER`). The technician's
  effort grows with how far apart two caps sit, so the optimizer rearranges the
  rack with the NEAREST swap first (a bad A' is fixed from A or B before C') and
  only fetches a SPARE when rack rearrangement can't reach the goal. This is
  expressed as a per-candidate **`cost`** (rack distance for an exchange,
  `SWAP_SPARE_COST`=100 for a spare) — see `swapActionCost`. Two levels:
  - **L0** — Tier-1 units, all in-rack exchanges + spares (`cost` orders near→far→spare).
  - **L1** — + grouped Tier-2 units, fallback (skipped when scissors used).
  `better()` (per-budget pick) and `chooseBudget()` (across L0/L1) both apply:
  **relay-pass gate → phase-balance (spreadOK/spread) → lowest `cost` (nearest swaps,
  spare-last) → lowest I_no → fewest swaps → fewest grouped touched**. If nothing
  passes the relay, lowest I_no wins (closest to safe), then lowest cost.
  - **Nameplate** (`NAMEPLATE_UF = 27.00 µF`, `window.NAMEPLATE_UF`): a unit below
    it is "failed" (เสีย). Failed units are NO LONGER removed-first — they're moved
    in-rack like any other, and a spare is fetched only if the rack can't balance
    (a single failed cap can't be fixed by rearrangement, so a spare IS used there).
    Nameplate is now **display-only** (badge + note). `isFailedUnit` still drives the
    "🔧 พบ N ตัวเสีย" note. For scissored slots it checks the measured pieces.
  Still swap-priority + display only — it NEVER changes the I_no calculation.
  (H-bridge path keeps the simpler optimizer.)
- **Phase-balance goal — the PRIMARY swap objective** (`PHASE_SPREAD_UF = 0.005 µF`,
  top of `calculator.js`, `window.PHASE_SPREAD_UF`, YY only). "Balance the phases at
  the star point": after swapping, ALL SIX per-phase SERIES capacitances (A,B,C on
  Y1 + A',B',C' on Y2) should sit within the tolerance of each other.
  **Sizing matters:** measured on a real bank (115 kV, 10 caps in series/phase →
  C_phase ≈ 2.72 µF), ΔC maps to I_no at ≈ **0.001 µF per 10.5 mA**. The original
  0.1 µF would have allowed I_no ≈ 1050 mA — the badge passed while the relay
  tripped. 0.005 µF ≈ 52 mA, matching the default 50 mA alarm. If you change the
  tolerance, keep it in the same order as the alarm. `phaseSpreadOf(metrics)`
  reads `perPhase.X.C1`/`.C2` and returns `{y1,y2,all,max,ok}` where `all` (=`max`)
  is the max−min across all six phases and `y1`/`y2` are the per-side spreads (for
  display). The optimizer's PRIMARY objective is to minimize this 6-phase spread,
  **subject to the relay passing** (I_no < threshold) as a hard gate — "บาลานซ์เฟส
  เป็นหลัก + I_no ต้องผ่านรีเลย์ด้วย". This is threaded all the way into the search:
  - `metricsOf()` returns `{ino, spread}` from ONE `calcYYMetrics` call (no extra cost).
  - The beam frontier is MULTI-OBJECTIVE: it keeps the tightest-spread states AND a
    half-beam of lowest-I_no states, so a relay-passing arrangement is never pruned
    while chasing balance.
  - `better()` (per-budget pick) and `chooseBudget()` (across P1–P4) both apply:
    failed-out → **relay-pass gate** → lowest spread (balance) among passers →
    lowest I_no → least disruptive. If nothing passes the relay, lowest I_no wins
    (closest to safe). `findPhaseAwareYYSwaps` takes the threshold as its last arg.
  Still NEVER changes the I_no calculation itself. Shown as a "ΔC เฟส" badge on each
  solution card + a "บาลานซ์เฟส" line on the summary banner.
- Quick Mode = auto-pick the fewest swaps that reach the best balance / lowest I_no.
  The 2 / 4 / 6 cards are explicit fixed-budget options for the field worker.

## Excel export (template-based, `exporter.js`)

Export fills the **actual EGAT reference workbook** (`Double wye unground CAP
(RS-CAY21)`) so the output looks byte-identical to the field form. The template is
embedded as base64 in `template-xlsx.js` (`EGAT_TEMPLATE_B64`). **We do NOT
round-trip through SheetJS** — its community build drops cell fills/borders on
write (verified). Instead we do **XML surgery with JSZip** (loaded from CDN like
xlsx): unzip, string-patch only the input cells' `<v>` values in the raw
`xl/worksheets/sheetN.xml`, re-zip (DEFLATE). Everything we don't touch —
formatting, merges, drawings, formulas — is preserved verbatim.
- **6 output sheets** = the template's 3 (C-Bank Arrangement, Farad Measurement,
  Volt-Amp Measurement) with BEFORE data, then 3 clones ("… หลังสับ") with the
  recommended-swap AFTER data. The clones (`sheet4/5/6.xml`) copy the source sheet
  **and its drawing** (`drawing4/5/6.xml`) verbatim, retarget the sheet rels, and are
  registered in `[Content_Types].xml` + `workbook.xml.rels` + `workbook.xml`.
  **Do NOT rename the first 3 sheets** — Farad/Volt-Amp formulas cross-reference
  `'C-Bank Arrangement '!…` by name; renaming breaks them.
- Per-sheet input cells (formulas untouched): **C-Bank** grid VS→X3, each phase's
  series slots → first parallel column (A→B, B→R, C→AH, A'→J, B'→Z, C'→AP), rows
  9,11,…,29 (11 max → overflow alert); unused rows = 0. **Farad** VS→X4, per-phase
  series C on row 17 (C=A,S=B,AI=C,K=A',AA=B',AQ=C'). **Volt-Amp** VS→X4, same cols
  row 11 = V (VS·1000/√3), row 17 = I (ωC·V).
- **We KEEP every formula AND its cached value** (never blank) and force a full
  recompute on open via **`<calcPr calcId="0" fullCalcOnLoad="1"/>`** — a plain
  `fullCalcOnLoad` with the original `calcId` did NOT recalc in the field (cells
  came up blank when caches were cleared). Cached values shown until Excel recalcs
  are the template's example (115 kV/27.2 → Ino 33.16); Excel recomputes to the
  real inputs on open. The template formulas are the same phasor method as
  `calcYYMetrics` (Excel-verified).
- H-bridge falls back to a simple SheetJS sheet (`exportSimple`) — the template is
  Y-Y only.
- **Not verifiable from CI/headless:** that Excel opens the file without a "repair"
  prompt. All structural checks (valid zip, well-formed XML, parts registered) pass;
  confirm by opening a real export if you touch this.

## Build / test / run

```bash
npm install        # one-time (only dev deps; app itself has none)
npm run build      # src/ → dist/egat-cbank.html + dist/index.html
npm test           # verifies I_no matches Excel reference values
npm run serve      # local static server on http://localhost:8080 (serves dist/)
```

Deploy = copy `dist/index.html` to the GitHub Pages repo root.

## Gotchas that already bit us

- **Cross-block variable scope.** `F_HZ` was declared in one `<script>` block but
  used in `calcYYMetrics` in another → `F_HZ is not defined`. Calculator now uses
  the locally-declared `PI2F`. Keep each block self-sufficient for its globals,
  or declare shared constants in a block that loads first.
- **GitHub Pages caching.** After deploy the old file is served for a while;
  hard-refresh (Ctrl+Shift+R). The version badge (top-right, e.g. `v5.4`) is the
  quickest way to confirm which build is live — bump it in
  `src/_body_markup.html` when you ship.
- **iOS Files-app sandbox.** Avoid `position:sticky` + `backdrop-filter`
  combinations and inline `onclick` that needs cross-origin; these broke before.

## When changing the math, always

1. Edit `src/js/calculator.js`.
2. `npm test` — both reference numbers must still pass.
3. `npm run build`.
4. Bump the version badge.
