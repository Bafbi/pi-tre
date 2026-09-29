import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
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
import {
	createServeController,
	localUrlFor,
	onResponseClosed,
	resolveRequestPath,
} from "../../src/serve.js";

/** Whether `mkfifo` is on PATH; the FIFO test needs it. */
function hasMkfifo(): boolean {
	try {
		execFileSync("mkfifo", ["--version"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

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

	it("clamps a literal dot-dot segment to the root", () => {
		// A literal `..` never reaches the containment check: the URL parser
		// normalizes it away, so the result stays under the root.
		expect(resolveRequestPath("/srv/ws", "/../secret")).toEqual({
			ok: true,
			absPath: "/srv/ws/secret",
		});
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

describe("localUrlFor", () => {
	it("uses localhost for a wildcard bind", () => {
		expect(localUrlFor(8080, "0.0.0.0")).toBe("http://localhost:8080");
		expect(localUrlFor(8080, "::")).toBe("http://localhost:8080");
	});

	it("names a specific bound address", () => {
		expect(localUrlFor(8080, "192.168.1.5")).toBe(
			"http://192.168.1.5:8080",
		);
		expect(localUrlFor(8080, "127.0.0.1")).toBe("http://127.0.0.1:8080");
	});

	it("brackets an IPv6 literal", () => {
		expect(localUrlFor(8080, "::1")).toBe("http://[::1]:8080");
	});
});

describe("onResponseClosed", () => {
	it("runs on close, not on finish", () => {
		const res = new EventEmitter();
		let calls = 0;
		onResponseClosed(
			res as unknown as Parameters<typeof onResponseClosed>[0],
			() => {
				calls++;
			},
		);
		res.emit("finish");
		expect(calls).toBe(0);
		res.emit("close");
		expect(calls).toBe(1);
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

			const res = await fetch(`${status.localUrl}/hello.txt`);
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
			const res = await fetch(`${status.localUrl}/reports/`);
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
			const res = await fetch(`${status.localUrl}/site/`);
			expect(await res.text()).toBe("<h1>home</h1>");
		} finally {
			await controller.stop();
		}
	});

	it("serves an empty file with length zero", async () => {
		const root = tempDir();
		writeFileSync(join(root, "empty.txt"), "");
		const controller = createServeController({ host: "127.0.0.1" });
		try {
			const status = await controller.start({ sessionKey: "k", root });
			const res = await fetch(`${status.localUrl}/empty.txt`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-length")).toBe("0");
			expect(await res.text()).toBe("");
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
			const res = await fetch(`${status.localUrl}/f.txt`, {
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
		const res = await fetch(`${status.localUrl}/f.txt`);
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
			const res = await fetch(`${status.localUrl}/reports`, {
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
			const res = await fetch(`${status.localUrl}/site/`);
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
			const res = await fetch(`${status.localUrl}/link.txt`);
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

	it.skipIf(!hasMkfifo())(
		"answers 404 for a FIFO instead of blocking",
		async () => {
			const root = tempDir();
			execFileSync("mkfifo", [join(root, "pipe")]);
			const controller = createServeController({ host: "127.0.0.1" });
			try {
				const status = await controller.start({
					sessionKey: "k",
					root,
				});
				const res = await fetch(`${status.localUrl}/pipe`, {
					signal: AbortSignal.timeout(3000),
				});
				expect(res.status).toBe(404);
			} finally {
				await controller.stop();
			}
		},
	);

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
