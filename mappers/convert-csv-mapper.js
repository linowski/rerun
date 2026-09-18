/**
 * Convert CSV Mapper
 * Maps Convert.com aggregated report CSV exports to our standardized experiment data format
 *
 * Expected CSV columns from Convert export:
 * - projectId, projectName
 * - experienceId, experienceName
 * - goalId
 * - variationId, variationName (A = Control, B = Variation)
 * - visitors, conversions, conversion_rate
 * - total_revenue, revenue_per_visitor
 */

const ConvertCSVMapper = {
    /**
     * Parse CSV content into experiment data
     * @param {string} csvContent - Raw CSV string
     * @param {string} accountId - Convert account ID for URL generation
     * @returns {Array} - Array of standardized experiment objects
     */
    parseCSV(csvContent, accountId = '') {
        const lines = csvContent.trim().split('\n');
        if (lines.length < 2) return [];

        const headers = this.parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
        const rows = [];

        for (let i = 1; i < lines.length; i++) {
            const values = this.parseCSVLine(lines[i]);
            if (values.length !== headers.length) continue;

            const row = {};
            headers.forEach((header, index) => {
                row[header] = values[index].trim();
            });
            rows.push(row);
        }

        return this.mapRows(rows, accountId);
    },

    /**
     * Parse a CSV line handling quoted values
     * @param {string} line - Single CSV line
     * @returns {Array} - Array of values
     */
    parseCSVLine(line) {
        const values = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                values.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        values.push(current);
        return values;
    },

    /**
     * Map CSV rows to standardized experiment format
     * Groups rows by experience and goal, then calculates metrics
     * @param {Array} rows - Array of parsed CSV row objects
     * @param {string} accountId - Convert account ID for URL generation
     * @returns {Array} - Array of standardized experiment objects
     */
    mapRows(rows, accountId = '') {
        // Group rows by experienceId and goalId
        const grouped = {};

        rows.forEach(row => {
            const expId = row.experienceid || row.experience_id || '';
            const goalId = row.goalid || row.goal_id || '';
            const key = `${expId}_${goalId}`;

            if (!grouped[key]) {
                grouped[key] = {
                    experienceId: expId,
                    experienceName: row.experiencename || row.experience_name || '',
                    projectId: row.projectid || row.project_id || '',
                    projectName: row.projectname || row.project_name || '',
                    goalId: goalId,
                    variations: []
                };
            }

            grouped[key].variations.push({
                variationId: row.variationid || row.variation_id || '',
                variationName: (row.variationname || row.variation_name || '').toUpperCase(),
                visitors: parseInt(row.visitors || 0),
                conversions: parseInt(row.conversions || 0),
                conversionRate: parseFloat(row.conversion_rate || row.conversionrate || 0),
                totalRevenue: parseFloat(row.total_revenue || row.totalrevenue || 0),
                revenuePerVisitor: parseFloat(row.revenue_per_visitor || row.revenuepervisitor || 0)
            });
        });

        // Convert grouped data to experiments
        // Use the first goal (primary) for each experience
        const experimentsByExpId = {};

        Object.values(grouped).forEach(group => {
            const expId = group.experienceId;

            // Find control (A)
            const control = group.variations.find(v =>
                v.variationName === 'A' ||
                v.variationName.includes('CONTROL') ||
                v.variationName.includes('ORIGINAL')
            ) || group.variations[0];

            // Find primary variation (B): prefer the first non-control arm with usable sample.
            const nonControlVariations = group.variations.filter(v => v !== control);
            const variation = nonControlVariations.find(v => control.visitors + v.visitors > 0)
                || nonControlVariations[0];

            if (!control || !variation) return;

            const sampleSize = control.visitors + variation.visitors;
            if (sampleSize <= 0) return;

            // Calculate effect size (percentage change) for primary A vs B
            const primaryMetric = this.calculatePercentChange(
                control.conversionRate,
                variation.conversionRate
            );

            const secondaryMetric = this.calculatePercentChange(
                control.revenuePerVisitor,
                variation.revenuePerVisitor
            );

            // pvalue recalculated by stats-utils.js in generateTableRows
            const pvalue = null;

            // Build additional comparisons for C, D, E... variations
            const additionalComparisons = nonControlVariations.filter(v => {
                if (v === variation) return false;
                return control.visitors + v.visitors > 0;
            }).map(v => {
                return {
                    variationName: v.variationName || v.variationId,
                    primaryMetric: this.calculatePercentChange(control.conversionRate, v.conversionRate),
                    primaryMetricLabel: 'conversions',
                    primaryMetricType: 'binary',
                    secondaryMetric: this.calculatePercentChange(control.revenuePerVisitor, v.revenuePerVisitor),
                    secondaryMetricLabel: 'revenue/visitor',
                    secondaryMetricType: 'continuous',
                    pvalue: null,
                    sampleSize: control.visitors + v.visitors,
                    power: null
                };
            });

            // Create or update experiment entry
            if (!experimentsByExpId[expId]) {
                // Generate Convert app URL
                const url = accountId && group.projectId && expId
                    ? `https://app.convert.com/accounts/${accountId}/projects/${group.projectId}/experiences/${expId}/report`
                    : '';

                experimentsByExpId[expId] = {
                    id: expId,
                    name: group.experienceName || `Experiment ${expId}`,
                    url: url,
                    projectId: group.projectId,
                    projectName: group.projectName,
                    primaryMetric: primaryMetric,
                    primaryMetricLabel: 'conversions',
                    primaryMetricType: 'binary',
                    secondaryMetric: secondaryMetric,
                    secondaryMetricLabel: 'revenue/visitor',
                    secondaryMetricType: 'continuous',
                    pvalue: pvalue,
                    sampleSize: sampleSize,
                    baseRate: control.conversionRate,
                    power: null,
                    // Convert's aggregated CSV lists variation arms, not test iteration history.
                    // Default imported experiments to first-time unless a future export field says otherwise.
                    iterations: 0,
                    triggered: [],
                    traffic: null,
                    owner: '',
                    // The aggregated CSV export carries no description column,
                    // so there is nothing to populate Change with.
                    change: '',
                    // Nor a ship-decision column, for the same reason.
                    decision: '',
                    additionalComparisons: additionalComparisons,
                    // Store raw data for reference
                    _rawData: {
                        control: control,
                        variation: variation,
                        goalId: group.goalId
                    }
                };
            }
        });

        return Object.values(experimentsByExpId);
    },

    /**
     * Calculate percentage change between control and variation
     * @param {number} controlValue - Control metric value
     * @param {number} variationValue - Variation metric value
     * @returns {number} - Percentage change (rounded to 2 decimals)
     */
    calculatePercentChange(controlValue, variationValue) {
        if (!controlValue || controlValue === 0) return 0;
        const change = ((variationValue - controlValue) / controlValue) * 100;
        return Math.round(change * 100) / 100;
    },

    // power, pvalue, normalCDF, calculatePower provided by stats-utils.js
};

// Export for use in browser
if (typeof window !== 'undefined') {
    window.ConvertCSVMapper = ConvertCSVMapper;
}
