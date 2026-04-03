export type WebfetchMode = "safe_markdown" | "raw_markdown" | "extract_only";

export type HtmlPreprocessor = "regex" | "dom";

export interface WebfetchOptions {
	url: string;
	mode: WebfetchMode;
	strictSafety: boolean;
	maxBytes: number;
	timeoutSec: number;
	maxRedirects: number;
	maxMarkdownChars: number;
	conversionModel?: string;
	htmlPreprocessor: HtmlPreprocessor;
}

export interface WebfetchExtensionConfig {
	conversionModel?: string;
	htmlPreprocessor?: HtmlPreprocessor;
}

export interface RedirectHop {
	from: string;
	to: string;
	statusCode: number;
}

export interface FetchResult {
	url: string;
	statusCode: number;
	contentType: string;
	bodyText: string;
	bodyBytes: number;
	truncated: boolean;
	redirects: RedirectHop[];
}

export type DetectorEngine = "semgrep" | "fuzzy";

export interface DetectorHit {
	engine: DetectorEngine;
	ruleId: string;
	weight: number;
	excerpt: string;
	context: string;
	hidden: boolean;
}

export type RiskDecision = "allow" | "allow_with_warning" | "block";

export interface ScanResult {
	semgrepScore: number;
	fuzzyScore: number;
	contextBoost: number;
	finalScore: number;
	decision: RiskDecision;
	hits: DetectorHit[];
}

export interface MarkdownConversionResult {
	markdown: string;
	usedSubagent: boolean;
	conversionModelUsed?: string;
	conversionPreprocessStrategy?: string;
	conversionInputCharsRaw?: number;
	conversionInputCharsPrepared?: number;
	fallbackReason?: string;
}

export interface WebfetchDetails {
	url: string;
	statusCode: number;
	contentType: string;
	bodyBytes: number;
	truncated: boolean;
	redirects: RedirectHop[];
	scan: ScanResult;
	mode: WebfetchMode;
	conversionModelUsed?: string;
	conversionPreprocessStrategy?: string;
	conversionInputCharsRaw?: number;
	conversionInputCharsPrepared?: number;
	usedSubagent: boolean;
	fallbackReason?: string;
	markdownTruncated: boolean;
}
