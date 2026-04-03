import { extractVisibleText } from "./scan.js";

function guessTitle(body: string, url: string): string {
	const match = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (match?.[1]) {
		return match[1].replace(/\s+/g, " ").trim();
	}
	return url;
}

function inferCodeLanguage(contentType: string, body: string): string {
	const normalized = contentType.toLowerCase();
	if (normalized.includes("shellscript") || normalized.includes("x-sh") || normalized.includes("bash")) return "sh";
	if (normalized.includes("javascript")) return "js";
	if (normalized.includes("typescript")) return "ts";
	if (normalized.includes("json")) return "json";
	if (normalized.includes("xml")) return "xml";
	if (normalized.includes("yaml") || normalized.includes("yml")) return "yaml";
	if (normalized.includes("toml")) return "toml";
	if (normalized.includes("markdown")) return "md";
	if (normalized.includes("csv")) return "csv";

	if (body.startsWith("#!/bin/sh") || body.startsWith("#!/usr/bin/env sh")) return "sh";
	if (body.startsWith("#!/bin/bash") || body.startsWith("#!/usr/bin/env bash")) return "bash";
	if (body.startsWith("#!/usr/bin/env node")) return "js";
	return "text";
}

export function shouldUseSubagentConversion(contentType: string, body: string): boolean {
	const normalizedType = contentType.toLowerCase();
	if (normalizedType.includes("text/html") || normalizedType.includes("application/xhtml+xml")) return true;
	if (normalizedType === "" && /<html\b/i.test(body)) return true;
	return false;
}

export function deterministicTextMarkdown(body: string, contentType: string): string {
	const normalizedType = contentType.toLowerCase();
	const normalizedBody = body.replace(/\r\n/g, "\n").trimEnd();

	if (normalizedType.includes("markdown")) return normalizedBody;

	const lang = inferCodeLanguage(contentType, normalizedBody);
	return `\`\`\`${lang}\n${normalizedBody}\n\`\`\``;
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
