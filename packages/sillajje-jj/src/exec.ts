/**
 * The process seam, defined locally so the package carries no pi import.
 *
 * Structurally identical to pi's `ExecOptions` / `ExecResult`: the adapter
 * passes `pi.exec` straight in, and the package's tests pass a fake.
 */

export interface ExecOptions {
	/** Abort signal — lets a hung jj be cancelled. */
	signal?: AbortSignal;
	/** Timeout in milliseconds. */
	timeout?: number;
	/** Working directory jj runs in (the workspace or repo root). */
	cwd?: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	/** True when the process was killed (timeout or abort). */
	killed?: boolean;
}

/** Execute a command and return its captured streams and exit code. */
export type ExecFn = (
	command: string,
	args: string[],
	options?: ExecOptions,
) => Promise<ExecResult>;
