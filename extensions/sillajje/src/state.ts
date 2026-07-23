/** Lifecycle state of a sillajje session. */
export type SessionLifecycle = "inactive" | "active" | "archived";

/**
 * In-memory session state.
 *
 * Tracks jj availability, repo root, workspace path, and lifecycle.
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

	/** Whether the user has sent at least one prompt in this session. */
	private hasPrompted = false;

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

	isJjAvailable(): boolean {
		return this.jjAvailable;
	}

	hasUserPrompted(): boolean {
		return this.hasPrompted;
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

	setWorkspacePath(path: string): void {
		this.workspacePath = path;
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

	reset(): void {
		this.lifecycle = "inactive";
		this.repoRoot = undefined;
		this.jjAvailable = false;
		this.workspacePath = undefined;
		this.sessionId = undefined;
		this.hasPrompted = false;
	}
}
