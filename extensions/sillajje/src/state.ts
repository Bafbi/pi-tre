import type { InteractionMeta } from "./metadata.js";

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

	/** Whether the user has sent at least one prompt in this session. */
	private hasPrompted = false;

	// ---------------------------------------------------------------------------
	// Interaction tracking (per-interaction, reset after each stamp)
	// ---------------------------------------------------------------------------

	private newInteraction = false;
	private prompt: string | undefined;
	private toolCallCount = 0;
	private toolNamesSet: Set<string> = new Set();
	private thinkingBlocks = 0;
	private agentStartAt = 0;
	private response: string | undefined;
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

	/**
	 * Called from `before_agent_start` as a fallback for when the `input` event
	 * didn't fire (e.g. queued follow-ups). Uses the last known streaming behavior.
	 */
	enableInteractionIfNotSteering(): void {
		if (this.lastStreamingBehavior !== "steer") {
			this.newInteraction = true;
		}
	}

	recordPrompt(text: string): void {
		this.prompt = text;
	}

	getInteractionPrompt(): string | undefined {
		return this.prompt;
	}

	markAgentStart(): void {
		this.agentStartAt = Date.now();
	}

	getInteractionElapsedMs(): number {
		if (this.agentStartAt === 0) return 0;
		return Date.now() - this.agentStartAt;
	}

	recordToolCall(toolName: string): void {
		this.toolCallCount++;
		this.toolNamesSet.add(toolName);
	}

	recordThinkingBlock(): void {
		this.thinkingBlocks++;
	}

	recordAgentResponse(text: string): void {
		this.response = text;
	}

	getInteractionResponse(): string | undefined {
		return this.response;
	}

	/**
	 * Return a snapshot of the current interaction data for metadata building.
	 * Returns undefined when there is no new interaction to stamp or the prompt is missing.
	 */
	getInteractionData(sessionId: string): InteractionMeta | undefined {
		if (!this.newInteraction || !this.prompt) return undefined;

		return {
			toolNames: [...this.toolNamesSet],
			toolCallCount: this.toolCallCount,
			elapsedMs: this.getInteractionElapsedMs(),
			thinkingBlocks: this.thinkingBlocks,
			sessionId,
		};
	}

	/** Reset per-interaction counters. Called after each stamp. */
	resetInteraction(): void {
		this.newInteraction = false;
		this.prompt = undefined;
		this.toolCallCount = 0;
		this.toolNamesSet = new Set();
		this.thinkingBlocks = 0;
		this.agentStartAt = 0;
		this.response = undefined;
		this.lastStreamingBehavior = undefined;
	}
}
