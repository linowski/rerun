/**
 * Convert.com API Mapper
 * Maps Convert.com API responses to our standardized experiment data format.
 */

const ConvertMapper = MapperUtils.createExperimentMapper({
    nameFields: ['name', 'test_name'],
    sampleSizeFields: ['visitors', 'sessions'],
    pvalueFields: ['p_value', 'pValue', 'pvalue', 'significance'],
    powerFields: ['statistical_power', 'power'],
    ownerFields: ['owner', 'created_by'],
    changeFields: ['description', 'test_description', 'hypothesis'],
    // Platforms rarely expose a clean shipped/won status; these are the
    // plausible field names, normalized by MapperUtils.normalizeDecision.
    decisionFields: ['decision', 'status', 'result', 'winner'],
    binaryKeywords: ['goal'],
    trafficFields: [
        { field: 'traffic_allocation', scale: 100 },
        { field: 'included_traffic', scale: 1 }
    ],

    iterations(experiment) {
        return experiment.variations?.length > 2 ? 1 : 0;
    },

    // Structured trigger types: always a page visit; add interaction on click triggers.
    triggered(experiment) {
        const types = [{ type: 'page' }];
        if (experiment.trigger_type === 'click') types.push({ type: 'interaction' });
        return types;
    },

    trafficSubtitle(experiment) {
        return experiment.location_description || null;
    },

    metricValue(experiment, metricType) {
        const goal = (experiment.goals || [])[MapperUtils.metricIndex(metricType)];
        return MapperUtils.percentFromRatio(
            MapperUtils.firstNumber(goal, ['improvement', 'conversion_rate_lift'])
        );
    },

    metricLabel(experiment, metricType) {
        const goal = (experiment.goals || [])[MapperUtils.metricIndex(metricType)];
        return MapperUtils.firstValue(
            goal,
            ['name', 'goal_name'],
            metricType === 'primary' ? 'conversions' : 'revenue'
        );
    }
});

if (typeof window !== 'undefined') {
    window.ConvertMapper = ConvertMapper;
}
