#!/usr/bin/env node
/**
 * Assert every mise config root defines the expected workspace tasks.
 *
 * `//:check-core` finds modules through `optional = true` globs. A new
 * `extensions/foo` with no `[tasks.check]` stub has no `:check` task, and the
 * optional glob matches nothing, so its tests never run. This catches that.
 *
 * Run with `mise run config-roots` or `node scripts/check-config-roots.mjs`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const EXPECTED = [
	"lint",
	"test",
	"test-external",
	"typecheck",
	"typecheck-strict",
	"type-aware",
	"check",
	"ci",
];

function readDir(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** Read the `[monorepo] config_roots` globs from the root mise.toml. */
function readConfigRoots() {
	const mise = readFileSync(join(ROOT, "mise.toml"), "utf8");
	const match = mise.match(/config_roots\s*=\s*\[([^\]]*)\]/);
	if (!match) return [];
	return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Task names defined as `[tasks.<name>]` in a workspace config. */
function taskNames(dir) {
	let text;
	try {
		text = readFileSync(join(dir, "mise.toml"), "utf8");
	} catch {
		return undefined;
	}
	const names = new Set();
	for (const match of text.matchAll(/^\[tasks\.([A-Za-z0-9_-]+)\]/gm)) {
		names.add(match[1]);
	}
	return names;
}

const missing = [];
for (const glob of readConfigRoots()) {
	const slash = glob.indexOf("/");
	const base = slash === -1 ? "." : glob.slice(0, slash);
	const baseDir = join(ROOT, base);
	for (const entry of readDir(baseDir)) {
		const dir = join(baseDir, entry);
		if (!statSync(dir).isDirectory()) continue;
		const names = taskNames(dir);
		if (!names) continue;
		const absent = EXPECTED.filter((name) => !names.has(name));
		if (absent.length > 0) {
			missing.push(`${base}/${entry}: missing ${absent.join(", ")}`);
		}
	}
}

if (missing.length > 0) {
	console.error(`Config root check failed with ${missing.length} issue(s):`);
	for (const issue of missing) console.error(`  ${issue}`);
	process.exit(1);
}

console.log("Config root check passed.");
