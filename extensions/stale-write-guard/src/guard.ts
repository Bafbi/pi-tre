export const DEFAULT_MTIME_TOLERANCE_MS = 2;

export interface StaleWriteCheckInput {
	currentMtimeMs: number;
	lastReadMtimeMs?: number;
	lastAgentEditMtimeMs?: number;
	toleranceMs?: number;
}

/**
 * Returns true when mutating an existing file would be unsafe because
 * the extension has no successful read record for the current file version.
 *
 * In practice this means:
 * - no recorded read yet -> block
 * - recorded read is older than current mtime -> block
 * - recorded read is up to date -> allow
 */
export function requiresReadBeforeMutation({
	currentMtimeMs,
	lastReadMtimeMs,
	toleranceMs = DEFAULT_MTIME_TOLERANCE_MS,
}: StaleWriteCheckInput): boolean {
	if (lastReadMtimeMs === undefined) {
		return true;
	}

	const readIsStale = currentMtimeMs - lastReadMtimeMs > toleranceMs;
	return readIsStale;
}
