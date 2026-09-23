import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Node runs this file directly (type stripping). The schema lives in
// `@pi-tre/sillajje-core`; the `./schema` subpath points at the config module,
// which has no relative imports so Node can strip and load it.
import { SillajjeConfigSchema } from "@pi-tre/sillajje-core/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));

const schema = {
	$schema: "https://json-schema.org/draft/2020-12/schema#",
	...SillajjeConfigSchema,
};

const outPath = join(__dirname, "..", "sillajje-config.schema.json");
writeFileSync(outPath, `${JSON.stringify(schema, null, "\t")}\n`, "utf-8");

// Format the generated file with the repository's formatter, so re-running
// the generator is byte-identical and the repo format task is a no-op.
execFileSync("pnpm", ["exec", "biome", "format", "--write", outPath], {
	stdio: "ignore",
});

console.log(`Wrote schema to ${outPath}`);
