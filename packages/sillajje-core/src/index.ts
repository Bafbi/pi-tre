/**
 * `@pi-tre/sillajje-core` — the composition layer over the jj and workspace
 * boundaries.
 *
 * It owns the action contract, the shared status event, and the config
 * schema. It never imports pi.
 */

export type {
	Action,
	HostPorts,
	ProvenanceVersions,
	RunSubagent,
	StatusEvent,
	SubagentPort,
	SubagentRequest,
	SubagentResponse,
} from "./action.js";
export { emitStatus } from "./action.js";
export {
	ARCHIVE_ARGS,
	ARCHIVE_HELP,
	type ArchiveInput,
	type ArchiveResult,
	createArchive,
	createUnarchive,
	UNARCHIVE_ARGS,
	UNARCHIVE_HELP,
	type UnarchiveInput,
	type UnarchiveResult,
} from "./archive.js";
export {
	type ArgValue,
	type CommandHelp,
	type CommandSpec,
	type FlagDef,
	type ParseResult,
	parseCommandArgs,
	renderHelp,
	renderSessionFailure,
	STAMP_ARGS,
	STAMP_HELP,
} from "./args.js";
export { assembleDescription, type Section } from "./body.js";
export {
	defaultSillajjeConfig,
	type SillajjeConfig,
	SillajjeConfigSchema,
} from "./config.js";
export {
	createFold,
	FOLD_ARGS,
	FOLD_HELP,
	type FoldConfig,
	type FoldInput,
	type FoldResult,
	getFoldConfig,
} from "./fold.js";
export {
	buildCommitBody,
	buildFoldBody,
	buildLoop,
	buildMeta,
	type CommitBodyData,
	deriveSubject,
	FOLD_BODY_SECTIONS,
	type FoldBodyData,
	type FoldBodySection,
	type InteractionMeta,
	LOOP_FIELDS,
	type LoopField,
	STAMP_BODY_SECTIONS,
	type StampBodySection,
	type StampProvenance,
	type StampSource,
	smartWrap,
} from "./metadata.js";
export {
	createSetSessionBookmark,
	createStamp,
	getStampConfig,
	type InteractionData,
	type RevStampInput,
	type SessionFailure,
	type SessionStampInput,
	type SetSessionBookmarkInput,
	type StampActions,
	type StampConfig,
	type StampResult,
} from "./stamp/index.js";
export {
	type GeneratedText,
	generateHeader,
	generateManualHeader,
	generateTrace,
	type HeaderOptions,
	type SubGeneratorContext,
	type TraceOptions,
} from "./sub-generator.js";
export {
	createSync,
	SYNC_ARGS,
	SYNC_HELP,
	type SyncInput,
	type SyncResult,
} from "./sync.js";
