/**
 * Progress — the adapter's live rendering of a running Action.
 *
 * The renderer turns the Status events the core streams into a widget above
 * the editor. It accumulates the run's steps, marks the finished ones, and
 * freezes on the step that failed. A new run clears the stale widget; a
 * successful run clears its own. A run that finishes before the delay never
 * draws, so an instant command shows nothing while a slow one does. The core
 * never sees this module.
 */

import type { PhaseCode, StatusEvent } from "@pi-tre/sillajje-core";

/** Writes one widget's lines, or clears it with `undefined`. */
export type SetWidget = (key: string, lines: string[] | undefined) => void;

/** The widget key Progress owns; distinct from the pill and serve keys. */
export const PROGRESS_WIDGET_KEY = "sillajje-action";

/** How long a run may stay quiet before the first step draws. */
export const DEFAULT_PROGRESS_DELAY_MS = 250;

/** Renderer tuning. */
export interface ProgressOptions {
	/** Milliseconds before the first running step draws; 0 draws at once. */
	delayMs?: number;
}

type StepState = "running" | "done" | "failed";

/** A core phase code, plus the two steps the adapter authors for `new`. */
type ProgressCode = PhaseCode | "creating-workspace" | "running-post-init";

interface Step {
	code: ProgressCode;
	target?: string;
	state: StepState;
}

const MARKER: Record<StepState, string> = {
	running: "●",
	done: "✓",
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
	"generating-header": () => "generating header",
	"sealing-change": (target) => (target ? `sealing ${target}` : "sealing"),
	"creating-workspace": () => "creating workspace",
	"running-post-init": () => "running post-init",
};

function phaseLabel(code: ProgressCode, target: string | undefined): string {
	return PHRASES[code](target);
}

/** Render the accumulated steps as widget lines. */
function renderLines(steps: readonly Step[]): string[] {
	return steps.map(
		(step) => `${MARKER[step.state]} ${phaseLabel(step.code, step.target)}`,
	);
}

/** The renderer handle a command holds for the life of one Action. */
export interface Progress {
	/** Feed a Status event. `phase` advances; `error` freezes. */
	onStatus: (event: StatusEvent) => void;
	/** Advance to an adapter-authored step the core never emits. */
	step: (code: ProgressCode, target?: string) => void;
	/** Freeze the running step on a failure the core did not emit as `error`. */
	fail: () => void;
	/** Finish the run: clear the widget unless a step froze. */
	end: () => void;
}

/**
 * Create a renderer over a widget sink. Without a sink (no UI) every call is
 * a no-op. Creation clears the widget so a frozen run does not outlive its
 * command; the first running step waits `delayMs` so an instant run never
 * draws. A failure draws at once.
 */
export function createProgress(
	setWidget: SetWidget | undefined,
	options?: ProgressOptions,
): Progress {
	const delayMs = options?.delayMs ?? DEFAULT_PROGRESS_DELAY_MS;
	let steps: Step[] = [];
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

	// Clear a stale widget from a previous run at the start of this one.
	write();

	const freeze = (): void => {
		if (frozen) return;
		cancelTimer();
		const current = steps.at(-1);
		if (current?.state === "running") current.state = "failed";
		frozen = true;
		show();
	};

	const pushStep = (code: ProgressCode, target: string | undefined): void => {
		if (frozen) return;
		const current = steps.at(-1);
		if (current?.state === "running") current.state = "done";
		steps.push(
			target === undefined
				? { code, state: "running" }
				: { code, target, state: "running" },
		);
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

	return {
		onStatus(event) {
			if (event.kind === "phase") {
				pushStep(event.code, event.target);
			} else if (event.kind === "error") {
				freeze();
			}
		},
		step: pushStep,
		fail: freeze,
		end() {
			cancelTimer();
			steps = [];
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
