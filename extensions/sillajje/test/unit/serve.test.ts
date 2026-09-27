import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServeController, resolveRequestPath } from "../../src/serve.js";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "sillajje-serve-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveRequestPath", () => {
	it("resolves a normal path under the root", () => {
		expect(resolveRequestPath("/srv/ws", "/reports/a.html")).toEqual({
			ok: true,
			absPath: "/srv/ws/reports/a.html",
		});
	});

	it("rejects an encoded traversal", () => {
		// `%2e%2e%2f` decodes to `../` after the URL parser has run, so the
		// containment check, not the parser, has to catch it.
		const result = resolveRequestPath("/srv/ws", "/%2e%2e%2fsecret");
		expect(result).toEqual({ ok: false, status: 403 });
	});

	it("rejects a NUL byte", () => {
		expect(resolveRequestPath("/srv/ws", "/%00")).toEqual({
			ok: false,
			status: 400,
		});
	});

	it("rejects a malformed escape", () => {
		expect(resolveRequestPath("/srv/ws", "/%zz")).toEqual({
			ok: false,
			status: 400,
		});
	});
});

describe("createServeController", () => {
	it("serves a file and reports its status", async () => {
		const root = tempDir();
		writeFileSync(join(root, "hello.txt"), "hi there");
		const controller = createServeController({ host: "127.0.0.1" });
		try {
			const status = await controller.start({
				sessionKey: "user/host/s1",
				root,
			});
			expect(status.port).toBeGreaterThan(0);
			expect(controller.status()?.root).toBe(root);
			// A loopback bind advertises no LAN URL.
			expect(status.lanUrls).toEqual([]);

			const res = await fetch(`${status.localhostUrl}/hello.txt`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe(
				"text/plain; charset=utf-8",
			);
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(await res.text()).toBe("hi there");
		} finally {
			await controller.stop();
		}
		expect(controller.status()).toBeUndefined();
	});

	it("lists a directory when there is no index.html", async () => {
		const root = tempDir();
		mkdirSync(join(root, "reports"));
		writeFileSync(join(root, "reports", "a.html"), "<h1>a</h1>");
		const controller = createServeController({ host: "127.0.0.1" });
		try {
			const status = await controller.start({ sessionKey: "k", root });
			const res = await fetch(`${status.localhostUrl}/reports/`);
			expect(res.status).toBe(200);
			expect(await res.text()).toContain('href="a.html"');
		} finally {
			await controller.stop();
		}
	});

	it("serves index.html for a directory", async () => {
		const root = tempDir();
		mkdirSync(join(root, "site"));
		writeFileSync(join(root, "site", "index.html"), "<h1>home</h1>");
		const controller = createServeController({ host: "127.0.0.1" });
		try {
			const status = await controller.start({ sessionKey: "k", root });
			const res = await fetch(`${status.localhostUrl}/site/`);
			expect(await res.text()).toBe("<h1>home</h1>");
		} finally {
			await controller.stop();
		}
	});

	it("answers HEAD without a body", async () => {
		const root = tempDir();
		writeFileSync(join(root, "f.txt"), "abc");
		const controller = createServeController({ host: "127.0.0.1" });
		try {
			const status = await controller.start({ sessionKey: "k", root });
			const res = await fetch(`${status.localhostUrl}/f.txt`, {
				method: "HEAD",
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("content-length")).toBe("3");
			expect(await res.text()).toBe("");
		} finally {
			await controller.stop();
		}
	});

	it("stops when the served root disappears", async () => {
		const root = tempDir();
		writeFileSync(join(root, "f.txt"), "abc");
		const controller = createServeController({ host: "127.0.0.1" });
		let goneCalls = 0;
		const status = await controller.start({
			sessionKey: "k",
			root,
			onRootGone: () => {
				goneCalls++;
			},
		});

		rmSync(root, { recursive: true, force: true });
		const res = await fetch(`${status.localhostUrl}/f.txt`);
		expect(res.status).toBe(404);
		await vi.waitFor(() => {
			expect(controller.status()).toBeUndefined();
		});
		expect(goneCalls).toBe(1);
	});

	it("redirects a directory request that lacks the trailing slash", async () => {
		const root = tempDir();
		mkdirSync(join(root, "reports"));
		writeFileSync(join(root, "reports", "a.html"), "<h1>a</h1>");
		const controller = createServeController({ host: "127.0.0.1" });
		try {
			const status = await controller.start({ sessionKey: "k", root });
			const res = await fetch(`${status.localhostUrl}/reports`, {
				redirect: "manual",
			});
			expect(res.status).toBe(301);
			expect(res.headers.get("location")).toBe("/reports/");
		} finally {
			await controller.stop();
		}
	});

	it("refuses an index.html symlink that points outside the root", async () => {
		const root = tempDir();
		const outside = tempDir();
		writeFileSync(join(outside, "secret.txt"), "secret");
		mkdirSync(join(root, "site"));
		symlinkSync(
			join(outside, "secret.txt"),
			join(root, "site", "index.html"),
		);
		const controller = createServeController({ host: "127.0.0.1" });
		try {
			const status = await controller.start({ sessionKey: "k", root });
			const res = await fetch(`${status.localhostUrl}/site/`);
			expect(res.status).toBe(403);
		} finally {
			await controller.stop();
		}
	});

	it("refuses a symlinked file that points outside the root", async () => {
		const root = tempDir();
		const outside = tempDir();
		writeFileSync(join(outside, "secret.txt"), "secret");
		symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
		const controller = createServeController({ host: "127.0.0.1" });
		try {
			const status = await controller.start({ sessionKey: "k", root });
			const res = await fetch(`${status.localhostUrl}/link.txt`);
			expect(res.status).toBe(403);
		} finally {
			await controller.stop();
		}
	});

	it("rejects a concurrent start", async () => {
		const root = tempDir();
		const controller = createServeController({ host: "127.0.0.1" });
		const first = controller.start({ sessionKey: "k", root });
		await expect(
			controller.start({ sessionKey: "k", root }),
		).rejects.toThrow(/start already in progress/);
		try {
			await first;
			expect(controller.status()).toBeDefined();
		} finally {
			await controller.stop();
		}
	});

	it("refuses a second start while running", async () => {
		const root = tempDir();
		const controller = createServeController({ host: "127.0.0.1" });
		try {
			await controller.start({ sessionKey: "k", root });
			await expect(
				controller.start({ sessionKey: "k", root }),
			).rejects.toThrow(/already serving/);
		} finally {
			await controller.stop();
		}
	});
});
