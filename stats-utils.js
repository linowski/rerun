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
 * The z-statistic for an observed effect at a given sample size -- the
 * shared core of both the fixed-horizon and mSPRT p-value calculations,
 * since mSPRT's always-valid p-value is built on top of the same z, not a
 * different test statistic.
 * @param {number} totalSampleSize - Total sample size across all arms
 * @param {string} metricType - 'binary' or 'continuous'
 * @param {number} observedEffect - Observed relative effect as percentage (e.g., 10 for +10%)
 * @param {number} baselineRate - Baseline conversion rate as percentage (default 5% for binary)
 * @returns {number|null} The z-statistic, or null if it can't be calculated
 */
function observedZStatistic(totalSampleSize, metricType, observedEffect, baselineRate = 5) {
    if (!totalSampleSize || totalSampleSize <= 0) return null;
    if (observedEffect === null || observedEffect === undefined) return null;

    const perArm = Math.floor(totalSampleSize / 2);

    if (metricType === 'binary') {
        const p1 = baselineRate / 100;
        const p2 = p1 * (1 + observedEffect / 100);
        const pPooled = (p1 + p2) / 2;
        const se = Math.sqrt(pPooled * (1 - pPooled) * (2 / perArm));
        if (se === 0) return null;
        return Math.abs(p2 - p1) / se;
    } else {
        // Continuous: treat observedEffect/100 as Cohen's d approximation
        const effectSize = Math.abs(observedEffect) / 100;
        const se = Math.sqrt(2 / perArm);
        if (se === 0) return null;
        return effectSize / se;
    }
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
    // No measured effect (e.g. a test with no secondary metric): nothing to test.
    if (observedEffect === null || observedEffect === undefined) return null;
    const z = observedZStatistic(totalSampleSize, metricType, observedEffect, baselineRate);
    if (z === null) return totalSampleSize > 0 ? 1 : null;
    return Math.max(0, 2 * (1 - normalCDF(z)));
}

/**
 * Always-valid p-value under the normal-mean mSPRT (mixture Sequential
 * Probability Ratio Test). Unlike a fixed-horizon p-value, this stays valid
 * (Type-I error controlled) no matter when you look, so peeking doesn't
 * inflate false positives the way it does under a plain z-test.
 *
 * Derived here directly from the closed-form mSPRT numerator for normal
 * data with a N(0, tau^2) mixing prior and known variance sigma^2, given in
 * Appendix A (eq. A.1) of Chen & Ye, "Sequential Test for Practical
 * Significance: Truncated Mixture Sequential Probability Ratio Test"
 * (arXiv:2509.07892), itself following Johari, Pekelis & Walsh, "Always
 * Valid Inference" (arXiv:1512.04922) and Robbins (1970). Dividing that
 * numerator by the null-hypothesis likelihood and writing n*xbar^2/sigma^2
 * as Z^2 (the ordinary z-statistic this file already computes) and
 * n*tau^2/sigma^2 as r, the sigma- and sample-dependent terms cancel
 * exactly, leaving:
 *
 *   Lambda = sqrt(1 / (1 + r)) * exp( r * Z^2 / (2 * (1 + r)) )
 *
 * and the always-valid p-value is p = min(1, 1 / Lambda) (arXiv:2509.07892
 * section 2.3). That paper's own simulations fix tau^2 to constants (e.g.
 * 0.01, 0.1, 1) "chosen before testing" and never let it depend on n --
 * which matters here because an earlier version of this function instead
 * computed r as "the z-score the MDE would produce at this experiment's own
 * sample size," which bakes n into r on top of the n already inside Z, so r
 * collapsed toward 0 for small samples -- a large observed effect on a
 * small sample then produced a p-value near 1 (a 196% lift read as p=0.75),
 * the opposite of what the test is supposed to do.
 *
 * r=1 is a fixed, moderate default, not tied to any one test's sample size
 * or MDE. Spotify's engineering writeup on choosing a sequential testing
 * framework (Mattsson & Lo, 2023, engineering.atspotify.com/2023/03) found
 * mSPRT's power "relatively stable across different choices" of this
 * tuning parameter, and that the false-positive guarantee holds regardless
 * of the value picked -- a badly chosen constant costs power, not
 * validity, and using the sample size to choose it "gives up the benefit
 * of not needing" one in the first place.
 * @param {number} z - The observed z-statistic (from observedZStatistic)
 * @param {number} r - Mixing-to-sample variance ratio (fixed constant, r > 0)
 * @returns {number} Always-valid p-value (0 to 1)
 */
function mSprtPValue(z, r = 1) {
    if (z === null || !Number.isFinite(z)) return null;
    if (!r || r <= 0) return null;
    const logLambda = -0.5 * Math.log(1 + r) + (r * z * z) / (2 * (1 + r));
    const lambda = Math.exp(logLambda);
    return Math.max(0, Math.min(1, 1 / lambda));
}

/**
 * mSPRT always-valid p-value from the same observed-effect inputs as
 * recalculatePValue. Unlike fixed-horizon power/p-value, this does NOT
 * take an MDE parameter -- see mSprtPValue's comment on why r must stay a
 * fixed constant rather than being calibrated per experiment.
 * @param {number} totalSampleSize - Total sample size across all arms
 * @param {string} metricType - 'binary' or 'continuous'
 * @param {number} observedEffect - Observed relative effect as percentage
 * @param {number} baselineRate - Baseline conversion rate as percentage
 * @returns {number|null} Always-valid p-value, or null if it can't be calculated
 */
function recalculateSequentialPValue(totalSampleSize, metricType, observedEffect, baselineRate = 5) {
    if (observedEffect === null || observedEffect === undefined) return null;
    const z = observedZStatistic(totalSampleSize, metricType, observedEffect, baselineRate);
    if (z === null) return totalSampleSize > 0 ? 1 : null;
    return mSprtPValue(z);
}

/**
 * Power under sequential (mSPRT) testing has no clean closed form the way
 * fixed-horizon power does -- Johari et al. show the mSPRT needs roughly
 * 1.2x-1.4x the fixed-horizon sample size for the same power, since it
 * spends some of its error budget on being valid at every intermediate
 * look, not just the final one. Rather than inventing a bespoke formula,
 * this applies that documented inflation factor to the existing
 * fixed-horizon calculation: it's an approximation, not an exact result,
 * and is labeled as such everywhere it's shown.
 */
const SEQUENTIAL_SAMPLE_SIZE_INFLATION = 1.3;

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
