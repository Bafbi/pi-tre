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

type DomNode = DefaultTreeAdapterTypes.Node;
type DomParentNode = DefaultTreeAdapterTypes.ParentNode;
type DomChildNode = DefaultTreeAdapterTypes.ChildNode;
type DomElement = DefaultTreeAdapterTypes.Element;
type DomTextNode = DefaultTreeAdapterTypes.TextNode;

const ALWAYS_REMOVE_TAGS = new Set([
	"style",
	"svg",
	"canvas",
	"video",
	"audio",
	"iframe",
	"map",
	"noscript",
	"template",
]);

const REMOVE_INTERACTION_TAGS = new Set(["form", "input", "textarea", "select", "option", "dialog"]);

const DROP_ATTRIBUTE_NAMES = new Set(["style", "width", "height", "target", "rel", "tabindex"]);

const KEEP_CORE_ATTRIBUTE_NAMES = new Set(["href", "title", "alt", "role", "id", "type"]);

const KEEP_ARIA_ATTRIBUTE_NAMES = new Set(["aria-label", "aria-labelledby", "aria-current"]);

const KEEP_DATA_PREFIXES = ["data-category", "data-label", "data-author", "data-type"];
const DROP_DATA_PREFIXES = ["data-react", "data-v-", "data-track", "data-analytics"];

const FLUFF_CLASS_OR_ID_PATTERNS: RegExp[] = [
	/\b(cookie|consent|gdpr|onetrust|cmp|terms-banner)\b/i,
	/\b(modal|popup|interstitial|overlay|newsletter|paywall)\b/i,
	/(?:^|[-_])(ad|ads)(?:[-_]|$)|\b(advertisement|sponsor|taboola|outbrain|promo)\b/i,
	/\b(share|social-icons|comments|disqus)\b/i,
	/\b(skeleton|spinner|placeholder)\b/i,
];

const VOID_HTML_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

function isDomElement(node: DomNode): node is DomElement {
	return "tagName" in node;
}

function isTextNode(node: DomNode): node is DomTextNode {
	return node.nodeName === "#text";
}

function isCommentNode(node: DomNode): boolean {
	return node.nodeName === "#comment";
}

function getAttributeValue(element: DomElement, name: string): string | undefined {
	return element.attrs.find((attr) => attr.name.toLowerCase() === name)?.value;
}

function hasAttribute(element: DomElement, name: string): boolean {
	return element.attrs.some((attr) => attr.name.toLowerCase() === name);
}

function escapeHtmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function parseSpanNode(htmlText: string): DomChildNode[] {
	const fragment = parseFragment(htmlText);
	return [...fragment.childNodes];
}

function imageAltReplacementNodes(altText: string): DomChildNode[] {
	return parseSpanNode(`<span>[Image: ${escapeHtmlText(altText)}]</span>`);
}

function isJsonLdScript(element: DomElement): boolean {
	if (element.tagName !== "script") return false;
	const type = (getAttributeValue(element, "type") ?? "").trim().toLowerCase();
	return type.startsWith("application/ld+json");
}

function isAriaHiddenTrue(element: DomElement): boolean {
	const value = (getAttributeValue(element, "aria-hidden") ?? "").trim().toLowerCase();
	return value === "true";
}

function classAndIdSignals(element: DomElement): string {
	const classValue = getAttributeValue(element, "class") ?? "";
	const idValue = getAttributeValue(element, "id") ?? "";
	return `${classValue} ${idValue}`.toLowerCase();
}

function isFluffByClassOrId(element: DomElement): boolean {
	const signals = classAndIdSignals(element);
	if (!signals.trim()) return false;
	return FLUFF_CLASS_OR_ID_PATTERNS.some((pattern) => pattern.test(signals));
}

function isNavigationalHref(rawHref: string | undefined): boolean {
	if (!rawHref) return false;
	const href = rawHref.trim();
	if (!href) return false;

	const lower = href.toLowerCase();
	if (lower === "#" || lower.startsWith("#")) return false;
	if (lower.startsWith("javascript:")) return false;
	if (lower.startsWith("mailto:")) return false;
	if (lower.startsWith("tel:")) return false;
	return true;
}

function containsNavigationalLink(node: DomNode): boolean {
	if (isDomElement(node) && node.tagName === "a") {
		return isNavigationalHref(getAttributeValue(node, "href"));
	}
	if (!("childNodes" in node)) return false;
	for (const child of node.childNodes) {
		if (containsNavigationalLink(child)) return true;
	}
	return false;
}

function shouldKeepDataAttribute(name: string, value: string): boolean {
	const lowerName = name.toLowerCase();
	for (const prefix of DROP_DATA_PREFIXES) {
		if (lowerName.startsWith(prefix)) return false;
	}

	const compactValue = value.trim();
	if (compactValue.length === 0 || compactValue.length > 60) return false;

	return KEEP_DATA_PREFIXES.some((prefix) => lowerName === prefix || lowerName.startsWith(`${prefix}-`));
}

function shouldKeepAttribute(element: DomElement, name: string, value: string): boolean {
	const lowerName = name.toLowerCase();

	if (lowerName.startsWith("on")) return false;
	if (DROP_ATTRIBUTE_NAMES.has(lowerName)) return false;
	if (lowerName === "aria-hidden") return false;
	if (lowerName === "hidden") return false;

	if (lowerName.startsWith("aria-")) {
		return KEEP_ARIA_ATTRIBUTE_NAMES.has(lowerName);
	}

	if (lowerName.startsWith("data-")) {
		return shouldKeepDataAttribute(lowerName, value);
	}

	if (element.tagName === "script" && isJsonLdScript(element) && lowerName === "type") return true;

	return KEEP_CORE_ATTRIBUTE_NAMES.has(lowerName);
}

function getSignificantChildren(element: DomElement): DomChildNode[] {
	const significant: DomChildNode[] = [];
	for (const child of element.childNodes) {
		if (isTextNode(child)) {
			if (child.value.trim().length === 0) continue;
			significant.push(child);
			continue;
		}
		significant.push(child);
	}
	return significant;
}

function shouldUnwrapContainer(element: DomElement): boolean {
	if (element.tagName !== "div" && element.tagName !== "span") return false;
	if (element.attrs.length > 0) return false;

	const significant = getSignificantChildren(element);
	if (significant.length === 0) return false;
	if (significant.every((node) => isTextNode(node))) return true;
	return significant.length === 1 && isDomElement(significant[0]);
}

function reparentNodes(nodes: DomChildNode[], parent: DomParentNode): DomChildNode[] {
	for (const node of nodes) {
		if ("parentNode" in node) {
			(node as { parentNode: DomParentNode }).parentNode = parent;
		}
	}
	return nodes;
}

type ElementAction =
	| { kind: "remove" }
	| { kind: "keep" }
	| { kind: "unwrap" }
	| { kind: "replace"; nodes: DomChildNode[] };

function classifyElementAction(element: DomElement): ElementAction {
	if (isAriaHiddenTrue(element)) return { kind: "remove" };
	if (hasAttribute(element, "hidden")) return { kind: "remove" };

	if (ALWAYS_REMOVE_TAGS.has(element.tagName)) return { kind: "remove" };
	if (REMOVE_INTERACTION_TAGS.has(element.tagName)) return { kind: "remove" };
	if (isFluffByClassOrId(element)) return { kind: "remove" };

	if (element.tagName === "script") {
		return isJsonLdScript(element) ? { kind: "keep" } : { kind: "remove" };
	}

	if (element.tagName === "img") {
		const alt = (getAttributeValue(element, "alt") ?? "").trim();
		if (!alt) return { kind: "remove" };
		return { kind: "replace", nodes: imageAltReplacementNodes(alt) };
	}

	if (element.tagName === "button") {
		if (containsNavigationalLink(element)) return { kind: "unwrap" };
		return { kind: "remove" };
	}

	if (element.tagName === "a") {
		if (!isNavigationalHref(getAttributeValue(element, "href"))) return { kind: "unwrap" };
	}

	return { kind: "keep" };
}

function transformParentNode(parent: DomParentNode): void {
	const transformedChildren: DomChildNode[] = [];

	for (const child of parent.childNodes) {
		if (isCommentNode(child)) {
			continue;
		}

		if (!isDomElement(child)) {
			transformedChildren.push(child);
			continue;
		}

		const action = classifyElementAction(child);
		if (action.kind === "remove") {
			continue;
		}

		if (action.kind === "replace") {
			transformedChildren.push(...reparentNodes(action.nodes, parent));
			continue;
		}

		transformParentNode(child);
		child.attrs = child.attrs.filter((attr) => shouldKeepAttribute(child, attr.name, attr.value));

		if (action.kind === "unwrap" || shouldUnwrapContainer(child)) {
			transformedChildren.push(...reparentNodes([...child.childNodes], parent));
			continue;
		}

		transformedChildren.push(child);
	}

	parent.childNodes = transformedChildren;
}

function findFirstElementByTag(document: DefaultTreeAdapterTypes.Document, tagName: string): DomElement | undefined {
	const stack: DomNode[] = [...document.childNodes];
	while (stack.length > 0) {
		const node = stack.shift();
		if (!node) break;
		if (isDomElement(node) && node.tagName === tagName) return node;
		if ("childNodes" in node) {
			stack.unshift(...node.childNodes);
		}
	}
	return undefined;
}

function extractBroadCandidate(html: string): { strategy: string; html: string } {
	const document = parse(html);
	const body = findFirstElementByTag(document, "body");
	if (body) return { strategy: "body-broad", html: serializeOuter(body) };
	return { strategy: "full-broad", html };
}

function preprocessFragmentHtml(html: string): string {
	const fragment = parseFragment(html);
	transformParentNode(fragment);
	return serialize(fragment);
}

function countLeadingClosingTags(line: string): number {
	const leading = line.match(/^(?:<\/[a-zA-Z][\w:-]*\s*>\s*)+/)?.[0];
	if (!leading) return 0;
	return leading.match(/<\/[a-zA-Z][\w:-]*\s*>/g)?.length ?? 0;
}

function countOpeningAndClosingTags(line: string): { openingCount: number; closingCount: number } {
	const closingCount = line.match(/<\/[a-zA-Z][\w:-]*\s*>/g)?.length ?? 0;
	let openingCount = 0;
	for (const match of line.matchAll(/<([a-zA-Z][\w:-]*)(\s[^>]*)?>/g)) {
		const wholeTag = match[0] ?? "";
		const tagName = (match[1] ?? "").toLowerCase();
		if (!tagName) continue;
		if (/\/\s*>$/.test(wholeTag)) continue;
		if (VOID_HTML_TAGS.has(tagName)) continue;
		openingCount++;
	}
	return { openingCount, closingCount };
}

function applyIndentation(html: string): string {
	const lines = html
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return "";

	const indentedLines: string[] = [];
	let depth = 0;

	for (const line of lines) {
		const leadingClosingTags = countLeadingClosingTags(line);
		const indentDepth = Math.max(0, depth - leadingClosingTags);
		indentedLines.push(`${"  ".repeat(indentDepth)}${line}`);

		const { openingCount, closingCount } = countOpeningAndClosingTags(line);
		depth = Math.max(0, depth + openingCount - closingCount);
	}

	return indentedLines.join("\n");
}

function normalizeWhitespace(html: string): string {
	const normalized = html
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/>\s+</g, ">\n<")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return applyIndentation(normalized);
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
	const candidate = extractBroadCandidate(html);
	const processed = normalizeWhitespace(preprocessFragmentHtml(candidate.html));
	return finalizeResult(processed, rawChars, options.maxChars, candidate.strategy);
}
