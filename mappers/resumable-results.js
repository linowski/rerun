/**
 * Resumable, per-experiment result loading shared by the API imports.
 *
 * Every API platform works the same way: one call lists the experiments,
 * then one or more calls per experiment fetch its results. This helper owns
 * the second half, so that:
 *
 *  - each experiment is fetched as one unit and replaced in one step: a
 *    saved copy holds either its old complete results or its new complete
 *    results, never a mix;
 *  - the saved copy is written as results arrive, so stopping part-way
 *    (reload, closed tab, dropped connection) loses at most the
 *    experiments in flight, and the next load resumes with the rest;
 *  - a Refresh fetches only what is new, unfinished or changed, and
 *    "Re-pull all" (force) fetches everything again;
 *  - a failure that will not fix itself (no metric, unsupported engine,
 *    missing scope) is recorded and not retried on every load, while a
 *    passing one (timeout, rate limit, server error) is retried next time.
 *
 * Bookkeeping lives on each raw experiment:
 *   _fetchedAt  ms timestamp of its last complete fetch (absent = pending)
 *   _issue      why it has no results, for a permanent failure
 */

const ResumableResults = {
    /**
     * Combines a fresh listing with the saved copy. A saved experiment keeps
     * its results, with the listing's fields laid over it so list-level facts
     * (status, flag, end date) stay current; it is marked pending again when
     * `changed(fresh, saved)` says its results may be out of date.
     * Experiments no longer listed are dropped.
     */
    merge(fresh, saved, { idOf = exp => exp.id, changed = () => false } = {}) {
        const savedById = new Map((saved || []).map(exp => [String(idOf(exp)), exp]));
        return fresh.map(exp => {
            const old = savedById.get(String(idOf(exp)));
            if (!old) return exp;
            const merged = { ...old, ...exp };
            if (changed(exp, old)) {
                delete merged._fetchedAt;
                delete merged._issue;
            }
            return merged;
        });
    },

    // Experiments still to fetch: never fetched, interrupted, or (with
    // `force`) all of them.
    pending(experiments, { force = false } = {}) {
        return experiments.filter(exp => force || !exp._fetchedAt);
    },

    /**
     * Fetches `targets` (members of `experiments`) a few at a time.
     *
     * `fetchOne(exp)` resolves to the experiment's complete new version (a
     * new object; it must not mutate `exp`), or throws. An error with
     * `permanent: true` records `_issue` and stops retries; any other error
     * leaves the experiment as it was, to be tried again next load.
     *
     * `save(experiments)` is called as results arrive (at most every
     * `saveEvery` ms) and once at the end; `onProgress(done, total)` after
     * each experiment.
     *
     * @returns {Promise<{ fetched: number, failed: number }>}
     */
    async run(experiments, targets, {
        fetchOne,
        save = async () => {},
        onProgress = () => {},
        concurrency = 4,
        saveEvery = 2000
    }) {
        const queue = targets.slice();
        const total = queue.length;
        let done = 0;
        let fetched = 0;
        let failed = 0;
        let lastSave = Date.now();
        let saving = Promise.resolve();

        // Saves run one after another, so an older copy never lands last.
        const persist = () => {
            lastSave = Date.now();
            const snapshot = experiments.slice();
            saving = saving.then(() => save(snapshot)).catch(error =>
                console.warn('Could not save results:', error.message));
            return saving;
        };

        const replace = (exp, next) => {
            const index = experiments.indexOf(exp);
            if (index >= 0) experiments[index] = next;
        };

        const worker = async () => {
            while (queue.length) {
                const exp = queue.shift();
                try {
                    const next = await fetchOne(exp);
                    const complete = { ...next, _fetchedAt: Date.now() };
                    delete complete._issue;
                    replace(exp, complete);
                    fetched++;
                } catch (error) {
                    failed++;
                    if (error.permanent) {
                        replace(exp, { ...exp, _fetchedAt: Date.now(), _issue: error.message });
                    } else {
                        console.warn(`Results for "${exp.name}" will be retried:`, error.message);
                    }
                }
                onProgress(++done, total);
                if (Date.now() - lastSave >= saveEvery) persist();
            }
        };

        await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
        await persist();
        return { fetched, failed };
    },

    // Why experiments have no results, most common first, one per line:
    // "12 results query failed (PostHog 403: …)\n3 has no primary metric",
    // plus how many failed only for now.
    summarize(experiments) {
        const counts = new Map();
        experiments.forEach(exp => {
            if (exp._issue) counts.set(exp._issue, (counts.get(exp._issue) || 0) + 1);
        });
        const lines = [...counts].sort((a, b) => b[1] - a[1]).map(([issue, n]) => `${n} ${issue}`);
        const retry = this.pending(experiments).length;
        if (retry) lines.push(`${retry} failed for now and will be retried`);
        return lines.join('\n');
    },

    // An error that retrying will not fix.
    permanentError(message) {
        const error = new Error(message);
        error.permanent = true;
        return error;
    }
};

if (typeof window !== 'undefined') {
    window.ResumableResults = ResumableResults;
}
