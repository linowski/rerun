# Rerun - Experiment Analysis Dashboard

## Project Overview
A browser-based experimentation dashboard that analyzes A/B test results from multiple platforms. No build system — vanilla HTML/CSS/JS served directly.

## Architecture

### Two-Layer Data Model
1. **Default JSON** (`data.json`) — Dummy/fallback experiment data in the standardized format. Used when no API or CSV import is available.
2. **Mapper bindings** (`mappers/`) — Each experimentation platform has a mapper that transforms its API/CSV response into the standardized format. All mappers produce objects with the same shape.

### Standardized Experiment Object Shape
```js
{
  name, id, primaryMetric, primaryMetricLabel, primaryMetricType,  // "binary" | "continuous"
  secondaryMetric, secondaryMetricLabel, secondaryMetricType,
  sampleSize, baseRate, triggered, traffic, owner,
  trafficSubtitle,  // produced by mappers but not currently displayed
  ownerEmail,  // optional: when `owner` is a name read from an email (Amplitude, via `MapperUtils.nameFromEmail`), the email for the tooltip and search
  cuped,       // optional: true when the platform's analysis used CUPED (Amplitude analysisParams, PostHog stats_config.cuped); As reported shows a small "CUPED" note under its p-value
  primaryCV, secondaryCV,  // continuous metrics: the control arm's SD / mean, needed for any recalculated p-value or power (without it: none, and the test is left out of Testing Sensitivity). Amplitude: arm variance; PostHog: sum of squares; GrowthBook: result stddev
  secondaryBaseRate,  // optional: a binary secondary's own control rate % (else the primary's baseRate is used); PostHog, GrowthBook, data.json (made up). A baseRate of 0 (control had no conversions) gives no recalculated p-value or power, not a 5% stand-in
  pvalueMissingReason, secondaryPvalueMissingReason,  // optional: why the platform gave no p-value (PostHog validation failures), shown in the estimate's tooltip
  reachLabel, reachNote,  // optional: what `traffic` is out of (default "of traffic"; PostHog: "of site visitors" or "rollout") and its tooltip
  url, change, decision,     // optional: platform link, what the variation did, "Shipped" | "Not Shipped"
  preregisteredSampleSize,   // optional; fixed-horizon tests without one get a "No prereg" flag
  iterations,                // optional; >= 1 marks a rerun of an earlier test (Iteration column)
  additionalComparisons,     // optional: extra variations, [{ variationName, ...results }]
  screenshots,               // optional: [{ arm, armLabel, viewport, pageState, file }]
  date,       // test end date (every mapper: Amplitude endDate, PostHog end_date, GrowthBook latest phase end)
  startDate,  // optional; shown in the Started column with the run length under it and both dates on hover (falls back to `date`); with `date`, the Sample size column shows an avg/day sub-label, plus the run length when under 14 days (amber under 7, which also flags Too Good To Be True)
  pvalue, secondaryPvalue,  // optional; the p-values the platform reported (two-sided), used by Method "As reported"
  testMethod, // "fixed" | "sequential" | "hybrid" | "bayesian" | null (unknown: no icon; As reported reads it as sequential, so its reported p gets the always-valid mSPRT penalty)
  hypothesis, // optional, primary metric only: "two-sided" (default) | "superiority" | "non-inferiority"
  niMargin    // optional; non-inferiority margin, relative % (e.g. 2 = no worse than -2%); defaults to the MDE input
}
```

### Supported Mappers
- `growthbook-mapper.js` — GrowthBook API (`fetchExperiments()` lists stopped experiments, every page; `fetchOne()` attaches `/results` as `detailedResults`). Verified against a real account: metrics in role order (settings `goals`, then `secondaryMetrics`, then `guardrails`, labelled as such) with names from the results; per-arm stats from `analyses[0]` (`percentChange` fraction, `mean`, `stddev`, `pValue` or `chanceToBeatControl`); binary vs continuous from the control's own spread; no lift when the control mean is 0; decision from `resultSummary` (released test variant or won = Shipped, lost = Not Shipped); dates from the result; owner from `ownerEmail`; CUPED = `regressionAdjustmentEnabled`; screenshots from variations; triggers from visual changes / redirects / URL targeting (page), linked features (flag), other targeting (segment); reach = latest phase coverage as "rollout"
- `convert-mapper.js` — Convert.com API
- `convert-csv-mapper.js` — Convert.com CSV export (has `parseCSV()` + `mapRows()`)
- `eppo-mapper.js` — Eppo API
- `absmartly-mapper.js` — ABsmartly API
- `amplitude-mapper.js` — Amplitude Experiment Management API (`fetchExperiments()` lists experiments; `prepare()` adds analysis settings and metric names in batches (and, from the same `get`, each Web Experiment's `pageViewObjects`: URL rules and page trigger, plus the primary metric's `testDirection` / MDE as `primaryMetricParams`); triggers: Web Experiment = page (URL rules in the tooltip), a non-page-load trigger (element appeared, click, manual...) = interaction, feature experiment = flag; `fetchOne()` attaches `use_amp_experiments` analyze output as `analysis`, plus `_activeUsers` (unique `_active` users in the test window from one `query_amplitude_data` events-segmentation call, read from `overallSeries`) for reach = exposed ÷ active users (`reach()`, falls back to the rollout); newest first, 50 at a time with Load more; running experiments are skipped unless a decision, rolled-out variant or past end date says they finished). `AmplitudeMapper.mcp` is the browser OAuth (PKCE) sign-in + JSON-RPC client for Amplitude's MCP server; tokens in sessionStorage

- `posthog-mapper.js` — PostHog API with a personal API key (`experiment:read` + `query:read`). `fetchExperiments(projectRef, key)` lists finished experiments: ended, or flag switched off or serving one variant (`isFinished`); running ones are skipped. Project URL or id, blank = `@current` (then the org project with the most experiments, needs `project:read`); tries US then EU cloud; no end date = dated by `updated_at`; `fetchOne()` loads one experiment's detail (the list is slim) and runs one `ExperimentQuery` for its first primary and first secondary metric, attached as `_results`. Bayesian `chance_to_win` becomes a two-sided p; variant screenshots map from `parameters.variant_screenshot_media_ids` (public `/uploaded_media/<id>` URLs); "decrease" goals have their sign flipped. Reach (`reach()`): people exposed ÷ distinct people with a `$pageview` in the test window (one HogQL query in `fetchOne`, `_siteVisitors`); without it, the flag rollout labelled "rollout". Trigger (`triggers()`) shows only real targeting: `$pageview` exposure = page; a click-type exposure event = interaction; URL conditions = page, device/OS/browser = device, including person properties or cohorts = segment. Flag plumbing (`$feature/…` and flag-evaluates-to conditions) and exclusions add nothing; the `flag` type always shows (every PostHog experiment is a flag; alone it means exposed wherever the code checks it, not tied to a page; `images/iconFlag.svg`, a placeholder drawn in-house); the conditions show in the tooltip.

All API mappers expose: `mapExperiment(raw) → standardized` and `mapExperiments(array) → array`

The three live API imports (GrowthBook, Amplitude, PostHog) also expose `fetchOne(raw) → raw with results` (never mutating its input; throwing `ResumableResults.permanentError()` when retrying cannot help) and `changed(fresh, saved)`, and load results through **`mappers/resumable-results.js`**: each experiment is fetched and replaced as one unit (`_fetchedAt` when complete, `_issue` for a permanent failure), the raw experiments are saved to the shared import cache as results arrive, a reload shows the saved copy and only finishes experiments still pending, **Refresh** (or **Retry**) lists again and fetches only new, changed or pending ones (`merge` + `pending`), and **Re-pull all** fetches everything. The page side is `fetchResultsResumably()`, `showResultsStatus()` and `alertIfNoResults()` in `index.html`. Saved copies are trimmed to what Rerun reads: Amplitude `slim()` keeps only each variant's key and name (the Web Experiment code is ~90% of an experiment), PostHog `slimResult()` drops the query text and per-step session samples; older saved copies are trimmed and written back on load. File imports (Convert CSV, Local JSON) load in one step and skip this

The last import is kept as one backup. Switching the toggle to Dummy Data only sets it aside (`last_import_active` = `0`). Clicking Import always opens the dialog, preselected on the saved source (the toggle switches on only after a valid OK); OK on that same source (same PostHog project, no new file) restores the backup with no calls; clicking **Import** while already on an import reopens the dialog (Cancel keeps it), while the switch and "Dummy Data" toggle back. Another source, or a new file, replaces it. When listing fails but this platform's results are saved (`listingFailed()`), they stay on screen instead of falling back to dummy data

## Key Files
- `index.html` — Main page: all inline JS (rendering, sorting, tabs, summary bar, highlighting)
- `styles.css` — All styles (single file)
- `stats-utils.js` — Statistical functions: power calculations, p-value recalculation, Type M/S errors, erf/normalCDF/normalPDF
- `sequential-design.js` — `SequentialDesign`: 5-look group sequential design (t³ alpha spending, non-binding futility); `bounds()`, `get()`, `powerAt()`. Copied from changeandmeasure `components/`; keep both in step
- `always-valid-design.js` — `AlwaysValidDesign`: exact mSPRT power (r = 7.84) for evenly spaced checks; `boundary()`, `get()`, `powerAt()`. Copied from changeandmeasure `components/`; keep both in step
- `mappers/mapper-utils.js` — Shared mapper helpers for platform API normalization
- `mappers/resumable-results.js` — Resumable, per-experiment result loading shared by the API imports
- `data.json` — Dummy experiment data in standardized format

## Statistical Functions (stats-utils.js)
- `recalculatePower(totalSampleSize, metricType, relativeMDE, baselineRate)` — Power at a given MDE
- `recalculatePValue(totalSampleSize, metricType, observedEffect, baselineRate)` — P-value from observed effect
- `mSprtPValue(z, r = SEQUENTIAL_MSPRT_R)` — Always-valid mSPRT p-value; `SEQUENTIAL_MSPRT_R` = (1.96 + 0.84)² ≈ 7.84, tuned to an 80%-powered effect (p < 0.05 at z ≈ 3.03); the notes show as the tooltip under Method when Sequential is chosen (`SEQUENTIAL_NOTES`)
- `groupSequentialPValue(z)` — Group sequential repeated p-value at the last of 5 looks (Jennison & Turnbull): the smallest α whose design rejects with the final z; tabulated final boundaries, inverted. Notes in `GROUP_NOTES`
- `recalculateSequentialPower(..., sequential, peeks)` — Exact power for 'msprt' (one check a day over the test's run, `SEQUENTIAL_DEFAULT_PEEKS` = 30 without dates) or 'group', from the fixed-horizon power's expected z (`fixedPowerFraction`)
- `hypothesisPValue(..., sequential)` / `recalculateSequentialPValue(..., sequential)` — `sequential` is false, 'msprt' (or true) or 'group'
- `typeM(power)` — Exaggeration ratio (Gelman & Carlin)
- `typeS(power)` — Wrong sign probability (Gelman & Carlin)
- Helper: `erf`, `normalCDF`, `normalPDF`, `getZScore`, `calculateBinaryPower`, `calculateContinuousPower`

## Summary Bar Metrics
Always computed from the full loaded dataset, whichever tab is active (including Rerun).
- **Testing Sensitivity / per MDE** — % of tests with >=80% power at fixed thresholds (1%, 2%, 5%, 10%, 15%, plus the MDE input), with "EXP" / "MDE" row labels on the left, plus a column at the median MDE in its panel's colour (about 50% by definition; a value already on the scale marks that column; "15%+" loses its "+" when a column passes it) (the median MDE has its own panel: green <=5%, orange <=15%, red above)
- **Stat-Sig Rate** — every test with a primary result, each on its own hypothesis: a win (primaryMetric > 0 AND pvalue < alpha, the header's **Alpha** input, default 0.05), or for non-inferiority, its one-sided p against the margin < alpha. The count line reads "10 of 37 tests"; the tooltip splits wins and non-inferior
- **Median Impact** — median primary effect across all tests; **Median MDE** — median of each test's MDE at 80% power (a test that can't reach 80% even at a 200% effect counts as 200%; shown ">200%" if the median lands there) (own panels: Median Impact after False Positive Risk, Median MDE last, right of Testing Sensitivity). Each panel shows "x of N tests" under the number (`summary-metric-count`), N being every test with a result: tests covered (Median MDE: those that could be sized), "from x sig. wins" for FPR
- **False Positive Risk** — Kohavi's Bayesian FPR: `alpha*(1-pi) / (alpha*(1-pi) + power*pi)` where pi = success rate. Under Sequential (mSPRT) or Group sequential it's shown as "≈": the sequential p-values feed the success count, and alpha serves as an upper bound on false wins, so it leans conservative

## Header Controls
- **Method** — **As reported** (default): the platform's own `pvalue` / `secondaryPvalue`, estimated where missing (drawn as a dashed outlined pill), with power following each test's `testMethod`; a note under the dropdown summarises the methods used and how many p-values were estimated (the other options show their assumptions there, with a tooltip: `FIXED_NOTES`, `SEQUENTIAL_NOTES`, `GROUP_NOTES`). Disabled when the data has no reported p-values (falls back to Fixed horizon). **Fixed horizon** / **Sequential (mSPRT)** / **Group sequential** recalculate every test as if run that way. P-values Rerun computes for tests with several variants are Bonferroni-corrected (× comparisons with control); a platform's reported p is used as it comes, and its own correction (Amplitude's `pvalueCorrection` / `pvalueUncorrected`) shows in the tooltip. **MDE** — % for the Power column; **Alpha** — significance cut for the P-val columns (not the sequential modes) and the summary. All three persist in localStorage

## UI Conventions
- Color spectrum: red (#dc3545) -> orange (#e0a800) -> green (#28a745) for good/bad indicators
- `sensitivityColor(pct)` — Smooth RGB blend for 0-100% values
- Method column pairs the method badge with a hypothesis badge ("FIXED / 2-TAIL", "SEQ / NON-INF"). One-sided primary p-values come from `hypothesisPValue()` in `stats-utils.js`, which backs the z (and SE) out of the two-sided p; non-inferiority tests count in Stat-Sig Rate on their own p-value, and are left out of FPR
- Power column shows the power % badge with the MDE under it (Type M/S are not displayed). Under the sequential modes (and sequential tests As reported) it's exact (`recalculateSequentialPower`), with a tooltip naming the design (mSPRT checks per day, or 5 looks)
- Tooltips: put the text in a `data-tip` attribute (never `title`); `initTooltips()` in `index.html` renders one shared `.tooltip` for all of them
- Rerun list: a row's rerun button opens a draft panel (nothing is saved yet); the panel's **Rerun** button adds an entry to `rerunInstances`. A test can have many entries, and the Rerun tab shows one row per entry (each with **Remove**). Details (origin/notes/tags/type) live in `rerunDetails`, keyed by instance id, or by `draftEntryKey(selectionKey)` for drafts. The list persists in localStorage and is never deleted by a data change: `syncRerunEntriesToDataset()` moves entries whose experiment isn't loaded (matched by selection key plus the experiment `name` saved with each entry) into `hiddenReruns`, and moves them back when that data loads. Only **Clear list** (shown entries) and **Remove them** (hidden ones), both confirmed, delete. The Rerun tab's **Export JSON / Import JSON** saves and loads the shown list as a sidecar file (`format: "rerun-recommendations"`); imported entries for unloaded data are kept hidden
- The row's rerun tile is faint while undecided and full blue once decided (`.decided`: on the list, or declined with its diagonal), black while its panel is open on a scenario tab. On the Rerun tab, where every row is an entry, its type tile stays blue (`tr[data-instance-id] .rerun-row-btn-type`)
- **Rerun / Don't rerun toggle in place**: neither closes the panel; the chosen one shows filled black, clicking it again undoes it, and clicking the other switches the decision. **Rerun** on a scenario tab: the new entry becomes the panel's subject (`openEntryPanels`, session-only), shown as **✓ Rerun** (selected; clicking it again takes the entry off the list and returns its type and notes to a draft, `undoRerunFromPanel`), with **Don't rerun** switching the decision (`switchRerunToDecline`: the entry comes off the list, then the test is declined; blocked when several reruns are planned) **+ Add another** for a second idea, and **Remove** (deletes the entry, confirmed) (`toggleRerunDraft(row, { newDraft: true })`). Reopening a planned test opens its latest entry this way
- **Don't rerun**: the rerun panel's second button records a decision not to rerun (`declinedReruns`, by selection key with the experiment `name`, so it only applies while that test is loaded; the panel's **Notes** field is the reason, shown there and editable when the panel is reopened). Declined rows still count as matches (the scenario counts are unchanged) but lose the amber highlight and signal tints, show the rerun tile with a diagonal instead of arrows (`row-declined`, `images/iconRerunDeclined.svg`), are skipped by the highlight jumper, and are counted in the subtitle ("· 2 decided not to rerun"). Reopening the panel shows **✓ Don't rerun** filled (selected); clicking it again undoes it in place, and **Rerun** replaces it. The two decisions exclude each other: a test with entries on the rerun list can't be declined (the button is `aria-disabled` with an explaining tip), and if an older save holds both, the entries win (`isDeclined()` requires no entries). Saved with the rerun list and included in its Export / Import file (`declined`)
- Rerun types (`RERUN_TYPES`) are test designs, plus a `group: 'Decide'` set (**Ship it**, **Unship it**) for candidates that need a decision rather than another run; each group renders after a light-grey divider (a disabled `.rerun-type-divider` option) in the dropdown
- Rows with screenshots show a tiny thumbnail on the ID line (`renderRowThumb()`: first test-variant shot, else control; "+N" for more; lazy-loaded; the row click opens the panel with the full comparison)
- Experiment names link to the experiment on its platform when it has a `url` (`renderExperimentName()`: new tab, same colour, underline on hover, "Open in PostHog ↗" tooltip), else plain text. The rerun-list jump lives in the ⋯ menu and the Reruns strip
- **Don't Rerun tab** (`data-tab="declined"`, after RERUN): shown only while a loaded test is declined (`updateDeclinedTab()`, grey count badge); lists just those tests (`filterViewRows`) with "Reason: …" under the name, no highlighting (its TAB_CONFIG `matches` is always false). Undoing keeps the row until the tab is left; if the list empties, the view moves to Almost Significant. A draft opened there keeps the scenario it was declined from as its origin
- **Export tab** (`data-tab="rerun-export"`, after RERUN): the rerun list as a readable white document in place of the table (`renderRerunExport()` into `#rerunExportView`; `body.rerun-export-active` hides the table). Shown only while the list has entries (`updateExportTab()`); one item per entry, in the Rerun tab's order and following the search: type tile (a click goes to the entry on the Rerun tab), notes edited in place (`editExportNotes()`: a click swaps them for a `.rerun-note-field` textarea of the same saved notes; leaving it saves), name and experiment code, type as a phrase (`statement` in `RERUN_TYPES`), scenario icon and name with the original result (`rerunExportResult()`: rounded effect, metric name without its brackets, p under the current Method, n), compound partners, notes (`noteParagraphs()`: an all-caps "LABEL:" typed at the start of a line or sentence (a single letter: a line only) starts a paragraph and shows as a grey pill, bold in copies; the hint beside the panel's Notes label says so; `linkParts()`: web addresses show as short links, kept in full in plain text and Markdown). **Copy** (formatted HTML + plain text), **Copy Markdown**, **Download HTML** (`rerunExportFile()`: one self-contained file using the tab's own rules from `styles.css`, icons embedded) and **Print / PDF** (print CSS shows only the document) share what is shown. Tags and the JSON file stay on the Rerun tab
- Tabs are scenario filters (Almost Significant, Squeeze The Lemon, etc.) that highlight matching rows

## Styling Preferences
- Clean, minimal design; no outer borders on summary bar
- Font sizes: titles 14px, labels 11-12px, stat values 16px, summary big values 24px
- Standard dark text: #2c2c2c; subtle labels: #555
- Tab hover uses blue (#0066cc) bottom border
