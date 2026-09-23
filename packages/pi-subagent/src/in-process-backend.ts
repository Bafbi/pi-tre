import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	type AgentSessionEvent,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	type ResourceLoader,
	resolveCliModel,
	SessionManager,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
	type AssistantMessageInfo,
	emitAssistantMessage,
} from "./assistant-message.js";
import { createPushStream, type PushStream } from "./push-stream.js";
import type {
	SubagentBackend,
	SubagentEvent,
	SubagentSession,
	SubagentTask,
	SubagentUsage,
} from "./types.js";
import { zeroUsage } from "./types.js";

/** Session start reason reported to extensions loaded into the child. */
const DEFAULT_SESSION_START_EVENT: SessionStartEvent = {
	type: "session_start",
	reason: "new",
};

/**
 * Grace between the timeout deadline and force-finishing a child that
 * ignores the cooperative abort.
 */
const TIMEOUT_ABORT_GRACE_MS = 1_000;

export interface InProcessBackendOptions {
	/**
	 * Model runtime override for tests. By default the backend builds its
	 * own runtime with auth resolved from the agent directory, so callers
	 * need no runtime wiring.
	 */
	modelRuntime?: ModelRuntime;
	/** Returns the parent model to inherit when the task carries none. */
	onModel?: () => Model<Api> | undefined;
	/** Returns the parent thinking level to inherit when the task carries none. */
	onThinkingLevel?: () => ThinkingLevel | undefined;
	/** Session factory override for tests. Default: the SDK's `createAgentSession`. */
	createSession?: (
		options?: CreateAgentSessionOptions,
	) => Promise<CreateAgentSessionResult>;
	/**
	 * Resource-loader override for tests. Default: a
	 * `DefaultResourceLoader` that appends the task's `systemPrompt`.
	 */
	createResourceLoader?: (options: {
		cwd: string;
		agentDir: string;
		appendSystemPrompt: string[];
	}) => Promise<ResourceLoader> | ResourceLoader;
}

/** Build the default resource loader, appending the task's system prompt. */
async function defaultCreateResourceLoader(options: {
	cwd: string;
	agentDir: string;
	appendSystemPrompt: string[];
}): Promise<ResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		appendSystemPrompt: options.appendSystemPrompt,
	});
	await loader.reload();
	return loader;
}

type MessageLike = AssistantMessageInfo & { role: string };

/**
 * A backend that runs the subagent in this process through the pi SDK.
 *
 * Each call gets a fresh in-memory session, so no conversation history
 * leaks between the parent and its subagents or between subagents. The
 * task's tool allowlist and `excludeTools` denylist are passed to the
 * session; put the spawning extension's own tool names into
 * `excludeTools` so the child cannot recurse into them. The parent's
 * model and thinking level are inherited through the `onModel` and
 * `onThinkingLevel` callbacks when the task carries none. A task
 * `systemPrompt` is appended to the child's system prompt through a
 * resource loader, matching the process backend's
 * `--append-system-prompt`.
 *
 * Abort is cooperative: `abort()`, `signal`, and the timeout deadline
 * call `session.abort()` and wait for the agent to settle. The deadline
 * reports `timedOut` when the run outlasts `timeoutMs`; if the child
 * ignores the cooperative abort, the run is finished after the grace
 * period anyway.
 */
export function createInProcessBackend(
	options?: InProcessBackendOptions,
): SubagentBackend {
	const agentDir = getAgentDir();
	const createSession = options?.createSession ?? createAgentSession;
	const createResourceLoader =
		options?.createResourceLoader ?? defaultCreateResourceLoader;

	// The runtime is always required, so the backend owns it: built once,
	// lazily, from the agent directory's auth.json and models.json.
	let runtimePromise: Promise<ModelRuntime> | undefined;
	const getRuntime = () => {
		runtimePromise ??= options?.modelRuntime
			? Promise.resolve(options.modelRuntime)
			: ModelRuntime.create({
					authPath: join(agentDir, "auth.json"),
					allowModelNetwork: false,
				});
		return runtimePromise;
	};

	return {
		run(task: SubagentTask): SubagentSession {
			const push = createPushStream<SubagentEvent>();

			const usage: SubagentUsage = zeroUsage();
			let resolveUsage: (u: SubagentUsage) => void = () => {};
			const usagePromise = new Promise<SubagentUsage>((resolve) => {
				resolveUsage = resolve;
			});

			let removeSignalListener = () => {};
			let finished = false;
			let timedOut = false;
			let aborted = false;
			let childSession: AgentSession | undefined;

			const session: SubagentSession = {
				events: push.stream,
				usage: () => usagePromise,
				abort: () => {
					requestAbort();
					return runPromise.then(() => {});
				},
			};

			// Match the process backend's exit contract: -1 when the run timed out,
			// 1 for a spawn/session error, 0 otherwise.
			const finish = (exitCode = timedOut ? -1 : 0): void => {
				if (finished) return;
				finished = true;
				clearTimeout(deadlineTimer);
				clearTimeout(abortGraceTimer);
				removeSignalListener();
				// Disconnect extensions and listeners before the stream closes.
				childSession?.dispose();
				push.push({
					type: "exit",
					code: exitCode,
					timedOut,
					aborted,
					overflow: false,
					stderr: "",
				});
				push.close();
				resolveUsage({ ...usage });
			};

			// Abort is cooperative once a session exists. During initialization
			// there is nothing to abort yet, so end the run now; a session that
			// resolves later is disposed by the `finished` check.
			const requestAbort = (): void => {
				if (aborted || finished) return;
				aborted = true;
				if (childSession) {
					void childSession.abort();
					return;
				}
				finish(0);
			};

			// Wall-clock deadline: `timeoutMs` bounds the whole turn, not
			// periods of silence. At the deadline the child is aborted
			// cooperatively; if it has not settled within the grace period,
			// the run ends anyway, so a hung turn cannot swallow the
			// `timedOut` report.
			const timeoutMs = task.timeoutMs;
			let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
			let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
			if (timeoutMs !== undefined) {
				deadlineTimer = setTimeout(() => {
					if (finished) return;
					timedOut = true;
					void childSession?.abort();
					abortGraceTimer = setTimeout(() => {
						if (!finished) finish();
					}, TIMEOUT_ABORT_GRACE_MS);
				}, timeoutMs);
			}

			// Installed before the initialization awaits so an abort cannot be
			// missed while the model runtime, resource loader, or session is
			// being built.
			if (task.signal) {
				if (task.signal.aborted) {
					requestAbort();
				} else {
					task.signal.addEventListener("abort", requestAbort, {
						once: true,
					});
					removeSignalListener = () =>
						task.signal?.removeEventListener("abort", requestAbort);
				}
			}

			const runPromise = (async (): Promise<void> => {
				try {
					const runtime = await getRuntime();

					const { model, thinkingLevel: resolvedThinkingLevel } =
						await resolveModel(task, runtime, options);
					// Precedence: an explicit task level wins, then the level
					// parsed from the task's model string, then the inherited
					// parent level. Parent defaults apply only when the task
					// carries none.
					const thinkingLevel =
						task.thinkingLevel ??
						resolvedThinkingLevel ??
						options?.onThinkingLevel?.();

					// The process backend appends `systemPrompt` via
					// `--append-system-prompt`; the in-process equivalent is a
					// resource loader with `appendSystemPrompt`.
					const resourceLoader = task.systemPrompt
						? await createResourceLoader({
								cwd: task.cwd,
								agentDir,
								appendSystemPrompt: [task.systemPrompt],
							})
						: undefined;

					// An abort during initialization already ended the run; do not
					// build a session just to dispose it.
					if (finished) return;

					const sessionOptions: CreateAgentSessionOptions = {
						cwd: task.cwd,
						agentDir,
						modelRuntime: runtime,
						sessionManager: SessionManager.inMemory(),
						sessionStartEvent: DEFAULT_SESSION_START_EVENT,
					};
					if (model !== undefined) sessionOptions.model = model;
					if (thinkingLevel !== undefined) {
						sessionOptions.thinkingLevel = thinkingLevel;
					}
					if (task.tools !== undefined)
						sessionOptions.tools = task.tools;
					if (task.excludeTools !== undefined) {
						sessionOptions.excludeTools = task.excludeTools;
					}
					if (resourceLoader !== undefined) {
						sessionOptions.resourceLoader = resourceLoader;
					}
					const { session: child } =
						await createSession(sessionOptions);
					childSession = child;

					// The deadline's abort grace elapsed while the session was still
					// being created. `finish()` already ran and closed the stream, so
					// dispose this late session here instead of leaking it.
					if (finished) {
						child.dispose();
						return;
					}

					child.subscribe((event) => {
						handleSessionEvent(event, push, usage);
					});

					// The watchdog or an external abort fired while the session
					// was being created; nothing to run.
					if (timedOut || aborted) {
						finish();
						return;
					}

					try {
						await child.prompt(task.prompt);
					} catch (err) {
						push.push({
							type: "error",
							message:
								err instanceof Error
									? err.message
									: String(err),
						});
						// A prompt failure is a session error (code 1); keep the
						// timeout (-1) and abort (0) semantics.
						finish(timedOut ? -1 : aborted ? 0 : 1);
						return;
					}

					finish();
				} catch (err) {
					push.push({
						type: "error",
						message:
							err instanceof Error ? err.message : String(err),
					});
					// One exit path: finish() reports the error as a code-1 exit
					// and still disposes the child session.
					finish(1);
				}
			})();

			return session;
		},
	};
}

/** Map one AgentSession event onto the subagent event stream. */
function handleSessionEvent(
	event: AgentSessionEvent,
	push: PushStream<SubagentEvent>,
	usage: SubagentUsage,
): void {
	const e = event as {
		type: string;
		assistantMessageEvent?: { type: string; delta?: string };
		message?: MessageLike;
	};

	if (
		e.type === "message_update" &&
		e.assistantMessageEvent &&
		typeof e.assistantMessageEvent.type === "string"
	) {
		const ame = e.assistantMessageEvent;
		if (ame.type === "text_delta" && typeof ame.delta === "string") {
			push.push({ type: "text", text: ame.delta, kind: "delta" });
		} else if (
			ame.type === "thinking_delta" &&
			typeof ame.delta === "string"
		) {
			push.push({ type: "thinking", text: ame.delta, kind: "delta" });
		}
	}

	if (e.type === "message_end" && e.message?.role === "assistant") {
		const msg = e.message;
		emitAssistantMessage(
			{
				content: Array.isArray(msg.content) ? msg.content : [],
				usage: msg.usage,
				stopReason: msg.stopReason,
				errorMessage: msg.errorMessage,
			},
			(event) => push.push(event),
			usage,
		);
	}
}

/** A resolved model plus a thinking level parsed from a CLI string. */
interface ResolvedModel {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
}

async function resolveModel(
	task: SubagentTask,
	runtime: ModelRuntime,
	options?: InProcessBackendOptions,
): Promise<ResolvedModel> {
	const model = task.model ?? options?.onModel?.();
	if (model === undefined) {
		return { model: undefined, thinkingLevel: undefined };
	}
	if (typeof model !== "string") {
		return { model, thinkingLevel: undefined };
	}
	const {
		model: resolved,
		thinkingLevel,
		error,
	} = resolveCliModel({
		cliModel: model,
		modelRuntime: runtime,
	});
	if (error || !resolved) {
		throw new Error(`Unknown model "${model}"${error ? `: ${error}` : ""}`);
	}
	return { model: resolved, thinkingLevel };
}
