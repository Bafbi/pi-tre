import { URL } from "node:url";

import type { ParsedRepo } from "./types.js";

/**
 * Parse a repo identifier string into structured form.
 *
 * Supports:
 *   - GitHub shorthand: "owner/repo" or "owner/repo:branch" or "owner/repo@branch"
 *   - Full URLs: "https://host.com/path/to/repo" or "git@host.com:path/to/repo"
 *   - With branch suffix: URL ":branch" or URL "@branch"
 */
export function parseRepoIdentifier(input: string): ParsedRepo {
	const extracted = extractBranch(input.trim());
	const raw = extracted.rest;
	const explicitBranch = extracted.branch;

	// Local paths
	const isLocalPath =
		raw.startsWith("/") ||
		raw.startsWith("./") ||
		raw.startsWith("~/") ||
		raw.startsWith("../") ||
		/^[A-Za-z]:[\\/]/.test(raw) ||
		raw.startsWith("\\\\");

	if (isLocalPath) {
		return {
			raw: input,
			host: "generic",
			cloneUrl: raw,
			branch: explicitBranch,
			displayName: raw.split("/").pop() || raw,
			dirName: sanitizeDirName(
				raw.replace(/^\//, "").replace(/\//g, "_") + (explicitBranch ? `-${explicitBranch}` : ""),
			),
		};
	}

	// Parse host and clone URL
	if (raw.startsWith("http://") || raw.startsWith("https://")) {
		return parseHttpUrl(raw, input, explicitBranch);
	}

	if (raw.startsWith("git@")) {
		return parseSshUrl(raw, input, explicitBranch);
	}

	// GitHub shorthand: "owner/repo"
	if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
		const [owner, repo] = raw.split("/");
		return {
			raw: input,
			host: "github",
			cloneUrl: `https://github.com/${raw}.git`,
			branch: explicitBranch,
			displayName: raw,
			dirName: sanitizeDirName(`github_${owner}_${repo}${explicitBranch ? `-${explicitBranch}` : ""}`),
			owner: raw.split("/")[0],
			repo: raw.split("/")[1],
		};
	}

	throw new Error(`Cannot parse repository identifier: ${input}`);
}

function parseHttpUrl(raw: string, original: string, branch: string | null): ParsedRepo {
	const url = new URL(raw);
	const host = classifyHost(url.hostname);
	const pathParts = url.pathname
		.replace(/^\//, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.split("/");
	const name = pathParts[pathParts.length - 1] || "repo";

	const trimmedRaw = raw.replace(/\/+$/, "");
	const cloneUrl = trimmedRaw.endsWith(".git") ? trimmedRaw : `${trimmedRaw}.git`;

	return {
		raw: original,
		host,
		cloneUrl,
		branch,
		displayName: pathParts.join("/"),
		dirName: sanitizeDirName(`${host}_${pathParts.join("_")}${branch ? `-${branch}` : ""}`),
		owner: pathParts[0],
		repo: name,
	};
}

function parseSshUrl(raw: string, original: string, branch: string | null): ParsedRepo {
	// git@host.com:owner/repo.git → https://host.com/owner/repo
	const match = raw.match(/^git@([^:]+):(.+)$/);
	if (!match) {
		throw new Error(`Cannot parse SSH git URL: ${original}`);
	}

	const hostname = match[1];
	const path = match[2].replace(/\.git$/, "");
	const pathParts = path.split("/");
	const name = pathParts[pathParts.length - 1] || "repo";
	const host = classifyHost(hostname);

	return {
		raw: original,
		host,
		cloneUrl: raw,
		branch,
		displayName: path,
		dirName: sanitizeDirName(`${host}_${pathParts.join("_")}${branch ? `-${branch}` : ""}`),
		owner: pathParts[0],
		repo: name,
	};
}

function extractBranch(raw: string): { rest: string; branch: string | null } {
	const lastColon = raw.lastIndexOf(":");
	const lastAt = raw.lastIndexOf("@");

	// Colon form takes precedence — test it first
	if (lastColon > 0 && isBranchDelimiter(raw, lastColon)) {
		return { rest: raw.slice(0, lastColon), branch: raw.slice(lastColon + 1) };
	}

	// Fall back to at-sign
	if (lastAt > 0 && isBranchDelimiter(raw, lastAt)) {
		return { rest: raw.slice(0, lastAt), branch: raw.slice(lastAt + 1) };
	}

	return { rest: raw, branch: null };
}

function isBranchDelimiter(raw: string, index: number): boolean {
	const char = raw[index];
	const after = raw.slice(index + 1);
	if (after.length === 0) return false;

	// Guard against protocol/port/userinfo separators in URLs with ://
	if (raw.includes("://")) {
		const protocolEnd = raw.indexOf("://") + 3;
		const firstSlashAfterProtocol = raw.indexOf("/", protocolEnd);
		if (firstSlashAfterProtocol === -1 || index < firstSlashAfterProtocol) {
			return false;
		}
	}

	// Guard against SSH host delimiter in scp-like syntax (git@host:path)
	if (char === ":" && raw.startsWith("git@")) {
		const firstColonAfterPrefix = raw.indexOf(":", 4);
		if (index === firstColonAfterPrefix) {
			return false;
		}
	}

	// Guard against the @ in git@ prefix
	if (char === "@" && raw.startsWith("git@")) {
		const firstAt = raw.indexOf("@");
		if (index === firstAt) {
			return false;
		}
	}

	return true;
}

function classifyHost(hostname: string): ParsedRepo["host"] {
	if (hostname.includes("github")) return "github";
	if (hostname.includes("gitlab")) return "gitlab";
	if (hostname.includes("bitbucket")) return "bitbucket";
	return "generic";
}

function sanitizeDirName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}
