/**
 * Client for the OpenCode Console hosted search.
 *
 * One POST buys one search: it costs the workspace USD 0.01, so the call
 * happens only after the config gate and the credential check. Every failure
 * mode becomes a typed outcome; nothing here throws past `searchConsole`.
 */

/** The Console provider id this client asks for. */
export const SEARCH_PROVIDER_ID = "opencode";

/** One result the Console returned. */
export interface ConsoleSearchResult {
	url: string;
	title?: string;
	content?: string;
	/** Publication time, in milliseconds since the Unix epoch. */
	published?: number;
}

/** Why a search produced no results. */
type SearchFailureReason =
	| "unauthorized"
	| "balance"
	| "rate_limited"
	| "server"
	| "timeout"
	| "aborted"
	| "invalid_response"
	| "network";

export type SearchOutcome =
	| { ok: true; results: ConsoleSearchResult[] }
	| { ok: false; reason: SearchFailureReason; message: string };

export interface ConsoleSearchOptions {
	query: string;
	/** Bearer token. Never logged, never echoed in a message. */
	apiKey: string;
	endpoint: string;
	timeoutMs: number;
	maxResults: number;
	/** Caller's cancellation, combined with the request timeout. */
	signal?: AbortSignal | undefined;
}

export interface ConsoleSearchDeps {
	/** Injected in tests. Defaults to the global fetch. */
	fetch?: typeof fetch | undefined;
}

/** Map a JSON body to results, or `undefined` when it is not a search response. */
function parseResults(
	body: unknown,
	maxResults: number,
): ConsoleSearchResult[] | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const record = body as Record<string, unknown>;
	if (record.providerID !== SEARCH_PROVIDER_ID) return undefined;
	if (!Array.isArray(record.results)) return undefined;

	const results: ConsoleSearchResult[] = [];
	for (const entry of record.results) {
		if (results.length >= maxResults) break;
		if (typeof entry !== "object" || entry === null) continue;
		const hit = entry as Record<string, unknown>;
		if (typeof hit.url !== "string" || hit.url.length === 0) continue;
		const result: ConsoleSearchResult = { url: hit.url };
		if (typeof hit.title === "string") result.title = hit.title;
		if (typeof hit.content === "string") result.content = hit.content;
		const time = hit.time;
		if (typeof time === "object" && time !== null) {
			const published = (time as Record<string, unknown>).published;
			if (typeof published === "number" && Number.isFinite(published)) {
				result.published = published;
			}
		}
		results.push(result);
	}
	return results;
}

/** A message for an HTTP status, naming the status and the fix. */
function statusFailure(status: number): SearchOutcome {
	if (status === 401 || status === 403) {
		return {
			ok: false,
			reason: "unauthorized",
			message: `OpenCode rejected the API key (HTTP ${status}). Sign in again for the configured provider, or set OPENCODE_API_KEY.`,
		};
	}
	if (status === 402) {
		return {
			ok: false,
			reason: "balance",
			message:
				"The OpenCode workspace balance is exhausted (HTTP 402). Add credit in the OpenCode console.",
		};
	}
	if (status === 429) {
		return {
			ok: false,
			reason: "rate_limited",
			message:
				"OpenCode rate limited the search (HTTP 429). Wait before searching again.",
		};
	}
	return {
		ok: false,
		reason: "server",
		message: `OpenCode search failed (HTTP ${status}). Retry later.`,
	};
}

/** Run one search against the Console. Never throws. */
export async function searchConsole(
	options: ConsoleSearchOptions,
	deps: ConsoleSearchDeps = {},
): Promise<SearchOutcome> {
	const fetchImpl = deps.fetch ?? globalThis.fetch;
	const timeout = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout])
		: timeout;

	/** The outcome for a request that ran out of time. */
	const timedOut = (): SearchOutcome => ({
		ok: false,
		reason: "timeout",
		message: `The OpenCode search timed out after ${options.timeoutMs} ms.`,
	});

	/**
	 * The outcome for a request that stopped early. The caller's abort wins over
	 * the timeout, so a cancelled call is never reported as a slow one.
	 */
	const interrupted = (): SearchOutcome | undefined => {
		if (options.signal?.aborted) {
			return {
				ok: false,
				reason: "aborted",
				message: "The search was cancelled.",
			};
		}
		if (timeout.aborted) return timedOut();
		return undefined;
	};

	let response: Response;
	try {
		response = await fetchImpl(options.endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${options.apiKey}`,
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify({
				query: options.query,
				providerID: SEARCH_PROVIDER_ID,
			}),
			signal,
		});
	} catch (error) {
		const stopped = interrupted();
		if (stopped) return stopped;
		const name = error instanceof Error ? error.name : "";
		if (name === "TimeoutError" || name === "AbortError") return timedOut();
		return {
			ok: false,
			reason: "network",
			message: `Could not reach ${options.endpoint}.`,
		};
	}

	if (!response.ok) return statusFailure(response.status);

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		// An abort or a timeout can land while the body is still arriving.
		const stopped = interrupted();
		if (stopped) return stopped;
		return {
			ok: false,
			reason: "invalid_response",
			message: "OpenCode returned a body that is not search JSON.",
		};
	}

	const results = parseResults(body, options.maxResults);
	if (results === undefined) {
		return {
			ok: false,
			reason: "invalid_response",
			message: `OpenCode returned something other than provider "${SEARCH_PROVIDER_ID}" results.`,
		};
	}
	return { ok: true, results };
}
