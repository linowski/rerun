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
  reachLabel, reachNote,  // optional: what `traffic` is out of (default "of traffic"; PostHog: "of site visitors" or "rollout") and its tooltip
  url, change, decision,     // optional: platform link, what the variation did, "Shipped" | "Not Shipped"
  preregisteredSampleSize,   // optional; fixed-horizon tests without one get a "No prereg" flag
  iterations,                // optional; >= 1 marks a rerun of an earlier test (Success Rate of Iterations)
  additionalComparisons,     // optional: extra variations, [{ variationName, ...results }]
  screenshots,               // optional: [{ arm, armLabel, viewport, pageState, file }]
  date,       // test end date, shown in the "Started" column
  startDate,  // optional; when present with `date`, the Sample size column shows an avg/day sub-label
  pvalue, secondaryPvalue,  // optional; the p-values the platform reported (two-sided), used by Method "As reported"
  testMethod, // "fixed" | "sequential" | "hybrid" | "bayesian" | null (unknown: no icon; As reported reads it as sequential, so its reported p gets the always-valid mSPRT penalty)
  hypothesis, // optional, primary metric only: "two-sided" (default) | "superiority" | "non-inferiority"
  niMargin    // optional; non-inferiority margin, relative % (e.g. 2 = no worse than -2%); defaults to the MDE input
}
```

### Supported Mappers
- `growthbook-mapper.js` — GrowthBook API (`fetchExperiments()` lists stopped experiments, every page; `fetchOne()` attaches `/results` as `detailedResults`)
- `convert-mapper.js` — Convert.com API
- `convert-csv-mapper.js` — Convert.com CSV export (has `parseCSV()` + `mapRows()`)
- `eppo-mapper.js` — Eppo API
- `absmartly-mapper.js` — ABsmartly API
- `amplitude-mapper.js` — Amplitude Experiment Management API (`fetchExperiments()` lists experiments; `prepare()` adds analysis settings and metric names in batches; `fetchOne()` attaches `use_amp_experiments` analyze output as `analysis`; newest first, 50 at a time with Load more). `AmplitudeMapper.mcp` is the browser OAuth (PKCE) sign-in + JSON-RPC client for Amplitude's MCP server; tokens in sessionStorage

- `posthog-mapper.js` — PostHog API with a personal API key (`experiment:read` + `query:read`). `fetchExperiments(projectRef, key)` lists finished experiments: ended, or flag switched off or serving one variant (`isFinished`); running ones are skipped. Project URL or id, blank = `@current` (then the org project with the most experiments, needs `project:read`); tries US then EU cloud; no end date = dated by `updated_at`; `fetchOne()` loads one experiment's detail (the list is slim) and runs one `ExperimentQuery` for its first primary and first secondary metric, attached as `_results`. Bayesian `chance_to_win` becomes a two-sided p; variant screenshots map from `parameters.variant_screenshot_media_ids` (public `/uploaded_media/<id>` URLs); "decrease" goals have their sign flipped. Reach (`reach()`): people exposed ÷ distinct people with a `$pageview` in the test window (one HogQL query in `fetchOne`, `_siteVisitors`); without it, the flag rollout labelled "rollout". Trigger (`triggers()`) shows only real targeting: `$pageview` exposure = page; a click-type exposure event = interaction; URL conditions = page, device/OS/browser = device, including person properties or cohorts = segment. Flag plumbing (`$feature/…` and flag-evaluates-to conditions) and exclusions add nothing; the `flag` type always shows (every PostHog experiment is a flag; alone it means exposed wherever the code checks it, not tied to a page; `images/iconFlag.svg`, a placeholder drawn in-house); the conditions show in the tooltip.

All API mappers expose: `mapExperiment(raw) → standardized` and `mapExperiments(array) → array`

The three live API imports (GrowthBook, Amplitude, PostHog) also expose `fetchOne(raw) → raw with results` (never mutating its input; throwing `ResumableResults.permanentError()` when retrying cannot help) and `changed(fresh, saved)`, and load results through **`mappers/resumable-results.js`**: each experiment is fetched and replaced as one unit (`_fetchedAt` when complete, `_issue` for a permanent failure), the raw experiments are saved to the shared import cache as results arrive, a reload shows the saved copy and only finishes experiments still pending, **Refresh** (or **Retry**) lists again and fetches only new, changed or pending ones (`merge` + `pending`), and **Re-pull all** fetches everything. The page side is `fetchResultsResumably()`, `showResultsStatus()` and `alertIfNoResults()` in `index.html`. File imports (Convert CSV, Local JSON) load in one step and skip this

The last import is kept as one backup. Switching the toggle to Dummy Data only sets it aside (`last_import_active` = `0`). Clicking Import always opens the dialog, preselected on the saved source (the toggle switches on only after a valid OK); OK on that same source (same PostHog project, no new file) restores the backup with no calls; clicking **Import** while already on an import reopens the dialog (Cancel keeps it), while the switch and "Dummy Data" toggle back. Another source, or a new file, replaces it. When listing fails but this platform's results are saved (`listingFailed()`), they stay on screen instead of falling back to dummy data

## Key Files
- `index.html` — Main page: all inline JS (rendering, sorting, tabs, summary bar, highlighting)
- `styles.css` — All styles (single file)
- `stats-utils.js` — Statistical functions: power calculations, p-value recalculation, Type M/S errors, erf/normalCDF/normalPDF
- `mappers/mapper-utils.js` — Shared mapper helpers for platform API normalization
- `mappers/resumable-results.js` — Resumable, per-experiment result loading shared by the API imports
- `data.json` — Dummy experiment data in standardized format

## Statistical Functions (stats-utils.js)
- `recalculatePower(totalSampleSize, metricType, relativeMDE, baselineRate)` — Power at a given MDE
- `recalculatePValue(totalSampleSize, metricType, observedEffect, baselineRate)` — P-value from observed effect
- `typeM(power)` — Exaggeration ratio (Gelman & Carlin)
- `typeS(power)` — Wrong sign probability (Gelman & Carlin)
- Helper: `erf`, `normalCDF`, `normalPDF`, `getZScore`, `calculateBinaryPower`, `calculateContinuousPower`

## Summary Bar Metrics
Always computed from the full loaded dataset, whichever tab is active (including Rerun).
- **Testing Sensitivity / per MDE** — % of experiments with >=80% power at fixed thresholds (0.5%, 1%, 2%, 5%, 10%, 15%), plus the **median MDE** at 80% power (green <=5%, orange <=15%, red above)
- **Median Rel. Effect** — Median primary metric across experiments
- **Success Rate** — Experiments with primaryMetric > 0 AND pvalue < alpha (the header's **Alpha** input, default 0.05)
- **False Positive Risk** — Kohavi's Bayesian FPR: `alpha*(1-pi) / (alpha*(1-pi) + power*pi)` where pi = success rate. Under Sequential (mSPRT) it's shown as "≈": the always-valid p-values feed the success count, and alpha serves as an upper bound on false wins, so it leans conservative

## Header Controls
- **Method** — **As reported** (default): the platform's own `pvalue` / `secondaryPvalue`, estimated where missing (drawn as a dashed outlined pill), with power following each test's `testMethod`; a note under the dropdown summarises the methods used and how many p-values were estimated. Disabled when the data has no reported p-values (falls back to Fixed horizon). **Fixed horizon** / **Sequential (mSPRT)** recalculate every test as if run that way. **MDE** — % for the Power column; **Alpha** — significance cut for the P-val columns (not Sequential) and the summary. All three persist in localStorage

## UI Conventions
- Color spectrum: red (#dc3545) -> orange (#e0a800) -> green (#28a745) for good/bad indicators
- `sensitivityColor(pct)` — Smooth RGB blend for 0-100% values
- Method column pairs the method badge with a hypothesis badge ("FIXED / 2-TAIL", "SEQ / NON-INF"). One-sided primary p-values come from `hypothesisPValue()` in `stats-utils.js`, which backs the z (and SE) out of the two-sided p; non-inferiority tests are left out of Success Rate and FPR
- Power column shows the power % badge with the MDE under it (Type M/S are not displayed). Under Sequential (mSPRT) it's prefixed "≈": fixed-horizon power at sampleSize ÷ `SEQUENTIAL_SAMPLE_SIZE_INFLATION`
- Tooltips: put the text in a `data-tip` attribute (never `title`); `initTooltips()` in `index.html` renders one shared `.tooltip` for all of them
- Rerun list: a row's rerun button opens a draft panel (nothing is saved yet); the panel's **Rerun** button adds an entry to `rerunInstances`. A test can have many entries, and the Rerun tab shows one row per entry (each with **Remove**). Details (origin/notes/tags/type) live in `rerunDetails`, keyed by instance id, or by `draftEntryKey(selectionKey)` for drafts. The list persists in localStorage and is never deleted by a data change: `syncRerunEntriesToDataset()` moves entries whose experiment isn't loaded (matched by selection key plus the experiment `name` saved with each entry) into `hiddenReruns`, and moves them back when that data loads. Only **Clear list** (shown entries) and **Remove them** (hidden ones), both confirmed, delete. The Rerun tab's **Export JSON / Import JSON** saves and loads the shown list as a sidecar file (`format: "rerun-recommendations"`); imported entries for unloaded data are kept hidden
- Rerun types (`RERUN_TYPES`) are test designs, plus a `group: 'Decide'` set (**Ship it**, **Unship it**) for candidates that need a decision rather than another run; each group renders after a light-grey divider (a disabled `.rerun-type-divider` option) in the dropdown
- Tabs are scenario filters (Almost Significant, Squeeze The Lemon, etc.) that highlight matching rows

## Styling Preferences
- Clean, minimal design; no outer borders on summary bar
- Font sizes: titles 14px, labels 11-12px, stat values 16px, summary big values 24px
- Standard dark text: #2c2c2c; subtle labels: #555
- Tab hover uses blue (#0066cc) bottom border
