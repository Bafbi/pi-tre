/**
 * Stamp module — self-contained engine for sealing Interactions and diffs into
 * jj Changes. Single entry point: `stamp(input, deps)`.
 *
 * The module owns:
 * - Interaction stamp: derives prompt, response, thinking, tools, and elapsed
 *   from pi's `Message[]` transcript → builds Sub-generator transcript →
 *   runs Header + Trace in parallel → assembles the config-gated Commit body →
 *   seals the working copy (update-stale, describe, bookmark set, jj new).
 * - Diff stamp (`interaction: null`): fetches the diff, returns `no-changes`
 *   when empty, generates a conventional-commit header, describes the change.
 * - `setSessionBookmark`: exported for `before_agent_start` reuse.
 *
 * All dependencies are injected (ExecFn, SpawnFn, config, onStatus sink).
 * Expected failures are values (`ok: false`), never throws. The adapter
 * maps statuses and results to notifications.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { SillajjeConfig } from "./config.js";
import {
	buildCommitBody,
	buildMetadata,
	deriveSubject,
	type InteractionMeta,
	type MetadataFieldToggles,
	smartWrap,
} from "./metadata.js";
import type { SpawnFn, SubGeneratorContext } from "./sub-generator.js";
import { generateHeader, generateTrace } from "./sub-generator.js";
import type { ExecFn } from "./workspace.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for the stamp operation. */
export interface StampInput {
	/**
	 * Pi's own transcript (Message[] from @earendil-works/pi-ai).
	 * `null` for a Diff stamp (derived from a diff, not an Interaction).
	 */
	interaction: Message[] | null;
	/** Session workspace info. */
	workspace: { sessionKey: string; wsPath: string };
	/**
	 * Revision to target. Default `"@"`.
	 * `"@"` → full seal (update-stale → describe → bookmark set → jj new).
	 * Any other rev → describe-only.
	 */
	rev?: string;
}

/** Dependencies injected into the stamp module. */
export interface StampDeps {
	/** jj execution adapter (existing seam from the workspace module). */
	exec: ExecFn;
	/** Sub-generator subprocess adapter (existing seam). */
	spawn: SpawnFn;
	/** Fully-populated sillajje config. The module extracts its own options. */
	config: SillajjeConfig;
	/**
	 * Status sink — called during execution for phases, warnings, and errors.
	 * Treated as infallible: a throwing sink is caught and never corrupts the stamp.
	 */
	onStatus?: (s: StampStatus) => void;
}

/** A status event emitted during stamp execution. */
export type StampStatus =
	| {
			kind: "phase";
			code: "collecting-diff" | "generating-header" | "sealing-change";
	  }
	| {
			kind: "warning";
			code: "header-fallback" | "trace-fallback";
			message: string;
	  }
	| { kind: "error"; code: string; message: string };

/** The terminal result of a stamp operation. */
export type StampResult =
	| { ok: true; subject: string; rev: string }
	| { ok: false; reason: "no-changes" | "failed" };

// ---------------------------------------------------------------------------
// Config extraction (moved from the adapter)
// ---------------------------------------------------------------------------

interface StampConfig {
	headerMode: "one_line" | "user_prompt";
	traceEnabled: boolean;
	traceDetail: "high" | "step" | "decision";
	metaFields: MetadataFieldToggles;
	metaEnabled: boolean;
	showUserPrompt: boolean;
	showResponse: boolean;
	maxAttempts: number;
	timeoutMs: number;
	model: string;
}

/**
 * Extract stamping options from the fully-populated SillajjeConfig.
 * The sync-drift between schema defaults and these extraction defaults
 * is pinned by unit tests against `Default(SillajjeConfigSchema, {})`.
 */
function getStampConfig(cfg: SillajjeConfig): StampConfig {
	return {
		headerMode: cfg.message?.header ?? "one_line",
		traceEnabled: cfg.message?.body?.trace?.enabled ?? true,
		traceDetail: cfg.message?.body?.trace?.detail ?? "high",
		metaFields: cfg.message?.body?.meta ?? {},
		metaEnabled: cfg.message?.body?.meta?.enabled ?? true,
		showUserPrompt: cfg.message?.body?.user_prompt ?? true,
		showResponse: cfg.message?.body?.response ?? true,
		maxAttempts: cfg.subGenerator?.retry?.maxAttempts ?? 3,
		timeoutMs: cfg.subGenerator?.timeoutMs ?? 30_000,
		model: cfg.subGeneratorModel ?? "openai/gpt-4o-mini",
	};
}

// ---------------------------------------------------------------------------
// Derivation from pi's Message[] transcript
// ---------------------------------------------------------------------------

/**
 * Extract the concatenated text from an AssistantMessage's content blocks.
 * Filters to only `text` blocks and joins with newlines.
 */
export function extractAssistantText(
	msg: Pick<Message, "role" | "content">,
): string {
	if ("role" in msg && msg.role !== "assistant") return "";
	const content = (
		msg as { content?: Array<{ type: string; text?: string }> }
	).content;
	if (!content) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block.type === "text",
		)
		.map((b) => b.text)
		.join("\n");
}

/** Result of deriving interaction data from a Message[] transcript. */
interface DerivedInteractionData {
	prompt: string;
	response: string;
	toolNames: string[];
	toolCallCount: number;
	thinkingBlocks: number;
	elapsedMs: number;
}

/**
 * Derive interaction data from pi's Message[] transcript.
 *
 * - prompt: text from the first UserMessage
 * - response: text from the last AssistantMessage
 * - toolNames: set of unique toolCall names across all assistant messages
 * - toolCallCount: total toolCall blocks
 * - thinkingBlocks: total ThinkingContent blocks
 * - elapsedMs: last message timestamp - first message timestamp
 *
 * Returns `undefined` when there are no user or assistant messages.
 */
export function deriveInteractionData(
	messages: Message[],
): DerivedInteractionData | undefined {
	const userMsgs = messages.filter((m) => m.role === "user");
	const assistantMsgs = messages.filter((m) => m.role === "assistant");

	if (userMsgs.length === 0 || assistantMsgs.length === 0) return undefined;

	// Prompt: first user message text
	const firstUser = userMsgs[0];
	let prompt = "";
	if (typeof firstUser.content === "string") {
		prompt = firstUser.content.trim();
	} else {
		prompt = (firstUser.content ?? [])
			.filter((b) => "type" in b && b.type === "text")
			.map((b) => (b as { text: string }).text)
			.join("\n")
			.trim();
	}

	// Response: last assistant message text
	const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
	const response = extractAssistantText(lastAssistant);

	// Tool calls and thinking blocks from all assistant messages
	const toolNames = new Set<string>();
	let toolCallCount = 0;
	let thinkingBlocks = 0;

	for (const msg of assistantMsgs) {
		const content = msg.content ?? [];
		for (const block of content) {
			if (block.type === "toolCall") {
				toolCallCount++;
				toolNames.add(block.name);
			} else if (block.type === "thinking") {
				thinkingBlocks++;
			}
		}
	}

	// Elapsed: last message timestamp minus first
	const firstTimestamp = messages[0].timestamp;
	const lastTimestamp = messages[messages.length - 1].timestamp;
	const elapsedMs = Math.max(0, lastTimestamp - firstTimestamp);

	return {
		prompt,
		response,
		toolNames: [...toolNames],
		toolCallCount,
		thinkingBlocks,
		elapsedMs,
	};
}

// ---------------------------------------------------------------------------
// setSessionBookmark
// ---------------------------------------------------------------------------

/**
 * Point the `sillajje/<sessionKey>` bookmark at the workspace's current
 * working copy (`@`).
 *
 * Exported so `before_agent_start` reuses the same `ExecFn` path for the
 * initial bookmark creation.
 */
export async function setSessionBookmark(
	exec: ExecFn,
	sessionKey: string,
	wsPath: string,
): Promise<void> {
	await exec("jj", ["bookmark", "set", `sillajje/${sessionKey}`, "-r", "@"], {
		cwd: wsPath,
	});
}

// ---------------------------------------------------------------------------
// Status emission helper (infallible)
// ---------------------------------------------------------------------------

function emit(status: StampStatus, deps: StampDeps): void {
	if (!deps.onStatus) return;
	try {
		deps.onStatus(status);
	} catch {
		// A throwing sink must never corrupt the stamp.
	}
}

// ---------------------------------------------------------------------------
// Interaction stamp (the primary path)
// ---------------------------------------------------------------------------

/**
 * Execute the Interaction stamp path.
 *
 * Derives interaction data from the transcript, builds the Sub-generator
 * context, runs header + trace in parallel, assembles the commit body,
 * and seals the working copy.
 */
async function stampInteraction(
	input: StampInput,
	deps: StampDeps,
	cfg: StampConfig,
): Promise<StampResult> {
	if (!input.interaction) {
		// should not happen — caller guards this
		return { ok: false, reason: "failed" };
	}

	const messages = input.interaction;
	const data = deriveInteractionData(messages);

	if (!data) {
		return { ok: false, reason: "failed" };
	}

	const { wsPath, sessionKey } = input.workspace;
	const rev = input.rev ?? "@";

	// Phase: collecting-diff
	emit({ kind: "phase", code: "collecting-diff" }, deps);

	// Fetch diff.
	const diffResult = await deps.exec("jj", ["diff", "-r", rev], {
		cwd: wsPath,
	});
	const diff = diffResult.code === 0 ? diffResult.stdout : "";

	// Fetch prior descriptions.
	let priorDescriptions: string[] = [];
	try {
		const priorResult = await deps.exec(
			"jj",
			[
				"log",
				"-r",
				`ancestors(sillajje/${sessionKey})`,
				"--no-graph",
				"-T",
				"description.first_line()",
			],
			{ cwd: wsPath },
		);
		if (priorResult.code === 0) {
			priorDescriptions = priorResult.stdout
				.split("\n")
				.filter((l: string) => l.trim().length > 0)
				.slice(0, 5);
		}
	} catch {
		// Non-fatal — prior descriptions are optional context.
	}

	// Build sub-generator transcript (same format as the current adapter).
	const transcript = [
		`User: ${data.prompt}`,
		"",
		`Tools used: ${data.toolNames.join(", ")}`,
		"",
		"Assistant:",
		data.response,
	].join("\n");

	const subCtx: SubGeneratorContext = {
		transcript,
		diff,
		previousDescriptions: priorDescriptions,
	};

	// Phase: generating-header
	emit({ kind: "phase", code: "generating-header" }, deps);

	// Run header + trace sub-generators in parallel.
	const headerCall =
		cfg.headerMode !== "user_prompt"
			? generateHeader(subCtx, deps.spawn, {
					model: cfg.model,
					maxAttempts: cfg.maxAttempts,
					timeoutMs: cfg.timeoutMs,
					prompt: data.prompt,
				})
			: Promise.resolve(deriveSubject(data.prompt));

	const traceCall = cfg.traceEnabled
		? generateTrace(subCtx, deps.spawn, {
				model: cfg.model,
				maxAttempts: cfg.maxAttempts,
				timeoutMs: cfg.timeoutMs,
				detail: cfg.traceDetail,
			})
		: Promise.resolve("");

	const [subject, trace] = await Promise.all([headerCall, traceCall]);

	// Detect sub-generator fallback and emit warnings.
	if (
		cfg.headerMode !== "user_prompt" &&
		subject === deriveSubject(data.prompt)
	) {
		emit(
			{
				kind: "warning",
				code: "header-fallback",
				message:
					"commit subject generation failed — sub-generator exhausted retries",
			},
			deps,
		);
	}
	if (cfg.traceEnabled && trace === "") {
		emit(
			{
				kind: "warning",
				code: "trace-fallback",
				message:
					"commit trace generation failed — sub-generator exhausted retries",
			},
			deps,
		);
	}

	// Build metadata with config-gated per-field toggles.
	const interactionMeta: InteractionMeta = {
		toolNames: data.toolNames,
		toolCallCount: data.toolCallCount,
		elapsedMs: data.elapsedMs,
		thinkingBlocks: data.thinkingBlocks,
		sessionId: sessionKey,
	};
	const metaStr = cfg.metaEnabled
		? buildMetadata(interactionMeta, cfg.metaFields)
		: "";

	// Assemble the commit body with config-gated sections.
	const body = buildCommitBody({
		subject,
		trace: cfg.traceEnabled ? smartWrap(trace, 72) : "",
		prompt: cfg.showUserPrompt ? data.prompt : "",
		metadata: cfg.metaEnabled ? metaStr : "",
		response: cfg.showResponse ? data.response : "",
	});

	// Phase: sealing-change
	emit({ kind: "phase", code: "sealing-change" }, deps);

	try {
		// 1. Ensure the workspace working copy isn't stale.
		const updateResult = await deps.exec(
			"jj",
			["workspace", "update-stale"],
			{
				cwd: wsPath,
			},
		);
		if (updateResult.code !== 0) {
			emit(
				{
					kind: "error",
					code: "update_stale_failed",
					message: `jj workspace update-stale failed (exit ${updateResult.code}): ${updateResult.stderr}`,
				},
				deps,
			);
			return { ok: false, reason: "failed" };
		}

		// Full seal only for rev "@".
		if (rev === "@") {
			// 2. Describe the working copy with the interaction body.
			const descResult = await deps.exec("jj", ["describe", "-m", body], {
				cwd: wsPath,
			});
			if (descResult.code !== 0) {
				emit(
					{
						kind: "error",
						code: "describe_failed",
						message: `jj describe failed (exit ${descResult.code}): ${descResult.stderr}`,
					},
					deps,
				);
				return { ok: false, reason: "failed" };
			}

			// 3. Point the session bookmark at the stamped working copy.
			const bookmarkResult = await deps.exec(
				"jj",
				["bookmark", "set", `sillajje/${sessionKey}`, "-r", "@"],
				{ cwd: wsPath },
			);
			if (bookmarkResult.code !== 0) {
				emit(
					{
						kind: "error",
						code: "bookmark_set_failed",
						message: `jj bookmark set failed (exit ${bookmarkResult.code}): ${bookmarkResult.stderr}`,
					},
					deps,
				);
				return { ok: false, reason: "failed" };
			}

			// 4. Seal the current working copy and start a fresh one on top.
			const newResult = await deps.exec("jj", ["new"], { cwd: wsPath });
			if (newResult.code !== 0) {
				emit(
					{
						kind: "error",
						code: "jj_new_failed",
						message: `jj new failed (exit ${newResult.code}): ${newResult.stderr}`,
					},
					deps,
				);
				return { ok: false, reason: "failed" };
			}

			return { ok: true, subject, rev };
		}

		// Non-"@" rev: describe-only.
		const descResult = await deps.exec(
			"jj",
			["describe", "-r", rev, "-m", body],
			{
				cwd: wsPath,
			},
		);
		if (descResult.code !== 0) {
			emit(
				{
					kind: "error",
					code: "describe_failed",
					message: `jj describe failed (exit ${descResult.code}): ${descResult.stderr}`,
				},
				deps,
			);
			return { ok: false, reason: "failed" };
		}

		return { ok: true, subject, rev };
	} catch (err) {
		// Defects (unexpected throws from exec, etc.).
		emit(
			{
				kind: "error",
				code: "unexpected_error",
				message: `stamp failed: ${String(err)}`,
			},
			deps,
		);
		return { ok: false, reason: "failed" };
	}
}

// ---------------------------------------------------------------------------
// Diff stamp (the secondary path)
// ---------------------------------------------------------------------------

/**
 * Execute the Diff stamp path.
 *
 * Fetches the diff at the target revision, returns `no-changes` when empty,
 * generates a classic conventional-commit header, and describes the change.
 */
async function stampDiff(
	input: StampInput,
	deps: StampDeps,
	cfg: StampConfig,
): Promise<StampResult> {
	const { wsPath, sessionKey } = input.workspace;
	const rev = input.rev ?? "@";

	// Phase: collecting-diff
	emit({ kind: "phase", code: "collecting-diff" }, deps);

	// Fetch diff.
	const diffResult = await deps.exec("jj", ["diff", "-r", rev], {
		cwd: wsPath,
	});
	const diff = diffResult.code === 0 ? diffResult.stdout : "";

	if (!diff || diff.trim().length === 0) {
		return { ok: false, reason: "no-changes" };
	}

	// Phase: generating-header
	emit({ kind: "phase", code: "generating-header" }, deps);

	// Generate a classic conventional-commit header from the diff.
	const { generateManualHeader } = await import("./sub-generator.js");
	const subject = await generateManualHeader(diff, deps.spawn, {
		model: cfg.model,
		maxAttempts: cfg.maxAttempts,
		timeoutMs: cfg.timeoutMs,
	});

	// Detect sub-generator fallback.
	if (subject === "chore: manual checkpoint") {
		emit(
			{
				kind: "warning",
				code: "header-fallback",
				message:
					"commit subject generation failed — sub-generator exhausted retries",
			},
			deps,
		);
	}

	// Build body: subject + metadata line.
	const metaLine = `Meta: sillajje/${sessionKey}`;
	const body = `${subject}\n\n${metaLine}`;

	// Phase: sealing-change
	emit({ kind: "phase", code: "sealing-change" }, deps);

	try {
		if (rev === "@") {
			// Full seal.
			const updateResult = await deps.exec(
				"jj",
				["workspace", "update-stale"],
				{
					cwd: wsPath,
				},
			);
			if (updateResult.code !== 0) {
				emit(
					{
						kind: "error",
						code: "update_stale_failed",
						message: `jj workspace update-stale failed (exit ${updateResult.code}): ${updateResult.stderr}`,
					},
					deps,
				);
				return { ok: false, reason: "failed" };
			}

			const descResult = await deps.exec("jj", ["describe", "-m", body], {
				cwd: wsPath,
			});
			if (descResult.code !== 0) {
				emit(
					{
						kind: "error",
						code: "describe_failed",
						message: `jj describe failed (exit ${descResult.code}): ${descResult.stderr}`,
					},
					deps,
				);
				return { ok: false, reason: "failed" };
			}

			const bookmarkResult = await deps.exec(
				"jj",
				["bookmark", "set", `sillajje/${sessionKey}`, "-r", "@"],
				{ cwd: wsPath },
			);
			if (bookmarkResult.code !== 0) {
				emit(
					{
						kind: "error",
						code: "bookmark_set_failed",
						message: `jj bookmark set failed (exit ${bookmarkResult.code}): ${bookmarkResult.stderr}`,
					},
					deps,
				);
				return { ok: false, reason: "failed" };
			}

			const newResult = await deps.exec("jj", ["new"], { cwd: wsPath });
			if (newResult.code !== 0) {
				emit(
					{
						kind: "error",
						code: "jj_new_failed",
						message: `jj new failed (exit ${newResult.code}): ${newResult.stderr}`,
					},
					deps,
				);
				return { ok: false, reason: "failed" };
			}
		} else {
			// Describe-only.
			const descResult = await deps.exec(
				"jj",
				["describe", "-r", rev, "-m", body],
				{
					cwd: wsPath,
				},
			);
			if (descResult.code !== 0) {
				emit(
					{
						kind: "error",
						code: "describe_failed",
						message: `jj describe failed (exit ${descResult.code}): ${descResult.stderr}`,
					},
					deps,
				);
				return { ok: false, reason: "failed" };
			}
		}

		return { ok: true, subject, rev };
	} catch (err) {
		emit(
			{
				kind: "error",
				code: "unexpected_error",
				message: `stamp failed: ${String(err)}`,
			},
			deps,
		);
		return { ok: false, reason: "failed" };
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stamp a jj Change from an Interaction or a Diff.
 *
 * The main entry point for the stamp module. When `input.interaction` is a
 * `Message[]` transcript, the Interaction stamp path executes: derives
 * interaction data from the transcript, runs the Sub-generator for Header +
 * Trace in parallel, assembles the config-gated Commit body, and seals the
 * working copy (update-stale → describe → bookmark set → jj new for `@`;
 * describe-only for other revs).
 *
 * When `input.interaction` is `null`, the Diff stamp path executes: fetches
 * the diff at the target revision, returns `no-changes` when empty, generates
 * a classic conventional-commit header from the diff, and describes the change.
 *
 * Statuses stream through the injected `onStatus` sink during execution.
 * Expected failures (jj non-zero exit, sub-generator exhaustion) are returned
 * as `ok: false` values. The module never throws for expected failures.
 *
 * @param input - The stamp input (interaction transcript or null for diff).
 * @param deps - Injected dependencies (exec, spawn, config, onStatus sink).
 * @returns A StampResult value.
 */
export async function stamp(
	input: StampInput,
	deps: StampDeps,
): Promise<StampResult> {
	const cfg = getStampConfig(deps.config);

	if (input.interaction !== null) {
		return stampInteraction(input, deps, cfg);
	}
	return stampDiff(input, deps, cfg);
}
