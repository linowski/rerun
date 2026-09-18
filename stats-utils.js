// ============================================
// STATISTICAL UTILITY FUNCTIONS
// Power calculations adapted from changeandmeasure project
// ============================================

/**
 * Error function approximation (Abramowitz and Stegun)
 */
function erf(x) {
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return sign * y;
}

/**
 * Standard normal cumulative distribution function
 */
function normalCDF(z) {
    return 0.5 * (1 + erf(z / Math.sqrt(2)));
}

/**
 * Inverse normal CDF (Z-score for a given probability)
 */
function getZScore(p) {
    if (p <= 0 || p >= 1) return 0;

    const a = [2.515517, 0.802853, 0.010328];
    const b = [1.432788, 0.189269, 0.001308];

    let t = Math.sqrt(-2 * Math.log(Math.min(p, 1 - p)));
    let z = t - (a[0] + a[1] * t + a[2] * t * t) /
               (1 + b[0] * t + b[1] * t * t + b[2] * t * t * t);

    return p < 0.5 ? -z : z;
}

/**
 * Calculate power given sample size for binary metrics
 * @param {number} sampleSize - Sample size per group (per arm)
 * @param {number} p1 - Baseline conversion rate as decimal (e.g., 0.10)
 * @param {number} p2 - Treatment conversion rate as decimal (e.g., 0.12)
 * @param {number} alpha - Significance level (default 0.05)
 * @returns {number} Power as decimal (0 to 1)
 */
function calculateBinaryPower(sampleSize, p1, p2, alpha = 0.05) {
    const Z_alpha = getZScore(1 - alpha / 2);

    const effectiveDiff = Math.abs(p2 - p1);
    const p_pooled = (p1 + p2) / 2;
    const numerator = Math.sqrt(sampleSize) * effectiveDiff;
    const denominator = Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));

    const Z_beta = numerator / denominator - Z_alpha * Math.sqrt(2 * p_pooled * (1 - p_pooled)) / denominator;

    return Math.max(0, Math.min(1, normalCDF(Z_beta)));
}

/**
 * Calculate power given sample size for continuous metrics
 * @param {number} sampleSize - Sample size per group (per arm)
 * @param {number} effectSize - Cohen's d (mean difference / standard deviation)
 * @param {number} alpha - Significance level (default 0.05)
 * @returns {number} Power as decimal (0 to 1)
 */
function calculateContinuousPower(sampleSize, effectSize, alpha = 0.05) {
    const Z_alpha = getZScore(1 - alpha / 2);
    const Z_beta = Math.sqrt(sampleSize * Math.pow(effectSize, 2) / 2) - Z_alpha;
    return Math.max(0, Math.min(1, normalCDF(Z_beta)));
}

/**
 * Recalculate p-value from observed effect, sample size, and assumed baseline
 * @param {number} totalSampleSize - Total sample size across all arms
 * @param {string} metricType - 'binary' or 'continuous'
 * @param {number} observedEffect - Observed relative effect as percentage (e.g., 10 for +10%)
 * @param {number} baselineRate - Baseline conversion rate as percentage (default 5% for binary)
 * @returns {number} Two-tailed p-value, or null if can't calculate
 */
function recalculatePValue(totalSampleSize, metricType, observedEffect, baselineRate = 5) {
    if (!totalSampleSize || totalSampleSize <= 0) return null;
    if (observedEffect === null || observedEffect === undefined) return null;

    const perArm = Math.floor(totalSampleSize / 2);

    if (metricType === 'binary') {
        const p1 = baselineRate / 100;
        const p2 = p1 * (1 + observedEffect / 100);
        const pPooled = (p1 + p2) / 2;
        const se = Math.sqrt(pPooled * (1 - pPooled) * (2 / perArm));
        if (se === 0) return 1;
        const z = Math.abs(p2 - p1) / se;
        return Math.max(0, 2 * (1 - normalCDF(z)));
    } else {
        // Continuous: treat observedEffect/100 as Cohen's d approximation
        const effectSize = Math.abs(observedEffect) / 100;
        const se = Math.sqrt(2 / perArm);
        if (se === 0) return 1;
        const z = effectSize / se;
        return Math.max(0, 2 * (1 - normalCDF(z)));
    }
}

/**
 * Standard normal probability density function
 */
function normalPDF(z) {
    return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/**
 * Type M error (exaggeration ratio) — Gelman & Carlin / Kohavi
 * Expected magnitude of significant estimate relative to true effect.
 * @param {number} power - Power as decimal (0-1)
 * @param {number} alpha - Significance level (default 0.05)
 * @returns {number} Exaggeration ratio (1.0 = no exaggeration)
 */
function typeM(power, alpha = 0.05) {
    if (power === null || power <= 0) return null;
    const zCrit = getZScore(1 - alpha / 2);
    // Non-centrality parameter from power: λ = zCrit + z_β
    const zBeta = getZScore(power);
    const lambda = zCrit + zBeta;
    if (lambda <= 0) return null;

    // E[|Z| | |Z| > zCrit] where Z ~ N(λ, 1)
    // = [λ·Φ(λ-zCrit) + φ(zCrit-λ) + λ·Φ(-λ-zCrit) + φ(zCrit+λ)] / [Φ(λ-zCrit) + Φ(-λ-zCrit)]
    // Denominator is power (by definition)
    const num = lambda * normalCDF(lambda - zCrit) + normalPDF(zCrit - lambda)
              + lambda * normalCDF(-lambda - zCrit) + normalPDF(zCrit + lambda);
    const denom = normalCDF(lambda - zCrit) + normalCDF(-lambda - zCrit);
    if (denom <= 0) return null;
    return (num / denom) / lambda;
}

/**
 * Type S error (wrong sign probability) — Gelman & Carlin / Kohavi
 * Probability that a significant result has the wrong sign.
 * @param {number} power - Power as decimal (0-1)
 * @param {number} alpha - Significance level (default 0.05)
 * @returns {number} Probability (0-1)
 */
function typeS(power, alpha = 0.05) {
    if (power === null || power <= 0) return null;
    const zCrit = getZScore(1 - alpha / 2);
    const zBeta = getZScore(power);
    const lambda = zCrit + zBeta;
    if (lambda <= 0) return null;

    // P(wrong sign | significant) = Φ(-λ - zCrit) / [Φ(λ - zCrit) + Φ(-λ - zCrit)]
    const denom = normalCDF(lambda - zCrit) + normalCDF(-lambda - zCrit);
    if (denom <= 0) return null;
    return normalCDF(-lambda - zCrit) / denom;
}

function recalculatePower(totalSampleSize, metricType, relativeMDE = 2, baselineRate = 5) {
    if (!totalSampleSize || totalSampleSize <= 0) return null;

    const perArm = Math.floor(totalSampleSize / 2);

    if (metricType === 'binary') {
        const p1 = baselineRate / 100;
        const p2 = p1 * (1 + relativeMDE / 100);
        const power = calculateBinaryPower(perArm, p1, p2);
        return Math.round(power * 100);
    } else {
        // For continuous metrics, convert relative MDE to Cohen's d
        // Assume CV ~= 1 for revenue-like metrics (sd ≈ mean)
        const effectSize = relativeMDE / 100;
        const power = calculateContinuousPower(perArm, effectSize);
        return Math.round(power * 100);
    }
}
