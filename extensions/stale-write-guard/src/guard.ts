const DEFAULT_MTIME_TOLERANCE_MS = 2;

/**
 * Returns true when a whole-file write is unsafe because the extension has
 * no full-read record for the file's current version.
 *
 * The filesystem records when a file changed (mtime), but not whether the
 * agent has seen the whole current version. So we compare the current mtime
 * against the mtime recorded when the whole file last reached context.
 */
export function requiresFullReadBeforeWrite(
	currentMtimeMs: number,
	fullReadMtimeMs: number | undefined,
): boolean {
	if (fullReadMtimeMs === undefined) return true;
	return currentMtimeMs - fullReadMtimeMs > DEFAULT_MTIME_TOLERANCE_MS;
}
