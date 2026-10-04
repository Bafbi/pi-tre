/**
 * The Seed a session's workspace copied in.
 *
 * The Seed record is written to the session log when a copy runs, so a later
 * command can tell whether either side of a seeded path moved. It mirrors the
 * Base marker (`session-base.ts`): a custom entry read by scanning the branch
 * for the newest one.
 */

import { createHash } from "node:crypto";
import {
	copyFileSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { dirname } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CommandHelp, CommandSpec } from "@pi-tre/sillajje-core";

/** The custom type of the Seed record entry. */
export const SESSION_SEED_TYPE = "sillajje/seed";

/** The data a Seed record carries. */
export interface SeedRecord {
	/** The checkout the paths were copied from. */
	source: string;
	/** Workspace-relative file path → SHA-256 of the copied content. */
	paths: Record<string, string>;
}

/**
 * The newest Seed record on the branch, or undefined when the branch has none.
 * A record with a malformed body is treated as absent.
 */
export function lastSeedRecord(branch: SessionEntry[]): SeedRecord | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (
			entry?.type !== "custom" ||
			entry.customType !== SESSION_SEED_TYPE
		) {
			continue;
		}
		const data = entry.data;
		if (data === null || typeof data !== "object") continue;
		const source = (data as { source?: unknown }).source;
		const raw = (data as { paths?: unknown }).paths;
		if (
			typeof source !== "string" ||
			raw === null ||
			typeof raw !== "object"
		) {
			continue;
		}
		const paths: Record<string, string> = {};
		let malformed = false;
		for (const [key, value] of Object.entries(
			raw as Record<string, unknown>,
		)) {
			if (typeof value !== "string") {
				malformed = true;
				break;
			}
			paths[key] = value;
		}
		if (malformed) continue;
		return { source, paths };
	}
	return undefined;
}

/** The `/sillajje:seed` subcommand's flags. */
export const SEED_ARGS: CommandSpec = {
	name: "seed",
	usage: "seed [-s|--session <id>] [--push|--pull] [--force]",
	flags: [
		{ key: "session", aliases: ["-s", "--session"], takesValue: true },
		{ key: "push", aliases: ["--push"], takesValue: false },
		{ key: "pull", aliases: ["--pull"], takesValue: false },
		{ key: "force", aliases: ["--force"], takesValue: false },
	],
	exclusive: [["push", "pull"]],
};

/** The `/sillajje:seed` subcommand's help. */
export const SEED_HELP: CommandHelp = {
	usage: SEED_ARGS.usage,
	lines: [
		"Reports the ignored paths this session seeded and whether either side moved.",
		"  -s, --session <id>  target another session; @ means this session",
		"  --push              copy Workspace edits back to the checkout",
		"  --pull              refresh the Workspace copies from the checkout",
		"  --force             overwrite a path that moved on both sides",
		"  -h, --help          show this help",
		"A missing destination is created from the surviving side; a missing source is reported.",
	],
};

/** How a seeded path stands against the Seed record. */
export type SeedFileState =
	| "unchanged"
	| "workspace-moved"
	| "checkout-moved"
	| "both-moved"
	| "workspace-missing"
	| "checkout-missing";

/**
 * SHA-256 of a file's bytes, or undefined when the file cannot be read. The
 * undefined result is a state, not an error: the caller reports a missing file.
 */
export function hashFile(path: string): string | undefined {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return undefined;
	}
}

/**
 * Classify one seeded path from the recorded hash and the current hash on each
 * side. A missing file is its own state, so a caller reports rather than
 * treats it as a move.
 */
export function seedFileState(
	recorded: string,
	workspaceHash: string | undefined,
	checkoutHash: string | undefined,
): SeedFileState {
	if (workspaceHash === undefined) return "workspace-missing";
	if (checkoutHash === undefined) return "checkout-missing";
	const workspaceMoved = workspaceHash !== recorded;
	const checkoutMoved = checkoutHash !== recorded;
	if (workspaceMoved && checkoutMoved) return "both-moved";
	if (workspaceMoved) return "workspace-moved";
	if (checkoutMoved) return "checkout-moved";
	return "unchanged";
}

/**
 * Copy one file to another path, creating the destination's parents. A
 * destination symlink is removed first, so the copy never writes through it to
 * a target outside the Workspace or the checkout.
 */
export function copySeedFile(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true });
	try {
		if (lstatSync(to).isSymbolicLink()) rmSync(to);
	} catch {
		// No destination yet.
	}
	copyFileSync(from, to);
}
