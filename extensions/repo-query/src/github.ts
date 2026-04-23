import { Octokit } from "@octokit/rest";

import type { ValidationResult } from "./types.js";

function getOctokit(): Octokit {
	return new Octokit({
		auth: process.env.GITHUB_TOKEN,
		request: { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) },
	});
}

/**
 * Validate a GitHub repo exists and check if it's archived.
 * On 404, search for similar repos and return suggestions.
 */
export async function validateGitHubRepo(owner: string, repo: string): Promise<ValidationResult> {
	try {
		const { data } = await getOctokit().repos.get({ owner, repo });

		const warning = data.archived
			? `Repository ${owner}/${repo} is archived (read-only). Last pushed: ${data.pushed_at ?? "unknown"}.`
			: undefined;

		return { valid: true, archived: data.archived, warning };
	} catch (err: unknown) {
		const status = (err as { status?: number }).status;
		if (status === 404) {
			// Try searching for similar repos
			const suggestions = await searchGitHubRepos(repo, owner);
			return { valid: false, suggestions };
		}
		// 403, rate limit, network, or any other error — re-throw to let caller handle
		throw err;
	}
}

async function searchGitHubRepos(repoName: string, ownerHint?: string): Promise<string[]> {
	try {
		const query = ownerHint ? `${repoName} user:${ownerHint}` : `${repoName} in:name`;
		const { data } = await getOctokit().search.repos({
			q: query,
			sort: "stars",
			order: "desc",
			per_page: 5,
		});
		return data.items.map((r) => r.full_name);
	} catch {
		return [];
	}
}
