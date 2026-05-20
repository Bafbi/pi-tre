import { describe, expect, it } from "vitest";

import { parseRepoIdentifier } from "../../src/resolver.js";

describe("parseRepoIdentifier", () => {
	it("parses GitHub shorthand without branch", () => {
		const result = parseRepoIdentifier("facebook/react");
		expect(result.host).toBe("github");
		expect(result.displayName).toBe("facebook/react");
		expect(result.branch).toBeNull();
		expect(result.cloneUrl).toBe("https://github.com/facebook/react.git");
		expect(result.dirName).toBe("github_facebook_react");
	});

	it("parses GitHub shorthand with colon branch", () => {
		const result = parseRepoIdentifier("vuejs/vue:main");
		expect(result.host).toBe("github");
		expect(result.displayName).toBe("vuejs/vue");
		expect(result.branch).toBe("main");
		expect(result.dirName).toBe("github_vuejs_vue-main");
	});



	it("parses GitHub shorthand with slash-containing branch", () => {
		const result = parseRepoIdentifier("owner/repo:feature/foo");
		expect(result.host).toBe("github");
		expect(result.displayName).toBe("owner/repo");
		expect(result.branch).toBe("feature/foo");
	});



	it("does not treat scheme colon in HTTPS URL as branch", () => {
		const result = parseRepoIdentifier("https://gitlab.com/foo/bar");
		expect(result.host).toBe("gitlab");
		expect(result.cloneUrl).toBe("https://gitlab.com/foo/bar.git");
		expect(result.branch).toBeNull();
		expect(result.owner).toBe("foo");
		expect(result.repo).toBe("bar");
	});

	it("parses HTTPS URL with colon branch suffix", () => {
		const result = parseRepoIdentifier("https://gitlab.com/foo/bar:main");
		expect(result.host).toBe("gitlab");
		expect(result.cloneUrl).toBe("https://gitlab.com/foo/bar.git");
		expect(result.branch).toBe("main");
		expect(result.owner).toBe("foo");
		expect(result.repo).toBe("bar");
	});



	it("does not treat HTTP port colon as branch", () => {
		const result = parseRepoIdentifier("http://host:8080/path/to/repo");
		expect(result.cloneUrl).toBe("http://host:8080/path/to/repo.git");
		expect(result.branch).toBeNull();
	});

	it("parses HTTP URL with port and colon branch suffix", () => {
		const result = parseRepoIdentifier("http://host:8080/path/to/repo:main");
		expect(result.cloneUrl).toBe("http://host:8080/path/to/repo.git");
		expect(result.branch).toBe("main");
		expect(result.owner).toBe("path");
		expect(result.repo).toBe("repo");
	});

	it("does not treat SSH host delimiter as branch", () => {
		const result = parseRepoIdentifier("git@gitlab.com:foo/bar.git");
		expect(result.host).toBe("gitlab");
		expect(result.cloneUrl).toBe("git@gitlab.com:foo/bar.git");
		expect(result.branch).toBeNull();
		expect(result.owner).toBe("foo");
		expect(result.repo).toBe("bar");
	});

	it("parses SSH URL with single path component and no branch", () => {
		const result = parseRepoIdentifier("git@host:repo.git");
		expect(result.cloneUrl).toBe("git@host:repo.git");
		expect(result.branch).toBeNull();
	});

	it("parses SSH URL with colon branch suffix", () => {
		const result = parseRepoIdentifier("git@gitlab.com:foo/bar.git:main");
		expect(result.host).toBe("gitlab");
		expect(result.cloneUrl).toBe("git@gitlab.com:foo/bar.git");
		expect(result.branch).toBe("main");
		expect(result.owner).toBe("foo");
		expect(result.repo).toBe("bar");
	});

	it("parses SSH single-path URL with colon branch suffix", () => {
		const result = parseRepoIdentifier("git@host:repo.git:main");
		expect(result.cloneUrl).toBe("git@host:repo.git");
		expect(result.branch).toBe("main");
		expect(result.owner).toBe("repo");
		expect(result.repo).toBe("repo");
	});

	it("does not treat HTTP userinfo at-sign as branch", () => {
		const result = parseRepoIdentifier("http://user@host/path/to/repo");
		expect(result.cloneUrl).toBe("http://user@host/path/to/repo.git");
		expect(result.branch).toBeNull();
	});



	it("gives colon precedence over at-sign for branch delimiter", () => {
		const result = parseRepoIdentifier("owner/repo:feature@foo");
		expect(result.host).toBe("github");
		expect(result.displayName).toBe("owner/repo");
		expect(result.branch).toBe("feature@foo");
		expect(result.dirName).toBe("github_owner_repo-feature_foo");
	});

	it("parses local path without branch", () => {
		const result = parseRepoIdentifier("/tmp/my-repo");
		expect(result.host).toBe("generic");
		expect(result.cloneUrl).toBe("/tmp/my-repo");
		expect(result.branch).toBeNull();
		expect(result.owner).toBeUndefined();
		expect(result.repo).toBeUndefined();
		expect(result.dirName).toBe("tmp_my-repo");
	});

	it("parses local path with colon branch suffix", () => {
		const result = parseRepoIdentifier("/tmp/my-repo:feature/test");
		expect(result.host).toBe("generic");
		expect(result.cloneUrl).toBe("/tmp/my-repo");
		expect(result.branch).toBe("feature/test");
		expect(result.dirName).toBe("tmp_my-repo-feature_test");
	});

	it("trims trailing slash in HTTPS URL", () => {
		const result = parseRepoIdentifier("https://gitlab.com/foo/bar/");
		expect(result.cloneUrl).toBe("https://gitlab.com/foo/bar.git");
		expect(result.displayName).toBe("foo/bar");
		expect(result.repo).toBe("bar");
		expect(result.dirName).toBe("gitlab_foo_bar");
	});

	it("handles HTTPS URL with trailing slash and branch suffix", () => {
		const result = parseRepoIdentifier("https://gitlab.com/foo/bar/:main");
		expect(result.cloneUrl).toBe("https://gitlab.com/foo/bar.git");
		expect(result.branch).toBe("main");
		expect(result.displayName).toBe("foo/bar");
	});

	it("parses bare github.com URL as HTTPS", () => {
		const result = parseRepoIdentifier("github.com/biomejs/biome");
		expect(result.host).toBe("github");
		expect(result.cloneUrl).toBe("https://github.com/biomejs/biome.git");
		expect(result.displayName).toBe("biomejs/biome");
		expect(result.branch).toBeNull();
		expect(result.owner).toBe("biomejs");
		expect(result.repo).toBe("biome");
		expect(result.dirName).toBe("github_biomejs_biome");
	});

	it("parses bare github.com URL with colon branch", () => {
		const result = parseRepoIdentifier("github.com/biomejs/biome:main");
		expect(result.host).toBe("github");
		expect(result.cloneUrl).toBe("https://github.com/biomejs/biome.git");
		expect(result.branch).toBe("main");
		expect(result.displayName).toBe("biomejs/biome");
		expect(result.dirName).toBe("github_biomejs_biome-main");
	});



	it("parses bare gitlab.com URL as HTTPS", () => {
		const result = parseRepoIdentifier("gitlab.com/foo/bar");
		expect(result.host).toBe("gitlab");
		expect(result.cloneUrl).toBe("https://gitlab.com/foo/bar.git");
		expect(result.displayName).toBe("foo/bar");
		expect(result.owner).toBe("foo");
		expect(result.repo).toBe("bar");
	});

	it("parses bare github.com URL with .git suffix", () => {
		const result = parseRepoIdentifier("github.com/biomejs/biome.git");
		expect(result.host).toBe("github");
		expect(result.cloneUrl).toBe("https://github.com/biomejs/biome.git");
		expect(result.displayName).toBe("biomejs/biome");
		expect(result.repo).toBe("biome");
	});

	it("parses bare github.com URL with trailing slash", () => {
		const result = parseRepoIdentifier("github.com/biomejs/biome/");
		expect(result.host).toBe("github");
		expect(result.cloneUrl).toBe("https://github.com/biomejs/biome.git");
		expect(result.displayName).toBe("biomejs/biome");
		expect(result.repo).toBe("biome");
	});
});
