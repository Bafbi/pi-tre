/**
 * Interaction stamp path — the Session stamp with a transcript.
 *
 * Builds the sub-generator context from derived interaction data, runs header
 * + trace in parallel, assembles the commit body with provenance, and seals
 * the working copy. Always seals: a session stamp is bound to its session's
 * `@`.
 */

import { emitStatus } from "../action.js";
import {
	buildCommitBody,
	buildLoop,
	buildMeta,
	deriveSubject,
	type StampBodySection,
	smartWrap,
} from "../metadata.js";
import {
	generateHeader,
	generateTrace,
	type SubGeneratorContext,
} from "../sub-generator.js";
import { sealWorkingCopy } from "./internal.js";
import type { InteractionData, StampDeps, StampResult } from "./types.js";

// ---------------------------------------------------------------------------
// Sub-generator transcript builder
// ---------------------------------------------------------------------------

function buildTranscript(data: InteractionData): string {
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
// stampInteractionPath — the Interaction stamp path
// ---------------------------------------------------------------------------

/**
 * Execute the Interaction stamp path: derived transcript + diff → header and
 * trace, then the full seal.
 */
export async function stampInteractionPath(
	workspace: { sessionKey: string; wsPath: string },
	interaction: InteractionData,
	deps: StampDeps,
): Promise<StampResult> {
	const { wsPath, sessionKey } = workspace;
	const data = interaction;
	const cfg = deps.cfg;
	const jj = deps.jj;

	// Phase: collecting-diff
	emitStatus(deps.onStatus, { kind: "phase", code: "collecting-diff" });

	// The diff is auxiliary context for the sub-generator. A rejected fetch
	// degrades to an empty diff — it must not fail the stamp.
	let diff = "";
	try {
		diff = await jj.diff("@", { cwd: wsPath });
	} catch {
		// Non-fatal: the sub-generator still gets transcript + prior descriptions.
	}

	// Fetch prior descriptions (non-fatal).
	let priorDescriptions: string[] = [];
	try {
		const priorCommits = await jj.log(`ancestors(sillajje/${sessionKey})`, {
			cwd: wsPath,
		});
		priorDescriptions = priorCommits
			.map((commit) => commit.description.split("\n")[0] ?? "")
			.filter((line) => line.trim().length > 0)
			.slice(0, 5);
	} catch {
		// Optional context.
	}

	const subCtx: SubGeneratorContext = {
		transcript: buildTranscript(data),
		diff,
		previousDescriptions: priorDescriptions,
	};

	const wants = (section: StampBodySection): boolean =>
		cfg.body.includes(section);

	// Phase: generating-header
	emitStatus(deps.onStatus, { kind: "phase", code: "generating-header" });

	// Run header + trace sub-generators in parallel.
	const headerCall =
		cfg.headerMode !== "user_prompt"
			? generateHeader(subCtx, deps.run, {
					model: cfg.model,
					maxAttempts: cfg.maxAttempts,
					timeoutMs: cfg.timeoutMs,
					prompt: data.prompt,
				})
			: Promise.resolve({
					text: deriveSubject(data.prompt),
					fellBack: false,
				});

	const traceCall = wants("trace")
		? generateTrace(subCtx, deps.run, {
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
		emitStatus(deps.onStatus, {
			kind: "warning",
			code: "header-fallback",
			message:
				"commit subject generation failed — sub-generator exhausted retries",
		});
	}
	if (trace.fellBack) {
		fallbacks.push("trace");
		emitStatus(deps.onStatus, {
			kind: "warning",
			code: "trace-fallback",
			message:
				"commit trace generation failed — sub-generator exhausted retries",
		});
	}

	// Build metadata and commit body.
	const interactionMeta = {
		toolNames: data.toolNames,
		toolCallCount: data.toolCallCount,
		elapsedMs: data.elapsedMs,
		thinkingBlocks: data.thinkingBlocks,
	};
	const metadata = buildMeta({
		source: "interaction",
		sessionKey,
		model: cfg.model,
		fallbacks,
		env: deps.env,
	});
	const loop = wants("loop")
		? buildLoop(interactionMeta, cfg.loopFields)
		: "";

	const body = buildCommitBody(
		{
			subject,
			trace: wants("trace") ? smartWrap(trace.text, 72) : "",
			prompt: wants("prompt") ? data.prompt : "",
			metadata,
			loop,
			response: wants("response") ? data.response : "",
		},
		cfg.body,
	);

	// Phase: sealing-change
	emitStatus(deps.onStatus, { kind: "phase", code: "sealing-change" });

	try {
		return await sealWorkingCopy(deps, wsPath, sessionKey, body, subject);
	} catch (err) {
		emitStatus(deps.onStatus, {
			kind: "error",
			code: "unexpected_error",
			message: `stamp failed: ${String(err)}`,
		});
		return { ok: false, reason: "failed" };
	}
}
