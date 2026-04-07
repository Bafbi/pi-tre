import { describe, expect, test } from "vitest";

import { enforceUrlPolicy, normalizeUrl } from "../../src/url-policy.js";

describe("url policy", () => {
	test("rejects non-http protocol", () => {
		expect(() => normalizeUrl("file:///tmp/a.txt")).toThrowError(/Unsupported protocol/);
	});

	test("rejects credentials in url", () => {
		expect(() => normalizeUrl("https://user:pass@example.com")).toThrowError(/Credentials/);
	});

	test("blocks localhost by default", async () => {
		const url = normalizeUrl("http://localhost:8080/");
		await expect(enforceUrlPolicy(url, false)).rejects.toThrowError(/localhost/);
	});
});
