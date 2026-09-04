export const DEFAULT_MTIME_TOLERANCE_MS = 2;

/**
 * Returns true when mutating an existing file is unsafe because the
 * extension has no read record for the file's current version.
 *
 * The filesystem records when a file changed (mtime), but not whether
 * the agent has read that version. So we compare the current mtime
 * against the mtime recorded the last time the agent saw the file.
 */
export function requiresReadBeforeMutation(
	currentMtimeMs: number,
	lastSeenMtimeMs: number | undefined,
): boolean {
	if (lastSeenMtimeMs === undefined) return true;
	return currentMtimeMs - lastSeenMtimeMs > DEFAULT_MTIME_TOLERANCE_MS;
}
