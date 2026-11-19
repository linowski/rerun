/**
 * GrowthBook API Mapper
 * Maps GrowthBook API responses to our standardized experiment data format
 */

const GrowthBookMapper = {
    async request(apiHost, path, apiKey) {
        const response = await fetch(`${apiHost}${path}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });
        if (!response.ok) {
            const error = new Error(`HTTP error! status: ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return response.json();
    },

    /**
     * Lists stopped experiments with traffic, every page (GrowthBook returns
     * 10 per page unless asked for more, 100 at most).
     * @param {string} apiHost - API host URL
     * @param {string} apiKey - API key for authentication
     * @returns {Promise<Array>} - Array of filtered raw experiments
     */
    async fetchExperiments(apiHost, apiKey) {
        const rawExperiments = [];
        let offset = 0;
        for (;;) {
            const data = await this.request(apiHost, `/api/v1/experiments?limit=100&offset=${offset}`, apiKey);
            const page = data.experiments || (Array.isArray(data) ? data : []);
            rawExperiments.push(...page);
            if (!data.hasMore || !page.length) break;
            offset = data.nextOffset ?? offset + page.length;
        }

        // Filter only stopped experiments with non-zero traffic allocation
        return rawExperiments.filter(exp => {
            const isStopped = exp.status === 'stopped';
            const hasTraffic = (exp.coverage && exp.coverage > 0) ||
                              (exp.trafficSplit && Object.values(exp.trafficSplit).some(v => v > 0)) ||
                              (exp.phases && exp.phases.some(p => p.coverage > 0));
            return isStopped && hasTraffic;
        });
    },

    /**
     * One experiment's results, for ResumableResults.run, attached as
     * `detailedResults`. Resolves to a new object. A client error (no
     * results for it, no access) is permanent; anything else is retried.
     */
    async fetchOne(experiment, apiHost, apiKey) {
        const experimentId = experiment.id || experiment.experimentId || experiment.key;
        if (!experimentId) throw ResumableResults.permanentError('has no id');
        try {
            const results = await this.request(apiHost, `/api/v1/experiments/${experimentId}/results`, apiKey);
            return { ...experiment, detailedResults: results };
        } catch (error) {
            if (error.status >= 400 && error.status < 500 && error.status !== 429) {
                throw ResumableResults.permanentError(`results request failed (${error.message})`);
            }
            throw error;
        }
    },

    latestPhase(experiment) {
        const phases = experiment.phases || [];
        return phases[phases.length - 1] || null;
    },

    // Whether a saved experiment's results may be out of date.
    changed(fresh, saved) {
        return (fresh.dateUpdated || '') !== (saved.dateUpdated || '');
    },

    /*
     * Mapping, written against GrowthBook's real results shape
     * (GET /api/v1/experiments/:id/results, attached as `detailedResults`):
     *
     *   result: { phase, dateStart, dateEnd, health: { srm },
     *     results: [{ dimension: '', totalUsers,
     *       metrics: [{ metricId, metricName,
     *         variations: [{ variationId, users,
     *           analyses: [{ engine, mean, stddev, percentChange (fraction),
     *             pValue (frequentist), chanceToBeatControl (bayesian),
     *             ciLow, ciHigh, effectStandardError }] }] }] }] }
     *
     * Metric roles come from the experiment's settings: `goals` (primary),
     * `secondaryMetrics`, then `guardrails`. Variation 0 is the control.
     */

    // The overall (non-dimension) results block, or null.
    resultsBlock(experiment) {
        const results = experiment.detailedResults?.result?.results;
        if (!Array.isArray(results)) return null;
        return results.find(r => !r.dimension) || results[0] || null;
    },

    // Result metrics in role order: goals, secondary metrics, guardrails,
    // then anything else the results carry. The first is the primary, the
    // second the secondary.
    orderedMetrics(experiment) {
        const block = this.resultsBlock(experiment);
        const metrics = block?.metrics || [];
        const settings = experiment.settings || experiment.detailedResults?.result?.settings || {};
        const ids = [...(settings.goals || []), ...(settings.secondaryMetrics || []), ...(settings.guardrails || [])]
            .map(m => m.metricId);
        const byId = new Map(metrics.map(m => [m.metricId, m]));
        const ordered = [...new Set(ids)].map(id => byId.get(id)).filter(Boolean);
        return ordered.concat(metrics.filter(m => !ordered.includes(m)));
    },

    metricFor(experiment, role) {
        return this.orderedMetrics(experiment)[role === 'primary' ? 0 : 1] || null;
    },

    roleOf(experiment, metric) {
        const settings = experiment.settings || {};
        const has = list => (list || []).some(m => m.metricId === metric?.metricId);
        if (has(settings.goals)) return 'goal';
        if (has(settings.secondaryMetrics)) return 'secondary';
        if (has(settings.guardrails)) return 'guardrail';
        return '';
    },

    analysis(variation) {
        return variation?.analyses?.[0] || null;
    },

    // A proportion's spread is sqrt(mean * (1 - mean)); a count or amount's
    // is not. Read from the control arm's own numbers, not the metric name.
    isBinaryMetric(metric) {
        const control = this.analysis(metric?.variations?.[0]);
        const mean = Number(control?.mean);
        const sd = Number(control?.stddev);
        if (!(mean > 0) || mean >= 1 || !Number.isFinite(sd)) return null;
        const expected = Math.sqrt(mean * (1 - mean));
        // Within 5%: GrowthBook may adjust the spread slightly (e.g. CUPED).
        return Math.abs(sd - expected) / expected < 0.05;
    },

    metricType(metric) {
        const binary = this.isBinaryMetric(metric);
        if (binary === null) return metric ? MapperUtils.determineMetricType(metric.metricName) : null;
        return binary ? 'binary' : 'continuous';
    },

    /**
     * One metric's comparison of variation `index` against control:
     * { lift %, pvalue, sampleSize, baseRate %, cv }, or nulls when the
     * control has no data (a lift against zero is undefined).
     */
    compare(experiment, metric, index) {
        const control = metric?.variations?.[0];
        const variant = metric?.variations?.[index];
        const c = this.analysis(control);
        const v = this.analysis(variant);
        const sampleSize = (control?.users || 0) + (variant?.users || 0);
        if (!c || !v || !(Number(c.mean) > 0)) {
            return { lift: null, pvalue: null, sampleSize, baseRate: c ? 0 : null, cv: null };
        }
        const binary = this.isBinaryMetric(metric) ?? this.metricType(metric) === 'binary';
        let pvalue = null;
        if (v.engine === 'frequentist' || Number(v.pValue) > 0) {
            pvalue = MapperUtils.normalizePValue(v.pValue);
        } else if (Number.isFinite(v.chanceToBeatControl)) {
            // Bayesian: chance to beat control is about one minus the
            // one-sided p, so the two-sided p is twice the smaller tail.
            pvalue = Math.round(2 * Math.min(v.chanceToBeatControl, 1 - v.chanceToBeatControl) * 1e6) / 1e6;
        }
        return {
            lift: Number.isFinite(v.percentChange) ? Math.round(v.percentChange * 100 * 1000) / 1000 : null,
            pvalue,
            sampleSize,
            baseRate: binary ? Math.round(c.mean * 100 * 10000) / 10000 : null,
            cv: binary ? null : (Number(c.stddev) >= 0 ? Number(c.stddev) / Number(c.mean) : null)
        };
    },

    metricLabel(experiment, metric) {
        if (!metric) return '';
        const role = this.roleOf(experiment, metric);
        return role === 'guardrail' ? `${metric.metricName} (guardrail)` : metric.metricName || '';
    },

    // Shipped when a test variation was released or the result is "won";
    // Not Shipped when "lost"; otherwise (inconclusive, did not finish) blank.
    decision(experiment) {
        const summary = experiment.resultSummary || experiment.resultsStatus || {};
        const controlId = experiment.variations?.[0]?.variationId;
        if (summary.releasedVariationId && summary.releasedVariationId !== controlId) return 'Shipped';
        if (summary.status === 'won') return 'Shipped';
        if (summary.status === 'lost') return 'Not Shipped';
        return '';
    },

    // The dates the results cover (a multi-phase test's results are for one
    // phase), else the latest phase, else the last update.
    dates(experiment) {
        const result = experiment.detailedResults?.result;
        const phase = this.latestPhase(experiment);
        return {
            startDate: (result?.dateStart || phase?.dateStarted || '').slice(0, 10) || null,
            date: (result?.dateEnd || phase?.dateEnded || experiment.dateUpdated || '').slice(0, 10) || null
        };
    },

    /**
     * The Trigger column, from what the experiment records:
     *  - a visual-editor change, a URL redirect, or URL targeting: page
     *    (the URL rule in the tooltip when there is one);
     *  - linked feature flags: flag;
     *  - other targeting attributes or saved groups: segment.
     */
    triggers(experiment) {
        const phase = this.latestPhase(experiment) || {};
        let condition = {};
        try { condition = JSON.parse(phase.targetingCondition || '{}') || {}; } catch (e) { condition = {}; }
        const urlRule = condition.url ? this.describeCondition(condition.url) : '';
        const triggers = [];
        if (experiment.hasVisualChangesets || experiment.hasURLRedirects || urlRule) {
            const kind = experiment.hasURLRedirects ? 'URL redirect test' : experiment.hasVisualChangesets ? 'Visual editor change' : 'Page targeting';
            triggers.push({ type: 'page', label: urlRule ? `${kind} on pages where URL ${urlRule}` : kind });
        }
        if ((experiment.linkedFeatures || []).length) {
            triggers.push({ type: 'flag', label: 'Feature flag: exposed wherever the code checks it, not tied to a page' });
        }
        const attributes = Object.keys(condition).filter(key => key !== 'url');
        const groups = (phase.savedGroupTargeting || []).length;
        if (attributes.length || groups) {
            triggers.push({ type: 'segment', label: [
                attributes.length ? `Targeting on ${attributes.join(', ')}` : '',
                groups ? `${groups} saved group${groups === 1 ? '' : 's'}` : ''
            ].filter(Boolean).join('; ') });
        }
        return triggers;
    },

    // A targeting condition in words: "matches ^https://example.com/…".
    describeCondition(value) {
        if (typeof value === 'string') return `is ${value}`;
        const [op, operand] = Object.entries(value || {})[0] || [];
        const text = String(operand ?? '').replace(/\\\//g, '/');
        const short = text.length > 90 ? `${text.slice(0, 87)}…` : text;
        const words = { $regex: 'matches', $eq: 'is', $ne: 'is not', $in: 'is one of', $nin: 'is not one of' };
        return `${words[op] || op} ${short}`;
    },

    // The latest phase's coverage: a share of the users the targeting admits.
    rollout(experiment) {
        const coverage = this.latestPhase(experiment)?.coverage;
        return Number.isFinite(coverage) ? Math.round(coverage * 100) : null;
    },

    screenshots(experiment) {
        const variations = experiment.variations || [];
        // "Shot 2" only means something when some arm has more than one.
        const numbered = variations.some(v => (v.screenshots || []).filter(Boolean).length > 1);
        return variations.flatMap((variation, index) =>
            (variation.screenshots || []).filter(Boolean).map((url, shot) => ({
                arm: String.fromCharCode(65 + index),
                armLabel: variation.name || variation.key || `Variation ${index}`,
                viewport: null,
                pageState: numbered ? `Shot ${shot + 1}` : null,
                file: typeof url === 'string' ? url : url.path || url.url || ''
            }))).filter(s => s.file);
    },

    /**
     * Maps a GrowthBook experiment to the standardized shape.
     * @param {Object} experiment - Raw experiment, with `detailedResults`
     * @returns {Object} - Standardized experiment object
     */
    mapExperiment(experiment) {
        const experimentId = experiment.id || experiment.experimentId || experiment.key;
        const primaryMetric = this.metricFor(experiment, 'primary');
        const secondaryMetric = this.metricFor(experiment, 'secondary');
        const primary = primaryMetric ? this.compare(experiment, primaryMetric, 1) : null;
        const secondary = secondaryMetric ? this.compare(experiment, secondaryMetric, 1) : null;
        const settings = experiment.settings || {};
        const variations = experiment.variations || [];
        const additionalComparisons = variations.slice(2).map((variation, i) => {
            const index = i + 2;
            const extra = primaryMetric ? this.compare(experiment, primaryMetric, index) : null;
            const extraSecondary = secondaryMetric ? this.compare(experiment, secondaryMetric, index) : null;
            return {
                variationName: variation.name || variation.key || `Variation ${index}`,
                primaryMetric: extra?.lift ?? null,
                primaryMetricLabel: this.metricLabel(experiment, primaryMetric),
                primaryMetricType: this.metricType(primaryMetric),
                secondaryMetric: extraSecondary?.lift ?? null,
                secondaryMetricLabel: this.metricLabel(experiment, secondaryMetric),
                secondaryMetricType: this.metricType(secondaryMetric),
                pvalue: extra?.pvalue ?? null,
                secondaryPvalue: extraSecondary?.pvalue ?? null,
                sampleSize: extra?.sampleSize || 0
            };
        });
        const ownerEmail = experiment.ownerEmail || '';
        const rollout = this.rollout(experiment);

        return {
            id: experimentId || null,
            name: experiment.name || 'Untitled Experiment',
            ...this.dates(experiment),
            url: experimentId ? `https://app.growthbook.io/experiment/${experimentId}` : null,
            primaryMetric: primary?.lift ?? null,
            primaryMetricLabel: this.metricLabel(experiment, primaryMetric),
            primaryMetricType: this.metricType(primaryMetric),
            secondaryMetric: secondary?.lift ?? null,
            secondaryMetricLabel: this.metricLabel(experiment, secondaryMetric),
            secondaryMetricType: this.metricType(secondaryMetric),
            pvalue: primary?.pvalue ?? null,
            secondaryPvalue: secondary?.pvalue ?? null,
            sampleSize: primary?.sampleSize || this.resultsBlock(experiment)?.totalUsers || 0,
            baseRate: primary?.baseRate ?? null,
            primaryCV: primary?.cv ?? null,
            secondaryBaseRate: secondary?.baseRate || null,
            secondaryCV: secondary?.cv ?? null,
            // Iterations mean "a rerun of an earlier test", which GrowthBook
            // does not record; a name that says so ("[Retest]", "Rerun") counts.
            iterations: /\b(re-?test|re-?run)\b/i.test(experiment.name || '') ? 1 : 0,
            testMethod: this.extractTestMethod(experiment),
            // GrowthBook calls CUPED "regression adjustment".
            cuped: typeof settings.regressionAdjustmentEnabled === 'boolean' ? settings.regressionAdjustmentEnabled : null,
            triggered: this.triggers(experiment),
            traffic: rollout,
            reachLabel: 'rollout',
            reachNote: 'Share of targeted users the experiment included (GrowthBook’s coverage), not of all site visitors. GrowthBook does not report site traffic with the experiment.',
            trafficSubtitle: null,
            owner: MapperUtils.nameFromEmail(ownerEmail),
            ownerEmail,
            // What the variation did: GrowthBook carries this as the
            // experiment's description or hypothesis.
            change: experiment.description || experiment.hypothesis || '',
            decision: this.decision(experiment),
            screenshots: this.screenshots(experiment),
            additionalComparisons
        };
    },

    mapExperiments(experiments) {
        return MapperUtils.mapExperiments(this, experiments);
    },

    // 'fixed' | 'sequential' | 'bayesian' from the analysis settings, which
    // the experiment carries and its results repeat; null when neither says.
    extractTestMethod(experiment) {
        const settings = experiment.settings?.statsEngine
            ? experiment.settings
            : experiment.detailedResults?.result?.settings;
        if (settings?.statsEngine === 'bayesian') return 'bayesian';
        if (settings?.statsEngine !== 'frequentist') return null;
        return settings.sequentialTestingEnabled ? 'sequential' : 'fixed';
    }
};

if (typeof window !== 'undefined') {
    window.GrowthBookMapper = GrowthBookMapper;
}
