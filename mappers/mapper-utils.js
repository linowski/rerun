/**
 * Shared helpers for platform API mappers.
 */

const MapperUtils = {
    binaryKeywords: ['conversion', 'click', 'signup', 'purchase', 'sale', 'visit', 'cart'],

    metricIndex(metricType) {
        return metricType === 'primary' ? 0 : 1;
    },

    mapExperiments(mapper, experiments) {
        if (!Array.isArray(experiments)) {
            return [];
        }
        return experiments.map(exp => mapper.mapExperiment(exp));
    },

    firstValue(source, fields, fallback = null) {
        if (!source) return fallback;
        for (const field of fields) {
            const value = source[field];
            if (value !== null && value !== undefined && value !== '') {
                return value;
            }
        }
        return fallback;
    },

    firstNumber(source, fields, fallback = null) {
        const value = this.firstValue(source, fields, null);
        if (value === null) return fallback;
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    },

    normalizePower(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        if (!Number.isFinite(number)) return null;
        return Math.round(number <= 1 ? number * 100 : number);
    },

    normalizePValue(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        if (!Number.isFinite(number)) return null;
        return number >= 0 && number <= 1 ? number : null;
    },

    // Platforms spell a "shipped" decision differently (won/ship-it/live/etc.);
    // normalize to 'Shipped' when the platform says so, and leave everything
    // else -- still running, inconclusive, explicitly not shipped, or simply
    // not reported -- blank rather than guessing a specific label. The app's
    // own filtering treats "not Shipped" (including blank) as not shipped.
    normalizeDecision(value) {
        const text = String(value || '').toLowerCase();
        if (!text) return '';
        const shipped = ['ship', 'shipped', 'won', 'win', 'live', 'launched', 'rolled out'];
        return shipped.some(keyword => text.includes(keyword)) ? 'Shipped' : '';
    },

    percentFromRatio(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? Math.round(number * 100) : null;
    },

    determineMetricType(label, extraKeywords = []) {
        const metricName = (label || '').toLowerCase();
        const keywords = this.binaryKeywords.concat(extraKeywords);
        return keywords.some(keyword => metricName.includes(keyword)) ? 'binary' : 'continuous';
    },

    trafficPercent(source, fieldConfigs) {
        for (const config of fieldConfigs) {
            const value = this.firstNumber(source, [config.field], null);
            if (value !== null) {
                return Math.round(value * (config.scale || 1));
            }
        }
        return null;
    },

    createExperimentMapper(config) {
        const mapper = {
            mapExperiment(experiment) {
                return {
                    name: MapperUtils.firstValue(experiment, config.nameFields, 'Untitled Experiment'),
                    primaryMetric: this.extractMetricValue(experiment, 'primary'),
                    primaryMetricLabel: this.extractMetricLabel(experiment, 'primary'),
                    primaryMetricType: this.determineMetricType(experiment, 'primary'),
                    secondaryMetric: this.extractMetricValue(experiment, 'secondary'),
                    secondaryMetricLabel: this.extractMetricLabel(experiment, 'secondary'),
                    secondaryMetricType: this.determineMetricType(experiment, 'secondary'),
                    sampleSize: MapperUtils.firstNumber(experiment, config.sampleSizeFields, 0),
                    power: this.calculatePower(experiment),
                    pvalue: MapperUtils.normalizePValue(MapperUtils.firstValue(experiment, config.pvalueFields, null)),
                    iterations: config.iterations(experiment),
                    triggered: config.triggered(experiment),
                    traffic: this.calculateTrafficPercentage(experiment),
                    trafficSubtitle: config.trafficSubtitle(experiment),
                    owner: MapperUtils.firstValue(experiment, config.ownerFields, ''),
                    // What the variation actually did. Platforms carry this as a
                    // description or hypothesis; blank when they carry neither.
                    change: MapperUtils.firstValue(experiment, config.changeFields || [], ''),
                    // Whether the experiment shipped. Blank when the platform has
                    // no ship/won-style status to report.
                    decision: MapperUtils.normalizeDecision(
                        MapperUtils.firstValue(experiment, config.decisionFields || [], '')
                    )
                };
            },

            mapExperiments(experiments) {
                return MapperUtils.mapExperiments(this, experiments);
            },

            extractMetricValue(experiment, metricType) {
                return config.metricValue(experiment, metricType);
            },

            extractMetricLabel(experiment, metricType) {
                return config.metricLabel(experiment, metricType);
            },

            determineMetricType(experiment, metricType) {
                return MapperUtils.determineMetricType(
                    this.extractMetricLabel(experiment, metricType),
                    config.binaryKeywords || []
                );
            },

            calculatePower(experiment) {
                return MapperUtils.normalizePower(MapperUtils.firstValue(experiment, config.powerFields, null));
            },

            calculateTrafficPercentage(experiment) {
                return MapperUtils.trafficPercent(experiment, config.trafficFields);
            }
        };

        return mapper;
    }
};

if (typeof window !== 'undefined') {
    window.MapperUtils = MapperUtils;
}
