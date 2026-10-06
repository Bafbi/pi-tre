/**
 * Unit tests for the Record write seam — the start/terminal pair and the
 * throw path.
 *
 * The seam is a pure function over a Record sink, so these tests pin its
 * contract without a session or jj.
 */

import { describe, expect, it } from "vitest";
import { recordOperation, type SillajjeRecord } from "../../src/record.js";

function collecting(): {
	sink: (record: SillajjeRecord) => void;
	records: SillajjeRecord[];
} {
	const records: SillajjeRecord[] = [];
	return { sink: (record) => records.push(record), records };
}

describe("recordOperation", () => {
	it("writes a start Record then the terminal Record", async () => {
		const { sink, records } = collecting();

		const result = await recordOperation(sink, "guard", {
			fields: { session: "s1" },
			run: async () => ({ ok: true as const }),
			settle: () => ({ stage: "done", result: { status: "created" } }),
		});

		expect(result).toEqual({ ok: true });
		expect(records.map((r) => r.stage)).toEqual(["start", "done"]);
		expect(records[0]).toMatchObject({
			v: 1,
			operation: "guard",
			stage: "start",
			session: "s1",
		});
		expect(records[1]).toMatchObject({
			operation: "guard",
			stage: "done",
			session: "s1",
			result: { status: "created" },
		});
	});

	it("writes a failed Record and rethrows when the run throws", async () => {
		const { sink, records } = collecting();

		await expect(
			recordOperation(sink, "guard", {
				fields: { session: "s1" },
				run: async () => {
					throw new Error("jj exploded");
				},
				settle: () => ({ stage: "done" }),
			}),
		).rejects.toThrow("jj exploded");

		expect(records.map((r) => r.stage)).toEqual(["start", "failed"]);
		expect(records[1]?.error).toEqual({ message: "jj exploded" });
	});
});
