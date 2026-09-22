#!/usr/bin/env node
/**
 * Dependency boundary and cycle check for the pi-tre monorepo.
 *
 * This replaces dependency-cruiser, which refuses to run on the repo's pinned
 * Node 25 (dependency-cruiser 18 supports `^22 || ^24 || >=26`).
 *
 * Rules:
 * 1. No import cycles among first-party files.
 * 2. `packages/pi-subagent` must not import from `extensions/`.
 * 3. An extension must not import from another extension.
 * 4. `src/` must not import `test/`.
 *
 * Run with `mise run boundaries` or `node scripts/check-boundaries.mjs`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const WORKSPACE_DIRS = ["extensions", "packages"];

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** List a directory, returning an empty list when it does not exist. */
function readDir(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function walk(dir, acc = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return acc;
	}
	for (const entry of entries) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) walk(path, acc);
		else if (path.endsWith(".ts")) acc.push(path);
	}
	return acc;
}

/** Map package name to its absolute directory. */
function readPackageDirs() {
	const map = new Map();
	for (const group of WORKSPACE_DIRS) {
		const groupDir = join(ROOT, group);
		for (const entry of readDir(groupDir)) {
			const dir = join(groupDir, entry);
			if (!statSync(dir).isDirectory()) continue;
			const pkgPath = join(dir, "package.json");
			try {
				const pkg = readJson(pkgPath);
				if (pkg.name) map.set(pkg.name, dir);
			} catch {
				// Not a package directory.
			}
		}
	}
	return map;
}

const SPECIFIER_PATTERNS = [
	/from\s+["']([^"']+)["']/g,
	/import\s*\(\s*["']([^"']+)["']\s*\)/g,
	/^\s*import\s+["']([^"']+)["']/gm,
];

/** Characters after which a `/` starts a regex literal, not a division. */
const REGEX_PRECEDERS = new Set([
	"(",
	",",
	"=",
	":",
	"[",
	"!",
	"&",
	"|",
	"?",
	"{",
	"}",
	";",
	"+",
	"-",
	"*",
	"%",
	"<",
	">",
	"^",
	"~",
	"\n",
]);

/**
 * Drop comments so an import-like phrase in prose never becomes an edge.
 * Tracks string, template, and regex literals so a `//` inside one is kept.
 */
function stripComments(text) {
	let out = "";
	let i = 0;
	let prev = "\n";
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			out += ch;
			i += 1;
			while (i < text.length) {
				const c = text[i];
				if (c === "\\") {
					out += c + (text[i + 1] ?? "");
					i += 2;
					continue;
				}
				out += c;
				i += 1;
				if (c === ch) break;
			}
			prev = ch;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			i += 2;
			while (
				i < text.length &&
				!(text[i] === "*" && text[i + 1] === "/")
			) {
				i += 1;
			}
			i += 2;
			continue;
		}
		if (ch === "/" && REGEX_PRECEDERS.has(prev)) {
			out += ch;
			i += 1;
			let inClass = false;
			while (i < text.length) {
				const c = text[i];
				if (c === "\\") {
					out += c + (text[i + 1] ?? "");
					i += 2;
					continue;
				}
				if (c === "\n") break;
				out += c;
				i += 1;
				if (inClass) {
					if (c === "]") inClass = false;
				} else if (c === "[") {
					inClass = true;
				} else if (c === "/") {
					break;
				}
			}
			prev = "/";
			continue;
		}
		out += ch;
		if (!/\s/.test(ch)) prev = ch;
		i += 1;
	}
	return out;
}

function extractSpecifiers(source) {
	const text = stripComments(source);
	const specifiers = new Set();
	for (const re of SPECIFIER_PATTERNS) {
		re.lastIndex = 0;
		let match = re.exec(text);
		while (match !== null) {
			specifiers.add(match[1]);
			match = re.exec(text);
		}
	}
	return [...specifiers];
}

/**
 * Candidate source files for a resolved specifier. NodeNext writes a `.js`
 * specifier for a `.ts` file, so map the emitted extension back to its
 * TypeScript source before trying the plain extensions.
 */
function sourceCandidates(base) {
	const candidates = [base];
	const swaps = [
		[".js", ".ts"],
		[".mjs", ".ts"],
		[".cjs", ".ts"],
		[".jsx", ".tsx"],
	];
	for (const [from, to] of swaps) {
		if (base.endsWith(from)) {
			candidates.push(`${base.slice(0, -from.length)}${to}`);
		}
	}
	candidates.push(`${base}.ts`, join(base, "index.ts"));
	return candidates;
}

/** Resolve a specifier to a first-party file, or undefined when external. */
function resolveSpecifier(fromFile, specifier, packageDirs, fileSet) {
	if (specifier.startsWith(".")) {
		const base = resolve(dirname(fromFile), specifier);
		for (const candidate of sourceCandidates(base)) {
			if (fileSet.has(candidate)) return candidate;
		}
		return undefined;
	}
	if (specifier.startsWith("@pi-tre/")) {
		const name = specifier.split("/").slice(0, 2).join("/");
		const dir = packageDirs.get(name);
		if (!dir) return undefined;
		const entry = join(dir, "src", "index.ts");
		return fileSet.has(entry) ? entry : undefined;
	}
	return undefined;
}

function findCycles(graph) {
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map([...graph.keys()].map((key) => [key, WHITE]));
	const cycles = new Map();
	function visit(node, stack) {
		color.set(node, GRAY);
		stack.push(node);
		for (const next of graph.get(node) ?? []) {
			if (color.get(next) === GRAY) {
				const cycle = stack.slice(stack.indexOf(next));
				const key = [...cycle].sort().join("|");
				if (!cycles.has(key)) cycles.set(key, cycle);
			} else if (color.get(next) === WHITE) {
				visit(next, [...stack]);
			}
		}
		color.set(node, BLACK);
	}
	for (const node of graph.keys()) {
		if (color.get(node) === WHITE) visit(node, []);
	}
	return [...cycles.values()];
}

/** Normalize a path to forward slashes. `relative` uses `\` on Windows. */
function toPosix(path) {
	return path.split("\\").join("/");
}

/** Return the workspace root name for a path, or undefined for root files. */
function workspaceOf(path) {
	const rel = toPosix(relative(ROOT, path));
	for (const group of WORKSPACE_DIRS) {
		if (rel.startsWith(`${group}/`)) {
			return `${group}/${rel.split("/")[1]}`;
		}
	}
	return undefined;
}

/** Return true when the path is under a `src/` directory. */
function isSrc(path) {
	return toPosix(relative(ROOT, path)).split("/").includes("src");
}

/** Return true when the path is under a `test/` directory. */
function isTest(path) {
	return toPosix(relative(ROOT, path)).split("/").includes("test");
}

const packageDirs = readPackageDirs();
const files = [];
for (const group of WORKSPACE_DIRS) {
	const groupDir = join(ROOT, group);
	for (const entry of readDir(groupDir)) {
		const dir = join(groupDir, entry);
		if (!statSync(dir).isDirectory()) continue;
		for (const sub of ["src", "test"]) {
			files.push(...walk(join(dir, sub)));
		}
	}
}
const fileSet = new Set(files);
const graph = new Map(files.map((file) => [file, []]));
const violations = [];

for (const file of files) {
	const text = readFileSync(file, "utf8");
	for (const specifier of extractSpecifiers(text)) {
		const target = resolveSpecifier(file, specifier, packageDirs, fileSet);
		if (!target) continue;
		graph.get(file).push(target);

		const fromWorkspace = workspaceOf(file);
		const toWorkspace = workspaceOf(target);

		if (
			fromWorkspace === "packages/pi-subagent" &&
			toWorkspace?.startsWith("extensions/")
		) {
			violations.push(
				`${relative(ROOT, file)} imports ${relative(ROOT, target)}: pi-subagent must not depend on an extension.`,
			);
		}
		if (
			fromWorkspace?.startsWith("extensions/") &&
			toWorkspace?.startsWith("extensions/") &&
			fromWorkspace !== toWorkspace
		) {
			violations.push(
				`${relative(ROOT, file)} imports ${relative(ROOT, target)}: extensions must not import each other.`,
			);
		}
		if (isSrc(file) && isTest(target)) {
			violations.push(
				`${relative(ROOT, file)} imports ${relative(ROOT, target)}: src must not import tests.`,
			);
		}
	}
}

for (const cycle of findCycles(graph)) {
	violations.push(
		`Import cycle: ${cycle.map((file) => relative(ROOT, file)).join(" -> ")}`,
	);
}

if (violations.length > 0) {
	console.error(
		`Boundary check failed with ${violations.length} violation(s):`,
	);
	for (const violation of violations) console.error(`  ${violation}`);
	process.exit(1);
}

console.log(`Boundary check passed (${files.length} files checked).`);
