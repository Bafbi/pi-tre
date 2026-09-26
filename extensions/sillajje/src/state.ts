/** Lifecycle state of a sillajje session. */
export type SessionLifecycle = "inactive" | "active" | "archived";

/**
 * In-memory session state.
 *
 * Tracks jj availability, repo root, workspace path, lifecycle, and the
 * Interaction cursor.
 * Callers query state via getters and transition via explicit methods.
 */
export class SessionState {
	private lifecycle: SessionLifecycle = "inactive";

	/** Absolute path to the jj-initialized repo root, or undefined when not found. */
	private repoRoot: string | undefined;

	/** Whether `jj` is on PATH and the repo root was found. */
	private jjAvailable = false;

	/** Absolute path to the session workspace directory. Set after workspace creation. */
	private workspacePath: string | undefined;

	/** The session ID derived from the Pi session manager. */
	private sessionId: string | undefined;

	/**
	 * Effective session key used for workspace names and bookmarks.
	 * Equals `sessionId` normally; gets a numeric suffix when another session
	 * already holds `sillajje-<sessionId>` (session-ID collision guard).
	 */
	private sessionKey: string | undefined;

	/**
	 * Whether the session's workspace is missing: the directory was deleted
	 * externally, or `jj` disappeared from PATH mid-session. A session with a
	 * missing workspace no-ops like an inactive one but keeps prompting
	 * notifications.
	 */
	private missingWorkspace = false;

	/** Whether the user has sent at least one prompt in this session. */
	private hasPrompted = false;

	/**
	 * The id of the last Stamp marker on the current branch, or null for a
	 * fresh session. Everything after it is the next Interaction.
	 */
	private cursorId: string | null = null;

	// ---------------------------------------------------------------------------
	// Getters
	// ---------------------------------------------------------------------------

	isInactive(): boolean {
		return this.lifecycle === "inactive";
	}

	isActive(): boolean {
		return this.lifecycle === "active";
	}

	isArchived(): boolean {
		return this.lifecycle === "archived";
	}

	getLifecycle(): SessionLifecycle {
		return this.lifecycle;
	}

	getRepoRoot(): string | undefined {
		return this.repoRoot;
	}

	getWorkspacePath(): string | undefined {
		return this.workspacePath;
	}

	getSessionId(): string | undefined {
		return this.sessionId;
	}

	/** Effective session key (falls back to the raw session ID). */
	getSessionKey(): string | undefined {
		return this.sessionKey ?? this.sessionId;
	}

	isMissingWorkspace(): boolean {
		return this.missingWorkspace;
	}

	isJjAvailable(): boolean {
		return this.jjAvailable;
	}

	hasUserPrompted(): boolean {
		return this.hasPrompted;
	}

	getCursorId(): string | null {
		return this.cursorId;
	}

	// ---------------------------------------------------------------------------
	// Setters / transitions
	// ---------------------------------------------------------------------------

	/**
	 * Record the result of jj detection from `session_start`.
	 * When jj is absent or no repo root found, lifecycle stays "inactive".
	 */
	setDetection(jjAvailable: boolean, repoRoot?: string): void {
		this.jjAvailable = jjAvailable;
		this.repoRoot = repoRoot;

		if (jjAvailable && repoRoot) {
			this.lifecycle = "active";
		} else {
			this.lifecycle = "inactive";
		}
	}

	setSessionId(id: string): void {
		this.sessionId = id;
	}

	setSessionKey(key: string | undefined): void {
		this.sessionKey = key;
	}

	/** Mark the session's workspace as missing. */
	markMissingWorkspace(): void {
		this.missingWorkspace = true;
	}

	/**
	 * Clear the missing-workspace flag. A successful unarchive rebuilds the
	 * workspace, so the session is usable again.
	 */
	clearMissingWorkspace(): void {
		this.missingWorkspace = false;
	}

	setWorkspacePath(path: string): void {
		this.workspacePath = path;
	}

	clearWorkspacePath(): void {
		this.workspacePath = undefined;
	}

	setArchived(): void {
		this.lifecycle = "archived";
	}

	setActive(): void {
		this.lifecycle = "active";
	}

	setInactive(): void {
		this.lifecycle = "inactive";
	}

	markPrompted(): void {
		this.hasPrompted = true;
	}

	setCursorId(id: string | null): void {
		this.cursorId = id;
	}

	reset(): void {
		this.lifecycle = "inactive";
		this.repoRoot = undefined;
		this.jjAvailable = false;
		this.workspacePath = undefined;
		this.sessionId = undefined;
		this.sessionKey = undefined;
		this.missingWorkspace = false;
		this.hasPrompted = false;
		this.cursorId = null;
	}
}
