import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type ExtensionAPI, getAgentDir } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { z } from "zod";

import { createWebfetchDebugController } from "./debug.js";
import { WEBFETCH_DETAILS_VERSION, validateWebfetchDetails } from "./details/index.js";
import { fetchWithCurl } from "./fetch.js";
import { deterministicTextMarkdown, fallbackMarkdown, shouldUseSubagentConversion } from "./markdown.js";
import { preprocessHtmlForConversion } from "./preprocess-html.js";
import { scanPromptInjection } from "./scan.js";
import { convertWithSubagent } from "./subagent.js";
import type {
	HtmlPreprocessor,
	MarkdownConversionResult,
	WebfetchDetails,
	WebfetchExtensionConfig,
	WebfetchMode,
	WebfetchOptions,
} from "./types.js";

const DEFAULT_MAX_BYTES = 400_000;
const DEFAULT_TIMEOUT_SEC = 25;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_MARKDOWN_CHARS = 30_000;
const DEFAULT_SUBAGENT_INPUT_MAX_CHARS = 60_000;
const CONVERSION_MODEL_ENV = "PI_WEBFETCH_CONVERSION_MODEL";
const HTML_PREPROCESSOR_ENV = "PI_WEBFETCH_HTML_PREPROCESSOR";
const CONVERSION_MODEL_FLAG = "webfetch-conversion-model";
const HTML_PREPROCESSOR_FLAG = "webfetch-html-preprocessor";
const EXTENSION_CONFIG_FILE = "webfetch-tool.json";

const extensionConfigSchema = z
	.object({
		$schema: z.string().optional(),
		conversionModel: z.string().min(3).optional(),
		htmlPreprocessor: z.enum(["regex", "dom"]).optional(),
		strictSafety: z.boolean().optional(),
		maxBytes: z.number().int().optional(),
		timeoutSec: z.number().int().optional(),
		maxRedirects: z.number().int().optional(),
		maxMarkdownChars: z.number().int().optional(),
		defaultMode: z.enum(["safe_markdown", "raw_markdown", "extract_only"]).optional(),
	})
	.strict();

function normalizeMode(input: string | undefined): WebfetchMode {
	if (input === "raw_markdown") return "raw_markdown";
	if (input === "extract_only") return "extract_only";
	return "safe_markdown";
}

function normalizeConfiguredMode(input: unknown): WebfetchMode | undefined {
	if (typeof input !== "string") return undefined;
	if (input === "safe_markdown" || input === "raw_markdown" || input === "extract_only") return input;
	return undefined;
}

function normalizeModelValue(input: unknown): string | undefined {
	if (typeof input !== "string") return undefined;
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	if (trimmed.toLowerCase() === "default") return undefined;
	return trimmed;
}

function normalizeHtmlPreprocessor(input: unknown): HtmlPreprocessor | undefined {
	if (typeof input !== "string") return undefined;
	const trimmed = input.trim().toLowerCase();
	if (trimmed === "dom") return "dom";
	if (trimmed === "regex") return "regex";
	return undefined;
}

function readConfigFile(path: string): WebfetchExtensionConfig {
	if (!existsSync(path)) return {};
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		const validated = extensionConfigSchema.safeParse(parsed);
		if (!validated.success) return {};
		const { $schema: _schema, ...config } = validated.data;
		return config;
	} catch {
		return {};
	}
}

function loadExtensionConfig(cwd: string): WebfetchExtensionConfig {
	const globalConfigPath = join(getAgentDir(), "extensions", EXTENSION_CONFIG_FILE);
	const projectConfigPath = join(cwd, ".pi", "extensions", EXTENSION_CONFIG_FILE);
	const globalConfig = readConfigFile(globalConfigPath);
	const projectConfig = readConfigFile(projectConfigPath);
	return {
		...globalConfig,
		...projectConfig,
	};
}

function clampNumber(input: unknown, fallback: number, min: number, max: number): number {
	if (typeof input !== "number" || Number.isNaN(input)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(input)));
}

function toOptions(
	input: {
		url: string;
		mode?: string;
	},
	defaults: {
		flagConversionModel?: string;
		configConversionModel?: string;
		envConversionModel?: string;
		flagHtmlPreprocessor?: HtmlPreprocessor;
		configHtmlPreprocessor?: HtmlPreprocessor;
		envHtmlPreprocessor?: HtmlPreprocessor;
		configStrictSafety?: boolean;
		configMaxBytes?: number;
		configTimeoutSec?: number;
		configMaxRedirects?: number;
		configMaxMarkdownChars?: number;
		configDefaultMode?: WebfetchMode;
	},
): WebfetchOptions {
	return {
		url: input.url,
		mode: normalizeMode(input.mode ?? defaults.configDefaultMode),
		strictSafety: defaults.configStrictSafety ?? true,
		maxBytes: clampNumber(defaults.configMaxBytes, DEFAULT_MAX_BYTES, 10_000, 2_000_000),
		timeoutSec: clampNumber(defaults.configTimeoutSec, DEFAULT_TIMEOUT_SEC, 5, 120),
		maxRedirects: clampNumber(defaults.configMaxRedirects, DEFAULT_MAX_REDIRECTS, 0, 8),
		maxMarkdownChars: clampNumber(defaults.configMaxMarkdownChars, DEFAULT_MAX_MARKDOWN_CHARS, 2_000, 120_000),
		conversionModel: defaults.flagConversionModel ?? defaults.configConversionModel ?? defaults.envConversionModel,
		htmlPreprocessor:
			defaults.flagHtmlPreprocessor ?? defaults.configHtmlPreprocessor ?? defaults.envHtmlPreprocessor ?? "regex",
	};
}

function topDetectorHits(details: WebfetchDetails): string[] {
	return details.scan.hits.slice(0, 4).map((hit) => `${hit.engine}:${hit.ruleId} (${hit.context})`);
}

function formatToolCallUrl(url: string | undefined, maxLength = 90): string {
	const value = (url ?? "").trim();
	if (!value) return "<missing-url>";
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}...`;
}

function truncateMarkdown(markdown: string, maxChars: number): { markdown: string; truncated: boolean } {
	if (markdown.length <= maxChars) return { markdown, truncated: false };
	return {
		markdown: `${markdown.slice(0, maxChars)}\n\n...[truncated]...`,
		truncated: true,
	};
}

function summarizeReason(value: string | undefined, maxLength = 220): string | undefined {
	if (!value) return undefined;
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, maxLength)}...`;
}

function yamlQuote(value: string): string {
	return JSON.stringify(value);
}

function yamlStringList(key: string, values: string[]): string[] {
	if (values.length === 0) return [`${key}: []`];
	return [`${key}:`, ...values.map((value) => `  - ${yamlQuote(value)}`)];
}

function buildReport(markdown: string, details: WebfetchDetails): string {
	const warnings: string[] = [];
	if (details.scan.decision !== "allow") warnings.push(`risk=${details.scan.decision}`);
	if (details.truncated) warnings.push("body-truncated");
	if (details.markdownTruncated) warnings.push("markdown-truncated");
	if (!details.usedSubagent && details.fallbackReason) warnings.push("fallback-converter");

	const detectorHits = topDetectorHits(details);
	const fallbackReason = summarizeReason(details.fallbackReason);

	const frontmatterLines = [
		"---",
		`webfetchDetailsVersion: ${details.webfetchDetailsVersion}`,
		`url: ${yamlQuote(details.url)}`,
		`statusCode: ${details.statusCode}`,
		`contentType: ${yamlQuote(details.contentType || "unknown")}`,
		`bodyBytes: ${details.bodyBytes}`,
		`mode: ${yamlQuote(details.mode)}`,
		`redirectCount: ${details.redirects.length}`,
		`truncatedBody: ${details.truncated}`,
		`markdownTruncated: ${details.markdownTruncated}`,
		"risk:",
		`  decision: ${yamlQuote(details.scan.decision)}`,
		`  finalScore: ${details.scan.finalScore}`,
		`  semgrepScore: ${details.scan.semgrepScore}`,
		`  fuzzyScore: ${details.scan.fuzzyScore}`,
		`  contextBoost: ${details.scan.contextBoost}`,
		"conversion:",
		`  usedSubagent: ${details.usedSubagent}`,
		`  modelUsed: ${details.conversionModelUsed ? yamlQuote(details.conversionModelUsed) : "null"}`,
		`  preprocessStrategy: ${details.conversionPreprocessStrategy ? yamlQuote(details.conversionPreprocessStrategy) : "null"}`,
		`  inputCharsRaw: ${details.conversionInputCharsRaw ?? 0}`,
		`  inputCharsPrepared: ${details.conversionInputCharsPrepared ?? 0}`,
		...yamlStringList("warnings", warnings),
		...yamlStringList("detectorHits", detectorHits),
		`fallbackReason: ${fallbackReason ? yamlQuote(fallbackReason) : "null"}`,
		"---",
	];

	return `${frontmatterLines.join("\n")}\n\n${markdown}`;
}

async function convertToMarkdown(
	mode: WebfetchMode,
	bodyText: string,
	contentType: string,
	url: string,
	cwd: string,
	timeoutSec: number,
	conversionModel: string | undefined,
	htmlPreprocessor: HtmlPreprocessor,
	signal?: AbortSignal,
): Promise<MarkdownConversionResult> {
	if (mode === "extract_only") {
		return {
			markdown: fallbackMarkdown(bodyText, contentType, url),
			usedSubagent: false,
			conversionPreprocessStrategy: "extract-only",
			conversionInputCharsRaw: bodyText.length,
			conversionInputCharsPrepared: bodyText.length,
			fallbackReason: "extract_only mode",
		};
	}

	if (!shouldUseSubagentConversion(contentType, bodyText)) {
		return {
			markdown: deterministicTextMarkdown(bodyText, contentType),
			usedSubagent: false,
			conversionPreprocessStrategy: "deterministic-text",
			conversionInputCharsRaw: bodyText.length,
			conversionInputCharsPrepared: bodyText.length,
			fallbackReason: "deterministic text conversion",
		};
	}

	const preprocessed = preprocessHtmlForConversion(bodyText, {
		maxChars: DEFAULT_SUBAGENT_INPUT_MAX_CHARS,
		preprocessor: htmlPreprocessor,
	});

	try {
		const converted = await convertWithSubagent(
			preprocessed.htmlForConversion,
			url,
			cwd,
			timeoutSec,
			conversionModel,
			signal,
		);
		return {
			markdown: converted.markdown,
			usedSubagent: true,
			conversionModelUsed: converted.modelUsed,
			conversionPreprocessStrategy: preprocessed.strategy,
			conversionInputCharsRaw: preprocessed.rawChars,
			conversionInputCharsPrepared: preprocessed.preparedChars,
		};
	} catch (error) {
		return {
			markdown: fallbackMarkdown(bodyText, contentType, url),
			usedSubagent: false,
			conversionPreprocessStrategy: preprocessed.strategy,
			conversionInputCharsRaw: preprocessed.rawChars,
			conversionInputCharsPrepared: preprocessed.preparedChars,
			fallbackReason: error instanceof Error ? error.message : "sub-agent conversion failed",
		};
	}
}

export default function (pi: ExtensionAPI) {
	const debug = createWebfetchDebugController(pi);
	debug.registerCommand();

	pi.registerFlag(CONVERSION_MODEL_FLAG, {
		description: "Default model for webfetch markdown conversion sub-agent",
		type: "string",
	});

	pi.registerFlag(HTML_PREPROCESSOR_FLAG, {
		description: "HTML preprocessing engine for webfetch conversion (regex|dom)",
		type: "string",
	});

	pi.registerTool({
		name: "webfetch",
		label: "Web Fetch",
		description:
			"Fetch a web page with curl, run prompt-injection scoring (semgrep-like + fuzzy), then convert content to markdown via a constrained sub-agent.",
		promptSnippet:
			"Use webfetch for web pages. It performs URL policy checks, injection scoring, and markdown conversion before returning content.",
		renderCall(args, theme, _context) {
			const url = formatToolCallUrl(typeof args.url === "string" ? args.url : undefined);
			const title = theme.fg("toolTitle", theme.bold("webfetch"));
			const urlDisplay = theme.fg("accent", url);
			return new Text(`${title} ${urlDisplay}`, 0, 0);
		},
		parameters: Type.Object({
			url: Type.String({ description: "HTTP(S) URL to fetch." }),
			mode: Type.Optional(
				Type.String({
					description: "safe_markdown | raw_markdown | extract_only (default: extension config or safe_markdown)",
				}),
			),
		}),
		async execute(_toolCallId, input, signal, onUpdate, ctx) {
			const extensionConfig = loadExtensionConfig(ctx.cwd);
			const flagConversionModel = normalizeModelValue(pi.getFlag(CONVERSION_MODEL_FLAG));
			const configConversionModel = normalizeModelValue(extensionConfig.conversionModel);
			const envConversionModel = normalizeModelValue(process.env[CONVERSION_MODEL_ENV]);
			const flagHtmlPreprocessor = normalizeHtmlPreprocessor(pi.getFlag(HTML_PREPROCESSOR_FLAG));
			const configHtmlPreprocessor = normalizeHtmlPreprocessor(extensionConfig.htmlPreprocessor);
			const envHtmlPreprocessor = normalizeHtmlPreprocessor(process.env[HTML_PREPROCESSOR_ENV]);
			const options = toOptions(input, {
				flagConversionModel,
				configConversionModel,
				envConversionModel,
				flagHtmlPreprocessor,
				configHtmlPreprocessor,
				envHtmlPreprocessor,
				configStrictSafety: extensionConfig.strictSafety,
				configMaxBytes: extensionConfig.maxBytes,
				configTimeoutSec: extensionConfig.timeoutSec,
				configMaxRedirects: extensionConfig.maxRedirects,
				configMaxMarkdownChars: extensionConfig.maxMarkdownChars,
				configDefaultMode: normalizeConfiguredMode(extensionConfig.defaultMode),
			});
			debug.addEvent(
				`run start url=${options.url} mode=${options.mode} strict=${options.strictSafety} timeout=${options.timeoutSec}s maxBytes=${options.maxBytes} model=${options.conversionModel ?? "<default>"} preprocessor=${options.htmlPreprocessor}`,
				ctx,
			);

			onUpdate?.({
				content: [{ type: "text", text: `webfetch: validating + fetching ${options.url}` }],
				details: { phase: "fetch" },
			});

			const fetch = await fetchWithCurl({
				url: options.url,
				maxBytes: options.maxBytes,
				timeoutSec: options.timeoutSec,
				maxRedirects: options.maxRedirects,
				allowPrivateHosts: false,
				signal,
			});
			debug.addEvent(
				`fetch done url=${fetch.url} status=${fetch.statusCode} type=${fetch.contentType || "unknown"} bytes=${fetch.bodyBytes} redirects=${fetch.redirects.length}`,
				ctx,
			);

			onUpdate?.({
				content: [{ type: "text", text: `webfetch: scanning ${fetch.url} for prompt injection` }],
				details: { phase: "scan" },
			});

			const scan = scanPromptInjection(fetch.bodyText, fetch.contentType, options.strictSafety);
			debug.addEvent(`scan score=${scan.finalScore} decision=${scan.decision} hits=${scan.hits.length}`, ctx);
			const detailsBase: Omit<WebfetchDetails, "usedSubagent" | "fallbackReason" | "markdownTruncated"> = {
				webfetchDetailsVersion: WEBFETCH_DETAILS_VERSION,
				url: fetch.url,
				statusCode: fetch.statusCode,
				contentType: fetch.contentType,
				bodyBytes: fetch.bodyBytes,
				truncated: fetch.truncated,
				redirects: fetch.redirects,
				scan,
				mode: options.mode,
			};

			if (scan.decision === "block" && options.strictSafety && options.mode === "safe_markdown") {
				debug.setSnapshot(
					{
						url: fetch.url,
						mode: options.mode,
						statusCode: fetch.statusCode,
						contentType: fetch.contentType,
						bodyBytes: fetch.bodyBytes,
						conversionModelConfigured: options.conversionModel,
						usedSubagent: false,
						fallbackReason: "blocked by safety policy",
						scanScore: scan.finalScore,
						scanDecision: scan.decision,
					},
					ctx,
				);
				const blockMessage = [
					`Blocked: detected high prompt-injection risk in '${fetch.url}'.`,
					`Risk score: ${scan.finalScore}.`,
					"Use mode='raw_markdown' to review risky source content when explicitly needed.",
				].join(" ");

				const details = validateWebfetchDetails({
					...detailsBase,
					usedSubagent: false,
					fallbackReason: "blocked by safety policy",
					markdownTruncated: false,
				});
				debug.addEvent(`run blocked by safety policy score=${scan.finalScore}`, ctx);
				return {
					content: [{ type: "text", text: blockMessage }],
					details,
				};
			}

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `webfetch: converting content to markdown${options.conversionModel ? ` (model=${options.conversionModel})` : ""}`,
					},
				],
				details: { phase: "convert" },
			});

			const converted = await convertToMarkdown(
				options.mode,
				fetch.bodyText,
				fetch.contentType,
				fetch.url,
				ctx.cwd,
				options.timeoutSec,
				options.conversionModel,
				options.htmlPreprocessor,
				signal,
			);
			const truncated = truncateMarkdown(converted.markdown, options.maxMarkdownChars);

			const details = validateWebfetchDetails({
				...detailsBase,
				conversionModelUsed: converted.conversionModelUsed,
				conversionPreprocessStrategy: converted.conversionPreprocessStrategy,
				conversionInputCharsRaw: converted.conversionInputCharsRaw,
				conversionInputCharsPrepared: converted.conversionInputCharsPrepared,
				usedSubagent: converted.usedSubagent,
				fallbackReason: converted.fallbackReason,
				markdownTruncated: truncated.truncated,
			});
			debug.setSnapshot(
				{
					url: fetch.url,
					mode: options.mode,
					statusCode: fetch.statusCode,
					contentType: fetch.contentType,
					bodyBytes: fetch.bodyBytes,
					conversionModelConfigured: options.conversionModel,
					conversionModelUsed: converted.conversionModelUsed,
					conversionPreprocessStrategy: converted.conversionPreprocessStrategy,
					conversionInputCharsRaw: converted.conversionInputCharsRaw,
					conversionInputCharsPrepared: converted.conversionInputCharsPrepared,
					usedSubagent: converted.usedSubagent,
					fallbackReason: converted.fallbackReason,
					scanScore: scan.finalScore,
					scanDecision: scan.decision,
				},
				ctx,
			);
			debug.addEvent(
				`run complete subagent=${converted.usedSubagent} modelUsed=${converted.conversionModelUsed ?? "<none>"} input=${converted.conversionInputCharsPrepared ?? 0}/${converted.conversionInputCharsRaw ?? 0} strategy=${converted.conversionPreprocessStrategy ?? "n/a"} fallback=${converted.fallbackReason ?? "<none>"}`,
				ctx,
			);
			const report = buildReport(truncated.markdown, details);

			return {
				content: [{ type: "text", text: report }],
				details,
			};
		},
	});
}
