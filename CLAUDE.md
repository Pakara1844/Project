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
    styles/main.css    all CSS (dual light/dark theme) — the authoritative design system
    styles/tailwind.css Tailwind v4 entry (utilities + theme only, NO Preflight);
                         build.js compiles it via @tailwindcss/cli and inlines the
                         result ahead of main.css (see below)
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
  — the optimizer. **v9.4 = the v6.5 logic restored** (field decision 2026-11: v6.5
  tested best in the field). `expand()` emits **in-phase exchanges only** (A↔A',
  B↔B', C↔C' — a capacitor never leaves its phase) plus spare replacements and the
  scissored piece moves. Equal-valued swaps are skipped (no-ops). Every candidate is
  scored by the *real* `calcYYMetrics` I_no. Two complementary searches, merged:
  1. **Beam search** — keeps the best `BEAM` partial solutions at each depth so it
     can pass *through* a temporarily-worse state. Finds the exact 2-swap optimum
     for small banks (it keeps *all* depth-1 states). (The old single-step greedy
     got stuck — in ~24% of random banks NO single swap improved I_no but a *pair* did.)
  2. **Outlier-fix track** — some banks need a COORDINATED set of spare swaps where
     *every* intermediate step makes I_no worse before it collapses to ~0. Beam
     prunes those rising paths, so this track greedily replaces the worst per-phase
     outlier (failed first, then mode deviation) with the closest spare,
     **accepting temporary I_no rises**, recording each state.
  Budgets **2 / 4 / 6**. Per budget, `better()` ranks: **failed (<nameplate) units
  left installed (fewest) → lowest I_no (a tie within `INO_TIE_MA` = 2 mA when BOTH
  plans pass the relay) → FEWEST spares → fewest swaps → lowest I_no**. Reports
  `actualSwaps`, `sparesUsed`, `acts`. Do NOT revert to beam-only — you will
  reintroduce the "doesn't use spares / collapses to 1 swap" bug.
  `sparesUsed` counts ONLY spare-consuming actions (`replace-y1`/`replace-y2`/
  `piece-replace` — the set `SPARE_ACTION_TYPES`); `piece-swap` and `exchange` use
  no spare and must not inflate it. NOTE: a "replace" can re-use a unit that was
  pulled out earlier (it sits in the spare pool), so `sparesUsed` may exceed the
  number of spares entered — that is v6.5's "use the least-bad removed unit as a
  temporary replacement when good spares run out".
  (v7.x–v9.3 used a different optimizer — cross-phase rack exchanges, rack-distance
  `cost`, phase-balance gate, Track 3, budgets 2/6/12, `minSpare`. Recoverable from
  git: commit `bdb9cc8` = v9.3.)
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
- **Swap priority (v9.4 = v6.5 restored, + 2 changes)** — field decision 2026-11.
  - **Nameplate-failure first** (`NAMEPLATE_UF = 27.00 µF`): a unit reading below
    nameplate is "failed" (เสีย) and is taken OUT FIRST; units ≥ nameplate are
    "good" and kept in place unless needed. `clientCalculate` runs levels and, per
    budget, picks the LEAST-disruptive level that meets the threshold ("ผ่านแล้วหยุด"):
    - **L0** — swap failed Tier-1 units only (good + grouped locked).
    - **L1** — swap all Tier-1 units (grouped locked) — only if L0 can't do it.
    - **L2** — also swap grouped Tier-2 units — only if L1 can't AND no scissors.
    `chooseBudget()` order: **fewest failed left → passes threshold → lowest level →
    fewest spares → fewest swaps → lowest I_no**. For scissored slots "failed"
    checks the measured pieces (`measuredA`/`measuredB`).
  - **Change 1 vs v6.5 — threshold is selectable.** The relay threshold is the
    Step-2 bubble value (`THRESHOLD_MA`, 5–50 mA), not a fixed 50 mA.
  - **Change 2 vs v6.5 — spare conservation.** v6.5 picked the plan using the MOST
    spares at equal I_no; v9.4 picks the FEWEST, and when both plans pass the
    relay it treats I_no within `INO_TIE_MA` (2 mA) as a tie. Guarded by
    `test/swap.test.js` Case 7 (in-phase fix → 0 spares) and Case 8 (adding spares
    must not increase spare use). Do NOT flip it back to "most spares".
  - **Known trade-off (faithful to v6.5):** "failed out first" outranks passing the
    relay. On a bank with MORE failed units than the budget can both remove and
    rebalance, a bigger spare pool can lead to a plan that removes more failed units
    but ends ABOVE the threshold (it shows "ยังไม่ผ่าน"). Raise the budget or review.
  It NEVER changes the I_no calculation. (H-bridge path keeps its simpler optimizer.)
- **Phase balance (`PHASE_SPREAD_UF = 0.005 µF`) is DISPLAY ONLY in v9.4.** The
  within-wye series spread (A=B=C on Y1, A'=B'=C' on Y2, via `phaseSpreadOf()` on
  the per-phase SERIES C) is still computed and shown as the "ΔC เฟส" badge + the
  summary-banner line, but the restored optimizer does not rank by it. (I_no = 0
  needs only within-wye balance; the two wyes need not match.)
- Quick Mode = auto-pick the fewest swaps that passes the threshold (else the knee /
  lowest I_no). The 2 / 4 / 6 cards are explicit fixed-budget options.

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

## Styling — Tailwind v4 + the design system

`main.css` is the **authoritative design system** (tokens, components, dual
light/dark theme). Tailwind is layered in **additively** for utility classes:

- Source of truth for utilities: `src/styles/tailwind.css`. It imports only the
  Tailwind **theme + utilities** layers — **Preflight (Tailwind's reset) is
  deliberately omitted** so it does NOT wipe main.css's base styles. It also maps
  the existing CSS-var tokens to Tailwind colors (`bg-surface`, `text-ink2`,
  `border-line`, …) and wires the `dark:` variant to the app's
  `[data-theme="dark"]` attribute (not media / `.dark`).
- `build.js` compiles it with `@tailwindcss/cli` (run via `node`, no network, no
  CDN — offline build stays intact) and inlines the purged result in a
  `<style id="tw">` **before** `<style id="app">` (main.css).
- **Cascade caveat:** Tailwind utilities live in `@layer utilities`; main.css is
  unlayered, and **unlayered CSS beats layered CSS**. So a utility will NOT
  override a component rule that sets the *same* property — add utilities to
  elements/props main.css doesn't already style, or use the `!` important
  modifier (e.g. `p-6!`) when you must win. For broad visual changes, prefer
  editing main.css.
- Dev deps `tailwindcss` + `@tailwindcss/cli` are required now — run
  `npm install` before `npm run build`.

## Build / test / run

```bash
npm install        # one-time (dev deps: tailwindcss, @tailwindcss/cli, test runner)
npm run build      # compiles Tailwind + bundles src/ → dist/*.html + root index.html
npm test           # verifies I_no matches Excel reference values + swap optimizer
npm run serve      # local static server on http://localhost:8080 (serves dist/)
```

Deploy = copy `dist/index.html` to the GitHub Pages repo root.

## Gotchas that already bit us

- **Cross-block variable scope.** `F_HZ` was declared in one `<script>` block but
  used in `calcYYMetrics` in another → `F_HZ is not defined`. Calculator now uses
  the locally-declared `PI2F`. Keep each block self-sufficient for its globals,
  or declare shared constants in a block that loads first.
- **Top-level `const` collides ACROSS `<script>` blocks.** Each `src/js/*.js`
  becomes its own classic `<script>`, but top-level `const`/`let` share ONE global
  lexical scope — so the same name declared in two files throws `Identifier '…' has
  already been declared`, which aborts the *entire* second block. This bit us: both
  `calculator.js` and `formulas.js` declared `const PI2F`, silently killing
  `formulas.js` (the formula view). Fixed by renaming the formulas.js copy to
  `PI2F_F`. When two blocks need the same constant, give them distinct names (or
  reference the one from the earlier-loaded block).
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
