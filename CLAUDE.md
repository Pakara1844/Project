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
  tested best in the field). `expand()` emits **exchanges between ANY two positions**
  — in-phase (A↔A'), same-side cross-phase (A↔B↔C / A'↔B'↔C', v9.6 F5) and
  cross-side cross-phase (A↔B', v9.8) — plus spare replacements and the scissored
  piece moves. **Move-once (v9.8):** `reps(arr, true, movedIds)` skips units this plan
  already moved, so each physical unit is moved AT MOST ONCE (v9.7 could reach A↔B'
  only through a 3-step detour via A/A', shuffling equal 27 µF units for nothing —
  field bank #3, Cases 18–19). Failed units are never moved (v9.7). In-phase swaps
  can only MIRROR an imbalance across the wyes; same-side/cross-side swaps or spares
  are what balance a wye. **Value-dedup (v9.6):** `reps()` evaluates ONE unit per
  distinct value per phase (and per distinct good spare value), and `sig()` sorts each
  phase's values (multiset) — equal-valued units give identical arrangements. This cut
  a 10-units/phase bank from ~24 s to ~1.6 s; do not remove it. Every candidate is
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
  Budgets **2 / 4 / 6** at the default depth (`BASE_DEPTH` 6); the legacy `swapMode`
  arg now carries options `{ maxDepth }` — with a deeper search (`EXT_DEPTH` 12) a 4th
  budget = maxDepth is added (F2). The beam frontier (F4) keeps half by (failed left,
  overvoltage, I_no) and half by I_no, so failed-removal paths whose I_no rises for now
  are not pruned. Per budget, `better()` ranks (v9.7): **failed (out-of-tolerance)
  units left installed (fewest) → LEAST SEVERE failed left (`sev` = worst relative
  deviation; G1) → units over 110 % rated voltage (fewest) → passes the I_no ref →
  if passing: WITHIN-SIDE BALANCED first (`spread` ≤ `PHASE_SPREAD_UF`; if neither,
  the tighter spread beyond `SPREAD_TIE_UF` 0.001 µF) → fewest spares → fewest swaps
  → lowest I_no; if not passing: lowest I_no → spares → swaps**. Exchanges NEVER move
  a failed unit (`reps(arr, true)`; failed pieces never piece-swapped) — a failed
  unit is replaced by a spare or stays put (user decision v9.7). The beam keeps
  thirds: (failed, sev, ov), within-side spread, and I_no. It also returns `refPlans` (least
  effort per I_no ref) and `minBelow` (v9.5). Reports
  `actualSwaps`, `sparesUsed`, `acts`. Do NOT revert to beam-only — you will
  reintroduce the "doesn't use spares / collapses to 1 swap" bug.
  `sparesUsed` counts ONLY spare-consuming actions (`replace-y1`/`replace-y2`/
  `piece-replace` — the set `SPARE_ACTION_TYPES`); `piece-swap` and `exchange` use
  no spare and must not inflate it. NOTE: a "replace" can re-use a GOOD unit that was
  pulled out earlier (it sits in the spare pool), so `sparesUsed` may exceed the
  number of spares entered. Failed (out-of-tolerance) units are NEVER re-used (v9.5).
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
- **Swap priority (v9.4 = v6.5 restored + changes; v9.5 safety rules)** — field
  decisions 2026-11. Research basis: `docs/swap-priority-research.md`.
  - **Failed first — FAILED = outside the tolerance band, either side (v9.5).** The
    Step-2 "พิกัดตัวเก็บประจุ" inputs give rated C (default `NAMEPLATE_UF` 27.00 µF)
    and a band (default **−5 % / +10 %**, `TOL_MINUS_PCT`/`TOL_PLUS_PCT` = IEC
    60871-1:2005 §7.2 unit tolerance, identical IS 13925-1:2012). Below = lost
    elements, above = shorted elements. Helpers: `capSpecOf()`, `capValOutOfTol()`,
    `unitOutOfTolerance()` (scissored → checks each measured piece). Failed units are
    taken OUT FIRST. `clientCalculate` runs levels and, per budget, picks the
    LEAST-disruptive level that meets the threshold ("ผ่านแล้วหยุด"):
    - **L0** — swap failed Tier-1 units only (good + grouped locked).
    - **L1** — swap all Tier-1 units (grouped locked) — only if L0 can't do it.
    - **L2** — also swap grouped Tier-2 units — only if L1 can't AND no scissors.
    `chooseBudget()` order: **fewest failed left → no overvoltage → passes threshold
    → lowest level → fewest spares → fewest swaps → lowest I_no**.
  - **Never reinstall a failed unit (v9.5).** Out-of-tolerance spares — and units
    pulled out earlier, which sit in the spare pool — are skipped by every
    replacement path (`goodSpare` in `expand()` + outlier-fix). v6.5 reused "the
    least-bad removed unit" when good spares ran out; that is gone. If good spares
    run out, failed units stay installed and the note says "⛔ spare ดีไม่พอ … ต้องหา
    spare เพิ่ม". (A removed GOOD unit may still be re-used elsewhere.)
  - **110 % overvoltage gate (v9.5, IEEE 18).** Optional "แรงดันพิกัด (kV)" input.
    `unitVoltageStats()` splits Vph across each series string (V_i ∝ 1/C_i, neutral
    shift ignored). With a rating entered, a candidate's `ov` (units > `UNIT_OV_LIMIT`
    1.10 × rated) ranks right after failed-left in `better()` and `chooseBudget()`.
    This catches EQUALIZED failures that I_no cannot see (e.g. A1 = A'1 = 26.0 µF:
    I_no = 0 but 111.5 % of a 6.2 kV rating — `test/swap.test.js` Case 12). Every
    plan card shows "V ตัวสูงสุด" (% of rated, or % of string average if no rating).
  - **Threshold is selectable (vs v6.5).** The Step-2 bubble = the I_no **ref**
    (`THRESHOLD_MA`, 5–50 mA); the relay CT itself is ≤ 50 mA.
  - **Spare conservation (vs v6.5).** Fewest spares among equally-good plans (v6.5:
    MOST). Since v9.7 the order among passing plans is balance → spares → swaps →
    I_no, so `INO_TIE_MA` is no longer used by the ranking (constant kept, legacy).
    Guarded by Cases 7/8.
  - **I_no ref comparison (v9.5).** `findPhaseAwareYYSwaps` returns `refPlans[r]` for
    every r in `INO_REF_LIST` (5…50): the least-effort candidate (fewest swaps, then
    spares, then I_no) with failed-left = the minimum achievable, no overvoltage and
    I_no < r. `clientCalculate` merges levels into `quickResult.refTable` and marks
    `leastWork` (🛠 cheapest) and `bestValue` (⭐ the extra-effort plan with the most
    mA saved per extra swap, if ≥ `INO_WORTH_MA_PER_SWAP` = 5 mA/swap — engineering
    judgement, not a standard; else the cheapest). UI: `buildRefTable()` in ui.js with
    a "ใช้ค่านี้" button (`useInoRef(r)` re-runs with that ref). Guarded by Case 11.
  - **Benchmark (v9.4 → v9.5, 200 random banks, ref 50):** pass 66 % → 85 %, failed
    left in plan 22 → 16, failed units reinstalled 5 → 0; where both pass, swaps
    same/fewer in 126/130 (the 4 "more" = removing a high-C unit v9.4 called good, or
    not reusing a failed unit — the intended safety cost).
  - **v9.6 fixes (from a field bank: 5 failed in B + over-capacitive A', 10 spares —
    v9.5 recommended 4 swaps @ 256 mA with a failed unit still in):**
    - **F1** `chooseBudget`: when NOTHING passes, rank **lowest I_no** first (then
      spares → swaps → level). "Least-disruptive level" applies only among passing
      plans (v6.5 put level first, so an L0 plan at 307 mA beat L1 at 188 mA).
    - **F2** adaptive depth: if no budget passes, or failed units remain while good
      spares are left, `clientCalculate` re-runs `buildLevels(EXT_DEPTH)`;
      `quickResult.extended`/`maxDepth`; UI shows a "สูงสุด N ครั้ง (ค้นหาเพิ่ม)" card.
    - **F3** recommendation (ui.js): uses the ref-table plan for the SELECTED ref
      (least work) when it exists; otherwise the budget cards, but never a plan that
      leaves more failed units / overvoltage than another option. The chosen plan is
      `quickResult.recommended`, and **Excel export uses exactly it**. If nothing
      passes, the banner says so ("⛔ … ต้องเพิ่ม spare"). The banner hint follows the
      ⭐ rule so banner and table never contradict.
    - **F4** two-objective beam (see optimizer bullet). **F5** same-side swaps.
    - Result on that bank (69 kV): recommended 7 swaps/5 spares → 23.4 mA; ⭐ 8 swaps
      → 8.1 mA; deepest 9 swaps → 4.45 mA; all failed out; guarded by Cases 13–14.
    - (v9.6 note on budget cards showing MIRROR plans is superseded by v9.7
      balance-first ranking — budget cards now prefer within-side balance too.)
  - **v9.8 — spares-only recommendation (#4).** If NOTHING passes even after the deep
    search AND failed units > good spares, `clientCalculate` builds
    `quickResult.sparesOnly`: replace the WORST failed units with the good spares on
    hand (closest-to-rated spare first), no exchanges; `sparesShort` = failed − good
    spares, `failedTotal`. ui.js then recommends ONLY that plan ("เปลี่ยนตัวเสียหนัก
    สุด N ตัว … ต้องหา spare ดีเพิ่มอีก M ตัว") and tells the field NOT to shuffle the
    rack now (it must be re-arranged when spares arrive). The full best-effort plan
    stays visible in the budget cards. Excel exports the spares-only plan. Scissored
    pairs are left to the full plan (piece-level). Guarded by Case 17 (bank #3: 11
    failed / 4 spares → replace 19, 21, 21, 22; 7 more spares needed).
  - **v9.9 — TEMPORARY plan on spare shortage (supersedes the v9.8 spares-only
    recommendation when it exists).** Field decision: time on site is limited and the
    bank must go back in service now. If failed units > good spares AND no normal plan
    is passing + balanced, `clientCalculate` runs one more pass with
    `{ moveFailed: true }` at `TEMP_DEPTH` 16: spares still replace the WORST failed
    units first, but the remaining failed units MAY be moved (still once each) to
    spread their deficit so A=B=C per side. In this mode `better()` ranks failed →
    sev → pass → balance → I_no → overvoltage → spares → swaps (overvoltage is
    reported, not gating). Result = `quickResult.tempPlan` (`tempMove`,
    `movedFailed`); ui.js recommends it ("แนะนำ (จัดชั่วคราว — spare ไม่พอ)") with
    the max unit-voltage warning + spares still needed; Excel exports it. The normal
    budget cards / ref table keep the never-move-failed rule. F2 extension depth is now
    `min(16, max(EXT_DEPTH, min(failed, good spares) + 4))`. Guarded by Case 20 (bank #4,
    115 kV, 14 failed / 4 spares → 10 swaps, 26 mA, ΔC ≤ 0.0095; was 2176+ mA).
  - **v10.0 — field-style balance target + spare priority (from field bank SNO-CAY5).**
    - Step 2 `#balSumUF` = max difference of the per-rack SUM ΣC within a wye (field
      sheet practice, UI default **0.1 µF**). `clientCalculate` converts it to the
      series tolerance `BAL_TOL_UF = ΣC_tol / n²` (n = avg units per phase; first-order
      exact) — every balance check (`phaseSpreadOf` default, `better()`, `balOf`, ref
      table) now uses `BAL_TOL_UF`, not `PHASE_SPREAD_UF`. Callers that pass nothing
      (tests) get `BAL_SUM_DEFAULT` 0.5 µF ≈ the old 0.005 µF at 10/phase.
    - Step 2 `#sparePriority`: **`balance`** (UI default, the field way) or `failed`
      (v9.7 worst-failed-first; also the engine default when the arg is absent).
      Balance-first ranking (`BAL_FIRST`): balanced (worse side ≤ tol) → worse-side
      spread → passes I_no → failed left → sev → overvoltage → I_no → better-side spread
      (passing plans only) → spares → swaps. The better-side spread is deliberately a
      LATE tie-break: balancing one side while the other is still off can RAISE I_no
      (their imbalances were partly cancelling — the field's own SNO-CAY5 plan balanced
      Y1 to 0.0016 µF and I_no went 1602 → 2182 mA because Y2 A' is 0.31 µF low).
    - **Bug A fixed:** a grouped parallel slot (`isLocked`, ~54 µF) is judged per unit
      (`val / parallelCountOf()`); before, all 20 such slots counted as failed
      ("30 failed, need 27 spares" → correct 10 / 7). `unitDevOf()` likewise.
    - **Bug B fixed:** move-once now covers scissored PIECE positions (`id.a`/`id.b`) —
      a piece position is changed at most once (C'-10.a used to move 3×). A pulled-out
      piece enters the spare pool under its OWN id (`pulledPiece`), not the spare's.
    - **Display:** plan cards list units in RACK order (`slotOrder()`), and a scissored
      slot shows its two pieces, each with "← อะไหล่ S-2 / ชิ้นจาก B'-10.a (เดิม x)"
      and its swap number (`pairRow`, `pieceHistory` in ui.js). Step text names the
      pair, the piece and the new pair totals. Guarded by Case 21.
  - **Display (v9.6):** the "ก่อนสับเปลี่ยน" card (YY) no longer shows Σ Y1 / Σ Y2 /
    |ΣY1−ΣY2| (that difference does NOT drive I_no — two balanced wyes can differ);
    it shows ΔC within Y1, ΔC within Y2, per-phase total ratio max/min (IEC ≤ 1.08)
    and V_no. Plan cards (`buildSolEng`) show ΔC within Y1·Y2, I_no, **V_no**, Q, and
    the per-phase ratio. H-bridge keeps the old Σ rows.
  It NEVER changes the I_no calculation. (H-bridge path keeps its simpler optimizer;
  its failed badges use the same tolerance band.)
- **Within-side balance (`PHASE_SPREAD_UF = 0.005 µF`) — a RANKING OBJECTIVE again
  since v9.7** (user: "บาลานซ์ A B C ของแต่ละฝั่ง", "บาลานซ์ก่อน แรงงานทีหลัง"). The
  within-wye series spread (A=B=C on Y1, A'=B'=C' on Y2, via `phaseSpreadOf()` on the
  per-phase SERIES C) is computed per candidate in `record()`. Why it matters: I_no
  only sees the DIFFERENCE between the wyes, so two wyes off in the same way MIRROR
  each other (I_no ≈ 0 while each wye is unbalanced and weak units stay stressed).
  In-phase swaps can only mirror; balancing a wye needs same-side swaps or spares.
  v9.7 also re-searches deeper (F2) when the best plan isn't balanced, and the UI
  warns "⚠ I_no ผ่านเพราะสองฝั่งเพี้ยนคล้ายกันจนหักล้างกัน" + "🧰 ต้องหา spare ดีเพิ่ม
  อีก N ตัว" (G2). The ref table has a "บาลานซ์ในฝั่ง" column. refPlans pick balanced
  plans first (else the tightest spread ± `SPREAD_TIE_UF`), then least work.
  Field bank #2 (C and C' both damaged, 8 failed): 5 spares → keeps only 24/25/25 µF,
  ΔC 0.010 per wye (needs 3 more spares); 8 spares → all out, ΔC 0.002 (Cases 15–16).
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
