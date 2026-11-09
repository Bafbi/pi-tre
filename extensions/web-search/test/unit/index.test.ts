import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleSearchResult } from "../../src/client.js";
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

function okFetch(
	result: Response = jsonResponse({
		providerID: "opencode",
		results: [hit],
	}),
) {
	const fetchImpl = vi.fn(async () => result);
	return fetchImpl as unknown as typeof fetch;
}

/** A config dir with the spend gate open. */
function enabledConfigDir(): string {
	const configDir = makeTempDir("web-search-global-", tempDirs);
	writeGlobalConfig(configDir, { enabled: true });
	return configDir;
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
			resolveApiKey: async () => "key",
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
		const text = String(
			(result.content[0] as { type: "text"; text: string }).text,
		);
		expect(text).toContain("web-search.json");
		expect(text).toContain("0.01");
		expect(result.details).toMatchObject({ status: "disabled" });
		expect(result.structuredContent).toMatchObject({ status: "disabled" });
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
		const text = String(
			(result.content[0] as { type: "text"; text: string }).text,
		);
		expect(text).toContain("opencode-go");
	});

	it("returns the results and reports the spend", async () => {
		const configDir = enabledConfigDir();
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const tool = captureExtension({
			configDir,
			fetch: okFetch(),
			resolveApiKey: async () => "key",
		});

		const result = await tool.execute(
			"call-3",
			searchParams,
			undefined,
			undefined,
			makeContext(cwd),
		);

		const text = String(
			(result.content[0] as { type: "text"; text: string }).text,
		);
		expect(text).toContain(hit.url);
		expect(text).toContain("OpenCode can search the web.");
		expect(result.isError).toBeFalsy();
		expect(result.details).toMatchObject({ status: "ok", costUsd: 0.01 });
		expect(result.structuredContent).toMatchObject({
			status: "ok",
			costUsd: 0.01,
			results: [{ url: hit.url }],
		});
		expect(result.usage?.cost.total).toBeCloseTo(0.01, 5);
	});

	it("reports a rejected key as an error", async () => {
		const configDir = enabledConfigDir();
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const tool = captureExtension({
			configDir,
			fetch: okFetch(jsonResponse({}, 401)),
			resolveApiKey: async () => "key",
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
		expect(result.structuredContent).toMatchObject({ status: "failed" });
		const text = String(
			(result.content[0] as { type: "text"; text: string }).text,
		);
		expect(text).toContain("401");
	});

	it("passes a requested limit to the Console call", async () => {
		const configDir = enabledConfigDir();
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				providerID: "opencode",
				results: [hit, { url: "https://example.com/second" }],
			}),
		);
		const tool = captureExtension({
			configDir,
			fetch: fetchImpl as unknown as typeof fetch,
			resolveApiKey: async () => "key",
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
	});

	it("reads the project config only from a trusted project", async () => {
		const configDir = makeTempDir("web-search-global-", tempDirs);
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		writeProjectConfig(cwd, { enabled: true });
		const fetchImpl = okFetch();
		const tool = captureExtension({
			configDir,
			fetch: fetchImpl,
			resolveApiKey: async () => "key",
		});

		const untrusted = await tool.execute(
			"call-6",
			searchParams,
			undefined,
			undefined,
			makeContext(cwd, { isProjectTrusted: () => false }),
		);
		expect(untrusted.details).toMatchObject({ status: "disabled" });

		const trusted = await tool.execute(
			"call-7",
			searchParams,
			undefined,
			undefined,
			makeContext(cwd, { isProjectTrusted: () => true }),
		);
		expect(trusted.details).toMatchObject({ status: "ok" });
	});

	it("resolves the credential from the configured provider", async () => {
		const configDir = enabledConfigDir();
		const cwd = makeTempDir("web-search-repo-", tempDirs);
		const requested: string[] = [];
		const tool = captureExtension({
			configDir,
			fetch: okFetch(),
			resolveApiKey: async (provider) => {
				requested.push(provider);
				return "key";
			},
		});

		await tool.execute(
			"call-8",
			searchParams,
			undefined,
			undefined,
			makeContext(cwd),
		);

		expect(requested[0]).toBe("opencode-go");
	});
});
