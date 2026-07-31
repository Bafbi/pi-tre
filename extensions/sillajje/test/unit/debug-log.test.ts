import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDebugLogger } from "../../src/debug-log";

const tempDirs: string[] = [];

/** Create a fresh temp dir and return a log file path inside it. */
function makeLogPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "sillajje-log-test-"));
	tempDirs.push(dir);
	return join(dir, "sillajje.log");
}

function cleanLog() {
	for (const d of tempDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* ok */
		}
	}
}

function readLog(logPath: string): string {
	if (!existsSync(logPath)) return "";
	return readFileSync(logPath, "utf-8");
}

describe("createDebugLogger", () => {
	beforeEach(cleanLog);
	afterEach(cleanLog);

	// -------------------------------------------------------------------
	// Enabled / disabled
	// -------------------------------------------------------------------

	it("returns a no-op logger when enabled is false", () => {
		const logPath = makeLogPath();
		const logger = createDebugLogger({ enabled: false }, logPath);
		expect(logger.enabled).toBe(false);
		logger.event("test");
		expect(existsSync(logPath)).toBe(false);
	});

	it("returns a no-op logger by default", () => {
		const logPath = makeLogPath();
		const logger = createDebugLogger({ enabled: false }, logPath);
		expect(logger.enabled).toBe(false);
	});

	it("returns an active logger when enabled is true", () => {
		const logPath = makeLogPath();
		const logger = createDebugLogger({ enabled: true }, logPath);
		expect(logger.enabled).toBe(true);
	});

	// -------------------------------------------------------------------
	// Writing
	// -------------------------------------------------------------------

	it("writes event entries when enabled", () => {
		const logPath = makeLogPath();
		const logger = createDebugLogger({ enabled: true }, logPath);
		logger.event("my_event", { count: 42 });

		const raw = readLog(logPath);
		expect(raw).toContain('"type":"event"');
		expect(raw).toContain('"name":"my_event"');
		expect(raw).toContain('"count":42');
	});

	it("writes error entries with message and stack", () => {
		const logPath = makeLogPath();
		const logger = createDebugLogger({ enabled: true }, logPath);
		logger.error("my_error", new Error("test error"));

		const raw = readLog(logPath);
		expect(raw).toContain('"type":"error"');
		expect(raw).toContain('"name":"my_error"');
		expect(raw).toContain('"message":"test error"');
		expect(raw).toContain('"stack"');
	});

	it("handles non-Error objects in error()", () => {
		const logPath = makeLogPath();
		const logger = createDebugLogger({ enabled: true }, logPath);
		logger.error("plain", "just a string");

		const raw = readLog(logPath);
		expect(raw).toContain('"message":"just a string"');
	});

	it("writes raw messages", () => {
		const logPath = makeLogPath();
		const logger = createDebugLogger({ enabled: true }, logPath);
		logger.raw("hello world");

		const raw = readLog(logPath);
		expect(raw).toContain('"type":"raw"');
		expect(raw).toContain('"message":"hello world"');
	});

	it("appends multiple entries", () => {
		const logPath = makeLogPath();
		const logger = createDebugLogger({ enabled: true }, logPath);
		logger.event("first");
		logger.event("second");

		const lines = readLog(logPath).trim().split("\n");
		expect(lines.length).toBe(2);
	});
});
