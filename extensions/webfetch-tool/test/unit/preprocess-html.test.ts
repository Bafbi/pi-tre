import { describe, expect, test } from "vitest";

import { preprocessHtmlForConversion } from "../../src/preprocess-html.js";

describe("preprocessHtmlForConversion", () => {
	test("keeps broad structure while filtering attributes", () => {
		const html = `
			<html>
				<body>
					<header id="top" class="top-bar" style="background: blue">Header</header>
					<nav role="navigation" aria-label="Main Menu" aria-expanded="true">
						<a href="/docs" target="_blank" rel="noreferrer" tabindex="0">Docs</a>
					</nav>
					<main id="content" class="docs" data-category="AI" data-track-click="true" data-label="Guides">
						<p style="color:red">Hello world.</p>
					</main>
					<footer class="site-footer">Footer</footer>
					<script>console.log("remove")</script>
				</body>
			</html>
		`;

		const result = preprocessHtmlForConversion(html, { maxChars: 20_000 });

		expect(result.strategy).toBe("body-broad");
		expect(result.htmlForConversion).toContain("<header");
		expect(result.htmlForConversion).toContain("<nav");
		expect(result.htmlForConversion).toContain("<footer");
		expect(result.htmlForConversion).toContain('class="top-bar"');
		expect(result.htmlForConversion).toContain('id="content"');
		expect(result.htmlForConversion).toContain('aria-label="Main Menu"');
		expect(result.htmlForConversion).toContain('data-category="AI"');
		expect(result.htmlForConversion).toContain('data-label="Guides"');
		expect(result.htmlForConversion).not.toContain('data-track-click="true"');
		expect(result.htmlForConversion).not.toContain('aria-expanded="true"');
		expect(result.htmlForConversion).not.toContain('style="color:red"');
		expect(result.htmlForConversion).not.toContain("target=");
		expect(result.htmlForConversion).not.toContain("rel=");
		expect(result.htmlForConversion).not.toContain("tabindex=");
		expect(result.htmlForConversion).not.toContain("console.log");
	});

	test("keeps json-ld scripts and removes executable scripts", () => {
		const html = `
			<body>
				<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
				<script type="text/javascript">alert(1)</script>
			</body>
		`;

		const result = preprocessHtmlForConversion(html, { maxChars: 20_000 });

		expect(result.htmlForConversion).toContain('type="application/ld+json"');
		expect(result.htmlForConversion).toContain("BreadcrumbList");
		expect(result.htmlForConversion).not.toContain("alert(1)");
	});

	test("converts images with alt text and removes alt-less images", () => {
		const html = `
			<body>
				<img src="hero.jpg" alt="Hero banner" />
				<img src="icon.jpg" />
			</body>
		`;

		const result = preprocessHtmlForConversion(html, { maxChars: 20_000 });

		expect(result.htmlForConversion).toContain("[Image: Hero banner]");
		expect(result.htmlForConversion).not.toContain("icon.jpg");
		expect(result.htmlForConversion).not.toContain("<img");
	});

	test("removes fluff blocks by class/id signals", () => {
		const html = `
			<body>
				<div id="cookie-consent" class="gdpr-banner">We use cookies</div>
				<div class="newsletter-popup">Subscribe now</div>
				<div class="social-icons">share links</div>
				<main><p>Important page content</p></main>
			</body>
		`;

		const result = preprocessHtmlForConversion(html, { maxChars: 20_000 });

		expect(result.htmlForConversion).not.toContain("We use cookies");
		expect(result.htmlForConversion).not.toContain("Subscribe now");
		expect(result.htmlForConversion).not.toContain("share links");
		expect(result.htmlForConversion).toContain("Important page content");
	});

	test("prunes interaction elements and keeps navigational links", () => {
		const html = `
			<body>
				<form><input value="q" /></form>
				<button><a href="/next">Next</a></button>
				<button>Click me</button>
				<a href="#">Hash</a>
				<a href="javascript:doThing()">Run JS</a>
				<a href="mailto:x@example.com">Mail</a>
				<a href="tel:+123">Call</a>
				<a href="/valid">Valid</a>
			</body>
		`;

		const result = preprocessHtmlForConversion(html, { maxChars: 20_000 });

		expect(result.htmlForConversion).not.toContain("<form");
		expect(result.htmlForConversion).not.toContain("<input");
		expect(result.htmlForConversion).not.toContain("<button");
		expect(result.htmlForConversion).toContain('href="/next"');
		expect(result.htmlForConversion).toContain('href="/valid"');
		expect(result.htmlForConversion).not.toContain('href="#"');
		expect(result.htmlForConversion).not.toContain("javascript:doThing");
		expect(result.htmlForConversion).not.toContain("mailto:x@example.com");
		expect(result.htmlForConversion).not.toContain("tel:+123");
	});

	test("removes aria-hidden subtrees", () => {
		const html = `
			<body>
				<div aria-hidden="true"><p>Decorative text</p></div>
				<main><p>Visible content</p></main>
			</body>
		`;

		const result = preprocessHtmlForConversion(html, { maxChars: 20_000 });

		expect(result.htmlForConversion).not.toContain("Decorative text");
		expect(result.htmlForConversion).toContain("Visible content");
	});

	test("truncates when prepared html exceeds max chars", () => {
		const html = `<body><p>${"x".repeat(20_000)}</p></body>`;
		const result = preprocessHtmlForConversion(html, { maxChars: 2_000 });

		expect(result.strategy).toBe("body-broad");
		expect(result.truncated).toBe(true);
		expect(result.preparedChars).toBe(2_000);
	});
});
