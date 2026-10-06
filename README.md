# Rerun

Rerun is a browser-based experiment analysis dashboard for reviewing A/B test results across experimentation platforms. It runs as plain HTML/CSS/JavaScript with no build step.

## What It Does

- Loads demo experiment data from `data.json`.
- Imports platform data through mapper files in `mappers/`.
- Supports GrowthBook API data, the Amplitude Experiment Management API, and Convert aggregated CSV exports.
- Normalizes platform responses into a shared experiment shape.
- Recalculates power and p-values in the browser.
- Highlights scenarios such as almost-significant tests, likely false positives, false negatives, and promising negative tests.

## Quick Start

Open `index.html` in a browser.

To use real data, click **Import** and pick a platform. API keys are entered there, not stored in any project file.

## Data Shape

Mappers normalize platform data to objects like:

```js
{
  name,
  id,
  date,
  primaryMetric,
  primaryMetricLabel,
  primaryMetricType,
  secondaryMetric,
  secondaryMetricLabel,
  secondaryMetricType,
  sampleSize,
  baseRate,
  triggered,
  traffic,
  trafficSubtitle,
  owner
}
```

## Credentials And Privacy

Credentials are handled client-side. Do not commit `config.js`, `.env` files, raw exports, or local tool settings.

Dashboard API keys are kept in browser `sessionStorage` for the current tab session, not committed or stored in project files.

The Convert export utility can optionally remember a secret key in browser `localStorage`. Use that only on trusted machines.

## Project Structure

- `index.html` - main dashboard UI and inline app script
- `styles.css` - dashboard styles
- `stats-utils.js` - statistical calculations
- `mappers/` - platform normalization code
- `utilities/` - standalone helper tools
- `data.json` - demo/fallback experiment data

## License

The source code in this repository is licensed under the [MIT License](LICENSE).

## Third-Party Assets

The icons in `images/` are from [Streamline](https://streamlinehq.com), used
under a [Streamline Premium license](https://help.streamlinehq.com/en/articles/5354366-streamline-premium-licenses).
They are not covered by the MIT license above. Streamline Premium terms permit
use within an open-source project with attribution, but do not permit
extracting and redistributing the icon files themselves as standalone,
freely-reusable assets — if you fork this project, bring your own icons or
your own Streamline license.

## Custom Integrations

Only the GrowthBook API, Amplitude and Convert CSV import are wired up to
pull real data today; the other mappers are scaffolding.

Amplitude uses a read-only **Management API key** (Settings → Organization
settings → API keys), entered in the import dialog, to list experiments.
Results (lift, p-value, sample size) come from **Sign in with Amplitude** in the
same dialog: rerun signs in to Amplitude's MCP server with read-only OAuth and
calls its `use_amp_experiments` tool (action `analyze`) directly from the browser. No AI client is
involved, so no model tokens are used, and the sign-in is kept only for the
browser tab. Each experiment is one `analyze` call, so rerun loads the 50
newest first; **Load more** under the Import toggle adds 50 more, then 100 at a
time. Serve rerun over `http://localhost` (e.g. VS Code Live Server);
sign-in cannot return to a `file://` page. For custom integration or
setup help, contact [Jakub Linowski](https://linowski.ca).
