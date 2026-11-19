# Rerun

Rerun is a browser-based experiment analysis dashboard for reviewing A/B test results across experimentation platforms. It runs as plain HTML/CSS/JavaScript with no build step.

## What It Does

- Loads demo experiment data from `data.json`, or imports real data: GrowthBook API, Amplitude Experiment Management API, PostHog API, Convert aggregated CSV exports, or a local JSON file already in the shape below. Mappers in `mappers/` normalize each platform into that shared shape.
- Reads results three ways (**Method**): **As reported** uses each platform's own p-values (estimating the rest) and each test's own design; **Fixed horizon** and **Sequential (mSPRT)** recalculate every test as if it had been run that way. Tests can be two-sided, one-sided superiority, or non-inferiority with a margin.
- Shows power at a chosen MDE, an adjustable significance level (Alpha), and per-test flags such as missing preregistration and average sample per day.
- Summarizes the whole program: success rate, Kohavi's false positive risk, and testing sensitivity (the share of tests powered to detect each effect size, plus the median MDE).
- Highlights rerun candidates by scenario: Almost Significant, Squeeze The Lemon, Promising Losers, Too Good To Be True, and Too Good To Be False.
- Builds a rerun list: pick a test design for each candidate (or a Ship it / Unship it decision), add notes and tags, compare its screenshots, and export or import the list as JSON.

## Quick Start

Serve this folder over HTTP and open the `localhost` URL, for example with `npx serve`, `python -m http.server`, or VS Code's Live Server. Opening `index.html` straight from disk (`file://`) blocks the data from loading.

To use real data, click **Import** and pick a platform. API keys are entered there, not stored in any project file.

## Data Shape

Mappers normalize platform data into an array of experiment objects, and a
local JSON import takes the same array directly. Effects are relative lifts in
percent (`5` means +5%).

```js
{
  // Identity
  name,                     // experiment name
  id,                       // stable id; rerun lists and exports link to it
  url,                      // optional link to the experiment on its platform
  change,                   // optional: what the variation did
  owner,

  // Timing
  date,                     // end date, YYYY-MM-DD
  startDate,                // optional; with `date`, shows an average sample per day

  // Results
  primaryMetric,            // relative lift, %
  primaryMetricLabel,
  primaryMetricType,        // "binary" | "continuous"
  secondaryMetric,          // optional, same shape as the primary
  secondaryMetricLabel,
  secondaryMetricType,
  pvalue,                   // optional: the platform's two-sided p-value for the primary
  secondaryPvalue,          // optional: same, for the secondary
  sampleSize,               // total across arms
  baseRate,                 // control conversion rate, %; used where p-values must be estimated

  // Design
  testMethod,               // optional: "fixed" | "sequential" | "hybrid" | "bayesian"
                            //   (none: read as sequential, the conservative assumption)
  hypothesis,               // optional: "two-sided" (default) | "superiority" | "non-inferiority"
  niMargin,                 // optional non-inferiority margin, % (defaults to the MDE input)
  preregisteredSampleSize,  // optional; fixed-horizon tests without it are flagged
  iterations,               // optional; 1+ marks a rerun of an earlier test

  // Context
  decision,                 // optional: "Shipped" | "Not Shipped"
  triggered,                // optional: array of { type } trigger descriptors
  traffic,                  // optional: % of traffic exposed
  reachLabel, reachNote,    // optional: what `traffic` is a % of (default "of traffic") and a tooltip
  additionalComparisons,    // optional: extra variations, each { variationName, ...results }
  screenshots               // optional: [{ arm, armLabel, viewport, pageState, file }]
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
- `utilities/` - standalone helper tools (`convert-export.html` exports Convert.com experiments and results to CSV)
- `images/` - tab and scenario icons (Streamline, see Third-Party Assets)
- `data.json` - demo/fallback experiment data
- `_data/` - not in the repo: gitignored, for your own private experiment data, imported via **Import → Local JSON File**

## License

The source code in this repository is licensed under the [MIT License](LICENSE).

## Third-Party Assets

The icons in `images/` (except `iconFlag.svg`, drawn for this project) are from [Streamline](https://streamlinehq.com), used
under a [Streamline Premium license](https://help.streamlinehq.com/en/articles/5354366-streamline-premium-licenses).
They are not covered by the MIT license above. Streamline Premium terms permit
use within an open-source project with attribution, but do not permit
extracting and redistributing the icon files themselves as standalone,
freely-reusable assets — if you fork this project, bring your own icons or
your own Streamline license.

## Custom Integrations

Only the GrowthBook API, Amplitude, PostHog and Convert CSV import are wired up to
pull real data today; the other mappers are scaffolding.

PostHog uses a **personal API key** (Settings → Personal API keys) with the
read scopes `experiment:read` and `query:read`, plus the project's URL or ID
(blank uses the key's current project on US or EU cloud; a self-hosted
instance needs its URL). Rerun lists the project's finished experiments (running ones are skipped) and runs
one results query per experiment for its first primary and secondary metric,
all from the browser.

For every API import, results are saved as they arrive. A reload makes no calls
beyond finishing experiments an interrupted load did not get to; **Refresh**
under the Import toggle fetches only new or changed experiments, and **Re-pull
all** fetches everything again.

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
