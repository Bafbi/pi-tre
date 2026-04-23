import { describe, expect, it } from "vitest";

import { parseRepoIdentifier } from "../../src/resolver.js";

describe("parseRepoIdentifier", () => {
	it("parses GitHub shorthand without branch", () => {
		const result = parseRepoIdentifier("facebook/react");
		expect(result.host).toBe("github");
		expect(result.displayName).toBe("facebook/react");
		expect(result.branch).toBeNull();
		expect(result.cloneUrl).toBe("https://github.com/facebook/react.git");
	});

	it("parses GitHub shorthand with colon branch", () => {
		const result = parseRepoIdentifier("vuejs/vue:main");
		expect(result.host).toBe("github");
		expect(result.displayName).toBe("vuejs/vue");
		expect(result.branch).toBe("main");
	});

	it("parses GitHub shorthand with at-sign branch", () => {
		const result = parseRepoIdentifier("vuejs/vue@main");
		expect(result.host).toBe("github");
		expect(result.displayName).toBe("vuejs/vue");
		expect(result.branch).toBe("main");
	});

	it("parses GitHub shorthand with slash-containing branch", () => {
		const result = parseRepoIdentifier("owner/repo:feature/foo");
		expect(result.host).toBe("github");
		expect(result.displayName).toBe("owner/repo");
		expect(result.branch).toBe("feature/foo");
	});

	it("parses GitHub shorthand with at-sign slash-containing branch", () => {
		const result = parseRepoIdentifier("owner/repo@feature/foo");
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

	it("parses HTTPS URL with at-sign branch suffix", () => {
		const result = parseRepoIdentifier("https://gitlab.com/foo/bar@main");
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

	it("parses HTTP URL with userinfo and at-sign branch suffix", () => {
		const result = parseRepoIdentifier("http://user@host/path/to/repo@main");
		expect(result.cloneUrl).toBe("http://user@host/path/to/repo.git");
		expect(result.branch).toBe("main");
		expect(result.owner).toBe("path");
		expect(result.repo).toBe("repo");
	});

	it("parses local path without branch", () => {
		const result = parseRepoIdentifier("/tmp/my-repo");
		expect(result.host).toBe("generic");
		expect(result.cloneUrl).toBe("/tmp/my-repo");
		expect(result.branch).toBeNull();
		expect(result.owner).toBeUndefined();
		expect(result.repo).toBeUndefined();
	});

	it("parses local path with colon branch suffix", () => {
		const result = parseRepoIdentifier("/tmp/my-repo:feature/test");
		expect(result.host).toBe("generic");
		expect(result.cloneUrl).toBe("/tmp/my-repo");
		expect(result.branch).toBe("feature/test");
	});
});
