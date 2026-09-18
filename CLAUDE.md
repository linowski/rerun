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
  sampleSize, baseRate, triggered, traffic, trafficSubtitle, owner
}
```

### Supported Mappers
- `growthbook-mapper.js` — GrowthBook API (has `fetchExperiments()` + `mapExperiments()`)
- `convert-mapper.js` — Convert.com API
- `convert-csv-mapper.js` — Convert.com CSV export (has `parseCSV()` + `mapRows()`)
- `eppo-mapper.js` — Eppo API
- `absmartly-mapper.js` — ABsmartly API

All API mappers expose: `mapExperiment(raw) → standardized` and `mapExperiments(array) → array`

## Key Files
- `index.html` — Main page: all inline JS (rendering, sorting, tabs, summary bar, highlighting)
- `styles.css` — All styles (single file)
- `stats-utils.js` — Statistical functions: power calculations, p-value recalculation, Type M/S errors, erf/normalCDF/normalPDF
- `mappers/mapper-utils.js` — Shared mapper helpers for platform API normalization
- `config.js` — API keys (should be in .gitignore)
- `config.example.js` — Safe local config template
- `data.json` — Dummy experiment data in standardized format

## Statistical Functions (stats-utils.js)
- `recalculatePower(totalSampleSize, metricType, relativeMDE, baselineRate)` — Power at a given MDE
- `recalculatePValue(totalSampleSize, metricType, observedEffect, baselineRate)` — P-value from observed effect
- `typeM(power)` — Exaggeration ratio (Gelman & Carlin)
- `typeS(power)` — Wrong sign probability (Gelman & Carlin)
- Helper: `erf`, `normalCDF`, `normalPDF`, `getZScore`, `calculateBinaryPower`, `calculateContinuousPower`

## Summary Bar Metrics
- **Testing Sensitivity / per MDE** — % of experiments with >=80% power at fixed thresholds (0.5%, 1%, 2%, 5%, 10%, 15%)
- **Median Rel. Effect** — Median primary metric across experiments
- **Success Rate** — Experiments with primaryMetric > 0 AND pvalue < 0.05
- **False Positive Risk** — Kohavi's Bayesian FPR: `alpha*(1-pi) / (alpha*(1-pi) + power*pi)` where pi = success rate

## UI Conventions
- Color spectrum: red (#dc3545) -> orange (#e0a800) -> green (#28a745) for good/bad indicators
- `sensitivityColor(pct)` — Smooth RGB blend for 0-100% values
- `blendToRed(t)` — Gray-to-red blend for Type M/S danger values
- Power column shows 3 micro columns: power %, exaggeration (Type M), wrong sign (Type S)
- Tabs are scenario filters (Almost Significant, Squeeze The Lemon, etc.) that highlight matching rows

## Styling Preferences
- Clean, minimal design; no outer borders on summary bar
- Font sizes: titles 14px, labels 11-12px, stat values 16px, summary big values 24px
- Standard dark text: #2c2c2c; subtle labels: #555
- Tab hover uses blue (#0066cc) bottom border
