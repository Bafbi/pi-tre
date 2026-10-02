/**
 * Progress's seam: drive the renderer with a fake widget sink and assert the
 * lines it writes. The widget is the only output; nothing here reaches into
 * the renderer's state.
 */

import { describe, expect, it } from "vitest";
import {
	createProgress,
	PROGRESS_WIDGET_KEY,
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

describe("createProgress", () => {
	it("clears any stale widget when the run starts", () => {
		const { setWidget, calls } = fakeWidget();

		createProgress(setWidget);

		expect(calls).toEqual([{ key: PROGRESS_WIDGET_KEY, lines: undefined }]);
	});

	it("renders a phase with its target", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = createProgress(setWidget);

		progress.onStatus({
			kind: "phase",
			code: "archiving",
			target: "s1",
		});

		expect(lastLines(calls)).toEqual(["● archiving s1"]);
	});

	it("renders a phase without a target", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = createProgress(setWidget);

		progress.onStatus({ kind: "phase", code: "collecting-diff" });

		expect(lastLines(calls)).toEqual(["● collecting diff"]);
	});

	it("advances an adapter-authored step", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = createProgress(setWidget);

		progress.step("creating-workspace");
		progress.step("running-post-init");

		expect(lastLines(calls)).toEqual([
			"✓ creating workspace",
			"● running post-init",
		]);
	});

	it("marks the previous step done when the next starts", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = createProgress(setWidget);

		progress.onStatus({ kind: "phase", code: "folding", target: "trunk" });
		progress.onStatus({ kind: "phase", code: "pushing", target: "review" });

		expect(lastLines(calls)).toEqual([
			"✓ folding onto trunk",
			"● pushing review",
		]);
	});

	it("freezes the running step when the run fails", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = createProgress(setWidget);

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
		const progress = createProgress(setWidget);

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
		const progress = createProgress(setWidget);

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
		const progress = createProgress(setWidget);

		progress.onStatus({ kind: "phase", code: "archiving", target: "s1" });
		progress.end();

		expect(lastLines(calls)).toBeUndefined();
	});

	it("ignores info and warning events", () => {
		const { setWidget, calls } = fakeWidget();
		const progress = createProgress(setWidget);
		const before = calls.length;

		progress.onStatus({ kind: "info", code: "note", message: "hi" });
		progress.onStatus({ kind: "warning", code: "warn", message: "hm" });

		expect(calls).toHaveLength(before);
	});

	it("no-ops without a widget sink", () => {
		const progress = createProgress(undefined);

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
