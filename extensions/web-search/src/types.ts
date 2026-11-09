import type { ConsoleSearchResult } from "./client.js";

/** What the tool did, in one word. */
type WebSearchStatus = "ok" | "disabled" | "unconfigured" | "failed";

/** Result payload kept for rendering, session history, and codemode scripts. */
export interface WebSearchDetails {
	query: string;
	status: WebSearchStatus;
	results: ConsoleSearchResult[];
	/** USD billed to the workspace for this call. Zero when nothing was bought. */
	costUsd: number;
	/** Console provider id, `"opencode"`. */
	provider: string;
	endpoint: string;
	error?: string | undefined;
}
