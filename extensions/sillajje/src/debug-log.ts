/**
 * Debug logger for sillajje.
 *
 * When enabled, writes timestamped JSON-line entries to `~/.pi/logs/sillajje.log`.
 * When disabled, all methods are no-ops.
 *
 * Accepts its enabled flag as a dependency — callers provide the config
 * (from `config.ts`) rather than resolving it internally. This keeps the
 * module testable without filesystem mocking and follows the codebase-design
 * principle of "accept dependencies, don't create them."
 */

import { appendFileSync, mkdirSync } from "node:fs";
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

export interface DebugLoggerOptions {
	/** Whether the logger is enabled. */
	enabled: boolean;
}

// ---------------------------------------------------------------------------
// Log path
// ---------------------------------------------------------------------------

const DEFAULT_LOG_PATH = join(homedir(), ".pi/logs/sillajje.log");

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a debug logger.
 *
 * @param options - `{ enabled: boolean }`. When `false` (the default),
 *   returns a no-op logger. Pass `{ enabled: true }` to activate file logging.
 * @param logPath - Override for the log file path (defaults to
 *   `~/.pi/logs/sillajje.log`). Tests pass a temp path so the real user log
 *   is never written.
 */
export function createDebugLogger(
	options: DebugLoggerOptions,
	logPath?: string,
): DebugLogger {
	if (!options.enabled) {
		return noopLogger;
	}

	const resolvedLogPath = logPath ?? DEFAULT_LOG_PATH;

	// Ensure the log directory exists.
	mkdirSync(dirname(resolvedLogPath), { recursive: true });

	const write = (entry: Record<string, unknown>) => {
		try {
			appendFileSync(resolvedLogPath, `${JSON.stringify(entry)}\n`);
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
