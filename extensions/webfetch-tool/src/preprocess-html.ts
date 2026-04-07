import { type DefaultTreeAdapterTypes, parse, parseFragment, serialize, serializeOuter } from "parse5";

export interface HtmlPreprocessResult {
	htmlForConversion: string;
	strategy: string;
	rawChars: number;
	preparedChars: number;
	truncated: boolean;
}

interface HtmlPreprocessOptions {
	maxChars: number;
}

const PRESERVE_ASIDE_SIGNALS = [
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

const REMOVE_ASIDE_SIGNALS = ["sidebar", "toc", "navigation", "menu", "related", "share", "social", "meta"];

const CONTENT_HINT_PATTERN = /(content|main|article|docs?|markdown|post)/i;

type DomNode = DefaultTreeAdapterTypes.Node;
type DomParentNode = DefaultTreeAdapterTypes.ParentNode;
type DomChildNode = DefaultTreeAdapterTypes.ChildNode;
type DomElement = DefaultTreeAdapterTypes.Element;
type DomTextNode = DefaultTreeAdapterTypes.TextNode;

function removeNoise(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
		.replace(/<!--([\s\S]*?)-->/g, " ");
}

function isDomElement(node: DomNode): node is DomElement {
	return "tagName" in node;
}

function isDomTextNode(node: DomNode): node is DomTextNode {
	return node.nodeName === "#text";
}

function getAttributeValue(element: DomElement, name: string): string | undefined {
	return element.attrs.find((attr) => attr.name.toLowerCase() === name)?.value;
}

function getElementSignals(element: DomElement): string {
	const classValue = getAttributeValue(element, "class") ?? "";
	const idValue = getAttributeValue(element, "id") ?? "";
	const roleValue = getAttributeValue(element, "role") ?? "";
	return `${classValue} ${idValue} ${roleValue}`.toLowerCase();
}

function walkDom(node: DomNode, onElement: (element: DomElement) => void): void {
	if (isDomElement(node)) {
		onElement(node);
	}

	if (!("childNodes" in node)) return;
	for (const child of node.childNodes) {
		walkDom(child, onElement);
	}
}

function textLengthFromDom(node: DomNode): number {
	if (isDomTextNode(node)) {
		return node.value.replace(/\s+/g, " ").trim().length;
	}
	if (!("childNodes" in node)) return 0;

	let total = 0;
	for (const child of node.childNodes) {
		total += textLengthFromDom(child);
	}
	return total;
}

function pickBestElement(elements: DomElement[]): DomElement | undefined {
	if (elements.length === 0) return undefined;
	let best = elements[0];
	let bestScore = textLengthFromDom(best);

	for (let i = 1; i < elements.length; i++) {
		const candidate = elements[i];
		const score = textLengthFromDom(candidate);
		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}

	return best;
}

function findElements(
	document: DefaultTreeAdapterTypes.Document,
	predicate: (element: DomElement) => boolean,
): DomElement[] {
	const results: DomElement[] = [];
	walkDom(document, (element) => {
		if (predicate(element)) results.push(element);
	});
	return results;
}

function extractMainCandidate(html: string): { strategy: string; html: string } {
	const document = parse(html);

	const main = pickBestElement(findElements(document, (element) => element.tagName === "main"));
	if (main) return { strategy: "main", html: serializeOuter(main) };

	const article = pickBestElement(findElements(document, (element) => element.tagName === "article"));
	if (article) return { strategy: "article", html: serializeOuter(article) };

	const roleMain = pickBestElement(
		findElements(document, (element) => (getAttributeValue(element, "role") ?? "").toLowerCase() === "main"),
	);
	if (roleMain) return { strategy: "role-main", html: serializeOuter(roleMain) };

	const contentContainer = pickBestElement(
		findElements(document, (element) => {
			if (element.tagName !== "div" && element.tagName !== "section") return false;
			const signals = getElementSignals(element);
			return CONTENT_HINT_PATTERN.test(signals);
		}),
	);
	if (contentContainer) {
		return { strategy: "content-container", html: serializeOuter(contentContainer) };
	}

	return { strategy: "full", html };
}

function shouldRemoveElement(element: DomElement): boolean {
	const tag = element.tagName;
	if (
		tag === "nav" ||
		tag === "header" ||
		tag === "footer" ||
		tag === "form" ||
		tag === "dialog" ||
		tag === "script" ||
		tag === "style" ||
		tag === "noscript" ||
		tag === "template"
	) {
		return true;
	}

	if (tag !== "aside") return false;

	const signals = getElementSignals(element);
	if (PRESERVE_ASIDE_SIGNALS.some((signal) => signals.includes(signal))) {
		return false;
	}
	if (signals.includes("complementary")) {
		return true;
	}
	return REMOVE_ASIDE_SIGNALS.some((signal) => signals.includes(signal));
}

function pruneDomTree(parent: DomParentNode): void {
	const retained: DomChildNode[] = [];
	for (const child of parent.childNodes) {
		if (isDomElement(child) && shouldRemoveElement(child)) {
			continue;
		}
		if ("childNodes" in child) {
			pruneDomTree(child);
		}
		retained.push(child);
	}
	parent.childNodes = retained;
}

function removeBoilerplateBlocks(html: string): string {
	const fragment = parseFragment(html);
	pruneDomTree(fragment);
	return serialize(fragment);
}

function stripNonEssentialAttributes(html: string): string {
	const fragment = parseFragment(html);
	walkDom(fragment, (element) => {
		element.attrs = element.attrs.filter((attr) => {
			const name = attr.name.toLowerCase();
			if (name === "class" || name === "style" || name === "id") return false;
			if (name.startsWith("data-") || name.startsWith("aria-")) return false;
			return true;
		});
	});
	return serialize(fragment);
}

function normalizeWhitespace(html: string): string {
	return html
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/>\s+</g, "> <")
		.trim();
}

function finalizeResult(processed: string, rawChars: number, maxChars: number, strategy: string): HtmlPreprocessResult {
	const truncated = processed.length > maxChars;
	const htmlForConversion = truncated ? processed.slice(0, maxChars) : processed;
	return {
		htmlForConversion,
		strategy,
		rawChars,
		preparedChars: htmlForConversion.length,
		truncated,
	};
}

export function preprocessHtmlForConversion(html: string, options: HtmlPreprocessOptions): HtmlPreprocessResult {
	const rawChars = html.length;
	const cleaned = removeNoise(html);
	const candidate = extractMainCandidate(cleaned);
	let processed = removeBoilerplateBlocks(candidate.html);
	processed = stripNonEssentialAttributes(processed);
	processed = normalizeWhitespace(processed);

	return finalizeResult(processed, rawChars, options.maxChars, candidate.strategy);
}
