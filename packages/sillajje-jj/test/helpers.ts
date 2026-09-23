import type { ExecFn, ExecOptions, ExecResult } from "../src/index.js";

interface RecordedCall {
	command: string;
	args: string[];
	options?: ExecOptions | undefined;
}

export interface RecordingExec {
	exec: ExecFn;
	calls: RecordedCall[];
}

/** A fake `ExecFn` that records every call and delegates to `handler`. */
export function recordingExec(
	handler: (args: string[], options?: ExecOptions) => ExecResult,
): RecordingExec {
	const calls: RecordedCall[] = [];
	const exec: ExecFn = async (command, args, options) => {
		calls.push({ command, args, options });
		return handler(args, options);
	};
	return { exec, calls };
}

export function ok(stdout = ""): ExecResult {
	return { code: 0, stdout, stderr: "", killed: false };
}

export function fail(stderr = "error", code = 1): ExecResult {
	return { code, stdout: "", stderr, killed: false };
}
