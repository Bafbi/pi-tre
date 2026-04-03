import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FetchResult, RedirectHop } from "./types.js";
import { enforceUrlPolicy, normalizeUrl } from "./url-policy.js";

interface ProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface CurlStepResult {
	statusCode: number;
	contentType: string;
	effectiveUrl: string;
	headersText: string;
	bodyText: string;
	bodyBytes: number;
	truncated: boolean;
}

export interface CurlFetchInput {
	url: string;
	maxBytes: number;
	timeoutSec: number;
	maxRedirects: number;
	allowPrivateHosts: boolean;
	signal?: AbortSignal;
}

function parseWriteOut(stdout: string): { statusCode: number; contentType: string; effectiveUrl: string } {
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	if (lines.length < 3) {
		throw new Error(`Unexpected curl output: ${stdout}`);
	}

	const statusCode = Number.parseInt(lines[0], 10);
	if (Number.isNaN(statusCode)) {
		throw new Error(`Invalid HTTP status code from curl: ${lines[0]}`);
	}

	return {
		statusCode,
		contentType: lines[1],
		effectiveUrl: lines[2],
	};
}

function extractLocationHeader(headersText: string): string | undefined {
	const matches = headersText.match(/^location:\s*(.+)$/gim);
	if (!matches || matches.length === 0) return undefined;
	const latest = matches[matches.length - 1];
	return latest.replace(/^location:\s*/i, "").trim();
}

function inferContentType(headersText: string): string {
	const matches = headersText.match(/^content-type:\s*(.+)$/gim);
	if (!matches || matches.length === 0) return "";
	const latest = matches[matches.length - 1];
	return latest.replace(/^content-type:\s*/i, "").trim();
}

function isRedirectStatus(statusCode: number): boolean {
	return statusCode >= 300 && statusCode <= 399;
}

function runProcess(
	command: string,
	args: string[],
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;

		const onAbort = () => {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 500).unref();
		};

		const timeout = setTimeout(() => {
			onAbort();
		}, options.timeoutMs);

		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		proc.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});

		proc.on("close", (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve({
				stdout,
				stderr,
				exitCode: exitCode ?? 1,
			});
		});
	});
}

async function curlOnce(url: URL, maxBytes: number, timeoutSec: number, signal?: AbortSignal): Promise<CurlStepResult> {
	const scratchDir = await mkdtemp(join(tmpdir(), "pi-webfetch-"));
	const headersPath = join(scratchDir, "headers.txt");
	const bodyPath = join(scratchDir, "body.bin");

	try {
		const args = [
			"--silent",
			"--show-error",
			"--compressed",
			"--proto",
			"=http,https",
			"--connect-timeout",
			String(Math.max(3, Math.min(timeoutSec, 15))),
			"--max-time",
			String(timeoutSec),
			"--max-filesize",
			String(maxBytes),
			"--dump-header",
			headersPath,
			"--output",
			bodyPath,
			"--write-out",
			"%{http_code}\\n%{content_type}\\n%{url_effective}\\n",
			url.toString(),
		];

		const result = await runProcess("curl", args, {
			signal,
			timeoutMs: timeoutSec * 1000 + 1000,
		});

		if (result.exitCode !== 0) {
			throw new Error(`curl failed (${result.exitCode}): ${result.stderr.trim() || "unknown error"}`);
		}

		const parsed = parseWriteOut(result.stdout);
		const headersText = await readFile(headersPath, "utf8");
		const rawBody = await readFile(bodyPath);
		const truncated = rawBody.length > maxBytes;
		const bodyText = rawBody.subarray(0, maxBytes).toString("utf8");

		return {
			statusCode: parsed.statusCode,
			contentType: parsed.contentType || inferContentType(headersText),
			effectiveUrl: parsed.effectiveUrl,
			headersText,
			bodyText,
			bodyBytes: rawBody.length,
			truncated,
		};
	} finally {
		await rm(scratchDir, { recursive: true, force: true });
	}
}

function isTextLikeContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase();
	if (!normalized) return true;
	if (normalized.startsWith("text/")) return true;
	if (normalized.startsWith("application/xhtml+xml")) return true;
	if (normalized.startsWith("application/xml")) return true;
	if (normalized.startsWith("application/json")) return true;
	return false;
}

export async function fetchWithCurl(input: CurlFetchInput): Promise<FetchResult> {
	const initialUrl = normalizeUrl(input.url);
	const redirects: RedirectHop[] = [];
	let currentUrl = initialUrl;

	for (let attempt = 0; attempt <= input.maxRedirects; attempt++) {
		await enforceUrlPolicy(currentUrl, input.allowPrivateHosts);
		const step = await curlOnce(currentUrl, input.maxBytes, input.timeoutSec, input.signal);
		const effective = normalizeUrl(step.effectiveUrl || currentUrl.toString());

		if (isRedirectStatus(step.statusCode)) {
			if (attempt >= input.maxRedirects) {
				throw new Error(`Too many redirects while fetching '${initialUrl.toString()}'.`);
			}
			const location = extractLocationHeader(step.headersText);
			if (!location) {
				throw new Error(`Redirect status ${step.statusCode} without Location header.`);
			}
			const nextUrl = normalizeUrl(new URL(location, effective).toString());
			redirects.push({
				from: currentUrl.toString(),
				to: nextUrl.toString(),
				statusCode: step.statusCode,
			});
			currentUrl = nextUrl;
			continue;
		}

		if (step.statusCode >= 400) {
			throw new Error(`HTTP ${step.statusCode} while fetching '${effective.toString()}'.`);
		}

		if (!isTextLikeContentType(step.contentType)) {
			throw new Error(`Unsupported content-type '${step.contentType || "unknown"}'.`);
		}

		return {
			url: effective.toString(),
			statusCode: step.statusCode,
			contentType: step.contentType,
			bodyText: step.bodyText,
			bodyBytes: step.bodyBytes,
			truncated: step.truncated,
			redirects,
		};
	}

	throw new Error("Unexpected redirect handling failure.");
}
