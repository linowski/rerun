/**
 * Group sequential test designs (depends on stats-utils.js).
 * Used by: index.html (Method = Group sequential). Shared with changeandmeasure (components/); keep in step.
 *
 * One-sided at alpha / 2 (so it lines up with a two-sided test that only ships wins), evenly spaced
 * looks. Spending (Lan & DeMets 1983, Kim & DeMets 1987 power family, Pampallona et al. 2001 futility):
 *   - efficacy spends (alpha / 2) * t^3, with boundaries that hold even if futility is ignored
 *   - futility spends beta * t^2 (approximate boundary, non-binding)
 *
 * A design only depends on alpha. Outcomes are tabulated by `theta`, the expected z-score at the
 * final look (effect size and sample combined), so one table serves every effect and duration.
 */
const SequentialDesign = (function() {
    const LOOKS = 5;
    const BETA = 0.2;
    const NODES = 41;                       // Simpson nodes per look (odd)
    const THETA_MIN = -12, THETA_STEP = 0.1, THETA_COUNT = 321;
    const ALPHA_MIN = 0.001, ALPHA_MAX = 1, ALPHA_COUNT = 60;
    const DT = 1 / LOOKS;
    const SQRT_DT = Math.sqrt(DT);

    function phi(x) { return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI); }

    /** Simpson nodes and weights on [a, b]. */
    function simpson(a, b) {
        const x = new Float64Array(NODES), w = new Float64Array(NODES), h = (b - a) / (NODES - 1);
        for (let i = 0; i < NODES; i++) {
            x[i] = a + i * h;
            w[i] = (i === 0 || i === NODES - 1 ? 1 : (i % 2 ? 4 : 2)) * h / 3;
        }
        return { x: x, w: w };
    }

    /** Null density of the Brownian path at look 1, weighted for integration over [lo, hi]. */
    function firstStep(lo, hi) {
        const grid = simpson(lo, hi), mass = new Float64Array(NODES);
        for (let i = 0; i < NODES; i++) mass[i] = grid.w[i] * phi(grid.x[i] / SQRT_DT) / SQRT_DT;
        return { x: grid.x, mass: mass };
    }

    /** Moves the surviving null mass one look forward onto [lo, hi]. */
    function nextStep(prev, lo, hi) {
        const grid = simpson(lo, hi), mass = new Float64Array(NODES);
        for (let i = 0; i < NODES; i++) {
            let sum = 0;
            for (let j = 0; j < NODES; j++) sum += prev.mass[j] * phi((grid.x[i] - prev.x[j]) / SQRT_DT);
            mass[i] = grid.w[i] * sum / SQRT_DT;
        }
        return { x: grid.x, mass: mass };
    }

    function crossingProb(prev, bound) {
        let sum = 0;
        for (let j = 0; j < NODES; j++) sum += prev.mass[j] * (1 - normalCDF((bound - prev.x[j]) / SQRT_DT));
        return sum;
    }

    /** Efficacy (z) boundaries from alpha spending, ignoring futility. */
    function efficacyBounds(alpha) {
        const bounds = [];
        let prev = null, spent = 0;
        for (let k = 1; k <= LOOKS; k++) {
            const t = k * DT, total = alpha / 2 * Math.pow(t, 3), need = total - spent;
            spent = total;
            let b;
            if (k === 1) {
                b = getZScore(1 - need);
            } else {
                let lo = -8, hi = 8;
                for (let i = 0; i < 50; i++) {
                    const mid = (lo + hi) / 2;
                    if (crossingProb(prev, mid * Math.sqrt(t)) > need) lo = mid; else hi = mid;
                }
                b = (lo + hi) / 2;
            }
            bounds.push(b);
            const lowEdge = -6 * Math.sqrt(t), highEdge = b * Math.sqrt(t);
            prev = k === 1 ? firstStep(lowEdge, highEdge) : nextStep(prev, lowEdge, highEdge);
        }
        return bounds;
    }

    /** Futility (z) boundaries; the last look has none. */
    function futilityBounds(alpha, efficacy) {
        const drift = (alpha >= 1 ? 0 : getZScore(1 - alpha / 2)) + getZScore(1 - BETA);
        return efficacy.map(function(b, i) {
            const t = (i + 1) * DT;
            if (i === LOOKS - 1) return -Infinity;
            return Math.min(drift * Math.sqrt(t) + getZScore(BETA * t * t), b - 0.05);
        });
    }

    function bounds(alpha) {
        const efficacy = efficacyBounds(alpha);
        return { efficacy: efficacy, futility: futilityBounds(alpha, efficacy) };
    }

    /**
     * Tabulates P(ship at look k) and P(stop at look k) over theta. Survivors are tracked under the
     * null once, then reweighted by the likelihood ratio exp(theta * x - theta^2 * t / 2).
     */
    function tabulate(alpha) {
        const b = bounds(alpha);
        const steps = [];
        for (let k = 1; k < LOOKS; k++) {
            const root = Math.sqrt(k * DT), lo = b.futility[k - 1] * root, hi = b.efficacy[k - 1] * root;
            steps.push(k === 1 ? firstStep(lo, hi) : nextStep(steps[k - 2], lo, hi));
        }
        const ship = new Float64Array(THETA_COUNT * LOOKS), stop = new Float64Array(THETA_COUNT * LOOKS);
        for (let ti = 0; ti < THETA_COUNT; ti++) {
            const theta = THETA_MIN + ti * THETA_STEP, row = ti * LOOKS;
            let stopped = 0;
            for (let k = 1; k <= LOOKS; k++) {
                const root = Math.sqrt(k * DT), hi = b.efficacy[k - 1] * root, lo = b.futility[k - 1] * root;
                let win = 0, quit = 0;
                if (k === 1) {
                    win = 1 - normalCDF((hi - theta * DT) / SQRT_DT);
                    quit = normalCDF((lo - theta * DT) / SQRT_DT);
                } else {
                    const prev = steps[k - 2], t = (k - 1) * DT;
                    for (let j = 0; j < NODES; j++) {
                        const mass = prev.mass[j] * Math.exp(theta * prev.x[j] - theta * theta * t / 2);
                        win += mass * (1 - normalCDF((hi - prev.x[j] - theta * DT) / SQRT_DT));
                        if (k < LOOKS) quit += mass * normalCDF((lo - prev.x[j] - theta * DT) / SQRT_DT);
                    }
                }
                ship[row + k - 1] = win;
                stop[row + k - 1] = k === LOOKS ? Math.max(0, 1 - stopped) : win + quit;
                stopped += win + quit;
            }
        }
        return { ship: ship, stop: stop };
    }

    const tables = [];
    function tableAt(index) {
        if (!tables[index]) {
            tables[index] = tabulate(ALPHA_MIN * Math.pow(ALPHA_MAX / ALPHA_MIN, index / (ALPHA_COUNT - 1)));
        }
        return tables[index];
    }

    let lastDesign = null;

    /** Design for any alpha, blended between the tabulated ones. Consecutive calls with one alpha are free. */
    function get(alpha) {
        if (lastDesign && lastDesign.alpha === alpha) return lastDesign;
        const position = Math.max(0, Math.min(ALPHA_COUNT - 1,
            Math.log(alpha / ALPHA_MIN) / Math.log(ALPHA_MAX / ALPHA_MIN) * (ALPHA_COUNT - 1)));
        // Cubic through four neighboring tables. (Straight lines would make results snap to the tabulated alphas.)
        const first = Math.max(0, Math.min(ALPHA_COUNT - 4, Math.floor(position) - 1)), u = position - first;
        const weights = [
            -(u - 1) * (u - 2) * (u - 3) / 6, u * (u - 2) * (u - 3) / 2,
            -u * (u - 1) * (u - 3) / 2, u * (u - 1) * (u - 2) / 6
        ];
        const size = THETA_COUNT * LOOKS, ship = new Float64Array(size), stop = new Float64Array(size);
        weights.forEach(function(weight, n) {
            const table = tableAt(first + n);
            for (let i = 0; i < size; i++) {
                ship[i] += weight * table.ship[i];
                stop[i] += weight * table.stop[i];
            }
        });
        lastDesign = { alpha: alpha, ship: ship, stop: stop };
        return lastDesign;
    }

    /** Writes P(ship) and P(stop) at each look for one theta into the given arrays (length LOOKS). */
    function lookup(design, theta, shipOut, stopOut) {
        const position = Math.max(0, Math.min(THETA_COUNT - 1, (theta - THETA_MIN) / THETA_STEP));
        const index = Math.min(THETA_COUNT - 2, Math.floor(position)), f = position - index, row = index * LOOKS;
        for (let k = 0; k < LOOKS; k++) {
            shipOut[k] = design.ship[row + k] + f * (design.ship[row + LOOKS + k] - design.ship[row + k]);
            stopOut[k] = design.stop[row + k] + f * (design.stop[row + LOOKS + k] - design.stop[row + k]);
        }
    }

    /** Theta at which the design ships with probability `power`. */
    function thetaForPower(design, power) {
        const ship = new Float64Array(LOOKS), stop = new Float64Array(LOOKS);
        let lo = THETA_MIN, hi = THETA_MIN + THETA_STEP * (THETA_COUNT - 1);
        for (let i = 0; i < 40; i++) {
            const mid = (lo + hi) / 2;
            lookup(design, mid, ship, stop);
            let total = 0;
            for (let k = 0; k < LOOKS; k++) total += ship[k];
            if (total < power) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
    }

    /** Design for a one-sided alpha (get() takes the two-sided alpha and spends half of it). */
    function forOneSided(alphaOneSided) {
        return get(Math.min(ALPHA_MAX, 2 * alphaOneSided));
    }

    /** P(ship at any look) at one theta. */
    function powerAt(design, theta) {
        const ship = new Float64Array(LOOKS), stop = new Float64Array(LOOKS);
        lookup(design, theta, ship, stop);
        let total = 0;
        for (let k = 0; k < LOOKS; k++) total += ship[k];
        return total;
    }

    /** Expected share of the maximum sample used before stopping, at one theta. */
    function expectedFraction(design, theta) {
        const ship = new Float64Array(LOOKS), stop = new Float64Array(LOOKS);
        lookup(design, theta, ship, stop);
        let total = 0;
        for (let k = 0; k < LOOKS; k++) total += stop[k] * (k + 1) * DT;
        return total;
    }

    return {
        LOOKS: LOOKS, bounds: bounds, get: get, lookup: lookup, thetaForPower: thetaForPower,
        forOneSided: forOneSided, powerAt: powerAt, expectedFraction: expectedFraction
    };
})();
