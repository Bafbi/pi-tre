/**
 * The Record: a persisted, observational entry in the session log.
 *
 * Sillajje writes Records for the operations it drives — a start Record, then
 * a terminal done, failed, or noop Record — so a failed or surprising run can
 * be diagnosed after the fact. The extension never reads a Record back; the
 * behavioral entries (the Base, Stamp, Folded source, and Seed markers) are a
 * separate concern. See ADR 0010.
 */

import type {
	FoldResult,
	OmittedFile,
	StampResult,
	StatusEvent,
} from "@pi-tre/sillajje-core";

/** The custom type of a Record entry. */
export const RECORD_TYPE = "sillajje/record";

/** The trigger that reached an operation, where it has more than one. */
type RecordTrigger =
	| "auto"
	| "flush"
	| "manual"
	| "cross-session"
	| "rev"
	| "command"
	| "shutdown"
	| "copy"
	| "push"
	| "pull";

/** Where in its life an operation is. */
type RecordStage = "start" | "done" | "failed" | "noop";

/** The stages a settle produces; it never produces `start`. */
type RecordTerminalStage = "done" | "failed" | "noop";

/** A failure's code and message. */
interface RecordError {
	code?: string | number | undefined;
	message: string;
}

/** The diff manifest: what reached the sub-generator, and what was dropped. */
interface RecordDiff {
	files?: number | undefined;
	omitted: ReadonlyArray<OmittedFile>;
}

/** A sub-generator's outcome. */
interface RecordGenerator {
	model?: string | undefined;
	fallbacks: readonly string[];
}

/** The fields every Record can carry. */
interface RecordBase {
	v: 1;
	stage: RecordStage;
	trigger?: RecordTrigger | undefined;
	session?: string | undefined;
	change?: string | undefined;
	error?: RecordError | undefined;
	diff?: RecordDiff | undefined;
	generator?: RecordGenerator | undefined;
}

/** The Workspace lifecycle. */
interface WorkspaceRecord extends RecordBase {
	operation: "workspace";
	resolved?: { base: string; label: string } | undefined;
	result?:
		| { status: "created"; fromRoot: boolean; workspace: string }
		| { status: "reused" }
		| { reason: string }
		| undefined;
}

/** A Seed copy, push, or pull. */
interface SeedRecord extends RecordBase {
	operation: "seed";
	trigger?: "copy" | "push" | "pull" | undefined;
	input?:
		| {
				source?: string | undefined;
				paths?: readonly string[] | undefined;
				target?: string | undefined;
				push?: boolean | undefined;
				pull?: boolean | undefined;
				force?: boolean | undefined;
		  }
		| undefined;
	result?:
		| {
				copied: readonly string[];
				skipped: readonly { path: string; reason: string }[];
		  }
		| { moved: boolean; paths: readonly string[] }
		| undefined;
}

/** The Base a `/sillajje:new` resolved. */
interface BaseRecord extends RecordBase {
	operation: "base";
	input?:
		| { onto?: string | undefined; ontoSession?: string | undefined }
		| undefined;
	resolved?: { base: string; label: string } | undefined;
}

/** A stamp of any trigger. */
interface StampRecord extends RecordBase {
	operation: "stamp";
	trigger?: "auto" | "flush" | "manual" | "cross-session" | "rev" | undefined;
	input?:
		| { target?: string | undefined; rev?: string | undefined }
		| undefined;
	result?:
		| { source: string; subject: string; rev: string }
		| { reason: string }
		| undefined;
}

/** A Fold. */
interface FoldRecord extends RecordBase {
	operation: "fold";
	input?:
		| {
				session?: string | undefined;
				rev?: string | undefined;
				onto?: string | undefined;
				named?: string | undefined;
				exclude?: readonly string[] | undefined;
				update?: string | undefined;
				push?: boolean | undefined;
				archive?: boolean | undefined;
				noMarker?: boolean | undefined;
				rebase?: string | undefined;
		  }
		| undefined;
	resolved?: { base: string; tip: string; target: string } | undefined;
	result?:
		| {
				subject: string;
				rev: string;
				ref: string;
				bookmark?: string | undefined;
				marker?: string | undefined;
				pushed: readonly string[];
				archived?: boolean | undefined;
				rebase?: string | undefined;
		  }
		| { reason: string; files?: readonly string[] | undefined }
		| undefined;
}

/** A Sync. */
interface SyncRecord extends RecordBase {
	operation: "sync";
	input?:
		| { target?: string | undefined; rev?: string | undefined }
		| undefined;
	result?:
		| { rev: string }
		| { reason: string; files?: readonly string[] | undefined }
		| undefined;
}

/** An Archive, from the command or the shutdown path. */
interface ArchiveRecord extends RecordBase {
	operation: "archive";
	trigger?: "command" | "shutdown" | undefined;
	input?: { target?: string | undefined } | undefined;
	result?:
		| { status: "removed" | "already-gone" | "failed" }
		| { reason: string }
		| undefined;
}

/** An Unarchive. */
interface UnarchiveRecord extends RecordBase {
	operation: "unarchive";
	trigger?: "command" | undefined;
	input?: { target?: string | undefined } | undefined;
	result?:
		| { sessionKey: string; workspace: string }
		| { reason: string }
		| undefined;
}

/** A blocked tool call or a corrected command form. */
interface GuardRecord extends RecordBase {
	operation: "guard";
	input?: Record<string, unknown> | undefined;
	result?: Record<string, unknown> | undefined;
}

/** One persisted Record, discriminated on the operation it observes. */
export type SillajjeRecord =
	| WorkspaceRecord
	| SeedRecord
	| BaseRecord
	| StampRecord
	| FoldRecord
	| SyncRecord
	| ArchiveRecord
	| UnarchiveRecord
	| GuardRecord;

/** The operation a Record observes. */
type RecordOperation = SillajjeRecord["operation"];

/** The fields one operation's Record carries. */
type RecordFieldsFor<Op extends RecordOperation> = Omit<
	Extract<SillajjeRecord, { operation: Op }>,
	"v" | "operation" | "stage"
>;

/** Where a Record goes. The adapter binds it to `pi.appendEntry`. */
export type RecordSink = (record: SillajjeRecord) => void;

/** One observed operation: the work, and how its result settles the Record. */
export interface RecordStep<Op extends RecordOperation, Result> {
	/** Fields merged into both the start and the terminal Record. */
	fields?: RecordFieldsFor<Op> | undefined;
	/** The work the Record observes. */
	run: () => Promise<Result>;
	/** The terminal stage and fields, computed from the result. */
	settle: (
		result: Result,
	) => { stage: RecordTerminalStage } & RecordFieldsFor<Op>;
}

/**
 * Run `step.run` between a start Record and a terminal Record. A thrown run
 * writes a failed Record carrying the throw's message and rethrows, so a crash
 * still leaves a trace. The sink is treated as infallible.
 */
export async function recordOperation<Op extends RecordOperation, Result>(
	sink: RecordSink,
	operation: Op,
	step: RecordStep<Op, Result>,
): Promise<Result> {
	const fields = step.fields ?? ({} as RecordFieldsFor<Op>);
	sink({ v: 1, operation, stage: "start", ...fields } as SillajjeRecord);
	try {
		const result = await step.run();
		sink({
			v: 1,
			operation,
			...fields,
			...step.settle(result),
		} as SillajjeRecord);
		return result;
	} catch (err) {
		sink({
			v: 1,
			operation,
			stage: "failed",
			...fields,
			error: {
				message: err instanceof Error ? err.message : String(err),
			},
		} as SillajjeRecord);
		throw err;
	}
}

/**
 * The `diff` and `generator` manifest a stamp or fold Record carries. Both
 * operations surface the same sub-generator diagnostics, so the mapping lives
 * in one place.
 */
const manifestFields = (diagnostics: {
	diff: { files: number; omitted: ReadonlyArray<OmittedFile> };
	model: string;
	fallbacks: readonly string[];
}): { diff: RecordDiff; generator: RecordGenerator } => ({
	diff: {
		files: diagnostics.diff.files,
		omitted: [...diagnostics.diff.omitted],
	},
	generator: {
		model: diagnostics.model,
		fallbacks: [...diagnostics.fallbacks],
	},
});

/**
 * The failure fields an operation's captured error statuses contribute. The
 * last error Status event carries the failing step code and jj's own message;
 * `fallback` stands in when the operation failed without emitting one.
 */
export const lastErrorFailure = (
	captured: readonly StatusEvent[],
	fallback: string,
): { error: RecordError } => {
	const err = [...captured].reverse().find((event) => event.kind === "error");
	return err === undefined
		? { error: { message: fallback } }
		: { error: { code: err.code, message: err.message } };
};

/** The terminal Record fields a successful StampResult contributes. */
const stampRecordFields = (
	result: Extract<StampResult, { ok: true }>,
): {
	change: string | undefined;
	result: { source: string; subject: string; rev: string };
	diff: RecordDiff;
	generator: RecordGenerator;
} => ({
	change: result.changeId,
	result: {
		source: result.diagnostics.source,
		subject: result.subject,
		rev: result.rev,
	},
	...manifestFields(result.diagnostics),
});

/** The terminal Record fields a successful FoldResult contributes. */
export const foldRecordFields = (
	result: Extract<FoldResult, { ok: true }>,
): RecordFieldsFor<"fold"> => ({
	change: result.rev,
	session: result.sessionKey,
	result: {
		subject: result.subject,
		rev: result.rev,
		ref: result.ref,
		bookmark: result.bookmark,
		marker: result.marker,
		pushed: [...result.pushed],
		archived: result.archived,
		rebase: result.rebase,
	},
	resolved: {
		base: result.diagnostics.base,
		tip: result.diagnostics.tip,
		target: result.diagnostics.target,
	},
	...manifestFields(result.diagnostics),
});

/** The settle every stamp path shares: done, noop, or the captured failure. */
export const stampSettle =
	(captured: readonly StatusEvent[]) =>
	(
		result: StampResult,
	): { stage: RecordTerminalStage } & RecordFieldsFor<"stamp"> =>
		result.ok
			? { stage: "done", ...stampRecordFields(result) }
			: result.reason === "no-changes"
				? { stage: "noop", result: { reason: "no-changes" } }
				: {
						stage: "failed",
						...lastErrorFailure(captured, "stamp failed"),
					};
