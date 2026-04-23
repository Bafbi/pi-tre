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
	let raw = input.trim();
	let explicitBranch: string | null = null;

	// Extract branch suffix (take the last occurrence of : or @ that isn't part of URL)
	const lastColon = raw.lastIndexOf(":");
	const lastAt = raw.lastIndexOf("@");
	const splitIndex = Math.max(lastColon, lastAt);

	if (splitIndex > 0) {
		const before = raw.slice(0, splitIndex);
		const after = raw.slice(splitIndex + 1);
		const splitChar = raw[splitIndex];

		if (after.length > 0) {
			let isBranchSuffix = true;

			// Guard against protocol/port/userinfo separators in URLs with ://
			if (raw.includes("://")) {
				const protocolEnd = raw.indexOf("://") + 3;
				const firstSlashAfterProtocol = raw.indexOf("/", protocolEnd);
				if (firstSlashAfterProtocol === -1 || splitIndex < firstSlashAfterProtocol) {
					isBranchSuffix = false;
				}
			}

			// Guard against SSH host delimiter in scp-like syntax (git@host:path)
			if (isBranchSuffix && splitChar === ":" && raw.startsWith("git@")) {
				const firstColonAfterPrefix = raw.indexOf(":", 4);
				if (splitIndex === firstColonAfterPrefix) {
					isBranchSuffix = false;
				}
			}

			if (isBranchSuffix) {
				raw = before;
				explicitBranch = after;
			}
		}
	}

	// Local paths
	if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("~/")) {
		return {
			raw: input,
			host: "generic",
			cloneUrl: raw,
			branch: explicitBranch,
			displayName: raw.split("/").pop() || raw,
			dirName: sanitizeDirName(raw.split("/").pop() || "repo"),
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
			dirName: sanitizeDirName(`${repo}${explicitBranch ? `-${explicitBranch}` : ""}`),
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
		.replace(/\.git$/, "")
		.split("/");
	const name = pathParts[pathParts.length - 1] || "repo";

	return {
		raw: original,
		host,
		cloneUrl: raw.endsWith(".git") ? raw : `${raw}.git`,
		branch,
		displayName: pathParts.join("/"),
		dirName: sanitizeDirName(`${name}${branch ? `-${branch}` : ""}`),
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
		dirName: sanitizeDirName(`${name}${branch ? `-${branch}` : ""}`),
		owner: pathParts[0],
		repo: name,
	};
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
