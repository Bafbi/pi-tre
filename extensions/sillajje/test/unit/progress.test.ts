/**
 * Progress's seam: drive the renderer with a fake widget sink and assert the
 * lines it writes. The widget is the only output; nothing here reaches into
 * the renderer's state.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createProgress,
	PROGRESS_WIDGET_KEY,
	type Progress,
	type SetWidget,
} from "../../src/progress.js";

interface WidgetCall {
	key: string;
	lines: string[] | undefined;
}

function fakeWidget(): { setWidget: SetWidget; calls: WidgetCall[] } {
	const calls: WidgetCall[] = [];
	return { setWidget: (key, lines) => calls.push({ key, lines }), calls };
}

/** The lines of the most recent widget write. */
function lastLines(calls: WidgetCall[]): string[] | undefined {
	return calls.at(-1)?.lines;
}

/** A renderer that draws at once, so a test need not advance a timer. */
function makeProgress(setWidget: SetWidget | undefined): Progress {
	return createProgress(setWidget, { delayMs: 0 });
}

afterEach(() => {
	vi.useRealTimers();
});

describe("createProgress", () => {
	it("clears any stale widget when the run starts", () => {
		const { setWidget, calls } = fakeWidget();

		makeProgress(setWidget);

		expect(calls).toEqual([{ key: PROGRESS_WIDGET_KEY, lines: undefined }]);
	});

	it("renders a phase with its target", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.onStatus({
			kind: "phase",
			code: "archiving",
			target: "s1",
		});

		expect(lastLines(calls)).toEqual(["● archiving s1"]);
	});

	it("renders a phase without a target", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.onStatus({ kind: "phase", code: "collecting-diff" });

		expect(lastLines(calls)).toEqual(["● collecting diff"]);
	});

	it("advances an adapter-authored step", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.step("creating-workspace");
		progress.step("running-post-init");

		expect(lastLines(calls)).toEqual([
			"✓ creating workspace",
			"● running post-init",
		]);
	});

	it("marks the previous step done when the next starts", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.onStatus({ kind: "phase", code: "folding", target: "trunk" });
		progress.onStatus({ kind: "phase", code: "pushing", target: "review" });

		expect(lastLines(calls)).toEqual([
			"✓ folding onto trunk",
			"● pushing review",
		]);
	});

	it("freezes the running step when the run fails", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.onStatus({ kind: "phase", code: "folding", target: "trunk" });
		progress.fail();
		const frozen = calls.length;

		expect(lastLines(calls)).toEqual(["✗ folding onto trunk"]);

		progress.end();

		expect(calls).toHaveLength(frozen);
		expect(lastLines(calls)).toEqual(["✗ folding onto trunk"]);
	});

	it("freezes the failed step and keeps it when the run ends", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.onStatus({ kind: "phase", code: "folding", target: "trunk" });
		progress.onStatus({
			kind: "error",
			code: "fold_failed",
			message: "boom",
		});
		const frozen = calls.length;

		expect(lastLines(calls)).toEqual(["✗ folding onto trunk"]);

		progress.end();

		expect(calls).toHaveLength(frozen);
		expect(lastLines(calls)).toEqual(["✗ folding onto trunk"]);
	});

	it("ignores further phases once frozen", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.onStatus({ kind: "phase", code: "folding", target: "trunk" });
		progress.onStatus({
			kind: "error",
			code: "fold_failed",
			message: "boom",
		});
		progress.onStatus({ kind: "phase", code: "pushing", target: "review" });

		expect(lastLines(calls)).toEqual(["✗ folding onto trunk"]);
	});

	it("clears the widget when the run ends on success", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.onStatus({ kind: "phase", code: "archiving", target: "s1" });
		progress.end();

		expect(lastLines(calls)).toBeUndefined();
	});

	it("ignores info and warning events", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);
		const before = calls.length;

		progress.onStatus({ kind: "info", code: "note", message: "hi" });
		progress.onStatus({ kind: "warning", code: "warn", message: "hm" });

		expect(calls).toHaveLength(before);
	});

	it("no-ops without a widget sink", () => {
		const progress = makeProgress(undefined);

		expect(() => {
			progress.onStatus({ kind: "phase", code: "archiving" });
			progress.onStatus({
				kind: "error",
				code: "archive_failed",
				message: "boom",
			});
			progress.end();
		}).not.toThrow();
	});
});

describe("createProgress delay", () => {
	it("clears a stale widget but waits before drawing the first step", () => {
		vi.useFakeTimers();
		const { setWidget, calls } = fakeWidget();
		const progress = createProgress(setWidget, { delayMs: 250 });

		progress.onStatus({ kind: "phase", code: "archiving", target: "s1" });
		expect(lastLines(calls)).toBeUndefined();

		vi.advanceTimersByTime(249);
		expect(lastLines(calls)).toBeUndefined();

		vi.advanceTimersByTime(1);
		expect(lastLines(calls)).toEqual(["● archiving s1"]);
	});

	it("draws every accumulated step once the delay passes", () => {
		vi.useFakeTimers();
		const { setWidget, calls } = fakeWidget();
		const progress = createProgress(setWidget, { delayMs: 250 });

		progress.onStatus({ kind: "phase", code: "folding", target: "trunk" });
		progress.onStatus({ kind: "phase", code: "pushing", target: "review" });
		expect(lastLines(calls)).toBeUndefined();

		vi.advanceTimersByTime(250);
		expect(lastLines(calls)).toEqual([
			"✓ folding onto trunk",
			"● pushing review",
		]);
	});

	it("draws a failure at once", () => {
		vi.useFakeTimers();
		const { setWidget, calls } = fakeWidget();
		const progress = createProgress(setWidget, { delayMs: 250 });

		progress.onStatus({ kind: "phase", code: "folding", target: "trunk" });
		progress.fail();

		expect(lastLines(calls)).toEqual(["✗ folding onto trunk"]);
	});

	it("never draws when the run ends before the delay", () => {
		vi.useFakeTimers();
		const { setWidget, calls } = fakeWidget();
		const progress = createProgress(setWidget, { delayMs: 250 });

		progress.onStatus({ kind: "phase", code: "archiving", target: "s1" });
		progress.end();

		vi.advanceTimersByTime(250);
		expect(calls).toHaveLength(1);
		expect(lastLines(calls)).toBeUndefined();
	});
});

describe("createProgress plan", () => {
	it("draws every announced step as pending", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.plan(["collecting-diff", "generating-header", "folding"]);

		expect(lastLines(calls)).toEqual([
			"○ collecting diff",
			"○ generating header",
			"○ folding",
		]);
	});

	it("advances the planned step its phase names", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.plan(["collecting-diff", "generating-header", "folding"]);
		progress.onStatus({ kind: "phase", code: "collecting-diff" });
		progress.onStatus({ kind: "phase", code: "generating-header" });

		expect(lastLines(calls)).toEqual([
			"✓ collecting diff",
			"● generating header",
			"○ folding",
		]);
	});

	it("fills a planned step's target when its phase arrives", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.plan(["folding"]);
		expect(lastLines(calls)).toEqual(["○ folding"]);

		progress.onStatus({ kind: "phase", code: "folding", target: "main" });

		expect(lastLines(calls)).toEqual(["● folding onto main"]);
	});

	it("marks the planned steps it passes over as skipped", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.plan(["folding", "pushing"]);
		progress.onStatus({ kind: "phase", code: "archiving", target: "s1" });

		expect(lastLines(calls)).toEqual([
			"– folding",
			"– pushing",
			"● archiving s1",
		]);
	});

	it("marks a planned step skipped when its condition resolves false", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.plan(["creating-workspace", "seeding", "running-post-init"]);
		progress.step("creating-workspace");
		progress.step("running-post-init");

		expect(lastLines(calls)).toEqual([
			"✓ creating workspace",
			"– seeding",
			"● running post-init",
		]);
	});

	it("appends every phase when no plan arrives", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.onStatus({ kind: "phase", code: "folding", target: "main" });
		progress.onStatus({ kind: "phase", code: "pushing", target: "review" });

		expect(lastLines(calls)).toEqual([
			"✓ folding onto main",
			"● pushing review",
		]);
	});

	it("matches an adapter-authored step against the plan", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.plan(["creating-workspace", "running-post-init"]);
		progress.step("running-post-init");

		// `creating-workspace` was planned and never stepped, so it is skipped.
		expect(lastLines(calls)).toEqual([
			"– creating workspace",
			"● running post-init",
		]);
	});

	it("freezes the first pending step when the failure lands before any phase", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.plan(["collecting-diff", "folding"]);
		progress.fail();

		expect(lastLines(calls)).toEqual(["✗ collecting diff", "○ folding"]);
	});

	it("ignores a plan that arrives after the run advanced", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.onStatus({ kind: "phase", code: "folding", target: "main" });
		const advanced = calls.length;
		progress.plan(["pushing"]);

		expect(calls).toHaveLength(advanced);
		expect(lastLines(calls)).toEqual(["● folding onto main"]);
	});

	it("draws the whole plan once the delay passes", () => {
		vi.useFakeTimers();
		const { setWidget, calls } = fakeWidget();
		const progress = createProgress(setWidget, { delayMs: 250 });

		progress.plan(["collecting-diff", "folding"]);
		expect(lastLines(calls)).toBeUndefined();

		vi.advanceTimersByTime(250);
		expect(lastLines(calls)).toEqual(["○ collecting diff", "○ folding"]);
	});

	it("clears the widget when a planned run ends on success", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = makeProgress(setWidget);

		progress.plan(["archiving"]);
		progress.onStatus({
			kind: "phase",
			code: "archiving",
			target: "s1",
		});
		progress.end();

		expect(lastLines(calls)).toBeUndefined();
	});
});
