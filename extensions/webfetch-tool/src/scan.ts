import type { DetectorHit, RiskDecision, ScanResult } from "./types.js";

interface Rule {
	id: string;
	pattern: RegExp;
	weight: number;
}

interface ScanSegment {
	context: string;
	hidden: boolean;
	text: string;
}

const SEMGREP_RULES: Rule[] = [
	{
		id: "ignore-previous-instructions",
		pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|messages?)/gi,
		weight: 30,
	},
	{
		id: "override-system-prompt",
		pattern: /(override|bypass|disregard)\s+(the\s+)?(system|developer)\s+(prompt|instructions?)/gi,
		weight: 26,
	},
	{
		id: "reveal-secrets",
		pattern: /(reveal|print|dump|show)\s+(all\s+)?(secrets?|keys?|tokens?|credentials?)/gi,
		weight: 22,
	},
	{
		id: "tool-misuse-request",
		pattern: /(run|execute|call)\s+(the\s+)?(bash|shell|terminal|tool)\s+(command|with)/gi,
		weight: 16,
	},
	{
		id: "role-hijack",
		pattern: /you\s+are\s+now\s+(the\s+)?(system|developer|admin|root)/gi,
		weight: 20,
	},
];

const FUZZY_RULES: Rule[] = [
	{
		id: "ignore-obfuscated",
		pattern:
			/i\W*g\W*n\W*o\W*r\W*e.{0,40}(p\W*r\W*e\W*v\W*i\W*o\W*u\W*s|a\W*b\W*o\W*v\W*e).{0,40}i\W*n\W*s\W*t\W*r\W*u\W*c\W*t\W*i\W*o\W*n/gi,
		weight: 18,
	},
	{
		id: "system-prompt-obfuscated",
		pattern: /s\W*y\W*s\W*t\W*e\W*m.{0,30}p\W*r\W*o\W*m\W*p\W*t/gi,
		weight: 14,
	},
	{
		id: "exfiltrate-obfuscated",
		pattern:
			/(e\W*x\W*f\W*i\W*l\W*t\W*r\W*a\W*t\W*e|d\W*u\W*m\W*p).{0,30}(c\W*r\W*e\W*d\W*e\W*n\W*t\W*i\W*a\W*l|s\W*e\W*c\W*r\W*e\W*t)/gi,
		weight: 16,
	},
];

const HTML_ENTITY_MAP: Record<string, string> = {
	"&nbsp;": " ",
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
};

function decodeBasicHtmlEntities(value: string): string {
	return value.replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (entity) => HTML_ENTITY_MAP[entity] ?? entity);
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function takeExcerpt(value: string, maxLength = 180): string {
	const compact = normalizeWhitespace(value);
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, maxLength)}...`;
}

function visibleTextFromHtml(html: string): string {
	return normalizeWhitespace(
		decodeBasicHtmlEntities(
			html
				.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
				.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
				.replace(/<!--([\s\S]*?)-->/g, " ")
				.replace(/<[^>]+>/g, " "),
		),
	);
}

function extractSegments(body: string, contentType: string): ScanSegment[] {
	const normalizedType = contentType.toLowerCase();
	if (!normalizedType.includes("html") && !body.includes("<html")) {
		return [{ context: "document", hidden: false, text: body }];
	}

	const segments: ScanSegment[] = [{ context: "visible-text", hidden: false, text: visibleTextFromHtml(body) }];

	for (const match of body.matchAll(/<!--([\s\S]*?)-->/g)) {
		if (!match[1]) continue;
		segments.push({ context: "html-comment", hidden: true, text: decodeBasicHtmlEntities(match[1]) });
	}

	for (const match of body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
		if (!match[1]) continue;
		segments.push({ context: "script", hidden: true, text: match[1] });
	}

	for (const match of body.matchAll(/<meta\b[^>]*content=["']([^"']+)["'][^>]*>/gi)) {
		if (!match[1]) continue;
		segments.push({ context: "meta", hidden: true, text: decodeBasicHtmlEntities(match[1]) });
	}

	return segments;
}

function scanRule(
	engine: "semgrep" | "fuzzy",
	rules: Rule[],
	segments: ScanSegment[],
): { hits: DetectorHit[]; score: number } {
	const hits: DetectorHit[] = [];
	let score = 0;

	for (const segment of segments) {
		for (const rule of rules) {
			let matchCount = 0;
			for (const match of segment.text.matchAll(rule.pattern)) {
				const excerptSource = match[0] ?? "";
				hits.push({
					engine,
					ruleId: rule.id,
					weight: rule.weight,
					excerpt: takeExcerpt(excerptSource),
					context: segment.context,
					hidden: segment.hidden,
				});

				score += segment.hidden ? Math.ceil(rule.weight * 1.2) : rule.weight;
				matchCount++;
				if (matchCount >= 3) break;
			}
		}
	}

	return { hits, score };
}

function decideRisk(finalScore: number, strictSafety: boolean): RiskDecision {
	const blockThreshold = strictSafety ? 60 : 75;
	const warnThreshold = strictSafety ? 35 : 45;
	if (finalScore >= blockThreshold) return "block";
	if (finalScore >= warnThreshold) return "allow_with_warning";
	return "allow";
}

export function extractVisibleText(body: string, contentType: string): string {
	return extractSegments(body, contentType)
		.filter((segment) => !segment.hidden)
		.map((segment) => segment.text)
		.join("\n")
		.trim();
}

export function scanPromptInjection(body: string, contentType: string, strictSafety: boolean): ScanResult {
	const segments = extractSegments(body, contentType);
	const semgrep = scanRule("semgrep", SEMGREP_RULES, segments);
	const fuzzy = scanRule("fuzzy", FUZZY_RULES, segments);
	const hiddenHitCount = [...semgrep.hits, ...fuzzy.hits].filter((hit) => hit.hidden).length;
	const volumeBoost = semgrep.hits.length + fuzzy.hits.length >= 7 ? 6 : 0;
	const contextBoost = (hiddenHitCount > 0 ? 10 : 0) + volumeBoost;

	const semgrepScore = Math.min(70, semgrep.score);
	const fuzzyScore = Math.min(40, fuzzy.score);
	const finalScore = Math.min(100, semgrepScore + fuzzyScore + contextBoost);
	const decision = decideRisk(finalScore, strictSafety);

	return {
		semgrepScore,
		fuzzyScore,
		contextBoost,
		finalScore,
		decision,
		hits: [...semgrep.hits, ...fuzzy.hits].slice(0, 30),
	};
}
