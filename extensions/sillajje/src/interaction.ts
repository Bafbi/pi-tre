/**
 * The Interaction lifecycle as a projection of the session log.
 *
 * The adapter appends a Stamp marker after each Session stamp. The marker's
 * entry id is the cursor: everything after it on the current branch is the
 * next Interaction. `projectInteraction` derives that Interaction's data and
 * entry range, or returns undefined when the slice is incomplete.
 */

import type { Message } from "@earendil-works/pi-ai";
import type {
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { InteractionData } from "@pi-tre/sillajje-core";

import { deriveInteractionData } from "./derive.js";

/** The custom type of the Stamp marker entry. */
export const STAMP_MARKER_TYPE = "sillajje/stamp";

/**
 * The id of the last Stamp marker on the branch, or null when the branch has
 * none. It is the cursor: everything after it is the next Interaction.
 */
export function lastStampMarkerId(branch: SessionEntry[]): string | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (
			entry?.type === "custom" &&
			entry.customType === STAMP_MARKER_TYPE
		) {
			return entry.id;
		}
	}
	return null;
}

/**
 * Project the Interaction after `cursorId` from the current branch.
 *
 * `cursorId` is the id of the last Stamp marker on the branch, or null for a
 * fresh session. When the cursor is not on the branch — a fork — the whole
 * branch is the slice.
 *
 * Returns undefined when the slice has no complete Interaction: no user
 * message or no assistant message.
 */
export function projectInteraction(
	branch: SessionEntry[],
	cursorId: string | null,
): InteractionData | undefined {
	const start =
		cursorId === null
			? -1
			: branch.findIndex((entry) => entry.id === cursorId);

	const messageEntries = branch
		.slice(start + 1)
		.filter(
			(entry): entry is SessionMessageEntry => entry.type === "message",
		);

	const first = messageEntries[0];
	const last = messageEntries[messageEntries.length - 1];
	if (!first || !last) return undefined;

	const messages = messageEntries
		.map((entry) => entry.message)
		.filter(
			(message): message is Message =>
				message.role === "user" || message.role === "assistant",
		);

	const interaction = deriveInteractionData(messages);
	if (!interaction) return undefined;

	return { ...interaction, range: { first: first.id, last: last.id } };
}
