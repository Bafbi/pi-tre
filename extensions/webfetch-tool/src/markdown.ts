import { extractVisibleText } from "./scan.js";

function guessTitle(body: string, url: string): string {
	const match = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (match?.[1]) {
		return match[1].replace(/\s+/g, " ").trim();
	}
	return url;
}

export function fallbackMarkdown(body: string, contentType: string, url: string): string {
	const title = guessTitle(body, url);
	const text = extractVisibleText(body, contentType);
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 400);

	const paragraphs: string[] = [];
	let current = "";
	for (const line of lines) {
		if ((current + line).length > 280) {
			paragraphs.push(current.trim());
			current = line;
		} else {
			current = `${current} ${line}`.trim();
		}
	}
	if (current) paragraphs.push(current.trim());

	return [`# ${title}`, "", `Source: ${url}`, "", ...paragraphs].join("\n");
}
