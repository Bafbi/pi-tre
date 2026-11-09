import { describe, expect, it, vi } from "vitest";

import { searchConsole } from "../../src/client.js";

const KEY = "sk-test-token-do-not-print";
const ENDPOINT = "https://opencode.test/console/api/websearch";

interface Recorded {
	url: string;
	init: RequestInit;
}

function stubFetch(
	handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
	const calls: Recorded[] = [];
	const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init: init ?? {} });
		return handler(url, init ?? {});
	});
	return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const okBody = {
	providerID: "opencode",
	results: [
		{
			url: "https://example.com/a",
			title: "A",
			content: "first hit",
			time: { published: 1735689600000 },
		},
		{ url: "https://example.com/b", title: "B", content: "second hit" },
	],
};

function call(overrides: Partial<Parameters<typeof searchConsole>[0]> = {}) {
	return {
		query: "opencode hosted search",
		apiKey: KEY,
		endpoint: ENDPOINT,
		timeoutMs: 5000,
		maxResults: 8,
		...overrides,
	};
}

describe("searchConsole", () => {
	it("sends the documented request", async () => {
		const { fetchImpl, calls } = stubFetch(() => jsonResponse(okBody));

		await searchConsole(call(), { fetch: fetchImpl });

		expect(calls).toHaveLength(1);
		const [record] = calls;
		expect(record?.url).toBe(ENDPOINT);
		expect(record?.init.method).toBe("POST");
		const headers = record?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Bearer ${KEY}`);
		expect(headers["content-type"]).toBe("application/json");
		expect(JSON.parse(String(record?.init.body))).toEqual({
			query: "opencode hosted search",
			providerID: "opencode",
		});
	});

	it("returns the results, keeping the published time", async () => {
		const { fetchImpl } = stubFetch(() => jsonResponse(okBody));

		const outcome = await searchConsole(call(), { fetch: fetchImpl });

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.results).toEqual([
			{
				url: "https://example.com/a",
				title: "A",
				content: "first hit",
				published: 1735689600000,
			},
			{ url: "https://example.com/b", title: "B", content: "second hit" },
		]);
	});

	it("drops results beyond maxResults", async () => {
		const { fetchImpl } = stubFetch(() => jsonResponse(okBody));

		const outcome = await searchConsole(call({ maxResults: 1 }), {
			fetch: fetchImpl,
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.results).toHaveLength(1);
	});

	it("rejects a result set from a different provider", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({ ...okBody, providerID: "exa" }),
		);

		const outcome = await searchConsole(call(), { fetch: fetchImpl });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("invalid_response");
	});

	it("reports a rejected key without echoing it", async () => {
		const { fetchImpl } = stubFetch(() =>
			jsonResponse({ error: "nope" }, 401),
		);

		const outcome = await searchConsole(call(), { fetch: fetchImpl });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("unauthorized");
		expect(outcome.message).not.toContain(KEY);
		expect(outcome.message).toContain("401");
	});

	it("reports an empty balance as its own reason", async () => {
		const { fetchImpl } = stubFetch(() => jsonResponse({}, 402));

		const outcome = await searchConsole(call(), { fetch: fetchImpl });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("balance");
	});

	it("reports rate limiting", async () => {
		const { fetchImpl } = stubFetch(() => jsonResponse({}, 429));

		const outcome = await searchConsole(call(), { fetch: fetchImpl });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("rate_limited");
	});

	it("reports a server error", async () => {
		const { fetchImpl } = stubFetch(() => jsonResponse({}, 503));

		const outcome = await searchConsole(call(), { fetch: fetchImpl });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("server");
	});

	it("reports a body that is not search JSON", async () => {
		const { fetchImpl } = stubFetch(
			() => new Response("<html>maintenance</html>", { status: 200 }),
		);

		const outcome = await searchConsole(call(), { fetch: fetchImpl });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("invalid_response");
	});

	it("reports a timeout", async () => {
		const { fetchImpl } = stubFetch(() => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		});

		const outcome = await searchConsole(call(), { fetch: fetchImpl });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("timeout");
	});

	it("reports an abort as an abort, not a timeout", async () => {
		const { fetchImpl } = stubFetch(() => {
			throw new DOMException("The operation was aborted.", "AbortError");
		});
		const controller = new AbortController();
		controller.abort();

		const outcome = await searchConsole(
			call({ signal: controller.signal }),
			{ fetch: fetchImpl },
		);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("aborted");
	});

	it("reports an abort that lands while the body is arriving", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				({
					ok: true,
					status: 200,
					json: async () => {
						throw new DOMException(
							"The operation was aborted.",
							"AbortError",
						);
					},
				}) as unknown as Response,
		);
		const controller = new AbortController();
		controller.abort();

		const outcome = await searchConsole(
			call({ signal: controller.signal }),
			{
				fetch: fetchImpl,
			},
		);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("aborted");
	});

	it("reports a timeout that lands while the body is arriving", async () => {
		const { fetchImpl } = stubFetch(
			() =>
				({
					ok: true,
					status: 200,
					json: async () => {
						// Outlive the request timeout, so the timeout signal has fired.
						await new Promise((resolve) => setTimeout(resolve, 25));
						throw new DOMException(
							"The operation timed out.",
							"TimeoutError",
						);
					},
				}) as unknown as Response,
		);

		const outcome = await searchConsole(call({ timeoutMs: 10 }), {
			fetch: fetchImpl,
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("timeout");
	});

	it("reports a network failure", async () => {
		const { fetchImpl } = stubFetch(() => {
			throw new TypeError("fetch failed");
		});

		const outcome = await searchConsole(call(), { fetch: fetchImpl });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("network");
	});
});
