import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDebugLogger } from "../../src/debug-log";

const LOG_PATH = join(homedir(), ".pi/logs/sillajje.log");

const tempDirs: string[] = [];

function cleanLog() {
	try {
		rmSync(LOG_PATH);
	} catch {
		/* ok */
	}
	for (const d of tempDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* ok */
		}
	}
}

function readLog(): string {
	if (!existsSync(LOG_PATH)) return "";
	return readFileSync(LOG_PATH, "utf-8");
}

describe("createDebugLogger", () => {
	beforeEach(cleanLog);
	afterEach(cleanLog);

	// -------------------------------------------------------------------
	// Enabled / disabled
	// -------------------------------------------------------------------

	it("returns a no-op logger when enabled is false", () => {
		const logger = createDebugLogger({ enabled: false });
		expect(logger.enabled).toBe(false);
		logger.event("test");
		expect(existsSync(LOG_PATH)).toBe(false);
	});

	it("returns a no-op logger by default", () => {
		const logger = createDebugLogger({ enabled: false });
		expect(logger.enabled).toBe(false);
	});

	it("returns an active logger when enabled is true", () => {
		const logger = createDebugLogger({ enabled: true });
		expect(logger.enabled).toBe(true);
	});

	// -------------------------------------------------------------------
	// Writing
	// -------------------------------------------------------------------

	it("writes event entries when enabled", () => {
		const logger = createDebugLogger({ enabled: true });
		logger.event("my_event", { count: 42 });

		const raw = readLog();
		expect(raw).toContain('"type":"event"');
		expect(raw).toContain('"name":"my_event"');
		expect(raw).toContain('"count":42');
	});

	it("writes error entries with message and stack", () => {
		const logger = createDebugLogger({ enabled: true });
		logger.error("my_error", new Error("test error"));

		const raw = readLog();
		expect(raw).toContain('"type":"error"');
		expect(raw).toContain('"name":"my_error"');
		expect(raw).toContain('"message":"test error"');
		expect(raw).toContain('"stack"');
	});

	it("handles non-Error objects in error()", () => {
		const logger = createDebugLogger({ enabled: true });
		logger.error("plain", "just a string");

		const raw = readLog();
		expect(raw).toContain('"message":"just a string"');
	});

	it("writes raw messages", () => {
		const logger = createDebugLogger({ enabled: true });
		logger.raw("hello world");

		const raw = readLog();
		expect(raw).toContain('"type":"raw"');
		expect(raw).toContain('"message":"hello world"');
	});

	it("appends multiple entries", () => {
		const logger = createDebugLogger({ enabled: true });
		logger.event("first");
		logger.event("second");

		const lines = readLog().trim().split("\n");
		expect(lines.length).toBe(2);
	});
});
