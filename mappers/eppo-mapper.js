/**
 * Eppo API Mapper
 * Maps Eppo API responses to our standardized experiment data format.
 */

const EppoMapper = MapperUtils.createExperimentMapper({
    nameFields: ['name', 'flagKey'],
    sampleSizeFields: ['subjects', 'assignments'],
    pvalueFields: ['pValue', 'pvalue', 'p_value'],
    powerFields: ['power'],
    ownerFields: ['owner', 'createdBy'],
    changeFields: ['description', 'hypothesis'],
    // Platforms rarely expose a clean shipped/won status; these are the
    // plausible field names, normalized by MapperUtils.normalizeDecision.
    decisionFields: ['decision', 'status', 'result', 'winner'],
    binaryKeywords: ['flag'],
    trafficFields: [
        { field: 'percentageExposed', scale: 1 },
        { field: 'allocationPercent', scale: 1 }
    ],

    iterations(experiment) {
        return experiment.variations?.length > 2 ? 1 : 0;
    },

    // Structured trigger types: always a page visit; add interaction when targeted.
    triggered(experiment) {
        const types = [{ type: 'page' }];
        if (experiment.targeting) types.push({ type: 'interaction' });
        return types;
    },

    trafficSubtitle(experiment) {
        return experiment.targetingRules || null;
    },

    metricValue(experiment, metricType) {
        const analysis = experiment.analysis || experiment.results;
        const metric = (analysis?.metrics || [])[MapperUtils.metricIndex(metricType)];
        return MapperUtils.percentFromRatio(
            MapperUtils.firstNumber(metric, ['lift', 'relativeChange'])
        );
    },

    metricLabel(experiment, metricType) {
        const metrics = metricType === 'primary'
            ? experiment.primaryMetrics || []
            : experiment.secondaryMetrics || [];
        const fallbackMetrics = experiment.primaryMetrics || experiment.secondaryMetrics || [];
        const metric = metrics[0] || fallbackMetrics[MapperUtils.metricIndex(metricType)];
        return MapperUtils.firstValue(
            metric,
            ['name', 'metricKey'],
            metricType === 'primary' ? 'conversions' : 'revenue'
        );
    }
});

if (typeof window !== 'undefined') {
    window.EppoMapper = EppoMapper;
}
