/**
 * ABsmartly API Mapper
 * Maps ABsmartly API responses to our standardized experiment data format.
 */

const ABsmartlyMapper = MapperUtils.createExperimentMapper({
    nameFields: ['name', 'experimentName'],
    sampleSizeFields: ['units', 'exposures'],
    pvalueFields: ['pValue', 'p_value', 'pvalue'],
    powerFields: ['power'],
    ownerFields: ['createdBy', 'owner'],
    changeFields: ['description', 'hypothesis'],
    // Platforms rarely expose a clean shipped/won status; these are the
    // plausible field names, normalized by MapperUtils.normalizeDecision.
    decisionFields: ['decision', 'status', 'result', 'winner'],
    binaryKeywords: ['event'],
    trafficFields: [
        { field: 'trafficAllocation', scale: 100 },
        { field: 'allocation', scale: 1 }
    ],

    iterations(experiment) {
        return experiment.variants?.length > 2 ? 1 : 0;
    },

    // Structured trigger types: always a page visit; add interaction when audience-scoped.
    triggered(experiment) {
        const types = [{ type: 'page' }];
        if (experiment.audiences) types.push({ type: 'interaction' });
        return types;
    },

    trafficSubtitle(experiment) {
        return experiment.audienceDescription || null;
    },

    metricValue(experiment, metricType) {
        const results = experiment.results || experiment.stats;
        const metric = (results?.metrics || [])[MapperUtils.metricIndex(metricType)];
        return MapperUtils.percentFromRatio(
            MapperUtils.firstNumber(metric, ['effect', 'lift'])
        );
    },

    metricLabel(experiment, metricType) {
        const metric = (experiment.goals || experiment.metrics || [])[MapperUtils.metricIndex(metricType)];
        return MapperUtils.firstValue(
            metric,
            ['name', 'metricName'],
            metricType === 'primary' ? 'conversions' : 'revenue'
        );
    }
});

if (typeof window !== 'undefined') {
    window.ABsmartlyMapper = ABsmartlyMapper;
}
