import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type ExtensionAPI, type Theme, getAgentDir, keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { z } from "zod";

import { type WebfetchDebugArtifactRefs, createWebfetchDebugController } from "./debug.js";
import { WEBFETCH_DETAILS_VERSION, validateWebfetchDetails } from "./details/index.js";
import { fetchWithCurl } from "./fetch.js";
import { deterministicTextMarkdown, fallbackMarkdown, shouldUseSubagentConversion } from "./markdown.js";
import { preprocessHtmlForConversion } from "./preprocess-html.js";
import { scanPromptInjection } from "./scan.js";
import { type SubagentDebugEvent, type SubagentProgressUpdate, convertWithSubagent } from "./subagent.js";
import type {
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
const CONVERSION_MODEL_FLAG = "webfetch-conversion-model";
const EXTENSION_CONFIG_FILE = "webfetch-tool.json";

const extensionConfigSchema = z
	.object({
		$schema: z.string().optional(),
		conversionModel: z.string().min(3).optional(),
		strictSafety: z.boolean().optional(),
		maxBytes: z.number().int().optional(),
		timeoutSec: z.number().int().optional(),
		maxRedirects: z.number().int().optional(),
		maxMarkdownChars: z.number().int().optional(),
		defaultMode: z.enum(["safe_markdown", "raw_markdown", "extract_only"]).optional(),
	})
	.strict();

type WebfetchProgressPhase = "fetch" | "scan" | "convert" | "convert-subagent";

interface WebfetchProgressDetails {
	phase: WebfetchProgressPhase;
	message: string;
	subagentPreview?: string;
}

interface ConversionDebugHooks {
	onPreprocessedHtml?: (html: string) => Promise<void> | void;
	onSubagentEvent?: (event: SubagentDebugEvent) => void;
	onFinalOutput?: (markdown: string) => Promise<void> | void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isWebfetchDetailsPayload(value: unknown): value is WebfetchDetails {
	if (!isRecord(value)) return false;
	if (value.webfetchDetailsVersion !== WEBFETCH_DETAILS_VERSION) return false;
	if (typeof value.url !== "string") return false;
	if (typeof value.statusCode !== "number") return false;
	if (!isRecord(value.scan)) return false;
	return true;
}

function isWebfetchProgressDetails(value: unknown): value is WebfetchProgressDetails {
	if (!isRecord(value)) return false;
	if (typeof value.phase !== "string") return false;
	if (typeof value.message !== "string") return false;
	if (value.subagentPreview !== undefined && typeof value.subagentPreview !== "string") return false;
	return true;
}

async function initializeDebugArtifacts(cwd: string): Promise<WebfetchDebugArtifactRefs> {
	const runId = new Date().toISOString().replace(/[:.]/g, "-");
	const runDir = join(cwd, ".pi", "webfetch-debug", runId);
	await mkdir(runDir, { recursive: true });
	return { runDir };
}

async function writeDebugArtifact(runDir: string, fileName: string, content: string): Promise<string> {
	const path = join(runDir, fileName);
	await writeFile(path, content, "utf8");
	return path;
}

function extractSubagentMessageText(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text?: string } => isRecord(part) && typeof part.type === "string")
		.filter((part) => part.type === "text")
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("\n")
		.trim();
}

function buildSubagentConversationMarkdown(events: SubagentDebugEvent[]): string {
	const lines: string[] = [];
	lines.push("# subagent conversation");
	lines.push("");
	lines.push(`- eventCount: ${events.length}`);
	lines.push(`- parsedCount: ${events.filter((event) => event.parsed !== undefined).length}`);
	lines.push(`- parseErrorCount: ${events.filter((event) => event.parseError !== undefined).length}`);
	lines.push("");

	let messageIndex = 0;
	for (const event of events) {
		if (!isRecord(event.parsed)) continue;
		if (event.parsed.type !== "message_end") continue;
		if (!isRecord(event.parsed.message)) continue;

		const message = event.parsed.message;
		const role = typeof message.role === "string" ? message.role : "unknown";
		const model = typeof message.model === "string" ? message.model : undefined;
		const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
		const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
		const text = extractSubagentMessageText(message);

		lines.push(`## [${messageIndex}] role=${role}${model ? ` model=${model}` : ""}`);
		if (stopReason) lines.push(`- stopReason: ${stopReason}`);
		if (errorMessage) lines.push(`- errorMessage: ${errorMessage}`);
		lines.push("");
		lines.push("~~~text");
		lines.push(text || "(no text content)");
		lines.push("~~~");
		lines.push("");
		messageIndex++;
	}

	if (messageIndex === 0) {
		lines.push("(no message_end events captured)");
		lines.push("");
	}

	return lines.join("\n");
}

function serializeSubagentEventsJsonl(events: SubagentDebugEvent[]): string {
	return events.map((event) => JSON.stringify(event)).join("\n");
}

function extractToolResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((entry) => entry.type === "text")
		.map((entry) => entry.text ?? "")
		.join("\n")
		.trim();
}

function summarizePreview(text: string, maxLines = 6, maxLineChars = 140): string[] {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	if (lines.length === 0) return [];
	return lines
		.slice(-maxLines)
		.map((line) => (line.length <= maxLineChars ? line : `${line.slice(0, maxLineChars)}...`));
}

function phaseLabel(phase: WebfetchProgressPhase): string {
	switch (phase) {
		case "fetch":
			return "fetching";
		case "scan":
			return "scanning";
		case "convert":
			return "converting";
		case "convert-subagent":
			return "sub-agent converting";
		default:
			return "working";
	}
}

function renderWebfetchResult(
	result: { content: Array<{ type: string; text?: string }>; details: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Text {
	const title = theme.fg("toolTitle", theme.bold("webfetch"));
	const textOutput = extractToolResultText(result);

	if (options.isPartial) {
		const progress = isWebfetchProgressDetails(result.details)
			? result.details
			: ({ phase: "convert", message: textOutput || "working" } satisfies WebfetchProgressDetails);
		let text = `${title} ${theme.fg("warning", phaseLabel(progress.phase))}`;
		text += `\n${theme.fg("muted", progress.message)}`;
		if (progress.subagentPreview) {
			text += `\n${theme.fg("accent", "sub-agent stream")}`;
			for (const line of summarizePreview(progress.subagentPreview)) {
				text += `\n${theme.fg("dim", line)}`;
			}
		}
		return new Text(text, 0, 0);
	}

	if (!isWebfetchDetailsPayload(result.details)) {
		return new Text(textOutput || `${title} ${theme.fg("success", "done")}`, 0, 0);
	}

	const details = result.details;
	const riskColor =
		details.scan.decision === "block"
			? "error"
			: details.scan.decision === "allow_with_warning"
				? "warning"
				: "success";
	const summaryBits = [
		theme.fg("success", `${details.statusCode}`),
		theme.fg("muted", details.contentType || "unknown"),
		theme.fg(riskColor, `risk=${details.scan.decision}:${details.scan.finalScore}`),
		theme.fg("muted", `conv=${details.usedSubagent ? "subagent" : "fallback"}`),
	];

	let text = `${title} ${summaryBits.join(" ")}`;
	if (!options.expanded) {
		const warnings: string[] = [];
		if (details.truncated) warnings.push("body-truncated");
		if (details.markdownTruncated) warnings.push("markdown-truncated");
		if (!details.usedSubagent && details.fallbackReason) warnings.push("fallback");
		if (warnings.length > 0) {
			text += `\n${theme.fg("warning", warnings.join(", "))}`;
		}
		text += `\n${keyHint("app.tools.expand", "to expand")}`;
		return new Text(text, 0, 0);
	}

	text += `\n${theme.fg("accent", "url:")} ${theme.fg("dim", details.url)}`;
	text += `\n${theme.fg("accent", "redirects:")} ${theme.fg("dim", String(details.redirects.length))}`;
	text += `\n${theme.fg("accent", "bytes:")} ${theme.fg("dim", String(details.bodyBytes))}`;
	text += `\n${theme.fg("accent", "conversion:")} ${theme.fg("dim", details.conversionPreprocessStrategy ?? "unknown")}`;
	if (details.conversionInputCharsPrepared !== undefined && details.conversionInputCharsRaw !== undefined) {
		text += ` ${theme.fg("dim", `(${details.conversionInputCharsPrepared}/${details.conversionInputCharsRaw} chars)`)} `;
	}
	if (details.fallbackReason) {
		text += `\n${theme.fg("warning", `fallback: ${summarizeReason(details.fallbackReason, 160)}`)}`;
	}
	if (details.scan.hits.length > 0) {
		text += `\n${theme.fg("accent", "detectors:")}`;
		for (const hit of topDetectorHits(details)) {
			text += `\n${theme.fg("dim", `- ${hit}`)}`;
		}
	}

	const previewLines = summarizePreview(textOutput, 10, 160);
	if (previewLines.length > 0) {
		text += `\n${theme.fg("accent", "output preview:")}`;
		for (const line of previewLines) {
			text += `\n${theme.fg("dim", line)}`;
		}
	}

	return new Text(text, 0, 0);
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

function buildSubagentPreview(text: string, maxChars = 900): string {
	const compact = text.replace(/\r/g, "").trim();
	if (!compact) return "";
	if (compact.length <= maxChars) return compact;
	return `...${compact.slice(compact.length - maxChars)}`;
}

function mapSubagentProgressStageToMessage(stage: SubagentProgressUpdate["stage"]): string {
	switch (stage) {
		case "launching":
			return "starting markdown sub-agent";
		case "reading-source":
			return "sub-agent reading prepared HTML source";
		case "converting":
			return "sub-agent generating markdown";
		case "completed":
			return "sub-agent finished conversion";
		default:
			return "sub-agent converting";
	}
}

async function convertToMarkdown(
	mode: WebfetchMode,
	bodyText: string,
	contentType: string,
	url: string,
	cwd: string,
	timeoutSec: number,
	conversionModel: string | undefined,
	signal: AbortSignal | undefined,
	onProgress?: (details: WebfetchProgressDetails) => void,
	debugHooks?: ConversionDebugHooks,
): Promise<MarkdownConversionResult> {
	if (mode === "extract_only") {
		onProgress?.({ phase: "convert", message: "extract_only mode: using deterministic fallback markdown" });
		const markdown = fallbackMarkdown(bodyText, contentType, url);
		await debugHooks?.onFinalOutput?.(markdown);
		return {
			markdown,
			usedSubagent: false,
			conversionPreprocessStrategy: "extract-only",
			conversionInputCharsRaw: bodyText.length,
			conversionInputCharsPrepared: bodyText.length,
			fallbackReason: "extract_only mode",
		};
	}

	if (!shouldUseSubagentConversion(contentType, bodyText)) {
		onProgress?.({ phase: "convert", message: "deterministic text conversion (non-HTML content)" });
		const markdown = deterministicTextMarkdown(bodyText, contentType);
		await debugHooks?.onFinalOutput?.(markdown);
		return {
			markdown,
			usedSubagent: false,
			conversionPreprocessStrategy: "deterministic-text",
			conversionInputCharsRaw: bodyText.length,
			conversionInputCharsPrepared: bodyText.length,
			fallbackReason: "deterministic text conversion",
		};
	}

	const preprocessed = preprocessHtmlForConversion(bodyText, {
		maxChars: DEFAULT_SUBAGENT_INPUT_MAX_CHARS,
	});
	await debugHooks?.onPreprocessedHtml?.(preprocessed.htmlForConversion);
	onProgress?.({
		phase: "convert-subagent",
		message: `prepared HTML with strategy='${preprocessed.strategy}' (${preprocessed.preparedChars}/${preprocessed.rawChars} chars)`,
	});

	try {
		const converted = await convertWithSubagent(
			preprocessed.htmlForConversion,
			url,
			cwd,
			timeoutSec,
			conversionModel,
			signal,
			(update) => {
				onProgress?.({
					phase: "convert-subagent",
					message: mapSubagentProgressStageToMessage(update.stage),
					subagentPreview: update.assistantText ? buildSubagentPreview(update.assistantText) : undefined,
				});
			},
			(event) => {
				debugHooks?.onSubagentEvent?.(event);
			},
		);
		await debugHooks?.onFinalOutput?.(converted.markdown);
		return {
			markdown: converted.markdown,
			usedSubagent: true,
			conversionModelUsed: converted.modelUsed,
			conversionPreprocessStrategy: preprocessed.strategy,
			conversionInputCharsRaw: preprocessed.rawChars,
			conversionInputCharsPrepared: preprocessed.preparedChars,
		};
	} catch (error) {
		// Detect parent cancellation and rethrow to preserve AbortSignal
		if (signal?.aborted) {
			throw error;
		}
		if (error instanceof Error && error.name === "AbortError") {
			throw error;
		}
		const markdown = fallbackMarkdown(bodyText, contentType, url);
		await debugHooks?.onFinalOutput?.(markdown);
		return {
			markdown,
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

	pi.registerTool({
		name: "webfetch",
		label: "Web Fetch",
		description:
			"Fetch a web page with curl, run prompt-injection scoring (semgrep-like + fuzzy), then convert content to markdown via a constrained sub-agent.",
		promptSnippet:
			"Use webfetch for web pages. It performs URL policy checks, injection scoring, and markdown conversion before returning content.",
		renderCall(args, theme, _context) {
			const url = formatToolCallUrl(typeof args.url === "string" ? args.url : undefined);
			const mode = typeof args.mode === "string" ? args.mode : "safe_markdown";
			const title = theme.fg("toolTitle", theme.bold("webfetch"));
			const urlDisplay = theme.fg("accent", url);
			const modeDisplay = theme.fg("dim", `(${mode})`);
			return new Text(`${title} ${urlDisplay} ${modeDisplay}`, 0, 0);
		},
		renderResult(result, options, theme, _context) {
			return renderWebfetchResult(
				result as { content: Array<{ type: string; text?: string }>; details: unknown },
				options,
				theme,
			);
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
			const options = toOptions(input, {
				flagConversionModel,
				configConversionModel,
				envConversionModel,
				configStrictSafety: extensionConfig.strictSafety,
				configMaxBytes: extensionConfig.maxBytes,
				configTimeoutSec: extensionConfig.timeoutSec,
				configMaxRedirects: extensionConfig.maxRedirects,
				configMaxMarkdownChars: extensionConfig.maxMarkdownChars,
				configDefaultMode: normalizeConfiguredMode(extensionConfig.defaultMode),
			});
			debug.addEvent(
				`run start url=${options.url} mode=${options.mode} strict=${options.strictSafety} timeout=${options.timeoutSec}s maxBytes=${options.maxBytes} model=${options.conversionModel ?? "<default>"}`,
				ctx,
			);

			let debugArtifacts: WebfetchDebugArtifactRefs | undefined;
			const subagentDebugEvents: SubagentDebugEvent[] = [];
			if (debug.isEnabled()) {
				debugArtifacts = await initializeDebugArtifacts(ctx.cwd);
				debug.addEvent(`debug artifacts initialized runDir=${debugArtifacts.runDir}`, ctx);
			}

			let lastProgressUpdateMs = 0;
			const emitProgress = (progress: WebfetchProgressDetails) => {
				const now = Date.now();
				const shouldThrottle = progress.phase === "convert-subagent" && progress.subagentPreview !== undefined;
				if (shouldThrottle && now - lastProgressUpdateMs < 220) return;
				lastProgressUpdateMs = now;
				onUpdate?.({
					content: [{ type: "text", text: `webfetch: ${progress.message}` }],
					details: progress,
				});
			};

			emitProgress({ phase: "fetch", message: `validating + fetching ${options.url}` });

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
			if (debugArtifacts) {
				debugArtifacts.curlHtmlPath = await writeDebugArtifact(
					debugArtifacts.runDir,
					"curl-response.html",
					fetch.bodyText,
				);
				debug.addEvent(`debug artifact curlHtmlPath=${debugArtifacts.curlHtmlPath}`, ctx);
			}

			emitProgress({ phase: "scan", message: `scanning ${fetch.url} for prompt injection` });

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
						debugArtifacts,
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

			emitProgress({
				phase: "convert",
				message: `converting content to markdown${options.conversionModel ? ` (model=${options.conversionModel})` : ""}`,
			});

			const converted = await convertToMarkdown(
				options.mode,
				fetch.bodyText,
				fetch.contentType,
				fetch.url,
				ctx.cwd,
				options.timeoutSec,
				options.conversionModel,
				signal,
				(progress) => emitProgress(progress),
				debugArtifacts
					? {
							onPreprocessedHtml: async (html) => {
								debugArtifacts.preprocessedHtmlPath = await writeDebugArtifact(
									debugArtifacts.runDir,
									"preprocessed.html",
									html,
								);
								debug.addEvent(`debug artifact preprocessedHtmlPath=${debugArtifacts.preprocessedHtmlPath}`, ctx);
							},
							onSubagentEvent: (event) => {
								subagentDebugEvents.push(event);
							},
							onFinalOutput: async (markdown) => {
								debugArtifacts.conversionOutputPath = await writeDebugArtifact(
									debugArtifacts.runDir,
									"conversion-output.md",
									markdown,
								);
								debug.addEvent(`debug artifact conversionOutputPath=${debugArtifacts.conversionOutputPath}`, ctx);
							},
						}
					: undefined,
			);
			if (debugArtifacts && subagentDebugEvents.length > 0) {
				debugArtifacts.subagentEventsPath = await writeDebugArtifact(
					debugArtifacts.runDir,
					"subagent-events.jsonl",
					serializeSubagentEventsJsonl(subagentDebugEvents),
				);
				debugArtifacts.subagentConversationPath = await writeDebugArtifact(
					debugArtifacts.runDir,
					"subagent-conversation.md",
					buildSubagentConversationMarkdown(subagentDebugEvents),
				);
				debug.addEvent(
					`debug artifacts subagentEvents=${debugArtifacts.subagentEventsPath} subagentConversation=${debugArtifacts.subagentConversationPath}`,
					ctx,
				);
			}
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
					debugArtifacts,
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
