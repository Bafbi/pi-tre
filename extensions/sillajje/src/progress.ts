/**
 * Progress — the adapter's live rendering of a running Action.
 *
 * The renderer turns the Status events the core streams into a widget above
 * the editor. An Action announces its steps first (`plan`); the renderer draws
 * every one of them as pending, so a slow first step never leaves the user
 * without feedback. Each `phase` marks the planned step running and closes the
 * steps before it, and a failure freezes the step it broke on. A phase that the
 * plan did not list is appended, so a drifting plan still renders.
 *
 * A new run clears the stale widget; a successful run clears its own. A run
 * that finishes before the delay never draws, so an instant command shows
 * nothing while a slow one does. The core never sees this module.
 */

import type { PhaseCode, StatusEvent } from "@pi-tre/sillajje-core";

/** Writes one widget's lines, or clears it with `undefined`. */
export type SetWidget = (key: string, lines: string[] | undefined) => void;

/** The widget key Progress owns; distinct from the pill and serve keys. */
export const PROGRESS_WIDGET_KEY = "sillajje-action";

/** How long a run may stay quiet before the widget draws. */
export const DEFAULT_PROGRESS_DELAY_MS = 250;

/** Renderer tuning. */
export interface ProgressOptions {
	/** Milliseconds before the widget draws; 0 draws at once. */
	delayMs?: number;
}

type StepState = "pending" | "running" | "done" | "skipped" | "failed";

/** A core phase code, plus the steps the adapter authors for `new`. */
type ProgressCode =
	| PhaseCode
	| "creating-workspace"
	| "seeding"
	| "running-post-init";

interface Step {
	code: ProgressCode;
	/** Known only once the step's phase arrives; a planned step has none. */
	target?: string;
	state: StepState;
}

const MARKER: Record<StepState, string> = {
	pending: "○",
	running: "●",
	done: "✓",
	skipped: "–",
	failed: "✗",
};

/**
 * The code-to-phrase table. The core owns the codes; the adapter owns the
 * words, so copy changes never touch core tests.
 */
const PHRASES: Record<ProgressCode, (target: string | undefined) => string> = {
	archiving: (target) => (target ? `archiving ${target}` : "archiving"),
	unarchiving: (target) => (target ? `unarchiving ${target}` : "unarchiving"),
	folding: (target) => (target ? `folding onto ${target}` : "folding"),
	pushing: (target) => (target ? `pushing ${target}` : "pushing"),
	rebasing: (target) => (target ? `rebasing onto ${target}` : "rebasing"),
	"collecting-diff": () => "collecting diff",
	checking: (target) => (target ? `checking ${target}` : "checking"),
	"generating-header": () => "generating header",
	"sealing-change": (target) => (target ? `sealing ${target}` : "sealing"),
	"resolving-source": () => "resolving source",
	"creating-workspace": () => "creating workspace",
	seeding: () => "seeding",
	"running-post-init": () => "running post-init",
};

/** Render the accumulated steps as widget lines. */
function renderLines(steps: readonly Step[]): string[] {
	return steps.map(
		(step) => `${MARKER[step.state]} ${PHRASES[step.code](step.target)}`,
	);
}

/** The renderer handle a command holds for the life of one Action. */
export interface Progress {
	/** Feed a Status event. `plan` seeds the steps; `phase` advances them. */
	onStatus: (event: StatusEvent) => void;
	/** Seed the steps. The core sends this; the adapter sends it for `new`. */
	plan: (codes: readonly ProgressCode[]) => void;
	/** Advance to an adapter-authored step the core never emits. */
	step: (code: ProgressCode, target?: string) => void;
	/**
	 * Mark the running step skipped when it fails without ending the run, so a
	 * non-fatal failure never renders as done.
	 */
	skip: () => void;
	/** Freeze the current step on a failure the core did not emit as `error`. */
	fail: () => void;
	/** Finish the run: clear the widget unless a step froze. */
	end: () => void;
}

/**
 * Create a renderer over a widget sink. Without a sink (no UI) every call is
 * a no-op. Creation clears the widget so a frozen run does not outlive its
 * command; the draw waits `delayMs` so an instant run never draws. A failure
 * draws at once.
 */
export function createProgress(
	setWidget: SetWidget | undefined,
	options?: ProgressOptions,
): Progress {
	const delayMs = options?.delayMs ?? DEFAULT_PROGRESS_DELAY_MS;
	let steps: Step[] = [];
	/** Index of the running step, or -1 before the run advances. */
	let cursor = -1;
	let frozen = false;
	let visible = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const write = (): void => {
		if (setWidget === undefined) return;
		setWidget(
			PROGRESS_WIDGET_KEY,
			steps.length === 0 ? undefined : renderLines(steps),
		);
	};

	const show = (): void => {
		visible = true;
		write();
	};

	const cancelTimer = (): void => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
	};

	/** Draw now when visible, else arm the delay once. */
	const schedule = (): void => {
		if (visible) {
			write();
		} else if (delayMs <= 0) {
			show();
		} else if (timer === undefined) {
			timer = setTimeout(() => {
				timer = undefined;
				if (!frozen) show();
			}, delayMs);
		}
	};

	// Clear a stale widget from a previous run at the start of this one.
	write();

	const seed = (codes: readonly ProgressCode[]): void => {
		if (frozen) return;
		// A plan names the steps that have not run yet. Once one has, the widget
		// reflects real work and a late plan would erase it.
		if (cursor >= 0) return;
		steps = codes.map((code) => ({ code, state: "pending" }));
		cursor = -1;
		schedule();
	};

	const advance = (code: ProgressCode, target: string | undefined): void => {
		if (frozen) return;
		// The plan lists the run's steps, so the matching step is at or after
		// the cursor. A code the plan omitted is appended instead of dropped.
		let index = -1;
		for (let i = cursor + 1; i < steps.length; i += 1) {
			if (steps[i]?.code === code) {
				index = i;
				break;
			}
		}
		if (index === -1) {
			const next: Step = { code, state: "running" };
			if (target !== undefined) next.target = target;
			steps.push(next);
			index = steps.length - 1;
		} else {
			const step = steps[index];
			if (step !== undefined) {
				// A planned step has no target: the phase is where it becomes
				// known.
				if (target !== undefined) step.target = target;
				step.state = "running";
			}
		}
		// The step that was running has finished; the ones still pending never ran
		// and are marked skipped, never done: the widget must not claim work that
		// did not happen. The cursor still moves past them.
		for (let i = 0; i < index; i += 1) {
			const step = steps[i];
			if (step === undefined) continue;
			if (step.state === "running") step.state = "done";
			else if (step.state === "pending") step.state = "skipped";
		}
		cursor = index;
		schedule();
	};

	const skip = (): void => {
		if (frozen) return;
		const current = steps.find((step) => step.state === "running");
		if (current !== undefined) current.state = "skipped";
		schedule();
	};

	const freeze = (): void => {
		if (frozen) return;
		cancelTimer();
		// The step that broke is the running one, or the first still pending
		// when the failure lands before its phase.
		const broken =
			steps.find((step) => step.state === "running") ??
			steps.find((step) => step.state === "pending");
		if (broken !== undefined) broken.state = "failed";
		frozen = true;
		show();
	};

	return {
		onStatus(event) {
			if (event.kind === "plan") {
				seed(event.codes);
			} else if (event.kind === "phase") {
				advance(event.code, event.target);
			} else if (event.kind === "error") {
				freeze();
			}
		},
		plan: seed,
		step: advance,
		skip,
		fail: freeze,
		end() {
			cancelTimer();
			steps = [];
			cursor = -1;
			if (frozen) {
				// Keep the frozen widget until the next run clears it.
				frozen = false;
				return;
			}
			if (visible) {
				visible = false;
				write();
			}
		},
	};
}
