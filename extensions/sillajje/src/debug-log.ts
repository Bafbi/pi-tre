/**
 * Debug logger for sillajje.
 *
 * When debug is enabled (via `.pi/configs/sillajje.json` in the repo
 * or `~/.pi/configs/sillajje.json` globally, with `{ "debug": true }`),
 * writes timestamped JSON-line entries to `~/.pi/logs/sillajje.log`.
 * When disabled, all methods are no-ops.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DebugLogger {
	/** Whether debug logging is active. */
	readonly enabled: boolean;
	/** Log a named event with optional structured data. */
	event(name: string, data?: Record<string, unknown>): void;
	/** Log an error event. */
	error(name: string, err: unknown): void;
	/** Write a raw message to the log. */
	raw(message: string): void;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

const GLOBAL_CONFIG_PATH = join(homedir(), ".pi/configs/sillajje.json");
const LOG_PATH = join(homedir(), ".pi/logs/sillajje.log");

/**
 * Read the debug flag from a JSON config file.
 * Returns `false` if the file doesn't exist or can't be parsed.
 */
function readDebugFlag(configPath: string): boolean {
	try {
		const raw = readFileSync(configPath, "utf-8");
		const config = JSON.parse(raw);
		return config.debug === true;
	} catch {
		return false;
	}
}

/**
 * Resolve the debug flag. Checks project-local config first
 * (`.pi/configs/sillajje.json` relative to `repoRoot`): if it exists,
 * its value wins. Otherwise falls back to the global config.
 */
function resolveDebugFlag(repoRoot?: string): boolean {
	if (repoRoot) {
		const localPath = join(repoRoot, ".pi/configs/sillajje.json");
		try {
			const raw = readFileSync(localPath, "utf-8");
			const config = JSON.parse(raw);
			// Project config exists — its value is authoritative.
			return config.debug === true;
		} catch {
			// Project config doesn't exist or is borked — fall through.
		}
	}
	return readDebugFlag(GLOBAL_CONFIG_PATH);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a debug logger.
 *
 * When `repoRoot` is provided, checks `.pi/configs/sillajje.json` there first;
 * otherwise uses the global config at `~/.pi/configs/sillajje.json`.
 * Returns a no-op logger when debug is not enabled.
 */
export function createDebugLogger(repoRoot?: string): DebugLogger {
	const enabled = resolveDebugFlag(repoRoot);

	if (!enabled) {
		return noopLogger;
	}

	// Ensure the log directory exists.
	mkdirSync(dirname(LOG_PATH), { recursive: true });

	const write = (entry: Record<string, unknown>) => {
		try {
			appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
		} catch {
			// Log write failure is silent — don't break the extension.
		}
	};

	return {
		enabled: true,
		event(name: string, data?: Record<string, unknown>) {
			write({
				ts: new Date().toISOString(),
				type: "event",
				name,
				...data,
			});
		},
		error(name: string, err: unknown) {
			write({
				ts: new Date().toISOString(),
				type: "error",
				name,
				message: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			});
		},
		raw(message: string) {
			write({
				ts: new Date().toISOString(),
				type: "raw",
				message,
			});
		},
	};
}

// ---------------------------------------------------------------------------
// No-op fallback
// ---------------------------------------------------------------------------

const noopLogger: DebugLogger = {
	enabled: false,
	event: () => {},
	error: () => {},
	raw: () => {},
};
