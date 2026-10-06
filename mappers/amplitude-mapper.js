/**
 * Amplitude Experiment API Mapper
 * Maps Amplitude Experiment Management API responses to our standardized
 * experiment data format.
 *
 * The Management API (https://experiment.amplitude.com/api/1/experiments)
 * describes experiments -- name, state, variants, rollout, decision -- but
 * does not expose analysis results (lift, p-value, exposures), and the
 * Dashboard REST API needs a secret key and a saved chart per experiment.
 * Metric fields therefore come from fetchResults(), which calls the
 * `use_amp_experiments` tool on Amplitude's MCP server via `mcp` below.
 */

const AmplitudeMapper = {
    hosts: {
        us: 'https://experiment.amplitude.com',
        eu: 'https://experiment.eu.amplitude.com'
    },

    // Page size for the list endpoint; the API caps it at 1000.
    pageLimit: 1000,

    /**
     * Fetches experiments from the Amplitude Experiment Management API.
     * Management API keys are bound to one data region, so when no host is
     * given the US host is tried first and the EU host on a 401.
     * @param {string|null} apiHost - API host URL, or null to auto-detect
     * @param {string} apiKey - Management API key
     * @returns {Promise<Array>} - Array of filtered raw experiments
     */
    async fetchExperiments(apiHost, apiKey) {
        const hosts = apiHost ? [apiHost] : [this.hosts.us, this.hosts.eu];
        let lastError = null;

        for (const host of hosts) {
            try {
                const experiments = await this.fetchAllPages(host, apiKey);
                return experiments.filter(exp => this.isAnalyzable(exp));
            } catch (error) {
                lastError = error;
                if (error.status !== 401) break;
            }
        }
        throw lastError;
    },

    async fetchAllPages(host, apiKey) {
        const experiments = [];
        let cursor = null;

        do {
            const params = new URLSearchParams({ limit: String(this.pageLimit) });
            if (cursor) params.set('cursor', cursor);

            const response = await fetch(`${host}/api/1/experiments?${params}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                const error = new Error(`HTTP error! status: ${response.status}`);
                error.status = response.status;
                throw error;
            }

            const data = await response.json();
            experiments.push(...(data.experiments || []));
            cursor = data.nextCursor || null;
        } while (cursor);

        return experiments;
    },

    /**
     * Attaches results from Amplitude's MCP `use_amp_experiments` tool
     * (action 'analyze') to each raw experiment as `analysis` -- see
     * analysisArm below -- and, from action 'get', its `analysisParams`
     * (statistical method, alpha) and metric ids, whose names come from
     * `use_amplitude_metrics`. Requires an mcp sign-in (see `mcp` below).
     * Throws if the first experiment fails; later failures are skipped.
     * @param {Array} experiments - Raw experiments from fetchExperiments()
     * @param {Function} [onProgress] - Called with (done, total) after each one
     * @returns {Promise<number>} - How many experiments got results
     */
    async fetchResults(experiments, onProgress = () => {}) {
        const tools = await this.mcp.listTools();
        if (!tools.some(t => t.name === 'use_amp_experiments')) {
            const names = tools.map(t => t.name);
            throw new Error(
                'Amplitude MCP offers no use_amp_experiments tool for this account. '
                + `Tools it offers (${names.length}): ${names.join(', ') || 'none'}`
            );
        }

        // Settings first: a few batched calls, so the test-method badges
        // show before the slower per-experiment analysis finishes.
        await this.fetchAnalysisParams(experiments);
        await this.fetchMetricNames(experiments, tools);

        let done = 0;
        let analyzed = 0;
        const analyze = async experiment => {
            // 'analyze' queries one experiment's primary metric; the tool's
            // optional metricIds/groupBy/filters are left out.
            const result = await this.mcp.callTool('use_amp_experiments', {
                action: 'analyze',
                id: String(experiment.id)
            });
            experiment.analysis = this.findAnalysis(this.mcp.parseToolResult(result));
            if (experiment.analysis) {
                analyzed++;
            } else {
                const excerpt = JSON.stringify(result).slice(0, 400);
                console.warn(`Amplitude analyze returned no usable results for "${experiment.name}":`, excerpt);
            }
        };

        // The first call runs alone: if it fails, the call itself is wrong and
        // there is no point repeating it for every experiment.
        if (experiments.length) {
            await analyze(experiments[0]);
            onProgress(++done, experiments.length);
        }

        // The rest run a few at a time; a failure here is usually one
        // experiment without enough data yet, so it is skipped.
        const queue = experiments.slice(1);
        const worker = async () => {
            while (queue.length) {
                const experiment = queue.shift();
                try {
                    await analyze(experiment);
                } catch (error) {
                    console.warn(`Amplitude analyze skipped "${experiment.name}":`, error.message);
                }
                onProgress(++done, experiments.length);
            }
        };
        await Promise.all(Array.from({ length: this.resultConcurrency }, worker));
        return analyzed;
    },

    // Parallel analyze calls; kept low to stay clear of Amplitude rate limits.
    resultConcurrency: 4,

    // Experiments per 'get' call.
    getBatchSize: 20,

    /**
     * Names each experiment's primary metric (`primaryMetricName`) by looking
     * up the metric ids from fetchAnalysisParams() with the MCP
     * `use_amplitude_metrics` tool (action 'get_metrics'), in batches of
     * unique ids. Failures only cost the names: labels fall back to
     * "primary metric".
     */
    async fetchMetricNames(experiments, tools) {
        const ids = [...new Set(experiments.map(exp => exp.metricIds?.[0]).filter(Boolean))];
        if (!ids.length) return;

        if (!tools.some(t => t.name === 'use_amplitude_metrics')) {
            console.warn('Amplitude metric names skipped: no use_amplitude_metrics tool for this account.');
            return;
        }

        const names = new Map();
        for (let i = 0; i < ids.length; i += this.getBatchSize) {
            const batch = ids.slice(i, i + this.getBatchSize);
            try {
                const result = await this.mcp.callTool('use_amplitude_metrics', {
                    action: 'get_metrics',
                    metricIds: batch
                });
                for (const payload of this.mcp.parseToolResult(result)) {
                    this.collectNamed(payload, names);
                }
            } catch (error) {
                console.warn('Amplitude metric names failed:', error.message);
            }
        }
        for (const experiment of experiments) {
            const name = names.get(experiment.metricIds?.[0]);
            if (name) experiment.primaryMetricName = name;
        }
        console.log(`Amplitude metric names: ${names.size} found for ${ids.length} primary metric ids`);
    },

    // Walks a tool payload for objects carrying both an id and a name, since
    // the metrics may sit under `metrics`, `data` or similar, with the id or
    // name under a few spellings. The first name found for an id wins, so a
    // nested object (an event, say) cannot overwrite the metric's own name.
    collectNamed(node, names) {
        if (Array.isArray(node)) {
            node.forEach(item => this.collectNamed(item, names));
        } else if (node && typeof node === 'object') {
            const id = node.id ?? node.metricId;
            const name = [node.name, node.displayName, node.metricName, node.title]
                .find(value => typeof value === 'string' && value);
            if (id != null && name && !names.has(String(id))) names.set(String(id), name);
            Object.values(node).forEach(value => this.collectNamed(value, names));
        }
    },

    /**
     * Copies each experiment's `analysisParams` from the MCP 'get' action,
     * which (unlike the Management API) includes the statistical method.
     * The rest of the 'get' payload is dropped: variant payloads can hold
     * whole scripts and would bloat the import cache. Failures only lose the
     * test-method badge, so they are logged rather than thrown.
     */
    async fetchAnalysisParams(experiments) {
        for (let i = 0; i < experiments.length; i += this.getBatchSize) {
            const batch = experiments.slice(i, i + this.getBatchSize);
            try {
                const result = await this.mcp.callTool('use_amp_experiments', {
                    action: 'get',
                    ids: batch.map(exp => String(exp.id))
                });
                const payload = this.mcp.parseToolResult(result)
                    .find(p => Array.isArray(p?.experiments));
                const byId = new Map((payload?.experiments || []).map(exp => [String(exp.id), exp]));
                for (const experiment of batch) {
                    const config = byId.get(String(experiment.id));
                    if (config?.analysisParams) experiment.analysisParams = config.analysisParams;
                    // Metric ids in metricIndex order; index 0 is the primary.
                    if (Array.isArray(config?.metrics)) {
                        experiment.metricIds = [...config.metrics]
                            .sort((a, b) => (a.metricIndex ?? 0) - (b.metricIndex ?? 0))
                            .map(metric => String(metric.id));
                    }
                }
            } catch (error) {
                console.warn('Amplitude get (analysis settings) failed:', error.message);
            }
        }
    },

    // The analysis is the first entry of `data` (one per metric; without
    // metricIds, just the primary metric) that has a per-variant summary.
    // Payloads may wrap it one level deeper, e.g. under `result`. Only the
    // fields the mapper reads are kept: the rest (daily timeseries, traffic
    // changepoints) runs to kilobytes per experiment and would bloat the cache.
    findAnalysis(payloads) {
        for (const payload of payloads) {
            for (const candidate of [payload, payload?.result, payload?.structuredContent]) {
                const entries = Array.isArray(candidate?.data) ? candidate.data : [];
                const analysis = entries.find(entry => entry?.summary);
                if (analysis) {
                    const { control, alpha, summary, isBinaryMetric } = analysis;
                    return { control, alpha, summary, isBinaryMetric };
                }
            }
        }
        return null;
    },

    // Newest first by start date (creation date for ones never started), so
    // a capped import analyzes the most recent experiments.
    newestFirst(experiments) {
        const date = exp => String(exp.startDate || exp.createdAt || '');
        return [...experiments].sort((a, b) => date(b).localeCompare(date(a)));
    },

    // Keep experiments that have actually run: skip deleted/archived ones and
    // ones still being planned, which have no traffic to analyze.
    isAnalyzable(experiment) {
        if (experiment.deleted || experiment.archived) return false;
        return experiment.state !== 'planning';
    },

    /**
     * Maps an Amplitude experiment to our standard format
     * @param {Object} experiment - Raw experiment object from Amplitude API
     * @returns {Object} - Standardized experiment object
     */
    mapExperiment(experiment) {
        const variants = experiment.variants || [];
        const variantCount = variants.length || 2;

        // Build additional comparisons for variants beyond the first treatment.
        const additionalComparisons = [];
        for (let i = 2; i < variantCount; i++) {
            const variant = variants[i] || {};
            additionalComparisons.push({
                variationName: variant.name || variant.key || `Variant ${i}`,
                primaryMetric: this.extractMetricValue(experiment, 'primary', i),
                primaryMetricLabel: this.extractMetricLabel(experiment, 'primary'),
                primaryMetricType: this.determineMetricType(experiment, 'primary'),
                secondaryMetric: this.extractMetricValue(experiment, 'secondary', i),
                secondaryMetricLabel: this.extractMetricLabel(experiment, 'secondary'),
                secondaryMetricType: this.determineMetricType(experiment, 'secondary'),
                pvalue: this.extractPValue(experiment, i),
                sampleSize: this.extractSampleSize(experiment, i),
                power: null
            });
        }

        return {
            id: experiment.id || experiment.key || null,
            name: experiment.name || experiment.key || 'Untitled Experiment',
            url: this.buildUrl(experiment),
            date: (experiment.startDate || experiment.createdAt || '').slice(0, 10),
            primaryMetric: this.extractMetricValue(experiment, 'primary'),
            primaryMetricLabel: this.extractMetricLabel(experiment, 'primary'),
            primaryMetricType: this.determineMetricType(experiment, 'primary'),
            secondaryMetric: this.extractMetricValue(experiment, 'secondary'),
            secondaryMetricLabel: this.extractMetricLabel(experiment, 'secondary'),
            secondaryMetricType: this.determineMetricType(experiment, 'secondary'),
            sampleSize: this.extractSampleSize(experiment),
            baseRate: this.extractBaseRate(experiment),
            power: null,
            pvalue: this.extractPValue(experiment),
            // Rerun's iterations means "reruns an earlier test", which
            // Amplitude does not record; every experiment counts as first-time.
            iterations: 0,
            testMethod: this.extractTestMethod(experiment),
            triggered: this.extractTriggers(experiment),
            traffic: MapperUtils.firstNumber(experiment, ['rolloutPercentage'], null),
            trafficSubtitle: this.extractTrafficSubtitle(experiment),
            owner: experiment.createdBy || '',
            change: experiment.description || '',
            decision: this.extractDecision(experiment),
            additionalComparisons: additionalComparisons
        };
    },

    /**
     * Maps an array of Amplitude experiments
     * @param {Array} experiments - Array of raw experiments from Amplitude API
     * @returns {Array} - Array of standardized experiment objects
     */
    mapExperiments(experiments) {
        return MapperUtils.mapExperiments(this, experiments);
    },

    buildUrl(experiment) {
        if (!experiment.projectId || !experiment.id) return null;
        return `https://app.amplitude.com/experiment/${experiment.projectId}/${experiment.id}/config`;
    },

    // Amplitude records a decision to roll out a variant as rolledOutVariant;
    // rolling out the control is a rollback, i.e. not shipped.
    extractDecision(experiment) {
        const rolledOut = experiment.rolledOutVariant;
        if (rolledOut) {
            const control = experiment.variants?.[0]?.key || 'control';
            return rolledOut === control ? '' : 'Shipped';
        }
        const decision = String(experiment.decision || '').toLowerCase();
        if (decision.includes('rollout') || decision.includes('roll-out')) return 'Shipped';
        return MapperUtils.normalizeDecision(decision);
    },

    // Every experiment is triggered by assignment; target segments narrow it
    // to an audience, and a feature-flag delivery means an in-app interaction.
    extractTriggers(experiment) {
        const types = [{ type: 'page' }];
        if (experiment.targetSegments?.length) types.push({ type: 'segment' });
        if (experiment.deliveryMethod === 'feature') types.push({ type: 'interaction' });
        return types;
    },

    extractTrafficSubtitle(experiment) {
        const segments = (experiment.targetSegments || [])
            .map(segment => segment.name)
            .filter(Boolean);
        return segments.length ? `targeting ${segments.join(', ')}` : null;
    },

    /**
     * Per-variant statistics from the 'analyze' result attached by
     * fetchResults() as `experiment.analysis`. Its shape:
     *   { control: 'control', alpha: 0.05,
     *     summary: { <variantKey>: { mean, num, absoluteLift, pValue, ... } } }
     * where mean is the arm's rate/mean, num its exposed users, and
     * absoluteLift the difference from control in absolute units.
     */
    analysisArm(experiment, variantIndex) {
        const summary = experiment.analysis?.summary;
        if (!summary) return null;
        const controlKey = experiment.analysis.control || 'control';
        if (variantIndex === 0) return summary[controlKey] || null;
        // Match by variant key; fall back to position among the treatments.
        const key = experiment.variants?.[variantIndex]?.key;
        if (key && summary[key]) return summary[key];
        const treatments = Object.keys(summary).filter(k => k !== controlKey);
        return summary[treatments[variantIndex - 1]] || null;
    },

    // Relative lift as a percentage (5 for +5%), matching the Amplitude UI.
    extractMetricValue(experiment, metricType, variantIndex = 1) {
        // 'analyze' returns the primary metric only.
        if (metricType !== 'primary') return null;
        const controlMean = MapperUtils.firstNumber(this.analysisArm(experiment, 0), ['mean'], null);
        const absLift = MapperUtils.firstNumber(this.analysisArm(experiment, variantIndex), ['absoluteLift'], null);
        if (absLift === null || !controlMean) return null;
        return Math.round((absLift / controlMean) * 100 * 1000) / 1000;
    },

    // The primary's name comes from fetchMetricNames(); "primary metric"
    // only when that lookup found nothing. 'analyze' returns no secondary
    // metric, so its label and type stay empty rather than naming one the
    // experiment may not have.
    extractMetricLabel(experiment, metricType) {
        if (metricType !== 'primary') return '';
        return experiment.primaryMetricName || 'primary metric';
    },

    // 'analyze' flags binary (conversion) metrics; without results the type
    // is unknown and left out.
    determineMetricType(experiment, metricType) {
        if (metricType !== 'primary') return null;
        const isBinary = experiment.analysis?.isBinaryMetric;
        if (isBinary === true) return 'binary';
        if (isBinary === false) return 'continuous';
        return null;
    },

    extractPValue(experiment, variantIndex = 1) {
        return MapperUtils.normalizePValue(
            MapperUtils.firstValue(this.analysisArm(experiment, variantIndex), ['pValue'], null)
        );
    },

    // Control plus the compared variant, matching the other mappers.
    extractSampleSize(experiment, variantIndex = 1) {
        const control = MapperUtils.firstNumber(this.analysisArm(experiment, 0), ['num'], 0);
        const variant = MapperUtils.firstNumber(this.analysisArm(experiment, variantIndex), ['num'], 0);
        return control + variant;
    },

    // From analysisParams.statisticalMethod, e.g. 'sequentialTestMSPRT'.
    // Amplitude's alternative is a T-test (fixed horizon); anything
    // unrecognised stays null so no badge is guessed.
    extractTestMethod(experiment) {
        const method = String(experiment.analysisParams?.statisticalMethod || '').toLowerCase();
        if (!method) return null;
        if (method.includes('sequential')) return 'sequential';
        if (method.includes('bayes')) return 'bayesian';
        if (/t_?-?test|fixed/.test(method)) return 'fixed';
        console.warn('Unrecognised Amplitude statisticalMethod:', experiment.analysisParams.statisticalMethod);
        return null;
    },

    // Control mean as a percentage (5 for 5%), or null.
    extractBaseRate(experiment) {
        const mean = MapperUtils.firstNumber(this.analysisArm(experiment, 0), ['mean'], null);
        return mean === null ? null : Math.round(mean * 100 * 100) / 100;
    },

    /**
     * Amplitude MCP client: signs in to Amplitude's MCP server from the
     * browser and calls its tools directly -- no AI client in between, so no
     * model tokens are spent. The server speaks standard OAuth 2.1 (dynamic
     * client registration + PKCE, read-only `mcp:read` scope) and allows
     * browser origins, so a static page can use it.
     *
     * Nothing here is a secret that belongs in the repo: the client id is
     * public and registered per page URL at runtime, and tokens stay in
     * sessionStorage, so they are gone when the tab closes.
     */
    mcp: {
        host: 'https://mcp.amplitude.com',
        scope: 'mcp:read offline_access',
        protocolVersion: '2025-06-18',

        storageKeys: {
            clientPrefix: 'amplitude_mcp_client_',   // localStorage, per redirect URI
            tokens: 'amplitude_mcp_tokens',          // sessionStorage
            pending: 'amplitude_mcp_pending'         // sessionStorage, during sign-in
        },

        sessionId: null,
        requestId: 0,

        // The page returns to itself after sign-in, so Live Server's port (or any
        // other host) works without configuration.
        redirectUri() {
            return window.location.origin + window.location.pathname;
        },

        isSignedIn() {
            return Boolean(this.readTokens()?.access_token);
        },

        readTokens() {
            try {
                return JSON.parse(sessionStorage.getItem(this.storageKeys.tokens) || 'null');
            } catch (e) {
                return null;
            }
        },

        saveTokens(tokens) {
            sessionStorage.setItem(this.storageKeys.tokens, JSON.stringify({
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token || this.readTokens()?.refresh_token || null
            }));
        },

        signOut() {
            sessionStorage.removeItem(this.storageKeys.tokens);
            this.sessionId = null;
        },

        // Registers this page as an OAuth client once per redirect URI. The
        // resulting client id is public (PKCE, no client secret).
        async clientId() {
            const redirectUri = this.redirectUri();
            const storageKey = this.storageKeys.clientPrefix + redirectUri;
            const cached = localStorage.getItem(storageKey);
            if (cached) return cached;

            const response = await fetch(`${this.host}/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_name: 'Rerun',
                    redirect_uris: [redirectUri],
                    grant_types: ['authorization_code', 'refresh_token'],
                    response_types: ['code'],
                    token_endpoint_auth_method: 'none',
                    scope: this.scope
                })
            });
            if (!response.ok) {
                throw new Error(`Amplitude sign-in registration failed (${response.status})`);
            }
            const { client_id: clientId } = await response.json();
            localStorage.setItem(storageKey, clientId);
            return clientId;
        },

        base64Url(bytes) {
            return btoa(String.fromCharCode(...new Uint8Array(bytes)))
                .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        },

        randomString() {
            return this.base64Url(crypto.getRandomValues(new Uint8Array(32)));
        },

        // Leaves the page for Amplitude's login; completeSignIn() finishes the
        // exchange when the browser comes back.
        async startSignIn() {
            const clientId = await this.clientId();
            const verifier = this.randomString();
            const state = this.randomString();
            const challenge = this.base64Url(
                await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
            );

            sessionStorage.setItem(this.storageKeys.pending, JSON.stringify({ verifier, state, clientId }));

            const params = new URLSearchParams({
                response_type: 'code',
                client_id: clientId,
                redirect_uri: this.redirectUri(),
                scope: this.scope,
                state,
                code_challenge: challenge,
                code_challenge_method: 'S256',
                resource: this.host
            });
            window.location.assign(`${this.host}/authorize?${params}`);
        },

        /**
         * Finishes a sign-in if the page was just loaded from Amplitude's login
         * redirect. Resolves true when a new sign-in completed.
         */
        async completeSignIn() {
            const url = new URL(window.location.href);
            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            const error = url.searchParams.get('error');
            let pending = null;
            try {
                pending = JSON.parse(sessionStorage.getItem(this.storageKeys.pending) || 'null');
            } catch (e) { /* treated as no pending sign-in */ }

            if (!pending || (!code && !error)) return false;

            // Drop the OAuth parameters from the address bar either way.
            sessionStorage.removeItem(this.storageKeys.pending);
            ['code', 'state', 'scope', 'error', 'error_description', 'iss'].forEach(p => url.searchParams.delete(p));
            window.history.replaceState(null, '', url.pathname + url.search + url.hash);

            if (error) throw new Error(`Amplitude sign-in was cancelled or failed: ${error}`);
            if (state !== pending.state) throw new Error('Amplitude sign-in state did not match; please try again.');

            await this.requestTokens({
                grant_type: 'authorization_code',
                code,
                redirect_uri: this.redirectUri(),
                client_id: pending.clientId,
                code_verifier: pending.verifier,
                resource: this.host
            });
            return true;
        },

        async requestTokens(fields) {
            const response = await fetch(`${this.host}/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(fields)
            });
            if (!response.ok) {
                throw new Error(`Amplitude token request failed (${response.status})`);
            }
            this.saveTokens(await response.json());
        },

        async refreshTokens() {
            const refreshToken = this.readTokens()?.refresh_token;
            if (!refreshToken) return false;
            try {
                await this.requestTokens({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: await this.clientId(),
                    resource: this.host
                });
                return true;
            } catch (e) {
                this.signOut();
                return false;
            }
        },

        // Streamable-HTTP responses arrive either as plain JSON or as a
        // server-sent-event stream whose `data:` lines carry the JSON-RPC message.
        async readRpcResponse(response, id) {
            const type = response.headers.get('Content-Type') || '';
            if (!type.includes('text/event-stream')) {
                return response.json();
            }
            const text = await response.text();
            const messages = text.split('\n')
                .filter(line => line.startsWith('data:'))
                .map(line => {
                    try { return JSON.parse(line.slice(5).trim()); } catch (e) { return null; }
                })
                .filter(Boolean);
            return messages.find(message => message.id === id) || messages[messages.length - 1];
        },

        async post(body, retried = false) {
            const headers = {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'Authorization': `Bearer ${this.readTokens()?.access_token}`,
                'MCP-Protocol-Version': this.protocolVersion
            };
            if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

            const response = await fetch(`${this.host}/mcp`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            if (response.status === 401 && !retried && await this.refreshTokens()) {
                return this.post(body, true);
            }
            if (response.status === 401) {
                this.signOut();
                const error = new Error('Amplitude sign-in expired; please sign in again.');
                error.status = 401;
                throw error;
            }
            if (!response.ok) {
                throw new Error(`Amplitude MCP request failed (${response.status})`);
            }
            return response;
        },

        async rpc(method, params) {
            const id = ++this.requestId;
            const response = await this.post({ jsonrpc: '2.0', id, method, params });
            const message = await this.readRpcResponse(response, id);
            if (message?.error) {
                throw new Error(`Amplitude MCP ${method} failed: ${message.error.message}`);
            }
            return message?.result;
        },

        async connect() {
            if (this.sessionId !== null) return;
            const id = ++this.requestId;
            const response = await this.post({
                jsonrpc: '2.0',
                id,
                method: 'initialize',
                params: {
                    protocolVersion: this.protocolVersion,
                    capabilities: {},
                    clientInfo: { name: 'Rerun', version: '1.0' }
                }
            });
            // Empty string when the server runs sessionless (or does not expose the
            // header to browsers); later requests then simply omit it.
            this.sessionId = response.headers.get('Mcp-Session-Id') || '';
            await this.readRpcResponse(response, id);
            await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
        },

        // tools/list may be paginated; follow nextCursor to get every tool.
        async listTools() {
            await this.connect();
            const tools = [];
            let cursor;
            do {
                const result = await this.rpc('tools/list', cursor ? { cursor } : {});
                tools.push(...(result?.tools || []));
                cursor = result?.nextCursor;
            } while (cursor);
            return tools;
        },

        async callTool(name, args) {
            await this.connect();
            const result = await this.rpc('tools/call', { name, arguments: args });
            if (result?.isError) {
                const text = (result.content || []).map(c => c.text).join(' ');
                throw new Error(`Amplitude ${name} failed: ${text || 'unknown error'}`);
            }
            return result;
        },

        // Tool results carry JSON as a text block, and sometimes also as
        // structuredContent. Returns every parseable payload, most likely first,
        // so callers can pick the one with the shape they expect.
        parseToolResult(result) {
            const payloads = [];
            if (result?.structuredContent) payloads.push(result.structuredContent);
            for (const block of result?.content || []) {
                if (block.type !== 'text') continue;
                const parsed = this.parseLooseJson(block.text);
                if (parsed !== null) payloads.push(parsed);
            }
            return payloads;
        },

        // Tool text may wrap its JSON in prose or a code fence, and statistical
        // output can contain bare NaN/Infinity, which JSON.parse rejects. Try the
        // text as-is, then the outermost {...}, each with NaN/Infinity as null.
        parseLooseJson(text) {
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            const candidates = [text];
            if (start > 0 || (end >= 0 && end < text.length - 1)) {
                candidates.push(text.slice(start, end + 1));
            }
            for (const candidate of candidates) {
                for (const attempt of [candidate, candidate.replace(/(?<=[:,\[]\s*)-?(NaN|Infinity)\b/g, 'null')]) {
                    try {
                        return JSON.parse(attempt);
                    } catch (e) { /* try the next form */ }
                }
            }
            return null;
        }
    }
};

if (typeof window !== 'undefined') {
    window.AmplitudeMapper = AmplitudeMapper;
}
