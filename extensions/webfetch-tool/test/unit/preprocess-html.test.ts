import { describe, expect, test } from "vitest";

import { preprocessHtmlForConversion } from "../../src/preprocess-html.js";

describe("preprocessHtmlForConversion", () => {
	test("prioritizes <main> and removes obvious boilerplate", () => {
		const html = `
			<html>
				<head><title>Test</title><script>console.log("x")</script></head>
				<body>
					<header><h1>Site Header</h1></header>
					<nav><a href="/a">A</a></nav>
					<main id="content" class="main docs" data-id="1">
						<h1>Article Title</h1>
						<p>Hello world.</p>
					</main>
					<footer>Footer text</footer>
				</body>
			</html>
		`;

		const result = preprocessHtmlForConversion(html, { maxChars: 10_000 });

		expect(result.strategy).toBe("main");
		expect(result.htmlForConversion).toContain("Article Title");
		expect(result.htmlForConversion).toContain("Hello world.");
		expect(result.htmlForConversion).not.toContain("Site Header");
		expect(result.htmlForConversion).not.toContain("Footer text");
		expect(result.htmlForConversion).not.toContain("console.log");
		expect(result.preparedChars).toBeLessThan(result.rawChars);
		expect(result.truncated).toBe(false);
	});

	test("preserves warning asides while removing sidebar-like asides", () => {
		const html = `
			<main>
				<aside class="warning">Security warning</aside>
				<aside class="sidebar" role="complementary">Table of contents</aside>
				<p>Body text</p>
			</main>
		`;

		const result = preprocessHtmlForConversion(html, { maxChars: 10_000 });

		expect(result.htmlForConversion).toContain("Security warning");
		expect(result.htmlForConversion).not.toContain("Table of contents");
		expect(result.htmlForConversion).toContain("Body text");
	});

	test("chooses the most content-dense main when multiple mains exist", () => {
		const html = `
			<main><p>tiny</p></main>
			<main>
				<h1>Actual content</h1>
				<p>${"Important content ".repeat(50)}</p>
			</main>
		`;

		const result = preprocessHtmlForConversion(html, { maxChars: 20_000 });

		expect(result.strategy).toBe("main");
		expect(result.htmlForConversion).toContain("Actual content");
		expect(result.htmlForConversion).not.toContain("<p>tiny</p>");
	});

	test("truncates when prepared html exceeds max chars", () => {
		const body = `<main><p>${"x".repeat(20_000)}</p></main>`;
		const result = preprocessHtmlForConversion(body, { maxChars: 2_000 });

		expect(result.strategy).toBe("main");
		expect(result.truncated).toBe(true);
		expect(result.preparedChars).toBe(2_000);
	});

	test("dom preprocessor keeps warning aside and picks dense main", () => {
		const html = `
			<main><p>tiny</p></main>
			<main>
				<aside class="warning">Read this warning</aside>
				<aside class="sidebar" role="complementary">TOC</aside>
				<h1>Primary content</h1>
				<p>${"Body ".repeat(80)}</p>
			</main>
		`;

		const result = preprocessHtmlForConversion(html, {
			maxChars: 20_000,
			preprocessor: "dom",
		});

		expect(result.strategy).toBe("dom-main");
		expect(result.htmlForConversion).toContain("Primary content");
		expect(result.htmlForConversion).toContain("Read this warning");
		expect(result.htmlForConversion).not.toContain("TOC");
	});
});
