import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { fetchWithCurl } from "./fetch.js";
import { fallbackMarkdown } from "./markdown.js";
import { scanPromptInjection } from "./scan.js";
import { convertWithSubagent } from "./subagent.js";
import type { MarkdownConversionResult, WebfetchDetails, WebfetchMode, WebfetchOptions } from "./types.js";

const DEFAULT_MAX_BYTES = 400_000;
const DEFAULT_TIMEOUT_SEC = 25;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_MARKDOWN_CHARS = 30_000;

function normalizeMode(input: string | undefined): WebfetchMode {
	if (input === "raw_markdown") return "raw_markdown";
	if (input === "extract_only") return "extract_only";
	return "safe_markdown";
}

function clampNumber(input: unknown, fallback: number, min: number, max: number): number {
	if (typeof input !== "number" || Number.isNaN(input)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(input)));
}

function toOptions(input: {
	url: string;
	mode?: string;
	strictSafety?: boolean;
	maxBytes?: number;
	timeoutSec?: number;
	maxRedirects?: number;
	maxMarkdownChars?: number;
}): WebfetchOptions {
	return {
		url: input.url,
		mode: normalizeMode(input.mode),
		strictSafety: input.strictSafety ?? true,
		maxBytes: clampNumber(input.maxBytes, DEFAULT_MAX_BYTES, 10_000, 2_000_000),
		timeoutSec: clampNumber(input.timeoutSec, DEFAULT_TIMEOUT_SEC, 5, 120),
		maxRedirects: clampNumber(input.maxRedirects, DEFAULT_MAX_REDIRECTS, 0, 8),
		maxMarkdownChars: clampNumber(input.maxMarkdownChars, DEFAULT_MAX_MARKDOWN_CHARS, 2_000, 120_000),
	};
}

function summarizeHits(details: WebfetchDetails): string {
	if (details.scan.hits.length === 0) return "none";
	return details.scan.hits
		.slice(0, 4)
		.map((hit) => `${hit.engine}:${hit.ruleId} (${hit.context})`)
		.join(", ");
}

function truncateMarkdown(markdown: string, maxChars: number): { markdown: string; truncated: boolean } {
	if (markdown.length <= maxChars) return { markdown, truncated: false };
	return {
		markdown: `${markdown.slice(0, maxChars)}\n\n...[truncated]...`,
		truncated: true,
	};
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
		`Detector hits: ${summarizeHits(details)}`,
		`Warnings: ${warnings.length > 0 ? warnings.join(", ") : "none"}`,
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
	signal?: AbortSignal,
): Promise<MarkdownConversionResult> {
	if (mode === "extract_only") {
		return {
			markdown: fallbackMarkdown(bodyText, contentType, url),
			usedSubagent: false,
			fallbackReason: "extract_only mode",
		};
	}

	try {
		const sourceText = bodyText.slice(0, 120_000);
		const converted = await convertWithSubagent(sourceText, url, cwd, timeoutSec, signal);
		return {
			markdown: converted.markdown,
			usedSubagent: true,
		};
	} catch (error) {
		return {
			markdown: fallbackMarkdown(bodyText, contentType, url),
			usedSubagent: false,
			fallbackReason: error instanceof Error ? error.message : "sub-agent conversion failed",
		};
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "webfetch",
		label: "Web Fetch",
		description:
			"Fetch a web page with curl, run prompt-injection scoring (semgrep-like + fuzzy), then convert content to markdown via a constrained sub-agent.",
		promptSnippet:
			"Use webfetch for web pages. It performs URL policy checks, injection scoring, and markdown conversion before returning content.",
		parameters: Type.Object({
			url: Type.String({ description: "HTTP(S) URL to fetch." }),
			mode: Type.Optional(
				Type.String({ description: "safe_markdown | raw_markdown | extract_only (default: safe_markdown)" }),
			),
			strictSafety: Type.Optional(Type.Boolean({ description: "Block high-risk content when true (default: true)." })),
			maxBytes: Type.Optional(Type.Number({ description: "Maximum response bytes to keep (default: 400000)." })),
			timeoutSec: Type.Optional(Type.Number({ description: "Fetch + conversion timeout seconds (default: 25)." })),
			maxRedirects: Type.Optional(Type.Number({ description: "Maximum redirects to follow manually (default: 3)." })),
			maxMarkdownChars: Type.Optional(
				Type.Number({ description: "Maximum markdown chars returned (default: 30000)." }),
			),
		}),
		async execute(_toolCallId, input, signal, onUpdate, ctx) {
			const options = toOptions(input);

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

			onUpdate?.({
				content: [{ type: "text", text: `webfetch: scanning ${fetch.url} for prompt injection` }],
				details: { phase: "scan" },
			});

			const scan = scanPromptInjection(fetch.bodyText, fetch.contentType, options.strictSafety);
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
				const blockMessage = [
					`Blocked: detected high prompt-injection risk in '${fetch.url}'.`,
					`Risk score: ${scan.finalScore}.`,
					"Use mode='raw_markdown' or strictSafety=false only if you explicitly want to review risky source content.",
				].join(" ");

				const details: WebfetchDetails = {
					...detailsBase,
					usedSubagent: false,
					fallbackReason: "blocked by safety policy",
					markdownTruncated: false,
				};
				return {
					content: [{ type: "text", text: blockMessage }],
					details,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: "webfetch: converting content to markdown" }],
				details: { phase: "convert" },
			});

			const converted = await convertToMarkdown(
				options.mode,
				fetch.bodyText,
				fetch.contentType,
				fetch.url,
				ctx.cwd,
				options.timeoutSec,
				signal,
			);
			const truncated = truncateMarkdown(converted.markdown, options.maxMarkdownChars);

			const details: WebfetchDetails = {
				...detailsBase,
				usedSubagent: converted.usedSubagent,
				fallbackReason: converted.fallbackReason,
				markdownTruncated: truncated.truncated,
			};
			const report = buildReport(truncated.markdown, details);

			return {
				content: [{ type: "text", text: report }],
				details,
			};
		},
	});
}
