import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleSearchResult } from "../../src/client.js";
import { WebSearchOutputSchema } from "../../src/structured.js";
import {
	captureExtension,
	cleanup,
	makeContext,
	makeTempDir,
	writeGlobalConfig,
	writeProjectConfig,
} from "../helpers/pi.js";

const tempDirs: string[] = [];

afterEach(() => {
	cleanup(tempDirs);
});

const SECRET = "sk-console-secret-value";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const hit: ConsoleSearchResult = {
	url: "https://opencode.ai/docs/websearch/",
	title: "Web search",
	content: "OpenCode can search the web.",
	published: 1735689600000,
};

const secondHit = { url: "https://example.com/second" };

const okBody = { providerID: "opencode", results: [hit, secondHit] };

/** A fetch stub that records the requests it was given. */
function recordingFetch(result: Response) {
	const calls: RequestInit[] = [];
	const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
		calls.push(init ?? {});
		return result;
	});
	return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** A fetch stub that answers every call with a fresh result response. */
function okFetch(make: () => Response = () => jsonResponse(okBody)) {
	return vi.fn(async () => make()) as unknown as typeof fetch;
}

/** A config dir with the spend gate open. */
function enabledConfigDir(extra: Record<string, unknown> = {}): string {
	const configDir = makeTempDir("web-search-global-", tempDirs);
	writeGlobalConfig(configDir, { enabled: true, ...extra });
	return configDir;
}

/** A context whose credential store answers from a map. */
function contextWithKeys(
	cwd: string,
	keys: Record<string, string | undefined>,
	options: { throwing?: boolean; trusted?: boolean } = {},
) {
	const requested: string[] = [];
	return {
		requested,
		ctx: makeContext(cwd, {
			isProjectTrusted: () => options.trusted ?? true,
			modelRegistry: {
				getApiKeyForProvider: async (provider: string) => {
					requested.push(provider);
					if (options.throwing)
						throw new Error("credential store is unreadable");
					return keys[provider];
				},
			} as never,
		}),
	};
}

function textOf(result: { content: unknown[] }): string {
	return String((result.content[0] as { type: "text"; text: string }).text);
}

/** Assert the result is what a codemode script receives, with no key in it. */
function expectSchema(result: { structuredContent?: unknown }): void {
	expect(Check(WebSearchOutputSchema, result.structuredContent)).toBe(true);
	expect(JSON.stringify(result)).not.toContain(SECRET);
}

const searchParams = { query: "opencode hosted web search" };

describe("search_web", () => {
	it("spends nothing and explains how to turn it on when disabled", async () => {
		const configDir = makeTempDir("web-search-global-", tempDirs);
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const fetchImpl = okFetch();
		const tool = captureExtension({
			configDir,
			fetch: fetchImpl,
			resolveApiKey: async () => SECRET,
		});

		const result = await tool.execute(
			"call-1",
			searchParams,
			undefined,
			undefined,
			makeContext(cwd),
		);

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(result.isError).toBeFalsy();
		expect(textOf(result)).toContain("web-search.json");
		expect(textOf(result)).toContain("0.01");
		expect(result.details).toMatchObject({
			status: "disabled",
			costUsd: 0,
		});
		expectSchema(result);
	});

	it("explains a missing credential instead of calling out", async () => {
		const configDir = enabledConfigDir();
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const fetchImpl = okFetch();
		const tool = captureExtension({
			configDir,
			fetch: fetchImpl,
			resolveApiKey: async () => undefined,
		});

		const result = await tool.execute(
			"call-2",
			searchParams,
			undefined,
			undefined,
			makeContext(cwd),
		);

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(result.isError).toBeFalsy();
		expect(result.details).toMatchObject({ status: "unconfigured" });
		expect(textOf(result)).toContain("opencode-go");
		expectSchema(result);
	});

	it("returns the results and reports the spend", async () => {
		const configDir = enabledConfigDir();
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const tool = captureExtension({
			configDir,
			fetch: okFetch(),
			resolveApiKey: async () => SECRET,
		});

		const result = await tool.execute(
			"call-3",
			searchParams,
			undefined,
			undefined,
			makeContext(cwd),
		);

		expect(textOf(result)).toContain(hit.url);
		expect(textOf(result)).toContain("OpenCode can search the web.");
		expect(result.isError).toBeFalsy();
		expect(result.details).toMatchObject({ status: "ok", costUsd: 0.01 });
		expect(result.structuredContent).toMatchObject({
			status: "ok",
			costUsd: 0.01,
			results: [{ url: hit.url }, { url: secondHit.url }],
		});
		expectSchema(result);
		expect(result.usage?.cost.total).toBeCloseTo(0.01, 5);
	});

	it("reports a rejected key as an error without echoing the key", async () => {
		const configDir = enabledConfigDir();
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const tool = captureExtension({
			configDir,
			fetch: okFetch(() => jsonResponse({}, 401)),
			resolveApiKey: async () => SECRET,
		});

		const result = await tool.execute(
			"call-4",
			searchParams,
			undefined,
			undefined,
			makeContext(cwd),
		);

		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ status: "failed", costUsd: 0 });
		expectSchema(result);
		expect(textOf(result)).toContain("401");
	});

	it("trims to the requested limit", async () => {
		const configDir = enabledConfigDir();
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const tool = captureExtension({
			configDir,
			fetch: okFetch(),
			resolveApiKey: async () => SECRET,
		});

		const result = await tool.execute(
			"call-5",
			{ ...searchParams, limit: 1 },
			undefined,
			undefined,
			makeContext(cwd),
		);

		expect(result.structuredContent).toMatchObject({
			results: [{ url: hit.url }],
		});
		expectSchema(result);
	});

	it("keeps an out-of-range limit inside the Console bounds", async () => {
		const configDir = enabledConfigDir();
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const tool = captureExtension({
			configDir,
			fetch: okFetch(),
			resolveApiKey: async () => SECRET,
		});

		for (const [limit, kept] of [
			[0, 1],
			[-5, 1],
			[999, 2],
			[Number.NaN, 2],
		] as const) {
			const result = await tool.execute(
				`call-limit-${limit}`,
				{ ...searchParams, limit },
				undefined,
				undefined,
				makeContext(cwd),
			);
			const structured = result.structuredContent as {
				results: unknown[];
			};
			expect(structured.results).toHaveLength(kept);
			expectSchema(result);
		}
	});

	it("falls back to the configured maxResults when no limit is given", async () => {
		const configDir = enabledConfigDir({ maxResults: 1 });
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const tool = captureExtension({
			configDir,
			fetch: okFetch(),
			resolveApiKey: async () => SECRET,
		});

		const result = await tool.execute(
			"call-6",
			searchParams,
			undefined,
			undefined,
			makeContext(cwd),
		);

		expect(result.structuredContent).toMatchObject({
			results: [{ url: hit.url }],
		});
		expectSchema(result);
	});

	it("reads the project config only from a trusted project", async () => {
		const configDir = makeTempDir("web-search-global-", tempDirs);
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		writeProjectConfig(cwd, { enabled: true });
		const tool = captureExtension({
			configDir,
			fetch: okFetch(),
			resolveApiKey: async () => SECRET,
		});

		const untrusted = await tool.execute(
			"call-7",
			searchParams,
			undefined,
			undefined,
			makeContext(cwd, { isProjectTrusted: () => false }),
		);
		expect(untrusted.details).toMatchObject({ status: "disabled" });
		expectSchema(untrusted);

		const trusted = await tool.execute(
			"call-8",
			searchParams,
			undefined,
			undefined,
			makeContext(cwd, { isProjectTrusted: () => true }),
		);
		expect(trusted.details).toMatchObject({ status: "ok" });
		expectSchema(trusted);
	});

	it("reads the credential from pi's store for the configured provider", async () => {
		const configDir = enabledConfigDir();
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const { ctx, requested } = contextWithKeys(cwd, {
			"opencode-go": SECRET,
		});
		const { fetchImpl, calls } = recordingFetch(jsonResponse(okBody));
		const tool = captureExtension({ configDir, fetch: fetchImpl });

		const result = await tool.execute(
			"call-9",
			searchParams,
			undefined,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({ status: "ok" });
		expectSchema(result);
		expect(requested).toEqual(["opencode-go"]);
		const headers = calls[0]?.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Bearer ${SECRET}`);
	});

	it("falls back to the opencode provider when opencode-go has no key", async () => {
		const configDir = enabledConfigDir();
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const { ctx, requested } = contextWithKeys(cwd, {
			opencode: SECRET,
		});
		const tool = captureExtension({
			configDir,
			fetch: okFetch(),
		});

		const result = await tool.execute(
			"call-10",
			searchParams,
			undefined,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({ status: "ok" });
		expectSchema(result);
		expect(requested).toEqual(["opencode-go", "opencode"]);
	});

	it("reports no credential when the store holds none", async () => {
		const configDir = enabledConfigDir();
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const { ctx } = contextWithKeys(cwd, {});
		const fetchImpl = okFetch();
		const tool = captureExtension({ configDir, fetch: fetchImpl });

		const result = await tool.execute(
			"call-11",
			searchParams,
			undefined,
			undefined,
			ctx,
		);

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({ status: "unconfigured" });
		expect(result.isError).toBeFalsy();
		expectSchema(result);
	});

	it("survives a credential store that throws", async () => {
		const configDir = enabledConfigDir();
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const { ctx } = contextWithKeys(cwd, {}, { throwing: true });
		const tool = captureExtension({ configDir, fetch: okFetch() });

		const result = await tool.execute(
			"call-12",
			searchParams,
			undefined,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({ status: "unconfigured" });
		expect(result.isError).toBeFalsy();
		expectSchema(result);
	});
});
