/**
 * The command port's adapter binding.
 *
 * The core names a command string, a cwd, a timeout, and a signal. This
 * module owns the parts that depend on the host: `sh -c`, the environment,
 * and the forced `CI=1`. A check that would prompt must fail fast instead of
 * hanging until its timeout, and a stray `CI=0` in the shell must not change
 * the gate's behaviour.
 */

import type { CommandPort } from "@pi-tre/sillajje-core";

/** The host's process execution, as `pi.exec` exposes it. */
export interface ExecHost {
	exec: (
		command: string,
		args: string[],
		options?: {
			cwd?: string;
			timeout?: number;
			signal?: AbortSignal;
		},
	) => Promise<{
		stdout: string;
		stderr: string;
		code: number;
		killed: boolean;
	}>;
}

/**
 * A command line run through `sh -c`. A check's `command` is an
 * operator-authored shell line from trusted project config, so a shell is the
 * feature; the repo's `no-shell-c` ast-grep rule flags this call as a
 * reminder.
 */
export function createCommandPort(host: ExecHost): CommandPort {
	return {
		async exec(input) {
			const started = Date.now();
			const options: {
				cwd: string;
				timeout: number;
				signal?: AbortSignal;
			} = { cwd: input.cwd, timeout: input.timeoutMs };
			if (input.signal !== undefined) options.signal = input.signal;
			const result = await host.exec(
				"sh",
				["-c", `export CI=1\n${input.command}`],
				options,
			);
			return {
				code: result.code,
				stdout: result.stdout,
				stderr: result.stderr,
				killed: result.killed,
				durationMs: Date.now() - started,
			};
		},
	};
}
