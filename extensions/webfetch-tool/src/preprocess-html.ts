export interface HtmlPreprocessResult {
	htmlForConversion: string;
	strategy: "main" | "article" | "role-main" | "content-container" | "full";
	rawChars: number;
	preparedChars: number;
	truncated: boolean;
}

interface HtmlPreprocessOptions {
	maxChars: number;
}

function removeNoise(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
		.replace(/<!--([\s\S]*?)-->/g, " ");
}

function extractMainCandidate(html: string): { strategy: HtmlPreprocessResult["strategy"]; html: string } {
	const mainMatch = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/i);
	if (mainMatch?.[0]) {
		return { strategy: "main", html: mainMatch[0] };
	}

	const articleMatch = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/i);
	if (articleMatch?.[0]) {
		return { strategy: "article", html: articleMatch[0] };
	}

	const roleMainMatch = html.match(/<[^>]*\brole=["']main["'][^>]*>[\s\S]*?<\/[^>]+>/i);
	if (roleMainMatch?.[0]) {
		return { strategy: "role-main", html: roleMainMatch[0] };
	}

	const contentContainerMatch = html.match(
		/<(?:div|section)\b[^>]*(?:id|class)=["'][^"']*(?:content|main|article|docs?|markdown|post)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section)>/i,
	);
	if (contentContainerMatch?.[0]) {
		return { strategy: "content-container", html: contentContainerMatch[0] };
	}

	return { strategy: "full", html };
}

function removeBoilerplateBlocks(html: string): string {
	const preserveAsideSignals = [
		"warning",
		"note",
		"tip",
		"caution",
		"admonition",
		"callout",
		"important",
		"alert",
		"danger",
	];
	const removeAsideSignals = ["sidebar", "toc", "navigation", "menu", "related", "share", "social", "meta"];

	return html
		.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
		.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, " ")
		.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, " ")
		.replace(/<aside\b([^>]*)>[\s\S]*?<\/aside>/gi, (match, attrs: string) => {
			const normalizedAttrs = attrs.toLowerCase();
			if (preserveAsideSignals.some((signal) => normalizedAttrs.includes(signal))) {
				return match;
			}
			if (
				normalizedAttrs.includes('role="complementary"') ||
				normalizedAttrs.includes("role='complementary'") ||
				removeAsideSignals.some((signal) => normalizedAttrs.includes(signal))
			) {
				return " ";
			}
			return match;
		})
		.replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, " ")
		.replace(/<dialog\b[^>]*>[\s\S]*?<\/dialog>/gi, " ");
}

function stripNonEssentialAttributes(html: string): string {
	return html.replace(/\s(?:class|style|id|data-[\w:-]+|aria-[\w:-]+)=("[^"]*"|'[^']*')/gi, "");
}

function normalizeWhitespace(html: string): string {
	return html
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/>\s+</g, "><")
		.trim();
}

export function preprocessHtmlForConversion(html: string, options: HtmlPreprocessOptions): HtmlPreprocessResult {
	const rawChars = html.length;
	const cleaned = removeNoise(html);
	const candidate = extractMainCandidate(cleaned);
	let processed = removeBoilerplateBlocks(candidate.html);
	processed = stripNonEssentialAttributes(processed);
	processed = normalizeWhitespace(processed);

	const truncated = processed.length > options.maxChars;
	const htmlForConversion = truncated ? processed.slice(0, options.maxChars) : processed;

	return {
		htmlForConversion,
		strategy: candidate.strategy,
		rawChars,
		preparedChars: htmlForConversion.length,
		truncated,
	};
}
