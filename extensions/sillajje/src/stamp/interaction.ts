/**
 * Interaction stamp path — the Session stamp with a transcript.
 *
 * Derives interaction data from the transcript, builds the Sub-generator
 * context, runs header + trace in parallel, assembles the commit body with
 * provenance, and seals the working copy. Always seals: a session stamp is
 * bound to its session's `@`.
 */

import type { Message } from "@earendil-works/pi-ai";
import {
	buildCommitBody,
	deriveSubject,
	renderMetadata,
	smartWrap,
} from "../metadata.js";
import type { SubGeneratorContext } from "../sub-generator.js";
import { generateHeader, generateTrace } from "../sub-generator.js";
import { deriveInteractionData } from "./derive.js";
import { emit, sealWorkingCopy } from "./internal.js";
import type {
	DerivedInteractionData,
	StampConfig,
	StampDeps,
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
// stampInteractionPath — the Interaction stamp path (private)
// ---------------------------------------------------------------------------

/**
 * Execute the Interaction stamp path: transcript + diff → header and trace,
 * then the full seal.
 */
export async function stampInteractionPath(
	workspace: { sessionKey: string; wsPath: string },
	interaction: Message[],
	deps: StampDeps,
	cfg: StampConfig,
): Promise<StampResult> {
	const { wsPath, sessionKey } = workspace;
	const messages = interaction;

	const data = deriveInteractionData(messages);
	if (!data) {
		emit(
			{
				kind: "error",
				code: "derive_interaction_failed",
				message:
					"transcript lacks required interaction data (no user or assistant message)",
			},
			deps,
		);
		return { ok: false, reason: "failed" };
	}

	// Phase: collecting-diff
	emit({ kind: "phase", code: "collecting-diff" }, deps);

	// The diff is auxiliary context for the sub-generator. A rejected fetch
	// degrades to an empty diff — it must not fail the stamp.
	let diff = "";
	try {
		const diffResult = await deps.exec("jj", ["diff", "-r", "@"], {
			cwd: wsPath,
		});
		diff = diffResult.code === 0 ? diffResult.stdout : "";
	} catch {
		// Non-fatal: the sub-generator still gets transcript + prior descriptions.
	}

	// Fetch prior descriptions (non-fatal).
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
			: Promise.resolve({
					text: deriveSubject(data.prompt),
					fellBack: false,
				});

	const traceCall = cfg.traceEnabled
		? generateTrace(subCtx, deps.spawn, {
				model: cfg.model,
				maxAttempts: cfg.maxAttempts,
				timeoutMs: cfg.timeoutMs,
				detail: cfg.traceDetail,
			})
		: Promise.resolve({ text: "", fellBack: false });

	const [header, trace] = await Promise.all([headerCall, traceCall]);
	const subject = header.text;

	// Emit a warning only when a sub-generator actually exhausted its retries
	// (signalled by the generator's fallback flag, not by text comparison).
	const fallbacks: string[] = [];
	if (header.fellBack) {
		fallbacks.push("header");
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
	if (trace.fellBack) {
		fallbacks.push("trace");
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
	const interactionMeta = {
		toolNames: data.toolNames,
		toolCallCount: data.toolCallCount,
		elapsedMs: data.elapsedMs,
		thinkingBlocks: data.thinkingBlocks,
	};
	const metadata = renderMetadata({
		enabled: cfg.metaEnabled,
		fields: cfg.metaFields,
		model: cfg.model,
		fallbacks,
		env: deps.env,
		facts: { trigger: "interaction", sessionKey },
		meta: interactionMeta,
	});

	const body = buildCommitBody({
		subject,
		trace: cfg.traceEnabled ? smartWrap(trace.text, 72) : "",
		prompt: cfg.showUserPrompt ? data.prompt : "",
		metadata,
		response: cfg.showResponse ? data.response : "",
	});

	// Phase: sealing-change
	emit({ kind: "phase", code: "sealing-change" }, deps);

	try {
		return await sealWorkingCopy(deps, wsPath, sessionKey, body, subject);
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
