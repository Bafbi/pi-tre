/**
 * `@pi-tre/sillajje-jj` — the typed substrate over the `jj` process.
 *
 * It owns every jj command, the deferred-operation transaction, and the
 * parsing of jj output. It knows jj and nothing of sillajje sessions, stamps,
 * or folds.
 */

export { formatFailure, JjError } from "./errors.js";
export type { ExecFn, ExecOptions, ExecResult } from "./exec.js";
export { createJj } from "./jj.js";
export type {
	Bookmark,
	Commit,
	Jj,
	JjFailure,
	Mutation,
	MutationResult,
	Result,
	RollbackFailure,
	Tx,
	Workspace,
} from "./types.js";
export type { JjVersion, VersionCheck } from "./versions.js";
export {
	checkVersionString,
	isSeriesValidated,
	parseJjVersion,
	seriesOf,
	VALIDATED_JJ_SERIES,
} from "./versions.js";
