/**
 * jj version parsing and the validated-series list.
 *
 * jj is pre-1.0 and its output moves between minor releases, but sillajje runs
 * on hosts whose jj we do not control. The package therefore declares the
 * minor series its fixtures and tests cover, and the adapter warns — once —
 * when the host runs outside that list. A mismatch is not fatal: every parse
 * site already fails loudly through a typed `JjFailure`, so an untested jj
 * breaks at the first incompatible command, never silently.
 */

export interface JjVersion {
	major: number;
	minor: number;
	patch: number;
	/** The version string jj printed, e.g. `jj 0.44.0-af45d57de716`. */
	raw: string;
}

/**
 * The jj minor series this build's fixtures and tests were captured against.
 * Regenerate the fixtures (and this list) on a deliberate jj bump.
 */
export const VALIDATED_JJ_SERIES: readonly string[] = ["0.44"];

export type VersionCheck =
	| { status: "validated"; version: JjVersion }
	| { status: "untested"; version: JjVersion }
	| { status: "unrecognised"; raw: string };

/** Parse `jj 0.44.0-af45d57…` into its numeric parts. */
export function parseJjVersion(output: string): JjVersion | undefined {
	const match = /^jj\s+(\d+)\.(\d+)\.(\d+)/.exec(output);
	if (!match) return undefined;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		raw: output.trim(),
	};
}

/** The `major.minor` series a version belongs to. */
export function seriesOf(version: JjVersion): string {
	return `${version.major}.${version.minor}`;
}

export function isSeriesValidated(series: string): boolean {
	return VALIDATED_JJ_SERIES.includes(series);
}

/** Classify a raw `jj --version` string. Never throws. */
export function checkVersionString(output: string): VersionCheck {
	const version = parseJjVersion(output);
	if (version === undefined) {
		return { status: "unrecognised", raw: output.trim() };
	}
	return isSeriesValidated(seriesOf(version))
		? { status: "validated", version }
		: { status: "untested", version };
}
