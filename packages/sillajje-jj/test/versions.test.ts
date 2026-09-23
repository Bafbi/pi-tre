import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	checkVersionString,
	createJj,
	isSeriesValidated,
	parseJjVersion,
	seriesOf,
	VALIDATED_JJ_SERIES,
} from "../src/index.js";
import { realExec, stopRealJj, useRealJj } from "./real-jj.js";

const fixture = readFileSync(
	new URL("./fixtures/jj-version.txt", import.meta.url),
	"utf-8",
);

beforeAll(useRealJj);
afterAll(stopRealJj);

describe("parseJjVersion", () => {
	it("parses a release carrying a build suffix", () => {
		expect(parseJjVersion("jj 0.44.0-af45d57de716")).toEqual({
			major: 0,
			minor: 44,
			patch: 0,
			raw: "jj 0.44.0-af45d57de716",
		});
	});

	it("parses a plain release and trailing whitespace", () => {
		expect(parseJjVersion("jj 1.2.3\n")).toMatchObject({
			major: 1,
			minor: 2,
			patch: 3,
		});
	});

	it("returns undefined when the format is unknown", () => {
		expect(parseJjVersion("jj version whatever")).toBeUndefined();
	});
});

describe("checkVersionString", () => {
	it("classifies a validated series", () => {
		expect(checkVersionString(fixture).status).toBe("validated");
	});

	it("classifies a newer series as untested", () => {
		expect(checkVersionString("jj 0.45.0").status).toBe("untested");
	});

	it("classifies an unparseable string as unrecognised", () => {
		expect(checkVersionString("nonsense")).toMatchObject({
			status: "unrecognised",
			raw: "nonsense",
		});
	});
});

describe("validated-series guard", () => {
	it("the installed jj series is in the validated list", async () => {
		const check = await createJj(realExec).checkVersion();
		if (check.status === "unrecognised") {
			throw new Error(`unrecognised jj version: ${check.raw}`);
		}
		expect(VALIDATED_JJ_SERIES).toContain(seriesOf(check.version));
	});

	it("the captured version fixture is a validated series", () => {
		const version = parseJjVersion(fixture);
		expect(version).toBeDefined();
		if (version !== undefined) {
			expect(isSeriesValidated(seriesOf(version))).toBe(true);
		}
	});
});
