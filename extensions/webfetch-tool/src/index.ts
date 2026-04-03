import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { z } from "zod";

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
const STATUS_KEY = "webfetch-tool";
const DEBUG_WIDGET_KEY = "webfetch-tool-debug";
const MAX_DEBUG_EVENTS = 20;

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

type UiCtx = Pick<ExtensionContext, "hasUI" | "ui">;

interface DebugSnapshot {
	url: string;
	mode: WebfetchMode;
	statusCode: number;
	contentType: string;
	bodyBytes: number;
	conversionModelConfigured?: string;
	conversionModelUsed?: string;
	conversionPreprocessStrategy?: string;
	conversionInputCharsRaw?: number;
	conversionInputCharsPrepared?: number;
	usedSubagent: boolean;
	fallbackReason?: string;
	scanScore: number;
	scanDecision: string;
}

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

function summarizeHits(details: WebfetchDetails): string {
	if (details.scan.hits.length === 0) return "none";
	return details.scan.hits
		.slice(0, 4)
		.map((hit) => `${hit.engine}:${hit.ruleId} (${hit.context})`)
		.join(", ");
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

function summarizeReason(value: string | undefined, maxLength = 220): string {
	if (!value) return "<none>";
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, maxLength)}...`;
}

function buildReport(markdown: string, details: WebfetchDetails): string {
	const redirects = details.redirects.length;
	const warnings: string[] = [];
	if (details.scan.decision !== "allow") warnings.push(`risk=${details.scan.decision}`);
	if (details.truncated) warnings.push("body-truncated");
	if (details.markdownTruncated) warnings.push("markdown-truncated");
	if (!details.usedSubagent && details.fallbackReason) warnings.push("fallback-converter");

	const header = [
		`Webfetch: ${details.url}`,
		`Status: ${details.statusCode} | Type: ${details.contentType || "unknown"} | Bytes: ${details.bodyBytes}`,
		`Risk score: ${details.scan.finalScore} (semgrep=${details.scan.semgrepScore}, fuzzy=${details.scan.fuzzyScore}, boost=${details.scan.contextBoost})`,
		`Redirects: ${redirects} | Mode: ${details.mode}`,
		`Conversion model used: ${details.conversionModelUsed ?? "<none>"}`,
		`Conversion input: ${details.conversionInputCharsPrepared ?? 0}/${details.conversionInputCharsRaw ?? 0} chars (${details.conversionPreprocessStrategy ?? "n/a"})`,
		`Detector hits: ${summarizeHits(details)}`,
		`Warnings: ${warnings.length > 0 ? warnings.join(", ") : "none"}`,
		`Fallback reason: ${summarizeReason(details.fallbackReason)}`,
	];

	return `${header.join("\n")}\n\n---\n\n${markdown}`;
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
	let debugEnabled = false;
	const debugEvents: string[] = [];
	let lastSnapshot: DebugSnapshot | undefined;

	const getDebugLines = () => {
		const lines: string[] = [];
		lines.push(`debug: ${debugEnabled ? "ON" : "OFF"}`);
		if (lastSnapshot) {
			lines.push(`last url: ${lastSnapshot.url}`);
			lines.push(`last mode: ${lastSnapshot.mode}`);
			lines.push(`last status/type: ${lastSnapshot.statusCode} ${lastSnapshot.contentType || "unknown"}`);
			lines.push(
				`last conversion: used=${lastSnapshot.conversionModelUsed ?? "<none>"} subagent=${lastSnapshot.usedSubagent} input=${lastSnapshot.conversionInputCharsPrepared ?? 0}/${lastSnapshot.conversionInputCharsRaw ?? 0} (${lastSnapshot.conversionPreprocessStrategy ?? "n/a"})`,
			);
			if (lastSnapshot.fallbackReason) {
				lines.push(`last fallback: ${lastSnapshot.fallbackReason}`);
			}
			lines.push(`last scan: ${lastSnapshot.scanScore} (${lastSnapshot.scanDecision})`);
		}
		if (debugEvents.length > 0) {
			lines.push("recent events:");
			for (const event of debugEvents.slice(-8)) {
				lines.push(event);
			}
		}
		return lines;
	};

	const syncDebugUi = (ctx: UiCtx) => {
		if (!ctx.hasUI) return;
		if (!debugEnabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(DEBUG_WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, "webfetch debug ON");
		ctx.ui.setWidget(DEBUG_WIDGET_KEY, getDebugLines());
	};

	const addDebugEvent = (message: string, ctx?: UiCtx) => {
		const line = `${new Date().toISOString()} ${message}`;
		debugEvents.push(line);
		if (debugEvents.length > MAX_DEBUG_EVENTS) {
			debugEvents.splice(0, debugEvents.length - MAX_DEBUG_EVENTS);
		}
		if (debugEnabled && ctx) {
			syncDebugUi(ctx);
		}
	};

	const buildDebugDump = () => {
		const lines: string[] = [];
		lines.push("# webfetch-tool debug dump");
		lines.push("");
		lines.push(`debugEnabled: ${debugEnabled}`);
		if (lastSnapshot) {
			lines.push("");
			lines.push("## last-run");
			lines.push(`- url: ${lastSnapshot.url}`);
			lines.push(`- mode: ${lastSnapshot.mode}`);
			lines.push(`- statusCode: ${lastSnapshot.statusCode}`);
			lines.push(`- contentType: ${lastSnapshot.contentType || "unknown"}`);
			lines.push(`- bodyBytes: ${lastSnapshot.bodyBytes}`);
			lines.push(`- conversionModelConfigured: ${lastSnapshot.conversionModelConfigured ?? "<none>"}`);
			lines.push(`- conversionModelUsed: ${lastSnapshot.conversionModelUsed ?? "<none>"}`);
			lines.push(`- conversionPreprocessStrategy: ${lastSnapshot.conversionPreprocessStrategy ?? "<none>"}`);
			lines.push(`- conversionInputCharsRaw: ${lastSnapshot.conversionInputCharsRaw ?? 0}`);
			lines.push(`- conversionInputCharsPrepared: ${lastSnapshot.conversionInputCharsPrepared ?? 0}`);
			lines.push(`- usedSubagent: ${lastSnapshot.usedSubagent}`);
			lines.push(`- fallbackReason: ${lastSnapshot.fallbackReason ?? "<none>"}`);
			lines.push(`- scan: ${lastSnapshot.scanScore} (${lastSnapshot.scanDecision})`);
		}
		lines.push("");
		lines.push("## recent-events");
		if (debugEvents.length === 0) {
			lines.push("(none)");
		} else {
			for (const event of debugEvents) lines.push(`- ${event}`);
		}
		return `${lines.join("\n")}\n`;
	};

	pi.registerCommand("webfetch-debug", {
		description: "Debug webfetch-tool (on|off|status|toggle|dump)",
		handler: async (args, ctx) => {
			const [subcommandRaw] = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = subcommandRaw ?? "toggle";

			switch (subcommand) {
				case "on": {
					debugEnabled = true;
					addDebugEvent("debug enabled", ctx);
					break;
				}
				case "off": {
					debugEnabled = false;
					addDebugEvent("debug disabled", ctx);
					break;
				}
				case "status": {
					addDebugEvent("debug status requested", ctx);
					break;
				}
				case "toggle": {
					debugEnabled = !debugEnabled;
					addDebugEvent(`debug ${debugEnabled ? "enabled" : "disabled"} (toggle)`, ctx);
					break;
				}
				case "dump": {
					addDebugEvent("debug dump generated", ctx);
					if (ctx.hasUI) {
						ctx.ui.setEditorText(buildDebugDump());
						ctx.ui.notify("webfetch debug dump copied to editor", "info");
					}
					break;
				}
				default: {
					if (ctx.hasUI) {
						ctx.ui.notify("Unknown subcommand. Use: /webfetch-debug [on|off|status|toggle|dump]", "warning");
					}
					return;
				}
			}

			syncDebugUi(ctx);
			if (ctx.hasUI && subcommand !== "dump") {
				ctx.ui.notify(`webfetch debug: ${debugEnabled ? "ON" : "OFF"}`, "info");
			}
		},
	});

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
			addDebugEvent(
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
			addDebugEvent(
				`fetch done url=${fetch.url} status=${fetch.statusCode} type=${fetch.contentType || "unknown"} bytes=${fetch.bodyBytes} redirects=${fetch.redirects.length}`,
				ctx,
			);

			onUpdate?.({
				content: [{ type: "text", text: `webfetch: scanning ${fetch.url} for prompt injection` }],
				details: { phase: "scan" },
			});

			const scan = scanPromptInjection(fetch.bodyText, fetch.contentType, options.strictSafety);
			addDebugEvent(`scan score=${scan.finalScore} decision=${scan.decision} hits=${scan.hits.length}`, ctx);
			const detailsBase: Omit<WebfetchDetails, "usedSubagent" | "fallbackReason" | "markdownTruncated"> = {
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
				lastSnapshot = {
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
				};
				const blockMessage = [
					`Blocked: detected high prompt-injection risk in '${fetch.url}'.`,
					`Risk score: ${scan.finalScore}.`,
					"Use mode='raw_markdown' to review risky source content when explicitly needed.",
				].join(" ");

				const details: WebfetchDetails = {
					...detailsBase,
					usedSubagent: false,
					fallbackReason: "blocked by safety policy",
					markdownTruncated: false,
				};
				addDebugEvent(`run blocked by safety policy score=${scan.finalScore}`, ctx);
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

			const details: WebfetchDetails = {
				...detailsBase,
				conversionModelUsed: converted.conversionModelUsed,
				conversionPreprocessStrategy: converted.conversionPreprocessStrategy,
				conversionInputCharsRaw: converted.conversionInputCharsRaw,
				conversionInputCharsPrepared: converted.conversionInputCharsPrepared,
				usedSubagent: converted.usedSubagent,
				fallbackReason: converted.fallbackReason,
				markdownTruncated: truncated.truncated,
			};
			lastSnapshot = {
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
			};
			addDebugEvent(
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
