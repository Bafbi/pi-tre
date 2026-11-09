import { join } from "node:path";

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionFactory,
	type ExtensionToolContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { SEARCH_PROVIDER_ID, searchConsole } from "./client.js";
import { loadWebSearchConfig } from "./config.js";
import {
	formatDisabled,
	formatFailure,
	formatResults,
	formatUnconfigured,
	PRICE_USD_PER_SEARCH,
	truncateOutput,
} from "./output.js";
import { buildStructured, WebSearchOutputSchema } from "./structured.js";
import type { WebSearchDetails } from "./types.js";

/** Result cap the Console call accepts. */
const MAX_RESULTS = 20;

const SearchWebParams = Type.Object({
	query: Type.String({
		description:
			"The search query, in the words a search engine would expect. One topic per call.",
	}),
	limit: Type.Optional(
		Type.Number({
			description:
				"How many results to keep, 1 to 20. Defaults to the configured maxResults. Extra results cost nothing.",
			minimum: 1,
			maximum: MAX_RESULTS,
		}),
	),
});

type SearchWebParams = {
	query: string;
	limit?: number | undefined;
};

/**
 * Injection seams for tests. Production callers use the default export, which
 * passes no overrides.
 */
export interface WebSearchOverrides {
	/** Replaces the global fetch for the Console call. */
	fetch?: typeof fetch | undefined;
	/** Replaces credential resolution. */
	resolveApiKey?:
		| ((
				provider: string,
				ctx: ExtensionToolContext,
		  ) => Promise<string | undefined>)
		| undefined;
	/** Overrides the global config directory. Tests pass a temp dir. */
	configDir?: string | undefined;
}

/**
 * Provider ids tried when the configured credential provider has no key. Both
 * map to OPENCODE_API_KEY in pi's catalog, so a user signed in to either one
 * reaches the Console.
 */
const FALLBACK_CREDENTIAL_PROVIDERS = ["opencode-go", "opencode"];

/** Resolve the Console key from pi's credential store, then the environment. */
async function resolveApiKeyFromPi(
	provider: string,
	ctx: ExtensionToolContext,
): Promise<string | undefined> {
	const candidates = [
		provider,
		...FALLBACK_CREDENTIAL_PROVIDERS.filter((id) => id !== provider),
	];
	for (const candidate of candidates) {
		try {
			const key =
				await ctx.modelRegistry?.getApiKeyForProvider(candidate);
			if (key) return key;
		} catch {
			// A broken credential store reads as "no key", which the caller reports.
		}
	}
	return undefined;
}

/** The config files named in the refusal text. */
function configPaths(
	cwd: string,
	configDir: string | undefined,
): { global: string; project: string } {
	return {
		global: join(
			configDir ?? join(getAgentDir(), "configs"),
			"web-search.json",
		),
		project: join(cwd, CONFIG_DIR_NAME, "configs", "web-search.json"),
	};
}

/** Keep a requested limit inside what the Console accepts. */
function clampLimit(requested: number): number {
	if (!Number.isFinite(requested)) return MAX_RESULTS;
	return Math.min(Math.max(Math.trunc(requested), 1), MAX_RESULTS);
}

/** Create the web-search extension factory, with optional test overrides. */
export function createWebSearchExtension(
	overrides: WebSearchOverrides = {},
): ExtensionFactory {
	return function webSearchExtension(pi: ExtensionAPI) {
		pi.registerTool({
			name: "search_web",
			label: "Web Search",
			description: [
				"Search the live web through the OpenCode Console.",
				"Each successful search costs USD 0.01 from the OpenCode workspace balance, and the tool is off until the user enables it in web-search.json.",
				"Returns ranked results with a URL and a snippet per result.",
				"Use it for current information, releases, and documentation that the repository cannot answer.",
			].join(" "),
			promptSnippet:
				"Search the live web through the OpenCode Console (USD 0.01 per search)",
			promptGuidelines: [
				"Use search_web for current facts, releases, and documentation outside this repository.",
				"search_web costs USD 0.01 per successful search. Ask for the pages you need in one query rather than several calls.",
				"When search_web reports that it is off, tell the user which config file enables it. Do not retry the call.",
				"Cite the result URLs that you used. A snippet is an excerpt, not the page.",
			],
			parameters: SearchWebParams,
			outputSchema: WebSearchOutputSchema,
			annotations: {
				// A search mutates nothing, but it does spend money. Marking it
				// read-only would let a permission extension auto-approve a paid
				// call, so the honest hint is "not read-only".
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},

			async execute(
				_toolCallId,
				params: SearchWebParams,
				signal,
				_onUpdate,
				ctx,
			) {
				const config = loadWebSearchConfig({
					cwd: ctx.cwd,
					trusted: ctx.isProjectTrusted(),
					configDir: overrides.configDir,
				});
				const base = {
					query: params.query,
					provider: SEARCH_PROVIDER_ID,
					endpoint: config.endpoint,
					results: [],
					costUsd: 0,
				} satisfies Omit<WebSearchDetails, "status">;

				const respond = (
					details: WebSearchDetails,
					text: string,
					isError = false,
				) => ({
					content: [
						{ type: "text" as const, text: truncateOutput(text) },
					],
					details,
					structuredContent: buildStructured(details),
					...(isError ? { isError: true } : {}),
				});

				// The gate is read per call, so a config change takes effect without
				// a reload. A refusal is plain text: an isError result is what a
				// codemode script's bare catch swallows.
				if (!config.enabled) {
					return respond(
						{ ...base, status: "disabled" },
						formatDisabled(
							configPaths(ctx.cwd, overrides.configDir),
						),
					);
				}

				const resolveKey =
					overrides.resolveApiKey ?? resolveApiKeyFromPi;
				const apiKey = await resolveKey(config.credentialProvider, ctx);
				if (!apiKey) {
					return respond(
						{ ...base, status: "unconfigured" },
						formatUnconfigured(config.credentialProvider),
					);
				}

				const outcome = await searchConsole(
					{
						query: params.query,
						apiKey,
						endpoint: config.endpoint,
						timeoutMs: config.timeoutMs,
						maxResults: clampLimit(
							params.limit ?? config.maxResults,
						),
						signal,
					},
					{ fetch: overrides.fetch },
				);

				if (!outcome.ok) {
					const details: WebSearchDetails = {
						...base,
						status: "failed",
						error: outcome.message,
					};
					return respond(details, formatFailure(details), true);
				}

				const details: WebSearchDetails = {
					...base,
					status: "ok",
					results: outcome.results,
					costUsd: PRICE_USD_PER_SEARCH,
				};
				return {
					...respond(
						details,
						formatResults(params.query, outcome.results),
					),
					// The spend shows in session totals without a counter of ours.
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: PRICE_USD_PER_SEARCH,
						},
					},
				};
			},
		});
	};
}

export default function (pi: ExtensionAPI): void {
	createWebSearchExtension()(pi);
}
