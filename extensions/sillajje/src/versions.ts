/**
 * Version readers for the stamp provenance block.
 *
 * The adapter reads both versions once at extension activation and passes
 * them as `deps.env`; the stamp module renders them into the commit body's
 * metadata block. Both readers degrade to `"unknown"` rather than throwing —
 * a missing package.json must never break activation.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(pkgPath: string): string {
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
			version?: string;
		};
		return pkg.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

/** The sillajje extension's own version (its package.json, one level up). */
export function sillajjeVersion(): string {
	return readVersion(
		join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
	);
}

/** The pi coding agent's version, resolved through the dependency graph. */
export function piVersion(): string {
	try {
		const req = createRequire(import.meta.url);
		return readVersion(
			req.resolve("@earendil-works/pi-coding-agent/package.json"),
		);
	} catch {
		return "unknown";
	}
}
