/**
 * The core owns the config schema: its shape, its defaults, and its
 * validation. File loading, path resolution, merging, and the
 * `SILLAJJE_POST_INIT` override live in the adapter and `@pi-tre/pi-config`.
 */

import { homedir } from "node:os";
import { Check, Clean, Default } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
	defaultSillajjeConfig,
	type SillajjeConfig,
	SillajjeConfigSchema,
} from "../src/index.js";

const DEFAULT_STAMP_BODY = ["trace", "meta", "loop", "prompt", "response"];
const DEFAULT_LOOP = ["tools", "call_count", "elapsed", "thinking_blocks"];

/** Apply the schema's defaults to a raw value, as the loader does. */
function populate(raw: unknown): SillajjeConfig {
	return Default(
		SillajjeConfigSchema,
		Clean(SillajjeConfigSchema, raw),
	) as SillajjeConfig;
}

describe("SillajjeConfigSchema", () => {
	it("applies every default to an empty object", () => {
		const config = populate({});
		expect(config.debug).toBe(false);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
		expect(config.subGeneratorModel).toBe("openai/gpt-4o-mini");
		expect(config.vcsGuard).toBe(true);
		expect(config.actions?.stamp?.body).toEqual(DEFAULT_STAMP_BODY);
		expect(config.actions?.stamp?.header?.mode).toBe("one_line");
		expect(config.actions?.stamp?.trace?.detail).toBe("high");
		expect(config.actions?.stamp?.loop).toEqual(DEFAULT_LOOP);
		expect(config.actions?.fold?.body).toEqual(["summary", "ref"]);
		expect(config.actions?.fold?.summary?.detail).toBe("high");
		expect(config.subGenerator?.retry?.maxAttempts).toBe(3);
		expect(config.subGenerator?.timeoutMs).toBe(30_000);
	});

	it("keeps a provided value and fills the rest", () => {
		const config = populate({ debug: true });
		expect(config.debug).toBe(true);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
	});

	it("strips unknown properties", () => {
		const config = populate({ debug: true, not_a_field: 1 });
		expect(Object.hasOwn(config as object, "not_a_field")).toBe(false);
	});

	it("accepts a reordered stamp body", () => {
		const config = populate({
			actions: { stamp: { body: ["meta", "trace", "prompt"] } },
		});
		expect(config.actions?.stamp?.body).toEqual([
			"meta",
			"trace",
			"prompt",
		]);
	});

	it("accepts section detail for stamp and fold", () => {
		const config = populate({
			actions: {
				stamp: {
					header: { mode: "user_prompt" },
					trace: { detail: "step" },
					loop: ["elapsed"],
				},
				fold: { summary: { detail: "decision" } },
			},
		});
		expect(config.actions?.stamp?.header?.mode).toBe("user_prompt");
		expect(config.actions?.stamp?.trace?.detail).toBe("step");
		expect(config.actions?.stamp?.loop).toEqual(["elapsed"]);
		expect(config.actions?.fold?.summary?.detail).toBe("decision");
	});

	it("drops the retired message.* keys", () => {
		const config = populate({
			message: {
				header: "user_prompt",
				body: { user_prompt: false, meta: { enabled: false } },
			},
		});
		expect(Object.hasOwn(config as object, "message")).toBe(false);
		expect(config.actions?.stamp?.body).toEqual(DEFAULT_STAMP_BODY);
		expect(config.actions?.stamp?.header?.mode).toBe("one_line");
	});

	it("rejects an unknown body section", () => {
		expect(
			Check(SillajjeConfigSchema, {
				actions: { stamp: { body: ["header", "trace"] } },
			}),
		).toBe(false);
	});

	it("rejects a duplicate body section", () => {
		expect(
			Check(SillajjeConfigSchema, {
				actions: { stamp: { body: ["trace", "trace"] } },
			}),
		).toBe(false);
	});

	it("rejects an unknown Loop field", () => {
		expect(
			Check(SillajjeConfigSchema, {
				actions: { stamp: { loop: ["elapsed", "nope"] } },
			}),
		).toBe(false);
	});

	it("rejects an invalid trace detail", () => {
		expect(
			Check(SillajjeConfigSchema, {
				actions: { stamp: { trace: { detail: "low" } } },
			}),
		).toBe(false);
	});

	it("rejects a non-boolean debug value", () => {
		expect(Check(SillajjeConfigSchema, { debug: "yes" })).toBe(false);
	});
});

describe("defaultSillajjeConfig", () => {
	it("returns an independent copy each call", () => {
		const first = defaultSillajjeConfig();
		const second = defaultSillajjeConfig();
		first.debug = true;
		expect(second.debug).toBe(false);
	});
});
