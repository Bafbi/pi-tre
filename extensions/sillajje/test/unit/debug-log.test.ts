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
import { afterEach, describe, expect, it } from "vitest";
import { createDebugLogger } from "../../src/debug-log";

const GLOBAL_CONFIG_DIR = join(homedir(), ".pi/configs");
const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "sillajje.json");
const LOG_PATH = join(homedir(), ".pi/logs/sillajje.log");

const tempDirs: string[] = [];

function cleanLog() {
	try {
		rmSync(LOG_PATH);
	} catch {
		/* ok */
	}
	try {
		rmSync(GLOBAL_CONFIG_PATH);
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

function writeGlobalConfig(debug: boolean) {
	mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
	writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify({ debug }));
}

function readLog(): string {
	if (!existsSync(LOG_PATH)) return "";
	return readFileSync(LOG_PATH, "utf-8");
}

describe("createDebugLogger", () => {
	afterEach(cleanLog);

	// -------------------------------------------------------------------
	// No repoRoot — uses global config only
	// -------------------------------------------------------------------

	it("returns a no-op logger when no config exists", () => {
		cleanLog();
		const logger = createDebugLogger();
		expect(logger.enabled).toBe(false);
		logger.event("test");
		expect(existsSync(LOG_PATH)).toBe(false);
	});

	it("returns a no-op logger when global debug is false", () => {
		writeGlobalConfig(false);
		const logger = createDebugLogger();
		expect(logger.enabled).toBe(false);
	});

	it("returns an active logger when global debug is true", () => {
		writeGlobalConfig(true);
		const logger = createDebugLogger();
		expect(logger.enabled).toBe(true);
	});

	// -------------------------------------------------------------------
	// With repoRoot — project config takes precedence
	// -------------------------------------------------------------------

	it("uses project config when present and debug=true", () => {
		// Global config is OFF, project config is ON
		writeGlobalConfig(false);
		const repoRoot = mkdtempSync(
			join(homedir(), ".pi/sillajje-debug-test-"),
		);
		tempDirs.push(repoRoot);
		const projCfgDir = join(repoRoot, ".pi/configs");
		mkdirSync(projCfgDir, { recursive: true });
		writeFileSync(
			join(projCfgDir, "sillajje.json"),
			JSON.stringify({ debug: true }),
		);

		const logger = createDebugLogger(repoRoot);
		expect(logger.enabled).toBe(true);
	});

	it("falls back to global when project config is missing", () => {
		writeGlobalConfig(true);
		const repoRoot = mkdtempSync(
			join(homedir(), ".pi/sillajje-debug-test-"),
		);
		tempDirs.push(repoRoot);
		// No .pi/configs/sillajje.json in repoRoot

		const logger = createDebugLogger(repoRoot);
		expect(logger.enabled).toBe(true);
	});

	it("project config debug=false overrides global debug=true", () => {
		writeGlobalConfig(true);
		const repoRoot = mkdtempSync(
			join(homedir(), ".pi/sillajje-debug-test-"),
		);
		tempDirs.push(repoRoot);
		const projCfgDir = join(repoRoot, ".pi/configs");
		mkdirSync(projCfgDir, { recursive: true });
		writeFileSync(
			join(projCfgDir, "sillajje.json"),
			JSON.stringify({ debug: false }),
		);

		const logger = createDebugLogger(repoRoot);
		expect(logger.enabled).toBe(false);
	});

	// -------------------------------------------------------------------
	// Writing
	// -------------------------------------------------------------------

	it("writes event entries when enabled", () => {
		writeGlobalConfig(true);
		const logger = createDebugLogger();
		logger.event("my_event", { count: 42 });

		const raw = readLog();
		expect(raw).toContain('"type":"event"');
		expect(raw).toContain('"name":"my_event"');
		expect(raw).toContain('"count":42');
	});

	it("writes error entries with message and stack", () => {
		writeGlobalConfig(true);
		const logger = createDebugLogger();
		logger.error("my_error", new Error("test error"));

		const raw = readLog();
		expect(raw).toContain('"type":"error"');
		expect(raw).toContain('"name":"my_error"');
		expect(raw).toContain('"message":"test error"');
		expect(raw).toContain('"stack"');
	});

	it("handles non-Error objects in error()", () => {
		writeGlobalConfig(true);
		const logger = createDebugLogger();
		logger.error("plain", "just a string");

		const raw = readLog();
		expect(raw).toContain('"message":"just a string"');
	});

	it("writes raw messages", () => {
		writeGlobalConfig(true);
		const logger = createDebugLogger();
		logger.raw("hello world");

		const raw = readLog();
		expect(raw).toContain('"type":"raw"');
		expect(raw).toContain('"message":"hello world"');
	});

	it("appends multiple entries", () => {
		writeGlobalConfig(true);
		const logger = createDebugLogger();
		logger.event("first");
		logger.event("second");

		const lines = readLog().trim().split("\n");
		expect(lines.length).toBe(2);
	});
});
