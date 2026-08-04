import type { Message } from "@earendil-works/pi-ai";

/** Lifecycle state of a sillajje session. */
export type SessionLifecycle = "inactive" | "active" | "archived";

/**
 * In-memory session state.
 *
 * Tracks jj availability, repo root, workspace path, lifecycle,
 * and per-interaction data for change stamping.
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
	 * Whether the session was marked stale: the workspace directory was
	 * deleted externally or `jj` disappeared from PATH mid-session. Stale
	 * sessions no-op like inactive ones but keep prompting notifications.
	 */
	private stale = false;

	/** Whether the user has sent at least one prompt in this session. */
	private hasPrompted = false;

	/**
	 * Whether the current interaction ended with an error terminal `agent_end`
	 * and is awaiting finalization.
	 *
	 * Pi can emit `agent_end` mid-interaction: when a run ends in an error
	 * (stopReason "error" — timeout, 5xx, rate limit...), it auto-retries via
	 * `agent.continue()`, firing `agent_start` again. Stamping on that first
	 * (error) `agent_end` would seal a partial interaction and reset state, so
	 * the true final `agent_end` would skip stamping entirely. Instead the
	 * interaction is marked pending and finalized lazily: the continuation's
	 * `agent_start` clears it, otherwise the next `input` or `session_shutdown`
	 * stamps it.
	 */
	private pendingFinalize = false;

	// ---------------------------------------------------------------------------
	// Interaction tracking (per-interaction, reset after each stamp)
	// ---------------------------------------------------------------------------

	private newInteraction = false;

	/**
	 * Transcript messages accumulated from agent_end events.
	 * The stamp module derives prompt, response, tools, thinking, and elapsed
	 * from these messages.
	 */
	private messages: Message[] = [];

	/**
	 * Whether the last agent_end ended in an error (stopReason "error").
	 * Set by recordAgentEndError so deferred-finalize logic can branch on it
	 * without re-inspecting messages.
	 */
	private lastRunEndedInError = false;

	/** Tracks the streamingBehavior from the last `input` event. Used in `before_agent_start` to detect new interactions for queued follow-ups that may bypass `input`. */
	private lastStreamingBehavior: string | undefined = undefined;

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

	isStale(): boolean {
		return this.stale;
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

	setSessionKey(key: string | undefined): void {
		this.sessionKey = key;
	}

	/** Mark the session stale (workspace deleted or jj disappeared). */
	markStale(): void {
		this.stale = true;
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

	reset(): void {
		this.lifecycle = "inactive";
		this.repoRoot = undefined;
		this.jjAvailable = false;
		this.workspacePath = undefined;
		this.sessionId = undefined;
		this.sessionKey = undefined;
		this.stale = false;
		this.hasPrompted = false;
		this.resetInteraction();
	}

	// ---------------------------------------------------------------------------
	// Interaction tracking — getters & recorders
	// ---------------------------------------------------------------------------

	/**
	 * Mark whether a new interaction has begun, based on the `input` event.
	 * `steer` deliveries fold into the current interaction; everything else starts a new one.
	 *
	 * Also stores the streaming behavior so `before_agent_start` can use it
	 * for queued follow-ups that may bypass the `input` event.
	 */
	startInteraction(streamingBehavior: string | undefined): void {
		this.lastStreamingBehavior = streamingBehavior;
		if (streamingBehavior !== "steer") {
			this.newInteraction = true;
		}
		// steering: keep newInteraction false (fold into current interaction)
	}

	hasNewInteraction(): boolean {
		return this.newInteraction;
	}

	/** Whether the interaction ended with an error and awaits finalization. */
	hasPendingFinalize(): boolean {
		return this.pendingFinalize;
	}

	/** Mark the current interaction as ended-in-error, awaiting finalization. */
	markPendingFinalize(): void {
		this.pendingFinalize = true;
	}

	/**
	 * Clear the pending-finalize flag — called when a continuation
	 * (`agent_start` after a retry/compact) proves the interaction is still live.
	 */
	clearPendingFinalize(): void {
		this.pendingFinalize = false;
		this.lastRunEndedInError = false;
	}

	/**
	 * Called from `before_agent_start` as a fallback for when the `input` event
	 * didn't fire (e.g. queued follow-ups). Uses the last known streaming behavior.
	 */
	enableInteractionIfNotSteering(): void {
		if (this.lastStreamingBehavior !== "steer") {
			this.newInteraction = true;
		}
	}

	/**
	 * Record messages from an agent_end event. Messages accumulate across retry
	 * segments so the full transcript is available at stamp time.
	 */
	recordAgentMessages(msgs: Message[]): void {
		this.messages.push(...msgs);
	}

	/**
	 * Record that the last agent run ended in an error.
	 * Used by deferred-finalize logic.
	 */
	recordAgentEndError(): void {
		this.lastRunEndedInError = true;
	}

	/**
	 * Whether the last agent run ended in an error (stopReason "error").
	 */
	lastAgentRunWasError(): boolean {
		return this.lastRunEndedInError;
	}

	/**
	 * Return the accumulated transcript messages for the current interaction.
	 * Returns undefined when there is no new interaction or no messages.
	 */
	getInteractionMessages(): Message[] | undefined {
		if (!this.newInteraction || this.messages.length === 0)
			return undefined;
		return [...this.messages];
	}

	/** Reset per-interaction state. Called after each stamp. */
	resetInteraction(): void {
		this.newInteraction = false;
		this.messages = [];
		this.lastStreamingBehavior = undefined;
		this.pendingFinalize = false;
		this.lastRunEndedInError = false;
	}
}
