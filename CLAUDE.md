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
  sampleSize, baseRate, triggered, traffic, trafficSubtitle, owner,
  date,       // test end date, shown in the "Started" column
  startDate,  // optional; when present with `date`, the Sample size column shows an avg/day sub-label
  testMethod  // "fixed" | "sequential" | "hybrid" | "bayesian" | null (unknown: no icon)
}
```

### Supported Mappers
- `growthbook-mapper.js` — GrowthBook API (has `fetchExperiments()` + `mapExperiments()`)
- `convert-mapper.js` — Convert.com API
- `convert-csv-mapper.js` — Convert.com CSV export (has `parseCSV()` + `mapRows()`)
- `eppo-mapper.js` — Eppo API
- `absmartly-mapper.js` — ABsmartly API
- `amplitude-mapper.js` — Amplitude Experiment Management API (`fetchExperiments()` lists experiments; `fetchResults()` attaches `use_amp_experiments` analyze output as `analysis`). `AmplitudeMapper.mcp` is the browser OAuth (PKCE) sign-in + JSON-RPC client for Amplitude's MCP server; tokens in sessionStorage

All API mappers expose: `mapExperiment(raw) → standardized` and `mapExperiments(array) → array`

## Key Files
- `index.html` — Main page: all inline JS (rendering, sorting, tabs, summary bar, highlighting)
- `styles.css` — All styles (single file)
- `stats-utils.js` — Statistical functions: power calculations, p-value recalculation, Type M/S errors, erf/normalCDF/normalPDF
- `mappers/mapper-utils.js` — Shared mapper helpers for platform API normalization
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
- **False Positive Risk** — Kohavi's Bayesian FPR: `alpha*(1-pi) / (alpha*(1-pi) + power*pi)` where pi = success rate. Shown as "—" under Sequential (mSPRT), which has no established equivalent

## Header Controls
- **Method** — Fixed horizon or Sequential (mSPRT); **MDE** — % for the Power column; **Alpha** — significance cut for the P-val columns (fixed horizon) and the summary. All three persist in localStorage

## UI Conventions
- Color spectrum: red (#dc3545) -> orange (#e0a800) -> green (#28a745) for good/bad indicators
- `sensitivityColor(pct)` — Smooth RGB blend for 0-100% values
- Power column shows the power % badge with the MDE under it (Type M/S are not displayed). Under Sequential (mSPRT) it's prefixed "≈": fixed-horizon power at sampleSize ÷ `SEQUENTIAL_SAMPLE_SIZE_INFLATION`
- Tooltips: put the text in a `data-tip` attribute (never `title`); `initTooltips()` in `index.html` renders one shared `.tooltip` for all of them
- Rerun list: a row's rerun button opens a draft panel (nothing is saved yet); the panel's **Rerun** button adds an entry to `rerunInstances`. A test can have many entries, and the Rerun tab shows one row per entry (each with **Remove**). Details (origin/notes/tags/type) live in `rerunDetails`, keyed by instance id, or by `draftEntryKey(selectionKey)` for drafts. The list persists in localStorage; the Rerun tab's **Export JSON / Import JSON** saves and loads it as a sidecar file (`format: "rerun-recommendations"`) linked to experiments by selection key, so it only imports against the same dataset
- Rerun types (`RERUN_TYPES`) are test designs, plus a `group: 'Decide'` set (**Ship it**, **Unship it**) for candidates that need a decision rather than another run; each group renders after a light-grey divider (a disabled `.rerun-type-divider` option) in the dropdown
- Tabs are scenario filters (Almost Significant, Squeeze The Lemon, etc.) that highlight matching rows

## Styling Preferences
- Clean, minimal design; no outer borders on summary bar
- Font sizes: titles 14px, labels 11-12px, stat values 16px, summary big values 24px
- Standard dark text: #2c2c2c; subtle labels: #555
- Tab hover uses blue (#0066cc) bottom border
