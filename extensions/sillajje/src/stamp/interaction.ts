/**
 * Interaction stamp path.
 *
 * Derives interaction data from the transcript, builds the Sub-generator
 * context, runs header + trace in parallel, assembles the commit body,
 * and seals the working copy.
 */

import type { InteractionMeta } from "../metadata.js";
import {
	buildCommitBody,
	buildMetadata,
	deriveSubject,
	smartWrap,
} from "../metadata.js";
import type { SubGeneratorContext } from "../sub-generator.js";
import { generateHeader, generateTrace } from "../sub-generator.js";
import { sessionBookmark } from "./bookmark.js";
import { deriveInteractionData } from "./derive.js";
import { describeRevision, emit, sealWorkingCopy } from "./internal.js";
import type {
	DerivedInteractionData,
	StampConfig,
	StampDeps,
	StampInput,
	StampResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Sub-generator transcript builder
// ---------------------------------------------------------------------------

function buildTranscript(data: DerivedInteractionData): string {
	return [
		`User: ${data.prompt}`,
		"",
		`Tools used: ${data.toolNames.join(", ")}`,
		"",
		"Assistant:",
		data.response,
	].join("\n");
}

// ---------------------------------------------------------------------------
// stub — the main Interaction stamp path
// ---------------------------------------------------------------------------

/**
 * Execute the Interaction stamp path.
 */
export async function stampInteraction(
	input: StampInput,
	deps: StampDeps,
	cfg: StampConfig,
): Promise<StampResult> {
	if (!input.interaction) {
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

	const diffResult = await deps.exec("jj", ["diff", "-r", rev], {
		cwd: wsPath,
	});
	const diff = diffResult.code === 0 ? diffResult.stdout : "";

	// Fetch prior descriptions (non-fatal).
	let priorDescriptions: string[] = [];
	try {
		const priorResult = await deps.exec(
			"jj",
			[
				"log",
				"-r",
				`ancestors(${sessionBookmark(sessionKey)})`,
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
		// Optional context.
	}

	const subCtx: SubGeneratorContext = {
		transcript: buildTranscript(data),
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

	// Build metadata and commit body.
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
		if (rev === "@") {
			return await sealWorkingCopy(
				deps,
				wsPath,
				sessionKey,
				body,
				subject,
			);
		}
		return await describeRevision(deps, wsPath, rev, body, subject);
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
