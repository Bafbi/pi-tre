/**
 * Regenerate the jj output fixtures from the installed jj.
 *
 * A fixture is a *shape sample*, not a golden id set. Change ids are random
 * and commit ids carry a timestamp, so every capture produces new ids; the
 * tests derive their expected values from these files, which is why re-running
 * this script needs no test edits. The one thing a capture does pin is the
 * template shape, so a jj release that changes it fails a test.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../test/fixtures");
const dir = mkdtempSync(join(tmpdir(), "sillajje-jj-capture-"));

process.env.JJ_CONFIG = join(dir, "config.toml");
writeFileSync(
	process.env.JJ_CONFIG,
	[
		"[user]",
		'name = "Fixture Capture"',
		'email = "fixtures@example.com"',
		"[signing]",
		'backend = "none"',
		"",
	].join("\n"),
);

const run = (args: string[]): string =>
	execFileSync("jj", args, { cwd: dir, encoding: "utf-8" });

const write = (name: string, content: string): void => {
	writeFileSync(join(fixtures, name), content);
	console.log(`wrote ${name}`);
};

write("jj-version.txt", run(["--version"]));

run(["git", "init", "--quiet"]);
writeFileSync(join(dir, "a.txt"), "hello\n");
run(["describe", "-m", "root change", "--quiet"]);
run(["new", "-m", "work", "--quiet"]);
run(["bookmark", "set", "mybook", "-r", "@", "--quiet"]);

write(
	"log.jsonl",
	run(["log", "-r", "@ | @-", "--no-graph", "-T", 'json(self) ++ "\\n"']),
);
write("bookmark.jsonl", run(["bookmark", "list", "-T", 'json(self) ++ "\\n"']));
write(
	"workspace-list.txt",
	run(["workspace", "list", "-T", 'name ++ ":" ++ root ++ "\\n"']),
);

// The deferred op-id line is the one uncontrolled string: a step run with
// --no-integrate-operation prints it on stderr.
const deferred = spawnSync(
	"jj",
	[
		"describe",
		"--ignore-working-copy",
		"--no-integrate-operation",
		"-m",
		"deferred",
	],
	{ cwd: dir, encoding: "utf-8" },
);
const line = `${deferred.stdout}\n${deferred.stderr}`
	.split("\n")
	.find((entry) => entry.includes("--no-integrate-operation was requested"));
if (line === undefined) {
	throw new Error("could not capture the deferred op-id line");
}
write("op-id-line.txt", `${line}\n`);
