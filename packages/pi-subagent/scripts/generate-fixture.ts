/**
 * Record the pi protocol fixture.
 *
 * Runs the installed `pi` headless with a fixed prompt, captures its
 * `--mode json` stdout, scrubs volatile fields (ids, timestamps, cwd,
 * provider, model), and writes the replay fixture plus a metadata file
 * that pins the recording to the pi version that produced it.
 *
 * Run it after a pi version bump:
 *
 * 	mise run //packages/pi-subagent:generate-fixture
 *
 * Requires PI_TEST_MODEL (mise provides it). The run needs a working
 * provider; the fixture itself carries no secrets.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPT = "Reply with exactly the two words: hello world";
const TIMEOUT_MS = 180_000;

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(packageDir, "test", "fixtures");

const model = process.env.PI_TEST_MODEL;
if (!model) {
	console.error(
		"PI_TEST_MODEL is not set. Mise provides it by default; override it in mise.local.toml or the shell.",
	);
	process.exit(1);
}

// The version of the binary that actually produces the lines.
const piVersion = execFileSync("pi", ["--version"], {
	encoding: "utf-8",
})
	.trim()
	.split("\n")[0]
	.trim();

const result = spawnSync(
	"pi",
	["--mode", "json", "-p", "--no-session", "--model", model, PROMPT],
	{ encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT_MS },
);

if (result.error) {
	console.error(`pi failed to run: ${result.error.message}`);
	process.exit(1);
}
if (result.status !== 0) {
	console.error(
		`pi exited with code ${result.status}:\n${result.stderr?.slice(0, 2000)}`,
	);
	process.exit(1);
}

const lines = (result.stdout ?? "")
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line.length > 0)
	.map(scrubLine);

await mkdir(fixtureDir, { recursive: true });
await writeFile(
	join(fixtureDir, "pi-session.jsonl"),
	`${lines.join("\n")}\n`,
	"utf-8",
);
await writeFile(
	join(fixtureDir, "pi-session.meta.json"),
	`${JSON.stringify({ piVersion }, null, 2)}\n`,
	"utf-8",
);

console.log(
	`Recorded ${lines.length} protocol lines from pi ${piVersion} into test/fixtures/.`,
);

/** Replace volatile values so the fixture diffs only on shape changes. */
function scrubLine(line: string): string {
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		// Not JSON (e.g. stray stderr noise on stdout): keep the line as-is.
		return line;
	}
	return `${JSON.stringify(scrub(event))}`;
}

function scrub(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(scrub);
	}
	if (typeof value !== "object" || value === null) {
		return value;
	}
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		switch (key) {
			case "timestamp":
				out[key] = 0;
				break;
			case "id":
			case "responseId":
				out[key] = "fixture-id";
				break;
			case "cwd":
				out[key] = "/fixture";
				break;
			case "provider":
				out[key] = "fixture-provider";
				break;
			case "model":
				out[key] = "fixture-model";
				break;
			default:
				out[key] = scrub(child);
		}
	}
	return out;
}
