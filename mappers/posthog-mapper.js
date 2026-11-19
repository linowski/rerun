/**
 * PostHog API Mapper
 *
 * Lists a project's experiments with a personal API key and pulls each one's
 * results through PostHog's query API, then maps them to the standardized
 * experiment shape.
 *
 * The key needs two read scopes: `experiment:read` (the list) and
 * `query:read` (results). PostHog's API allows browser calls (CORS `*`), so
 * everything runs from the page and the key never leaves this tab.
 *
 * Results come from one `ExperimentQuery` per metric: the response has the
 * control as `baseline` and one entry per variant in `variant_results`, each
 * with `number_of_samples` (exposed users) and `sum` (converted users for a
 * funnel, the metric total for a mean). Frequentist results carry PostHog's
 * own two-sided `p_value`; Bayesian ones carry `chance_to_win` instead.
 * Experiments still on PostHog's legacy engine (`is_legacy`) are listed
 * without results.
 */

const PostHogMapper = {
    HOSTS: ['https://us.posthog.com', 'https://eu.posthog.com'],


    /**
     * Reads a project reference typed into the import dialog: a project URL
     * (any page inside it, which also pins the host, e.g. a self-hosted one)
     * or a bare project id. Blank means the key's current project.
     * @returns {{ host: string|null, projectId: string }}
     */
    parseProjectRef(ref) {
        const text = String(ref || '').trim();
        if (!text) return { host: null, projectId: '@current' };
        if (/^\d+$/.test(text)) return { host: null, projectId: text };
        try {
            const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
            const match = url.pathname.match(/\/(?:project|projects|environments)\/(\d+)/);
            return { host: url.origin, projectId: match ? match[1] : '@current' };
        } catch (error) {
            throw new Error(`"${text}" is not a PostHog project URL or id`);
        }
    },

    async request(host, path, apiKey, body = null) {
        for (let attempt = 0; ; attempt++) {
            const response = await fetch(`${host}${path}`, {
                method: body ? 'POST' : 'GET',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: body ? JSON.stringify(body) : undefined
            });
            // Throttled: wait as asked (capped), then try again, twice at most.
            if (response.status === 429 && attempt < 2) {
                const wait = Math.min(Number(response.headers.get('Retry-After')) || 10, 60);
                await new Promise(resolve => setTimeout(resolve, wait * 1000));
                continue;
            }
            if (!response.ok) {
                let detail = '';
                try {
                    const body = await response.json();
                    detail = body.detail || body.error || body.message || '';
                } catch (e) { /* not JSON */ }
                const error = new Error(`PostHog ${response.status}${detail ? `: ${detail}` : ''}`);
                error.status = response.status;
                throw error;
            }
            return response.json();
        }
    },

    // Every page of one project's experiment list.
    async listProject(host, projectId, apiKey) {
        const all = [];
        let path = `/api/projects/${projectId}/experiments/?limit=100`;
        while (path) {
            const page = await this.request(host, path, apiKey);
            all.push(...(page.results || []));
            // `next` is absolute; keep only the path so the host stays ours.
            path = page.next ? new URL(page.next).pathname + new URL(page.next).search : null;
        }
        // Launched and finished (see isFinished); running tests are skipped.
        return all.filter(exp => !exp.deleted && exp.start_date && this.isFinished(exp));
    },

    // With no project named, "@current" is whichever project the key's user
    // last had open in PostHog -- often an empty demo project. When that one
    // has no experiments, look through the organization's projects and take
    // the one with the most. Needs the key's `project:read` scope; without
    // it, null, and the status line asks for the project URL instead.
    async discoverProject(host, apiKey) {
        let projects;
        try {
            projects = (await this.request(host, '/api/organizations/@current/projects/?limit=200', apiKey)).results || [];
        } catch (error) {
            console.warn('PostHog: could not list projects (needs project:read):', error.message);
            return null;
        }
        let best = null;
        for (const project of projects) {
            let launched;
            try {
                launched = await this.listProject(host, project.id, apiKey);
            } catch (error) {
                continue;  // the key is limited to other projects
            }
            if (launched.length && (!best || launched.length > best.launched.length)) {
                best = { project, launched };
            }
        }
        console.log('PostHog projects:', projects.map(p => `${p.id} ${p.name}`), 'using:', best?.project.id ?? 'none');
        return best;
    },

    /**
     * Lists the project's launched experiments (every page). Tries the US
     * then the EU cloud unless the project reference named a host.
     * @returns {Promise<Array>} raw experiments, each with `_host` added
     */
    async fetchExperiments(projectRef, apiKey) {
        const { host, projectId } = this.parseProjectRef(projectRef);
        const hosts = host ? [host] : this.HOSTS;
        let lastError = null;
        for (const candidate of hosts) {
            try {
                let launched = await this.listProject(candidate, projectId, apiKey);
                let project = projectId;
                let projectName = '';
                let discovery = null;
                if (!launched.length && projectId === '@current') {
                    const found = await this.discoverProject(candidate, apiKey);
                    discovery = found ? 'found' : 'unavailable';
                    if (found) {
                        launched = found.launched;
                        project = String(found.project.id);
                        projectName = found.project.name || '';
                    }
                }
                // What was read, for the import status line.
                this.lastListing = {
                    host: candidate.replace(/^https?:\/\//, ''),
                    project, projectName, discovery,
                    launched: launched.length
                };
                console.log('PostHog listing:', this.lastListing, 'first raw experiment:', launched[0]);
                return launched.map(exp => ({ ...exp, _host: candidate, _projectId: project }));
            } catch (error) {
                lastError = error;
                // A key from the other region is rejected; anything else is real.
                if (error.status !== 401 && error.status !== 403) throw error;
            }
        }
        throw lastError;
    },

    // The experiment's metrics in PostHog's display order: inline metrics
    // plus shared (saved) ones, sorted by the experiment's ordered uuids.
    orderedMetrics(experiment, role) {
        const inline = (role === 'primary' ? experiment.metrics : experiment.metrics_secondary) || [];
        const saved = (experiment.saved_metrics || [])
            .filter(entry => (entry.metadata?.type || 'primary') === role)
            .map(entry => ({ ...entry.query, name: entry.query?.name || entry.name }));
        const metrics = inline.concat(saved).filter(metric => metric && metric.kind === 'ExperimentMetric');
        const order = (role === 'primary'
            ? experiment.primary_metrics_ordered_uuids
            : experiment.secondary_metrics_ordered_uuids) || [];
        const rank = metric => {
            const index = order.indexOf(metric.uuid);
            return index < 0 ? order.length : index;
        };
        return metrics.slice().sort((a, b) => rank(a) - rank(b));
    },

    // A client error (bad scope, missing experiment, rejected query) will
    // fail the same way next time; rate limits, server errors and dropped
    // connections may not.
    isPermanent(error) {
        return error.status >= 400 && error.status < 500 && error.status !== 429;
    },

    /**
     * One experiment's complete results, for ResumableResults.run: its
     * detail (the list is slim: no metrics or stats settings), then one
     * ExperimentQuery for the first primary and first secondary metric,
     * attached as `_results`. Resolves to a new object; never mutates `exp`.
     * Throws a permanent error when retrying cannot help.
     */
    async fetchOne(exp, apiKey) {
        const fail = (message, error) => {
            if (error && !this.isPermanent(error)) throw error;
            return ResumableResults.permanentError(message);
        };

        let experiment;
        try {
            const detail = await this.request(exp._host,
                `/api/projects/${exp._projectId}/experiments/${exp.id}/`, apiKey);
            experiment = { ...exp, ...detail, _results: {} };
        } catch (error) {
            throw fail(`could not be loaded (${error.message})`, error);
        }

        if (experiment.is_legacy) throw fail('uses PostHog\'s legacy results engine');
        if (!this.orderedMetrics(experiment, 'primary').length) {
            const allMetrics = (experiment.metrics || []).concat(experiment.saved_metrics || []);
            if (allMetrics.length) console.log(`PostHog: metrics of "${experiment.name}":`, allMetrics);
            throw fail(allMetrics.length
                ? `has metrics of an unsupported kind (${[...new Set(allMetrics.map(m => m.kind || m.query?.kind))].join(', ')})`
                : 'has no primary metric');
        }

        for (const role of ['primary', 'secondary']) {
            const metric = this.orderedMetrics(experiment, role)[0];
            if (!metric) continue;
            let response;
            try {
                response = await this.request(experiment._host,
                    `/api/projects/${experiment._projectId}/query/`, apiKey,
                    { query: { kind: 'ExperimentQuery', experiment_id: experiment.id, metric } });
            } catch (error) {
                // A secondary PostHog rejects outright is left out; anything
                // passing retries the whole experiment, so it stays one unit.
                if (role === 'secondary' && this.isPermanent(error)) {
                    console.warn(`PostHog: no secondary result for "${experiment.name}":`, error.message);
                    continue;
                }
                throw fail(`results query failed (${error.message})`, error);
            }
            if (response?.baseline) {
                experiment._results[role] = response;
            } else {
                // Most likely still computing: try again next load.
                console.log(`PostHog: unexpected ${role} result for "${experiment.name}":`, response);
                throw new Error('results not ready yet');
            }
        }
        experiment._siteVisitors = await this.fetchSiteVisitors(experiment, apiKey);
        return experiment;
    },

    // The test's window: start to end, or to its last edit (the flag change
    // that ended it) when never formally ended. As 'YYYY-MM-DD HH:MM:SS' UTC.
    testWindow(experiment) {
        const end = experiment.end_date || experiment.updated_at || new Date().toISOString();
        const sql = iso => new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
        return { from: sql(experiment.start_date), to: sql(end) };
    },

    /**
     * People who visited the site while the test ran: distinct people with a
     * page view in its window, for reach (exposed ÷ visitors). One HogQL
     * query, covered by `query:read`. Optional: on failure it is null (the
     * Reach column then falls back to the flag's rollout) and the
     * experiment still counts as complete.
     */
    async fetchSiteVisitors(experiment, apiKey) {
        const { from, to } = this.testWindow(experiment);
        try {
            const response = await this.request(experiment._host,
                `/api/projects/${experiment._projectId}/query/`, apiKey, {
                    query: {
                        kind: 'HogQLQuery',
                        query: `SELECT uniq(person_id) FROM events WHERE event = '$pageview' `
                            + `AND timestamp >= toDateTime('${from}', 'UTC') AND timestamp < toDateTime('${to}', 'UTC')`
                    }
                });
            const visitors = Number(response?.results?.[0]?.[0]);
            return Number.isFinite(visitors) && visitors > 0 ? visitors : null;
        } catch (error) {
            console.warn(`PostHog: no site visitor count for "${experiment.name}":`, error.message);
            return null;
        }
    },

    // Everyone counted in the primary result, across every arm.
    exposedCount(experiment) {
        const result = experiment._results?.primary;
        if (!result?.baseline) return null;
        return (result.variant_results || [])
            .reduce((sum, v) => sum + (v.number_of_samples || 0), result.baseline.number_of_samples || 0);
    },

    // Whether a saved experiment's results may be out of date: PostHog bumps
    // `updated_at` on any edit (metrics, stats settings, conclusion).
    changed(fresh, saved) {
        return (fresh.updated_at || '') !== (saved.updated_at || '');
    },

    // A variant's value for the metric: a conversion rate for funnel and
    // retention metrics, a per-user mean for mean metrics, the ratio of sums
    // for ratio metrics. Quantile metrics have no single value to compare.
    variantValue(stats, metricType) {
        if (!stats || !stats.number_of_samples) return null;
        if (metricType === 'ratio') {
            return stats.denominator_sum ? stats.sum / stats.denominator_sum : null;
        }
        if (metricType === 'quantile') return null;
        return stats.sum / stats.number_of_samples;
    },

    controlKey(experiment) {
        return experiment.stats_config?.baseline_variant_key || 'control';
    },

    // The test variants in result order (control is the response's baseline).
    // Variants the experiment excludes from analysis are left out.
    variantKeys(experiment) {
        const excluded = new Set(experiment.excluded_variants || []);
        const result = experiment._results?.primary;
        const keys = result?.variant_results?.length
            ? result.variant_results.map(v => v.key)
            : (experiment.feature_flag?.filters?.multivariate?.variants || [])
                .map(v => v.key).filter(key => key !== this.controlKey(experiment));
        return keys.filter(key => !excluded.has(key));
    },

    /**
     * One metric's comparison of `variantKey` against control.
     * @returns {{ lift, pvalue, sampleSize, baseRate, method } | null}
     */
    compare(experiment, role, variantKey) {
        const metric = this.orderedMetrics(experiment, role)[0];
        const result = experiment._results?.[role];
        if (!metric || !result?.baseline) return null;
        const variant = (result.variant_results || []).find(v => v.key === variantKey);
        if (!variant) return null;

        const metricType = metric.metric_type;
        const control = this.variantValue(result.baseline, metricType);
        const test = this.variantValue(variant, metricType);
        let lift = control ? (test / control - 1) * 100 : null;
        // Rerun reads a positive effect as good. For a "lower is better"
        // metric PostHog's win is a drop, so the sign is flipped to match.
        if (lift !== null && metric.goal === 'decrease') lift = -lift;

        let pvalue = MapperUtils.normalizePValue(variant.p_value);
        if (pvalue === null && Number.isFinite(variant.chance_to_win)) {
            // Bayesian with PostHog's flat prior: chance to win is about one
            // minus the one-sided p, so the two-sided p is twice the smaller tail.
            pvalue = Math.round(2 * Math.min(variant.chance_to_win, 1 - variant.chance_to_win) * 1e6) / 1e6;
        }

        return {
            lift: lift === null ? null : Math.round(lift * 100) / 100,
            pvalue,
            sampleSize: (result.baseline.number_of_samples || 0) + (variant.number_of_samples || 0),
            baseRate: this.isBinary(metric) && control !== null ? Math.round(control * 10000) / 100 : null,
            method: variant.method || null
        };
    },

    isBinary(metric) {
        return metric?.metric_type === 'funnel' || metric?.metric_type === 'retention';
    },

    metricLabel(metric) {
        if (!metric) return '';
        const source = metric.source || metric.numerator || metric.series?.[metric.series.length - 1];
        const name = metric.name || source?.custom_name || source?.name || source?.event || metric.metric_type || 'metric';
        return metric.goal === 'decrease' ? `${name} (lower is better)` : name;
    },

    // 'bayesian' | 'sequential' | 'fixed' from the experiment's own stats
    // settings, else from the method its results were computed with.
    // PostHog's sequential testing is opt-in, so frequentist without it is fixed.
    testMethod(experiment, resultMethod) {
        const config = experiment.stats_config || {};
        const method = config.method || resultMethod;
        if (method === 'bayesian') return 'bayesian';
        if (method !== 'frequentist') return null;
        return config.frequentist?.sequential_testing_enabled ? 'sequential' : 'fixed';
    },

    // Shipped when concluded as a win, or when the flag now serves a test
    // variant to everyone (PostHog's "ship variant"); Not Shipped when
    // concluded as a loss. Anything else is left blank.
    decision(experiment) {
        if (experiment.conclusion === 'won') return 'Shipped';
        const served = this.servedVariant(experiment);
        if (served && served !== this.controlKey(experiment)) return 'Shipped';
        if (experiment.conclusion === 'lost') return 'Not Shipped';
        return '';
    },

    // The one variant an active flag now serves to everyone (a release
    // condition overriding to it, or a 100% split), else null.
    servedVariant(experiment) {
        if (!experiment.feature_flag?.active) return null;
        const filters = experiment.feature_flag.filters || {};
        const override = (filters.groups || []).find(group =>
            group.variant
            && (group.rollout_percentage ?? 100) === 100
            && !(group.properties || []).length);
        if (override) return override.variant;
        return (filters.multivariate?.variants || []).find(v => v.rollout_percentage === 100)?.key || null;
    },

    // Finished: ended in PostHog, or (as many tests are never formally
    // ended) its flag is switched off or serves one variant to everyone.
    // Anything else is still splitting traffic and is left out: its
    // numbers are interim, which is exactly the peeking case.
    isFinished(experiment) {
        return !!experiment.end_date
            || experiment.feature_flag?.active === false
            || !!this.servedVariant(experiment);
    },

    // Screenshots attached to each variant in PostHog (up to 5 per variant).
    // PostHog serves uploaded media at a public, unguessable URL, so the
    // images load straight from it with no key. Arms are lettered control
    // first (A, B, C...); shots are numbered so "Shot 2" lines up across arms.
    screenshots(experiment) {
        const ids = experiment.parameters?.variant_screenshot_media_ids || {};
        const keys = [this.controlKey(experiment), ...this.variantKeys(experiment)];
        return keys.flatMap((key, armIndex) => (Array.isArray(ids[key]) ? ids[key] : [])
            .filter(Boolean)
            .map((mediaId, shot) => ({
                arm: String.fromCharCode(65 + armIndex),
                armLabel: key,
                viewport: null,
                pageState: `Shot ${shot + 1}`,
                file: String(mediaId).startsWith('data:')
                    ? mediaId
                    : `${experiment._host}/uploaded_media/${mediaId}`
            })));
    },

    /**
     * What triggers a user into the test, as the Trigger column's
     * [{ type, label }] (types: page, interaction, segment, device, flag). Only
     * what the test really targets counts, not PostHog's flag plumbing:
     *  - exposure on `$pageview` is a page visit; exposure on a user action
     *    (a click event, or an event named for a click, tap, open, scroll,
     *    submit...) is an interaction. Flag-check exposure (the default, or
     *    `$feature_flag_called` / `$experiment_exposure` set explicitly) and
     *    other events add nothing;
     *  - property conditions, on that event or in the flag's release
     *    conditions: URL ones are page, device/OS/browser ones are device,
     *    and person properties or cohorts that include people are a segment.
     *    Flag checks and exclusions ("email does not contain…", which keep
     *    people out rather than define an audience) are skipped.
     *  - always `flag` (every experiment runs on one): on its own it means
     *    users are exposed wherever the code checks it, not tied to a page.
     * The label carries the actual conditions for the icon's tooltip.
     */
    triggers(experiment) {
        const found = new Map();  // type -> [descriptions]
        const add = (type, text) => {
            if (!type) return;
            if (!found.has(type)) found.set(type, []);
            if (!found.get(type).includes(text)) found.get(type).push(text);
        };
        const addFilter = filter => add(this.filterType(filter), this.describeFilter(filter));

        const exposure = experiment.exposure_criteria?.exposure_config;
        if (exposure?.event === '$pageview') {
            add('page', 'Exposure on page view');
        } else if (exposure?.event && this.isInteractionEvent(exposure.event)) {
            add('interaction', `Exposure on ${exposure.event}`);
        }
        (exposure?.properties || []).forEach(addFilter);

        // Release conditions that admit people into the experiment (a 0%
        // group and a "ship to everyone" override admit nobody new).
        (experiment.feature_flag?.filters?.groups || [])
            .filter(group => (group.rollout_percentage ?? 100) > 0 && !group.variant)
            .forEach(group => (group.properties || []).forEach(addFilter));

        // Every PostHog experiment runs on a feature flag, shown alongside
        // whatever narrows it. With nothing tying exposure to a page or an
        // action, users are exposed wherever the code checks the flag.
        const flag = `Feature flag${experiment.feature_flag_key ? ` ${experiment.feature_flag_key}` : ''}`;
        add('flag', found.has('page') || found.has('interaction')
            ? `${flag}, limited by the ${found.has('page') ? 'page' : 'interaction'} condition`
            : `${flag}: exposed wherever the code checks it, not tied to a page`);

        return [...found].map(([type, texts]) => ({
            type,
            label: texts.join('; ')
        }));
    },

    // A user action: PostHog's click events, or a custom event named for one.
    isInteractionEvent(event) {
        if (['$autocapture', '$rageclick', '$dead_click', '$copy_autocapture'].includes(event)) return true;
        if (event.startsWith('$')) return false;  // other PostHog events: flag checks, page leave...
        return /click|tap|press|open|close|expand|scroll|submit|select|toggle|hover|swipe/i.test(event);
    },

    // Conditions that are PostHog plumbing, not targeting.
    isPlumbing(filter) {
        const key = String(filter.key || '');
        return filter.type === 'flag'
            || filter.operator === 'flag_evaluates_to'
            || key.startsWith('$feature')
            || key === '$active_feature_flags';
    },

    // Keeps people out rather than picking an audience.
    isExclusion(filter) {
        return ['is_not', 'not_icontains', 'not_regex', 'not_in', 'is_not_set',
            'not_starts_with', 'not_ends_with', 'is_cleaned_path_not_exact'].includes(filter.operator)
            || filter.negation === true;
    },

    DEVICE_KEYS: ['$device_type', '$os', '$os_name', '$browser', '$screen_width', '$screen_height',
        '$viewport_width', '$viewport_height', '$device', '$os_version', '$browser_version'],
    PAGE_KEYS: ['$current_url', '$pathname', '$host', '$referrer', '$referring_domain'],

    // The trigger type a condition stands for, or null when it is plumbing
    // or an exclusion (or an event property that targets nobody).
    filterType(filter) {
        if (this.isPlumbing(filter)) return null;
        const key = String(filter.key || '');
        const isPage = this.PAGE_KEYS.includes(key) || filter.operator?.includes('cleaned_path');
        // A page or device exclusion still narrows where the test runs.
        if (isPage) return 'page';
        if (this.DEVICE_KEYS.includes(key)) return 'device';
        // Which element was clicked (CSS selector, tag, text, link): the
        // interaction itself.
        if (filter.type === 'element') return 'interaction';
        if (this.isExclusion(filter)) return null;
        return filter.type === 'person' || filter.type === 'cohort' ? 'segment' : null;
    },

    OPERATORS: {
        exact: '=', is_not: '≠', icontains: 'contains', not_icontains: 'does not contain',
        starts_with: 'starts with', not_starts_with: 'does not start with', ends_with: 'ends with',
        not_ends_with: 'does not end with', regex: 'matches', not_regex: 'does not match',
        gt: '>', gte: '≥', lt: '<', lte: '≤', is_set: 'is set', is_not_set: 'is not set',
        in: 'in', not_in: 'not in', is_cleaned_path_exact: '=', is_date_before: 'before',
        is_date_after: 'after'
    },

    // "URL contains /checkout", "country = US, CA", "cohort 42".
    describeFilter(filter) {
        if (filter.type === 'cohort') return `cohort ${filter.cohort_name || filter.value}`;
        const names = { $current_url: 'URL', $pathname: 'path', $host: 'host', $device_type: 'device',
            $os: 'OS', $os_name: 'OS', $browser: 'browser', $screen_width: 'screen width' };
        const key = names[filter.key] || String(filter.key || '').replace(/^\$/, '');
        const op = this.OPERATORS[filter.operator || 'exact'] || filter.operator;
        if (filter.operator === 'is_set' || filter.operator === 'is_not_set') return `${key} ${op}`;
        const value = Array.isArray(filter.value) ? filter.value.join(', ') : filter.value;
        return `${key} ${op} ${value}`;
    },

    rollout(experiment) {
        const groups = experiment.feature_flag?.filters?.groups || [];
        const rollout = groups.find(group => !group.variant)?.rollout_percentage;
        return Number.isFinite(rollout) ? Math.round(rollout) : null;
    },

    /**
     * Reach for the Reach column: { traffic, reachLabel, reachNote }. Real
     * reach is the people exposed ÷ the people who visited the site in the
     * test's window. Without a visitor count, the flag's rollout, labelled
     * as such: it is a share of eligible users, not of the site.
     */
    reach(experiment) {
        const rollout = this.rollout(experiment);
        const rolloutText = rollout !== null ? ` Flag rollout: ${rollout}% of eligible users.` : '';
        const exposed = this.exposedCount(experiment);
        const visitors = experiment._siteVisitors;
        if (exposed && visitors) {
            const share = Math.min(100, exposed / visitors * 100);
            const { from, to } = this.testWindow(experiment);
            return {
                traffic: share >= 10 ? Math.round(share) : Math.round(share * 10) / 10,
                reachLabel: 'of site visitors',
                reachNote: `${exposed.toLocaleString()} exposed of ${visitors.toLocaleString()} people with a page view `
                    + `between ${from.slice(0, 10)} and ${to.slice(0, 10)}.${rolloutText}`
            };
        }
        return {
            traffic: rollout,
            reachLabel: 'rollout',
            reachNote: 'Share of eligible users the flag enrolled, not of all site visitors '
                + '(no visitor count for this test yet: Re-pull all fetches it).'
        };
    },

    mapExperiment(experiment) {
        const [variantKey, ...otherKeys] = this.variantKeys(experiment);
        const primaryMetric = this.orderedMetrics(experiment, 'primary')[0];
        const secondaryMetric = this.orderedMetrics(experiment, 'secondary')[0];
        const primary = variantKey ? this.compare(experiment, 'primary', variantKey) : null;
        const secondary = variantKey ? this.compare(experiment, 'secondary', variantKey) : null;
        const metricType = metric => this.isBinary(metric) ? 'binary' : 'continuous';
        const teamId = experiment.feature_flag?.team_id || experiment._projectId;
        const owner = [experiment.created_by?.first_name, experiment.created_by?.last_name]
            .filter(Boolean).join(' ');
        const variantNote = variantKey ? experiment.parameters?.variant_notes?.[variantKey] : '';

        return {
            id: String(experiment.id),
            name: experiment.name || 'Untitled Experiment',
            url: experiment._host && /^\d+$/.test(String(teamId))
                ? `${experiment._host}/project/${teamId}/experiments/${experiment.id}`
                : null,
            change: [experiment.description, variantNote].filter(Boolean).join(' '),
            owner,
            // Never formally ended: the last edit (usually the flag change
            // that shipped or stopped it) is the nearest end date PostHog has.
            date: (experiment.end_date || experiment.updated_at || '').slice(0, 10) || null,
            startDate: experiment.start_date ? experiment.start_date.slice(0, 10) : null,
            primaryMetric: primary?.lift ?? null,
            primaryMetricLabel: this.metricLabel(primaryMetric),
            primaryMetricType: metricType(primaryMetric),
            secondaryMetric: secondary?.lift ?? null,
            secondaryMetricLabel: this.metricLabel(secondaryMetric),
            secondaryMetricType: metricType(secondaryMetric),
            pvalue: primary?.pvalue ?? null,
            secondaryPvalue: secondary?.pvalue ?? null,
            sampleSize: primary?.sampleSize || 0,
            baseRate: primary?.baseRate ?? null,
            testMethod: this.testMethod(experiment, primary?.method),
            decision: this.decision(experiment),
            triggered: this.triggers(experiment),
            ...this.reach(experiment),
            trafficSubtitle: null,
            screenshots: this.screenshots(experiment),
            additionalComparisons: otherKeys.map(key => {
                const extra = this.compare(experiment, 'primary', key);
                const extraSecondary = this.compare(experiment, 'secondary', key);
                return {
                    variationName: key,
                    primaryMetric: extra?.lift ?? null,
                    primaryMetricLabel: this.metricLabel(primaryMetric),
                    primaryMetricType: metricType(primaryMetric),
                    secondaryMetric: extraSecondary?.lift ?? null,
                    secondaryMetricLabel: this.metricLabel(secondaryMetric),
                    secondaryMetricType: metricType(secondaryMetric),
                    pvalue: extra?.pvalue ?? null,
                    secondaryPvalue: extraSecondary?.pvalue ?? null,
                    sampleSize: extra?.sampleSize || 0
                };
            })
        };
    },

    // Filters again so a cache saved before running tests were skipped
    // drops them too.
    mapExperiments(experiments) {
        return MapperUtils.mapExperiments(this, (experiments || []).filter(exp => this.isFinished(exp)));
    }
};

if (typeof window !== 'undefined') {
    window.PostHogMapper = PostHogMapper;
}
