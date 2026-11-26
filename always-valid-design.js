/**
 * Always-valid (mSPRT) test with evenly spaced peeks (depends on stats-utils.js).
 * Used by: index.html (Method = Sequential (mSPRT), and power for sequential tests under As reported).
 * Shared with changeandmeasure (components/); keep in step.
 *
 * Normal-mean mixture SPRT with a fixed mixing ratio r, the same as mSprtPValue in stats-utils.js:
 *   Lambda(z) = (1 + r)^(-1/2) * exp(r z^2 / (2 (1 + r))),  always-valid p = min(1, 1 / Lambda)
 * so "p < alpha" is a constant z boundary c checked at every peek (c ~ 3.03 at alpha 0.05, r 7.84).
 *
 * Power for K evenly spaced peeks: survivors are tracked under the null once per (c, K), on Simpson
 * nodes that end exactly on each peek's boundary, then reweighted by the likelihood ratio
 * exp(theta * x - theta^2 * t / 2), so any theta is cheap.
 * Theta is the expected z at the last peek (effect size and sample combined), as in sequential-design.js.
 */
const AlwaysValidDesign = (function() {
    const R = (1.96 + 0.84) ** 2;           // 7.84: mixture tuned to an 80%-powered effect (rerun)
    const LOWER = -8;                        // Grid floor for the null path (sd is at most 1)
    const REACH = 8;                         // Kernel and boundary reach, in step sds
    const NODES_PER_SD = 4;                  // Simpson node density, per step sd
    const PEEK_BUCKETS = [1, 2, 3, 4, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 180];  // Above 180 changes power < 1%

    function phi(x) { return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI); }

    /** z needed at a peek for the always-valid p to fall below alpha. */
    function boundary(alpha, r = R) {
        return Math.sqrt(2 * (1 + r) / r * (Math.log(1 / alpha) + 0.5 * Math.log(1 + r)));
    }

    /** Nearest supported peek count (log scale), so designs can be cached. */
    function bucketPeeks(peeks) {
        const target = Math.log(Math.max(1, peeks));
        let best = PEEK_BUCKETS[0];
        PEEK_BUCKETS.forEach(function(k) {
            if (Math.abs(Math.log(k) - target) < Math.abs(Math.log(best) - target)) best = k;
        });
        return best;
    }

    const cache = new Map();

    /**
     * For each peek k, the null mass just below the boundary at peek k - 1 (the only mass that can
     * cross at peek k). Positions are on the sum scale S = z * sqrt(t), which has variance t.
     */
    function get(alpha, peeks) {
        const K = bucketPeeks(peeks), key = alpha + '|' + K;
        if (cache.has(key)) return cache.get(key);

        const c = boundary(alpha), dt = 1 / K, sd = Math.sqrt(dt);

        const near = [];
        let x = Float64Array.of(0), mass = Float64Array.of(1), lo0 = 0, h0 = 1;   // Start: all mass at 0
        for (let k = 1; k <= K; k++) {
            const bound = c * Math.sqrt(k * dt);
            // Keep the mass close enough to cross at this peek
            const keepX = [], keepM = [];
            for (let i = 0; i < x.length; i++) {
                if (mass[i] > 0 && x[i] > bound - REACH * sd) { keepX.push(x[i]); keepM.push(mass[i]); }
            }
            near.push({ x: Float64Array.from(keepX), mass: Float64Array.from(keepM), t: (k - 1) * dt, bound: bound });
            if (k === K) break;

            // Survivors at peek k: Simpson nodes on [LOWER, bound], ending exactly on the boundary so
            // results move smoothly with alpha (a fixed grid would catch the boundary unevenly).
            let n = Math.ceil((bound - LOWER) / (sd / NODES_PER_SD)) + 1;
            if (n % 2 === 0) n++;
            const h = (bound - LOWER) / (n - 1);
            const nextX = new Float64Array(n), next = new Float64Array(n);
            for (let i = 0; i < n; i++) {
                const xi = LOWER + i * h, w = (i === 0 || i === n - 1 ? 1 : (i % 2 ? 4 : 2)) * h / 3;
                let density = 0;
                if (k === 1) {
                    density = phi(xi / sd) / sd;
                } else {
                    // Only previous nodes within reach contribute
                    const jLo = Math.max(0, Math.ceil((xi - REACH * sd - lo0) / h0));
                    const jHi = Math.min(x.length - 1, Math.floor((xi + REACH * sd - lo0) / h0));
                    for (let j = jLo; j <= jHi; j++) density += mass[j] * phi((xi - x[j]) / sd);
                    density /= sd;
                }
                nextX[i] = xi;
                next[i] = w * density;
            }
            x = nextX;
            mass = next;
            lo0 = LOWER;
            h0 = h;
        }

        const design = { alpha: alpha, peeks: K, c: c, sd: sd, dt: dt, near: near };
        cache.set(key, design);
        return design;
    }

    /** P(always-valid p < alpha at some peek) when the expected z at the last peek is theta. */
    function powerAt(design, theta) {
        let total = 0;
        design.near.forEach(function(step) {
            for (let i = 0; i < step.x.length; i++) {
                const weight = Math.exp(theta * step.x[i] - theta * theta * step.t / 2);
                total += step.mass[i] * weight * (1 - normalCDF((step.bound - step.x[i] - theta * design.dt) / design.sd));
            }
        });
        return Math.min(1, total);
    }

    /** Theta at which the test reaches `power`. */
    function thetaForPower(design, power) {
        let lo = 0, hi = 20;
        for (let i = 0; i < 50; i++) {
            const mid = (lo + hi) / 2;
            if (powerAt(design, mid) < power) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
    }

    // ---- Tabulated per-peek outcomes, for callers that need many lookups (lesson grid searches) ----
    // Same layout as sequential-design.js: P(ship at peek k) over a theta grid, one table per
    // log-spaced alpha, blended with cubic weights so results don't snap to the tabulated alphas.
    const THETA_MIN = -12, THETA_STEP = 0.1, THETA_COUNT = 321;
    const ALPHA_MIN = 0.001, ALPHA_MAX = 1, ALPHA_COUNT = 25;

    /** P(ship at peek k) for every theta on the grid. */
    function tabulate(alpha, peeks) {
        const design = get(alpha, peeks), K = design.peeks, ship = new Float64Array(THETA_COUNT * K);
        for (let ti = 0; ti < THETA_COUNT; ti++) {
            const theta = THETA_MIN + ti * THETA_STEP, row = ti * K;
            design.near.forEach(function(step, k) {
                let sum = 0;
                for (let i = 0; i < step.x.length; i++) {
                    const weight = Math.exp(theta * step.x[i] - theta * theta * step.t / 2);
                    sum += step.mass[i] * weight * (1 - normalCDF((step.bound - step.x[i] - theta * design.dt) / design.sd));
                }
                ship[row + k] = sum;
            });
        }
        return ship;
    }

    const tables = new Map();
    function tableAt(index, peeks) {
        const key = index + '|' + peeks;
        if (!tables.has(key)) {
            tables.set(key, tabulate(ALPHA_MIN * Math.pow(ALPHA_MAX / ALPHA_MIN, index / (ALPHA_COUNT - 1)), peeks));
        }
        return tables.get(key);
    }

    let lastTable = null;

    /** Per-peek table for any alpha (two-sided p threshold) and peek count. Consecutive calls are free. */
    function table(alpha, peeks) {
        const K = bucketPeeks(peeks);
        if (lastTable && lastTable.alpha === alpha && lastTable.peeks === K) return lastTable;
        const position = Math.max(0, Math.min(ALPHA_COUNT - 1,
            Math.log(alpha / ALPHA_MIN) / Math.log(ALPHA_MAX / ALPHA_MIN) * (ALPHA_COUNT - 1)));
        const first = Math.max(0, Math.min(ALPHA_COUNT - 4, Math.floor(position) - 1)), u = position - first;
        const weights = [
            -(u - 1) * (u - 2) * (u - 3) / 6, u * (u - 2) * (u - 3) / 2,
            -u * (u - 1) * (u - 3) / 2, u * (u - 1) * (u - 2) / 6
        ];
        const ship = new Float64Array(THETA_COUNT * K);
        weights.forEach(function(weight, n) {
            const source = tableAt(first + n, K);
            for (let i = 0; i < ship.length; i++) ship[i] += weight * source[i];
        });
        lastTable = { alpha: alpha, peeks: K, ship: ship };
        return lastTable;
    }

    /** Writes P(ship at peek k) for one theta into shipOut (length >= peeks). Returns the peek count. */
    function lookup(tab, theta, shipOut) {
        const K = tab.peeks;
        const position = Math.max(0, Math.min(THETA_COUNT - 1, (theta - THETA_MIN) / THETA_STEP));
        const index = Math.min(THETA_COUNT - 2, Math.floor(position)), f = position - index, row = index * K;
        for (let k = 0; k < K; k++) {
            shipOut[k] = Math.max(0, tab.ship[row + k] + f * (tab.ship[row + K + k] - tab.ship[row + k]));
        }
        return K;
    }

    /** Theta at which a tabulated design reaches `power`. */
    function tableThetaForPower(tab, power) {
        const ship = new Float64Array(tab.peeks);
        let lo = 0, hi = THETA_MIN + THETA_STEP * (THETA_COUNT - 1);
        for (let i = 0; i < 40; i++) {
            const mid = (lo + hi) / 2;
            lookup(tab, mid, ship);
            let total = 0;
            for (let k = 0; k < tab.peeks; k++) total += ship[k];
            if (total < power) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
    }

    return {
        R: R, boundary: boundary, bucketPeeks: bucketPeeks, get: get, powerAt: powerAt, thetaForPower: thetaForPower,
        table: table, lookup: lookup, tableThetaForPower: tableThetaForPower
    };
})();
