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

    // Whether a saved experiment's results may be out of date.
    changed(fresh, saved) {
        return (fresh.dateUpdated || '') !== (saved.dateUpdated || '');
    },

    /**
     * Maps a GrowthBook experiment to our standard format
     * @param {Object} experiment - Raw experiment object from GrowthBook API
     * @returns {Object} - Standardized experiment object
     */
    mapExperiment(experiment) {
        const experimentId = experiment.id || experiment.experimentId || experiment.key;
        const variationCount = experiment.variations?.length || 2;

        // Build additional comparisons for variations beyond B (index 2, 3, ...)
        const additionalComparisons = [];
        if (variationCount > 2) {
            for (let i = 2; i < variationCount; i++) {
                const varName = experiment.variations[i]?.name ||
                                experiment.variations[i]?.key ||
                                `Variation ${i}`;
                additionalComparisons.push({
                    variationName: varName,
                    primaryMetric: this.extractMetricValue(experiment, 'primary', i),
                    primaryMetricLabel: this.extractMetricLabel(experiment, 'primary'),
                    primaryMetricType: this.determineMetricType(experiment, 'primary'),
                    secondaryMetric: this.extractMetricValue(experiment, 'secondary', i),
                    secondaryMetricLabel: this.extractMetricLabel(experiment, 'secondary'),
                    secondaryMetricType: this.determineMetricType(experiment, 'secondary'),
                    pvalue: this.extractPValue(experiment, i),
                    sampleSize: this.extractSampleSize(experiment, i),
                    power: null
                });
            }
        }

        return {
            id: experimentId || null,
            name: experiment.name || 'Untitled Experiment',
            url: experimentId ? `https://app.growthbook.io/experiment/${experimentId}` : null,
            primaryMetric: this.extractMetricValue(experiment, 'primary'),
            primaryMetricLabel: this.extractMetricLabel(experiment, 'primary'),
            primaryMetricType: this.determineMetricType(experiment, 'primary'),
            secondaryMetric: this.extractMetricValue(experiment, 'secondary'),
            secondaryMetricLabel: this.extractMetricLabel(experiment, 'secondary'),
            secondaryMetricType: this.determineMetricType(experiment, 'secondary'),
            sampleSize: this.extractSampleSize(experiment),
            baseRate: this.extractBaseRate(experiment),
            power: null,
            pvalue: this.extractPValue(experiment),
            iterations: variationCount - 1,
            testMethod: this.extractTestMethod(experiment),
            triggered: experiment.targeting ? [{ type: 'page' }, { type: 'interaction' }] : [{ type: 'page' }],
            traffic: this.calculateTrafficPercentage(experiment),
            trafficSubtitle: experiment.targetingDescription || null,
            owner: experiment.owner?.name || experiment.createdBy || '',
            // What the variation did: GrowthBook carries this as the experiment's
            // description or hypothesis.
            change: experiment.description || experiment.hypothesis || '',
            // GrowthBook reports a ship decision as resultsStatus.status once an
            // experiment has been analyzed ('won' | 'lost' | 'inconclusive' |
            // 'dnf'); MapperUtils normalizes that to 'Shipped' or blank.
            decision: MapperUtils.normalizeDecision(experiment.resultsStatus?.status),
            additionalComparisons: additionalComparisons
        };
    },

    /**
     * Maps an array of GrowthBook experiments
     * @param {Array} experiments - Array of raw experiments from GrowthBook API
     * @returns {Array} - Array of standardized experiment objects
     */
    mapExperiments(experiments) {
        return MapperUtils.mapExperiments(this, experiments);
    },

    /**
     * Extract metric value (percentage change)
     */
    extractMetricValue(experiment, metricType, variationIndex = 1) {
        // Prioritize detailedResults if available
        if (experiment.detailedResults?.result?.results) {
            const results = experiment.detailedResults.result.results;

            if (Array.isArray(results) && results.length > 0) {
                const firstResult = results[0];

                // Determine which metric index to use (0 = primary, 1 = secondary)
                const metricIndex = metricType === 'primary' ? 0 : 1;

                if (firstResult.metrics && firstResult.metrics[metricIndex]) {
                    const metric = firstResult.metrics[metricIndex];

                    if (metric.variations && metric.variations.length > variationIndex) {
                        const variation = metric.variations[variationIndex];

                        if (variation.analyses && variation.analyses.length > 0) {
                            const analysis = variation.analyses[0];

                            if (analysis.percentChange !== null && analysis.percentChange !== undefined) {
                                return Math.round(analysis.percentChange * 100 * 1000) / 1000;
                            }
                        }
                    }
                }
            }
        }

        // Fallback to basic results
        const results = experiment.results?.[0];
        if (results) {
            const change = results.change || results.lift || 0;
            return Math.round(change * 100);
        }

        // Return null if no data available
        return null;
    },

    /**
     * Extract metric label (e.g., "sales", "revenue")
     */
    extractMetricLabel(experiment, metricType) {
        if (metricType === 'primary') {
            return experiment.metrics?.[0]?.name || experiment.goalMetric || 'conversions';
        } else {
            return experiment.metrics?.[1]?.name || experiment.secondaryMetric || 'revenue';
        }
    },

    /**
     * Determine if metric is binary or continuous
     */
    determineMetricType(experiment, metricType) {
        return MapperUtils.determineMetricType(this.extractMetricLabel(experiment, metricType));
    },

    // calculatePower provided by stats-utils.js

    /**
     * Calculate traffic percentage
     */
    calculateTrafficPercentage(experiment) {
        if (experiment.coverage) {
            return Math.round(experiment.coverage * 100);
        }
        if (experiment.trafficSplit) {
            return Math.round(experiment.trafficSplit.control + experiment.trafficSplit.variation);
        }
        // Return null if no data available
        return null;
    },

    /**
     * Extract p-value from detailed results
     */
    extractPValue(experiment, variationIndex = 1) {
        // Prioritize detailedResults if available
        if (experiment.detailedResults?.result?.results) {
            const results = experiment.detailedResults.result.results;

            if (Array.isArray(results) && results.length > 0) {
                const firstResult = results[0];

                // Use primary metric (index 0)
                if (firstResult.metrics && firstResult.metrics[0]) {
                    const metric = firstResult.metrics[0];

                    if (metric.variations && metric.variations.length > variationIndex) {
                        const variation = metric.variations[variationIndex];

                        if (variation.analyses && variation.analyses.length > 0) {
                            const analysis = variation.analyses[0];

                            // Try direct pValue first (but skip if it's 0, which means Bayesian stats)
                            if (analysis.pValue && analysis.pValue > 0) {
                                return analysis.pValue;
                            }
                            if (analysis.p && analysis.p > 0) {
                                return analysis.p;
                            }

                            // Calculate from chanceToBeatControl (for Bayesian stats)
                            if (analysis.chanceToBeatControl !== null && analysis.chanceToBeatControl !== undefined) {
                                const chance = analysis.chanceToBeatControl;
                                // Two-tailed approximation: 2 * min(chance, 1-chance)
                                return 2 * Math.min(chance, 1 - chance);
                            }
                        }
                    }
                }
            }
        }

        // Fallback to basic results
        return experiment.results?.[0]?.pValue || experiment.pValue || null;
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
    },

    /**
     * Extract sample size from detailed results
     */
    extractSampleSize(experiment, variationIndex = 1) {
        // Prioritize detailedResults if available
        if (experiment.detailedResults?.result?.results) {
            const results = experiment.detailedResults.result.results;

            if (Array.isArray(results) && results.length > 0) {
                const firstResult = results[0];

                // For specific variation: sum control (0) + that variation
                if (variationIndex > 1 && firstResult.metrics && firstResult.metrics[0]) {
                    const metric = firstResult.metrics[0];
                    if (metric.variations) {
                        const controlUsers = metric.variations[0]?.users || 0;
                        const varUsers = metric.variations[variationIndex]?.users || 0;
                        if (controlUsers + varUsers > 0) return controlUsers + varUsers;
                    }
                }

                // Use totalUsers from the first result (for default/primary variation)
                if (firstResult.totalUsers) {
                    return firstResult.totalUsers;
                }

                // Fallback: sum users from primary metric variations
                if (firstResult.metrics && firstResult.metrics[0]) {
                    const metric = firstResult.metrics[0];

                    if (metric.variations) {
                        const totalUsers = metric.variations.reduce((sum, v) => sum + (v.users || 0), 0);
                        if (totalUsers > 0) return totalUsers;
                    }
                }
            }
        }

        // Fallback to basic fields
        return experiment.users || experiment.observations || 0;
    },

    /**
     * Extract baseline conversion rate from control variation
     * @returns {number} Base rate as percentage (e.g., 5 for 5%), or null
     */
    extractBaseRate(experiment) {
        if (experiment.detailedResults?.result?.results) {
            const results = experiment.detailedResults.result.results;
            if (Array.isArray(results) && results.length > 0) {
                const firstResult = results[0];
                if (firstResult.metrics && firstResult.metrics[0]) {
                    const metric = firstResult.metrics[0];
                    // Control is variation index 0
                    if (metric.variations && metric.variations[0]) {
                        const control = metric.variations[0];
                        if (control.cr !== undefined && control.cr !== null) {
                            return Math.round(control.cr * 100 * 100) / 100;
                        }
                        if (control.mean !== undefined && control.mean !== null) {
                            return Math.round(control.mean * 100 * 100) / 100;
                        }
                    }
                }
            }
        }
        return null;
    }
};

if (typeof window !== 'undefined') {
    window.GrowthBookMapper = GrowthBookMapper;
}
