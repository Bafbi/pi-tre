/**
 * Internal helpers shared across stamp sub-modules.
 */

import type { SillajjeConfig } from "../config.js";
import type { StampConfig, StampDeps, StampStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Config extraction
// ---------------------------------------------------------------------------

/**
 * Extract stamping options from the fully-populated SillajjeConfig.
 * The sync-drift between schema defaults and these extraction defaults
 * is pinned by unit tests against `Default(SillajjeConfigSchema, {})`.
 */
export function getStampConfig(cfg: SillajjeConfig): StampConfig {
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
// Status emission (infallible)
// ---------------------------------------------------------------------------

/**
 * Emit a status through the onStatus sink.
 * A throwing sink is caught — it must never corrupt the stamp.
 */
export function emit(status: StampStatus, deps: StampDeps): void {
	if (!deps.onStatus) return;
	try {
		deps.onStatus(status);
	} catch {
		// A throwing sink must never corrupt the stamp.
	}
}

// ---------------------------------------------------------------------------
// jj seal sequence
// ---------------------------------------------------------------------------

/**
 * Execute the full jj seal sequence on the workspace working copy:
 * update-stale → describe → bookmark set → jj new.
 *
 * Returns `ok: false` on any jj failure, with an error status emitted.
 * Returns `ok: true` on success.
 */
export async function sealWorkingCopy(
	deps: StampDeps,
	wsPath: string,
	sessionKey: string,
	body: string,
	subject: string,
): Promise<
	{ ok: true; subject: string; rev: string } | { ok: false; reason: "failed" }
> {
	// 1. Ensure the workspace working copy isn't stale.
	const updateResult = await deps.exec("jj", ["workspace", "update-stale"], {
		cwd: wsPath,
	});
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

	// 2. Describe the working copy with the commit body.
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

	return { ok: true, subject, rev: "@" };
}

/**
 * Describe a specific revision with the commit body (no bookmark set, no jj new).
 * Used for non-"@" rev stamps and the diff path's standalone describe.
 */
export async function describeRevision(
	deps: StampDeps,
	wsPath: string,
	rev: string,
	body: string,
	subject: string,
): Promise<
	{ ok: true; subject: string; rev: string } | { ok: false; reason: "failed" }
> {
	const descResult = await deps.exec(
		"jj",
		["describe", "-r", rev, "-m", body],
		{ cwd: wsPath },
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
}
